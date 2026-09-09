# Phase 1a — Durable CLI Peer Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A CLI Claude Code session keeps the same peer id across process restarts, and messages queued for it are never deleted — so an answer sent while it was down is still delivered when it comes back.

**Architecture:** CLI peers are currently keyed on `HOST_PID` (`server.ts:50`), so a restart mints a new peer id and orphans queued mail. Desktop peers already solve this with a `desktop_tokens` table mapping a durable token to a peer id. This generalizes that table into `peer_sessions`, keys CLI peers on `process.env.CLAUDE_CODE_SESSION_ID` (measured present in the MCP server's environment and identical to `claude agents --json`'s `sessionId`), and removes the one path that deletes undelivered mail (plus a surprising row delete in a read handler).

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, `Bun.serve`, `bun test`.

**Spec:** `docs/superpowers/specs/2026-09-09-chief-of-staff-coordination-design-v2.md` (§4 Identity, §5 Schema, §11 Testing, §12 Phasing)

## Global Constraints

- **Bun only.** `bun <file>`, `bun test`, `bun install`. Never node/npm/jest/vitest. Use `bun:sqlite`, never `better-sqlite3`.
- **Wire identity is `claude-peers`** and must not be renamed: MCP server key `claude-peers`, port `7899`, DB `~/.claude-peers.db`, env prefix `CLAUDE_PEERS_*`.
- **Desktop behavior must not change.** One bridge MCP server process serves many Desktop/Cowork sessions, so `claim_session` / `peer_session` / `session_token` stay exactly as they are. This plan touches CLI identity only.
- **Backwards compatible.** When `CLAUDE_CODE_SESSION_ID` is absent (standalone runs, older Claude Code), CLI registration must fall back to the existing pid behavior. No session may fail to register because the env var is missing.
- **Phase 1a adds no MCP tools, no hooks, and no new tables beyond `peer_sessions`.** Events, input-requests, and the digest are Phase 1b.
- All 51 existing tests must still pass at every commit.

---

### Task 1: `peer_sessions` table and idempotent migration

Creates the durable key→peer_id table and copies existing `desktop_tokens` rows into it. No behavior change yet — this task only adds storage.

