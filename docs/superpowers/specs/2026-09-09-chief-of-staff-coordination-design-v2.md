# Chief-of-Staff Coordination Layer — Design v2

**Date:** 2026-09-09
**Status:** Draft for review
**Supersedes:** `2026-09-08-chief-of-staff-coordination-design.md`
**Repo:** `chief-of-staff-mcp` (wire identity `claude-peers`)

## 0. What changed from v1, and why

v1 was reviewed by a staff engineer agent (§17 of the v1 document, which stands
as the review record and is cited here rather than absorbed). It raised three
blocking findings. All three were independently verified against the code and
all three hold:

| Finding | Verified how | Consequence |
| --- | --- | --- |
| **`tasks` has no producer.** The human assigns work by typing into terminals; nothing calls `assign_task`. | Operator reasoning; no counter-example found | `tasks`, `assign_task`, `update_task`, the A2A state machine, and the `stalled` projection are **cut from this design** |
| **The design ignored Claude Code's own primitives.** | `claude --version` → 2.1.266; `ListAgents`; `claude agents --json --all` | §2 rewritten around what the harness ships |
| **v1's regression test proved the wrong property.** Preserving a message row addressed to a dead peer id delivers nothing. | `server.ts:50` (`HOST_PID`), `broker.ts:271` (pid lookup) | Durable identity is now Phase 1, and the test asserts *delivery to a restarted peer* |

v1's §14 wake-on-push experiment, its events-vs-state separation, its monotonic
cursor, and its ack-after-processing rule all survive. Its `tasks` model does not.

## 1. Problem

Multiple Claude Code terminals, Desktop sessions, and cloud Cowork sessions run
at once. The human assigns work by typing into them. Once several are running,
**the human is the monitoring system** — and an agent that stops to ask a
question waits silently until someone notices.

This is not hypothetical. Observed on 2026-09-08, 18 live peers, three of them
blocked on the human and saying so only in a free-text field nothing polls:

- `zhci94yl` — *"Awaiting Dean's word before any branch or PR."*
- `qavxmwmj` — *"proposals for CA2 … pending Dean's word."*
- `x5wqlfrt` — *"Blocked on measured COGS for reports intelligence + dictation."*

Agents have already improvised the missing feature inside `set_summary`, cramming
state, blockers, history, and routing rules into a one-line status string. One
summary contains *"ttys015/eyrg5k5e also answers to that name, so route by peer
ID not name"* — an agent hand-rolling a coordination protocol because there is
nowhere structured to put it. This design gives that behavior a home.

## 2. What Claude Code already does — and what it does not

Claude Code 2.1.266 ships cross-session messaging, session naming, agent-view
state, and hooks. **Anything the harness does, this design must not rebuild.**

### 2.1 Native coverage [observed on 2.1.266]

`claude agents --json --all` returns, per session:

```json
{ "pid": 20790, "cwd": "/Users/deansingh/git/auditor", "kind": "interactive",
  "startedAt": 1788553100891, "sessionId": "7d20326c-…",
  "name": "Auditor Agent", "status": "waiting", "waitingFor": "input needed" }
```

That single row carries durable identity, live status, and blocked-state
detection — three things v1 proposed to build from scratch.

> **Docs conflict, resolved by observation.** The agent-view docs state that
> `claude agents` lists only background sessions started with `/bg` or `-p`, and
> explicitly *not* "interactive sessions you have open in other terminals." On
> 2.1.266 it returned `kind: "interactive"` rows for eleven foreground terminal
> sessions. **Observation governs this design**; a reader checking only the docs
> would reach the opposite conclusion. Re-verify on upgrade.

Two state vocabularies exist and must not be conflated:

| Surface | Values |
| --- | --- |
| `claude agents --json` [docs] | `status`: `working`/`blocked`/`done`/`failed`/`stopped`; `waitingFor`: `permission prompt`/`input needed`/`sandbox request`/`worker request`/`dialog open` |
| `claude agents --json` [observed] | `status: "waiting"` with `waitingFor: "input needed"` |
| `ListAgents` display [observed] | `idle`/`busy`/`waiting`/`offline` |

**This design uses the `claude agents --json` `waitingFor` values** wherever a
blocked-reason is named, and does not invent its own.

