/**
 * Decision-queue storage: the events, input_requests and digest_cursors
 * tables and their retention sweep.
 */

import { Database } from "bun:sqlite";
import { test, expect, describe } from "bun:test";
import { LIVE_PIDS, headersFor, useBroker } from "./harness.ts";

const { HTTP, DB, restartBroker, register, post, relay, connectWatch } = useBroker();

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

describe("input requests", () => {
  const raw = (path: string, body: unknown) =>
    fetch(`${HTTP}${path}`, { method: "POST", headers: headersFor(DB, path, body), body: JSON.stringify(body) });
  const call = async <T = Record<string, unknown>>(path: string, body: unknown) => {
    const res = await raw(path, body);
    return { status: res.status, ...((await res.json()) as T) } as { status: number } & T;
  };
  const row = (id: string) => {
    const db = new Database(DB, { readonly: true });
    try {
      return db.query("SELECT * FROM input_requests WHERE id = ?").get(id) as Record<string, string | null>;
    } finally {
      db.close();
    }
  };
  const regKeyed = async (key: string, pid: number, peer_type: "cli" | "desktop" = "cli") =>
    (
      await post<{ id: string }>("/register", {
        pid,
        cwd: `/tmp/${key}`,
        git_root: null,
        tty: null,
        summary: key,
        peer_type,
        session_key: key,
      })
    ).id;
  const ask = (body: Record<string, unknown>) => call<{ request_id: string }>("/request-input", body);

  test("a restarted peer receives the answer to a request it made before it died", async () => {
    const id = await regKeyed("restart-key", LIVE_PIDS[0]!);
    const { request_id } = await ask({ peer_id: id, question: "Merge or wait?" });
    await post("/unregister", { id });
    expect(await regKeyed("restart-key", LIVE_PIDS[1]!)).toBe(id);
    const answerer = await register("answerer", "cli");
    const r = await call("/answer-request", { request_id, answerer_id: answerer, answer: "wait", answered_via: "cos" });
    expect(r).toMatchObject({ status: 200, ok: true, woke: 0, target_type: "cli" });
    const { messages } = await post<{ messages: { text: string; from_id: string }[] }>("/poll-messages", { id });
    expect(messages.map((m) => m.text)).toEqual([`Answer to your request ${request_id} ("Merge or wait?"): wait`]);
    expect(messages[0]!.from_id).toBe(answerer);
    expect(row(request_id)).toMatchObject({
      state: "answered",
      answer: "wait",
      answered_by: answerer,
      answered_via: "cos",
    });
    expect(row(request_id).answered_at).toBeTruthy();
  });

  test("two concurrent answers: one wins, the other is a 409, the stored answer is the winner's", async () => {
    const id = await register("racer", "cli");
    const a = await register("answer-a", "cli");
    const b = await register("answer-b", "cli");
    const { request_id } = await ask({ peer_id: id, question: "q" });
    const rs = await Promise.all([
      call("/answer-request", { request_id, answerer_id: a, answer: "from a", answered_via: "cos" }),
      call("/answer-request", { request_id, answerer_id: b, answer: "from b", answered_via: "human" }),
    ]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = rs[0]!.status === 200 ? { a: "from a", by: a } : { a: "from b", by: b };
    expect(row(request_id)).toMatchObject({ answer: winner.a, answered_by: winner.by });
    const { messages } = await post<{ messages: unknown[] }>("/poll-messages", { id });
    expect(messages).toHaveLength(1);
  });

  test("escalate moves pending to escalated once; an escalated request can still be answered", async () => {
    const id = await register("escalator", "cli");
    const answerer = await register("esc-answerer", "cli");
    const { request_id } = await ask({ peer_id: id, question: "q" });
    expect((await call("/escalate-request", { request_id, peer_id: id, note: "urgent" })).status).toBe(200);
    expect(row(request_id)).toMatchObject({ state: "escalated", escalation_note: "urgent" });
    expect(row(request_id).escalated_at).toBeTruthy();
    expect((await call("/escalate-request", { request_id, peer_id: id })).status).toBe(409);
    expect((await call("/escalate-request", { request_id: "nope", peer_id: id })).status).toBe(404);
    const r = await call("/answer-request", { request_id, answerer_id: answerer, answer: "ok", answered_via: "human" });
    expect(r.status).toBe(200);
  });

  test("hook requests on one subject dedupe to one row with the last question; tool requests do not", async () => {
    const key = "dedupe-key";
    const ids = new Set<string>();
    let last = "";
    for (const question of ["one", "two", "three"]) {
      ids.add((await ask({ session_key: key, question, source: "hook" })).request_id);
      last = question;
    }
    expect(ids.size).toBe(1);
    const only = row([...ids][0]!);
    const first = only.created_at;
    expect(only).toMatchObject({ question: last, state: "pending", source: "hook" });
    const db = new Database(DB, { readonly: true });
    const n = (k: string) =>
      (db.query("SELECT COUNT(*) AS n FROM input_requests WHERE session_key = ?").get(k) as { n: number }).n;
    expect(n(key)).toBe(1);
    const t1 = await ask({ session_key: "tool-key", question: "a" });
    const t2 = await ask({ session_key: "tool-key", question: "b" });
    expect(t1.request_id).not.toBe(t2.request_id);
    expect(n("tool-key")).toBe(2);
    db.close();
    expect(row([...ids][0]!).created_at).toBe(first);
  });

  test("a hook request updates an escalated hook row without changing its state", async () => {
    const peer_id = await register("hook-esc", "cli");
    const a = await ask({ peer_id, question: "first", source: "hook" });
    await call("/escalate-request", { request_id: a.request_id, peer_id });
    const b = await ask({ peer_id, question: "second", source: "hook" });
    expect(b.request_id).toBe(a.request_id);
    expect(row(a.request_id)).toMatchObject({ state: "escalated", question: "second" });
  });

  test("close cancels one session's open requests and leaves another's alone", async () => {
    await ask({ session_key: "close-a", question: "1" });
    await ask({ session_key: "close-a", question: "2" });
    const other = await ask({ session_key: "close-b", question: "3" });
    const closed = await call<{ closed: number }>("/close-requests", { session_key: "close-a" });
    expect(closed).toMatchObject({ status: 200, ok: true, closed: 2 });
    const db = new Database(DB, { readonly: true });
    const rows = db.query("SELECT * FROM input_requests WHERE session_key = 'close-a'").all() as Record<
      string,
      string
    >[];
    db.close();
    for (const r of rows) {
      expect(r).toMatchObject({ state: "canceled", answered_via: "terminal" });
      expect(r.answered_at).toBeTruthy();
    }
    expect(row(other.request_id).state).toBe("pending");
    expect((await call("/close-requests", {})).status).toBe(400);
    expect((await call("/close-requests", { session_key: 5 })).status).toBe(400);
  });

  test("close also cancels the mapped peer's requests made by peer_id", async () => {
    const id = await regKeyed("close-mapped", LIVE_PIDS[0]!);
    const { request_id } = await ask({ peer_id: id, question: "q" });
    // Fake peers share live pids, so this id may carry other tests' open requests too.
    const { closed } = await call<{ closed: number }>("/close-requests", { session_key: "close-mapped" });
    expect(closed).toBeGreaterThanOrEqual(1);
    expect(row(request_id).state).toBe("canceled");
  });

  test("answering a hook-only request with no resolvable peer is a 409 and changes nothing", async () => {
    const answerer = await register("lonely-answerer", "cli");
    const { request_id } = await ask({ session_key: "unmapped-hook", question: "q", source: "hook" });
    const r = await call("/answer-request", { request_id, answerer_id: answerer, answer: "a", answered_via: "cos" });
    expect(r.status).toBe(409);
    expect(row(request_id)).toMatchObject({ state: "pending", answer: null });
    const db = new Database(DB, { readonly: true });
    expect(db.query("SELECT 1 FROM messages WHERE text LIKE ?").all(`%${request_id}%`)).toHaveLength(0);
    db.close();
  });

  test("answer validation: bad answered_via 400, unknown id 404, closed 409, bad types 400", async () => {
    const id = await register("validator", "cli");
    const answerer = await register("val-answerer", "cli");
    const { request_id } = await ask({ peer_id: id, question: "q" });
    const ans = (extra: Record<string, unknown>) =>
      call("/answer-request", { request_id, answerer_id: answerer, answer: "a", answered_via: "cos", ...extra });
    expect((await ans({ answered_via: "terminal" })).status).toBe(400);
    expect((await ans({ answered_via: undefined })).status).toBe(400);
    expect((await ans({ answer: 5 })).status).toBe(400);
    expect((await ans({ request_id: 5 })).status).toBe(400);
    expect((await ans({ request_id: "nope" })).status).toBe(404);
    expect(row(request_id).state).toBe("pending");
    expect((await ans({})).status).toBe(200);
    expect((await ans({})).status).toBe(409);
  });

  test("request-input validation and defaults", async () => {
    const peer_id = await register("req-val", "cli");
    expect((await ask({ peer_id })).status).toBe(400);
    expect((await ask({ peer_id, question: 5 })).status).toBe(400);
    expect((await ask({ peer_id, question: "q", source: "mouth" })).status).toBe(400);
    expect((await ask({ question: "q" })).status).toBe(400);
    const d = await ask({ peer_id, question: "q", waiting_for: 7, urgency: {} });
    expect(row(d.request_id)).toMatchObject({ waiting_for: "input needed", urgency: "normal", source: "tool" });
    const v = await ask({ peer_id, question: "q", waiting_for: "a decision", urgency: "whenever" });
    expect(row(v.request_id)).toMatchObject({ waiting_for: "a decision", urgency: "whenever" });
    const big = await ask({ peer_id, question: "x".repeat(10_000) });
    expect(row(big.request_id).question!.length).toBeLessThanOrEqual(4096);
  });

  test("an answer wakes a connected watcher", async () => {
    const id = await register("watched", "cli");
    const answerer = await register("watch-answerer", "cli");
    const w = await connectWatch(id);
    await w.next(); // "watching"
    const { request_id } = await ask({ peer_id: id, question: "q" });
    const r = await call("/answer-request", { request_id, answerer_id: answerer, answer: "go", answered_via: "human" });
    expect(r).toMatchObject({ status: 200, woke: 1 });
    expect(await w.next()).toEqual({ type: "wake" });
    w.ws.close();
  });

  test("an answer to an active-wake Desktop peer publishes to the relay", async () => {
    const d = await post<{ id: string; wake_topic: string }>("/register", {
      pid: LIVE_PIDS[0],
      cwd: "ans-desk",
      git_root: null,
      tty: null,
      summary: "Cowork",
      peer_type: "desktop",
      session_token: "cs_answer_desktop",
    });
    const answerer = await register("desk-answerer", "cli");
    const { request_id } = await ask({ peer_id: d.id, question: "q" });
    const before = relay.hits.length;
    const r = await call("/answer-request", { request_id, answerer_id: answerer, answer: "a", answered_via: "cos" });
    expect(r).toMatchObject({ status: 200, target_type: "desktop" });
    for (let i = 0; i < 50 && relay.hits.length === before; i++) await Bun.sleep(20);
    expect(relay.hits.filter((h) => h.path === `/${d.wake_topic}`).length).toBeGreaterThan(0);
    expect(JSON.stringify(r)).not.toContain("cs_answer_desktop");
  });

  test("/send-message to a missing peer still fails, and the gate demands credentials", async () => {
    const from_id = await register("sender", "cli");
    const r = await post<{ ok: boolean; error: string }>("/send-message", { from_id, to_id: "ghost", text: "hi" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not found");
    const bare = { "content-type": "application/json", authorization: headersFor(DB, "/x", {}).authorization! };
    const send = (path: string, body: unknown) =>
      fetch(`${HTTP}${path}`, { method: "POST", headers: bare, body: JSON.stringify(body) });
    expect((await send("/answer-request", { request_id: "x", answerer_id: from_id })).status).toBe(403);
    expect((await send("/escalate-request", { request_id: "x", peer_id: from_id })).status).toBe(403);
    expect((await send("/request-input", { peer_id: from_id, question: "q" })).status).toBe(403);
    expect((await send("/request-input", { session_key: "k", question: "q" })).status).toBe(200);
    expect((await send("/close-requests", { session_key: "k" })).status).toBe(200);
  });
});
