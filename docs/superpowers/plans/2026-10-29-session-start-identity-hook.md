# SessionStart Identity Hook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A CLI session keeps its peer id when the conversation is switched after the MCP server spawned (in-session `/resume`, and whatever `/clear` / `/compact` turn out to do), completing PR #1.

**Architecture:** The MCP server reads `CLAUDE_CODE_SESSION_ID` once at spawn, so the key goes stale when the conversation changes underneath it. A `SessionStart` hook receives the *live* `session_id` on every start/resume/clear/compact and posts it, with its ancestor pids, to a new broker endpoint `/session-start`. The broker finds the live CLI peer for that process and, if the live session already owns a different peer id, moves the live row onto that id. The server converges on its next 15s heartbeat via the existing `ensureRegistered` re-register path, so the server itself needs no logic change.

**Tech Stack:** Bun, `bun:sqlite`, `bun test`, Claude Code hooks (`~/.claude/settings.json`).

**Spec:** `docs/superpowers/specs/2026-09-09-chief-of-staff-coordination-design-v2.md` §4 (identity) and §8 (hooks). This plan **reverses** §8's line "`SessionStart` is **not** in this bundle … a hook for it would be redundant"; Task 4 amends the spec.

**Evidence (2026-10-29):** a plain `claude` (pid 24244) launched at 17:28:54Z; the conversation `c4d427b1…` was resumed inside it. The MCP server registered under the launch session `64627da0…` and got new id `l8lwqn48`, while `peer_sessions` still mapped `c4d427b1… → sr79due2`. The broker behaved as designed; the server's key was stale.

## Global Constraints

- Hooks must fail silently and fast: timeout ≤ 1s, exit 0 when the broker is unreachable, **never auto-launch the broker** (spec §8).
- One hook entrypoint, `hook.ts`, dispatching on `hook_event_name` from stdin (spec §8). This plan implements only `SessionStart`; other events exit 0.
- `bun cli.ts install-hooks` resolves its own path from `import.meta.dir`, merges idempotently, never duplicates entries (spec §8).
- Wire identity unchanged: port `7899`, DB `~/.claude-peers.db`, env `CLAUDE_PEERS_*` (CLAUDE.md).
- Desktop peers are out of scope: `/session-start` only ever touches rows with `peer_type != 'desktop'`.
- Undelivered mail is never deleted (CLAUDE.md); re-keying re-addresses it, never drops it.

## Review Focus

