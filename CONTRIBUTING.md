# Contributing

Thanks for helping. Bug reports, fixes and focused features are welcome.

## Setup

You need [Bun](https://bun.sh) 1.4 or later (CI runs 1.4.4).

```bash
git clone https://github.com/DeanSingh/chief-of-staff-mcp.git
cd chief-of-staff-mcp
bun install
```

## Before you open a pull request

```bash
bun test           # unit and end-to-end tests
bun run lint       # Biome lint and format check
bun run typecheck  # tsc --noEmit
bun run format     # apply Biome formatting
```

CI runs the first three on Linux and macOS, and all must pass.

- **Every behavior change comes with a test that fails without it.**
  Tests live in `test/`; broker tests are in `test/broker/`, one file per
  area, and start their broker with `useBroker()` from its harness. The
  end-to-end tests start a real broker and MCP servers on a private port and
  database, so they never touch your own.
- **Keep the wire identity.** The MCP server key `claude-peers`, port `7899`,
  `~/.claude-peers.db` and the `CLAUDE_PEERS_*` variables are shared with
  existing installs. See CLAUDE.md before changing any of them.
- **Keep the root entry files where they are.** `broker.ts`, `server.ts`,
  `cli.ts` and `hook.ts` are referenced by path from installed configs and
  hooks. New code goes in `src/`. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- **Keep functions small.** Biome's cognitive-complexity rule is an error
  for `src/`.
- **Update the docs in the same pull request.** A change users can see gets
  an entry under `## Unreleased` in [CHANGELOG.md](CHANGELOG.md), ending
  with the PR number, and README.md or docs/ARCHITECTURE.md say what now
  happens.
- **Commit messages** follow `type(scope): what now happens`, for example
  `fix(server): a lost list_changed is sent again until the client re-lists`.
  The body says why.
- One concern per pull request, with a description of what changed and why.

## Design rules

- **Regular agents carry nothing new.** A feature for the chief of staff or
  for you must not add tools or text to every other agent's context. Capture
  what you need with hooks; the coordinator tools appear only in the session
  that holds the role.
- **Records hold fixed text.** What hooks write to the broker is fixed text
  ("waiting for input"), never an agent's or a notification's own words,
  which can carry private details.

## Merging

Pull requests are merged with a merge commit, not squashed or rebased:
`.git-blame-ignore-revs` refers to commits by hash.

## Security issues

Please report vulnerabilities privately as described in
[SECURITY.md](SECURITY.md), not in an issue or pull request.
