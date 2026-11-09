import type { Database } from "bun:sqlite";
import type { Ticket, TicketSeverity, ReviewFinding } from "@standup/shared";
import { createReviewFinding, isHighSeverity, supersedeOpenFindings } from "@standup/store";
import { headlessSettingsArgs } from "./claude-cli.js";
import { withoutSlotEnv } from "./worker-env.js";
import { defaultGitRunner } from "./review/stage.js";
import { resolveTargetBranch } from "./target-branch.js";

/** The ticket/finding severity scale, low → critical. */
const SEVERITIES: readonly TicketSeverity[] = ["low", "medium", "high", "critical"];

/**
 * Auto-review reviewer/fixer split.
 *
 * On the `developing → needs_review` edge a READ-ONLY reviewer passes over the
 * ticket's diff and records what it finds as `review_findings`. It is
 * deliberately SEPARATE from the fixer: this module only ever RECORDS findings
 * — it holds no launch capability, so it structurally cannot dispatch a session.
 * The fixer runs solely on an explicit human "fix this finding" click (the
 * `POST /api/review-findings/:id/fix` endpoint in server.ts), never here.
 *
 * De-noise: every finding the reviewer emits is stored, but only High/critical
 * ones are surfaced at the human (`onHighFinding`) and shown on the Work
 * review-queue. Low/medium are recorded silently.
 *
 * The reviewer itself is a mockable seam (`AutoReviewDeps`): the default
 * implementation shells out to a headless read-only `claude`, but tests inject a
 * fake so the outward action is never taken in a test.
 */

/** A raw finding the reviewer emits, before it is persisted + severity-normalized. */
export interface ReviewerFinding {
  severity?: string;
  title: string;
  body?: string;
  file?: string;
  line?: number;
  /** Checks the reviewer ran (the validation-evidence bundle handed to the fixer). */
  checks?: string[];
  screenshots?: string[];
}

export interface AutoReviewInput {
  ticket: Ticket;
  /** The change's working directory — where the diff is computed from. */
  worktreePath: string;
  /** Base branch the diff is taken against (the project's branch). */
  baseBranch?: string;
}

export interface AutoReviewDeps {
  /** Produce the reviewed diff for the change. */
  computeDiff(worktreePath: string, baseBranch?: string): Promise<string>;
  /**
   * Run the READ-ONLY reviewer over the diff, returning raw findings. Never edits.
   *
   * Contract: a RESOLVED result is a COMPLETED pass — `[]` means the reviewer ran
   * and found the change genuinely clean, so on a re-review the prior pass's open
   * findings are superseded (the queue clears). A REJECTED result means the pass
   * did NOT complete (the reviewer process crashed, timed out, or could not be
   * read); `runAutoReview` then skips supersede so a transient failure preserves
   * the prior pass's still-open findings rather than silently wiping them off the
   * queue. Implementations must therefore throw on failure, never resolve `[]`.
   */
  runReviewer(input: {
    diff: string;
    ticket: Ticket;
    worktreePath: string;
  }): Promise<ReviewerFinding[]>;
}

export interface AutoReviewResult {
  /** Every finding persisted (all severities). */
  findings: ReviewFinding[];
  /** The High/critical subset — the ones surfaced at the human (de-noise). */
  high: ReviewFinding[];
  /**
   * Prior still-open findings this pass superseded (a re-review of the same
   * ticket). The caller broadcasts their removal so a stale one drops off the
   * live queue.
   */
  superseded: ReviewFinding[];
  /** The diff the reviewer saw, stamped into each finding's evidence bundle. */
  diff: string;
}

/** Normalize a reviewer-supplied severity onto the ticket severity scale. */
function normalizeSeverity(raw: string | undefined): TicketSeverity {
  const s = (raw ?? "").trim().toLowerCase();
  return (SEVERITIES as readonly string[]).includes(s) ? (s as TicketSeverity) : "medium";
}

/**
 * Run one non-destructive review pass for a ticket's change and persist the
 * findings. The reviewed diff is stamped into every finding's evidence bundle so
 * the fixer, at dispatch, sees the exact change the finding is about — the
 * collector owns `evidence.diff`, the reviewer only supplies `checks`/
 * `screenshots`. `onHighFinding` fires once per High/critical finding (the queue
 * signal); low/medium are stored but never pushed. An empty diff short-circuits:
 * there is nothing to review, so the reviewer is not even invoked.
 *
 * On a re-review of the same ticket (the needs_review -> developing ->
 * needs_review rework edge fires this gate again) the ticket's prior still-open
 * findings are superseded before the fresh set is recorded, so the de-noised
 * queue never stacks duplicate/stale High findings across rework cycles. The
 * superseded findings are returned so the caller can drop them off the live
 * queue.
 *
 * This function never launches anything — the fixer is a separate, explicitly
 * human-triggered path.
 */
