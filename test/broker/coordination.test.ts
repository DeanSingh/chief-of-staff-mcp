/**
 * Decision-queue storage: the events, input_requests and digest_cursors
 * tables and their retention sweep.
 */

import { Database } from "bun:sqlite";
import { test, expect, describe } from "bun:test";
import { useBroker } from "./harness.ts";

const { DB, restartBroker } = useBroker();

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

describe("coordination retention", () => {
  test("the sweep drops week-old events and settled requests, never pending ones", async () => {
    const db = new Database(DB);
    try {
      const addEvent = db.prepare("INSERT INTO events (message, created_at) VALUES (?, ?)");
      addEvent.run("old event", daysAgo(8));
      addEvent.run("recent event", daysAgo(1));

      const addRequest = db.prepare(
        "INSERT INTO input_requests (id, question, state, created_at, answered_at) VALUES (?, 'q', ?, ?, ?)",
      );
      addRequest.run("old-answered", "answered", daysAgo(9), daysAgo(8));
      addRequest.run("old-canceled", "canceled", daysAgo(9), daysAgo(8));
      addRequest.run("old-pending", "pending", daysAgo(8), null);
      addRequest.run("old-escalated", "escalated", daysAgo(8), null);

      db.run("INSERT INTO digest_cursors (peer_id, position, updated_at) VALUES ('p', 3, ?)", [daysAgo(60)]);
    } finally {
      db.close();
    }

    await restartBroker();

    const check = new Database(DB, { readonly: true });
    try {
      const events = check.query("SELECT message FROM events").all() as { message: string }[];
      expect(events.map((e) => e.message)).toEqual(["recent event"]);
      const requests = check.query("SELECT id FROM input_requests ORDER BY id").all() as { id: string }[];
      expect(requests.map((r) => r.id)).toEqual(["old-escalated", "old-pending"]);
      expect(check.query("SELECT peer_id FROM digest_cursors").all()).toHaveLength(1);
    } finally {
      check.close();
    }
  });
});
