import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createLaunch, createStore, getProject, upsertProject, type Store } from "@standup/store";
import type { CodeReviewAdapterId, PipelineRun, Project } from "@standup/shared";
import { reviewLinkFormats, runsCodeReview } from "../board/projection.js";
import { DEFAULT_ORG_PROFILE } from "../org-profile/default.js";
import { exampleCorpProfile } from "../org-profile/fixtures/example-corp.js";
import { setActiveOrgProfile } from "../org-profile/load.js";
import { autoPipelinePreset, codeReviewAdapterLayer, projectSeedLayer } from "../pipeline/engine.js";
import { codeReviewNotApplicable } from "../pipeline/runners.js";
import { composeReviewArtifact } from "../review-artifact.js";
import { projectReviewLinkFormat, resolveProjectCodeReview } from "../code-review/adapter.js";
import { codeReviewRequirement, projectCheckoutRemotes, projectCodeReview } from "./code-review-requirement.js";
import { defaultGitRunner, type GitRunner } from "./stage.js";

const CORP = exampleCorpProfile();
const CORP_REMOTE = "ssh://git@code.example.corp/repos/thing";
const GITHUB_REMOTE = "https://github.com/example/plain.git";

const dirs: string[] = [];

/** A throwaway git checkout under the OS temp dir whose `origin` is `remote`. */
function checkout(remote: string): string {
  const dir = mkdtempSync(join(tmpdir(), "standup-review-remote-"));
  dirs.push(dir);
  const git = (...args: string[]) => Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  git("init", "-q");
  git("remote", "add", "origin", remote);
  return dir;
}

let store: Store;
let corpRepo: string;
let githubRepo: string;

beforeAll(() => {
  setActiveOrgProfile(CORP);
  store = createStore(":memory:");
  corpRepo = checkout(CORP_REMOTE);
  githubRepo = checkout(GITHUB_REMOTE);
});

