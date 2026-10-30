/**
 * The HTTP server: the request gate (Host, Origin, install secret, peer
 * credential) and the route table.
 */

import { PEER_HEADER, peerSecret, secretsEqual } from "../shared/auth.ts";
import type {
  AckMessagesRequest,
  HeartbeatRequest,
  ListPeersRequest,
  Peer,
  PollMessagesRequest,
  RegisterRequest,
  SendMessageRequest,
  SessionStartRequest,
  SetSummaryRequest,
} from "../shared/types.ts";
import { PORT } from "./config.ts";
import { SECRET, selectAllPeers } from "./db.ts";
import { handleRegister, handleSessionStart } from "./identity.ts";
import {
  type WatchData,
  handleAckMessages,
  handlePeekMessages,
  handlePollMessages,
  handleSendMessage,
  watchers,
} from "./messages.ts";
import { handleHeartbeat, handleListPeers, handleSetSummary, handleUnread, handleUnregister } from "./peers.ts";
import { handleWakeMode, handleWakeStatus } from "./wake.ts";

// --- HTTP Server ---

// --- Request gate ---
// Loopback is not a security boundary against the browser: any page Dean
// opens can POST here (a text/plain "simple request" needs no CORS
// preflight), and a DNS-rebinding page can read the answers too. Clients of
// this broker are local processes, so refuse anything that looks like a
// browser, and require the install secret on every POST and /watch upgrade.
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

function gate(req: Request): Response | null {
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
  return hasSecret(req) ? null : Response.json({ ok: false, error: "missing or wrong broker secret" }, { status: 401 });
}

function hasSecret(req: Request): boolean {
  return secretsEqual(req.headers.get("authorization")?.replace(/^Bearer /, ""), SECRET);
}

function actsAsCaller(req: Request, path: string, body: Record<string, unknown>): boolean {
  const field = ACTS_AS[path];
  if (!field) return true;
  const id = body?.[field];
  if (typeof id !== "string") return false;
  if (path === "/send-message" && id === OPERATOR_ID) return true;
  return secretsEqual(req.headers.get(PEER_HEADER), peerSecret(SECRET, id));
}

export function startServer() {
  return Bun.serve<WatchData>({
    port: PORT,
    hostname: "127.0.0.1",
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the route table, one branch per route
    async fetch(req, server) {
      const url = new URL(req.url);
      const path = url.pathname;

      const refused = gate(req);
      if (refused) return refused;

      if (req.method !== "POST") {
        if (path.startsWith("/watch/")) {
          // Origin was already refused above, so a web page can't hijack a
          // peer's message feed cross-site. A local process needs the same
          // credentials it would need to read that peer's mail.
          const peer = decodeURIComponent(path.slice("/watch/".length));
          if (!peer) return new Response("missing peer id", { status: 400 });
          if (!hasSecret(req)) return new Response("missing or wrong broker secret", { status: 401 });
          if (!secretsEqual(req.headers.get(PEER_HEADER), peerSecret(SECRET, peer))) {
            return new Response(`not authorized to watch ${peer}`, { status: 403 });
          }
          if (server.upgrade(req, { data: { peer } })) return;
          return new Response("websocket upgrade required", { status: 426 });
        }
        if (path === "/health") {
          return Response.json({ status: "ok", peers: (selectAllPeers.all() as Peer[]).length });
        }
        return new Response("claude-peers broker", { status: 200 });
      }

      try {
        // biome-ignore lint/suspicious/noExplicitAny: each route casts the body to its own request type
        const body = (await req.json()) as Record<string, any>;
        if (!actsAsCaller(req, path, body)) {
          return Response.json(
            { ok: false, error: `not authorized to act as ${String(body?.[ACTS_AS[path]!])}` },
            { status: 403 },
          );
        }

        switch (path) {
          case "/register":
            return Response.json(handleRegister(body as RegisterRequest));
          case "/heartbeat": {
            const beat = handleHeartbeat(body as HeartbeatRequest);
            return Response.json(beat, { status: beat.ok ? 200 : 404 });
          }
          case "/set-summary": {
            const summaryResult = handleSetSummary(body as SetSummaryRequest);
            if (!summaryResult.ok) {
              return Response.json(summaryResult, { status: 404 });
            }
            return Response.json(summaryResult);
          }
          case "/wake-mode": {
            const r = handleWakeMode(body);
            return Response.json(r, { status: r.ok ? 200 : 400 });
          }
          case "/wake-status":
            return Response.json(handleWakeStatus());
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
        if (!set) {
          set = new Set();
          watchers.set(ws.data.peer, set);
        }
        set.add(ws);
        ws.send(JSON.stringify({ type: "watching", peer: ws.data.peer }));
      },
      close(ws) {
        const set = watchers.get(ws.data.peer);
        set?.delete(ws);
        if (set && set.size === 0) watchers.delete(ws.data.peer);
      },
      message() {
        /* watchers are receive-only */
      },
    },
  });
}
