import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { CodeReviewLinkFormat, ReviewLink } from "@standup/shared";
import {
  createLaunch,
  createPlanApproval,
  createReviewPacket,
  createSession,
  getPersonaJob,
  getPipelineRun,
  getPipelineRunByLaunch,
  linkPersonaJobLaunch,
  personaJobForLaunch,
  recordPipelineAttempt,
  submitReviewPacket,
  updateLaunchStatus,
  updatePipelineRun,
  updateSessionStatus,
} from "@standup/store";
import {
  REVIEW_LANDED_REASON,
  PICKED_ENDED_REASON,
  decidePipelineStage,
  markRunWaiting,
  parkPipelineRun,
  startPickedAttemptPipeline,
  startPipelineForLaunch,
} from "../pipeline/engine.js";
import { DEFAULT_ORG_PROFILE } from "../org-profile/default.js";
import { setActiveOrgProfile } from "../org-profile/load.js";
import type { OrgProfile } from "../org-profile/types.js";
import { advance, decideHumanReview, makeWorld, OWNER, REVIEW_DRAFT, submitPacket } from "../pipeline/test-world.js";
import { packetCodeReview, projectJobTask } from "./projection.js";

function jobWorld() {
  const w = makeWorld({ persona: true, reviewArtifact: null });
  const jobId = personaJobForLaunch(w.store.db, w.launch.id)!.job.id;
  const project = () => projectJobTask(w.store.db, jobId)!;
  return { w, jobId, project };
}

/** A second worker launch of the job, `status` and running its own session. */
function secondLaunch(w: ReturnType<typeof jobWorld>["w"], jobId: string, status: "running" | "starting" | "failed" = "running") {
  const sessionId = `sess-${randomUUID().slice(0, 8)}`;
  if (status === "running") createSession(w.store.db, { id: sessionId, projectId: "proj", title: "Worker 2", cwd: "/tmp/standup-pipeline-test/wt2", status: "running" });
  const launch = createLaunch(w.store.db, {
    id: randomUUID(),
    projectId: "proj",
    task: "second worker",
    worktreePath: "/tmp/standup-pipeline-test/wt2",
    branch: "standup/second",
    status,
    ...(status === "running" ? { sessionId } : {}),
    requester: OWNER,
    launchedBy: OWNER,
  });
  linkPersonaJobLaunch(w.store.db, jobId, launch.id);
  return launch;
}

const runOf = (w: ReturnType<typeof jobWorld>["w"]) => getPipelineRun(w.store.db, w.run.id)!;

