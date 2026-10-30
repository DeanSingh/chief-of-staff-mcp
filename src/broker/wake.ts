/**
 * Wake mode and the outbound wake relay for Desktop/Cowork sessions.
 */

import { WAKE_COALESCE_MS, WAKE_ON, WAKE_RELAY, WAKE_RELAY_ENV } from "./config.ts";
import { db } from "./db.ts";

// --- Wake mode ---
// Active: sends publish a wake and sessions are told to arm the Monitor, which
// costs each session a turn per 30-minute re-arm. Passive: pull only, no idle
// cost. A session's own setting wins over the global one, so one agent can
// stay awake while the rest are passive.
type WakeMode = "active" | "passive";
const isWakeMode = (v: unknown): v is WakeMode => v === "active" || v === "passive";

function globalWakeMode(): WakeMode {
  const row = db.query("SELECT value FROM settings WHERE key = 'desktop_wake'").get() as { value: string } | null;
  if (isWakeMode(row?.value)) return row.value;
  // Never set: a broker started with an explicit relay keeps waking, as it did
  // before modes existed.
  return WAKE_RELAY_ENV && WAKE_ON ? "active" : "passive";
}

export const effectiveWakeMode = (override: string | null): WakeMode =>
  isWakeMode(override) ? override : globalWakeMode();

/** <relay>/<topic> for a token whose wake mode is active, minting the topic on first use. */
export function activeWakeUrl(token: string): string | undefined {
  if (!WAKE_ON) return undefined;
  const row = db.query("SELECT wake_mode FROM desktop_tokens WHERE token = ?").get(token) as {
    wake_mode: string | null;
  } | null;
  if (!row || effectiveWakeMode(row.wake_mode) !== "active") return undefined;
  const topic = wakeTopicFor(token);
  return topic ? `${WAKE_RELAY}/${topic}` : undefined;
}

/** Topics whose wake mode is active right now, so a switch can tell which ones just went passive. */
function activeTopics(): Set<string> {
  const rows = db.query("SELECT wake_topic, wake_mode FROM desktop_tokens WHERE wake_topic IS NOT NULL").all() as {
    wake_topic: string;
    wake_mode: string | null;
  }[];
  return new Set(rows.filter((r) => effectiveWakeMode(r.wake_mode) === "active").map((r) => r.wake_topic));
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: argument validation and the off notices for every session a switch affects
export function handleWakeMode(body: { mode?: string; peer_id?: string; clear_overrides?: boolean }): {
  ok: boolean;
  error?: string;
  wake_url?: string;
} {
  const perPeer = typeof body.peer_id === "string";
  if (!isWakeMode(body.mode) && !(perPeer && body.mode === "default")) {
    return {
      ok: false,
      error: `mode must be active or passive${perPeer ? " (or default, to follow the global mode)" : ""}`,
    };
  }
  if (body.mode === "active" && !WAKE_ON) {
    return { ok: false, error: "the wake relay is disabled (CLAUDE_PEERS_WAKE_RELAY=off or invalid)" };
  }
  const token = perPeer
    ? (
        db.query("SELECT token FROM desktop_tokens WHERE peer_id = ? ORDER BY updated_at DESC").get(body.peer_id!) as {
          token: string;
        } | null
      )?.token
    : undefined;
  if (perPeer && !token) return { ok: false, error: `${body.peer_id} is not a desktop session` };

  const before = activeTopics();
  if (perPeer) {
    db.run("UPDATE desktop_tokens SET wake_mode = ? WHERE peer_id = ?", [
      body.mode === "default" ? null : body.mode!,
      body.peer_id!,
    ]);
  } else {
    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('desktop_wake', ?)", [body.mode!]);
    if (body.clear_overrides) db.run("UPDATE desktop_tokens SET wake_mode = NULL");
  }
  // A Monitor still listening on a topic that just went passive gets one
  // "off", which ends it, so the agent doesn't keep re-arming.
  const after = activeTopics();
  for (const topic of before) if (!after.has(topic)) postWake(topic, "off");
  return { ok: true, wake_url: token ? activeWakeUrl(token) : undefined };
}

export function handleWakeStatus(): {
  global: WakeMode;
  relay: string | null;
  peers: { id: string; summary: string; mode: WakeMode; own_setting: boolean }[];
} {
  const rows = db
    .query(`
    SELECT p.id, p.summary, t.wake_mode FROM peers p JOIN desktop_tokens t ON t.peer_id = p.id
    WHERE p.peer_type = 'desktop' ORDER BY p.summary
  `)
    .all() as { id: string; summary: string; wake_mode: string | null }[];
  return {
    global: globalWakeMode(),
    relay: WAKE_ON ? WAKE_RELAY : null,
    peers: rows.map((r) => ({
      id: r.id,
      summary: r.summary,
      mode: effectiveWakeMode(r.wake_mode),
      own_setting: isWakeMode(r.wake_mode),
    })),
  };
}

/** The token's wake topic, minted on first use (including tokens claimed before topics existed). */
function wakeTopicFor(token: string): string | undefined {
  const row = db.query("SELECT wake_topic FROM desktop_tokens WHERE token = ?").get(token) as {
    wake_topic: string | null;
  } | null;
  if (!row) return undefined;
  if (row.wake_topic) return row.wake_topic;
  const topic = `cp-wake-${Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
  db.run("UPDATE desktop_tokens SET wake_topic = ? WHERE token = ?", [topic, token]);
  return topic;
}

// At most one publish per topic per window. A send inside the window schedules
// one trailing publish at its end, so mail that lands just after a wake (while
// the agent is already reading its inbox) still wakes it again.
const wakeWindows = new Map<string, { last: number; trailing: boolean }>();

export function publishWake(topic: string): void {
  const now = Date.now();
  const w = wakeWindows.get(topic);
  if (w && now - w.last < WAKE_COALESCE_MS) {
    if (!w.trailing) {
      w.trailing = true;
      setTimeout(
        () => {
          w.trailing = false;
          w.last = Date.now();
          postWake(topic);
        },
        w.last + WAKE_COALESCE_MS - now,
      );
    }
    return;
  }
  wakeWindows.set(topic, { last: now, trailing: false });
  postWake(topic);
}

// Fire-and-forget: a slow or dead relay must never delay or fail a send. The
// mail is already queued; the agent still finds it on its next pull.
function postWake(topic: string, body: "wake" | "off" = "wake"): void {
  fetch(`${WAKE_RELAY}/${topic}`, { method: "POST", body, signal: AbortSignal.timeout(3000) })
    .then((r) => {
      // fetch resolves on 4xx/5xx; a rate-limited relay (429) must not fail silently.
      if (!r.ok) console.error(`[claude-peers broker] wake publish failed: HTTP ${r.status}`);
      return r.body?.cancel();
    })
    .catch((e) => console.error(`[claude-peers broker] wake publish failed: ${e}`));
}
