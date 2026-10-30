/**
 * Peer routes that need no identity work: heartbeat, summaries, listing,
 * the unread count and unregister.
 */

import type { HeartbeatRequest, ListPeersRequest, Peer, SetSummaryRequest } from "../shared/types.ts";
import {
  db,
  deletePeer,
  selectAllPeers,
  selectPeersByDirectory,
  selectPeersByGitRoot,
  touchPeerSessionByPeerId,
  updateLastSeen,
  updateSummary,
} from "./db.ts";
import { cacheSummary } from "./identity.ts";
import { isPidAlive, isSameProcess } from "./liveness.ts";
import { activeWakeUrl } from "./wake.ts";

/** Unread mail for the CLI peer a Claude Code process owns: the UserPromptSubmit nudge. */
export function handleUnread(body: { pid: number }): { count: number } {
  if (!Number.isInteger(body?.pid)) return { count: 0 };
  const live = (
    db.query("SELECT id, pid, pid_started FROM peers WHERE pid = ? AND peer_type != 'desktop'").all(body.pid) as {
      id: string;
      pid: number;
      pid_started: string | null;
    }[]
  ).find(isSameProcess);
  if (!live) return { count: 0 };
  const row = db.query("SELECT COUNT(*) AS n FROM messages WHERE to_id = ? AND delivered = 0").get(live.id) as {
    n: number;
  };
  return { count: row.n };
}

export function handleHeartbeat(body: HeartbeatRequest): { ok: boolean; error?: string; wake_url?: string } {
  const now = new Date().toISOString();
  // A reaped peer has no row to touch. Say so, so its server can re-register
  // it instead of heartbeating a row that is gone while nobody can reach it.
  const found = updateLastSeen.run(now, body.id).changes > 0;
  // Keeps this peer's peer_sessions mapping alive past cleanStalePeers' 30-day
  // TTL as long as it keeps heartbeating. Without this, a session that
  // registered once and ran longer than the TTL would have its mapping swept
  // out from under it while still alive, and its next reconnect would mint a
  // new id. Single UPDATE, keyed on peer_id: heartbeat is a hot path.
  touchPeerSessionByPeerId.run(now, body.id);
  if (!found) return { ok: false, error: `Peer ${body.id} not found` };
  // A desktop session learns about wake mode switches here, within one heartbeat.
  const t = db.query("SELECT token FROM desktop_tokens WHERE peer_id = ? ORDER BY updated_at DESC").get(body.id) as {
    token: string;
  } | null;
  return { ok: true, wake_url: t ? activeWakeUrl(t.token) : undefined };
}

export function handleSetSummary(body: SetSummaryRequest): { ok: boolean; error?: string } {
  const peer = db.query("SELECT id, cwd, git_root, peer_type FROM peers WHERE id = ?").get(body.id) as {
    id: string;
    cwd: string;
    git_root: string | null;
    peer_type: string;
  } | null;
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

export function handleListPeers(body: ListPeersRequest): Peer[] {
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

export function handleUnregister(body: { id: string }): void {
  deletePeer.run(body.id);
}
