/**
 * A real broker on a private port and temp DB for one test file, with a
 * stand-in wake relay. Call useBroker() at the top of a test file: it starts
 * the broker before that file's tests and removes it, and its DB, after.
 */

import { afterAll, beforeAll } from "bun:test";
import { dirname } from "node:path";
import { PEER_HEADER, peerSecret, readSecret, secretPath } from "../../src/shared/auth.ts";

/** The repo root, where the entry files live. */
export const ROOT = dirname(dirname(import.meta.dir));

// CLI registrations dedupe by PID, and the broker reaps PIDs that aren't
// alive, so each fake peer needs its own live-looking PID. Use ours for the
// first and its parent for the second: both are alive for the test's lifetime.
export const LIVE_PIDS = [process.pid, process.ppid];

// Every POST carries the install secret, and peer-scoped routes carry the
// credential for the id they act as, the way server.ts sends them. Tests that
// probe the gate itself use raw fetch.
const SUBJECT: Record<string, string> = {
  "/send-message": "from_id",
  "/heartbeat": "id",
  "/set-summary": "id",
  "/poll-messages": "id",
  "/peek-messages": "id",
  "/ack-messages": "id",
  "/unregister": "id",
};

export function headersFor(db: string, path: string, body: unknown): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  const secret = readSecret(secretPath(db));
  if (!secret) return h;
  h.authorization = `Bearer ${secret}`;
  const id = (body as Record<string, unknown> | null)?.[SUBJECT[path] ?? ""];
  if (typeof id === "string") h[PEER_HEADER] = peerSecret(secret, id);
  return h;
}

export async function postTo<T>(http: string, db: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${http}${path}`, {
    method: "POST",
    headers: headersFor(db, path, body),
    body: JSON.stringify(body),
  });
  return res.json() as Promise<T>;
}

async function waitForHealth(http: string, proc: ReturnType<typeof Bun.spawn>, what: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (proc.exitCode !== null) throw new Error(`broker failed to bind on ${what} (port not released?)`);
    try {
      if ((await fetch(`${http}/health`)).ok) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error(`broker did not ${what}`);
}

export function useBroker() {
  const PORT = 7899 + 1000 + Math.floor(Math.random() * 500);
  const HTTP = `http://127.0.0.1:${PORT}`;
  const WS = `ws://127.0.0.1:${PORT}`;
  const DB = `${import.meta.dir}/.test-broker-${PORT}.db`;

  // Stand-in for the wake relay (ntfy). Records every publish; can be told to
  // hang so a test can prove /send-message never waits on it, or to answer
  // with an error status.
  const relay = { hits: [] as Array<{ path: string; body: string }>, hang: false, status: 200, port: 0 };
  const relayServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      relay.hits.push({ path: new URL(req.url).pathname, body: await req.text() });
      if (relay.hang) return new Promise<Response>(() => {});
      return new Response("ok", { status: relay.status });
    },
  });
  relay.port = relayServer.port as number;

  const BROKER_ENV = {
    ...process.env,
    CLAUDE_PEERS_PORT: String(PORT),
    CLAUDE_PEERS_DB: DB,
    LC_ALL: "fr_FR.UTF-8",
    TZ: "Asia/Tokyo",
    CLAUDE_PEERS_WAKE_RELAY: `http://127.0.0.1:${relay.port}`,
    CLAUDE_PEERS_WAKE_COALESCE_MS: "1000",
  };

  let proc: ReturnType<typeof Bun.spawn>;
  const spawn = () => Bun.spawn(["bun", `${ROOT}/broker.ts`], { env: BROKER_ENV, stdout: "ignore", stderr: "ignore" });

  const post = <T>(path: string, body: unknown) => postTo<T>(HTTP, DB, path, body);

  // cleanStalePeers runs on broker startup, so a restart against the same DB is
  // the deterministic way to trigger the stale-peer sweep. The other trigger is a
  // 30s interval, which is too slow for a test.
  async function restartBroker(): Promise<void> {
    proc.kill();
    await proc.exited;
    await Bun.sleep(200); // Give port time to be released by OS
    proc = spawn();
    await waitForHealth(HTTP, proc, "restart");
  }

  let pidCursor = 0;
  async function register(summary: string, peer_type: "cli" | "desktop"): Promise<string> {
    const r = await post<{ id: string }>("/register", {
      pid: LIVE_PIDS[pidCursor++ % LIVE_PIDS.length],
      cwd: `/tmp/${summary}`,
      git_root: null,
      tty: null,
      summary,
      peer_type,
    });
    return r.id;
  }

  // Upgrades with the install secret and the peer's credential, the way
  // `bun cli.ts watch` does.
  function watchHeaders(peerId: string): Record<string, string> {
    const secret = readSecret(secretPath(DB))!;
    return { authorization: `Bearer ${secret}`, [PEER_HEADER]: peerSecret(secret, peerId) };
  }

  function connectWatch(
    peerId: string,
    headers = watchHeaders(peerId),
  ): Promise<{ ws: WebSocket; frames: unknown[]; next: () => Promise<unknown> }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${WS}/watch/${peerId}`, { headers });
      const frames: unknown[] = [];
      const waiters: Array<(f: unknown) => void> = [];
      ws.onmessage = (ev) => {
        const f = JSON.parse(String(ev.data));
        const w = waiters.shift();
        if (w) w(f);
        else frames.push(f);
      };
      ws.onerror = (e) => reject(e);
      ws.onopen = () =>
        resolve({
          ws,
          frames,
          next: () => (frames.length ? Promise.resolve(frames.shift()) : new Promise((r) => waiters.push(r))),
        });
    });
  }

  beforeAll(async () => {
    proc = spawn();
    await waitForHealth(HTTP, proc, "start");
  });

  afterAll(async () => {
    proc.kill();
    relayServer.stop(true);
    for (const suffix of ["", "-wal", "-shm", ".secret"]) {
      try {
        await Bun.file(DB + suffix).delete();
      } catch {}
    }
  });

  return { PORT, HTTP, WS, DB, BROKER_ENV, relay, post, restartBroker, register, watchHeaders, connectWatch };
}
