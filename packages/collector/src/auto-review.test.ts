import { expect, test, describe } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  createStore,
  upsertProject,
  createTicket,
  getReviewFindingsByTicket,
  getHighFindingsByTicket,
  getOpenHighFindings,
  setFindingStatus,
  type Store,
} from "@standup/store";
import type { Ticket, ReviewFinding } from "@standup/shared";
import {
  runAutoReview,
  buildFixerPrompt,
  parseReviewerOutput,
  parseReviewerFindings,
  interpretReviewerResult,
  defaultAutoReviewDeps,
  type ReviewerFinding,
} from "./auto-review.js";

/**
 * Auto-review reviewer/fixer split. Proves the reviewer produces findings, only
 * High/critical surface on the queue (de-noise), the reviewed diff is stamped
 * into each finding's evidence, and — the safety invariant — the reviewer never
 * dispatches a fixer (fix-dispatch is a separate, user-triggered path).
 */

function setup(): { store: Store; ticket: Ticket } {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p1", name: "Proj", branch: "main", repos: [] });
  const ticket = createTicket(store.db, {
    projectId: "p1",
    lens: "correctness",
    title: "Add retry policy",
    body: "Wire the backoff",
  });
  return { store, ticket };
}

/** A deps stub: a fixed diff and a fixed reviewer output, both spied. */
function stubDeps(diff: string, findings: ReviewerFinding[]) {
  const calls = { computeDiff: 0, runReviewer: 0 };
  return {
    calls,
    deps: {
      async computeDiff() {
        calls.computeDiff++;
        return diff;
      },
      async runReviewer() {
        calls.runReviewer++;
        return findings;
      },
    },
  };
}

