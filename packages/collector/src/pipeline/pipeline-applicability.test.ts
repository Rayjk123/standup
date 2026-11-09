import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import { setActiveProjectLayout, workspaceProjectLayout } from "../project-layout/layout.js";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { createLaunch, getLaunch, getPipelineRun, getPipelineRunByLaunch, personaJobForLaunch, setLaunchReviewTokenHash } from "@standup/store";
import { WORKER_TOKEN_HEADER, incompleteRequiredStages, parseLaunchPipelineMode, pipelineWaivers, stageStates } from "@standup/shared";
import type { Launch } from "@standup/shared";
import { workerTokenHash } from "../floor/gate.js";
import { startLaunchPipeline } from "../launcher.js";
import { testTempDir } from "../test-support/temp-dirs.js";
import {
  advancePipeline,
  captureProvisionSnapshot,
  decidePipelineStage,
  launchAwaitsValidation,
  markRunWaiting,
  pipelineDoneRefusal,
  pipelineReadyBlock,
  waivePipelineStage,
} from "./engine.js";
import { changeFacts, gitChangedFiles, gitHeadState, launchChangedFiles } from "./runners.js";
import { EVIDENCE, OWNER, WORKTREE, advance, human, makeWorld, post, submitPacket, submitPacketAsWorker, type World } from "./test-world.js";

const runOf = (w: World) => getPipelineRun(w.store.db, w.run.id)!;

// Provisioned workspaces here hold their checkouts under pkgs/, each cloned on `trunk`.
beforeAll(() => setActiveProjectLayout(workspaceProjectLayout({ packagesDir: "pkgs", fallbackBase: "origin/trunk" })));
afterAll(() => setActiveProjectLayout());

const REASON = "read-only lookup; no code changed";

/** A fresh launch row in the world's project, for startLaunchPipeline. */
function newLaunch(w: World): Launch {
  return createLaunch(w.store.db, {
    id: randomUUID(),
    projectId: "proj",
    task: "look something up",
    worktreePath: `/tmp/standup-pipeline-test/${randomUUID()}`,
    branch: "standup/x",
    baseBranch: "main",
    requester: OWNER,
  });
}