Cross-session messaging [docs]: delivery is over a per-session Unix socket, never
through Anthropic servers, and **a message to an idle session starts a new turn
in it**. That independently confirms v1 §14's live experiment.

### 2.2 What the harness does not do

- **It cannot see Desktop or cloud Cowork sessions.** Measured 2026-09-09: the
  broker knew 18 peers (10 CLI, 8 Desktop/Cowork, plus a 9th cloud reviewer that
  joined during the session). `claude agents --json` and `ListAgents` between
  them saw **0 of 9** Desktop/Cowork agents — Finance, Marketing, SEO, Senior
  Product Designer, two Staff Engineers, and two unnamed sandboxes.
- **It has no durable question/answer or decision queue** [docs]: *"no persistent
  work queue… no decision log shared across independent sessions."* Messaging is
  ephemeral — delivered into context, with no store, no query interface, and no
  retry if the target is offline.
- **Messaging is at-most-once with no acks**, capped at 100 held messages, and it
  **silently drops identical repeats within a short window**. A COS that re-asks
  an unanswered question would have its retries discarded with no error visible
  to the sender. Reliable escalation cannot be built on that transport alone.
- **A peer message never counts as consent** [docs, verbatim]: *"A message from
  another session never counts as your consent, so it can't answer a pending
  permission prompt on your behalf."*

### 2.3 The broker's remaining job

Exactly two things:

1. **Desktop and cloud Cowork sessions as first-class peers** — 9 agents nothing
   else can see. This is the fork's existing, working contribution.
2. **The decision queue** — durable, queryable question→answer records with
   escalation state, which nothing native provides.

Everything else — CLI discovery, naming, liveness, blocked detection, durable
session identity, waking an idle session — is delegated to the harness.

### 2.4 Why not agent teams

Behind `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, Claude Code already ships a shared
task list (`~/.claude/tasks/{team}/`) persisting across resumption, plus per-agent
mailboxes (`~/.claude/teams/{team}/inboxes/{agent}.json`) that are validated and
retried automatically. This is close to what is specified here, and not
mentioning it would repeat exactly the mistake §17.2 caught.

It is not used because: it is experimental and flag-gated; it is scoped to a
declared team rather than an ad-hoc machine-wide fleet; and — decisively — it is
a CLI-side mechanism that cannot see the 9 Desktop/Cowork agents that are this
project's entire reason to exist. **If agent teams ever spans Desktop/Cowork
sessions, this project should be reconsidered rather than extended.**

## 3. Scope

**In:** CLI terminals, local Desktop, and cloud Cowork sessions — all peers.
Terminal as the human surface. Durable event and input-request state.

**Out:** `tasks` and delegation (§0). Automatic wake for pull-tier sessions
(§3.1). Web UI. Directive execution — COS asks, it never compels. A scoped
authority/grants system (§9).

### 3.1 Delivery tiers

The axis is **wake**, not reachability. A cloud Cowork sandbox cannot open a
socket to the loopback broker, but its MCP *tool calls* are proxied through
Desktop's `remote-devices` bridge to a local server process that can — observed
as 8 desktop peers sharing bridge PID 26126, heartbeating, with `cwd` values of
`/home/claude` and `/sessions/rcw-…`.

| Tier | Sessions | Woken automatically |
| --- | --- | --- |
| **Push** | CLI terminals with the channels flag | ✅ verified — an idle session resumes |
| **Watch** | Local Desktop with `Monitor` armed | ✅ WS wake feed |
| **Pull** | Cloud Cowork; anything else | ❌ next tool call, or a human nudge |

Every tier can write events, raise input-requests, and read digests. **The design
must never assume an answer arrives — only that it is durable and retrievable.**

## 4. Identity — the prerequisite

CLI peers are currently keyed on `HOST_PID` (`server.ts:50`), so a restarted
agent gets a **new** peer id and mail addressed to the old one is undeliverable
forever. Desktop already solved this with `desktop_tokens`; CLI must get the same
treatment, keyed on Claude Code's `sessionId`, which is stable across `--resume`
and across crash+restart [docs].

**A `SessionStart` hook is mandatory, not optional.** Verified by direct search
including the MCP SDK types: nothing hands a Claude Code session id to an MCP
stdio server — `_meta` carries only `progressToken`. Hooks receive `session_id`
on stdin; the server process cannot obtain it any other way.

Three code sites treat pid-death as identity-death and must change together:

| Site | Current behavior |
| --- | --- |
| `broker.ts:271` | CLI re-registration looks up `WHERE pid = ? AND peer_type != 'desktop'` |
| `broker.ts:93-109` | 30s sweep: dead pid → delete peer row **and undelivered mail (`:107`)** |
| `broker.ts:~344-353` | `handleListPeers` runs a **second, duplicate** pid check and calls `deletePeer.run(p.id)` inline, on every `list_peers` call |

That third site is easy to miss and would silently undo the fix on a code path
nobody was looking at.

**Resolution.** Generalize `desktop_tokens` into a peer-type-agnostic
`peer_sessions(session_key → peer_id)` table. Pid liveness may still reap a
*row* promptly, but must never be read as identity death, and must never delete
mail. Reaping a row while the key survives is already exactly what Desktop does.

## 5. Schema

Three new tables plus one generalization. Follows the existing
`CREATE TABLE IF NOT EXISTS` + `PRAGMA table_info` migration conventions.

```sql
-- Generalizes desktop_tokens to all peer types. Migrate existing rows in.
CREATE TABLE IF NOT EXISTS peer_sessions (
  session_key TEXT PRIMARY KEY,   -- Claude Code sessionId (CLI) | claimed token (desktop)
  peer_id     TEXT NOT NULL,
  peer_type   TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,  -- monotonic; the digest cursor
  peer_id     TEXT NOT NULL,
  level       TEXT NOT NULL DEFAULT 'info',       -- RFC 5424
  source      TEXT NOT NULL DEFAULT 'tool',       -- 'tool' | 'hook'
  logger      TEXT,
  message     TEXT NOT NULL,
  data        TEXT,                               -- JSON; see §11 truncation
  created_at  TEXT NOT NULL
);
-- The digest scan (WHERE id > ? ORDER BY id) rides the rowid. This index serves
-- per-agent history for the CLI and the eventual UI.
CREATE INDEX IF NOT EXISTS idx_events_peer ON events(peer_id, id);

