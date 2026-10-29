#!/usr/bin/env bun
/**
 * claude-peers Claude Code hook entrypoint. Registered for SessionStart by
 * `bun cli.ts install-hooks`; reads the hook payload on stdin and dispatches
 * on hook_event_name.
 *
 * SessionStart: the MCP server reads CLAUDE_CODE_SESSION_ID once at spawn, so
 * after an in-session /resume its key is the launch session's, not the
 * conversation's. This hook sees the live session_id and reports it, with the
 * pid of the Claude Code process it runs under, to the broker's
 * /session-start, which hands the conversation's original peer id back.
 *
 * Hooks must never slow or break a session: one short-timeout request, every
 * error swallowed, always exit 0, never launch the broker, and print nothing
 * (SessionStart stdout is injected into the model's context).
 */

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);

const HOST_COMM = process.env.CLAUDE_PEERS_HOST_COMM ?? "claude";

/**
 * The nearest process at or above `start` whose name is `name`, or null.
 * Stops at the FIRST match: a `claude` started from inside another session
 * (a worker running `claude -p`) must resolve to itself, never to the parent
 * session above it, or the child would take over the parent's identity.
 */
export function hostPid(start: number, name = HOST_COMM, maxDepth = 8): number | null {
  let pid = start;
  for (let i = 0; i < maxDepth && pid > 1; i++) {
    const out = new TextDecoder().decode(Bun.spawnSync(["ps", "-o", "ppid=,comm=", "-p", String(pid)]).stdout).trim();
    const m = out.match(/^(\d+)\s+(.+)$/);
    if (!m) return null;
    if (m[2]!.split("/").pop() === name) return pid;
    pid = parseInt(m[1]!, 10);
  }
  return null;
}

async function main() {
  const input = JSON.parse(await Bun.stdin.text());
  if (input?.hook_event_name !== "SessionStart" || typeof input.session_id !== "string") return;
  const pid = hostPid(process.ppid);
  if (!pid) return;
  await fetch(`http://127.0.0.1:${BROKER_PORT}/session-start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_key: input.session_id, pid, source: input.source ?? "" }),
    signal: AbortSignal.timeout(800),
  });
}

if (import.meta.main) {
  try {
    await main();
  } catch {
    // Broker down, bad payload, timeout: never the session's problem.
  }
  process.exit(0);
}
