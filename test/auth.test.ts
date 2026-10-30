import { test, expect, describe, afterAll } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSecret, peerSecret, authHeaders, secretPath, PEER_HEADER } from "../src/shared/auth.ts";

const DIR = mkdtempSync(join(tmpdir(), "cp-auth-"));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const mode = (p: string) => statSync(p).mode & 0o777;

describe("broker secret", () => {
  test("lives beside the DB", () => {
    expect(secretPath("/x/y/.claude-peers.db")).toBe("/x/y/.claude-peers.db.secret");
  });

  test("is created 0600 with 256 bits of hex, and reused after", () => {
    const p = join(DIR, "a.secret");
    const s = ensureSecret(p);
    expect(s).toMatch(/^[0-9a-f]{64}$/);
    expect(mode(p)).toBe(0o600);
    expect(ensureSecret(p)).toBe(s);
  });

  test("an existing world-readable file is tightened to 0600", () => {
    const p = join(DIR, "b.secret");
    writeFileSync(p, "f".repeat(64));
    chmodSync(p, 0o644);
    expect(ensureSecret(p)).toBe("f".repeat(64));
    expect(mode(p)).toBe(0o600);
  });

  test("peer credentials are per id and per install", () => {
    expect(peerSecret("s1", "abc")).toBe(peerSecret("s1", "abc"));
    expect(peerSecret("s1", "abc")).not.toBe(peerSecret("s1", "abd"));
    expect(peerSecret("s1", "abc")).not.toBe(peerSecret("s2", "abc"));
  });

  test("authHeaders reads the install secret at call time and adds the peer credential", () => {
    const db = join(DIR, "c.db");
    const prev = process.env.CLAUDE_PEERS_DB;
    process.env.CLAUDE_PEERS_DB = db;
    try {
      expect(authHeaders().authorization).toBeUndefined();
      const s = ensureSecret(secretPath(db));
      const h = authHeaders("peer-cred");
      expect(h["content-type"]).toBe("application/json");
      expect(h.authorization).toBe(`Bearer ${s}`);
      expect(h[PEER_HEADER]).toBe("peer-cred");
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_PEERS_DB;
      else process.env.CLAUDE_PEERS_DB = prev;
    }
  });
});