/** The worker's pipeline_advance call with a not-applicable waiver. */
async function waive(w: World, stage: string, reason = REASON) {
  const res = await post(w, "/api/pipeline/advance", { session_id: w.sessionId, cwd: WORKTREE, stage, waive: { reason } });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

/**
 * Waives the run's current stage until it completes (or `max` waivers ran).
 * The launch's packet goes to the owner's Review tab first, since a worker's
 * waiver can't carry the run as far as code_review without one either.
 */
async function waiveToEnd(w: World, max = 10) {
  submitPacket(w);
  for (let i = 0; i < max && runOf(w).status !== "complete"; i++) {
    const res = await waive(w, runOf(w).currentStage);
    expect(res.status).toBe(200);
  }
}

describe("which launches get a pipeline by default", () => {
  const base = { reusedWorktree: false, scratch: false, requester: OWNER };

  test("a worktree launch of a project with a repo gets an active run", () => {
    const w = makeWorld();
    const run = startLaunchPipeline(w.store.db, newLaunch(w), { ...base });
    expect(run).toMatchObject({ status: "active", currentStage: "start" });
  });

  test("a scratch launch (no repo) gets no run, even when it asks for the default pipeline", () => {
    const w = makeWorld();
    expect(startLaunchPipeline(w.store.db, newLaunch(w), { ...base, scratch: true })).toBeNull();
    expect(startLaunchPipeline(w.store.db, newLaunch(w), { ...base, scratch: true, pipeline: "default" })).toBeNull();
  });

  test("a provisioned (no worktree) launch's run is off as not_coding, unless it asks for the default pipeline", () => {
    const w = makeWorld();
    const auto = startLaunchPipeline(w.store.db, newLaunch(w), { ...base, provisioned: true });
    expect(auto).toMatchObject({ status: "disabled", disabledReason: "not_coding" });
    const forced = startLaunchPipeline(w.store.db, newLaunch(w), { ...base, provisioned: true, pipeline: "default" });
    expect(forced).toMatchObject({ status: "active" });
  });

  test("a launch marked off (read-only, lookup, docs) records its run disabled as opt_out; false is the older form", () => {
    const w = makeWorld();
    expect(startLaunchPipeline(w.store.db, newLaunch(w), { ...base, pipeline: "off" })).toMatchObject({
      status: "disabled",
      disabledReason: "opt_out",
    });
    expect(startLaunchPipeline(w.store.db, newLaunch(w), { ...base, pipeline: false })).toMatchObject({
      status: "disabled",
      disabledReason: "opt_out",
    });
    expect(startLaunchPipeline(w.store.db, newLaunch(w), { ...base, pipeline: "off", attemptGroup: "g" })).toMatchObject({
      disabledReason: "attempt",
    });
  });

  test("a fixer's reused worktree gets no run", () => {
    const w = makeWorld();
    expect(startLaunchPipeline(w.store.db, newLaunch(w), { ...base, reusedWorktree: true })).toBeNull();
  });

  test("the launch option parses modes and the older booleans, and rejects anything else", () => {
    expect(parseLaunchPipelineMode(undefined)).toBeUndefined();
    expect(parseLaunchPipelineMode("off")).toBe("off");
    expect(parseLaunchPipelineMode("default")).toBe("default");
    expect(parseLaunchPipelineMode("auto")).toBe("auto");
    expect(parseLaunchPipelineMode(false)).toBe("off");
    expect(parseLaunchPipelineMode(true)).toBe("auto");
    expect(parseLaunchPipelineMode("on")).toBeNull();
    expect(parseLaunchPipelineMode(0)).toBeNull();
  });

  test("/api/launch refuses a pipeline value that is no mode", async () => {
    const w = makeWorld();
    const res = await post(w, "/api/launch", { task: "look it up", projectId: "proj", pipeline: "skip-it" }, human(w));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("pipeline must be");
  });
});

describe("a worker waives stages as not applicable", () => {
  test("a launch with no code change waives every stage to complete; each is recorded waived, never passed", async () => {
    const w = makeWorld();
    w.changed.files = [];
    await advance(w, "start");
    const first = await waive(w, "coding");
    expect(first.status).toBe(200);
    expect(first.body.outcome).toBe("waived");
    await waiveToEnd(w);
    const run = runOf(w);
    expect(run.status).toBe("complete");
    expect(incompleteRequiredStages(run.definition, run)).toEqual([]);
    const states = stageStates(run.definition, run);
    expect(states.coding!.state).toBe("waived");
    expect(states.validation!.state).toBe("waived");
    expect(states.review!.state).toBe("waived");
    expect(run.attempts.some((a) => a.status === "passed" && a.stageId !== "start")).toBe(false);
    const waivers = pipelineWaivers(run);
    expect(waivers[0]).toMatchObject({ stageId: "coding", by: "worker", actor: "worker", reason: REASON, notApplicable: true });
    expect(waivers.every((x) => x.notApplicable && x.by === "worker")).toBe(true);
  });

  test("a launch with code changes can't waive validation or review: refused, nothing recorded", async () => {
    const w = makeWorld();
    w.changed.files = ["packages/collector/src/x.ts"];
    await advance(w, "start");
    const atCoding = await waive(w, "coding");
    expect(atCoding.status).toBe(409);
    expect(atCoding.body.error).toContain("changes 1 file");
    await advance(w, "coding", EVIDENCE.coding);
    const before = runOf(w).attempts.length;
    const res = await waive(w, "validation");
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("packages/collector/src/x.ts");
    expect(runOf(w).attempts).toHaveLength(before);
    expect(runOf(w).currentStage).toBe("validation");
    await advance(w, "validation", EVIDENCE.validationPass);
    expect((await waive(w, "review")).status).toBe(409);
    expect(runOf(w).currentStage).toBe("review");
  });

  test("a change the worker reported is a code change even when git shows none now", async () => {
    const w = makeWorld();
    w.changed.files = [];
    await advance(w, "start");
    await advance(w, "coding", { summary: "edited it", changedFiles: ["src/a.ts"] });
    const res = await waive(w, "validation");
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("this run reported a code change (src/a.ts)");
  });

  test("a launch git can't read (a provisioned workspace) can't show it changed nothing: refused", async () => {
    const w = makeWorld();
    w.changed.files = null;
    await advance(w, "start");
    const res = await waive(w, "coding");
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("can't read this launch's checkout");
  });

  test("a waiver needs a real reason", async () => {
    const w = makeWorld();
    w.changed.files = [];
    await advance(w, "start");
    const res = await waive(w, "coding", "n/a");
    expect(res.status).toBe(422);
    expect(res.body.missing[0]).toContain("waive.reason");
    expect((await waive(w, "coding", "   ")).status).toBe(422);
  });

  test("an exhausted run stays the owner's to waive", async () => {
    const w = makeWorld();
    w.changed.files = [];
    await advance(w, "start");
    markRunWaiting(w.store.db, runOf(w), "budget ran out — needs you", "exhausted", w.deps);
    const res = await waive(w, "coding");
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("waiting on its owner");
    // The owner still can, in the console.
    const owner = await post(w, `/api/pipeline/runs/${w.run.id}/waive`, { stage: "coding", reason: "not needed" }, human(w));
    expect(owner.status).toBe(200);
    expect(pipelineWaivers(runOf(w))[0]).toMatchObject({ by: "owner", actor: OWNER, notApplicable: false });
  });

  test("waive can't ride along with evidence or a skip", async () => {
    const w = makeWorld();
    w.changed.files = [];
    await advance(w, "start");
    const res = await post(w, "/api/pipeline/advance", {
      session_id: w.sessionId,
      cwd: WORKTREE,
      stage: "coding",
      evidence: EVIDENCE.coding,
      waive: { reason: REASON },
    });
    expect(res.status).toBe(400);
  });

  test("code that appears after not-applicable waivers sends the run back to coding when the work is marked ready", async () => {
    const w = makeWorld();
    w.changed.files = [];
    await advance(w, "start");
    await waiveToEnd(w);
    expect(runOf(w).status).toBe("complete");
    expect(await pipelineReadyBlock(w.store.db, w.launch.id, w.deps)).toBeNull();

    w.changed.files = ["packages/collector/src/sneaky.ts"];
    const block = await pipelineReadyBlock(w.store.db, w.launch.id, w.deps);
    expect(block).toContain("waived as not applicable");
    const reopened = runOf(w);
    expect(reopened).toMatchObject({ status: "active", currentStage: "coding", epoch: 1 });
    // The old waivers stay on record; the new epoch must run the stages.
    expect(pipelineWaivers(reopened).length).toBeGreaterThan(0);
    expect(await pipelineReadyBlock(w.store.db, w.launch.id, w.deps)).toContain("Coding");
    expect((await waive(w, "coding")).status).toBe(409);
  });

  test("a run waived up to its code_review stage no longer waits on validation: the criterion runs from mark_ready_for_review", async () => {
    const w = makeWorld();
    w.changed.files = [];
    await advance(w, "start");
    expect(launchAwaitsValidation(w.store.db, w.launch.id)).toBe(true);
    for (let i = 0; i < 10 && runOf(w).currentStage !== "code_review"; i++) {
      expect((await waive(w, runOf(w).currentStage)).status).toBe(200);
    }
    expect(runOf(w)).toMatchObject({ status: "active", currentStage: "code_review" });
    expect(await pipelineReadyBlock(w.store.db, w.launch.id, w.deps)).toBeNull();
    expect(launchAwaitsValidation(w.store.db, w.launch.id)).toBe(false);
  });
});

describe("waivers are held to the checkout they were made on", () => {
  const SHA = "a".repeat(40);
  const OTHER = "b".repeat(40);

  test("a checkout with commits, switches or resets in its history can't waive (an in-place repo, or work moved off HEAD)", async () => {
    const w = makeWorld();
    w.changed.files = [];
    w.head.reflog = [`${SHA} checkout: moving from side to standup/thing`, `${OTHER} commit: side work`, `${SHA} `];
    await advance(w, "start");
    const res = await waive(w, "coding");
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("commit, switch or reset");
  });

  test("after the first waiver pins the checkout, any later move of HEAD refuses the next waiver", async () => {
    const w = makeWorld();
    w.changed.files = [];
    await advance(w, "start");
    expect((await waive(w, "coding")).status).toBe(200);
    expect(pipelineWaivers(runOf(w))).toHaveLength(1);
    // A commit on a side branch and a switch back: the tree is clean again, the reflog isn't.
    w.head.reflog = [`${SHA} checkout: moving from side to standup/thing`, `${OTHER} commit: side work`, ...w.head.reflog];
    const res = await waive(w, "validation");
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("has moved");
  });

  test("a run waived to complete can't be closed done once the launch changes code", async () => {
    const w = makeWorld({ persona: true });
    const jobId = personaJobForLaunch(w.store.db, w.launch.id)!.job.id;
    w.changed.files = [];
    await advance(w, "start");
    await waiveToEnd(w);
    expect(await pipelineDoneRefusal(w.store.db, jobId, w.deps)).toBeNull();
    w.head.head = OTHER;
    w.head.reflog = [`${OTHER} commit: the real change`, ...w.head.reflog];
    const refusal = await pipelineDoneRefusal(w.store.db, jobId, w.deps);
    expect(refusal).toContain("waived as not applicable");
    expect(refusal).toContain("has moved");
  });

  test("the worker's Stop sends a run waived to complete back to coding once it changes code, and blocks", async () => {
    const w = makeWorld();
    w.changed.files = [];
    await advance(w, "start");
    await waiveToEnd(w);
    w.changed.files = ["src/sneaky.ts"];
    const res = await post(w, "/hook", { session_id: w.sessionId, cwd: WORKTREE, hook_event_name: "Stop" });
    const out = (await res.json()) as { decision?: string; reason?: string };
    expect(runOf(w)).toMatchObject({ status: "active", currentStage: "coding", epoch: 1 });
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("Coding");
  });

  test("ready is held, not passed, when git can no longer read a waived run's checkout", async () => {
    const w = makeWorld();
    w.changed.files = [];
    await advance(w, "start");
    await waiveToEnd(w);
    w.changed.files = null;
    const block = await pipelineReadyBlock(w.store.db, w.launch.id, w.deps);
    expect(block).toContain("can't read this launch's checkout");
    expect(runOf(w).status).toBe("complete");
  });

  test("code after waivers on a run exhausted on the owner keeps the owner's wait instead of a fresh budget", async () => {
    const w = makeWorld();
    w.changed.files = [];
    await advance(w, "start");
    expect((await waive(w, "coding")).status).toBe(200);
    markRunWaiting(w.store.db, runOf(w), "budget ran out — needs you", "exhausted", w.deps);
    w.changed.files = ["src/a.ts"];
    const block = await pipelineReadyBlock(w.store.db, w.launch.id, w.deps);
    expect(block).toContain("waiting on its owner");
    expect(runOf(w)).toMatchObject({ status: "waiting_user", waitingKind: "exhausted", epoch: 0 });
  });
});

describe("Persona waives through its own route", () => {
  test("the route takes only a Persona credential", async () => {
    const w = makeWorld();
    w.changed.files = [];
    const anon = await post(w, "/api/pipeline/waive-not-applicable", { sessionId: w.sessionId, stage: "start", reason: REASON });
    expect(anon.status).toBe(403);
    const person = await post(w, "/api/pipeline/waive-not-applicable", { sessionId: w.sessionId, stage: "start", reason: REASON }, human(w));
    expect(person.status).toBe(403);
    expect(getPipelineRunByLaunch(w.store.db, w.launch.id)!.attempts).toHaveLength(0);
  });

  test("the engine records a Persona waiver as Persona's and holds it to the same no-change rule", async () => {
    const w = makeWorld();
    w.changed.files = ["src/real.ts"];
    await advance(w, "start");
    const refused = await waivePipelineStage(
      w.store.db,
      w.run.id,
      { stage: "coding", reason: REASON, actor: "alice's Persona", by: "persona" },
      w.deps
    );
    expect(refused.ok).toBe(false);
    w.changed.files = [];
    const ok = await waivePipelineStage(w.store.db, w.run.id, { stage: "coding", reason: REASON, actor: "alice's Persona", by: "persona" }, w.deps);
    expect(ok.ok).toBe(true);
    expect(pipelineWaivers(runOf(w))[0]).toMatchObject({ by: "persona", actor: "alice's Persona", notApplicable: true });
  });
});

describe("a provisioned workspace is read package by package", () => {
  const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };
  const git = (cwd: string, args: string[]) => {
    const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: GIT_ENV });
    if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
  };

  /** A workspace of several checkouts: a root that is no git repo, with packages cloned under pkgs/ on `trunk`. */
  function workspace(): string {
    const origin = testTempDir("standup-pkg-origin-");
    git(origin, ["init", "--initial-branch=trunk"]);
    writeFileSync(join(origin, "a.txt"), "a\n");
    git(origin, ["add", "."]);
    git(origin, ["commit", "-m", "first"]);
    const root = testTempDir("standup-workspace-");
    mkdirSync(join(root, "pkgs"));
    for (const pkg of ["pkg-a", "pkg-b"]) git(root, ["clone", "-q", origin, join("pkgs", pkg)]);
    return root;
  }

  const persona = (w: World, stage: string) =>
    waivePipelineStage(w.store.db, w.run.id, { stage, reason: REASON, actor: "alice's Persona", by: "persona" }, {
      ...w.deps,
      changedFiles: gitChangedFiles,
      headState: gitHeadState,
    });

  test("Persona waives a stage of a workspace launch that changed nothing, and is refused once a package changes", async () => {
    const root = workspace();
    const w = makeWorld({ worktree: root, provisioned: true });
    await advance(w, "start");
    const ok = await persona(w, "coding");
    expect(ok.ok).toBe(true);
    expect(pipelineWaivers(runOf(w))[0]).toMatchObject({ by: "persona", notApplicable: true });

    writeFileSync(join(root, "pkgs", "pkg-b", "draft.md"), "notes\n");
    const refused = await persona(w, "validation");
    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.error).toContain("this launch changes 1 file (pkgs/pkg-b/draft.md)");
  });

  test("a commit on a package's local trunk refuses the waiver, even with its reflog expired", async () => {
    const root = workspace();
    const pkg = join(root, "pkgs", "pkg-a");
    writeFileSync(join(pkg, "b.txt"), "b\n");
    git(pkg, ["add", "."]);
    git(pkg, ["commit", "-q", "-m", "work on trunk"]);
    git(pkg, ["reflog", "expire", "--expire=now", "--all"]);
    const w = makeWorld({ worktree: root, provisioned: true });
    await advance(w, "start");
    const refused = await persona(w, "coding");
    expect(refused.ok ? "" : refused.error).toContain("this launch changes 1 file (pkgs/pkg-a/b.txt)");
  });

  test("a switch in a package's history refuses the waiver", async () => {
    const root = workspace();
    const pkg = join(root, "pkgs", "pkg-a");
    git(pkg, ["checkout", "-q", "-b", "side"]);
    git(pkg, ["commit", "-q", "--allow-empty", "-m", "side"]);
    git(pkg, ["checkout", "-q", "trunk"]);
    const w = makeWorld({ worktree: root, provisioned: true });
    await advance(w, "start");
    const refused = await persona(w, "coding");
    expect(refused.ok ? "" : refused.error).toContain("commit, switch or reset");
  });

  test("after a waiver pins the workspace, a package added or re-cloned refuses the next one", async () => {
    const root = workspace();
    const w = makeWorld({ worktree: root, provisioned: true });
    await advance(w, "start");
    expect((await persona(w, "coding")).ok).toBe(true);
    const origin = testTempDir("standup-pkg-origin-");
    git(origin, ["init", "-q", "--initial-branch=trunk"]);
    git(origin, ["commit", "-q", "--allow-empty", "-m", "first"]);
    git(root, ["clone", "-q", origin, join("pkgs", "pkg-c")]);
    const added = await persona(w, "validation");
    expect(added.ok ? "" : added.error).toContain("has moved");

    const again = workspace();
    const w2 = makeWorld({ worktree: again, provisioned: true });
    await advance(w2, "start");
    expect((await persona(w2, "coding")).ok).toBe(true);
    const pkg = join(again, "pkgs", "pkg-a");
    const url = Bun.spawnSync(["git", "remote", "get-url", "origin"], { cwd: pkg }).stdout.toString().trim();
    rmSync(pkg, { recursive: true, force: true });
    git(again, ["clone", "-q", url, join("pkgs", "pkg-a")]);
    const recloned = await persona(w2, "validation");
    expect(recloned.ok ? "" : recloned.error).toContain("has moved");
  });

  test("a worktree launch still pins its bare HEAD and reflog length", async () => {
    const w = makeWorld();
    w.changed.files = [];
    await advance(w, "start");
    expect((await waive(w, "coding")).status).toBe(200);
    const waived = runOf(w).attempts.find((a) => a.status === "waived")!;
    expect((waived.evidence as { waiver: { checkout: unknown } }).waiver.checkout).toEqual({ head: "a".repeat(40), reflog: 1 });
  });

  test("a workspace with no package checked out still can't show it changed nothing", async () => {
    const w = makeWorld({ worktree: testTempDir("standup-empty-workspace-"), provisioned: true });
    await advance(w, "start");
    const refused = await persona(w, "coding");
    expect(refused.ok ? "" : refused.error).toContain("no package checked out");
  });

  const realGit = (w: World) => ({ ...w.deps, changedFiles: gitChangedFiles, headState: gitHeadState });
  const decide = (w: World, stage: string, kind: "skip" | "waive" | "close_out") =>
    decidePipelineStage(w.store.db, w.run.id, { stage, kind, reason: "nothing in this stage applies to a workspace lookup", actor: "alice's Persona" }, realGit(w));
  /** A full-run world on a fresh workspace, at `stage`, every stage before it waived by Persona as not applicable. */
  async function workspaceAt(stage: string) {
    const root = workspace();
    const w = makeWorld({ worktree: root, provisioned: true, persona: true });
    w.changed.files = [];
    await advance(w, "start");
    while (runOf(w).currentStage !== stage) {
      const res = await persona(w, runOf(w).currentStage);
      expect(res.ok ? "" : res.error).toBe("");
    }
    return { root, w };
  }
  /** Moves `pkg`'s origin on a commit and fast-forwards `pkg` to it, as a provision step's pull does. */
  function pullNewCommit(pkg: string) {
    const url = Bun.spawnSync(["git", "remote", "get-url", "origin"], { cwd: pkg }).stdout.toString().trim();
    git(url, ["commit", "-q", "--allow-empty", "-m", "upstream"]);
    git(pkg, ["pull", "-q", "--ff-only"]);
  }

  test("Persona's skip and waive decisions read a clean workspace package by package", async () => {
    const w = makeWorld({ worktree: workspace(), provisioned: true, persona: true, override: { stages: { screenshot: { skipWhen: [] } } } });
    w.changed.files = [];
    await advance(w, "start");
    const decided: string[] = [];
    while (runOf(w).currentStage !== "code_review") {
      const stage = runOf(w).currentStage;
      const kind = stage === "validation" || stage === "deploy" || stage === "screenshot" ? "skip" : stage === "review" ? "waive" : null;
      const res = kind ? await decide(w, stage, kind) : await persona(w, stage);
      expect(`${stage}: ${res.ok ? "" : res.error}`).toBe(`${stage}: `);
      if (kind) decided.push(stage);
    }
    expect(decided).toEqual(expect.arrayContaining(["validation", "deploy", "screenshot"]));
  });

  test("Persona is still refused a full run's deploy once a package has deployable code", async () => {
    const { root, w } = await workspaceAt("validation");
    expect((await decide(w, "validation", "skip")).ok).toBe(true);
    while (runOf(w).currentStage !== "deploy") expect((await persona(w, runOf(w).currentStage)).ok).toBe(true);
    writeFileSync(join(root, "pkgs", "pkg-a", "Handler.java"), "class Handler {}\n");
    const res = await decide(w, "deploy", "skip");
    expect(res.ok ? "" : res.error).toContain("deployable code (pkgs/pkg-a/Handler.java)");
  });

  test("protected stages stay the owner's on a workspace: Persona can't waive code_review or human_review", async () => {
    const root = workspace();
    const w = makeWorld({ worktree: root, provisioned: true, persona: true });
    w.changed.files = [];
    await advance(w, "start");
    let refused: Awaited<ReturnType<typeof persona>> | null = null;
    for (let i = 0; i < 12 && !refused; i++) {
      const res = await persona(w, runOf(w).currentStage);
      if (!res.ok) refused = res;
    }
    expect(["code_review", "human_review"]).toContain(runOf(w).currentStage);
    expect(refused && !refused.ok ? refused.error : "").toContain("can't be waived by Persona");
  });

  test("a workspace's facts come from its packages, not only the worker's list", async () => {
    const root = workspace();
    const w = makeWorld({ worktree: root, provisioned: true });
    writeFileSync(join(root, "pkgs", "pkg-a", "Foo.java"), "class Foo {}\n");
    writeFileSync(join(root, "pkgs", "pkg-b", "App.tsx"), "export {};\n");
    const { facts, files, fromGit } = await changeFacts(getLaunch(w.store.db, w.launch.id), ["README.md"], undefined, realGit(w));
    expect(fromGit).toBe(true);
    expect(files).toEqual(expect.arrayContaining(["pkgs/pkg-a/Foo.java", "pkgs/pkg-b/App.tsx", "README.md"]));
    expect(facts).toEqual({ docs_only: false, ui_changed: true });
  });

  test("a pull provisioning ran is the baseline, not a move; a new branch after it is fine, a commit after it refuses", async () => {
    const root = workspace();
    const pkg = join(root, "pkgs", "pkg-a");
    pullNewCommit(pkg);
    const unsnapped = makeWorld({ worktree: root, provisioned: true });
    await advance(unsnapped, "start");
    expect(((r) => (r.ok ? "" : r.error))(await persona(unsnapped, "coding"))).toContain("commit, switch or reset");

    const w = makeWorld({ worktree: root, provisioned: true });
    expect(await captureProvisionSnapshot(w.store.db, w.launch.id)).not.toBeNull();
    await advance(w, "start");
    expect(((r) => (r.ok ? "" : r.error))(await persona(w, "coding"))).toBe("");

    const fresh = workspace();
    pullNewCommit(join(fresh, "pkgs", "pkg-a"));
    const w2 = makeWorld({ worktree: fresh, provisioned: true });
    await captureProvisionSnapshot(w2.store.db, w2.launch.id);
    const pkgB = join(fresh, "pkgs", "pkg-b");
    git(pkgB, ["checkout", "-q", "-b", "feature"]);
    await advance(w2, "start");
    expect(((r) => (r.ok ? "" : r.error))(await persona(w2, "coding"))).toBe("");

    const third = workspace();
    const w3 = makeWorld({ worktree: third, provisioned: true });
    await captureProvisionSnapshot(w3.store.db, w3.launch.id);
    const pkg3 = join(third, "pkgs", "pkg-b");
    git(pkg3, ["checkout", "-q", "-b", "side"]);
    git(pkg3, ["commit", "-q", "--allow-empty", "-m", "side"]);
    git(pkg3, ["checkout", "-q", "trunk"]);
    await advance(w3, "start");
    expect(((r) => (r.ok ? "" : r.error))(await persona(w3, "coding"))).toContain("has 1 commit, switch or reset since it was provisioned");
  });

  test("files setup left changed don't count while untouched; edited or committed, they do", async () => {
    const root = workspace();
    const lock = join(root, "pkgs", "pkg-a", "setup.lock");
    writeFileSync(lock, "generated\n");
    writeFileSync(join(root, "pkgs", "pkg-b", "a.txt"), "rewritten by setup\n");
    const w = makeWorld({ worktree: root, provisioned: true });
    const snapshot = await captureProvisionSnapshot(w.store.db, w.launch.id);
    expect(Object.keys(snapshot!.dirty).sort()).toEqual(["pkgs/pkg-a/setup.lock", "pkgs/pkg-b/a.txt"]);
    expect(getLaunch(w.store.db, w.launch.id)?.provisionSnapshot).toEqual(snapshot!);
    await advance(w, "start");
    expect(((r) => (r.ok ? "" : r.error))(await persona(w, "coding"))).toBe("");

    writeFileSync(lock, "edited by the worker\n");
    expect(((r) => (r.ok ? "" : r.error))(await persona(w, "validation"))).toContain("this launch changes 1 file (pkgs/pkg-a/setup.lock)");

    writeFileSync(lock, "generated\n");
    git(join(root, "pkgs", "pkg-a"), ["add", "setup.lock"]);
    git(join(root, "pkgs", "pkg-a"), ["commit", "-q", "-m", "commit the setup file"]);
    expect(((r) => (r.ok ? "" : r.error))(await persona(w, "validation"))).toContain("has moved");
  });

  test.each([
    ["an untracked nested repo", (pkg: string) => {
      mkdirSync(join(pkg, "vendor"));
      git(join(pkg, "vendor"), ["init", "-q"]);
      writeFileSync(join(pkg, "vendor", "lib.java"), "class Lib {}\n");
      return () => writeFileSync(join(pkg, "vendor", "lib.java"), "class Lib { int x; }\n");
    }, "pkgs/pkg-a/vendor/"],
    ["a file whose name git quotes", (pkg: string) => {
      writeFileSync(join(pkg, "café.java"), "class A {}\n");
      return () => writeFileSync(join(pkg, "café.java"), "class A { int x; }\n");
    }, "pkgs/pkg-a/"],
  ])("%s setup left is never discounted as unchanged", async (_label, setup, named) => {
    const root = workspace();
    const pkg = join(root, "pkgs", "pkg-a");
    const edit = setup(pkg);
    const w = makeWorld({ worktree: root, provisioned: true });
    const snapshot = await captureProvisionSnapshot(w.store.db, w.launch.id);
    expect(snapshot!.dirty).toEqual({});
    edit();
    await advance(w, "start");
    expect(((r) => (r.ok ? "" : r.error))(await persona(w, "coding"))).toContain(named);
  });

  test("a mode change to a file setup left changed counts", async () => {
    const root = workspace();
    const script = join(root, "pkgs", "pkg-a", "setup.sh");
    writeFileSync(script, "echo hi\n");
    const w = makeWorld({ worktree: root, provisioned: true });
    await captureProvisionSnapshot(w.store.db, w.launch.id);
    chmodSync(script, 0o755);
    await advance(w, "start");
    expect(((r) => (r.ok ? "" : r.error))(await persona(w, "coding"))).toContain("pkgs/pkg-a/setup.sh");
  });

  test("a validation check whose paths are anchored at a package's root runs for a change in that package", async () => {
    const root = workspace();
    const w = makeWorld({
      worktree: root,
      provisioned: true,
      projectOverride: { stages: { validation: { checks: [{ command: "check-lib", paths: ["lib/**"] }, { command: "check-docs", paths: ["docs/**"] }] } } },
    });
    mkdirSync(join(root, "pkgs", "pkg-a", "lib"));
    writeFileSync(join(root, "pkgs", "pkg-a", "lib", "x.ts"), "export {};\n");
    const ran: string[] = [];
    const deps = { ...realGit(w), runCheck: async (_l: unknown, command: string) => (ran.push(command), { met: true, output: "ok" }) };
    w.changed.files = [];
    await advance(w, "start");
    await advancePipeline(w.store.db, w.run.id, { stage: "coding", evidence: EVIDENCE.coding }, deps);
    await advancePipeline(w.store.db, w.run.id, { stage: "validation", evidence: EVIDENCE.validationPass }, deps);
    expect(ran).toEqual(["check-lib"]);
  });

  test("a snapshot's reflog with older entries deleted counts as moved, even at the same length and HEAD", async () => {
    const root = workspace();
    const pkg = join(root, "pkgs", "pkg-a");
    pullNewCommit(pkg);
    pullNewCommit(pkg);
    const w = makeWorld({ worktree: root, provisioned: true });
    await captureProvisionSnapshot(w.store.db, w.launch.id);
    const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: pkg }).stdout.toString().trim();
    git(pkg, ["commit", "-q", "--allow-empty", "-m", "worker"]);
    git(pkg, ["reset", "-q", "--hard", head]);
    git(pkg, ["reflog", "delete", "HEAD@{4}"]);
    git(pkg, ["reflog", "delete", "HEAD@{3}"]);
    await advance(w, "start");
    expect(((r) => (r.ok ? "" : r.error))(await persona(w, "coding"))).toContain("since it was provisioned");
  });

  test("a glob anchored at a package's root matches its files on a workspace", async () => {
    const root = workspace();
    const w = makeWorld({ worktree: root, provisioned: true });
    mkdirSync(join(root, "pkgs", "pkg-a", "website"));
    writeFileSync(join(root, "pkgs", "pkg-a", "website", "page.js"), "1;\n");
    const { facts } = await changeFacts(getLaunch(w.store.db, w.launch.id), [], ["website/**"], realGit(w));
    expect(facts?.ui_changed).toBe(true);
  });

  test("a broken link under pkgs/ fails its own read instead of hiding every package", async () => {
    const root = workspace();
    symlinkSync(join(root, "nowhere"), join(root, "pkgs", "dangling"));
    const w = makeWorld({ worktree: root, provisioned: true });
    await advance(w, "start");
    expect(((r) => (r.ok ? "" : r.error))(await persona(w, "coding"))).toContain("checkout pkgs/dangling");
  });

  test("without origin/HEAD a package is read against origin/trunk, so a pushed side branch still shows", async () => {
    const root = workspace();
    const pkg = join(root, "pkgs", "pkg-a");
    git(pkg, ["remote", "set-head", "origin", "-d"]);
    git(pkg, ["checkout", "-q", "-b", "side"]);
    writeFileSync(join(pkg, "b.txt"), "b\n");
    git(pkg, ["add", "."]);
    git(pkg, ["commit", "-q", "-m", "work"]);
    git(pkg, ["push", "-q", "-u", "origin", "side"]);
    const w = makeWorld({ worktree: root, provisioned: true });
    expect(await launchChangedFiles(getLaunch(w.store.db, w.launch.id)!, gitChangedFiles)).toEqual(["pkgs/pkg-a/b.txt"]);
  });

  test("a dir under pkgs/ that isn't a git checkout refuses the waiver instead of going unread", async () => {
    const root = workspace();
    mkdirSync(join(root, "pkgs", "loose"));
    writeFileSync(join(root, "pkgs", "loose", "Main.java"), "class Main {}\n");
    const w = makeWorld({ worktree: root, provisioned: true });
    await advance(w, "start");
    expect(((r) => (r.ok ? "" : r.error))(await persona(w, "coding"))).toContain("can't read this launch's checkout pkgs/loose");
  });

  test("a package whose remote has no default branch is read against origin/trunk", async () => {
    const root = workspace();
    const pkg = join(root, "pkgs", "pkg-a");
    git(pkg, ["remote", "set-head", "origin", "-d"]);
    const w = makeWorld({ worktree: root, provisioned: true });
    await advance(w, "start");
    expect(((r) => (r.ok ? "" : r.error))(await persona(w, "coding"))).toBe("");
    writeFileSync(join(pkg, "b.txt"), "b\n");
    git(pkg, ["add", "."]);
    git(pkg, ["commit", "-q", "-m", "work"]);
    git(pkg, ["reflog", "expire", "--expire=now", "--all"]);
    expect(((r) => (r.ok ? "" : r.error))(await persona(w, "validation"))).toContain("pkgs/pkg-a/b.txt");
  });
});

