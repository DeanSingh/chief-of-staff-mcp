# Changelog

Notable changes. There are no tagged releases yet; `main` is the release.

## Unreleased

### Changed

- The `Stop` hook's "turn ended" event is `debug`, not `info`, so the
  default digest leaves it out (#24).
- The wake copy tells Desktop agents to keep the Monitor running silently:
  no reports that it fired, expired or was re-armed, or that a check found
  nothing (#23).
- The wake copy states the session's mode and how it is set (`/desktop-wake`,
  `set_wake`, or the broker's default), on claim, on `list_peers`, and when
  a switch either way reaches a running session (#19).
- No function in `src/` is over the complexity limit: the broker's routes
  and the server's tools dispatch from tables, and registration reads as
  its precedence order. Broker tests are split by area (#17).
- Code moved into `src/` and tests into `test/`; the root entry files stay
  for existing installs (#13).
- Stricter typecheck, pinned dev tooling, and a cognitive-complexity limit
  (#13).
- Biome lint and formatting, and CI on Linux and macOS (#12).

### Added

- `/claim-cos` and `/release-cos`: type one in a CLI session to make it the
  chief of staff, or give the role up. The hook carries it out and blocks the
  prompt, only when the session has a terminal, so an agent can't run it
  through `claude -p`, and the model can't invoke either command.
  `install-hooks` installs both (#27).
- The chief of staff: `bun cli.ts cos` names one peer, and only it can
  answer or escalate requests and read or acknowledge the digest as a peer;
  the broker checks the role on every call. Its server offers it
  `get_digest`, `answer_request`, `escalate_request` and `ack_digest`; every
  other session's tools are unchanged (#25).
- Hook capture for the decision queue: `install-hooks` also registers
  `Notification`, `Stop` and `SessionEnd`. A blocked agent raises one input
  request per session, a permission prompt is a warning event, and typing in
  the session or ending it closes its open requests (a peer message or task
  report does not). No agent text from `Stop` is recorded (#22).
- `bun cli.ts digest`: the decision queue from the terminal, with
  `--since`, `--limit`, `--level` and `--json`. It never moves a cursor, and
  strips control characters from agent text (#22).
- Decision queue in the broker: `events`, input requests with answer
  delivery, and a digest with an acknowledged cursor (#20).
- Desktop wake mode: active or passive, globally or per agent, with
  `bun cli.ts desktop-wake`, `/desktop-wake` and the `set_wake` tool. Passive
  is the default (#10).
- Durable CLI peer identity across restarts and `/resume` (#1).
- Content-free wake relay for cloud Cowork sessions (#2).

### Fixed

- The chief of staff's tools now appear in its running session. The server
  declares `tools.listChanged`, without which Claude Code ignored the
  re-list notice, and a session restarted with `claude --continue`, which
  takes its named id only after startup, is now told too (#26).
- `bun cli.ts watch` exits with the broker's reason when its credentials
  are refused (#12).
- A reaped peer re-registers on its next heartbeat (#9, #5).
- Each peer has its own message cursor and unread preview, so a session no
  longer misses mail or sees another session's (#8, #6).
- A returning peer gets its own summary back, not the repo's latest (#4).

### Security

- `/watch` requires the install secret and the watched peer's credential,
  and its frames carry no message content (#7).
- The broker refuses browser-shaped requests and requires an install secret
  and per-peer credentials (#3).
- If you run an older checkout, pull, then restart the broker
  (`bun cli.ts kill-broker`) and your sessions so every part runs the fixed
  code.
