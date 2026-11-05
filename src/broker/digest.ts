/**
 * The digest: one read-only view of peers, open input requests and recent
 * events, plus the acknowledged cursor that lets a reader resume. A read
 * never moves a cursor; only /ack-digest does. Everything here is data for a
 * reader to weigh, not instructions.
 */

import {
  type Digest,
  type DigestEscalated,
  type DigestEvent,
  type DigestPeer,
  type DigestRequest,
  EVENT_LEVELS,
  type EventLevel,
} from "../shared/types.ts";
import { PUBLIC_CWD, db } from "./db.ts";
import type { Fail } from "./events.ts";

const fail = (error: string): Fail => ({ ok: false, error, status: 400 });

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

/** A Desktop session_key is a bearer token, so it never leaves the broker. */
const isDesktopKey = (col: string) =>
  `EXISTS (SELECT 1 FROM peer_sessions d WHERE d.session_key = ${col} AND d.peer_type = 'desktop')`;
const MAPPED_PEER = (col: string) => `(SELECT m.peer_id FROM peer_sessions m WHERE m.session_key = ${col})`;

/** Who a row is about and the key it is filed under, with Desktop keys withheld. */
const attribution = (t: string) =>
  `COALESCE(${t}.peer_id, ${MAPPED_PEER(`${t}.session_key`)}) AS peer_id,
   CASE WHEN ${isDesktopKey(`${t}.session_key`)} THEN NULL ELSE ${t}.session_key END AS session_key`;

const isCount = (v: unknown, min: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min;

type DigestBody = { peer_id?: string; since_id?: number; limit?: number; min_level?: EventLevel };

function checkBody(b: DigestBody): Fail | null {
  if (b.min_level != null && !EVENT_LEVELS.includes(b.min_level)) {
    return fail(`min_level must be one of ${EVENT_LEVELS.join(", ")}`);
  }
  if (b.limit != null && !isCount(b.limit, 1)) return fail("limit must be a positive integer");
  if (b.since_id != null && !isCount(b.since_id, 0)) return fail("since_id must be a non-negative integer");
  if (b.peer_id != null && typeof b.peer_id !== "string") return fail("peer_id must be a string");
  return null;
}

const highestEventId = () => (db.query("SELECT COALESCE(MAX(id), 0) AS m FROM events").get() as { m: number }).m;

function cursorPosition(peer_id: string): number {
  const row = db.query("SELECT position FROM digest_cursors WHERE peer_id = ?").get(peer_id) as {
    position: number;
  } | null;
  return row?.position ?? 0;
}

function listPeers(): DigestPeer[] {
  return db
    .query(
      `SELECT id, CASE WHEN peer_type = 'desktop' THEN NULL ELSE
                (SELECT s.session_key FROM peer_sessions s WHERE s.peer_id = peers.id AND s.peer_type != 'desktop'
                 ORDER BY s.updated_at DESC LIMIT 1) END AS session_key,
              summary, ${PUBLIC_CWD} AS cwd, peer_type, last_seen
       FROM peers ORDER BY registered_at, id`,
    )
    .all() as DigestPeer[];
}

function listRequests<T>(state: "pending" | "escalated", extra: string): T[] {
  return db
    .query(
      `SELECT r.id, ${attribution("r")}, r.question, r.waiting_for, r.urgency, r.source, r.created_at${extra}
       FROM input_requests r WHERE r.state = ? ORDER BY r.created_at, r.id`,
    )
    .all(state) as T[];
}

function listEvents(from: number, max: number, min_level: EventLevel, limit: number): DigestEvent[] {
  const levels = EVENT_LEVELS.slice(EVENT_LEVELS.indexOf(min_level));
  return db
    .query(
      `SELECT e.id, ${attribution("e")}, e.level, e.source, e.logger, e.message, e.created_at
       FROM events e
       WHERE e.id > ? AND e.id <= ? AND e.level IN (${levels.map(() => "?").join(",")})
       ORDER BY e.id LIMIT ?`,
    )
    .all(from, max, ...levels, limit + 1) as DigestEvent[];
}

export function handleGetDigest(b: DigestBody): Digest | Fail {
  const bad = checkBody(b);
  if (bad) return bad;
  const limit = Math.min(b.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const from = b.since_id ?? (b.peer_id ? cursorPosition(b.peer_id) : 0);
  const max = highestEventId();
  const events = listEvents(from, max, b.min_level ?? "info", limit);
  const truncated = events.length > limit;
  if (truncated) events.length = limit;
  const to = truncated ? events[limit - 1]!.id : Math.max(from, max);
  return {
    ok: true,
    peers: listPeers(),
    pending: listRequests<DigestRequest>("pending", ""),
    escalated: listRequests<DigestEscalated>("escalated", ", r.escalated_at, r.escalation_note"),
    events,
    cursor: { from, to, truncated },
  };
}

export function handleAckDigest(b: { peer_id: string; position: number }): { ok: true; position: number } | Fail {
  if (typeof b.peer_id !== "string" || !b.peer_id) return fail("peer_id is required");
  if (!isCount(b.position, 0)) return fail("position must be a non-negative integer");
  // Never backward (current wins), never past the newest event, and a swept
  // table (highest 0) cannot pull a stored position down.
  const r = db
    .query(
      `INSERT INTO digest_cursors (peer_id, position, updated_at) VALUES (?1, MIN(?2, ?3), ?4)
       ON CONFLICT (peer_id) DO UPDATE SET
         position = MAX(position, MIN(?2, ?3)), updated_at = ?4
       RETURNING position`,
    )
    .get(b.peer_id, b.position, highestEventId(), new Date().toISOString()) as { position: number };
  return { ok: true, position: r.position };
}
