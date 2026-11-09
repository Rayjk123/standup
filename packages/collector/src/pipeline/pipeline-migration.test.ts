import { describe, expect, test } from "bun:test";
import { deletePipelineConfig, getPipelineRun, personaJobForLaunch, updatePersonaJob, updatePipelineRun } from "@standup/store";
import type { WsMessage } from "@standup/shared";
import { createPersonaEventRouter } from "../persona/events.js";
import { acceptWontfixReview, decidePipelineStage, routeLegacyBlocksToPersona } from "./engine.js";
import { EVIDENCE, OWNER, advance, approveHumanReview, makeWorld, submitPacket, type World } from "./test-world.js";

/*
 * The boot sweep that hands runs blocked before blocks went to Persona —
 * their jobs left waiting on the owner with the pipeline's own note — over to
 * Persona: the job goes active, noted "Persona deciding", and Persona is
 * woken once. Nothing is waived or advanced; Persona's own decisions then
 * finish the runs.
 */

const ACTOR = `${OWNER}'s Persona`;
const LEGACY_ISSUE_ID = "code review stage needs an issue id from you — the worker should ask_human for it";
const LEGACY_WONTFIX = "review has wontfix High/Medium findings — waive review in the console or message the worker";
const runOf = (w: World) => getPipelineRun(w.store.db, w.run.id)!;
const jobOf = (w: World) => personaJobForLaunch(w.store.db, w.launch.id)!.job;
const blocked = (w: World) => w.broadcasts.filter((m) => m.type === "pipeline:blocked");
/** Every owner's Persona runs. */
const personaRuns = () => true;

/** Leaves the run waiting at its current stage and its job waiting on the owner, as a block did before. */
function legacyBlock(w: World, reason: string): void {
  const job = jobOf(w);
  const note = `Pipeline needs you: ${reason}`;
  updatePipelineRun(w.store.db, w.run.id, { status: "waiting_user", waitingReason: reason, waitingKind: "owner_input", flaggedJob: { id: job.id, note } });
  updatePersonaJob(w.store.db, job.id, { status: "waiting_user", note });
}

/** A plain git project's run frozen with the full pipeline, stuck at code_review on the old issue-id wait. */
async function legacyIssueIdRun(): Promise<World> {
  const w = makeWorld({ persona: true, reviewArtifact: null, override: { preset: "full" } });
  await advance(w, "start");
  await advance(w, "coding", EVIDENCE.coding);
  await advance(w, "validation", EVIDENCE.validationPass);
  await advance(w, "review", EVIDENCE.reviewClean);
  submitPacket(w);
  await advance(w, "deploy", EVIDENCE.deploy);
  w.store.db.run("UPDATE pipeline_runs SET current_stage = 'code_review' WHERE id = ?", [w.run.id]);
  legacyBlock(w, LEGACY_ISSUE_ID);
  // The project's pipeline is the light one now.
  deletePipelineConfig(w.store.db, OWNER, null);
  return w;
}

/** A reviewed project's run held at review on wontfix findings, in the old wording. */
async function legacyWontfixRun(): Promise<World> {
  const w = makeWorld({ persona: true });
  await advance(w, "start");
  await advance(w, "coding", EVIDENCE.coding);
  await advance(w, "validation", EVIDENCE.validationPass);
  await advance(w, "review", {
    reviewers: [
      { name: "r1", findings: [{ severity: "high", title: "schema drift", status: "wontfix" }] },
      { name: "r2", findings: [] },
    ],
  });
  expect(runOf(w).currentStage).toBe("review");
  legacyBlock(w, LEGACY_WONTFIX);
  return w;
}

