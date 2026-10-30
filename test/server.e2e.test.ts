import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { peerSecret, readSecret, secretPath, PEER_HEADER } from "../src/shared/auth.ts";

/** The repo root, where the entry files live. */
const ROOT = dirname(import.meta.dir);

// Real MCP servers (one CLI, one Desktop) over stdio against a real broker on
// a private port: proves every route the servers use carries the install
// secret and the right peer credential once the broker enforces them.
const PORT = 7899 + 2000 + Math.floor(Math.random() * 500);
const HTTP = `http://127.0.0.1:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), "cp-e2e-"));
const DB = join(DIR, "peers.db");
// Stand-in for the wake relay, so no test ever publishes to a real one.
const relayHits: Array<{ path: string; body: string }> = [];
const relay = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    relayHits.push({ path: new URL(req.url).pathname, body: await req.text() });
    return new Response("ok");
  },
});
const ENV = {
  ...process.env,
  CLAUDE_PEERS_PORT: String(PORT),
  CLAUDE_PEERS_DB: DB,
  CLAUDE_PEERS_LOG: join(DIR, "server.log"),
  CLAUDE_PEERS_WAKE_RELAY: `http://127.0.0.1:${relay.port}`,
};

let broker: ReturnType<typeof Bun.spawn>;

class McpClient {
  proc: ReturnType<typeof Bun.spawn>;
  private buf = "";
  private nextId = 1;
  private waiting = new Map<number, (v: any) => void>();
  constructor(env: Record<string, string | undefined>) {
    const proc = Bun.spawn(["bun", `${ROOT}/server.ts`], {
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    this.proc = proc;
    (async () => {
      const dec = new TextDecoder();
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        this.buf += dec.decode(chunk);
        for (let nl = this.buf.indexOf("\n"); nl >= 0; nl = this.buf.indexOf("\n")) {
          const line = this.buf.slice(0, nl);
          this.buf = this.buf.slice(nl + 1);
          try {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && this.waiting.has(msg.id)) {
              this.waiting.get(msg.id)!(msg);
              this.waiting.delete(msg.id);
            }
          } catch {
            /* notification or noise */
          }
        }
      }
    })();
  }
  private write(msg: unknown) {
    (this.proc.stdin as import("bun").FileSink).write(`${JSON.stringify(msg)}\n`);
    (this.proc.stdin as import("bun").FileSink).flush();
  }
  request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout: ${method}`)), 8000);
      this.waiting.set(id, (v) => {
        clearTimeout(t);
        resolve(v);
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }
  async init() {
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "e2e", version: "0" },
    });
    this.write({ jsonrpc: "2.0", method: "notifications/initialized" });
  }
  async call(name: string, args: Record<string, unknown>): Promise<string> {
    const r = await this.request("tools/call", { name, arguments: args });
    return (r.result?.content ?? []).map((c: { text: string }) => c.text).join("\n");
  }
  async checkMessagesDescription(): Promise<string> {
    const r = await this.request("tools/list", {});
    return r.result.tools.find((t: { name: string }) => t.name === "check_messages").description;
  }
  stop() {
    this.proc.kill();
  }
}

// A desktop peer registered straight with the broker, before any server knows it.
async function registerDesktop(token: string): Promise<string> {
  const secret = readSecret(secretPath(DB))!;
  const res = await fetch(`${HTTP}/register`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify({
      pid: process.pid,
      cwd: "/tmp/e2e",
      git_root: null,
      tty: null,
      summary: "",
      peer_type: "desktop",
      session_token: token,
    }),
  });
  return ((await res.json()) as { id: string }).id;
}

// A third peer driven directly, the way the broker tests do.
async function asPeer(path: string, id: string, body: Record<string, unknown>) {
  const secret = readSecret(secretPath(DB))!;
  const res = await fetch(`${HTTP}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
      [PEER_HEADER]: peerSecret(secret, id),
    },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<any>;
}

