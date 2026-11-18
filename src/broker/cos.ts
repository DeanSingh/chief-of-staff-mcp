/**
 * The chief-of-staff role. Exactly one peer may hold it, named by the human
 * from the terminal (`bun cli.ts cos <peer>`) or by typing `/claim-cos` in a
 * CLI session. No registration, re-key or MCP tool can grant or move it. The
 * broker checks it against the authenticated caller on every coordinator call:
 * that check is the control, and hiding the tools from other sessions is only
 * a convenience.
 *
 * The role belongs to a peer id. A CLI peer keeps its id across restarts,
 * `/resume` and `/clear` (all map back to it through peer_sessions); a Desktop
 * peer keeps its id for as long as it keeps its peer_session token, and a new
 * claim_session mints a new id, so it never inherits the role.
 */

import { db } from "./db.ts";
import { type Fail, fail } from "./events.ts";

const KEY = "cos_peer";

export function cosPeer(): string | null {
  const row = db.query("SELECT value FROM settings WHERE key = ?").get(KEY) as { value: string } | null;
  return row?.value ?? null;
}

export function isCos(peerId: unknown): boolean {
  return typeof peerId === "string" && peerId !== "" && peerId === cosPeer();
}

/** The body field each coordinator route names its caller in, already checked against its credential. */
const COS_ONLY: Record<string, { field: string; action: string; optional?: boolean }> = {
  "/answer-request": { field: "answerer_id", action: "answer requests" },
  "/escalate-request": { field: "peer_id", action: "escalate requests" },
  // Without a peer_id this is the operator digest (`bun cli.ts digest`): the install secret alone.
  "/get-digest": { field: "peer_id", action: "read the digest as a peer", optional: true },
  "/ack-digest": { field: "peer_id", action: "acknowledge the digest" },
};

/** A refusal for a coordinator route called by anyone but the chief of staff, else null. */
export function cosRefusal(path: string, body: Record<string, unknown> | null): Fail | null {
  const rule = COS_ONLY[path];
  if (!rule) return null;
  const caller = body?.[rule.field];
  if (caller == null && rule.optional) return null;
  if (isCos(caller)) return null;
  return fail(403, `only the chief of staff can ${rule.action}; name one with \`bun cli.ts cos <peer-id>\``);
}

/** Names the chief of staff (replacing any other), or clears the role with null. */
export function handleSetCos(b: { peer_id?: unknown }): { ok: true; peer_id: string | null } | Fail {
  const peer = b?.peer_id;
  if (peer !== null && typeof peer !== "string") return fail(400, "peer_id must be a peer id or null");
  if (peer && !db.query("SELECT 1 FROM peers WHERE id = ?").get(peer)) return fail(404, `no such peer: ${peer}`);
  const now = new Date().toISOString();
  db.transaction(() => {
    if (peer) db.run("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [KEY, peer]);
    else db.run("DELETE FROM settings WHERE key = ?", [KEY]);
    db.run(
      `INSERT INTO events (peer_id, level, source, logger, message, created_at)
       VALUES (?, 'notice', 'operator', 'cos', ?, ?)`,
      [peer || null, peer ? `chief of staff is ${peer}` : "no chief of staff", now],
    );
  })();
  return { ok: true, peer_id: peer || null };
}

export function handleCosStatus(): { ok: true; peer_id: string | null } {
  return { ok: true, peer_id: cosPeer() };
}

type Claimed = { ok: true; peer_id: string | null; previous: string | null; self: string };

/**
 * `/claim-cos` and `/release-cos` typed in a CLI session: the hook passes the
 * session's key, having checked the human typed the command at a terminal.
 * A claim names the CLI peer the key maps to; a release clears the role only
 * if that peer holds it. Desktop sessions run no hooks, so their tokens never
 * resolve here. Like /set-cos, it needs the install secret alone.
 */
export function handleClaimCos(b: { session_key?: unknown; release?: unknown }): Claimed | Fail {
  const key = b?.session_key;
  if (typeof key !== "string" || !key) return fail(400, "session_key is required");
  const row = db.query("SELECT peer_id FROM peer_sessions WHERE session_key = ? AND peer_type = 'cli'").get(key) as {
    peer_id: string;
  } | null;
  if (!row) return fail(404, "this session has no claude-peers peer");
  const previous = cosPeer();
  const holds = previous === row.peer_id;
  if (b.release === true && !holds) return { ok: true, peer_id: previous, previous, self: row.peer_id };
  const set = handleSetCos({ peer_id: b.release === true ? null : row.peer_id });
  return set.ok ? { ...set, previous, self: row.peer_id } : set;
}