describe("routeLegacyBlocksToPersona", () => {
  test("hands a legacy issue-id block to Persona once, waiving nothing; close out then finishes it", async () => {
    const w = await legacyIssueIdRun();
    const attemptsBefore = runOf(w).attempts.length;
    w.broadcasts.length = 0;

    expect(routeLegacyBlocksToPersona(w.store.db, w.deps, personaRuns)).toBe(1);
    expect(jobOf(w)).toMatchObject({ status: "active", note: `Persona deciding: ${LEGACY_ISSUE_ID}` });
    expect(runOf(w)).toMatchObject({ currentStage: "code_review", status: "waiting_user", waitingReason: LEGACY_ISSUE_ID });
    expect(runOf(w).attempts).toHaveLength(attemptsBefore);
    expect(blocked(w)).toHaveLength(1);
    expect(blocked(w)[0]!.payload).toMatchObject({ runId: w.run.id, stage: "code_review", reason: LEGACY_ISSUE_ID });

    // A second sweep finds nothing new to hand over.
    expect(routeLegacyBlocksToPersona(w.store.db, w.deps, personaRuns)).toBe(0);
    expect(blocked(w)).toHaveLength(1);

    const closed = await decidePipelineStage(
      w.store.db,
      w.run.id,
      { stage: "code_review", kind: "close_out", reason: "a plain git project: there is no code review to cut, the review packet is the review", actor: ACTOR },
      w.deps
    );
    expect(closed.ok && closed.to).toBe("human_review");
    expect(jobOf(w).status).toBe("active");
    expect((await approveHumanReview(w)).status).toBe(200);
    const run = runOf(w);
    expect(run.status).toBe("complete");
    // code_review is waived by the close-out, never passed; nothing else was recorded for it.
    expect(run.attempts.filter((a) => a.stageId === "code_review").map((a) => a.status)).toEqual(["skipped", "waived"]);
    expect(run.attempts.some((a) => a.stageId === "code_review" && a.status === "passed")).toBe(false);
  });

  test("hands a legacy wontfix hold to Persona, which accepts it", async () => {
    const w = await legacyWontfixRun();
    w.broadcasts.length = 0;
    expect(routeLegacyBlocksToPersona(w.store.db, w.deps, personaRuns)).toBe(1);
    expect(jobOf(w)).toMatchObject({ status: "active", note: `Persona deciding: ${LEGACY_WONTFIX}` });
    expect(blocked(w)[0]!.payload).toMatchObject({ options: ["skip", "waive", "close_out", "accept_wontfix", "escalate"] });
    expect(runOf(w).attempts.some((a) => a.status === "waived")).toBe(false);

    const accepted = await acceptWontfixReview(
      w.store.db,
      w.run.id,
      { stage: "review", reason: "schema drift is tracked in its own ticket and out of scope for this change", actor: ACTOR },
      w.deps
    );
    expect(accepted.ok && accepted.to).toBe("deploy");
    expect(jobOf(w)).toMatchObject({ status: "active", note: "Pipeline moved on: Deploy and live-validate" });
  });

  test("leaves a job someone changed since, and a run with no Persona job, alone", async () => {
    const w = await legacyWontfixRun();
    updatePersonaJob(w.store.db, jobOf(w).id, { note: "owner: I'll look at this tomorrow" });
    w.broadcasts.length = 0;
    expect(routeLegacyBlocksToPersona(w.store.db, w.deps, personaRuns)).toBe(0);
    expect(jobOf(w)).toMatchObject({ status: "waiting_user", note: "owner: I'll look at this tomorrow" });
    expect(blocked(w)).toEqual([]);
  });

  test("a job flagged by another of its runs isn't lifted by a run that doesn't own the flag", async () => {
    const w = await legacyWontfixRun();
    // The job's note is another run's: this run's stored flag names an older note.
    updatePipelineRun(w.store.db, w.run.id, { flaggedJob: { id: jobOf(w).id, note: "Pipeline needs you: an older block" } });
    w.broadcasts.length = 0;
    expect(routeLegacyBlocksToPersona(w.store.db, w.deps, personaRuns)).toBe(0);
    expect(jobOf(w)).toMatchObject({ status: "waiting_user", note: `Pipeline needs you: ${LEGACY_WONTFIX}` });
    expect(blocked(w)).toEqual([]);
    // Nor by one with no stored flag at all.
    updatePipelineRun(w.store.db, w.run.id, { flaggedJob: null });
    expect(routeLegacyBlocksToPersona(w.store.db, w.deps, personaRuns)).toBe(0);
    expect(jobOf(w).status).toBe("waiting_user");
  });

  test("an owner whose Persona doesn't run here keeps their job waiting on them", async () => {
    const w = await legacyWontfixRun();
    w.broadcasts.length = 0;
    expect(routeLegacyBlocksToPersona(w.store.db, w.deps, (owner) => owner !== OWNER)).toBe(0);
    expect(jobOf(w)).toMatchObject({ status: "waiting_user", note: `Pipeline needs you: ${LEGACY_WONTFIX}` });
    expect(blocked(w)).toEqual([]);
  });

  test("Persona's event router turns the frame into an immediate inbox item for the owner", async () => {
    const w = await legacyWontfixRun();
    w.broadcasts.length = 0;
    routeLegacyBlocksToPersona(w.store.db, w.deps, personaRuns);
    const items: Array<{ kind: string; payload: Record<string, unknown>; opts?: { coalesceKey?: string; delayMs?: number } }> = [];
    const route = createPersonaEventRouter({
      db: w.store.db,
      owner: OWNER,
      coalesceMs: 5_000,
      enqueue: (kind, payload, opts) => items.push({ kind, payload, opts }),
      isSelfActing: () => false,
    });
    for (const frame of blocked(w)) route(frame as WsMessage);
    expect(items).toEqual([
      {
        kind: "worker_event",
        payload: expect.objectContaining({ type: "pipeline_blocked", jobId: jobOf(w).id, runId: w.run.id, stage: "review" }),
        opts: { coalesceKey: `pipeline:${w.run.id}` },
      },
    ]);
    // Another owner's router ignores it.
    const other: unknown[] = [];
    const bobs = createPersonaEventRouter({ db: w.store.db, owner: "bob", coalesceMs: 0, enqueue: (...a) => other.push(a), isSelfActing: () => false });
    for (const frame of blocked(w)) bobs(frame as WsMessage);
    expect(other).toEqual([]);
  });
});
