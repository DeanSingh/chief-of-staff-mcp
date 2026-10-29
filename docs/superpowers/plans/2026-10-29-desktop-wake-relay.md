# Desktop Wake Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A message sent to an idle Desktop/Cowork peer wakes it within seconds, with no human nudge.

**Architecture:** Each desktop identity gets a secret wake topic, stored beside its durable token. When the broker queues a message for a desktop peer, it POSTs the literal body `wake` (never message content) to `<relay>/<topic>`. The agent's `Monitor` streams that topic and filters out keep-alives. The resulting event starts a turn, and the agent calls `check_messages`, which already works over the Desktop bridge. Setup reaches the agent only through tool responses (`claim_session`, `list_peers`), because Desktop drops server-level instructions.

**Tech Stack:** Bun, `bun:sqlite`, `bun test`, ntfy (default `https://ntfy.sh`, overridable).

**Spec:** v2 §2 wake tiers ("Pull" tier) and §12 Phase 4 ("optional non-loopback rendezvous so pull-tier sessions wake automatically"). This plan implements Phase 4 with an outbound relay instead of the tunnel.

**Evidence (2026-10-29):** a manual test on the Marketing agent (cloud Cowork, `khdkgske`). It armed `curl -sN https://ntfy.sh/<topic>/json | grep --line-buffered '"event":"message"'` as a Monitor and went idle. A publish at 17:43:12Z started a turn at 17:43:16Z, and its reply arrived by channel push at 17:43:28Z. A local dry run showed ntfy sends `open`, then `keepalive` every 45s, and that the grep passes only `message`. **Precondition:** the re-arm test (`wake2`, ~18:22Z) must pass before Task 3 ships. If it fails, re-arm is unreliable, and Task 3's copy must change before rollout.

## Global Constraints

- The relay body is the literal string `wake`. Message text, sender, and peer ids never leave the machine.
- Topic format: `cp-wake-` + 24 lowercase hex chars from `crypto.getRandomValues`. A topic is shown only to its owner (its own `claim_session` / `list_peers` header), never in another peer's listing.
- Config: `CLAUDE_PEERS_WAKE_RELAY`, default `https://ntfy.sh`; the value `off` disables publishing and the setup copy.
- Publishing is fire-and-forget: `AbortSignal.timeout(3000)`, errors logged and swallowed, and it never delays or fails `/send-message`.
- Coalesce: at most one publish per topic per 10s.
- `Monitor` caps `timeout_ms` at 1800000 and has no `persistent` option. The setup copy uses 1800000 and tells the agent to re-arm on expiry.
- CLI peers get no Monitor copy at all; they have channel push (see memory `no-peer-inbox-monitor-in-cli`).
- Wire identity unchanged (CLAUDE.md).

## Review Focus

1. **Burst of messages to one agent**: ten sends must not mean ten wakes. → Task 1 test `coalesces publishes within 10s`.
2. **Relay down or slow**: `/send-message` must still return promptly and queue the mail. → Task 1 test `send succeeds when the relay hangs`.
3. **Topic leakage via `list_peers`**: another peer's listing must not contain any topic. → Task 2 test `list_peers shows only the caller's own topic`.
4. **Reaped and resurrected desktop peer**: it must keep the same topic, or its armed Monitor goes deaf. → Task 1 test `topic survives reap and resurrection`.
5. **Relay disabled**: no publish and no Monitor copy, and the existing pull behavior is unchanged. → Task 1 test `off disables publishing`; Task 2 test `off omits the wake copy`.
6. **Stream ends silently** (observed 18:24Z: `curl` exited 0 about 2.5 min after `wake2`, 19 min before the Monitor's timeout): a bare `curl` leaves the agent deaf until it notices. The copy loops `curl` and resumes with `since=<last connect − 5s>`, so a wake published during the gap is still delivered, and an `awk` filter outside the loop drops the replayed duplicate. Verified locally 2026-10-29 with forced 4s drops: a publish made during the gap was delivered exactly once. → Task 2 test `wake command reconnects and resumes with since=`. Task 3 Step 4 is a live check that runs past one stream drop.

---

### Task 1: Broker topics and publish-on-send

**Files:**
- Modify: `broker.ts` (migration adds `wake_topic TEXT` to `desktop_tokens`, using the ALTER-if-missing pattern at ~:73; `handleRegister` desktop branches; `handleSendMessage` ~:503)
- Modify: `shared/types.ts` (`RegisterResponse.wake_topic?: string`)
- Test: `broker.test.ts` (new `describe("wake relay")`; the broker is spawned with `CLAUDE_PEERS_WAKE_RELAY=http://127.0.0.1:<stub>`, where a `Bun.serve` stub records POSTs)

**Interfaces:**
- Produces: `RegisterResponse.wake_topic` is set for every desktop registration (new, existing, or resurrected) when the relay is not `off`. Rows without a topic get one lazily on their next register. CLI responses never carry one.
- Produces: `publishWake(topic: string): void` (fire-and-forget, coalesced).

