import { describe, expect, test } from "bun:test";
import { findDraftReviewPacketForLaunch, getPipelineRun, personaJobForLaunch, submitReviewPacket } from "@standup/store";
import { MIN_WONTFIX_ACCEPT_REASON, pipelineWaivers, stageStates, waiverLabel } from "@standup/shared";
import { acceptWontfixReview, markRunWaiting, waivePipelineStage, wontfixHold } from "./engine.js";
import { EVIDENCE, OWNER, REVIEW_DRAFT, advance, human, makeWorld, post, type World } from "./test-world.js";

/**
 * Persona accepting a review held on wontfix findings, on a launch with a
 * real code change: allowed only on a review held for the owner with every
 * High/Medium finding marked wontfix, recorded as its own kind of waiver and
 * shown wherever waivers are.
 */

const runOf = (w: World) => getPipelineRun(w.store.db, w.run.id)!;

const ACTOR = `${OWNER}'s Persona`;
const REASON =
  "Schema drift is tracked in job 4990eb33, which owns the migration; the same-UID  residual was descoped from this change";

const WONTFIX_REVIEW = {
  reviewers: [
    { name: "r1", findings: [{ severity: "high", title: "schema drift", status: "wontfix", note: "tracked in job 4990eb33" }] },
    {
      name: "r2",
      findings: [
        { severity: "medium", title: "same-UID residual", status: "wontfix" },
        { severity: "low", title: "nit", status: "open" },
        { severity: "high", title: "already fixed", status: "fixed" },
      ],
    },
  ],
};

async function toReview(w: World) {
  expect((await advance(w, "start")).status).toBe(200);
  expect((await advance(w, "coding", EVIDENCE.coding)).status).toBe(200);
  expect((await advance(w, "validation", EVIDENCE.validationPass)).status).toBe(200);
}

/** A coded launch held at review on wontfix findings, as the worker's advance leaves it. */
async function heldOnWontfix(w: World) {
  await toReview(w);
  const res = await advance(w, "review", WONTFIX_REVIEW);
  expect(res.body.to).toBe("review");
  expect(runOf(w)).toMatchObject({ status: "waiting_user", waitingKind: "owner_input" });
}

const accept = (w: World, reason = REASON, stage = runOf(w).currentStage) =>
  acceptWontfixReview(w.store.db, w.run.id, { stage, reason, actor: ACTOR }, w.deps);

