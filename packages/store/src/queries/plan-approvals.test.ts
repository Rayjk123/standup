import { expect, test, describe } from "bun:test";
import { createStore } from "../store.js";
import {
  approvePlan,
  createLaunch,
  createPlanApproval,
  getPlanApproval,
  PlanChangedError,
  planApprovalHash,
  submitPlan,
  upsertProject,
} from "../index.js";

function seeded() {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
  createLaunch(store.db, { id: "l1", projectId: "p", task: "t", worktreePath: "/w", branch: "b" });
  const gate = createPlanApproval(store.db, { launchId: "l1", projectId: "p", worktreePath: "/w" });
  return { db: store.db, gate };
}

describe("approvePlan compare-and-set", () => {
  test("approves when the stored plan still hashes to the expected value", () => {
    const { db, gate } = seeded();
    const submitted = submitPlan(db, gate.id, { relevantFiles: ["a.ts"], plan: "v1", acceptanceCriterion: "true" });
    const approved = approvePlan(db, gate.id, { expectedHash: planApprovalHash(submitted), approvedBy: "alice" });
    expect(approved.status).toBe("approved");
  });

  test("refuses when the plan was resubmitted after the hash was taken", () => {
    const { db, gate } = seeded();
    const v1 = submitPlan(db, gate.id, { relevantFiles: [], plan: "v1: edit a.ts" });
    const pinned = planApprovalHash(v1);
    submitPlan(db, gate.id, { relevantFiles: [], plan: "v2: rm -rf everything" });
    expect(() => approvePlan(db, gate.id, { expectedHash: pinned })).toThrow(PlanChangedError);
    expect(getPlanApproval(db, gate.id)!.status).toBe("awaiting_approval");
  });

  test("refuses a plan that is no longer awaiting approval", () => {
    const { db, gate } = seeded();
    const v1 = submitPlan(db, gate.id, { relevantFiles: [], plan: "v1" });
    approvePlan(db, gate.id, {});
    expect(() => approvePlan(db, gate.id, { expectedHash: planApprovalHash(v1) })).toThrow(PlanChangedError);
  });

  test("without an expected hash approval is unconditional", () => {
    const { db, gate } = seeded();
    submitPlan(db, gate.id, { relevantFiles: [], plan: "v1" });
    expect(approvePlan(db, gate.id, { plan: "edited" }).plan).toBe("edited");
  });
});
