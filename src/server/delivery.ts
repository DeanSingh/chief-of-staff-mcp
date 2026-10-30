/**
 * Message delivery: per-peer poll cursors and unread previews, channel
 * pushes, piggybacking on tool results, and acks.
 */

import type { Message, Peer, PeerId, PollMessagesResponse } from "../shared/types.ts";
import { brokerFetch } from "./client.ts";
import { log } from "./log.ts";
import { mcp } from "./mcp.ts";
import { desktopPeers, state } from "./state.ts";

// --- Tool handlers ---

// Per-peer delivery state. One server polls every Desktop session it serves,
// and a CLI peer's id can change (re-register, /resume re-key), so the poll
// cursor and the unread preview belong to a peer id, never to the process.
type Inbox = { lastSeen: number; preview: string };
export const inboxes = new Map<PeerId, Inbox>();

function inboxFor(peerId: PeerId): Inbox {
  let inbox = inboxes.get(peerId);
  if (!inbox) {
    inbox = { lastSeen: 0, preview: "" };
    inboxes.set(peerId, inbox);
  }
  return inbox;
}

/** Drops a peer's unread preview once its mail is read, and refreshes the tool list. */
export async function clearPreview(peerId: PeerId): Promise<void> {
  const inbox = inboxes.get(peerId);
  if (!inbox?.preview) return;
  inbox.preview = "";
  try {
    await mcp.notification({ method: "notifications/tools/list_changed" });
  } catch {
    /* non-critical */
  }
}

/**
 * The check_messages banner. tools/list doesn't say which session is asking,
 * so the banner quotes mail only on a CLI server serving exactly one peer.
 * Every session on a Desktop server shares one tool list, including sessions
 * that haven't called a tool yet: one session's mail must not appear in
 * another's tool list.
 */
export function unreadBanner(previews: string[], peerType: "cli" | "desktop", servedPeers: number): string {
  if (previews.length === 0) return "";
  if (peerType === "cli" && servedPeers === 1)
    return `⚠️ NEW MESSAGES WAITING — CALL THIS TOOL NOW.\n\nPreview: ${previews.join(" | ")}`;
  return "⚠️ New peer messages are waiting for at least one session on this server. Call this tool to see whether they are yours.";
}

// --- Piggyback message delivery on every tool call ---
// Appends pending messages to any tool response so Desktop sessions
// get messages opportunistically without calling check_messages.

export async function appendPendingMessages(
  result: { content: { type: string; text: string }[] },
  toolName: string,
  effectivePeerId: PeerId | null,
) {
  if (!effectivePeerId || toolName === "check_messages" || !inboxes.get(effectivePeerId)?.preview) return result;
  try {
    const pending = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: effectivePeerId }, effectivePeerId);
    if (pending.messages.length > 0) {
      await ackMessages(effectivePeerId, pending.messages);
      await clearPreview(effectivePeerId);
      const inbox = pending.messages.map((m) => `From ${m.from_id} (${m.sent_at}):\n${m.text}`).join("\n\n---\n\n");
      result.content.push({
        type: "text" as const,
        text: `\n\n📨 ${pending.messages.length} new message(s) arrived:\n\n${inbox}`,
      });
    }
  } catch {
    // Non-critical
  }
  return result;
}

// --- Message ack helper ---

// Highest message id this server has seen for any peer; only bounds the prune below.
let highestMessageId = 0;
// Track message IDs already pushed via channel to avoid re-pushing every poll cycle.
// Messages are NOT acked by the poll loop — only check_messages/piggybacking acks them —
// so they remain available as a fallback when channels aren't active.
const pushedMessageIds = new Set<number>();

export async function ackMessages(peerId: PeerId, messages: Message[]): Promise<void> {
  const ids = messages.map((m) => m.id);
  await brokerFetch("/ack-messages", { id: peerId, message_ids: ids }, peerId);
  const inbox = inboxFor(peerId);
  for (const id of ids) {
    pushedMessageIds.add(id);
    if (id > inbox.lastSeen) inbox.lastSeen = id;
    if (id > highestMessageId) highestMessageId = id;
  }
  // Prune old entries — only IDs near the high-water mark matter
  if (pushedMessageIds.size > 1000) {
    const threshold = highestMessageId - 500;
    for (const id of pushedMessageIds) {
      if (id < threshold) pushedMessageIds.delete(id);
    }
  }
}

