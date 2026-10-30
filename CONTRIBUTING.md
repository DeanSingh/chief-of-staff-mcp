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
  Tests live in `test/`. The end-to-end tests start a real broker and MCP
  servers on a private port and database, so they never touch your own.
- **Keep the wire identity.** The MCP server key `claude-peers`, port `7899`,
  `~/.claude-peers.db` and the `CLAUDE_PEERS_*` variables are shared with
  existing installs. See CLAUDE.md before changing any of them.
- **Keep the root entry files where they are.** `broker.ts`, `server.ts`,
  `cli.ts` and `hook.ts` are referenced by path from installed configs and
  hooks. New code goes in `src/`. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- **Keep functions small.** Biome's cognitive-complexity rule is an error
  for `src/`.
- One concern per pull request, with a description of what changed and why.

## Merging

Pull requests are merged with a merge commit, not squashed or rebased:
`.git-blame-ignore-revs` refers to commits by hash.

## Security issues

Please report vulnerabilities privately as described in
[SECURITY.md](SECURITY.md), not in an issue or pull request.
