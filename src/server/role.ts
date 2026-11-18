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

/** Whether the client was last offered the coordinator tools. */
let offered = false;

/** What tools/list offers now; the client has seen it once this returns. */
export function offerCos(): boolean {
  offered = servesCos();
  return offered;
}

/**
 * Records what the broker said about `id`, and has the client re-list tools
 * when what it was offered no longer matches. Compares against the offer, not
 * the last call: /register can report the role for an id the server switches
 * to only afterwards, so the change may surface on a later heartbeat.
 */
export function noteRole(id: PeerId, cos: boolean): void {
  if (cos) cosPeers.add(id);
  else cosPeers.delete(id);
  if (servesCos() === offered) return;
  offered = !offered;
  log(`Chief-of-staff tools ${offered ? "offered" : "withdrawn"} (peer ${id})`);
  mcp.notification({ method: "notifications/tools/list_changed" }).catch(() => {});
}
