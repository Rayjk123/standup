import { isAbsolute } from "path";
import { GLOBAL_PROJECT_ID } from "@standup/shared";
import { UNVERIFIABLE_VERDICT, parseContradictsClaim, type KnowledgeDocFile } from "@standup/knowledge";
import { UNVERIFIED_CONFIDENCE, type DraftDispute, type DraftVerification } from "./draft-verify.js";
import type { DroppedDisputes } from "./knowledge-dispute-evidence.js";
import { repoStateDisputes, type RepoProbe } from "./knowledge-repo-claims.js";
import { SCRATCH_PROJECT_ID } from "./projects-registry.js";

/**
 * The fact-check an agent's published doc gets after it goes live at
 * UNVERIFIED_CONFIDENCE: the model fact-check against a checkout of the project
 * the doc is about (knowledge-verify-repos.ts resolves it), plus the git check
 * of its repository-state claims. With no checkout to check against, the doc is
 * recorded `unverifiable`.
 *
 * - The model check passes and git finds nothing: the doc is raised to full
 *   confidence and last_verified_at is stamped.
 * - The model check disputes it: the doc is recorded disputed with the model's
 *   findings (and git's, tagged).
 * - Otherwise git's findings, if any, are recorded for a human on an
 *   `unverified` verdict — never `disputed`, so they neither hold the doc out of
 *   injection nor count against it in a contradiction — and the doc stays
 *   pending.
 * - A check that could not read its repository's mainline records the doc
 *   `unverifiable` with the reason, and it stays pending.
 * - A check that did not complete changes nothing.
 * A result for a body that has since changed is dropped and not counted.
 *
 * A global or scratch doc's findings against a repository it only names (not
 * its source project's) never dispute it: alone, they leave it `unverifiable`.
 */

/** Whether `projectId` is a reserved corpus with no repository of its own. */
export function isCorpusProject(projectId: string): boolean {
  return projectId === GLOBAL_PROJECT_ID || projectId === SCRATCH_PROJECT_ID;
}

/** Whether an accepted doc is an agent proposal still awaiting a passing
 *  fact-check: unverified confidence, no verification stamp. */
export function isPendingVerification(
  doc: { originClass?: string; confidence?: number; lastVerifiedAt?: string } | null
): boolean {
  return !!doc && doc.originClass === "agent" && doc.confidence === UNVERIFIED_CONFIDENCE && !doc.lastVerifiedAt;
}

/** Fact-check attempts a doc body gets (the publish check and nightly retries). */
export const MAX_VERIFY_ATTEMPTS = 3;
/** Pending docs retried per run. */
export const VERIFY_RETRIES_PER_RUN = 5;

/** Docs whose fact-check is running in this process, `project/slug`. */
const inFlight = new Set<string>();

/** Whether a doc's fact-check is running right now. */
export function isVerificationInFlight(projectId: string, slug: string): boolean {
  return inFlight.has(`${projectId}/${slug}`);
}

/**
 * Whether a doc is still owed a fact-check: one is running, or it is pending
 * and its current body has attempts left. Such a doc is neither verified nor
 * refuted, so nothing may resolve a conflict against it yet.
 */
export function isAwaitingVerification(
  doc: { projectId: string; slug: string; originClass?: string; confidence?: number; lastVerifiedAt?: string },
  attempts: number
): boolean {
  return isVerificationInFlight(doc.projectId, doc.slug) || (isPendingVerification(doc) && attempts < MAX_VERIFY_ATTEMPTS);
}

export interface PublishVerifyDeps {
  /** The model fact-check (draft-verify's verifyDraft in production), against
   *  `repoPath` and any further checkouts the doc is about. */
  verify(slug: string, body: string, repoPath: string, additionalRepos?: string[]): Promise<DraftVerification>;
  readAcceptedDoc(projectId: string, slug: string): Promise<KnowledgeDocFile | null>;
  /** The doc's current verdict findings, from the index. */
  currentDisputes(projectId: string, slug: string): DraftDispute[];
  /** Writes full confidence + last_verified_at now, and re-indexes the doc. */
  stampVerified(projectId: string, slug: string): Promise<void>;
  /** Records the verdict; `repoPath` is the checkout it was produced against,
   *  null for one with no checkout behind it. */
  recordVerdict(projectId: string, slug: string, verdict: string, disputes: DraftDispute[], repoPath?: string | null): void;
  /** The project's other repo checkouts, for symbol claims. */
  otherRepos(projectId: string): string[];
  /** Counts a completed attempt on this body (not called for a stale result). */
  recordAttempt?(projectId: string, slug: string, body: string, outcome: PublishVerifyOutcome, repoPath: string): void;
  probe?: RepoProbe;
}

export type PublishVerifyOutcome = "clean" | "disputed" | "unchecked" | "stale";

