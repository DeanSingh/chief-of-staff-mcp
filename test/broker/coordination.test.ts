/**
 * Decision-queue storage: the events, input_requests and digest_cursors
 * tables and their retention sweep.
 */

import { Database } from "bun:sqlite";
import { test, expect, describe } from "bun:test";
import { headersFor, useBroker } from "./harness.ts";

const { HTTP, DB, restartBroker, register, post } = useBroker();

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

describe("coordination retention", () => {
  test("the sweep drops week-old events and settled requests, never pending ones", async () => {
    const db = new Database(DB);
    try {
      const addEvent = db.prepare("INSERT INTO events (message, created_at) VALUES (?, ?)");
      addEvent.run("old event", daysAgo(8));
      addEvent.run("recent event", daysAgo(1));

      const addRequest = db.prepare(
        "INSERT INTO input_requests (id, question, state, created_at, answered_at) VALUES (?, 'q', ?, ?, ?)",
      );
      addRequest.run("old-answered", "answered", daysAgo(9), daysAgo(8));
      addRequest.run("old-canceled", "canceled", daysAgo(9), daysAgo(8));
      addRequest.run("old-pending", "pending", daysAgo(8), null);
      addRequest.run("old-escalated", "escalated", daysAgo(8), null);

      db.run("INSERT INTO digest_cursors (peer_id, position, updated_at) VALUES ('p', 3, ?)", [daysAgo(60)]);
    } finally {
      db.close();
    }

    await restartBroker();

    const check = new Database(DB, { readonly: true });
    try {
      const events = check.query("SELECT message FROM events").all() as { message: string }[];
      expect(events.map((e) => e.message)).toEqual(["recent event"]);
      const requests = check.query("SELECT id FROM input_requests ORDER BY id").all() as { id: string }[];
      expect(requests.map((r) => r.id)).toEqual(["old-escalated", "old-pending"]);
      expect(check.query("SELECT peer_id FROM digest_cursors").all()).toHaveLength(1);
    } finally {
      check.close();
    }
  });
});

describe("/report-event", () => {
  const rawPost = (body: unknown, headers?: Record<string, string>) =>
    fetch(`${HTTP}/report-event`, {
      method: "POST",
      headers: headers ?? headersFor(DB, "/report-event", body),
      body: JSON.stringify(body),
    });
  const stored = (id: number) => {
    const db = new Database(DB, { readonly: true });
    try {
      return db.query("SELECT * FROM events WHERE id = ?").get(id) as Record<string, string | null>;
    } finally {
      db.close();
    }
  };

  test("a registered peer's event is stored", async () => {
    const peer_id = await register("reporter", "cli");
    const r = await post<{ ok: boolean; event_id: number }>("/report-event", {
      peer_id,
      level: "warning",
      message: "x",
    });
    expect(r.ok).toBe(true);
    expect(typeof r.event_id).toBe("number");
    expect(stored(r.event_id)).toMatchObject({ peer_id, session_key: null, level: "warning", source: "tool" });
  });

  test("bad level, source or message is a 400", async () => {
    const peer_id = await register("badinput", "cli");
    expect((await rawPost({ peer_id, level: "loud", message: "x" })).status).toBe(400);
    expect((await rawPost({ peer_id, source: "mouth", message: "x" })).status).toBe(400);
    expect((await rawPost({ peer_id })).status).toBe(400);
    expect((await rawPost({ peer_id, message: 7 })).status).toBe(400);
  });

  test("exactly one of peer_id and session_key is required", async () => {
    const peer_id = await register("both", "cli");
    expect((await rawPost({ peer_id, session_key: "k", message: "x" })).status).toBe(400);
    expect((await rawPost({ message: "x" })).status).toBe(400);
    expect((await rawPost({ session_key: 5, message: "x" })).status).toBe(400);
    expect((await rawPost({ peer_id: 5, message: "x" })).status).toBe(403);
  });

  test("an unknown peer_id is a 404", async () => {
    expect((await rawPost({ peer_id: "nobody", message: "x" })).status).toBe(404);
  });

  test("peer_id without its credential is a 403", async () => {
    const peer_id = await register("impostor", "cli");
    const { authorization } = headersFor(DB, "/report-event", {});
    const bare = { "content-type": "application/json", authorization: authorization! };
    expect((await rawPost({ peer_id, message: "x" }, bare)).status).toBe(403);
  });

  test("a session_key alone needs only the install secret, and an unmapped key leaves peer_id NULL", async () => {
    const res = await rawPost({ session_key: "unmapped-key", message: "from a hook", source: "hook" });
    expect(res.status).toBe(200);
    const { event_id } = (await res.json()) as { event_id: number };
    expect(stored(event_id)).toMatchObject({ peer_id: null, session_key: "unmapped-key", source: "hook" });
  });

  test("a mapped CLI session_key resolves to its peer", async () => {
    const db = new Database(DB);
    try {
      db.run("INSERT INTO peer_sessions VALUES ('cli-key', 'cli-peer', 'cli', ?)", [daysAgo(0)]);
      db.run("INSERT INTO peer_sessions VALUES ('desk-key', 'desk-peer', 'desktop', ?)", [daysAgo(0)]);
    } finally {
      db.close();
    }
    const ok = await rawPost({ session_key: "cli-key", message: "x" });
    expect(stored(((await ok.json()) as { event_id: number }).event_id)).toMatchObject({ peer_id: "cli-peer" });
  });

  test("a Desktop session_key is refused and never stored", async () => {
    const db = new Database(DB);
    try {
      db.run("INSERT OR IGNORE INTO peer_sessions VALUES ('desk-key', 'desk-peer', 'desktop', ?)", [daysAgo(0)]);
    } finally {
      db.close();
    }
    expect((await rawPost({ session_key: "desk-key", message: "x" })).status).toBe(400);
    const check = new Database(DB, { readonly: true });
    try {
      expect(check.query("SELECT 1 FROM events WHERE session_key = 'desk-key'").all()).toHaveLength(0);
    } finally {
      check.close();
    }
  });

  test("data over 8 KB is stored as a truncated preview", async () => {
    const peer_id = await register("bigdata", "cli");
    const r = await post<{ event_id: number }>("/report-event", {
      peer_id,
      message: "x",
      data: { blob: "a".repeat(20_000) },
    });
    const data = JSON.parse(stored(r.event_id).data!);
    expect(data.truncated).toBe(true);
    expect(typeof data.preview).toBe("string");
    expect(data.preview.length).toBe(8000);
  });

  test("small data round-trips, and a 10 KB message is clipped with a marker", async () => {
    const peer_id = await register("bigmsg", "cli");
    const r = await post<{ event_id: number }>("/report-event", {
      peer_id,
      message: "m".repeat(10_000),
      data: { a: 1 },
    });
    const row = stored(r.event_id);
    expect(row.message!.length).toBeLessThanOrEqual(4096);
    expect(row.message!.endsWith("…[truncated]")).toBe(true);
    expect(JSON.parse(row.data!)).toEqual({ a: 1 });
  });
});
