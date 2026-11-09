import { describe, expect, test } from "bun:test";
import { createStore, getOrCreatePersonaThreadByRef, listPersonaSignals, recordPersonaSignal } from "@standup/store";
import type { PersonaSignalKind } from "@standup/store";
import { resolvePersonaConfig } from "./config.js";
import { HOLDABLE, READ_ACTIONS, decide } from "./policy.js";
import { PersonaRuntime } from "./runtime.js";

/*
 * list_signals: Persona's read-only view of the owner's preference signals
 * (persona_signals), for the weekly preference review.
 */

const OWNER = "alice";
const NOW = Date.parse("2026-10-18T22:00:00.000Z");
const ago = (hours: number) => new Date(NOW - hours * 60 * 60 * 1000).toISOString();

function harness() {
  const store = createStore(":memory:");
  const runtime = new PersonaRuntime({
    db: store.db,
    owner: OWNER,
    config: { ...resolvePersonaConfig({}), coalesceMs: 0 },
    broadcast: () => {},
    turnRunner: async () => ({ ok: true, text: "[silent]", sessionId: "sid-1", contextTokens: 10 }),
    now: () => new Date(NOW),
  });
  const tool = async (args: Record<string, unknown> = {}) => {
    const result = await runtime.tools.call("list_signals", args);
    const text = result.content.map((c) => c.text).join("");
    return { isError: !!result.isError, text };
  };
  const listed = async (args: Record<string, unknown> = {}) => {
    const res = await tool(args);
    expect(res.isError).toBe(false);
    return JSON.parse(res.text) as { since: string; kind?: string; next?: string; signals: Array<Record<string, unknown>> };
  };
  const signal = (kind: PersonaSignalKind, hoursAgo: number, owner = OWNER) =>
    recordPersonaSignal(store.db, { owner, kind, actor: "owner", subject: `s-${hoursAgo}`, value: { hoursAgo }, occurredAt: ago(hoursAgo) })!;
  return { store, runtime, tool, listed, signal };
}

const hoursOf = (signals: Array<Record<string, unknown>>) => signals.map((s) => (s.value as { hoursAgo: number }).hoursAgo);