describe("projectJobTask", () => {
  test("a run the engine blocks on the landed-review reason is Persona deciding in the validation column, not waiting", () => {
    const { w, jobId, project } = jobWorld();
    const atReview = updatePipelineRun(w.store.db, w.run.id, { currentStage: "code_review" })!;
    expect(markRunWaiting(w.store.db, atReview, REVIEW_LANDED_REASON, "owner_input", w.deps)).not.toBeNull();
    // The engine leaves the job active: the block is Persona's.
    expect(getPersonaJob(w.store.db, jobId)!.status).toBe("active");
    expect(project()).toMatchObject({ status: "validation", stage: "code_review", waitingOn: `Persona deciding: ${REVIEW_LANDED_REASON}` });
  });

  test("a picked attempt whose worker ended is Persona deciding in its stage column, not waiting", () => {
    const { w, jobId, project } = jobWorld();
    const ended = secondLaunch(w, jobId, "failed");
    const picked = startPickedAttemptPipeline(w.store.db, { launch: ended, owner: OWNER }, w.deps);
    expect(picked?.run).toMatchObject({ status: "waiting_user", waitingReason: PICKED_ENDED_REASON });
    expect(getPersonaJob(w.store.db, jobId)!.status).toBe("active");
    expect(project()).toMatchObject({ status: "coding", stage: "coding", waitingOn: `Persona deciding: ${PICKED_ENDED_REASON}` });
  });

  test("Persona escalating a blocked run to the owner puts the card in waiting", async () => {
    const { w, jobId, project } = jobWorld();
    await advance(w, "start");
    updatePipelineRun(w.store.db, w.run.id, { status: "waiting_user", waitingKind: "exhausted", waitingReason: "loop exhausted" });
    expect(project()).toMatchObject({ status: "coding", waitingOn: "Persona deciding: loop exhausted" });
    const escalated = await decidePipelineStage(
      w.store.db,
      w.run.id,
      { stage: "coding", kind: "escalate", reason: "the owner decides the API shape", actor: `${OWNER}'s Persona` },
      w.deps
    );
    expect(escalated.ok).toBe(true);
    expect(getPersonaJob(w.store.db, jobId)!.status).toBe("waiting_user");
    expect(project()).toMatchObject({ status: "waiting", stage: "coding" });
  });

  test("a run waiting with retries exhausted stays Persona deciding in its stage column", () => {
    const { w, project } = jobWorld();
    updatePipelineRun(w.store.db, w.run.id, { currentStage: "coding", status: "waiting_user", waitingReason: "retries spent", waitingKind: "exhausted" });
    expect(project()).toMatchObject({ status: "coding", waitingOn: "Persona deciding: retries spent" });
  });

  test("an active code_review run with no packet is validation, the code review in progress", () => {
    const { w, project } = jobWorld();
    updatePipelineRun(w.store.db, w.run.id, { currentStage: "code_review" });
    expect(project()).toMatchObject({ status: "validation", stage: "code_review", waitingOn: "code review in progress" });
  });

  test("a human_review run with no packet yet is validation: the worker is writing it", () => {
    const { w, project } = jobWorld();
    updatePipelineRun(w.store.db, w.run.id, { currentStage: "human_review" });
    const got = project();
    expect(got).toMatchObject({ status: "validation", stage: "human_review" });
    expect(got.waitingOn).toBeUndefined();
  });

  test("a packet sent back while the run is held at code_review is not in review", async () => {
    const { w, project } = jobWorld();
    updatePipelineRun(w.store.db, w.run.id, { currentStage: "human_review" });
    submitPacket(w);
    expect(project()).toMatchObject({ status: "in_review", waitingOn: "owner review of the packet" });
    const decided = await decideHumanReview(w, "changes_requested");
    expect(decided.status).toBe(200);
    updatePipelineRun(w.store.db, w.run.id, { currentStage: "code_review", status: "active" });
    const got = project();
    expect(got.status).not.toBe("in_review");
    expect(got).toMatchObject({ status: "validation", stage: "code_review", waitingOn: "code review in progress" });
  });

  test("a parked run with a pending packet is in review", () => {
    const { w, project } = jobWorld();
    updatePipelineRun(w.store.db, w.run.id, { currentStage: "human_review" });
    const parked = parkPipelineRun(w.store.db, w.run.id, { reason: "waits on the schema job landing first", by: "persona", actor: `${OWNER}'s Persona` }, w.deps);
    expect(parked.ok).toBe(true);
    expect(project()).toMatchObject({ status: "validation", flag: "parked", waitingOn: "parked: waits on the schema job landing first" });
    submitPacket(w);
    const got = project();
    expect(got).toMatchObject({ status: "in_review", waitingOn: "owner review of the packet" });
    expect(got.flag).toBeUndefined();
  });

  test("an approved run whose worker still runs (landing it) awaits Persona's close-out", async () => {
    const { w, project } = jobWorld();
    updatePipelineRun(w.store.db, w.run.id, { currentStage: "complete", status: "complete" });
    expect(getPipelineRunByLaunch(w.store.db, w.launch.id)!.status).toBe("complete");
    // The worker's session still runs: Persona messaged it to land the change.
    expect(project()).toMatchObject({ status: "in_review", waitingOn: "Persona to close out" });
  });

  test("a finished run's worker counts as live work once the job has a newer launch", () => {
    const { w, jobId, project } = jobWorld();
    updatePipelineRun(w.store.db, w.run.id, { currentStage: "complete", status: "complete" });
    expect(project().status).toBe("in_review");
    const next = secondLaunch(w, jobId);
    // The newer launch runs without a pipeline run of its own: the job is at work again.
    expect(next.status).toBe("running");
    expect(project().status).toBe("coding");
  });

  test("parallel launches whose runs both completed, one worker still landing, await close-out", () => {
    const { w, jobId, project } = jobWorld();
    const other = secondLaunch(w, jobId);
    const second = startPipelineForLaunch(w.store.db, { launchId: other.id, owner: OWNER, projectId: "proj" });
    updatePipelineRun(w.store.db, w.run.id, { currentStage: "complete", status: "complete" });
    updatePipelineRun(w.store.db, second.id, { currentStage: "complete", status: "complete" });
    // B's worker is done; A's still runs, landing what its run delivered.
    updateSessionStatus(w.store.db, other.sessionId!, "idle");
    // A and B started together; B's run started before A's completed, so it is no newer work.
    const stamp = (id: string, created: string, updated: string) =>
      w.store.db.run("UPDATE pipeline_runs SET created_at = ?, updated_at = ? WHERE id = ?", [created, updated, id]);
    stamp(w.run.id, "2026-10-12T10:00:00.000Z", "2026-10-12T13:00:00.000Z");
    stamp(second.id, "2026-10-12T11:00:00.000Z", "2026-10-12T12:00:00.000Z");
    w.store.db.run("UPDATE launches SET created_at = ? WHERE id = ?", ["2026-10-12T09:00:00.000Z", w.launch.id]);
    w.store.db.run("UPDATE launches SET created_at = ? WHERE id = ?", ["2026-10-12T10:30:00.000Z", other.id]);
    expect(project()).toMatchObject({ status: "in_review", waitingOn: "Persona to close out" });
  });

  test("Persona's escalation with a packet pending is waiting, a worker's review-only hand-off in review", () => {
    const { w, jobId, project } = jobWorld();
    updatePipelineRun(w.store.db, w.run.id, { currentStage: "human_review" });
    submitPacket(w);
    expect(project()).toMatchObject({ status: "in_review", waitingOn: "owner review of the packet" });
    // Persona escalates the job to its owner: the owner's decision, not just the packet's review.
    w.store.db.run(
      "UPDATE persona_jobs SET status = 'waiting_user', waiting_since = ?, waiting_source = 'persona' WHERE id = ?",
      ["2026-10-12T10:00:00.000Z", jobId]
    );
    const escalated = project();
    expect(escalated.status).toBe("waiting");
    expect(escalated.waitingOn).toBeDefined();
    expect(escalated.waitingOn).not.toBe("owner review of the packet");
    // The same wait raised by the worker's hand-off asks only for the packet's review.
    w.store.db.run("UPDATE persona_jobs SET waiting_source = 'handoff' WHERE id = ?", [jobId]);
    expect(project()).toMatchObject({ status: "in_review", waitingOn: "owner review of the packet" });
  });

  test("a finished run whose worker's session is idle awaits Persona's close-out", () => {
    const { w, project } = jobWorld();
    updatePipelineRun(w.store.db, w.run.id, { currentStage: "complete", status: "complete" });
    updateSessionStatus(w.store.db, w.sessionId, "idle");
    expect(project()).toMatchObject({ status: "in_review", waitingOn: "Persona to close out" });
  });

  test("a plan awaiting approval counts only while its launch is running", () => {
    const { w, project } = jobWorld();
    updatePipelineRun(w.store.db, w.run.id, { currentStage: "complete", status: "complete" });
    createPlanApproval(w.store.db, { launchId: w.launch.id, projectId: "proj", worktreePath: w.worktree });
    expect(project()).toMatchObject({ status: "queued", flag: "planned", waitingOn: "plan approval" });
    // The launch is cleaned with its plan never decided: the stale plan is ignored.
    updateLaunchStatus(w.store.db, w.launch.id, "cleaned");
    expect(project()).toMatchObject({ status: "in_review", waitingOn: "Persona to close out" });
    expect(project().flag).toBeUndefined();
  });

  test("another launch's run Persona decides puts the card in that run's stage column", () => {
    const { w, jobId, project } = jobWorld();
    updatePipelineRun(w.store.db, w.run.id, { currentStage: "human_review" });
    const other = secondLaunch(w, jobId);
    const second = startPipelineForLaunch(w.store.db, { launchId: other.id, owner: OWNER, projectId: "proj" });
    updatePipelineRun(w.store.db, second.id, { currentStage: "coding", status: "waiting_user", waitingReason: "pick a branch", waitingKind: "owner_input" });
    expect(project()).toMatchObject({ status: "coding", stage: "coding", waitingOn: "Persona deciding: pick a branch" });
    expect(project().links.runId).toBe(second.id);
  });

  test("a launch still starting counts as queued, not live", () => {
    const { w, jobId, project } = jobWorld();
    updatePipelineRun(w.store.db, w.run.id, { currentStage: "complete", status: "complete" });
    updateLaunchStatus(w.store.db, w.launch.id, "cleaned");
    secondLaunch(w, jobId, "starting");
    expect(project()).toMatchObject({ status: "queued", waitingOn: "host room to start" });
  });

  test("with no packet naming a review, the review the run's code_review stage recorded is linked", () => {
    const { w, project } = jobWorld();
    expect(project().links.codeReview).toBeUndefined();
    recordPipelineAttempt(w.store.db, w.run.id, {
      stageId: "code_review",
      status: "passed",
      evidence: { reviewId: "R-4321", url: "https://review.example/reviews/R-4321", issueId: "P1" },
    });
    expect(runOf(w).attempts.at(-1)?.stageId).toBe("code_review");
    expect(project().links.codeReview).toEqual({ id: "R-4321", url: "https://review.example/reviews/R-4321" });
  });

  test("every projected card carries launchIds, the mark of a refined card", () => {
    const { project } = jobWorld();
    expect(Array.isArray(project().links.launchIds)).toBe(true);
  });
});

