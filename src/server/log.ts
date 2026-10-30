/**
 * The debug log. Tool calls are logged by name and argument keys only.
 */

import { appendFileSync, chmodSync } from "node:fs";
import { DEBUG_LOG_PATH } from "./config.ts";

// --- Utility ---

// Claude Desktop launches one MCP server process per consumer (local app,
// localMcpBridge for remote/Cowork sessions). Only one of them gets a log
// file — the bridge instance's stderr goes to /dev/null, which makes the
// sessions that actually hit bugs invisible. Mirror every log line to a
// file so both processes are diagnosable.
/** The debug log records peer ids and tool names: owner-only. */
export function tightenLogFile(path: string): void {
  try {
    appendFileSync(path, "", { mode: 0o600 });
    chmodSync(path, 0o600);
  } catch {
    // Logging must never break the server
  }
}

/** One log line per tool call. Names only: values carry session tokens and message text. */
export function toolCallLogLine(name: string, args: Record<string, unknown> | undefined): string {
  return `Tool call ${name} args=[${Object.keys(args ?? {}).join(", ")}]`;
}

export function log(msg: string) {
  const line = `[claude-peers] ${msg}`;
  // MCP stdio servers must only use stderr for logging (stdout is the MCP protocol)
  console.error(line);
  try {
    appendFileSync(DEBUG_LOG_PATH, `${new Date().toISOString()} pid=${process.pid} ${line}\n`);
  } catch {
    // Logging must never break the server
  }
}