CREATE TABLE IF NOT EXISTS input_requests (
  id            TEXT PRIMARY KEY,
  peer_id       TEXT NOT NULL,
  question      TEXT NOT NULL,
  waiting_for   TEXT NOT NULL DEFAULT 'input needed',  -- Claude Code's vocabulary (§2.1)
  urgency       TEXT NOT NULL DEFAULT 'normal',
  state         TEXT NOT NULL DEFAULT 'pending',       -- pending|escalated|answered|canceled
  answer        TEXT,
  answered_by   TEXT,
  answered_via  TEXT,                                  -- 'cos' | 'human'
  created_at    TEXT NOT NULL,
  answered_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_requests_state ON input_requests(state);

CREATE TABLE IF NOT EXISTS digest_cursors (
  peer_id     TEXT PRIMARY KEY,
  position    INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL
);
```

**Retention**, extending the existing startup cleanup: `events` > 7d deleted;
`input_requests` in `answered`/`canceled` > 7d deleted; `peer_sessions` > 30d
deleted (matching today's `desktop_tokens` TTL). Undelivered `messages` keep
their existing 72h TTL, which becomes their **only** bound (§4).

`PRAGMA foreign_keys` is off (`broker.ts:33-34` sets only `journal_mode` and
`busy_timeout`), so the `messages` FKs to `peers(id)` enforce nothing. That is
what permits an insert addressed to a reaped-but-resurrectable peer. **Leave it
off and drop the misleading FK declarations**, rather than documenting a lie.

## 6. Broker API

New POST routes on the existing `switch (path)` dispatch, following the
`{ ok, error? }` + 404 convention that `/set-summary` establishes.

| Route | Request | Response |
| --- | --- | --- |
| `/report-event` | `{ peer_id, level, message, source?, logger?, data? }` | `{ ok, event_id }` |
| `/request-input` | `{ peer_id, question, waiting_for?, urgency? }` | `{ ok, request_id }` |
| `/answer-request` | `{ request_id, answerer_id, answer, answered_via }` | `{ ok, woke }` |
| `/escalate-request` | `{ request_id, note? }` | `{ ok }` |
| `/get-digest` | `{ peer_id, since_id?, limit? }` | `Digest` (§7) |
| `/ack-digest` | `{ peer_id, position }` | `{ ok }` |

`/answer-request` **must not call `handleSendMessage`** (`broker.ts:376`): it
404s when the target `peers` row is absent (`:378-381`), which is precisely the
restarted-peer case this must succeed through. It performs its own insert without
the existence check, then calls `notifyWatchers` (`broker.ts:365`) after commit.
That unguarded insert is new code and needs its own tests; it inherits no
hardening.

Concurrency: the state change is a single conditional
`UPDATE input_requests SET … WHERE id = ? AND state IN ('pending','escalated')`,
accepted only on one row affected. A read-then-write would let two COS readers
both answer.

## 7. Digest

```jsonc
{
  "peers":   [{ "id", "name", "summary", "cwd", "peer_type", "last_seen" }],
  "native":  [{ "sessionId", "name", "status", "waitingFor", "cwd" }],  // claude agents --json
  "pending": [{ "id", "peer_id", "question", "waiting_for", "urgency", "created_at" }],
  "events":  [{ "id", "peer_id", "level", "source", "message", "created_at" }],
  "cursor":  { "from": 1234, "to": 1291, "truncated": false }
}
```

**`native` is COS's job, not the broker's.** COS shells `claude agents --json`
itself and merges. The broker must not shell out to the harness — it is a daemon
with no session context, and coupling it to a CLI whose output shape is
explicitly version-unstable would be a mistake. Merging two populations into one
report is precisely the chief-of-staff role.

`pending` returns `state='pending'` **only**. An escalated request is already in
front of the human; excluding it is enforced by the query, not by prompt
discipline.

Cursor semantics: reads never advance; `ack_digest` does, after the tick's work
succeeds. Two COS readers are safe — `digest_cursors` is per-peer and event reads
are non-destructive, unlike the consumed `messages` mailbox.

## 8. Hooks

A small bundle in `~/.claude/settings.json`. This is the deterministic signal;
`request_input` is the cooperative backstop, not the other way round.

| Hook | Purpose | Key payload fields |
| --- | --- | --- |
| `SessionStart` | **Identity.** POST `session_id` → broker, establishing the CLI peer's durable key. | `session_id`, `cwd`, `session_start_reason` (`startup`/`resume`/`clear`/`compact`/`fork`) |
| `Notification` | **Blocked detection**, no agent cooperation required. | `notification_type` — act on `agent_needs_input`; record `permission_prompt` but **never** answer it (§2.2) |
| `Stop` | Turn ended — an `info` event marking idleness. | `session_id`, `last_assistant_message` |

`Notification` also emits `idle_prompt`, `agent_completed`, `auth_success`, the
`elicitation_*` family, and `quota_auto_resume_*`. Only `agent_needs_input` and
`permission_prompt` are consumed in v1; the rest are recorded at `debug`.

**Permission boundary.** A `permission_prompt` notification tells COS an agent is
blocked *on a permission*. COS reports it to the human and stops there. It may
never answer it — the harness forbids it, and it is the correct boundary: COS
settles questions, the human settles permissions, in the agent's own session.

## 9. COS operating model and authority

COS is a Claude Code terminal running `/loop`, registered as an ordinary peer.
Per tick: `get_digest` → merge `claude agents --json` → summarize for the human →
answer or escalate → `ack_digest` **last**, so a crash re-reads rather than loses.

`answer_request` returns `woke`. COS must tell the human which answers landed
live and which are queued for a pull-tier agent needing a nudge — *"answered the
Finance agent; it's Desktop, so it won't see it until you prompt it."* Knowing
who needs poking is the job.

**Authority ships as zero code.** COS is a Claude session; its authority is what
its instructions say, and the human controls those. A grants table is engineering
for a policy not yet discovered. `answered_via` records which decisions COS made
versus relayed — that is the dataset a real grants design should be built from
later. It is a decision log, not an audit trail: COS sets the field about itself.

## 10. Error handling

- Unknown ids → `{ ok: false, error }`, HTTP 404, per the `/set-summary` pattern.
- Broker unreachable → surfaced to the calling agent, never swallowed.
- Duplicate answer → rejected, original preserved (§6).
- **`data` over 8 KB** → the broker stores
  `{"truncated": true, "preview": "<first N chars>"}`. A truncated JSON string is
  not JSON, so v1's "merge a `truncated` key into the truncated value" was not
  implementable. Enforced broker-side, since the CLI and any future writer bypass
  tool-side validation. Truncate, never reject: telemetry must not break a turn.
- Digest `limit` defaults to 200 with `truncated: true`, bounding COS's context.

## 11. Testing

Extends `broker.test.ts` (51 passing today, verified by two `bun test` runs).

**The test that matters** — v1's proved the wrong property:

> `request_input` → kill the assignee's process → re-register under the **same
> `session_key`** → `answer_request` → **assert the restarted peer can read the
> answer.** Preserving a row addressed to a dead id is not delivery.

Also: cursor read-does-not-advance, then `ack_digest` does; concurrent
`answer_request` (exactly one wins); escalated requests leave `pending`;
`handleListPeers` no longer deletes rows on stale pid; oversized `data` stored as
`{truncated, preview}`; retention sweeps.

**Existing tests that must change** (`broker.test.ts:22-33`, `:148-155`) encode
pid-based CLI dedup — `"cli re-register with the same pid keeps the same id"` is
pinned to the `broker.ts:271` branch this design removes.

**Type debt to pay, not compound.** `bunx tsc --noEmit` fails at
`server.test.ts:52` (TS2352) and `:56` (TS2532). Root cause: `buildTools()` has
no return-type annotation, so TypeScript infers a union of five heterogeneous
tool-object literals, and `noUncheckedIndexedAccess` makes the indexed access
possibly-undefined. Every tool added widens that union. Fix: give `buildTools()`
an explicit `McpToolDef[]` return type with
`properties: Record<string, { type: string; description: string; enum?: string[] }>`.

**Tool registration note.** The runtime `peer_session` guard is blanket — any
desktop call to any non-`EXEMPT` tool is rejected (`server.ts:571`, `:596-609`).
`SESSION_ID_REQUIRED_TOOLS` (`:351-355`) is read only by the parity test, not by
the guard. New tools need `withSessionId([...])` in their schema and an entry in
that list for coverage.

## 12. Phasing

| Phase | Contents |
| --- | --- |
| **1** | `peer_sessions` identity + `SessionStart` hook; remove both mail-deleting paths (`broker.ts:107` and the `handleListPeers` inline delete); `events` + `input_requests` + digest/cursor; `Notification`/`Stop` hooks; `bun cli.ts digest`; the `buildTools()` type fix |
| **2** | COS profile and `/loop` operating model on top of Phase 1, validated against a Desktop peer |
| **3** | `tasks` — **only if** delegation through the mesh is ever observed |
| **4** | Optional non-loopback rendezvous so pull-tier sessions wake automatically; web UI over the same schema |

Identity and mail-retention **must land together**. Removing the deletion alone
leaves the message addressed to an id no future registration can match; making
identity durable alone leaves the message already deleted.

## 13. Open questions

1. **Are `CLAUDE_CODE_MESSAGING_SOCKET` / `_TOKEN` inherited by an MCP server
   child?** Unmeasured — a presence check was blocked by the permission
   classifier and not worked around. If they are inherited, there may be a path
   to session identity that does not require a hook. Worth one presence-only
   check (set/unset, length) before building the hook, since it would simplify
   Phase 1 materially.
2. **Does an agent reliably call `request_input`?** Now a *secondary* question:
   the `Notification` hook detects blockage without cooperation, so this only
   determines how much *context* a request carries, not whether it is noticed.
3. **`/loop` tick interval.** Start at 5 minutes and tune.
4. **Does the docs/observed conflict in §2.1 survive upgrades?** Re-verify
   `claude agents --json` on each Claude Code upgrade; the scope argument
   depends on it.

## 14. Non-goals

- Rebuilding anything the harness ships (§2).
- Replacing the human as the assigner of work.
- Compelling execution in another session, or answering a permission prompt.
- Third-party agent-memory infrastructure — the broker's SQLite is the store.
- Automatic wake for pull-tier sessions; COS reports who needs a nudge (§9).
