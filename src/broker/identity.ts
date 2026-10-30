/**
 * Peer identity: registration, the durable session_key -> peer id mapping,
 * the SessionStart re-key, and per-peer and per-workspace summaries.
 */

import { peerSecret } from "../shared/auth.ts";
import type {
  Peer,
  RegisterRequest,
  RegisterResponse,
  SessionStartRequest,
  SessionStartResponse,
} from "../shared/types.ts";
import { WAKE_RELAY } from "./config.ts";
import {
  SECRET,
  db,
  insertPeer,
  selectPeerBySessionToken,
  selectSummaryCache,
  touchPeerBySessionToken,
  upsertSummaryCache,
} from "./db.ts";
import { isPidAlive, isSameProcess, pidStartTime } from "./liveness.ts";
import { activeWakeUrl } from "./wake.ts";

function ownSummary(peerId: string): string | null {
  const row = db.query("SELECT summary FROM peer_summaries WHERE peer_id = ?").get(peerId) as {
    summary: string;
  } | null;
  return row?.summary ?? null;
}

// --- Generate peer ID ---

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  while (id.length < 8) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      // 252 = 7 * 36: dropping 252-255 keeps every char equally likely.
      if (b < 252 && id.length < 8) id += chars[b % chars.length];
    }
  }
  return id;
}

// --- Summary cache helpers ---

function summaryCacheKey(cwd: string, git_root: string | null): string {
  return git_root ?? cwd;
}

