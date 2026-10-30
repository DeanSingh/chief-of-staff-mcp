/**
 * Server settings from the environment, and whether this server runs under
 * Claude Code (cli) or Claude Desktop (desktop).
 */

// --- Configuration ---

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
export const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;

/**
 * The pid a CLI peer registers under. This MCP server is a child of the
 * Claude Code process; a `/mcp` reconnect spawns a NEW server process for the
 * SAME session, so keying on our own pid rotated the peer id on every
 * reconnect (and orphaned mail addressed to the old id). The parent pid is
 * the session itself and survives reconnects. Falls back to our own pid when
 * run standalone.
 */
export const HOST_PID = process.ppid && process.ppid > 1 ? process.ppid : process.pid;

/**
 * Claude Code's own session id, which this MCP server inherits in its
 * environment. Measured 2026-09-09: present in the server process and equal to
 * the `sessionId` from `claude agents --json`. Stable across
 * `claude --resume <id>` and across crash+restart, so the broker keys CLI peer
 * identity on it and a restarted session keeps its id and its queued mail.
 * Read once at spawn, so it goes stale when the conversation is switched
 * afterwards (in-session /resume, measured 2026-10-29): the SessionStart hook
 * (hook.ts) reports the live id and the broker re-keys this peer. Undefined
 * when run standalone; the broker falls back to pid matching.
 *
 * Desktop is unaffected: one bridge process serves many sessions, so a
 * process-level variable cannot discriminate between them and those sessions
 * continue to use claim_session / peer_session.
 */
export const SESSION_KEY = process.env.CLAUDE_CODE_SESSION_ID || undefined;

export const POLL_INTERVAL_MS = 1000;
// Floor of 1s: a bad override must not turn the heartbeat into a busy loop on the broker.
export const HEARTBEAT_INTERVAL_MS = Math.max(1000, Number(process.env.CLAUDE_PEERS_HEARTBEAT_MS) || 15_000);
export const BROKER_SCRIPT = new URL("../../broker.ts", import.meta.url).pathname;
export const PEER_NAME = process.env.CLAUDE_PEERS_NAME ?? "";
export const DEBUG_LOG_PATH = process.env.CLAUDE_PEERS_LOG ?? `${process.env.HOME}/.claude-peers.log`;

// Detect if running inside Claude Desktop (launched via disclaimer wrapper).
// CLAUDE_PEERS_PEER_TYPE forces the result — useful for tests and as an
// escape hatch if the ps-based detection ever misfires.
function detectPeerType(): "cli" | "desktop" {
  const forced = process.env.CLAUDE_PEERS_PEER_TYPE;
  if (forced === "desktop" || forced === "cli") return forced;
  try {
    const ppid = process.ppid;
    if (ppid) {
      const proc = Bun.spawnSync(["ps", "-p", String(ppid), "-o", "command="]);
      const cmd = new TextDecoder().decode(proc.stdout).trim();
      if (cmd.includes("Claude.app") || cmd.includes("disclaimer")) {
        return "desktop";
      }
    }
  } catch {
    /* default to cli */
  }
  return "cli";
}
export const PEER_TYPE = detectPeerType();
