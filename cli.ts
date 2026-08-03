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
 *   bun cli.ts kill-broker     — Stop the broker daemon
 */

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
    //
    // Format: single-line JSON so multi-line message text is preserved.
    // Claude sees: [claude-peers] {"from":"abc","summary":"...","text":"..."}
    console.error(`[claude-peers] Watching peer ${peerId} for incoming messages (Ctrl+C to stop)`);

    // Track last seen id so we only report new messages (peek, don't ack,
    // so the MCP server's piggyback/check_messages fallback still works).
    let sinceId = 0;
    let peersCache: Array<{ id: string; summary: string }> = [];
    let peersCacheTime = 0;

    while (true) {
      try {
        const result = await brokerFetch<{
          messages: Array<{ id: number; from_id: string; text: string; sent_at: string }>;
        }>("/peek-messages", { id: peerId, since_id: sinceId });

        if (result.messages.length > 0) {
          // Refresh peer cache at most once per 10s for sender summaries
          if (Date.now() - peersCacheTime > 10_000) {
            try {
              peersCache = await brokerFetch<Array<{ id: string; summary: string }>>(
                "/list-peers",
                { scope: "machine", cwd: "/", git_root: null }
              );
              peersCacheTime = Date.now();
            } catch {
              // Non-critical
            }
          }

          for (const msg of result.messages) {
            if (msg.id > sinceId) sinceId = msg.id;
            const sender = peersCache.find((p) => p.id === msg.from_id);
            const payload = {
              from: msg.from_id,
              summary: sender?.summary ?? "",
              sent_at: msg.sent_at,
              text: msg.text,
            };
            // One line of JSON per message — Monitor feeds this to Claude as a notification
            console.log(`[claude-peers] ${JSON.stringify(payload)}`);
          }
        }
      } catch (e) {
        console.error(`[claude-peers] Poll error: ${e instanceof Error ? e.message : String(e)}`);
      }

      await new Promise((r) => setTimeout(r, 1000));
    }
    break;
  }

  case "kill-broker": {
    try {
      const health = await brokerFetch<{ status: string; peers: number }>("/health");
      console.log(`Broker has ${health.peers} peer(s). Shutting down...`);
      // Find and kill the broker process on the port
      const proc = Bun.spawnSync(["lsof", "-ti", `:${BROKER_PORT}`]);
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

  default:
    console.log(`claude-peers CLI

Usage:
  bun cli.ts status          Show broker status and all peers
  bun cli.ts peers           List all peers
  bun cli.ts send <id> <msg> Send a message to a peer
  bun cli.ts watch <id>      Stream incoming messages for a peer (for Monitor tool)
  bun cli.ts kill-broker     Stop the broker daemon`);
}
