#!/usr/bin/env bun
/**
 * claude-peers CLI
 *
 * Utility commands for managing the broker and inspecting peers.
 * The commands live in src/cli/; this file stays at the repo root because
 * installed hooks and /desktop-wake run it by this path.
 *
 * Usage:
 *   bun cli.ts status          — Show broker status and all peers
 *   bun cli.ts peers           — List all peers
 *   bun cli.ts send <id> <msg> — Send a message to a peer
 *   bun cli.ts watch <id>      — Print a line per inbound message for a peer (for Monitor tool)
 *   bun cli.ts install-hooks   — Register the identity and unread hooks in ~/.claude/settings.json
 *   bun cli.ts kill-broker     — Stop the broker daemon
 *   bun cli.ts desktop-wake    — Show or switch Desktop sessions' wake mode (active | passive)
 */

import { desktopWake } from "./src/cli/desktop-wake.ts";
import { installHooks } from "./src/cli/install.ts";
import { killBroker, listPeers, send, status } from "./src/cli/peers.ts";
import { watch } from "./src/cli/watch.ts";

const COMMANDS: Record<string, () => Promise<void>> = {
  status,
  peers: listPeers,
  send,
  watch,
  "kill-broker": killBroker,
  "install-hooks": () => installHooks(import.meta.dir),
  "desktop-wake": desktopWake,
};

const run = COMMANDS[process.argv[2] ?? ""];
if (run) {
  await run();
} else {
  console.log(`claude-peers CLI

Usage:
  bun cli.ts status          Show broker status and all peers
  bun cli.ts peers           List all peers
  bun cli.ts send <id> <msg> Send a message to a peer
  bun cli.ts watch <id>      Print a line per inbound message for a peer (for Monitor tool)
  bun cli.ts install-hooks   Register the identity and unread hooks [--settings <path>]
  bun cli.ts kill-broker     Stop the broker daemon
  bun cli.ts desktop-wake    Show or switch Desktop wake mode: [status | active | passive | default] [agent] [--all]`);
}
