/**
 * /session-start: the SessionStart hook re-keying a resumed session.
 */

import { test, expect, describe, afterAll } from "bun:test";
import { useBroker } from "./harness.ts";

const { DB, post, register } = useBroker();

// A SessionStart hook posts the live session id plus its ancestor pids. The
// broker finds the CLI peer owned by that process and, when the live session
// already owns a different id (in-session /resume), moves the row onto it.
describe("/session-start", () => {
  type SSRes = { ok: boolean; peer_id?: string; action?: string; reason?: string };
  const sleepers: ReturnType<typeof Bun.spawn>[] = [];
  const livePid = () => {
    const p = Bun.spawn(["sleep", "30"]);
    sleepers.push(p);
    return p.pid;
  };
  const regCli = (pid: number, session_key: string, summary = "") =>
    post<{ id: string }>("/register", {
      pid,
      cwd: "/tmp/ss",
      git_root: null,
      tty: null,
      summary,
      peer_type: "cli",
      session_key,
    }).then((r) => r.id);
  const ss = (body: unknown) => post<SSRes>("/session-start", body);
  const machine = () =>
    post<Array<{ id: string; pid: number }>>("/list-peers", { scope: "machine", cwd: "/", git_root: null });

  afterAll(() => {
    for (const p of sleepers) {
      try {
        p.kill();
      } catch {}
    }
  });

  test("no live peer: no rows created", async () => {
    const before = (await machine()).length;
    const r = await ss({ session_key: "ss-none", pid: livePid(), source: "startup" });
    expect(r).toEqual({ ok: false, reason: "no_live_peer" });
    expect((await machine()).length).toBe(before);
  });

  test("unmapped key is mapped to the live peer", async () => {
    const proc = Bun.spawn(["sleep", "30"]);
    const id = await regCli(proc.pid, "ss-launch-m");
    const r = await ss({ session_key: "ss-fresh-m", pid: proc.pid, source: "clear" });
    expect(r).toEqual({ ok: true, peer_id: id, action: "mapped" });
    // After that process exits, resuming the new key elsewhere gets the same id.
    proc.kill();
    await proc.exited;
    expect(await regCli(livePid(), "ss-fresh-m")).toBe(id);
  });

  test("same key is a noop", async () => {
    const pid = livePid();
    const id = await regCli(pid, "ss-noop");
    expect(await ss({ session_key: "ss-noop", pid: pid, source: "startup" })).toEqual({
      ok: true,
      peer_id: id,
      action: "noop",
    });
  });

  test("resume rekeys the live process onto the session's original id", async () => {
    const idA = await regCli(livePid(), "ss-orig-r");
    await post("/unregister", { id: idA }); // original process gone; mapping kept
    const pidB = livePid();
    const idB = await regCli(pidB, "ss-launch-r");
    expect(idB).not.toBe(idA);

    const r = await ss({ session_key: "ss-orig-r", pid: pidB, source: "resume" });
    expect(r).toEqual({ ok: true, peer_id: idA, action: "rekeyed" });
    const peers = await machine();
    expect(peers.find((p) => p.id === idA)?.pid).toBe(pidB);
    expect(peers.some((p) => p.id === idB)).toBe(false);
  });

  test("rekey moves undelivered mail from an id only its launch key maps to", async () => {
    const idA = await regCli(livePid(), "ss-orig-mail");
    await post("/unregister", { id: idA });
    const pidB = livePid();
    const idB = await regCli(pidB, "ss-launch-mail");
    const sender = await register("SS sender", "cli");
    await post("/send-message", { from_id: sender, to_id: idB, text: "sent to the launch id" });

    await ss({ session_key: "ss-orig-mail", pid: pidB, source: "resume" });
    // idB only ever stood for the moments between launch and /resume. Whoever
    // wrote to it was addressing the agent in this terminal, which is now idA.
    const atB = await post<{ messages: Array<{ text: string }> }>("/peek-messages", { id: idB });
    const atA = await post<{ messages: Array<{ text: string }> }>("/peek-messages", { id: idA });
    expect(atA.messages.map((m) => m.text)).toContain("sent to the launch id");
    expect(atB.messages).toEqual([]);
  });

  test("rekey leaves mail on an id that more than one key maps to", async () => {
    const idA = await regCli(livePid(), "ss-orig-two");
    await post("/unregister", { id: idA });
    const pidB = livePid();
    const idB = await regCli(pidB, "ss-launch-two");
    // /clear in that terminal: idB now also carries a second conversation.
    expect((await ss({ session_key: "ss-clear-two", pid: pidB, source: "clear" })).action).toBe("mapped");
    const sender = await register("SS sender", "cli");
    await post("/send-message", { from_id: sender, to_id: idB, text: "for the cleared conversation" });

    await ss({ session_key: "ss-orig-two", pid: pidB, source: "resume" });
    const atB = await post<{ messages: Array<{ text: string }> }>("/peek-messages", { id: idB });
    const atA = await post<{ messages: Array<{ text: string }> }>("/peek-messages", { id: idA });
    expect(atB.messages.map((m) => m.text)).toContain("for the cleared conversation");
    expect(atA.messages.map((m) => m.text)).not.toContain("for the cleared conversation");
  });

  test("launch key resolves to the reclaimed id after rekey", async () => {
    const idA = await regCli(livePid(), "ss-orig-l");
    await post("/unregister", { id: idA });
    const pidB = livePid();
    await regCli(pidB, "ss-launch-l");
    await ss({ session_key: "ss-orig-l", pid: pidB, source: "resume" });
    // What the MCP server's ensureRegistered does on its next heartbeat.
    expect(await regCli(pidB, "ss-launch-l")).toBe(idA);
  });

  test("conflict when the session's peer is live under another live pid", async () => {
    const idA = await regCli(livePid(), "ss-orig-c");
    const pidB = livePid();
    const idB = await regCli(pidB, "ss-launch-c");
    expect(await ss({ session_key: "ss-orig-c", pid: pidB, source: "resume" })).toEqual({
      ok: false,
      reason: "conflict",
    });
    const ids = (await machine()).map((p) => p.id);
    expect(ids).toContain(idA);
    expect(ids).toContain(idB);
  });

  test("a refused conflict records nothing for the caller's pid", async () => {
    const procA = Bun.spawn(["sleep", "30"]);
    const idA = await regCli(procA.pid, "ss-orig-c2");
    const pidB = livePid();
    const idB = await regCli(pidB, "ss-launch-c2");
    expect(await ss({ session_key: "ss-orig-c2", pid: pidB, source: "resume" })).toEqual({
      ok: false,
      reason: "conflict",
    });
    // Once A is gone, B re-registering under its own launch key must still be
    // B. Had the refused call been recorded, B would now resolve to A's id.
    procA.kill();
    await procA.exited;
    await post("/unregister", { id: idB });
    expect(await regCli(pidB, "ss-launch-c2")).toBe(idB);
    expect(idA).not.toBe(idB);
  });

  test("desktop rows are never matched", async () => {
    const pid = livePid();
    await post("/register", {
      pid,
      cwd: "cs_ss_desktop",
      git_root: null,
      tty: null,
      summary: "",
      peer_type: "desktop",
      session_token: "cs_ss_desktop",
    });
    expect(await ss({ session_key: "ss-desk", pid: pid, source: "startup" })).toEqual({
      ok: false,
      reason: "no_live_peer",
    });
  });

  test("malformed body → bad_request", async () => {
    expect(await ss({})).toEqual({ ok: false, reason: "bad_request" });
    expect(await ss({ session_key: "x" })).toEqual({ ok: false, reason: "bad_request" });
  });
  // SE condition (3): pids get reused, so a pid match alone must not hand a
  // new process someone else's identity. Rows record the process start time.
  const { Database } = require("bun:sqlite");
  const setStarted = (id: string, v: string | null) => {
    const d = new Database(DB);
    d.run("UPDATE peers SET pid_started = ? WHERE id = ?", [v, id]);
    d.close();
  };
  // Recorded in the C locale and UTC whatever the broker's own environment is
  // (it inherits whichever session auto-launched it), or a broker restart under
  // another LANG/TZ would make every stored value mismatch.
  const startedOf = (pid: number) =>
    new TextDecoder()
      .decode(
        Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], { env: { ...process.env, LC_ALL: "C", TZ: "UTC" } })
          .stdout,
      )
      .trim();

  test("CLI rows record the process start time", async () => {
    const pid = livePid();
    const id = await regCli(pid, "ss-started");
    const d = new Database(DB, { readonly: true });
    const row = d.query("SELECT pid_started FROM peers WHERE id = ?").get(id) as { pid_started: string };
    d.close();
    expect(row.pid_started).toBe(startedOf(pid));
  });

  test("register does not adopt a pid-matched row left by a reused pid", async () => {
    const pid = livePid();
    const old = await post<{ id: string }>("/register", {
      pid,
      cwd: "/tmp/reuse",
      git_root: null,
      tty: null,
      summary: "",
      peer_type: "cli",
    });
    setStarted(old.id, "Mon Jan  1 00:00:00 2001");
    const again = await post<{ id: string }>("/register", {
      pid,
      cwd: "/tmp/reuse",
      git_root: null,
      tty: null,
      summary: "",
      peer_type: "cli",
    });
    expect(again.id).not.toBe(old.id);
  });

  test("session-start ignores a row whose recorded start time differs", async () => {
    const pid = livePid();
    const id = await regCli(pid, "ss-reuse");
    setStarted(id, "Mon Jan  1 00:00:00 2001");
    expect(await ss({ session_key: "ss-reuse-new", pid: pid, source: "resume" })).toEqual({
      ok: false,
      reason: "no_live_peer",
    });
  });

  test("rows with no recorded start time (pre-upgrade) still match", async () => {
    const pid = livePid();
    const id = await regCli(pid, "ss-legacy");
    setStarted(id, null);
    expect(await ss({ session_key: "ss-legacy-new", pid: pid, source: "clear" })).toEqual({
      ok: true,
      peer_id: id,
      action: "mapped",
    });
  });

  test("an owner whose pid is alive but reused is not a conflict", async () => {
    const idA = await regCli(livePid(), "ss-orig-u");
    setStarted(idA, "Mon Jan  1 00:00:00 2001");
    const pidB = livePid();
    await regCli(pidB, "ss-launch-u");
    expect(await ss({ session_key: "ss-orig-u", pid: pidB, source: "resume" })).toEqual({
      ok: true,
      peer_id: idA,
      action: "rekeyed",
    });
  });
  test("rekey keeps the previous conversation's identity", async () => {
    const idA = await regCli(livePid(), "ss-orig-k");
    await post("/unregister", { id: idA });
    const pidB = livePid();
    const idB = await regCli(pidB, "ss-conv-b"); // B has been conversation "ss-conv-b" for hours
    await ss({ session_key: "ss-orig-k", pid: pidB, source: "resume" }); // ...then /resume A
    // Resuming conversation B elsewhere later must get B's id, not A's.
    expect(await regCli(livePid(), "ss-conv-b")).toBe(idB);
  });

  test("a second live process resuming the same session gets its own id", async () => {
    const pidA = livePid();
    const idA = await regCli(pidA, "ss-twice");
    const pidB = livePid();
    const idB = await regCli(pidB, "ss-twice");
    expect(idB).not.toBe(idA);
    const peers = await machine();
    expect(peers.find((p) => p.id === idA)?.pid).toBe(pidA);
    // And re-registering B (heartbeat re-register) keeps B's own id.
    expect(await regCli(pidB, "ss-twice")).toBe(idB);
  });

  test("only the given pid is considered", async () => {
    // A nested `claude` whose server has not registered must not resolve to a
    // parent session's row: the hook sends exactly one pid and nothing walks up.
    const parent = livePid();
    await regCli(parent, "ss-parent");
    expect(await ss({ session_key: "ss-child", pid: livePid(), source: "startup" })).toEqual({
      ok: false,
      reason: "no_live_peer",
    });
  });
});