**Files:**
- Modify: `broker.ts` (schema block, after the `summary_cache` table at ~`:85`)
- Test: `broker.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: table `peer_sessions(session_key TEXT PRIMARY KEY, peer_id TEXT NOT NULL, peer_type TEXT NOT NULL, updated_at TEXT NOT NULL)`

- [ ] **Step 1: Write the failing test**

Add to `broker.test.ts`, inside the existing `describe` block:

```ts
test("peer_sessions carries desktop tokens forward and re-running is a no-op", async () => {
  // Register a desktop peer: this writes a desktop_tokens row.
  const first = await post<{ id: string }>("/register", {
    pid: LIVE_PIDS[0]!, cwd: "cs_mig", git_root: null, tty: null,
    summary: "Migration agent", peer_type: "desktop", session_token: "cs_mig",
  });

  // The broker mirrors it into peer_sessions on startup and on write.
  const rows = await post<{ rows: Array<{ session_key: string; peer_id: string; peer_type: string }> }>(
    "/debug-peer-sessions", {},
  );
  const mine = rows.rows.filter((r) => r.session_key === "cs_mig");
  expect(mine).toHaveLength(1);
  expect(mine[0]!.peer_id).toBe(first.id);
  expect(mine[0]!.peer_type).toBe("desktop");
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test broker.test.ts -t "peer_sessions carries desktop tokens"`
Expected: FAIL — `/debug-peer-sessions` returns `{"error":"not found"}`, so `rows.rows` is undefined.

- [ ] **Step 3: Add the table and migration**

In `broker.ts`, immediately after the `summary_cache` `CREATE TABLE` block:

```ts
// Durable session_key -> peer id, for ALL peer types. Generalizes
// desktop_tokens: CLI peers key on Claude Code's CLAUDE_CODE_SESSION_ID,
// desktop peers on their claimed token. The peers row is ephemeral; the
// address other agents hold is not.
db.run(`
  CREATE TABLE IF NOT EXISTS peer_sessions (
    session_key TEXT PRIMARY KEY,
    peer_id     TEXT NOT NULL,
    peer_type   TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  )
`);

// Idempotent: INSERT OR IGNORE means re-running on an already-migrated
// database is a no-op, never a duplicate or a constraint error.
db.run(`
  INSERT OR IGNORE INTO peer_sessions (session_key, peer_id, peer_type, updated_at)
  SELECT token, peer_id, 'desktop', updated_at FROM desktop_tokens
`);
```

Then add the debug route. In the `switch (path)` block in `Bun.serve`, before `default:`:

```ts
        case "/debug-peer-sessions":
          return Response.json({ rows: db.query("SELECT * FROM peer_sessions").all() });
```

- [ ] **Step 4: Run the test**

Run: `bun test broker.test.ts -t "peer_sessions carries desktop tokens"`
Expected: PASS

- [ ] **Step 5: Run the whole suite**

Run: `bun test`
Expected: 52 pass, 0 fail

- [ ] **Step 6: Commit**

```bash
git add broker.ts broker.test.ts
git commit -m "Add peer_sessions, generalizing desktop_tokens to all peer types"
```

---

### Task 2: `/register` resolves CLI identity by `session_key`

The broker accepts a `session_key` for CLI peers and returns the same peer id for it regardless of pid. Falls back to the existing pid lookup when no key is supplied.

**Files:**
- Modify: `shared/types.ts` (`RegisterRequest`)
- Modify: `broker.ts` (`handleRegister`, ~`:231-295`)
- Test: `broker.test.ts`

**Interfaces:**
- Consumes: `peer_sessions` from Task 1
- Produces: `RegisterRequest.session_key?: string`; `/register` returns the same `id` for a repeated `session_key`

- [ ] **Step 1: Write the failing tests**

```ts
test("cli peers keyed by session_key keep their id across pid changes", async () => {
  const reg = (pid: number, summary: string) => post<{ id: string; restored_summary?: string }>("/register", {
    pid, cwd: "/tmp/cli-sess", git_root: null, tty: "ttys100", summary,
    peer_type: "cli", session_key: "sess-aaaa-1111",
  });
  const first = await reg(LIVE_PIDS[0]!, "CA1");
  // Same session, restarted: a DIFFERENT pid, same session_key.
  const second = await reg(LIVE_PIDS[1]!, "");
  expect(second.id).toBe(first.id);
  expect(second.restored_summary).toBe("CA1");
});

test("cli registration without a session_key still dedupes by pid", async () => {
  const reg = (summary: string) => post<{ id: string }>("/register", {
    pid: LIVE_PIDS[1]!, cwd: "/tmp/cli-nokey", git_root: null, tty: "ttys101",
    summary, peer_type: "cli",
  });
  const a = await reg("Legacy agent");
  const b = await reg("");
  expect(b.id).toBe(a.id);
});
```

- [ ] **Step 2: Run them and confirm the first fails**

Run: `bun test broker.test.ts -t "cli peers keyed by session_key"`
Expected: FAIL — ids differ, because the pid changed and `session_key` is ignored.

- [ ] **Step 3: Add the field to the wire type**

In `shared/types.ts`, inside `RegisterRequest`, after `session_token`:

```ts
  /**
   * CLI only: Claude Code's own session id (process.env.CLAUDE_CODE_SESSION_ID).
   * Stable across --resume and across crash+restart, so the broker keys the
   * peer on it and the same id comes back after the process dies. Absent when
   * the server runs standalone or on a Claude Code without the variable, in
   * which case registration falls back to pid matching.
   */
  session_key?: string;
```

- [ ] **Step 4: Resolve CLI identity by key in `handleRegister`**

In `broker.ts`, inside `handleRegister`, replace the whole `if (isCli) { ... }` pid-lookup block with:

```ts
  // CLI identity. Prefer Claude Code's session id: it survives process death,
  // so a restarted session gets its id (and its queued mail) back. Fall back
  // to pid matching when no key was supplied.
  const cliKey = isCli && body.session_key ? body.session_key : null;
  if (cliKey) {
    const mapped = db.query("SELECT peer_id FROM peer_sessions WHERE session_key = ?")
      .get(cliKey) as { peer_id: string } | null;
    if (mapped) {
      const live = db.query("SELECT id, summary FROM peers WHERE id = ?")
        .get(mapped.peer_id) as { id: string; summary: string } | null;
      if (live) {
        db.run(
          "UPDATE peers SET pid = ?, cwd = ?, git_root = ?, tty = ?, last_seen = ?, summary = CASE WHEN ? = '' THEN summary ELSE ? END WHERE id = ?",
          [body.pid, body.cwd, body.git_root, body.tty, now, body.summary ?? "", body.summary ?? "", live.id],
        );
      } else {
        // Row was reaped but the session is back: resurrect under the SAME id
        // so mail queued for it is still addressed correctly.
        insertPeer.run(mapped.peer_id, body.pid, body.cwd, body.git_root, body.tty, body.summary ?? "", peerType, now, now, null);
      }
      db.run("UPDATE peer_sessions SET updated_at = ? WHERE session_key = ?", [now, cliKey]);
      if (body.summary) cacheSummary(body.cwd, body.git_root, body.summary);
      const restored = live && !body.summary ? live.summary || undefined : undefined;
      return { id: mapped.peer_id, restored_summary: restored };
    }
  } else if (isCli) {
    const existing = db.query("SELECT id, summary FROM peers WHERE pid = ? AND peer_type != 'desktop'").get(body.pid) as { id: string; summary: string } | null;
    if (existing) {
      db.run(
        "UPDATE peers SET cwd = ?, git_root = ?, tty = ?, last_seen = ?, summary = CASE WHEN ? = '' THEN summary ELSE ? END WHERE id = ?",
        [body.cwd, body.git_root, body.tty, now, body.summary ?? "", body.summary ?? "", existing.id],
      );
      if (body.summary) cacheSummary(body.cwd, body.git_root, body.summary);
      return { id: existing.id, restored_summary: body.summary ? undefined : existing.summary || undefined };
    }
  }
```

Declare `cliKey` immediately after the existing `const token = ...` line, so it is in scope for both the block above and the writes below:

```ts
  const cliKey = isCli && body.session_key ? body.session_key : null;
```

**Placement matters — read this carefully.** In the current file the order is:

```
  const token = ...
  if (token) { ...desktop resurrection, returns early... }
  const id = generateId();                     // ← id minted here
  if (token) { INSERT OR REPLACE INTO desktop_tokens ... }
  if (isCli) { ...pid lookup, returns early... }   // ← the block you replaced
  ...
  insertPeer.run(id, ...);                     // ← only reached for a NEW peer
```

The `peer_sessions` write must go **immediately before that final `insertPeer.run`**, *not* next to the `desktop_tokens` write. Writing it earlier would store the freshly minted `id` under `cliKey` before the CLI lookup reads it back, so a returning session would have its mapping overwritten and would be handed a new id — exactly the bug this task exists to fix.

Find the final line of the function:

```ts
  insertPeer.run(id, body.pid, body.cwd, body.git_root, body.tty, summary, peerType, now, now, token);
```

and insert directly above it:

```ts
  // Only reached when a genuinely new peer is being minted. Record its durable
  // key so the next registration under the same session reclaims this id.
  if (token) {
    db.run("INSERT OR REPLACE INTO peer_sessions (session_key, peer_id, peer_type, updated_at) VALUES (?, ?, 'desktop', ?)", [token, id, now]);
  }
  if (cliKey) {
    db.run("INSERT OR REPLACE INTO peer_sessions (session_key, peer_id, peer_type, updated_at) VALUES (?, ?, 'cli', ?)", [cliKey, id, now]);
  }
```

- [ ] **Step 5: Run both tests**

Run: `bun test broker.test.ts -t "cli peers keyed by session_key"` then `bun test broker.test.ts -t "still dedupes by pid"`
Expected: both PASS

- [ ] **Step 6: Run the whole suite**

Run: `bun test`
Expected: 54 pass, 0 fail. The existing `"cli re-register with the same pid keeps the same id"` test must still pass — it sends no `session_key`, so it exercises the fallback.

- [ ] **Step 7: Commit**

```bash
git add shared/types.ts broker.ts broker.test.ts
git commit -m "Key CLI peer identity on Claude Code's session id, with pid fallback"
```

---

### Task 3: `server.ts` sends its session key

**Files:**
- Modify: `server.ts` (near `HOST_PID` at `:50`; registration at `:1118`; `ensureRegistered` at `:182`)

**Interfaces:**
- Consumes: `RegisterRequest.session_key` from Task 2
- Produces: `SESSION_KEY: string | undefined`

- [ ] **Step 1: Add the constant**

In `server.ts`, immediately after the `HOST_PID` declaration:

```ts
/**
 * Claude Code's own session id, which this MCP server inherits in its
 * environment. Measured 2026-09-09: present in the server process and equal to
 * the `sessionId` from `claude agents --json`. Stable across --resume and
 * across crash+restart, so the broker keys CLI peer identity on it and a
 * restarted session keeps its id and its queued mail. Undefined when run
 * standalone; the broker falls back to pid matching.
 *
 * Desktop is unaffected: one bridge process serves many sessions, so a
 * process-level variable cannot discriminate between them and those sessions
 * continue to use claim_session / peer_session.
 */
const SESSION_KEY = process.env.CLAUDE_CODE_SESSION_ID || undefined;
```

- [ ] **Step 2: Send it from both registration sites**

In the CLI branch of `main()` (~`:1118`), add `session_key: SESSION_KEY,` to the `/register` body, after `peer_type: PEER_TYPE,`.

In `ensureRegistered()` (~`:182`), add the same line to its `/register` body.

- [ ] **Step 3: Log it, so a broken environment is visible**

Change the registration log line (~`:1127`) from:

```ts
    log(`Registered as peer ${myId} (host pid ${HOST_PID})`);
```

to:

```ts
    log(`Registered as peer ${myId} (host pid ${HOST_PID}, session_key ${SESSION_KEY ?? "none — falling back to pid"})`);
```

- [ ] **Step 4: Verify the variable is actually present**

Run: `bun -e 'console.log(process.env.CLAUDE_CODE_SESSION_ID ? "present" : "ABSENT")'`
Expected: `present`

If it prints `ABSENT`, stop and report: the fallback still works, but Phase 1a's whole premise needs re-measuring on this Claude Code version before continuing.

- [ ] **Step 5: Typecheck and test**

Run: `bunx tsc --noEmit` — expect only the two pre-existing `server.test.ts` errors (TS2352 at `:52`, TS2532 at `:56`), no new ones. Then `bun test` — expect 54 pass.

- [ ] **Step 6: Commit**

```bash
git add server.ts
git commit -m "Send the Claude Code session id when registering a CLI peer"
```

---

### Task 4: Stop deleting undelivered mail

**Correction to the spec's wording, verified in code.** The spec (§4, §12) says
"both mail-deleting paths", but there is exactly ONE: `broker.ts:107`
(`DELETE FROM messages ... delivered = 0`, inside `cleanStalePeers`).
`handleListPeers:350` calls `deletePeer`, which is `DELETE FROM peers WHERE id = ?`
— a row delete, not a mail delete.

Both edits are still in scope. The mail delete must go so the 72h undelivered TTL
is the only bound. The read-path row delete must go because a listing handler
silently mutating state is a surprising side effect, and with `peer_sessions` in
place the row delete no longer costs the session its identity.

**Files:**
- Modify: `broker.ts` (`cleanStalePeers` `:107`; `handleListPeers` inline delete ~`:349`)
- Test: `broker.test.ts`

**Interfaces:**
- Consumes: Task 2's durable identity (without it a preserved message is addressed to an id nothing can claim)
- Produces: `restartBroker()` in `broker.test.ts`, used again by Task 5

- [ ] **Step 1: Add a restart helper and write the failing tests**

`cleanStalePeers` runs at broker startup (`broker.ts:127`) and on a 30s interval
(`:133`). `/list-peers` never reaches it. So the only deterministic way to
exercise the mail-deletion path in a test is to restart the broker against the
same DB. Add this helper to `broker.test.ts`, next to the existing `post` helper:

```ts
// cleanStalePeers runs on broker startup, so a restart against the same DB is
// the deterministic way to trigger the stale-peer sweep. The other trigger is a
// 30s interval, which is too slow for a test.
async function restartBroker() {
  proc.kill();
  await proc.exited;
  proc = Bun.spawn(["bun", `${import.meta.dir}/broker.ts`], {
    env: { ...process.env, CLAUDE_PEERS_PORT: String(PORT), CLAUDE_PEERS_DB: DB },
    stdout: "ignore", stderr: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${HTTP}/health`)).ok) return; } catch {}
    await Bun.sleep(100);
  }
  throw new Error("broker did not restart");
}
```

Then add both tests:

```ts
test("mail for a dead-pid peer survives the stale-peer sweep", async () => {
  const doomed = Bun.spawn(["sleep", "30"]);
  const deadPid = doomed.pid;

  const victim = await post<{ id: string }>("/register", {
    pid: deadPid, cwd: "/tmp/dead-cli", git_root: null, tty: null,
    summary: "About to die", peer_type: "cli", session_key: "sess-dead-9999",
  });
  const sender = await register("Sender", "cli");
  await post("/send-message", { from_id: sender, to_id: victim.id, text: "answer you missed" });

  doomed.kill();
  await doomed.exited;
  await restartBroker();

  const peek = await post<{ messages: Array<{ text: string }> }>("/peek-messages", { id: victim.id });
  expect(peek.messages.map((m) => m.text)).toContain("answer you missed");
});

test("list-peers hides a dead-pid peer without destroying its identity", async () => {
  const doomed = Bun.spawn(["sleep", "30"]);
  const deadPid = doomed.pid;
  const KEY = "sess-listreap-7777";

  const before = await post<{ id: string }>("/register", {
    pid: deadPid, cwd: "/tmp/listreap", git_root: null, tty: null,
    summary: "Reaped by listing", peer_type: "cli", session_key: KEY,
  });
  doomed.kill();
  await doomed.exited;

  const listed = await post<Array<{ id: string }>>("/list-peers", { scope: "machine", cwd: "/", git_root: null });
  expect(listed.some((p) => p.id === before.id)).toBe(false);

  // The listing must not have cost the session its identity.
  const after = await post<{ id: string }>("/register", {
    pid: LIVE_PIDS[0]!, cwd: "/tmp/listreap", git_root: null, tty: null,
    summary: "", peer_type: "cli", session_key: KEY,
  });
  expect(after.id).toBe(before.id);
});
```

- [ ] **Step 2: Run them and confirm the first fails**

Run: `bun test broker.test.ts -t "survives the stale-peer sweep"`
Expected: FAIL — `peek.messages` is empty, because the startup sweep saw a dead
pid and deleted the peer's undelivered mail at `broker.ts:107`.

The second test may already pass — `peer_sessions` resurrection from Task 2
covers it. That is fine; it is a regression guard for the `handleListPeers`
change, not a red-first test.

- [ ] **Step 3: Remove the deletion in `cleanStalePeers`**

In `broker.ts`, in the `catch` branch of the pid check (~`:105-108`), delete the message-deleting line so the branch reads:

```ts
    } catch {
      // Process is gone: drop the row so it stops showing up as live.
      // Do NOT delete its undelivered mail. The peer id is durable via
      // peer_sessions, so a restarted session reclaims this id and must still
      // receive what was queued. The 72h undelivered TTL below is the bound.
      db.run("DELETE FROM peers WHERE id = ?", [peer.id]);
    }
```

- [ ] **Step 4: Remove the inline delete in `handleListPeers`**

In the filter at the end of `handleListPeers` (~`:344-353`), the `catch` currently calls `deletePeer.run(p.id)`. Replace the whole filter with:

```ts
  // Verify each peer's process is still alive.
  // Desktop peers share one VM PID — skip the kill check; heartbeat timeout handles staleness.
  return peers.filter((p) => {
    if (p.peer_type === "desktop") return true;
    try {
      process.kill(p.pid, 0);
      return true;
    } catch {
      // Hide it from this listing, but do not delete here. Row cleanup is
      // cleanStalePeers' job, and mail is never deleted (see Task 4 rationale).
      return false;
    }
  });
```

- [ ] **Step 5: Run the test**

Run: `bun test broker.test.ts -t "survives the stale-peer sweep"` and
`bun test broker.test.ts -t "without destroying its identity"`
Expected: both PASS

- [ ] **Step 6: Run the whole suite**

Run: `bun test`
Expected: 56 pass, 0 fail

- [ ] **Step 7: Commit**

```bash
git add broker.ts broker.test.ts
git commit -m "Never delete a peer's undelivered mail; the 72h TTL is the only bound"
```

---

### Task 5: The delivery test

Tasks 2 and 4 are each individually testable but neither proves the goal. This one does: a restarted CLI session, under a new pid, reads a message queued while it was gone. Preserving a row addressed to a dead id is not delivery.

**Files:**
- Test: `broker.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4
- Produces: nothing

- [ ] **Step 1: Write the test**

```ts
test("a restarted CLI session reads mail queued while it was down", async () => {
  const KEY = "sess-restart-4242";
  const doomed = Bun.spawn(["sleep", "30"]);
  const deadPid = doomed.pid;

  // Session registers and is alive.
  const before = await post<{ id: string }>("/register", {
    pid: deadPid, cwd: "/tmp/restart", git_root: null, tty: "ttys200",
    summary: "CA1", peer_type: "cli", session_key: KEY,
  });

  // Someone answers it.
  const sender = await register("COS", "cli");
  await post("/send-message", { from_id: sender, to_id: before.id, text: "yes, ship it" });

  // The session dies and the stale-peer sweep runs (see Task 4: a restart is
  // what actually triggers cleanStalePeers).
  doomed.kill();
  await doomed.exited;
  await restartBroker();

  // It comes back: same session_key, brand new pid.
  const after = await post<{ id: string }>("/register", {
    pid: LIVE_PIDS[0]!, cwd: "/tmp/restart", git_root: null, tty: "ttys201",
    summary: "", peer_type: "cli", session_key: KEY,
  });

  expect(after.id).toBe(before.id);

  const peek = await post<{ messages: Array<{ text: string }> }>("/peek-messages", { id: after.id });
  expect(peek.messages.map((m) => m.text)).toContain("yes, ship it");
});
```

- [ ] **Step 2: Run it**

Run: `bun test broker.test.ts -t "restarted CLI session reads mail"`
Expected: PASS. If it fails on `after.id`, Task 2 is incomplete; if it fails on the message, Task 4 is incomplete.

- [ ] **Step 3: Run the whole suite**

Run: `bun test`
Expected: 57 pass, 0 fail

- [ ] **Step 4: Typecheck**

Run: `bunx tsc --noEmit`
Expected: exactly the two pre-existing `server.test.ts` errors, no new ones.

- [ ] **Step 5: Remove the debug route**

`/debug-peer-sessions` from Task 1 was scaffolding. Delete its `case` from `broker.ts`, and rewrite Task 1's test to assert through the public surface instead:

```ts
test("peer_sessions carries desktop tokens forward and re-running is a no-op", async () => {
  const reg = () => post<{ id: string }>("/register", {
    pid: LIVE_PIDS[0]!, cwd: "cs_mig", git_root: null, tty: null,
    summary: "Migration agent", peer_type: "desktop", session_token: "cs_mig",
  });
  const first = await reg();
  await post("/unregister", { id: first.id });
  const back = await reg();
  expect(back.id).toBe(first.id);
});
```

- [ ] **Step 6: Run the suite once more**

Run: `bun test`
Expected: 57 pass, 0 fail

- [ ] **Step 7: Commit**

```bash
git add broker.ts broker.test.ts
git commit -m "Prove a restarted CLI session receives mail queued while it was down"
```

---

### Task 6: Document the behavior change

**Files:**
- Modify: `README.md` (the "Desktop / Cowork identity" section)
- Modify: `CLAUDE.md` (Architecture section)

**Interfaces:**
- Consumes: Tasks 1–5
- Produces: nothing

- [ ] **Step 1: Add a README subsection**

Immediately before the existing `### Desktop / Cowork identity` heading:

```markdown
### CLI session identity

A CLI peer is keyed on Claude Code's own session id, which the MCP server reads
from `CLAUDE_CODE_SESSION_ID` in its environment. That id is stable across
`--resume` and across a crash and restart, so a session that goes away and comes
back gets the **same** peer id — and any messages queued for it while it was
gone are still delivered. Undelivered mail is never deleted when a process dies;
the existing 72h TTL is the only bound.

If the variable is absent (a standalone run, or an older Claude Code), the
broker falls back to matching on the session's pid, which is the previous
behavior.
```

- [ ] **Step 2: Update `CLAUDE.md`**

In the Architecture section, append to the `broker.ts` bullet:

```markdown
  Peer identity is durable: `peer_sessions` maps a session key to a peer id —
  `CLAUDE_CODE_SESSION_ID` for CLI peers, a claimed token for Desktop — so ids
  survive process death. Undelivered mail is never deleted on reap.
```

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "Document durable CLI session identity and mail retention"
```

---

## Done when

- `bun test` → 57 pass, 0 fail
- `bunx tsc --noEmit` → only the two pre-existing `server.test.ts` errors
- A restarted CLI session keeps its peer id and receives mail queued while it was down
- Desktop registration, `claim_session`, and `peer_session` behave exactly as before
- No new MCP tools, no hooks, no `events` or `input_requests` tables — those are Phase 1b