/** An org's review tool whose reviews are `R-<n>` at the top of review.example.corp. */
const CORP_FORMAT: CodeReviewLinkFormat = {
  urlPattern: String.raw`^https://review\.example\.corp/(R-\d+)(?:[/?#]|$)`,
  idPattern: String.raw`\bR-\d+\b`,
  urlTemplate: "https://review.example.corp/{id}",
};

const CORP_PROFILE: OrgProfile = {
  ...DEFAULT_ORG_PROFILE,
  codeReview: { ...DEFAULT_ORG_PROFILE.codeReview, linkFormat: CORP_FORMAT },
};

/**
 * A job whose project reviews on the generic adapter (`adapter`) or on
 * whatever detects it (`detected`: github-pr, the default link format), its
 * launch's packet submitted with `links`.
 */
function packetWorld(adapter: "generic" | "detected", links: ReviewLink[]) {
  const w = makeWorld({ persona: true, reviewArtifact: adapter === "generic" ? "generic" : null });
  const jobId = personaJobForLaunch(w.store.db, w.launch.id)!.job.id;
  const packet = createReviewPacket(w.store.db, { owner: OWNER, launchId: w.launch.id, sessionId: w.sessionId, jobId, projectId: "proj" });
  expect(submitReviewPacket(w.store.db, { id: packet.id, owner: OWNER, draft: { ...REVIEW_DRAFT, links } })).not.toBeNull();
  return { w, project: () => projectJobTask(w.store.db, jobId)! };
}

