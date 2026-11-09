import type { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import type {
  OrchestrationProfile,
  OrchestrationRun,
  OrchestrationStep,
  ReviewFinding,
  Ticket,
  TicketSeverity,
} from "@standup/shared";
import { MAX_REVIEW_ROUNDS } from "@standup/shared";
import {
  GLOBAL_ORCH_OWNER_KEY,
  bumpOrchestrationRound,
  createOrchestrationRun,
  getActiveOrchestrationRunByTicket,
  getGateResults,
  getLatestOrchestrationRunByTicket,
  getLaunch,
  getOrchestrationRun,
  getProject,
  getTicket,
  heartbeatOrchestrationRun,
  recordGateResult,
  resolveActiveProfile,
  updateOrchestrationRunStatus,
} from "@standup/store";
import { checkAcceptanceCriterion } from "./plan-gate.js";
import {
  buildFixerPrompt,
  defaultAutoReviewDeps,
  runAutoReview as realRunAutoReview,
  type AutoReviewInput,
  type AutoReviewResult,
} from "./auto-review.js";
import { validateCleanliness } from "./cleanliness.js";
import { launchSession } from "./launcher.js";
import type { LaunchRequest } from "./launcher.js";
import { defaultGitRunner } from "./review/stage.js";
import { resolveTargetBranch } from "./target-branch.js";

/**
 * The bounded develop → deploy → review enforcement loop.
 *
 * `runOrchestrationForTicket` drives a resolved orchestration profile's steps IN
 * ORDER against a single `orchestration_runs` ledger row, and it is where the
 * user's intent — "loop: develop → deploy → adversarial review, and don't let
 * the agent mark work complete until the gates pass" — is actually GUARANTEED.
 * It is the SLOW, asynchronous half: it shells out for gates/deploys, runs
 * adversarial review passes, and dispatches fixer sessions. The FAST half is the
 * pure `orchestrationReadyBlockForTicket` state-check in server.ts, which only
 * reads the ledger this loop writes and blocks the completion choke until the
 * run has `succeeded`.
 *
 * Everything is bounded: a review step loops only until a round is clean or the
 * run exhausts its round budget (bumpOrchestrationRound returns null), at which
 * point the run fails with "did not converge". A failed gate/deploy fails the
 * run immediately (fail-closed). The four outward actions are a mockable
 * `OrchestrationGateDeps` seam so the controller is unit-testable with an
 * in-memory store and no shells, sessions, or review agents.
 */

/** The default review-round budget when neither the step nor the profile sets one. */
export const DEFAULT_MAX_REVIEW_ROUNDS = 3;

/** The finding severity a review step blocks on when none is configured. */
const DEFAULT_BLOCK_SEVERITY: "high" | "medium" = "high";

/** Low → critical rank, so a threshold can be compared with `>=`. */
const SEVERITY_RANK: Record<TicketSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/**
 * The outward actions the controller takes, injectable so a test drives the loop
 * with an in-memory store and NO shells/sessions/review agents. Exactly four
 * seams: run a gate/deploy command, run one review pass, dispatch a fixer for a
 * blocking finding, and compute the diff the cleanliness lint reads.
 */
export interface OrchestrationGateDeps {
  /** Run a gate/deploy shell command in `cwd`; `met` = exit 0 (fail-closed). */
  checkAcceptanceCriterion: (
    cwd: string,
    command: string | undefined,
    timeoutMs?: number
  ) => Promise<{ met: boolean; output: string }>;
  /** One READ-ONLY review pass over the ticket's diff; persists + returns findings. */
  runAutoReview: (
    db: Database,
    input: AutoReviewInput,
    onHighFinding?: (finding: ReviewFinding) => void
  ) => Promise<AutoReviewResult>;
  /** Dispatch a fixer session for a blocking finding, reusing the change's worktree. */
  dispatchFixer: (db: Database, finding: ReviewFinding, cwd: string) => Promise<void>;
  /**
   * The diff the content-cleanliness lint reads (its ADDED lines). Reports
   * `gitError: true` when git itself failed (not a repo, a bad ref, a spawn
   * error) — distinct from a genuinely empty change (`{ diff: "", gitError:
   * false }`) — so the caller fails CLOSED on a broken diff rather than passing
   * the cleanliness scan with zero lines examined.
   */
  computeDiff: (
    worktreePath: string,
    baseBranch?: string
  ) => Promise<{ diff: string; gitError: boolean }>;
}

/**
 * The real cleanliness diff: a `git diff` from the base's merge-base to the
 * WORKING TREE (committed + uncommitted edits), mirroring the review diff's
 * anchor logic. Unlike the review path's computeDiff — which swallows failures
 * into "" — this reports whether git ITSELF failed so the cleanliness gate can
 * fail CLOSED: a non-zero git exit or a spawn throw yields `gitError: true`,
 * while a clean repo with no changes yields `{ diff: "", gitError: false }`.
 */
async function computeCleanlinessDiff(
  worktreePath: string,
  baseBranch?: string
): Promise<{ diff: string; gitError: boolean }> {
  const git = async (args: string[]) => {
    const proc = Bun.spawn(["git", "-C", worktreePath, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return { code: proc.exitCode ?? 1, out };
  };
  try {
    if (baseBranch) {
      // The base may exist only as its remote copy (a launch cut from origin/<base>).
      let mergeBase = await git(["merge-base", baseBranch, "HEAD"]);
      if (mergeBase.code !== 0) {
        const remote = resolveTargetBranch(worktreePath, baseBranch, defaultGitRunner).remote;
        mergeBase = await git(["merge-base", remote, "HEAD"]);
      }
      const anchor =
        mergeBase.code === 0 && mergeBase.out.trim() ? mergeBase.out.trim() : baseBranch;
      const diff = await git(["diff", anchor]);
      // A real base diff is the answer; an empty or failed one falls through to
      // the plain working-tree diff (the base ref may be absent in this tree).
      if (diff.code === 0 && diff.out.trim()) return { diff: diff.out, gitError: false };
    }
    const fallback = await git(["diff", "HEAD"]);
    if (fallback.code === 0) return { diff: fallback.out, gitError: false };
    // git ran but exited non-zero (not a repo, no HEAD, bad ref): fail closed.
    return { diff: "", gitError: true };
  } catch {
    // Could not even spawn git: fail closed.
    return { diff: "", gitError: true };
  }
}

/**
 * The real deps: the plan-gate shell runner, a review pass backed by a headless
 * read-only reviewer, a fixer dispatch mirroring the human `POST
 * /api/review-findings/:id/fix` path (buildFixerPrompt + launchSession on the
 * reused worktree), and a real `git diff`. Tests never touch these — they pass a
 * fully mocked seam.
 */
export function defaultOrchestrationGateDeps(): OrchestrationGateDeps {
  const autoReviewDeps = defaultAutoReviewDeps();
  return {
    checkAcceptanceCriterion,
    runAutoReview: (db, input, onHighFinding) =>
      realRunAutoReview(db, input, autoReviewDeps, onHighFinding),
    computeDiff: computeCleanlinessDiff,
    async dispatchFixer(db, finding, cwd) {
      // Mirror the human fix-dispatch endpoint: a FRESH session seeded with the
      // finding + reviewed diff (buildFixerPrompt), run IN the change's worktree
      // (reuseWorktreePath) so it amends the reviewed tree rather than a pristine
      // baseline. Best-effort — a missing ticket/project is a no-op, not a throw,
      // so one un-dispatchable finding never aborts the whole review loop.
      const request = fixerLaunchRequest(db, finding, cwd);
      if (request) await launchSession(db, request);
    },
  };
}

/**
 * The launch a finding's fixer runs as: a fresh session seeded with the
 * finding, in the change's worktree `cwd`, launched by whoever launched the
 * change it fixes as the collector recorded it on that launch (never a
 * caller-named actor). Null when the finding's ticket or project is gone.
 */
export function fixerLaunchRequest(db: Database, finding: ReviewFinding, cwd: string): LaunchRequest | null {
  const ticket = getTicket(db, finding.ticketId);
  if (!ticket) return null;
  const project = getProject(db, ticket.projectId);
  if (!project) return null;
  const launchedBy = ticket.launchId ? getLaunch(db, ticket.launchId)?.launchedBy : undefined;
  return {
    project,
    task: buildFixerPrompt(finding),
    label: `Fix: ${finding.title}`,
    reuseWorktreePath: cwd,
    ...(launchedBy ? { launchedBy } : {}),
  };
}

export interface RunOrchestrationInput {
  ticketId: string;
  profile: OrchestrationProfile;
  /** The change's worktree — where gates/deploys run and the diff is taken. */
  cwd: string;
  /** Base branch the review diff is taken against (the project's branch). */
  baseBranch?: string;
  /** Acting alias, used only to stamp a personal-scoped run's owner key. */
  alias?: string;
  /** Injectable outward-action seam; defaults to the real implementations. */
  deps?: OrchestrationGateDeps;
}

/**
 * The review-round budget a run is created with: the largest per-review-step cap
 * (`step.rounds ?? profile.maxReviewRounds ?? default`), else the profile-wide
 * cap, hard-clamped to MAX_REVIEW_ROUNDS. bumpOrchestrationRound enforces this as
 * the run's hard bound, so its `null` return is the authoritative "did not
 * converge" signal. The clamp is the DURABLE guard against an over-cap round
 * count — it feeds the run's `max_rounds` and the loop's hard cap — so even a
 * profile that slipped past store validation (or a stale stored one) can never
 * fan out more than MAX_REVIEW_ROUNDS fixer rounds. v1 shares one round counter
 * across all review steps of a profile; the common single-review profile has an
 * exact per-step cap.
 */
export function reviewRoundBudget(profile: OrchestrationProfile): number {
  const perStep = profile.steps
    .filter((s): s is Extract<OrchestrationStep, { kind: "review" }> => s.kind === "review")
    .map((s) => s.rounds ?? profile.maxReviewRounds ?? DEFAULT_MAX_REVIEW_ROUNDS);
  const budget = perStep.length
    ? Math.max(...perStep)
    : profile.maxReviewRounds ?? DEFAULT_MAX_REVIEW_ROUNDS;
  return Math.min(budget, MAX_REVIEW_ROUNDS);
}

/** The owner key a run is stamped with (bookkeeping; enforcement keys on ticketId). */
function runOwnerKey(profile: OrchestrationProfile, ticket: Ticket, alias?: string): string {
  switch (profile.scope) {
    case "global":
      return GLOBAL_ORCH_OWNER_KEY;
    case "project":
      return ticket.projectId;
    case "personal":
      return alias ?? ticket.sessionId ?? "personal";
  }
}

/**
 * The active run for a ticket, creating one (status `queued`) when none is in
 * flight. Idempotent: the kick-off endpoint calls this synchronously to return a
 * run id immediately, and the async loop calls it again and reuses that same row
 * rather than minting a second. A prior TERMINAL run (succeeded/failed/…) is not
 * "active", so a re-kick after one starts a fresh run. The check-then-insert is
 * racy under concurrent POSTs, so a partial unique index (one active run per
 * ticket) is the authoritative guard: the race-loser's insert throws and is
 * resolved back to the winning run here rather than surfacing an error.
 */
export function ensureOrchestrationRun(
  db: Database,
  opts: { ticket: Ticket; profile: OrchestrationProfile; alias?: string }
): OrchestrationRun {
  const existing = getActiveOrchestrationRunByTicket(db, opts.ticket.id);
  if (existing) return existing;
  try {
    return createOrchestrationRun(db, {
      id: randomUUID(),
      profileName: opts.profile.name,
      scope: opts.profile.scope,
      ownerKey: runOwnerKey(opts.profile, opts.ticket, opts.alias),
      projectId: opts.ticket.projectId,
      ticketId: opts.ticket.id,
      sessionId: opts.ticket.sessionId,
      launchId: opts.ticket.launchId,
      maxRounds: reviewRoundBudget(opts.profile),
    });
  } catch (err) {
    // A concurrent POST inserted the ticket's active run between the check above
    // and this insert; the partial unique index rejected the duplicate. Return
    // the winner instead of the constraint error — but only when an active run
    // now exists, so an unrelated failure still propagates.
    const raced = getActiveOrchestrationRunByTicket(db, opts.ticket.id);
    if (raced) return raced;
    throw err;
  }
}

/** The change's ADDED lines (diff `+` lines, minus the `+++` file header). */
function addedLines(diff: string): string {
  return diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

/**
 * Drive a resolved profile's steps IN ORDER against the ticket's run ledger, and
 * return the run's terminal state.
 *
 * Order of enforcement:
 *  1. E-wire content cleanliness (automatic, always): a non-inclusive term in
 *     the change's added lines FAILS the run before any step; ai-tell /
 *     long-sentence are recorded as non-blocking warnings.
 *  2. Each profile step:
 *     - gate:   the command must exit 0, else the run fails (fail-closed).
 *     - deploy: `target.command ?? command` must exit 0, else the run fails; a
 *               deploy step with NO command fails closed (never a silent skip).
 *     - review: loop review → dispatch fixer for each blocking finding → bump the
 *               round → re-review, until a round is clean or the round budget is
 *               exhausted (bumpOrchestrationRound null → run fails, "did not
 *               converge in N rounds").
 *     - human_pause: fail CLOSED — the step has no resume mechanism yet, so it
 *       terminates the run `failed` rather than parking it `running` forever
 *       (which would lock the completion choke). Store validation rejects it too.
 *  3. All required steps passing → the run succeeds.
 */
export async function runOrchestrationForTicket(
  db: Database,
  input: RunOrchestrationInput
): Promise<OrchestrationRun> {
  const deps = input.deps ?? defaultOrchestrationGateDeps();
  const { profile, cwd, baseBranch } = input;

  const ticket = getTicket(db, input.ticketId);
  if (!ticket) throw new Error(`orchestration: ticket not found: ${input.ticketId}`);

  let run = ensureOrchestrationRun(db, { ticket, profile, alias: input.alias });
  const runId = run.id;
  if (run.status === "queued") {
    run = updateOrchestrationRunStatus(db, runId, "running");
  }
  // A run already past `running` (succeeded on a prior drive, or reaped lost) is
  // returned as-is — never re-open a terminal run.
  if (run.status !== "running") return run;

  const fail = (summary: string): OrchestrationRun =>
    updateOrchestrationRunStatus(db, runId, "failed", { summary, error: summary });

  // 1. Automatic content-cleanliness gate (E-wire) on the change's added lines.
  // This pre-step runs UNCONDITIONALLY before every profile step, so failing it
  // closed on a git error gates the ENTIRE run: a broken diff can never slip
  // through to a downstream review step (which takes its own diff) with the
  // cleanliness scan silently skipped. A genuinely empty diff (gitError false)
  // keeps the pass-through — there is simply nothing to lint.
  const { diff: cleanlinessDiff, gitError } = await deps.computeDiff(cwd, baseBranch);
  if (gitError) {
    recordGateResult(db, {
      runId,
      round: run.round,
      stepIndex: -1,
      kind: "cleanliness",
      passed: false,
      detail: "could not compute the change diff — git error",
    });
    return fail("could not compute the change diff — git error; cannot verify the change.");
  }
  const cleanliness = validateCleanliness(addedLines(cleanlinessDiff));
  const inclusive = cleanliness.filter((f) => f.category === "inclusive-language");
  const softFindings = cleanliness.filter((f) => f.category !== "inclusive-language");
  if (softFindings.length > 0) {
    recordGateResult(db, {
      runId,
      round: run.round,
      stepIndex: -1,
      kind: "cleanliness",
      passed: true,
      detail: `${softFindings.length} non-blocking warning(s): ${softFindings
        .map((f) => `${f.category} "${f.match}"`)
        .join(", ")}`,
    });
  }
  if (inclusive.length > 0) {
    const terms = [...new Set(inclusive.map((f) => f.match))].join(", ");
    recordGateResult(db, {
      runId,
      round: run.round,
      stepIndex: -1,
      kind: "cleanliness",
      passed: false,
      detail: `non-inclusive term(s): ${terms}`,
    });
    return fail(`content-cleanliness gate failed — non-inclusive term(s) in the change: ${terms}.`);
  }

  // 2. Each profile step, in order.
  for (let stepIndex = 0; stepIndex < profile.steps.length; stepIndex++) {
    const step = profile.steps[stepIndex];
    run = heartbeatOrchestrationRun(db, runId);

    if (step.kind === "gate") {
      const { met, output } = await deps.checkAcceptanceCriterion(cwd, step.command);
      recordGateResult(db, {
        runId,
        round: run.round,
        stepIndex,
        kind: "gate",
        passed: met,
        detail: met ? undefined : `$ ${step.command}\n${output}`,
      });
      if (!met) return fail(`gate "${step.name}" failed — the command did not exit 0.`);
    } else if (step.kind === "deploy") {
      const command = step.target?.command ?? step.command;
      if (!command || !command.trim()) {
        // A deploy step with no runnable command cannot deploy. Fail CLOSED
        // rather than record a no-op skip that would let the run succeed WITHOUT
        // deploying. Store validation already rejects such a profile; this is the
        // runtime backstop for a stale or hand-built one.
        recordGateResult(db, {
          runId,
          round: run.round,
          stepIndex,
          kind: "deploy",
          passed: false,
          detail: "no deploy command configured",
        });
        return fail(`deploy step failed — no deploy command configured.`);
      }
      const { met, output } = await deps.checkAcceptanceCriterion(cwd, command);
      recordGateResult(db, {
        runId,
        round: run.round,
        stepIndex,
        kind: "deploy",
        passed: met,
        detail: met ? undefined : `$ ${command}\n${output}`,
      });
      if (!met) return fail(`deploy step failed — the deploy command did not exit 0.`);
    } else if (step.kind === "review") {
      const outcome = await runReviewStep(db, {
        runId,
        stepIndex,
        step,
        profile,
        ticket,
        cwd,
        baseBranch,
        deps,
      });
      if (!outcome.ok) return fail(outcome.failSummary);
      run = getOrchestrationRun(db, runId)!;
    } else if (step.kind === "human_pause") {
      // human_pause has no resume mechanism yet: leaving the run `running` would
      // lock the ticket's completion choke forever with no way to clear it. Fail
      // CLOSED (terminal) instead, so even a legacy or hand-built profile that
      // still carries this step can never strand a run. Store validation rejects
      // new profiles with a human_pause step; this is the runtime backstop.
      recordGateResult(db, {
        runId,
        round: run.round,
        stepIndex,
        kind: "human_pause",
        passed: false,
        detail: "human_pause steps are not yet supported",
      });
      return fail("human_pause steps are not yet supported");
    }
  }

  // 3. Every required step passed.
  return updateOrchestrationRunStatus(db, runId, "succeeded", {
    summary: `Orchestration profile "${profile.name}" passed all ${profile.steps.length} step(s).`,
  });
}

/**
 * One review STEP: a bounded convergence loop. Each round runs a review pass,
 * records the outcome, and — while a finding at or above the block threshold
 * survives — dispatches a fixer for each blocking finding and advances the round
 * via bumpOrchestrationRound. A `null` bump means the round budget is exhausted:
 * the step fails "did not converge". A round with no blocking finding is clean
 * and the step passes.
 */
async function runReviewStep(
  db: Database,
  args: {
    runId: string;
    stepIndex: number;
    step: Extract<OrchestrationStep, { kind: "review" }>;
    profile: OrchestrationProfile;
    ticket: Ticket;
    cwd: string;
    baseBranch?: string;
    deps: OrchestrationGateDeps;
  }
): Promise<{ ok: true } | { ok: false; failSummary: string }> {
  const { runId, stepIndex, step, profile, ticket, cwd, baseBranch, deps } = args;
  const threshold = step.blockOnSeverity ?? profile.blockOnSeverity ?? DEFAULT_BLOCK_SEVERITY;
  const thresholdRank = SEVERITY_RANK[threshold];

  // A hard iteration bound independent of the ledger, so a mocked/misconfigured
  // bump can never spin this loop forever.
  const hardCap = reviewRoundBudget(profile) + 1;
  for (let iteration = 0; iteration <= hardCap; iteration++) {
    const run = heartbeatOrchestrationRun(db, runId);
    // Known residual: the review computes its OWN diff via autoReviewDeps.computeDiff,
    // which swallows a git error to "" — a review-time git failure would yield an
    // empty diff, no findings, and a vacuous pass. The unconditional cleanliness
    // pre-step already fails the run closed on a PERSISTENT git error, so this is
    // only a gap for an error transient to the review moment.
    const result = await deps.runAutoReview(db, {
      ticket,
      worktreePath: cwd,
      baseBranch,
    });
    const blocking = result.findings.filter(
      (f) => SEVERITY_RANK[f.severity] >= thresholdRank
    );
    recordGateResult(db, {
      runId,
      round: run.round,
      stepIndex,
      kind: "review",
      passed: blocking.length === 0,
      detail:
        blocking.length === 0
          ? undefined
          : blocking.map((f) => `[${f.severity}] ${f.title}`).join("; "),
    });
    if (blocking.length === 0) return { ok: true };

    // Dispatch a fixer for each blocking finding on the reused worktree, then
    // advance the round and re-review.
    for (const finding of blocking) {
      await deps.dispatchFixer(db, finding, cwd);
    }
    const bumped = bumpOrchestrationRound(db, runId);
    if (!bumped) {
      return {
        ok: false,
        failSummary:
          `review did not converge in ${run.maxRounds} round(s) — ` +
          `${blocking.length} finding(s) at or above "${threshold}" remain: ` +
          blocking.map((f) => `[${f.severity}] ${f.title}`).join("; "),
      };
    }
  }
  // Unreachable under the ledger bound; the hard cap is a belt-and-suspenders stop.
  return {
    ok: false,
    failSummary: `review did not converge within its round budget.`,
  };
}

/**
 * The PURE, synchronous completion-choke state check: does the ticket's
 * orchestration enforcement block the developing -> needs_review transition?
 * Returns a refusal message, or null (pass-through) when there is nothing to
 * enforce or the run has succeeded.
 *
 * It NEVER runs the loop — that is the async runOrchestrationForTicket; this
 * only READS the ledger that loop writes, so it is safe on the sync HTTP path:
 *  - A run exists for this ticket → allow ONLY when it `succeeded`; otherwise
 *    block, naming the profile, the run's status/round, and the outstanding
 *    failed step(s)/findings.
 *  - No run yet, but a project/global profile resolves for the ticket → block
 *    until the loop is kicked off and succeeds. A personal-scope-only default is
 *    resolved best-effort via the ticket's launch requester (its owning alias),
 *    so it now enforces before its first run too; it stays `undefined` for an
 *    automatic launch with no requester (matching the launcher's best-effort
 *    actor semantics), and such a default is enforced once its run is kicked off.
 */
export function orchestrationReadyBlock(db: Database, ticket: Ticket): string | null {
  const run = getLatestOrchestrationRunByTicket(db, ticket.id);
  if (run) {
    if (run.status === "succeeded") return null;
    const failed = getGateResults(db, run.id).filter((r) => !r.passed);
    const outstanding = failed.length
      ? failed.map((r) => `${r.kind}${r.detail ? ` (${r.detail})` : ""}`).join("; ")
      : run.error || run.summary || "the loop has not completed";
    return (
      `This change is governed by orchestration profile "${run.profileName}". Its ` +
      `develop -> deploy -> review run is ${run.status} (round ${run.round}/${run.maxRounds}) — ` +
      `marking work ready is blocked until the run succeeds. Outstanding: ${outstanding}. ` +
      `Fix the work and re-run the orchestration loop (POST /api/orchestration/runs).`
    );
  }
  // A personal-scope default keys on the acting alias; the ticket carries none,
  // so resolve the owner best-effort from the implementing launch's requester.
  const alias = ticket.launchId ? getLaunch(db, ticket.launchId)?.requester : undefined;
  const profile = resolveActiveProfile(db, { projectId: ticket.projectId, alias });
  if (!profile) return null;
  // Actionable lockout message (M4): v1's recovery path is to (re-)launch or
  // dispatch the ticket, which starts the loop — and recreates the implementing
  // worktree if it was pruned (the kick-off endpoint 409s without one).
  return (
    `This change is governed by orchestration profile "${profile.name}", but no ` +
    `passing develop -> deploy -> review run exists for it yet. Marking work ready ` +
    `is blocked until one succeeds — launch or dispatch this ticket to start the ` +
    `orchestration loop (POST /api/orchestration/runs) and let it succeed. If the ` +
    `implementing worktree was pruned, re-launch the ticket to recreate it.`
  );
}
