/**
 * MCP request handlers: tools/list and tools/call.
 */

import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Peer, PeerId, PollMessagesResponse, RegisterResponse } from "../shared/types.ts";
import { brokerFetch, isNotFound, remember } from "./client.ts";
import { PEER_NAME, PEER_TYPE } from "./config.ts";
import { ackMessages, appendPendingMessages, clearPreview, inboxes, unreadBanner } from "./delivery.ts";
import { log, toolCallLogLine } from "./log.ts";
import { mcp } from "./mcp.ts";
import {
  cliRegisterBody,
  desktopRegisterBody,
  getDesktopPeerId,
  isAmbiguousSession,
  mintSessionToken,
  resolvableSession,
} from "./sessions.ts";
import { desktopPeers, state } from "./state.ts";
import { SESSION_PARAM, TOOLS } from "./tools.ts";
import { WAKE_PASSIVE_NOTICE, peerListHeader, wakeCopy, wakeInstructions } from "./wake.ts";

function missingSessionIdError(toolName: string): string {
  let exampleArgs = "";
  switch (toolName) {
    case "set_summary":
      exampleArgs = '"summary": "...",';
      break;
    case "send_message":
      exampleArgs = '"to_id": "...", "message": "...",';
      break;
  }
  return `❌ claude-peers: Desktop sessions must pass \`${SESSION_PARAM}\` on "${toolName}" calls.

This MCP server is shared across all Desktop/Cowork sessions on this machine. Without \`${SESSION_PARAM}\`, your tool call cannot be attributed to your session — summaries get overwritten and messages get routed to the wrong session.

NOTE: the parameter is \`${SESSION_PARAM}\`, NOT \`session_id\`. Claude Desktop's remote-tools layer reserves the name \`session_id\` and strips it before the call reaches this server, so a value passed under that name is silently discarded.

To get your ${SESSION_PARAM}:
1. Call claim_session({ "label": "<short name for this session, e.g. PM agent>" }).
2. It returns a token like "cs_1a2b3c4d5e6f".
3. Pass that token as \`${SESSION_PARAM}\` on every claude-peers tool call.

Do NOT use \`pwd\` — every cloud Cowork session shares /home/claude, so it cannot tell sessions apart and the server rejects it.

Example:
  ${toolName}({
    ${exampleArgs}
    "${SESSION_PARAM}": "cs_1a2b3c4d5e6f"
  })

Retry this call with ${SESSION_PARAM} included.`;
}

function ambiguousSessionError(toolName: string, value: string): string {
  return `❌ claude-peers: "${value}" is not a unique session identifier, so "${toolName}" was rejected.

Every cloud Cowork session runs with this same working directory. If sessions keyed on it, they would all share ONE peer identity: your summary would overwrite another agent's, and a message addressed to that peer could be delivered back to you instead of the agent you meant to reach.

Fix — claim your own identity, then reuse it:
1. Call claim_session({ "label": "<short name for this session, e.g. PM agent>" }).
2. It returns a token like "cs_1a2b3c4d5e6f".
3. Pass that token as \`${SESSION_PARAM}\` on EVERY later claude-peers call, including a retry of this one.
4. Remember the token for the whole conversation. If you lose it, call claim_session again — but reuse it whenever you still have it, since each claim creates a new peer identity.`;
}

/** Installs the tools/list and tools/call handlers on the MCP server. */
export function registerHandlers(): void {
  mcp.setRequestHandler(ListToolsRequestSchema, async () => {
    const served = new Set([...(state.myId ? [state.myId] : []), ...[...desktopPeers.values()].map((e) => e.peerId)]);
    const previews = [...served].map((id) => inboxes.get(id)?.preview ?? "").filter(Boolean);
    const banner = unreadBanner(previews, PEER_TYPE, served.size);
    if (!banner) return { tools: TOOLS };

    // Inject the banner into check_messages description
    const dynamicTools = TOOLS.map((t) => {
      if (t.name === "check_messages") {
        return { ...t, description: `${banner}\n\n${t.description}` };
      }
      return t;
    });
    return { tools: dynamicTools };
  });

  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    log(toolCallLogLine(req.params.name, req.params.arguments));
    const { name, arguments: args } = req.params;
    // Prefer SESSION_PARAM. `session_id` is still accepted for direct MCP
    // clients (Claude Code CLI, .mcp.json), where nothing strips it — but it
    // never survives Desktop's remote-devices path. See SESSION_PARAM above.
    const sessionId = (args?.[SESSION_PARAM] ?? args?.session_id) as string | undefined;

    // Tools that establish identity rather than requiring one.
    const EXEMPT = name === "list_peers" || name === "claim_session";

    // GUARD 2: reject session keys that are not unique per session. Accepting
    // /home/claude silently aliases every cloud Cowork session onto one peer —
    // summaries overwrite each other and messages can be delivered back to the
    // sender. Failing loudly here is strictly better than aliasing quietly.
    if (PEER_TYPE === "desktop" && !EXEMPT && sessionId && isAmbiguousSession(sessionId)) {
      log(`REJECTED ${name}: ambiguous ${SESSION_PARAM}="${sessionId}"`);
      return {
        content: [
          {
            type: "text" as const,
            text: ambiguousSessionError(name, sessionId),
          },
        ],
        isError: true,
      };
    }

    // GUARD 1: desktop sessions must pass a session key for identity-bearing
    // tools. The MCP server process is shared across all Desktop/Cowork
    // sessions, so without one, tool calls collapse onto the host peer (state.myId)
    // and multiple sessions overwrite each other's summaries. list_peers is
    // exempt because it's read-only and sessions need it for discovery;
    // claim_session is exempt because it is how a session gets a key.
    if (PEER_TYPE === "desktop" && !sessionId && !EXEMPT) {
      log(`REJECTED ${name}: no ${SESSION_PARAM}. arg keys=[${Object.keys(args ?? {}).join(", ")}]`);
      return {
        content: [
          {
            type: "text" as const,
            text: missingSessionIdError(name),
          },
        ],
        isError: true,
      };
    }

    const identitySession = resolvableSession(sessionId);
    const effectivePeerId =
      identitySession && PEER_TYPE === "desktop" ? await getDesktopPeerId(identitySession) : state.myId;
    const toolResult = await handleTool(name, args, effectivePeerId, identitySession);
    const entry = identitySession ? desktopPeers.get(identitySession) : undefined;
    if (entry?.wakeNotice) {
      toolResult.content.push({ type: "text" as const, text: `\n\n${entry.wakeNotice}` });
      entry.wakeNotice = undefined;
    }
    return appendPendingMessages(toolResult, name, effectivePeerId);
  });
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

