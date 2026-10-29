import { test, expect, describe, afterAll } from "bun:test";
import { hostPid } from "./hook.ts";

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

async function runHook(input: unknown, port: number | undefined, hostComm = "bun") {
  const started = performance.now();
  const proc = Bun.spawn(["bun", HOOK], {
    stdin: new Blob([JSON.stringify(input)]),
    stdout: "pipe",
    stderr: "pipe",
    // The hook looks for its host by process name. Under test the host is this
    // bun process, not a claude.
    env: { ...process.env, CLAUDE_PEERS_PORT: String(port), CLAUDE_PEERS_HOST_COMM: hostComm },
  });
  const exitCode = await proc.exited;
  return { exitCode, elapsed: performance.now() - started, stdout: await new Response(proc.stdout).text() };
}

describe("hook.ts", () => {
  test("hostPid returns the nearest ancestor with the host's name, or null", async () => {
    const sh = Bun.spawn(["sh", "-c", "sleep 30; true"]);
    try {
      let child = 0;
      for (let i = 0; i < 50 && !child; i++) {
        child = parseInt(new TextDecoder().decode(Bun.spawnSync(["pgrep", "-P", String(sh.pid)]).stdout).trim(), 10) || 0;
        if (!child) await Bun.sleep(20);
      }
      expect(hostPid(child, "sh")).toBe(sh.pid);
      expect(hostPid(child, "no-such-process-name")).toBeNull();
    } finally {
      sh.kill();
    }
  });

  test("no host process: no request", async () => {
    const before = hits.length;
    const r = await runHook({ hook_event_name: "SessionStart", session_id: "s-nohost", source: "startup" }, stub.port, "no-such-process-name");
    expect(r.exitCode).toBe(0);
    expect(hits.length).toBe(before);
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
    // The hook was spawned directly by this test process, so its host is us.
    expect(hit?.body.pid).toBe(process.pid);
  });
});
