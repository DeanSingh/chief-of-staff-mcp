/**
 * Broker inspection commands: status, peers, send, kill-broker.
 */

import { BROKER_PORT, BROKER_URL, brokerFetch } from "./client.ts";

/** `status`: broker health and every peer. */
export async function status(): Promise<void> {
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
  return;
}

/** `peers`: every registered peer. */
export async function listPeers(): Promise<void> {
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
  return;
}

/** `send <id> <msg>`: message a peer as the operator. */
export async function send(): Promise<void> {
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
  return;
}

/** `kill-broker`: stop the broker daemon, never its clients. */
export async function killBroker(): Promise<void> {
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
  return;
}
