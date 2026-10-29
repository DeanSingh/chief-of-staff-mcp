import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { peerSecret, readSecret, secretPath, PEER_HEADER } from "./shared/auth.ts";

// Real MCP servers (one CLI, one Desktop) over stdio against a real broker on
// a private port: proves every route the servers use carries the install
// secret and the right peer credential once the broker enforces them.
const PORT = 7899 + 2000 + Math.floor(Math.random() * 500);
const HTTP = `http://127.0.0.1:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), "cp-e2e-"));
const DB = join(DIR, "peers.db");
const ENV = { ...process.env, CLAUDE_PEERS_PORT: String(PORT), CLAUDE_PEERS_DB: DB, CLAUDE_PEERS_LOG: join(DIR, "server.log") };

let broker: ReturnType<typeof Bun.spawn>;

class McpClient {
  proc: ReturnType<typeof Bun.spawn>;
  private buf = "";
  private nextId = 1;
  private waiting = new Map<number, (v: any) => void>();
  constructor(env: Record<string, string | undefined>) {
    const proc = Bun.spawn(["bun", `${import.meta.dir}/server.ts`], { env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    this.proc = proc;
    (async () => {
      const dec = new TextDecoder();
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        this.buf += dec.decode(chunk);
        let nl;
        while ((nl = this.buf.indexOf("\n")) >= 0) {
          const line = this.buf.slice(0, nl);
          this.buf = this.buf.slice(nl + 1);
          try {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && this.waiting.has(msg.id)) { this.waiting.get(msg.id)!(msg); this.waiting.delete(msg.id); }
          } catch { /* notification or noise */ }
        }
      }
    })();
  }
  private write(msg: unknown) {
    (this.proc.stdin as import("bun").FileSink).write(JSON.stringify(msg) + "\n");
    (this.proc.stdin as import("bun").FileSink).flush();
  }
  request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout: ${method}`)), 8000);
      this.waiting.set(id, (v) => { clearTimeout(t); resolve(v); });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }
  async init() {
    await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
    this.write({ jsonrpc: "2.0", method: "notifications/initialized" });
  }
  async call(name: string, args: Record<string, unknown>): Promise<string> {
    const r = await this.request("tools/call", { name, arguments: args });
    return (r.result?.content ?? []).map((c: { text: string }) => c.text).join("\n");
  }
  stop() { this.proc.kill(); }
}

// A third peer driven directly, the way the broker tests do.
async function asPeer(path: string, id: string, body: Record<string, unknown>) {
  const secret = readSecret(secretPath(DB))!;
  const res = await fetch(`${HTTP}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}`, [PEER_HEADER]: peerSecret(secret, id) },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<any>;
}

beforeAll(async () => {
  broker = Bun.spawn(["bun", `${import.meta.dir}/broker.ts`], { env: ENV, stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${HTTP}/health`)).ok) return; } catch {}
    await Bun.sleep(100);
  }
  throw new Error("broker did not start");
});

afterAll(() => {
  broker.kill();
  rmSync(DIR, { recursive: true, force: true });
});

describe("servers against a hardened broker", () => {
  test("cli and desktop servers register, send, receive and ack", async () => {
    const cli = new McpClient({ ...ENV, CLAUDE_PEERS_PEER_TYPE: "cli", CLAUDE_PEERS_NAME: "e2e cli", CLAUDE_CODE_SESSION_ID: `e2e-${PORT}` });
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

      expect(await desk.call("set_summary", { summary: "e2e desk summary", peer_session: token })).toContain("Summary updated");
      expect(await desk.call("send_message", { to_id: cliId, message: "desk to cli", peer_session: token })).toContain("Message sent");
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
});
