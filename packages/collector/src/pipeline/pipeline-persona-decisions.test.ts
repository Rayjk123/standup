import { describe, expect, test } from "bun:test";
import { deletePipelineConfig, getPersonaJob, getPipelineRun, listPipelineDecisions, personaJobForLaunch } from "@standup/store";
import { pipelineWaivers, waiverLabel } from "@standup/shared";
import type { PipelineBlockedPayload } from "@standup/shared";
import { decidePipelineStage, markRunWaiting, pipelineReadyBlock, runRequiresCodeReview, currentPipelineConfig, type PersonaDecisionKind } from "./engine.js";
import { EVIDENCE, OWNER, advance, makeWorld, submitPacket, type World } from "./test-world.js";

/*
 * Persona's decisions on a blocked run — skip, waive, close out, escalate —
 * each recorded on the run as Persona's and in the owner's audit; and a block
 * going to Persona (its job active, a pipeline:blocked frame) rather than to
 * the owner.
 */

const ACTOR = `${OWNER}'s Persona`;
const WAIVE_REASON = "flaky suite on the shared runner; the owner accepted the risk for this change";
const runOf = (w: World) => getPipelineRun(w.store.db, w.run.id)!;
const jobOf = (w: World) => personaJobForLaunch(w.store.db, w.launch.id)!.job;
const decide = (w: World, stage: string, kind: PersonaDecisionKind, reason: string) =>
  decidePipelineStage(w.store.db, w.run.id, { stage, kind, reason, actor: ACTOR }, w.deps);

async function toValidation(w: World) {
  await advance(w, "start");
  await advance(w, "coding", EVIDENCE.coding);
  expect(runOf(w).currentStage).toBe("validation");
}

describe("each decision is recorded as Persona's", () => {
  test("waive: recorded waived (not passed, not not-applicable), the run moves on, and the audit has it", async () => {
    const w = makeWorld({ persona: true });
    await toValidation(w);
    const res = await decide(w, "validation", "waive", WAIVE_REASON);
    expect(res.ok && res.to).toBe("review");
    const attempt = runOf(w).attempts.filter((a) => a.stageId === "validation").at(-1)!;
    expect(attempt.status).toBe("waived");
    expect(attempt.evidence).toEqual({ waiver: { by: "persona", actor: ACTOR, reason: WAIVE_REASON, notApplicable: false, kind: "waive" } });
    const [waiver] = pipelineWaivers(runOf(w));
    expect(waiver).toMatchObject({ stageId: "validation", by: "persona", kind: "waive", notApplicable: false });
    expect(waiverLabel(waiver!)).toBe("waived by Persona");
    expect(listPipelineDecisions(w.store.db, OWNER, { runId: w.run.id })).toEqual([
      expect.objectContaining({ kind: "waive", stage: "validation", reason: WAIVE_REASON, actor: ACTOR, jobId: jobOf(w).id, projectId: "proj" }),
    ]);
  });

  test("waive needs a reason of at least 40 characters; skip and escalate at least 10", async () => {
    const w = makeWorld({ persona: true });
    await toValidation(w);
    expect(await decide(w, "validation", "waive", "flaky tests")).toMatchObject({ ok: false, status: 422 });
    expect(await decide(w, "validation", "escalate", "short")).toMatchObject({ ok: false, status: 422 });
    expect(await decide(w, "review", "escalate", "the owner should look at this")).toMatchObject({ ok: false, status: 409 });
    expect(listPipelineDecisions(w.store.db, OWNER)).toEqual([]);
  });

  test("skip: validation of a code change can't be skipped — only reported, waived or escalated", async () => {
    const w = makeWorld({ persona: true });
    await toValidation(w);
    const res = await decide(w, "validation", "skip", "tests are not needed here");
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toContain("report evidence, waive it with a reason, or escalate");
    expect(runOf(w).currentStage).toBe("validation");
  });

  test("skip: a light run's live check is skipped with the decision as its evidence", async () => {
    const w = makeWorld({ persona: true, reviewArtifact: null });
    await toValidation(w);
    await advance(w, "validation", EVIDENCE.validationPass);
    await advance(w, "review", EVIDENCE.reviewClean);
    expect(runOf(w).currentStage).toBe("live_check");
    const res = await decide(w, "live_check", "skip", "a pure refactor with no behavior to check live");
    expect(res.ok && res.to).toBe("human_review");
    const attempt = runOf(w).attempts.find((a) => a.stageId === "live_check")!;
    expect(attempt).toMatchObject({ status: "skipped" });
    expect(attempt.evidence).toMatchObject({ decision: { by: "persona", actor: ACTOR, kind: "skip" } });
    expect(listPipelineDecisions(w.store.db, OWNER).map((d) => d.kind)).toEqual(["skip"]);
  });

  test("escalate: the job waits on the owner with Persona's reason, until the run moves on", async () => {
    const w = makeWorld({ persona: true });
    await toValidation(w);
    markRunWaiting(w.store.db, runOf(w), "loop validation → coding used 4/4", "exhausted", w.deps);
    expect(jobOf(w).status).toBe("active");
    const res = await decide(w, "validation", "escalate", "four rounds failed the same way; the owner should decide");
    expect(res.ok).toBe(true);
    expect(getPersonaJob(w.store.db, jobOf(w).id)).toMatchObject({
      status: "waiting_user",
      note: "Persona escalated: four rounds failed the same way; the owner should decide",
    });
    expect(listPipelineDecisions(w.store.db, OWNER).map((d) => d.kind)).toEqual(["escalate"]);
    // A waiver moving the run on makes the job active again.
    const waived = await decide(w, "validation", "waive", WAIVE_REASON);
    expect(waived.ok).toBe(true);
    expect(jobOf(w)).toMatchObject({ status: "active", note: "Pipeline moved on: Adversarial review" });
  });

  test("escalate needs a Persona job to hand the run to", async () => {
    const w = makeWorld();
    await toValidation(w);
    const res = await decide(w, "validation", "escalate", "the owner should decide this one");
    expect(res).toMatchObject({ ok: false, status: 409 });
  });
});

