# Chief-of-Staff Coordination Layer — Design

**Date:** 2026-09-08
**Status:** Approved for planning
**Repo:** `chief-of-staff-mcp` (wire identity `claude-peers`)

## 1. Problem

Multiple Claude Code terminals and Cowork sessions run at once. A human assigns
work to them. Once several are running, **the human is the monitoring system** —
they must look at every terminal to learn what happened, and an agent that stops
to ask a question waits silently until someone notices.

The existing peer mesh solves discovery and messaging. It does not solve:

- **Progress visibility.** `set_summary` fires only when an agent chooses to fire
  it. There is no record of what happened, only a current one-line status.
- **Blocking.** An agent needing input ends its turn. Nothing records that it is
  blocked, what it needs, or who could answer.
- **Aggregation.** Nothing can answer "what have my five agents done in the last
  ten minutes, and which of them need me?"

The Chief of Staff (COS) is the layer that watches, aggregates, reports up to the
human, and — with explicitly granted authority — answers on the human's behalf.

The primary flow is **upward**. Delegation is secondary and human-confirmed.

## 2. Scope

**In scope (v1):**

- Claude Code terminals **and Desktop / cloud Cowork sessions**. All three are
  full participants in every tool this design adds.
- Terminal as the human-facing surface: COS runs in its own terminal and reports
  there.
- Durable task, event, and input-request state in the existing broker SQLite.

### 2.1 What "reachable" actually means — three delivery tiers

An earlier draft excluded cloud Cowork on the grounds that it cannot reach
`127.0.0.1:7899`. **That was wrong**, and it conflated two different things.

A Cowork sandbox cannot open a socket to the broker *itself*. But its MCP **tool
calls** are proxied through Claude Desktop's `remote-devices` bridge to an MCP
server process running **locally on the human's machine**, and that process talks
to the loopback broker normally. Observed 2026-09-08: eight desktop peers, all
sharing the bridge's PID 26126 — including sessions with `cwd` of `/home/claude`
and `/sessions/rcw-…` — all registered and heartbeating within the same second.

So the axis that matters is **not** reachability. It is **wake**:

| Tier | Sessions | Reaches broker | Woken automatically |
| --- | --- | --- | --- |
| **Push** | CLI terminals with the channels flag | ✅ direct | ✅ channel push resumes an idle session (§14) |
| **Watch** | Local Desktop with a `Monitor` armed | ✅ direct | ✅ WS wake feed |
| **Pull** | Cloud Cowork; any session without push or watch | ✅ **via the bridge** | ❌ next tool call, or the human types "check messages" |

Every tier can `report_event`, `request_input`, `answer_request`, and read a
digest. Only the wake behavior differs. The design must therefore never assume an
answer *arrives*; it must only assume an answer is *durable and retrievable*.

**Explicitly out of scope (v1):**

- **Automatic wake for pull-tier sessions.** Solving it means a non-loopback
  rendezvous (the deferred tunnel). Not solving it costs a human nudge, which is
  the status quo and is acceptable.
- **Web UI / dashboard.** Deferred. The schema below is the data source it will
  eventually read, so nothing here blocks it.
- **Directive execution.** COS cannot *cause* work to start in another session.
  No dispatch tool exists in the harness. COS asks; it does not compel.
- **A scoped authority/grants system.** See §10 — deliberately deferred.

## 3. Vocabulary — adopted, not invented

Two established vocabularies are adopted wholesale. We take the *names and
transition rules only*; we do not implement either protocol's transport.

### 3.1 Task state — A2A

