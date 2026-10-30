/**
 * The request gate (Host, Origin, content type, install secret, peer
 * credentials), the route table, and /unread.
 */

import { test, expect, describe } from "bun:test";
import { statSync } from "node:fs";
import { PEER_HEADER, peerSecret, readSecret, secretPath } from "../../src/shared/auth.ts";
import { useBroker } from "./harness.ts";

const { PORT, HTTP, DB, post, watchHeaders, connectWatch } = useBroker();

describe("request gate", () => {
  const secret = () => readSecret(secretPath(DB))!;
  const auth = () => ({ "content-type": "application/json", authorization: `Bearer ${secret()}` });
  const raw = (
    path: string,
    headers: Record<string, string>,
    body: unknown = { scope: "machine", cwd: "/", git_root: null },
  ) => fetch(`${HTTP}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const peer = async (summary: string) => {
    const r = await post<{ id: string; peer_secret: string }>("/register", {
      pid: process.pid,
      cwd: `/tmp/gate-${summary}`,
      git_root: null,
      tty: null,
      summary,
      peer_type: "desktop",
      session_token: `cs_gate_${summary}`,
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
    const spoof = await raw(
      "/send-message",
      { ...auth(), [PEER_HEADER]: b.peer_secret },
      { from_id: a.id, to_id: target.id, text: "spoofed" },
    );
    expect(spoof.status).toBe(403);
    const none = await raw("/send-message", auth(), { from_id: a.id, to_id: target.id, text: "no credential" });
    expect(none.status).toBe(403);
    expect(await undelivered(target.id)).toEqual([]);
    const own = await raw(
      "/send-message",
      { ...auth(), [PEER_HEADER]: a.peer_secret },
      { from_id: a.id, to_id: target.id, text: "genuine" },
    );
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
    const list = await post<Array<{ id: string; summary: string }>>("/list-peers", {
      scope: "machine",
      cwd: "/",
      git_root: null,
    });
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
      pid: process.pid,
      cwd: "cs_gate_leak1",
      git_root: null,
      tty: null,
      summary: "leaky",
      peer_type: "desktop",
      session_token: "cs_gate_leak1",
    });
    const list = await post<Array<Record<string, unknown>>>("/list-peers", {
      scope: "machine",
      cwd: "/",
      git_root: null,
    });
    expect(list.some((p) => p.summary === "leaky")).toBe(true);
    expect(JSON.stringify(list)).not.toContain("cs_gate_");
    for (const p of list) {
      expect(p).not.toHaveProperty("session_token");
      expect(p).not.toHaveProperty("pid_started");
    }
  });

  test("a watch frame never carries the sender's token", async () => {
    const sender = await post<{ id: string }>("/register", {
      pid: process.pid,
      cwd: "cs_gate_leak2",
      git_root: null,
      tty: null,
      summary: "",
      peer_type: "desktop",
      session_token: "cs_gate_leak2",
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

  // The route table: what an unlisted path, a bad body or a plain GET gets.
  test("an unknown POST route is a 404 after the gate, never before it", async () => {
    for (const path of ["/nope", "/constructor", "/__proto__", "/toString"]) {
      expect((await raw(path, { "content-type": "application/json" })).status).toBe(401);
      const res = await raw(path, auth());
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not found" });
    }
  });

  test("a body that isn't JSON is a 500 with the parse error", async () => {
    const res = await fetch(`${HTTP}/list-peers`, { method: "POST", headers: auth(), body: "{not json" });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBeTruthy();
  });

  test("GET /health reports the peer count; any other GET is a plain banner", async () => {
    const health = await fetch(`${HTTP}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "ok", peers: expect.any(Number) });
    const other = await fetch(`${HTTP}/anything`);
    expect(other.status).toBe(200);
    expect(await other.text()).toBe("claude-peers broker");
  });

  test("a /watch upgrade attempt over plain GET is a 426 once the credentials pass", async () => {
    const id = (await peer("watch426")).id;
    const res = await fetch(`${HTTP}/watch/${id}`, { headers: watchHeaders(id) });
    expect(res.status).toBe(426);
    expect((await fetch(`${HTTP}/watch/`, { headers: watchHeaders("") })).status).toBe(400);
  });
});

describe("/unread", () => {
  test("counts a live CLI peer's undelivered mail by its host pid", async () => {
    const proc = Bun.spawn(["sleep", "30"]);
    try {
      const { id } = await post<{ id: string }>("/register", {
        pid: proc.pid,
        cwd: "/tmp/unread",
        git_root: null,
        tty: null,
        summary: "",
        peer_type: "cli",
        session_key: "unread-key",
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