- [ ] **Step 1: Failing tests**
  ```ts
  test("desktop register returns a cp-wake- topic; cli does not", ...)      // /^cp-wake-[0-9a-f]{24}$/
  test("same token → same topic across re-register", ...)
  test("topic survives reap and resurrection", ...)                        // restartBroker path used by the existing resurrection test
  test("send to a desktop peer publishes exactly 'wake' to its topic", ...) // stub saw POST /<topic>, body "wake"
  test("send to a cli peer publishes nothing", ...)
  test("coalesces publishes within 10s", ...)                              // 5 sends → 1 POST
  test("send succeeds when the relay hangs", ...)                          // stub never responds; /send-message returns ok in < 500ms
  test("off disables publishing", ...)                                     // second broker instance, env off → 0 POSTs, no wake_topic
  ```
- [ ] **Step 2:** `bun test broker.test.ts -t "wake relay"` → FAIL.
- [ ] **Step 3:** Implement the migration, topic minting in the desktop paths of `handleRegister`, `publishWake`, and the call in `handleSendMessage` when `target.peer_type === 'desktop'`.
- [ ] **Step 4:** `bun test` → all pass.
- [ ] **Step 5:** Commit `broker: wake desktop peers through a content-free relay publish`.

---

### Task 2: Setup copy delivered through tool responses

**Files:**
- Modify: `server.ts` (`watchInstructions` :77, `claim_session` :653, `getDesktopPeerId` :302 caches `wake_topic` in `desktopPeers`, and the `list_peers` header :710)
- Test: `server.test.ts`

**Interfaces:**
- Consumes: `RegisterResponse.wake_topic` (Task 1).
- Produces: `wakeInstructions(topic: string, relay: string): string`, which replaces `watchInstructions` for desktop. CLI headers drop the Monitor copy entirely.

Exact copy (the tests pin the command string):

```
To be woken when a peer messages you, arm this Monitor now, then carry on:

    Monitor({ command: "t=$(date +%s); while true; do curl -sN \"<relay>/<topic>/json?since=$t\" | grep --line-buffered '\"event\":\"message\"'; t=$(( $(date +%s) - 5 )); sleep 2; done | awk '!s[$0]++ { print; fflush() }'", description: "claude-peers wake", timeout_ms: 1800000 })

When it fires: call check_messages (with your peer_session) and answer what you find. When it expires (every 30 min), arm it again with the same call. This topic is private to you; do not share it.
```

- [ ] **Step 1: Failing tests:**
  - `wakeInstructions embeds the exact curl|grep command and timeout 1800000`
  - `no copy contains "persistent"`
  - `wake command reconnects and resumes with since=` (asserts the `while true` loop, `?since=$t`, the `- 5` back-off, and the `awk '!s[$0]++'` dedupe are in the command)
  - `cli list_peers header has no Monitor copy`
  - `list_peers shows only the caller's own topic`
  - `off omits the wake copy`
- [ ] **Step 2:** `bun test server.test.ts` → FAIL.
- [ ] **Step 3:** Implement. Delete `watchInstructions` and its loopback ws copy. Local Desktop sessions use the relay too, which keeps one path.
- [ ] **Step 4:** `bun test` → all pass; `bunx tsc --noEmit` shows no new errors.
- [ ] **Step 5:** Commit `server: hand desktop peers their wake Monitor via claim_session and list_peers`.

---

### Task 3: Rollout and live verification

- [ ] **Step 1:** SE review of Tasks 1–2. Their focus: outbound traffic, topic secrecy, and the default relay.
- [ ] **Step 2 (Dean's OK):** restart the broker, then verify by probe. `lsof` must show a new listener pid, and a `/register` of a throwaway desktop token must return a `wake_topic`.
- [ ] **Step 3:** In one idle Cowork agent, call `list_peers` and arm the Monitor it prints. Leave the agent idle, `bun cli.ts send <id> "wake check: reply 'woke'"`, and expect a reply within 60s with nobody typing.
- [ ] **Step 4:** Repeat Step 3 after 30 minutes to confirm the re-arm.
- [ ] **Step 5:** Update the README and CLAUDE.md "Architecture" paragraph to describe the relay and `CLAUDE_PEERS_WAKE_RELAY`. Commit and push.

---

### Task 4: SE follow-ups from PR #1

From the SE approval of PR #1 (ed2242c). These are not part of the wake relay, but they ship on this branch.

**Files:** `broker.ts` (`sessionStart` rekey branch), `cli.ts` (`install-hooks`), `broker.test.ts`, `cli.test.ts`

- [ ] **Step 1: Failing tests**
  ```ts
  test("rekey moves undelivered mail from an id only its launch key maps to", ...)  // launch key K0 minted A; mail to A; resume K1→B; A's mail now peeks under B
  test("rekey leaves mail on an id that more than one key maps to", ...)           // A mapped by K0 and K2 (/clear); resume → A's mail stays on A
  test("install-hooks replaces settings.json by rename, not in place", ...)        // inode changes; no *.tmp left behind
  test("install-hooks keeps a symlinked settings.json a symlink", ...)             // writes through to the link target
  ```
- [ ] **Step 2:** `bun test broker.test.ts cli.test.ts` → FAIL.
- [ ] **Step 3:** Implement the changes:
  - In the rekey branch, `UPDATE messages SET to_id = target WHERE to_id = old AND delivered = 0` when exactly one `peer_sessions` key maps to the old id.
  - In install-hooks, resolve the real path, write `<real>.tmp-<pid>`, then rename it over `<real>`.
- [ ] **Step 4:** `bun test` → all pass.
- [ ] **Step 5:** Commit `SE follow-ups: rekey carries a launch-only id's mail; install-hooks writes atomically`.