afterAll(() => {
  setActiveOrgProfile();
  store.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function register(id: string, overrides: Partial<Project> = {}): Project {
  upsertProject(store.db, { id, name: id, branch: "main", repos: [], ...overrides });
  return getProject(store.db, id)!;
}

function launchIn(id: string, projectId: string, worktreePath: string): string {
  createLaunch(store.db, { id, projectId, task: "t", worktreePath, branch: `b-${id}`, baseBranch: "main", tmuxSession: `tmux-${id}` });
  return id;
}

const ctx = (worktreePath: string) => ({ worktreePath, title: "Fix the widget", body: "It double-counted.", participants: [], branch: "b" });

/** The real git runner, counting the git commands it runs. */
function countingGit(): { git: GitRunner; calls: () => number } {
  let n = 0;
  const git: GitRunner = (args, cwd) => {
    n++;
    return defaultGitRunner(args, cwd);
  };
  return { git, calls: () => n };
}

/** A run of `projectId` whose code_review stage passed with `evidence`. */
function codeReviewRun(projectId: string, evidence: Record<string, unknown>): PipelineRun {
  return {
    id: `run-${projectId}`,
    projectId,
    launchId: `launch-${projectId}`,
    currentStage: "human_review",
    definition: { stages: [{ id: "code_review", kind: "code_review" }] },
    attempts: [{ stageId: "code_review", status: "passed", attempt: 1, createdAt: "2026-01-01T00:00:00.000Z", evidence }],
  } as unknown as PipelineRun;
}

describe("a remote-owned project's code review comes from one adapter", () => {
  test("a registered repo on the org's code host: issue-id ask, composed cut and link format all come from the org's review tool", async () => {
    const project = register("remote-owned", { repos: [corpRepo] });
    const review = projectCodeReview(store.db, project);
    expect(review.adapter?.id).toBe("generic");
    expect(review.requiresIssueId).toBe(true);
    expect(review.linkFormat).toEqual(CORP.codeReview.linkFormat);
    expect(review.requiresLinkedReview).toBe(false);

    // The pipeline's issue-id ask reads the same remotes and agrees.
    expect(codeReviewAdapterLayer(store.db, project.id)).toEqual({ stages: { code_review: { ownerInput: "issue_id" } } });

    const composed = await composeReviewArtifact(project, ctx(corpRepo), { dryRun: true }, { remotes: projectCheckoutRemotes(store.db, project) });
    expect(composed?.providerId).toBe("generic");
    expect(composed?.command).toContain("corp-review");
    expect(composed?.command).not.toContain("gh pr create");
    expect(composed?.placeholders.some((ph) => ph.includes("<issue-id>"))).toBe(true);
    expect(review.adapter!.howToCut({ prior: null })).toContain("corp-review --issue '<issue-id>'");
    expect(projectReviewLinkFormat(project, { remotes: projectCheckoutRemotes(store.db, project) })).toEqual(CORP.codeReview.linkFormat);
  });

  test("a repo-less project launched on the org's code host resolves the org's review tool from the launch's checkout", async () => {
    const project = register("launched-remote-owned");
    expect(projectCodeReview(store.db, project).adapter).toBeNull();
    const launchId = launchIn("L-remote", project.id, corpRepo);
    const review = projectCodeReview(store.db, project, { checkout: corpRepo });
    expect(review.adapter?.id).toBe("generic");
    expect(review.requiresIssueId).toBe(true);
    expect(codeReviewAdapterLayer(store.db, project.id, { checkout: corpRepo })).not.toBeNull();
    // An unpinned remote-owned project's packets don't have to link the review.
    expect(codeReviewRequirement(store.db, project.id, launchId)).toBeNull();
  });

  test("a project on GitHub keeps the pull-request adapter everywhere", async () => {
    const project = register("on-github", { repos: [githubRepo] });
    const review = projectCodeReview(store.db, project);
    expect(review.adapter?.id).toBe("github-pr");
    expect(review.requiresIssueId).toBe(false);
    expect(review.linkFormat).toEqual({});
    expect(codeReviewAdapterLayer(store.db, project.id)).toBeNull();
    const composed = await composeReviewArtifact(project, ctx(githubRepo), { dryRun: true }, { remotes: projectCheckoutRemotes(store.db, project) });
    expect(composed?.command).toContain("gh pr create");
  });

  test("a pin wins over the checkout's remotes, and its requirement reads no remotes", () => {
    const pinned = register("pinned-github", { repos: [corpRepo], codeReviewAdapter: "github-pr" });
    expect(projectCodeReview(store.db, pinned).adapter?.id).toBe("github-pr");
    expect(codeReviewAdapterLayer(store.db, pinned.id)).toBeNull();

    const generic = register("pinned-generic", { repos: [githubRepo], codeReviewAdapter: "generic" });
    const launchId = launchIn("L-pinned", generic.id, githubRepo);
    let reads = 0;
    const git: GitRunner = () => {
      reads++;
      return null;
    };
    const need = codeReviewRequirement(store.db, generic.id, launchId, { git });
    expect(need?.adapter.id).toBe("generic");
    expect(need?.howToCut).toContain("corp-review --issue '<issue-id>'");
    expect(reads).toBe(0);
  });

  test("the board reads a remote-owned project's recorded review under the org's link format", () => {
    const project = register("board-remote-owned", { repos: [corpRepo] });
    const formatOf = reviewLinkFormats(store.db);
    expect(formatOf(project.id)).toEqual(CORP.codeReview.linkFormat);
    // A bare review id gets the org's review page, as compose and the cut command name it.
    expect(runsCodeReview([codeReviewRun(project.id, { reviewId: "R-42" })], formatOf)).toEqual({
      id: "R-42",
      url: "https://code.example.corp/reviews/R-42",
    });

    const github = register("board-github", { repos: [githubRepo] });
    expect(reviewLinkFormats(store.db)(github.id)).toEqual({});
    expect(runsCodeReview([codeReviewRun(github.id, { reviewId: "R-42" })], reviewLinkFormats(store.db))).toEqual({ id: "R-42" });
  });

  test("one reader of the checkouts' remotes serves the pipeline's issue-id ask and its preset, reading git once", () => {
    const project = register("shared-read", { repos: [corpRepo] });
    const { git, calls } = countingGit();
    const remotes = projectCheckoutRemotes(store.db, project, { git });
    expect(calls()).toBe(0);
    expect(projectSeedLayer(store.db, project.id, { remotes })).toEqual({ stages: { code_review: { ownerInput: "issue_id" } } });
    const afterFirst = calls();
    expect(afterFirst).toBeGreaterThan(0);
    expect(autoPipelinePreset(store.db, project.id, { remotes })).toBe("full");
    expect(projectCodeReview(store.db, project, { remotes }).adapter?.id).toBe("generic");
    expect(calls()).toBe(afterFirst);
  });

  test("codeReviewNotApplicable keeps the code_review stage of a remote-owned project and drops a plain GitHub one's", () => {
    const owned = register("na-remote-owned", { repos: [corpRepo] });
    expect(codeReviewNotApplicable(store.db, codeReviewRun(owned.id, {}), null)).toBeNull();
    const github = register("na-github", { repos: [githubRepo] });
    expect(codeReviewNotApplicable(store.db, codeReviewRun(github.id, {}), null)).toContain("not applicable");
  });
});

describe("a profile where no adapter owns a remote resolves without reading git", () => {
  beforeAll(() => setActiveOrgProfile(DEFAULT_ORG_PROFILE));
  afterAll(() => setActiveOrgProfile(CORP));

  test("an unpinned GitHub project: its adapter, its packet requirement and its board link format spawn no git", () => {
    const project = register("default-github", { repos: [githubRepo] });
    const launchId = launchIn("L-default", project.id, githubRepo);
    const { git, calls } = countingGit();
    expect(projectCodeReview(store.db, project, { checkout: githubRepo, git }).adapter?.id).toBe("github-pr");
    expect(codeReviewRequirement(store.db, project.id, launchId, { git })).toBeNull();
    expect(reviewLinkFormats(store.db, { git })(project.id)).toEqual({});
    expect(calls()).toBe(0);
  });

  test("the same project under a profile with remote patterns does read its remotes", () => {
    const project = register("corp-github", { repos: [githubRepo] });
    const { git, calls } = countingGit();
    expect(projectCodeReview(store.db, project, { git, profile: CORP }).adapter?.id).toBe("github-pr");
    expect(calls()).toBeGreaterThan(0);
  });
});

describe("resolveProjectCodeReview reads a project's remotes at most once", () => {
  const project: Project = { id: "p", name: "p", branch: "main", repos: ["/r"] };
  const cases: Array<[string, Partial<Project>, number, CodeReviewAdapterId | null]> = [
    // name, project, remote reads, adapter
    ["unpinned, not detected", {}, 1, "generic"],
    ["pinned", { codeReviewAdapter: "github-pr" }, 0, "github-pr"],
    ["detected by the first adapter", { provision: "corp-provision x" }, 0, "generic"],
  ];
  for (const [name, overrides, expectedReads, adapter] of cases) {
    test(name, () => {
      let reads = 0;
      const remotes = () => {
        reads++;
        return [CORP_REMOTE];
      };
      const review = resolveProjectCodeReview({ ...project, ...overrides }, { remotes, profile: CORP });
      expect(review.adapter?.id ?? null).toBe(adapter);
      expect(reads).toBe(expectedReads);
    });
  }

  test("a profile no adapter of which owns a remote never calls the reader", () => {
    let reads = 0;
    const remotes = () => {
      reads++;
      return [CORP_REMOTE];
    };
    expect(resolveProjectCodeReview(project, { remotes, profile: DEFAULT_ORG_PROFILE }).adapter?.id).toBe("github-pr");
    expect(resolveProjectCodeReview({ ...project, repos: [] }, { remotes, profile: DEFAULT_ORG_PROFILE }).adapter).toBeNull();
    expect(reads).toBe(0);
  });

  test("no project resolves no adapter", () => {
    expect(resolveProjectCodeReview(null, { profile: CORP })).toEqual({
      adapter: null,
      requiresLinkedReview: false,
      requiresIssueId: false,
      linkFormat: {},
    });
  });
});
