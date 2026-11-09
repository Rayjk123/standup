import { expect, test, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createStore, upsertProject } from "@standup/store";
import { pendingVerificationRetryDeps, retryPendingPublishVerifications } from "./knowledge-reverify.js";
import {
  KnowledgeStore,
  LocalMarkdownBackend,
  getVerificationState,
  recordVerificationAttempt,
  type KnowledgeDocFile,
} from "@standup/knowledge";
import { buildResolveDeps } from "./knowledge-resolve.js";
import {
  MAX_VERIFY_ATTEMPTS,
  chooseVerificationRepo,
  draftVerdict,
  isAwaitingVerification,
  namedRepoReason,
  noRepoReason,
  recordUnverifiable,
  retryPendingVerifications,
  verifyPublishedDoc,
  type PublishVerifyDeps,
} from "./knowledge-publish-verify.js";
import { makeSpawnBudget, budgetedJudge } from "./knowledge-graph-audit.js";
import { chooseLoser, withJudgeRetry, type ContradictionJudgment } from "./knowledge-coherence.js";
import type { DraftDispute, DraftVerification } from "./draft-verify.js";

const pending = (slug: string) => ({
  projectId: "p",
  slug,
  body: `${slug} body`,
  originClass: "agent",
  confidence: 0.6,
});

function verifyDeps(calls: string[]): PublishVerifyDeps {
  return {
    verify: async (slug) => {
      calls.push(slug);
      return { verdict: "error", disputes: [] };
    },
    readAcceptedDoc: async (_p, slug): Promise<KnowledgeDocFile> => ({
      slug,
      title: slug,
      body: `${slug} body`,
      tags: [],
      updatedAt: new Date(),
      sourceKind: "code",
      originClass: "agent",
      confidence: 0.6,
    }),
    currentDisputes: () => [],
    stampVerified: async () => {},
    recordVerdict: () => {},
    otherRepos: () => [],
  };
}

describe("retryPendingVerifications", () => {
  test("retries pending docs a bounded number of times per body, within the per-run limit", async () => {
    const calls: string[] = [];
    const attempts = new Map<string, number>();
    const vd = verifyDeps(calls);
    vd.recordAttempt = (_p, slug) => attempts.set(slug, (attempts.get(slug) ?? 0) + 1);
    const deps = {
      verifyDeps: vd,
      repoFor: () => "/repo",
      attempts: (_p: string, slug: string) => attempts.get(slug) ?? 0,
    };
    const docs = [pending("a"), pending("b"), { ...pending("c"), lastVerifiedAt: "2026-09-01T00:00:00Z" }];
    for (let night = 0; night < MAX_VERIFY_ATTEMPTS + 2; night++) await retryPendingVerifications(deps, docs, 5);
    expect(calls.filter((c) => c === "a")).toHaveLength(MAX_VERIFY_ATTEMPTS);
    expect(calls).not.toContain("c");
    calls.length = 0;
    attempts.clear();
    expect(await retryPendingVerifications(deps, docs, 1)).toBe(1);
  });

  test("a doc the model disputed is never re-rolled; an errored or git-only one is", async () => {
    const calls: string[] = [];
    const deps = { verifyDeps: verifyDeps(calls), repoFor: () => "/repo", attempts: () => 0 };
    await retryPendingVerifications(deps, [
      { ...pending("disputed"), verdict: "disputed" },
      { ...pending("errored"), verdict: "error" },
      { ...pending("git-only"), verdict: "unverified" },
    ]);
    expect(calls).toEqual(["errored", "git-only"]);
  });

  test("docs with no repo to check against are skipped, and the spawn budget stops the run", async () => {
    const calls: string[] = [];
    const budget = makeSpawnBudget(1);
    const checked = await retryPendingVerifications(
      {
        verifyDeps: verifyDeps(calls),
        repoFor: (projectId) => (projectId === "p" ? "/repo" : null),
        attempts: () => 0,
        tryConsume: () => budget.tryConsume(),
      },
      [{ ...pending("x"), projectId: "no-repo" }, pending("a"), pending("b")]
    );
    expect(checked).toBe(1);
    expect(calls).toEqual(["a"]);
  });
});

