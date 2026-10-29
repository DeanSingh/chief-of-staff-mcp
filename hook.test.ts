import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostPid, hookCommand } from "./hook.ts";
import { ensureSecret, secretPath } from "./shared/auth.ts";

const HOOK = `${import.meta.dir}/hook.ts`;

// Captures what the hook posts. Stands in for the broker.
const hits: Array<{ path: string; body: any; auth: string | null }> = [];
let unread = 0;
const stub = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const path = new URL(req.url).pathname;
    hits.push({ path, body: await req.json(), auth: req.headers.get("authorization") });
    if (path === "/unread") return Response.json({ count: unread });
    return Response.json({ ok: true, peer_id: "x", action: "noop" });
  },
});
const DIR = mkdtempSync(join(tmpdir(), "cp-hook-"));
const DB = join(DIR, "peers.db");
const SECRET = ensureSecret(secretPath(DB));
afterAll(() => { stub.stop(true); rmSync(DIR, { recursive: true, force: true }); });

async function runHook(input: unknown, port: number | undefined, hostComm = "bun", db = DB) {
  const started = performance.now();
  const proc = Bun.spawn(["bun", HOOK], {
    stdin: new Blob([JSON.stringify(input)]),
    stdout: "pipe",
    stderr: "pipe",
    // The hook looks for its host by process name. Under test the host is this
    // bun process, not a claude.
    env: { ...process.env, CLAUDE_PEERS_PORT: String(port), CLAUDE_PEERS_HOST_COMM: hostComm, CLAUDE_PEERS_DB: db },
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
    expect(hit?.auth).toBe(`Bearer ${SECRET}`);
  });

  test("no broker secret yet: no request", async () => {
    const before = hits.length;
    const r = await runHook({ hook_event_name: "SessionStart", session_id: "s-nosecret", source: "startup" }, stub.port, "bun", join(DIR, "none.db"));
    expect(r.exitCode).toBe(0);
    expect(hits.length).toBe(before);
  });

  test("hookCommand survives any repo path in the shell", () => {
    for (const dir of [`/tmp/a b`, `/tmp/it's`, `/tmp/q"uote`, "/tmp/$(touch pwned)", "/tmp/`id`", "/tmp/$HOME"]) {
      const cmd = hookCommand(dir);
      expect(cmd.startsWith("bun ")).toBe(true);
      expect(cmd.endsWith(" # claude-peers")).toBe(true);
      // The shell must hand bun exactly one argument: the literal script path.
      const out = Bun.spawnSync(["sh", "-c", `printf '%s\\n' ${cmd.slice(4)}`]).stdout;
      expect(new TextDecoder().decode(out)).toBe(`${dir}/hook.ts\n`);
    }
  });

  test("UserPromptSubmit nudges when this session's peer has unread mail", async () => {
    unread = 2;
    const r = await runHook({ hook_event_name: "UserPromptSubmit", session_id: "s-ups", prompt: "hi" }, stub.port);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("You have 2 unread peer message(s). Call check_messages now to read them.");
    const hit = hits.findLast((h) => h.path === "/unread");
    expect(hit?.body).toEqual({ pid: process.pid });
    expect(hit?.auth).toBe(`Bearer ${SECRET}`);
  });

  test("UserPromptSubmit prints nothing when there is no mail", async () => {
    unread = 0;
    const r = await runHook({ hook_event_name: "UserPromptSubmit", session_id: "s-ups0", prompt: "hi" }, stub.port);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });
});
