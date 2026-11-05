/**
 * Runs the stale-peer sweep while another connection holds an old snapshot,
 * then again after it lets go, and prints the timings and WAL sizes as JSON.
 * Spawned by coordination.test.ts with CLAUDE_PEERS_DB set to a scratch path.
 */

import { Database } from "bun:sqlite";
import { db } from "../../src/broker/db.ts";
import { cleanStalePeers } from "../../src/broker/liveness.ts";

const path = process.env.CLAUDE_PEERS_DB!;
const walSize = () => Bun.file(`${path}-wal`).size;

db.run("INSERT INTO messages (from_id, to_id, text, sent_at, delivered) VALUES ('a', 'b', 'x', ?, 1)", [
  new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
]);

const reader = new Database(path, { readonly: true });
reader.run("BEGIN");
reader.query("SELECT count(*) FROM messages").get();

const start = performance.now();
cleanStalePeers();
const busyMs = performance.now() - start;
const walAfterBusy = walSize();

reader.run("COMMIT");
reader.close();

cleanStalePeers(); // changes nothing: only the owed checkpoint runs
console.log(JSON.stringify({ busyMs, walAfterBusy, walAfterRetry: walSize() }));