describe("runAutoReview", () => {
  test("records every finding but surfaces only High/critical (de-noise)", async () => {
    const { store, ticket } = setup();
    const surfaced: ReviewFinding[] = [];
    const { deps } = stubDeps("diff --git a/x b/x\n+bug", [
      { severity: "high", title: "Null deref on empty list", body: "guard it", file: "x.ts", line: 12, checks: ["bun test"] },
      { severity: "medium", title: "Rename for clarity" },
      { severity: "low", title: "Nit: trailing space" },
      { severity: "critical", title: "SQL injection", body: "parameterize" },
    ]);

    const result = await runAutoReview(
      store.db,
      { ticket, worktreePath: "/tmp/wt", baseBranch: "main" },
      deps,
      (f) => surfaced.push(f)
    );

    // All four persisted.
    expect(getReviewFindingsByTicket(store.db, ticket.id)).toHaveLength(4);
    // Only high + critical are the surfaced/high subset.
    expect(result.high).toHaveLength(2);
    expect(surfaced).toHaveLength(2);
    expect(surfaced.map((f) => f.severity).sort()).toEqual(["critical", "high"]);
    // The queue reads high-only open.
    expect(getHighFindingsByTicket(store.db, ticket.id)).toHaveLength(2);
    expect(getOpenHighFindings(store.db)).toHaveLength(2);
  });

  test("stamps the reviewed diff + reviewer checks into the evidence bundle", async () => {
    const { store, ticket } = setup();
    const diff = "diff --git a/a b/a\n-old\n+new";
    const { deps } = stubDeps(diff, [
      { severity: "high", title: "Broken contract", checks: ["typecheck", "unit"], screenshots: ["/s/1.png"] },
    ]);

    await runAutoReview(store.db, { ticket, worktreePath: "/tmp/wt" }, deps);

    const [finding] = getHighFindingsByTicket(store.db, ticket.id);
    expect(finding.evidence.diff).toBe(diff);
    expect(finding.evidence.checks).toEqual(["typecheck", "unit"]);
    expect(finding.evidence.screenshots).toEqual(["/s/1.png"]);
  });

  test("SAFETY: the reviewer never dispatches a fixer — findings stay open, no fix launch", async () => {
    const { store, ticket } = setup();
    const { deps } = stubDeps("diff --git a/x b/x\n+bug", [
      { severity: "high", title: "Race condition" },
    ]);

    await runAutoReview(store.db, { ticket, worktreePath: "/tmp/wt" }, deps);

    // A recorded finding is open and carries NO fixer launch — the fixer only
    // fires on the explicit POST .../fix click, never from the review pass.
    const [finding] = getHighFindingsByTicket(store.db, ticket.id);
    expect(finding.status).toBe("open");
    expect(finding.fixLaunchId).toBeUndefined();
  });

  test("an empty diff short-circuits — the reviewer is never even invoked", async () => {
    const { store, ticket } = setup();
    const { calls, deps } = stubDeps("   \n  ", [
      { severity: "high", title: "should not be reached" },
    ]);

    const result = await runAutoReview(store.db, { ticket, worktreePath: "/tmp/wt" }, deps);

    expect(calls.computeDiff).toBe(1);
    expect(calls.runReviewer).toBe(0);
    expect(result.findings).toHaveLength(0);
    expect(getReviewFindingsByTicket(store.db, ticket.id)).toHaveLength(0);
  });

  test("a dispatched/dismissed finding drops off the high-open queue", async () => {
    const { store, ticket } = setup();
    const { deps } = stubDeps("diff x", [
      { severity: "high", title: "A" },
      { severity: "critical", title: "B" },
    ]);
    await runAutoReview(store.db, { ticket, worktreePath: "/tmp/wt" }, deps);
    expect(getOpenHighFindings(store.db)).toHaveLength(2);

    const [first] = getOpenHighFindings(store.db);
    setFindingStatus(store.db, first.id, "dismissed");
    expect(getOpenHighFindings(store.db)).toHaveLength(1);
  });

  test("a re-review supersedes the prior pass's open findings — no stale/duplicate queue", async () => {
    const { store, ticket } = setup();

    // First pass: a High + a medium recorded, one High on the queue.
    const pass1 = stubDeps("diff --git a/x b/x\n+bug", [
      { severity: "high", title: "Null deref", body: "guard it", file: "x.ts", line: 12 },
      { severity: "medium", title: "Rename for clarity" },
    ]);
    const r1 = await runAutoReview(store.db, { ticket, worktreePath: "/tmp/wt" }, pass1.deps);
    expect(r1.superseded).toHaveLength(0);
    expect(getOpenHighFindings(store.db)).toHaveLength(1);

    // The rework edge fires the gate again: a second pass over the CURRENT diff.
    // Its findings are recorded fresh and the first pass's still-open findings are
    // superseded, so the queue shows exactly the second pass's High — never both.
    const pass2 = stubDeps("diff --git a/x b/x\n+different", [
      { severity: "high", title: "Off-by-one", body: "fix bound", file: "y.ts", line: 3 },
    ]);
    const r2 = await runAutoReview(store.db, { ticket, worktreePath: "/tmp/wt" }, pass2.deps);

    // Both of pass 1's findings were superseded (High + medium); the caller
    // filters to the High ones when broadcasting the queue removal.
    expect(r2.superseded.map((f) => f.title).sort()).toEqual(["Null deref", "Rename for clarity"]);
    expect(r2.superseded.every((f) => f.status === "superseded")).toBe(true);

    // The de-noised queue holds only the second pass's High — no stale duplicate.
    const open = getOpenHighFindings(store.db);
    expect(open).toHaveLength(1);
    expect(open[0].title).toBe("Off-by-one");
    // Every row still persisted (audit trail), but pass 1's are no longer open.
    expect(getReviewFindingsByTicket(store.db, ticket.id)).toHaveLength(3);
  });

  test("a re-review leaves an already-dispatched finding untouched", async () => {
    const { store, ticket } = setup();

    const pass1 = stubDeps("diff x", [{ severity: "high", title: "Race condition" }]);
    await runAutoReview(store.db, { ticket, worktreePath: "/tmp/wt" }, pass1.deps);
    const [dispatchedFinding] = getOpenHighFindings(store.db);
    // Human clicked "fix this" — the finding is now dispatched (fixer in flight).
    setFindingStatus(store.db, dispatchedFinding.id, "dispatched");

    // A second review pass must not supersede the dispatched finding.
    const pass2 = stubDeps("diff y", [{ severity: "high", title: "New issue" }]);
    const r2 = await runAutoReview(store.db, { ticket, worktreePath: "/tmp/wt" }, pass2.deps);

    expect(r2.superseded).toHaveLength(0);
    const again = store.db
      .query("SELECT status FROM review_findings WHERE id = ?")
      .get(dispatchedFinding.id) as { status: string };
    expect(again.status).toBe("dispatched");
  });

  test("an empty-diff re-review does not supersede prior findings", async () => {
    const { store, ticket } = setup();

    const pass1 = stubDeps("diff x", [{ severity: "high", title: "Real bug" }]);
    await runAutoReview(store.db, { ticket, worktreePath: "/tmp/wt" }, pass1.deps);
    expect(getOpenHighFindings(store.db)).toHaveLength(1);

    // A pass that computes no diff short-circuits before touching prior findings —
    // it must not wipe a legitimately open finding just because it saw nothing.
    const empty = stubDeps("   ", [{ severity: "high", title: "unreached" }]);
    const r = await runAutoReview(store.db, { ticket, worktreePath: "/tmp/wt" }, empty.deps);
    expect(r.superseded).toHaveLength(0);
    expect(getOpenHighFindings(store.db)).toHaveLength(1);
  });

  test("a re-review whose reviewer fails preserves the prior pass's open findings", async () => {
    const { store, ticket } = setup();

    // First pass records a real High finding on the queue.
    const pass1 = stubDeps("diff x", [{ severity: "high", title: "Real bug" }]);
    await runAutoReview(store.db, { ticket, worktreePath: "/tmp/wt" }, pass1.deps);
    expect(getOpenHighFindings(store.db)).toHaveLength(1);

    // The rework edge fires a re-review over a NON-empty diff, but the reviewer
    // process fails (crash/timeout). A completed-but-clean pass resolves []; a
    // failed pass must REJECT so it isn't mistaken for "clean" — otherwise
    // supersedeOpenFindings would wipe the still-valid High finding off the queue.
    const failing = {
      async computeDiff() {
        return "diff --git a/x b/x\n+changed";
      },
      async runReviewer(): Promise<ReviewerFinding[]> {
        throw new Error("reviewer timed out");
      },
    };
    await expect(
      runAutoReview(store.db, { ticket, worktreePath: "/tmp/wt" }, failing)
    ).rejects.toThrow();

    // The prior pass's finding is still open on the queue — not superseded away
    // by a failure that merely resolved empty.
    const open = getOpenHighFindings(store.db);
    expect(open).toHaveLength(1);
    expect(open[0].title).toBe("Real bug");
    expect(open[0].status).toBe("open");
  });

  test("a finding with no title is dropped", async () => {
    const { store, ticket } = setup();
    const { deps } = stubDeps("diff x", [
      { severity: "high", title: "   " },
      { severity: "high", title: "Real one" },
    ]);
    await runAutoReview(store.db, { ticket, worktreePath: "/tmp/wt" }, deps);
    expect(getReviewFindingsByTicket(store.db, ticket.id)).toHaveLength(1);
  });
});

