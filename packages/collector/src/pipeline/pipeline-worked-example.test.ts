import { expect, test } from "bun:test";
import { getPipelineRun, personaJobForLaunch } from "@standup/store";
import { EVIDENCE, advance, human, makeWorld, post, submitPacket, withIssueIdReviews, type World } from "./test-world.js";

/**
 * The default pipeline end to end, as a worker drives it: a failed
 * validation and a review with an open High each loop back to coding, the
 * screenshot stage is auto-skipped because nothing UI changed, and — for a
 * project whose review tool attaches the owner's issue id — a code review
 * reported without one is refused and hands the run (and its Persona job)
 * to the owner until the worker comes back with one. The step log is the
 * run's story, one line per advance.
 */
withIssueIdReviews();

function status(w: World): string {
  const run = getPipelineRun(w.store.db, w.run.id)!;
  return run.status === "waiting_user" ? `[waiting_user/${run.waitingKind}: ${run.waitingReason}]` : `[${run.status}]`;
}

function line(w: World, stage: string, res: { status: number; body: Record<string, any> }): string {
  if (res.status !== 200) return `${stage}: refused ${res.status} — ${res.body.error} ${status(w)}`;
  const run = getPipelineRun(w.store.db, w.run.id)!;
  const attempt = run.attempts.filter((a) => a.stageId === stage).length;
  const skipped = (res.body.skipped as Array<{ stageId: string; reason: string }>).map((s) => ` (skipped ${s.stageId}: ${s.reason})`).join("");
  return `${stage} #${attempt} ${res.body.outcome} → ${res.body.to}${skipped} ${status(w)}`;
}

test("worked example: start → … → complete with two rework loops, an auto-skip and the issue-id hand-off", async () => {
  const w = makeWorld({ persona: true });
  w.changed.files = ["packages/collector/src/pipeline/engine.ts", "packages/store/src/queries/pipeline.ts"];
  const log: string[] = [];
  const step = async (stage: string, evidence?: unknown) => log.push(line(w, stage, await advance(w, stage, evidence)));
  const jobLine = () => {
    const job = personaJobForLaunch(w.store.db, w.launch.id)!.job;
    log.push(`persona job: ${job.status} — ${job.note ?? ""}`);
  };

  await step("start");
  await step("coding", EVIDENCE.coding);
  await step("validation", EVIDENCE.validationFail);
  await step("coding", { summary: "fixed the two failing tests" });
  await step("validation", EVIDENCE.validationPass);
  await step("review", EVIDENCE.reviewHigh);
  await step("coding", { summary: "made the retry idempotent" });
  await step("validation", EVIDENCE.validationPass);
  await step("review", EVIDENCE.reviewClean);
  // Reaching code_review is part of the review: the packet the owner decides is in their Review tab first.
  const packetId = submitPacket(w);
  await step("deploy", EVIDENCE.deploy);
  await step("code_review", { url: "https://git.example.com/acme/app/pull/1234" });
  jobLine();
  await step("code_review", { url: "https://git.example.com/acme/app/pull/1234", issueId: "ISSUE-42" });
  jobLine();
  const res = await post(w, `/api/reviews/${packetId}/approve`, {}, human(w));
  const decided = (await res.json()) as Record<string, any>;
  log.push(`owner approved review → ${getPipelineRun(w.store.db, w.run.id)!.currentStage} ${status(w)}`);
  expect(decided.pipeline).toMatchObject({ runId: w.run.id, ok: true });

  expect(log).toEqual([
    "start #1 passed → coding [active]",
    "coding #1 passed → validation [active]",
    "validation #1 failed → coding [active]",
    "coding #2 passed → validation [active]",
    "validation #2 passed → review [active]",
    "review #1 failed → coding [active]",
    "coding #3 passed → validation [active]",
    "validation #3 passed → review [active]",
    "review #2 passed → deploy [active]",
    "deploy #1 passed → code_review (skipped screenshot: auto-skipped: ui_changed is false) [active]",
    "code_review: refused 422 — The code_review stage needs the owner's issue id. The owner has been asked for it; ask_human for it too, then advance again with it. [waiting_user/owner_input: code review stage needs an issue id — Persona asks the owner for it]",
    "persona job: active — Persona deciding: code review stage needs an issue id — Persona asks the owner for it",
    "code_review #1 passed → human_review [active]",
    "persona job: active — Pipeline moved on: Human review",
    "owner approved review → complete [complete]",
  ]);

  const run = getPipelineRun(w.store.db, w.run.id)!;
  expect(run.status).toBe("complete");
  expect(run.flaggedJob).toBeUndefined();
  const attempts = (id: string) => run.attempts.filter((a) => a.stageId === id).map((a) => a.status);
  expect(attempts("start")).toEqual(["passed"]);
  expect(attempts("coding")).toEqual(["passed", "passed", "passed"]);
  expect(attempts("validation")).toEqual(["failed", "passed", "passed"]);
  expect(attempts("review")).toEqual(["failed", "passed"]);
  expect(attempts("deploy")).toEqual(["passed"]);
  expect(attempts("screenshot")).toEqual(["skipped"]);
  expect(attempts("code_review")).toEqual(["passed"]);
  expect(attempts("human_review")).toEqual(["passed"]);
  expect(run.facts).toEqual({ ui_changed: false, docs_only: false });
  // Each committed advance left a structural checkpoint on the worker's session.
  expect(w.checkpoints.filter((c) => c.startsWith("Pipeline: "))).toHaveLength(12);
});
