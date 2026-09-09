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

- Local Claude Code terminals and local Claude Desktop sessions.
- Terminal as the human-facing surface: COS runs in its own terminal and reports
  there.
- Durable task, event, and input-request state in the existing broker SQLite.

**Explicitly out of scope (v1):**

- **Cloud Cowork sessions.** They cannot reach `127.0.0.1:7899`. Participation
  requires a non-loopback rendezvous point; deferred with the tunnel decision.
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

**Answers ride the existing message rail.** `answer_request` records the answer
*and* inserts a row via the same path as `send_message`, so it inherits
`notifyWatchers` fan-out, the `woke: N` count, channel push, and explicit-ack
durability — all machinery already hardened in `broker.ts`.

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
CREATE INDEX IF NOT EXISTS idx_tasks_to_state ON tasks(to_id, state);

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
CREATE INDEX IF NOT EXISTS idx_events_peer ON events(peer_id, id);

CREATE TABLE IF NOT EXISTS input_requests (
  id            TEXT PRIMARY KEY,        -- uuid
  peer_id       TEXT NOT NULL,           -- the blocked agent
  task_id       TEXT,
  question      TEXT NOT NULL,
  urgency       TEXT NOT NULL DEFAULT 'normal',   -- low | normal | high
  state         TEXT NOT NULL DEFAULT 'pending',  -- pending | escalated | answered | canceled
  answer        TEXT,
  answered_by   TEXT,                    -- peer id of answerer (COS, or a peer relaying the human)
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

`/answer-request` is **idempotent-safe**: answering an already-`answered`
request is rejected rather than overwriting. It performs two writes in one
transaction — updating `input_requests`, and inserting a `messages` row addressed
to the blocked peer — then fans out through `notifyWatchers`, returning the same
`woke` count `send_message` returns.

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
  "pending":  [{ "id", "peer_id", "question", "urgency", "created_at", "state" }],
  "events":   [{ "id", "peer_id", "task_id", "level", "message", "created_at" }],
  "cursor":   { "from": 1234, "to": 1291, "truncated": false }
}
```

COS's model turns this into prose. The broker does no summarization.

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

- *Blocked agent expired.* The answer is still recorded and the message row
  retained — existing behavior keeps mail for expired peers (`7c1dab0`), so the
  agent gets it on return.
- *`woke: 0`.* The agent was not listening. The answer is durable; it arrives on
  the agent's next `check_messages` or tool call. COS should report a `woke: 0`
  answer to the human as "sent but not yet picked up."
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
- Oversized `data` blobs → capped at 8 KB, truncated with a `truncated: true`
  marker rather than rejected, so telemetry never breaks an agent's turn.
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
- **Expired assignee:** answer recorded and message retained when the peer row is
  gone but the token mapping survives.
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
| **2** | `input_requests`, `request_input`, `answer_request`, `escalate_request` | Blocked agents become visible and unblockable. |
| **3** | `Stop` / `Notification` hooks POSTing to the broker as a passive backstop for agents that stall without reporting | Coverage for silent stalls — *only if they prove to be a real problem.* |
| **4** | Non-loopback rendezvous for cloud Cowork; web UI over the same schema | Cross-environment and away-from-keyboard. |

Phase 1 is independently useful and should ship before Phase 2 begins.

## 14. Open questions

1. **Does an agent reliably call `request_input` before ending its turn?** This
   is a prompt-engineering question, not a code question, and it determines
   whether Phase 3 is necessary. Phase 1+2 usage is the experiment.
2. **`/loop` tick interval for COS.** Too fast burns tokens; too slow defeats the
   purpose. Start at 5 minutes and tune against real use.
3. **Does COS need its own peer type?** Currently it registers as an ordinary
   `cli` peer. If the eventual web UI needs to find it, a `peer_type` of `cos`
   may be warranted — but not in v1.

## 15. Non-goals

- Replacing the human as the assigner of work.
- Compelling execution in another session.
- Any dependency on third-party agent-memory infrastructure. The broker's SQLite
  is the store; adding another would create a second source of truth.
- A2A or MCP-logging *protocol* compliance. We borrow vocabulary only.
