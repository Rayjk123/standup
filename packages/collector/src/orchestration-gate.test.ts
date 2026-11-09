import { expect, test, describe } from "bun:test";
import {
  createStore,
  upsertProject,
  createTicket,
  getTicket,
  createLaunch,
  setTicketLaunch,
  upsertProfile,
  setPersonalDefaultProfile,
  supersedeOrchestrationRunsForTicket,
  getGateResults,
  type Store,
} from "@standup/store";
import type {
  OrchestrationProfile,
  ReviewFinding,
  Ticket,
  TicketSeverity,
} from "@standup/shared";
import { MAX_REVIEW_ROUNDS } from "@standup/shared";
import {
  runOrchestrationForTicket,
  orchestrationReadyBlock,
  ensureOrchestrationRun,
  reviewRoundBudget,
  fixerLaunchRequest,
  type OrchestrationGateDeps,
} from "./orchestration-gate.js";
import type { AutoReviewResult } from "./auto-review.js";

/**
 * The bounded develop -> deploy -> review enforcement loop and its completion
 * choke. Every test drives the controller through the mockable deps seam — no
 * real shells, review agents, or fixer sessions — against an in-memory store, so
 * it exercises the ledger + choke logic deterministically.
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

/** A minimal fake persisted finding — the controller only reads severity/title. */
function finding(severity: TicketSeverity, title: string): ReviewFinding {
  return { severity, title } as unknown as ReviewFinding;
}

/** An AutoReviewResult carrying the given findings (the rest is inert here). */
function reviewResult(findings: ReviewFinding[]): AutoReviewResult {
  return { findings, high: [], superseded: [], diff: "diff" };
}

interface Spy {
  check: number;
  review: number;
  fixer: number;
  diff: number;
}

/**
 * A fully mocked deps seam. `gateMet` controls gate/deploy command exit;
 * `reviewSequence` yields one AutoReviewResult per review pass (the last entry
 * repeats); `diff` is what the cleanliness lint reads.
 */
function makeDeps(opts: {
  gateMet?: boolean;
  diff?: string;
  gitError?: boolean;
  reviewSequence?: AutoReviewResult[];
}): { deps: OrchestrationGateDeps; spy: Spy } {
  const spy: Spy = { check: 0, review: 0, fixer: 0, diff: 0 };
  let reviewIdx = 0;
  const deps: OrchestrationGateDeps = {
    async checkAcceptanceCriterion() {
      spy.check++;
      const met = opts.gateMet ?? true;
      return { met, output: met ? "" : "command failed" };
    },
    async runAutoReview() {
      spy.review++;
      const seq = opts.reviewSequence ?? [reviewResult([])];
      const r = seq[Math.min(reviewIdx, seq.length - 1)];
      reviewIdx++;
      return r;
    },
    async dispatchFixer() {
      spy.fixer++;
    },
    async computeDiff() {
      spy.diff++;
      return { diff: opts.diff ?? "", gitError: opts.gitError ?? false };
    },
  };
  return { deps, spy };
}

