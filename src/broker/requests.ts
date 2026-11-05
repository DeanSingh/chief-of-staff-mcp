/**
 * Input requests: an agent that is blocked asks a question, and whoever
 * answers it (the chief of staff or the human) has the answer delivered to
 * that agent as ordinary mail, even after the agent restarted.
 */

import type { PeerType, Subject } from "../shared/types.ts";
import { db } from "./db.ts";
import { type Fail, clip, subjectOf } from "./events.ts";
import { announce, storeMessage } from "./messages.ts";

const fail = (status: Fail["status"], error: string): Fail => ({ ok: false, error, status });

const OPEN = "state IN ('pending', 'escalated')";
const QUESTION_MAX = 1024;
const ANSWERERS = ["cos", "human"];

type RequestInputBody = Subject & {
  question: string;
  waiting_for?: string;
  urgency?: string;
  source?: "tool" | "hook";
};

export function handleRequestInput(b: RequestInputBody): { ok: true; request_id: string } | Fail {
  if (typeof b.question !== "string" || !b.question) return fail(400, "question is required");
  const source = b.source ?? "tool";
  if (source !== "tool" && source !== "hook") return fail(400, "source must be tool or hook");
  const subject = subjectOf(b);
  if ("status" in subject) return subject;
  const question = clip(b.question, QUESTION_MAX);

  if (source === "hook") {
    // One open hook request per subject: a repeated notification refreshes it.
    const open = db
      .query(
        `SELECT id FROM input_requests
         WHERE source = 'hook' AND ${OPEN} AND (peer_id = ? OR session_key = ?) LIMIT 1`,
      )
      .get(subject.peer_id, subject.session_key) as { id: string } | null;
    if (open) {
      db.run("UPDATE input_requests SET question = ? WHERE id = ?", [question, open.id]);
      return { ok: true, request_id: open.id };
    }
  }

  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO input_requests (id, peer_id, session_key, question, waiting_for, urgency, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      subject.peer_id,
      subject.session_key,
      question,
      typeof b.waiting_for === "string" ? b.waiting_for : "input needed",
      typeof b.urgency === "string" ? b.urgency : "normal",
      source,
      new Date().toISOString(),
    ],
  );
  return { ok: true, request_id: id };
}

/** Cancel a session's open requests, e.g. when the human answers at the terminal. */
export function handleCloseRequests(b: { session_key: string }): { ok: true; closed: number } | Fail {
  if (typeof b.session_key !== "string" || !b.session_key) return fail(400, "session_key is required");
  const mapped = db.query("SELECT peer_id FROM peer_sessions WHERE session_key = ?").get(b.session_key) as {
    peer_id: string;
  } | null;
  const r = db.run(
    `UPDATE input_requests SET state = 'canceled', answered_via = 'terminal', answered_at = ?
     WHERE ${OPEN} AND (session_key = ? OR peer_id = ?)`,
    [new Date().toISOString(), b.session_key, mapped?.peer_id ?? null],
  );
  return { ok: true, closed: r.changes };
}

export function handleEscalateRequest(b: { request_id: string; peer_id: string; note?: string }): { ok: true } | Fail {
  if (typeof b.request_id !== "string") return fail(400, "request_id is required");
  if (!db.query("SELECT 1 FROM input_requests WHERE id = ?").get(b.request_id)) {
    return fail(404, `no such request: ${b.request_id}`);
  }
  const r = db.run(
    "UPDATE input_requests SET state = 'escalated', escalated_at = ?, escalation_note = ? WHERE id = ? AND state = 'pending'",
    [new Date().toISOString(), typeof b.note === "string" ? clip(b.note) : null, b.request_id],
  );
  return r.changes === 1 ? { ok: true } : fail(409, "request is not pending");
}

type RequestRow = { id: string; peer_id: string | null; session_key: string | null; question: string; state: string };

/** The peer an answer is mailed to: the row's own, else whoever its session key maps to. */
function resolvePeer(row: RequestRow): string | null {
  if (row.peer_id) return row.peer_id;
  if (!row.session_key) return null;
  const m = db.query("SELECT peer_id FROM peer_sessions WHERE session_key = ?").get(row.session_key) as {
    peer_id: string;
  } | null;
  return m?.peer_id ?? null;
}

type AnswerBody = { request_id: string; answerer_id: string; answer: string; answered_via: "cos" | "human" };

export function handleAnswerRequest(b: AnswerBody): { ok: true; woke: number; target_type: PeerType | null } | Fail {
  if (!ANSWERERS.includes(b.answered_via)) return fail(400, "answered_via must be cos or human");
  if (typeof b.request_id !== "string") return fail(400, "request_id is required");
  if (typeof b.answer !== "string" || !b.answer) return fail(400, "answer is required");
  const row = db.query("SELECT * FROM input_requests WHERE id = ?").get(b.request_id) as RequestRow | null;
  if (!row) return fail(404, `no such request: ${b.request_id}`);
  if (row.state === "answered" || row.state === "canceled") return fail(409, `request is already ${row.state}`);
  const to_id = resolvePeer(row);
  if (!to_id) return fail(409, "no peer to deliver the answer to");

  const answer = clip(b.answer);
  const text = `Answer to your request ${row.id} ("${clip(row.question, 120)}"): ${answer}`;
  // The conditional UPDATE is the arbiter between concurrent answers; the
  // message is inserted only for the one that wins.
  const won = db.transaction(() => {
    const r = db.run(
      `UPDATE input_requests SET state = 'answered', answer = ?, answered_by = ?, answered_via = ?, answered_at = ?
       WHERE id = ? AND ${OPEN}`,
      [answer, b.answerer_id, b.answered_via, new Date().toISOString(), row.id],
    );
    if (r.changes !== 1) return false;
    storeMessage(b.answerer_id, to_id, text);
    return true;
  })();
  if (!won) return fail(409, "request was closed by someone else");
  return { ok: true, ...announce(to_id) };
}
