import { expect, test, describe } from "bun:test";
import { createStore } from "../store.js";
import {
  createKnowledgeResolution,
  getKnowledgeResolutions,
  getPendingResolutions,
  getKnowledgeResolution,
  markResolutionApplied,
  updateResolutionWinnerLoser,
  deleteKnowledgeResolution,
} from "./knowledge-resolutions.js";

function setup() {
  return createStore(":memory:");
}

/** A resolution record fixture; override what a case cares about. */
function record(over: Partial<Parameters<typeof createKnowledgeResolution>[1]> = {}) {
  return {
    id: "r1",
    projectId: "p",
    winnerSlug: "keep",
    loserSlug: "drop",
    type: "supersede" as const,
    status: "applied" as const,
    autoApplied: true,
    rationale: "drop is outdated",
    ...over,
  };
}

describe("knowledge_resolutions ledger", () => {
  test("persists and reads back a resolution", () => {
    const store = setup();
    createKnowledgeResolution(store.db, record({ detail: JSON.stringify({ reason: "x" }) }));
    const rows = getKnowledgeResolutions(store.db, "p");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.winnerSlug).toBe("keep");
    expect(rows[0]!.loserSlug).toBe("drop");
    expect(rows[0]!.autoApplied).toBe(true);
    expect(rows[0]!.detail).toContain("reason");
  });

  test("INSERT OR IGNORE dedups a redelivered stable id — the ledger can't grow unbounded for one pair", () => {
    const store = setup();
    // The resolver keys the id on the unordered pair, so a retry / both-directions
    // race re-inserts the SAME id and must not stack a second row.
    createKnowledgeResolution(store.db, record({ id: "pair-key" }));
    createKnowledgeResolution(store.db, record({ id: "pair-key", rationale: "second attempt" }));
    const rows = getKnowledgeResolutions(store.db, "p");
    expect(rows).toHaveLength(1);
    // First write wins (IGNORE, not REPLACE).
    expect(rows[0]!.rationale).toBe("drop is outdated");
  });

  test("getPendingResolutions returns only needs_review rows", () => {
    const store = setup();
    createKnowledgeResolution(store.db, record({ id: "a", status: "applied", autoApplied: true }));
    createKnowledgeResolution(
      store.db,
      record({ id: "b", status: "needs_review", autoApplied: false })
    );
    const pending = getPendingResolutions(store.db, "p");
    expect(pending.map((r) => r.id)).toEqual(["b"]);
  });

  test("getKnowledgeResolution fetches one by id", () => {
    const store = setup();
    createKnowledgeResolution(store.db, record({ id: "only" }));
    expect(getKnowledgeResolution(store.db, "only")?.loserSlug).toBe("drop");
    expect(getKnowledgeResolution(store.db, "missing")).toBeNull();
  });

  test("markResolutionApplied flips a needs_review row to applied, and only then", () => {
    const store = setup();
    createKnowledgeResolution(
      store.db,
      record({ id: "pend", status: "needs_review", autoApplied: false })
    );
    markResolutionApplied(store.db, "pend");
    const row = getKnowledgeResolution(store.db, "pend")!;
    expect(row.status).toBe("applied");
    // auto_applied stays false — a human, not the gate, released it.
    expect(row.autoApplied).toBe(false);
    expect(getPendingResolutions(store.db, "p")).toHaveLength(0);
  });

  test("updateResolutionWinnerLoser flips the recorded winner/loser (the swap action)", () => {
    const store = setup();
    createKnowledgeResolution(
      store.db,
      record({ id: "swp", status: "needs_review", autoApplied: false })
    );
    updateResolutionWinnerLoser(store.db, "swp", "drop", "keep");
    const row = getKnowledgeResolution(store.db, "swp")!;
    expect(row.winnerSlug).toBe("drop");
    expect(row.loserSlug).toBe("keep");
  });

  test("deleteKnowledgeResolution voids a row (the reject action)", () => {
    const store = setup();
    createKnowledgeResolution(
      store.db,
      record({ id: "rej", status: "needs_review", autoApplied: false })
    );
    deleteKnowledgeResolution(store.db, "rej");
    expect(getKnowledgeResolution(store.db, "rej")).toBeNull();
    expect(getPendingResolutions(store.db, "p")).toHaveLength(0);
  });
});
