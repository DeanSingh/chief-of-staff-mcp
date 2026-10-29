import { test, expect, describe } from "bun:test";
import {
  buildTools,
  SESSION_ID_REQUIRED_TOOLS,
  SESSION_PARAM,
  isAmbiguousSession,
  cliRegisterBody,
} from "./server.ts";

// Two independent transport constraints are pinned here, both learned the
// hard way from Desktop/Cowork sessions:
//
// 1. Claude Desktop's remote-tools dispatcher destructures `session_id` out of
//    the arguments before dispatch and never forwards it, so a parameter with
//    that exact name is silently swallowed and can never reach this server.
// 2. localMcpBridge re-announces our tools as {name, description, inputSchema}
//    only — the server-level `instructions` field is dropped — so the per-tool
//    schema is the only channel that can state the requirement.

const desktopTools = buildTools("desktop");
const cliTools = buildTools("cli");

describe("session parameter avoids the reserved name", () => {
  test("SESSION_PARAM is not the reserved `session_id`", () => {
    expect(SESSION_PARAM).not.toBe("session_id");
  });

  for (const tool of [...desktopTools, ...cliTools]) {
    test(`${tool.name} declares no session_id property`, () => {
      expect(tool.inputSchema.properties).not.toHaveProperty("session_id");
    });

    test(`${tool.name} never requires session_id`, () => {
      expect(tool.inputSchema.required ?? []).not.toContain("session_id");
    });
  }
});

describe("desktop schema matches the runtime guard", () => {
  for (const name of SESSION_ID_REQUIRED_TOOLS) {
    const tool = desktopTools.find((t) => t.name === name);

    test(`${name} declares ${SESSION_PARAM}`, () => {
      expect(tool).toBeDefined();
      expect(tool!.inputSchema.properties).toHaveProperty(SESSION_PARAM);
    });

    test(`${name} marks ${SESSION_PARAM} as required`, () => {
      expect(tool!.inputSchema.required ?? []).toContain(SESSION_PARAM);
    });

    test(`${name} does not describe ${SESSION_PARAM} as optional`, () => {
      const props = tool!.inputSchema.properties as Record<
        string,
        { description: string }
      >;
      expect(props[SESSION_PARAM].description.toLowerCase()).not.toContain(
        "optional"
      );
    });
  }

  test("list_peers stays optional — the runtime guard exempts it", () => {
    const tool = desktopTools.find((t) => t.name === "list_peers")!;
    expect(tool.inputSchema.required ?? []).not.toContain(SESSION_PARAM);
  });
});

describe("ambiguous session keys are refused, not aliased", () => {
  // Every cloud Cowork session has cwd /home/claude. Keying on it aliased the
  // PM agent and the Design Agent onto one peer: the later set_summary
  // overwrote the earlier, and a message addressed to that peer was delivered
  // back to its sender.
  for (const path of ["/home/claude", "/home/claude/", "/", "/root", "/app"]) {
    test(`${path} is rejected as a session key`, () => {
      expect(isAmbiguousSession(path)).toBe(true);
    });
  }

  // Local Cowork sandboxes get genuinely distinct paths and must keep working.
  for (const path of [
    "/sessions/busy-peaceful-goodall",
    "/home/claude/project",
    "cs_1a2b3c4d5e6f",
  ]) {
    test(`${path} is accepted as a session key`, () => {
      expect(isAmbiguousSession(path)).toBe(false);
    });
  }

  test("claim_session is offered on desktop so sessions can get a unique key", () => {
    expect(desktopTools.map((t) => t.name)).toContain("claim_session");
  });

  test("claim_session is not offered to cli sessions", () => {
    expect(cliTools.map((t) => t.name)).not.toContain("claim_session");
  });

  test("claim_session does not itself require a session key", () => {
    const tool = desktopTools.find((t) => t.name === "claim_session")!;
    expect(tool.inputSchema.required ?? []).not.toContain(SESSION_PARAM);
    expect(tool.inputSchema.required ?? []).toContain("label");
  });
});

describe("cli schema never demands a session parameter", () => {
  // CLI sessions have a host peer identity; requiring it would force them to
  // invent a value for a field the runtime ignores.
  for (const tool of cliTools) {
    test(`${tool.name} does not require ${SESSION_PARAM}`, () => {
      expect(tool.inputSchema.required ?? []).not.toContain(SESSION_PARAM);
    });
  }
});

