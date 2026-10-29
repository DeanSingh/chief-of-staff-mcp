# Chief-of-Staff Coordination Layer — Design v2

**Date:** 2026-09-09
**Status:** Approved for planning — Phase 1a plan next
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

**No hook is required. The MCP server already has the session id.**

An earlier draft of this section stated that a `SessionStart` hook was mandatory,
because nothing hands a session id to an MCP stdio server (`_meta` carries only
`progressToken`, verified against the SDK types) and the docs state the id is
*"NOT directly exported to child processes or MCP servers as an environment
variable."* **Measured 2026-09-09: that is false.**

```
env CLAUDE_CODE_SESSION_ID          = f1b5583d-c187-4b38-8e49-e9162b85ffdb
claude agents --json  → sessionId   = f1b5583d-c187-4b38-8e49-e9162b85ffdb
MCP server process (pid 3083, `bun server.ts`) → present in its environment
```

Checked by variable *name* only, never by reading a value. The running server
process was inspected directly, so this is not an inference from "children
inherit their parent's environment." The same UUID also names the session's
scratchpad directory, confirming it is the real identifier.

**Consequence:** `server.ts` reads `process.env.CLAUDE_CODE_SESSION_ID`. There is
no `/bind-session` route, no hook↔server join over the Claude Code pid, and no
arrival-ordering problem between a hook and a registration.

**Amended 2026-10-29: the environment key goes stale, so a `SessionStart` hook is
required after all.** The server reads `CLAUDE_CODE_SESSION_ID` once, at spawn.
When the conversation changes after that, the key no longer names the live
session. Measured on Claude Code 2.1.312, with the branch broker:

| Event | Live session id | Server's env key | Peer id without the hook | With the hook |
| --- | --- | --- | --- | --- |
| Start | `00b69402…` | `00b69402…` | `i0x113h1` (new) | same |
| `/clear` | **`7f15c2b3…` (new)** | `00b69402…` | `i0x113h1` (kept, but the new session id maps to nothing) | `i0x113h1`, and `7f15c2b3… → i0x113h1` is recorded (`mapped`) |
| `/compact` | `7f15c2b3…` (unchanged) | `00b69402…` | `i0x113h1` (kept) | same (`noop`) |
| Plain `claude`, then in-session `/resume` of `c4d427b1…` (owned `sr79due2`) | `c4d427b1…` | `64627da0…` (launch) | **`l8lwqn48` (new, so `sr79due2` was orphaned)** | `sr79due2` reclaimed (`rekeyed`); the server re-registered onto it within one heartbeat |

Rows observed afterwards: one `peers` row per process and no orphans. The
`/clear` gap is silent, but it matters: without the mapping, a later
`claude --resume 7f15c2b3…` would get a new id.

So identity takes two sources. The environment key covers launch, including
`claude --resume <id>` at launch. The `SessionStart` hook reports the live
`session_id` and its ancestor pids to `POST /session-start`, which:

- maps an unknown key to the process's peer;
- re-keys the process onto the id the session already owns, re-addressing
  undelivered mail;
- refuses (`conflict`) when that id is held by another live process.

The hook and the server are joined on the Claude Code pid **plus that process's
start time**, so a reused pid never inherits an identity (SE condition, 10-29).
Rows written before the start time was recorded match on pid alone.

**This does not generalize to Desktop.** One bridge MCP server process serves
many Desktop/Cowork sessions, so a process-level environment variable cannot
discriminate between them. `claim_session` / `peer_session` remain necessary and
unchanged for desktop peers. Note also that the server process does *not* carry
`CLAUDE_CODE_MESSAGING_SOCKET` / `_TOKEN`, which a Bash tool child does — spawn
environments differ, and nothing beyond the session id should be assumed.

> **Third docs failure in this area.** The docs were also wrong that
> `claude agents --json` lists only background sessions (§2.1), and wrong here.
> Every unobserved docs claim about these primitives has now failed under test.
> Treat `[docs]` in this domain as a hypothesis; `[observed]` governs.

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