1. **Same conversation open in two terminals** (`claude --resume X` twice): the second must not steal the first's live id. → Task 1 test `conflict when the session's peer is live under another live pid`.
2. **Mail sent to the temporary launch id in the minutes before `/resume`**: it must follow the session onto the reclaimed id. → Task 1 test `rekey re-addresses undelivered mail`.
3. **Hook fires before the MCP server has registered** (fresh `startup`): nothing to re-key; must return `no_live_peer`, not mint a peer. → Task 1 test `no live peer: no rows created`.
4. **Server's next re-register after a re-key** must land on the reclaimed id, not mint a third. → Task 1 test `launch key resolves to the reclaimed id after rekey`.
5. **Broker down while the hook runs**: session start must not slow or fail. → Task 2 test `exits 0 within 1s when the broker is unreachable`.

---

### Task 1: Broker `/session-start` endpoint

**Files:**
- Modify: `broker.ts` (new `handleSessionStart` beside `handleRegister` ~:294; route in the switch ~:583)
- Modify: `shared/types.ts` (request/response types)
- Test: `broker.test.ts` (new `describe("/session-start")`, reusing `post`, `register`, `LIVE_PIDS`, `restartBroker`)

**Interfaces:**
- Produces:
  ```ts
  interface SessionStartRequest { session_key: string; pids: number[]; source: string }
  type SessionStartResponse =
    | { ok: true; peer_id: PeerId; action: "noop" | "mapped" | "rekeyed" }
    | { ok: false; reason: "no_live_peer" | "conflict" | "bad_request" };
  ```
  `POST /session-start` → `SessionStartResponse` (HTTP 200 in all cases).

**Algorithm** (one `db.transaction`):
1. `P` = first row in `peers` with `peer_type != 'desktop'` whose `pid` is in `pids`, honouring `pids` order (nearest ancestor wins). None → `no_live_peer`.
2. `X` = `peer_sessions.peer_id` for `session_key`.
3. No `X` → insert `(session_key, P.id, 'cli', now)`; `mapped`.
4. `X === P.id` → touch `updated_at`; `noop`.
5. Else, if a `peers` row `X` exists with `pid != P.pid` and that pid is alive (`process.kill(pid, 0)`) → `conflict`, change nothing.
6. Else: delete row `X` if present; `UPDATE peers SET id = X WHERE id = P.id`; `UPDATE messages SET to_id = X WHERE to_id = P.id AND delivered = 0`; `UPDATE peer_sessions SET peer_id = X WHERE peer_id = P.id`; `rekeyed`.

- [ ] **Step 1: Write the failing tests**

  ```ts
  describe("/session-start", () => {
    test("no live peer: no rows created", ...)            // pids [999999] → {ok:false, reason:"no_live_peer"}; peer count unchanged
    test("unmapped key is mapped to the live peer", ...)   // register cli with session_key "launch"; session-start key "fresh" → action "mapped"; register again with session_key "fresh" + a different live pid → same id
    test("same key is a noop", ...)                        // key already maps to P → action "noop", peer_id P
    test("resume rekeys the live process onto the session's original id", ...)
      // register A with session_key "orig" → idA; unregister/kill-row A (restartBroker after a dead pid, or /unregister)
      // register B (live pid) with session_key "launch" → idB
      // session-start {session_key:"orig", pids:[B.pid]} → {ok:true, action:"rekeyed", peer_id: idA}
      // list-peers contains idA with B's pid and NOT idB
    test("rekey re-addresses undelivered mail", ...)       // send to idB before session-start; after rekey, poll-messages {id: idA} returns it
    test("launch key resolves to the reclaimed id after rekey", ...) // /register with session_key "launch" → id === idA (mirrors server ensureRegistered)
    test("conflict when the session's peer is live under another live pid", ...)
      // idA live on LIVE_PIDS[0]; idB live on LIVE_PIDS[1]; session-start {key:"orig", pids:[LIVE_PIDS[1]]} → {ok:false, reason:"conflict"}; both rows unchanged
    test("desktop rows are never matched", ...)            // desktop peer registered with pid in pids → no_live_peer
    test("malformed body → bad_request", ...)              // missing session_key or empty pids
  });
  ```

- [ ] **Step 2: Run to verify they fail**

  Run: `bun test broker.test.ts -t "/session-start"`
  Expected: FAIL (404 / JSON parse on unknown route).

- [ ] **Step 3: Implement `handleSessionStart(body: SessionStartRequest): SessionStartResponse` in `broker.ts`** per the algorithm above, plus the route. The pid-liveness check is inline today (`process.kill(pid, 0)` at `broker.ts:135` and `:473`); extract it to `isPidAlive(pid: number): boolean` and use it at all three sites.

- [ ] **Step 4: Run to verify they pass**

  Run: `bun test`
  Expected: all pass, including the existing 61.

- [ ] **Step 5: Commit**

  ```bash
  git add broker.ts shared/types.ts broker.test.ts
  git commit -m "broker: /session-start re-keys a CLI peer onto its resumed session's id"
  ```

---

### Task 2: `hook.ts` SessionStart entrypoint

**Files:**
- Create: `hook.ts`
- Create: `hook.test.ts`

**Interfaces:**
- Consumes: `POST /session-start` (Task 1).
- Produces: `bun hook.ts` reading a hook JSON object on stdin. Exported for tests: `ancestorPids(start: number, max = 8): number[]` (start pid first, then parents via `ps -o ppid= -p`, stopping at pid ≤ 1).

Behaviour: if `hook_event_name !== "SessionStart"` or `session_id` missing → exit 0. Else `fetch("http://127.0.0.1:${CLAUDE_PEERS_PORT ?? 7899}/session-start", { signal: AbortSignal.timeout(800) })` with `{ session_key: session_id, pids: ancestorPids(process.ppid), source }`. Swallow every error. Always exit 0, print nothing to stdout (SessionStart stdout is injected into context).

- [ ] **Step 1: Write the failing tests**

  ```ts
  test("ancestorPids starts at the given pid and includes this test's parent", ...) // ancestorPids(process.pid)[0] === process.pid; includes process.ppid
  test("exits 0 within 1s when the broker is unreachable", ...)  // spawn with CLAUDE_PEERS_PORT=<closed port>, stdin SessionStart JSON; exitCode 0, elapsed < 1000ms, stdout ""
  test("ignores non-SessionStart events", ...)                    // stdin {hook_event_name:"Stop"} → exit 0, no request (stub server sees 0 hits)
  test("posts session_id, source and ancestor pids", ...)         // Bun.serve stub on a random port records the body: session_key === "s-1", source === "resume", pids[0] === hook's parent pid
  ```

- [ ] **Step 2: Run to verify they fail** — `bun test hook.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `hook.ts`.**

