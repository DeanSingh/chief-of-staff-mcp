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

  test("peer_sessions carries desktop tokens forward and re-running is a no-op", async () => {
    // Register a desktop peer: this writes a desktop_tokens row.
    const first = await post<{ id: string }>("/register", {
      pid: LIVE_PIDS[0]!, cwd: "cs_mig", git_root: null, tty: null,
      summary: "Migration agent", peer_type: "desktop", session_token: "cs_mig",
    });

    // The broker mirrors it into peer_sessions on startup and on write.
    const rows = await post<{ rows: Array<{ session_key: string; peer_id: string; peer_type: string }> }>(
      "/debug-peer-sessions", {},
    );
    const mine = rows.rows.filter((r) => r.session_key === "cs_mig");
    expect(mine).toHaveLength(1);
    expect(mine[0]!.peer_id).toBe(first.id);
    expect(mine[0]!.peer_type).toBe("desktop");
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

      // Step 4: Verify migration copied the row with peer_type 'desktop'
      const rows = await migrationPost<{ rows: Array<{ session_key: string; peer_id: string; peer_type: string }> }>(
        "/debug-peer-sessions", {},
      );
      const migrated = rows.rows.filter((r) => r.session_key === "mig_test_token");
      expect(migrated).toHaveLength(1);
      expect(migrated[0]!.peer_id).toBe("mig_peer_xyz");
      expect(migrated[0]!.peer_type).toBe("desktop");

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

      const rows2 = await migrationPost<{ rows: Array<{ session_key: string; peer_id: string; peer_type: string }> }>(
        "/debug-peer-sessions", {},
      );
      const migrated2 = rows2.rows.filter((r) => r.session_key === "mig_test_token");
      expect(migrated2).toHaveLength(1); // Still exactly one, no error on re-run
      expect(migrated2[0]!.peer_id).toBe("mig_peer_xyz");

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