// --- Polling loop for inbound messages ---

/** The peer list, for sender details, when any of `messages` is still to be pushed. */
async function sendersFor(messages: Message[]): Promise<Peer[] | null> {
  if (!messages.some((m) => !pushedMessageIds.has(m.id))) return null;
  try {
    return await brokerFetch<Peer[]>("/list-peers", {
      scope: "machine",
      cwd: state.myCwd,
      git_root: state.myGitRoot,
    });
  } catch {
    return null; // Non-critical, proceed without sender info
  }
}

/** Pushes one message through every channel. None confirms delivery, so all of them fire. */
async function pushMessage(msg: Message, sender: Peer | undefined): Promise<void> {
  const fromSummary = sender?.summary ?? "";
  const fromCwd = sender?.cwd ?? "";

  // 1. Channel notification (works in CLI with --channels)
  try {
    await mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content: msg.text,
        meta: {
          from_id: msg.from_id,
          from_summary: fromSummary,
          from_cwd: fromCwd,
          sent_at: msg.sent_at,
        },
      },
    });
  } catch {
    // Transport-level failure — channel definitely not available
  }

  // Also push via logging notification — may surface in some clients
  try {
    await mcp.sendLoggingMessage({
      level: "info",
      logger: "claude-peers",
      data: {
        type: "peer_message",
        from_id: msg.from_id,
        from_summary: fromSummary,
        from_cwd: fromCwd,
        sent_at: msg.sent_at,
        text: msg.text,
      },
    });
  } catch {
    // Logging not supported — piggyback on next tool call will deliver
  }

  // Track so we don't re-push on next poll cycle
  pushedMessageIds.add(msg.id);

  log(`Pushed message ${msg.id} from ${msg.from_id}`);
}

/** Puts the unread messages in check_messages' description and tells the client to re-fetch it. */
async function showPreview(inbox: Inbox, messages: Message[]): Promise<void> {
  inbox.preview = messages.map((m) => `[${m.from_id}]: ${m.text.slice(0, 100)}`).join(" | ");
  try {
    await mcp.notification({
      method: "notifications/tools/list_changed",
    });
    log("Sent tools/list_changed notification");
  } catch {
    // Client doesn't support it
  }
}

async function pollForPeer(peerId: PeerId) {
  const inbox = inboxFor(peerId);
  try {
    const result = await brokerFetch<PollMessagesResponse>(
      "/peek-messages",
      {
        id: peerId,
        since_id: inbox.lastSeen,
      },
      peerId,
    );

    // Fetch peer list once for sender lookups (not per-message)
    const peers = await sendersFor(result.messages);
    for (const msg of result.messages) {
      if (pushedMessageIds.has(msg.id)) continue;
      if (msg.id > inbox.lastSeen) inbox.lastSeen = msg.id;
      if (msg.id > highestMessageId) highestMessageId = msg.id;
      await pushMessage(
        msg,
        peers?.find((p) => p.id === msg.from_id),
      );
    }

    if (result.messages.length > 0) await showPreview(inbox, result.messages);
  } catch (e) {
    // Broker might be down temporarily, don't crash
    log(`Poll error (${peerId}): ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Forgets delivery state for peer ids this server no longer serves (a CLI
 * peer re-keyed, a Desktop session re-registered), so the map stays bounded
 * by the live sessions. pushedMessageIds still stops a re-push if one returns.
 */
export function pruneInboxes<T>(state: Map<PeerId, T>, served: Iterable<PeerId>): void {
  const keep = new Set(served);
  for (const id of state.keys()) if (!keep.has(id)) state.delete(id);
}

export async function pollAndPushMessages() {
  const peerIds: PeerId[] = [];
  if (state.myId) peerIds.push(state.myId);
  for (const [_, entry] of desktopPeers) peerIds.push(entry.peerId);
  pruneInboxes(inboxes, peerIds);
  await Promise.all(peerIds.map(pollForPeer));
}
