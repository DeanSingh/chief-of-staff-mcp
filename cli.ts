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
 *   bun cli.ts watch <id>      — Stream incoming messages for a peer (for Monitor tool)
 *   bun cli.ts install-hooks   — Register the SessionStart identity hook in ~/.claude/settings.json
 *   bun cli.ts kill-broker     — Stop the broker daemon
 */

import { realpathSync, renameSync } from "node:fs";

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;

async function brokerFetch<T>(path: string, body?: unknown): Promise<T> {
  const opts: RequestInit = body
    ? {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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

    // Stream incoming messages to stdout, one line per message.
    // Designed for use with Claude Code's Monitor tool — each stdout line
    // becomes a notification that Claude reacts to mid-conversation.
    // (Monitor's native `ws` source can subscribe to the same URL directly;
    // this command is the fallback for harnesses without it.)
    //
    // Subscribes to the broker's WebSocket feed (ws://.../watch/<peer>), which
    // is a wake signal only: nothing is acked, so the MCP server's
    // check_messages / piggyback fallback still works.
    //
    // Format: single-line JSON so multi-line message text is preserved.
    // Claude sees: [claude-peers] {"from":"abc","summary":"...","text":"..."}
    const wsUrl = `${BROKER_URL.replace(/^http/, "ws")}/watch/${encodeURIComponent(peerId)}`;
    console.error(`[claude-peers] Watching peer ${peerId} for incoming messages via ${wsUrl} (Ctrl+C to stop)`);

    let backoff = 1000;
    while (true) {
      await new Promise<void>((resolve) => {
        const ws = new WebSocket(wsUrl);
        ws.onopen = () => { backoff = 1000; };
        ws.onmessage = (ev) => {
          try {
            const frame = JSON.parse(String(ev.data)) as {
              type: string; from_id?: string; from_summary?: string; sent_at?: string; text?: string;
            };
            if (frame.type !== "peer_message") return; // "watching" handshake etc.
            const payload = {
              from: frame.from_id,
              summary: frame.from_summary ?? "",
              sent_at: frame.sent_at,
              text: frame.text,
            };
            // One line of JSON per message — Monitor feeds this to Claude as a notification
            console.log(`[claude-peers] ${JSON.stringify(payload)}`);
          } catch {
            // ignore malformed frame
          }
        };
        ws.onerror = () => { /* onclose follows */ };
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
        process.kill(parseInt(pid), "SIGTERM");
      }
      console.log("Broker stopped.");
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  case "install-hooks": {
    // Registers hook.ts for SessionStart so a resumed conversation reclaims its
    // peer id (see hook.ts). The command is generated from this file's own
    // location, so re-run this after moving the repo. Our entry is recognised
    // by its trailing "# claude-peers" shell comment: re-running replaces it in
    // place instead of appending a duplicate, and anything else is untouched.
    const MARK = "# claude-peers";
    const flag = process.argv.indexOf("--settings");
    const path = flag > 0 ? process.argv[flag + 1]! : `${process.env.HOME}/.claude/settings.json`;
    const file = Bun.file(path);
    const settings: any = (await file.exists()) ? await file.json() : {};
    const command = `bun "${import.meta.dir}/hook.ts" ${MARK}`;

    settings.hooks ??= {};
    const groups: any[] = (settings.hooks.SessionStart ?? [])
      .map((g: any) => ({ ...g, hooks: (g.hooks ?? []).filter((h: any) => !String(h.command ?? "").endsWith(MARK)) }))
      .filter((g: any) => g.hooks.length > 0);
    groups.push({ hooks: [{ type: "command", command, timeout: 1 }] });
    settings.hooks.SessionStart = groups;

    // Write a sibling temp file and rename it over the original, so a crash
    // mid-write can't leave Claude Code a truncated settings.json. Resolve
    // symlinks first (dotfile managers link this file), or the rename would
    // replace the link with a plain file.
    const real = (await file.exists()) ? realpathSync(path) : path;
    const tmp = `${real}.tmp-${process.pid}`;
    await Bun.write(tmp, JSON.stringify(settings, null, 2) + "\n");
    renameSync(tmp, real);
    console.log(`Installed SessionStart hook in ${path}:\n  ${command}`);
    break;
  }

  default:
    console.log(`claude-peers CLI

Usage:
  bun cli.ts status          Show broker status and all peers
  bun cli.ts peers           List all peers
  bun cli.ts send <id> <msg> Send a message to a peer
  bun cli.ts watch <id>      Stream incoming messages for a peer (for Monitor tool)
  bun cli.ts install-hooks   Register the SessionStart identity hook [--settings <path>]
  bun cli.ts kill-broker     Stop the broker daemon`);
}