> **Amended 2026-09-09, after implementation.** This section originally read as
> though the pid lookup were *removed*. It is not: it survives as an explicit
> fallback for when `CLAUDE_CODE_SESSION_ID` is absent (a standalone run, or an
> older Claude Code), per the plan's backwards-compatibility constraint. Two
> consequences the original wording obscured, both found only by the final
> whole-branch review:
>
> 1. A session registering with a key that has **no mapping yet** must *adopt*
>    the pid-matched peer rather than mint a new id. Otherwise every CLI session
>    alive at upgrade time — which by definition has a pid-keyed row and no
>    `peer_sessions` row — gets a duplicate peer on its next reconnect, and the
>    old id's queued mail is orphaned for the full 72h TTL.
> 2. `handleSendMessage` still treats row-absence as identity death, which is
>    why the delivery guarantee is the narrow one stated in §11 — mail sent
>    *before* a session died, not while it was down. Phase 1b owns widening it.

`session_key` holds two kinds of value, by peer type:

| Peer type | `session_key` | Source |
| --- | --- | --- |
| `cli` | Claude Code session id | `process.env.CLAUDE_CODE_SESSION_ID` |
| `desktop` | claimed token | `claim_session`, unchanged |

For CLI peers `session_key` **is** the native `sessionId`, so COS joins the
broker's peers to `claude agents --json` on `session_key == sessionId` — an exact
key join, not a name match. `peers.name` is dropped: nothing populates it, and
this fleet has already proven names collide (two sessions answering to "CA1").

## 5. Schema

Three new tables plus one generalization. Follows the existing
`CREATE TABLE IF NOT EXISTS` + `PRAGMA table_info` migration conventions.

```sql
-- Generalizes desktop_tokens to all peer types. The migration copies existing
-- desktop_tokens rows in and MUST be idempotent: re-running on an already
-- migrated database is a no-op, never a duplicate or a constraint error.
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
| `/report-event` | `{ peer_id \| session_key, level, message, source?, logger?, data? }` | `{ ok, event_id }` |
| `/request-input` | `{ peer_id \| session_key, question, waiting_for?, urgency? }` | `{ ok, request_id }` |
| `/close-requests` | `{ session_key, reason }` | `{ ok, closed }` |
| `/answer-request` | `{ request_id, answerer_id, answer, answered_via }` | `{ ok, woke }` |
| `/escalate-request` | `{ request_id, note? }` | `{ ok }` |
| `/get-digest` | `{ peer_id, since_id?, limit? }` | `Digest` (§7) |
| `/ack-digest` | `{ peer_id, position }` | `{ ok }` |

**Hook-called routes accept `session_key` in place of `peer_id`.** A hook knows
its `session_id` and nothing else — it has never registered and holds no peer id.
`/report-event`, `/request-input`, and `/close-requests` therefore resolve either
key, looking `session_key` up through `peer_sessions` (§5). Exactly one of the
two must be supplied.

`/close-requests` serves the `UserPromptSubmit` hook (§8): the human answered in
the agent's own terminal, so that session's open requests are stale and move to
`canceled` with `answered_via: 'terminal'`.

**Store `status` / `waitingFor` verbatim.** Values from `claude agents --json` are
recorded as received — never normalized, never mapped to an "other" bucket, never
rejected as invalid. The docs enum (§2.1) is reference prose for the COS profile,
not a validation list. If the vocabulary shifts on a Claude Code upgrade, the
digest keeps working and only the profile needs editing.

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
  "peers":     [{ "id", "session_key", "summary", "cwd", "peer_type", "last_seen" }],
  "native":    [{ "sessionId", "name", "status", "waitingFor", "cwd" }],  // claude agents --json
  "pending":   [{ "id", "peer_id", "question", "waiting_for", "urgency", "created_at" }],
  "escalated": [{ "id", "peer_id", "question", "urgency", "created_at", "escalated_at" }],
  "events":    [{ "id", "peer_id", "level", "source", "message", "created_at" }],
  "cursor":    { "from": 1234, "to": 1291, "truncated": false }
}
```

