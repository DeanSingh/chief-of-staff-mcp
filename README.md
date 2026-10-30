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

### Access control

Loopback alone doesn't keep web pages out: a page you open can POST to `127.0.0.1`, and a DNS-rebinding page can read the replies. So the broker:

- refuses any request with an `Origin` header, a `Host` other than `127.0.0.1:<port>` / `localhost:<port>`, or (for POSTs) a `Content-Type` other than `application/json`;
- requires an install secret on every POST. It is 256 random bits in `~/.claude-peers.db.secret` (0600), created on the broker's first start and read by the MCP server, hook and CLI;
- hands each peer a credential at `/register` and requires it on every route that acts as that peer (send, poll, peek, ack, heartbeat, set-summary, unregister, and the `/watch` upgrade), so a caller can only send as, or read the mail of, the peer it registered;
- never returns desktop session tokens from `/list-peers`.

The DB, secret and debug log are owner-only. Processes running as your own user can still read those files, so this keeps out browsers and other users, not your own processes.

After upgrading, restart the broker (`bun cli.ts kill-broker`) and every session's MCP server together: an older server has no secret and is refused. Re-run `bun cli.ts install-hooks` to pick up the unread-mail nudge.

### Wake feed for sessions without channel push

Claude Desktop / Cowork ignore `claude/channel` notifications, so the broker also exposes a WebSocket wake feed:

```
ws://127.0.0.1:7899/watch/<peer-id>
```

The upgrade needs the install secret (`Authorization: Bearer …`) and that peer's credential, like any other route that acts as the peer. Each inbound message produces one `{"type":"wake"}` frame with no content; nothing is acked, so the session reads the message itself with `check_messages`.

`bun cli.ts watch <peer-id>` connects with those credentials (read from the secret file, never argv) and prints one line per wake, so a session can arm it as a `Monitor` command. `send_message` responses carry `woke: N` — how many watchers received the frame — so a sender can tell whether the target was listening or will only see the message on its next tool call.

Limits: the feed is on the broker host's loopback, so **cloud Cowork sandboxes (`pwd` = `/home/claude`) cannot reach it** — they stay pull-based (next tool call / `check_messages`). Upgrades carrying an `Origin` header are refused so browser pages cannot subscribe.

### Wake relay for cloud Cowork sessions (opt-in)

Cloud Cowork sandboxes can't reach the loopback feed above. While a desktop identity's wake mode is **active**, it gets a private topic on an ntfy relay (`CLAUDE_PEERS_WAKE_RELAY`, default `https://ntfy.sh`; `https://…`, or `http://` on 127.0.0.1/localhost), and a send to it POSTs the literal body `wake` there, never message content. `claim_session` and `list_peers` print a `Monitor` call that streams the topic and prints only the word `wake` (each event once, at most once per 8 s), so text published by anyone holding the topic never reaches the agent. The agent then calls `check_messages`. `CLAUDE_PEERS_WAKE_RELAY=off` disables the relay entirely.

#### Wake mode: active or passive

The `Monitor` expires every 30 minutes, and re-arming it costs the agent a turn even when nothing arrived. So waking is a switch:

- **passive** (the default): no topics are published to and no `Monitor` is suggested. Mail arrives on the agent's next claude-peers call. No idle cost.
- **active**: agents are told to arm the `Monitor` and are woken within seconds, at one turn per agent per 30 minutes while idle.

```bash
bun cli.ts desktop-wake                    # show the global mode and each agent's
bun cli.ts desktop-wake active             # all Desktop agents
bun cli.ts desktop-wake passive --all      # all agents, clearing their own settings
bun cli.ts desktop-wake active <agent>     # one agent, by id or a unique part of its summary
bun cli.ts desktop-wake default <agent>    # that agent follows the global mode again
```

`/desktop-wake …` runs the same command from Claude Code in any project; `bun cli.ts install-hooks` installs it. An agent can also switch itself: ask it to "stay awake" or "go quiet" and it calls the `set_wake` tool. Turning its own wake on starts publishing to the relay for that agent's topic, so the relay sees when that agent gets mail (never the content). An agent's own setting wins over the global one. The mode is stored in the broker's database, so it survives restarts.

Running agents pick up a switch within one heartbeat (15 s), on their next claude-peers call. Switching to passive also publishes `off` to the topic, which ends a running `Monitor` with a constant line telling the agent not to re-arm it. A broker started with `CLAUDE_PEERS_WAKE_RELAY` set and no stored mode starts active, as before.

### CLI session identity

A CLI peer is keyed on Claude Code's own session id, which the MCP server reads
from `CLAUDE_CODE_SESSION_ID` in its environment. That id is stable across
`claude --resume <id>` and across a crash and restart, so a session that goes away and
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

The environment variable is read once, when the MCP server spawns. If you start
`claude` and then `/resume` a conversation inside it, the server is still keyed
on the launch session and would get a new id. A `SessionStart` hook fixes that:
it sees the live session id and reports it to the broker, which hands the
conversation its original id back (mail included) within one heartbeat. Install
it once, and again after moving the repo:

```bash
bun cli.ts install-hooks   # adds the hooks to ~/.claude/settings.json and /desktop-wake to ~/.claude/commands; safe to re-run
```

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
bun cli.ts watch <id>        # print a line per inbound message (for Monitor)
bun cli.ts install-hooks     # register the SessionStart identity hook
bun cli.ts kill-broker       # stop the broker
bun cli.ts desktop-wake      # show or switch Desktop agents' wake mode (see above)
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