- [ ] **Step 4: Run** — `bun test` → all pass.

- [ ] **Step 5: Commit** — `git add hook.ts hook.test.ts && git commit -m "hook: SessionStart reports the live session id to the broker"`

---

### Task 3: `bun cli.ts install-hooks`

**Files:**
- Modify: `cli.ts` (new `install-hooks` case + usage line)
- Modify: `README.md` (one section: install, re-run after moving the repo)
- Test: `cli.test.ts` (create)

**Interfaces:**
- Produces: `bun cli.ts install-hooks [--settings <path>]` (default `~/.claude/settings.json`). Adds `hooks.SessionStart[]` entry `{ hooks: [{ type: "command", command: "bun <abs>/hook.ts", timeout: 1 }] }`, where `<abs>` is `import.meta.dir`. Idempotent: an existing entry whose command ends in `/hook.ts` is replaced in place, never duplicated. Every other key in the file is preserved byte-for-byte in value. Prints the path it wrote.

- [ ] **Step 1: Failing tests** (all against a temp settings file via `--settings`):
  `creates the SessionStart entry in an empty file`; `running twice leaves exactly one entry`; `preserves unrelated hooks and settings`; `replaces a stale entry pointing at an old repo path`.
- [ ] **Step 2:** `bun test cli.test.ts` → FAIL.
- [ ] **Step 3:** Implement with `Bun.file(...).json()` / `Bun.write`, 2-space JSON.
- [ ] **Step 4:** `bun test` → all pass.
- [ ] **Step 5:** Commit `cli: install-hooks registers the SessionStart identity hook`.

---

### Task 4: Measure, amend the spec, correct the server comment

**Files:**
- Modify: `server.ts:52-64` (the `SESSION_KEY` doc comment claims "Stable across --resume"; correct it: stable for `claude --resume <id>` at launch, stale after an in-session switch, which the SessionStart hook repairs)
- Modify: `docs/superpowers/specs/2026-09-09-chief-of-staff-coordination-design-v2.md` §4 (add a dated "Measured 2026-10-29" subsection) and §8 (replace the "SessionStart is not in this bundle" paragraph)

- [ ] **Step 1: Install on Dean's machine** (needs Dean's OK; it edits `~/.claude/settings.json`): `bun cli.ts install-hooks`. Restart the broker and verify by probe, not by assumption: `lsof -tiTCP:7899 -sTCP:LISTEN` shows a new pid, and `curl -s -XPOST 127.0.0.1:7899/session-start -d '{}'` returns `{"ok":false,"reason":"bad_request"}`.
- [ ] **Step 2: Measure the four sources** in a scratch terminal (`cd /tmp && claude --dangerously-load-development-channels server:claude-peers`). For each of `startup`, `/resume <other>`, `/clear`, `/compact`, record: hook `session_id`, server env key (`~/.claude-peers.log` "Registered as" line), `peer_sessions` rows for both, and the peer id shown by `list_peers` 20s later.
  Expected: the peer id after `/resume` equals the resumed conversation's original id; after `/clear` and `/compact` it is unchanged.
- [ ] **Step 3: Write the table and the decision into §4 / §8 of the v2 spec**, and correct the `server.ts` comment.
- [ ] **Step 4:** `bun test` → all pass; `bunx tsc --noEmit` → no new errors beyond the existing 2.
- [ ] **Step 5: Commit, push, and send the new head sha to SE** (`lznagln2`) for PR #1 re-review.
