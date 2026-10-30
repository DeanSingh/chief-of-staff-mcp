/**
 * The SessionStart and UserPromptSubmit hook. See hook.ts at the repo root.
 */

import { authHeaders, readSecret } from "./shared/auth.ts";

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

function post(path: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${BROKER_PORT}${path}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(800),
  });
}

export async function runHook(): Promise<void> {
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
