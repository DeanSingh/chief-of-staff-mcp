import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { statSync } from "node:fs";
import { peerSecret, readSecret, secretPath, PEER_HEADER } from "./shared/auth.ts";

// Spawn a real broker on a private port + temp DB and exercise the
// /watch WebSocket feed end to end: subscribe, send, receive, and confirm the
// message is NOT acked by the wake (still peekable).
const PORT = 7899 + 1000 + Math.floor(Math.random() * 500);
const HTTP = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}`;
const DB = `${import.meta.dir}/.test-broker-${PORT}.db`;

let proc: ReturnType<typeof Bun.spawn>;

// Stand-in for the wake relay (ntfy). Records every publish; can be told to
// hang so a test can prove /send-message never waits on it.
const relayHits: Array<{ path: string; body: string }> = [];
let relayHang = false;
let relayStatus = 200;
const relay = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  async fetch(req) {
    relayHits.push({ path: new URL(req.url).pathname, body: await req.text() });
    if (relayHang) return new Promise<Response>(() => {});
    return new Response("ok", { status: relayStatus });
  },
});
const BROKER_ENV = {
  ...process.env, CLAUDE_PEERS_PORT: String(PORT), CLAUDE_PEERS_DB: DB, LC_ALL: "fr_FR.UTF-8", TZ: "Asia/Tokyo",
  CLAUDE_PEERS_WAKE_RELAY: `http://127.0.0.1:${relay.port}`, CLAUDE_PEERS_WAKE_COALESCE_MS: "1000",
};

// Every POST carries the install secret, and peer-scoped routes carry the
// credential for the id they act as, the way server.ts sends them. Tests that
// probe the gate itself use raw fetch.
const SUBJECT: Record<string, string> = {
  "/send-message": "from_id", "/heartbeat": "id", "/set-summary": "id", "/poll-messages": "id",
  "/peek-messages": "id", "/ack-messages": "id", "/unregister": "id",
};
function headersFor(db: string, path: string, body: unknown): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  const secret = readSecret(secretPath(db));
  if (!secret) return h;
  h.authorization = `Bearer ${secret}`;
  const id = (body as Record<string, unknown> | null)?.[SUBJECT[path] ?? ""];
  if (typeof id === "string") h[PEER_HEADER] = peerSecret(secret, id);
  return h;
}

