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
messages, the session_key → peer id mapping, summaries, wake settings, events and input requests (the decision queue), in
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
| `events` | `/report-event`, and the subject resolution the decision-queue routes share |
| `requests` | Input requests: ask, escalate, answer (delivered as mail), close |
| `digest` | `/get-digest` and the acknowledged cursor `/ack-digest` |
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
`/watch` feed for a Monitor, switches wake mode, names the chief of staff
and installs the hooks.

## Access control

Loopback is not a boundary against the browser, so the broker refuses any
request with an `Origin` header, a foreign `Host`, or a non-JSON body. Every
POST carries the install secret (`<db>.secret`, 0600). Routes that act as a
peer also carry that peer's credential, an HMAC of its id under the secret,
returned by `/register`. The logic is in `src/shared/auth.ts` and the gate in
`src/broker/http.ts`. Processes running as the same user can read the
secret; the model keeps out browsers and other users. Routes that take a
`session_key` instead of a peer id, `/close-requests`, and `/get-digest`
without a `peer_id` need only the install secret, so attribution by session
key is not authenticated.

### The chief of staff

One peer id holds the chief-of-staff role, stored in the broker's settings
(`src/broker/cos.ts`). Only `/set-cos`, which `bun cli.ts cos` calls, sets
it: registration, `/session-start` and the MCP tools never do. The gate in
`src/broker/http.ts` checks the role after the credential check, so
`/answer-request`, `/escalate-request`, `/ack-digest` and `/get-digest` with a
`peer_id` refuse any caller that isn't the chief of staff. Register and
heartbeat responses carry `cos: true` for it, and its MCP server then offers
the coordinator tools (`src/server/role.ts`, `src/server/coordination.ts`).
Hiding the tools is a convenience; the broker check is the control. A Desktop
server serves many sessions with one tool list, so all of them see the tools
when one holds the role.

Two residuals, both because agents run as the same user:

- Agents run shell commands, often without anyone approving each one (auto
  mode). So `bun cli.ts cos` names or clears only from a terminal (stdin and
  stdout are TTYs) and only after the peer's id is typed back. That stops a
  misled agent, for example one following a peer message. It doesn't stop a
  hostile one: anything running as this user can fake a terminal, or read
  the install secret and call `/set-cos` directly.
- `/session-start` takes the session key from its caller. The session key is
  readable to the same uid (it's in `~/.claude/projects` filenames), so once
  the chief of staff's process is gone, another process that sends its key
  re-keys onto its peer id and holds the role. While it is live, the broker
  refuses that as a conflict.

## Waking a session

- **CLI sessions** get mail pushed by their MCP server within a second.
- **Local Desktop sessions** can run `bun cli.ts watch <id>` as a Monitor.
  It prints one line per `{"type":"wake"}` frame and never message content.
- **Cloud Cowork sessions** can't reach loopback. When a session's wake mode
  is active, the broker POSTs the word `wake` to a secret ntfy topic for that
  session, and the session's Monitor streams it. Passive mode, the default,
  publishes nothing and costs nothing while idle.
