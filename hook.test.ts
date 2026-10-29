import { test, expect, describe, afterAll } from "bun:test";
import { ancestorPids } from "./hook.ts";

const HOOK = `${import.meta.dir}/hook.ts`;

// Captures what the hook posts. Stands in for the broker.
const hits: Array<{ path: string; body: any }> = [];
const stub = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    hits.push({ path: new URL(req.url).pathname, body: await req.json() });
    return Response.json({ ok: true, peer_id: "x", action: "noop" });
  },
});
afterAll(() => stub.stop(true));

async function runHook(input: unknown, port: number) {
  const started = performance.now();
  const proc = Bun.spawn(["bun", HOOK], {
    stdin: new Blob([JSON.stringify(input)]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CLAUDE_PEERS_PORT: String(port) },
  });
  const exitCode = await proc.exited;
  return { exitCode, elapsed: performance.now() - started, stdout: await new Response(proc.stdout).text() };
}

describe("hook.ts", () => {
  test("ancestorPids starts at the given pid and includes this test's parent", () => {
    const chain = ancestorPids(process.pid);
    expect(chain[0]).toBe(process.pid);
    expect(chain).toContain(process.ppid);
  });

  test("exits 0 within 1s when the broker is unreachable", async () => {
    // Bind then release a port so nothing is listening on it.
    const tmp = Bun.serve({ port: 0, fetch: () => new Response() });
    const closed = tmp.port;
    tmp.stop(true);
    const r = await runHook({ hook_event_name: "SessionStart", session_id: "s-down", source: "startup" }, closed);
    expect(r.exitCode).toBe(0);
    expect(r.elapsed).toBeLessThan(1000);
    expect(r.stdout).toBe("");
  });

  test("ignores non-SessionStart events", async () => {
    const before = hits.length;
    const r = await runHook({ hook_event_name: "Stop", session_id: "s-stop" }, stub.port);
    expect(r.exitCode).toBe(0);
    expect(hits.length).toBe(before);
  });

  test("posts session_id, source and ancestor pids", async () => {
    const r = await runHook({ hook_event_name: "SessionStart", session_id: "s-1", source: "resume" }, stub.port);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    const hit = hits.find((h) => h.body?.session_key === "s-1");
    expect(hit?.path).toBe("/session-start");
    expect(hit?.body.source).toBe("resume");
    // The hook was spawned directly by this test process, so its nearest
    // ancestor is us.
    expect(hit?.body.pids[0]).toBe(process.pid);
  });
});
