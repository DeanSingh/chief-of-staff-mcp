#!/usr/bin/env bun
/**
 * claude-peers Claude Code hook entrypoint. Registered for SessionStart and
 * UserPromptSubmit by `bun cli.ts install-hooks`; reads the hook payload on
 * stdin and dispatches on hook_event_name.
 *
 * SessionStart: the MCP server reads CLAUDE_CODE_SESSION_ID once at spawn, so
 * after an in-session /resume its key is the launch session's, not the
 * conversation's. This hook sees the live session_id and reports it, with the
 * pid of the Claude Code process it runs under, to the broker's
 * /session-start, which hands the conversation's original peer id back.
 *
 * UserPromptSubmit: prints a one-line nudge when this session's peer has
 * unread mail, so it gets read even if channel push missed it.
 *
 * Hooks must never slow or break a session: one short-timeout request, every
 * error swallowed, always exit 0, never launch the broker. Stdout is injected
 * into the model's context, so SessionStart prints nothing and
 * UserPromptSubmit prints only the nudge.
 */

import { authHeaders, readSecret } from "./shared/auth.ts";

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);

/**
 * The settings.json command that runs this hook from `dir`. Single-quoted so
 * no repo path can break out into the shell; "# claude-peers" marks the entry
 * as ours for install-hooks.
 */
export function hookCommand(dir: string): string {
  return `bun '${`${dir}/hook.ts`.replace(/'/g, `'\\''`)}' # claude-peers`;
}

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

function post(path: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${BROKER_PORT}${path}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(800),
  });
}

async function main() {
  const input = JSON.parse(await Bun.stdin.text());
  const event = input?.hook_event_name;
  if (event !== "SessionStart" && event !== "UserPromptSubmit") return;
  const pid = hostPid(process.ppid);
  // No secret yet means no broker has ever run: nothing to tell it.
  if (!pid || !readSecret()) return;

  if (event === "SessionStart") {
    if (typeof input.session_id !== "string") return;
    await post("/session-start", { session_key: input.session_id, pid, source: input.source ?? "" });
    return;
  }

  // UserPromptSubmit: stdout is added to the model's context, so this line is
  // the nudge that gets mail read even when channel push missed it.
  const { count } = (await (await post("/unread", { pid })).json()) as { count: number };
  if (count > 0) console.log(`You have ${count} unread peer message(s). Call check_messages now to read them.`);
}

if (import.meta.main) {
  try {
    await main();
  } catch {
    // Broker down, bad payload, timeout: never the session's problem.
  }
  process.exit(0);
}