async function postTo<T>(http: string, db: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${http}${path}`, { method: "POST", headers: headersFor(db, path, body), body: JSON.stringify(body) });
  return res.json() as Promise<T>;
}
const post = <T>(path: string, body: unknown) => postTo<T>(HTTP, DB, path, body);

// cleanStalePeers runs on broker startup, so a restart against the same DB is
// the deterministic way to trigger the stale-peer sweep. The other trigger is a
// 30s interval, which is too slow for a test.
async function restartBroker() {
  proc.kill();
  await proc.exited;
  await Bun.sleep(200); // Give port time to be released by OS
  proc = Bun.spawn(["bun", `${import.meta.dir}/broker.ts`], {
    env: BROKER_ENV,
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

// Upgrades with the install secret and the peer's credential, the way
// `bun cli.ts watch` does.
function watchHeaders(peerId: string): Record<string, string> {
  const secret = readSecret(secretPath(DB))!;
  return { authorization: `Bearer ${secret}`, [PEER_HEADER]: peerSecret(secret, peerId) };
}

function connectWatch(peerId: string, headers = watchHeaders(peerId)): Promise<{ ws: WebSocket; frames: unknown[]; next: () => Promise<unknown> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS}/watch/${peerId}`, { headers });
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
    env: BROKER_ENV,
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
  relay.stop(true);
  for (const suffix of ["", "-wal", "-shm", ".secret"]) {
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

    // The frame is only a wake: no text, sender or id.
    expect(await w.next()).toEqual({ type: "wake" });

    // Wake is not delivery: message is still undelivered for check_messages.
    const peek = await post<{ messages: Array<{ text: string; delivered: number }> }>("/peek-messages", { id: finance });
    expect(peek.messages).toHaveLength(1);
    expect(peek.messages[0]!.delivered).toBe(0);
    expect(peek.messages[0]!.text).toBe("pull Q3 burn");

    w.ws.close();
  });

  // An id is not a secret: it shows up in transcripts, peer messages and argv.
  // Knowing one must not be enough to subscribe to that peer's feed.
  async function upgrade(peerId: string, headers: Record<string, string>): Promise<number> {
    const res = await fetch(`${HTTP}/watch/${peerId}`, {
      headers: {
        ...headers,
        connection: "Upgrade", upgrade: "websocket",
        "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    return res.status;
  }

  test("refuses an upgrade without the install secret", async () => {
    const victim = await register("victim", "cli");
    expect(await upgrade(victim, {})).toBe(401);
    expect(await upgrade(victim, { ...watchHeaders(victim), authorization: "Bearer wrong" })).toBe(401);
  });

  test("refuses an upgrade without the watched peer's own credential", async () => {
    const victim = await register("victim", "cli");
    const other = await register("other", "cli");
    const authorization = watchHeaders(victim).authorization!;
    expect(await upgrade(victim, { authorization })).toBe(403);
    // Another peer's valid credential doesn't open this peer's feed.
    expect(await upgrade(victim, { authorization, [PEER_HEADER]: watchHeaders(other)[PEER_HEADER]! })).toBe(403);
  });

  // `bun cli.ts watch` as a Monitor: a refusal must end it with the reason,
  // not loop silently reconnecting forever.
  function cliWatch(peerId: string, db: string) {
    return Bun.spawn(["bun", `${import.meta.dir}/cli.ts`, "watch", peerId], {
      env: { ...process.env, CLAUDE_PEERS_PORT: String(PORT), CLAUDE_PEERS_DB: db },
      stdout: "pipe", stderr: "pipe",
    });
  }

  test("cli watch exits with the reason when the broker refuses its credentials", async () => {
    const victim = await register("victim", "cli");
    const otherDb = `${DB}-other`;
    await Bun.write(secretPath(otherDb), "not-this-brokers-secret\n");
    try {
      const watch = cliWatch(victim, otherDb);
      const timer = setTimeout(() => watch.kill(), 3000);
      expect(await watch.exited).toBe(1);
      clearTimeout(timer);
      expect(await new Response(watch.stderr).text()).toContain("missing or wrong broker secret");
    } finally {
      await Bun.file(secretPath(otherDb)).delete();
    }
  }, 10_000);

  test("cli watch with the right credentials stays up and prints a wake line", async () => {
    const target = await register("watched", "cli");
    const sender = await register("sender", "cli");
    const watch = cliWatch(target, DB);
    try {
      await Bun.sleep(500); // preflight + subscribe
      expect(watch.exitCode).toBeNull();
      await post("/send-message", { from_id: sender, to_id: target, text: "hello" });
      const reader = (watch.stdout as ReadableStream<Uint8Array>).getReader();
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value)).toBe("[claude-peers] new peer message: call check_messages to read it\n");
    } finally {
      watch.kill();
    }
  });

  test("an uncredentialed watcher never sees message text", async () => {
    const victim = await register("victim", "cli");
    const sender = await register("sender", "cli");
    const frames: string[] = [];
    const ws = new WebSocket(`${WS}/watch/${victim}`);
    ws.onmessage = (ev) => frames.push(String(ev.data));
    ws.onerror = () => {};
    await Bun.sleep(200); // refused, or (if the gate were open) subscribed
    await post("/send-message", { from_id: sender, to_id: victim, text: "secret plans" });
    await Bun.sleep(100);
    ws.close();
    expect(frames.join("")).not.toContain("secret plans");
    expect(frames).toHaveLength(0);
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

  test("heartbeat for a reaped peer says not found, so its server can re-register it", async () => {
    const reg = () => post<{ id: string }>("/register", {
      pid: LIVE_PIDS[0]!, cwd: "cs_beat", git_root: null, tty: null, summary: "", peer_type: "desktop", session_token: "cs_beat",
    });
    const first = await reg();
    const live = await fetch(`${HTTP}/heartbeat`, { method: "POST", headers: headersFor(DB, "/heartbeat", { id: first.id }), body: JSON.stringify({ id: first.id }) });
    expect(live.status).toBe(200);
    expect(await live.json()).toMatchObject({ ok: true });

    await post("/unregister", { id: first.id }); // as cleanStalePeers does
    const reaped = await fetch(`${HTTP}/heartbeat`, { method: "POST", headers: headersFor(DB, "/heartbeat", { id: first.id }), body: JSON.stringify({ id: first.id }) });
    expect(reaped.status).toBe(404);
    expect(await reaped.json()).toMatchObject({ ok: false, error: expect.stringContaining("not found") });
    expect((await reg()).id).toBe(first.id);
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
    const doomed = Bun.spawn(["sleep", "30"]);
    const first = await reg(doomed.pid, "CA1");
    doomed.kill();
    await doomed.exited;
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
      // key: same session_key, a different pid. The original process has
      // exited first, as it would on a real restart (a still-running original
      // keeps the id; see "a second live process resuming the same session").
      doomed.kill();
      await doomed.exited;
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

    const migrationPost = <T>(path: string, body: unknown) => postTo<T>(MIGRATION_TEST_HTTP, MIGRATION_TEST_DB, path, body);

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
      for (const suffix of ["", "-wal", "-shm", ".secret"]) {
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
    expect(await ss({ session_key: "ss-noop", pid: pid, source: "startup" }))
      .toEqual({ ok: true, peer_id: id, action: "noop" });
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
    expect(await ss({ session_key: "ss-orig-c", pid: pidB, source: "resume" }))
      .toEqual({ ok: false, reason: "conflict" });
    const ids = (await machine()).map((p) => p.id);
    expect(ids).toContain(idA);
    expect(ids).toContain(idB);
  });

  test("a refused conflict records nothing for the caller's pid", async () => {
    const procA = Bun.spawn(["sleep", "30"]);
    const idA = await regCli(procA.pid, "ss-orig-c2");
    const pidB = livePid();
    const idB = await regCli(pidB, "ss-launch-c2");
    expect(await ss({ session_key: "ss-orig-c2", pid: pidB, source: "resume" }))
      .toEqual({ ok: false, reason: "conflict" });
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
      pid, cwd: "cs_ss_desktop", git_root: null, tty: null, summary: "", peer_type: "desktop", session_token: "cs_ss_desktop",
    });
    expect(await ss({ session_key: "ss-desk", pid: pid, source: "startup" }))
      .toEqual({ ok: false, reason: "no_live_peer" });
  });

  test("malformed body → bad_request", async () => {
    expect(await ss({})).toEqual({ ok: false, reason: "bad_request" });
    expect(await ss({ session_key: "x" })).toEqual({ ok: false, reason: "bad_request" });
  });
  // SE condition (3): pids get reused, so a pid match alone must not hand a
  // new process someone else's identity. Rows record the process start time.
  const { Database } = require("bun:sqlite");
  const setStarted = (id: string, v: string | null) => {
    const d = new Database(DB); d.run("UPDATE peers SET pid_started = ? WHERE id = ?", [v, id]); d.close();
  };
  // Recorded in the C locale and UTC whatever the broker's own environment is
// (it inherits whichever session auto-launched it), or a broker restart under
// another LANG/TZ would make every stored value mismatch.
const startedOf = (pid: number) => new TextDecoder().decode(Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], { env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }).stdout).trim();

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
    expect(await ss({ session_key: "ss-reuse-new", pid: pid, source: "resume" }))
      .toEqual({ ok: false, reason: "no_live_peer" });
  });

  test("rows with no recorded start time (pre-upgrade) still match", async () => {
    const pid = livePid();
    const id = await regCli(pid, "ss-legacy");
    setStarted(id, null);
    expect(await ss({ session_key: "ss-legacy-new", pid: pid, source: "clear" }))
      .toEqual({ ok: true, peer_id: id, action: "mapped" });
  });

  test("an owner whose pid is alive but reused is not a conflict", async () => {
    const idA = await regCli(livePid(), "ss-orig-u");
    setStarted(idA, "Mon Jan  1 00:00:00 2001");
    const pidB = livePid();
    await regCli(pidB, "ss-launch-u");
    expect(await ss({ session_key: "ss-orig-u", pid: pidB, source: "resume" }))
      .toEqual({ ok: true, peer_id: idA, action: "rekeyed" });
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
    expect(await ss({ session_key: "ss-child", pid: livePid(), source: "startup" }))
      .toEqual({ ok: false, reason: "no_live_peer" });
  });
});

