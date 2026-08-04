import { test, expect, describe } from "bun:test";
import {
  buildTools,
  SESSION_ID_REQUIRED_TOOLS,
  SESSION_PARAM,
  isAmbiguousSession,
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
