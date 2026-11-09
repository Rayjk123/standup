import { expect, test, describe } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createStore, createLaunch, setSetting, upsertProject } from "@standup/store";
import { KnowledgeStore, UNVERIFIABLE_VERDICT, type KnowledgeDocFile } from "@standup/knowledge";
import { GLOBAL_PROJECT_ID } from "@standup/shared";
import {
  absolutePathsIn,
  dbRepoOwnership,
  dbVerificationInputs,
  disputedDocRows,
  isWrongRepoDispute,
  noResolvableRepoReason,
  projectsNamedIn,
  repairWrongRepoDisputesInDb,
  repoBelongsToProject,
  repoMayServeProject,
  repoOwners,
  resolveVerificationRepo,
  retryRepoFor,
  type RepoOwnership,
} from "./knowledge-verify-repos.js";
import { retryPendingVerifications, type PublishVerifyDeps } from "./knowledge-publish-verify.js";
import { WORKTREE_ROOT_SETTING } from "./launcher.js";
import type { DraftDispute } from "./draft-verify.js";

/** Projects on a fake host: `billing` and `standup` with one repo each, `named`
 *  with a repo whose directory name is distinctive, `bare` with none. */
const REPOS: Record<string, string[]> = {
  billing: ["/repos/billing/packages/BillingControlPlane"],
  standup: ["/repos/standup"],
  named: ["/repos/OrderLedgerService"],
  bare: [],
  [GLOBAL_PROJECT_ID]: [],
};
/** Launch worktrees on the fake host and the project each was created for. */
const LAUNCHES: Record<string, string> = {
  "/worktrees/standup/billing-refresh-000001": "standup",
  "/worktrees/billing/feature-1": "billing",
};

const ownership: RepoOwnership = {
  projectIds: () => Object.keys(REPOS),
  roots: (p) => REPOS[p] ?? [],
  launchAt: (path) => {
    const projectId = Object.entries(LAUNCHES).find(([wt]) => path === wt || path.startsWith(`${wt}/`))?.[1];
    return projectId ? { projectId, dedicated: true } : null;
  },
  gitCommonDir: () => null,
};

const resolve = (input: {
  targetProject: string;
  proposerProject?: string;
  proposerRepo?: string;
  sourceProject?: string;
  body?: string;
}) =>
  resolveVerificationRepo({
    body: "",
    ...input,
    projectRepos: (p) => REPOS[p] ?? [],
    projects: () => Object.entries(REPOS).map(([id, repos]) => ({ id, repos })),
    ownership,
  });

