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
 *
 * The code lives in src/hook.ts; this file stays at the repo root because
 * installed hooks run it by this path.
 */

import { runHook } from "./src/hook.ts";

try {
  await runHook();
} catch {
  // Broker down, bad payload, timeout: never the session's problem.
}
process.exit(0);
