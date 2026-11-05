/**
 * Message routes and the /watch WebSocket wake feed.
 */

import type {
  AckMessagesRequest,
  Message,
  PeerType,
  PollMessagesRequest,
  PollMessagesResponse,
  SendMessageRequest,
} from "../shared/types.ts";
import { WAKE_ON } from "./config.ts";
import { db, insertMessage, markDelivered, selectUndelivered, selectUndeliveredSince } from "./db.ts";
import { effectiveWakeMode, publishWake } from "./wake.ts";

// --- WebSocket watchers ---
// A peer (or a harness Monitor on its behalf) opens ws://host/watch/<peer-id>
// with that peer's credentials and receives one {"type":"wake"} frame per
// inbound message. Frames carry no content and ack nothing: the message stays
// in the DB until the peer reads it via check_messages / poll, which is
// credentialed on its own.
export type WatchData = { peer: string };
type WatchSocket = import("bun").ServerWebSocket<WatchData>;
export const watchers = new Map<string, Set<WatchSocket>>();

function notifyWatchers(to_id: string, frame: unknown): number {
  const set = watchers.get(to_id);
  if (!set || set.size === 0) return 0;
  const payload = JSON.stringify(frame);
  let n = 0;
  for (const ws of set) {
    try {
      ws.send(payload);
      n++;
    } catch {
      /* dead socket; close handler cleans up */
    }
  }
  return n;
}

/** Store a message for `to_id`. Callers announce it afterward with `announce`. */
export function storeMessage(from_id: string, to_id: string, text: string): void {
  insertMessage.run(from_id, to_id, text, new Date().toISOString());
}

/** Wake `to_id`'s watchers and, for an active-wake Desktop peer, publish to the relay. */
export function announce(to_id: string): { woke: number; target_type: PeerType | null } {
  const woke = notifyWatchers(to_id, { type: "wake" });
  const target_type = peerTypeOf(to_id);
  if (WAKE_ON && target_type === "desktop") {
    const t = db
      .query("SELECT wake_topic, wake_mode FROM desktop_tokens WHERE peer_id = ? AND wake_topic IS NOT NULL")
      .get(to_id) as { wake_topic: string; wake_mode: string | null } | null;
    if (t && effectiveWakeMode(t.wake_mode) === "active") publishWake(t.wake_topic);
  }
  return { woke, target_type };
}

/** From `peers`, falling back to the durable `peer_sessions` mapping. */
function peerTypeOf(id: string): PeerType | null {
  const row =
    db.query("SELECT peer_type FROM peers WHERE id = ?").get(id) ??
    db.query("SELECT peer_type FROM peer_sessions WHERE peer_id = ? LIMIT 1").get(id);
  return ((row as { peer_type: PeerType } | null)?.peer_type as PeerType | undefined) ?? null;
}

/** Insert a message and announce it. */
export function deliver(from_id: string, to_id: string, text: string) {
  storeMessage(from_id, to_id, text);
  return announce(to_id);
}

export function handleSendMessage(body: SendMessageRequest): {
  ok: boolean;
  error?: string;
  woke?: number;
  target_last_seen?: string;
  target_type?: string;
} {
  // Verify target exists
  const target = db.query("SELECT id, last_seen, peer_type FROM peers WHERE id = ?").get(body.to_id) as {
    id: string;
    last_seen: string;
    peer_type: string;
  } | null;
  if (!target) {
    return { ok: false, error: `Peer ${body.to_id} not found (stale or expired ID — call list_peers and re-send)` };
  }

  const { woke } = deliver(body.from_id, body.to_id, body.text);
  return { ok: true, woke, target_last_seen: target.last_seen, target_type: target.peer_type };
}

export function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  const messages = selectUndelivered.all(body.id) as Message[];
  // Don't mark as delivered here — let the caller ack explicitly
  // so messages aren't lost when channel push silently fails.
  return { messages };
}

export function handleAckMessages(body: AckMessagesRequest): void {
  // Only the recipient can mark its mail read.
  db.transaction(() => {
    for (const id of body.message_ids) {
      markDelivered.run(id, body.id);
    }
  })();
}

export function handlePeekMessages(body: { id: string; since_id?: number }): PollMessagesResponse {
  const sinceId = body.since_id ?? 0;
  const messages = selectUndeliveredSince.all(body.id, sinceId) as Message[];
  // Don't mark as delivered — just peek
  return { messages };
}
