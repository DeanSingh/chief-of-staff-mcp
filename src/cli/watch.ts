/**
 * `bun cli.ts watch`: the wake feed for a Monitor.
 */

import { PEER_HEADER, peerSecret, readSecret, secretPath } from "../shared/auth.ts";
import { BROKER_URL } from "./client.ts";

/** `watch <id>`: print one line per inbound message, for a Monitor. Runs until killed. */
export async function watch(): Promise<void> {
  const peerId = process.argv[3];
  if (!peerId) {
    console.error("Usage: bun cli.ts watch <peer-id>");
    process.exit(1);
  }

  // Print one line per inbound message. Designed for Claude Code's Monitor
  // tool: each stdout line becomes a notification that Claude reacts to
  // mid-conversation.
  //
  // Subscribes to the broker's WebSocket feed (ws://.../watch/<peer>), which
  // is a wake signal only: frames carry no content and nothing is acked, so
  // the session reads the message itself with check_messages. The upgrade
  // carries the install secret and this peer's credential, read from the
  // secret file, so neither is ever in argv.
  const wsUrl = `${BROKER_URL.replace(/^http/, "ws")}/watch/${encodeURIComponent(peerId)}`;
  const secret = readSecret();
  if (!secret) {
    console.error(`No broker secret at ${secretPath()}; start the broker first.`);
    process.exit(1);
  }
  const headers = { authorization: `Bearer ${secret}`, [PEER_HEADER]: peerSecret(secret, peerId) };
  console.error(`[claude-peers] Watching peer ${peerId} for incoming messages via ${wsUrl} (Ctrl+C to stop)`);

  let backoff = 1000;
  while (true) {
    // A WebSocket client never sees why an upgrade failed, so ask over plain
    // HTTP first: a refusal won't change by retrying, while 426 means the
    // credentials passed and only the upgrade is missing.
    const refused = await fetch(`${BROKER_URL}/watch/${encodeURIComponent(peerId)}`, {
      headers,
      signal: AbortSignal.timeout(3000),
    }).then(
      (res) => (res.status === 401 || res.status === 403 ? res.text() : null),
      () => null, // broker down: the reconnect loop waits for it
    );
    if (refused !== null) {
      console.error(`[claude-peers] Broker refused to watch ${peerId}: ${refused}`);
      process.exit(1);
    }
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(wsUrl, { headers });
      ws.onopen = () => {
        backoff = 1000;
      };
      ws.onmessage = (ev) => {
        try {
          if ((JSON.parse(String(ev.data)) as { type: string }).type !== "wake") return; // "watching" handshake etc.
          console.log("[claude-peers] new peer message: call check_messages to read it");
        } catch {
          // ignore malformed frame
        }
      };
      ws.onerror = () => {
        /* onclose follows */
      };
      ws.onclose = () => resolve();
    });
    console.error(`[claude-peers] Feed closed; reconnecting in ${backoff / 1000}s`);
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, 15_000);
  }
}