describe("runOrchestrationForTicket", () => {
  test("(a) all-pass profile: run succeeds and the choke allows the transition", async () => {
    const { store, ticket } = setup();
    const profile: OrchestrationProfile = {
      name: "ci",
      scope: "project",
      steps: [
        { kind: "gate", name: "unit tests", command: "bun test" },
        { kind: "deploy", command: "npx cdk deploy" },
        { kind: "review" },
      ],
    };
    const { deps, spy } = makeDeps({ reviewSequence: [reviewResult([])] });

    const run = await runOrchestrationForTicket(store.db, {
      ticketId: ticket.id,
      profile,
      cwd: "/tmp/wt",
      deps,
    });

    expect(run.status).toBe("succeeded");
    // gate + deploy each ran once; review ran once and was clean; no fixer.
    expect(spy.check).toBe(2);
    expect(spy.review).toBe(1);
    expect(spy.fixer).toBe(0);
    // The completion choke now allows the developing -> needs_review transition.
    expect(orchestrationReadyBlock(store.db, ticket)).toBeNull();
  });

  test("(b) a failing gate fails the run and the choke BLOCKS with a message", async () => {
    const { store, ticket } = setup();
    const profile: OrchestrationProfile = {
      name: "ci",
      scope: "project",
      steps: [{ kind: "gate", name: "unit tests", command: "bun test" }],
    };
    const { deps } = makeDeps({ gateMet: false });

    const run = await runOrchestrationForTicket(store.db, {
      ticketId: ticket.id,
      profile,
      cwd: "/tmp/wt",
      deps,
    });

    expect(run.status).toBe("failed");
    expect(run.status).not.toBe("succeeded");

    const block = orchestrationReadyBlock(store.db, ticket);
    expect(block).not.toBeNull();
    expect(block).toContain("ci"); // names the profile
    expect(block).toContain("failed"); // names the run status
    // The failed gate step is recorded on the ledger.
    const results = getGateResults(store.db, run.id);
    expect(results.some((r) => r.kind === "gate" && !r.passed)).toBe(true);
  });

  test("(c) a surviving high finding dispatches the fixer, re-reviews, and hitting the round cap fails the run", async () => {
    const { store, ticket } = setup();
    const profile: OrchestrationProfile = {
      name: "adversarial",
      scope: "project",
      maxReviewRounds: 1, // small cap so the bump-null path is reached fast
      steps: [{ kind: "review", blockOnSeverity: "high" }],
    };
    // Every review pass surfaces a high finding — it never converges.
    const { deps, spy } = makeDeps({
      reviewSequence: [reviewResult([finding("high", "Null deref")])],
    });

    const run = await runOrchestrationForTicket(store.db, {
      ticketId: ticket.id,
      profile,
      cwd: "/tmp/wt",
      deps,
    });

    expect(run.status).toBe("failed");
    expect(run.summary ?? run.error ?? "").toContain("did not converge");
    // Re-reviewed after dispatching a fixer: >1 review pass, >=1 fixer dispatch.
    expect(spy.review).toBeGreaterThan(1);
    expect(spy.fixer).toBeGreaterThan(0);
    expect(orchestrationReadyBlock(store.db, ticket)).not.toBeNull();
  });

  test("(c') a high finding that a fixer resolves converges to success", async () => {
    const { store, ticket } = setup();
    const profile: OrchestrationProfile = {
      name: "adversarial",
      scope: "project",
      maxReviewRounds: 3,
      steps: [{ kind: "review" }],
    };
    // First pass finds a high finding; after the fixer, the re-review is clean.
    const { deps, spy } = makeDeps({
      reviewSequence: [reviewResult([finding("high", "Race")]), reviewResult([])],
    });

    const run = await runOrchestrationForTicket(store.db, {
      ticketId: ticket.id,
      profile,
      cwd: "/tmp/wt",
      deps,
    });

    expect(run.status).toBe("succeeded");
    expect(spy.review).toBe(2); // dirty then clean
    expect(spy.fixer).toBe(1); // one fixer for the first-pass finding
    expect(orchestrationReadyBlock(store.db, ticket)).toBeNull();
  });

  test("(d) a non-inclusive term in the diff's added lines blocks via the cleanliness gate", async () => {
    const { store, ticket } = setup();
    const profile: OrchestrationProfile = {
      name: "clean",
      scope: "project",
      steps: [{ kind: "gate", name: "noop", command: "true" }],
    };
    // Added line carries a denylisted term; cleanliness must fail before the step.
    const { deps, spy } = makeDeps({
      diff: "--- a/x\n+++ b/x\n+const nodes = whitelist(all);",
    });

    const run = await runOrchestrationForTicket(store.db, {
      ticketId: ticket.id,
      profile,
      cwd: "/tmp/wt",
      deps,
    });

    expect(run.status).toBe("failed");
    expect(run.summary ?? "").toContain("whitelist");
    // Failed before the gate ran (fail-fast on dirty content).
    expect(spy.check).toBe(0);
    const results = getGateResults(store.db, run.id);
    expect(results.some((r) => r.kind === "cleanliness" && !r.passed)).toBe(true);
    expect(orchestrationReadyBlock(store.db, ticket)).not.toBeNull();
  });

  test("(e) no active profile: the choke is a pass-through (no block)", () => {
    const { store, ticket } = setup();
    // No profile stored, no default set, no run kicked off.
    expect(orchestrationReadyBlock(store.db, ticket)).toBeNull();
  });

  test("a deploy step with a target but no command FAILS the run (no silent skip)", async () => {
    const { store, ticket } = setup();
    const profile: OrchestrationProfile = {
      name: "deploy-only",
      scope: "project",
      steps: [{ kind: "deploy", target: { account: "123" } }],
    };
    const { deps, spy } = makeDeps({});

    const run = await runOrchestrationForTicket(store.db, {
      ticketId: ticket.id,
      profile,
      cwd: "/tmp/wt",
      deps,
    });

    // A target that pins no command is not deployable — fail CLOSED rather than
    // record a no-op skip that would let the run succeed without deploying.
    expect(run.status).toBe("failed");
    expect(run.summary ?? run.error ?? "").toContain("no deploy command");
    expect(spy.check).toBe(0); // no command to run
    const results = getGateResults(store.db, run.id);
    expect(results.some((r) => r.kind === "deploy" && !r.passed)).toBe(true);
    expect(orchestrationReadyBlock(store.db, ticket)).not.toBeNull();
  });

  test("a human_pause step fails the run closed (deferred — no resume yet), keeping the choke blocked", async () => {
    const { store, ticket } = setup();
    // A legacy / hand-built profile can still carry a human_pause step (store
    // validation rejects new ones). The runtime must fail it closed rather than
    // park the run `running` forever with no way to resume.
    const profile: OrchestrationProfile = {
      name: "gated",
      scope: "project",
      steps: [{ kind: "human_pause", prompt: "Confirm the migration ran" }],
    };
    const { deps } = makeDeps({});

    const run = await runOrchestrationForTicket(store.db, {
      ticketId: ticket.id,
      profile,
      cwd: "/tmp/wt",
      deps,
    });

    expect(run.status).toBe("failed");
    expect(run.summary ?? run.error ?? "").toContain("not yet supported");
    expect(orchestrationReadyBlock(store.db, ticket)).not.toBeNull();
    const results = getGateResults(store.db, run.id);
    expect(results.some((r) => r.kind === "human_pause" && !r.passed)).toBe(true);
  });
});

