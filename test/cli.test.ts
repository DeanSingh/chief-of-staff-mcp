import { Database } from "bun:sqlite";
import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, rmSync, statSync, lstatSync, symlinkSync, readdirSync, readlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { ensureSecret, secretPath } from "../src/shared/auth.ts";
import { useBroker } from "./broker/harness.ts";

/** The repo root, where the entry files live. */
const ROOT = dirname(import.meta.dir);

const DIR = mkdtempSync(join(tmpdir(), "cp-install-hooks-"));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const OURS = `bun '${ROOT}/hook.ts' # claude-peers`;
let n = 0;

async function install(initial?: unknown) {
  const path = join(DIR, `settings-${n++}.json`);
  if (initial !== undefined) await Bun.write(path, JSON.stringify(initial));
  const proc = Bun.spawn(["bun", `${ROOT}/cli.ts`, "install-hooks", "--settings", path], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await proc.exited).toBe(0);
  return { path, read: async () => Bun.file(path).json() };
}

const commands = (settings: any): string[] =>
  (settings.hooks?.SessionStart ?? []).flatMap((g: any) => g.hooks.map((h: any) => h.command));

describe("install-hooks", () => {
  test("creates the SessionStart entry in an empty file", async () => {
    const s = await (await install()).read();
    expect(s.hooks.SessionStart).toEqual([{ hooks: [{ type: "command", command: OURS, timeout: 1 }] }]);
  });

  test("also registers the unread nudge for UserPromptSubmit, once", async () => {
    const first = await install();
    const again = Bun.spawn(["bun", `${ROOT}/cli.ts`, "install-hooks", "--settings", first.path], {
      stdout: "pipe",
    });
    await again.exited;
    const s = await first.read();
    expect(s.hooks.UserPromptSubmit).toEqual([{ hooks: [{ type: "command", command: OURS, timeout: 1 }] }]);
  });

  test("registers all five events, and a re-run leaves exactly one entry for each", async () => {
    const first = await install();
    const again = Bun.spawn(["bun", `${ROOT}/cli.ts`, "install-hooks", "--settings", first.path], {
      stdout: "pipe",
    });
    expect(await again.exited).toBe(0);
    expect(await new Response(again.stdout).text()).toContain(
      "Installed SessionStart, UserPromptSubmit, Notification, Stop and SessionEnd hooks",
    );
    const s = await first.read();
    for (const event of ["SessionStart", "UserPromptSubmit", "Notification", "Stop", "SessionEnd"]) {
      const ours = s.hooks[event].flatMap((g: any) => g.hooks).filter((h: any) => h.command === OURS);
      expect(ours).toEqual([{ type: "command", command: OURS, timeout: 1 }]);
    }
  });

  test("running twice leaves exactly one entry", async () => {
    const first = await install();
    const proc = Bun.spawn(["bun", `${ROOT}/cli.ts`, "install-hooks", "--settings", first.path], {
      stdout: "pipe",
    });
    await proc.exited;
    expect(commands(await first.read()).filter((c) => c === OURS)).toHaveLength(1);
  });

  test("preserves unrelated hooks and settings", async () => {
    const s = await (
      await install({
        model: "opus",
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
          SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo hi" }] }],
        },
      })
    ).read();
    expect(s.model).toBe("opus");
    expect(s.hooks.Stop).toEqual([
      { hooks: [{ type: "command", command: "say done" }] },
      { hooks: [{ type: "command", command: OURS, timeout: 1 }] },
    ]);
    expect(s.hooks.SessionStart[0]).toEqual({ matcher: "startup", hooks: [{ type: "command", command: "echo hi" }] });
    expect(commands(s)).toContain(OURS);
  });

  test("replaces a stale entry pointing at an old repo path", async () => {
    const s = await (
      await install({
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: `bun "/old/place/hook.ts" # claude-peers`, timeout: 1 }] },
          ],
        },
      })
    ).read();
    expect(commands(s)).toEqual([OURS]);
  });

  test("installs /desktop-wake next to settings.json, pointing at this checkout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-cmd-"));
    try {
      const path = join(dir, "settings.json");
      const run = () =>
        Bun.spawn(["bun", `${ROOT}/cli.ts`, "install-hooks", "--settings", path], {
          stdout: "pipe",
          stderr: "pipe",
        }).exited;
      expect(await run()).toBe(0);
      const cmd = await Bun.file(join(dir, "commands", "desktop-wake.md")).text();
      expect(cmd).toContain(`Run \`bun '${ROOT}/cli.ts' desktop-wake $ARGUMENTS\``);
      expect(cmd).toContain(`allowed-tools: ${JSON.stringify(`Bash(bun '${ROOT}/cli.ts' desktop-wake:*)`)}`);
      expect(await run()).toBe(0); // re-running rewrites ours
      expect(await Bun.file(join(dir, "commands", "desktop-wake.md")).text()).toBe(cmd);

      // Someone else's /desktop-wake is left alone.
      await Bun.write(join(dir, "commands", "desktop-wake.md"), "mine");
      expect(await run()).toBe(0);
      expect(await Bun.file(join(dir, "commands", "desktop-wake.md")).text()).toBe("mine");
      // Mentioning claude-peers doesn't make a file ours.
      await Bun.write(join(dir, "commands", "desktop-wake.md"), "mine # claude-peers");
      expect(await run()).toBe(0);
      expect(await Bun.file(join(dir, "commands", "desktop-wake.md")).text()).toBe("mine # claude-peers");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("install-hooks replaces settings.json by rename, not in place", async () => {
    const path = join(DIR, `atomic-${n++}.json`);
    await Bun.write(path, JSON.stringify({ model: "opus" }));
    const before = statSync(path).ino;
    const proc = Bun.spawn(["bun", `${ROOT}/cli.ts`, "install-hooks", "--settings", path], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(0);
    // A new inode means the file was swapped in whole: a crash mid-write
    // leaves the old settings intact instead of a truncated file.
    expect(statSync(path).ino).not.toBe(before);
    expect((await Bun.file(path).json()).model).toBe("opus");
    expect(readdirSync(DIR).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  test("install-hooks keeps a symlinked settings.json a symlink", async () => {
    const real = join(DIR, `real-${n++}.json`);
    const link = join(DIR, `link-${n++}.json`);
    await Bun.write(real, JSON.stringify({ model: "opus" }));
    symlinkSync(real, link);
    const proc = Bun.spawn(["bun", `${ROOT}/cli.ts`, "install-hooks", "--settings", link], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(0);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(real);
    expect(commands(await Bun.file(real).json())).toEqual([OURS]);
  });

  test("install-hooks keeps settings.json's permissions (it can hold secrets in env)", async () => {
    const path = join(DIR, `mode-${n++}.json`);
    await Bun.write(path, JSON.stringify({ env: { TOKEN: "x" } }));
    chmodSync(path, 0o600);
    const proc = Bun.spawn(["bun", `${ROOT}/cli.ts`, "install-hooks", "--settings", path], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(0);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

const broker = useBroker();

describe("broker commands", () => {
  async function cli(...args: string[]) {
    const proc = Bun.spawn(["bun", `${ROOT}/cli.ts`, ...args], {
      env: { ...process.env, CLAUDE_PEERS_PORT: String(broker.PORT), CLAUDE_PEERS_DB: broker.DB },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = [await new Response(proc.stdout).text(), await new Response(proc.stderr).text()];
    return { code: await proc.exited, out, err };
  }

  describe("digest", () => {
    let to = 0;
    test("prints what is waiting, the events, and where to resume", async () => {
      await broker.post("/request-input", { session_key: "cli-dg", question: "Ship the migration tonight?" });
      await broker.post("/report-event", { session_key: "cli-dg", level: "warning", message: "tests are red" });
      const last = await broker.post<{ event_id: number }>("/report-event", {
        session_key: "cli-dg",
        message: "turn done",
      });
      to = last.event_id;
      const r = await cli("digest");
      expect(r.code).toBe(0);
      expect(r.out).toContain("Waiting on you (1)");
      expect(r.out).toContain("Ship the migration tonight?");
      expect(r.out).toContain("Escalated (0)");
      expect(r.out).toContain("Events since 0");
      expect(r.out).toContain("warning");
      expect(r.out).toContain("tests are red");
      expect(r.out).toContain("turn done");
      expect(r.out).toContain(`next: --since ${to}`);
      expect(r.out).not.toContain("cli-dg");
    });

    test("control characters in agent text are not printed to the terminal", async () => {
      await broker.post("/report-event", {
        session_key: "cli-esc",
        level: "warning",
        message: "before\u001b[2J\u001b]0;pwned\u0007after\u009b31m",
      });
      const r = await cli("digest", "--since", String(to));
      expect(r.out).toContain("before");
      expect(r.out).toContain("after");
      const control = [...r.out].filter((c) => {
        const n = c.charCodeAt(0);
        return (n <= 0x1f && c !== "\n") || (n >= 0x7f && n <= 0x9f);
      });
      expect(control).toEqual([]);
      to = (JSON.parse((await cli("digest", "--json")).out) as { cursor: { to: number } }).cursor.to;
    });

    test("--json prints the raw digest", async () => {
      const r = await cli("digest", "--json");
      expect(r.code).toBe(0);
      const d = JSON.parse(r.out);
      expect(d.cursor.to).toBe(to);
      expect(d.pending).toHaveLength(1);
    });

    test("--since <to> shows no events, and a read never moves a cursor", async () => {
      const r = await cli("digest", "--since", String(to));
      expect(r.code).toBe(0);
      expect(r.out).toContain(`Events since ${to}`);
      expect(r.out).not.toContain("tests are red");
      const db = new Database(broker.DB, { readonly: true });
      try {
        expect(db.query("SELECT COUNT(*) AS n FROM digest_cursors").get()).toEqual({ n: 0 });
      } finally {
        db.close();
      }
    });

    test("--level and --limit filter, and a bad value is an error, not a crash", async () => {
      const warn = await cli("digest", "--level", "warning");
      expect(warn.out).toContain("tests are red");
      expect(warn.out).not.toContain("turn done");
      const one = await cli("digest", "--limit", "1");
      expect(one.out).toContain("tests are red");
      expect(one.out).not.toContain("turn done");
      expect(one.out).toContain("next: --since");
      const bad = await cli("digest", "--level", "loud");
      expect(bad.code).toBe(1);
      expect(bad.err).toContain("min_level must be one of");
      expect(bad.err).not.toContain("    at ");
    });
  });

  describe("cos", () => {
    const reg = async (summary: string, token: string) =>
      (
        await broker.post<{ id: string }>("/register", {
          pid: process.pid,
          cwd: `/ (${summary})`,
          git_root: null,
          tty: null,
          summary,
          peer_type: "desktop",
          session_token: token,
        })
      ).id;
    const holder = async () => (await broker.post<{ peer_id: string | null }>("/cos-status", {})).peer_id;

    /**
     * Runs `bun cli.ts cos ...` on a pseudo-terminal, as a person at a terminal
     * would, typing `answer` when it asks for confirmation.
     */
    async function inTerminal(args: string[], answer: string) {
      // Python's pty works on macOS and Linux alike, and tolerates a non-tty stdin.
      const PTY = "import os, pty, sys\nsys.exit(os.waitstatus_to_exitcode(pty.spawn(sys.argv[1:])))";
      const argv = ["python3", "-c", PTY, "bun", `${ROOT}/cli.ts`, "cos", ...args];
      const proc = Bun.spawn(argv, {
        env: { ...process.env, CLAUDE_PEERS_PORT: String(broker.PORT), CLAUDE_PEERS_DB: broker.DB },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      const dec = new TextDecoder();
      let out = "";
      let answered = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        out += dec.decode(value);
        if (!answered && out.includes("to confirm")) {
          answered = true;
          (proc.stdin as import("bun").FileSink).write(`${answer}\n`);
          (proc.stdin as import("bun").FileSink).flush();
        }
      }
      (proc.stdin as import("bun").FileSink).end();
      return { code: await proc.exited, out: out.replaceAll("\r", "") };
    }

    test("with no chief of staff, says so; showing needs no terminal", async () => {
      const r = await cli("cos");
      expect(r.code).toBe(0);
      expect(r.out).toContain("No chief of staff.");
    });

    test("without a terminal, naming or clearing is refused and nothing changes", async () => {
      const id = await reg("COS by agent", "cs_clicos0000010");
      const named = await cli("cos", id);
      expect(named.code).toBe(1);
      expect(named.err).toContain("needs a terminal");
      expect(await holder()).toBeNull();
      await inTerminal([id], id);
      expect(await holder()).toBe(id);
      const cleared = await cli("cos", "--clear");
      expect(cleared.code).toBe(1);
      expect(await holder()).toBe(id);
      await inTerminal(["--clear"], id);
      expect(await holder()).toBeNull();
    });

    test("names a peer once its id is typed back, shows it, and clears it", async () => {
      const id = await reg("Chief of Staff agent", "cs_clicos0000001");
      const named = await inTerminal([id], id);
      expect(named.code).toBe(0);
      expect(named.out).toContain(`${id}  desktop  / (Chief of Staff agent)`);
      expect(named.out).toContain(`Chief of staff is now ${id}`);
      expect(await holder()).toBe(id);
      expect((await cli("cos")).out).toContain(`Chief of staff: ${id}  Chief of Staff agent`);
      const cleared = await inTerminal(["--clear"], id);
      expect(cleared.code).toBe(0);
      expect(cleared.out).toContain("No chief of staff.");
      expect(await holder()).toBeNull();
    });

    test("a name match shows the peer and changes nothing unless its id is typed back", async () => {
      const id = await reg("COS-unique-label", "cs_clicos0000002");
      const wrong = await inTerminal(["cos-unique"], "yes");
      expect(wrong.code).toBe(1);
      expect(wrong.out).toContain(`${id}  desktop`);
      expect(wrong.out).toContain("Not changed.");
      expect(await holder()).toBeNull();
      expect((await inTerminal(["cos-unique"], id)).code).toBe(0);
      expect(await holder()).toBe(id);
    });

    test("an ambiguous or unknown name changes nothing", async () => {
      const before = await holder();
      await reg("twin agent", "cs_clicos0000003");
      await reg("twin agent", "cs_clicos0000004");
      const twins = await inTerminal(["twin"], "");
      expect(twins.code).toBe(1);
      expect(twins.out).toContain('"twin" matches 2 peers');
      const none = await inTerminal(["nobody-by-this-name"], "");
      expect(none.code).toBe(1);
      expect(none.out).toContain('No peer matches "nobody-by-this-name"');
      expect(await holder()).toBe(before);
    });
  });

  test("send carries the install secret", async () => {
    const seen: Array<string | null> = [];
    const stub = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        seen.push(req.headers.get("authorization"));
        return Response.json({ ok: true });
      },
    });
    try {
      const db = join(DIR, "send.db");
      const secret = ensureSecret(secretPath(db));
      const proc = Bun.spawn(["bun", `${ROOT}/cli.ts`, "send", "abc12345", "hello"], {
        env: { ...process.env, CLAUDE_PEERS_PORT: String(stub.port), CLAUDE_PEERS_DB: db },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await proc.exited).toBe(0);
      expect(seen).toEqual([`Bearer ${secret}`]);
    } finally {
      stub.stop(true);
    }
  });
});