beforeAll(async () => {
  broker = Bun.spawn(["bun", `${ROOT}/broker.ts`], { env: ENV, stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${HTTP}/health`)).ok) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error("broker did not start");
});

afterAll(() => {
  broker.kill();
  relay.stop(true);
  rmSync(DIR, { recursive: true, force: true });
});

describe("servers against a hardened broker", () => {
  test("cli and desktop servers register, send, receive and ack", async () => {
    const cli = new McpClient({
      ...ENV,
      CLAUDE_PEERS_PEER_TYPE: "cli",
      CLAUDE_PEERS_NAME: "e2e cli",
      CLAUDE_CODE_SESSION_ID: `e2e-${PORT}`,
    });
    const desk = new McpClient({ ...ENV, CLAUDE_PEERS_PEER_TYPE: "desktop" });
    try {
      await cli.init();
      await desk.init();

      const cliList = await cli.call("list_peers", { scope: "machine" });
      const cliId = cliList.match(/Your peer ID: (\w+)/)?.[1];
      expect(cliId).toBeDefined();

      const claimed = await desk.call("claim_session", { label: "e2e desk" });
      const token = claimed.match(/cs_[0-9a-f]{12}/)?.[0];
      const deskId = claimed.match(/Your peer ID is (\w+)/)?.[1];
      expect(token).toBeDefined();
      expect(deskId).toBeDefined();

      expect(await desk.call("set_summary", { summary: "e2e desk summary", peer_session: token })).toContain(
        "Summary updated",
      );
      expect(await desk.call("send_message", { to_id: cliId, message: "desk to cli", peer_session: token })).toContain(
        "Message sent",
      );
      expect(await cli.call("check_messages", {})).toContain("desk to cli");

      expect(await cli.call("send_message", { to_id: deskId, message: "cli to desk" })).toContain("Message sent");
      expect(await desk.call("check_messages", { peer_session: token })).toContain("cli to desk");
      // Acked: nothing left for the desktop peer.
      expect((await asPeer("/peek-messages", deskId!, { id: deskId })).messages).toEqual([]);

      // The desktop peer's token appears nowhere in what other peers see.
      expect(await cli.call("list_peers", { scope: "machine" })).not.toContain(token!);
    } finally {
      cli.stop();
      desk.stop();
    }
  }, 30_000);

  // Issue #6: one shared server, mail queued for a session before the server
  // knew it, at a lower id than mail it has already seen for another session.
  test("each desktop session keeps its own cursor and preview", async () => {
    const desk = new McpClient({ ...ENV, CLAUDE_PEERS_PEER_TYPE: "desktop" });
    try {
      await desk.init();
      const claimed = await desk.call("claim_session", { label: "e2e A" });
      const tokenA = claimed.match(/cs_[0-9a-f]{12}/)![0];
      const idA = claimed.match(/Your peer ID is (\w+)/)![1]!;

      const tokenB = "cs_bbbbbbbbbbbb";
      const idB = await registerDesktop(tokenB);
      const sender = await registerDesktop("cs_cccccccccccc");
      await asPeer("/send-message", sender, { from_id: sender, to_id: idB, text: "early mail for B" });
      await asPeer("/send-message", sender, { from_id: sender, to_id: idA, text: "private note for A" });
      await Bun.sleep(1500); // a poll cycle sees A's mail

      // The shared tool list says mail is waiting but shows none of it.
      const banner = await desk.checkMessagesDescription();
      expect(banner).toMatch(/waiting/i);
      expect(banner).not.toContain("private note for A");

      // B's first tool call puts it on this server; its older mail still arrives.
      await desk.call("set_summary", { summary: "e2e B", peer_session: tokenB });
      await Bun.sleep(1500);
      expect(await desk.call("set_summary", { summary: "e2e B", peer_session: tokenB })).toContain("early mail for B");

      // B's piggyback didn't clear A's banner; A's check_messages clears the last one.
      expect(await desk.checkMessagesDescription()).toMatch(/waiting/i);
      expect(await desk.call("check_messages", { peer_session: tokenA })).toContain("private note for A");
      expect(await desk.checkMessagesDescription()).not.toMatch(/waiting/i);
    } finally {
      desk.stop();
    }
  }, 30_000);
});

describe("desktop sessions after a reap", () => {
  // Issue #5: a desktop peer reaped while its server keeps running must come
  // back on its own, not stay unreachable until it happens to call set_summary.
  test("a reaped desktop session is re-registered by the next heartbeat", async () => {
    const desk = new McpClient({ ...ENV, CLAUDE_PEERS_PEER_TYPE: "desktop", CLAUDE_PEERS_HEARTBEAT_MS: "1000" });
    try {
      await desk.init();
      const claimed = await desk.call("claim_session", { label: "e2e reaped" });
      const token = claimed.match(/cs_[0-9a-f]{12}/)![0];
      const id = claimed.match(/Your peer ID is (\w+)/)![1]!;
      const sender = await registerDesktop("cs_dddddddddddd");

      await asPeer("/unregister", id, { id }); // as cleanStalePeers does after 30 min without a heartbeat
      expect((await asPeer("/send-message", sender, { from_id: sender, to_id: id, text: "x" })).ok).toBe(false);

      await Bun.sleep(2500); // two heartbeats
      const sent = await asPeer("/send-message", sender, { from_id: sender, to_id: id, text: "you're back" });
      expect(sent.ok).toBe(true);
      expect(await desk.call("check_messages", { peer_session: token })).toContain("you're back");
    } finally {
      desk.stop();
    }
  }, 30_000);
});

describe("tool dispatch", () => {
  // Tool names come from the client: one that is an Object prototype key must
  // be as unknown as any other, not dispatched to a built-in.
  test("an unknown tool name is refused, including prototype keys", async () => {
    const cli = new McpClient({
      ...ENV,
      CLAUDE_PEERS_PEER_TYPE: "cli",
      CLAUDE_CODE_SESSION_ID: `e2e-dispatch-${PORT}`,
    });
    try {
      await cli.init();
      for (const name of ["no_such_tool", "constructor", "toString", "__proto__"]) {
        const r = await cli.request("tools/call", { name, arguments: {} });
        expect(JSON.stringify(r)).toContain(`Unknown tool: ${name}`);
      }
    } finally {
      cli.stop();
    }
  }, 30_000);
});

describe("cli sessions after a reap", () => {
  // Issue #5, CLI side: the heartbeat's 404 triggers the re-register, with no
  // list-peers round trip on every beat.
  test("a reaped cli session is re-registered by the next heartbeat", async () => {
    const cli = new McpClient({
      ...ENV,
      CLAUDE_PEERS_PEER_TYPE: "cli",
      CLAUDE_PEERS_NAME: "e2e cli reaped",
      CLAUDE_CODE_SESSION_ID: `e2e-reaped-${PORT}`,
      CLAUDE_PEERS_HEARTBEAT_MS: "1000",
    });
    try {
      await cli.init();
      const id = (await cli.call("list_peers", { scope: "machine" })).match(/Your peer ID: (\w+)/)![1]!;
      const sender = await registerDesktop("cs_eeeeeeeeeeee");

      await asPeer("/unregister", id, { id });
      expect((await asPeer("/send-message", sender, { from_id: sender, to_id: id, text: "x" })).ok).toBe(false);

      await Bun.sleep(2500); // two heartbeats
      // peer_sessions hands the same id back, so the old address works again.
      const sent = await asPeer("/send-message", sender, { from_id: sender, to_id: id, text: "cli is back" });
      expect(sent.ok).toBe(true);
      expect(await cli.call("check_messages", {})).toContain("cli is back");
    } finally {
      cli.stop();
    }
  }, 30_000);
});

describe("desktop wake mode", () => {
  const setMode = async (body: Record<string, unknown>) => {
    const secret = readSecret(secretPath(DB))!;
    const res = await fetch(`${HTTP}/wake-mode`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
  };

  test("a switch reaches a running session, and set_wake changes only that session", async () => {
    const desk = new McpClient({ ...ENV, CLAUDE_PEERS_PEER_TYPE: "desktop", CLAUDE_PEERS_HEARTBEAT_MS: "1000" });
    try {
      await desk.init();
      await setMode({ mode: "passive" });
      const claimed = await desk.call("claim_session", { label: "e2e wake" });
      const token = claimed.match(/cs_[0-9a-f]{12}/)![0];
      expect(claimed).not.toContain("Monitor(");

      // Turned on globally: the session hears about it on its next call.
      await setMode({ mode: "active" });
      await Bun.sleep(2500); // two heartbeats
      const on = await desk.call("set_summary", { summary: "e2e wake", peer_session: token });
      expect(on).toContain("now active");
      expect(on).toContain("Monitor(");
      const topic = on.match(/cp-wake-[0-9a-f]{24}/)![0];
      // Told once, not on every call.
      expect(await desk.call("set_summary", { summary: "e2e wake", peer_session: token })).not.toContain("Monitor(");

      // The agent goes quiet on its own: its Monitor gets "off", the global mode stays active.
      const off = await desk.call("set_wake", { mode: "passive", peer_session: token });
      expect(off).toContain("now passive");
      for (let i = 0; i < 50 && !relayHits.some((h) => h.path === `/${topic}` && h.body === "off"); i++)
        await Bun.sleep(20);
      expect(relayHits.filter((h) => h.path === `/${topic}`).map((h) => h.body)).toEqual(["off"]);
      await Bun.sleep(1500);
      expect(await desk.call("set_summary", { summary: "e2e wake", peer_session: token })).not.toContain("now ");
    } finally {
      desk.stop();
      await setMode({ mode: "active", clear_overrides: true });
    }
  }, 30_000);
});