**`native` is COS's job, not the broker's.** COS shells `claude agents --json`
itself and merges. The broker must not shell out to the harness — it is a daemon
with no session context, and coupling it to a CLI whose output shape is
explicitly version-unstable would be a mistake. Merging two populations into one
report is precisely the chief-of-staff role.

`pending` returns `state='pending'` only; `escalated` returns `state='escalated'`
separately. An earlier draft dropped escalated requests from the digest entirely
so COS would not re-nag — but that means **an escalation the human misses once
becomes invisible forever**, which is the original failure mode wearing a
different hat. Visibility belongs in the data; *how loudly to raise it* belongs
in the COS profile's prose. The two arrays are separate so the profile can treat
them differently without the query deciding for it.

`peers.session_key` is what makes the join to `native` exact (§4). `peers.name`
is deliberately absent — nothing populates it.

Cursor semantics: reads never advance; `ack_digest` does, after the tick's work
succeeds. Two COS readers are safe — `digest_cursors` is per-peer and event reads
are non-destructive, unlike the consumed `messages` mailbox.

## 8. Hooks

A small bundle in `~/.claude/settings.json`. This is the deterministic signal;
`request_input` is the cooperative backstop, not the other way round.

| Hook | Purpose | Key payload fields |
| --- | --- | --- |
| `Notification` | **Blocked detection**, no agent cooperation required. | `notification_type` — act on `agent_needs_input`; record `permission_prompt` but **never** answer it (§2.2) |
| `UserPromptSubmit` | **Out-of-band close.** The human answered in the agent's own terminal, so its open request is stale. | `session_id` → cancel that session's `pending`/`escalated` requests as `canceled`, `answered_via: 'terminal'` |
| `Stop` | Turn ended — an `info` event marking idleness. | `session_id`, `last_assistant_message` |

`SessionStart` **is** in this bundle (amended 2026-10-29; see §4). The
environment key goes stale after `/clear` and an in-session `/resume`, and only
the hook sees the live session id. It is installed by `bun cli.ts install-hooks`
and posts to `/session-start`.

Without the `UserPromptSubmit` rule, `pending` fills with questions the human
already answered by typing directly into the blocked agent — noise within a day,
and COS re-reporting resolved items is worse than COS staying quiet.

`Notification` also emits `idle_prompt`, `agent_completed`, `auth_success`, the
`elicitation_*` family, and `quota_auto_resume_*`. Only `agent_needs_input` and
`permission_prompt` are consumed in v1; the rest are recorded at `debug`.