export function cacheSummary(cwd: string, git_root: string | null, summary: string): void {
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
function claimPeerByPid(
  pid: number,
  body: RegisterRequest,
  now: string,
  cliKey: string | null,
): { id: string; restored_summary?: string } | null {
  const existing = (
    db.query("SELECT id, summary, pid, pid_started FROM peers WHERE pid = ? AND peer_type != 'desktop'").all(pid) as {
      id: string;
      summary: string;
      pid: number;
      pid_started: string | null;
    }[]
  ).find(isSameProcess);
  if (!existing) return null;
  db.run(
    "UPDATE peers SET cwd = ?, git_root = ?, tty = ?, last_seen = ?, summary = CASE WHEN ? = '' THEN summary ELSE ? END WHERE id = ?",
    [body.cwd, body.git_root, body.tty, now, body.summary ?? "", body.summary ?? "", existing.id],
  );
  if (cliKey) {
    db.run(
      "INSERT OR REPLACE INTO peer_sessions (session_key, peer_id, peer_type, updated_at) VALUES (?, ?, 'cli', ?)",
      [cliKey, existing.id, now],
    );
  }
  if (body.summary) cacheSummary(body.cwd, body.git_root, body.summary);
  return { id: existing.id, restored_summary: body.summary ? undefined : existing.summary || undefined };
}

export function handleRegister(body: RegisterRequest): RegisterResponse {
  const res = registerPeer(body);
  if ((body.peer_type ?? "cli") !== "desktop") {
    db.run("UPDATE peers SET pid_started = ? WHERE id = ?", [pidStartTime(body.pid), res.id]);
  } else if (body.session_token) {
    // The full subscribe base, so the server never pairs this topic with a
    // relay of its own (its env may differ from the one that launched us).
    res.wake_url = activeWakeUrl(body.session_token);
    if (res.wake_url) res.wake_topic = res.wake_url.slice(WAKE_RELAY.length + 1);
  }
  return { ...res, peer_secret: peerSecret(SECRET, res.id) };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: identity precedence (token, session key, pid, new id) reads top to bottom; splitting it is its own change
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
    const mapped = db.query("SELECT peer_id FROM desktop_tokens WHERE token = ?").get(token) as {
      peer_id: string;
    } | null;
    if (mapped) {
      const restored = body.summary ? undefined : (ownSummary(mapped.peer_id) ?? undefined);
      insertPeer.run(
        mapped.peer_id,
        body.pid,
        body.cwd,
        body.git_root,
        body.tty,
        body.summary || restored || "",
        peerType,
        now,
        now,
        token,
      );
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
    db.run("INSERT OR REPLACE INTO peer_sessions (session_key, peer_id, peer_type, updated_at) VALUES (?, ?, ?, ?)", [
      token,
      id,
      "desktop",
      now,
    ]);
  }

  // CLI identity. Prefer Claude Code's session id: it survives process death,
  // so a restarted session gets its id (and its queued mail) back. Fall back
  // to pid matching when no key was supplied.
  // Desktop sessions share one VM PID, so PID-based matching would conflate
  // other active sessions; they are keyed by session_token above instead.
  if (cliKey) {
    const mapped = db.query("SELECT peer_id FROM peer_sessions WHERE session_key = ?").get(cliKey) as {
      peer_id: string;
    } | null;
    if (mapped) {
      const live = db.query("SELECT id, summary, pid, pid_started FROM peers WHERE id = ?").get(mapped.peer_id) as {
        id: string;
        summary: string;
        pid: number;
        pid_started: string | null;
      } | null;
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
        insertPeer.run(
          mapped.peer_id,
          body.pid,
          body.cwd,
          body.git_root,
          body.tty,
          summaryToInsert,
          peerType,
          now,
          now,
          null,
        );
      }
      db.run("UPDATE peer_sessions SET updated_at = ? WHERE session_key = ?", [now, cliKey]);
      if (body.summary) cacheSummary(body.cwd, body.git_root, body.summary);
      const restored = live ? (!body.summary ? live.summary || undefined : undefined) : resurrectedSummary;
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

function mintPeer(
  body: RegisterRequest,
  now: string,
  cliKey: string | null,
  peerType: string,
  isCli: boolean,
  id = generateId(),
  token: string | null = null,
): RegisterResponse {
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
    db.run(
      "INSERT OR REPLACE INTO peer_sessions (session_key, peer_id, peer_type, updated_at) VALUES (?, ?, 'cli', ?)",
      [cliKey, id, now],
    );
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
  const row = db
    .query("SELECT session_key FROM process_sessions WHERE pid = ? AND pid_started = ?")
    .get(pid, started) as { session_key: string } | null;
  return row?.session_key ?? null;
}

const sessionStart = db.transaction((body: SessionStartRequest, now: string): SessionStartResponse => {
  const live = (
    db.query("SELECT id, pid, pid_started FROM peers WHERE pid = ? AND peer_type != 'desktop'").all(body.pid) as {
      id: string;
      pid: number;
      pid_started: string | null;
    }[]
  ).find(isSameProcess);
  if (!live) return { ok: false, reason: "no_live_peer" };

  // From now on this process registers under the live session, not the key
  // its server was spawned with. Recorded only once the call is accepted: a
  // refused conflict must leave the process where it was.
  const recordLiveSession = () => {
    const started = pidStartTime(body.pid);
    if (started) {
      db.run(
        "INSERT OR REPLACE INTO process_sessions (pid, pid_started, session_key, updated_at) VALUES (?, ?, ?, ?)",
        [body.pid, started, body.session_key, now],
      );
    }
  };

  const mapped = db.query("SELECT peer_id FROM peer_sessions WHERE session_key = ?").get(body.session_key) as {
    peer_id: string;
  } | null;
  if (!mapped) {
    recordLiveSession();
    db.run("INSERT INTO peer_sessions (session_key, peer_id, peer_type, updated_at) VALUES (?, ?, 'cli', ?)", [
      body.session_key,
      live.id,
      now,
    ]);
    return { ok: true, peer_id: live.id, action: "mapped" };
  }
  if (mapped.peer_id === live.id) {
    recordLiveSession();
    db.run("UPDATE peer_sessions SET updated_at = ? WHERE session_key = ?", [now, body.session_key]);
    return { ok: true, peer_id: live.id, action: "noop" };
  }

  // The same conversation is open in another terminal that is still running:
  // that process owns the id. Leave both alone.
  const owner = db.query("SELECT pid, pid_started FROM peers WHERE id = ?").get(mapped.peer_id) as {
    pid: number;
    pid_started: string | null;
  } | null;
  if (owner && owner.pid !== live.pid && isPidAlive(owner.pid) && isSameProcess(owner))
    return { ok: false, reason: "conflict" };
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

export function handleSessionStart(body: SessionStartRequest): SessionStartResponse {
  if (typeof body?.session_key !== "string" || !body.session_key || !Number.isInteger(body.pid) || body.pid <= 1) {
    return { ok: false, reason: "bad_request" };
  }
  return sessionStart(body, new Date().toISOString());
}
