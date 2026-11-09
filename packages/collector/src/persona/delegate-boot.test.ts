import { describe, expect, test } from "bun:test";
import { createAsk, enqueuePersonaInbox, listPendingPersonaInbox } from "@standup/store";
import { harness, OWNER, until } from "./delegate-test-harness.js";

// Persona's start() runs before the collector listens, so its re-routing of
// held asks must not grow with pending holds times inbox size: on a
// long-lived install that kept /health from answering through a restart.
describe("Persona start with many pending floor holds and a large inbox", () => {
  test("re-routes the holds in one read of the inbox, well inside a restart's health wait", async () => {
    const h = harness({ STANDUP_PERSONA_DELEGATES: "0" }, { subscribe: false, start: false });
    try {
      const filler = "x".repeat(2_000);
      const asks: string[] = [];
      h.store.db.transaction(() => {
        for (let i = 0; i < 20_000; i++) {
          enqueuePersonaInbox(h.store.db, { owner: OWNER, kind: "worker_event", payload: { type: "note", n: i, filler } });
        }
        h.store.db.run("UPDATE persona_inbox SET status = 'done'");
        for (let i = 0; i < 400; i++) {
          asks.push(createAsk(h.store.db, h.sessionId, "ask_human", `Run this? step ${i}`, ["Allow once", "Deny"], { gate: "safety_floor" }).id);
        }
      })();
      // One hold the main Persona already has: an inbox item names it (upper-cased, as a payload may carry it).
      enqueuePersonaInbox(h.store.db, { owner: OWNER, kind: "worker_event", payload: { type: "ask", ask: { id: asks[0]!.toUpperCase() } } });
      h.store.db.run("UPDATE persona_inbox SET status = 'done'");

      const t0 = performance.now();
      h.runtime.start();
      const ms = performance.now() - t0;
      // Scanning the inbox once per hold took about 21 s here.
      expect(ms).toBeLessThan(3_000);

      const rerouted = listPendingPersonaInbox(h.store.db, OWNER, "worker_event").map((i) => i.coalesceKey);
      expect(rerouted).toHaveLength(asks.length - 1);
      expect(rerouted).not.toContain(`ask:${asks[0]}`);
      expect(rerouted).toContain(`ask:${asks[1]}`);
      // The tick start() kicked off works on the DB; let it finish before closing.
      await until(() => h.mainTurns.length > 0, "the main turn on the re-routed holds", 20_000);
      h.runtime.stop();
      await Bun.sleep(500);
    } finally {
      await h.close();
    }
  }, 60_000);
});