**Installation.** `bun cli.ts install-hooks` writes the settings, and nobody
hand-types a path: it resolves its own location from `import.meta.dir` (the same
pattern the README's `claude mcp add` line uses) and registers **one** entrypoint,
`hook.ts`, which reads `hook_event_name` from stdin and dispatches internally. So
`settings.json` gets one generated command per event, all pointing at the same
file. The merge is idempotent — re-running must not duplicate entries — and the
README says to re-run it after moving the repo.

**Hooks must fail silently and fast.** Timeout ≤ 1s; exit 0 when the broker is
unreachable; **never auto-launch the broker.** The MCP server deliberately
auto-launches it, but a hook that did the same would spawn brokers from every
`SessionStart` in every terminal, and a hook that blocks adds latency to the
start of every session. Telemetry must never be able to break or slow a session.

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

> Send a message to a CLI peer → kill its process → re-register under the **same
> `session_key`** (a new pid) → **assert the restarted peer reads the message.**
> Preserving a row addressed to a dead id is not delivery.
>
> This is a 1a test and needs no `input_requests`; in 1b the same shape is
> repeated with `request_input` / `answer_request`.

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
| **1a** | `peer_sessions` keyed on `process.env.CLAUDE_CODE_SESSION_ID`; `/register` consults it; remove **both** mail-deleting paths (`broker.ts:107` and the `handleListPeers` inline delete); idempotent `desktop_tokens` migration; the restarted-peer delivery test. **No hooks, no new tools.** |
| **1b** | `events` + `input_requests` + `digest_cursors`; the new routes and tools; `hook.ts` + `install-hooks` (`Notification`, `UserPromptSubmit`, `Stop`); `bun cli.ts digest`; the `buildTools()` type fix |
| **2** | COS profile and `/loop` operating model on top of Phase 1, validated against a Desktop peer |
| **3** | `tasks` — **only if** delegation through the mesh is ever observed |
| **4** | Optional non-loopback rendezvous so pull-tier sessions wake automatically; web UI over the same schema |

**1a ships alone and is independently valuable**: it fixes a live bug — a
restarted CLI agent currently loses its mail — with no new surface area. Because
identity comes from the environment rather than a hook (§4), 1a has no hook
dependency; an earlier split that put identity in 1a and hooks in 1b would have
shipped plumbing that could not work.

Within 1a, identity and mail-retention **must land together**. Removing the
deletion alone leaves the message addressed to an id no future registration can
match; making identity durable alone leaves the message already deleted.

## 13. Open questions

1. ~~**Are the messaging env vars inherited by an MCP server child?**~~
   **RESOLVED 2026-09-09, and the answer was better than the question.** A
   presence-only check (variable *names* only, no values read) found that the
   running MCP server process carries `CLAUDE_CODE_SESSION_ID`, matching the
   `sessionId` in `claude agents --json` exactly. Identity needs no hook — see
   §4. For the record, the server's environment does **not** include
   `CLAUDE_CODE_MESSAGING_SOCKET` / `_TOKEN`, though a Bash tool child does have
   them; the two spawn environments differ and neither should be assumed from
   the other. The messaging socket is not used by this design.
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

---

## 15. Staff engineer review of v2 — 2026-09-09

**Verdict: approved for planning once the four gaps in 15.1 are written in.**
The three v1 blockers are resolved, and resolved by verification rather than
assertion — the third code site (`handleListPeers` inline delete, `broker.ts:350`)
is exactly the kind of thing that survives a fix nobody traced. Every line
reference in v2 was checked against the branch and holds.

### 15.1 Gaps that must be specified before the implementation plan

**(a) The join between hook and MCP server is unspecified.** §4 says the
`SessionStart` hook establishes identity and §8 says it POSTs `session_id`. But
the hook and the MCP server are two processes that reach the broker
independently, and neither knows the other's key: the hook has `session_id`, the
server has `HOST_PID`. The only value both hold is the Claude Code process pid —
the hook's `$PPID`, the server's `process.ppid`. Specify: the hook POSTs
`/bind-session { pid, session_key, cwd, reason }`; `/register` looks the pid up
in a pid→session_key binding; and **both arrival orders must work** — hook
before register (register finds the binding) and register before hook (bind
re-keys the existing peer row and migrates its peer id into `peer_sessions`).
Add a test for each order. On `reason: resume`, the new pid binds to the old
session_key and the peer id comes back from `peer_sessions` — that is the §11
"test that matters," and it only passes if this join is defined.

**(b) Hook-originated routes cannot supply `peer_id`.** §6 keys `/report-event`
and `/request-input` on `peer_id`; the `Notification` and `Stop` hooks only know
`session_id`. Every route a hook calls must accept `session_key` as an
alternative to `peer_id`, resolved through `peer_sessions`. A hook that fires
before the session's peer exists (hook-before-register, above) must not fail:
bind first, then report, in the same handler or the same shell script.

**(c) Out-of-band answers strand requests as `pending` forever.** The human
will keep typing into agent terminals — that is the workflow. When Dean answers
the Auditor Agent in its own terminal, its `input_requests` row stays `pending`
and the digest reports a blockage that no longer exists. Specify: a
`UserPromptSubmit` hook (the human typed in that session) and a
`status: working` observation both close that peer's open requests with
`state: 'canceled', answered_via: 'terminal'`. Without this, `pending` decays
into noise within a day and COS learns to ignore it.

**(d) `escalated` is invisible by construction, which recreates the four-day
Auditor Agent.** §7 excludes escalated requests so COS does not re-report them
each tick. Correct for *details*, wrong for *existence*: an escalation the human
has forgotten is the exact failure this project exists to fix. Add an
`escalated` array to the digest — `{ id, peer_id, question, urgency,
created_at }` — and put the presentation rule in the COS profile ("one line with
count and oldest age; full detail only when older than N hours"), not in the
query. The broker returns facts; the profile decides how loud to be.

### 15.2 Should-fix

- **`peers.name` has no source.** The broker's peer row has `summary`; Claude
  Code's `name` lives in `claude agents --json`. Either drop `name` from the
  digest's `peers` rows or define where it comes from. What the row *does* need
  is `session_key`, so COS can join `peers` to `native` on
  `session_key == sessionId` instead of matching names. That join is the whole
  merge; make it a key, not a heuristic.
- **Hook bundle must be installed, not pasted — and no hand-typed paths.**
  `~/.claude/settings.json` already has hooks on this machine. Ship
  `bun cli.ts install-hooks` that (1) resolves its own install location from
  `import.meta.dir` and writes that absolute path — the user never types one,
  same as the README's `claude mcp add` line; (2) registers **one** entrypoint,
  `hook.ts`, which reads `hook_event_name` from stdin and dispatches, so the
  settings file gains one generated command per event, all identical; (3)
  merges into the existing `hooks` object and is idempotent on re-run;
  (4) documents "re-run after moving the repo." Every hook must time out fast
  (≤1s) and exit 0 when the broker is down — the bundle is global and fires in
  sessions that never loaded this MCP server. Hooks must never auto-launch the
  broker.
- **`desktop_tokens` → `peer_sessions` migration must be idempotent.**
  `CREATE TABLE IF NOT EXISTS` + `INSERT OR IGNORE ... SELECT FROM
  desktop_tokens` on every startup; keep `desktop_tokens` until one release
  after. State it, and test the second run.
- **Split Phase 1.** Identity + mail retention + their tests are a
  self-contained correctness fix with no new tool surface; ship them as Phase 1a
  before events/requests/digest/hooks (1b). 1a is reviewable in one sitting and
  is the bug you already have today.
- **`Stop` events carry `last_assistant_message`.** Fine under the 8 KB
  truncation, but say so — it is the one field that will routinely hit the cap.

### 15.3 Decision on open question 13.1

**Run the check; do not wait on it.** (Revised after Dean's read.) It is a
one-line presence-only test — set/unset and length, never the value — so do it
and record the result in §13.1. It does not change 1a's shape either way: the
socket path is not a session id, and the hook bundle ships regardless for
`Notification`/`Stop`, so `SessionStart` identity on the same bundle is free and
is the documented, version-stable path. If the variables *are* inherited, note
it as a possible later shortcut for the MCP server to self-identify; if not, the
question is closed.

### 15.4 Keep, and worth calling out

§2.1's docs-vs-observed conflict, resolved by observation and flagged for
re-verification on upgrade. §2.4 naming agent teams and the condition under
which this project should be *reconsidered rather than extended* — that is the
right posture for a fork. §7 keeping `claude agents --json` out of the daemon.
§9's `woke`-driven "who needs a nudge" as the job description. §11 identifying
the tests that are pinned to the behavior being removed, and the root cause of
the `tsc` debt rather than a suppression.
