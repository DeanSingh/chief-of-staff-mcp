/**
 * The chief-of-staff role: one peer, named from the terminal with
 * `bun cli.ts cos`, is the only one the broker lets answer, escalate, or read
 * and acknowledge the digest as a peer.
 */

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { headersFor, useBroker } from "./harness.ts";

const { HTTP, DB, post } = useBroker();

const sleepers: ReturnType<typeof Bun.spawn>[] = [];
/** A pid that stays alive, so each CLI peer gets its own id. */
const livePid = () => {
  const p = Bun.spawn(["sleep", "60"]);
  sleepers.push(p);
  return p.pid;
};
afterAll(() => {
  for (const p of sleepers) p.kill();
});

const call = async <T = Record<string, unknown>>(path: string, body: unknown) => {
  const res = await fetch(`${HTTP}${path}`, {
    method: "POST",
    headers: headersFor(DB, path, body),
    body: JSON.stringify(body),
  });
  return { status: res.status, ...((await res.json()) as T) } as { status: number } & T;
};

const regCli = async (session_key: string, pid = livePid(), extra: Record<string, unknown> = {}) =>
  (
    await post<{ id: string; cos?: boolean }>("/register", {
      pid,
      cwd: `/tmp/${session_key}`,
      git_root: null,
      tty: null,
      summary: session_key,
      peer_type: "cli",
      session_key,
      ...extra,
    })
  ).id;

const regDesktop = async (token: string, label: string) =>
  (
    await post<{ id: string }>("/register", {
      pid: process.pid,
      cwd: `/ (${label})`,
      git_root: null,
      tty: null,
      summary: label,
      peer_type: "desktop",
      session_token: token,
    })
  ).id;

const nameCos = (peer_id: string | null) => call<{ ok: boolean; peer_id: string | null }>("/set-cos", { peer_id });
const cosNow = async () => (await call<{ peer_id: string | null }>("/cos-status", {})).peer_id;

const ask = async (session_key: string) =>
  (await call<{ request_id: string }>("/request-input", { session_key, question: "q?" })).request_id;

function query<T>(sql: string, ...args: (string | number)[]): T {
  const db = new Database(DB, { readonly: true });
  try {
    return db.query(sql).get(...args) as T;
  } finally {
    db.close();
  }
}
const requestRow = (id: string) =>
  query<{ state: string; answer: string | null; escalated_at: string | null }>(
    "SELECT state, answer, escalated_at FROM input_requests WHERE id = ?",
    id,
  );
const cursorOf = (peer: string) =>
  query<{ position: number } | null>("SELECT position FROM digest_cursors WHERE peer_id = ?", peer);
const mailFrom = (peer: string) => query<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE from_id = ?", peer).n;

/** Every peer-scoped coordinator call, as `peer` would make it. */
const coordinatorCalls = (peer: string, request_id: string) => ({
  answer: () => call("/answer-request", { request_id, answerer_id: peer, answer: "yes", answered_via: "cos" }),
  escalate: () => call("/escalate-request", { request_id, peer_id: peer, note: "n" }),
  digest: () => call("/get-digest", { peer_id: peer }),
  ack: () => call("/ack-digest", { peer_id: peer, position: 1 }),
});

/** Every coordinator call from `peer` is refused and leaves nothing behind. */
async function expectRefused(peer: string) {
  const asker = `refused-${crypto.randomUUID()}`;
  await regCli(asker);
  const request_id = await ask(asker);
  for (const [name, run] of Object.entries(coordinatorCalls(peer, request_id))) {
    const r = await run();
    expect({ name, status: r.status }).toEqual({ name, status: 403 });
    expect(String(r.error)).toContain("only the chief of staff");
  }
  expect(requestRow(request_id)).toEqual({ state: "pending", answer: null, escalated_at: null });
  expect(cursorOf(peer)).toBeNull();
  expect(mailFrom(peer)).toBe(0);
}

async function expectAllowed(peer: string) {
  const asker = `allowed-${crypto.randomUUID()}`;
  await regCli(asker);
  const calls = coordinatorCalls(peer, await ask(asker));
  expect((await calls.digest()).status).toBe(200);
  expect((await calls.escalate()).status).toBe(200);
  expect((await calls.answer()).status).toBe(200);
}

