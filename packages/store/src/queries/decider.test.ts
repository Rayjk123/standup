import { describe, expect, test } from "bun:test";
import { createStore } from "../store.js";
import {
  getGlobalDeciderPrefs,
  getUserDeciderPrefs,
  listDeciderDecisions,
  putGlobalDeciderPrefs,
  putUserDeciderPrefs,
  recordDeciderDecision,
  sanitizeDeciderPrefs,
} from "./decider.js";
import { setSetting } from "./settings.js";

const base = {
  kind: "project" as const,
  backend: "claude" as const,
  routedTo: "claude" as const,
  choice: "standup",
  confidence: 0.71,
  latencyMs: 92.4,
  fallbackReason: null,
  detail: null,
  alias: "ana",
  sessionId: null,
  launchId: "L1",
};

describe("decider prefs", () => {
  test("sanitize keeps known kinds mapped to known backends only", () => {
    expect(sanitizeDeciderPrefs({ project: "claude", turn_end: "claude", effort: "gpt", model: "other-backend", other: "claude" })).toEqual({
      project: "claude",
      turn_end: "claude",
    });
    expect(sanitizeDeciderPrefs(null)).toEqual({});
    expect(sanitizeDeciderPrefs(["claude"])).toEqual({});
  });

  test("a user's layer round-trips and a PUT replaces it", () => {
    const { db } = createStore(":memory:");
    expect(getUserDeciderPrefs(db, "ana")).toEqual({ alias: "ana", backends: {} });
    putUserDeciderPrefs(db, "ana", { project: "claude", model: "claude" });
    putUserDeciderPrefs(db, "ana", { effort: "claude" });
    expect(getUserDeciderPrefs(db, "ana").backends).toEqual({ effort: "claude" });
    expect(getUserDeciderPrefs(db, "bo").backends).toEqual({});
  });

  test("the global layer round-trips, and a corrupt blob reads as empty", () => {
    const { db } = createStore(":memory:");
    putGlobalDeciderPrefs(db, { project: "claude" });
    expect(getGlobalDeciderPrefs(db)).toEqual({ project: "claude" });
    setSetting(db, "decider_backends", "{not json");
    expect(getGlobalDeciderPrefs(db)).toEqual({});
  });

  test("a stored backend this build doesn't know is dropped on read", () => {
    const { db } = createStore(":memory:");
    setSetting(db, "decider_backends", JSON.stringify({ project: "retired-backend", turn_end: "claude" }));
    expect(getGlobalDeciderPrefs(db)).toEqual({ turn_end: "claude" });
  });
});

describe("decider decisions", () => {
  test("records round-trip, newest first, filtered by alias and kind", () => {
    const { db } = createStore(":memory:");
    recordDeciderDecision(db, base);
    recordDeciderDecision(db, { ...base, alias: "bo" });
    const last = recordDeciderDecision(db, { ...base, kind: "turn_end", alias: "ana" });
    const ana = listDeciderDecisions(db, { alias: "ana" });
    expect(ana.map((d) => d.id)[0]).toBe(last.id);
    expect(ana).toHaveLength(2);
    expect(listDeciderDecisions(db, { kind: "turn_end" })).toHaveLength(1);
    expect(listDeciderDecisions(db)).toHaveLength(3);
    expect(listDeciderDecisions(db, { limit: 1 })).toHaveLength(1);
    const row = listDeciderDecisions(db, { alias: "bo" })[0];
    expect(row).toMatchObject({ latencyMs: 92, confidence: 0.71, launchId: "L1", backend: "claude", routedTo: "claude" });
  });

  test("a log table carrying extra nullable columns from an earlier build still records and reads", () => {
    const { db } = createStore(":memory:");
    db.exec("ALTER TABLE decider_decisions ADD COLUMN extra_latency_ms INTEGER");
    db.exec("ALTER TABLE decider_decisions ADD COLUMN extra_choice TEXT");
    const recorded = recordDeciderDecision(db, base);
    const [row] = listDeciderDecisions(db);
    expect(row.id).toBe(recorded.id);
    expect(Object.keys(row).sort()).toEqual(Object.keys(recorded).sort());
  });
});
