/**
 * Whether this server serves the chief of staff. The broker says so on each
 * /register and /heartbeat; the server then offers the coordinator tools. This
 * is only what the tool list shows: the broker checks the role on every call.
 */

import type { PeerId } from "../shared/types.ts";
import { log } from "./log.ts";
import { mcp } from "./mcp.ts";
import { desktopPeers, state } from "./state.ts";

/** Peers the broker last said hold the role. */
const cosPeers = new Set<PeerId>();

const served = (id: PeerId) => id === state.myId || [...desktopPeers.values()].some((e) => e.peerId === id);

/**
 * True when a peer this server serves holds the role. One Desktop server
 * serves every Desktop session, and tools/list is per server, so when the
 * chief of staff is a Desktop session every Desktop session sees the tools.
 */
export function servesCos(): boolean {
  for (const id of cosPeers) if (served(id)) return true;
  return false;
}

/** Records what the broker said about `id`, and has the client re-list tools when that changes what we offer. */
export function noteRole(id: PeerId, cos: boolean): void {
  const before = servesCos();
  if (cos) cosPeers.add(id);
  else cosPeers.delete(id);
  if (servesCos() === before) return;
  log(`Chief-of-staff tools ${before ? "withdrawn" : "offered"} (peer ${id})`);
  mcp.notification({ method: "notifications/tools/list_changed" }).catch(() => {});
}
