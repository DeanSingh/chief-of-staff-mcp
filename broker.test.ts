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
    expect(send).toEqual({ ok: true, woke: 1 });

    const frame = (await w.next()) as Record<string, unknown>;
    expect(frame).toMatchObject({
      type: "peer_message", from_id: cos, from_summary: "Chief of staff", text: "pull Q3 burn",
    });
    expect(typeof frame.id).toBe("number");

    // Wake is not delivery: message is still undelivered for check_messages.
    const peek = await post<{ messages: Array<{ id: number; delivered: number }> }>("/peek-messages", { id: finance });
    expect(peek.messages).toHaveLength(1);
    expect(peek.messages[0]!.delivered).toBe(0);
    expect(peek.messages[0]!.id).toBe(frame.id);

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
});
