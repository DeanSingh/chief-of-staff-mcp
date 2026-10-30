/**
 * Mutable state shared across the server's modules.
 */

import type { PeerId } from "../shared/types.ts";

export const state = {
  /** The CLI host peer's id; null on a Desktop server, which has no host peer. */
  myId: null as PeerId | null,
  myCwd: process.cwd(),
  myGitRoot: null as string | null,
  /** The most recent summary, for re-registration. */
  myLastSummary: "",
};

// For desktop (Cowork), multiple sessions share this server process.
// Each session registers as a separate peer, keyed by its peer_session value.
// wakeNotice: a wake mode switch the session hasn't been told about yet,
// appended to its next tool result.
export const desktopPeers = new Map<
  string,
  { peerId: PeerId; summary: string; wakeUrl?: string; wakeNotice?: string }
>();
