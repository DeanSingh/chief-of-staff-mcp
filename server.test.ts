import { test, expect, describe } from "bun:test";
import { buildTools, SESSION_ID_REQUIRED_TOOLS } from "./server.ts";

// Claude Desktop's localMcpBridge re-announces our tools to remote/Cowork
// sessions as { name, description, inputSchema } only — the MCP server
// `instructions` field is dropped. So the per-tool schema is the ONLY place a
// remote session learns that session_id is mandatory. If the schema says
// otherwise, the model omits it and the runtime guard rejects every call.

const desktopTools = buildTools("desktop");
const cliTools = buildTools("cli");

describe("desktop schema matches the runtime session_id guard", () => {
  for (const name of SESSION_ID_REQUIRED_TOOLS) {
    const tool = desktopTools.find((t) => t.name === name);

    test(`${name} declares session_id`, () => {
      expect(tool).toBeDefined();
      expect(tool!.inputSchema.properties).toHaveProperty("session_id");
    });

    test(`${name} marks session_id as required`, () => {
      expect(tool!.inputSchema.required ?? []).toContain("session_id");
    });

    test(`${name} does not describe session_id as optional`, () => {
      const props = tool!.inputSchema.properties as Record<
        string,
        { description: string }
      >;
      expect(props.session_id.description.toLowerCase()).not.toContain(
        "optional"
      );
    });
  }

  test("list_peers stays optional — the runtime guard exempts it", () => {
    const tool = desktopTools.find((t) => t.name === "list_peers")!;
    expect(tool.inputSchema.required ?? []).not.toContain("session_id");
  });
});

describe("cli schema never demands session_id", () => {
  // CLI sessions have a host peer identity; requiring session_id would force
  // them to invent a value for a field the runtime ignores.
  for (const tool of cliTools) {
    test(`${tool.name} does not require session_id`, () => {
      expect(tool.inputSchema.required ?? []).not.toContain("session_id");
    });
  }
});
