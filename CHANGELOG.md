# Changelog

Notable changes. There are no tagged releases yet; `main` is the release.

## Unreleased

### Changed

- No function in `src/` is over the complexity limit: the broker's routes
  and the server's tools dispatch from tables, and registration reads as
  its precedence order. Broker tests are split by area (#PR).
- Code moved into `src/` and tests into `test/`; the root entry files stay
  for existing installs (#13).
- Stricter typecheck, pinned dev tooling, and a cognitive-complexity limit
  (#13).
- Biome lint and formatting, and CI on Linux and macOS (#12).

### Added

- Desktop wake mode: active or passive, globally or per agent, with
  `bun cli.ts desktop-wake`, `/desktop-wake` and the `set_wake` tool. Passive
  is the default (#10).
- Durable CLI peer identity across restarts and `/resume` (#1).
- Content-free wake relay for cloud Cowork sessions (#2).

### Fixed

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