describe("resolveVerificationRepo", () => {
  test("a doc of a real project is checked against that project's repo, not the session's checkout", () => {
    // The session is attributed to billing but works in a standup launch worktree.
    expect(
      resolve({ targetProject: "billing", proposerProject: "billing", proposerRepo: "/worktrees/standup/billing-refresh-000001" })
    ).toEqual({ repo: "/repos/billing/packages/BillingControlPlane" });
    // A standup session proposing into billing.
    expect(
      resolve({ targetProject: "billing", proposerProject: "standup", proposerRepo: "/worktrees/standup/billing-refresh-000001" })
    ).toEqual({ repo: "/repos/billing/packages/BillingControlPlane" });
    // The session's checkout is used when it belongs to the doc's project.
    expect(resolve({ targetProject: "billing", proposerProject: "billing", proposerRepo: "/worktrees/billing/feature-1" })).toEqual({
      repo: "/worktrees/billing/feature-1",
    });
  });

  test("a global doc resolves its source project's checkout", () => {
    expect(
      resolve({ targetProject: GLOBAL_PROJECT_ID, proposerProject: "billing", proposerRepo: "/worktrees/billing/feature-1" })
    ).toEqual({ repo: "/worktrees/billing/feature-1", projects: ["billing"] });
    // No proposer at hand: the source session's project's repo.
    expect(resolve({ targetProject: GLOBAL_PROJECT_ID, sourceProject: "standup" })).toEqual({
      repo: "/repos/standup",
      projects: ["standup"],
    });
    // A proposer checkout of another project's launch is not used for the source.
    expect(
      resolve({ targetProject: GLOBAL_PROJECT_ID, proposerProject: "billing", proposerRepo: "/worktrees/standup/billing-refresh-000001" })
    ).toEqual({ repo: "/repos/billing/packages/BillingControlPlane", projects: ["billing"] });
  });

  test("a global doc is also checked against the registered projects its body names, listed as named", () => {
    expect(
      resolve({
        targetProject: GLOBAL_PROJECT_ID,
        sourceProject: "standup",
        body: "OrderLedgerService pins the same SDK (OrderLedgerService/build.gradle).",
      })
    ).toEqual({
      repo: "/repos/standup",
      additionalRepos: ["/repos/OrderLedgerService"],
      projects: ["standup", "named"],
      namedRepos: ["/repos/OrderLedgerService"],
    });
    expect(resolve({ targetProject: GLOBAL_PROJECT_ID, body: "In `billing` and in `standup`, retries are capped." })).toEqual({
      repo: "/repos/billing/packages/BillingControlPlane",
      additionalRepos: ["/repos/standup"],
      projects: ["billing", "standup"],
      namedRepos: ["/repos/billing/packages/BillingControlPlane", "/repos/standup"],
    });
  });

  test("a passing mention of a project does not add its repo", () => {
    expect(
      resolve({ targetProject: GLOBAL_PROJECT_ID, sourceProject: "standup", body: "OrderLedgerService pins the same SDK." })
    ).toEqual({ repo: "/repos/standup", projects: ["standup"] });
  });

  test("with no resolvable repo the doc is unverifiable, with the reason", () => {
    expect(resolve({ targetProject: GLOBAL_PROJECT_ID, sourceProject: "bare", body: "Prefer small reviews." })).toEqual({
      repo: null,
      reason: noResolvableRepoReason(GLOBAL_PROJECT_ID),
    });
    expect(resolve({ targetProject: "bare", proposerProject: "standup", proposerRepo: "/repos/standup" })).toEqual({
      repo: null,
      reason: "unverifiable: no repo for project bare",
    });
  });
});

describe("projectsNamedIn", () => {
  const projects = Object.entries(REPOS).map(([id, repos]) => ({ id, repos }));
  test("matches repo paths, backticked ids, repo names used as paths, and repeated mentions, in body order", () => {
    expect(projectsNamedIn("see /repos/standup/packages and `billing`", projects)).toEqual(["standup", "billing"]);
    expect(projectsNamedIn("BillingControlPlane/model holds the API", projects)).toEqual(["billing"]);
    expect(projectsNamedIn("the acme/OrderLedgerService repo", projects)).toEqual(["named"]);
    expect(projectsNamedIn("BillingControlPlane's API, unlike billing's CLI", projects)).toEqual(["billing"]);
    expect(projectsNamedIn("a standups meeting, billing-like rules", projects)).toEqual([]);
    expect(projectsNamedIn("global and scratch are corpora", projects)).toEqual([]);
  });

  test("a single passing mention of an id or repo name names nothing", () => {
    expect(projectsNamedIn("BillingControlPlane's API", projects)).toEqual([]);
    expect(projectsNamedIn("the billing for reviews", projects)).toEqual([]);
    const short = [{ id: "docs", repos: ["/repos/docs"] }, { id: "core", repos: ["/repos/core"] }];
    expect(projectsNamedIn("see the docs for core concepts; docs/intro.md", short)).toEqual(["docs"]);
    expect(projectsNamedIn("see the docs for core concepts", short)).toEqual([]);
    expect(projectsNamedIn("edit docs/intro.md", short)).toEqual([]);
  });
});