describe("wake instructions", () => {
  const URL_A = "https://ntfy.example/cp-wake-0123456789abcdef01234567";
  const URL_B = "https://ntfy.example/cp-wake-fedcba9876543210fedcba98";
  // The command as the agent's shell will run it. The copy embeds it as a JSON
  // string, which is what the agent passes to Monitor.
  const RAW = `t=$(date +%s); while true; do c=$(date +%s); curl -sN --max-time 600 "${URL_A}/json?since=$t" | grep --line-buffered '"event":"message"'; t=$(( c - 5 )); sleep 2; done | awk '!s[$0]++ { print; fflush() }'`;

  test("wakeInstructions embeds the exact curl|grep command and timeout 1800000", async () => {
    const { wakeInstructions } = await import("./server.ts");
    expect(wakeInstructions(URL_A, "claim")).toContain(
      `Monitor({ command: ${JSON.stringify(RAW)}, description: "claude-peers wake", timeout_ms: 1800000 })`,
    );
  });

  test("wake command reconnects, bounds each stream, and resumes from the last connect", async () => {
    const { wakeInstructions } = await import("./server.ts");
    const text = wakeInstructions(URL_A, "claim");
    // A half-open stream must not leave the agent deaf until Monitor expiry,
    // and resuming from the last *connect* (not disconnect) replays anything
    // published during a stall; awk drops the duplicates.
    for (const part of ["while true", "c=$(date +%s); curl", "--max-time 600", "/json?since=$t", "t=$(( c - 5 ))", "awk '!s[$0]++"]) {
      expect(text).toContain(part);
    }
  });

  test("re-arming tells the agent to check messages once (wakes during the gap are not replayed)", async () => {
    const { wakeInstructions } = await import("./server.ts");
    expect(wakeInstructions(URL_A, "claim")).toMatch(/arm it again with the same call, then call check_messages once/);
  });

  test("claim_session copy says arm now; list_peers copy only if not already running", async () => {
    const { wakeInstructions } = await import("./server.ts");
    expect(wakeInstructions(URL_A, "claim")).toStartWith("To be woken when a peer messages you, arm this Monitor now");
    const list = wakeInstructions(URL_A, "list");
    expect(list).toStartWith(`If your "claude-peers wake" Monitor is not running (or has expired), arm it:`);
    expect(list).not.toContain("arm this Monitor now");
  });

  test("no copy contains \"persistent\"", async () => {
    const { wakeInstructions, peerListHeader, SERVER_INSTRUCTIONS } = await import("./server.ts");
    for (const text of [wakeInstructions(URL_A, "claim"), wakeInstructions(URL_A, "list"), peerListHeader("abc", URL_A), peerListHeader("abc", undefined), SERVER_INSTRUCTIONS]) {
      expect(text).not.toContain("persistent");
    }
  });

  test("server instructions carry no Monitor call (cli sessions read them)", async () => {
    const { SERVER_INSTRUCTIONS } = await import("./server.ts");
    expect(SERVER_INSTRUCTIONS).not.toContain("Monitor(");
    expect(SERVER_INSTRUCTIONS).not.toContain("/watch/");
    expect(SERVER_INSTRUCTIONS).not.toContain("as soon as you see it");
  });

  test("cli list_peers header has no Monitor copy", async () => {
    const { peerListHeader } = await import("./server.ts");
    expect(peerListHeader("abc", undefined)).toBe("Your peer ID: abc\n\n");
  });

  test("list_peers shows only the caller's own wake URL", async () => {
    const { peerListHeader } = await import("./server.ts");
    const mine = peerListHeader("abc", URL_A);
    expect(mine).toContain(`${URL_A}/json`);
    expect(mine).not.toContain(URL_B);
    expect(peerListHeader("def", URL_B)).not.toContain(URL_A);
  });

  test("no wake URL (relay off at the broker) omits the wake copy", async () => {
    const { peerListHeader, wakeCopy } = await import("./server.ts");
    expect(wakeCopy(undefined, "claim")).toBe("");
    expect(peerListHeader("abc", undefined)).toBe("Your peer ID: abc\n\n");
  });

  test("an ambiguous peer_session resolves to no identity (so list_peers can't hand out a shared topic)", async () => {
    const { resolvableSession } = await import("./server.ts");
    expect(resolvableSession("/home/claude")).toBeUndefined();
    expect(resolvableSession("/home/claude/")).toBeUndefined();
    expect(resolvableSession("cs_1a2b3c4d5e6f")).toBe("cs_1a2b3c4d5e6f");
    expect(resolvableSession(undefined)).toBeUndefined();
  });
});

describe("CLI registration builder", () => {
  // Structural, independent of CLAUDE_CODE_SESSION_ID's value: dropping the
  // `session_key: SESSION_KEY` line from cliRegisterBody must fail this test
  // in every environment, whether or not the env var happens to be set. The
  // old version of this test compared `body.session_key` against a
  // re-derivation of the same env var, so it passed even when both sides
  // were undefined — exactly the silent-regression case this test exists to
  // catch (see the comment on cliRegisterBody itself).
  test("cliRegisterBody always includes a session_key property", () => {
    const body = cliRegisterBody("test summary");
    expect(body).toHaveProperty("session_key");
  });

  const hasSessionEnv = !!process.env.CLAUDE_CODE_SESSION_ID;
  if (!hasSessionEnv) {
    console.warn(
      "[server.test.ts] CLAUDE_CODE_SESSION_ID is not set in this environment " +
      "— skipping the session_key VALUE assertion below (structural presence " +
      "is still checked above, in every environment)."
    );
  }

  test.skipIf(!hasSessionEnv)(
    "cliRegisterBody's session_key matches CLAUDE_CODE_SESSION_ID when the env var is set",
    () => {
      const body = cliRegisterBody("test summary");
      expect(body.session_key).not.toBeUndefined();
      expect(body.session_key).toBe(process.env.CLAUDE_CODE_SESSION_ID);
    }
  );
});
