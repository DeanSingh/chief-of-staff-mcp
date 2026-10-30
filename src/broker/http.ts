/**
 * The HTTP server: the request gate (Host, Origin, install secret, peer
 * credential) and the route table.
 */

import type { Server } from "bun";
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

// biome-ignore lint/suspicious/noExplicitAny: each route casts the body to its own request type
type Body = Record<string, any>;

/** POST routes. A route not listed here is a 404. */
const ROUTES = new Map<string, (body: Body) => Response>([
  ["/register", (b) => Response.json(handleRegister(b as RegisterRequest))],
  [
    "/heartbeat",
    (b) => {
      const beat = handleHeartbeat(b as HeartbeatRequest);
      return Response.json(beat, { status: beat.ok ? 200 : 404 });
    },
  ],
  [
    "/set-summary",
    (b) => {
      const r = handleSetSummary(b as SetSummaryRequest);
      return Response.json(r, { status: r.ok ? 200 : 404 });
    },
  ],
  [
    "/wake-mode",
    (b) => {
      const r = handleWakeMode(b);
      return Response.json(r, { status: r.ok ? 200 : 400 });
    },
  ],
  ["/wake-status", () => Response.json(handleWakeStatus())],
  ["/list-peers", (b) => Response.json(handleListPeers(b as ListPeersRequest))],
  ["/send-message", (b) => Response.json(handleSendMessage(b as SendMessageRequest))],
  ["/poll-messages", (b) => Response.json(handlePollMessages(b as PollMessagesRequest))],
  [
    "/ack-messages",
    (b) => {
      handleAckMessages(b as AckMessagesRequest);
      return Response.json({ ok: true });
    },
  ],
  ["/peek-messages", (b) => Response.json(handlePeekMessages(b as { id: string; since_id?: number }))],
  ["/session-start", (b) => Response.json(handleSessionStart(b as SessionStartRequest))],
  ["/unread", (b) => Response.json(handleUnread(b as { pid: number }))],
  [
    "/unregister",
    (b) => {
      handleUnregister(b as { id: string });
      return Response.json({ ok: true });
    },
  ],
]);

/**
 * The /watch/<peer> upgrade. Origin was already refused by the gate, so a web
 * page can't hijack a peer's message feed cross-site. A local process needs
 * the same credentials it would need to read that peer's mail.
 */
function watchUpgrade(req: Request, server: Server<WatchData>, path: string): Response | undefined {
  const peer = decodeURIComponent(path.slice("/watch/".length));
  if (!peer) return new Response("missing peer id", { status: 400 });
  if (!hasSecret(req)) return new Response("missing or wrong broker secret", { status: 401 });
  if (!secretsEqual(req.headers.get(PEER_HEADER), peerSecret(SECRET, peer))) {
    return new Response(`not authorized to watch ${peer}`, { status: 403 });
  }
  if (server.upgrade(req, { data: { peer } })) return;
  return new Response("websocket upgrade required", { status: 426 });
}

function handleGet(req: Request, server: Server<WatchData>, path: string): Response | undefined {
  if (path.startsWith("/watch/")) return watchUpgrade(req, server, path);
  if (path === "/health") {
    return Response.json({ status: "ok", peers: (selectAllPeers.all() as Peer[]).length });
  }
  return new Response("claude-peers broker", { status: 200 });
}

async function handlePost(req: Request, path: string): Promise<Response> {
  try {
    const body = (await req.json()) as Body;
    if (!actsAsCaller(req, path, body)) {
      return Response.json(
        { ok: false, error: `not authorized to act as ${String(body?.[ACTS_AS[path]!])}` },
        { status: 403 },
      );
    }
    const route = ROUTES.get(path);
    return route ? route(body) : Response.json({ error: "not found" }, { status: 404 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 500 });
  }
}

export function startServer() {
  return Bun.serve<WatchData>({
    port: PORT,
    hostname: "127.0.0.1",
    async fetch(req, server) {
      const path = new URL(req.url).pathname;
      const refused = gate(req);
      if (refused) return refused;
      return req.method === "POST" ? handlePost(req, path) : handleGet(req, server, path);
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