describe("repoBelongsToProject", () => {
  test("a launch worktree belongs to its launch's project only", () => {
    expect(repoBelongsToProject("/worktrees/standup/billing-refresh-000001", "standup", ownership)).toBe(true);
    expect(repoBelongsToProject("/worktrees/standup/billing-refresh-000001/packages", "billing", ownership)).toBe(false);
    expect(repoBelongsToProject("/repos/billing/packages/BillingControlPlane/model", "billing", ownership)).toBe(true);
    expect(repoBelongsToProject("/repos/billing/packages/BillingControlPlaneX", "billing", ownership)).toBe(false);
  });

  test("a git worktree whose shared repository is inside the project's repo belongs to it", () => {
    const own = { ...ownership, gitCommonDir: () => "/repos/standup/.git" };
    expect(repoBelongsToProject("/elsewhere/wt", "standup", own)).toBe(true);
    expect(repoBelongsToProject("/elsewhere/wt", "billing", own)).toBe(false);
  });

  test("an in-place or adopted launch does not claim the repos under it; it owns only a path no registered repo does", () => {
    const own: RepoOwnership = { ...ownership, launchAt: () => ({ projectId: "standup", dedicated: false }) };
    expect(repoOwners("/repos/billing/packages/BillingControlPlane", own)).toEqual(["billing"]);
    expect(repoMayServeProject("/repos/billing/packages/BillingControlPlane", "billing", own)).toBe(true);
    // The launch's project cannot have another project's repo checked for it.
    expect(repoMayServeProject("/repos/billing/packages/BillingControlPlane", "standup", own)).toBe(false);
    expect(
      resolveVerificationRepo({
        targetProject: "standup",
        proposerProject: "standup",
        proposerRepo: "/repos/billing/packages/BillingControlPlane",
        body: "",
        projectRepos: (p) => REPOS[p] ?? [],
        projects: () => Object.entries(REPOS).map(([id, repos]) => ({ id, repos })),
        ownership: own,
      })
    ).toEqual({ repo: "/repos/standup" });
    expect(repoOwners("/home/me/elsewhere", own)).toEqual(["standup"]);
    expect(repoMayServeProject("/home/me/elsewhere", "bare", own)).toBe(false);
  });

  test("the guard admits a checkout no project owns, and never another project's", () => {
    expect(repoMayServeProject("/home/me/scratch-checkout", "bare", ownership)).toBe(true);
    expect(repoBelongsToProject("/home/me/scratch-checkout", "bare", ownership)).toBe(false);
    expect(repoMayServeProject("/worktrees/standup/billing-refresh-000001", "billing", ownership)).toBe(false);
    expect(repoMayServeProject("/repos/standup", "bare", ownership)).toBe(false);
  });
});

/** The dispute the publish check recorded against a standup worktree for a billing doc. */
const WRONG_REPO: DraftDispute = {
  claim: "Draft claims to describe state of BillingControlPlane repository on main",
  finding:
    "The repository at the provided path (/worktrees/standup/billing-refresh-000001) is the open-source Standup project (https://github.com/example/standup.git), not the internal BillingControlPlane package.",
  evidence: "cd to path and run `git remote -v`",
};
/** A genuine dispute against the doc's own repo. */
const GENUINE: DraftDispute = {
  claim: "The retry budget is five",
  finding: "RETRY_BUDGET in /repos/billing/packages/BillingControlPlane/src/retry.ts is 3",
  evidence: "rg RETRY_BUDGET /repos/billing/packages/BillingControlPlane",
};