describe("list_signals", () => {
  test("is a read that always acts and can't be held", () => {
    expect(READ_ACTIONS.has("list_signals")).toBe(true);
    expect(HOLDABLE.has("list_signals")).toBe(false);
    expect(decide("list_signals").rule).toBe("act");
    expect(decide("list_signals", {}, { hold: new Set(["list_signals"]) }).rule).toBe("act");
    const h = harness();
    expect(h.runtime.tools.list().some((t) => t.name === "list_signals")).toBe(true);
  });

  test("filters by since (default 7d) and kind, oldest first, only the owner's", async () => {
    const h = harness();
    h.signal("approval", 24 * 8);
    h.signal("approval", 48);
    h.signal("option_reply", 30);
    h.signal("approval", 2);
    h.signal("approval", 1, "someone-else");

    const cases: Array<[Record<string, unknown>, number[]]> = [
      [{}, [48, 30, 2]],
      [{ since: "2w" }, [192, 48, 30, 2]],
      [{ since: "36h" }, [30, 2]],
      [{ since: ago(48) }, [48, 30, 2]],
      [{ kind: "approval" }, [48, 2]],
      [{ kind: "option_reply", since: "24h" }, []],
    ];
    for (const [args, expected] of cases) {
      const out = await h.listed(args);
      expect([args, hoursOf(out.signals)]).toEqual([args, expected]);
    }

    const out = await h.listed({ kind: "approval" });
    expect(out.since).toBe(ago(24 * 7));
    expect(out.kind).toBe("approval");
    expect(out.signals[0]).toMatchObject({ kind: "approval", actor: "owner", subject: "s-48", audience: "private", occurredAt: ago(48) });
    expect(out.signals[0]).not.toHaveProperty("owner");
  });

  /** Every signal's hours, read page by page through `next`'s `after` cursor. */
  const pages = async (h: ReturnType<typeof harness>, args: Record<string, unknown>) => {
    const seen: number[][] = [];
    let after: string | undefined;
    for (let i = 0; i < 50; i++) {
      const page = await h.listed({ ...args, ...(after ? { after } : {}) });
      seen.push(hoursOf(page.signals));
      if (!page.next) return seen;
      after = /after (\S+)\.$/.exec(page.next)![1];
      expect(after).toBe(page.signals[page.signals.length - 1]!.id as string);
    }
    throw new Error("paging never ended");
  };

  test("limit caps the page and next names the cursor for the rest", async () => {
    const h = harness();
    for (const hours of [5, 4, 3, 2, 1]) h.signal("approval", hours);
    expect(await pages(h, { limit: 2 })).toEqual([[5, 4], [3, 2], [1]]);
    expect(await pages(h, { limit: 5 })).toEqual([[5, 4, 3, 2, 1]]);
    expect((await h.listed({ after: "no-such-signal" })).signals).toEqual([]);
  });

  test("the cursor pages past signals that share a time", async () => {
    const h = harness();
    for (let i = 0; i < 3; i++) {
      recordPersonaSignal(h.store.db, { owner: OWNER, kind: "approval", actor: "owner", value: { hoursAgo: i }, occurredAt: ago(1) });
    }
    expect(await pages(h, { limit: 2 })).toEqual([[0, 1], [2]]);
  });

  test("a busy week fits the result cap: the page stays valid JSON and carries its cursor", async () => {
    const h = harness();
    for (let i = 0; i < 400; i++) {
      recordPersonaSignal(h.store.db, {
        owner: OWNER,
        kind: "persona_action",
        actor: "system",
        subject: "launch_session",
        value: { hoursAgo: i, reason: "r".repeat(1000) },
        jobId: `job-${i}`,
        threadId: "thread-1",
        occurredAt: new Date(NOW - (400 - i) * 60_000).toISOString(),
      });
    }
    for (const limit of [undefined, 200]) {
      const res = await h.tool({ kind: "persona_action", ...(limit ? { limit } : {}) });
      expect(res.text.length).toBeLessThan(12_000);
      const page = JSON.parse(res.text) as { next?: string; signals: Array<{ value: { reason: string } }> };
      expect(page.next).toContain("after ");
      expect(page.signals.length).toBeGreaterThan(0);
      expect(page.signals[0]!.value.reason.length).toBeLessThanOrEqual(200);
    }
    const all = (await pages(h, { kind: "persona_action", limit: 200 })).flat();
    expect(all).toEqual(Array.from({ length: 400 }, (_, i) => i));
  });

  test("one oversized value is clipped to text, so the page stays valid JSON; next names the ISO since", async () => {
    const h = harness();
    const images = Array.from({ length: 50 }, (_, i) => `/tmp/${"p".repeat(300)}-${i}.png`);
    for (let i = 0; i < 2; i++) {
      recordPersonaSignal(h.store.db, {
        owner: OWNER,
        kind: "persona_action",
        actor: "system",
        subject: "write_doc",
        value: { target: { images } },
        occurredAt: ago(2 - i),
      });
    }
    const res = await h.tool({ kind: "persona_action", since: "7d", limit: 1 });
    expect(res.text.length).toBeLessThan(12_000);
    const page = JSON.parse(res.text) as { since: string; next?: string; signals: Array<{ value: Record<string, unknown> }> };
    expect(typeof page.signals[0]!.value.clipped).toBe("string");
    expect((page.signals[0]!.value.clipped as string).length).toBeLessThanOrEqual(2_000);
    expect(page.next).toContain(`since ${ago(24 * 7)},`);
  });

  test("leaves your own logged actions out unless asked for by kind", async () => {
    const h = harness();
    h.signal("persona_action", 3);
    h.signal("approval", 2);
    h.signal("option_reply", 1);
    expect(hoursOf((await h.listed()).signals)).toEqual([2, 1]);
    expect(hoursOf((await h.listed({ kind: "persona_action" })).signals)).toEqual([3]);
  });

  test("refuses bad arguments", async () => {
    const h = harness();
    for (const args of [{ kind: "bogus" }, { since: "yesterday" }, { limit: "many" }]) {
      expect([args, (await h.tool(args)).isError]).toEqual([args, true]);
    }
  });

  test("is refused outside a private thread", async () => {
    const h = harness();
    h.signal("approval", 1);
    for (const audience of ["shared", "external"] as const) {
      const thread = getOrCreatePersonaThreadByRef(h.store.db, OWNER, "slack", `C1:${audience}`, "#team", audience);
      (h.runtime as unknown as { turnThreadId?: string }).turnThreadId = thread.id;
      const res = await h.tool();
      expect([audience, res.isError]).toEqual([audience, true]);
      expect(res.text).toContain("list_signals works only in a private thread");
    }
  });

  test("leaves the signals as they were", async () => {
    const h = harness();
    h.signal("approval", 1);
    const before = listPersonaSignals(h.store.db, OWNER);
    await h.listed({ kind: "approval", since: "7d", limit: 10 });
    expect(listPersonaSignals(h.store.db, OWNER)).toEqual(before);
  });
});
