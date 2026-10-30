/**
 * The broker's SQLite database: opened owner-only, schema and migrations
 * applied on import, and the prepared statements the handlers share.
 */

import { Database } from "bun:sqlite";
import { chmodSync } from "node:fs";
import { ensureSecret, secretPath } from "../shared/auth.ts";
import { DB_PATH } from "./config.ts";

// --- Database setup ---

// Every file the broker creates (DB, -wal, -shm, secret) is owner-only, even
// one SQLite recreates mid-run after the startup chmod below.
process.umask(0o077);

export const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");
// The DB holds every peer's mail and session tokens: owner-only.
for (const suffix of ["", "-wal", "-shm"]) {
  try {
    chmodSync(DB_PATH + suffix, 0o600);
  } catch {
    /* not created yet */
  }
}

export const SECRET = ensureSecret(secretPath(DB_PATH));

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
// A session's own wake mode ('active' | 'passive'); NULL follows the global one.
if (!(db.query("PRAGMA table_info(desktop_tokens)").all() as { name: string }[]).some((c) => c.name === "wake_mode")) {
  db.run("ALTER TABLE desktop_tokens ADD COLUMN wake_mode TEXT");
}
// Broker-wide settings that must survive a restart, including the auto-spawn
// that doesn't inherit the environment of the broker it replaces.
db.run("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");

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

// Idempotent: INSERT OR IGNORE means re-running on an already-migrated
// database is a no-op, never a duplicate or a constraint error.
db.run(`
  INSERT OR IGNORE INTO peer_sessions (session_key, peer_id, peer_type, updated_at)
  SELECT token, peer_id, 'desktop', updated_at FROM desktop_tokens
`);

// --- Prepared statements ---

export const insertPeer = db.prepare(`
  INSERT INTO peers (id, pid, cwd, git_root, tty, summary, peer_type, registered_at, last_seen, session_token)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export const selectPeerBySessionToken = db.prepare(`
  SELECT * FROM peers WHERE session_token = ?
`);

export const touchPeerBySessionToken = db.prepare(`
  UPDATE peers SET pid = ?, last_seen = ?, summary = CASE WHEN ? = '' THEN summary ELSE ? END WHERE session_token = ?
`);

export const touchPeerSessionByPeerId = db.prepare(`
  UPDATE peer_sessions SET updated_at = ? WHERE peer_id = ?
`);

export const updateLastSeen = db.prepare(`
  UPDATE peers SET last_seen = ? WHERE id = ?
`);

export const updateSummary = db.prepare(`
  UPDATE peers SET summary = ? WHERE id = ?
`);

export const deletePeer = db.prepare(`
  DELETE FROM peers WHERE id = ?
`);

// What other peers may see of a peer. Never SELECT * here: session_token is
// a desktop session's bearer identity. Older desktop rows also carry the
// token as their cwd (servers registered with cwd = token), so mask it there.
const PUBLIC_CWD =
  "CASE WHEN session_token IS NOT NULL AND instr(cwd, session_token) > 0 THEN replace(cwd, session_token, '(desktop session)') ELSE cwd END";
const PUBLIC_PEER_COLUMNS = `id, pid, ${PUBLIC_CWD} AS cwd, git_root, tty, summary, peer_type, registered_at, last_seen`;

export const selectAllPeers = db.prepare(`
  SELECT ${PUBLIC_PEER_COLUMNS} FROM peers
`);

export const selectPeersByDirectory = db.prepare(`
  SELECT ${PUBLIC_PEER_COLUMNS} FROM peers WHERE cwd = ?
`);

export const selectPeersByGitRoot = db.prepare(`
  SELECT ${PUBLIC_PEER_COLUMNS} FROM peers WHERE git_root = ?
`);

export const insertMessage = db.prepare(`
  INSERT INTO messages (from_id, to_id, text, sent_at, delivered)
  VALUES (?, ?, ?, ?, 0)
`);

export const selectUndelivered = db.prepare(`
  SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC
`);

export const selectUndeliveredSince = db.prepare(`
  SELECT * FROM messages WHERE to_id = ? AND delivered = 0 AND id > ? ORDER BY sent_at ASC
`);

export const upsertSummaryCache = db.prepare(`
  INSERT INTO summary_cache (key, summary, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET summary = excluded.summary, updated_at = excluded.updated_at
`);

export const selectSummaryCache = db.prepare(`
  SELECT summary FROM summary_cache WHERE key = ?
`);

export const markDelivered = db.prepare(`
  UPDATE messages SET delivered = 1 WHERE id = ? AND to_id = ?
`);