describe("a doc still owed a fact-check is not resolved against", () => {
  test("pending with attempts left (persisted, across restarts) blocks; spent attempts or verified does not", async () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc({
      id: "d1",
      projectId: "p",
      slug: "fresh",
      title: "Fresh",
      body: "fresh body",
      updatedAt: new Date(),
      filePath: "/x/fresh.md",
      originClass: "agent",
      confidence: 0.6,
    });
    const backend = new LocalMarkdownBackend(db, null, {}, "");
    const deps = buildResolveDeps({
      db,
      backend,
      knowledgeDir: "",
      recordDocVerdict: () => {},
      clearDocVerdict: () => {},
      syncProject: async () => {},
      resolve: async () => null,
    });
    expect(deps.isVerificationPending!("p", "fresh")).toBe(true);
    for (let i = 0; i < MAX_VERIFY_ATTEMPTS; i++) recordVerificationAttempt(db, "p", "fresh", "fresh body", "unchecked");
    expect(deps.isVerificationPending!("p", "fresh")).toBe(false);
    // A new body starts over.
    db.run("UPDATE knowledge SET body = 'edited body' WHERE id = 'd1'");
    expect(deps.isVerificationPending!("p", "fresh")).toBe(true);
    expect(isAwaitingVerification({ projectId: "p", slug: "x", originClass: "agent", confidence: 1, lastVerifiedAt: "2026-09-01" }, 0)).toBe(false);
    // The state goes with the doc.
    store.deleteDoc("p", "fresh");
    expect(getVerificationState(db, "p", "fresh", "fresh body").attempts).toBe(0);
  });
});

describe("judge retries draw on the spawn budget per attempt", () => {
  test("each retry is charged; a spent budget stops the retries", async () => {
    const budget = makeSpawnBudget(2);
    let calls = 0;
    const failing = async (): Promise<ContradictionJudgment> => {
      calls++;
      return { contradicts: false, reason: "", error: "exit 1" };
    };
    const judge = withJudgeRetry(budgetedJudge(failing, budget), { attempts: 3, sleep: async () => {} });
    const doc = { slug: "s", title: "t", body: "b" };
    const out = await judge(doc, doc);
    expect(calls).toBe(2);
    expect(budget.spawned()).toBe(2);
    expect(out.skipped).toBe(true);
  });
});

describe("chooseVerificationRepo", () => {
  const repos: Record<string, string[]> = {
    a: ["/repos/a"],
    b: ["/repos/b", "/repos/b-extra"],
    empty: [],
  };
  const choose = (targetProject: string, proposerProject: string, proposerRepo: string | null) =>
    chooseVerificationRepo({ targetProject, proposerProject, proposerRepo, projectRepos: (p) => repos[p] ?? [] });

  test("a proposal into the proposer's own project uses the proposer's checkout, registered or not", () => {
    expect(choose("a", "a", "/worktrees/a/feature")).toEqual({ repo: "/worktrees/a/feature" });
    expect(choose("empty", "empty", "/worktrees/empty/x")).toEqual({ repo: "/worktrees/empty/x" });
  });

  test("a proposal from A into B uses B's repo, never A's checkout", () => {
    expect(choose("b", "a", "/worktrees/a/feature")).toEqual({ repo: "/repos/b" });
    expect(choose("b", "a", "/repos/a")).toEqual({ repo: "/repos/b" });
  });

  test("a proposer's checkout inside one of B's repos is used as is", () => {
    expect(choose("b", "a", "/repos/b-extra/sub")).toEqual({ repo: "/repos/b-extra/sub" });
    // A sibling path sharing a prefix is not inside the repo.
    expect(choose("b", "a", "/repos/b-extra2")).toEqual({ repo: "/repos/b" });
  });

  test("a target with no repo is unverifiable, never the proposer's repo", () => {
    expect(choose("empty", "a", "/repos/a")).toEqual({ repo: null, reason: noRepoReason("empty") });
    expect(noRepoReason("empty")).toBe("unverifiable: no repo for project empty");
  });
});