/**
 * Where a doc's fact-check runs: a checkout of a project the doc is about —
 * with, for a global or scratch doc, the further checkouts of the other
 * projects it is about and the ids of the projects resolved — or nowhere, with
 * the reason.
 */
export type VerificationRepo =
  | {
      repo: string;
      additionalRepos?: string[];
      projects?: string[];
      /** The checkouts, among `repo` and `additionalRepos`, of projects a
       *  corpus doc only names rather than comes from. */
      namedRepos?: string[];
    }
  | { repo: null; reason: string };

/** Why a doc of `projectId` could not be fact-checked. */
export function noRepoReason(projectId: string): string {
  return `unverifiable: no repo for project ${projectId}`;
}

export function isWithin(path: string, root: string): boolean {
  const base = root.replace(/\/+$/, "");
  return path === base || path.startsWith(`${base}/`);
}

/**
 * The checkout a doc proposed into `targetProject` is fact-checked against.
 *
 * - Into the proposer's own project: the proposer's checkout (a launch
 *   worktree can sit outside the project's configured repos), provided
 *   `belongsTo` accepts it as that project's.
 * - Into another project: the proposer's checkout only when it lies inside one
 *   of that project's repos, else that project's first existing repo
 *   `belongsTo` accepts.
 * - None of those: unverifiable. A doc is never checked against a repository
 *   of a different project, whose verdict would say nothing about it.
 */
export function chooseVerificationRepo(input: {
  targetProject: string;
  proposerProject: string | null | undefined;
  proposerRepo: string | null | undefined;
  /** The project's existing repo checkouts, primary first. */
  projectRepos(projectId: string): string[];
  /** Whether a checkout belongs to the project (repo-ownership guard). */
  belongsTo?(path: string, projectId: string): boolean;
}): VerificationRepo {
  const { targetProject, proposerProject, proposerRepo } = input;
  if (
    targetProject === proposerProject &&
    proposerRepo &&
    (!input.belongsTo || input.belongsTo(proposerRepo, targetProject))
  ) {
    return { repo: proposerRepo };
  }
  const repos = input.projectRepos(targetProject).filter((r) => !input.belongsTo || input.belongsTo(r, targetProject));
  if (proposerRepo && repos.some((r) => isWithin(proposerRepo, r))) return { repo: proposerRepo };
  if (repos.length > 0) return { repo: repos[0]! };
  return { repo: null, reason: noRepoReason(targetProject) };
}

const NAMED_REPO_FINDING =
  "The fact-check's findings are all against repositories of projects this doc only mentions, so they do not dispute it; they are listed below for a human.";

/** The note recorded on a doc no checkout could check, carrying the reason. */
export function unverifiableDispute(
  reason: string,
  finding = "The fact-check was skipped: no repository checkout of the doc's project, or of a project it is about, is on this host to check it against."
): DraftDispute {
  return {
    claim: reason,
    finding,
    evidence: "projects.repos_json",
    origin: "repo",
  };
}

/**
 * Records that `projectId/slug` could not be fact-checked: an `unverifiable`
 * verdict carrying the reason (`contradicted` when it already had contradiction
 * edges, which are kept). The doc stays pending and injectable, and the note is
 * never weighed in a contradiction.
 */
export function recordUnverifiable(
  deps: Pick<PublishVerifyDeps, "currentDisputes" | "recordVerdict">,
  projectId: string,
  slug: string,
  reason: string
): void {
  const carried = deps.currentDisputes(projectId, slug).filter((d) => parseContradictsClaim(d.claim) !== null);
  deps.recordVerdict(
    projectId,
    slug,
    carried.length > 0 ? "contradicted" : UNVERIFIABLE_VERDICT,
    [...carried, unverifiableDispute(reason)],
    null
  );
  console.warn(`[knowledge-verify] ${projectId}/${slug}: ${reason}; fact-check skipped`);
}

/** The checkout among `repos` a dispute's cited or searched files lie in, if any. */
function disputeRepo(d: DraftDispute, repos: readonly string[]): string | null {
  const files = [...(d.citations ?? []).map((c) => c.file), ...(d.searched ?? [])].filter((f) => isAbsolute(f));
  for (const file of files) {
    const repo = repos.filter((r) => isWithin(file, r)).sort((a, b) => b.length - a.length)[0];
    if (repo) return repo;
  }
  return null;
}

/** Why a corpus doc's findings were set aside as only about repositories it names. */
export function namedRepoReason(projectId: string, repos: readonly string[]): string {
  return `unverifiable: the fact-check's findings are against ${repos.join(", ")}, which this ${projectId} doc only names`;
}

/**
 * Splits a corpus doc's model disputes into those against its source
 * project's checkout and those against checkouts it only names. A dispute
 * whose files lie in no checked repository goes with the primary `repoPath`.
 */
