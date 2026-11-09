import { describe, expect, test } from "bun:test";
import { getPipelineRun } from "@standup/store";
import { EVIDENCE, advance, approveHumanReview, decideHumanReview, makeWorld, submitPacketAsWorker, writeTinyPng, type World } from "./test-world.js";

/*
 * The order a run takes its review packet in. The packet of a project that
 * requires a linked code review must link the review its code_review stage
 * records, so it can only be submitted after code_review: the run goes
 * screenshot → code_review → packet (human_review), and nothing on the way to
 * code_review may wait on that packet. A project with no review to cut
 * submits its packet whenever it likes.
 */

const REVIEW_URL = "https://review.example/reviews/R-123456";
const REVIEW_LINK = { kind: "code_review" as const, label: "R-123456", url: REVIEW_URL };
const runOf = (w: World) => getPipelineRun(w.store.db, w.run.id)!;

/** Drives a UI change's run to its screenshot stage. */
async function toScreenshot(w: World) {
  w.changed.files = ["packages/web/src/components/X.tsx"];
  await advance(w, "start");
  await advance(w, "coding", EVIDENCE.coding);
  await advance(w, "validation", EVIDENCE.validationPass);
  await advance(w, "review", EVIDENCE.reviewClean);
  await advance(w, "deploy", EVIDENCE.deploy);
  expect(runOf(w).currentStage).toBe("screenshot");
}

describe("a linked-review project's run reaches its packet through code_review", () => {
  test("screenshots pass without a packet the project can't submit yet, and the packet follows the review", async () => {
    const w = makeWorld({ persona: true });
    await toScreenshot(w);

    // Before code_review the packet is refused: it has no review to link yet.
    const early = await submitPacketAsWorker(w, { links: [REVIEW_LINK] });
    expect(early.status).toBe(409);
    expect(early.body.reason).toBe("review-stage-pending");

    // So the screenshot stage can't wait on it.
    const shot = await advance(w, "screenshot", { screenshots: [{ path: writeTinyPng(), caption: "the changed view" }] });
    expect(shot.body.error).toBeUndefined();
    expect(shot.status).toBe(200);
    expect(runOf(w).currentStage).toBe("code_review");

    const review = await advance(w, "code_review", { url: REVIEW_URL, issueId: "ISSUE-1" });
    expect(review.status).toBe(200);
    expect(runOf(w)).toMatchObject({ currentStage: "human_review", status: "active" });

    // The packet is accepted now, and only with the review the stage recorded.
    expect((await submitPacketAsWorker(w)).status).toBe(400);
    expect((await submitPacketAsWorker(w, { links: [REVIEW_LINK] })).status).toBe(200);

    expect((await approveHumanReview(w)).status).toBe(200);
    expect(runOf(w)).toMatchObject({ currentStage: "complete", status: "complete" });
  });

  test("a run with no UI to shoot moves from deploy into code_review without a packet too", async () => {
    const w = makeWorld({ persona: true });
    w.changed.files = ["packages/collector/src/x.ts"];
    await advance(w, "start");
    await advance(w, "coding", EVIDENCE.coding);
    await advance(w, "validation", EVIDENCE.validationPass);
    await advance(w, "review", EVIDENCE.reviewClean);
    const deploy = await advance(w, "deploy", EVIDENCE.deploy);
    expect(deploy.status).toBe(200);
    expect(runOf(w).currentStage).toBe("code_review");
  });

  test("a run sent back after its review waits on code_review again before a new packet is taken", async () => {
    const w = makeWorld({ persona: true });
    await toScreenshot(w);
    await advance(w, "screenshot", { screenshots: [{ path: writeTinyPng() }] });
    await advance(w, "code_review", { url: REVIEW_URL, issueId: "ISSUE-1" });
    expect((await submitPacketAsWorker(w, { links: [REVIEW_LINK] })).status).toBe(200);
    // The owner asks for changes: the run goes back to coding and round two
    // reaches code_review again without a packet, revising the same review there.
    expect((await decideHumanReview(w, "changes_requested")).status).toBe(200);
    expect(runOf(w).currentStage).toBe("coding");
    await advance(w, "coding", EVIDENCE.coding);
    await advance(w, "validation", EVIDENCE.validationPass);
    await advance(w, "review", EVIDENCE.reviewClean);
    await advance(w, "deploy", EVIDENCE.deploy);
    expect((await submitPacketAsWorker(w, { links: [REVIEW_LINK] })).body.reason).toBe("review-stage-pending");
    expect((await advance(w, "screenshot", { screenshots: [{ path: writeTinyPng() }] })).status).toBe(200);
    expect(runOf(w).currentStage).toBe("code_review");
  });
});

describe("a project with no code review to cut", () => {
  test("submits its packet before code_review, with no review link, and finishes on the owner's approval", async () => {
    // Pinned to the full preset (a plain git project's own is light, with no
    // deploy or code_review), so the code_review stage that can't apply is on the way.
    const w = makeWorld({ persona: true, reviewArtifact: null, override: { preset: "full" } });
    await toScreenshot(w);
    expect((await submitPacketAsWorker(w)).status).toBe(200);
    expect((await advance(w, "screenshot", { screenshots: [{ path: writeTinyPng() }] })).status).toBe(200);
    expect(runOf(w).currentStage).toBe("human_review");
    expect((await approveHumanReview(w)).status).toBe(200);
    expect(runOf(w)).toMatchObject({ currentStage: "complete", status: "complete" });
  });
});
