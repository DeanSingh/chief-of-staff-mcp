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
 *   bun cli.ts digest          — Show the decision queue: waiting requests and recent events
 *   bun cli.ts cos [peer]      — Show or name the chief of staff (the one peer that may answer requests)
 *   bun cli.ts install-hooks   — Register the identity, unread and decision-queue hooks in ~/.claude/settings.json
 *   bun cli.ts kill-broker     — Stop the broker daemon
 *   bun cli.ts desktop-wake    — Show or switch Desktop sessions' wake mode (active | passive)
 */

import { cos } from "./src/cli/cos.ts";
import { desktopWake } from "./src/cli/desktop-wake.ts";
import { digest } from "./src/cli/digest.ts";
import { installHooks } from "./src/cli/install.ts";
import { killBroker, listPeers, send, status } from "./src/cli/peers.ts";
import { watch } from "./src/cli/watch.ts";

const COMMANDS: Record<string, () => Promise<void>> = {
  status,
  peers: listPeers,
  send,
  watch,
  digest,
  cos,
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
  bun cli.ts digest          Show the decision queue: [--since <id>] [--limit <n>] [--level <level>] [--json]
  bun cli.ts cos [peer]      Show or name the chief of staff, the one peer that may answer requests: [<id or name> | --clear]
  bun cli.ts install-hooks   Register the identity, unread and decision-queue hooks [--settings <path>]
  bun cli.ts kill-broker     Stop the broker daemon
  bun cli.ts desktop-wake    Show or switch Desktop wake mode: [status | active | passive | default] [agent] [--all]`);
}
