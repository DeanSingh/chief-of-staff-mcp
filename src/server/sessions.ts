/**
 * Identity for the peers this server serves: the CLI host peer and the
 * Desktop sessions that claim a token.
 */

import type { PeerId, RegisterResponse } from "../shared/types.ts";
import { brokerFetch, isNotFound, remember } from "./client.ts";
import { HOST_PID, PEER_NAME, SESSION_KEY } from "./config.ts";
import { log } from "./log.ts";
import { desktopPeers, state } from "./state.ts";

/**
 * The registration payload every CLI path must send. One builder so the
 * call sites cannot drift apart — a missing session_key silently reverts a
 * peer to pid-keyed identity, which no test would catch.
 */
export function cliRegisterBody(summary: string | undefined) {
  return {
    pid: HOST_PID,
    cwd: state.myCwd,
    git_root: state.myGitRoot,
    tty: getTty(),
    summary,
    // Hardcoded, NOT PEER_TYPE: this is the CLI-only builder. One call site
    // (the set_summary re-register path) reaches it from the `else` of an
    // `if (sessionId && PEER_TYPE === "desktop")` check, so on a desktop
    // server with a falsy sessionId it would otherwise post
    // peer_type: "desktop" with no session_token — minting a token-less
    // desktop ghost that pid-reaping never collects and list_peers never
    // hides. That path is unreachable today only because of a guard
    // elsewhere; this builder must not be able to emit a desktop
    // registration regardless.
    peer_type: "cli",
    session_key: SESSION_KEY,
  };
}

/**
 * Heartbeat the CLI host peer. A 404 means the broker reaped it; register
 * again so it is reachable. peer_sessions hands back the same id.
 */
export async function heartbeatHost(): Promise<void> {
  const id = state.myId;
  if (!id) return;
  try {
    await brokerFetch("/heartbeat", { id }, id);
  } catch (e) {
    if (!isNotFound(e)) return;
    const reg = remember(
      await brokerFetch<RegisterResponse>("/register", cliRegisterBody(state.myLastSummary || PEER_NAME)),
    );
    // set_summary may have re-registered while this request was in flight.
    if (state.myId !== id) return;
    log(`Re-registered as peer ${reg.id} (was ${id})`);
    state.myId = reg.id;
  }
}

export async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code === 0) {
      return text.trim();
    }
  } catch {
    // not a git repo
  }
  return null;
}

export function getTty(): string | null {
  try {
    // Try to get the parent's tty from the process tree
    const ppid = process.ppid;
    if (ppid) {
      const proc = Bun.spawnSync(["ps", "-o", "tty=", "-p", String(ppid)]);
      const tty = new TextDecoder().decode(proc.stdout).trim();
      if (tty && tty !== "?" && tty !== "??") {
        return tty;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Session paths that are NOT unique per session and therefore cannot be used
 * as an identity key.
 *
 * Cloud Cowork sessions all run with cwd `/home/claude`, so keying on `pwd`
 * silently aliases every cloud session onto ONE peer: summaries overwrite each
 * other and a message addressed to that peer can be delivered back to the
 * sender. Local Cowork sandboxes get genuinely distinct paths
 * (e.g. /sessions/busy-peaceful-goodall) and are fine.
 *
 * Nothing in the request carries a usable discriminator — the remote-tools
 * dispatcher holds a per-session id but localMcpBridge drops it, and no _meta
 * reaches us — so ambiguous sessions must claim a minted token instead.
 */
const AMBIGUOUS_SESSION_PATHS = new Set(["/home/claude", "/", "/root", "/app"]);

export function isAmbiguousSession(value: string): boolean {
  return AMBIGUOUS_SESSION_PATHS.has(value.trim().replace(/\/+$/, "") || "/");
}

/**
 * The session value an identity may be resolved from. GUARD 2 rejects
 * ambiguous values for identity-bearing tools, but list_peers is exempt, and
 * resolving /home/claude there would register it as a shared token and print
 * its wake URL to every cloud session that passed it.
 */
export function resolvableSession(value: string | undefined): string | undefined {
  return value && !isAmbiguousSession(value) ? value : undefined;
}

/** Mints an unguessable, collision-free session token. */
export function mintSessionToken(): string {
  return `cs_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/**
 * The registration payload for a desktop session. cwd is this server's own
 * directory, never the token: cwd is shown to every other peer, and the token
 * is the session's bearer identity.
 */
export function desktopRegisterBody(sessionId: string, summary: string) {
  return {
    pid: process.pid,
    cwd: state.myCwd,
    git_root: null,
    tty: null,
    summary,
    peer_type: "desktop" as const,
    session_token: sessionId,
  };
}

export async function getDesktopPeerId(sessionId: string): Promise<PeerId> {
  const existing = desktopPeers.get(sessionId);
  if (existing) return existing.peerId;

  // Register a new peer for this desktop session.
  // Seed with PEER_NAME so desktop sessions start with their assigned identity.
  // The broker keys desktop peers on session_token, so if another server
  // process (or a previous incarnation of this one) already registered this
  // session we get the SAME peer id back — no identity rotation.
  // Empty summary: keep whatever summary the session already set.
  const reg = remember(await brokerFetch<RegisterResponse>("/register", desktopRegisterBody(sessionId, "")));
  const summary = reg.restored_summary ?? PEER_NAME;
  if (!reg.restored_summary && PEER_NAME) {
    await brokerFetch("/set-summary", { id: reg.id, summary: PEER_NAME }, reg.id).catch(() => {});
  }
  desktopPeers.set(sessionId, { peerId: reg.id, summary, wakeUrl: reg.wake_url });
  return reg.id;
}