export function splitNamedRepoDisputes(
  disputes: readonly DraftDispute[],
  repoPath: string,
  additionalRepos: readonly string[],
  namedRepos: readonly string[]
): { source: DraftDispute[]; named: DraftDispute[] } {
  const repos = [repoPath, ...additionalRepos];
  const source: DraftDispute[] = [];
  const named: DraftDispute[] = [];
  for (const d of disputes) {
    const repo = disputeRepo(d, repos) ?? repoPath;
    (namedRepos.includes(repo) ? named : source).push(d);
  }
  return { source, named };
}

/**
 * The verdict a review draft's fact-check records, by the same rules as a
 * published doc's: model disputes only against checkouts the doc only names
 * make it `unverifiable` and are shown as notes; an `unverifiable` check stays
 * `unverifiable` with its reason; git's findings are shown alongside, and on
 * their own make it `unverified`. `namedRepos` defaults as in verifyPublishedDoc.
 */
export function draftVerdict(
  checked: DraftVerification,
  gitFindings: readonly DraftDispute[],
  projectId: string,
  repoPath: string,
  additionalRepos: readonly string[] = [],
  namedRepos: readonly string[] = isCorpusProject(projectId) ? additionalRepos : []
): { verdict: DraftVerification["verdict"]; disputes: DraftDispute[] } {
  if (checked.verdict === "disputed") {
    const { source, named } = splitNamedRepoDisputes(checked.disputes, repoPath, additionalRepos, namedRepos);
    const namedNotes = named.map((d): DraftDispute => ({ ...d, origin: "repo" }));
    if (source.length > 0) return { verdict: "disputed", disputes: [...source, ...namedNotes, ...gitFindings] };
    if (named.length > 0) {
      const repos = [...new Set(named.map((d) => disputeRepo(d, [repoPath, ...additionalRepos]) ?? repoPath))];
      return {
        verdict: UNVERIFIABLE_VERDICT,
        disputes: [unverifiableDispute(namedRepoReason(projectId, repos), NAMED_REPO_FINDING), ...namedNotes, ...gitFindings],
      };
    }
  }
  if (checked.verdict === UNVERIFIABLE_VERDICT) {
    return { verdict: UNVERIFIABLE_VERDICT, disputes: [...checked.disputes, ...gitFindings] };
  }
  const notes = checked.verdict === "unverified" ? checked.disputes : [];
  if (gitFindings.length > 0) return { verdict: "unverified", disputes: [...notes, ...gitFindings] };
  return { verdict: checked.verdict, disputes: checked.disputes };
}

/**
 * Fact-checks `body` of `projectId/slug` against `repoPath` (and any further
 * checkouts the doc is about) and records the result. `namedRepos` are the
 * checkouts of projects a corpus doc only names; by default, for a corpus doc,
 * the further checkouts (the source project's, when there is one, comes first).
 */
