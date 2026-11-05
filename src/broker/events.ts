/**
 * Decision-queue events: /report-event, and the subject resolution the other
 * decision-queue routes share.
 */

import { EVENT_LEVELS, type EventLevel, type Subject } from "../shared/types.ts";
import { db } from "./db.ts";

export type Fail = { ok: false; error: string; status: 400 | 404 | 409 };

/** A route result as an HTTP response: a Fail carries its status, success is 200. */
export function reply(r: { ok: boolean }): Response {
  return Response.json(r, { status: r.ok ? 200 : (r as unknown as Fail).status });
}

export const fail = (status: Fail["status"], error: string): Fail => ({ ok: false, error, status });

/** Cap on short agent-written fields (logger, waiting_for, urgency, session_key). */
export const FIELD_MAX = 256;

const TRUNCATED = "…[truncated]";
const DATA_MAX = 8192;
const DATA_PREVIEW = 8000;

/** Cap text at `max` chars, marking the cut. */
export function clip(text: string, max = 4096): string {
  return text.length <= max ? text : text.slice(0, max - TRUNCATED.length) + TRUNCATED;
}

/** JSON for the `data` column; over 8 KB it becomes a marked preview, never an error. */
export function clipData(data: unknown): string | null {
  if (data === undefined) return null;
  const json = JSON.stringify(data);
  if (json === undefined) return null;
  if (json.length <= DATA_MAX) return json;
  return JSON.stringify({ truncated: true, preview: json.slice(0, DATA_PREVIEW) });
}

/** The prefix of a Desktop session token, a bearer credential that is never stored as a key. */
export const DESKTOP_PREFIX = "cs_";

const given = (v: unknown) => v !== undefined && v !== null && v !== "";

/** True when a peer id is known: it has a live row or a durable session mapping. */
export function peerKnown(peer_id: string): boolean {
  return !!(
    db.query("SELECT 1 FROM peers WHERE id = ?").get(peer_id) ??
    db.query("SELECT 1 FROM peer_sessions WHERE peer_id = ?").get(peer_id)
  );
}

/**
 * Resolve who a row is about. Exactly one key is accepted. A session_key that
 * maps to a CLI peer resolves to it; an unmapped one is stored alone. A Desktop
 * session_key is a bearer token, so it is refused rather than stored.
 */
export function subjectOf(body: Subject): { peer_id: string | null; session_key: string | null } | Fail {
  const { peer_id, session_key } = body;
  if (given(peer_id) === given(session_key)) return fail(400, "give exactly one of peer_id or session_key");
  if (given(peer_id)) {
    return peerKnown(peer_id as string)
      ? { peer_id: peer_id as string, session_key: null }
      : fail(404, `no such peer: ${peer_id}`);
  }
  if (typeof session_key !== "string") return fail(400, "session_key must be a string");
  if (session_key.length > FIELD_MAX) return fail(400, `session_key is longer than ${FIELD_MAX} characters`);
  if (session_key.startsWith(DESKTOP_PREFIX))
    return fail(400, "a Desktop session token cannot be used as a session_key");
  const row = db.query("SELECT peer_id, peer_type FROM peer_sessions WHERE session_key = ?").get(session_key) as {
    peer_id: string;
    peer_type: string;
  } | null;
  if (row?.peer_type === "desktop")
    return fail(400, "a Desktop session cannot be addressed by session_key; use peer_id");
  return { peer_id: row?.peer_id ?? null, session_key };
}

type ReportEventRequest = Subject & {
  level?: string;
  message: string;
  source?: "tool" | "hook";
  logger?: string;
  data?: unknown;
};

export function handleReportEvent(b: ReportEventRequest): { ok: true; event_id: number } | Fail {
  if (typeof b.message !== "string" || !b.message) return fail(400, "message is required");
  const source = b.source ?? "tool";
  if (source !== "tool" && source !== "hook") return fail(400, "source must be tool or hook");
  const level = b.level ?? "info";
  if (!EVENT_LEVELS.includes(level as EventLevel)) return fail(400, `level must be one of ${EVENT_LEVELS.join(", ")}`);
  if (b.logger != null && typeof b.logger !== "string") return fail(400, "logger must be a string");
  const subject = subjectOf(b);
  if ("status" in subject) return subject;
  // A stop event records only that a turn ended: the assistant's last message
  // can carry case details, so neither it nor its data is kept.
  const isStop = b.logger === "stop";
  const r = db
    .query(
      `INSERT INTO events (peer_id, session_key, level, source, logger, message, data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      subject.peer_id,
      subject.session_key,
      level,
      source,
      b.logger == null ? null : clip(b.logger, FIELD_MAX),
      isStop ? "turn ended" : clip(b.message),
      isStop ? null : clipData(b.data),
      new Date().toISOString(),
    );
  return { ok: true, event_id: Number(r.lastInsertRowid) };
}