describe("wake relay", () => {
  type Reg = { id: string; wake_topic?: string; wake_url?: string };
  const TOPIC = /^cp-wake-[0-9a-f]{24}$/;
  const sleepers: ReturnType<typeof Bun.spawn>[] = [];
  const livePid = () => { const p = Bun.spawn(["sleep", "30"]); sleepers.push(p); return p.pid; };
  afterAll(() => { for (const p of sleepers) { try { p.kill(); } catch {} } });
  const regDesktop = (token: string, base = HTTP, db = DB) => postTo<Reg>(base, db, "/register",
    { pid: LIVE_PIDS[0], cwd: token, git_root: null, tty: null, summary: "Cowork", peer_type: "desktop", session_token: token });
  const regCli = (base = HTTP, db = DB) => postTo<Reg>(base, db, "/register",
    { pid: livePid(), cwd: "/tmp/wake", git_root: null, tty: null, summary: "Sender", peer_type: "cli" });
  const hitsFor = (topic: string) => relayHits.filter((h) => h.path === `/${topic}`);
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
    const d = new Database(DB); d.run("UPDATE desktop_tokens SET wake_topic = NULL WHERE token = ?", ["cs_wake_d"]); d.close();
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
    expect(relayHits.some((h) => h.body.includes("secret") || h.path.includes(d.id) || h.path.includes(s.id))).toBe(false);
  });

  test("list-peers never carries a wake topic", async () => {
    await regDesktop("cs_wake_h");
    const peers = await post<unknown[]>("/list-peers", { scope: "machine", cwd: "/", git_root: null });
    expect(JSON.stringify(peers)).not.toContain("cp-wake-");
  });

  test("send to a cli peer publishes nothing", async () => {
    const a = await regCli();
    const b = await regCli();
    const before = relayHits.length;
    await post("/send-message", { from_id: a.id, to_id: b.id, text: "hi" });
    await Bun.sleep(300);
    expect(relayHits.length).toBe(before);
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
    relayHang = true;
    try {
      const t0 = performance.now();
      const res = await post<{ ok: boolean }>("/send-message", { from_id: s.id, to_id: d.id, text: "still queued" });
      expect(res.ok).toBe(true);
      expect(performance.now() - t0).toBeLessThan(500);
      const peek = await post<{ messages: Array<{ text: string }> }>("/peek-messages", { id: d.id });
      expect(peek.messages.map((m) => m.text)).toContain("still queued");
    } finally { relayHang = false; }
  });

  // Off unless Dean opts in: an unset relay, "off", and a relay that would
  // publish in clear text over the internet all mean no topics and no egress.
  const { CLAUDE_PEERS_WAKE_RELAY: _relay, ...UNSET } = BROKER_ENV;
  for (const [i, [label, env]] of ([
    ["unset (the default)", UNSET],
    ["off", { ...BROKER_ENV, CLAUDE_PEERS_WAKE_RELAY: "off" }],
    ["a plain-http remote relay", { ...BROKER_ENV, CLAUDE_PEERS_WAKE_RELAY: "http://ntfy.example" }],
    ["a relay URL with shell metacharacters", { ...BROKER_ENV, CLAUDE_PEERS_WAKE_RELAY: 'https://ntfy.example/x";touch /tmp/cp-pwned;"' }],
  ] as const).entries()) {
    test(`relay ${label}: no topic, no publish`, async () => {
      const OFF_PORT = PORT + 200 + i;
      const OFF_HTTP = `http://127.0.0.1:${OFF_PORT}`;
      const OFF_DB = `${import.meta.dir}/.test-broker-off-${OFF_PORT}.db`;
      const off = Bun.spawn(["bun", `${import.meta.dir}/broker.ts`], {
        env: { ...env, CLAUDE_PEERS_PORT: String(OFF_PORT), CLAUDE_PEERS_DB: OFF_DB },
        stdout: "ignore", stderr: "ignore",
      });
      try {
        for (let i = 0; i < 50; i++) {
          try { if ((await fetch(`${OFF_HTTP}/health`)).ok) break; } catch {}
          await Bun.sleep(100);
        }
        const d = await regDesktop(`cs_wake_off${i}`, OFF_HTTP, OFF_DB);
        expect(d.id).toBeDefined();
        expect(d.wake_topic).toBeUndefined();
        expect(d.wake_url).toBeUndefined();
        const s = await regCli(OFF_HTTP, OFF_DB);
        const before = relayHits.length;
        await postTo(OFF_HTTP, OFF_DB, "/send-message", { from_id: s.id, to_id: d.id, text: "x" });
        await Bun.sleep(300);
        expect(relayHits.length).toBe(before);
      } finally {
        off.kill();
        await off.exited;
        for (const suffix of ["", "-wal", "-shm", ".secret"]) { try { await Bun.file(OFF_DB + suffix).delete(); } catch {} }
      }
    });
  }

  test("an HTTP error from the relay is logged, without the topic", async () => {
    const ERR_PORT = PORT + 300;
    const ERR_HTTP = `http://127.0.0.1:${ERR_PORT}`;
    const ERR_DB = `${import.meta.dir}/.test-broker-err-${ERR_PORT}.db`;
    const b = Bun.spawn(["bun", `${import.meta.dir}/broker.ts`], {
      env: { ...BROKER_ENV, CLAUDE_PEERS_PORT: String(ERR_PORT), CLAUDE_PEERS_DB: ERR_DB },
      stdout: "ignore", stderr: "pipe",
    });
    relayStatus = 429;
    try {
      for (let i = 0; i < 50; i++) {
        try { if ((await fetch(`${ERR_HTTP}/health`)).ok) break; } catch {}
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
      relayStatus = 200;
      b.kill();
      await b.exited;
      for (const suffix of ["", "-wal", "-shm", ".secret"]) { try { await Bun.file(ERR_DB + suffix).delete(); } catch {} }
    }
  });

  describe("wake mode", () => {
    const setMode = (body: Record<string, unknown>) => fetch(`${HTTP}/wake-mode`, {
      method: "POST", headers: headersFor(DB, "/wake-mode", body), body: JSON.stringify(body),
    });
    const status = () => post<{ global: string; relay: string | null; peers: { id: string; mode: string; own_setting: boolean }[] }>("/wake-status", {});
    const beat = (id: string) => post<{ ok: boolean; wake_url?: string }>("/heartbeat", { id });
    // These tests share one broker with the rest of the file: leave it active.
    afterAll(async () => { await setMode({ mode: "active", clear_overrides: true }); });

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
      expect((await fetch(`${HTTP}/wake-mode`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "passive" }) })).status).toBe(401);
      expect((await status()).global).toBe("active");
    });
  });
});

