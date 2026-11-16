/**
 * The Claude Code hook: identity on SessionStart, the unread nudge and
 * request closing on UserPromptSubmit, and decision-queue capture on
 * Notification and Stop, and closing requests on SessionEnd. See hook.ts at
 * the repo root.
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
    // Leaves the 1 s hook timeout room for bun's start-up, the stdin read and the host walk.
    signal: AbortSignal.timeout(600),
  });
}

type HookInput = {
  session_id?: unknown;
  notification_type?: unknown;
  source?: unknown;
  prompt?: unknown;
};

/**
 * Notification: a blocked agent raises one input request for its session (the
 * broker keeps one open hook request per session); a permission prompt is a
 * warning, because no one but the human may answer it; anything else is a
 * debug event. Every row carries fixed text, never the notification's own
 * message: Claude Code builds agent_needs_input's from the agent's question,
 * which can carry case details.
 */
function notify(session_key: string, input: HookInput): Promise<Response> {
  const type = typeof input.notification_type === "string" ? input.notification_type : "unknown";
  if (type === "agent_needs_input") {
    const body = { session_key, question: "waiting for input", waiting_for: "input needed", source: "hook" };
    return post("/request-input", body);
  }
  if (type === "permission_prompt") {
    const body = {
      session_key,
      level: "warning",
      logger: "notification",
      message: "permission prompt",
      source: "hook",
    };
    return post("/report-event", body);
  }
  const debug = `notification: ${type}`;
  return post("/report-event", { session_key, level: "debug", logger: "notification", message: debug, source: "hook" });
}

/**
 * Prompts Claude Code submits on its own: a channel push (a peer message) and
 * a background task's report both fire UserPromptSubmit, with the prompt
 * starting with one of these tags. They are not the human answering. Checked
 * on Claude Code 2.1.325. A prompt this list misses closes requests early; the
 * broker records every close as a notice event, so that shows in the digest.
 */
const MACHINE_PROMPTS = ["<channel ", "<task-notification>"];

const isMachinePrompt = (prompt: unknown): boolean =>
  typeof prompt === "string" && MACHINE_PROMPTS.some((tag) => prompt.startsWith(tag));

/**
 * UserPromptSubmit: when the human typed it, they answered at the terminal, so
 * the session's open requests are closed; and stdout is added to the model's
 * context, so the unread line is the nudge that gets mail read even when
 * channel push missed it. The two requests run side by side to stay inside
 * the hook's budget.
 */
async function promptSubmitted(session_key: string | null, prompt: unknown): Promise<void> {
  // Started before the host walk, which /close-requests doesn't need.
  const close = session_key && !isMachinePrompt(prompt) ? post("/close-requests", { session_key }) : null;
  const pid = hostPid(process.ppid);
  const unread = async () => {
    if (!pid) return;
    const { count } = (await (await post("/unread", { pid })).json()) as { count: number };
    if (count > 0) console.log(`You have ${count} unread peer message(s). Call check_messages now to read them.`);
  };
  // allSettled: a failed close must not cut the nudge short.
  await Promise.allSettled([close, unread()]);
}

export async function runHook(): Promise<void> {
  const input = JSON.parse(await Bun.stdin.text()) as HookInput & { hook_event_name?: unknown };
  const event = input?.hook_event_name;
  // No secret yet means no broker has ever run: nothing to tell it.
  if (!readSecret()) return;
  const session_key = typeof input.session_id === "string" && input.session_id ? input.session_id : null;

  switch (event) {
    case "SessionStart": {
      const pid = hostPid(process.ppid);
      if (!pid || !session_key) return;
      await post("/session-start", { session_key, pid, source: input.source ?? "" });
      return;
    }
    case "UserPromptSubmit":
      return promptSubmitted(session_key, input.prompt);
    // Notification and Stop are filed by session key alone: no host walk.
    case "Notification":
      if (session_key) await notify(session_key, input);
      return;
    // The session is over, so no one will answer its open requests there.
    case "SessionEnd":
      if (session_key) await post("/close-requests", { session_key });
      return;
    case "Stop":
      // Only that a turn ended: the assistant's last message can carry case details.
      if (session_key) {
        await post("/report-event", {
          session_key,
          level: "info",
          logger: "stop",
          message: "turn ended",
          source: "hook",
        });
      }
      return;
  }
}
