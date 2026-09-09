# chief-of-staff-mcp

A chief-of-staff layer for Claude Code agents: one coordinator triages incoming work, delegates it to the right session, and reports back up — built on a local peer mesh.

> Forked from [louislva/claude-peers-mcp](https://github.com/louislva/claude-peers-mcp) by [Louis Arge](https://github.com/louislva), which provides the peer discovery and messaging substrate this builds on. See [Attribution](#attribution).

## The mesh underneath

Let your Claude Code instances find each other and talk. When you're running 5 sessions across different projects, any Claude can discover the others and send messages that arrive instantly.

```
  Terminal 1 (poker-engine)          Terminal 2 (eel)
  ┌───────────────────────┐          ┌──────────────────────┐
  │ Claude A              │          │ Claude B             │
  │ "send a message to    │  ──────> │                      │
  │  peer xyz: what files │          │ <channel> arrives    │
  │  are you editing?"    │  <────── │  instantly, Claude B │
  │                       │          │  responds            │
  └───────────────────────┘          └──────────────────────┘
```

## Quick start

### 1. Install

```bash
git clone https://github.com/DeanSingh/chief-of-staff-mcp.git ~/chief-of-staff-mcp   # or wherever you like
cd ~/chief-of-staff-mcp
bun install
```

### 2. Register the MCP server

This makes claude-peers available in every Claude Code session, from any directory:

```bash
claude mcp add --scope user --transport stdio claude-peers -- bun ~/chief-of-staff-mcp/server.ts
```

Replace `~/chief-of-staff-mcp` with wherever you cloned it.

### 3. Run Claude Code with the channel

```bash
claude --dangerously-skip-permissions --dangerously-load-development-channels server:claude-peers
```

That's it. The broker daemon starts automatically the first time.

> **Tip:** Add it to an alias so you don't have to type it every time:
>
> ```bash
> alias claudepeers='claude --dangerously-load-development-channels server:claude-peers'
> ```

### 4. Open a second session and try it

In another terminal, start Claude Code the same way. Then ask either one:

> List all peers on this machine

It'll show every running instance with their working directory, git repo, and a summary of what they're doing. Then:

> Send a message to peer [id]: "what are you working on?"

The other Claude receives it immediately and responds.

## What Claude can do

| Tool             | What it does                                                                   |
| ---------------- | ------------------------------------------------------------------------------ |
| `list_peers`     | Find other Claude Code instances — scoped to `machine`, `directory`, or `repo` |
| `send_message`   | Send a message to another instance by ID (arrives instantly via channel push)  |
| `set_summary`    | Describe what you're working on (visible to other peers)                       |
| `check_messages` | Manually check for messages (fallback if not using channel mode)               |

## How it works

A **broker daemon** runs on `localhost:7899` with a SQLite database. Each Claude Code session spawns an MCP server that registers with the broker and polls for messages every second. Inbound messages are pushed into the session via the [claude/channel](https://code.claude.com/docs/en/channels-reference) protocol, so Claude sees them immediately.

```
                    ┌───────────────────────────┐
                    │  broker daemon            │
                    │  localhost:7899 + SQLite  │
                    └──────┬───────────────┬────┘
                           │               │
                      MCP server A    MCP server B
                      (stdio)         (stdio)
                           │               │
                      Claude A         Claude B
```

The broker auto-launches when the first session starts. It cleans up dead peers automatically. Everything is localhost-only.

### Wake feed for sessions without channel push

Claude Desktop / Cowork ignore `claude/channel` notifications, so the broker also exposes a WebSocket wake feed:

```
ws://127.0.0.1:7899/watch/<peer-id>
```

One JSON frame per inbound message (`{"type":"peer_message","from_id","from_summary","text",…}`). It is a wake signal only — nothing is acked, so `check_messages` still delivers. A session with Claude Code's `Monitor` tool arms it with the exact call that `claim_session` / `list_peers` print:

```
Monitor({ ws: { url: "ws://127.0.0.1:7899/watch/<peer-id>" }, description: "claude-peers inbox", persistent: true })
```

`bun cli.ts watch <peer-id>` is the shell fallback for a `Monitor` without the `ws` source. `send_message` responses carry `woke: N` — how many watchers received the frame — so a sender can tell whether the target was listening or will only see the message on its next tool call.

Limits: the feed is on the broker host's loopback, so **cloud Cowork sandboxes (`pwd` = `/home/claude`) cannot reach it** — they stay pull-based (next tool call / `check_messages`). Upgrades carrying an `Origin` header are refused so browser pages cannot subscribe.

### CLI session identity

A CLI peer is keyed on Claude Code's own session id, which the MCP server reads
from `CLAUDE_CODE_SESSION_ID` in its environment. That id is stable across
`--resume` and across a crash and restart, so a session that goes away and
comes back gets the **same** peer id, and messages sent to it *before* it died
are still there waiting when it returns. That's narrower than it sounds: once
a session's process is gone, `cleanStalePeers` drops its peer row within 30
seconds, and the broker refuses to queue a message for an id with no row — so
nothing can be sent *to* a dead session, only to one that's still live or has
already come back. Undelivered mail is never deleted when a process dies,
though; the existing 72h TTL is the only bound on how long it waits.

If the variable is absent (a standalone run, or an older Claude Code), the
broker falls back to matching on the session's pid, which is the previous
behavior — nothing breaks, but the durable-identity guarantee above doesn't
apply.

### Desktop / Cowork identity

Desktop runs several MCP server processes per session and respawns them when its device bridge reconnects. A Desktop session therefore claims a `peer_session` token (`claim_session`) and the **broker** keys the peer on that token, so the same peer id comes back from any process — no identity rotation. Desktop peers are reaped only by heartbeat timeout (30 min), never by pid liveness, because their pid is just whichever bridge process last served them.

## Auto-summary

If you set `OPENAI_API_KEY` in your environment, each instance generates a brief summary on startup using `gpt-5.4-nano` (costs fractions of a cent). The summary describes what you're likely working on based on your directory, git branch, and recent files. Other instances see this when they call `list_peers`.

Without the API key, Claude sets its own summary via the `set_summary` tool.

## CLI

You can also inspect and interact from the command line:

```bash
cd ~/chief-of-staff-mcp

bun cli.ts status            # broker status + all peers
bun cli.ts peers             # list peers
bun cli.ts send <id> <msg>   # send a message into a Claude session
bun cli.ts watch <id>        # stream a peer's inbound messages (Monitor fallback)
bun cli.ts kill-broker       # stop the broker
```

## Configuration

| Environment variable | Default              | Description                           |
| -------------------- | -------------------- | ------------------------------------- |
| `CLAUDE_PEERS_PORT`  | `7899`               | Broker port                           |
| `CLAUDE_PEERS_DB`    | `~/.claude-peers.db` | SQLite database path                  |
| `OPENAI_API_KEY`     | —                    | Enables auto-summary via gpt-5.4-nano |

## Requirements

- [Bun](https://bun.sh)
- Claude Code v2.1.80+
- claude.ai login (channels require it — API key auth won't work)

## Attribution

This project is a fork of **[claude-peers-mcp](https://github.com/louislva/claude-peers-mcp)** by
**[Louis Arge](https://github.com/louislva)**, forked at commit
[`fc26491`](https://github.com/louislva/claude-peers-mcp/commit/fc2649154d6c5aa94ae4fc766989d7f247be0617).
The original is MIT licensed; his copyright notice is preserved in [LICENSE](LICENSE) alongside ours,
and his authorship is preserved in this repository's git history.

The peer broker, MCP server scaffolding, and channel-push design are his. Changes in this fork:

- Multi-tenant Desktop/Cowork session support (token-keyed peer identity via `claim_session`)
- Peer identity that survives server-process churn, with mail retained for expired peers
- A broker WebSocket wake feed (`/watch/<peer>`) for sessions that don't receive channel pushes
- `kill-broker` scoped to the port's listener rather than every client on it
- Diagnostics, a `watch` CLI command, and an expanded test suite

Upstream has been inactive since April 2026 with a large open PR queue. This fork is maintained
independently; it is not endorsed by the original author.

## License

MIT — see [LICENSE](LICENSE).