export async function verifyPublishedDoc(
  deps: PublishVerifyDeps,
  projectId: string,
  slug: string,
  body: string,
  repoPath: string,
  additionalRepos: string[] = [],
  namedRepos: string[] = isCorpusProject(projectId) ? additionalRepos : []
): Promise<{ outcome: PublishVerifyOutcome; disputes: DraftDispute[]; dropped?: DroppedDisputes }> {
  const key = `${projectId}/${slug}`;
  inFlight.add(key);
  try {
    let result: DraftVerification;
    try {
      result =
        additionalRepos.length > 0
          ? await deps.verify(slug, body, repoPath, additionalRepos)
          : await deps.verify(slug, body, repoPath);
    } catch (err) {
      console.error(`[knowledge-verify] ${key} failed:`, err);
      result = { verdict: "error", disputes: [] };
    }
    const repos = [
      ...new Set([repoPath, ...additionalRepos, ...deps.otherRepos(projectId)]),
    ];
    const gitFindings = await repoStateDisputes(body, repos, deps.probe).catch(() => []);
    const current = await deps.readAcceptedDoc(projectId, slug);
    if (!current || current.body !== body || !isPendingVerification(current)) {
      return { outcome: "stale", disputes: [] };
    }
    const carried = deps.currentDisputes(projectId, slug).filter((d) => parseContradictsClaim(d.claim) !== null);
    const held = carried.length > 0 ? "contradicted" : UNVERIFIABLE_VERDICT;
    const { source, named } =
      result.verdict === "disputed"
        ? splitNamedRepoDisputes(result.disputes, repoPath, additionalRepos, namedRepos)
        : { source: [], named: [] };
    // Findings against a repository the doc only names are shown, as notes.
    const namedNotes = named.map((d): DraftDispute => ({ ...d, origin: "repo" }));
    let outcome: PublishVerifyOutcome;
    let findings: DraftDispute[] = [];
    if (source.length > 0) {
      findings = [...source, ...namedNotes, ...gitFindings];
      deps.recordVerdict(projectId, slug, "disputed", [...carried, ...findings], repoPath);
      outcome = "disputed";
    } else if (named.length > 0) {
      const repos = [...new Set(named.map((d) => disputeRepo(d, [repoPath, ...additionalRepos]) ?? repoPath))];
      findings = [unverifiableDispute(namedRepoReason(projectId, repos), NAMED_REPO_FINDING), ...namedNotes, ...gitFindings];
      deps.recordVerdict(projectId, slug, held, [...carried, ...findings], null);
      outcome = "unchecked";
    } else if (result.verdict === UNVERIFIABLE_VERDICT) {
      findings = [...result.disputes, ...gitFindings];
      deps.recordVerdict(projectId, slug, held, [...carried, ...findings], null);
      outcome = "unchecked";
    } else if (result.verdict === "clean" && gitFindings.length === 0) {
      await deps.stampVerified(projectId, slug);
      if (carried.length > 0) deps.recordVerdict(projectId, slug, "contradicted", carried, repoPath);
      else deps.recordVerdict(projectId, slug, "clean", [], repoPath);
      outcome = "clean";
    } else {
      // Git's findings, and the notes of a check whose findings were all set
      // aside, are for a human: shown, but neither verifying nor disputing the doc.
      const notes = result.verdict === "unverified" ? result.disputes : [];
      if (gitFindings.length > 0 || notes.length > 0) {
        findings = [...notes, ...gitFindings];
        deps.recordVerdict(
          projectId,
          slug,
          carried.length > 0 ? "contradicted" : "unverified",
          [...carried, ...findings],
          repoPath
        );
      } else {
        console.warn(`[knowledge-verify] ${key}: fact-check did not complete; left unverified`);
      }
      outcome = "unchecked";
    }
    deps.recordAttempt?.(projectId, slug, body, outcome, repoPath);
    return { outcome, disputes: findings, ...(result.dropped ? { dropped: result.dropped } : {}) };
  } finally {
    inFlight.delete(key);
  }
}

export interface RetryPendingDeps {
  verifyDeps: PublishVerifyDeps;
  /** The checkout(s) a doc is retried against, each belonging to a project the
   *  doc is about — resolved through the repo-ownership guard
   *  (knowledge-verify-repos.ts's retryRepoFor), never a project's first repo
   *  taken unguarded; null skips the doc. */
  repoFor(
    projectId: string,
    slug: string,
    body: string
  ): string | { repo: string; additionalRepos?: string[]; namedRepos?: string[] } | null;
  attempts(projectId: string, slug: string, body: string): number;
  /** Claims one model spawn; false once the run's budget is spent. */
  tryConsume?(): boolean;
}

/** Verdicts a retry may revisit: none yet, a check that errored, git findings
 *  with no model verdict, or no repo to check against (one may exist since).
 *  A model's dispute is never re-rolled. */
const RETRYABLE_VERDICTS = new Set<string | undefined>([undefined, "error", "unverified", UNVERIFIABLE_VERDICT]);

/**
 * Retries the fact-check of agent docs still pending — published while no repo
 * was reachable, or whose check did not complete — a bounded number of times
 * per body, so a doc is not left at UNVERIFIED_CONFIDENCE for good by one
 * failure. Returns how many it checked.
 */
export async function retryPendingVerifications(
  deps: RetryPendingDeps,
  docs: ReadonlyArray<{
    projectId: string;
    slug: string;
    body: string;
    originClass?: string;
    confidence?: number;
    lastVerifiedAt?: string;
    verdict?: string;
  }>,
  limit: number = VERIFY_RETRIES_PER_RUN
): Promise<number> {
  let checked = 0;
  for (const doc of docs) {
    if (checked >= limit) break;
    if (!isPendingVerification(doc) || isVerificationInFlight(doc.projectId, doc.slug)) continue;
    if (!RETRYABLE_VERDICTS.has(doc.verdict)) continue;
    if (deps.attempts(doc.projectId, doc.slug, doc.body) >= MAX_VERIFY_ATTEMPTS) continue;
    const target = deps.repoFor(doc.projectId, doc.slug, doc.body);
    if (!target) continue;
    const repo = typeof target === "string" ? target : target.repo;
    const additionalRepos = typeof target === "string" ? [] : (target.additionalRepos ?? []);
    const namedRepos = typeof target === "string" ? undefined : target.namedRepos;
    if (deps.tryConsume && !deps.tryConsume()) break;
    checked++;
    await verifyPublishedDoc(deps.verifyDeps, doc.projectId, doc.slug, doc.body, repo, additionalRepos, namedRepos).catch((err) =>
      console.error(`[knowledge-verify] retry ${doc.projectId}/${doc.slug} failed:`, err)
    );
  }
  return checked;
}