describe("naming the chief of staff", () => {
  test("only an existing peer can be named, and the name can be cleared", async () => {
    await nameCos(null);
    expect(await cosNow()).toBeNull();
    expect((await nameCos("nosuchpeer")).status).toBe(404);
    expect((await call("/set-cos", { peer_id: 7 })).status).toBe(400);
    const id = await regCli("cos-named");
    expect((await nameCos(id)).peer_id).toBe(id);
    expect(await cosNow()).toBe(id);
    await nameCos(null);
    expect(await cosNow()).toBeNull();
    await expectRefused(id);
  });

  test("naming is recorded in the digest as a notice", async () => {
    const id = await regCli("cos-noticed");
    await nameCos(id);
    const d = await call<{ events: Array<{ level: string; logger: string; message: string }> }>("/get-digest", {
      since_id: 0,
      limit: 500,
    });
    expect(d.events.at(-1)).toMatchObject({ level: "notice", logger: "cos", message: `chief of staff is ${id}` });
  });

  test("with no chief of staff, nobody can answer", async () => {
    await nameCos(null);
    await expectRefused(await regCli("cos-nobody"));
  });

  test("the chief of staff can answer, escalate and read the digest", async () => {
    const id = await regCli("cos-allowed");
    await nameCos(id);
    await expectAllowed(id);
    expect((await call("/ack-digest", { peer_id: id, position: 1 })).status).toBe(200);
  });

  test("naming a new chief of staff strips the old one", async () => {
    const old = await regCli("cos-old");
    const next = await regCli("cos-new");
    await nameCos(old);
    await nameCos(next);
    await expectRefused(old);
    await expectAllowed(next);
  });

  test("the operator digest needs no role", async () => {
    await nameCos(null);
    expect((await call("/get-digest", {})).status).toBe(200);
  });
});

describe("who holds the role", () => {
  test("a non-COS CLI peer is refused", async () => {
    await nameCos(await regCli("cos-holder"));
    await expectRefused(await regCli("cos-bystander"));
  });

  test("register and heartbeat say whether the peer holds the role", async () => {
    const pid = livePid();
    const id = await regCli("cos-told", pid);
    expect((await post<{ cos?: boolean }>("/heartbeat", { id })).cos).toBeUndefined();
    await nameCos(id);
    expect((await post<{ cos?: boolean }>("/heartbeat", { id })).cos).toBe(true);
    const again = await post<{ id: string; cos?: boolean }>("/register", {
      pid,
      cwd: "/tmp/cos-told",
      git_root: null,
      tty: null,
      summary: "",
      peer_type: "cli",
      session_key: "cos-told",
    });
    expect(again).toMatchObject({ id, cos: true });
  });

  test("registration can't grant the role", async () => {
    await nameCos(await regCli("cos-real"));
    const claimant = await regCli("cos-claimant", livePid(), { cos: true, role: "cos" });
    await expectRefused(claimant);
    // Re-registering the same session doesn't either.
    await regCli("cos-claimant", livePid(), { cos: true });
    await expectRefused(claimant);
  });

  test("Desktop: a second session on the same server, even with the same label, is refused", async () => {
    const cos = await regDesktop("cs_cosdesk000001", "Chief of Staff");
    await nameCos(cos);
    const other = await regDesktop("cs_cosdesk000002", "Chief of Staff");
    expect(other).not.toBe(cos);
    await expectRefused(other);
    await expectAllowed(cos);
  });

  test("the role survives /clear: the new session key maps to the same peer", async () => {
    const pid = livePid();
    const id = await regCli("cos-before-clear", pid);
    await nameCos(id);
    const ss = await post<{ ok: boolean; peer_id: string; action: string }>("/session-start", {
      session_key: "cos-after-clear",
      pid,
      source: "clear",
    });
    expect(ss).toEqual({ ok: true, peer_id: id, action: "mapped" });
    await expectAllowed(id);
  });

  test("another process can't take the role by sending the COS key while the COS is live", async () => {
    const id = await regCli("cos-live-key");
    await nameCos(id);
    const pidB = livePid();
    const intruder = await regCli("cos-intruder", pidB);
    const ss = await post<{ ok: boolean; reason?: string }>("/session-start", {
      session_key: "cos-live-key",
      pid: pidB,
      source: "resume",
    });
    expect(ss).toEqual({ ok: false, reason: "conflict" });
    await expectRefused(intruder);
    expect(await cosNow()).toBe(id);
  });
});
