/**
 * Server startup: register, connect over stdio, then poll and heartbeat.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { generateSummary, getGitBranch, getRecentFiles } from "../shared/summarize.ts";
import type { RegisterResponse } from "../shared/types.ts";
import { brokerFetch, ensureBroker, isNotFound, remember } from "./client.ts";
import {
  DEBUG_LOG_PATH,
  HEARTBEAT_INTERVAL_MS,
  HOST_PID,
  PEER_NAME,
  PEER_TYPE,
  POLL_INTERVAL_MS,
  SESSION_KEY,
} from "./config.ts";
import { pollAndPushMessages } from "./delivery.ts";
import { registerHandlers } from "./handlers.ts";
import { log, tightenLogFile } from "./log.ts";
import { mcp } from "./mcp.ts";
import { cliRegisterBody, desktopRegisterBody, getGitRoot, getTty, heartbeatHost } from "./sessions.ts";
import { desktopPeers, state } from "./state.ts";
import { WAKE_PASSIVE_NOTICE, wakeInstructions } from "./wake.ts";

// --- Startup ---

export async function main() {
  tightenLogFile(DEBUG_LOG_PATH);

  // 1. Ensure broker is running
  await ensureBroker();

  // 2. Gather context
  state.myCwd = process.cwd();
  state.myGitRoot = await getGitRoot(state.myCwd);
  const tty = getTty();

  log(`CWD: ${state.myCwd}`);
  log(`Git root: ${state.myGitRoot ?? "(none)"}`);
  log(`TTY: ${tty ?? "(unknown)"}`);

  // 3. Register with broker
  if (PEER_NAME) {
    log(`Fixed identity: ${PEER_NAME}`);
  }
  log(`Peer type: ${PEER_TYPE}`);

  if (PEER_TYPE === "desktop") {
    // Desktop: the MCP server process is shared across all Cowork sessions.
    // Do NOT register a host peer — it would become a "ghost" that collides
    // with real sessions whenever they call a tool without session_id.
    // Sessions register themselves lazily via getDesktopPeerId() when they
    // pass session_id on their first tool call.
    log("Desktop MCP server — skipping host peer registration. Sessions register lazily via session_id.");
    state.myId = null;
  } else {
    // CLI: register the host peer normally, with cached summary restore
    // and auto-summary fallback. The broker will return `restored_summary`
    // if a previous session in this workspace cached one.
    const reg = remember(await brokerFetch<RegisterResponse>("/register", cliRegisterBody(PEER_NAME)));
    state.myId = reg.id;
    log(
      `Registered as peer ${state.myId} (host pid ${HOST_PID}, session_key ${SESSION_KEY ? "present" : "absent — falling back to pid"})`,
    );

    if (reg.restored_summary) {
      state.myLastSummary = reg.restored_summary;
      log(`Restored summary from previous session: "${reg.restored_summary}"`);
    } else if (PEER_NAME) {
      state.myLastSummary = PEER_NAME;
    } else {
      // 4. No cached or fixed summary — generate one via gpt-5.4-nano (best-effort)
      (async () => {
        try {
          const branch = await getGitBranch(state.myCwd);
          const recentFiles = await getRecentFiles(state.myCwd);
          const summary = await generateSummary({
            cwd: state.myCwd,
            git_root: state.myGitRoot,
            git_branch: branch,
            recent_files: recentFiles,
          });
          if (summary && state.myId && !state.myLastSummary) {
            await brokerFetch("/set-summary", { id: state.myId, summary }, state.myId);
            state.myLastSummary = summary;
            log(`Auto-summary applied: ${summary}`);
          }
        } catch (e) {
          log(`Auto-summary failed (non-critical): ${e instanceof Error ? e.message : String(e)}`);
        }
      })();
    }
  }

  // 5. Connect MCP over stdio
  // Register oninitialized BEFORE connect so it's in place when the client
  // sends the initialized notification. Capabilities are only available
  // after the handshake completes — checking after connect() is a race.
  registerHandlers();
  mcp.oninitialized = () => {
    try {
      // Claude Desktop declares some capabilities under `experimental` rather
      // than the standard fields, so cast once to read everything we need.
      const caps = mcp.getClientCapabilities() as
        | { sampling?: unknown; elicitation?: unknown; experimental?: unknown }
        | undefined;
      log(
        `Client capabilities: sampling=${!!caps?.sampling}, elicitation=${!!caps?.elicitation}, experimental=${JSON.stringify(caps?.experimental)}`,
      );
    } catch (e) {
      log(`Could not read client capabilities: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  await mcp.connect(new StdioServerTransport());
  log("MCP connected");

  // 6. Start polling for inbound messages
  const pollTimer = setInterval(pollAndPushMessages, POLL_INTERVAL_MS);

  // 7. Start heartbeat (also re-registers if peer was cleaned up)
  const heartbeatTimer = setInterval(async () => {
    const beats: Promise<void>[] = [];
    if (state.myId) {
      beats.push(heartbeatHost().catch(() => {}));
    }
    for (const [sessionId, entry] of desktopPeers) {
      beats.push(
        brokerFetch<{ wake_url?: string }>("/heartbeat", { id: entry.peerId }, entry.peerId)
          .then((r) => {
            // The wake mode was switched (globally or for this session): tell
            // the session on its next tool call.
            if (r.wake_url === entry.wakeUrl) return;
            entry.wakeUrl = r.wake_url;
            entry.wakeNotice = r.wake_url
              ? `Wake mode for this session is now active.\n\n${wakeInstructions(r.wake_url, "claim")}`
              : WAKE_PASSIVE_NOTICE;
          })
          .catch(async (e) => {
            // Reaped while this process was idle or suspended. Register again:
            // desktop_tokens hands back the same id, so addresses other peers
            // hold and mail queued for it stay valid.
            if (!isNotFound(e)) return;
            const reg = remember(
              await brokerFetch<RegisterResponse>("/register", desktopRegisterBody(sessionId, entry.summary)),
            );
            desktopPeers.set(sessionId, {
              peerId: reg.id,
              summary: entry.summary,
              wakeUrl: reg.wake_url ?? entry.wakeUrl,
            });
            log(`Re-registered a reaped desktop session as peer ${reg.id}`);
          })
          .catch(() => {}),
      );
    }
    await Promise.all(beats);
  }, HEARTBEAT_INTERVAL_MS);

  // 8. Clean up on exit.
  // Deliberately do NOT unregister any peers here. This process is only the
  // transport: Desktop respawns MCP server processes on every bridge
  // reconnect, and the CLI respawns us on /mcp reconnect, while the SESSIONS
  // those peers represent live on. Unregistering on shutdown was the root
  // cause of peer-ID rotation (verified 2026-08-20: "Unregistered desktop
  // session cs_…" at 23:05 → same token re-registered minutes
  // later under a new id, stranding queued mail). The broker already reaps
  // truly-dead peers: CLI by host-pid liveness, desktop by heartbeat timeout.
  const cleanup = () => {
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}
