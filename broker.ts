#!/usr/bin/env bun
/**
 * claude-peers broker daemon
 *
 * A singleton HTTP server on localhost:7899 backed by SQLite.
 * Tracks all registered Claude Code peers and routes messages between them.
 *
 * Auto-launched by the MCP server if not already running.
 * Run directly: bun broker.ts
 *
 * The code lives in src/broker/; this file stays at the repo root because
 * the MCP server launches it by this path.
 */

import { DB_PATH, PORT } from "./src/broker/config.ts";
import { db } from "./src/broker/db.ts";
import { startServer } from "./src/broker/http.ts";
import { cleanStalePeers } from "./src/broker/liveness.ts";

cleanStalePeers();

// Reclaim disk space after initial cleanup
db.run("VACUUM");

// Periodically clean stale peers (every 30s)
setInterval(cleanStalePeers, 30_000);

startServer();
console.error(`[claude-peers broker] listening on 127.0.0.1:${PORT} (db: ${DB_PATH})`);
