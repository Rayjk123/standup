import { describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import {
  createLaunch,
  createPersonaJob,
  getOrCreatePersonaConsoleThread,
  getPersonaJob,
  getPipelineRun,
  linkPersonaJobLaunch,
  listPipelineDecisions,
  personaJobForLaunch,
} from "@standup/store";
import { DEFAULT_PIPELINE } from "@standup/shared";
import type { Launch } from "@standup/shared";
import { projectPipelinePreset } from "../code-review/adapter.js";
import { DEFAULT_ORG_PROFILE } from "../org-profile/default.js";
import { setActiveOrgProfile } from "../org-profile/load.js";
import { exampleCorpProfile } from "../org-profile/fixtures/example-corp.js";
import { acceptWontfixReview, decidePipelineStage, setPipelineLayerByPersona, startPipelineForLaunch } from "./engine.js";
import {
  EVIDENCE,
  OWNER,
  advance,
  approveHumanReview,
  human,
  makeWorld,
  plainGitRepo,
  post,
  submitPacket,
  type World,
} from "./test-world.js";

/*
 * Presets: a project with no code review to cut (a plain git repo) runs the
 * light flow — no deploy, no code review, an isolated live check — while a
 * project opted in to a linked code review keeps the full one, whose
 * code_review stage Persona can't skip, waive or close out. Plain-words specs
 * and the job's and launch's layers reshape a pipeline the same way.
 */

/** A remote on the example.corp fixture profile's code host. */
const CORP_REMOTE = "ssh://git@code.example.corp/pkg/Thing";

/** Runs `fn` with the example.corp org profile active, then drops it. */
function withOrgProfile(fn: () => void): void {
  setActiveOrgProfile(exampleCorpProfile());
  try {
    fn();
  } finally {
    setActiveOrgProfile(DEFAULT_ORG_PROFILE);
  }
}

const ACTOR = `${OWNER}'s Persona`;
const runOf = (w: World) => getPipelineRun(w.store.db, w.run.id)!;
const ids = (w: World) => runOf(w).definition.stages.map((s) => s.id);
const jobOf = (w: World) => personaJobForLaunch(w.store.db, w.launch.id)!.job;

const LIVE_CHECK = {
  environment: "isolated collector on :7791",
  isolation: { ports: [7791], tmuxSocket: "/tmp/standup-live-check.sock" },
  liveSamples: [{ request: "GET /api/health", response: "200 ok", ok: true }],
};

/** A fresh launch of the world's project, optionally linked to `jobId`. */
function newLaunch(w: World, jobId?: string): Launch {
  const launch = createLaunch(w.store.db, {
    id: randomUUID(),
    projectId: "proj",
    task: "another change",
    worktreePath: `/tmp/standup-pipeline-test/${randomUUID()}`,
    branch: `standup/${randomUUID().slice(0, 6)}`,
    baseBranch: "main",
    status: "running",
    requester: OWNER,
    launchedBy: OWNER,
  });
  if (jobId) linkPersonaJobLaunch(w.store.db, jobId, launch.id);
  return launch;
}

async function putConfig(w: World, body: unknown, project = "proj") {
  const res = await w.app.request(`/api/pipeline-config?project=${project}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...human(w) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

describe("the project's own preset", () => {
  test("a project opted in to a linked code review resolves to exactly the default pipeline", () => {
    const w = makeWorld();
    expect(runOf(w).preset).toBe("full");
    expect(runOf(w).definition).toEqual(DEFAULT_PIPELINE);
  });

  test("full for a linked review, a review gate, a code-review remote, an unknown project or unread remotes; light for a plain git repo", () => {
    const base = { id: "p", name: "P", branch: "main", repos: [] as string[] };
    const corp = { profile: exampleCorpProfile() };
    expect(projectPipelinePreset(null, corp)).toBe("full");
    expect(projectPipelinePreset({ ...base, codeReviewAdapter: "generic" }, { ...corp, remotes: [] })).toBe("full");
    expect(projectPipelinePreset({ ...base, reviewProcess: "command" }, { ...corp, remotes: [] })).toBe("full");
    expect(projectPipelinePreset({ ...base, repos: ["/r"] }, { ...corp, remotes: [CORP_REMOTE] })).toBe("full");
    expect(projectPipelinePreset({ ...base, repos: ["/r"] }, { ...corp, remotes: null })).toBe("full");
    expect(projectPipelinePreset({ ...base, repos: ["/r"] }, { ...corp, remotes: ["https://github.com/a/b.git"] })).toBe("light");
    expect(projectPipelinePreset({ ...base, repos: ["/r"] }, { ...corp, remotes: [] })).toBe("light");
    // Without the org profile, its code host is a plain remote like any other.
    expect(projectPipelinePreset({ ...base, repos: ["/r"] }, { profile: DEFAULT_ORG_PROFILE, remotes: [CORP_REMOTE] })).toBe("light");
  });

  test("a project registered without repos is read from the launch's own checkout", () => {
    const plain = makeWorld({ reviewArtifact: null, project: { repos: [] }, worktree: plainGitRepo() });
    expect(runOf(plain).preset).toBe("light");
    expect(ids(plain)).not.toContain("code_review");

    withOrgProfile(() => {
      const corp = makeWorld({ reviewArtifact: null, project: { repos: [] }, worktree: plainGitRepo(CORP_REMOTE) });
      expect(runOf(corp).preset).toBe("full");
      expect(ids(corp)).toContain("code_review");
    });

    // Nothing git can read — no repo and no checkout — stays on the full flow.
    const unread = makeWorld({ reviewArtifact: null, project: { repos: [] }, worktree: "/tmp/standup-pipeline-test/missing" });
    expect(runOf(unread).preset).toBe("full");
  });

  test("every readable checkout counts: a launch checkout on another host can't relabel a project whose registered repo is on the org's code host", () => {
    withOrgProfile(() => {
      const corpRepo = plainGitRepo(CORP_REMOTE);
      const relabelled = makeWorld({ reviewArtifact: null, project: { repos: [corpRepo] }, worktree: plainGitRepo() });
      expect(runOf(relabelled).preset).toBe("full");
      const localOnly = makeWorld({ reviewArtifact: null, project: { repos: [corpRepo] }, worktree: plainGitRepo(null) });
      expect(runOf(localOnly).preset).toBe("full");
    });
    // Plain repos everywhere, with an unreadable one among them, stay light.
    const plain = makeWorld({
      reviewArtifact: null,
      project: { repos: [plainGitRepo("https://github.com/example/other.git"), "/tmp/standup-pipeline-test/missing"] },
      worktree: plainGitRepo(),
    });
    expect(runOf(plain).preset).toBe("light");
  });
});

describe("a light project's run", () => {
  test("runs start → coding → validation → review → live check → (screenshots skipped) → human review → complete, never waiting on the owner", async () => {
    const w = makeWorld({ persona: true, reviewArtifact: null });
    expect(runOf(w).preset).toBe("light");
    expect(ids(w)).toEqual(["start", "coding", "validation", "review", "live_check", "screenshot", "human_review", "complete"]);

    await advance(w, "start");
    await advance(w, "coding", EVIDENCE.coding);
    await advance(w, "validation", EVIDENCE.validationPass);
    const reviewed = await advance(w, "review", EVIDENCE.reviewClean);
    expect(reviewed.body.to).toBe("live_check");
    const checked = await advance(w, "live_check", LIVE_CHECK);
    expect(checked.status).toBe(200);
    expect(checked.body.skipped).toEqual([expect.objectContaining({ stageId: "screenshot" })]);
    expect(runOf(w).currentStage).toBe("human_review");

    submitPacket(w);
    const decided = await approveHumanReview(w);
    expect(decided.status).toBe(200);
    const run = runOf(w);
    expect(run.status).toBe("complete");
    expect(run.attempts.map((a) => a.stageId)).not.toContain("code_review");
    expect(run.attempts.map((a) => a.stageId)).not.toContain("deploy");
    expect(jobOf(w).status).toBe("active");
    expect(w.broadcasts.filter((m) => m.type === "persona:job").map((m) => (m.payload as { status: string }).status)).not.toContain(
      "waiting_user"
    );
  });

  test("a review held on wontfix findings is Persona's to accept, and its job stays active", async () => {
    const w = makeWorld({ persona: true, reviewArtifact: null });
    await advance(w, "start");
    await advance(w, "coding", EVIDENCE.coding);
    await advance(w, "validation", EVIDENCE.validationPass);
    await advance(w, "review", {
      reviewers: [
        { name: "r1", findings: [{ severity: "high", title: "schema drift", status: "wontfix" }] },
        { name: "r2", findings: [] },
      ],
    });
    expect(runOf(w)).toMatchObject({ currentStage: "review", status: "waiting_user", waitingKind: "owner_input" });
    expect(jobOf(w).status).toBe("active");
    const accepted = await acceptWontfixReview(
      w.store.db,
      w.run.id,
      { stage: "review", reason: "schema drift is tracked in its own ticket and out of scope for this change", actor: ACTOR },
      w.deps
    );
    expect(accepted.ok && accepted.to).toBe("live_check");
    expect(jobOf(w).status).toBe("active");
    expect(listPipelineDecisions(w.store.db, OWNER, { runId: w.run.id }).map((d) => d.kind)).toEqual(["accept_wontfix"]);
  });
});

describe("a full project's run", () => {
  /** To the code_review stage, with the packet the owner reviews in the Review tab. */
  async function toCodeReview(w: World) {
    await advance(w, "start");
    await advance(w, "coding", EVIDENCE.coding);
    await advance(w, "validation", EVIDENCE.validationPass);
    await advance(w, "review", EVIDENCE.reviewClean);
    submitPacket(w);
    await advance(w, "deploy", EVIDENCE.deploy);
    expect(runOf(w).currentStage).toBe("code_review");
  }

  test("keeps deploy, screenshots and code_review; Persona can't skip, waive or close out its code_review stage", async () => {
    const w = makeWorld({ persona: true });
    expect(ids(w)).toEqual(expect.arrayContaining(["deploy", "screenshot", "code_review"]));
    await toCodeReview(w);
    for (const kind of ["skip", "waive", "close_out"] as const) {
      const res = await decidePipelineStage(
        w.store.db,
        w.run.id,
        { stage: "code_review", kind, reason: "the code review is not needed for this small change, honestly it isn't", actor: ACTOR },
        w.deps
      );
      expect(res.ok).toBe(false);
      if (res.ok) continue;
      expect(res.status).toBe(409);
      expect(res.error).toContain("escalate");
    }
    expect(runOf(w).currentStage).toBe("code_review");
    expect(listPipelineDecisions(w.store.db, OWNER)).toEqual([]);
  });

  /** A full world whose screenshot stage doesn't auto-skip, driven to it with `files` changed. */
  async function atScreenshot(files: string[], uiPaths?: string[]) {
    const w = makeWorld({ persona: true, override: { stages: { screenshot: { skipWhen: [], ...(uiPaths ? { uiPaths } : {}) } } } });
    w.changed.files = files;
    await advance(w, "start");
    await advance(w, "coding", EVIDENCE.coding);
    await advance(w, "validation", EVIDENCE.validationPass);
    await advance(w, "review", EVIDENCE.reviewClean);
    await advance(w, "deploy", EVIDENCE.deploy);
    expect(runOf(w).currentStage).toBe("screenshot");
    submitPacket(w);
    return w;
  }

  test("Persona may skip screenshots of a change with no UI, recorded as its decision", async () => {
    const w = await atScreenshot(["packages/collector/src/x.ts"]);
    const res = await decidePipelineStage(
      w.store.db,
      w.run.id,
      { stage: "screenshot", kind: "skip", reason: "collector-only change, no UI", actor: ACTOR },
      w.deps
    );
    expect(res.ok && res.to).toBe("code_review");
    const attempt = runOf(w).attempts.filter((a) => a.stageId === "screenshot").at(-1)!;
    expect(attempt.status).toBe("skipped");
    expect(attempt.evidence).toEqual({ decision: { by: "persona", actor: ACTOR, kind: "skip", reason: "collector-only change, no UI" } });
    expect(listPipelineDecisions(w.store.db, OWNER, { runId: w.run.id })).toEqual([
      expect.objectContaining({ kind: "skip", stage: "screenshot", actor: ACTOR, jobId: jobOf(w).id }),
    ]);
  });

  test("Persona may not skip screenshots of a change that touches UI", async () => {
    const w = await atScreenshot(["packages/web/src/App.tsx"]);
    const res = await decidePipelineStage(
      w.store.db,
      w.run.id,
      { stage: "screenshot", kind: "skip", reason: "looks fine without screenshots", actor: ACTOR },
      w.deps
    );
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toContain("touches UI");
    expect(runOf(w).currentStage).toBe("screenshot");
  });

  test("UI paths narrowed on the stage don't hide a change to the default UI paths from that refusal", async () => {
    const w = await atScreenshot(["packages/web/src/App.tsx"], ["docs-site/**"]);
    const res = await decidePipelineStage(
      w.store.db,
      w.run.id,
      { stage: "screenshot", kind: "skip", reason: "the stage's UI paths say this change has no UI to show", actor: ACTOR },
      w.deps
    );
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toContain("touches UI (packages/web/src/App.tsx)");
  });

  /** A full world driven to its deploy stage with `files` changed. */
  async function atDeploy(files: string[]) {
    const w = makeWorld({ persona: true });
    w.changed.files = files;
    await advance(w, "start");
    await advance(w, "coding", EVIDENCE.coding);
    await advance(w, "validation", EVIDENCE.validationPass);
    await advance(w, "review", EVIDENCE.reviewClean);
    expect(runOf(w).currentStage).toBe("deploy");
    submitPacket(w);
    return w;
  }

  test("Persona may skip the deploy of a docs-and-tests change, not of a source change", async () => {
    const docs = await atDeploy(["README.md", "packages/collector/src/x.test.ts"]);
    const skipped = await decidePipelineStage(
      docs.store.db,
      docs.run.id,
      { stage: "deploy", kind: "skip", reason: "docs and tests only, nothing to deploy", actor: ACTOR },
      docs.deps
    );
    expect(skipped.ok).toBe(true);
    expect(runOf(docs).attempts.find((a) => a.stageId === "deploy")?.status).toBe("skipped");

    const code = await atDeploy(["packages/collector/src/x.ts"]);
    const refused = await decidePipelineStage(
      code.store.db,
      code.run.id,
      { stage: "deploy", kind: "skip", reason: "small change, deploy not needed", actor: ACTOR },
      code.deps
    );
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error).toContain("deployable code");
    // Nor can it be waived.
    const waived = await decidePipelineStage(
      code.store.db,
      code.run.id,
      { stage: "deploy", kind: "waive", reason: "small change, the deploy isn't worth it for a one-line fix", actor: ACTOR },
      code.deps
    );
    expect(waived.ok).toBe(false);
    expect(runOf(code).currentStage).toBe("deploy");
  });
});

describe("plain-words specs and layers", () => {
  test("a project spec drops code_review, and a later launch freezes it", async () => {
    const w = makeWorld();
    const put = await putConfig(w, { spec: "no code review, isolated live check, review packet" });
    expect(put.status).toBe(200);
    expect(put.body.ok).toBe(true);
    expect(put.body.preset).toEqual({ auto: "full", effective: "full" });
    expect(put.body.compiled.unknown).toEqual([]);
    const stages = (put.body.stages as Array<{ id: string }>).map((s) => s.id);
    expect(stages).toEqual(["coding", "validation", "review", "live_check", "screenshot", "human_review"]);
    expect(put.body.override.spec).toBe("no code review, isolated live check, review packet");

    const got = await w.app.request("/api/pipeline-config?project=proj", { headers: human(w) });
    const view = (await got.json()) as Record<string, any>;
    expect(view.preset).toEqual({ auto: "full", effective: "full" });
    expect((view.stages as Array<{ id: string }>).map((s) => s.id)).toEqual(stages);

    const launch = newLaunch(w);
    const run = startPipelineForLaunch(w.store.db, { launchId: launch.id, owner: OWNER, projectId: "proj" });
    expect(run.definition.stages.map((s) => s.id)).not.toContain("code_review");
    expect(run.definition.stages.map((s) => s.id)).toContain("live_check");
  });

  test("a spec clause the phrase table doesn't know is refused with 400, naming it", async () => {
    const w = makeWorld();
    const put = await putConfig(w, { spec: "no code review, frobnicate the widgets" });
    expect(put.status).toBe(400);
    expect(put.body.unknown).toEqual(["frobnicate the widgets"]);
    const byPersona = setPipelineLayerByPersona(
      w.store.db,
      OWNER,
      { scope: "project", projectId: "proj", spec: "frobnicate the widgets", reason: "the owner asked for it", actor: ACTOR },
      w.deps
    );
    expect(byPersona).toMatchObject({ ok: false, status: 400, unknown: ["frobnicate the widgets"] });
    const launch = await post(w, "/api/projects/proj/launch", { task: "x", pipelineSpec: "frobnicate the widgets" }, human(w));
    expect(launch.status).toBe(400);
    expect(((await launch.json()) as { unknown: string[] }).unknown).toEqual(["frobnicate the widgets"]);
  });

  test("a job layer set by Persona shapes the runs of the job's later launches", () => {
    const w = makeWorld({ persona: true });
    const job = jobOf(w);
    const set = setPipelineLayerByPersona(
      w.store.db,
      OWNER,
      {
        scope: "job",
        jobId: job.id,
        spec: "no screenshots",
        reason: "the job is a backend refactor",
        actor: ACTOR,
        ownerApproved: true,
        approvedWeakens: ["screenshot is removed"],
      },
      w.deps
    );
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    expect(set.stages.map((s) => s.id)).not.toContain("screenshot");
    expect(getPersonaJob(w.store.db, job.id)!.pipelineOverride).toMatchObject({ stages: { screenshot: { skip: true } } });

    const launch = newLaunch(w, job.id);
    const run = startPipelineForLaunch(w.store.db, { launchId: launch.id, owner: OWNER, projectId: "proj" });
    expect(run.definition.stages.map((s) => s.id)).not.toContain("screenshot");
    // A launch outside the job keeps the project's pipeline.
    const other = startPipelineForLaunch(w.store.db, { launchId: newLaunch(w).id, owner: OWNER, projectId: "proj" });
    expect(other.definition.stages.map((s) => s.id)).toContain("screenshot");
    // Another owner's job reads as none.
    const thread = getOrCreatePersonaConsoleThread(w.store.db, "bob");
    const bobs = createPersonaJob(w.store.db, { owner: "bob", threadId: thread.id, title: "B", goal: "b" });
    expect(
      setPipelineLayerByPersona(w.store.db, OWNER, { scope: "job", jobId: bobs.id, spec: "no code review", reason: "not mine at all", actor: ACTOR }, w.deps)
    ).toMatchObject({ ok: false, status: 404 });
    expect(listPipelineDecisions(w.store.db, OWNER, { jobId: job.id }).map((d) => d.kind)).toEqual(["config"]);
  });

  test("a launch layer replaces a run's definition while it is at coding, and is refused past it", async () => {
    const w = makeWorld({ persona: true });
    await advance(w, "start");
    expect(runOf(w).currentStage).toBe("coding");
    const set = setPipelineLayerByPersona(
      w.store.db,
      OWNER,
      {
        scope: "launch",
        sessionId: w.sessionId,
        spec: "no deploy",
        reason: "this launch only edits a script",
        actor: ACTOR,
        ownerApproved: true,
        approvedWeakens: ["deploy is removed"],
      },
      w.deps
    );
    expect(set.ok).toBe(true);
    const run = runOf(w);
    expect(run.definition.stages.map((s) => s.id)).not.toContain("deploy");
    expect(run.launchOverride).toMatchObject({ stages: { deploy: { skip: true } } });
    expect(run.currentStage).toBe("coding");
    expect(run.attempts.map((a) => a.stageId)).toEqual(["start"]);
    expect(listPipelineDecisions(w.store.db, OWNER, { runId: w.run.id })).toEqual([
      expect.objectContaining({ kind: "config", stage: "coding", detail: expect.objectContaining({ scope: "launch" }) }),
    ]);

    await advance(w, "coding", EVIDENCE.coding);
    const late = setPipelineLayerByPersona(
      w.store.db,
      OWNER,
      {
        scope: "launch",
        sessionId: w.sessionId,
        spec: "no screenshots",
        reason: "this launch only edits a script",
        actor: ACTOR,
        ownerApproved: true,
        approvedWeakens: ["screenshot is removed"],
      },
      w.deps
    );
    expect(late).toMatchObject({ ok: false, status: 409, error: "the run is past coding; change the job or project pipeline instead" });
  });

  test("the Persona-only routes refuse a request without a Persona credential", async () => {
    const w = makeWorld({ persona: true });
    for (const path of ["/api/pipeline/config", "/api/pipeline/decide"]) {
      expect((await post(w, path, { scope: "user", spec: "no code review", reason: "a good reason", sessionId: w.sessionId })).status).toBe(403);
      expect((await post(w, path, { scope: "user", spec: "no code review", reason: "a good reason", sessionId: w.sessionId }, human(w))).status).toBe(403);
    }
  });

  test("the owner reads their own Persona decisions", async () => {
    const w = makeWorld({ persona: true });
    setPipelineLayerByPersona(w.store.db, OWNER, { scope: "user", spec: "3 reviewers", reason: "the owner wants more eyes", actor: ACTOR }, w.deps);
    const res = await w.app.request("/api/pipeline/decisions", { headers: human(w) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { decisions: Array<{ kind: string }> }).decisions.map((d) => d.kind)).toEqual(["config"]);
    const bob = await w.app.request("/api/pipeline/decisions", { headers: human(w, "bob") });
    expect(((await bob.json()) as { decisions: unknown[] }).decisions).toEqual([]);
    expect((await w.app.request("/api/pipeline/decisions")).status).toBe(403);
  });
});