export async function runAutoReview(
  db: Database,
  input: AutoReviewInput,
  deps: AutoReviewDeps,
  onHighFinding?: (finding: ReviewFinding) => void
): Promise<AutoReviewResult> {
  const diff = (await deps.computeDiff(input.worktreePath, input.baseBranch)).trim();
  if (!diff) {
    return { findings: [], high: [], superseded: [], diff: "" };
  }

  const raw = await deps.runReviewer({
    diff,
    ticket: input.ticket,
    worktreePath: input.worktreePath,
  });

  // A re-review (the needs_review -> developing -> needs_review rework edge fires
  // this gate a second time) reviews the CURRENT diff, so any still-open finding
  // from an earlier pass is stale: its evidence.diff is frozen at that pass's
  // review time and the defect it named is either gone or re-emitted by this pass.
  // Supersede those predecessors before recording the fresh set — otherwise the
  // de-noised queue would stack duplicate/stale High findings across rework
  // cycles and could seed a fixer with a pre-fix diff. A finding already
  // dispatched or dismissed is left untouched (fixer in flight / human verdict).
  //
  // This runs only past a COMPLETED reviewer pass: `runReviewer` rejects when the
  // reviewer process fails, so a transient failure (crash/timeout) propagates out
  // of this function BEFORE supersede — the prior pass's open findings survive on
  // the queue rather than being wiped by a failure that merely looks like "clean".
  const superseded = supersedeOpenFindings(db, input.ticket.id);

  const findings: ReviewFinding[] = [];
  const high: ReviewFinding[] = [];
  for (const r of raw) {
    const title = r.title?.trim();
    if (!title) continue; // a finding with no title is not actionable — drop it.
    const severity = normalizeSeverity(r.severity);
    const finding = createReviewFinding(db, {
      ticketId: input.ticket.id,
      sessionId: input.ticket.sessionId,
      severity,
      title,
      body: r.body?.trim() ?? "",
      file: r.file?.trim() || undefined,
      line: typeof r.line === "number" ? r.line : undefined,
      evidence: {
        checks: Array.isArray(r.checks) ? r.checks.filter((c) => typeof c === "string") : [],
        screenshots: Array.isArray(r.screenshots)
          ? r.screenshots.filter((s) => typeof s === "string")
          : [],
        diff,
      },
    });
    findings.push(finding);
    if (isHighSeverity(severity)) {
      high.push(finding);
      onHighFinding?.(finding);
    }
  }

  return { findings, high, superseded, diff };
}

/**
 * The fixer's opening prompt: seeds a FRESH agent with the specific finding plus
 * the reviewed diff (from the finding's evidence bundle) and the reviewer's
 * validation evidence, and scopes it to fixing ONLY that finding. Pure and
 * testable; the fix-dispatch endpoint feeds this to `launchSession`. Composing
 * the prompt does NOT dispatch anything — that is the endpoint's job, and only
 * on an explicit human click.
 */
export function buildFixerPrompt(finding: ReviewFinding): string {
  const where = finding.file
    ? `\nLocation: ${finding.file}${finding.line ? `:${finding.line}` : ""}`
    : "";
  const diff = finding.evidence.diff?.trim();
  const diffBlock = diff
    ? `\n\nThe reviewed change (the diff this finding is about):\n\`\`\`diff\n${diff}\n\`\`\``
    : "";
  const checks =
    finding.evidence.checks.length > 0
      ? `\n\nValidation evidence at hand-off — checks the reviewer ran: ${finding.evidence.checks.join(", ")}.`
      : "";
  const shots =
    finding.evidence.screenshots.length > 0
      ? ` Screenshots: ${finding.evidence.screenshots.join(", ")}.`
      : "";
  return [
    `A code reviewer flagged this issue on a change that is up for review. Fix ONLY this finding — do not take on unrelated work.`,
    ``,
    `Finding (${finding.severity}): ${finding.title}${where}`,
    finding.body.trim() ? `\n${finding.body.trim()}` : "",
    diffBlock,
    checks + shots,
    ``,
    `Make the smallest correct change that resolves the finding, then verify it.`,
  ].join("\n");
}

