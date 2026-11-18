import { expect, test } from "bun:test";
import { freePort, removeDb, startBroker } from "./harness.ts";

test("freePort gives a port nothing listens on", () => {
  const port = freePort();
  const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response() });
  expect(server.port).toBe(port);
  server.stop(true);
});

test("a broker whose port another program holds fails at once, not at the test's timeout", async () => {
  // Like Chrome's DevTools on 9334: something answers there, but not as a broker.
  const other = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("", { status: 404 }) });
  const db = `${import.meta.dir}/.test-broker-taken-${other.port}.db`;
  const started = Date.now();
  try {
    const start = startBroker({ ...process.env, CLAUDE_PEERS_PORT: String(other.port), CLAUDE_PEERS_DB: db });
    await expect(start).rejects.toThrow("failed to bind");
    expect(Date.now() - started).toBeLessThan(4000);
  } finally {
    other.stop(true);
    await removeDb(db);
  }
});
