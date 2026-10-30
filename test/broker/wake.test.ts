/**
 * Desktop wake mode, the wake relay, and `bun cli.ts desktop-wake`.
 */

import { test, expect, describe, afterAll } from "bun:test";
import { ROOT, LIVE_PIDS, headersFor, postTo, useBroker } from "./harness.ts";

const { PORT, HTTP, DB, BROKER_ENV, relay, post, restartBroker } = useBroker();

describe("wake relay", () => {
  type Reg = { id: string; wake_topic?: string; wake_url?: string };
  const TOPIC = /^cp-wake-[0-9a-f]{24}$/;
  const sleepers: ReturnType<typeof Bun.spawn>[] = [];
  const livePid = () => {
    const p = Bun.spawn(["sleep", "30"]);
    sleepers.push(p);
    return p.pid;
  };
  afterAll(() => {
    for (const p of sleepers) {
      try {
        p.kill();
      } catch {}
    }
  });
  const regDesktop = (token: string, base = HTTP, db = DB) =>
    postTo<Reg>(base, db, "/register", {
      pid: LIVE_PIDS[0],
      cwd: token,
      git_root: null,
      tty: null,
      summary: "Cowork",
      peer_type: "desktop",
      session_token: token,
    });
  const regCli = (base = HTTP, db = DB) =>
    postTo<Reg>(base, db, "/register", {
      pid: livePid(),
      cwd: "/tmp/wake",
      git_root: null,
      tty: null,
      summary: "Sender",
      peer_type: "cli",
    });
  const hitsFor = (topic: string) => relay.hits.filter((h) => h.path === `/${topic}`);
  async function waitFor(cond: () => boolean, ms = 1000) {
    for (let t = 0; t < ms && !cond(); t += 20) await Bun.sleep(20);
  }

  test("desktop register returns a cp-wake- topic; cli does not", async () => {
    expect((await regDesktop("cs_wake_a")).wake_topic).toMatch(TOPIC);
    expect((await regCli()).wake_topic).toBeUndefined();
  });

  test("desktop register returns the full wake URL on the broker's own relay", async () => {
    // The broker is the single source of truth for the relay: a server whose
    // env names a different relay must not print a URL nobody publishes to.
    const d = await regDesktop("cs_wake_url");
    expect(d.wake_url).toBe(`http://127.0.0.1:${relay.port}/${d.wake_topic}`);
    expect((await regCli()).wake_url).toBeUndefined();
  });

  test("same token → same topic across re-register", async () => {
    const a = await regDesktop("cs_wake_b");
    const b = await regDesktop("cs_wake_b");
    expect(a.wake_topic).toMatch(TOPIC);
    expect(b.id).toBe(a.id);
    expect(b.wake_topic).toBe(a.wake_topic!);
  });

  test("topic survives reap and resurrection", async () => {
    const a = await regDesktop("cs_wake_c");
    await post("/unregister", { id: a.id });
    await restartBroker();
    const b = await regDesktop("cs_wake_c");
    expect(a.wake_topic).toMatch(TOPIC);
    expect(b.id).toBe(a.id);
    expect(b.wake_topic).toBe(a.wake_topic!);
  });

  test("a token minted before topics existed gets one on its next register, then keeps it", async () => {
    const a = await regDesktop("cs_wake_d");
    const { Database } = require("bun:sqlite");
    const d = new Database(DB);
    d.run("UPDATE desktop_tokens SET wake_topic = NULL WHERE token = ?", ["cs_wake_d"]);
    d.close();
    const b = await regDesktop("cs_wake_d");
    expect(b.wake_topic).toMatch(TOPIC);
    expect(b.wake_topic).not.toBe(a.wake_topic!);
    expect((await regDesktop("cs_wake_d")).wake_topic).toBe(b.wake_topic!);
  });

  test("send to a desktop peer publishes exactly 'wake' to its topic", async () => {
    const d = await regDesktop("cs_wake_e");
    const s = await regCli();
    const res = await post<{ ok: boolean }>("/send-message", { from_id: s.id, to_id: d.id, text: "secret plans" });
    expect(res.ok).toBe(true);
    await waitFor(() => hitsFor(d.wake_topic!).length > 0);
    expect(hitsFor(d.wake_topic!)).toEqual([{ path: `/${d.wake_topic}`, body: "wake" }]);
    expect(relay.hits.some((h) => h.body.includes("secret") || h.path.includes(d.id) || h.path.includes(s.id))).toBe(
      false,
    );
  });

  test("list-peers never carries a wake topic", async () => {
    await regDesktop("cs_wake_h");
    const peers = await post<unknown[]>("/list-peers", { scope: "machine", cwd: "/", git_root: null });
    expect(JSON.stringify(peers)).not.toContain("cp-wake-");
  });

  test("send to a cli peer publishes nothing", async () => {
    const a = await regCli();
    const b = await regCli();
    const before = relay.hits.length;
    await post("/send-message", { from_id: a.id, to_id: b.id, text: "hi" });
    await Bun.sleep(300);
    expect(relay.hits.length).toBe(before);
  });

  test("coalesces publishes within the window, then sends one trailing wake", async () => {
    const d = await regDesktop("cs_wake_f");
    const s = await regCli();
    for (let i = 0; i < 5; i++) await post("/send-message", { from_id: s.id, to_id: d.id, text: `m${i}` });
    await Bun.sleep(300);
    expect(hitsFor(d.wake_topic!).length).toBe(1);
    // Mail that arrived inside the window must still wake the agent once the
    // window closes, or a message landing just after a wake is never seen.
    await waitFor(() => hitsFor(d.wake_topic!).length > 1, 2000);
    await Bun.sleep(300);
    expect(hitsFor(d.wake_topic!).length).toBe(2);
  });

  test("send succeeds when the relay hangs", async () => {
    const d = await regDesktop("cs_wake_g");
    const s = await regCli();
    relay.hang = true;
    try {
      const t0 = performance.now();
      const res = await post<{ ok: boolean }>("/send-message", { from_id: s.id, to_id: d.id, text: "still queued" });
      expect(res.ok).toBe(true);
      expect(performance.now() - t0).toBeLessThan(500);
      const peek = await post<{ messages: Array<{ text: string }> }>("/peek-messages", { id: d.id });
      expect(peek.messages.map((m) => m.text)).toContain("still queued");
    } finally {
      relay.hang = false;
    }
  });

  // Off unless Dean opts in: an unset relay, "off", and a relay that would
  // publish in clear text over the internet all mean no topics and no egress.
  const { CLAUDE_PEERS_WAKE_RELAY: _relay, ...UNSET } = BROKER_ENV;
  for (const [i, [label, env]] of (
    [
      ["unset (the default)", UNSET],
      ["off", { ...BROKER_ENV, CLAUDE_PEERS_WAKE_RELAY: "off" }],
      ["a plain-http remote relay", { ...BROKER_ENV, CLAUDE_PEERS_WAKE_RELAY: "http://ntfy.example" }],
      [
        "a relay URL with shell metacharacters",
        { ...BROKER_ENV, CLAUDE_PEERS_WAKE_RELAY: 'https://ntfy.example/x";touch /tmp/cp-pwned;"' },
      ],
    ] as const
  ).entries()) {
    test(`relay ${label}: no topic, no publish`, async () => {
      const OFF_PORT = PORT + 200 + i;
      const OFF_HTTP = `http://127.0.0.1:${OFF_PORT}`;
      const OFF_DB = `${import.meta.dir}/.test-broker-off-${OFF_PORT}.db`;
      const off = Bun.spawn(["bun", `${ROOT}/broker.ts`], {
        env: { ...env, CLAUDE_PEERS_PORT: String(OFF_PORT), CLAUDE_PEERS_DB: OFF_DB },
        stdout: "ignore",
        stderr: "ignore",
      });
      try {
        for (let i = 0; i < 50; i++) {
          try {
            if ((await fetch(`${OFF_HTTP}/health`)).ok) break;
          } catch {}
          await Bun.sleep(100);
        }
        const d = await regDesktop(`cs_wake_off${i}`, OFF_HTTP, OFF_DB);
        expect(d.id).toBeDefined();
        expect(d.wake_topic).toBeUndefined();
        expect(d.wake_url).toBeUndefined();
        const s = await regCli(OFF_HTTP, OFF_DB);
        const before = relay.hits.length;
        await postTo(OFF_HTTP, OFF_DB, "/send-message", { from_id: s.id, to_id: d.id, text: "x" });
        await Bun.sleep(300);
        expect(relay.hits.length).toBe(before);
      } finally {
        off.kill();
        await off.exited;
        for (const suffix of ["", "-wal", "-shm", ".secret"]) {
          try {
            await Bun.file(OFF_DB + suffix).delete();
          } catch {}
        }
      }
    });
  }

  test("an HTTP error from the relay is logged, without the topic", async () => {
    const ERR_PORT = PORT + 300;
    const ERR_HTTP = `http://127.0.0.1:${ERR_PORT}`;
    const ERR_DB = `${import.meta.dir}/.test-broker-err-${ERR_PORT}.db`;
    const b = Bun.spawn(["bun", `${ROOT}/broker.ts`], {
      env: { ...BROKER_ENV, CLAUDE_PEERS_PORT: String(ERR_PORT), CLAUDE_PEERS_DB: ERR_DB },
      stdout: "ignore",
      stderr: "pipe",
    });
    relay.status = 429;
    try {
      for (let i = 0; i < 50; i++) {
        try {
          if ((await fetch(`${ERR_HTTP}/health`)).ok) break;
        } catch {}
        await Bun.sleep(100);
      }
      const d = await regDesktop("cs_wake_err", ERR_HTTP, ERR_DB);
      const s = await regCli(ERR_HTTP, ERR_DB);
      await postTo(ERR_HTTP, ERR_DB, "/send-message", { from_id: s.id, to_id: d.id, text: "x" });
      await waitFor(() => hitsFor(d.wake_topic!).length > 0);
      await Bun.sleep(200);
      b.kill();
      const err = await new Response(b.stderr as ReadableStream).text();
      expect(err).toContain("wake publish failed: HTTP 429");
      expect(err).not.toContain(d.wake_topic!);
    } finally {
      relay.status = 200;
      b.kill();
      await b.exited;
      for (const suffix of ["", "-wal", "-shm", ".secret"]) {
        try {
          await Bun.file(ERR_DB + suffix).delete();
        } catch {}
      }
    }
  });

  describe("wake mode", () => {
    const setMode = (body: Record<string, unknown>) =>
      fetch(`${HTTP}/wake-mode`, {
        method: "POST",
        headers: headersFor(DB, "/wake-mode", body),
        body: JSON.stringify(body),
      });
    const status = () =>
      post<{ global: string; relay: string | null; peers: { id: string; mode: string; own_setting: boolean }[] }>(
        "/wake-status",
        {},
      );
    const beat = (id: string) => post<{ ok: boolean; wake_url?: string }>("/heartbeat", { id });
    // These tests share one broker with the rest of the file: leave it active.
    afterAll(async () => {
      await setMode({ mode: "active", clear_overrides: true });
    });

    test("a broker started with a relay is active by default", async () => {
      const d = await regDesktop("cs_mode_a");
      expect((await status()).global).toBe("active");
      expect((await status()).peers.find((p) => p.id === d.id)).toMatchObject({ mode: "active", own_setting: false });
      expect((await beat(d.id)).wake_url).toBe(d.wake_url!);
    });

    test("passive: no wake URL, no publish, and an armed topic gets one 'off'", async () => {
      const d = await regDesktop("cs_mode_b");
      const s = await regCli();
      expect((await setMode({ mode: "passive" })).status).toBe(200);
      await waitFor(() => hitsFor(d.wake_topic!).length > 0);
      expect(hitsFor(d.wake_topic!)).toEqual([{ path: `/${d.wake_topic}`, body: "off" }]);

      expect((await regDesktop("cs_mode_b")).wake_url).toBeUndefined();
      expect((await beat(d.id)).wake_url).toBeUndefined();
      await post("/send-message", { from_id: s.id, to_id: d.id, text: "hi" });
      await Bun.sleep(300);
      expect(hitsFor(d.wake_topic!)).toHaveLength(1); // still just the "off"

      // Switching to the mode it's already in sends nothing.
      await setMode({ mode: "passive" });
      await Bun.sleep(200);
      expect(hitsFor(d.wake_topic!)).toHaveLength(1);
      await setMode({ mode: "active" });
    });

    test("an agent's own setting wins over the global one, and default clears it", async () => {
      const keep = await regDesktop("cs_mode_keep");
      const other = await regDesktop("cs_mode_other");
      const s = await regCli();
      await setMode({ mode: "passive" });
      expect((await setMode({ mode: "active", peer_id: keep.id })).status).toBe(200);

      expect((await beat(keep.id)).wake_url).toBe(keep.wake_url!);
      expect((await beat(other.id)).wake_url).toBeUndefined();
      expect((await status()).peers.find((p) => p.id === keep.id)).toMatchObject({ mode: "active", own_setting: true });
      const before = hitsFor(keep.wake_topic!).length;
      await post("/send-message", { from_id: s.id, to_id: keep.id, text: "still awake?" });
      await waitFor(() => hitsFor(keep.wake_topic!).length > before);
      expect(hitsFor(keep.wake_topic!).at(-1)).toEqual({ path: `/${keep.wake_topic}`, body: "wake" });

      // Back to the global (passive) mode: that's a switch to passive, so "off".
      expect((await setMode({ mode: "default", peer_id: keep.id })).status).toBe(200);
      await waitFor(() => hitsFor(keep.wake_topic!).at(-1)?.body === "off");
      expect(hitsFor(keep.wake_topic!).at(-1)!.body).toBe("off");
      expect((await beat(keep.id)).wake_url).toBeUndefined();
      await setMode({ mode: "active" });
    });

    test("--all clears every agent's own setting", async () => {
      const d = await regDesktop("cs_mode_all");
      await setMode({ mode: "active", peer_id: d.id });
      await setMode({ mode: "passive", clear_overrides: true });
      expect((await status()).peers.find((p) => p.id === d.id)).toMatchObject({ mode: "passive", own_setting: false });
      await setMode({ mode: "active" });
    });

    test("the mode survives a broker restart", async () => {
      const d = await regDesktop("cs_mode_restart");
      await setMode({ mode: "passive" });
      await restartBroker();
      expect((await status()).global).toBe("passive");
      expect((await regDesktop("cs_mode_restart")).wake_url).toBeUndefined();
      expect(d.wake_url).toBeDefined();
      await setMode({ mode: "active" });
    });

    test("bad requests are refused", async () => {
      const c = await regCli();
      expect((await setMode({ mode: "loud" })).status).toBe(400);
      expect((await setMode({ mode: "default" })).status).toBe(400); // default needs an agent
      expect((await setMode({ mode: "active", peer_id: c.id })).status).toBe(400); // not a desktop session
      expect(
        (
          await fetch(`${HTTP}/wake-mode`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ mode: "passive" }),
          })
        ).status,
      ).toBe(401);
      expect((await status()).global).toBe("active");
    });
  });
});

