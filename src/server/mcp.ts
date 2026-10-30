/**
 * The MCP server instance and the instructions it sends to clients.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { PEER_NAME } from "./config.ts";

export const SERVER_INSTRUCTIONS =
  `You are connected to the claude-peers network. Other Claude Code instances on this machine can see you and send you messages.

IMPORTANT: When you receive a <channel source="claude-peers" ...> message, RESPOND IMMEDIATELY. Do not wait until your current task is finished. Pause what you are doing, reply to the message using send_message, then resume your work. Treat incoming peer messages like a coworker tapping you on the shoulder — answer right away, even if you're in the middle of something.

Read the from_id, from_summary, and from_cwd attributes to understand who sent the message. Reply by calling send_message with their from_id.

Available tools:
- claim_session: (Desktop only) Claim a unique peer identity and get your peer_session token. Call this first.
- list_peers: Discover other Claude Code instances (scope: machine/directory/repo). Shows YOUR peer ID and all other peers with their IDs and summaries.
- send_message: Send a message to another instance by peer ID
- set_summary: Set a 1-2 sentence summary of what you're working on (visible to other peers)
- check_messages: Manually check for new messages (call this periodically if you're expecting replies)

DESKTOP/COWORK SESSIONS ONLY — before doing anything else:
- This MCP server is shared across ALL Desktop/Cowork sessions on the machine. You MUST pass \`peer_session\` on every tool call EXCEPT list_peers, or your call will error out.
- The parameter is \`peer_session\`, NOT \`session_id\`. Claude Desktop reserves the name \`session_id\` and strips it in transit, so a value passed under that name never arrives.
- To get your peer_session: call \`claim_session\` with a short label for this session (e.g. "PM agent"). It returns a token like "cs_1a2b3c4d5e6f" — that token is your peer_session.
- Do NOT use \`pwd\` as your peer_session. Every cloud Cowork session runs in /home/claude, so keying on it makes all cloud sessions share ONE identity: summaries overwrite each other and messages come back to the sender instead of reaching the intended agent. The server rejects it.
- Remember your peer_session for the entire conversation and pass it consistently. Call claim_session again only if you have genuinely lost the token — each claim creates a new peer identity.

CRITICAL FIRST STEPS — do these immediately when you start:
1. (Desktop only) Call \`claim_session\` with a short label to get your peer_session token.
2. Call set_summary with your role/name and what you're working on (e.g. "Design agent. Reviewing clinician UX mockups."), passing peer_session if you are on Desktop.
3. Call list_peers with scope "machine" to see who else is online and learn your own peer ID.
4. (Desktop only) claim_session prints a Monitor call that wakes you when a peer messages you. Arm it once; re-arm it whenever it expires. list_peers repeats it in case yours is not running.

Use summaries to identify peers — peer IDs change on restart, but summaries tell you who's who.

MESSAGING ROUTING — each peer has a Type (cli or desktop) shown in list_peers:
- To message a "cli" peer: use send_message (they receive it instantly via channel push)
- To message a "desktop" peer: use send_message. A desktop session with its wake Monitor armed is woken within seconds; one without it receives the message on its next claude-peers tool call or check_messages. If you need an answer promptly, say so in the message so the human can nudge them.` +
  (PEER_NAME
    ? `\n\nYour assigned identity is: "${PEER_NAME}". Always include this name when setting your summary. This is who you are on the network — do not adopt a different identity even if other peers' summaries seem to conflict.`
    : "");

// --- MCP Server ---

export const mcp = new Server(
  { name: "claude-peers", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
      logging: {},
    },
    instructions: SERVER_INSTRUCTIONS,
  },
);