describe("buildFixerPrompt", () => {
  test("seeds the fresh agent with the finding + the reviewed diff", () => {
    const finding: ReviewFinding = {
      id: "f1",
      ticketId: "t1",
      severity: "high",
      title: "Null deref on empty list",
      body: "guard the head access",
      file: "src/x.ts",
      line: 12,
      status: "open",
      evidence: { checks: ["bun test"], screenshots: [], diff: "diff --git a/x b/x\n+boom" },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const prompt = buildFixerPrompt(finding);
    expect(prompt).toContain("Null deref on empty list");
    expect(prompt).toContain("guard the head access");
    expect(prompt).toContain("src/x.ts:12");
    expect(prompt).toContain("diff --git a/x b/x");
    expect(prompt).toContain("bun test");
    // Scoped to only this finding.
    expect(prompt).toContain("ONLY this finding");
  });
});

describe("defaultAutoReviewDeps.computeDiff", () => {
  async function git(cwd: string, args: string[]): Promise<void> {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    if (proc.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
    }
  }

  test("captures BOTH committed and still-uncommitted changes on the branch", async () => {
    const repo = await mkdtemp(join(tmpdir(), "standup-computediff-"));
    try {
      await git(repo, ["init", "-b", "main"]);
      await git(repo, ["config", "user.email", "t@t"]);
      await git(repo, ["config", "user.name", "t"]);
      await writeFile(join(repo, "f.txt"), "base\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "base"]);

      // The change: one part committed on a feature branch, one part left in the
      // working tree uncommitted — the mixed state a three-dot base diff drops.
      await git(repo, ["checkout", "-b", "feat"]);
      await writeFile(join(repo, "f.txt"), "base\nCOMMITTED_LINE\n");
      await git(repo, ["commit", "-am", "committed part"]);
      await writeFile(join(repo, "f.txt"), "base\nCOMMITTED_LINE\nUNCOMMITTED_LINE\n");

      const diff = await defaultAutoReviewDeps().computeDiff(repo, "main");
      // Both the committed AND the uncommitted line must be in the reviewed diff.
      expect(diff).toContain("COMMITTED_LINE");
      expect(diff).toContain("UNCOMMITTED_LINE");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("with no base ref, diffs the working tree against HEAD", async () => {
    const repo = await mkdtemp(join(tmpdir(), "standup-computediff-nobase-"));
    try {
      await git(repo, ["init", "-b", "main"]);
      await git(repo, ["config", "user.email", "t@t"]);
      await git(repo, ["config", "user.name", "t"]);
      await writeFile(join(repo, "f.txt"), "base\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "base"]);
      await writeFile(join(repo, "f.txt"), "base\nWORKING_TREE_ONLY\n");

      const diff = await defaultAutoReviewDeps().computeDiff(repo, undefined);
      expect(diff).toContain("WORKING_TREE_ONLY");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe("parseReviewerOutput", () => {
  test("extracts findings from a claude --output-format json envelope", () => {
    const envelope = JSON.stringify({
      type: "result",
      result: '[{"severity":"high","title":"Bug","body":"x"}]',
    });
    const out = parseReviewerOutput(envelope);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("Bug");
  });

  test("tolerates stray prose around the JSON array", () => {
    const out = parseReviewerOutput('Here are the findings: [{"title":"A"}] done');
    expect(out).toHaveLength(1);
  });

  test("degrades to no findings on unparseable output", () => {
    expect(parseReviewerOutput("not json at all")).toEqual([]);
    expect(parseReviewerOutput("")).toEqual([]);
  });
});

describe("parseReviewerFindings", () => {
  test("a genuinely clean review ([]) is a readable empty array, NOT unreadable", () => {
    // The strict parser must distinguish a real clean pass from unreadable output:
    // [] means "ran, found nothing" (queue-clearing), null means "couldn't read".
    expect(parseReviewerFindings("[]")).toEqual([]);
    expect(parseReviewerFindings(JSON.stringify({ result: "[]" }))).toEqual([]);
  });

  test("returns findings for a well-formed array", () => {
    const out = parseReviewerFindings('[{"severity":"high","title":"Bug"}]');
    expect(out).toHaveLength(1);
    expect(out?.[0].title).toBe("Bug");
  });

  test("signals null (unreadable) on a prose refusal with no array", () => {
    // An exit-0 model that refuses in prose emits no bracketed array — this must
    // NOT be read as a clean [] that clears the queue.
    expect(parseReviewerFindings("I can't review this change.")).toBeNull();
    expect(parseReviewerFindings("")).toBeNull();
  });

  test("signals null (unreadable) on a truncated / malformed array", () => {
    // A max-token-truncated array (open bracket, no close) or malformed JSON is
    // unreadable, not clean.
    expect(parseReviewerFindings('[{"title":"x"')).toBeNull();
    expect(parseReviewerFindings('[{"title":]')).toBeNull();
    expect(parseReviewerFindings('{"result":"[not json"}')).toBeNull();
  });

  test("signals null (unreadable) when a parsed array holds only non-findings", () => {
    // A well-formed array that filters to zero real findings is NOT a clean pass:
    // prose whose bracketed slice is a numeric list ("lines [10, 20, 30]"), or
    // real findings emitted with no `title`. Reading either as a clean [] would
    // let a re-review supersede the prior pass's still-open High findings.
    expect(
      parseReviewerFindings('{"result":"I reviewed lines [10, 20, 30] and cannot complete."}')
    ).toBeNull();
    expect(parseReviewerFindings('[{"severity":"high","body":"real bug, no title"}]')).toBeNull();
    // A literal empty array is still the genuinely-clean signal, not unreadable.
    expect(parseReviewerFindings("[]")).toEqual([]);
    // A partial parse — one valid finding among non-findings — keeps what it can.
    expect(parseReviewerFindings('[{"title":"real"}, 5]')).toHaveLength(1);
  });
});

/**
 * `interpretReviewerResult` is the decision the DEFAULT reviewer runs on its
 * finished subprocess — the exact line the fix changed (swallow-a-failed/unreadable
 * -pass-into-[] → throw). Driving it directly gives the guard genuine regression
 * coverage: it drove out the defect that a stubbed `runReviewer` could never
 * reach, and reverting the fix (returning `parseReviewerOutput(stdout)` or
 * dropping the exit check) turns these red. It must REJECT anything short of a
 * completed, readable pass — otherwise `runAutoReview` reads the [] as clean and
 * supersedes the prior pass's still-open High findings off the queue.
 */
describe("interpretReviewerResult (default reviewer's exit/parse guard)", () => {
  test("THROWS on a non-zero exit (the reviewer process failed)", () => {
    // A process failure is NOT a clean pass, even with plausible-looking output.
    expect(() => interpretReviewerResult(2, '{"result":"[]"}')).toThrow();
    expect(() => interpretReviewerResult(null, "")).toThrow();
  });

  test("THROWS on exit-0 with unreadable output (prose refusal)", () => {
    // The exact gap the fix closes: a live claude exits 0 but emits no findings
    // array. This must throw, not return [] — otherwise a re-review would
    // supersede the prior pass's still-open High findings.
    expect(() => interpretReviewerResult(0, "I cannot review this change.")).toThrow();
    expect(() => interpretReviewerResult(0, "")).toThrow();
  });

  test("THROWS on exit-0 with a truncated / malformed JSON array", () => {
    expect(() => interpretReviewerResult(0, '[{"title":"x"')).toThrow();
    expect(() => interpretReviewerResult(0, '{"result":"[not json"}')).toThrow();
  });

  test("THROWS on exit-0 with an is_error envelope whose result slices to an array", () => {
    // error_max_turns / rate-limit / overload: the CLI completes at exit 0 but
    // flags is_error, and its `result` can still slice to a valid array (often
    // []). This must throw, not read as a completed clean pass — otherwise a
    // re-review supersedes the prior pass's still-open High findings.
    expect(() =>
      interpretReviewerResult(0, JSON.stringify({ is_error: true, result: "[]" }))
    ).toThrow();
    expect(() =>
      interpretReviewerResult(
        0,
        JSON.stringify({ is_error: true, result: "I stopped at lines [10, 20]." })
      )
    ).toThrow();
  });

  test("THROWS on exit-0 whose parsed array holds only non-findings", () => {
    // A soft-failure whose result slices to a numeric/title-less array is not a
    // clean pass — interpretReviewerResult must reject it.
    expect(() =>
      interpretReviewerResult(0, '{"result":"I reviewed lines [10, 20, 30]."}')
    ).toThrow();
    expect(() =>
      interpretReviewerResult(0, '[{"severity":"high","body":"real bug, no title"}]')
    ).toThrow();
  });

  test("returns [] on exit-0 with a genuinely clean review", () => {
    // A real completed pass that found nothing SHOULD return [] so the queue clears.
    expect(interpretReviewerResult(0, "[]")).toEqual([]);
    expect(interpretReviewerResult(0, '{"result":"[]"}')).toEqual([]);
  });

  test("returns the findings on exit-0 with a well-formed array", () => {
    const out = interpretReviewerResult(0, '[{"severity":"high","title":"Bug"}]');
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("Bug");
  });
});