/** Model the default reviewer runs on — cheap + fast, matching the daily-review cron. */
const REVIEWER_MODEL = "claude-haiku-4-5-20251001";
/** Per-review agent wall-clock cap. */
const REVIEWER_TIMEOUT_MS = 6 * 60 * 1000;

/** Instruction handed to the read-only reviewer agent. */
function reviewerPrompt(diff: string, ticket: Ticket): string {
  return `You are a senior code reviewer doing ONE read-only pass over a change that is ready for review. You may ONLY read — never edit, never run destructive commands.

The change is for: ${ticket.title}
${ticket.body ? `\n${ticket.body}\n` : ""}
Here is the reviewed diff:
\`\`\`diff
${diff}
\`\`\`

Report the real defects you find. De-noise aggressively: only flag things a human would genuinely want to act on. For each, assign an honest severity — most findings are low/medium; reserve high/critical for correctness bugs, regressions, security issues, or broken contracts.

Output ONLY a JSON array (no prose, no fences) of findings, each an object:
{"severity": "low|medium|high|critical", "title": "...", "body": "what/where/why + suggested fix", "file": "repo-relative path", "line": 123, "checks": ["what you verified"]}
If the change is clean, output [].`;
}

/**
 * Pull the JSON findings array out of a headless `claude --output-format json`
 * envelope, distinguishing "read a findings array" from "couldn't read one".
 * The envelope's `result` holds the model's final text; the model was asked for
 * a bare JSON array, but tolerate stray prose by slicing to the outer brackets.
 *
 * Returns the parsed findings — a genuinely clean review yields `[]`. Returns
 * `null` when no readable findings array could be extracted: no brackets, a
 * `JSON.parse` failure (truncated/malformed array), a non-array value, or a
 * non-empty array whose every element is a non-finding (prose that merely
 * contained a bracketed list, or findings emitted with no `title`). That `null`
 * is a distinct "unreadable" signal, NOT a clean review — a prose refusal
 * ("I can't review this") or a max-token-truncated array must not be mistaken for
 * "the change is clean" and clear the queue. `runReviewer` throws on `null` so a
 * re-review over unreadable output preserves the prior pass's open findings.
 */
export function parseReviewerFindings(stdout: string): ReviewerFinding[] | null {
  let text = stdout;
  try {
    const envelope = JSON.parse(stdout) as { result?: unknown };
    if (typeof envelope.result === "string") text = envelope.result;
  } catch {
    // stdout wasn't the JSON envelope — fall through and scan the raw text.
  }
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const arr = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (!Array.isArray(arr)) return null;
    const findings = arr.filter(
      (x): x is ReviewerFinding =>
        !!x && typeof x === "object" && typeof (x as ReviewerFinding).title === "string"
    );
    // A genuinely clean review is a LITERAL empty array. A non-empty parse whose
    // every element is a non-finding is unreadable, not clean — prose that merely
    // contained a bracketed list (e.g. "lines [10, 20, 30]" slices to a numeric
    // array) or real findings emitted without the required `title` key. Reading
    // that as a clean [] would let a re-review supersede the prior pass's open
    // findings, so surface the `null` unreadable signal instead.
    if (arr.length > 0 && findings.length === 0) return null;
    return findings;
  } catch {
    return null;
  }
}

/**
 * Soft-miss wrapper over `parseReviewerFindings`: unreadable output degrades to
 * no findings rather than surfacing the `null` signal. Kept for callers that want
 * the lenient shape; the reviewer process path uses the strict variant so an
 * unreadable pass is never mistaken for a clean one.
 */
export function parseReviewerOutput(stdout: string): ReviewerFinding[] {
  return parseReviewerFindings(stdout) ?? [];
}

/**
 * Decide whether a finished reviewer subprocess is a COMPLETED, readable pass and
 * return its findings — or throw because it was not. This is the guard that keeps
 * a failed/unreadable pass from being mistaken for a clean one on the re-review
 * edge (a throw here makes `runAutoReview` skip supersede, preserving the prior
 * pass's open findings):
 *
 *  - A non-zero exit means the PROCESS failed (crash, timeout kill, missing
 *    binary) — not a completed pass — so its (empty) output must not read as
 *    "clean". Throw.
 *  - An exit-0 envelope can still flag its OWN failure via `is_error` (the
 *    canonical case is `error_max_turns` — the agent hit the turn/limit cap over a
 *    large diff — or a rate-limit/overload surfaced at exit 0). Its `result` may
 *    slice to a valid array (often `[]`), so mirror the sibling `--output-format
 *    json` readers and treat `is_error` as a mandatory failure signal: throw
 *    before trusting the sliced array.
 *  - On a clean exit, `parseReviewerFindings` returns `null` when no findings
 *    array could be read (a prose refusal, or a truncated/malformed array) — exit
 *    0 alone does NOT prove a readable pass. Throw on `null`.
 *  - A parsed array — including an empty one from a genuinely clean review — is a
 *    real completed pass and is returned so the queue clears.
 */