describe("verifyPublishedDoc", () => {
  const cited = (file: string): DraftDispute => ({
    claim: `claim about ${file}`,
    finding: "differs",
    evidence: "rg",
    kind: "contradicted",
    citations: [{ file, line: 1, quote: "x" }],
  });
  function run(
    projectId: string,
    result: DraftVerification,
    repoPath: string,
    additionalRepos: string[] = [],
    namedRepos?: string[]
  ) {
    const recorded: Array<{ verdict: string; disputes: DraftDispute[]; repo: string | null | undefined }> = [];
    const deps: PublishVerifyDeps = {
      ...verifyDeps([]),
      verify: async () => result,
      readAcceptedDoc: async (_p, slug) => ({ ...(await verifyDeps([]).readAcceptedDoc(projectId, slug))!, body: "body" }),
      recordVerdict: (_p, _s, verdict, disputes, repo) => recorded.push({ verdict, disputes, repo }),
    };
    return verifyPublishedDoc(deps, projectId, "doc", "body", repoPath, additionalRepos, namedRepos).then((out) => ({
      out,
      recorded,
    }));
  }

  test("a corpus doc's findings only against a repo it names leave it unverifiable, not disputed", async () => {
    const { out, recorded } = await run(
      "global",
      { verdict: "disputed", disputes: [cited("/repos/ledger/src/a.ts")] },
      "/repos/standup",
      ["/repos/ledger"]
    );
    expect(out.outcome).toBe("unchecked");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.verdict).toBe("unverifiable");
    expect(recorded[0]!.repo).toBeNull();
    expect(recorded[0]!.disputes[0]!.claim).toBe(namedRepoReason("global", ["/repos/ledger"]));
    expect(recorded[0]!.disputes.every((d) => d.origin === "repo")).toBe(true);
  });

  test("a finding against the source project's repo still disputes it, with named-repo findings as notes", async () => {
    const { out, recorded } = await run(
      "global",
      { verdict: "disputed", disputes: [cited("/repos/standup/a.ts"), cited("/repos/ledger/b.ts")] },
      "/repos/standup",
      ["/repos/ledger"]
    );
    expect(out.outcome).toBe("disputed");
    expect(recorded[0]!.verdict).toBe("disputed");
    expect(recorded[0]!.disputes.map((d) => d.origin)).toEqual([undefined, "repo"]);
  });

  test("with no source project, findings against the named primary repo are not a dispute", async () => {
    const { recorded } = await run(
      "global",
      { verdict: "disputed", disputes: [cited("/repos/ledger/src/a.ts")] },
      "/repos/ledger",
      [],
      ["/repos/ledger"]
    );
    expect(recorded[0]!.verdict).toBe("unverifiable");
    // A project doc's findings are never set aside.
    const own = await run("p", { verdict: "disputed", disputes: [cited("/repos/ledger/src/a.ts")] }, "/repos/ledger");
    expect(own.recorded[0]!.verdict).toBe("disputed");
  });

  test("a check that could not refresh mainline records the doc unverifiable with the reason", async () => {
    const note: DraftDispute = { claim: "unverifiable: could not refresh mainline of /r (no origin remote)", finding: "f", evidence: "e", origin: "repo" };
    const { out, recorded } = await run("p", { verdict: "unverifiable", disputes: [note] }, "/r");
    expect(out.outcome).toBe("unchecked");
    expect(recorded).toEqual([{ verdict: "unverifiable", disputes: [note], repo: null }]);
  });

  test("dropped disputes are reported on the result", async () => {
    const dropped = { count: 1, reasons: ["c: the quote is not at f:1 (±3 lines)"] };
    const { out, recorded } = await run("p", { verdict: "clean", disputes: [], dropped }, "/r");
    expect(out.outcome).toBe("clean");
    expect(out.dropped).toEqual(dropped);
    expect(recorded[0]!.verdict).toBe("clean");
  });
});

