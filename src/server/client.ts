/**
 * Talking to the broker: per-peer credentials, authenticated requests, and
 * launching the broker when it isn't running.
 */

import { authHeaders } from "../shared/auth.ts";
import type { PeerId, RegisterResponse } from "../shared/types.ts";
import { BROKER_SCRIPT, BROKER_URL } from "./config.ts";
import { log } from "./log.ts";

// --- Broker communication ---

/**
 * Each peer's broker credential, from its /register response. Routes that act
 * as a peer (send, poll, ack, heartbeat, set-summary) must carry it.
 */
const credentials = new Map<PeerId, string>();

export function remember(reg: RegisterResponse): RegisterResponse {
  if (reg.peer_secret) credentials.set(reg.id, reg.peer_secret);
  return reg;
}

/** A non-2xx broker response, keeping the status so callers need not parse the message. */
export class BrokerError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    body: string,
  ) {
    super(`Broker error (${path}): ${status} ${body}`);
    this.name = "BrokerError";
  }
}

/** The broker no longer has this peer: it was reaped and must register again. */
export function isNotFound(e: unknown): boolean {
  return e instanceof BrokerError && e.status === 404;
}

/** POST to the broker; `as` names the peer the call acts for. */
export async function brokerFetch<T>(path: string, body: unknown, as?: PeerId | null): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: authHeaders(as ? credentials.get(as) : undefined),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new BrokerError(path, res.status, await res.text());
  return res.json() as Promise<T>;
}

async function isBrokerAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function ensureBroker(): Promise<void> {
  if (await isBrokerAlive()) {
    log("Broker already running");
    return;
  }

  log("Starting broker daemon...");
  const proc = Bun.spawn(["bun", BROKER_SCRIPT], {
    stdio: ["ignore", "ignore", "inherit"],
    // Detach so the broker survives if this MCP server exits
    // On macOS/Linux, the broker will keep running
  });

  // Unref so this process can exit without waiting for the broker
  proc.unref();

  // Wait for it to come up
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await isBrokerAlive()) {
      log("Broker started");
      return;
    }
  }
  throw new Error("Failed to start broker daemon after 6 seconds");
}
