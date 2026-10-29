#!/usr/bin/env bun
/**
 * claude-peers Claude Code hook entrypoint. Registered for SessionStart by
 * `bun cli.ts install-hooks`; reads the hook payload on stdin and dispatches
 * on hook_event_name.
 *
 * SessionStart: the MCP server reads CLAUDE_CODE_SESSION_ID once at spawn, so
 * after an in-session /resume its key is the launch session's, not the
 * conversation's. This hook sees the live session_id and reports it, with the
 * ancestor pids that identify the Claude Code process, to the broker's
 * /session-start, which hands the conversation's original peer id back.
 *
 * Hooks must never slow or break a session: one short-timeout request, every
 * error swallowed, always exit 0, never launch the broker, and print nothing
 * (SessionStart stdout is injected into the model's context).
 */

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);

/** `start`, then its parent, grandparent, ... up to `max` pids, stopping at init. */
export function ancestorPids(start: number, max = 8): number[] {
  const chain: number[] = [];
  let pid = start;
  while (pid > 1 && chain.length < max) {
    chain.push(pid);
    const out = Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(pid)]);
    pid = parseInt(new TextDecoder().decode(out.stdout).trim(), 10);
    if (!Number.isFinite(pid)) break;
  }
  return chain;
}

async function main() {
  const input = JSON.parse(await Bun.stdin.text());
  if (input?.hook_event_name !== "SessionStart" || typeof input.session_id !== "string") return;
  await fetch(`http://127.0.0.1:${BROKER_PORT}/session-start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_key: input.session_id, pids: ancestorPids(process.ppid), source: input.source ?? "" }),
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
