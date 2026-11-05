/**
 * Process liveness and the stale-peer sweep.
 */

import { db } from "./db.ts";

/** Signal 0 checks existence without killing. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The process's start time as `ps` reports it, or null if it isn't running. */
export function pidStartTime(pid: number): string | null {
  // Fixed locale and zone: the broker inherits its environment from whichever
  // session auto-launched it, and a restart under another LANG/TZ must not make
  // every recorded value mismatch.
  const out = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], {
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  });
  return new TextDecoder().decode(out.stdout).trim() || null;
}

/** True unless the row's recorded start time shows its pid now belongs to another process. */
export function isSameProcess(row: { pid: number; pid_started: string | null }): boolean {
  return row.pid_started == null || pidStartTime(row.pid) === row.pid_started;
}

// Clean up stale peers (PIDs that no longer exist) on startup
export function cleanStalePeers() {
  // PID liveness applies to CLI peers only. A desktop peer's pid is whichever
  // MCP server process happened to serve its last call — Desktop spawns
  // several and respawns them on bridge reconnects — so reaping desktop peers
  // by pid deleted live sessions (and their undelivered messages) every time
  // a bridge process exited. Desktop peers are reaped by heartbeat below.
  const peers = db.query("SELECT id, pid, peer_type FROM peers WHERE peer_type != 'desktop'").all() as {
    id: string;
    pid: number;
    peer_type: string;
  }[];
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
  db.run("DELETE FROM messages WHERE delivered = 1 AND sent_at < ?", [
    new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
  ]);
  db.run("DELETE FROM messages WHERE delivered = 0 AND sent_at < ?", [
    new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString(),
  ]);
  db.run("DELETE FROM desktop_tokens WHERE updated_at < ?", [
    new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
  ]);
  db.run("DELETE FROM process_sessions WHERE updated_at < ?", [
    new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
  ]);
  // Same 30-day TTL as desktop_tokens above. Safe only because handleHeartbeat
  // refreshes peer_sessions.updated_at on every heartbeat (see touchPeerSessionByPeerId)
  // — otherwise a session alive longer than the TTL would have its mapping
  // swept out from under it and mint a new id on its next reconnect.
  db.run("DELETE FROM peer_sessions WHERE updated_at < ?", [
    new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
  ]);
  db.run("DELETE FROM summary_cache WHERE updated_at < ?", [
    new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
  ]);
  db.run("DELETE FROM peer_summaries WHERE updated_at < ?", [
    new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
  ]);
  sweepDecisionQueue();
}

const CLEARED_QUESTION = "(question text cleared after 7 days)";

/**
 * Decision queue retention. Events live a week. Settled requests lose their
 * text after a day and the row after a week. Open requests are never deleted
 * (a human may still answer) but lose their text after a week. digest_cursors
 * are tiny and must outlive a quiet week.
 */
function sweepDecisionQueue() {
  let changed = 0;
  const run = (sql: string, params: (string | null)[]) => {
    changed += db.run(sql, params).changes;
  };
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const day = 24 * 60 * 60 * 1000;
  run("DELETE FROM events WHERE created_at < ?", [ago(7 * day)]);
  run("DELETE FROM input_requests WHERE state IN ('answered', 'canceled') AND answered_at < ?", [ago(7 * day)]);
  // waiting_for and urgency are agent-written free text, so they go with the
  // question. The "already cleared" guards keep a settled row from being
  // rewritten on every sweep.
  run(
    `UPDATE input_requests
     SET question = '', answer = NULL, escalation_note = NULL, waiting_for = 'input needed', urgency = 'normal'
     WHERE state IN ('answered', 'canceled') AND answered_at < ?
       AND (question != '' OR answer IS NOT NULL OR escalation_note IS NOT NULL
            OR waiting_for != 'input needed' OR urgency != 'normal')`,
    [ago(day)],
  );
  run(
    `UPDATE input_requests
     SET question = ?1, escalation_note = NULL, waiting_for = 'input needed', urgency = 'normal'
     WHERE state IN ('pending', 'escalated') AND question_at < ?2
       AND (question != ?1 OR escalation_note IS NOT NULL
            OR waiting_for != 'input needed' OR urgency != 'normal')`,
    [CLEARED_QUESTION, ago(7 * day)],
  );
  // Truncating the WAL drops the pre-clear page images. A busy result (an
  // open reader) is fine: the next sweep that changes something retries.
  if (changed > 0) db.run("PRAGMA wal_checkpoint(TRUNCATE)");
}