describe("close out", () => {
  /**
   * A legacy run of a light project: started with the full pipeline frozen,
   * stuck at code_review waiting on the owner's issue id in the old wording — then the
   * pin is removed, so the project's pipeline is the light one.
   */
  async function legacyStuckAtCodeReview(): Promise<World> {
    const w = makeWorld({ persona: true, reviewArtifact: null, override: { preset: "full" } });
    expect(runOf(w).preset).toBe("full");
    await toValidation(w);
    await advance(w, "validation", EVIDENCE.validationPass);
    await advance(w, "review", EVIDENCE.reviewClean);
    submitPacket(w);
    await advance(w, "deploy", EVIDENCE.deploy);
    w.store.db.run("UPDATE pipeline_runs SET current_stage = 'code_review', status = 'active' WHERE id = ?", [w.run.id]);
    const waiting = markRunWaiting(w.store.db, runOf(w), "code review stage needs an issue id from you — the worker should ask_human for it", "owner_input", w.deps);
    expect(waiting?.currentStage).toBe("code_review");
    deletePipelineConfig(w.store.db, OWNER, null);
    expect(currentPipelineConfig(w.store.db, runOf(w)).preset).toBe("light");
    expect(runRequiresCodeReview(w.store.db, runOf(w))).toBe(false);
    return w;
  }

  test("a legacy light-project run stuck at code_review closes code_review out and lands on human review", async () => {
    const w = await legacyStuckAtCodeReview();
    const reason = "this project has no code review to cut; the review packet is the owner's review";
    const res = await decide(w, "code_review", "close_out", reason);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.closedOut).toEqual(["code_review"]);
    expect(res.to).toBe("human_review");
    const run = runOf(w);
    expect(run).toMatchObject({ currentStage: "human_review", status: "active" });
    expect(run.waitingReason).toBeUndefined();
    const stage = run.attempts.filter((a) => a.stageId === "code_review").at(-1)!;
    expect(stage.status).toBe("waived");
    expect(stage.evidence).toEqual({
      waiver: { by: "persona", actor: ACTOR, reason: `${reason} — not in the project's light pipeline`, notApplicable: true, kind: "close_out" },
    });
    expect(pipelineWaivers(run).map((x) => waiverLabel(x))).toEqual(["waived by Persona"]);
    expect(listPipelineDecisions(w.store.db, OWNER, { runId: w.run.id })).toEqual([
      expect.objectContaining({ kind: "close_out", stage: "code_review", detail: { closedOut: ["code_review"], now: "human_review", preset: "light" } }),
    ]);
    expect(jobOf(w).status).toBe("active");
    // A close-out rests on the project's pipeline, not on the launch changing
    // no code: the change it carries doesn't reopen the run.
    expect(await pipelineReadyBlock(w.store.db, w.launch.id, w.deps)).toBeNull();
    expect(runOf(w).currentStage).toBe("human_review");
  });

  test("refused when the current stage still applies, naming what does", async () => {
    const w = makeWorld({ persona: true });
    await toValidation(w);
    const res = await decide(w, "validation", "close_out", "the change is small enough to close out without the rest");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    expect(res.error).toContain("still applies");
    expect(res.error).toContain("validation, review, deploy");
    expect(runOf(w).currentStage).toBe("validation");
    expect(runOf(w).attempts.filter((a) => a.status === "waived")).toEqual([]);
  });
});

describe("a block goes to Persona", () => {
  test("the job stays active, noted, and a pipeline:blocked frame names the run and the options", async () => {
    const w = makeWorld({ persona: true });
    await toValidation(w);
    markRunWaiting(w.store.db, runOf(w), "worker stopped 3 times at validation without advancing", "stalled", w.deps);
    expect(jobOf(w)).toMatchObject({ status: "active", note: "Persona deciding: worker stopped 3 times at validation without advancing" });
    const frames = w.broadcasts.filter((m) => m.type === "pipeline:blocked");
    expect(frames).toHaveLength(1);
    expect(frames[0]!.audience).toBe(OWNER);
    expect(frames[0]!.payload as PipelineBlockedPayload).toEqual({
      owner: OWNER,
      jobId: jobOf(w).id,
      runId: w.run.id,
      launchId: w.launch.id,
      sessionId: w.sessionId,
      stage: "validation",
      waitingKind: "stalled",
      reason: "worker stopped 3 times at validation without advancing",
      options: ["skip", "waive", "close_out", "escalate"],
    });
  });

  test("a run with no Persona job waits for the owner, with no frame", async () => {
    const w = makeWorld();
    await toValidation(w);
    markRunWaiting(w.store.db, runOf(w), "worker stopped 3 times at validation without advancing", "stalled", w.deps);
    expect(runOf(w).status).toBe("waiting_user");
    expect(w.broadcasts.filter((m) => m.type === "pipeline:blocked")).toEqual([]);
  });
});
