import type { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { KNOWLEDGE_RESOLVE_CWD, ensureInternalCwd } from "./internal-cwd.js";
import type { DocVerdictState } from "./knowledge-coherence.js";
import { isAwaitingVerification } from "./knowledge-publish-verify.js";
import {
  createKnowledgeResolution,
  getKnowledgeResolution,
  markResolutionAutoApplied,
} from "@standup/store";
import {
  deriveConfidence,
  parseContradictsClaim,
  contradictionDisputes,
  readKnowledgeFile,
  writeKnowledgeFile,
  getVerificationState,
  updateDocFrontmatter,
  KnowledgeStore,
  DISPUTED_CONFIDENCE,
  DEFAULT_HALF_LIFE_DAYS,
  UNVERIFIABLE_VERDICT,
  type KnowledgeBackend,
  type KnowledgeDoc,
  type DraftDispute,
  type OriginClass,
  type SourceKind,
  type SearchResult,
  type SearchOptions,
} from "@standup/knowledge";

/**
 * Automatic contradiction resolution (roadmap r7). When the coherence pass flags
 * a NEW `contradicts` edge between two accepted docs (knowledge-coherence.ts), a
 * detached resolver decides how to reconcile the pair and — for the safe cases
 * only — applies the fix without a human, keeping the corpus coherent as it
 * self-grows rather than parking every conflict in a review queue.
 *
 * Three resolution shapes, all reversible (history preserved, confidence decayed
 * rather than hard-deleted):
 *
 * - `rescope`  — narrow BOTH claims with a scoping qualifier so they no longer
 *   conflict (e.g. "on the beta stack" vs "in production"). Nothing is
 *   superseded, so it is always safe to auto-apply.
 * - `supersede` — the losing claim is tombstoned (verdict "superseded", held out
 *   of injection) with its confidence decayed, and the winning claim's
 *   contradiction flag is cleared so it is re-admitted. The doc stays on disk
 *   and in search — a human can revive it by editing.
 * - `merge`    — combine both into the winner's body, then supersede the loser
 *   with a tombstone (same non-destructive supersede as above). The winner's body
 *   BEFORE the merge is recorded on the resolution ledger row (`priorWinnerBody`),
 *   so the one shape that rewrites a kept doc stays reversible too.
 *
 * AUTONOMY GATE. Only NON-destructive resolutions are auto-applied. A resolution
 * that would hard-delete a claim, or supersede a HUMAN-authored (`owner`) or a
 * HIGH-confidence claim, is NOT applied: it is recorded as a `needs_review`
 * resolution (the durable human-review queue entry) describing the proposal for
 * a human to accept, and the docs are left untouched (still flagged
 * "contradicted" so the conflict stays visible).
 *
 * The whole orchestration is pure of I/O beyond its injected deps — the resolver
 * LLM call, the corpus search, the doc reads/writes, the verdict writes, and the
 * ledger write are all seams — so it is unit-testable with a deterministic
 * resolver stub and NO network, filesystem, or `claude` spawn.
 */

/** The resolution shapes a proposal can take. `delete` is a hard removal a
 *  resolver may recommend; it is never auto-applied (always needs review). */
export type ResolutionType = "rescope" | "merge" | "supersede" | "delete";

/**
 * A claim under conflict, loaded with the provenance/confidence/trust the
 * autonomy gate reads. The body + title feed the resolver's grounding.
 */
export interface ClaimRecord {
  slug: string;
  title: string;
  body: string;
  originClass?: OriginClass;
  sourceKind?: SourceKind;
  /** Stored base confidence at `lastVerifiedAt`; decayed to "now" for the gate. */
  confidence?: number;
  lastVerifiedAt?: string;
  halfLifeDays?: number;
  generatedFromSha?: string;
}

/** The two claims plus the grounding assembled for the resolver LLM. */
export interface ResolverInput {
  /** The project the conflicting pair lives in — lets the production resolver
   *  locate the repo to ground itself in code. */
  projectId: string;
  a: ClaimRecord;
  b: ClaimRecord;
  /** Corpus (and, in production, code) context grounding the resolution. */
  grounding: string;
}

/**
 * The resolver's proposal. `winnerSlug`/`loserSlug` name the two claims in the
 * conflicting pair — for `supersede`/`merge`/`delete` the loser is the one
 * tombstoned/removed; for `rescope` both are kept and narrowed.
 */
export interface ResolutionProposal {
  type: ResolutionType;
  winnerSlug: string;
  loserSlug: string;
  /** For `rescope`: the scoping qualifier appended to each claim's body. */
  rescope?: { winnerQualifier: string; loserQualifier: string };
  /** For `merge`: the combined body written into the winner. */
  mergedBody?: string;
  /** One-line rationale, recorded on the ledger and (for supersede) the tombstone. */
  rationale: string;
}

/**
 * The injectable resolver LLM call. Returns a proposal, or null when it cannot
 * decide (the conflict then stays flagged for human review by the coherence
 * pass's existing prioritization). Injected so tests run deterministically with
 * no network; production spawns Haiku (runClaudeContradictionResolver).
 */
export type ContradictionResolver = (
  input: ResolverInput
) => Promise<ResolutionProposal | null>;

/**
 * Above this decayed confidence a claim is "high-confidence" and superseding it
 * is treated as destructive — a human must confirm. Sits above
 * MIN_INJECTION_CONFIDENCE (0.25) so a merely-aging doc that has decayed out of
 * injection is still auto-resolvable, while a freshly-verified or strongly-held
 * doc is not tombstoned without sign-off.
 */
export const HIGH_CONFIDENCE_THRESHOLD = 0.75;

/** The dispute-claim prefix a tombstone carries, naming the winning doc. Kept
 *  distinct from CONTRADICTS_CLAIM_PREFIX so the graph never reads a resolved
 *  tombstone as a live `contradicts` edge. */
export const SUPERSEDED_CLAIM_PREFIX = "Superseded by ";

/** The tombstone dispute stamped on a superseded loser, naming its winner. */
export function supersededTombstone(
  winnerSlug: string,
  rationale: string
): DraftDispute {
  return {
    claim: `${SUPERSEDED_CLAIM_PREFIX}${winnerSlug}`,
    finding:
      rationale ||
      `Superseded by ${winnerSlug} — a contradiction was resolved in its favor.`,
    evidence: `Auto-resolved contradiction: this claim was tombstoned in favor of ${winnerSlug}. Revive it by editing the doc if it is still correct.`,
  };
}

/** Whether a dispute claim is a supersede tombstone (naming the winner) rather
 *  than a fact-check finding or a `Contradicts <slug>` edge. Distinct from both,
 *  so edge-clearing on an already-tombstoned doc can recognize the tombstone
 *  instead of miscounting it as a live fact dispute. */
export function isSupersededTombstone(claim: string): boolean {
  return claim.startsWith(SUPERSEDED_CLAIM_PREFIX);
}

export interface ResolutionDecision {
  autoApply: boolean;
  reason: string;
}

/** Whether a rescope proposal carries BOTH non-blank scoping qualifiers — the
 *  only shape that actually narrows the two claims. A rescope missing them (or
 *  with a blank/one-sided qualifier) narrows nothing, so it is neither
 *  auto-applyable nor recordable as a coherent proposal. */
export function hasRescopeQualifiers(proposal: ResolutionProposal): boolean {
  return Boolean(
    proposal.rescope &&
      proposal.rescope.winnerQualifier.trim() &&
      proposal.rescope.loserQualifier.trim()
  );
}

/**
 * Why applying a destructive change to `claim` needs a human, or null when it is
 * safe (a low-confidence agent-authored doc). A human-authored (`owner`) claim,
 * or one whose CURRENT (decayed) confidence is still high, is protected; a claim
 * with no confidence opinion is treated conservatively as high (it opted into no
 * decay, so nothing lets us call it stale enough to touch automatically). `role`
 * names the side and `verb` the operation so the reason reads for a reviewer.
 */
function protectedClaimReason(
  claim: ClaimRecord,
  now: Date,
  role: string,
  verb: string
): string | null {
  if (claim.originClass === "owner") {
    return `the ${role} claim is human-authored (owner) — a human must confirm ${verb} it`;
  }
  // A losing agent claim nothing has verified carries no earned confidence,
  // whatever number it was published with. A winner keeps the full gate: its
  // body is what a rescope or merge rewrites.
  if (role === "losing" && isUnverifiedAgentClaim(claim)) return null;
  const current = deriveConfidence(
    {
      confidence: claim.confidence,
      lastVerifiedAt: claim.lastVerifiedAt,
      halfLifeDays: claim.halfLifeDays,
    },
    now
  );
  if (current === undefined || current >= HIGH_CONFIDENCE_THRESHOLD) {
    const level = current === undefined ? "no decay opinion" : current.toFixed(2);
    return `the ${role} claim is high-confidence (${level}) — a human must confirm ${verb} it`;
  }
  return null;
}

/** An agent-written claim nothing has verified: no last_verified_at stamp (an
 *  agent doc is published at UNVERIFIED_CONFIDENCE without one, and only a
 *  passing fact-check stamps it). */
export function isUnverifiedAgentClaim(claim: ClaimRecord): boolean {
  return claim.originClass === "agent" && !claim.lastVerifiedAt;
}

/**
 * The autonomy gate: whether a proposal is safe to apply without a human. Pure
 * so the whole decision is unit-testable.
 *
 * - `rescope` keeps both claims (only narrows them) but does so by APPENDING an
 *   LLM-generated qualifier to BOTH bodies, so it is gated exactly like a merge
 *   winner: an owner/high-confidence doc on EITHER side would have its
 *   authoritative body silently rewritten, which needs a human. A rescope of two
 *   low-confidence agent docs (with both scoping qualifiers present) is safe; a
 *   qualifier-less rescope narrows nothing and is not auto-applyable.
 * - `delete` is a hard removal — never auto-applied.
 * - `supersede` tombstones the loser. Tombstoning a human-authored (`owner`) or
 *   still-high-confidence claim is destructive and needs review; tombstoning a
 *   low-confidence agent claim is safe (reversible, history kept).
 * - `merge` tombstones the loser AND overwrites the WINNER's body with
 *   LLM-generated text, so it is gated on BOTH sides: an owner/high-confidence
 *   winner (its human-written body would be silently rewritten) or loser needs
 *   review.
 *
 * A losing claim that is an unverified agent claim is never protected by its
 * confidence number; the WINNER of a rescope or merge, whose body is rewritten,
 * keeps the full protection. The gate is evaluated on the claims as they are
 * at resolve time.
 */
export function classifyResolution(
  proposal: ResolutionProposal,
  loser: ClaimRecord,
  winner: ClaimRecord,
  now: Date
): ResolutionDecision {
  if (proposal.type === "delete") {
    return {
      autoApply: false,
      reason: "hard delete is never auto-applied — a human must confirm removing a claim",
    };
  }
  if (proposal.type === "rescope") {
    if (!hasRescopeQualifiers(proposal)) {
      return {
        autoApply: false,
        reason: "rescope proposal has no scoping qualifiers to narrow the claims",
      };
    }
    // A rescope appends the qualifier to BOTH bodies, so an owner or
    // high-confidence doc on EITHER side would have its authoritative body
    // silently rewritten (e.g. a prod-truth owner doc gaining "This only holds on
    // the beta stack."). Withhold for a human then — the same protection the merge
    // winner gets, applied to both narrowed docs.
    const winnerGate = protectedClaimReason(winner, now, "winning", "rescoping");
    if (winnerGate) return { autoApply: false, reason: winnerGate };
    const loserGate = protectedClaimReason(loser, now, "losing", "rescoping");
    if (loserGate) return { autoApply: false, reason: loserGate };
    return {
      autoApply: true,
      reason: "rescope narrows two low-confidence agent claims — reversible, no owner body rewritten",
    };
  }
  // A merge rewrites the winner's whole body, so an owner/high-confidence winner
  // is as protected as the loser it tombstones.
  if (proposal.type === "merge") {
    const winnerGate = protectedClaimReason(winner, now, "winning", "overwriting");
    if (winnerGate) return { autoApply: false, reason: winnerGate };
  }
  const loserGate = protectedClaimReason(loser, now, "losing", "superseding");
  if (loserGate) return { autoApply: false, reason: loserGate };
  const current = deriveConfidence(
    {
      confidence: loser.confidence,
      lastVerifiedAt: loser.lastVerifiedAt,
      halfLifeDays: loser.halfLifeDays,
    },
    now
  );
  if (isUnverifiedAgentClaim(loser)) {
    return {
      autoApply: true,
      reason: "the losing claim is an unverified agent-authored doc — safe to supersede with a tombstone",
    };
  }
  return {
    autoApply: true,
    reason: `the losing claim is a low-confidence (${current!.toFixed(2)}) agent-authored doc — safe to supersede with a tombstone`,
  };
}

/**
 * Strips the `Contradicts <otherSlug>` dispute off a doc's current verdict state
 * and recomputes the verdict — the "clear the edge" step. A doc that still
 * carries a fact-check dispute stays "disputed"; one that still opposes ANOTHER
 * doc stays "contradicted"; one with nothing left is cleared (null), re-admitting
 * it to injection. Pure.
 */
export function clearContradictionEdge(
  current: DocVerdictState | null,
  otherSlug: string
): { verdict: string | null; disputes: DraftDispute[] } {
  const kept = (current?.disputes ?? []).filter(
    (d) => parseContradictsClaim(d.claim) !== otherSlug
  );
  // A doc that still carries a supersede tombstone is a RETIRED loser, not a
  // fact-disputed doc. Clearing a now-moot contradiction edge on it (a shared-node
  // 3-way race can call this on a doc a concurrent resolution just tombstoned) must
  // leave it superseded — never revive it to "disputed" by miscounting its
  // "Superseded by X" tombstone as a fact-check finding.
  if (kept.some((d) => isSupersededTombstone(d.claim))) {
    return { verdict: "superseded", disputes: kept };
  }
  // A git or no-repo note (origin set) is for a human, never a fact dispute.
  const isNote = (d: DraftDispute) => d.origin !== undefined;
  const stillFactDisputed = kept.some(
    (d) => parseContradictsClaim(d.claim) === null && !isSupersededTombstone(d.claim) && !isNote(d)
  );
  const stillContradicts = kept.some((d) => parseContradictsClaim(d.claim) !== null);
  // Git findings leave a doc `unverified`; a no-repo note alone, `unverifiable`.
  let verdict: string | null = null;
  if (stillFactDisputed) verdict = "disputed";
  else if (stillContradicts) verdict = "contradicted";
  else if (kept.some((d) => d.origin === "git")) verdict = "unverified";
  else if (kept.some(isNote)) verdict = UNVERIFIABLE_VERDICT;
  return { verdict, disputes: kept };
}

/** The record persisted for a resolution attempt (applied or withheld). */
export interface ResolutionRecord {
  id: string;
  projectId: string;
  winnerSlug: string;
  loserSlug: string;
  type: ResolutionType;
  status: "applied" | "needs_review";
  autoApplied: boolean;
  rationale: string;
  detail?: string;
}

/**
 * The side effects resolveContradiction performs, injected so the orchestration
 * is testable without a backend, filesystem, or `claude` spawn.
 */
export interface ResolveDeps {
  /** Loads a conflicting claim's body + provenance/confidence. Null when the doc
   *  no longer exists (renamed/removed since the flag). */
  loadClaim(projectId: string, slug: string): ClaimRecord | null;
  /** Reads a doc's current verdict + disputes so clearing the edge folds onto
   *  (never clobbers) whatever else it carries. */
  getVerdictState(projectId: string, slug: string): DocVerdictState | null;
  /** Corpus grounding search — the KnowledgeBackend search seam. */
  search(projectId: string, query: string, options?: SearchOptions): Promise<SearchResult[]>;
  /** The injectable resolver LLM call (deterministic stub in tests). */
  resolve: ContradictionResolver;
  /** Writes a losing claim's decayed confidence + last_verified_at into its
   *  frontmatter, keeping the doc (history). */
  decayConfidence(
    projectId: string,
    slug: string,
    confidence: number,
    lastVerifiedAt: string
  ): Promise<void>;
  /** Records a doc's verdict + disputes; a null verdict clears it. */
  setVerdict(
    projectId: string,
    slug: string,
    verdict: string | null,
    disputes: DraftDispute[]
  ): void | Promise<void>;
  /** Appends a scoping qualifier to a claim's body, preserving its frontmatter. */
  rescopeBody(projectId: string, slug: string, qualifier: string): Promise<void>;
  /** Replaces the winner's body with the merged doc, preserving its frontmatter. */
  mergeBody(projectId: string, winnerSlug: string, mergedBody: string): Promise<void>;
  /** Re-reads the project's docs from disk after a body/frontmatter write. */
  resync(projectId: string): Promise<void>;
  /** Slugs of OTHER docs carrying a `Contradicts <slug>` dispute pointing at the
   *  given doc — the third docs still flagged against it. Used when a loser is
   *  tombstoned to clear their now-moot edge to the retired claim so they don't
   *  stay flagged forever against a doc that no longer participates in injection.
   *  Optional so the orchestration stays testable without a corpus. */
  findContradictors?(projectId: string, slug: string): string[];
  /** Persists the resolution ledger row. */
  recordResolution(record: ResolutionRecord): void;
  /** The status of any resolution ALREADY recorded for this pair (by its stable
   *  {@link resolutionId}), or null when none. Lets a re-verify cycle that
   *  re-detects an already-resolved or still-pending pair skip the resolver spawn
   *  and the review notification instead of re-firing them every cooldown —
   *  detection re-finds a needs-review pair (both docs still live + "contradicted")
   *  each cron tick, and re-spawning the model + re-notifying on the unchanged pair
   *  is pure waste. Optional so the orchestration stays testable without a ledger. */
  getExistingResolution?(id: string): ExistingResolution | null;
  /** Whether a doc is still owed a fact-check (running, or pending with
   *  attempts left). A pair with such a side is left for later: the doc is
   *  neither verified nor refuted yet. Optional; absent reads as never. */
  isVerificationPending?(projectId: string, slug: string): boolean;
  /** Flips a withheld row to applied once the gate, re-evaluated on the claims
   *  as they are now, releases it. Optional; without it a withheld row is left
   *  for a human. */
  markAutoApplied?(id: string): void;
  /** Surfaces a withheld (needs-review) resolution — a feed nudge in production;
   *  omitted in tests. */
  onNeedsReview?(record: ResolutionRecord): void;
  now?: () => Date;
}

/** A resolution already on the ledger for a pair: its status, plus the
 *  recorded proposal for a withheld one. */
export interface ExistingResolution {
  status: "applied" | "needs_review";
  type?: ResolutionType;
  winnerSlug?: string;
  loserSlug?: string;
  rationale?: string;
  detail?: string;
}

export type ResolveOutcome =
  | { status: "applied"; type: ResolutionType; winnerSlug: string; loserSlug: string }
  | {
      status: "needs-review";
      type: ResolutionType;
      winnerSlug: string;
      loserSlug: string;
      reason: string;
    }
  | { status: "declined" }
  | { status: "skipped"; reason: string };

/** The ledger row's `detail` JSON: the gate reason plus the full proposal
 *  specifics a human review needs to SEE the proposal and a later accept needs to
 *  REPLAY it (the rescope qualifiers and the merged body). A withheld
 *  (needs_review) row is dead-lettered without this — its detail is all an accept
 *  path has to reconstruct the proposal from.
 *
 *  For a merge it also captures `priorWinnerBody` — the winner's content BEFORE it
 *  was overwritten with the LLM-generated merged body. A merge is the one shape
 *  that rewrites a KEPT doc rather than tombstoning the retired one, so without
 *  this the winner's original text would be lost. Recording it on the durable
 *  ledger row keeps the merge reversible (a human can restore the winner from it),
 *  mirroring the tombstone that preserves the superseded loser. */
function resolutionDetail(
  proposal: ResolutionProposal,
  decisionReason: string,
  priorWinnerBody?: string
): string {
  return JSON.stringify({
    reason: decisionReason,
    ...(proposal.rescope ? { rescope: proposal.rescope } : {}),
    ...(proposal.type === "merge" && proposal.mergedBody
      ? { mergedBody: proposal.mergedBody, priorWinnerBody: priorWinnerBody ?? "" }
      : {}),
  });
}

/** A stable id for a resolution keyed on the project and the UNORDERED pair, so a
 *  retry, a redelivery, or a both-directions race (W→X and X→W) all map to ONE
 *  ledger row under INSERT OR IGNORE — the ledger can never grow unbounded for a
 *  pair that is already resolved. Exported so a caller (e.g. a backfill that
 *  enumerates flagged pairs) can look a pair up in the resolutions ledger under
 *  the same key this module writes it under, without re-deriving the hash. */
export function resolutionId(
  projectId: string,
  winnerSlug: string,
  loserSlug: string
): string {
  const pair = [winnerSlug, loserSlug].sort().join(" ");
  return createHash("sha1").update(`${projectId} ${pair}`).digest("hex");
}

/** Project-scoped key for the UNORDERED pair — the in-flight lock and the ledger
 *  id share this so both directions of one conflict collapse to one unit. */
function pairKey(projectId: string, slugA: string, slugB: string): string {
  return `${projectId} ${[slugA, slugB].sort().join(" ")}`;
}

/**
 * Pairs a detached resolver is currently working, keyed by {@link pairKey}. When
 * two clean subjects mutually contradict, the reverify/accept loops fire
 * resolveContradiction(W,[X]) AND resolveContradiction(X,[W]); without this guard
 * each would tombstone the other as loser and the whole pair would vanish from
 * the corpus (data loss). The check-and-claim runs synchronously at the top of
 * resolveContradiction (before any await), so on a single-threaded runtime the
 * second call sees the claim and skips.
 */
const inFlightPairs = new Set<string>();

/**
 * Resolves a single flagged contradiction between `slugA` and `slugB`. Loads
 * both claims, grounds a proposal from the injected resolver, and either
 * auto-applies a non-destructive resolution (clearing the edge) or records a
 * human-review entry for a destructive one. Never throws for a merely-declined
 * or missing-claim case; callers still wrap it in try/catch as detached work.
 */
export async function resolveContradiction(
  deps: ResolveDeps,
  projectId: string,
  slugA: string,
  slugB: string
): Promise<ResolveOutcome> {
  const key = pairKey(projectId, slugA, slugB);
  // Claim the pair synchronously (before any await) so a concurrent
  // opposite-direction resolver on the same pair skips instead of racing us into
  // tombstoning both docs.
  if (inFlightPairs.has(key)) {
    return { status: "skipped", reason: "a resolution for this pair is already in flight" };
  }
  inFlightPairs.add(key);
  try {
    return await resolveContradictionLocked(deps, projectId, slugA, slugB);
  } finally {
    inFlightPairs.delete(key);
  }
}

async function resolveContradictionLocked(
  deps: ResolveDeps,
  projectId: string,
  slugA: string,
  slugB: string
): Promise<ResolveOutcome> {
  const a = deps.loadClaim(projectId, slugA);
  const b = deps.loadClaim(projectId, slugB);
  if (!a || !b) return { status: "skipped", reason: "a conflicting claim no longer exists" };

  // A pair where either side is ALREADY tombstoned is already resolved — the
  // opposite-direction chain of a race, or a re-fire on a stale flag. Skipping
  // here (before the resolver spawn) is what stops the sequential half of the
  // both-directions race from superseding the surviving winner too, and stops a
  // re-recalled superseded loser from being re-resolved every cron cycle.
  if (
    deps.getVerdictState(projectId, slugA)?.verdict === "superseded" ||
    deps.getVerdictState(projectId, slugB)?.verdict === "superseded"
  ) {
    return { status: "skipped", reason: "the pair is already resolved — one claim is tombstoned" };
  }

  // Dedup against a prior resolution of this exact pair (stable, order-independent
  // id). A withheld (needs_review) pair leaves both docs live + "contradicted", so
  // the re-verify cron re-detects it every cooldown; without this it would re-spawn
  // the model and re-fire the review notification indefinitely on an unchanged
  // pair. An already-applied pair likewise should not be silently re-auto-resolved
  // (e.g. a rescope re-confirmed by the judge would otherwise append qualifiers
  // again, growing the body unbounded) — one auto-resolution per pair, then it is a
  // human's call. Skip BEFORE the resolver spawn.
  if (deps.isVerificationPending?.(projectId, slugA) || deps.isVerificationPending?.(projectId, slugB)) {
    return { status: "skipped", reason: "a claim's fact-check is still running" };
  }

  const existingId = resolutionId(projectId, slugA, slugB);
  const existing = deps.getExistingResolution?.(existingId);
  if (existing) {
    // A withheld proposal is re-gated on the claims as they are now: a loser that
    // was held because of the confidence it was published at is released once
    // that confidence is seen for what it is (an unverified agent claim). No new
    // model call — the recorded proposal is what is applied.
    if (existing.status === "needs_review" && deps.markAutoApplied) {
      const released = await releaseWithheld(deps, projectId, existingId, existing, a, b);
      if (released) return released;
    }
    return {
      status: "skipped",
      reason: `this pair already has a ${existing.status} resolution — not re-resolving`,
    };
  }

  const grounding = await buildGrounding(deps, projectId, a, b);
  const proposal = await deps.resolve({ projectId, a, b, grounding });
  if (!proposal) return { status: "declined" };

  // The proposal must name the two claims actually in conflict — a resolver that
  // hallucinated a third slug can't be trusted to have reasoned about this pair.
  const pair = new Set([slugA, slugB]);
  if (
    !pair.has(proposal.winnerSlug) ||
    !pair.has(proposal.loserSlug) ||
    proposal.winnerSlug === proposal.loserSlug
  ) {
    return { status: "skipped", reason: "resolver named a claim outside the conflicting pair" };
  }

  // A rescope that narrows nothing (missing/blank qualifiers) would clear the
  // contradiction edge on BOTH docs without scoping either — re-admitting two
  // genuinely-opposing docs unqualified. Decline it outright (no mutation, no
  // ledger row); the pair stays flagged for a human.
  if (proposal.type === "rescope" && !hasRescopeQualifiers(proposal)) {
    return { status: "skipped", reason: "rescope proposal has no scoping qualifiers to narrow the claims" };
  }

  const now = deps.now?.() ?? new Date();
  const loser = proposal.loserSlug === a.slug ? a : b;
  const winner = proposal.winnerSlug === a.slug ? a : b;
  const decision = classifyResolution(proposal, loser, winner, now);

  const record: ResolutionRecord = {
    id: resolutionId(projectId, proposal.winnerSlug, proposal.loserSlug),
    projectId,
    winnerSlug: proposal.winnerSlug,
    loserSlug: proposal.loserSlug,
    type: proposal.type,
    status: decision.autoApply ? "applied" : "needs_review",
    autoApplied: decision.autoApply,
    rationale: proposal.rationale,
    // Snapshot the winner's body BEFORE applyResolution overwrites it (merge only),
    // so the ledger row carries the pre-merge content and the merge stays reversible.
    detail: resolutionDetail(proposal, decision.reason, winner.body),
  };

  if (!decision.autoApply) {
    // Destructive: withhold. Record the proposal for a human and leave the docs
    // flagged "contradicted" so the conflict stays visible until a human acts.
    deps.recordResolution(record);
    deps.onNeedsReview?.(record);
    return {
      status: "needs-review",
      type: proposal.type,
      winnerSlug: proposal.winnerSlug,
      loserSlug: proposal.loserSlug,
      reason: decision.reason,
    };
  }

  await applyResolution(deps, projectId, proposal, winner, loser, now);
  deps.recordResolution(record);
  return {
    status: "applied",
    type: proposal.type,
    winnerSlug: proposal.winnerSlug,
    loserSlug: proposal.loserSlug,
  };
}

/**
 * Applies a NON-destructive resolution to the corpus (the mutation half of
 * resolveContradiction, and the human-accept path's shared apply): narrows a
 * rescope's two claims, or tombstones the loser (decayed confidence + a
 * "superseded" verdict that KEEPS the loser's own fact-check findings) and clears
 * the winner's — and any third doc's — now-moot contradiction edge. The gate is
 * the caller's responsibility; this is called only after classifyResolution
 * cleared it (auto path) or a human accepted it. Assumes a rescope carries valid
 * qualifiers (resolveContradiction / acceptResolution guard that first).
 */
async function applyResolution(
  deps: ResolveDeps,
  projectId: string,
  proposal: ResolutionProposal,
  winner: ClaimRecord,
  loser: ClaimRecord,
  now: Date
): Promise<void> {
  const nowIso = now.toISOString();
  if (proposal.type === "rescope") {
    // Narrow both claims, then clear the contradiction edge on both — neither is
    // superseded.
    await deps.rescopeBody(projectId, winner.slug, proposal.rescope!.winnerQualifier);
    await deps.rescopeBody(projectId, loser.slug, proposal.rescope!.loserQualifier);
    await deps.resync(projectId);
    await clearEdgeOn(deps, projectId, winner.slug, loser.slug);
    await clearEdgeOn(deps, projectId, loser.slug, winner.slug);
    return;
  }

  // supersede / merge: for a merge, fold the combined body into the winner first;
  // then tombstone the loser (decayed confidence + "superseded" verdict) and clear
  // the winner's contradiction flag so it is re-admitted to injection.
  if (proposal.type === "merge" && proposal.mergedBody) {
    await deps.mergeBody(projectId, winner.slug, proposal.mergedBody);
  }
  // Decay the loser's confidence in its frontmatter, then resync so the DB row
  // reflects it — recording the verdict AFTER the resync is what makes this pass's
  // verdict stick (upsertDoc preserves the verdict column).
  await deps.decayConfidence(projectId, loser.slug, DISPUTED_CONFIDENCE, nowIso);
  await deps.resync(projectId);
  await tombstoneLoser(deps, projectId, winner.slug, loser.slug, proposal.rationale);
  await clearEdgeOn(deps, projectId, winner.slug, loser.slug);
  // Any THIRD doc that only opposed the loser now opposes a tombstoned,
  // out-of-injection claim, so its `Contradicts <loser>` edge is moot — clear it
  // so it isn't left flagged "contradicted" forever against a retired doc.
  const thirdDocs = (deps.findContradictors?.(projectId, loser.slug) ?? []).filter(
    (slug) => slug !== winner.slug && slug !== loser.slug
  );
  for (const z of thirdDocs) {
    await clearEdgeOn(deps, projectId, z, loser.slug);
  }
}

/**
 * Stamps the "superseded" tombstone on the loser while PRESERVING its own
 * fact-check findings (history a human still needs) and dropping every stale
 * `Contradicts <other>` edge it carried — the loser is retired, so those edges
 * are moot, and its winner-edge is replaced by the tombstone naming the winner.
 */
async function tombstoneLoser(
  deps: ResolveDeps,
  projectId: string,
  winnerSlug: string,
  loserSlug: string,
  rationale: string
): Promise<void> {
  const state = deps.getVerdictState(projectId, loserSlug);
  const factChecks = (state?.disputes ?? []).filter(
    (d) => parseContradictsClaim(d.claim) === null
  );
  await deps.setVerdict(projectId, loserSlug, "superseded", [
    ...factChecks,
    supersededTombstone(winnerSlug, rationale),
  ]);
}

/**
 * Whether the withheld resolution's LOSER — the doc an accept would tombstone — is
 * still flagged as contradicting the winner, read from the live verdict state. The
 * coherence pass flags a contradiction with MUTUAL edges (flagContradictions writes
 * a `Contradicts <other>` dispute onto BOTH docs), and the only way a human revives
 * a doc is by editing it, which clears THAT doc's verdict + disputes
 * (clearDocVerdict) and nothing else — a one-sided clear that leaves the untouched
 * doc's now-stale edge behind. So the reversibility guard is LOSER-centric: it asks
 * whether the LOSER still opposes the winner, not whether EITHER side does. An OR
 * over both edges would be satisfied by the winner's lingering stale edge alone and
 * re-tombstone a loser the human just brought back. A loser already tombstoned
 * ("superseded") means the pair was resolved. Reads only the injected verdict seam,
 * so it is deterministic.
 */
function pairStillContradicts(
  deps: ResolveDeps,
  projectId: string,
  winnerSlug: string,
  loserSlug: string
): boolean {
  const winnerState = deps.getVerdictState(projectId, winnerSlug);
  const loserState = deps.getVerdictState(projectId, loserSlug);
  if (winnerState?.verdict === "superseded" || loserState?.verdict === "superseded") {
    return false;
  }
  // The loser is the side an accept tombstones, so the guard is whether the LOSER
  // still carries its `Contradicts <winner>` edge. A human revives the loser by
  // editing it (clearDocVerdict clears only the loser's disputes); the winner's
  // untouched stale edge must NOT keep the pair reading as "still contradicting".
  return (loserState?.disputes ?? []).some(
    (d) => parseContradictsClaim(d.claim) === winnerSlug
  );
}

/**
 * Applies a withheld resolution's recorded proposal when the autonomy gate,
 * evaluated on the current claims, now allows it — and the pair still
 * contradicts. Returns the applied outcome, or null to leave the row for a human.
 */
async function releaseWithheld(
  deps: ResolveDeps,
  projectId: string,
  id: string,
  existing: ExistingResolution,
  a: ClaimRecord,
  b: ClaimRecord
): Promise<ResolveOutcome | null> {
  if (!existing.type || !existing.winnerSlug || !existing.loserSlug) return null;
  const proposal = proposalFromResolution({
    type: existing.type,
    winnerSlug: existing.winnerSlug,
    loserSlug: existing.loserSlug,
    rationale: existing.rationale ?? "",
    detail: existing.detail,
  });
  if (!proposal || proposal.type === "delete") return null;
  const winner = proposal.winnerSlug === a.slug ? a : proposal.winnerSlug === b.slug ? b : null;
  const loser = proposal.loserSlug === a.slug ? a : proposal.loserSlug === b.slug ? b : null;
  if (!winner || !loser || winner === loser) return null;
  const now = deps.now?.() ?? new Date();
  if (!classifyResolution(proposal, loser, winner, now).autoApply) return null;
  if (!pairStillContradicts(deps, projectId, proposal.winnerSlug, proposal.loserSlug)) return null;
  await applyResolution(deps, projectId, proposal, winner, loser, now);
  deps.markAutoApplied!(id);
  return {
    status: "applied",
    type: proposal.type,
    winnerSlug: proposal.winnerSlug,
    loserSlug: proposal.loserSlug,
  };
}

/**
 * Applies a previously-withheld (needs_review) proposal because a HUMAN accepted
 * it — the accept path the durable review queue exists to serve. Bypasses the
 * autonomy gate (a human is the authority) but keeps every other safety property
 * of the auto path: it re-loads the claims (skips if one is gone), re-validates a
 * rescope's qualifiers, re-checks the pair STILL contradicts (a stale withheld row
 * whose docs a human already revived is a no-op — replaying it would re-tombstone
 * the revived doc), and reuses the same non-destructive applyResolution. It does
 * NOT record a new ledger row — the caller flips the existing row to `applied`.
 * Never throws for a merely-missing/invalid case.
 */
export async function acceptResolution(
  deps: ResolveDeps,
  projectId: string,
  proposal: ResolutionProposal
): Promise<ResolveOutcome> {
  const winner = deps.loadClaim(projectId, proposal.winnerSlug);
  const loser = deps.loadClaim(projectId, proposal.loserSlug);
  if (!winner || !loser) {
    return { status: "skipped", reason: "a conflicting claim no longer exists" };
  }
  if (proposal.type === "rescope" && !hasRescopeQualifiers(proposal)) {
    return { status: "skipped", reason: "rescope proposal has no scoping qualifiers to narrow the claims" };
  }
  if (proposal.type === "delete") {
    return { status: "skipped", reason: "a hard delete is not applied through this path" };
  }
  // Re-check the pair still contradicts before applying. A withheld row can sit in
  // the review queue while a human independently revives one of the docs; blindly
  // replaying the proposal would re-tombstone a claim they deliberately brought
  // back.
  if (!pairStillContradicts(deps, projectId, proposal.winnerSlug, proposal.loserSlug)) {
    return {
      status: "skipped",
      reason: "the pair no longer contradicts — a human revived or resolved it since this resolution was withheld",
    };
  }
  const now = deps.now?.() ?? new Date();
  await applyResolution(deps, projectId, proposal, winner, loser, now);
  return {
    status: "applied",
    type: proposal.type,
    winnerSlug: proposal.winnerSlug,
    loserSlug: proposal.loserSlug,
  };
}

/**
 * Rejects a withheld resolution WITHOUT superseding either claim — the human
 * dismissed the proposal. The coherence pass flags a contradiction with MUTUAL
 * `Contradicts <other>` edges on both docs, so a reject just strips that edge off
 * BOTH sides (recomputing each verdict) so neither doc stays flagged
 * "contradicted"; nothing is tombstoned, no body is rewritten. Reuses the same
 * edge-clearing the auto/accept paths use (clearEdgeOn → clearContradictionEdge),
 * so it never revives a doc that still carries a real fact-check dispute or a
 * live edge to a THIRD doc. Never throws for a merely-missing doc. The caller
 * voids the ledger row; note that re-detection may re-surface the pair later.
 */
export async function rejectResolution(
  deps: ResolveDeps,
  projectId: string,
  winnerSlug: string,
  loserSlug: string
): Promise<void> {
  await clearEdgeOn(deps, projectId, winnerSlug, loserSlug);
  await clearEdgeOn(deps, projectId, loserSlug, winnerSlug);
}

/**
 * The mirror-image proposal with winner and loser reversed — the "swap winner"
 * action, where a human applies the held resolution but with the opposite call on
 * which claim wins (e.g. tombstone the doc the resolver had picked as winner). A
 * rescope's per-side qualifiers are swapped alongside the roles so each doc still
 * receives the qualifier meant for it (a rescope keeps both claims, so the swap is
 * body-neutral there); a merge's combined body follows the new winner. Pure so the
 * swap semantics are unit-testable.
 */
export function swapProposal(proposal: ResolutionProposal): ResolutionProposal {
  return {
    ...proposal,
    winnerSlug: proposal.loserSlug,
    loserSlug: proposal.winnerSlug,
    rescope: proposal.rescope
      ? {
          winnerQualifier: proposal.rescope.loserQualifier,
          loserQualifier: proposal.rescope.winnerQualifier,
        }
      : undefined,
  };
}

/**
 * Reconstructs the proposal a withheld resolution recorded, from its ledger
 * columns (type/winner/loser/rationale) plus the `detail` JSON (the rescope
 * qualifiers / merged body). Returns null when the row can't yield an applyable
 * proposal — a rescope whose qualifiers weren't persisted (a legacy row), so an
 * accept can't silently re-admit two docs unnarrowed. The accept route reads this.
 */
export function proposalFromResolution(row: {
  type: ResolutionType;
  winnerSlug: string;
  loserSlug: string;
  rationale: string;
  detail?: string;
}): ResolutionProposal | null {
  let detail: {
    rescope?: { winnerQualifier?: unknown; loserQualifier?: unknown };
    mergedBody?: unknown;
  } = {};
  if (row.detail) {
    try {
      detail = JSON.parse(row.detail);
    } catch {
      detail = {};
    }
  }
  const proposal: ResolutionProposal = {
    type: row.type,
    winnerSlug: row.winnerSlug,
    loserSlug: row.loserSlug,
    rationale: row.rationale,
  };
  if (row.type === "rescope") {
    const winnerQualifier = detail.rescope?.winnerQualifier;
    const loserQualifier = detail.rescope?.loserQualifier;
    if (
      typeof winnerQualifier !== "string" ||
      typeof loserQualifier !== "string" ||
      !winnerQualifier.trim() ||
      !loserQualifier.trim()
    ) {
      return null;
    }
    proposal.rescope = { winnerQualifier, loserQualifier };
  }
  if (row.type === "merge" && typeof detail.mergedBody === "string") {
    proposal.mergedBody = detail.mergedBody;
  }
  return proposal;
}

/** Reads a doc's current verdict state, strips the `Contradicts <other>` dispute,
 *  and writes back the recomputed verdict — the edge-clearing write. */
async function clearEdgeOn(
  deps: ResolveDeps,
  projectId: string,
  slug: string,
  otherSlug: string
): Promise<void> {
  const cleared = clearContradictionEdge(deps.getVerdictState(projectId, slug), otherSlug);
  await deps.setVerdict(projectId, slug, cleared.verdict, cleared.disputes);
}

/** Assembles corpus grounding for the resolver from the docs most similar to the
 *  pair, excluding the pair itself. Best-effort — a search hiccup yields no
 *  grounding rather than aborting the resolution. */
async function buildGrounding(
  deps: ResolveDeps,
  projectId: string,
  a: ClaimRecord,
  b: ClaimRecord
): Promise<string> {
  try {
    const query = `${a.title} ${b.title}`.slice(0, 500);
    const hits = await deps.search(projectId, query, { corpus: "project", limit: 5 });
    const lines = hits
      .filter((h) => h.slug !== a.slug && h.slug !== b.slug)
      .slice(0, 3)
      .map((h) => `- [${h.slug}] ${h.excerpt}`.replace(/\s+/g, " ").slice(0, 400));
    return lines.length ? `Related corpus context:\n${lines.join("\n")}` : "";
  } catch {
    return "";
  }
}

// ── Production resolver ───────────────────────────────────────────────────────

const RESOLVER_MODEL = "claude-haiku-4-5-20251001";
const RESOLVER_TIMEOUT_MS = 90_000;

function buildResolverPrompt(input: ResolverInput): string {
  const { a, b, grounding } = input;
  return `Two accepted knowledge-base documents CONTRADICT each other — they make claims about the same thing that cannot both be true. Decide how to reconcile them.

--- DOCUMENT A (${a.slug}) ---
title: ${a.title}
origin: ${a.originClass ?? "unknown"}   confidence: ${a.confidence ?? "n/a"}

${a.body}
--- END A ---

--- DOCUMENT B (${b.slug}) ---
title: ${b.title}
origin: ${b.originClass ?? "unknown"}   confidence: ${b.confidence ?? "n/a"}

${b.body}
--- END B ---

${grounding ? grounding + "\n\n" : ""}Choose ONE resolution:
- "rescope": both claims are actually true under different scopes (env, version, subsystem). Give a short scoping qualifier for each so they no longer conflict.
- "supersede": one claim is correct and the other is wrong/outdated. Name the winner and the loser; the loser is tombstoned.
- "merge": both hold partial truth better stated as one document. Give the combined body; the loser is tombstoned in favor of the winner.
- "delete": one claim should be removed entirely (rare; a human will confirm).

Reply with ONLY a JSON object and nothing else:
{"type":"rescope|supersede|merge|delete","winnerSlug":"<slug>","loserSlug":"<slug>","rescope":{"winnerQualifier":"...","loserQualifier":"..."},"mergedBody":"...","rationale":"one sentence"}

Include "rescope" only for a rescope, "mergedBody" only for a merge. winnerSlug and loserSlug must each be exactly "${a.slug}" or "${b.slug}".`;
}

/**
 * Parses the resolver's reply into a proposal. Fail-closed: any unparseable
 * reply, an unknown type, or a missing required field resolves to null, so a
 * flaky resolver never triggers a mutation — the conflict simply stays flagged.
 * Pure and exported so the brittle real-model parse is deterministically tested.
 */
export function parseResolverOutput(raw: string): ResolutionProposal | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let parsed: {
    type?: unknown;
    winnerSlug?: unknown;
    loserSlug?: unknown;
    rescope?: { winnerQualifier?: unknown; loserQualifier?: unknown };
    mergedBody?: unknown;
    rationale?: unknown;
  };
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  const type = parsed.type;
  if (type !== "rescope" && type !== "merge" && type !== "supersede" && type !== "delete") {
    return null;
  }
  if (typeof parsed.winnerSlug !== "string" || typeof parsed.loserSlug !== "string") {
    return null;
  }
  const proposal: ResolutionProposal = {
    type,
    winnerSlug: parsed.winnerSlug,
    loserSlug: parsed.loserSlug,
    rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
  };
  if (type === "rescope") {
    // rescope is fail-closed on its required fields, exactly like an unknown type
    // or a missing slug: a rescope narrows nothing without BOTH scoping qualifiers
    // (missing rescope object, non-string, or blank), yet it would still clear the
    // contradiction edge on both docs — re-admitting two genuinely-opposing docs
    // unqualified. Reject it so the pair simply stays flagged.
    const winnerQualifier = parsed.rescope?.winnerQualifier;
    const loserQualifier = parsed.rescope?.loserQualifier;
    if (
      typeof winnerQualifier !== "string" ||
      typeof loserQualifier !== "string" ||
      !winnerQualifier.trim() ||
      !loserQualifier.trim()
    ) {
      return null;
    }
    proposal.rescope = { winnerQualifier, loserQualifier };
  }
  if (type === "merge" && typeof parsed.mergedBody === "string") {
    proposal.mergedBody = parsed.mergedBody;
  }
  return proposal;
}