describe("projectJobTask: a packet's code review is read under its project's adapter", () => {
  beforeEach(() => setActiveOrgProfile(CORP_PROFILE));
  afterEach(() => setActiveOrgProfile());

  const corpUrl = "https://review.example.corp/R-77";
  const prUrl = "https://github.com/o/r/pull/12";
  const cases: Array<[string, "generic" | "detected", ReviewLink[], { id: string; url: string } | undefined]> = [
    ["the adapter's pattern finds the review among other links", "generic", [{ kind: "other", label: "review", url: corpUrl }], { id: "R-77", url: corpUrl }],
    ["the default format reads no review from a link of another kind", "detected", [{ kind: "other", label: "review", url: corpUrl }], undefined],
    ["the adapter's pattern reads the id, not the URL's last segment", "generic", [{ kind: "code_review", label: "R-77", url: `${corpUrl}/diff` }], { id: "R-77", url: `${corpUrl}/diff` }],
    ["the default format reads the URL's last segment", "detected", [{ kind: "code_review", label: "R-77", url: `${corpUrl}/diff` }], { id: "diff", url: `${corpUrl}/diff` }],
    ["a bare id becomes the adapter's page for it", "generic", [{ kind: "code_review", label: "R-88", url: "R-88" }], { id: "R-88", url: "https://review.example.corp/R-88" }],
    ["the default format reads no review from a bare id", "detected", [{ kind: "code_review", label: "R-88", url: "R-88" }], undefined],
    ["a code_review link off the adapter's pattern names none", "generic", [{ kind: "code_review", label: "#12", url: prUrl }], undefined],
    ["the default format reads any http(s) code_review link", "detected", [{ kind: "code_review", label: "#12", url: prUrl }], { id: "12", url: prUrl }],
  ];
  for (const [name, adapter, links, expected] of cases) {
    test(name, () => {
      const { project } = packetWorld(adapter, links);
      expect(project().links.codeReview).toEqual(expected);
    });
  }

  test("a packet naming no review under the adapter falls back to the run's recorded review", () => {
    const { w, project } = packetWorld("generic", [{ kind: "code_review", label: "#12", url: prUrl }]);
    recordPipelineAttempt(w.store.db, w.run.id, { stageId: "code_review", status: "passed", evidence: { reviewId: "R-5", url: "https://review.example.corp/R-5" } });
    expect(project().links.codeReview).toEqual({ id: "R-5", url: "https://review.example.corp/R-5" });
  });

  const evidenceCases: Array<[string, "generic" | "detected", Record<string, string>, { id?: string; url?: string }]> = [
    ["a run's bare review id becomes the adapter's page for it", "generic", { reviewId: "R-6" }, { id: "R-6", url: "https://review.example.corp/R-6" }],
    ["the default format keeps a run's bare review id, with no page", "detected", { reviewId: "R-6" }, { id: "R-6" }],
    ["the adapter's pattern reads a run's review id from its URL", "generic", { url: `${corpUrl}/diff` }, { id: "R-77", url: `${corpUrl}/diff` }],
    ["the default format reads a run's review id from its URL's last segment", "detected", { url: `${corpUrl}/diff` }, { id: "diff", url: `${corpUrl}/diff` }],
    ["a run's URL off the adapter's pattern is kept as recorded", "generic", { reviewId: "#12", url: prUrl }, { id: "#12", url: prUrl }],
  ];
  for (const [name, adapter, evidence, expected] of evidenceCases) {
    test(name, () => {
      const { w, project } = packetWorld(adapter, []);
      recordPipelineAttempt(w.store.db, w.run.id, { stageId: "code_review", status: "passed", evidence });
      expect(project().links.codeReview).toEqual(expected);
    });
  }

  test("packetCodeReview reads under the project's adapter, and under the default format for an unknown project", () => {
    const { w } = packetWorld("generic", []);
    const links: ReviewLink[] = [{ kind: "other", label: "review", url: corpUrl }];
    expect(packetCodeReview(w.store.db, links, "proj")).toEqual({ id: "R-77", url: corpUrl });
    expect(packetCodeReview(w.store.db, links, "no-such-project")).toBeNull();
    expect(packetCodeReview(w.store.db, links, null)).toBeNull();
  });
});
