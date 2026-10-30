# Architecture

chief-of-staff-mcp is three kinds of process on one machine. The README
covers setup and behavior in detail. This page is the map.

```
 Claude Code session ─stdio─ MCP server ─┐
 Claude Code session ─stdio─ MCP server ─┼─HTTP─ broker (127.0.0.1:7899) ── SQLite
 Claude Desktop      ─stdio─ MCP server ─┘          │
                                                    └─HTTPS─ wake relay (opt-in)
```

## Broker

One per machine, launched by the first MCP server that finds it down
(`broker.ts`, code in `src/broker/`). It owns all state: peers, queued
messages, the session_key → peer id mapping, summaries and wake settings, in
`~/.claude-peers.db`.

| Module | Responsibility |
| --- | --- |
| `config` | Port, database path and wake relay from the environment |
| `db` | Opens the database owner-only, applies schema and migrations, prepares statements |
| `identity` | `/register` and `/session-start`: which peer id a caller gets back |
| `liveness` | Pid checks and the stale-peer sweep (every 30 s) |
| `peers` | Heartbeat, summaries, listing, unread count, unregister |
| `messages` | Send, poll, peek, ack, and the `/watch` WebSocket wake feed |
| `wake` | Active/passive wake mode and publishing to the relay |
| `http` | The request gate and the route table |

## MCP server

One per Claude Code session, spawned over stdio (`server.ts`, code in
`src/server/`). It registers its peer with the broker, exposes the tools
(`list_peers`, `send_message`, `check_messages`, `set_summary`, and for
Desktop `claim_session` and `set_wake`), polls for mail every second and
pushes it into the session as a `claude/channel` notification. It also
appends unread mail to tool results.

One Desktop server serves every Desktop/Cowork session, so each session
claims a `peer_session` token and passes it on every call. The broker keys
that peer on the token.

The server's mutable state is in one place, `src/server/state.ts`: the CLI
host peer's id, cwd, git root and last summary (`state`), and the Desktop
sessions it serves (`desktopPeers`). Registration, the heartbeat, tool
handlers and the poll loop all read and update it. Per-peer delivery state
(poll cursors, unread previews) lives in `src/server/delivery.ts`.

## Hook and CLI

`hook.ts` runs as Claude Code's SessionStart and UserPromptSubmit hook. It
re-keys a resumed session to its original peer id and prints an unread-mail
nudge. `cli.ts` inspects the broker, sends as the operator, runs the
`/watch` feed for a Monitor, switches wake mode and installs the hooks.

## Access control

Loopback is not a boundary against the browser, so the broker refuses any
request with an `Origin` header, a foreign `Host`, or a non-JSON body. Every
POST carries the install secret (`<db>.secret`, 0600). Routes that act as a
peer also carry that peer's credential, an HMAC of its id under the secret,
returned by `/register`. The logic is in `src/shared/auth.ts` and the gate in
`src/broker/http.ts`. Processes running as the same user can read the
secret; the model keeps out browsers and other users.

## Waking a session

- **CLI sessions** get mail pushed by their MCP server within a second.
- **Local Desktop sessions** can run `bun cli.ts watch <id>` as a Monitor.
  It prints one line per `{"type":"wake"}` frame and never message content.
- **Cloud Cowork sessions** can't reach loopback. When a session's wake mode
  is active, the broker POSTs the word `wake` to a secret ntfy topic for that
  session, and the session's Monitor streams it. Passive mode, the default,
  publishes nothing and costs nothing while idle.