describe("isWrongRepoDispute", () => {
  const row = (disputes: DraftDispute[], extra: Partial<{ verdictRepo: string; publishRepo: string }> = {}) => ({
    projectId: "billing",
    slug: "s",
    disputes,
    verdictRepo: extra.verdictRepo ?? null,
    publishRepo: extra.publishRepo ?? null,
  });

  test("a legacy dispute saying the repo is another project's, naming a path outside the project, is wrong-repo", () => {
    expect(isWrongRepoDispute(row([WRONG_REPO]), ownership)).toBe(true);
    const path = "/worktrees/standup/billing-refresh-000001";
    const phrasings: DraftDispute[] = [
      {
        claim: `The repository is at ${path}`,
        finding: "This is a git worktree containing the Standup knowledge base system (TypeScript), not BillingControlPlane.",
        evidence: "find . -name '*.java'",
      },
      {
        claim: "The handler validates invoices on main",
        finding: `This is the wrong repository: ${path} holds the Standup TypeScript meta-tool.`,
        evidence: `find ${path} -name '*.java' returns no results`,
      },
      {
        claim: "Unable to verify any claims",
        finding: "The provided repository is the Standup project, not the billing project described in the draft.",
        evidence: `find ${path} -name 'sandbox_core.py' returned no results`,
      },
    ];
    for (const d of phrasings) expect(isWrongRepoDispute(row([d]), ownership)).toBe(true);
  });

  test("a genuine dispute is kept, even one whose wording resembles a wrong-repo finding", () => {
    expect(isWrongRepoDispute(row([GENUINE]), ownership)).toBe(false);
    const insideRepo: DraftDispute = {
      ...WRONG_REPO,
      finding: "The module at /repos/billing/packages/BillingControlPlane/src/a.ts is the legacy package, not the one the draft names.",
    };
    expect(isWrongRepoDispute(row([insideRepo]), ownership)).toBe(false);
    // The wrong-repo wording with no path named and none recorded is left alone.
    const unnamed: DraftDispute = { claim: "x", finding: "This is the Standup project, not the billing repository.", evidence: "ls" };
    expect(isWrongRepoDispute(row([unnamed]), ownership)).toBe(false);
    expect(isWrongRepoDispute(row([unnamed], { publishRepo: "/worktrees/standup/billing-refresh-000001" }), ownership)).toBe(true);
  });

  test("ordinary finding prose and root-relative paths do not make a dispute wrong-repo", () => {
    const path = "/worktrees/standup/billing-refresh-000001";
    const genuine: DraftDispute[] = [
      {
        claim: "The handler lives in /src/server/handler.ts and serves /api/v1",
        finding: "The file /src/server/handler.ts does not exist in the repository; handleRequest is not defined in the server package.",
        evidence: "rg handleRequest",
      },
      {
        claim: "The handler validates invoices on main",
        finding: `The repository at ${path} is the Standup TypeScript meta-tool (for agent coordination), not a Java codebase.`,
        evidence: "find",
      },
      {
        claim: "The registry lives in packages/collector/src/projects-registry.ts",
        finding: `The repository at ${path} contains only Billing code, with no registry files.`,
        evidence: "find",
      },
    ];
    for (const d of genuine) expect(isWrongRepoDispute(row([d]), ownership)).toBe(false);
    // An explicit wrong-project phrase naming only root-relative paths, with the
    // publish check's checkout inside the project, stands.
    const rootRelative: DraftDispute = {
      claim: "Routes live under /api/v1",
      finding: "The repository is the gateway project, not the service; /src/routes/v1.ts does not exist.",
      evidence: "ls /src/routes",
    };
    expect(isWrongRepoDispute(row([rootRelative], { publishRepo: "/repos/billing/packages/BillingControlPlane" }), ownership)).toBe(false);
  });

  test("a recorded verdict checkout decides on its own", () => {
    expect(isWrongRepoDispute(row([GENUINE], { verdictRepo: "/worktrees/standup/billing-refresh-000001" }), ownership)).toBe(true);
    expect(isWrongRepoDispute(row([WRONG_REPO], { verdictRepo: "/repos/billing/packages/BillingControlPlane" }), ownership)).toBe(false);
  });

  test("a checkout in the project's own registered repo is never set aside, whatever launch contains it", () => {
    // An adopted session whose cwd is the parent of every repo on the host.
    const hostWide: RepoOwnership = { ...ownership, launchAt: () => ({ projectId: "standup", dedicated: false }) };
    expect(isWrongRepoDispute(row([GENUINE], { verdictRepo: "/repos/billing/packages/BillingControlPlane" }), hostWide)).toBe(false);
    expect(repoMayServeProject("/repos/billing/packages/BillingControlPlane", "billing", hostWide)).toBe(true);
    // Even a dedicated launch claiming it does not outrank the project's own repo.
    const claiming: RepoOwnership = { ...ownership, launchAt: () => ({ projectId: "standup", dedicated: true }) };
    expect(isWrongRepoDispute(row([GENUINE], { verdictRepo: "/repos/billing/packages/BillingControlPlane" }), claiming)).toBe(false);
  });

  test("names absolute paths, trimming trailing punctuation", () => {
    expect(absolutePathsIn("at (/a/b/c), then /x/y. and / or")).toEqual(["/a/b/c", "/x/y"]);
  });
});