/**
 * The production resolver: a Haiku `claude` reasoning over the two doc texts plus
 * the corpus grounding assembled by buildGrounding, with NO tools and NO repo
 * access — the same hard isolation the contradiction judge uses, and for the same
 * reason. Its inputs are UNTRUSTED corpus bodies (agent-distilled from arbitrary
 * analyzed repos, or a crafted proposed doc), and its OUTPUT (a rescope qualifier
 * or a merged body) is written straight back into the corpus and re-indexed as
 * trusted context — potentially into a global cross-project corpus. Giving it
 * Read/Grep + `--add-dir <repo>` (auto-approved under bypassPermissions) would let
 * an injected instruction in a doc body pull real file contents (a `.env`, a
 * credentials file) INTO the merged body — prompt-injection exfiltration plus
 * corpus poisoning. `--tools ""` disables the whole built-in toolset, so there is
 * nothing to bypass: the model can only reason over the prompt text, and code
 * grounding, when needed, must arrive through the trusted search seam, never a
 * live file read. Same reserved cwd + dropped `user` setting source as the judge
 * so global hooks never fire. Never throws — any failure resolves to null (no
 * mutation).
 */
export async function runClaudeContradictionResolver(
  input: ResolverInput
): Promise<ResolutionProposal | null> {
  ensureInternalCwd(KNOWLEDGE_RESOLVE_CWD);
  const args = [
    "claude",
    "-p",
    buildResolverPrompt(input),
    "--model",
    RESOLVER_MODEL,
    // No tools at all — the resolver reasons over the two doc texts + the corpus
    // grounding in the prompt and needs nothing else. Its inputs are untrusted and
    // its output is written back into the corpus, so no built-in tool (Read/Grep/
    // Glob included) may run; `--tools ""` is the same defense the judge applies,
    // stricter than a deny list because there is no tool to bypass even with the
    // permission mode relaxed below.
    "--tools",
    "",
    "--permission-mode",
    "bypassPermissions",
    "--setting-sources",
    "project",
    "--strict-mcp-config",
    "--output-format",
    "json",
  ];

  const proc = Bun.spawn(args, {
    cwd: KNOWLEDGE_RESOLVE_CWD,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), RESOLVER_TIMEOUT_MS);
  try {
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    if (proc.exitCode !== 0) return null;
    const envelope = JSON.parse(stdout) as { result?: string; is_error?: boolean };
    if (envelope.is_error || !envelope.result) return null;
    return parseResolverOutput(envelope.result);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Wiring ────────────────────────────────────────────────────────────────────

/** Maps a KnowledgeDoc-shaped row to the ClaimRecord the resolver reads. */
function toClaim(doc: {
  slug: string;
  title: string;
  body: string;
  originClass?: OriginClass;
  sourceKind?: SourceKind;
  confidence?: number;
  lastVerifiedAt?: string;
  halfLifeDays?: number;
  generatedFromSha?: string;
}): ClaimRecord {
  return {
    slug: doc.slug,
    title: doc.title,
    body: doc.body,
    originClass: doc.originClass,
    sourceKind: doc.sourceKind,
    confidence: doc.confidence,
    lastVerifiedAt: doc.lastVerifiedAt,
    halfLifeDays: doc.halfLifeDays,
    generatedFromSha: doc.generatedFromSha,
  };
}

/** The production wiring for resolveContradiction's seams. */
export interface ResolveWiring {
  db: Database;
  /** The KnowledgeBackend read side (getDoc / search) — the same seam the
   *  detection path already threads through. */
  backend: Pick<KnowledgeBackend, "search" | "getDoc">;
  /** Corpus root for the file-level frontmatter/body writes. */
  knowledgeDir: string;
  /** Records / clears a doc's verdict in the DB (knowledgeSync.recordDocVerdict /
   *  clearDocVerdict). */
  recordDocVerdict: (projectId: string, slug: string, verdict: string, disputes: unknown[]) => void;
  clearDocVerdict: (projectId: string, slug: string) => void;
  /** Re-reads a project's docs from disk into the index after a write. */
  syncProject: (projectId: string) => Promise<void>;
  /** The injectable resolver LLM call. */
  resolve: ContradictionResolver;
  /** Surfaces a withheld (needs-review) resolution — a feed nudge in production. */
  onNeedsReview?: (record: ResolutionRecord) => void;
  now?: () => Date;
}

/**
 * Builds the concrete ResolveDeps from the real backend/store, so both detection
 * paths (accept-time and the re-verify cron) share one wiring. The file writes
 * carry a doc's frontmatter through (like the PUT edit route) so an automatic
 * rescope/merge never severs provenance or graph edges.
 */
export function buildResolveDeps(w: ResolveWiring): ResolveDeps {
  const store = new KnowledgeStore(w.db);
  return {
    loadClaim: (projectId, slug) => {
      const doc = w.backend.getDoc(projectId, slug);
      return doc ? toClaim(doc) : null;
    },
    getVerdictState: (projectId, slug) => {
      const doc = w.backend.getDoc(projectId, slug);
      return doc ? { verdict: doc.verdict, disputes: doc.disputes } : null;
    },
    search: (projectId, query, options) => w.backend.search(projectId, query, options),
    resolve: w.resolve,
    decayConfidence: async (projectId, slug, confidence, lastVerifiedAt) => {
      await updateDocFrontmatter(w.knowledgeDir, projectId, slug, {
        confidence,
        last_verified_at: lastVerifiedAt,
        half_life_days: DEFAULT_HALF_LIFE_DAYS,
      });
    },
    setVerdict: (projectId, slug, verdict, disputes) => {
      if (verdict === null) w.clearDocVerdict(projectId, slug);
      else w.recordDocVerdict(projectId, slug, verdict, disputes);
    },
    rescopeBody: async (projectId, slug, qualifier) => {
      const q = qualifier.trim();
      if (!q) return;
      await rewriteBody(w.knowledgeDir, projectId, slug, (body) => `${body}\n\n${q}`);
    },
    mergeBody: async (projectId, winnerSlug, mergedBody) => {
      await rewriteBody(w.knowledgeDir, projectId, winnerSlug, () => mergedBody);
    },
    resync: (projectId) => w.syncProject(projectId),
    findContradictors: (projectId, slug) =>
      store
        .getDocsByProject(projectId)
        .filter(
          (doc: KnowledgeDoc) =>
            doc.slug !== slug &&
            contradictionDisputes(doc).some(
              (d) => parseContradictsClaim(d.claim) === slug
            )
        )
        .map((doc: KnowledgeDoc) => doc.slug),
    recordResolution: (record) => createKnowledgeResolution(w.db, record),
    getExistingResolution: (id) => {
      const row = getKnowledgeResolution(w.db, id);
      return row
        ? {
            status: row.status,
            type: row.type,
            winnerSlug: row.winnerSlug,
            loserSlug: row.loserSlug,
            rationale: row.rationale,
            detail: row.detail,
          }
        : null;
    },
    markAutoApplied: (id) => markResolutionAutoApplied(w.db, id),
    // A doc still owed a fact-check — one running, or a pending body with
    // attempts left (persisted, so it holds across restarts) — is not resolved
    // against yet.
    isVerificationPending: (projectId, slug) => {
      const doc = w.backend.getDoc(projectId, slug);
      return !!doc && isAwaitingVerification(doc, getVerificationState(w.db, projectId, slug, doc.body).attempts);
    },
    onNeedsReview: w.onNeedsReview,
    now: w.now,
  };
}

/**
 * Rewrites an accepted doc's body while carrying every frontmatter field
 * readKnowledgeFile surfaces back through, so an automatic edit preserves the
 * doc's provenance, trust, graph edges, AUDIENCE (scope + owner_user), and
 * native-memory marker the way the PUT edit route does. writeKnowledgeFile
 * re-emits only the fields it is HANDED, so this MUST pass every one it read:
 *  - dropping related/origin_class/source_session_id would sever the doc's
 *    session→doc/related edges and revert its trust class;
 *  - dropping scope/owner_user would silently WIDEN the doc's audience — the
 *    following resync re-derives coerceScope(undefined) = 'project', so a
 *    user-scoped ('user'/owner) or 'global' doc auto-resolved by the
 *    contradiction resolver would leak into every teammate's injection (or, for
 *    a demoted 'global' doc, stop reaching other projects). This runs
 *    automatically with no human (the auto contradiction resolver + Item 1's
 *    nightly graph-wide sweep), so it must never re-aim a private doc.
 */
async function rewriteBody(
  knowledgeDir: string,
  projectId: string,
  slug: string,
  transform: (body: string) => string
): Promise<void> {
  const file = await readKnowledgeFile(knowledgeDir, projectId, slug);
  if (!file) return;
  await writeKnowledgeFile(knowledgeDir, projectId, {
    slug,
    title: file.title,
    body: transform(file.body),
    tags: file.tags,
    related: file.related,
    originClass: file.originClass,
    sourceSessionId: file.sourceSessionId,
    sourceKind: file.sourceKind,
    generatedFromSha: file.generatedFromSha,
    generatedAt: file.generatedAt,
    // Audience columns — carried through so an AUTOMATIC rescope/merge never
    // drops a doc's scope/owner and lets the resync default it to 'project'.
    scope: file.scope,
    ownerUser: file.ownerUser,
    confidence: file.confidence,
    lastVerifiedAt: file.lastVerifiedAt,
    halfLifeDays: file.halfLifeDays,
    nativeMemoryFrom: file.nativeMemoryFrom,
  });
}

/**
 * Fire-and-forget resolution over every pair a fresh contradiction flag produced
 * (subject vs each opposing doc). Sequential so the bounded resolver spawns don't
 * fan out — the same discipline the accept-path's batch contradiction check uses.
 * Each pair is guarded so one failure never aborts the rest; the whole thing is
 * detached, so callers return immediately.
 */
export function resolveContradictionsAsync(
  deps: ResolveDeps,
  projectId: string,
  subjectSlug: string,
  contradictedSlugs: readonly string[]
): void {
  if (contradictedSlugs.length === 0) return;
  void (async () => {
    for (const other of contradictedSlugs) {
      try {
        const outcome = await resolveContradiction(deps, projectId, subjectSlug, other);
        console.log(
          `[knowledge-resolve] ${projectId}/${subjectSlug} vs ${other}: ${outcome.status}` +
            (outcome.status === "applied" || outcome.status === "needs-review"
              ? ` (${outcome.type})`
              : "")
        );
      } catch (err) {
        console.error(
          `[knowledge-resolve] ${projectId}/${subjectSlug} vs ${other} failed:`,
          err
        );
      }
    }
  })();
}