describe("request gate", () => {
  const secret = () => readSecret(secretPath(DB))!;
  const auth = () => ({ "content-type": "application/json", authorization: `Bearer ${secret()}` });
  const raw = (path: string, headers: Record<string, string>, body: unknown = { scope: "machine", cwd: "/", git_root: null }) =>
    fetch(`${HTTP}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const peer = async (summary: string) => {
    const r = await post<{ id: string; peer_secret: string }>("/register", {
      pid: process.pid, cwd: `/tmp/gate-${summary}`, git_root: null, tty: null, summary, peer_type: "desktop", session_token: `cs_gate_${summary}`,
    });
    return r;
  };
  const undelivered = async (id: string) =>
    (await post<{ messages: Array<{ id: number; text: string }> }>("/peek-messages", { id })).messages;

  test("the install secret is created 0600 beside the DB, and the DB is 0600", () => {
    expect(secret()).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(secretPath(DB)).mode & 0o777).toBe(0o600);
    expect(statSync(DB).mode & 0o777).toBe(0o600);
    // The WAL holds recent mail until checkpoint: it must be owner-only too,
    // though SQLite creates it after the broker's startup chmod.
    expect(statSync(`${DB}-wal`).mode & 0o777).toBe(0o600);
  });

  test("a text/plain POST is refused", async () => {
    const res = await raw("/list-peers", { ...auth(), "content-type": "text/plain" });
    expect(res.status).toBe(415);
  });

  test("a foreign Host is refused (DNS rebinding)", async () => {
    const res = await raw("/list-peers", { ...auth(), host: `attacker.example:${PORT}` });
    expect(res.status).toBe(403);
    const health = await fetch(`${HTTP}/health`, { headers: { host: `attacker.example:${PORT}` } });
    expect(health.status).toBe(403);
  });

  test("localhost and 127.0.0.1 Hosts are accepted", async () => {
    expect((await raw("/list-peers", { ...auth(), host: `localhost:${PORT}` })).status).toBe(200);
    expect((await raw("/list-peers", { ...auth(), host: `127.0.0.1:${PORT}` })).status).toBe(200);
  });

  test("any Origin is refused (cross-site requests)", async () => {
    expect((await raw("/list-peers", { ...auth(), origin: "http://attacker.example" })).status).toBe(403);
    expect((await raw("/list-peers", { ...auth(), origin: "null" })).status).toBe(403);
  });

  test("a POST without the install secret is refused", async () => {
    const plain = { "content-type": "application/json" };
    for (const path of ["/register", "/list-peers", "/send-message", "/session-start", "/ack-messages"]) {
      expect((await raw(path, plain)).status).toBe(401);
      expect((await raw(path, { ...plain, authorization: `Bearer ${"0".repeat(64)}` })).status).toBe(401);
    }
  });

  test("GET /health stays open so clients can probe liveness", async () => {
    expect((await fetch(`${HTTP}/health`)).status).toBe(200);
  });

  test("register hands back this peer's credential", async () => {
    const r = await peer("cred");
    expect(r.peer_secret).toBe(peerSecret(secret(), r.id));
  });

  test("send-message refuses a from_id that isn't the caller's", async () => {
    const a = await peer("send-a");
    const b = await peer("send-b");
    const target = await peer("send-t");
    const spoof = await raw("/send-message", { ...auth(), [PEER_HEADER]: b.peer_secret }, { from_id: a.id, to_id: target.id, text: "spoofed" });
    expect(spoof.status).toBe(403);
    const none = await raw("/send-message", auth(), { from_id: a.id, to_id: target.id, text: "no credential" });
    expect(none.status).toBe(403);
    expect(await undelivered(target.id)).toEqual([]);
    const own = await raw("/send-message", { ...auth(), [PEER_HEADER]: a.peer_secret }, { from_id: a.id, to_id: target.id, text: "genuine" });
    expect(((await own.json()) as { ok: boolean }).ok).toBe(true);
    expect((await undelivered(target.id)).map((m) => m.text)).toEqual(["genuine"]);
  });

  test("peer-scoped routes refuse another peer's id", async () => {
    const a = await peer("scope-a");
    const b = await peer("scope-b");
    const asB = { ...auth(), [PEER_HEADER]: b.peer_secret };
    for (const [path, body] of [
      ["/heartbeat", { id: a.id }],
      ["/set-summary", { id: a.id, summary: "hijacked" }],
      ["/poll-messages", { id: a.id }],
      ["/peek-messages", { id: a.id }],
      ["/ack-messages", { id: a.id, message_ids: [1] }],
      ["/unregister", { id: a.id }],
    ] as const) {
      expect([path, (await raw(path, asB, body)).status]).toEqual([path, 403]);
    }
    const list = await post<Array<{ id: string; summary: string }>>("/list-peers", { scope: "machine", cwd: "/", git_root: null });
    expect(list.find((p) => p.id === a.id)?.summary).toBe("scope-a");
  });

  test("ack marks only the caller's own mail", async () => {
    const a = await peer("ack-a");
    const b = await peer("ack-b");
    await post("/send-message", { from_id: "cli", to_id: a.id, text: "for a" });
    const [msg] = await undelivered(a.id);
    await post("/ack-messages", { id: b.id, message_ids: [msg!.id] });
    expect((await undelivered(a.id)).map((m) => m.text)).toEqual(["for a"]);
    await post("/ack-messages", { id: a.id, message_ids: [msg!.id] });
    expect(await undelivered(a.id)).toEqual([]);
  });

  test("the cli sender needs only the install secret", async () => {
    const t = await peer("cli-t");
    const res = await raw("/send-message", auth(), { from_id: "cli", to_id: t.id, text: "from the terminal" });
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  test("list-peers never returns session tokens, even through cwd", async () => {
    await post("/register", {
      pid: process.pid, cwd: "cs_gate_leak1", git_root: null, tty: null, summary: "leaky", peer_type: "desktop", session_token: "cs_gate_leak1",
    });
    const list = await post<Array<Record<string, unknown>>>("/list-peers", { scope: "machine", cwd: "/", git_root: null });
    expect(list.some((p) => p.summary === "leaky")).toBe(true);
    expect(JSON.stringify(list)).not.toContain("cs_gate_");
    for (const p of list) {
      expect(p).not.toHaveProperty("session_token");
      expect(p).not.toHaveProperty("pid_started");
    }
  });

  test("a watch frame never carries the sender's token", async () => {
    const sender = await post<{ id: string }>("/register", {
      pid: process.pid, cwd: "cs_gate_leak2", git_root: null, tty: null, summary: "", peer_type: "desktop", session_token: "cs_gate_leak2",
    });
    const target = await peer("watch-t");
    const w = await connectWatch(target.id);
    try {
      await w.next(); // "watching" handshake
      await post("/send-message", { from_id: sender.id, to_id: target.id, text: "hi" });
      const frame = await w.next();
      expect(JSON.stringify(frame)).not.toContain("cs_gate_leak2");
    } finally {
      w.ws.close();
    }
  });
});

describe("/unread", () => {
  test("counts a live CLI peer's undelivered mail by its host pid", async () => {
    const proc = Bun.spawn(["sleep", "30"]);
    try {
      const { id } = await post<{ id: string }>("/register", {
        pid: proc.pid, cwd: "/tmp/unread", git_root: null, tty: null, summary: "", peer_type: "cli", session_key: "unread-key",
      });
      expect(await post<{ count: number }>("/unread", { pid: proc.pid })).toEqual({ count: 0 });
      await post("/send-message", { from_id: "cli", to_id: id, text: "one" });
      await post("/send-message", { from_id: "cli", to_id: id, text: "two" });
      expect(await post<{ count: number }>("/unread", { pid: proc.pid })).toEqual({ count: 2 });
    } finally {
      proc.kill();
    }
  });

  test("an unknown pid has nothing unread", async () => {
    expect(await post<{ count: number }>("/unread", { pid: 999999 })).toEqual({ count: 0 });
  });
});

describe("summaries after a restart", () => {
  // Several agents share one repo. A peer coming back must get its OWN last
  // summary, never whichever agent in that repo set one most recently.
  const REPO = "/tmp/shared-repo-summaries";
  const sleepers: ReturnType<typeof Bun.spawn>[] = [];
  const livePid = () => { const p = Bun.spawn(["sleep", "30"]); sleepers.push(p); return p.pid; };
  afterAll(() => { for (const p of sleepers) { try { p.kill(); } catch {} } });
  const cli = (pid: number, session_key: string, summary = "") => post<{ id: string; restored_summary?: string }>("/register", {
    pid, cwd: REPO, git_root: REPO, tty: null, summary, peer_type: "cli", session_key,
  });
  const desk = (token: string, summary = "") => post<{ id: string; restored_summary?: string }>("/register", {
    pid: process.pid, cwd: "/", git_root: null, tty: null, summary, peer_type: "desktop", session_token: token,
  });
  const summaryOf = async (id: string) =>
    (await post<Array<{ id: string; summary: string }>>("/list-peers", { scope: "machine", cwd: "/", git_root: null }))
      .find((p) => p.id === id)?.summary;

  test("a returning CLI session gets its own last summary, not the repo's latest", async () => {
    const a = await cli(livePid(), "sum-a", "Coding Agent 1");
    const b = await cli(livePid(), "sum-b");
    await post("/set-summary", { id: b.id, summary: "Security Agent" }); // B speaks last in the repo
    await post("/unregister", { id: a.id }); // A's row is reaped
    const back = await cli(livePid(), "sum-a");
    expect(back.id).toBe(a.id);
    expect(back.restored_summary).toBe("Coding Agent 1");
    expect(await summaryOf(a.id)).toBe("Coding Agent 1");
  });

  test("a summary set after registering is the one restored", async () => {
    const a = await cli(livePid(), "sum-c", "QA Agent");
    await post("/set-summary", { id: a.id, summary: "QA Agent. Grading PR 12" });
    await cli(livePid(), "sum-d", "Coding Agent 3");
    await post("/unregister", { id: a.id });
    expect((await cli(livePid(), "sum-c")).restored_summary).toBe("QA Agent. Grading PR 12");
  });

  test("a brand-new CLI session in a shared repo doesn't inherit another agent's summary", async () => {
    await cli(livePid(), "sum-e", "Production Monitor");
    const fresh = await cli(livePid(), "sum-new");
    expect(fresh.restored_summary).toBeUndefined();
    expect(await summaryOf(fresh.id)).toBe("");
  });

  test("a returning desktop session gets its own last summary", async () => {
    const a = await desk("cs_sum_pm", "PM agent");
    await desk("cs_sum_design", "Design agent");
    await post("/unregister", { id: a.id });
    const back = await desk("cs_sum_pm");
    expect(back.id).toBe(a.id);
    expect(back.restored_summary).toBe("PM agent");
    expect(await summaryOf(a.id)).toBe("PM agent");
  });

  test("a session without a key (older Claude Code) still falls back to the workspace summary", async () => {
    const pid = livePid();
    await post("/register", { pid, cwd: "/tmp/legacy-ws", git_root: null, tty: null, summary: "Legacy agent", peer_type: "cli" });
    const fresh = await post<{ id: string; restored_summary?: string }>("/register", {
      pid: livePid(), cwd: "/tmp/legacy-ws", git_root: null, tty: null, summary: "", peer_type: "cli",
    });
    expect(fresh.restored_summary).toBe("Legacy agent");
  });
});
