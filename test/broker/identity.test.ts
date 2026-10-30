/**
 * Peer identity: registration, reaping and resurrection, session keys,
 * the startup migration, and summaries across restarts.
 */

import { test, expect, describe, afterAll } from "bun:test";
import { ROOT, LIVE_PIDS, headersFor, postTo, useBroker } from "./harness.ts";

const { PORT, HTTP, DB, post, restartBroker, register } = useBroker();

describe("peer identity", () => {
  test("desktop peers keyed by session_token keep their id across server processes", async () => {
    const reg = (pid: number, summary: string) =>
      post<{ id: string; restored_summary?: string }>("/register", {
        pid,
        cwd: "cs_tok1",
        git_root: null,
        tty: null,
        summary,
        peer_type: "desktop",
        session_token: "cs_tok1",
      });
    const first = await reg(LIVE_PIDS[0]!, "Finance agent");
    // A different MCP server process (different pid) re-registers the same token
    // with an empty summary — same id, and the summary the session set survives.
    const second = await reg(LIVE_PIDS[1]!, "");
    expect(second.id).toBe(first.id);
    expect(second.restored_summary).toBe("Finance agent");
    // Same token with a new summary updates in place, still same id.
    const third = await reg(LIVE_PIDS[0]!, "Finance agent — closing Q3");
    expect(third.id).toBe(first.id);
    const peers = await post<Array<{ id: string; summary: string }>>("/list-peers", {
      scope: "machine",
      cwd: "/",
      git_root: null,
    });
    expect(peers.filter((p) => p.id === first.id)).toHaveLength(1);
    expect(peers.find((p) => p.id === first.id)!.summary).toBe("Finance agent — closing Q3");
  });

  test("a reaped desktop peer resurrects under its original id with mail intact", async () => {
    const reg = () =>
      post<{ id: string }>("/register", {
        pid: LIVE_PIDS[0]!,
        cwd: "cs_resur",
        git_root: null,
        tty: null,
        summary: "PM agent",
        peer_type: "desktop",
        session_token: "cs_resur",
      });
    const first = await reg();
    const sender = await register("Sender", "cli");
    await post("/send-message", { from_id: sender, to_id: first.id, text: "while you were out" });
    // Simulate heartbeat expiry: the peers row is deleted (as cleanStalePeers
    // does), but messages and the token mapping remain.
    await post("/unregister", { id: first.id });
    // Session comes back, same token -> SAME id, queued mail still addressed to it.
    const back = await reg();
    expect(back.id).toBe(first.id);
    const peek = await post<{ messages: Array<{ text: string }> }>("/peek-messages", { id: back.id });
    expect(peek.messages.map((m) => m.text)).toContain("while you were out");
  });

  test("heartbeat for a reaped peer says not found, so its server can re-register it", async () => {
    const reg = () =>
      post<{ id: string }>("/register", {
        pid: LIVE_PIDS[0]!,
        cwd: "cs_beat",
        git_root: null,
        tty: null,
        summary: "",
        peer_type: "desktop",
        session_token: "cs_beat",
      });
    const first = await reg();
    const live = await fetch(`${HTTP}/heartbeat`, {
      method: "POST",
      headers: headersFor(DB, "/heartbeat", { id: first.id }),
      body: JSON.stringify({ id: first.id }),
    });
    expect(live.status).toBe(200);
    expect(await live.json()).toMatchObject({ ok: true });

    await post("/unregister", { id: first.id }); // as cleanStalePeers does
    const reaped = await fetch(`${HTTP}/heartbeat`, {
      method: "POST",
      headers: headersFor(DB, "/heartbeat", { id: first.id }),
      body: JSON.stringify({ id: first.id }),
    });
    expect(reaped.status).toBe(404);
    expect(await reaped.json()).toMatchObject({ ok: false, error: expect.stringContaining("not found") });
    expect((await reg()).id).toBe(first.id);
  });

  test("cli re-register with the same pid keeps the same id", async () => {
    const reg = (summary: string) =>
      post<{ id: string }>("/register", {
        pid: LIVE_PIDS[1]!,
        cwd: "/tmp/cli-stable",
        git_root: null,
        tty: "ttys099",
        summary,
        peer_type: "cli",
      });
    const a = await reg("QA agent");
    const b = await reg(""); // MCP server respawned by /mcp reconnect
    expect(b.id).toBe(a.id);
  });

  test("cli peers keyed by session_key keep their id across pid changes", async () => {
    const reg = (pid: number, summary: string) =>
      post<{ id: string; restored_summary?: string }>("/register", {
        pid,
        cwd: "/tmp/cli-sess",
        git_root: null,
        tty: "ttys100",
        summary,
        peer_type: "cli",
        session_key: "sess-aaaa-1111",
      });
    const doomed = Bun.spawn(["sleep", "30"]);
    const first = await reg(doomed.pid, "CA1");
    doomed.kill();
    await doomed.exited;
    // Same session, restarted: a DIFFERENT pid, same session_key.
    const second = await reg(LIVE_PIDS[1]!, "");
    expect(second.id).toBe(first.id);
    expect(second.restored_summary).toBe("CA1");
  });

  test("a pre-upgrade CLI peer (no session_key) is ADOPTED, not duplicated, once it starts sending one", async () => {
    // Fresh, never-before-used pid: a spawned "sleep" gives an alive pid this
    // test owns exclusively, so this doesn't collide with pid state any other
    // test in this file left behind on LIVE_PIDS.
    const doomed = Bun.spawn(["sleep", "30"]);
    const pid = doomed.pid;
    const restarted = Bun.spawn(["sleep", "30"]);
    try {
      // Simulates every existing session at the moment this fix lands: a
      // peers row keyed on pid alone, no peer_sessions mapping at all.
      const before = await post<{ id: string }>("/register", {
        pid,
        cwd: "/tmp/upgrade-cli",
        git_root: null,
        tty: null,
        summary: "Pre-upgrade agent",
        peer_type: "cli",
      });
      const sender = await register("Sender", "cli");
      await post("/send-message", { from_id: sender, to_id: before.id, text: "queued before upgrade" });

      // The upgraded server reconnects: SAME pid, but now sends a session_key
      // for the first time. It must adopt the existing peer, not mint a new one.
      const after = await post<{ id: string }>("/register", {
        pid,
        cwd: "/tmp/upgrade-cli",
        git_root: null,
        tty: null,
        summary: "",
        peer_type: "cli",
        session_key: "sess-upgrade-adopt-1",
      });

      expect(after.id).toBe(before.id);

      const peek = await post<{ messages: Array<{ text: string }> }>("/peek-messages", { id: after.id });
      expect(peek.messages.map((m) => m.text)).toContain("queued before upgrade");

      // The assertions above also hold on a broker that ignores session_key
      // entirely (same pid -> same id). What proves the adoption RECORDED the
      // key -> id mapping is a later registration that can only resolve by
      // key: same session_key, a different pid. The original process has
      // exited first, as it would on a real restart (a still-running original
      // keeps the id; see "a second live process resuming the same session").
      doomed.kill();
      await doomed.exited;
      const later = await post<{ id: string }>("/register", {
        pid: restarted.pid,
        cwd: "/tmp/upgrade-cli",
        git_root: null,
        tty: null,
        summary: "",
        peer_type: "cli",
        session_key: "sess-upgrade-adopt-1",
      });
      expect(later.id).toBe(before.id);
    } finally {
      doomed.kill();
      restarted.kill();
      await doomed.exited;
      await restarted.exited;
    }
  });

  test("a reaped cli peer resurrects under its original id with its cached summary restored", async () => {
    const reg = (summary: string) =>
      post<{ id: string; restored_summary?: string }>("/register", {
        pid: LIVE_PIDS[0]!,
        cwd: "/tmp/cli-resur",
        git_root: null,
        tty: "ttys102",
        summary,
        peer_type: "cli",
        session_key: "sess-resur-1",
      });
    const first = await reg("Ops agent");
    // Simulate heartbeat expiry: the peers row is deleted (as cleanStalePeers
    // does), but peer_sessions and the workspace summary cache remain.
    await post("/unregister", { id: first.id });
    // Session comes back, same session_key, no summary supplied -> SAME id,
    // and the cached summary comes back rather than a blank one.
    const back = await reg("");
    expect(back.id).toBe(first.id);
    expect(back.restored_summary).toBe("Ops agent");
    const peers = await post<Array<{ id: string; summary: string }>>("/list-peers", {
      scope: "machine",
      cwd: "/",
      git_root: null,
    });
    expect(peers.find((p) => p.id === first.id)!.summary).toBe("Ops agent");
  });

  test("mail for a dead-pid peer survives the stale-peer sweep", async () => {
    const doomed = Bun.spawn(["sleep", "30"]);
    const deadPid = doomed.pid;

    const victim = await post<{ id: string }>("/register", {
      pid: deadPid,
      cwd: "/tmp/dead-cli",
      git_root: null,
      tty: null,
      summary: "About to die",
      peer_type: "cli",
      session_key: "sess-dead-9999",
    });
    const sender = await register("Sender", "cli");
    await post("/send-message", { from_id: sender, to_id: victim.id, text: "answer you missed" });

    doomed.kill();
    await doomed.exited;
    await restartBroker();

    const peek = await post<{ messages: Array<{ text: string }> }>("/peek-messages", { id: victim.id });
    expect(peek.messages.map((m) => m.text)).toContain("answer you missed");
  });

  test("a restarted CLI session still reads mail sent before it died", async () => {
    const KEY = "sess-restart-4242";
    const doomed = Bun.spawn(["sleep", "30"]);
    const deadPid = doomed.pid;

    // Session registers and is alive.
    const before = await post<{ id: string }>("/register", {
      pid: deadPid,
      cwd: "/tmp/restart",
      git_root: null,
      tty: "ttys200",
      summary: "CA1",
      peer_type: "cli",
      session_key: KEY,
    });

    // Someone answers it WHILE IT IS STILL ALIVE. This is the only case there
    // is to test: handleSendMessage refuses any send whose to_id has no peers
    // row ("stale or expired ID"), and cleanStalePeers deletes that row within
    // ~30s of the pid dying, so nothing can be queued for this peer again
    // until it re-registers. The guarantee this test proves is narrower than
    // its old name claimed — mail sent before death survives death, not that
    // mail can be queued for a peer that is already gone.
    const sender = await register("COS", "cli");
    await post("/send-message", { from_id: sender, to_id: before.id, text: "yes, ship it" });

    // The session dies and the stale-peer sweep runs (see Task 4: a restart is
    // what actually triggers cleanStalePeers).
    doomed.kill();
    await doomed.exited;
    await restartBroker();

    // It comes back: same session_key, brand new pid.
    const after = await post<{ id: string }>("/register", {
      pid: LIVE_PIDS[0]!,
      cwd: "/tmp/restart",
      git_root: null,
      tty: "ttys201",
      summary: "",
      peer_type: "cli",
      session_key: KEY,
    });

    expect(after.id).toBe(before.id);

    const peek = await post<{ messages: Array<{ text: string }> }>("/peek-messages", { id: after.id });
    expect(peek.messages.map((m) => m.text)).toContain("yes, ship it");
  });

  test("list-peers hides a dead-pid peer without destroying its identity", async () => {
    const doomed = Bun.spawn(["sleep", "30"]);
    const deadPid = doomed.pid;
    const KEY = "sess-listreap-7777";

    const before = await post<{ id: string }>("/register", {
      pid: deadPid,
      cwd: "/tmp/listreap",
      git_root: null,
      tty: null,
      summary: "Reaped by listing",
      peer_type: "cli",
      session_key: KEY,
    });
    doomed.kill();
    await doomed.exited;

    const listed = await post<Array<{ id: string }>>("/list-peers", { scope: "machine", cwd: "/", git_root: null });
    expect(listed.some((p) => p.id === before.id)).toBe(false);

    // The listing must not have cost the session its identity.
    const after = await post<{ id: string }>("/register", {
      pid: LIVE_PIDS[0]!,
      cwd: "/tmp/listreap",
      git_root: null,
      tty: null,
      summary: "",
      peer_type: "cli",
      session_key: KEY,
    });
    expect(after.id).toBe(before.id);
  });

  test("heartbeat refreshes the peer_sessions mapping, keeping it alive past what would be its expiry", async () => {
    // cleanStalePeers sweeps peer_sessions rows older than 30 days. A session
    // that registers once and then just heartbeats for longer than that must
    // not have its mapping swept out from under it. We don't fake 30 days;
    // instead we assert the mechanism the sweep depends on directly:
    // handleHeartbeat must advance peer_sessions.updated_at, keyed on peer_id
    // (not the primary key session_key). If that write is missing, this
    // assertion fails regardless of how the 30-day sweep itself behaves.
    //
    // A second, idle peer guards the other direction: an UPDATE missing its
    // WHERE clause would refresh every mapping, pass the first assertion, and
    // silently defeat the TTL. Fresh pids keep both registrations off the
    // pid-adoption path, so they are guaranteed to be two distinct peers.
    const KEY = "sess-heartbeat-refresh-1";
    const IDLE_KEY = "sess-heartbeat-idle-1";
    const busyProc = Bun.spawn(["sleep", "30"]);
    const idleProc = Bun.spawn(["sleep", "30"]);

    const { Database } = await import("bun:sqlite");
    const readDb = new Database(DB, { readonly: true });
    const updatedAt = (key: string) =>
      new Date(
        (readDb.query("SELECT updated_at FROM peer_sessions WHERE session_key = ?").get(key) as { updated_at: string })
          .updated_at,
      ).getTime();
    try {
      const reg = await post<{ id: string }>("/register", {
        pid: busyProc.pid,
        cwd: "/tmp/heartbeat-refresh",
        git_root: null,
        tty: null,
        summary: "Heartbeating agent",
        peer_type: "cli",
        session_key: KEY,
      });
      const idle = await post<{ id: string }>("/register", {
        pid: idleProc.pid,
        cwd: "/tmp/heartbeat-idle",
        git_root: null,
        tty: null,
        summary: "Idle agent",
        peer_type: "cli",
        session_key: IDLE_KEY,
      });
      expect(idle.id).not.toBe(reg.id);

      const before = updatedAt(KEY);
      const idleBefore = updatedAt(IDLE_KEY);

      // Ensure the next timestamp is measurably later (ISO strings are
      // millisecond-resolution) before heartbeating.
      await Bun.sleep(20);
      await post("/heartbeat", { id: reg.id });

      expect(updatedAt(KEY)).toBeGreaterThan(before);
      expect(updatedAt(IDLE_KEY)).toBe(idleBefore);
    } finally {
      readDb.close();
      busyProc.kill();
      idleProc.kill();
      await busyProc.exited;
      await idleProc.exited;
    }
  });

  test("migration: INSERT OR IGNORE copies desktop_tokens to peer_sessions at startup", async () => {
    // This test ONLY exercises the startup migration (INSERT OR IGNORE ... FROM desktop_tokens),
    // not the handleRegister write path. It spawns a separate broker against a pre-seeded DB.
    const MIGRATION_TEST_PORT = PORT + 100;
    const MIGRATION_TEST_DB = `${import.meta.dir}/.test-broker-migration-${MIGRATION_TEST_PORT}.db`;
    const MIGRATION_TEST_HTTP = `http://127.0.0.1:${MIGRATION_TEST_PORT}`;

    const migrationPost = <T>(path: string, body: unknown) =>
      postTo<T>(MIGRATION_TEST_HTTP, MIGRATION_TEST_DB, path, body);

    // Step 1: Seed a temp DB with a desktop_tokens row (no peer_sessions table yet)
    const { Database } = await import("bun:sqlite");
    const seedDb = new Database(MIGRATION_TEST_DB);
    seedDb.run(`
      CREATE TABLE desktop_tokens (
        token TEXT PRIMARY KEY,
        peer_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    const seedTime = new Date().toISOString();
    seedDb.run(
      `
      INSERT INTO desktop_tokens (token, peer_id, updated_at)
      VALUES (?, ?, ?)
    `,
      ["mig_test_token", "mig_peer_xyz", seedTime],
    );
    seedDb.close();

    let migProc: ReturnType<typeof Bun.spawn> | null = null;

    try {
      // Step 2: Spawn a broker against this seeded DB
      migProc = Bun.spawn(["bun", `${ROOT}/broker.ts`], {
        env: { ...process.env, CLAUDE_PEERS_PORT: String(MIGRATION_TEST_PORT), CLAUDE_PEERS_DB: MIGRATION_TEST_DB },
        stdout: "ignore",
        stderr: "ignore",
      });

      // Step 3: Wait for startup
      let started = false;
      for (let i = 0; i < 50; i++) {
        try {
          if ((await fetch(`${MIGRATION_TEST_HTTP}/health`)).ok) {
            started = true;
            break;
          }
        } catch {}
        await Bun.sleep(100);
      }
      if (!started) throw new Error("Migration broker did not start");

      // Step 4: Verify migration copied the row, through the public surface.
      // The seed above only creates desktop_tokens. peer_sessions is
      // deliberately ABSENT from the seed — it does not exist until the
      // startup migration creates it and copies this row into it. (Do not
      // "helpfully" pre-seed peer_sessions here: that would make this test
      // pass without the migration ever running.) So a CLI registration keyed
      // to the migrated session_key can only get mig_peer_xyz back by reading
      // it out of peer_sessions — the same table the startup migration writes
      // into. No peers row exists yet for mig_peer_xyz either, so this first
      // call also exercises the CLI resurrection branch of handleRegister
      // (mapped session_key, no live peer row).
      const reg1 = await migrationPost<{ id: string }>("/register", {
        pid: process.pid,
        cwd: "/tmp/mig",
        git_root: null,
        tty: null,
        summary: "",
        peer_type: "cli",
        session_key: "mig_test_token",
      });
      expect(reg1.id).toBe("mig_peer_xyz");

      // Step 5: Test idempotency - kill first broker and wait for it to exit
      migProc.kill();
      await migProc.exited; // Deterministically wait for process to actually exit
      await Bun.sleep(200); // Give port time to be released by OS

      // Step 5b: Spawn second broker on same port
      migProc = Bun.spawn(["bun", `${ROOT}/broker.ts`], {
        env: { ...process.env, CLAUDE_PEERS_PORT: String(MIGRATION_TEST_PORT), CLAUDE_PEERS_DB: MIGRATION_TEST_DB },
        stdout: "ignore",
        stderr: "ignore",
      });

      // Step 6: Wait for restart
      let restarted = false;
      for (let i = 0; i < 50; i++) {
        try {
          if ((await fetch(`${MIGRATION_TEST_HTTP}/health`)).ok) {
            restarted = true;
            break;
          }
        } catch {}
        await Bun.sleep(100);
      }
      if (!restarted) throw new Error("Migration broker (restart) did not start");

      // Re-running the migration on restart must not disturb the mapping:
      // the same session_key still resolves to the same peer_id, no error.
      // Note this second call takes the LIVE branch, NOT resurrection: reg1
      // above inserted a peers row under pid=process.pid, which is this test
      // process itself and stays alive across the restart, so cleanStalePeers
      // never reaps it. What this half proves is that peer_sessions still
      // holds the right mapping after a second migration run, not a second
      // pass through the resurrection branch.
      const reg2 = await migrationPost<{ id: string }>("/register", {
        pid: process.pid,
        cwd: "/tmp/mig",
        git_root: null,
        tty: null,
        summary: "",
        peer_type: "cli",
        session_key: "mig_test_token",
      });
      expect(reg2.id).toBe("mig_peer_xyz");
    } finally {
      // Cleanup - guaranteed to run even if assertions fail
      if (migProc) {
        try {
          migProc.kill();
        } catch {}
        try {
          await migProc.exited;
        } catch {} // Wait for process to actually exit
      }
      // Delete temp files - only after process is truly gone
      for (const suffix of ["", "-wal", "-shm", ".secret"]) {
        const filePath = MIGRATION_TEST_DB + suffix;
        try {
          await Bun.file(filePath).delete();
        } catch {} // Missing file is OK
      }
    }
  });
});

describe("summaries after a restart", () => {
  // Several agents share one repo. A peer coming back must get its OWN last
  // summary, never whichever agent in that repo set one most recently.
  const REPO = "/tmp/shared-repo-summaries";
  const sleepers: ReturnType<typeof Bun.spawn>[] = [];
  const livePid = () => {
    const p = Bun.spawn(["sleep", "30"]);
    sleepers.push(p);
    return p.pid;
  };
  afterAll(() => {
    for (const p of sleepers) {
      try {
        p.kill();
      } catch {}
    }
  });
  const cli = (pid: number, session_key: string, summary = "") =>
    post<{ id: string; restored_summary?: string }>("/register", {
      pid,
      cwd: REPO,
      git_root: REPO,
      tty: null,
      summary,
      peer_type: "cli",
      session_key,
    });
  const desk = (token: string, summary = "") =>
    post<{ id: string; restored_summary?: string }>("/register", {
      pid: process.pid,
      cwd: "/",
      git_root: null,
      tty: null,
      summary,
      peer_type: "desktop",
      session_token: token,
    });
  const summaryOf = async (id: string) =>
    (
      await post<Array<{ id: string; summary: string }>>("/list-peers", { scope: "machine", cwd: "/", git_root: null })
    ).find((p) => p.id === id)?.summary;

  test("a returning CLI session gets its own last summary, not the repo's latest", async () => {
    const a = await cli(livePid(), "sum-a", "Coding Agent 1");
    const b = await cli(livePid(), "sum-b");
    await post("/set-summary", { id: b.id, summary: "Security Agent" }); // B speaks last in the repo
    await post("/unregister", { id: a.id }); // A's row is reaped
    const back = await cli(livePid(), "sum-a");
    expect(back.id).toBe(a.id);
    expect(back.restored_summary).toBe("Coding Agent 1");
    expect(await summaryOf(a.id)).toBe("Coding Agent 1");
  });

  test("a summary set after registering is the one restored", async () => {
    const a = await cli(livePid(), "sum-c", "QA Agent");
    await post("/set-summary", { id: a.id, summary: "QA Agent. Grading PR 12" });
    await cli(livePid(), "sum-d", "Coding Agent 3");
    await post("/unregister", { id: a.id });
    expect((await cli(livePid(), "sum-c")).restored_summary).toBe("QA Agent. Grading PR 12");
  });

  test("a brand-new CLI session in a shared repo doesn't inherit another agent's summary", async () => {
    await cli(livePid(), "sum-e", "Production Monitor");
    const fresh = await cli(livePid(), "sum-new");
    expect(fresh.restored_summary).toBeUndefined();
    expect(await summaryOf(fresh.id)).toBe("");
  });

  test("a returning desktop session gets its own last summary", async () => {
    const a = await desk("cs_sum_pm", "PM agent");
    await desk("cs_sum_design", "Design agent");
    await post("/unregister", { id: a.id });
    const back = await desk("cs_sum_pm");
    expect(back.id).toBe(a.id);
    expect(back.restored_summary).toBe("PM agent");
    expect(await summaryOf(a.id)).toBe("PM agent");
  });

  test("a session without a key (older Claude Code) still falls back to the workspace summary", async () => {
    const pid = livePid();
    await post("/register", {
      pid,
      cwd: "/tmp/legacy-ws",
      git_root: null,
      tty: null,
      summary: "Legacy agent",
      peer_type: "cli",
    });
    const fresh = await post<{ id: string; restored_summary?: string }>("/register", {
      pid: livePid(),
      cwd: "/tmp/legacy-ws",
      git_root: null,
      tty: null,
      summary: "",
      peer_type: "cli",
    });
    expect(fresh.restored_summary).toBe("Legacy agent");
  });
});
