import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, rmSync, statSync, lstatSync, symlinkSync, readdirSync, readlinkSync, chmodSync } from "node:fs";
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

  test("installs /desktop-wake next to settings.json, pointing at this checkout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-cmd-"));
    try {
      const path = join(dir, "settings.json");
      const run = () => Bun.spawn(["bun", `${import.meta.dir}/cli.ts`, "install-hooks", "--settings", path], { stdout: "pipe", stderr: "pipe" }).exited;
      expect(await run()).toBe(0);
      const cmd = await Bun.file(join(dir, "commands", "desktop-wake.md")).text();
      expect(cmd).toContain(`Run \`bun '${import.meta.dir}/cli.ts' desktop-wake $ARGUMENTS\``);
      expect(cmd).toContain(`allowed-tools: ${JSON.stringify(`Bash(bun '${import.meta.dir}/cli.ts' desktop-wake:*)`)}`);
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
    const proc = Bun.spawn(["bun", `${import.meta.dir}/cli.ts`, "install-hooks", "--settings", path], { stdout: "pipe", stderr: "pipe" });
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
    const proc = Bun.spawn(["bun", `${import.meta.dir}/cli.ts`, "install-hooks", "--settings", link], { stdout: "pipe", stderr: "pipe" });
    expect(await proc.exited).toBe(0);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(real);
    expect(commands(await Bun.file(real).json())).toEqual([OURS]);
  });

  test("install-hooks keeps settings.json's permissions (it can hold secrets in env)", async () => {
    const path = join(DIR, `mode-${n++}.json`);
    await Bun.write(path, JSON.stringify({ env: { TOKEN: "x" } }));
    chmodSync(path, 0o600);
    const proc = Bun.spawn(["bun", `${import.meta.dir}/cli.ts`, "install-hooks", "--settings", path], { stdout: "pipe", stderr: "pipe" });
    expect(await proc.exited).toBe(0);
    expect(statSync(path).mode & 0o777).toBe(0o600);
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
