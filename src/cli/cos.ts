/**
 * `bun cli.ts cos`: name the chief of staff, the one peer the broker lets
 * answer, escalate and read the digest as a peer. Only this command, run by
 * the human, sets the role: no MCP tool, registration or peer message can.
 */

import { brokerFetch } from "./client.ts";

const USAGE = "Usage: bun cli.ts cos [<peer id or a unique part of its name> | --clear]";

type PeerRow = { id: string; cwd: string; summary: string; peer_type?: string };

async function allPeers(): Promise<PeerRow[]> {
  return brokerFetch<PeerRow[]>("/list-peers", { scope: "machine", cwd: "/", git_root: null });
}

/** A peer's name as people know it: its summary, else the Desktop label in its cwd. */
const nameOf = (p: PeerRow) => p.summary || p.cwd;

/** The one peer `target` names, by id or a unique part of its name. Exits if there isn't one. */
async function resolvePeer(target: string): Promise<PeerRow> {
  const peers = await allPeers();
  const exact = peers.find((p) => p.id === target);
  const needle = target.toLowerCase();
  const matches = exact
    ? [exact]
    : peers.filter((p) => p.summary.toLowerCase().includes(needle) || p.cwd.toLowerCase().includes(needle));
  if (matches.length !== 1) {
    console.error(
      matches.length
        ? `"${target}" matches ${matches.length} peers; pass an id:\n${matches.map((p) => `  ${p.id}  ${nameOf(p).slice(0, 70)}`).join("\n")}`
        : `No peer matches "${target}".`,
    );
    process.exit(1);
  }
  return matches[0]!;
}

async function show(): Promise<void> {
  const { peer_id } = await brokerFetch<{ peer_id: string | null }>("/cos-status", {});
  if (!peer_id) {
    console.log("No chief of staff.");
    return;
  }
  const peer = (await allPeers()).find((p) => p.id === peer_id);
  console.log(`Chief of staff: ${peer_id}  ${peer ? nameOf(peer).slice(0, 70) : "(not running)"}`);
}

/** `cos`: show, name or clear the chief of staff. */
export async function cos(): Promise<void> {
  const args = process.argv.slice(3);
  const target = args.join(" ").trim();
  try {
    if (!target) return await show();
    if (target === "--clear") {
      await brokerFetch("/set-cos", { peer_id: null });
      console.log("No chief of staff.");
      return;
    }
    if (target.startsWith("-")) {
      console.error(USAGE);
      process.exit(1);
    }
    const peer = await resolvePeer(target);
    await brokerFetch("/set-cos", { peer_id: peer.id });
    console.log(`Chief of staff is now ${peer.id}  ${nameOf(peer).slice(0, 70)}`);
    console.log(
      peer.peer_type === "desktop"
        ? "Its server shows it the coordinator tools within one heartbeat (15 s). Every Desktop session on that server sees them too, but the broker refuses any other session's calls."
        : "Its server shows it the coordinator tools within one heartbeat (15 s).",
    );
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