export function interpretReviewerResult(
  exitCode: number | null,
  stdout: string
): ReviewerFinding[] {
  if (exitCode !== 0) {
    throw new Error(`reviewer exited ${exitCode ?? "null"}`);
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    envelope = null;
  }
  if (
    !!envelope &&
    typeof envelope === "object" &&
    (envelope as { is_error?: unknown }).is_error === true
  ) {
    throw new Error("reviewer envelope reported is_error");
  }
  const findings = parseReviewerFindings(stdout);
  if (findings === null) {
    throw new Error("reviewer produced no readable findings array");
  }
  return findings;
}

/**
 * Default deps: a real `git diff` plus a headless read-only `claude` reviewer.
 * `reviewCwd` is where both the diff is taken and the agent is added (`--add-dir`).
 * The agent is spawned exactly like the daily-review cron's lens agents — no
 * write tools, no MCP, dropped `user` setting sources so global hooks never fire
 * and it never registers as a phantom Standup session.
 */
export function defaultAutoReviewDeps(): AutoReviewDeps {
  return {
    async computeDiff(worktreePath, baseBranch) {
      // Diff the base against the current WORKING TREE so the whole change is
      // reviewed — committed AND still-uncommitted edits. This is a two-dot
      // `git diff <anchor>` (commit → working tree), NOT a three-dot
      // `<base>...`: the three-dot form resolves to merge-base→HEAD and so
      // silently omits the working tree, hiding a session's final uncommitted
      // edit from the reviewer. The anchor is the merge-base of base and HEAD,
      // so commits that landed on the base after this worktree forked don't
      // appear as spurious reversals. Never throws — a diff we can't take
      // yields "" and the review is skipped.
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
          if (diff.code === 0 && diff.out.trim()) return diff.out;
        }
        // No base ref (or the base diff failed on an unrelated/absent base):
        // fall back to the plain working-tree diff before giving up.
        const fallback = await git(["diff", "HEAD"]);
        return fallback.code === 0 ? fallback.out : "";
      } catch {
        return "";
      }
    },
    async runReviewer({ diff, ticket, worktreePath }) {
      const proc = Bun.spawn(
        [
          "claude",
          "-p",
          reviewerPrompt(diff, ticket),
          "--model",
          REVIEWER_MODEL,
          "--add-dir",
          worktreePath,
          "--permission-mode",
          "bypassPermissions",
          "--setting-sources",
          "project",
          ...headlessSettingsArgs(),
          "--strict-mcp-config",
          // Read-only tool list — the reviewer cannot write, run the fixer, or
          // reach any MCP write tool. It is purely a reader over the diff.
          "--allowedTools",
          "Read,Grep,Glob",
          // A hard deny list is what actually enforces read-only: bypassPermissions
          // auto-approves every tool call, and --allowedTools only governs which
          // calls are auto-approved (not which the model may attempt), so on their
          // own the mutating tools would still run unprompted. Deny rules take
          // precedence over both the permission mode and the allow list, so the
          // reviewed diff — semi-untrusted, agent-authored content that can carry
          // injected instructions — structurally cannot induce a worktree edit or
          // a shell command.
          "--disallowedTools",
          "Write,Edit,MultiEdit,NotebookEdit,Bash",
          "--output-format",
          "json",
        ],
        { stdout: "pipe", stderr: "pipe", env: withoutSlotEnv() }
      );
      const timer = setTimeout(() => proc.kill(), REVIEWER_TIMEOUT_MS);
      try {
        const stdout = await new Response(proc.stdout).text();
        await proc.exited;
        // Fail closed on anything short of a completed, readable pass — a non-zero
        // exit (crashed/timed-out process) OR an exit-0 with output that carries no
        // findings array (a prose refusal, a truncated/malformed array). Either
        // throws, so on a re-review runAutoReview skips supersedeOpenFindings and
        // the prior pass's still-open findings survive on the queue instead of
        // being wiped by a failure that merely looks "clean". Any stdout-read /
        // spawn error propagates for the same reason.
        return interpretReviewerResult(proc.exitCode, stdout);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
