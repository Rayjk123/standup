import { describe, expect, test } from "bun:test";
import type { PipelineRun } from "@standup/shared";
import {
  applyPipelineFrame,
  applyRunsRead,
  pipelineViewer,
  publishPipelineResync,
  setPipelineViewer,
  subscribePipelineResync,
} from "./pipelineUpdates";
import { sampleRunNoUi, sampleRunUiChange } from "../components/pipeline-fixtures";

const ids = new Set([sampleRunUiChange.launchId, sampleRunNoUi.launchId]);

describe("applyRunsRead", () => {
  const at = (run: PipelineRun, updatedAt: string, currentStage = run.currentStage): PipelineRun => ({ ...run, updatedAt, currentStage });

  test("the read's list wins: its runs, in its order, dropping ones it no longer lists", () => {
    const shown = [at(sampleRunNoUi, "2026-10-14T00:00:00Z")];
    const read = [at(sampleRunUiChange, "2026-10-14T00:00:00Z")];
    expect(applyRunsRead(shown, read)).toEqual(read);
  });

  test("a run a frame already moved past what the read saw keeps the frame's version", () => {
    const framed = at(sampleRunUiChange, "2026-10-14T00:00:05Z", "review");
    const stale = at(sampleRunUiChange, "2026-10-14T00:00:01Z", "validation");
    expect(applyRunsRead([framed], [stale])).toEqual([framed]);
  });

  test("a run a frame changed while the read was in flight keeps the frame's version, even at the same updatedAt (a park)", () => {
    const parked = { ...at(sampleRunUiChange, "2026-10-14T00:00:01Z"), parked: { reason: "waiting", by: "worker", actor: "w", at: "t" } } as PipelineRun;
    const stale = at(sampleRunUiChange, "2026-10-14T00:00:01Z");
    expect(applyRunsRead([parked], [stale], new Set([parked.id]))).toEqual([parked]);
    // Without the frame mark the read wins at an equal updatedAt.
    expect(applyRunsRead([parked], [stale])).toEqual([stale]);
  });

  test("a run a frame added while the read was in flight stays, though the read didn't list it", () => {
    const added = at(sampleRunNoUi, "2026-10-14T00:00:09Z");
    const read = [at(sampleRunUiChange, "2026-10-14T00:00:00Z")];
    expect(applyRunsRead([added], read, new Set([added.id]))).toEqual([...read, added]);
  });

  test("a read newer than what's shown replaces it", () => {
    const shown = at(sampleRunUiChange, "2026-10-14T00:00:01Z", "validation");
    const fresh = at(sampleRunUiChange, "2026-10-14T00:00:05Z", "review");
    expect(applyRunsRead([shown], [fresh])).toEqual([fresh]);
  });
});

describe("applyPipelineFrame", () => {
  test("replaces a run it already holds in place", () => {
    const moved: PipelineRun = { ...sampleRunUiChange, currentStage: "complete", status: "complete" };
    const next = applyPipelineFrame([sampleRunUiChange, sampleRunNoUi], moved, ids, null);
    expect(next).toEqual([moved, sampleRunNoUi]);
  });

  test("adds an unseen run only for a watched launch owned by the viewer", () => {
    const viewer = sampleRunNoUi.owner;
    expect(applyPipelineFrame([sampleRunUiChange], sampleRunNoUi, ids, viewer)).toEqual([sampleRunUiChange, sampleRunNoUi]);

    const runs = [sampleRunUiChange];
    expect(applyPipelineFrame(runs, { ...sampleRunNoUi, owner: "someone-else" }, ids, viewer)).toBe(runs);
    expect(applyPipelineFrame(runs, sampleRunNoUi, ids, null)).toBe(runs);
    expect(applyPipelineFrame(runs, { ...sampleRunNoUi, launchId: "launch-unwatched" }, ids, viewer)).toBe(runs);
  });
});

describe("pipeline resync and viewer", () => {
  test("resync reaches every subscriber until it unsubscribes", () => {
    let calls = 0;
    const off = subscribePipelineResync(() => calls++);
    publishPipelineResync();
    off();
    publishPipelineResync();
    expect(calls).toBe(1);
  });

  test("the viewer is the hello-ok identity; empty clears it", () => {
    setPipelineViewer("alice");
    expect(pipelineViewer()).toBe("alice");
    setPipelineViewer("");
    expect(pipelineViewer()).toBeNull();
  });
});