describe("a reviewed project's launch with no enabled run owes its code review only for code", () => {
  test("pipeline off: a draft-only packet is accepted without a code review; once the launch changes code it is refused", async () => {
    const w = makeWorld({ disabled: true });
    w.changed.files = [];
    expect((await submitPacketAsWorker(w)).status).toBe(200);
    w.changed.files = ["pkgs/pkg-a/x.ts"];
    const refused = await submitPacketAsWorker(w);
    expect(refused.status).toBe(400);
    expect(refused.body.reason).toBe("review-required");
  });

  test("no run at all: the same rule; a checkout git can't read still owes the code review", async () => {
    const w = makeWorld({ disabled: true });
    w.store.db.run("DELETE FROM pipeline_runs WHERE id = ?", [w.run.id]);
    w.changed.files = [];
    expect((await submitPacketAsWorker(w)).status).toBe(200);
    w.changed.files = null;
    const refused = await submitPacketAsWorker(w);
    expect(refused.status).toBe(400);
    expect(refused.body.reason).toBe("review-required");
  });

  test("the brief asks a code-free launch for no code review", async () => {
    const w = makeWorld({ disabled: true });
    const brief = async () => {
      const token = `review-token-${randomUUID()}`;
      setLaunchReviewTokenHash(w.store.db, w.launch.id, workerTokenHash(token));
      const res = await w.app.request(`/api/reviews/brief?session_id=${w.sessionId}`, { headers: { [WORKER_TOKEN_HEADER]: token } });
      return ((await res.json()) as { brief: string }).brief;
    };
    expect(await brief()).toContain("Open the code review first");
    w.changed.files = [];
    expect(await brief()).not.toContain("Code review:");
  });
});
