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
        "INSERT INTO input_requests (id, question, state, created_at, question_at, answered_at) VALUES (?, 'q', ?, ?, ?, ?)",
      );
      addRequest.run("old-answered", "answered", daysAgo(9), daysAgo(9), daysAgo(8));
      addRequest.run("old-canceled", "canceled", daysAgo(9), daysAgo(9), daysAgo(8));
      addRequest.run("old-pending", "pending", daysAgo(8), daysAgo(8), null);
      addRequest.run("old-escalated", "escalated", daysAgo(8), daysAgo(8), null);

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

  test("the sweep clears request text: closed after 24h, open after 7 days; rows and open state stay", async () => {
    const hoursAgo = (n: number) => new Date(Date.now() - n * 60 * 60 * 1000).toISOString();
    const FIXED = "(question text cleared after 7 days)";
    const seed = new Database(DB);
    try {
      const add = seed.prepare(
        `INSERT INTO input_requests (id, question, answer, escalation_note, state, created_at, question_at, answered_at)
         VALUES (?, 'secret q', ?, 'secret note', ?, ?, ?, ?)`,
      );
      add.run("ret-closed-25h", "secret a", "answered", daysAgo(2), daysAgo(2), hoursAgo(25));
      add.run("ret-closed-23h", "secret a", "answered", daysAgo(2), daysAgo(2), hoursAgo(23));
      add.run("ret-canceled-25h", null, "canceled", daysAgo(2), daysAgo(2), hoursAgo(25));
      add.run("ret-closed-8d", "secret a", "answered", daysAgo(9), daysAgo(9), daysAgo(8));
      add.run("ret-pending-8d", null, "pending", daysAgo(8), daysAgo(8), null);
      add.run("ret-escalated-8d", null, "escalated", daysAgo(8), daysAgo(8), null);
      add.run("ret-pending-6d", null, "pending", daysAgo(6), daysAgo(6), null);
    } finally {
      seed.close();
    }

    await restartBroker();

    const check = new Database(DB, { readonly: true });
    try {
      const get = (id: string) =>
        check.query("SELECT * FROM input_requests WHERE id = ?").get(id) as Record<string, string | null> | null;
      expect(get("ret-closed-25h")).toMatchObject({
        state: "answered",
        question: "",
        answer: null,
        escalation_note: null,
      });
      expect(get("ret-canceled-25h")).toMatchObject({ state: "canceled", question: "", escalation_note: null });
      expect(get("ret-closed-23h")).toMatchObject({
        question: "secret q",
        answer: "secret a",
        escalation_note: "secret note",
      });
      expect(get("ret-closed-8d")).toBeNull();
      expect(get("ret-pending-8d")).toMatchObject({ state: "pending", question: FIXED, escalation_note: null });
      expect(get("ret-escalated-8d")).toMatchObject({ state: "escalated", question: FIXED, escalation_note: null });
      expect(get("ret-pending-6d")).toMatchObject({
        state: "pending",
        question: "secret q",
        escalation_note: "secret note",
      });
    } finally {
      check.close();
    }
  });

  test("the sweep resets waiting_for and urgency with the text, and rewrites a cleared row only once", async () => {
    const seed = new Database(DB);
    try {
      const add = seed.prepare(
        `INSERT INTO input_requests (id, question, waiting_for, urgency, state, created_at, question_at, answered_at)
         VALUES (?, 'q', 'SENTINEL-WAIT', 'SENTINEL-URG', ?, ?, ?, ?)`,
      );
      const hours25 = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      add.run("rst-closed", "answered", daysAgo(2), daysAgo(2), hours25);
      add.run("rst-open", "pending", daysAgo(8), daysAgo(8), null);
      add.run("rst-fresh", "pending", daysAgo(1), daysAgo(1), null);
    } finally {
      seed.close();
    }

    await restartBroker();

    const check = new Database(DB, { readonly: true });
    try {
      const get = (id: string) => check.query("SELECT * FROM input_requests WHERE id = ?").get(id);
      expect(get("rst-closed")).toMatchObject({ waiting_for: "input needed", urgency: "normal" });
      expect(get("rst-open")).toMatchObject({ waiting_for: "input needed", urgency: "normal" });
      expect(get("rst-fresh")).toMatchObject({ waiting_for: "SENTINEL-WAIT", urgency: "SENTINEL-URG" });
    } finally {
      check.close();
    }
  });

  test("swept text is gone from the main database file and the -wal", async () => {
    const hours25 = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const seed = new Database(DB);
    try {
      seed.run(
        "INSERT INTO input_requests (id, question, state, created_at, question_at, answered_at) VALUES ('scrub-req', 'SCRUB-Q-SENTINEL-91', 'answered', ?, ?, ?)",
        [daysAgo(2), daysAgo(2), hours25],
      );
      seed.run("INSERT INTO events (message, created_at) VALUES ('SCRUB-E-SENTINEL-77', ?)", [daysAgo(8)]);
    } finally {
      seed.close();
    }

    await restartBroker();

    for (const file of [DB, `${DB}-wal`]) {
      const f = Bun.file(file);
      if (!(await f.exists())) continue;
      const bytes = Buffer.from(await f.arrayBuffer()).toString("latin1");
      expect(bytes).not.toContain("SCRUB-Q-SENTINEL-91");
      expect(bytes).not.toContain("SCRUB-E-SENTINEL-77");
    }
  });

  test("TTL-deleted mail is gone from the main database file and the -wal", async () => {
    // Nothing in the decision queue is eligible here, so only the messages
    // deletes change rows in this sweep.
    const seed = new Database(DB);
    try {
      seed.run(
        "INSERT INTO messages (from_id, to_id, text, sent_at, delivered) VALUES ('a', 'b', 'MAIL-DELIVERED-SENTINEL-55', ?, 1)",
        [new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()],
      );
      seed.run(
        "INSERT INTO messages (from_id, to_id, text, sent_at, delivered) VALUES ('a', 'b', 'MAIL-UNDELIVERED-SENTINEL-66', ?, 0)",
        [new Date(Date.now() - 73 * 60 * 60 * 1000).toISOString()],
      );
    } finally {
      seed.close();
    }

    await restartBroker();

    for (const file of [DB, `${DB}-wal`]) {
      const f = Bun.file(file);
      if (!(await f.exists())) continue;
      const bytes = Buffer.from(await f.arrayBuffer()).toString("latin1");
      expect(bytes).not.toContain("MAIL-DELIVERED-SENTINEL-55");
      expect(bytes).not.toContain("MAIL-UNDELIVERED-SENTINEL-66");
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

  test("a 5 KB logger is stored at 256 chars or fewer, and a stop logger still drops the message", async () => {
    const peer_id = await register("loggercap", "cli");
    const r = await post<{ event_id: number }>("/report-event", { peer_id, message: "x", logger: "l".repeat(5000) });
    expect(stored(r.event_id).logger!.length).toBeLessThanOrEqual(256);
    const s = await post<{ event_id: number }>("/report-event", { peer_id, message: "secret", logger: "stop" });
    expect(stored(s.event_id)).toMatchObject({ logger: "stop", message: "turn ended" });
  });

  test("a session_key over 256 chars is a 400 and stores nothing", async () => {
    const res = await rawPost({ session_key: "k".repeat(257), message: "longkey" });
    expect(res.status).toBe(400);
    const db = new Database(DB, { readonly: true });
    expect(db.query("SELECT 1 FROM events WHERE message = 'longkey'").all()).toHaveLength(0);
    db.close();
    expect((await rawPost({ session_key: "k".repeat(256), message: "okkey" })).status).toBe(200);
  });

  test("a Desktop-format session_key (cs_ prefix) is a 400 and stores nothing", async () => {
    const res = await rawPost({ session_key: "cs_anything", message: "csevent" });
    expect(res.status).toBe(400);
    const db = new Database(DB, { readonly: true });
    expect(db.query("SELECT 1 FROM events WHERE session_key LIKE 'cs_%'").all()).toHaveLength(0);
    db.close();
  });

  test("an explicit peer_id null with a session_key is accepted", async () => {
    const res = await rawPost({ peer_id: null, session_key: "null-peer-key", message: "nullpeer" });
    expect(res.status).toBe(200);
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

  test("a stop event stores a fixed message and no data; other loggers keep theirs", async () => {
    const peer_id = await register("stopper", "cli");
    const body = {
      peer_id,
      level: "warning",
      source: "hook",
      message: "Patient J. Doe, DOB 1/2/1980",
      data: { last_assistant_message: "private" },
    };
    const stop = await post<{ event_id: number }>("/report-event", { ...body, logger: "stop" });
    expect(stored(stop.event_id)).toMatchObject({
      message: "turn ended",
      data: null,
      level: "warning",
      source: "hook",
    });
    const other = await post<{ event_id: number }>("/report-event", { ...body, logger: "notification" });
    expect(stored(other.event_id)).toMatchObject({ message: body.message });
    expect(JSON.parse(stored(other.event_id).data!)).toEqual(body.data);
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

  test("a 2 KB question is truncated to 1 KB on insert and on the hook update path; answers keep 4 KB", async () => {
    const big = "q".repeat(2048);
    const a = await ask({ session_key: "cap-tool", question: big });
    expect(row(a.request_id).question!.length).toBeLessThanOrEqual(1024);
    expect(row(a.request_id).question!.endsWith("…[truncated]")).toBe(true);
    const h = await ask({ session_key: "cap-hook", question: "short", source: "hook" });
    await ask({ session_key: "cap-hook", question: big, source: "hook" });
    expect(row(h.request_id).question!.length).toBeLessThanOrEqual(1024);
    expect(row(h.request_id).question!.endsWith("…[truncated]")).toBe(true);
    const peer_id = await regKeyed("cap-key", LIVE_PIDS[0]!);
    const answerer = await register("cap-answerer", "cli");
    const r = await ask({ peer_id, question: "q" });
    await call("/answer-request", {
      request_id: r.request_id,
      answerer_id: answerer,
      answer: "a".repeat(2048),
      answered_via: "cos",
    });
    expect(row(r.request_id).answer).toHaveLength(2048);
    await post("/poll-messages", { id: peer_id }); // drain: fake peers share ids across tests
  });

  test("an answer given while the asker is down is delivered when it re-registers", async () => {
    const id = await regKeyed("down-key", LIVE_PIDS[0]!);
    const { request_id } = await ask({ peer_id: id, question: "Proceed?" });
    await post("/unregister", { id });
    const answerer = await register("down-answerer", "cli");
    const r = await call("/answer-request", {
      request_id,
      answerer_id: answerer,
      answer: "yes",
      answered_via: "human",
    });
    expect(r).toMatchObject({ status: 200, ok: true });
    expect(await regKeyed("down-key", LIVE_PIDS[1]!)).toBe(id);
    const { messages } = await post<{ messages: { text: string }[] }>("/poll-messages", { id });
    // Fake peers share ids across tests, so other mail may be queued too.
    expect(messages.map((m) => m.text)).toContain(`Answer to your request ${request_id} ("Proceed?"): yes`);
  });

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

  test("waiting_for and urgency are clipped to 256 chars; short values are stored verbatim", async () => {
    const big = await ask({
      session_key: "wf-big",
      question: "q",
      waiting_for: "w".repeat(5000),
      urgency: "u".repeat(5000),
    });
    expect(row(big.request_id).waiting_for!.length).toBeLessThanOrEqual(256);
    expect(row(big.request_id).urgency!.length).toBeLessThanOrEqual(256);
    const small = await ask({ session_key: "wf-small", question: "q", waiting_for: "a review", urgency: "high" });
    expect(row(small.request_id)).toMatchObject({ waiting_for: "a review", urgency: "high" });
  });

  test("a session_key over 256 chars, or in the Desktop token format, is a 400 and stores nothing", async () => {
    const long = await ask({ session_key: "k".repeat(257), question: "longkeyq" });
    expect(long.status).toBe(400);
    const cs = await ask({ session_key: "cs_anything", question: "csq" });
    expect(cs.status).toBe(400);
    const db = new Database(DB, { readonly: true });
    expect(db.query("SELECT 1 FROM input_requests WHERE question IN ('longkeyq', 'csq')").all()).toHaveLength(0);
    db.close();
  });

  test("answering a peer that no longer exists is a 409, leaves the request pending and mails nothing", async () => {
    const keyless = await register("keyless-asker", "cli");
    const answerer = await register("keyless-answerer", "cli");
    // Ids are shared across tests by pid: make sure this one has no session mapping.
    const seed = new Database(DB);
    seed.run("DELETE FROM peer_sessions WHERE peer_id = ?", [keyless]);
    expect(seed.query("SELECT 1 FROM peer_sessions WHERE peer_id = ?").all(keyless)).toHaveLength(0);
    seed.close();
    const { request_id } = await ask({ peer_id: keyless, question: "gone q" });
    await post("/unregister", { id: keyless });
    const r = await call("/answer-request", { request_id, answerer_id: answerer, answer: "a", answered_via: "cos" });
    expect(r.status).toBe(409);
    expect(row(request_id)).toMatchObject({ state: "pending", answer: null });
    const db = new Database(DB, { readonly: true });
    expect(db.query("SELECT 1 FROM messages WHERE text LIKE ?").all(`%${request_id}%`)).toHaveLength(0);
    db.close();
  });

  test("a new question on a week-old open hook row survives the sweep, and created_at is unchanged", async () => {
    const old = daysAgo(8);
    const seed = new Database(DB);
    seed.run(
      `INSERT INTO input_requests (id, session_key, question, source, created_at, question_at)
       VALUES ('stale-hook', 'stale-hook-key', 'old question', 'hook', ?, ?)`,
      [old, old],
    );
    seed.close();
    const upd = await ask({ session_key: "stale-hook-key", question: "fresh question", source: "hook" });
    expect(upd.request_id).toBe("stale-hook");
    await restartBroker();
    expect(row("stale-hook")).toMatchObject({ question: "fresh question", created_at: old });
    const d = await post<{ pending: Array<{ id: string; question: string; created_at: string }> }>("/get-digest", {});
    expect(d.pending.find((r) => r.id === "stale-hook")).toMatchObject({ question: "fresh question", created_at: old });
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

describe("digest and cursor", () => {
  type Dg = {
    ok: boolean;
    status: number;
    peers: Array<Record<string, unknown>>;
    pending: Array<Record<string, unknown>>;
    escalated: Array<Record<string, unknown>>;
    events: Array<Record<string, unknown>>;
    cursor: { from: number; to: number; truncated: boolean };
    error?: string;
  };
  const call = async <T = Dg>(path: string, body: unknown) => {
    const res = await fetch(`${HTTP}${path}`, {
      method: "POST",
      headers: headersFor(DB, path, body),
      body: JSON.stringify(body),
    });
    return { status: res.status, ...((await res.json()) as object) } as { status: number } & T;
  };
  const digest = (body: Record<string, unknown>) => call("/get-digest", body);
  const report = (body: Record<string, unknown>) => post<{ event_id: number }>("/report-event", body);
  const highest = () => {
    const db = new Database(DB, { readonly: true });
    try {
      return (db.query("SELECT COALESCE(MAX(id), 0) AS m FROM events").get() as { m: number }).m;
    } finally {
      db.close();
    }
  };
  const sql = (fn: (db: Database) => void) => {
    const db = new Database(DB);
    try {
      fn(db);
    } finally {
      db.close();
    }
  };
  const cursorRow = (peer_id: string) => {
    const db = new Database(DB, { readonly: true });
    try {
      return db.query("SELECT position FROM digest_cursors WHERE peer_id = ?").get(peer_id) as {
        position: number;
      } | null;
    } finally {
      db.close();
    }
  };
  const regKey = async (key: string, pid: number) =>
    (
      await post<{ id: string }>("/register", {
        pid,
        cwd: `/tmp/${key}`,
        git_root: null,
        tty: null,
        summary: key,
        peer_type: "cli",
        session_key: key,
      })
    ).id;

  test("a read does not advance the cursor; an ack does", async () => {
    const peer = await register("dg-reader", "cli");
    const { event_id } = await report({ peer_id: peer, message: "e1", level: "warning" });
    const a = await digest({ peer_id: peer });
    const b = await digest({ peer_id: peer });
    expect(a.cursor.from).toBe(b.cursor.from);
    expect(cursorRow(peer)).toBeNull();
    const acked = await call<{ position: number }>("/ack-digest", { peer_id: peer, position: event_id });
    expect(acked).toMatchObject({ status: 200, position: event_id });
    const c = await digest({ peer_id: peer });
    expect(c.cursor.from).toBe(event_id);
    expect(c.events.every((e) => (e.id as number) > event_id)).toBe(true);
  });

  test("pending and escalated requests land in separate arrays, with the escalation fields", async () => {
    const peer = await register("dg-asker", "cli");
    const p = await post<{ request_id: string }>("/request-input", { peer_id: peer, question: "pending q" });
    const e = await post<{ request_id: string }>("/request-input", { peer_id: peer, question: "escalated q" });
    await post("/escalate-request", { peer_id: peer, request_id: e.request_id, note: "needs a human" });
    const d = await digest({});
    expect(d.pending.map((r) => r.id)).toContain(p.request_id);
    expect(d.pending.map((r) => r.id)).not.toContain(e.request_id);
    const esc = d.escalated.find((r) => r.id === e.request_id)!;
    expect(esc).toMatchObject({ question: "escalated q", escalation_note: "needs a human", peer_id: peer });
    expect(typeof esc.escalated_at).toBe("string");
    expect(d.escalated.map((r) => r.id)).not.toContain(p.request_id);
    expect(d.pending.find((r) => r.id === p.request_id)).toMatchObject({
      peer_id: peer,
      session_key: null,
      waiting_for: "input needed",
      urgency: "normal",
      source: "tool",
    });
  });

  test("min_level defaults to info: debug events are skipped but the cursor passes them", async () => {
    const peer = await register("dg-level", "cli");
    const start = highest();
    await report({ peer_id: peer, message: "d1", level: "debug" });
    await report({ peer_id: peer, message: "d2", level: "debug" });
    await report({ peer_id: peer, message: "i1", level: "info" });
    const last = (await report({ peer_id: peer, message: "d3", level: "debug" })).event_id;
    const d = await digest({ since_id: start });
    expect(d.events.map((e) => e.message)).toEqual(["i1"]);
    expect(d.events[0]).not.toHaveProperty("data");
    expect(d.cursor).toEqual({ from: start, to: last, truncated: false });
    const all = await digest({ since_id: start, min_level: "debug" });
    expect(all.events).toHaveLength(4);
    const high = await digest({ since_id: start, min_level: "error" });
    expect(high.events).toHaveLength(0);
  });

  test("the default limit is 200 and truncation ends the cursor at the last returned id; 5000 is capped to 1000", async () => {
    const peer = await register("dg-limit", "cli");
    const start = highest();
    sql((db) => {
      const ins = db.prepare(
        "INSERT INTO events (peer_id, level, source, message, created_at) VALUES (?, 'info', 'tool', 'bulk', ?)",
      );
      const now = new Date().toISOString();
      for (let i = 0; i < 1205; i++) ins.run(peer, now);
    });
    const d = await digest({ since_id: start });
    expect(d.events).toHaveLength(200);
    expect(d.cursor).toEqual({ from: start, to: d.events[199]!.id as number, truncated: true });
    const big = await digest({ since_id: start, limit: 5000 });
    expect(big.events).toHaveLength(1000);
    expect(big.cursor.truncated).toBe(true);
    const five = await digest({ since_id: start, limit: 5 });
    expect(five.events).toHaveLength(5);
    const rest = await digest({ since_id: big.cursor.to, limit: 1000 });
    expect(rest.events).toHaveLength(205);
    expect(rest.cursor).toMatchObject({ truncated: false, to: highest() });
  });

  test("validation: bad min_level, limit, since_id or position is a 400", async () => {
    const peer = await register("dg-valid", "cli");
    for (const bad of [
      { min_level: "loud" },
      { limit: 0 },
      { limit: -3 },
      { limit: 1.5 },
      { limit: "9" },
      { since_id: -1 },
      { since_id: 1.5 },
      { since_id: "3" },
    ]) {
      expect((await digest(bad)).status).toBe(400);
    }
    for (const position of [-1, 2.5, "7", null]) {
      expect((await call("/ack-digest", { peer_id: peer, position })).status).toBe(400);
    }
  });

  test("an empty range or a since_id past the end never gives to < from", async () => {
    const past = highest() + 1_000_000;
    const d = await digest({ since_id: past });
    expect(d.events).toHaveLength(0);
    expect(d.cursor).toEqual({ from: past, to: past, truncated: false });
  });

  test("a Desktop token never appears in the digest", async () => {
    const start = highest();
    const d = await post<{ id: string }>("/register", {
      pid: LIVE_PIDS[1],
      cwd: "cs_digest_x",
      git_root: null,
      tty: null,
      summary: "desk",
      peer_type: "desktop",
      session_token: "cs_digest_x",
    });
    await report({ peer_id: d.id, message: "from desktop", level: "warning" });
    await post("/request-input", { peer_id: d.id, question: "desktop q" });
    sql((db) => {
      const now = new Date().toISOString();
      db.run(
        "INSERT INTO events (session_key, level, source, message, created_at) VALUES ('cs_digest_x', 'warning', 'hook', 'keyed', ?)",
        [now],
      );
      db.run(
        "INSERT INTO input_requests (id, session_key, question, created_at) VALUES ('dg-desk-req', 'cs_digest_x', 'q', ?)",
        [now],
      );
      db.run(
        "INSERT INTO input_requests (id, session_key, question, state, escalated_at, created_at) VALUES ('dg-desk-esc', 'cs_digest_x', 'q', 'escalated', ?, ?)",
        [now, now],
      );
    });
    const out = await digest({ min_level: "debug", since_id: start });
    const text = JSON.stringify(out);
    expect(text).not.toContain("cs_digest_x");
    expect(text).toContain("from desktop");
    expect(text).toContain("keyed");
    const row = out.pending.find((r) => r.id === "dg-desk-req")!;
    expect(row.session_key).toBeNull();
    expect(row.peer_id).toBe(d.id);
    expect(out.escalated.find((r) => r.id === "dg-desk-esc")!.session_key).toBeNull();
    const peer = out.peers.find((p) => p.id === d.id)!;
    expect(peer.session_key).toBeNull();
    expect(peer.cwd).not.toContain("cs_digest_x");
  });

  test("an unmapped cs_ key seeded directly never appears in the digest", async () => {
    sql((db) => {
      const now = new Date().toISOString();
      db.run(
        "INSERT INTO events (session_key, level, source, message, created_at) VALUES ('cs_unmapped_tok', 'warning', 'hook', 'unmapped', ?)",
        [now],
      );
      db.run(
        "INSERT INTO input_requests (id, session_key, question, created_at) VALUES ('dg-unmapped-cs', 'cs_unmapped_tok', 'q', ?)",
        [now],
      );
    });
    const out = await digest({ min_level: "debug", since_id: 0 });
    expect(JSON.stringify(out)).not.toContain("cs_unmapped_tok");
    expect(out.pending.find((r) => r.id === "dg-unmapped-cs")!.session_key).toBeNull();
  });

  test("peers[] lists public fields with the newest session key for a CLI peer", async () => {
    const id = await regKey("dg-peer-key", LIVE_PIDS[0]!);
    sql((db) => {
      db.run(
        "INSERT OR REPLACE INTO peer_sessions (session_key, peer_id, peer_type, updated_at) VALUES (?, ?, 'cli', ?)",
        ["dg-peer-key-newer", id, new Date(Date.now() + 60_000).toISOString()],
      );
    });
    const p = (await digest({})).peers.find((x) => x.id === id)!;
    expect(p).toMatchObject({ session_key: "dg-peer-key-newer", summary: "dg-peer-key", peer_type: "cli" });
    expect(Object.keys(p).sort()).toEqual(["cwd", "id", "last_seen", "peer_type", "session_key", "summary"]);
  });

  test("ack is monotonic and clamped to the highest event id", async () => {
    const peer = await register("dg-ack", "cli");
    sql((db) => {
      const ins = db.prepare(
        "INSERT INTO events (level, source, message, created_at) VALUES ('info', 'tool', 'pad', ?)",
      );
      for (let i = 0; i < 12; i++) ins.run(new Date().toISOString());
    });
    const ack = (position: number) => call<{ position: number }>("/ack-digest", { peer_id: peer, position });
    expect((await ack(10)).position).toBe(10);
    expect((await ack(3)).position).toBe(10);
    expect((await ack(1_000_000_000)).position).toBe(highest());
    expect(cursorRow(peer)!.position).toBe(highest());
  });

  test("ack does not regress once events have been swept", async () => {
    const peer = await register("dg-swept", "cli");
    await report({ peer_id: peer, message: "x" });
    const top = highest();
    expect((await call<{ position: number }>("/ack-digest", { peer_id: peer, position: top })).position).toBe(top);
    sql((db) => db.run("DELETE FROM events"));
    const after = await call<{ position: number }>("/ack-digest", { peer_id: peer, position: 1_000_000_000 });
    expect(after.position).toBe(top);
    expect(cursorRow(peer)!.position).toBe(top);
  });

  test("an operator digest needs only the install secret and leaves cursors alone", async () => {
    const before = (() => {
      const db = new Database(DB, { readonly: true });
      try {
        return JSON.stringify(db.query("SELECT * FROM digest_cursors ORDER BY peer_id").all());
      } finally {
        db.close();
      }
    })();
    const bare = { "content-type": "application/json", authorization: headersFor(DB, "/x", {}).authorization! };
    const res = await fetch(`${HTTP}/get-digest`, { method: "POST", headers: bare, body: "{}" });
    expect(res.status).toBe(200);
    const db = new Database(DB, { readonly: true });
    try {
      expect(JSON.stringify(db.query("SELECT * FROM digest_cursors ORDER BY peer_id").all())).toBe(before);
    } finally {
      db.close();
    }
  });

  test("naming a peer needs that peer's credential, on both routes", async () => {
    const peer = await register("dg-gate", "cli");
    const bare = { "content-type": "application/json", authorization: headersFor(DB, "/x", {}).authorization! };
    for (const [path, body] of [
      ["/get-digest", { peer_id: peer }],
      ["/ack-digest", { peer_id: peer, position: 1 }],
    ] as const) {
      const res = await fetch(`${HTTP}${path}`, { method: "POST", headers: bare, body: JSON.stringify(body) });
      expect(res.status).toBe(403);
    }
    const noId = await fetch(`${HTTP}/ack-digest`, {
      method: "POST",
      headers: bare,
      body: JSON.stringify({ position: 1 }),
    });
    expect(noId.status).toBe(403);
  });

  test("an event reported under a session key resolves to the peer that registers it later", async () => {
    const start = highest();
    await post("/report-event", { session_key: "dg-late-key", message: "early", level: "warning" });
    const before = await digest({ since_id: start });
    expect(before.events[0]).toMatchObject({ peer_id: null, session_key: "dg-late-key" });
    const id = await regKey("dg-late-key", LIVE_PIDS[1]!);
    const after = await digest({ since_id: start });
    expect(after.events[0]).toMatchObject({ peer_id: id, session_key: "dg-late-key" });
  });
});