describe("repairWrongRepoDisputesInDb", () => {
  test("downgrades a wrong-repo dispute to unverifiable, keeps a genuine one, and is idempotent", () => {
    const store = createStore(":memory:");
    const knowledge = new KnowledgeStore(store.db);
    upsertProject(store.db, { id: "billing", name: "Billing", branch: "main", repos: REPOS.billing! });
    upsertProject(store.db, { id: "standup", name: "Standup", branch: "main", repos: REPOS.standup! });
    createLaunch(store.db, {
      id: "l1",
      kind: "worktree",
      projectId: "standup",
      task: "refresh",
      worktreePath: "/worktrees/standup/billing-refresh-000001",
      branch: "standup/billing-refresh",
      status: "cleaned",
    });
    const upsert = (slug: string) =>
      knowledge.upsertDoc({
        id: `billing/${slug}`,
        projectId: "billing",
        slug,
        title: slug,
        body: `${slug} body`,
        updatedAt: new Date(),
        filePath: `/k/billing/${slug}.md`,
        originClass: "agent",
      });
    upsert("wrong");
    upsert("genuine");
    upsert("contradicted-too");
    const contradiction: DraftDispute = { claim: "Contradicts other-doc", finding: "x", evidence: "y" };
    knowledge.setDocVerdict("billing", "wrong", "disputed", [WRONG_REPO]);
    knowledge.setDocVerdict("billing", "genuine", "disputed", [GENUINE]);
    knowledge.setDocVerdict("billing", "contradicted-too", "disputed", [contradiction, WRONG_REPO]);

    const record = (p: string, s: string, verdict: string, disputes: DraftDispute[], repo: null) =>
      knowledge.setDocVerdict(p, s, verdict, disputes, repo);
    const repaired = repairWrongRepoDisputesInDb(store.db, record);
    expect(repaired.map((r) => r.slug).sort()).toEqual(["contradicted-too", "wrong"]);

    const wrong = knowledge.getDoc("billing", "wrong")!;
    expect(wrong.verdict).toBe(UNVERIFIABLE_VERDICT);
    expect(wrong.disputes).toEqual([
      expect.objectContaining({
        claim: "unverifiable: the fact-check ran against /worktrees/standup/billing-refresh-000001, outside project billing",
        origin: "repo",
      }),
    ]);
    const both = knowledge.getDoc("billing", "contradicted-too")!;
    expect(both.verdict).toBe("contradicted");
    expect(both.disputes?.map((d) => d.claim)).toEqual([contradiction.claim, expect.stringContaining("unverifiable:")]);
    expect(knowledge.getDoc("billing", "genuine")!.verdict).toBe("disputed");

    expect(repairWrongRepoDisputesInDb(store.db, record)).toEqual([]);
    expect(disputedDocRows(store.db).map((r) => r.slug)).toEqual(["genuine"]);
    store.close();
  });
});

