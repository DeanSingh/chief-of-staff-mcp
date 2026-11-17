/**
 * The chief of staff's tools: the decision queue's digest, answers,
 * escalations and the digest cursor. The server offers them only when it
 * serves the chief of staff; the broker checks the role on every call.
 */

import type { Digest, PeerType } from "../shared/types.ts";
import { brokerErrorText, brokerFetch } from "./client.ts";
import { deliveryStatus } from "./delivery.ts";
import type { ToolArgs, ToolHandler, ToolResult } from "./handlers.ts";

const text = (t: string): ToolResult => ({ content: [{ type: "text" as const, text: t }] });
const error = (t: string): ToolResult => ({ content: [{ type: "text" as const, text: t }], isError: true });

/** Runs one coordinator call as `peer`, turning a refusal into the broker's own words. */
async function asCos(
  what: string,
  peer: string | null,
  run: (peer: string) => Promise<ToolResult>,
): Promise<ToolResult> {
  if (!peer) return error("Not registered with broker yet");
  try {
    return await run(peer);
  } catch (e) {
    return error(`Could not ${what}: ${brokerErrorText(e)}`);
  }
}

const getDigest: ToolHandler = (args, peer) =>
  asCos("read the digest", peer, async (id) => {
    const { since_id, limit, min_level } = (args ?? {}) as Record<string, unknown>;
    const { ok: _ok, ...digest } = await brokerFetch<Digest>(
      "/get-digest",
      { peer_id: id, since_id, limit, min_level },
      id,
    );
    const { from, to } = digest.cursor;
    return text(
      `cursor ${from}→${to}; call ack_digest with ${to} once you have acted on it.\n\n${JSON.stringify(digest, null, 2)}`,
    );
  });

const answerRequest: ToolHandler = (args, peer) =>
  asCos("answer the request", peer, async (id) => {
    const { request_id, answer, answered_via } = (args ?? {}) as Record<string, unknown>;
    const r = await brokerFetch<{ woke: number; target_type: PeerType | null }>(
      "/answer-request",
      { request_id, answerer_id: id, answer, answered_via },
      id,
    );
    const nudge =
      !r.woke && r.target_type === "desktop"
        ? " If it doesn't pick it up, the human may need to nudge that session."
        : "";
    return text(`Answered request ${String(request_id)}; the answer was ${deliveryStatus(r)}.${nudge}`);
  });

const escalateRequest: ToolHandler = (args, peer) =>
  asCos("escalate the request", peer, async (id) => {
    const { request_id, note } = (args ?? {}) as Record<string, unknown>;
    await brokerFetch("/escalate-request", { request_id, peer_id: id, note }, id);
    return text(`Escalated request ${String(request_id)}: it now waits for the human.`);
  });

const ackDigest: ToolHandler = (args, peer) =>
  asCos("acknowledge the digest", peer, async (id) => {
    const { position } = (args ?? {}) as ToolArgs & { position?: unknown };
    const r = await brokerFetch<{ position: number }>("/ack-digest", { peer_id: id, position }, id);
    return text(`Acknowledged the digest up to ${r.position}.`);
  });

export const COORDINATOR_HANDLERS: Array<[string, ToolHandler]> = [
  ["get_digest", getDigest],
  ["answer_request", answerRequest],
  ["escalate_request", escalateRequest],
  ["ack_digest", ackDigest],
];