describe("cli desktop-wake", () => {
  const run = async (...args: string[]) => {
    const p = Bun.spawn(["bun", `${ROOT}/cli.ts`, "desktop-wake", ...args], {
      env: { ...process.env, CLAUDE_PEERS_PORT: String(PORT), CLAUDE_PEERS_DB: DB },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([
      p.exited,
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    return { code, out, err };
  };
  const desk = async (summary: string, token: string) =>
    (
      await post<{ id: string }>("/register", {
        pid: process.pid,
        cwd: `/tmp/${summary}`,
        git_root: null,
        tty: null,
        summary,
        peer_type: "desktop",
        session_token: token,
      })
    ).id;

  test("sets one agent by a unique part of its summary, then back to the global mode", async () => {
    const id = await desk("Quokka wake agent", "cs_cliwake_quokka1");
    const on = await run("active", "quokka");
    expect(on.code).toBe(0);
    expect(on.out).toMatch(new RegExp(`${id}\\s+active\\*`));
    const back = await run("default", id);
    expect(back.code).toBe(0);
    expect(back.out).not.toMatch(new RegExp(`${id}\\s+\\w+\\*`));
  });

  test("refuses a name that matches several agents, or none", async () => {
    await desk("Wombat wake agent one", "cs_cliwake_wombat1");
    await desk("Wombat wake agent two", "cs_cliwake_wombat2");
    const many = await run("active", "wombat");
    expect(many.code).toBe(1);
    expect(many.err).toContain('"wombat" matches 2 Desktop sessions');
    const none = await run("active", "no-such-agent-xyz");
    expect(none.code).toBe(1);
    expect(none.err).toContain('No Desktop session matches "no-such-agent-xyz"');
  });

  test("an unknown mode, or default without an agent, prints usage and exits 1", async () => {
    for (const args of [["bogus"], ["default"]]) {
      const r = await run(...args);
      expect(r.code).toBe(1);
      expect(r.err).toContain("Usage: bun cli.ts desktop-wake");
    }
  });
});
