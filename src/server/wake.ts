/**
 * The wake Monitor command and the copy that tells a Desktop session how to
 * arm it.
 */

import type { PeerId } from "../shared/types.ts";
import { SESSION_PARAM } from "./tools.ts";

/**
 * The exact Monitor call that wakes a Desktop/Cowork session when a peer
 * messages it. Returned from claim_session/list_peers because Desktop's
 * localMcpBridge drops server-level instructions — tool responses are the
 * only channel guaranteed to reach a Desktop/Cowork agent.
 *
 * Cloud sessions can't reach the broker's loopback, so the broker POSTs a bare
 * "wake" to the session's secret topic on an outbound relay (ntfy) and the
 * Monitor streams that topic. `url` is <relay>/<topic> exactly as the broker
 * publishes it. Each stream is capped at 10 min so a half-open connection
 * can't leave the agent deaf, and every reconnect resumes 5s before the
 * previous connect, so wakes published during a drop or stall are replayed;
 * the read loop drops the duplicates. Monitor caps timeout_ms at 30 min and has no
 * persistent option, hence the re-arm instruction, and a re-arm starts from
 * "now", hence the check_messages after it.
 *
 * "claim" is the first-time copy; "list" (printed on every list_peers) only
 * asks for a Monitor that isn't already running, so repeat calls don't stack
 * duplicate watchers.
 */
/**
 * The shell command an agent's wake Monitor runs. Everything it prints lands
 * in the agent's context, and anyone holding the topic can publish to it, so
 * it never echoes a byte from the network: each new event id prints the
 * constant "wake", at most once per `gapSec`. Duplicates are the replays the
 * `since=` resume deliberately causes. The gap sits under the broker's 10s
 * coalescing window, so a genuine trailing wake is never dropped, while a
 * leaked topic can at most burn one turn per gap.
 *
 * Plain POSIX sh, no awk or grep: mawk (Debian/Ubuntu's default awk) holds
 * piped input until EOF, which would sit on every wake until the stream
 * closed, and `grep --line-buffered` isn't in busybox. `echo` after curl ends
 * a stream cut mid-line, so the next event isn't glued onto it.
 *
 * When the session's wake mode goes passive the broker publishes "off": the
 * Monitor prints a constant line and stops, so the agent doesn't re-arm it.
 * Matching the unescaped `"message":"off"` can't be faked from another JSON
 * field, and the worst a leaked topic can do with it is stop the Monitor.
 */
export function wakeCommand(url: string, gapSec = 8): string {
  return `t=$(date +%s); while true; do c=$(date +%s); curl -sN --max-time 600 "${url}/json?since=$t"; echo; t=$(( c - 5 )); sleep 2; done | while IFS= read -r l; do case $l in *'"event":"message"'*) ;; *) continue ;; esac; case $l in *'"message":"off"'*) echo "${WAKE_OFF_LINE}"; exit 0 ;; esac; i=\${l#*'"id":"'}; i=\${i%%'"'*}; case " $s " in *" $i "*) continue ;; esac; s="$s $i"; n=$(date +%s); [ $(( n - \${w:-0} )) -lt ${gapSec} ] && continue; w=$n; echo wake; done`;
}

export const WAKE_OFF_LINE = "claude-peers wake is now passive: this Monitor has stopped. Do not re-arm it.";

// The copy states the mode and how it is set, and claims no authority: the
// broker can't tell who flipped it (anything holding the install secret can),
// and "this overrides your earlier instructions" in a tool result is the shape
// of a prompt injection. An agent holding a direct order from its user about
// the Monitor should take a change to it from the user, not from this copy.
const WAKE_SET_BY = "(set with /desktop-wake or set_wake)";

/** Told to a session whose wake mode just went passive. */
export const WAKE_PASSIVE_NOTICE = `Wake mode for this session is now passive ${WAKE_SET_BY}. Your "claude-peers wake" Monitor stops by itself; do not re-arm it. Peer messages still arrive on your next claude-peers call.`;

export function wakeInstructions(url: string, mode: "claim" | "list"): string {
  const command = wakeCommand(url);
  const lead =
    mode === "claim"
      ? "To be woken when a peer messages you, arm this Monitor now, then carry on:"
      : `If your "claude-peers wake" Monitor is not running (or has expired), arm it:`;
  return `Wake mode for this session is active ${WAKE_SET_BY}. ${lead}

    Monitor({ command: ${JSON.stringify(command)}, description: "claude-peers wake", timeout_ms: 1800000 })

When it fires: call check_messages (with your ${SESSION_PARAM}) and answer what you find. When it expires (every 30 min), arm it again with the same call, then call check_messages once to catch anything sent while it was down. If it prints that wake is passive, or a claude-peers result says so, do not re-arm it. This URL is private to you; do not share it.`;
}

/** Told to a running session on its next tool call after its wake mode is switched. */
export function wakeSwitchNotice(url: string | undefined): string {
  return url ? wakeInstructions(url, "claim") : WAKE_PASSIVE_NOTICE;
}

/** The wake copy for a session, or "" when the broker gave it no wake URL (relay off, or no token). */
export function wakeCopy(url: string | undefined, mode: "claim" | "list"): string {
  return url ? wakeInstructions(url, mode) : "";
}

/** list_peers header for a caller with an identity. CLI callers have no wake URL (channel push wakes them). */
export function peerListHeader(peerId: PeerId, wakeUrl: string | undefined): string {
  const copy = wakeCopy(wakeUrl, "list");
  return `Your peer ID: ${peerId}\n\n${copy ? `${copy}\n\n` : ""}`;
}