async function handleTool(
  name: string,
  args: Record<string, unknown> | undefined,
  effectivePeerId: PeerId | null,
  sessionId: string | undefined,
): Promise<ToolResult> {
  switch (name) {
    case "claim_session": {
      const label = ((args as { label?: string })?.label ?? "").trim();
      const token = mintSessionToken();
      try {
        const reg = remember(
          await brokerFetch<RegisterResponse>("/register", {
            ...desktopRegisterBody(token, label || PEER_NAME),
            cwd: label ? `${state.myCwd} (${label})` : state.myCwd,
          }),
        );
        desktopPeers.set(token, { peerId: reg.id, summary: label || PEER_NAME, wakeUrl: reg.wake_url });
        log(`Claimed a session -> peer ${reg.id} (${label})`);
        const wake = wakeCopy(reg.wake_url, "claim");
        return {
          content: [
            {
              type: "text" as const,
              text: `✅ Session claimed. Your peer ID is ${reg.id}.

Your ${SESSION_PARAM} token is:

    ${token}

Pass \`"${SESSION_PARAM}": "${token}"\` on EVERY subsequent claude-peers call (send_message, set_summary, check_messages). Remember it for the whole conversation — do not call claim_session again unless you have lost it, because each claim creates a new peer identity.

Next: call set_summary (with your token) to tell other peers what you are working on.${wake ? `\n\n${wake}` : ""}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error claiming session: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "list_peers": {
      const scope = (args as { scope: string }).scope as "machine" | "directory" | "repo";
      try {
        const peers = await brokerFetch<Peer[]>("/list-peers", {
          scope,
          cwd: state.myCwd,
          git_root: state.myGitRoot,
          exclude_id: effectivePeerId,
        });

        const header = effectivePeerId
          ? peerListHeader(effectivePeerId, sessionId ? desktopPeers.get(sessionId)?.wakeUrl : undefined)
          : `⚠️ You have no peer identity yet. Desktop/Cowork sessions must call \`claim_session\` (with a short label) to get a \`${SESSION_PARAM}\` token, then pass that token on every claude-peers tool call except list_peers. Do NOT use \`pwd\` — every cloud session shares /home/claude and would collide onto one identity. Note the parameter is \`${SESSION_PARAM}\`, NOT \`session_id\` — Claude Desktop reserves that name and strips it in transit. Until you claim one, other peers cannot message you and set_summary/send_message will error.\n\n`;

        if (peers.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `${header}No other Claude Code instances found (scope: ${scope}).`,
              },
            ],
          };
        }

        const lines = peers.map((p) => {
          const parts = [`ID: ${p.id}`, `Type: ${p.peer_type ?? "cli"}`, `PID: ${p.pid}`, `CWD: ${p.cwd}`];
          if (p.git_root) parts.push(`Repo: ${p.git_root}`);
          if (p.tty) parts.push(`TTY: ${p.tty}`);
          if (p.summary) parts.push(`Summary: ${p.summary}`);
          parts.push(`Last seen: ${p.last_seen}`);
          return parts.join("\n  ");
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `${header}Found ${peers.length} peer(s) (scope: ${scope}):\n\n${lines.join("\n\n")}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error listing peers: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "send_message": {
      const { to_id, message } = args as { to_id: string; message: string };
      if (!to_id) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Missing to_id. Call list_peers first to get peer IDs, then pass the ID as to_id.",
            },
          ],
          isError: true,
        };
      }
      if (!effectivePeerId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<{
          ok: boolean;
          error?: string;
          woke?: number;
          target_last_seen?: string;
          target_type?: string;
        }>(
          "/send-message",
          {
            from_id: effectivePeerId,
            to_id,
            text: message,
          },
          effectivePeerId,
        );
        if (!result.ok) {
          return {
            content: [{ type: "text" as const, text: `Failed to send: ${result.error}` }],
            isError: true,
          };
        }
        // Say what actually happened, so silence from the target is never
        // mistaken for delivery. "Sent" only ever means "queued on the broker".
        const ageSec = result.target_last_seen
          ? Math.max(0, Math.round((Date.now() - Date.parse(result.target_last_seen)) / 1000))
          : null;
        const ageText = ageSec === null ? "" : ageSec < 60 ? `${ageSec}s ago` : `${Math.round(ageSec / 60)}m ago`;
        const status =
          result.woke && result.woke > 0
            ? `delivered — the peer has a live wake watch and was woken instantly`
            : result.target_type === "cli"
              ? `queued — CLI peer, pushed via channel if their session is running (last seen ${ageText})`
              : `queued — desktop/cloud peer, they will see it on their next claude-peers tool call or check_messages (last seen ${ageText})`;
        return {
          content: [{ type: "text" as const, text: `Message sent to peer ${to_id}: ${status}.` }],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error sending message: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "set_summary": {
      const { summary } = args as { summary: string };
      if (!effectivePeerId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        await brokerFetch("/set-summary", { id: effectivePeerId, summary }, effectivePeerId);
        // Update the right summary store
        if (sessionId && PEER_TYPE === "desktop") {
          const entry = desktopPeers.get(sessionId);
          if (entry) entry.summary = summary;
        } else {
          state.myLastSummary = summary;
        }
        return {
          content: [
            { type: "text" as const, text: `Summary updated: "${summary}" (your peer ID: ${effectivePeerId})` },
          ],
        };
      } catch (e) {
        // If peer was cleaned up, re-register
        const errMsg = e instanceof Error ? e.message : String(e);
        if (isNotFound(e)) {
          try {
            if (sessionId && PEER_TYPE === "desktop") {
              // Re-register with summary in one call (avoids extra /set-summary round-trip)
              desktopPeers.delete(sessionId);
              const reg = remember(
                await brokerFetch<RegisterResponse>("/register", desktopRegisterBody(sessionId, summary)),
              );
              desktopPeers.set(sessionId, { peerId: reg.id, summary, wakeUrl: reg.wake_url });
              log(`Re-registered a desktop session as peer ${reg.id}`);
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Re-registered and summary set: "${summary}" (new peer ID: ${reg.id})`,
                  },
                ],
              };
            } else {
              const reg = remember(await brokerFetch<RegisterResponse>("/register", cliRegisterBody(summary)));
              state.myId = reg.id;
              state.myLastSummary = summary;
              log(`Re-registered as peer ${state.myId} after stale cleanup`);
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Re-registered and summary set: "${summary}" (new peer ID: ${state.myId})`,
                  },
                ],
              };
            }
          } catch {
            // fall through to error
          }
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `Error setting summary: ${errMsg}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "set_wake": {
      const mode = (args as { mode?: string })?.mode;
      const entry = sessionId ? desktopPeers.get(sessionId) : undefined;
      if (!effectivePeerId || !entry) {
        return {
          content: [{ type: "text" as const, text: "set_wake is for Desktop sessions: claim_session first." }],
          isError: true,
        };
      }
      try {
        const r = await brokerFetch<{ wake_url?: string }>("/wake-mode", { mode, peer_id: effectivePeerId });
        entry.wakeUrl = r.wake_url;
        entry.wakeNotice = undefined;
        return {
          content: [
            {
              type: "text" as const,
              text: r.wake_url
                ? `Wake mode for this session is now active.\n\n${wakeInstructions(r.wake_url, "claim")}`
                : mode === "passive"
                  ? WAKE_PASSIVE_NOTICE
                  : `This session now follows the global wake mode, which is passive. ${WAKE_PASSIVE_NOTICE}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            { type: "text" as const, text: `Error setting wake mode: ${e instanceof Error ? e.message : String(e)}` },
          ],
          isError: true,
        };
      }
    }

    case "check_messages": {
      if (!effectivePeerId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<PollMessagesResponse>(
          "/poll-messages",
          { id: effectivePeerId },
          effectivePeerId,
        );
        if (result.messages.length > 0) {
          await ackMessages(effectivePeerId, result.messages);
        }
        await clearPreview(effectivePeerId);
        if (result.messages.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No new messages." }],
          };
        }
        const lines = result.messages.map((m) => `From ${m.from_id} (${m.sent_at}):\n${m.text}`);
        return {
          content: [
            {
              type: "text" as const,
              text: `${result.messages.length} new message(s):\n\n${lines.join("\n\n---\n\n")}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error checking messages: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