describe("orchestration enforcement — stale success, lockout, and caps", () => {
  const gateProfile: OrchestrationProfile = {
    name: "ci",
    scope: "project",
    steps: [{ kind: "gate", name: "unit tests", command: "bun test" }],
  };

  test("a superseded prior success re-blocks the choke; a fresh run re-allows", async () => {
    const { store, ticket } = setup();
    const { deps } = makeDeps({ reviewSequence: [reviewResult([])] });

    // A clean run succeeds and the completion choke allows the transition.
    const first = await runOrchestrationForTicket(store.db, {
      ticketId: ticket.id,
      profile: gateProfile,
      cwd: "/tmp/wt",
      deps,
    });
    expect(first.status).toBe("succeeded");
    expect(orchestrationReadyBlock(store.db, ticket)).toBeNull();

    // Rework invalidates that success: the latest run is no longer `succeeded`,
    // so the choke re-blocks — a stale pass can't authorize the reworked change.
    supersedeOrchestrationRunsForTicket(store.db, ticket.id);
    const blocked = orchestrationReadyBlock(store.db, ticket);
    expect(blocked).not.toBeNull();
    expect(blocked).toContain("superseded");

    // A fresh passing run is a NEW row and re-authorizes completion.
    const second = await runOrchestrationForTicket(store.db, {
      ticketId: ticket.id,
      profile: gateProfile,
      cwd: "/tmp/wt",
      deps,
    });
    expect(second.status).toBe("succeeded");
    expect(second.id).not.toBe(first.id);
    expect(orchestrationReadyBlock(store.db, ticket)).toBeNull();
  });

  test("a git error computing the diff FAILS the run before any step runs", async () => {
    const { store, ticket } = setup();
    const { deps, spy } = makeDeps({ gitError: true });

    const run = await runOrchestrationForTicket(store.db, {
      ticketId: ticket.id,
      profile: gateProfile,
      cwd: "/tmp/wt",
      deps,
    });

    // A git failure means the change can't be verified clean — fail closed, and
    // do NOT let a step run under an unknown diff.
    expect(run.status).toBe("failed");
    expect(run.summary ?? "").toContain("git error");
    expect(spy.check).toBe(0);
    const results = getGateResults(store.db, run.id);
    expect(results.some((r) => r.kind === "cleanliness" && !r.passed)).toBe(true);
    expect(orchestrationReadyBlock(store.db, ticket)).not.toBeNull();
  });

  test("a genuinely empty diff (no git error) is clean and the run proceeds", async () => {
    const { store, ticket } = setup();
    const { deps, spy } = makeDeps({ diff: "", gitError: false });

    const run = await runOrchestrationForTicket(store.db, {
      ticketId: ticket.id,
      profile: gateProfile,
      cwd: "/tmp/wt",
      deps,
    });

    expect(run.status).toBe("succeeded");
    expect(spy.check).toBe(1); // the gate ran — an empty diff is not a git error
    expect(orchestrationReadyBlock(store.db, ticket)).toBeNull();
  });

  test("a personal-scope default resolves via the launch requester and blocks", () => {
    const { store, ticket } = setup();
    // A personal-scope default profile owned by alias "alice".
    upsertProfile(store.db, "personal", "alice", {
      name: "mine",
      scope: "personal",
      steps: [{ kind: "review" }],
    });
    setPersonalDefaultProfile(store.db, "alice", "mine");

    // The ticket carries no alias yet, so a personal-only default resolves to
    // nothing and the choke is a pass-through.
    expect(orchestrationReadyBlock(store.db, ticket)).toBeNull();

    // Link an implementing launch whose requester is "alice"; the choke resolves
    // the personal default best-effort from that requester and blocks (no run yet).
    createLaunch(store.db, {
      id: "L1",
      projectId: "p1",
      task: "impl",
      worktreePath: "/tmp/wt",
      branch: "feat/x",
      requester: "alice",
    });
    setTicketLaunch(store.db, ticket.id, "L1");
    const linked = getTicket(store.db, ticket.id)!;

    const block = orchestrationReadyBlock(store.db, linked);
    expect(block).not.toBeNull();
    expect(block).toContain("mine"); // names the resolved personal profile
  });

  test("ensureOrchestrationRun reuses the active run instead of minting a second", () => {
    const { store, ticket } = setup();
    const first = ensureOrchestrationRun(store.db, { ticket, profile: gateProfile });
    const second = ensureOrchestrationRun(store.db, { ticket, profile: gateProfile });

    expect(second.id).toBe(first.id); // idempotent — one active run per ticket
    const count = store.db
      .query("SELECT COUNT(*) AS n FROM orchestration_runs WHERE ticket_id = ?")
      .get(ticket.id) as { n: number };
    expect(count.n).toBe(1);
  });

  test("reviewRoundBudget clamps an over-cap profile to MAX_REVIEW_ROUNDS", () => {
    // A stale/oversized maxReviewRounds is clamped so the loop can never fan out
    // more fixer rounds than the hard cap allows.
    expect(
      reviewRoundBudget({
        name: "x",
        scope: "project",
        maxReviewRounds: MAX_REVIEW_ROUNDS + 50,
        steps: [{ kind: "review" }],
      })
    ).toBe(MAX_REVIEW_ROUNDS);

    // A per-step `rounds` override above the cap is likewise clamped.
    expect(
      reviewRoundBudget({
        name: "x",
        scope: "project",
        steps: [{ kind: "review", rounds: MAX_REVIEW_ROUNDS + 1 }],
      })
    ).toBe(MAX_REVIEW_ROUNDS);

    // An in-range budget is returned unchanged.
    expect(
      reviewRoundBudget({
        name: "x",
        scope: "project",
        maxReviewRounds: 2,
        steps: [{ kind: "review" }],
      })
    ).toBe(2);
  });
});