From the [Agent2Agent protocol](https://a2a-protocol.org/latest/specification/):

| Group | States |
| --- | --- |
| Running | `submitted`, `working` |
| Paused | `input-required`, `auth-required` |
| Finished (terminal) | `completed`, `failed`, `canceled`, `rejected` |

`input-required` is specified as a pause during which the agent asks for
additional context, returning to `working` once answered. That is exactly the
blocking case this design exists to solve.

**Terminal states are non-restartable.** A task in a terminal state cannot
transition out. This is deliberate: it forces an explicit decision to create a
new task rather than silently reusing stale state. The broker enforces it.

`auth-required` is included in the schema for vocabulary completeness but has no
producer in v1.

### 3.2 Event severity — MCP / RFC 5424

From the [MCP logging utility](https://modelcontextprotocol.io/specification/2025-03-26/server/utilities/logging),
which standardizes on [RFC 5424](https://www.rfc-editor.org/info/rfc5424/):

`debug`, `info`, `notice`, `warning`, `error`, `critical`, `alert`, `emergency`

Plus an optional `logger` name and structured JSON `data`. This is already the
spec our own MCP server implements, so the vocabulary is native.

### 3.3 Why two tables and not one

A **task** is a unit of work with mutable state and a lifecycle. An **event** is
an immutable observation with a timestamp and a severity. Collapsing them into
one "updates" table produces rows that are sometimes state and sometimes
history, forcing every query to disambiguate.

Keeping them separate lets COS answer both questions cleanly:

- *"What is agent 3 doing now?"* → task state (mutable, small)
- *"What happened since I last looked?"* → event scan from a cursor (append-only,
  monotonic, crash-safe)

## 4. Architecture

No new processes. COS is **a Claude Code terminal running `/loop`**, registered
as an ordinary peer. Summarizing raw events into useful prose is a model job, not
a SQL job — a deterministic daemon could only ever print a table.

```
   ┌──────────────┐   report_event / request_input   ┌──────────────────┐
   │  agent 1..N  │ ───────────────────────────────> │  broker (SQLite) │
   │  (terminals) │ <───── answer via messages ───── │  127.0.0.1:7899  │
   └──────────────┘        (existing rail)           └────────┬─────────┘
                                                              │
                                              get_digest      │ ack_digest
                                                              v
                                                     ┌──────────────────┐
                                                     │  COS terminal    │
                                                     │  /loop           │
                                                     └────────┬─────────┘
                                                              │ prose digest
                                                              v
                                                           human
```

**Answers ride the existing message rail — but not the existing code path.**
`answer_request` records the answer *and* inserts a `messages` row, so the answer
inherits `notifyWatchers` fan-out, the `woke: N` count, channel push, and
explicit-ack durability.

It must **not** call `handleSendMessage` (`broker.ts:376`), because that function
returns `{ ok: false }` when the target peer row is absent
(`broker.ts:378-381`) — which is precisely the expired-agent case §9 needs to
succeed through. `/answer-request` therefore performs its own narrower insert,
without the existence check, inside a transaction with the `input_requests`
update. That unguarded insert is genuinely new code and needs its own tests; it
does not inherit hardening it never went through.

Note also that `broker.ts` never sets `PRAGMA foreign_keys = ON` (only
`journal_mode` and `busy_timeout`, `broker.ts:33-34`), so the `messages` FK
references to `peers(id)` are decorative and enforce nothing. This is what makes
the orphaned insert possible — but no part of this design may rely on the FKs for
integrity, because they provide none.

**Topology is flat.** Any peer may create a task for any other. COS is a
*behavioral* role, not a structural one — a session becomes the chief of staff by
acting like one. This matches the existing mesh-of-equals design and avoids
having to answer "what happens to open tasks when the coordinator dies." A
declared-coordinator role can be layered on later without a schema change.

## 5. Schema

Added to `broker.ts` alongside the existing `peers`, `messages`,
`desktop_tokens`, and `summary_cache` tables. Follows the established
`CREATE TABLE IF NOT EXISTS` + `PRAGMA table_info` migration pattern.

```sql
CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,          -- uuid
  from_id     TEXT NOT NULL,             -- creator peer
  to_id       TEXT NOT NULL,             -- assignee peer
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  state       TEXT NOT NULL DEFAULT 'submitted',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  closed_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_to_state   ON tasks(to_id, state);
CREATE INDEX IF NOT EXISTS idx_tasks_from       ON tasks(from_id);          -- serves filter:"mine"
CREATE INDEX IF NOT EXISTS idx_tasks_closed     ON tasks(state, closed_at); -- serves retention sweep

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,  -- monotonic; the COS cursor
  peer_id     TEXT NOT NULL,
  task_id     TEXT,                               -- nullable: not all events belong to a task
  level       TEXT NOT NULL DEFAULT 'info',       -- RFC 5424
  logger      TEXT,
  message     TEXT NOT NULL,
  data        TEXT,                               -- JSON blob
  created_at  TEXT NOT NULL
);
-- The digest's primary scan (WHERE id > ? ORDER BY id LIMIT ?) is already served
-- by the INTEGER PRIMARY KEY rowid. This index exists only for per-agent event
-- history ("what has agent 3 done"), which the CLI and the eventual UI need.
CREATE INDEX IF NOT EXISTS idx_events_peer ON events(peer_id, id);

CREATE TABLE IF NOT EXISTS input_requests (
  id            TEXT PRIMARY KEY,        -- uuid
  peer_id       TEXT NOT NULL,           -- the blocked agent
  task_id       TEXT,
  question      TEXT NOT NULL,
  urgency       TEXT NOT NULL DEFAULT 'normal',   -- low | normal | high
  state         TEXT NOT NULL DEFAULT 'pending',  -- pending | escalated | answered | canceled
  answer        TEXT,
  answered_by   TEXT,                    -- peer id that submitted the answer
  answered_via  TEXT,                    -- 'cos' (decided autonomously) | 'human' (relayed)
  created_at    TEXT NOT NULL,
  answered_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_requests_state ON input_requests(state);

-- Per-reader digest cursor. Explicitly acked, never advanced on read.
CREATE TABLE IF NOT EXISTS digest_cursors (
  peer_id     TEXT PRIMARY KEY,
  position    INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL
);
```

**Retention**, extending the existing startup cleanup in `broker.ts`:

- `events` older than 7 days — deleted.
- `tasks` in a terminal state, `closed_at` older than 30 days — deleted.
- `input_requests` in `answered`/`canceled` older than 7 days — deleted.

## 6. Broker API

New POST routes, added to the existing `switch (path)` dispatch. All follow the
established `{ ok: boolean; error?: string }` convention and return `404` for
unknown ids.

| Route | Request | Response |
| --- | --- | --- |
| `/create-task` | `{ from_id, to_id, title, body? }` | `{ ok, task_id }` |
| `/update-task` | `{ task_id, peer_id, state, note? }` | `{ ok, task }` |
| `/list-tasks` | `{ peer_id, filter: "mine"\|"assigned"\|"all", include_closed? }` | `{ tasks: Task[] }` |
| `/report-event` | `{ peer_id, level, message, task_id?, logger?, data? }` | `{ ok, event_id }` |
| `/request-input` | `{ peer_id, question, task_id?, urgency? }` | `{ ok, request_id }` |
| `/answer-request` | `{ request_id, answerer_id, answer }` | `{ ok, woke }` |
| `/escalate-request` | `{ request_id, note? }` | `{ ok }` |
| `/get-digest` | `{ peer_id, since_id?, limit? }` | `Digest` (see §7) |
| `/ack-digest` | `{ peer_id, position }` | `{ ok }` |

`/update-task` **rejects** any transition out of a terminal state with
`{ ok: false, error: "task <id> is in terminal state <state>" }`.

`/update-task` **must also write an `events` row** for every transition, in the
same transaction. Without this, the digest silently loses task completions: the
digest's `tasks` array carries non-terminal tasks only (§7), so a task moving to
`completed` simply vanishes from one tick to the next with nothing in the event
stream recording that it finished. Making the event write implicit in the broker
is preferable to requiring every caller to remember a paired `report_event`
call — a rule that would be violated the first time an agent was in a hurry.

`/answer-request` is **idempotent-safe under concurrency**. The state change must
be a single conditional statement —
`UPDATE input_requests SET ... WHERE id = ? AND state IN ('pending','escalated')`
— with the answer accepted only if it reports one row affected. A read-then-write
would let two COS readers both answer the same request. This mirrors the
transactional pattern already used in `handleAckMessages`.

All of `/answer-request`'s writes (the request update, the `messages` insert, the
task transition back to `working`, and the event row) occur in one transaction,
with `notifyWatchers` fan-out after it commits.

If the request carries a `task_id`, `/answer-request` also transitions that task
from `input-required` back to `working`.

## 7. MCP tool surface

Eight new tools on the existing server, joining `claim_session`, `list_peers`,
`send_message`, `set_summary`, `check_messages`.

Every tool must carry the `peer_session` parameter for Desktop sessions, per the
existing contract (`server.ts:359-372` — Desktop's dispatcher strips `session_id`
in transit, which is why the parameter is named `peer_session`).

| Tool | Purpose |
| --- | --- |
| `report_event` | Record an observation. `level` (RFC 5424), `message`, optional `task_id`, `logger`, `data`. |
| `assign_task` | Create a task for another peer. Returns `task_id`. |
| `update_task` | Move a task through its A2A lifecycle. Rejected for terminal states. |
| `request_input` | Declare "I am blocked and need X." Sets the task to `input-required`, returns `request_id`. The agent then ends its turn. |
| `answer_request` | Answer a pending request. Records the answer and pushes it to the blocked agent. |
| `escalate_request` | Mark a request as needing the human, so COS does not reprocess it each tick. |
| `get_digest` | Read everything since the last acked cursor. COS's primary read. |
| `ack_digest` | Advance the cursor, after a tick's work is done. |

`get_digest` / `ack_digest` are additionally exposed as **CLI commands**
(`bun cli.ts digest`) for inspection outside a session, mirroring the existing
`bun cli.ts peers` / `status` pattern.

### Digest shape

One call returns everything COS needs for a tick:

```jsonc
{
  "peers":    [{ "id", "summary", "cwd", "last_seen", "peer_type" }],
  "tasks":    [{ "id", "to_id", "title", "state", "updated_at" }],  // non-terminal only
  "pending":  [{ "id", "peer_id", "question", "urgency", "created_at" }],  // state='pending' ONLY
  "stalled":  [{ "id", "to_id", "title", "state", "assignee_alive" }],     // non-terminal, assignee gone
  "events":   [{ "id", "peer_id", "task_id", "level", "message", "created_at" }],
  "cursor":   { "from": 1234, "to": 1291, "truncated": false }
}
```

COS's model turns this into prose. The broker does no summarization.

**`pending` excludes escalated requests, by construction.** Once COS calls
`escalate_request`, the item's state becomes `escalated` and it drops out of
`pending`, so it is not re-surfaced on every subsequent tick. This is enforced by
the query, not by COS's prompt discipline — an escalated request is already in
front of the human and does not need re-reporting. It reappears only as an
`answered` transition once someone answers it.

**`stalled` covers the dead-assignee case.** A task in `working` or
`input-required` whose assignee no longer has a live `peers` row is nobody's
work: the agent died holding it. Nothing else in the design would surface this,
and the human needs to know so the task can be reassigned or closed. The broker
computes it; it is a projection, not a stored state.

## 8. COS operating model

COS is a terminal launched with the channels flag, running `/loop`. Each tick:

1. `get_digest` — everything since the last acked cursor.
2. Summarize into prose for the human. Highlight: high-urgency pending requests,
   tasks stuck in one state, `error`+ severity events.
3. Answer any request it is authorized to answer (`answer_request`), or
   `escalate_request` and surface it to the human.
4. `ack_digest` with `cursor.to` — **only after** step 2 and 3 succeed.

The ack-after-processing ordering is the crash-safety property: a COS that dies
mid-tick re-reads the same window rather than losing it.

**Two COS readers are safe.** `digest_cursors` is keyed by `peer_id` and event
reads are non-destructive, so independent readers get independent windows over
the same append-only log. This is a deliberate departure from the mailbox model
in `messages`, where reads are consumed.

**A restarted COS replays.** CLI peer ids are keyed on the parent process pid
(`HOST_PID`, `server.ts:50`), so a genuinely new COS terminal gets a new peer id
and therefore a fresh cursor at position 0 — it will re-read whatever remains in
the 7-day event window. This is bounded by retention and by the 200-event
`truncated` cap, so it is noisy rather than dangerous. If it proves annoying in
practice, the fix is to let COS pass an explicit `since_id` on its first tick
rather than to add identity machinery.

Between ticks, channel push still delivers urgent peer messages immediately, so
COS is not purely poll-bound.

## 9. Escalation mechanics

The one piece with no prior art. Full path:

```
agent    request_input(task_id, "should I bump the major version?")
         └─ task.state := 'input-required'
         └─ event logged at 'notice'
         └─ agent ends its turn

COS      get_digest → sees pending request
         ├─ authorized & confident  → answer_request(id, "yes, it's breaking")
         └─ not authorized/unsure   → escalate_request(id) → prints to human

human    answers in COS's terminal
COS      answer_request(id, <human's words>, answered_by=COS)

broker   input_requests.state := 'answered'
         task.state := 'working'
         INSERT INTO messages (to_id = blocked agent, text = answer)
         notifyWatchers(...) → woke: N

agent    wakes on channel push, reads the answer, resumes
```

**Edge cases:**

- *Blocked CLI agent's process died.* **This currently destroys the answer, and
  fixing it is required work in Phase 2.** `cleanStalePeers` runs every 30s
  (`broker.ts:133`); when a CLI peer's pid is dead it executes
  `DELETE FROM messages WHERE to_id = ? AND delivered = 0` (`broker.ts:108`).
  The mail-retention guarantee added in `7c1dab0` applies **only to desktop
  peers** — the desktop branch is separately commented "Keep undelivered desktop
  mail" precisely because the CLI branch does not. An earlier draft of this spec
  claimed otherwise; that was wrong.

  Required change: `cleanStalePeers` must not delete undelivered messages for a
  peer that has an open (`pending`/`escalated`) `input_requests` row or a
  non-terminal assigned task. The existing 72h undelivered-message TTL still
  bounds growth.
- *Pull-tier assignee (cloud Cowork, or any peer with no push/watch).* The answer
  is recorded and queued exactly as for any other peer. It is delivered on that
  session's next claude-peers tool call, or when the human types "check
  messages." **This is a normal outcome, not a failure** — see §2.1.

  It does, however, create a real COS responsibility: `answer_request` returns
  the same `woke` count `send_message` does, so COS knows whether an answer
  landed live or is sitting in a queue. **COS must surface pull-tier answers to
  the human as needing a nudge** — *"answered `x5wqlfrt`'s COGS question; it's a
  desktop peer, so it won't see it until you prompt it."* Tracking which agents
  need poking is precisely the chief-of-staff job, and the data for it is already
  in the response.
- *Duplicate answers.* Rejected — the second `answer_request` returns
  `{ ok: false }` rather than overwriting.
- *Agent asks without a task.* `task_id` is nullable; the request stands alone.

## 10. Authority — deliberately unbuilt

COS is a Claude session. Its authority is whatever its instructions say, and the
human controls those. **v1 ships no grants table and no permission code.**

Rationale: a scoped-authority system is real engineering for a policy that has
not yet been discovered. We do not know which decisions recur, at what
granularity, or whether they are better expressed as categories, budgets, or
allowlists. Building it now means designing a vocabulary for an unknown domain.

The intended path: let COS's prompt carry its authority, observe which decisions
actually repeat, and design the grant mechanism against that evidence. The
`input_requests` table records every decision COS made and every one it
escalated — which *is* the dataset that should inform the eventual design.

## 11. Error handling

- Unknown `task_id` / `request_id` / `peer_id` → `{ ok: false, error }`, HTTP 404,
  matching the existing `set-summary` and `send-message` pattern.
- Invalid state name → rejected with the list of valid states.
- Terminal-state transition → rejected (§6).
- Broker unreachable → the MCP tool surfaces the error to the calling agent;
  agents must not silently swallow it. Existing broker auto-launch applies.
- Oversized `data` blobs → capped at 8 KB. **The broker enforces this at write
  time and stores the truncated value**, with a `truncated: true` key merged into
  the stored JSON. Tool-side validation is not sufficient (the CLI and any future
  writer bypass it), and truncating only in the digest projection would leave
  unbounded rows in the table. Oversized input is truncated, never rejected, so
  telemetry can never break an agent's turn.
- Digest `limit` defaults to 200 events with `truncated: true` when exceeded, so
  a burst cannot blow out COS's context.

## 12. Testing

Extends `broker.test.ts` (currently 51 passing tests across 2 files).

- **Task lifecycle:** every legal transition succeeds; every transition out of
  each of the four terminal states is rejected.
- **Event cursor:** events written, `get_digest` returns them, a second
  `get_digest` without `ack_digest` returns the *same* window (proving read does
  not advance), `ack_digest` then advances it.
- **Answer delivery:** `answer_request` inserts a `messages` row addressed to the
  blocked peer, flips the task to `working`, and returns a `woke` count.
- **Duplicate answer:** second call rejected, original answer intact.
- **Expired CLI assignee — the regression test that matters:** create a task,
  `request_input`, kill the assignee's pid, run `cleanStalePeers`, then
  `answer_request`. The answer message must survive. This test fails against
  today's `broker.ts:108` and is the proof that the §9 guard was implemented.
- **Expired desktop assignee:** answer recorded and message retained via the
  `desktop_tokens` mapping.
- **`update_task` writes an event:** every transition, terminal ones included,
  appears in the digest's event stream.
- **Concurrent answer:** two `answer_request` calls race; exactly one succeeds
  and the stored answer is that one's.
- **Escalated requests leave `pending`:** after `escalate_request`, the next
  `get_digest` does not list the request under `pending`.
- **Stalled detection:** a `working` task whose assignee row is gone appears in
  the digest's `stalled` array.
- **Oversized `data`:** an 8 KB+ blob is stored truncated with `truncated: true`,
  and the write succeeds.
- **Retention:** startup cleanup deletes aged events and closed tasks, leaves
  open ones.

**Pre-existing debt to clear as part of this work:** `bunx tsc --noEmit`
currently fails with 2 errors in `server.test.ts:52,56`. Shipped code is clean.
The new tool schemas will touch that same union type, so it should be fixed
rather than worked around.

## 13. Phasing

| Phase | Contents | Value delivered |
| --- | --- | --- |
| **1** | `events`, `tasks`, digest + cursor, `report_event`, `assign_task`, `update_task`, CLI `digest` | COS can observe and report up. Solves the primary pain. |
| **2** | `input_requests`, `request_input`, `answer_request`, `escalate_request`, **the `cleanStalePeers` mail guard (§9)** | Blocked agents become visible and unblockable. |
| **3** | `Stop` / `Notification` hooks POSTing to the broker as a passive backstop for agents that stall without reporting | Coverage for silent stalls — *only if they prove to be a real problem.* |
| **4** | Optional non-loopback rendezvous (the deferred tunnel) so pull-tier sessions wake automatically; web UI over the same schema | Removes the human nudge; away-from-keyboard. |

Phase 1 is independently useful and should ship before Phase 2 begins.

## 14. The load-bearing premise — verified 2026-09-08

Phase 2 rests entirely on this claim: *an agent that called `request_input` and
ended its turn can be woken by a channel push carrying the answer.* An earlier
draft listed the wrong thing as the open question. This is the right one, and it
was tested rather than argued.

**Method.** Two live CLI peers whose summaries said they were idle
(`stasd6kj` in `~/git/omniai-gem`, `ls1m7znt` in `~/git/auditor`) were sent a
diagnostic `send_message` and asked to report what they observed.

**Result — confirmed, for CLI peers.** Both resumed. Both reported the message
arrived as a `<channel source="claude-peers">` block occupying a user turn, with
**no user input and no tool call of their own preceding it**, after their prior
turn had fully ended.

Three details from that test matter to this design:

1. **No `Monitor` is required.** `stasd6kj` confirmed it had never armed the
   `ws://127.0.0.1:7899/watch/<peer>` subscription. Push reached an idle CLI
   session without the wake feed, so Phase 2 has no dependency on `Monitor`.
2. **Channel delivery does not ack.** `check_messages` afterwards still returned
   the message as unread. That is the deliberate `handlePollMessages` behavior
   (`broker.ts:398-401`) working as designed, and it means an answer stays
   durable even if the push is not acted on.
3. **Clock skew is real.** One peer's session clock reported a different date
   than the broker's `sent_at`. **This is why the digest cursor is the monotonic
   `events.id`, never a timestamp.** Nothing ordering-sensitive in this design
   may use wall-clock time for sequencing.

**Residual uncertainty, stated honestly.** Neither peer could introspect the
harness well enough to distinguish "the push woke the process" from "the harness
drained a queued message into the top of the next turn." That distinction does
not change this design: either mechanism satisfies Phase 2's requirement, which
is only that an idle agent receives the answer without needing a human to type
into its terminal. Both peers explicitly flagged their inference as inference,
and it is recorded here as such.

**Scope of the result.** This verifies the *push* tier only (§2.1). Desktop and
cloud Cowork peers lack channel push by design and are pull-tier: their answers
queue durably and arrive on the next tool call or a human nudge. That is a
known, accepted behavior — not an unverified assumption — so nothing in Phase 2
is blocked on testing it. What Phase 2 must do is *report* it, per §9.

## 15. Open questions

1. **Does an agent reliably call `request_input` before ending its turn?** This
   is a prompt-engineering question, not a code question, and it determines
   whether Phase 3 is necessary. Phase 1+2 usage is the experiment.
2. **`/loop` tick interval for COS.** Too fast burns tokens; too slow defeats the
   purpose. Start at 5 minutes and tune against real use.
3. **Does COS need its own peer type?** Currently it registers as an ordinary
   `cli` peer. If the eventual web UI needs to find it, a `peer_type` of `cos`
   may be warranted — but not in v1.

## 16. Non-goals

- Replacing the human as the assigner of work.
- Compelling execution in another session.
- Any dependency on third-party agent-memory infrastructure. The broker's SQLite
  is the store; adding another would create a second source of truth.
- Automatic wake for pull-tier sessions. COS reports which agents need a nudge
  (§9); it does not try to eliminate the nudge.
- A2A or MCP-logging *protocol* compliance. We borrow vocabulary only.
