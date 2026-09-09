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
  Peer,
  Message,
} from "./shared/types.ts";

const PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const DB_PATH = process.env.CLAUDE_PEERS_DB ?? `${process.env.HOME}/.claude-peers.db`;

// --- Database setup ---

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");

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

// Idempotent: INSERT OR IGNORE means re-running on an already-migrated
// database is a no-op, never a duplicate or a constraint error.
db.run(`
  INSERT OR IGNORE INTO peer_sessions (session_key, peer_id, peer_type, updated_at)
  SELECT token, peer_id, 'desktop', updated_at FROM desktop_tokens
`);

// Clean up stale peers (PIDs that no longer exist) on startup
function cleanStalePeers() {
  // PID liveness applies to CLI peers only. A desktop peer's pid is whichever
  // MCP server process happened to serve its last call — Desktop spawns
  // several and respawns them on bridge reconnects — so reaping desktop peers
  // by pid deleted live sessions (and their undelivered messages) every time
  // a bridge process exited. Desktop peers are reaped by heartbeat below.
  const peers = db.query("SELECT id, pid, peer_type FROM peers WHERE peer_type != 'desktop'").all() as { id: string; pid: number; peer_type: string }[];
  for (const peer of peers) {
    try {
      // Check if process is still alive (signal 0 doesn't kill, just checks)
      process.kill(peer.pid, 0);
    } catch {
      // Process doesn't exist, remove it
      db.run("DELETE FROM peers WHERE id = ?", [peer.id]);
      db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [peer.id]);
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
  db.run("DELETE FROM summary_cache WHERE updated_at < ?", [new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()]);
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

const updateLastSeen = db.prepare(`
  UPDATE peers SET last_seen = ? WHERE id = ?
`);

const updateSummary = db.prepare(`
  UPDATE peers SET summary = ? WHERE id = ?
`);

const deletePeer = db.prepare(`
  DELETE FROM peers WHERE id = ?
`);

const selectAllPeers = db.prepare(`
  SELECT * FROM peers
`);

const selectPeersByDirectory = db.prepare(`
  SELECT * FROM peers WHERE cwd = ?
`);

const selectPeersByGitRoot = db.prepare(`
  SELECT * FROM peers WHERE git_root = ?
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
  UPDATE messages SET delivered = 1 WHERE id = ?
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

function handleRegister(body: RegisterRequest): RegisterResponse {
  const now = new Date().toISOString();

  const peerType = body.peer_type ?? "cli";
  const isCli = peerType !== "desktop";

  // Desktop sessions keyed by token get their existing peer back. This is
  // what keeps a Cowork session's peer id stable across the several MCP
  // server processes Desktop runs (and respawns) for the same session.
  const token = !isCli && body.session_token ? body.session_token : null;
  const cliKey = isCli && body.session_key ? body.session_key : null;
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
      insertPeer.run(mapped.peer_id, body.pid, body.cwd, body.git_root, body.tty, body.summary ?? "", peerType, now, now, token);
      db.run("UPDATE desktop_tokens SET updated_at = ? WHERE token = ?", [now, token]);
      db.run("UPDATE peer_sessions SET updated_at = ? WHERE session_key = ?", [now, token]);
      return { id: mapped.peer_id };
    }
  }

  const id = generateId();
  if (token) {
    db.run("INSERT OR REPLACE INTO desktop_tokens (token, peer_id, updated_at) VALUES (?, ?, ?)", [token, id, now]);
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
      const live = db.query("SELECT id, summary FROM peers WHERE id = ?")
        .get(mapped.peer_id) as { id: string; summary: string } | null;
      let resurrectedSummary: string | undefined;
      if (live) {
        db.run(
          "UPDATE peers SET pid = ?, cwd = ?, git_root = ?, tty = ?, last_seen = ?, summary = CASE WHEN ? = '' THEN summary ELSE ? END WHERE id = ?",
          [body.pid, body.cwd, body.git_root, body.tty, now, body.summary ?? "", body.summary ?? "", live.id],
        );
      } else {
        // Row was reaped but the session is back: resurrect under the SAME id
        // so mail queued for it is still addressed correctly. Fall back to the
        // cached workspace summary when none was supplied, same as a fresh peer
        // (below), so a reaped-and-restarted session doesn't rejoin blank.
        let summaryToInsert = body.summary;
        if (!summaryToInsert) {
          summaryToInsert = getCachedSummary(body.cwd, body.git_root) ?? "";
          if (summaryToInsert) resurrectedSummary = summaryToInsert;
        }
        insertPeer.run(mapped.peer_id, body.pid, body.cwd, body.git_root, body.tty, summaryToInsert, peerType, now, now, null);
      }
      db.run("UPDATE peer_sessions SET updated_at = ? WHERE session_key = ?", [now, cliKey]);
      if (body.summary) cacheSummary(body.cwd, body.git_root, body.summary);
      const restored = live ? (!body.summary ? (live.summary || undefined) : undefined) : resurrectedSummary;
      return { id: mapped.peer_id, restored_summary: restored };
    }
  } else if (isCli) {
    // CLI re-registration for a pid we already know (the Claude Code session
    // pid — its MCP server process may have been respawned by /mcp reconnect):
    // keep the SAME peer id so addresses other agents hold stay valid, and keep
    // the summary unless a new one is given.
    const existing = db.query("SELECT id, summary FROM peers WHERE pid = ? AND peer_type != 'desktop'").get(body.pid) as { id: string; summary: string } | null;
    if (existing) {
      db.run(
        "UPDATE peers SET cwd = ?, git_root = ?, tty = ?, last_seen = ?, summary = CASE WHEN ? = '' THEN summary ELSE ? END WHERE id = ?",
        [body.cwd, body.git_root, body.tty, now, body.summary ?? "", body.summary ?? "", existing.id],
      );
      if (body.summary) cacheSummary(body.cwd, body.git_root, body.summary);
      return { id: existing.id, restored_summary: body.summary ? undefined : existing.summary || undefined };
    }
  }

  // Carry forward cached summary for CLI sessions in the same workspace.
  // Desktop sessions always set fresh summaries and would collide on one cache slot.
  let summary = body.summary;
  if (!summary && isCli) {
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

function handleHeartbeat(body: HeartbeatRequest): void {
  updateLastSeen.run(new Date().toISOString(), body.id);
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
    try {
      process.kill(p.pid, 0);
      return true;
    } catch {
      deletePeer.run(p.id);
      return false;
    }
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
  const sender = db.query("SELECT summary, cwd FROM peers WHERE id = ?").get(body.from_id) as { summary: string; cwd: string } | null;
  const woke = notifyWatchers(body.to_id, {
    type: "peer_message",
    id: Number(res.lastInsertRowid),
    from_id: body.from_id,
    from_summary: sender?.summary ?? "",
    from_cwd: sender?.cwd ?? "",
    sent_at,
    text: body.text,
  });
  return { ok: true, woke, target_last_seen: target.last_seen, target_type: target.peer_type };
}

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  const messages = selectUndelivered.all(body.id) as Message[];
  // Don't mark as delivered here — let the caller ack explicitly
  // so messages aren't lost when channel push silently fails.
  return { messages };
}

function handleAckMessages(body: AckMessagesRequest): void {
  db.transaction(() => {
    for (const id of body.message_ids) {
      markDelivered.run(id);
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

Bun.serve<WatchData>({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method !== "POST") {
      if (path.startsWith("/watch/")) {
        // Watchers are local harness processes (Monitor, cli.ts watch), which
        // never send an Origin header. Browsers always do — refuse them so a
        // web page can't hijack a peer's message feed cross-site.
        if (req.headers.get("origin") !== null) {
          return new Response("forbidden origin", { status: 403 });
        }
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
      const body = await req.json();

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
        case "/unregister":
          handleUnregister(body as { id: string });
          return Response.json({ ok: true });
        case "/debug-peer-sessions":
          return Response.json({ rows: db.query("SELECT * FROM peer_sessions").all() });
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
