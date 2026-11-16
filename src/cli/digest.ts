/**
 * `digest`: the operator's view of the decision queue. It reads the digest
 * with the install secret alone, so it never reads or moves a peer's cursor;
 * `--since` is how a reader resumes. Questions and messages are text agents
 * and hooks wrote: shown for a person to weigh, never to obey.
 */

import type { Digest, DigestEvent, DigestRequest } from "../shared/types.ts";
import { brokerFetch } from "./client.ts";

const USAGE = "Usage: bun cli.ts digest [--since <event id>] [--limit <n>] [--level <level>] [--json]";

/** "--since 5 --json" → { since: "5", json: true }; a flag missing its value is an error. */
function parseArgs(args: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === "--json") out.json = true;
    else if (["--since", "--limit", "--level"].includes(flag) && args[i + 1] !== undefined)
      out[flag.slice(2)] = args[++i]!;
    else throw new Error(USAGE);
  }
  return out;
}

/** A whole number, or the string itself so the broker's validation names the bad value. */
const num = (v: string | true | undefined) => (typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v);

function age(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** C0, DEL and C1 control characters: ESC, BEL and CSI could move the cursor, rewrite lines or set the title. */
const isControl = (c: string) => {
  const n = c.charCodeAt(0);
  return n <= 0x1f || (n >= 0x7f && n <= 0x9f);
};

/** One line of agent-written text, safe for a terminal: whitespace runs become one space, control characters are dropped. */
const oneLine = (text: string) =>
  [...text.replace(/\s+/g, " ")]
    .filter((c) => !isControl(c))
    .join("")
    .trim();

const who = (peer_id: string | null) => peer_id ?? "-";

function requests(title: string, rows: DigestRequest[]): string[] {
  return [
    `${title} (${rows.length})`,
    ...rows.map((r) => `  ${age(r.created_at).padStart(4)}  ${who(r.peer_id).padEnd(8)}  ${oneLine(r.question)}`),
  ];
}

function events(from: number, rows: DigestEvent[]): string[] {
  return [
    `Events since ${from}`,
    ...rows.map(
      (e) => `  ${String(e.id).padStart(6)}  ${e.level.padEnd(9)}  ${who(e.peer_id).padEnd(8)}  ${oneLine(e.message)}`,
    ),
  ];
}

export async function digest(): Promise<void> {
  try {
    const args = parseArgs(process.argv.slice(3));
    const body: Record<string, unknown> = {};
    if (args.since !== undefined) body.since_id = num(args.since);
    if (args.limit !== undefined) body.limit = num(args.limit);
    if (args.level !== undefined) body.min_level = args.level;
    const d = await brokerFetch<Digest>("/get-digest", body);
    if (args.json) {
      console.log(JSON.stringify(d, null, 2));
      return;
    }
    const { from, to, truncated } = d.cursor;
    console.log(
      [
        ...requests("Waiting on you", d.pending),
        "",
        ...requests("Escalated", d.escalated),
        "",
        ...events(from, d.events),
        "",
        `next: --since ${to}${truncated ? "  (more events after this page)" : ""}`,
      ].join("\n"),
    );
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