describe("launch ownership over the store", () => {
  /** A host with `standup` and `ledger` repos under one directory, an adopted
   *  session whose cwd is that directory, an in-place launch in the standup
   *  repo, and a dedicated worktree under the worktree root. */
  function host() {
    const root = mkdtempSync(join(tmpdir(), "verify-repos-"));
    const repos = join(root, "repos");
    const standupRepo = join(repos, "standup");
    const ledgerRepo = join(repos, "OrderLedgerService");
    const worktrees = join(root, "worktrees");
    const dedicated = join(worktrees, "standup", "feature-1");
    for (const dir of [standupRepo, ledgerRepo, dedicated]) mkdirSync(dir, { recursive: true });
    const store = createStore(":memory:");
    setSetting(store.db, WORKTREE_ROOT_SETTING, worktrees);
    upsertProject(store.db, { id: "standup", name: "Standup", branch: "main", repos: [standupRepo] });
    upsertProject(store.db, { id: "ledger", name: "Ledger", branch: "main", repos: [ledgerRepo] });
    const launch = (id: string, kind: "worktree" | "adopted", projectId: string, worktreePath: string, inPlace = false) =>
      createLaunch(store.db, { id, kind, projectId, task: id, worktreePath, branch: "b", status: "running", inPlace });
    launch("adopted", "adopted", "ledger", repos);
    launch("in-place", "worktree", "ledger", standupRepo, true);
    launch("dedicated", "worktree", "ledger", dedicated);
    return { root, store, standupRepo, ledgerRepo, dedicated };
  }

  test("only a dedicated worktree under the worktree root claims a path", () => {
    const h = host();
    const own = dbRepoOwnership(h.store.db);
    expect(own.launchAt(h.dedicated)).toEqual({ projectId: "ledger", dedicated: true });
    expect(own.launchAt(h.standupRepo)).toEqual({ projectId: "ledger", dedicated: false });
    expect(repoOwners(h.dedicated, own)).toEqual(["ledger"]);
    expect(repoOwners(h.standupRepo, own)).toEqual(["standup"]);
    expect(repoMayServeProject(h.standupRepo, "standup", own)).toBe(true);
    expect(repoMayServeProject(h.standupRepo, "ledger", own)).toBe(false);
    h.store.close();
    rmSync(h.root, { recursive: true, force: true });
  });

  test("a genuine dispute under an adopted or in-place launch is not set aside, so its retry loop terminates", async () => {
    const h = host();
    const knowledge = new KnowledgeStore(h.store.db);
    knowledge.upsertDoc({
      id: "standup/doc",
      projectId: "standup",
      slug: "doc",
      title: "doc",
      body: "doc body",
      updatedAt: new Date(),
      filePath: "/k/standup/doc.md",
      originClass: "agent",
      confidence: 0.6,
    });
    // The state the loop runs from: a wrong-repo repair left the doc unverifiable.
    knowledge.setDocVerdict("standup", "doc", UNVERIFIABLE_VERDICT, [], null);
    const verified: string[] = [];
    const attempts = new Map<string, number>();
    const verifyDeps: PublishVerifyDeps = {
      verify: async (_slug, _body, repo) => {
        verified.push(repo);
        return { verdict: "disputed", disputes: [GENUINE] };
      },
      readAcceptedDoc: async (): Promise<KnowledgeDocFile> => ({
        slug: "doc",
        title: "doc",
        body: "doc body",
        tags: [],
        updatedAt: new Date(),
        sourceKind: "code",
        originClass: "agent",
        confidence: 0.6,
      }),
      currentDisputes: (p, s) => knowledge.getDoc(p, s)?.disputes ?? [],
      stampVerified: async () => {},
      recordVerdict: (p, s, verdict, disputes, repo) => knowledge.setDocVerdict(p, s, verdict, disputes, repo ?? null),
      otherRepos: () => [],
      recordAttempt: (p, s) => attempts.set(`${p}/${s}`, (attempts.get(`${p}/${s}`) ?? 0) + 1),
    };
    const record = (p: string, s: string, verdict: string, disputes: DraftDispute[], repo: null) =>
      knowledge.setDocVerdict(p, s, verdict, disputes, repo);
    for (let night = 0; night < 5; night++) {
      repairWrongRepoDisputesInDb(h.store.db, record);
      const doc = knowledge.getDoc("standup", "doc")!;
      await retryPendingVerifications(
        {
          verifyDeps,
          repoFor: retryRepoFor(dbVerificationInputs(h.store.db)),
          // Unbounded attempts: only the verdict can end the loop.
          attempts: () => 0,
        },
        [{ ...doc, body: "doc body", originClass: "agent", confidence: 0.6 }]
      );
    }
    expect(verified).toEqual([h.standupRepo]);
    expect(knowledge.getDoc("standup", "doc")!.verdict).toBe("disputed");
    h.store.close();
    rmSync(h.root, { recursive: true, force: true });
  });
});