describe("fixerLaunchRequest", () => {
  test("a fixer is launched by whoever launched the change, never by its requester", () => {
    const { store, ticket } = setup();
    createLaunch(store.db, { id: "L1", projectId: "p1", task: "impl", worktreePath: "/tmp/wt", branch: "feat/x", requester: "mallory", launchedBy: "alice" });
    setTicketLaunch(store.db, ticket.id, "L1");
    const f = { ticketId: ticket.id, title: "Fix it", severity: "high", body: "b", evidence: { checks: [], screenshots: [] } } as unknown as ReviewFinding;
    expect(fixerLaunchRequest(store.db, f, "/tmp/wt")).toMatchObject({ launchedBy: "alice", reuseWorktreePath: "/tmp/wt", label: "Fix: Fix it" });
  });

  test("a change with no recorded launcher gives its fixer none", () => {
    const { store, ticket } = setup();
    createLaunch(store.db, { id: "L1", projectId: "p1", task: "impl", worktreePath: "/tmp/wt", branch: "feat/x", requester: "alice" });
    setTicketLaunch(store.db, ticket.id, "L1");
    const f = { ticketId: ticket.id, title: "Fix it", severity: "high", body: "b", evidence: { checks: [], screenshots: [] } } as unknown as ReviewFinding;
    expect(fixerLaunchRequest(store.db, f, "/tmp/wt")!.launchedBy).toBeUndefined();
    expect(fixerLaunchRequest(store.db, { ...f, ticketId: "nope" } as ReviewFinding, "/tmp/wt")).toBeNull();
  });
});