describe("recordUnverifiable", () => {
  test("records an unverifiable verdict with the reason, keeping only contradiction edges", () => {
    const recorded: Array<{ verdict: string; disputes: DraftDispute[] }> = [];
    const deps = {
      currentDisputes: (): DraftDispute[] => [
        { claim: "Contradicts other", finding: "x", evidence: "y" },
        { claim: "old fact-check finding", finding: "from the wrong repo", evidence: "rg" },
      ],
      recordVerdict: (_p: string, _s: string, verdict: string, disputes: DraftDispute[]) =>
        recorded.push({ verdict, disputes }),
    };
    recordUnverifiable(deps, "p", "doc", noRepoReason("p"));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.verdict).toBe("contradicted");
    expect(recorded[0]!.disputes.map((d) => d.claim)).toEqual(["Contradicts other", noRepoReason("p")]);
    expect(recorded[0]!.disputes[1]!.origin).toBe("repo");

    recorded.length = 0;
    recordUnverifiable({ ...deps, currentDisputes: () => [] }, "p", "doc", noRepoReason("p"));
    expect(recorded[0]!.verdict).toBe("unverifiable");
  });

  test("an unverifiable doc never loses a contradiction on its own fact-check", () => {
    const note: DraftDispute = { claim: noRepoReason("p"), finding: "skipped", evidence: "projects.repos_json", origin: "repo" };
    const unverifiable = { slug: "new", state: { verdict: "disputed", disputes: [note], originClass: "agent" } };
    const other = { slug: "old", state: { verdict: undefined, disputes: [], originClass: "agent" } };
    const choice = chooseLoser(unverifiable, other);
    expect(choice?.basis ?? "").not.toContain("own fact-check");
  });
});

describe("draftVerdict", () => {
  const git: DraftDispute = { claim: "merged in abc", finding: "not on main", evidence: "git merge-base", origin: "git" };
  const citing = (file: string): DraftDispute => ({
    claim: "c",
    finding: "f",
    evidence: "e",
    citations: [{ file, line: 1, quote: "q" }],
  });

  test("an unverifiable check keeps its reason alongside git findings", () => {
    const note: DraftDispute = { claim: "unverifiable: could not refresh mainline of /r (no origin remote)", finding: "f", evidence: "e", origin: "repo" };
    const result = draftVerdict({ verdict: "unverifiable", disputes: [note] }, [git], "p", "/r");
    expect(result.verdict).toBe("unverifiable");
    expect(result.disputes).toEqual([note, git]);
  });

  test("findings only against a named repo make a corpus draft unverifiable; a source finding disputes it", () => {
    const named = draftVerdict({ verdict: "disputed", disputes: [citing("/named/x.ts")] }, [], "global", "/src", ["/named"], ["/named"]);
    expect(named.verdict).toBe("unverifiable");
    expect(named.disputes[0]!.claim).toBe(namedRepoReason("global", ["/named"]));
    expect(named.disputes.every((d) => d.origin === "repo")).toBe(true);
    const source = draftVerdict(
      { verdict: "disputed", disputes: [citing("/src/a.ts"), citing("/named/x.ts")] },
      [git],
      "global",
      "/src",
      ["/named"],
      ["/named"]
    );
    expect(source.verdict).toBe("disputed");
    expect(source.disputes.map((d) => d.origin)).toEqual([undefined, "repo", "git"]);
  });

  test("git findings alone leave a draft unverified; a clean check with none stays clean", () => {
    expect(draftVerdict({ verdict: "clean", disputes: [] }, [git], "p", "/r")).toEqual({ verdict: "unverified", disputes: [git] });
    expect(draftVerdict({ verdict: "clean", disputes: [] }, [], "p", "/r")).toEqual({ verdict: "clean", disputes: [] });
  });

  test("a check whose every finding was set aside records its notes as unverified and never stamps the doc", async () => {
    const note: DraftDispute = { claim: "x: the quote is not at a.ts:3", finding: "set aside", evidence: "", origin: "repo" };
    const git: DraftDispute = { claim: "merged in abc", finding: "not on main", evidence: "git merge-base", origin: "git" };
    const checked: DraftVerification = { verdict: "unverified", disputes: [note], dropped: { count: 1, reasons: [note.claim] } };
    expect(draftVerdict(checked, [], "p", "/r")).toEqual({ verdict: "unverified", disputes: [note] });
    expect(draftVerdict(checked, [git], "p", "/r")).toEqual({ verdict: "unverified", disputes: [note, git] });

    let stamped = false;
    const recorded: Array<{ verdict: string; disputes: DraftDispute[] }> = [];
    const deps: PublishVerifyDeps = {
      ...verifyDeps([]),
      verify: async () => checked,
      stampVerified: async () => void (stamped = true),
      recordVerdict: (_p, _s, verdict, disputes) => void recorded.push({ verdict, disputes }),
    };
    const result = await verifyPublishedDoc(deps, "p", "d", "d body", "/r");
    expect(result.outcome).toBe("unchecked");
    expect(stamped).toBe(false);
    expect(recorded).toEqual([{ verdict: "unverified", disputes: [note] }]);
  });
});

