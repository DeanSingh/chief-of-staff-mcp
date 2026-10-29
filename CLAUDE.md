---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

# chief-of-staff-mcp

A chief-of-staff layer for Claude Code agents, built on a peer discovery and messaging MCP channel.

Forked from [louislva/claude-peers-mcp](https://github.com/louislva/claude-peers-mcp) (MIT) at `fc26491`.

## Naming: project vs. wire identity

The *project* is `chief-of-staff-mcp`. The *wire identity* is still `claude-peers`, deliberately:

| Thing | Value | Why |
| --- | --- | --- |
| MCP server key | `claude-peers` | It is the tool-name prefix (`mcp__claude-peers__*`); renaming breaks every config and running session |
| Broker port | `7899` | Shared with upstream installs, which preserves interop |
| SQLite path | `~/.claude-peers.db` | Renaming orphans existing peer state |
| Env vars | `CLAUDE_PEERS_*` | Consistent with the above |

Do not rename these casually. If they ever change, it must be one deliberate commit that also
updates `.mcp.json`, every `CLAUDE.md` reference, and provides a migration path for the DB.

## Architecture

- `broker.ts` — Singleton HTTP daemon on localhost:7899 + SQLite. Auto-launched by the MCP server.
  Peer identity is durable for CLI peers: `peer_sessions` maps
  `CLAUDE_CODE_SESSION_ID` to a peer id, so a restarted CLI session reclaims
  its id and mail sent to it *before* it died is still delivered. Desktop
  still reclaims via `desktop_tokens`, unchanged by this; Desktop does get a
  `peer_sessions` row too, but it's a mirror nothing reads yet. That
  guarantee doesn't cover mail sent *while* it's down:
  `handleSendMessage` refuses any send whose `to_id` has no `peers` row, and
  `cleanStalePeers` deletes that row ~30s after the process dies, so a dead
  peer can't be sent to at all until it re-registers. Undelivered mail is
  never deleted on reap; the pre-existing 72h TTL is the only bound.
- `server.ts` — MCP stdio server, one per Claude Code instance. Connects to broker, exposes tools, pushes channel notifications.
- `shared/auth.ts` — Broker access control. Every POST carries the install secret
  (`<db>.secret`, 0600, created by the broker); routes that act as a peer also carry
  that peer's credential from `/register`. The broker also refuses browser-shaped
  requests (any `Origin`, a foreign `Host`, non-JSON bodies). See README "Access control".
- `hook.ts` — Claude Code hook: SessionStart re-keys a resumed session's identity;
  UserPromptSubmit prints the unread-mail nudge. Installed by `bun cli.ts install-hooks`.
- `shared/types.ts` — Shared TypeScript types for broker API.
- `shared/summarize.ts` — Auto-summary generation via gpt-5.4-nano.
- `cli.ts` — CLI utility for inspecting broker state.

## Running

```bash
# Start Claude Code with the channel:
claude --dangerously-load-development-channels server:claude-peers

# Or just add to .mcp.json and use as regular MCP (no channel push, but tools work):
# { "claude-peers": { "command": "bun", "args": ["./server.ts"] } }

# CLI:
bun cli.ts status
bun cli.ts peers
bun cli.ts send <peer-id> <message>
bun cli.ts kill-broker
```

## Bun

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
