import { expect, test, describe } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createStore } from "../store.js";
import {
  deletePlanReviewRemark,
  getPlanReviewRemark,
  listUndeliveredPlanReviewRemarks,
  markPlanReviewRemarkDelivered,
  setPlanReviewRemark,
} from "../index.js";

describe("plan review remarks", () => {
  test("a remark replaces the plan's earlier one undelivered, and stays once delivered", () => {
    const { db } = createStore(":memory:");
    setPlanReviewRemark(db, "plan-1", { feedback: "Split it." });
    expect(getPlanReviewRemark(db, "plan-1")).toEqual({ feedback: "Split it.", delivered: false });
    markPlanReviewRemarkDelivered(db, "plan-1");
    expect(getPlanReviewRemark(db, "plan-1")).toEqual({ feedback: "Split it.", delivered: true });
    setPlanReviewRemark(db, "plan-1", { note: "Keep the old API." });
    expect(getPlanReviewRemark(db, "plan-1")).toEqual({ note: "Keep the old API.", delivered: false });
    expect(listUndeliveredPlanReviewRemarks(db)).toEqual(["plan-1"]);
    deletePlanReviewRemark(db, "plan-1");
    expect(getPlanReviewRemark(db, "plan-1")).toBeNull();
  });

  test("a remark older than a day has expired", () => {
    const { db } = createStore(":memory:");
    setPlanReviewRemark(db, "plan-2", { note: "n" });
    db.run("UPDATE plan_review_remarks SET updated_at = datetime('now', '-2 days') WHERE plan_id = 'plan-2'");
    expect(getPlanReviewRemark(db, "plan-2")).toBeNull();
    expect(listUndeliveredPlanReviewRemarks(db)).toEqual([]);
  });

  test("survives reopening the database", () => {
    const dir = mkdtempSync(join(tmpdir(), "plan-remarks-"));
    const path = join(dir, "standup.db");
    const first = createStore(path);
    setPlanReviewRemark(first.db, "plan-3", { note: "carried across a restart" });
    first.close();
    const second = createStore(path);
    expect(getPlanReviewRemark(second.db, "plan-3")).toEqual({ note: "carried across a restart", delivered: false });
    second.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
