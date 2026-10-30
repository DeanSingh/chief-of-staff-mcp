/**
 * The /watch WebSocket wake feed and `bun cli.ts watch`.
 */

import { test, expect, describe } from "bun:test";
import { PEER_HEADER, secretPath } from "../../src/shared/auth.ts";
import { ROOT, useBroker } from "./harness.ts";

const { PORT, HTTP, WS, DB, post, register, watchHeaders, connectWatch } = useBroker();

describe("/watch WebSocket feed", () => {
  test("pushes a wake frame on send-message without acking it", async () => {
    const finance = await register("Finance agent", "desktop");
    const cos = await register("Chief of staff", "cli");

    const w = await connectWatch(finance);
    expect(await w.next()).toEqual({ type: "watching", peer: finance });

    const send = await post<{ ok: boolean; woke: number }>("/send-message", {
      from_id: cos,
      to_id: finance,
      text: "pull Q3 burn",
    });
    expect(send).toMatchObject({ ok: true, woke: 1, target_type: "desktop" });

    // The frame is only a wake: no text, sender or id.
    expect(await w.next()).toEqual({ type: "wake" });

    // Wake is not delivery: message is still undelivered for check_messages.
    const peek = await post<{ messages: Array<{ text: string; delivered: number }> }>("/peek-messages", {
      id: finance,
    });
    expect(peek.messages).toHaveLength(1);
    expect(peek.messages[0]!.delivered).toBe(0);
    expect(peek.messages[0]!.text).toBe("pull Q3 burn");

    w.ws.close();
  });

  // An id is not a secret: it shows up in transcripts, peer messages and argv.
  // Knowing one must not be enough to subscribe to that peer's feed.
  async function upgrade(peerId: string, headers: Record<string, string>): Promise<number> {
    const res = await fetch(`${HTTP}/watch/${peerId}`, {
      headers: {
        ...headers,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    return res.status;
  }

  test("refuses an upgrade without the install secret", async () => {
    const victim = await register("victim", "cli");
    expect(await upgrade(victim, {})).toBe(401);
    expect(await upgrade(victim, { ...watchHeaders(victim), authorization: "Bearer wrong" })).toBe(401);
  });

  test("refuses an upgrade without the watched peer's own credential", async () => {
    const victim = await register("victim", "cli");
    const other = await register("other", "cli");
    const authorization = watchHeaders(victim).authorization!;
    expect(await upgrade(victim, { authorization })).toBe(403);
    // Another peer's valid credential doesn't open this peer's feed.
    expect(await upgrade(victim, { authorization, [PEER_HEADER]: watchHeaders(other)[PEER_HEADER]! })).toBe(403);
  });

  // `bun cli.ts watch` as a Monitor: a refusal must end it with the reason,
  // not loop silently reconnecting forever.
  function cliWatch(peerId: string, db: string) {
    return Bun.spawn(["bun", `${ROOT}/cli.ts`, "watch", peerId], {
      env: { ...process.env, CLAUDE_PEERS_PORT: String(PORT), CLAUDE_PEERS_DB: db },
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  test("cli watch exits with the reason when the broker refuses its credentials", async () => {
    const victim = await register("victim", "cli");
    const otherDb = `${DB}-other`;
    await Bun.write(secretPath(otherDb), "not-this-brokers-secret\n");
    try {
      const watch = cliWatch(victim, otherDb);
      const timer = setTimeout(() => watch.kill(), 3000);
      expect(await watch.exited).toBe(1);
      clearTimeout(timer);
      expect(await new Response(watch.stderr).text()).toContain("missing or wrong broker secret");
    } finally {
      await Bun.file(secretPath(otherDb)).delete();
    }
  }, 10_000);

  test("cli watch with the right credentials stays up and prints a wake line", async () => {
    const target = await register("watched", "cli");
    const sender = await register("sender", "cli");
    const watch = cliWatch(target, DB);
    try {
      await Bun.sleep(500); // preflight + subscribe
      expect(watch.exitCode).toBeNull();
      await post("/send-message", { from_id: sender, to_id: target, text: "hello" });
      const reader = (watch.stdout as ReadableStream<Uint8Array>).getReader();
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value)).toBe("[claude-peers] new peer message: call check_messages to read it\n");
    } finally {
      watch.kill();
    }
  });

  test("an uncredentialed watcher never sees message text", async () => {
    const victim = await register("victim", "cli");
    const sender = await register("sender", "cli");
    const frames: string[] = [];
    const ws = new WebSocket(`${WS}/watch/${victim}`);
    ws.onmessage = (ev) => frames.push(String(ev.data));
    ws.onerror = () => {};
    await Bun.sleep(200); // refused, or (if the gate were open) subscribed
    await post("/send-message", { from_id: sender, to_id: victim, text: "secret plans" });
    await Bun.sleep(100);
    ws.close();
    expect(frames.join("")).not.toContain("secret plans");
    expect(frames).toHaveLength(0);
  });

  test("woke=0 when nobody is watching; watcher gets nothing for other peers", async () => {
    const a = await register("A", "cli");
    const b = await register("B", "cli");
    const w = await connectWatch(a);
    await w.next(); // watching handshake

    const send = await post<{ ok: boolean; woke: number }>("/send-message", { from_id: a, to_id: b, text: "to b" });
    expect(send.woke).toBe(0);
    await Bun.sleep(100);
    expect(w.frames).toHaveLength(0);
    w.ws.close();
  });

  test("rejects browser upgrades (Origin header present)", async () => {
    const res = await fetch(`${HTTP}/watch/anyone`, {
      headers: {
        origin: "http://evil.example",
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    expect(res.status).toBe(403);
  });
});
