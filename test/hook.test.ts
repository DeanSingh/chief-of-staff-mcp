import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { DESKTOP_WAKE_MARK, desktopWakeCommand, hookCommand, isOurDesktopWakeCommand } from "../src/cli/install.ts";
import { hostPid } from "../src/hook.ts";
import { ensureSecret, secretPath } from "../src/shared/auth.ts";

/** The repo root, where the entry files live. */
const ROOT = dirname(import.meta.dir);

const HOOK = `${ROOT}/hook.ts`;

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
afterAll(() => {
  stub.stop(true);
  rmSync(DIR, { recursive: true, force: true });
});

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
        child =
          parseInt(new TextDecoder().decode(Bun.spawnSync(["pgrep", "-P", String(sh.pid)]).stdout).trim(), 10) || 0;
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
    const r = await runHook(
      { hook_event_name: "SessionStart", session_id: "s-nohost", source: "startup" },
      stub.port,
      "no-such-process-name",
    );
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

  test("ignores events it doesn't handle", async () => {
    const before = hits.length;
    const r = await runHook({ hook_event_name: "PreToolUse", session_id: "s-pre", tool_name: "Bash" }, stub.port);
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
    const r = await runHook(
      { hook_event_name: "SessionStart", session_id: "s-nosecret", source: "startup" },
      stub.port,
      "bun",
      join(DIR, "none.db"),
    );
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

  const frontmatter = (file: string) => Bun.YAML.parse(file.split("---\n")[1]!) as Record<string, string>;

  test("desktopWakeCommand's frontmatter holds exactly its three keys for any repo path", () => {
    for (const dir of ["/tmp/a b", "/tmp/it's", '/tmp/q"uote', "/tmp/x: y", "/tmp/#hash", "/tmp/$HOME"]) {
      const fm = frontmatter(desktopWakeCommand(dir)!);
      expect(Object.keys(fm).sort()).toEqual(["allowed-tools", "argument-hint", "description"]);
      const run = `bun '${`${dir}/cli.ts`.replace(/'/g, `'\\''`)}' desktop-wake`;
      expect(fm["allowed-tools"]).toBe(`Bash(${run}:*)`);
    }
  });

  // ")" would close Bash(...) early and allow whatever follows it.
  test("desktopWakeCommand leaves out allowed-tools when the path has a )", () => {
    const fm = frontmatter(desktopWakeCommand("/tmp/x) Bash(rm")!);
    expect(Object.keys(fm).sort()).toEqual(["argument-hint", "description"]);
  });

  // The path is quoted into the Markdown body, where these would garble it.
  test("desktopWakeCommand refuses a path with a line break or backtick", () => {
    for (const dir of ["/tmp/a\nevil: true", "/tmp/a\rb", "/tmp/a`b"]) expect(desktopWakeCommand(dir)).toBeNull();
  });

  test("only a file carrying the exact marker line counts as ours", () => {
    expect(isOurDesktopWakeCommand(desktopWakeCommand("/tmp/repo")!)).toBe(true);
    expect(isOurDesktopWakeCommand("my notes # claude-peers")).toBe(false);
    expect(isOurDesktopWakeCommand(`see ${DESKTOP_WAKE_MARK} for details`)).toBe(false);
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

  describe("decision queue", () => {
    const since = (n: number) => hits.slice(n);

    test("agent_needs_input raises one hook request for the session, with no host walk", async () => {
      const n = hits.length;
      const r = await runHook(
        {
          hook_event_name: "Notification",
          session_id: "s-blocked",
          notification_type: "agent_needs_input",
          message: "Claude is waiting for your input",
        },
        stub.port,
        "no-such-process-name",
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("");
      expect(since(n).map((h) => h.path)).toEqual(["/request-input"]);
      expect(since(n)[0]!.body).toEqual({
        session_key: "s-blocked",
        question: "Claude is waiting for your input",
        waiting_for: "input needed",
        source: "hook",
      });
      expect(since(n)[0]!.auth).toBe(`Bearer ${SECRET}`);
    });

    test("permission_prompt is a warning event, never a request", async () => {
      const n = hits.length;
      await runHook(
        {
          hook_event_name: "Notification",
          session_id: "s-perm",
          notification_type: "permission_prompt",
          message: "Claude needs your permission to use Bash",
        },
        stub.port,
      );
      expect(since(n).map((h) => h.path)).toEqual(["/report-event"]);
      expect(since(n)[0]!.body).toEqual({
        session_key: "s-perm",
        level: "warning",
        logger: "notification",
        message: "Claude needs your permission to use Bash",
        source: "hook",
      });
    });

    test("any other notification is a debug event naming its type, with no text and no data", async () => {
      for (const [type, expected] of [
        ["auth_success", "notification: auth_success"],
        [undefined, "notification: unknown"],
      ] as const) {
        const n = hits.length;
        await runHook(
          { hook_event_name: "Notification", session_id: "s-other", notification_type: type, message: "private text" },
          stub.port,
        );
        expect(since(n).map((h) => h.path)).toEqual(["/report-event"]);
        expect(since(n)[0]!.body).toEqual({
          session_key: "s-other",
          level: "debug",
          logger: "notification",
          message: expected,
          source: "hook",
        });
      }
    });

    test("Stop reports a turn ended, without the assistant's last message", async () => {
      const n = hits.length;
      const r = await runHook(
        { hook_event_name: "Stop", session_id: "s-stop", stop_hook_active: false, last_assistant_message: "secret" },
        stub.port,
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("");
      expect(since(n).map((h) => h.path)).toEqual(["/report-event"]);
      expect(since(n)[0]!.body).toEqual({
        session_key: "s-stop",
        level: "info",
        logger: "stop",
        message: "turn ended",
        source: "hook",
      });
      expect(JSON.stringify(since(n))).not.toContain("secret");
    });

    test("UserPromptSubmit closes the session's requests and checks unread mail", async () => {
      unread = 0;
      const n = hits.length;
      await runHook({ hook_event_name: "UserPromptSubmit", session_id: "s-reply", prompt: "go ahead" }, stub.port);
      const got = since(n);
      expect(got.map((h) => h.path).sort()).toEqual(["/close-requests", "/unread"]);
      expect(got.find((h) => h.path === "/close-requests")!.body).toEqual({ session_key: "s-reply" });
    });

    // A channel push or a background task's report reaches the session as a
    // prompt too (verified on Claude Code 2.1.325: the hook's prompt is the
    // <channel …> block). Only the human typing answers a request.
    test("UserPromptSubmit from a peer message or task report keeps requests open, and still checks mail", async () => {
      for (const prompt of [
        '<channel source="claude-peers" from_id="abc" from_summary="" from_cwd="" sent_at="x">\nhi\n</channel>',
        "<task-notification>\n<task-id>t1</task-id>\n</task-notification>",
      ]) {
        const n = hits.length;
        const r = await runHook({ hook_event_name: "UserPromptSubmit", session_id: "s-machine", prompt }, stub.port);
        expect(r.exitCode).toBe(0);
        expect(since(n).map((h) => h.path)).toEqual(["/unread"]);
      }
    });

    test("a typed prompt that merely mentions a channel tag still closes requests", async () => {
      const n = hits.length;
      await runHook(
        { hook_event_name: "UserPromptSubmit", session_id: "s-typed", prompt: "why did <channel source=x> fire?" },
        stub.port,
      );
      expect(
        since(n)
          .map((h) => h.path)
          .sort(),
      ).toEqual(["/close-requests", "/unread"]);
    });

    test("UserPromptSubmit with no host process still closes requests", async () => {
      const n = hits.length;
      await runHook(
        { hook_event_name: "UserPromptSubmit", session_id: "s-nohost-reply", prompt: "x" },
        stub.port,
        "no-such-process-name",
      );
      expect(since(n).map((h) => h.path)).toEqual(["/close-requests"]);
    });

    test("no session_id: nothing is posted for the queue", async () => {
      const n = hits.length;
      for (const hook_event_name of ["Notification", "Stop"]) {
        await runHook({ hook_event_name, notification_type: "agent_needs_input", message: "m" }, stub.port);
      }
      expect(since(n)).toHaveLength(0);
    });

    test("no secret: no hits, exit 0", async () => {
      const n = hits.length;
      for (const input of [
        { hook_event_name: "Notification", session_id: "s-ns", notification_type: "agent_needs_input", message: "m" },
        { hook_event_name: "Stop", session_id: "s-ns" },
        { hook_event_name: "UserPromptSubmit", session_id: "s-ns", prompt: "x" },
      ]) {
        const r = await runHook(input, stub.port, "bun", join(DIR, "none.db"));
        expect(r.exitCode).toBe(0);
      }
      expect(since(n)).toHaveLength(0);
    });

    test("broker down: every queue event exits 0 within 1s", async () => {
      const tmp = Bun.serve({ port: 0, fetch: () => new Response() });
      const closed = tmp.port;
      tmp.stop(true);
      for (const input of [
        { hook_event_name: "Notification", session_id: "s-d", notification_type: "agent_needs_input", message: "m" },
        { hook_event_name: "Stop", session_id: "s-d" },
        { hook_event_name: "UserPromptSubmit", session_id: "s-d", prompt: "x" },
      ]) {
        const r = await runHook(input, closed);
        expect(r.exitCode).toBe(0);
        expect(r.elapsed).toBeLessThan(1000);
        expect(r.stdout).toBe("");
      }
    });
  });
});
