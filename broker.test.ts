import { test, expect, describe, beforeAll, afterAll } from "bun:test";

// Spawn a real broker on a private port + temp DB and exercise the
// /watch WebSocket feed end to end: subscribe, send, receive, and confirm the
// message is NOT acked by the wake (still peekable).
const PORT = 7899 + 1000 + Math.floor(Math.random() * 500);
const HTTP = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}`;
const DB = `${import.meta.dir}/.test-broker-${PORT}.db`;

let proc: ReturnType<typeof Bun.spawn>;

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${HTTP}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<T>;
}

// cleanStalePeers runs on broker startup, so a restart against the same DB is
// the deterministic way to trigger the stale-peer sweep. The other trigger is a
// 30s interval, which is too slow for a test.
async function restartBroker() {
  proc.kill();
  await proc.exited;
  await Bun.sleep(200); // Give port time to be released by OS
  proc = Bun.spawn(["bun", `${import.meta.dir}/broker.ts`], {
    env: { ...process.env, CLAUDE_PEERS_PORT: String(PORT), CLAUDE_PEERS_DB: DB },
    stdout: "ignore", stderr: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    // If the new process already died (e.g. EADDRINUSE because the OS hadn't
    // released the port yet), no amount of /health polling will ever succeed.
    // Fail fast with the real cause instead of burning the full timeout.
    if (proc.exitCode !== null) {
      throw new Error("broker failed to bind on restart (port not released?)");
    }
    try { if ((await fetch(`${HTTP}/health`)).ok) return; } catch {}
    await Bun.sleep(100);
  }
  throw new Error("broker did not restart");
}

// CLI registrations dedupe by PID, and the broker reaps PIDs that aren't
// alive, so each fake peer needs its own live-looking PID. Use ours for the
// first and its parent for the second: both are alive for the test's lifetime.
const LIVE_PIDS = [process.pid, process.ppid];
let pidCursor = 0;

async function register(summary: string, peer_type: "cli" | "desktop"): Promise<string> {
  const r = await post<{ id: string }>("/register", {
    pid: LIVE_PIDS[pidCursor++ % LIVE_PIDS.length], cwd: `/tmp/${summary}`, git_root: null, tty: null, summary, peer_type,
  });
  return r.id;
}

function connectWatch(peerId: string): Promise<{ ws: WebSocket; frames: unknown[]; next: () => Promise<unknown> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS}/watch/${peerId}`);
    const frames: unknown[] = [];
    const waiters: Array<(f: unknown) => void> = [];
    ws.onmessage = (ev) => {
      const f = JSON.parse(String(ev.data));
      const w = waiters.shift();
      if (w) w(f); else frames.push(f);
    };
    ws.onerror = (e) => reject(e);
    ws.onopen = () => resolve({
      ws, frames,
      next: () => frames.length ? Promise.resolve(frames.shift()) : new Promise((r) => waiters.push(r)),
    });
  });
}

