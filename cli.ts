#!/usr/bin/env bun
/**
 * claude-peers CLI
 *
 * Utility commands for managing the broker and inspecting peers.
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

import { chmodSync, mkdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { authHeaders, peerSecret, readSecret, secretPath, PEER_HEADER } from "./src/shared/auth.ts";
import { desktopWakeCommand, hookCommand, isOurDesktopWakeCommand } from "./hook.ts";

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;

async function brokerFetch<T>(path: string, body?: unknown): Promise<T> {
  const opts: RequestInit = body
    ? {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(body),
      }
    : {};
  const res = await fetch(`${BROKER_URL}${path}`, {
    ...opts,
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) {
    throw new Error(`${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

const cmd = process.argv[2];

switch (cmd) {
  case "status": {
    try {
      const health = await brokerFetch<{ status: string; peers: number }>("/health");
      console.log(`Broker: ${health.status} (${health.peers} peer(s) registered)`);
      console.log(`URL: ${BROKER_URL}`);

      if (health.peers > 0) {
        const peers = await brokerFetch<
          Array<{
            id: string;
            pid: number;
            cwd: string;
            git_root: string | null;
            tty: string | null;
            summary: string;
            last_seen: string;
          }>
        >("/list-peers", {
          scope: "machine",
          cwd: "/",
          git_root: null,
        });

        console.log("\nPeers:");
        for (const p of peers) {
          console.log(`  ${p.id}  PID:${p.pid}  ${p.cwd}`);
          if (p.summary) console.log(`         ${p.summary}`);
          if (p.tty) console.log(`         TTY: ${p.tty}`);
          console.log(`         Last seen: ${p.last_seen}`);
        }
      }
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  case "peers": {
    try {
      const peers = await brokerFetch<
        Array<{
          id: string;
          pid: number;
          cwd: string;
          git_root: string | null;
          tty: string | null;
          summary: string;
          last_seen: string;
        }>
      >("/list-peers", {
        scope: "machine",
        cwd: "/",
        git_root: null,
      });

      if (peers.length === 0) {
        console.log("No peers registered.");
      } else {
        for (const p of peers) {
          const parts = [`${p.id}  PID:${p.pid}  ${p.cwd}`];
          if (p.summary) parts.push(`  Summary: ${p.summary}`);
          console.log(parts.join("\n"));
        }
      }
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  case "send": {
    const toId = process.argv[3];
    const msg = process.argv.slice(4).join(" ");
    if (!toId || !msg) {
      console.error("Usage: bun cli.ts send <peer-id> <message>");
      process.exit(1);
    }
    try {
      const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
        from_id: "cli",
        to_id: toId,
        text: msg,
      });
      if (result.ok) {
        console.log(`Message sent to ${toId}`);
      } else {
        console.error(`Failed: ${result.error}`);
      }
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    break;
  }

  case "watch": {
    const peerId = process.argv[3];
    if (!peerId) {
      console.error("Usage: bun cli.ts watch <peer-id>");
      process.exit(1);
    }

    // Print one line per inbound message. Designed for Claude Code's Monitor
    // tool: each stdout line becomes a notification that Claude reacts to
    // mid-conversation.
    //
    // Subscribes to the broker's WebSocket feed (ws://.../watch/<peer>), which
    // is a wake signal only: frames carry no content and nothing is acked, so
    // the session reads the message itself with check_messages. The upgrade
    // carries the install secret and this peer's credential, read from the
    // secret file, so neither is ever in argv.
    const wsUrl = `${BROKER_URL.replace(/^http/, "ws")}/watch/${encodeURIComponent(peerId)}`;
    const secret = readSecret();
    if (!secret) {
      console.error(`No broker secret at ${secretPath()}; start the broker first.`);
      process.exit(1);
    }
    const headers = { authorization: `Bearer ${secret}`, [PEER_HEADER]: peerSecret(secret, peerId) };
    console.error(`[claude-peers] Watching peer ${peerId} for incoming messages via ${wsUrl} (Ctrl+C to stop)`);

    let backoff = 1000;
    while (true) {
      // A WebSocket client never sees why an upgrade failed, so ask over plain
      // HTTP first: a refusal won't change by retrying, while 426 means the
      // credentials passed and only the upgrade is missing.
      const refused = await fetch(`${BROKER_URL}/watch/${encodeURIComponent(peerId)}`, {
        headers,
        signal: AbortSignal.timeout(3000),
      }).then(
        (res) => (res.status === 401 || res.status === 403 ? res.text() : null),
        () => null, // broker down: the reconnect loop waits for it
      );
      if (refused !== null) {
        console.error(`[claude-peers] Broker refused to watch ${peerId}: ${refused}`);
        process.exit(1);
      }
      await new Promise<void>((resolve) => {
        const ws = new WebSocket(wsUrl, { headers });
        ws.onopen = () => {
          backoff = 1000;
        };
        ws.onmessage = (ev) => {
          try {
            if ((JSON.parse(String(ev.data)) as { type: string }).type !== "wake") return; // "watching" handshake etc.
            console.log("[claude-peers] new peer message: call check_messages to read it");
          } catch {
            // ignore malformed frame
          }
        };
        ws.onerror = () => {
          /* onclose follows */
        };
        ws.onclose = () => resolve();
      });
      console.error(`[claude-peers] Feed closed; reconnecting in ${backoff / 1000}s`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 15_000);
    }
  }

  case "kill-broker": {
    try {
      const health = await brokerFetch<{ status: string; peers: number }>("/health");
      console.log(`Broker has ${health.peers} peer(s). Shutting down...`);
      // Kill ONLY the listening process. A bare `lsof -ti :port` also lists
      // every CLIENT with a connection to the broker — i.e. the MCP server of
      // every live session — and SIGTERMing those disconnects the whole fleet.
      const proc = Bun.spawnSync(["lsof", "-ti", `TCP:${BROKER_PORT}`, "-sTCP:LISTEN"]);
      const pids = new TextDecoder()
        .decode(proc.stdout)
        .trim()
        .split("\n")
        .filter((p) => p);
      for (const pid of pids) {
        process.kill(parseInt(pid, 10), "SIGTERM");
      }
      console.log("Broker stopped.");
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  case "install-hooks": {
    // Registers hook.ts for SessionStart, so a resumed conversation reclaims its
    // peer id, and for UserPromptSubmit, the unread-mail nudge (see hook.ts). The command is generated from this file's own
    // location, so re-run this after moving the repo. Our entry is recognised
    // by its trailing "# claude-peers" shell comment: re-running replaces it in
    // place instead of appending a duplicate, and anything else is untouched.
    const MARK = "# claude-peers";
    const flag = process.argv.indexOf("--settings");
    const path = flag > 0 ? process.argv[flag + 1]! : `${process.env.HOME}/.claude/settings.json`;
    const file = Bun.file(path);
    // Only the hooks we own are typed; everything else passes through untouched.
    type Hook = { command?: unknown; [k: string]: unknown };
    type Group = { hooks?: Hook[]; [k: string]: unknown };
    const settings: { hooks?: Record<string, Group[]>; [k: string]: unknown } = (await file.exists())
      ? await file.json()
      : {};
    const command = hookCommand(import.meta.dir);

    settings.hooks ??= {};
    for (const event of ["SessionStart", "UserPromptSubmit"]) {
      const groups: Group[] = (settings.hooks[event] ?? [])
        .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !String(h.command ?? "").endsWith(MARK)) }))
        .filter((g) => g.hooks.length > 0);
      groups.push({ hooks: [{ type: "command", command, timeout: 1 }] });
      settings.hooks[event] = groups;
    }

    // Write a sibling temp file and rename it over the original, so a crash
    // mid-write can't leave Claude Code a truncated settings.json. Resolve
    // symlinks first (dotfile managers link this file), or the rename would
    // replace the link with a plain file. The temp file is created with the
    // original's permissions, never wider even for a moment: settings.json can
    // hold secrets in env and is often 0600. (chmod after too: umask can only
    // narrow the creation mode.)
    const exists = await file.exists();
    const real = exists ? realpathSync(path) : path;
    const tmp = `${real}.tmp-${process.pid}`;
    try {
      const mode = exists ? statSync(real).mode & 0o7777 : 0o644;
      writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode, flag: "wx" });
      chmodSync(tmp, mode);
      renameSync(tmp, real);
    } catch (e) {
      try {
        unlinkSync(tmp);
      } catch {}
      throw e;
    }
    console.log(`Installed SessionStart and UserPromptSubmit hooks in ${path}:\n  ${command}`);

    // The /desktop-wake slash command, user-wide so it works from any project.
    // It runs this checkout's cli.ts by absolute path, like the hook above. A
    // file of the same name that isn't ours is left alone.
    const cmdPath = `${dirname(path)}/commands/desktop-wake.md`;
    const cmdFile = Bun.file(cmdPath);
    const wakeCommand = desktopWakeCommand(import.meta.dir);
    if (!wakeCommand) {
      console.log(
        `Skipped ${cmdPath}: this checkout's path has a line break or backtick. Move the repo to use /desktop-wake.`,
      );
    } else if ((await cmdFile.exists()) && !isOurDesktopWakeCommand(await cmdFile.text())) {
      console.log(`Skipped ${cmdPath}: it exists and isn't from claude-peers.`);
    } else {
      mkdirSync(dirname(cmdPath), { recursive: true });
      await Bun.write(cmdPath, wakeCommand);
      console.log(`Installed /desktop-wake in ${cmdPath}`);
    }
    break;
  }

  case "desktop-wake": {
    // Active: Desktop sessions arm a Monitor that wakes them within seconds of
    // a message, at one turn per session per 30-minute re-arm. Passive: pull
    // only, no idle cost. An agent's own setting wins over the global one.
    type Status = {
      global: string;
      relay: string | null;
      peers: { id: string; summary: string; mode: string; own_setting: boolean }[];
    };
    const args = process.argv.slice(3);
    const all = args.includes("--all");
    const [mode, ...rest] = args.filter((a) => a !== "--all");
    const target = rest.join(" ").trim();
    const show = (st: Status) => {
      console.log(`Global: ${st.global}${st.relay ? ` (relay ${st.relay})` : " (relay disabled)"}`);
      for (const p of st.peers) {
        console.log(
          `  ${p.id}  ${(p.mode + (p.own_setting ? "*" : "")).padEnd(8)} ${p.summary.slice(0, 70) || "(no summary)"}`,
        );
      }
      if (st.peers.some((p) => p.own_setting))
        console.log("  * = the agent's own setting, which wins over the global one");
      if (st.peers.some((p) => p.mode === "active"))
        console.log("Active agents re-arm their Monitor every 30 min, one turn each, even when idle.");
    };
    try {
      if (!mode || mode === "status") {
        show(await brokerFetch<Status>("/wake-status", {}));
        break;
      }
      if (!["active", "passive", "default"].includes(mode) || (mode === "default" && !target)) {
        console.error(
          "Usage: bun cli.ts desktop-wake [status | active | passive] [agent id or name] [--all]\n       bun cli.ts desktop-wake default <agent>   (the agent follows the global mode again)\n--all also clears every agent's own setting.",
        );
        process.exit(1);
      }
      let peer_id: string | undefined;
      if (target) {
        const st = await brokerFetch<Status>("/wake-status", {});
        const exact = st.peers.find((p) => p.id === target);
        const matches = exact
          ? [exact]
          : st.peers.filter((p) => p.summary.toLowerCase().includes(target.toLowerCase()));
        if (matches.length !== 1) {
          console.error(
            matches.length
              ? `"${target}" matches ${matches.length} Desktop sessions; pass an id:\n${matches.map((p) => `  ${p.id}  ${p.summary.slice(0, 70)}`).join("\n")}`
              : `No Desktop session matches "${target}".`,
          );
          process.exit(1);
        }
        peer_id = matches[0]!.id;
      }
      await brokerFetch("/wake-mode", { mode, peer_id, clear_overrides: all });
      show(await brokerFetch<Status>("/wake-status", {}));
      if (mode !== "passive") console.log("Agents switched to active pick it up on their next claude-peers call.");
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
    break;
  }

  default:
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
