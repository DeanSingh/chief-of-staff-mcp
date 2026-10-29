#!/usr/bin/env bun
/**
 * claude-peers broker daemon
 *
 * A singleton HTTP server on localhost:7899 backed by SQLite.
 * Tracks all registered Claude Code peers and routes messages between them.
 *
 * Auto-launched by the MCP server if not already running.
 * Run directly: bun broker.ts
 */

import { Database } from "bun:sqlite";
import { chmodSync } from "node:fs";
import { ensureSecret, peerSecret, secretPath, secretsEqual, PEER_HEADER } from "./shared/auth.ts";
import type {
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  SetSummaryRequest,
  ListPeersRequest,
  SendMessageRequest,
  PollMessagesRequest,
  PollMessagesResponse,
  AckMessagesRequest,
  SessionStartRequest,
  SessionStartResponse,
  Peer,
  Message,
} from "./shared/types.ts";

const PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const DB_PATH = process.env.CLAUDE_PEERS_DB ?? `${process.env.HOME}/.claude-peers.db`;
// Cloud Desktop/Cowork sessions can't reach this loopback broker, so they are
// woken through an outbound pub/sub relay instead: each desktop identity gets a
// secret topic, and a send POSTs the bare word "wake" to it. Message content
// never leaves the machine. "off" disables the relay.
// Off unless configured: the relay is a third party that sees when each
// desktop identity gets mail. It must be https, except on this machine, and
// URL-safe characters only: it is pasted into the shell command every agent's
// Monitor runs.
const WAKE_RELAY = (process.env.CLAUDE_PEERS_WAKE_RELAY ?? "off").replace(/\/+$/, "");
const WAKE_ON = /^[A-Za-z0-9.:\/_-]+$/.test(WAKE_RELAY)
  && /^https:\/\/|^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(WAKE_RELAY);
if (WAKE_RELAY !== "off" && !WAKE_ON) {
  console.error("[claude-peers broker] CLAUDE_PEERS_WAKE_RELAY must be https:// (or http:// on 127.0.0.1/localhost) and use only [A-Za-z0-9.:/_-]; wake relay disabled");
}
const WAKE_COALESCE_MS = Number(process.env.CLAUDE_PEERS_WAKE_COALESCE_MS) || 10_000;

// --- Database setup ---

// Every file the broker creates (DB, -wal, -shm, secret) is owner-only, even
// one SQLite recreates mid-run after the startup chmod below.
process.umask(0o077);

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");
// The DB holds every peer's mail and session tokens: owner-only.
for (const suffix of ["", "-wal", "-shm"]) {
  try { chmodSync(DB_PATH + suffix, 0o600); } catch { /* not created yet */ }
}

const SECRET = ensureSecret(secretPath(DB_PATH));

db.run(`
  CREATE TABLE IF NOT EXISTS peers (
    id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    cwd TEXT NOT NULL,
    git_root TEXT,
    tty TEXT,
    summary TEXT NOT NULL DEFAULT '',
    peer_type TEXT NOT NULL DEFAULT 'cli',
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    text TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0,
    -- These FOREIGN KEY declarations are UNENFORCED: PRAGMA foreign_keys is
    -- never set anywhere in this file. That is deliberate, not an oversight -
    -- peers are reaped (their row in the peers table deleted) while their
    -- messages persist under the TTL in cleanStalePeers, so from_id/to_id
    -- dangling with no matching peers row is an expected, ongoing state, not
    -- corruption. Turning the pragma on would start rejecting exactly that
    -- and break reaping; it would also require a table rebuild (SQLite
    -- doesn't retrofit FK enforcement onto an existing table in place).
    FOREIGN KEY (from_id) REFERENCES peers(id),
    FOREIGN KEY (to_id) REFERENCES peers(id)
  )
`);

// Migration: desktop peers are keyed by their claimed session token so the id
// survives MCP server process churn.
const peerCols = (db.query("PRAGMA table_info(peers)").all() as { name: string }[]).map((c) => c.name);
if (!peerCols.includes("session_token")) {
  db.run("ALTER TABLE peers ADD COLUMN session_token TEXT");
}
db.run("CREATE INDEX IF NOT EXISTS idx_peers_session_token ON peers(session_token)");
// CLI rows record their process's start time: pids are reused, so a pid match
// alone could hand a new process a dead session's identity. NULL on rows
// written before this column existed, which are matched on pid alone.
if (!peerCols.includes("pid_started")) {
  db.run("ALTER TABLE peers ADD COLUMN pid_started TEXT");
}