beforeAll(async () => {
  proc = Bun.spawn(["bun", `${import.meta.dir}/broker.ts`], {
    env: { ...process.env, CLAUDE_PEERS_PORT: String(PORT), CLAUDE_PEERS_DB: DB },
    stdout: "ignore", stderr: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${HTTP}/health`)).ok) return; } catch {}
    await Bun.sleep(100);
  }
  throw new Error("broker did not start");
});

afterAll(async () => {
  proc.kill();
  for (const suffix of ["", "-wal", "-shm"]) {
    try { await Bun.file(DB + suffix).delete(); } catch {}
  }
});

describe("broker /watch WebSocket feed", () => {
  test("pushes a wake frame on send-message without acking it", async () => {
    const finance = await register("Finance agent", "desktop");
    const cos = await register("Chief of staff", "cli");

    const w = await connectWatch(finance);
    expect(await w.next()).toEqual({ type: "watching", peer: finance });

    const send = await post<{ ok: boolean; woke: number }>("/send-message", {
      from_id: cos, to_id: finance, text: "pull Q3 burn",
    });
    expect(send).toMatchObject({ ok: true, woke: 1, target_type: "desktop" });

    const frame = (await w.next()) as Record<string, unknown>;
    expect(frame).toMatchObject({
      type: "peer_message", from_id: cos, from_summary: "Chief of staff", text: "pull Q3 burn",
    });
    expect(typeof frame.id).toBe("number");

    // Wake is not delivery: message is still undelivered for check_messages.
    const peek = await post<{ messages: Array<{ id: number; delivered: number }> }>("/peek-messages", { id: finance });
    expect(peek.messages).toHaveLength(1);
    expect(peek.messages[0]!.delivered).toBe(0);
    expect(peek.messages[0]!.id).toBe(frame.id as number);

    w.ws.close();
  });

  test("woke=0 when nobody is watching; watcher gets nothing for other peers", async () => {
    const a = await register("A", "cli");
    const b = await register("B", "cli");
    const w = await connectWatch(a);
    await w.next(); // watching handshake

    const send = await post<{ ok: boolean; woke: number }>("/send-message", { from_id: a, to_id: b, text: "to b" });
    expect(send.woke).toBe(0);
    await Bun.sleep(100);
    expect(w.frames).toHaveLength(0);
    w.ws.close();
  });

  test("desktop peers keyed by session_token keep their id across server processes", async () => {
    const reg = (pid: number, summary: string) => post<{ id: string; restored_summary?: string }>("/register", {
      pid, cwd: "cs_tok1", git_root: null, tty: null, summary, peer_type: "desktop", session_token: "cs_tok1",
    });
    const first = await reg(LIVE_PIDS[0]!, "Finance agent");
    // A different MCP server process (different pid) re-registers the same token
    // with an empty summary — same id, and the summary the session set survives.
    const second = await reg(LIVE_PIDS[1]!, "");
    expect(second.id).toBe(first.id);
    expect(second.restored_summary).toBe("Finance agent");
    // Same token with a new summary updates in place, still same id.
    const third = await reg(LIVE_PIDS[0]!, "Finance agent — closing Q3");
    expect(third.id).toBe(first.id);
    const peers = await post<Array<{ id: string; summary: string }>>("/list-peers", { scope: "machine", cwd: "/", git_root: null });
    expect(peers.filter((p) => p.id === first.id)).toHaveLength(1);
    expect(peers.find((p) => p.id === first.id)!.summary).toBe("Finance agent — closing Q3");
  });

  test("a reaped desktop peer resurrects under its original id with mail intact", async () => {
    const reg = () => post<{ id: string }>("/register", {
      pid: LIVE_PIDS[0]!, cwd: "cs_resur", git_root: null, tty: null, summary: "PM agent", peer_type: "desktop", session_token: "cs_resur",
    });
    const first = await reg();
    const sender = await register("Sender", "cli");
    await post("/send-message", { from_id: sender, to_id: first.id, text: "while you were out" });
    // Simulate heartbeat expiry: the peers row is deleted (as cleanStalePeers
    // does), but messages and the token mapping remain.
    await post("/unregister", { id: first.id });
    // Session comes back, same token -> SAME id, queued mail still addressed to it.
    const back = await reg();
    expect(back.id).toBe(first.id);
    const peek = await post<{ messages: Array<{ text: string }> }>("/peek-messages", { id: back.id });
    expect(peek.messages.map((m) => m.text)).toContain("while you were out");
  });

  test("cli re-register with the same pid keeps the same id", async () => {
    const reg = (summary: string) => post<{ id: string }>("/register", {
      pid: LIVE_PIDS[1]!, cwd: "/tmp/cli-stable", git_root: null, tty: "ttys099", summary, peer_type: "cli",
    });
    const a = await reg("QA agent");
    const b = await reg(""); // MCP server respawned by /mcp reconnect
    expect(b.id).toBe(a.id);
  });

  test("cli peers keyed by session_key keep their id across pid changes", async () => {
    const reg = (pid: number, summary: string) => post<{ id: string; restored_summary?: string }>("/register", {
      pid, cwd: "/tmp/cli-sess", git_root: null, tty: "ttys100", summary,
      peer_type: "cli", session_key: "sess-aaaa-1111",
    });
    const first = await reg(LIVE_PIDS[0]!, "CA1");
    // Same session, restarted: a DIFFERENT pid, same session_key.
    const second = await reg(LIVE_PIDS[1]!, "");
    expect(second.id).toBe(first.id);
    expect(second.restored_summary).toBe("CA1");
  });

  test("a pre-upgrade CLI peer (no session_key) is ADOPTED, not duplicated, once it starts sending one", async () => {
    // Fresh, never-before-used pid: a spawned "sleep" gives an alive pid this
    // test owns exclusively, so this doesn't collide with pid state any other
    // test in this file left behind on LIVE_PIDS.
    const doomed = Bun.spawn(["sleep", "30"]);
    const pid = doomed.pid;
    const restarted = Bun.spawn(["sleep", "30"]);
    try {
      // Simulates every existing session at the moment this fix lands: a
      // peers row keyed on pid alone, no peer_sessions mapping at all.
      const before = await post<{ id: string }>("/register", {
        pid, cwd: "/tmp/upgrade-cli", git_root: null, tty: null,
        summary: "Pre-upgrade agent", peer_type: "cli",
      });
      const sender = await register("Sender", "cli");
      await post("/send-message", { from_id: sender, to_id: before.id, text: "queued before upgrade" });

      // The upgraded server reconnects: SAME pid, but now sends a session_key
      // for the first time. It must adopt the existing peer, not mint a new one.
      const after = await post<{ id: string }>("/register", {
        pid, cwd: "/tmp/upgrade-cli", git_root: null, tty: null,
        summary: "", peer_type: "cli", session_key: "sess-upgrade-adopt-1",
      });

      expect(after.id).toBe(before.id);

      const peek = await post<{ messages: Array<{ text: string }> }>("/peek-messages", { id: after.id });
      expect(peek.messages.map((m) => m.text)).toContain("queued before upgrade");

      // The assertions above also hold on a broker that ignores session_key
      // entirely (same pid -> same id). What proves the adoption RECORDED the
      // key -> id mapping is a later registration that can only resolve by
      // key: same session_key, a different pid.
      const later = await post<{ id: string }>("/register", {
        pid: restarted.pid, cwd: "/tmp/upgrade-cli", git_root: null, tty: null,
        summary: "", peer_type: "cli", session_key: "sess-upgrade-adopt-1",
      });
      expect(later.id).toBe(before.id);
    } finally {
      doomed.kill();
      restarted.kill();
      await doomed.exited;
      await restarted.exited;
    }
  });

  test("a reaped cli peer resurrects under its original id with its cached summary restored", async () => {
    const reg = (summary: string) => post<{ id: string; restored_summary?: string }>("/register", {
      pid: LIVE_PIDS[0]!, cwd: "/tmp/cli-resur", git_root: null, tty: "ttys102", summary,
      peer_type: "cli", session_key: "sess-resur-1",
    });
    const first = await reg("Ops agent");
    // Simulate heartbeat expiry: the peers row is deleted (as cleanStalePeers
    // does), but peer_sessions and the workspace summary cache remain.
    await post("/unregister", { id: first.id });
    // Session comes back, same session_key, no summary supplied -> SAME id,
    // and the cached summary comes back rather than a blank one.
    const back = await reg("");
    expect(back.id).toBe(first.id);
    expect(back.restored_summary).toBe("Ops agent");
    const peers = await post<Array<{ id: string; summary: string }>>("/list-peers", { scope: "machine", cwd: "/", git_root: null });
    expect(peers.find((p) => p.id === first.id)!.summary).toBe("Ops agent");
  });

  test("mail for a dead-pid peer survives the stale-peer sweep", async () => {
    const doomed = Bun.spawn(["sleep", "30"]);
    const deadPid = doomed.pid;

    const victim = await post<{ id: string }>("/register", {
      pid: deadPid, cwd: "/tmp/dead-cli", git_root: null, tty: null,
      summary: "About to die", peer_type: "cli", session_key: "sess-dead-9999",
    });
    const sender = await register("Sender", "cli");
    await post("/send-message", { from_id: sender, to_id: victim.id, text: "answer you missed" });

    doomed.kill();
    await doomed.exited;
    await restartBroker();

    const peek = await post<{ messages: Array<{ text: string }> }>("/peek-messages", { id: victim.id });
    expect(peek.messages.map((m) => m.text)).toContain("answer you missed");
  });

  test("a restarted CLI session still reads mail sent before it died", async () => {
    const KEY = "sess-restart-4242";
    const doomed = Bun.spawn(["sleep", "30"]);
    const deadPid = doomed.pid;

    // Session registers and is alive.
    const before = await post<{ id: string }>("/register", {
      pid: deadPid, cwd: "/tmp/restart", git_root: null, tty: "ttys200",
      summary: "CA1", peer_type: "cli", session_key: KEY,
    });

    // Someone answers it WHILE IT IS STILL ALIVE. This is the only case there
    // is to test: handleSendMessage refuses any send whose to_id has no peers
    // row ("stale or expired ID"), and cleanStalePeers deletes that row within
    // ~30s of the pid dying, so nothing can be queued for this peer again
    // until it re-registers. The guarantee this test proves is narrower than
    // its old name claimed — mail sent before death survives death, not that
    // mail can be queued for a peer that is already gone.
    const sender = await register("COS", "cli");
    await post("/send-message", { from_id: sender, to_id: before.id, text: "yes, ship it" });

    // The session dies and the stale-peer sweep runs (see Task 4: a restart is
    // what actually triggers cleanStalePeers).
    doomed.kill();
    await doomed.exited;
    await restartBroker();

    // It comes back: same session_key, brand new pid.
    const after = await post<{ id: string }>("/register", {
      pid: LIVE_PIDS[0]!, cwd: "/tmp/restart", git_root: null, tty: "ttys201",
      summary: "", peer_type: "cli", session_key: KEY,
    });

    expect(after.id).toBe(before.id);

    const peek = await post<{ messages: Array<{ text: string }> }>("/peek-messages", { id: after.id });
    expect(peek.messages.map((m) => m.text)).toContain("yes, ship it");
  });

  test("list-peers hides a dead-pid peer without destroying its identity", async () => {
    const doomed = Bun.spawn(["sleep", "30"]);
    const deadPid = doomed.pid;
    const KEY = "sess-listreap-7777";

    const before = await post<{ id: string }>("/register", {
      pid: deadPid, cwd: "/tmp/listreap", git_root: null, tty: null,
      summary: "Reaped by listing", peer_type: "cli", session_key: KEY,
    });
    doomed.kill();
    await doomed.exited;

    const listed = await post<Array<{ id: string }>>("/list-peers", { scope: "machine", cwd: "/", git_root: null });
    expect(listed.some((p) => p.id === before.id)).toBe(false);

    // The listing must not have cost the session its identity.
    const after = await post<{ id: string }>("/register", {
      pid: LIVE_PIDS[0]!, cwd: "/tmp/listreap", git_root: null, tty: null,
      summary: "", peer_type: "cli", session_key: KEY,
    });
    expect(after.id).toBe(before.id);
  });

  test("heartbeat refreshes the peer_sessions mapping, keeping it alive past what would be its expiry", async () => {
    // cleanStalePeers sweeps peer_sessions rows older than 30 days. A session
    // that registers once and then just heartbeats for longer than that must
    // not have its mapping swept out from under it. We don't fake 30 days;
    // instead we assert the mechanism the sweep depends on directly:
    // handleHeartbeat must advance peer_sessions.updated_at, keyed on peer_id
    // (not the primary key session_key). If that write is missing, this
    // assertion fails regardless of how the 30-day sweep itself behaves.
    //
    // A second, idle peer guards the other direction: an UPDATE missing its
    // WHERE clause would refresh every mapping, pass the first assertion, and
    // silently defeat the TTL. Fresh pids keep both registrations off the
    // pid-adoption path, so they are guaranteed to be two distinct peers.
    const KEY = "sess-heartbeat-refresh-1";
    const IDLE_KEY = "sess-heartbeat-idle-1";
    const busyProc = Bun.spawn(["sleep", "30"]);
    const idleProc = Bun.spawn(["sleep", "30"]);

    const { Database } = await import("bun:sqlite");
    const readDb = new Database(DB, { readonly: true });
    const updatedAt = (key: string) =>
      new Date((readDb.query("SELECT updated_at FROM peer_sessions WHERE session_key = ?").get(key) as { updated_at: string }).updated_at).getTime();
    try {
      const reg = await post<{ id: string }>("/register", {
        pid: busyProc.pid, cwd: "/tmp/heartbeat-refresh", git_root: null, tty: null,
        summary: "Heartbeating agent", peer_type: "cli", session_key: KEY,
      });
      const idle = await post<{ id: string }>("/register", {
        pid: idleProc.pid, cwd: "/tmp/heartbeat-idle", git_root: null, tty: null,
        summary: "Idle agent", peer_type: "cli", session_key: IDLE_KEY,
      });
      expect(idle.id).not.toBe(reg.id);

      const before = updatedAt(KEY);
      const idleBefore = updatedAt(IDLE_KEY);

      // Ensure the next timestamp is measurably later (ISO strings are
      // millisecond-resolution) before heartbeating.
      await Bun.sleep(20);
      await post("/heartbeat", { id: reg.id });

      expect(updatedAt(KEY)).toBeGreaterThan(before);
      expect(updatedAt(IDLE_KEY)).toBe(idleBefore);
    } finally {
      readDb.close();
      busyProc.kill();
      idleProc.kill();
      await busyProc.exited;
      await idleProc.exited;
    }
  });

  test("rejects browser upgrades (Origin header present)", async () => {
    const res = await fetch(`${HTTP}/watch/anyone`, {
      headers: {
        origin: "http://evil.example",
        connection: "Upgrade", upgrade: "websocket",
        "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    expect(res.status).toBe(403);
  });

  test("migration: INSERT OR IGNORE copies desktop_tokens to peer_sessions at startup", async () => {
    // This test ONLY exercises the startup migration (INSERT OR IGNORE ... FROM desktop_tokens),
    // not the handleRegister write path. It spawns a separate broker against a pre-seeded DB.
    const MIGRATION_TEST_PORT = PORT + 100;
    const MIGRATION_TEST_DB = `${import.meta.dir}/.test-broker-migration-${MIGRATION_TEST_PORT}.db`;
    const MIGRATION_TEST_HTTP = `http://127.0.0.1:${MIGRATION_TEST_PORT}`;

    async function migrationPost<T>(path: string, body: unknown): Promise<T> {
      const res = await fetch(`${MIGRATION_TEST_HTTP}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return res.json() as Promise<T>;
    }

    // Step 1: Seed a temp DB with a desktop_tokens row (no peer_sessions table yet)
    const { Database } = await import("bun:sqlite");
    const seedDb = new Database(MIGRATION_TEST_DB);
    seedDb.run(`
      CREATE TABLE desktop_tokens (
        token TEXT PRIMARY KEY,
        peer_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    const seedTime = new Date().toISOString();
    seedDb.run(`
      INSERT INTO desktop_tokens (token, peer_id, updated_at)
      VALUES (?, ?, ?)
    `, ["mig_test_token", "mig_peer_xyz", seedTime]);
    seedDb.close();

    let migProc: ReturnType<typeof Bun.spawn> | null = null;

    try {
      // Step 2: Spawn a broker against this seeded DB
      migProc = Bun.spawn(["bun", `${import.meta.dir}/broker.ts`], {
        env: { ...process.env, CLAUDE_PEERS_PORT: String(MIGRATION_TEST_PORT), CLAUDE_PEERS_DB: MIGRATION_TEST_DB },
        stdout: "ignore", stderr: "ignore",
      });

      // Step 3: Wait for startup
      let started = false;
      for (let i = 0; i < 50; i++) {
        try { if ((await fetch(`${MIGRATION_TEST_HTTP}/health`)).ok) { started = true; break; } } catch {}
        await Bun.sleep(100);
      }
      if (!started) throw new Error("Migration broker did not start");

      // Step 4: Verify migration copied the row, through the public surface.
      // The seed above only creates desktop_tokens. peer_sessions is
      // deliberately ABSENT from the seed — it does not exist until the
      // startup migration creates it and copies this row into it. (Do not
      // "helpfully" pre-seed peer_sessions here: that would make this test
      // pass without the migration ever running.) So a CLI registration keyed
      // to the migrated session_key can only get mig_peer_xyz back by reading
      // it out of peer_sessions — the same table the startup migration writes
      // into. No peers row exists yet for mig_peer_xyz either, so this first
      // call also exercises the CLI resurrection branch of handleRegister
      // (mapped session_key, no live peer row).
      const reg1 = await migrationPost<{ id: string }>("/register", {
        pid: process.pid, cwd: "/tmp/mig", git_root: null, tty: null,
        summary: "", peer_type: "cli", session_key: "mig_test_token",
      });
      expect(reg1.id).toBe("mig_peer_xyz");

      // Step 5: Test idempotency - kill first broker and wait for it to exit
      migProc.kill();
      await migProc.exited; // Deterministically wait for process to actually exit
      await Bun.sleep(200); // Give port time to be released by OS

      // Step 5b: Spawn second broker on same port
      migProc = Bun.spawn(["bun", `${import.meta.dir}/broker.ts`], {
        env: { ...process.env, CLAUDE_PEERS_PORT: String(MIGRATION_TEST_PORT), CLAUDE_PEERS_DB: MIGRATION_TEST_DB },
        stdout: "ignore", stderr: "ignore",
      });

      // Step 6: Wait for restart
      let restarted = false;
      for (let i = 0; i < 50; i++) {
        try { if ((await fetch(`${MIGRATION_TEST_HTTP}/health`)).ok) { restarted = true; break; } } catch {}
        await Bun.sleep(100);
      }
      if (!restarted) throw new Error("Migration broker (restart) did not start");

      // Re-running the migration on restart must not disturb the mapping:
      // the same session_key still resolves to the same peer_id, no error.
      // Note this second call takes the LIVE branch, NOT resurrection: reg1
      // above inserted a peers row under pid=process.pid, which is this test
      // process itself and stays alive across the restart, so cleanStalePeers
      // never reaps it. What this half proves is that peer_sessions still
      // holds the right mapping after a second migration run, not a second
      // pass through the resurrection branch.
      const reg2 = await migrationPost<{ id: string }>("/register", {
        pid: process.pid, cwd: "/tmp/mig", git_root: null, tty: null,
        summary: "", peer_type: "cli", session_key: "mig_test_token",
      });
      expect(reg2.id).toBe("mig_peer_xyz");

    } finally {
      // Cleanup - guaranteed to run even if assertions fail
      if (migProc) {
        try { migProc.kill(); } catch {}
        try { await migProc.exited; } catch {} // Wait for process to actually exit
      }
      // Delete temp files - only after process is truly gone
      for (const suffix of ["", "-wal", "-shm"]) {
        const filePath = MIGRATION_TEST_DB + suffix;
        try { await Bun.file(filePath).delete(); } catch {} // Missing file is OK
      }
    }
  });
});

// A SessionStart hook posts the live session id plus its ancestor pids. The
// broker finds the CLI peer owned by that process and, when the live session
// already owns a different id (in-session /resume), moves the row onto it.
describe("/session-start", () => {
  type SSRes = { ok: boolean; peer_id?: string; action?: string; reason?: string };
  const sleepers: ReturnType<typeof Bun.spawn>[] = [];
  const livePid = () => { const p = Bun.spawn(["sleep", "30"]); sleepers.push(p); return p.pid; };
  const regCli = (pid: number, session_key: string, summary = "") => post<{ id: string }>("/register", {
    pid, cwd: "/tmp/ss", git_root: null, tty: null, summary, peer_type: "cli", session_key,
  }).then((r) => r.id);
  const ss = (body: unknown) => post<SSRes>("/session-start", body);
  const machine = () => post<Array<{ id: string; pid: number }>>("/list-peers", { scope: "machine", cwd: "/", git_root: null });

  afterAll(() => { for (const p of sleepers) { try { p.kill(); } catch {} } });

  test("no live peer: no rows created", async () => {
    const before = (await machine()).length;
    const r = await ss({ session_key: "ss-none", pids: [livePid()], source: "startup" });
    expect(r).toEqual({ ok: false, reason: "no_live_peer" });
    expect((await machine()).length).toBe(before);
  });

  test("unmapped key is mapped to the live peer", async () => {
    const pid = livePid();
    const id = await regCli(pid, "ss-launch-m");
    const r = await ss({ session_key: "ss-fresh-m", pids: [pid], source: "clear" });
    expect(r).toEqual({ ok: true, peer_id: id, action: "mapped" });
    // A later process registering under the new key gets the same id back.
    expect(await regCli(livePid(), "ss-fresh-m")).toBe(id);
  });

  test("same key is a noop", async () => {
    const pid = livePid();
    const id = await regCli(pid, "ss-noop");
    expect(await ss({ session_key: "ss-noop", pids: [pid], source: "startup" }))
      .toEqual({ ok: true, peer_id: id, action: "noop" });
  });

  test("resume rekeys the live process onto the session's original id", async () => {
    const idA = await regCli(livePid(), "ss-orig-r");
    await post("/unregister", { id: idA }); // original process gone; mapping kept
    const pidB = livePid();
    const idB = await regCli(pidB, "ss-launch-r");
    expect(idB).not.toBe(idA);

    const r = await ss({ session_key: "ss-orig-r", pids: [pidB], source: "resume" });
    expect(r).toEqual({ ok: true, peer_id: idA, action: "rekeyed" });
    const peers = await machine();
    expect(peers.find((p) => p.id === idA)?.pid).toBe(pidB);
    expect(peers.some((p) => p.id === idB)).toBe(false);
  });

  test("rekey re-addresses undelivered mail", async () => {
    const idA = await regCli(livePid(), "ss-orig-mail");
    await post("/unregister", { id: idA });
    const pidB = livePid();
    const idB = await regCli(pidB, "ss-launch-mail");
    const sender = await register("SS sender", "cli");
    await post("/send-message", { from_id: sender, to_id: idB, text: "sent to the launch id" });

    await ss({ session_key: "ss-orig-mail", pids: [pidB], source: "resume" });
    const peek = await post<{ messages: Array<{ text: string }> }>("/peek-messages", { id: idA });
    expect(peek.messages.map((m) => m.text)).toContain("sent to the launch id");
  });

  test("launch key resolves to the reclaimed id after rekey", async () => {
    const idA = await regCli(livePid(), "ss-orig-l");
    await post("/unregister", { id: idA });
    const pidB = livePid();
    await regCli(pidB, "ss-launch-l");
    await ss({ session_key: "ss-orig-l", pids: [pidB], source: "resume" });
    // What the MCP server's ensureRegistered does on its next heartbeat.
    expect(await regCli(pidB, "ss-launch-l")).toBe(idA);
  });

  test("conflict when the session's peer is live under another live pid", async () => {
    const idA = await regCli(livePid(), "ss-orig-c");
    const pidB = livePid();
    const idB = await regCli(pidB, "ss-launch-c");
    expect(await ss({ session_key: "ss-orig-c", pids: [pidB], source: "resume" }))
      .toEqual({ ok: false, reason: "conflict" });
    const ids = (await machine()).map((p) => p.id);
    expect(ids).toContain(idA);
    expect(ids).toContain(idB);
  });

  test("desktop rows are never matched", async () => {
    const pid = livePid();
    await post("/register", {
      pid, cwd: "cs_ss_desktop", git_root: null, tty: null, summary: "", peer_type: "desktop", session_token: "cs_ss_desktop",
    });
    expect(await ss({ session_key: "ss-desk", pids: [pid], source: "startup" }))
      .toEqual({ ok: false, reason: "no_live_peer" });
  });

  test("malformed body → bad_request", async () => {
    expect(await ss({})).toEqual({ ok: false, reason: "bad_request" });
    expect(await ss({ session_key: "x", pids: [] })).toEqual({ ok: false, reason: "bad_request" });
  });
  // SE condition (3): pids get reused, so a pid match alone must not hand a
  // new process someone else's identity. Rows record the process start time.
  const { Database } = require("bun:sqlite");
  const setStarted = (id: string, v: string | null) => {
    const d = new Database(DB); d.run("UPDATE peers SET pid_started = ? WHERE id = ?", [v, id]); d.close();
  };
  const startedOf = (pid: number) => new TextDecoder().decode(Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)]).stdout).trim();

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
    const old = await post<{ id: string }>("/register", { pid, cwd: "/tmp/reuse", git_root: null, tty: null, summary: "", peer_type: "cli" });
    setStarted(old.id, "Mon Jan  1 00:00:00 2001");
    const again = await post<{ id: string }>("/register", { pid, cwd: "/tmp/reuse", git_root: null, tty: null, summary: "", peer_type: "cli" });
    expect(again.id).not.toBe(old.id);
  });

  test("session-start ignores a row whose recorded start time differs", async () => {
    const pid = livePid();
    const id = await regCli(pid, "ss-reuse");
    setStarted(id, "Mon Jan  1 00:00:00 2001");
    expect(await ss({ session_key: "ss-reuse-new", pids: [pid], source: "resume" }))
      .toEqual({ ok: false, reason: "no_live_peer" });
  });

  test("rows with no recorded start time (pre-upgrade) still match", async () => {
    const pid = livePid();
    const id = await regCli(pid, "ss-legacy");
    setStarted(id, null);
    expect(await ss({ session_key: "ss-legacy-new", pids: [pid], source: "clear" }))
      .toEqual({ ok: true, peer_id: id, action: "mapped" });
  });

  test("an owner whose pid is alive but reused is not a conflict", async () => {
    const idA = await regCli(livePid(), "ss-orig-u");
    setStarted(idA, "Mon Jan  1 00:00:00 2001");
    const pidB = livePid();
    await regCli(pidB, "ss-launch-u");
    expect(await ss({ session_key: "ss-orig-u", pids: [pidB], source: "resume" }))
      .toEqual({ ok: true, peer_id: idA, action: "rekeyed" });
  });
});
