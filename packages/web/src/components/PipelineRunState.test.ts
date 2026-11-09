import { describe, expect, test } from "bun:test";
import type { PipelineRun, PipelineWorker } from "@standup/shared";
import { banner, canWaiveStage, ownerCanAct } from "./PipelineView";
import { splitRuns } from "./PipelineSection";
import { sampleRunNoUi, sampleRunUiChange } from "./pipeline-fixtures";

const coding = sampleRunUiChange.definition.stages.find((s) => s.id === "coding");

function run(id: string, worker?: PipelineWorker, status: PipelineRun["status"] = "active"): PipelineRun {
  return { ...sampleRunUiChange, id, launchId: `launch-${id}`, currentStage: "coding", status, ...(worker ? { worker } : {}) };
}

describe("banner", () => {
  test("a live worker's run is in progress", () => {
    expect(banner(run("a", { state: "live" }), coding).text).toBe("In progress · Coding");
  });

  test("a run read without its worker state keeps the run's own status", () => {
    expect(banner(run("a"), coding).text).toBe("In progress · Coding");
  });

  test("an ended worker's run reads ended at its stage, not in progress", () => {
    expect(banner(run("a", { state: "ended" }), coding).text).toStartWith("Ended at Coding");
  });

  test("a superseded launch's run reads superseded at its stage", () => {
    expect(banner(run("a", { state: "superseded" }), coding).text).toStartWith("Superseded at Coding");
  });

  test("a superseded run that was waiting doesn't claim to need the owner", () => {
    const waiting = { ...sampleRunUiChange, worker: { state: "superseded" } as PipelineWorker };
    expect(ownerCanAct(waiting)).toBe(false);
    expect(banner(waiting, undefined, ownerCanAct(waiting)).text).toStartWith("Superseded at code_review");
    expect(ownerCanAct({ ...sampleRunUiChange, worker: { state: "live" } })).toBe(true);
    // Its stage stays waivable, for a stage that holds up closing the job.
    const review = waiting.definition.stages.find((s) => s.id === "code_review")!;
    expect(canWaiveStage(waiting, review, "current")).toBe(true);
  });

  test("a complete run stays complete whatever its worker did", () => {
    expect(banner({ ...sampleRunNoUi, worker: { state: "ended" } }, undefined).text).toStartWith("Complete");
  });
});

describe("splitRuns", () => {
  test("a single run is the current one", () => {
    const only = run("a", { state: "ended" });
    expect(splitRuns([only])).toEqual({ current: [only], earlier: [] });
  });

  test("the live run is current and ended or superseded ones are earlier, in order", () => {
    const [a, b, c] = [run("a", { state: "superseded" }), run("b", { state: "ended" }), run("c", { state: "live" })];
    const split = splitRuns([a!, b!, c!]);
    expect(split.current.map((r) => r.id)).toEqual(["c"]);
    expect(split.earlier.map((r) => r.id)).toEqual(["a", "b"]);
  });

  test("with no live run the newest is current", () => {
    const split = splitRuns([run("a", { state: "superseded" }), run("b", { state: "ended" })]);
    expect(split.current.map((r) => r.id)).toEqual(["b"]);
    expect(split.earlier.map((r) => r.id)).toEqual(["a"]);
  });

  test("two live workers both stay current", () => {
    const split = splitRuns([run("a", { state: "live" }), run("b", { state: "live" })]);
    expect(split.current.map((r) => r.id)).toEqual(["a", "b"]);
    expect(split.earlier).toEqual([]);
  });

  test("no runs split to nothing", () => {
    expect(splitRuns([])).toEqual({ current: [], earlier: [] });
  });
});
