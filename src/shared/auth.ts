/**
 * Broker authentication, shared by the broker and its clients.
 *
 * The broker listens on loopback with no other access control, so any web
 * page Dean opens could reach it with a simple cross-site POST, and any
 * caller could act as any peer. Two layers fix that:
 *
 * - An install secret: 256 random bits in a 0600 file beside the DB, created
 *   by the broker on first start and sent as a bearer token on every POST.
 *   It shuts out browsers and other OS users. It cannot shut out processes
 *   running as Dean, which can read the file (and the DB itself).
 * - A per-peer credential, handed out by /register: HMAC(install secret, peer
 *   id). Routes that act as a peer (send, poll, ack, ...) require the
 *   credential for that id, so a caller can only send as the peer it
 *   registered. Derived rather than stored so every MCP server process
 *   serving one session gets the same credential and it survives restarts.
 */

import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { createHmac, timingSafeEqual } from "node:crypto";

/** Header carrying the per-peer credential. */
export const PEER_HEADER = "x-claude-peers-peer-secret";

export function dbPath(): string {
  return process.env.CLAUDE_PEERS_DB ?? `${process.env.HOME}/.claude-peers.db`;
}

export function secretPath(db = dbPath()): string {
  return `${db}.secret`;
}

/** The install secret, or null when the broker hasn't created it yet. */
export function readSecret(path = secretPath()): string | null {
  try {
    return readFileSync(path, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** Broker side: read the install secret, creating it 0600 on first start. */
export function ensureSecret(path: string): string {
  try {
    const hex = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
    // wx: never overwrite a secret another broker start already wrote.
    writeFileSync(path, `${hex}\n`, { mode: 0o600, flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  chmodSync(path, 0o600);
  const secret = readSecret(path);
  if (!secret) throw new Error(`empty broker secret at ${path}`);
  return secret;
}

export function peerSecret(secret: string, peerId: string): string {
  return createHmac("sha256", secret).update(`peer:${peerId}`).digest("hex");
}

export function secretsEqual(a: string | null | undefined, b: string): boolean {
  if (!a) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Headers for a broker POST, optionally acting as the peer `credential` belongs to. */
export function authHeaders(credential?: string): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  const secret = readSecret();
  if (secret) h.authorization = `Bearer ${secret}`;
  if (credential) h[PEER_HEADER] = credential;
  return h;
}
