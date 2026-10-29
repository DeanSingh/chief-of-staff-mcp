import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSecret, secretPath } from "./shared/auth.ts";

const DIR = mkdtempSync(join(tmpdir(), "cp-install-hooks-"));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const OURS = `bun '${import.meta.dir}/hook.ts' # claude-peers`;
let n = 0;

async function install(initial?: unknown) {
  const path = join(DIR, `settings-${n++}.json`);
  if (initial !== undefined) await Bun.write(path, JSON.stringify(initial));
  const proc = Bun.spawn(["bun", `${import.meta.dir}/cli.ts`, "install-hooks", "--settings", path], { stdout: "pipe", stderr: "pipe" });
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
    const again = Bun.spawn(["bun", `${import.meta.dir}/cli.ts`, "install-hooks", "--settings", first.path], { stdout: "pipe" });
    await again.exited;
    const s = await first.read();
    expect(s.hooks.UserPromptSubmit).toEqual([{ hooks: [{ type: "command", command: OURS, timeout: 1 }] }]);
  });

  test("running twice leaves exactly one entry", async () => {
    const first = await install();
    const proc = Bun.spawn(["bun", `${import.meta.dir}/cli.ts`, "install-hooks", "--settings", first.path], { stdout: "pipe" });
    await proc.exited;
    expect(commands(await first.read()).filter((c) => c === OURS)).toHaveLength(1);
  });

  test("preserves unrelated hooks and settings", async () => {
    const s = await (await install({
      model: "opus",
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
        SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo hi" }] }],
      },
    })).read();
    expect(s.model).toBe("opus");
    expect(s.hooks.Stop).toEqual([{ hooks: [{ type: "command", command: "say done" }] }]);
    expect(s.hooks.SessionStart[0]).toEqual({ matcher: "startup", hooks: [{ type: "command", command: "echo hi" }] });
    expect(commands(s)).toContain(OURS);
  });

  test("replaces a stale entry pointing at an old repo path", async () => {
    const s = await (await install({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: `bun "/old/place/hook.ts" # claude-peers`, timeout: 1 }] }] },
    })).read();
    expect(commands(s)).toEqual([OURS]);
  });
});

describe("broker commands", () => {
  test("send carries the install secret", async () => {
    const seen: Array<string | null> = [];
    const stub = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      fetch(req) { seen.push(req.headers.get("authorization")); return Response.json({ ok: true }); },
    });
    try {
      const db = join(DIR, "send.db");
      const secret = ensureSecret(secretPath(db));
      const proc = Bun.spawn(["bun", `${import.meta.dir}/cli.ts`, "send", "abc12345", "hello"], {
        env: { ...process.env, CLAUDE_PEERS_PORT: String(stub.port), CLAUDE_PEERS_DB: db }, stdout: "pipe", stderr: "pipe",
      });
      expect(await proc.exited).toBe(0);
      expect(seen).toEqual([`Bearer ${secret}`]);
    } finally {
      stub.stop(true);
    }
  });
});