// Durable session_token -> peer id mapping. The peers row is ephemeral (a
// desktop peer expires after 30 min without heartbeats), but the session and
// the addresses other agents hold for it are not — so a returning session
// must get the SAME id back even when its row was reaped.
db.run(`
  CREATE TABLE IF NOT EXISTS desktop_tokens (
    token TEXT PRIMARY KEY,
    peer_id TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);
// The topic lives beside the token so it outlives the reaped peers row: an
// agent's armed Monitor keeps listening on it across resurrection.
if (!(db.query("PRAGMA table_info(desktop_tokens)").all() as { name: string }[]).some((c) => c.name === "wake_topic")) {
  db.run("ALTER TABLE desktop_tokens ADD COLUMN wake_topic TEXT");
}

// Cache summaries by workspace so they survive across sessions
db.run(`
  CREATE TABLE IF NOT EXISTS summary_cache (
    key TEXT PRIMARY KEY,
    summary TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);

// Durable session_key -> peer id, for ALL peer types. Generalizes
// desktop_tokens: CLI peers key on Claude Code's CLAUDE_CODE_SESSION_ID,
// desktop peers on their claimed token. The peers row is ephemeral; the
// address other agents hold is not.
db.run(`
  CREATE TABLE IF NOT EXISTS peer_sessions (
    session_key TEXT PRIMARY KEY,
    peer_id     TEXT NOT NULL,
    peer_type   TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  )
`);
// handleHeartbeat refreshes this table keyed on peer_id (not the primary
// key), and heartbeat is a hot path — index it so that lookup stays O(log n)
// instead of a full table scan.
db.run("CREATE INDEX IF NOT EXISTS idx_peer_sessions_peer_id ON peer_sessions(peer_id)");

// The session a running Claude Code process is LIVE in, as last reported by
// its SessionStart hook. The MCP server's CLAUDE_CODE_SESSION_ID is fixed at
// spawn and goes stale after /clear or an in-session /resume; registration
// consults this first so the stale key never decides identity. Keyed on pid +
// start time so a reused pid never inherits it.
db.run(`
  CREATE TABLE IF NOT EXISTS process_sessions (
    pid INTEGER NOT NULL,
    pid_started TEXT NOT NULL,
    session_key TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (pid, pid_started)
  )
`);

// Each peer's own last summary, kept when its row is reaped so a returning
// session (CLI by session key, desktop by token) gets its OWN summary back.
// summary_cache can't do this: it is keyed by workspace, so with several
// agents in one repo it holds whichever agent spoke last.
db.run(`
  CREATE TABLE IF NOT EXISTS peer_summaries (
    peer_id    TEXT PRIMARY KEY,
    summary    TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);
db.run(`
  CREATE TRIGGER IF NOT EXISTS keep_peer_summary BEFORE DELETE ON peers
  WHEN OLD.summary != ''
  BEGIN
    INSERT OR REPLACE INTO peer_summaries (peer_id, summary, updated_at)
    VALUES (OLD.id, OLD.summary, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  END
`);

function ownSummary(peerId: string): string | null {
  const row = db.query("SELECT summary FROM peer_summaries WHERE peer_id = ?").get(peerId) as { summary: string } | null;
  return row?.summary ?? null;
}

// Idempotent: INSERT OR IGNORE means re-running on an already-migrated
// database is a no-op, never a duplicate or a constraint error.
db.run(`
  INSERT OR IGNORE INTO peer_sessions (session_key, peer_id, peer_type, updated_at)
  SELECT token, peer_id, 'desktop', updated_at FROM desktop_tokens
`);

/** Signal 0 checks existence without killing. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The process's start time as `ps` reports it, or null if it isn't running. */
function pidStartTime(pid: number): string | null {
  // Fixed locale and zone: the broker inherits its environment from whichever
  // session auto-launched it, and a restart under another LANG/TZ must not make
  // every recorded value mismatch.
  const out = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], { env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
  return new TextDecoder().decode(out.stdout).trim() || null;
}

/** True unless the row's recorded start time shows its pid now belongs to another process. */
function isSameProcess(row: { pid: number; pid_started: string | null }): boolean {
  return row.pid_started == null || pidStartTime(row.pid) === row.pid_started;
}

// Clean up stale peers (PIDs that no longer exist) on startup
function cleanStalePeers() {
  // PID liveness applies to CLI peers only. A desktop peer's pid is whichever
  // MCP server process happened to serve its last call — Desktop spawns
  // several and respawns them on bridge reconnects — so reaping desktop peers
  // by pid deleted live sessions (and their undelivered messages) every time
  // a bridge process exited. Desktop peers are reaped by heartbeat below.
  const peers = db.query("SELECT id, pid, peer_type FROM peers WHERE peer_type != 'desktop'").all() as { id: string; pid: number; peer_type: string }[];
  for (const peer of peers) {
    if (!isPidAlive(peer.pid)) {
      // Process is gone: drop the row so it stops showing up as live.
      // Do NOT delete its undelivered mail. The peer id is durable via
      // peer_sessions, so a restarted session reclaims this id and must still
      // receive what was queued. The 72h undelivered TTL below is the bound.
      db.run("DELETE FROM peers WHERE id = ?", [peer.id]);
    }
  }

  // Clean stale desktop peers by heartbeat timeout (PID check doesn't work — shared VM).
  // 30 minutes: desktop sessions can be idle for long stretches (user reading, thinking,
  // working in another session). The MCP server process may be suspended by Claude Desktop
  // when idle, stopping heartbeats — so a short timeout causes false positives.
  const staleTimeout = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  // Keep undelivered desktop mail: the id survives expiry via desktop_tokens,
  // so a returning session picks its queue up. Bounded by the TTL below.
  db.run("DELETE FROM peers WHERE peer_type = 'desktop' AND last_seen < ?", [staleTimeout]);

  // TTL: delivered messages > 24h, undelivered > 72h (recipient never came back), summary cache > 7d
  db.run("DELETE FROM messages WHERE delivered = 1 AND sent_at < ?", [new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()]);
  db.run("DELETE FROM messages WHERE delivered = 0 AND sent_at < ?", [new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString()]);
  db.run("DELETE FROM desktop_tokens WHERE updated_at < ?", [new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()]);
  db.run("DELETE FROM process_sessions WHERE updated_at < ?", [new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()]);
  // Same 30-day TTL as desktop_tokens above. Safe only because handleHeartbeat
  // refreshes peer_sessions.updated_at on every heartbeat (see touchPeerSessionByPeerId)
  // — otherwise a session alive longer than the TTL would have its mapping
  // swept out from under it and mint a new id on its next reconnect.
  db.run("DELETE FROM peer_sessions WHERE updated_at < ?", [new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()]);
  db.run("DELETE FROM summary_cache WHERE updated_at < ?", [new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()]);
  db.run("DELETE FROM peer_summaries WHERE updated_at < ?", [new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()]);
}

cleanStalePeers();

// Reclaim disk space after initial cleanup
db.run("VACUUM");

// Periodically clean stale peers (every 30s)
setInterval(cleanStalePeers, 30_000);

// --- Prepared statements ---

const insertPeer = db.prepare(`
  INSERT INTO peers (id, pid, cwd, git_root, tty, summary, peer_type, registered_at, last_seen, session_token)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const selectPeerBySessionToken = db.prepare(`
  SELECT * FROM peers WHERE session_token = ?
`);

const touchPeerBySessionToken = db.prepare(`
  UPDATE peers SET pid = ?, last_seen = ?, summary = CASE WHEN ? = '' THEN summary ELSE ? END WHERE session_token = ?
`);

const touchPeerSessionByPeerId = db.prepare(`
  UPDATE peer_sessions SET updated_at = ? WHERE peer_id = ?
`);

const updateLastSeen = db.prepare(`
  UPDATE peers SET last_seen = ? WHERE id = ?
`);

const updateSummary = db.prepare(`
  UPDATE peers SET summary = ? WHERE id = ?
`);

const deletePeer = db.prepare(`
  DELETE FROM peers WHERE id = ?
`);

// What other peers may see of a peer. Never SELECT * here: session_token is
// a desktop session's bearer identity. Older desktop rows also carry the
// token as their cwd (servers registered with cwd = token), so mask it there.
const PUBLIC_CWD = "CASE WHEN session_token IS NOT NULL AND instr(cwd, session_token) > 0 THEN replace(cwd, session_token, '(desktop session)') ELSE cwd END";
const PUBLIC_PEER_COLUMNS = `id, pid, ${PUBLIC_CWD} AS cwd, git_root, tty, summary, peer_type, registered_at, last_seen`;

const selectAllPeers = db.prepare(`
  SELECT ${PUBLIC_PEER_COLUMNS} FROM peers
`);

const selectPeersByDirectory = db.prepare(`
  SELECT ${PUBLIC_PEER_COLUMNS} FROM peers WHERE cwd = ?
`);

const selectPeersByGitRoot = db.prepare(`
  SELECT ${PUBLIC_PEER_COLUMNS} FROM peers WHERE git_root = ?
`);

const insertMessage = db.prepare(`
  INSERT INTO messages (from_id, to_id, text, sent_at, delivered)
  VALUES (?, ?, ?, ?, 0)
`);

const selectUndelivered = db.prepare(`
  SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC
`);

const selectUndeliveredSince = db.prepare(`
  SELECT * FROM messages WHERE to_id = ? AND delivered = 0 AND id > ? ORDER BY sent_at ASC
`);

const upsertSummaryCache = db.prepare(`
  INSERT INTO summary_cache (key, summary, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET summary = excluded.summary, updated_at = excluded.updated_at
`);

const selectSummaryCache = db.prepare(`
  SELECT summary FROM summary_cache WHERE key = ?
`);

const markDelivered = db.prepare(`
  UPDATE messages SET delivered = 1 WHERE id = ? AND to_id = ?
`);

// --- Generate peer ID ---

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// --- Summary cache helpers ---

function summaryCacheKey(cwd: string, git_root: string | null): string {
  return git_root ?? cwd;
}

function cacheSummary(cwd: string, git_root: string | null, summary: string): void {
  if (!summary) return;
  const key = summaryCacheKey(cwd, git_root);
  upsertSummaryCache.run(key, summary, new Date().toISOString());
}

function getCachedSummary(cwd: string, git_root: string | null): string | null {
  const key = summaryCacheKey(cwd, git_root);
  const row = selectSummaryCache.get(key) as { summary: string } | null;
  return row?.summary ?? null;
}

// --- Request handlers ---

// Shared by both CLI identity paths: the session_key fallback (key present
// but unmapped) and the no-key path (pre-session-key callers). Looks up an
// existing CLI peer row by pid, refreshes it in place, and — when a cliKey is
// given — records the key -> id mapping so future registrations resolve by
// key without needing this fallback again. Returns null when no pid match
// exists, so the caller falls through to minting a fresh peer.
function claimPeerByPid(pid: number, body: RegisterRequest, now: string, cliKey: string | null): { id: string; restored_summary?: string } | null {
  const existing = (db.query("SELECT id, summary, pid, pid_started FROM peers WHERE pid = ? AND peer_type != 'desktop'")
    .all(pid) as { id: string; summary: string; pid: number; pid_started: string | null }[]).find(isSameProcess);
  if (!existing) return null;
  db.run(
    "UPDATE peers SET cwd = ?, git_root = ?, tty = ?, last_seen = ?, summary = CASE WHEN ? = '' THEN summary ELSE ? END WHERE id = ?",
    [body.cwd, body.git_root, body.tty, now, body.summary ?? "", body.summary ?? "", existing.id],
  );
  if (cliKey) {
    db.run("INSERT OR REPLACE INTO peer_sessions (session_key, peer_id, peer_type, updated_at) VALUES (?, ?, 'cli', ?)", [cliKey, existing.id, now]);
  }
  if (body.summary) cacheSummary(body.cwd, body.git_root, body.summary);
  return { id: existing.id, restored_summary: body.summary ? undefined : (existing.summary || undefined) };
}

function handleRegister(body: RegisterRequest): RegisterResponse {
  const res = registerPeer(body);
  if ((body.peer_type ?? "cli") !== "desktop") {
    db.run("UPDATE peers SET pid_started = ? WHERE id = ?", [pidStartTime(body.pid), res.id]);
  } else if (WAKE_ON && body.session_token) {
    res.wake_topic = wakeTopicFor(body.session_token);
    // The full subscribe base, so the server never pairs this topic with a
    // relay of its own (its env may differ from the one that launched us).
    if (res.wake_topic) res.wake_url = `${WAKE_RELAY}/${res.wake_topic}`;
  }
  return { ...res, peer_secret: peerSecret(SECRET, res.id) };
}

/** The token's wake topic, minted on first use (including tokens claimed before topics existed). */
function wakeTopicFor(token: string): string | undefined {
  const row = db.query("SELECT wake_topic FROM desktop_tokens WHERE token = ?").get(token) as { wake_topic: string | null } | null;
  if (!row) return undefined;
  if (row.wake_topic) return row.wake_topic;
  const topic = "cp-wake-" + Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
  db.run("UPDATE desktop_tokens SET wake_topic = ? WHERE token = ?", [topic, token]);
  return topic;
}

// At most one publish per topic per window. A send inside the window schedules
// one trailing publish at its end, so mail that lands just after a wake (while
// the agent is already reading its inbox) still wakes it again.
const wakeWindows = new Map<string, { last: number; trailing: boolean }>();

function publishWake(topic: string): void {
  const now = Date.now();
  const w = wakeWindows.get(topic);
  if (w && now - w.last < WAKE_COALESCE_MS) {
    if (!w.trailing) {
      w.trailing = true;
      setTimeout(() => { w.trailing = false; w.last = Date.now(); postWake(topic); }, w.last + WAKE_COALESCE_MS - now);
    }
    return;
  }
  wakeWindows.set(topic, { last: now, trailing: false });
  postWake(topic);
}

// Fire-and-forget: a slow or dead relay must never delay or fail a send. The
// mail is already queued; the agent still finds it on its next pull.
function postWake(topic: string): void {
  fetch(`${WAKE_RELAY}/${topic}`, { method: "POST", body: "wake", signal: AbortSignal.timeout(3000) })
    .then((r) => {
      // fetch resolves on 4xx/5xx; a rate-limited relay (429) must not fail silently.
      if (!r.ok) console.error(`[claude-peers broker] wake publish failed: HTTP ${r.status}`);
      return r.body?.cancel();
    })
    .catch((e) => console.error(`[claude-peers broker] wake publish failed: ${e}`));
}

function registerPeer(body: RegisterRequest): RegisterResponse {
  const now = new Date().toISOString();

  const peerType = body.peer_type ?? "cli";
  const isCli = peerType !== "desktop";

  // Desktop sessions keyed by token get their existing peer back. This is
  // what keeps a Cowork session's peer id stable across the several MCP
  // server processes Desktop runs (and respawns) for the same session.
  const token = !isCli && body.session_token ? body.session_token : null;
  const cliKey = isCli ? (liveSessionKey(body.pid) ?? body.session_key ?? null) : null;
  if (token) {
    const existing = selectPeerBySessionToken.get(token) as Peer | null;
    if (existing) {
      touchPeerBySessionToken.run(body.pid, now, body.summary ?? "", body.summary ?? "", token);
      db.run("UPDATE desktop_tokens SET updated_at = ? WHERE token = ?", [now, token]);
      db.run("UPDATE peer_sessions SET updated_at = ? WHERE session_key = ?", [now, token]);
      return { id: existing.id, restored_summary: body.summary ? undefined : existing.summary };
    }
    // Row was reaped (session idled past the heartbeat window) but the token
    // is known: resurrect the peer under its ORIGINAL id so addresses other
    // agents hold stay valid and queued mail is still addressed correctly.
    const mapped = db.query("SELECT peer_id FROM desktop_tokens WHERE token = ?").get(token) as { peer_id: string } | null;
    if (mapped) {
      const restored = body.summary ? undefined : (ownSummary(mapped.peer_id) ?? undefined);
      insertPeer.run(mapped.peer_id, body.pid, body.cwd, body.git_root, body.tty, body.summary || restored || "", peerType, now, now, token);
      db.run("UPDATE desktop_tokens SET updated_at = ? WHERE token = ?", [now, token]);
      db.run("UPDATE peer_sessions SET updated_at = ? WHERE session_key = ?", [now, token]);
      return { id: mapped.peer_id, restored_summary: restored };
    }
  }

  const id = generateId();
  if (token) {
    db.run("INSERT OR REPLACE INTO desktop_tokens (token, peer_id, updated_at) VALUES (?, ?, ?)", [token, id, now]);
    // Desktop identity is still resolved through desktop_tokens above (the
    // lookups at the top of this function and the resurrection branch both
    // read desktop_tokens, never peer_sessions). This write only mirrors the
    // mapping into peer_sessions so it exists — it is not read yet. It lets a
    // later phase finish the migration (switch desktop lookups to read
    // peer_sessions too) and eventually drop desktop_tokens, without a
    // backfill step. Deliberately uncovered by a desktop-specific test: the
    // only way to assert peer_sessions is actually read today is a
    // cross-type test that would break the moment the CLI-only lookup
    // (see the cliKey branch below) gets hardened to also check peer_type.
    db.run("INSERT OR REPLACE INTO peer_sessions (session_key, peer_id, peer_type, updated_at) VALUES (?, ?, ?, ?)", [token, id, "desktop", now]);
  }

  // CLI identity. Prefer Claude Code's session id: it survives process death,
  // so a restarted session gets its id (and its queued mail) back. Fall back
  // to pid matching when no key was supplied.
  // Desktop sessions share one VM PID, so PID-based matching would conflate
  // other active sessions; they are keyed by session_token above instead.
  if (cliKey) {
    const mapped = db.query("SELECT peer_id FROM peer_sessions WHERE session_key = ?")
      .get(cliKey) as { peer_id: string } | null;
    if (mapped) {
      const live = db.query("SELECT id, summary, pid, pid_started FROM peers WHERE id = ?")
        .get(mapped.peer_id) as { id: string; summary: string; pid: number; pid_started: string | null } | null;
      if (live && live.pid !== body.pid && isPidAlive(live.pid) && isSameProcess(live)) {
        // The same session is open in another terminal that is still running:
        // that process owns the id. Keep (or mint) this process's own peer and
        // leave the key mapped to the owner.
        const own = claimPeerByPid(body.pid, body, now, null);
        if (own) return own;
        return mintPeer(body, now, null, peerType, isCli);
      }
      let resurrectedSummary: string | undefined;
      if (live) {
        db.run(
          "UPDATE peers SET pid = ?, cwd = ?, git_root = ?, tty = ?, last_seen = ?, summary = CASE WHEN ? = '' THEN summary ELSE ? END WHERE id = ?",
          [body.pid, body.cwd, body.git_root, body.tty, now, body.summary ?? "", body.summary ?? "", live.id],
        );
      } else {
        // Row was reaped but the session is back: resurrect under the SAME id
        // so mail queued for it is still addressed correctly, with its own
        // last summary when none was supplied, so it doesn't rejoin blank.
        let summaryToInsert = body.summary;
        if (!summaryToInsert) {
          summaryToInsert = ownSummary(mapped.peer_id) ?? "";
          if (summaryToInsert) resurrectedSummary = summaryToInsert;
        }
        insertPeer.run(mapped.peer_id, body.pid, body.cwd, body.git_root, body.tty, summaryToInsert, peerType, now, now, null);
      }
      db.run("UPDATE peer_sessions SET updated_at = ? WHERE session_key = ?", [now, cliKey]);
      if (body.summary) cacheSummary(body.cwd, body.git_root, body.summary);
      const restored = live ? (!body.summary ? (live.summary || undefined) : undefined) : resurrectedSummary;
      return { id: mapped.peer_id, restored_summary: restored };
    }

    // No peer_sessions mapping yet for this key. This is the state of EVERY
    // CLI session at the moment session_key support first lands (or any
    // session that has never sent one before): do NOT fall through to
    // minting — that would orphan the pid-keyed row this session already
    // has, splitting it into two live `peers` rows for one process. Fall
    // back to the pid lookup and, on a hit, ADOPT that peer's id and record
    // the key -> id mapping so the next registration resolves by key
    // directly instead of taking this fallback again.
    const adopted = claimPeerByPid(body.pid, body, now, cliKey);
    if (adopted) return adopted;
  } else if (isCli) {
    // CLI re-registration for a pid we already know (the Claude Code session
    // pid — its MCP server process may have been respawned by /mcp reconnect):
    // keep the SAME peer id so addresses other agents hold stay valid, and keep
    // the summary unless a new one is given.
    const existing = claimPeerByPid(body.pid, body, now, null);
    if (existing) return existing;
  }

  return mintPeer(body, now, cliKey, peerType, isCli, id, token);
}

function mintPeer(body: RegisterRequest, now: string, cliKey: string | null, peerType: string, isCli: boolean, id = generateId(), token: string | null = null): RegisterResponse {
  // A brand-new session starts blank. Only a caller with no session key (an
  // older Claude Code) inherits the workspace's cached summary: pid matching
  // is its only way back after a restart. With a key, a new id means a new
  // session, and the cache holds whichever agent in the repo spoke last.
  // Desktop sessions always set fresh summaries and would collide on one cache slot.
  let summary = body.summary;
  if (!summary && isCli && !cliKey && !body.session_key) {
    summary = getCachedSummary(body.cwd, body.git_root) ?? "";
  }

  if (summary && isCli) {
    cacheSummary(body.cwd, body.git_root, summary);
  }

  // Only reached when a genuinely new peer is being minted. Record its durable
  // key so the next registration under the same session reclaims this id.
  if (cliKey) {
    db.run("INSERT OR REPLACE INTO peer_sessions (session_key, peer_id, peer_type, updated_at) VALUES (?, ?, 'cli', ?)", [cliKey, id, now]);
  }

  insertPeer.run(id, body.pid, body.cwd, body.git_root, body.tty, summary, peerType, now, now, token);
  return { id, restored_summary: summary !== body.summary ? summary : undefined };
}

// In-session /resume switches the conversation after the MCP server spawned,
// so the server registered under the launch session's key and was minted a
// new id. The SessionStart hook sees the live session id and posts it here
// with the Claude Code pid. Find the CLI peer that process owns and, if the live
// session already owns a different id, move the row onto that id so other
// agents' addresses and mail queued for it stay valid. The server picks the
// change up on its next heartbeat: its peer row is gone, so ensureRegistered
// re-registers, and registration resolves this process through
// process_sessions to the live session's key, hence the reclaimed id.
/** The session this process's SessionStart hook last reported, if any. */
function liveSessionKey(pid: number): string | null {
  const started = pidStartTime(pid);
  if (!started) return null;
  const row = db.query("SELECT session_key FROM process_sessions WHERE pid = ? AND pid_started = ?").get(pid, started) as { session_key: string } | null;
  return row?.session_key ?? null;
}

const sessionStart = db.transaction((body: SessionStartRequest, now: string): SessionStartResponse => {
  const live = (db.query("SELECT id, pid, pid_started FROM peers WHERE pid = ? AND peer_type != 'desktop'")
    .all(body.pid) as { id: string; pid: number; pid_started: string | null }[]).find(isSameProcess);
  if (!live) return { ok: false, reason: "no_live_peer" };

  // From now on this process registers under the live session, not the key
  // its server was spawned with. Recorded only once the call is accepted: a
  // refused conflict must leave the process where it was.
  const recordLiveSession = () => {
    const started = pidStartTime(body.pid);
    if (started) {
      db.run("INSERT OR REPLACE INTO process_sessions (pid, pid_started, session_key, updated_at) VALUES (?, ?, ?, ?)", [body.pid, started, body.session_key, now]);
    }
  };

  const mapped = db.query("SELECT peer_id FROM peer_sessions WHERE session_key = ?").get(body.session_key) as { peer_id: string } | null;
  if (!mapped) {
    recordLiveSession();
    db.run("INSERT INTO peer_sessions (session_key, peer_id, peer_type, updated_at) VALUES (?, ?, 'cli', ?)", [body.session_key, live.id, now]);
    return { ok: true, peer_id: live.id, action: "mapped" };
  }
  if (mapped.peer_id === live.id) {
    recordLiveSession();
    db.run("UPDATE peer_sessions SET updated_at = ? WHERE session_key = ?", [now, body.session_key]);
    return { ok: true, peer_id: live.id, action: "noop" };
  }

  // The same conversation is open in another terminal that is still running:
  // that process owns the id. Leave both alone.
  const owner = db.query("SELECT pid, pid_started FROM peers WHERE id = ?").get(mapped.peer_id) as { pid: number; pid_started: string | null } | null;
  if (owner && owner.pid !== live.pid && isPidAlive(owner.pid) && isSameProcess(owner)) return { ok: false, reason: "conflict" };
  recordLiveSession();

  // Move the live row onto the resumed session's id. Only the row moves: the
  // conversation this process was in before keeps its own key mapping, dormant
  // until that conversation is resumed somewhere. Its undelivered mail stays
  // with it too, unless that id is mapped by at most one key, i.e. it was never
  // /clear'd into a second conversation. Then the mail follows the row on the
  // reading that whoever wrote to it was addressing the agent in this terminal
  // (the case this exists for: mail sent to the id minted between launch and
  // /resume). "Undelivered" means unacked, so a channel-pushed message the old
  // conversation saw but never acked also moves and shows up again here.
  const target = mapped.peer_id;
  const keys = (db.query("SELECT COUNT(*) AS n FROM peer_sessions WHERE peer_id = ?").get(live.id) as { n: number }).n;
  if (keys <= 1) db.run("UPDATE messages SET to_id = ? WHERE to_id = ? AND delivered = 0", [target, live.id]);
  db.run("DELETE FROM peers WHERE id = ?", [target]);
  db.run("UPDATE peers SET id = ?, last_seen = ? WHERE id = ?", [target, now, live.id]);
  db.run("UPDATE peer_sessions SET updated_at = ? WHERE session_key = ?", [now, body.session_key]);
  return { ok: true, peer_id: target, action: "rekeyed" };
});

function handleSessionStart(body: SessionStartRequest): SessionStartResponse {
  if (typeof body?.session_key !== "string" || !body.session_key || !Number.isInteger(body.pid) || body.pid <= 1) {
    return { ok: false, reason: "bad_request" };
  }
  return sessionStart(body, new Date().toISOString());
}

/** Unread mail for the CLI peer a Claude Code process owns: the UserPromptSubmit nudge. */
function handleUnread(body: { pid: number }): { count: number } {
  if (!Number.isInteger(body?.pid)) return { count: 0 };
  const live = (db.query("SELECT id, pid, pid_started FROM peers WHERE pid = ? AND peer_type != 'desktop'")
    .all(body.pid) as { id: string; pid: number; pid_started: string | null }[]).find(isSameProcess);
  if (!live) return { count: 0 };
  const row = db.query("SELECT COUNT(*) AS n FROM messages WHERE to_id = ? AND delivered = 0").get(live.id) as { n: number };
  return { count: row.n };
}

function handleHeartbeat(body: HeartbeatRequest): void {
  const now = new Date().toISOString();
  updateLastSeen.run(now, body.id);
  // Keeps this peer's peer_sessions mapping alive past cleanStalePeers' 30-day
  // TTL as long as it keeps heartbeating. Without this, a session that
  // registered once and ran longer than the TTL would have its mapping swept
  // out from under it while still alive, and its next reconnect would mint a
  // new id. Single UPDATE, keyed on peer_id: heartbeat is a hot path.
  touchPeerSessionByPeerId.run(now, body.id);
}

function handleSetSummary(body: SetSummaryRequest): { ok: boolean; error?: string } {
  const peer = db.query("SELECT id, cwd, git_root, peer_type FROM peers WHERE id = ?").get(body.id) as { id: string; cwd: string; git_root: string | null; peer_type: string } | null;
  if (!peer) {
    return { ok: false, error: `Peer ${body.id} not found — re-register via /register` };
  }
  updateSummary.run(body.summary, body.id);
  // Persist to cache so future CLI sessions in this workspace inherit it.
  // Desktop sessions are excluded — they set fresh summaries and would collide in shared workspaces.
  if (peer.peer_type !== "desktop") {
    cacheSummary(peer.cwd, peer.git_root, body.summary);
  }
  return { ok: true };
}

function handleListPeers(body: ListPeersRequest): Peer[] {
  let peers: Peer[];

  switch (body.scope) {
    case "machine":
      peers = selectAllPeers.all() as Peer[];
      break;
    case "directory":
      peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      break;
    case "repo":
      if (body.git_root) {
        peers = selectPeersByGitRoot.all(body.git_root) as Peer[];
      } else {
        // No git root, fall back to directory
        peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      }
      break;
    default:
      peers = selectAllPeers.all() as Peer[];
  }

  // Exclude the requesting peer
  if (body.exclude_id) {
    peers = peers.filter((p) => p.id !== body.exclude_id);
  }

  // Verify each peer's process is still alive.
  // Desktop peers share one VM PID — skip the kill check; heartbeat timeout handles staleness.
  return peers.filter((p) => {
    if (p.peer_type === "desktop") return true;
    // A dead pid is hidden from this listing, not deleted here. Row cleanup is
    // cleanStalePeers' job, and mail is never deleted (see Task 4 rationale).
    return isPidAlive(p.pid);
  });
}

// --- WebSocket watchers ---
// A peer (or a harness Monitor on its behalf) opens ws://host/watch/<peer-id>
// and receives one JSON frame per inbound message. Frames are a wake signal
// only: nothing is acked here, so the message stays in the DB until the peer
// reads it via check_messages / poll.
type WatchData = { peer: string };
type WatchSocket = import("bun").ServerWebSocket<WatchData>;
const watchers = new Map<string, Set<WatchSocket>>();

function notifyWatchers(to_id: string, frame: unknown): number {
  const set = watchers.get(to_id);
  if (!set || set.size === 0) return 0;
  const payload = JSON.stringify(frame);
  let n = 0;
  for (const ws of set) {
    try { ws.send(payload); n++; } catch { /* dead socket; close handler cleans up */ }
  }
  return n;
}

function handleSendMessage(body: SendMessageRequest): { ok: boolean; error?: string; woke?: number; target_last_seen?: string; target_type?: string } {
  // Verify target exists
  const target = db.query("SELECT id, last_seen, peer_type FROM peers WHERE id = ?").get(body.to_id) as { id: string; last_seen: string; peer_type: string } | null;
  if (!target) {
    return { ok: false, error: `Peer ${body.to_id} not found (stale or expired ID — call list_peers and re-send)` };
  }

  const sent_at = new Date().toISOString();
  const res = insertMessage.run(body.from_id, body.to_id, body.text, sent_at);
  const sender = db.query(`SELECT summary, ${PUBLIC_CWD} AS cwd FROM peers WHERE id = ?`).get(body.from_id) as { summary: string; cwd: string } | null;
  const woke = notifyWatchers(body.to_id, {
    type: "peer_message",
    id: Number(res.lastInsertRowid),
    from_id: body.from_id,
    from_summary: sender?.summary ?? "",
    from_cwd: sender?.cwd ?? "",
    sent_at,
    text: body.text,
  });
  if (WAKE_ON && target.peer_type === "desktop") {
    const t = db.query("SELECT wake_topic FROM desktop_tokens WHERE peer_id = ? AND wake_topic IS NOT NULL").get(body.to_id) as { wake_topic: string } | null;
    if (t) publishWake(t.wake_topic);
  }
  return { ok: true, woke, target_last_seen: target.last_seen, target_type: target.peer_type };
}

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  const messages = selectUndelivered.all(body.id) as Message[];
  // Don't mark as delivered here — let the caller ack explicitly
  // so messages aren't lost when channel push silently fails.
  return { messages };
}

function handleAckMessages(body: AckMessagesRequest): void {
  // Only the recipient can mark its mail read.
  db.transaction(() => {
    for (const id of body.message_ids) {
      markDelivered.run(id, body.id);
    }
  })();
}

function handlePeekMessages(body: { id: string; since_id?: number }): PollMessagesResponse {
  const sinceId = body.since_id ?? 0;
  const messages = selectUndeliveredSince.all(body.id, sinceId) as Message[];
  // Don't mark as delivered — just peek
  return { messages };
}

function handleUnregister(body: { id: string }): void {
  deletePeer.run(body.id);
}

// --- HTTP Server ---

// --- Request gate ---
// Loopback is not a security boundary against the browser: any page Dean
// opens can POST here (a text/plain "simple request" needs no CORS
// preflight), and a DNS-rebinding page can read the answers too. Clients of
// this broker are local processes, so refuse anything that looks like a
// browser, and require the install secret on every POST.
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

// The body field naming the peer a route acts as. Those routes also need that
// peer's credential, so a caller can only act as the peer it registered.
const ACTS_AS: Record<string, "id" | "from_id"> = {
  "/send-message": "from_id",
  "/heartbeat": "id",
  "/set-summary": "id",
  "/poll-messages": "id",
  "/peek-messages": "id",
  "/ack-messages": "id",
  "/unregister": "id",
};
// `bun cli.ts send` speaks for the human at the terminal, not for a peer.
const OPERATOR_ID = "cli";

function gate(req: Request, path: string): Response | null {
  if (!ALLOWED_HOSTS.has(req.headers.get("host") ?? "")) {
    return new Response("forbidden host", { status: 403 });
  }
  // Local clients (servers, hooks, the CLI, Monitor) never send Origin.
  // Browsers always do on cross-site requests.
  if (req.headers.get("origin") !== null) {
    return new Response("forbidden origin", { status: 403 });
  }
  if (req.method !== "POST") return null;
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return new Response("content-type must be application/json", { status: 415 });
  }
  const bearer = req.headers.get("authorization")?.replace(/^Bearer /, "");
  if (!secretsEqual(bearer, SECRET)) {
    return Response.json({ ok: false, error: "missing or wrong broker secret" }, { status: 401 });
  }
  return null;
}

function actsAsCaller(req: Request, path: string, body: Record<string, unknown>): boolean {
  const field = ACTS_AS[path];
  if (!field) return true;
  const id = body?.[field];
  if (typeof id !== "string") return false;
  if (path === "/send-message" && id === OPERATOR_ID) return true;
  return secretsEqual(req.headers.get(PEER_HEADER), peerSecret(SECRET, id));
}

Bun.serve<WatchData>({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;

    const refused = gate(req, path);
    if (refused) return refused;

    if (req.method !== "POST") {
      if (path.startsWith("/watch/")) {
        // Origin was already refused above, so a web page can't hijack a
        // peer's message feed cross-site.
        const peer = decodeURIComponent(path.slice("/watch/".length));
        if (!peer) return new Response("missing peer id", { status: 400 });
        if (server.upgrade(req, { data: { peer } })) return;
        return new Response("websocket upgrade required", { status: 426 });
      }
      if (path === "/health") {
        return Response.json({ status: "ok", peers: (selectAllPeers.all() as Peer[]).length });
      }
      return new Response("claude-peers broker", { status: 200 });
    }

    try {
      const body = (await req.json()) as Record<string, any>;
      if (!actsAsCaller(req, path, body)) {
        return Response.json({ ok: false, error: `not authorized to act as ${String(body?.[ACTS_AS[path]!])}` }, { status: 403 });
      }

      switch (path) {
        case "/register":
          return Response.json(handleRegister(body as RegisterRequest));
        case "/heartbeat":
          handleHeartbeat(body as HeartbeatRequest);
          return Response.json({ ok: true });
        case "/set-summary": {
          const summaryResult = handleSetSummary(body as SetSummaryRequest);
          if (!summaryResult.ok) {
            return Response.json(summaryResult, { status: 404 });
          }
          return Response.json(summaryResult);
        }
        case "/list-peers":
          return Response.json(handleListPeers(body as ListPeersRequest));
        case "/send-message":
          return Response.json(handleSendMessage(body as SendMessageRequest));
        case "/poll-messages":
          return Response.json(handlePollMessages(body as PollMessagesRequest));
        case "/ack-messages":
          handleAckMessages(body as AckMessagesRequest);
          return Response.json({ ok: true });
        case "/peek-messages":
          return Response.json(handlePeekMessages(body as { id: string; since_id?: number }));
        case "/session-start":
          return Response.json(handleSessionStart(body as SessionStartRequest));
        case "/unread":
          return Response.json(handleUnread(body as { pid: number }));
        case "/unregister":
          handleUnregister(body as { id: string });
          return Response.json({ ok: true });
        default:
          return Response.json({ error: "not found" }, { status: 404 });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return Response.json({ error: msg }, { status: 500 });
    }
  },
  websocket: {
    open(ws) {
      let set = watchers.get(ws.data.peer);
      if (!set) watchers.set(ws.data.peer, (set = new Set()));
      set.add(ws);
      ws.send(JSON.stringify({ type: "watching", peer: ws.data.peer }));
    },
    close(ws) {
      const set = watchers.get(ws.data.peer);
      set?.delete(ws);
      if (set && set.size === 0) watchers.delete(ws.data.peer);
    },
    message() { /* watchers are receive-only */ },
  },
});

console.error(`[claude-peers broker] listening on 127.0.0.1:${PORT} (db: ${DB_PATH})`);