describe("the re-verification tick's retry of pending publish fact-checks", () => {
  test("retries a pending doc against its project's checkout, up to the attempt limit, persisting attempts", async () => {
    const repo = mkdtempSync(join(tmpdir(), "retry-pending-"));
    const store = createStore(":memory:");
    try {
      upsertProject(store.db, { id: "p", name: "P", branch: "main", repos: [repo] });
      const kstore = new KnowledgeStore(store.db);
      kstore.upsertDoc({
        id: "d1",
        projectId: "p",
        slug: "pending",
        title: "Pending",
        body: "pending body",
        updatedAt: new Date(),
        filePath: "/x/pending.md",
        originClass: "agent",
        confidence: 0.6,
      });
      const calls: Array<{ slug: string; repoPath: string }> = [];
      const recorded: string[] = [];
      const deps = pendingVerificationRetryDeps(
        store.db,
        { recordDocVerdict: (_p, _s, verdict) => void recorded.push(verdict), syncProject: async () => {} },
        "",
        {
          readAcceptedDoc: async (_p, slug) => ({
            slug,
            title: slug,
            body: "pending body",
            tags: [],
            updatedAt: new Date(),
            sourceKind: "code",
            originClass: "agent",
            confidence: 0.6,
          }),
          getDoc: (p, s) => kstore.getDoc(p, s),
        },
        async (slug, _body, repoPath) => {
          calls.push({ slug, repoPath });
          return { verdict: "error", disputes: [] };
        }
      );
      for (let i = 0; i < MAX_VERIFY_ATTEMPTS + 2; i++) await retryPendingPublishVerifications(store.db, deps);
      expect(calls).toEqual(Array.from({ length: MAX_VERIFY_ATTEMPTS }, () => ({ slug: "pending", repoPath: repo })));
      expect(getVerificationState(store.db, "p", "pending", "pending body").attempts).toBe(MAX_VERIFY_ATTEMPTS);
    } finally {
      store.close();
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a repo registered after the sweep's deps were built is used on the next sweep", async () => {
    const repo = mkdtempSync(join(tmpdir(), "retry-late-repo-"));
    const store = createStore(":memory:");
    try {
      upsertProject(store.db, { id: "p", name: "P", branch: "main", repos: [] });
      const kstore = new KnowledgeStore(store.db);
      kstore.upsertDoc({
        id: "d1",
        projectId: "p",
        slug: "pending",
        title: "Pending",
        body: "pending body",
        updatedAt: new Date(),
        filePath: "/x/pending.md",
        originClass: "agent",
        confidence: 0.6,
      });
      const calls: string[] = [];
      const deps = pendingVerificationRetryDeps(
        store.db,
        { recordDocVerdict: () => {}, syncProject: async () => {} },
        "",
        {
          readAcceptedDoc: async (_p, slug) => ({
            slug,
            title: slug,
            body: "pending body",
            tags: [],
            updatedAt: new Date(),
            sourceKind: "code",
            originClass: "agent",
            confidence: 0.6,
          }),
          getDoc: (p, s) => kstore.getDoc(p, s),
        },
        async (_slug, _body, repoPath) => {
          calls.push(repoPath);
          return { verdict: "error", disputes: [] };
        }
      );
      expect(await retryPendingPublishVerifications(store.db, deps)).toBe(0);
      upsertProject(store.db, { id: "p", name: "P", branch: "main", repos: [repo] });
      expect(await retryPendingPublishVerifications(store.db, deps)).toBe(1);
      expect(calls).toEqual([repo]);
    } finally {
      store.close();
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
