/**
 * `bun cli.ts desktop-wake`: Desktop sessions' wake mode.
 */

import { brokerFetch } from "./client.ts";

/** `desktop-wake`: show or switch Desktop sessions' wake mode. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: argument parsing and the agent lookup for one command
export async function desktopWake(): Promise<void> {
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
      return;
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
      const matches = exact ? [exact] : st.peers.filter((p) => p.summary.toLowerCase().includes(target.toLowerCase()));
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
  return;
}