describe("Persona accepts a review held on wontfix findings", () => {
  test("allowed when every High/Medium finding is wontfix: recorded as its own waiver, and the run moves on", async () => {
    const w = makeWorld({ persona: true });
    w.changed.files = ["packages/collector/src/real.ts"];
    await heldOnWontfix(w);
    // The hold goes to Persona to decide: the job stays active.
    expect(personaJobForLaunch(w.store.db, w.launch.id)!.job.status).toBe("active");
    expect(wontfixHold(runOf(w))).toEqual({
      wontfix: [
        { reviewer: "r1", severity: "high", title: "schema drift", note: "tracked in job 4990eb33" },
        { reviewer: "r2", severity: "medium", title: "same-UID residual" },
      ],
      open: [],
    });

    const res = await accept(w);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res).toMatchObject({ from: "review", to: "deploy", outcome: "waived" });
    const run = runOf(w);
    expect(run).toMatchObject({ currentStage: "deploy", status: "active" });
    expect(run.waitingKind ?? null).toBeNull();
    expect(run.waitingReason ?? null).toBeNull();
    expect(personaJobForLaunch(w.store.db, w.launch.id)!.job.status).toBe("active");

    const attempt = run.attempts.at(-1)!;
    expect(attempt).toMatchObject({ stageId: "review", status: "waived", nextStage: "deploy" });
    expect(attempt.reason).toContain("waived by Persona (wontfix accepted)");
    expect(attempt.reason).toContain(REASON);
    expect(attempt.evidence).toEqual({
      waiver: {
        by: "persona",
        actor: ACTOR,
        reason: REASON,
        notApplicable: false,
        wontfixAccepted: {
          findings: [
            { reviewer: "r1", severity: "high", title: "schema drift", note: "tracked in job 4990eb33" },
            { reviewer: "r2", severity: "medium", title: "same-UID residual" },
          ],
        },
        kind: "accept_wontfix",
      },
    });
    // Not passed, and not a not-applicable waiver.
    expect(stageStates(run.definition, run).review!.state).toBe("waived");
    const [waiver] = pipelineWaivers(run);
    expect(waiver).toMatchObject({ stageId: "review", by: "persona", actor: ACTOR, reason: REASON, notApplicable: false });
    expect(waiver!.wontfixFindings).toHaveLength(2);
    expect(waiverLabel(waiver!)).toBe("waived by Persona (wontfix accepted)");
    expect(w.checkpoints.at(-1)).toContain("waived by Persona (wontfix accepted)");
  });

  test("refused while any High/Medium finding is open (a looped run, or a held attempt with one open); the run keeps its state", async () => {
    const w = makeWorld();
    await toReview(w);
    // An open Medium alongside a wontfix High loops to coding, never holds at review.
    await advance(w, "review", {
      reviewers: [
        { name: "r1", findings: [{ severity: "high", title: "a", status: "wontfix" }] },
        { name: "r2", findings: [{ severity: "medium", title: "b", status: "open" }] },
      ],
    });
    expect(runOf(w).currentStage).toBe("coding");
    expect((await accept(w, REASON, "review")).ok).toBe(false);

    // A held run whose last review attempt has an open blocking finding (a hand-edited or racing attempt) is refused too.
    await advance(w, "coding", EVIDENCE.coding);
    await advance(w, "validation", EVIDENCE.validationPass);
    await advance(w, "review", WONTFIX_REVIEW);
    const held = runOf(w);
    const last = held.attempts.at(-1)!;
    w.store.db.run("UPDATE pipeline_stage_attempts SET evidence_json = ? WHERE id = ?", [
      JSON.stringify({
        reviewers: [
          { name: "r1", findings: [{ severity: "high", title: "schema drift", status: "wontfix" }] },
          { name: "r2", findings: [{ severity: "medium", title: "still open", status: "open" }] },
        ],
      }),
      last.id,
    ]);
    const before = runOf(w);
    const res = await accept(w);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    expect(res.error).toContain("open High/Medium findings ([medium] still open)");
    const after = runOf(w);
    expect(after).toMatchObject({ currentStage: "review", status: "waiting_user", waitingReason: before.waitingReason });
    expect(after.attempts).toHaveLength(before.attempts.length);
  });

  test("refused on a stage that isn't review", async () => {
    const w = makeWorld();
    await advance(w, "start");
    await advance(w, "coding", EVIDENCE.coding);
    const res = await accept(w, REASON, "validation");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("isn't a review stage");
    expect(runOf(w).currentStage).toBe("validation");
  });

  test("refused on a review that isn't held on wontfix findings (active, or a clean review not yet reported)", async () => {
    const w = makeWorld();
    await toReview(w);
    const res = await accept(w);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("isn't held for the owner on wontfix findings");
  });

  test(`refused with a reason shorter than ${MIN_WONTFIX_ACCEPT_REASON} characters`, async () => {
    const w = makeWorld();
    await heldOnWontfix(w);
    const res = await accept(w, "  tracked elsewhere  ");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(422);
    expect(res.missing?.[0]).toContain(`at least ${MIN_WONTFIX_ACCEPT_REASON} characters`);
    expect(runOf(w)).toMatchObject({ currentStage: "review", status: "waiting_user" });
  });

  test("refused when the reason doesn't name every wontfix finding by title", async () => {
    const w = makeWorld();
    await heldOnWontfix(w);
    const generic = await accept(w, "These are all out of scope for this change, so accept them.");
    expect(generic.ok).toBe(false);
    if (generic.ok) return;
    expect(generic.status).toBe(422);
    expect(generic.error).toContain(`doesn't name: "schema drift", "same-UID residual"`);
    const partial = await accept(w, "schema drift is tracked in job 4990eb33, which owns the migration.");
    expect(partial.ok).toBe(false);
    if (partial.ok) return;
    expect(partial.error).toContain(`doesn't name: "same-UID residual"`);
    expect(runOf(w)).toMatchObject({ currentStage: "review", status: "waiting_user" });
    // Matched case- and whitespace-insensitively, with no other floor than the length.
    const named = "SCHEMA DRIFT: job 4990eb33. Same-UID residual: descoped.";
    expect(named.length).toBeGreaterThanOrEqual(MIN_WONTFIX_ACCEPT_REASON);
    expect((await accept(w, named)).ok).toBe(true);
  });

  test("titles are matched as whole phrases, longest first", async () => {
    const w = makeWorld();
    await toReview(w);
    await advance(w, "review", {
      reviewers: [
        { name: "r1", findings: [{ severity: "high", title: "race", status: "wontfix" }] },
        {
          name: "r2",
          findings: [
            { severity: "medium", title: "missing auth", status: "wontfix" },
            { severity: "medium", title: "missing auth check on /admin", status: "wontfix" },
          ],
        },
      ],
    });
    // "trace" doesn't name "race"; naming the longer title doesn't name the shorter one inside it.
    const loose = await accept(w, "The trace shows the missing auth check on /admin is tracked in job 4990eb33.");
    expect(loose.ok).toBe(false);
    if (loose.ok) return;
    expect(loose.error).toContain(`doesn't name: "race", "missing auth"`);
    const named = "race: tracked in 4990eb33. missing auth: descoped. missing auth check on /admin: tracked in 4364aa89.";
    expect((await accept(w, named)).ok).toBe(true);
  });

  test("refused when the review → coding loop budget is spent, even though the hold reads owner_input", async () => {
    const w = makeWorld();
    await toReview(w);
    for (let i = 0; i < 4; i++) {
      expect((await advance(w, "review", EVIDENCE.reviewHigh)).body.to).toBe("coding");
      await advance(w, "coding", EVIDENCE.coding);
      await advance(w, "validation", EVIDENCE.validationPass);
    }
    // The fifth review relabels what it couldn't fix as wontfix.
    await advance(w, "review", WONTFIX_REVIEW);
    expect(runOf(w)).toMatchObject({ currentStage: "review", status: "waiting_user", waitingKind: "owner_input" });
    const res = await accept(w);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("budget ran out");
    expect(res.error).toContain("Persona decides (skip, waive, close out or escalate) — or the owner in the console");
    expect(runOf(w).currentStage).toBe("review");
  });

  test("a review re-advanced with a new wontfix finding refuses a reason written for the old ones", async () => {
    const w = makeWorld();
    await heldOnWontfix(w);
    // The worker re-advances while held, adding a wontfix High Persona hasn't weighed.
    const again = await advance(w, "review", {
      reviewers: [
        ...WONTFIX_REVIEW.reviewers,
        { name: "r3", findings: [{ severity: "high", title: "auth check skipped on /admin", status: "wontfix" }] },
      ],
    });
    expect(again.body.to).toBe("review");
    const res = await accept(w);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain(`doesn't name: "auth check skipped on /admin"`);
    expect(runOf(w).currentStage).toBe("review");
  });

  test("a not-applicable waiver of a wontfix-held review points at accept_wontfix", async () => {
    const w = makeWorld();
    await heldOnWontfix(w);
    const res = await waivePipelineStage(w.store.db, w.run.id, { stage: "review", reason: REASON, actor: ACTOR, by: "persona" }, w.deps);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('kind "accept_wontfix"');
    expect(res.error).not.toContain("only the owner");
  });

  test("refused when a budget ran out on the owner: that waiver stays the owner's", async () => {
    const w = makeWorld();
    await heldOnWontfix(w);
    const exhausted = markRunWaiting(w.store.db, runOf(w), "loop review → coding used 4/4 — needs you", "exhausted", w.deps);
    expect(exhausted?.waitingKind).toBe("exhausted");
    const res = await accept(w);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("waiting on its owner");
    expect(res.error).toContain("Persona decides (skip, waive, close out or escalate) — or the owner in the console");
    expect(runOf(w)).toMatchObject({ currentStage: "review", waitingKind: "exhausted" });
  });

  test("the route takes only a Persona credential", async () => {
    const w = makeWorld();
    await heldOnWontfix(w);
    const anon = await post(w, "/api/pipeline/accept-wontfix", { sessionId: w.sessionId, stage: "review", reason: REASON });
    expect(anon.status).toBe(403);
    const person = await post(w, "/api/pipeline/accept-wontfix", { sessionId: w.sessionId, stage: "review", reason: REASON }, human(w));
    expect(person.status).toBe(403);
    expect(runOf(w).currentStage).toBe("review");
  });

  test("the review packet shows the waiver, its reason and the findings it covered", async () => {
    const w = makeWorld({ issueId: "ISSUE-42" });
    w.changed.files = ["packages/collector/src/real.ts"];
    await heldOnWontfix(w);
    expect((await accept(w)).ok).toBe(true);
    // A reviewed project's packet links the code review, so the run goes through code_review first;
    // human_review opens the packet's draft, which the worker submits.
    expect((await advance(w, "deploy", EVIDENCE.deploy)).status).toBe(200);
    expect((await advance(w, "code_review", { url: "https://git.example.com/acme/app/pull/1", issueId: "ISSUE-42" })).body.to).toBe("human_review");
    const draft = findDraftReviewPacketForLaunch(w.store.db, OWNER, w.launch.id)!;
    expect(submitReviewPacket(w.store.db, { id: draft.id, owner: OWNER, draft: REVIEW_DRAFT })).toBeTruthy();

    const res = await w.app.request(`/api/reviews/${draft.id}`, { headers: human(w) });
    expect(res.status).toBe(200);
    const { review } = (await res.json()) as { review: { pipeline: { waivers: Array<Record<string, unknown>> } } };
    expect(review.pipeline.waivers).toEqual([
      expect.objectContaining({
        stageId: "review",
        by: "persona",
        actor: ACTOR,
        reason: REASON,
        notApplicable: false,
        wontfixFindings: [
          { reviewer: "r1", severity: "high", title: "schema drift", note: "tracked in job 4990eb33" },
          { reviewer: "r2", severity: "medium", title: "same-UID residual" },
        ],
      }),
    ]);
  });
});
