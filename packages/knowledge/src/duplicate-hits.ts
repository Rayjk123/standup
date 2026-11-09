import type { Database } from "bun:sqlite";
import type { DraftVerdict, OriginClass } from "./types.js";

/**
 * One result per content: the query-time collapse of hits that carry the same
 * doc twice. Two shapes reach one result list:
 *
 *  - a mirror copy: a reserved project that holds copies of another project's
 *    docs (the `standup-self` self-fix project mirrors `standup`). The mirror
 *    is an alias of its canonical project, so a mirror hit with the same slug
 *    as a canonical hit, or one lexically near-identical to it, is the same
 *    doc, and the canonical one is kept.
 *  - a near-identical duplicate within one project: the same body (whitespace
 *    aside) or a significant-token Jaccard of NEAR_IDENTICAL_JACCARD over
 *    title + body. The bar is a copy's, well above the write path's near-dup
 *    bar, so two distinct docs about one subject both stay. A copy homed in
 *    another (non-mirror) project is left alone: projects reach different
 *    audiences and each keeps its own verification history, so retiring one
 *    is the corpus migrations' call, not the ranking's. The same holds for a
 *    personal (`scope: user`) doc against a team or global doc, or another
 *    user's: it reaches only its owner, so both stay.
 *
 * Of a duplicate pair the canonical (non-mirror) hit is kept, then the
 * higher-trust one (verdict, origin, confidence), then the newer, then the
 * higher-ranked. The kept hit takes the better of the two slots and scores.
 */

/** Reserved mirror project id → the canonical project it copies. */
export type MirrorProjects = Readonly<Record<string, string>>;

/** Title+body token Jaccard at or above which two docs in one result list are copies. */
export const NEAR_IDENTICAL_JACCARD = 0.9;

/**
 * The looser bar a mirror copy must clear against a canonical doc under a
 * different slug: the write path's lexical near-dup (Jaccard 0.6, or 0.8
 * containment between comparably-sized token sets), as the copy-retiring
 * migration applies it.
 */
export const MIRROR_NEAR_DUP_JACCARD = 0.6;
export const MIRROR_NEAR_DUP_CONTAINMENT = 0.8;
const MIRROR_SIZE_RATIO_FLOOR = 0.5;

/** The fields of a hit the collapse reads. */
export interface DuplicateCandidate {
  id: string;
  projectId: string;
  slug: string;
  score: number;
  verdict?: DraftVerdict | string;
  originClass?: OriginClass | string;
  confidence?: number;
  writtenAt?: string;
}

const STOPWORDS = new Set([
  "the", "and", "for", "are", "was", "were", "this", "that", "these", "those",
  "with", "from", "into", "not", "but", "can", "will", "would", "should", "could",
  "use", "used", "using", "how", "what", "why", "when", "where", "which", "who",
  "its", "our", "your", "you", "has", "have", "had", "does", "did", "then",
]);

/** Significant tokens (three or more characters, stopwords dropped) of a text. */
export function contentTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (raw.length >= 3 && !STOPWORDS.has(raw)) out.add(raw);
  }
  return out;
}

/** Jaccard of two token sets, and their containment when comparably sized (else 0). */
export function contentOverlap(a: ReadonlySet<string>, b: ReadonlySet<string>): { jaccard: number; containment: number } {
  if (a.size === 0 || b.size === 0) return { jaccard: 0, containment: 0 };
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const smaller = Math.min(a.size, b.size);
  const larger = Math.max(a.size, b.size);
  return {
    jaccard: inter / (a.size + b.size - inter),
    containment: smaller / larger >= MIRROR_SIZE_RATIO_FLOOR ? inter / smaller : 0,
  };
}

/** Whether one of the two hits is a mirror copy homed in the other's canonical project. */
export function isMirrorPair(
  a: Pick<DuplicateCandidate, "projectId">,
  b: Pick<DuplicateCandidate, "projectId">,
  mirrors: MirrorProjects
): boolean {
  return mirrors[a.projectId] === b.projectId || mirrors[b.projectId] === a.projectId;
}

/**
 * A doc's comparable text: its whitespace-collapsed body, its title+body
 * tokens, and its audience (scope, plus the owning user of a user-scoped doc).
 */
export interface DocText {
  body: string;
  tokens: Set<string>;
  audience?: string;
}

export function docText(title: string, body: string, audience?: string): DocText {
  return { body: body.replace(/\s+/g, " ").trim(), tokens: contentTokens(`${title}\n${body}`), audience };
}

/**
 * The audience key of a doc: a user-scoped doc's owner, else one shared key
 * for project and global docs, which reach the same agents in their project.
 */
export function docAudience(scope: string | null, ownerUser: string | null): string {
  return scope === "user" ? `user:${ownerUser ?? ""}` : "shared";
}

/**
 * Whether `a` and `b` carry the same content (see the module comment). With
 * `nearIdentical` false only mirror pairs are compared.
 */
export function isDuplicatePair(
  a: DuplicateCandidate,
  b: DuplicateCandidate,
  textA: DocText | undefined,
  textB: DocText | undefined,
  mirrors: MirrorProjects,
  nearIdentical = true
): boolean {
  const mirror = isMirrorPair(a, b, mirrors);
  if (mirror && a.slug === b.slug) return true;
  if (!mirror && (!nearIdentical || a.projectId !== b.projectId)) return false;
  if (!textA || !textB) return false;
  if (!mirror && textA.audience !== textB.audience) return false;
  if (textA.body.length > 0 && textA.body === textB.body) return true;
  const { jaccard, containment } = contentOverlap(textA.tokens, textB.tokens);
  if (jaccard >= NEAR_IDENTICAL_JACCARD) return true;
  return mirror && (jaccard >= MIRROR_NEAR_DUP_JACCARD || containment >= MIRROR_NEAR_DUP_CONTAINMENT);
}

function verdictRank(verdict: string | undefined): number {
  if (verdict === "superseded") return 0;
  if (verdict === "disputed") return 1;
  if (verdict === "contradicted") return 2;
  if (verdict === "error") return 3;
  return 4;
}

function originRank(origin: string | undefined): number {
  if (origin === "owner") return 3;
  if (origin === "agent") return 2;
  if (origin === "system") return 1;
  return 0;
}

function writtenMs(hit: DuplicateCandidate): number {
  const at = Date.parse(hit.writtenAt ?? "");
  return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
}

/**
 * Whether `challenger` should replace `incumbent` as the kept hit of a
 * duplicate pair. `incumbent` is the higher-ranked of the two, so a full tie
 * keeps it.
 */
export function prefersChallenger(
  incumbent: DuplicateCandidate,
  challenger: DuplicateCandidate,
  mirrors: MirrorProjects
): boolean {
  if (mirrors[incumbent.projectId] === challenger.projectId) return true;
  if (mirrors[challenger.projectId] === incumbent.projectId) return false;
  const byVerdict = verdictRank(challenger.verdict) - verdictRank(incumbent.verdict);
  if (byVerdict !== 0) return byVerdict > 0;
  const byOrigin = originRank(challenger.originClass) - originRank(incumbent.originClass);
  if (byOrigin !== 0) return byOrigin > 0;
  const byConfidence = (challenger.confidence ?? 0) - (incumbent.confidence ?? 0);
  if (byConfidence !== 0) return byConfidence > 0;
  return writtenMs(challenger) > writtenMs(incumbent);
}

// Bound parameters per IN-list query, under SQLite's default ceiling.
const TEXT_BATCH = 500;

/** Title, body and audience of each doc id, read from the index. */
function docTexts(db: Database, ids: readonly string[]): Map<string, DocText> {
  const out = new Map<string, DocText>();
  for (let i = 0; i < ids.length; i += TEXT_BATCH) {
    const batch = ids.slice(i, i + TEXT_BATCH);
    const rows = db
      .query(
        `SELECT id, title, body, scope, owner_user FROM knowledge WHERE id IN (${batch.map(() => "?").join(", ")})`
      )
      .all(...batch) as Array<{
      id: string;
      title: string | null;
      body: string | null;
      scope: string | null;
      owner_user: string | null;
    }>;
    for (const r of rows) out.set(r.id, docText(r.title ?? "", r.body ?? "", docAudience(r.scope, r.owner_user)));
  }
  return out;
}

/** How collapseDuplicateHits compares hits. */
export interface CollapseOptions {
  /** Reserved mirror project → canonical project. Default none. */
  mirrors?: MirrorProjects;
  /** Also collapse near-identical hits within one project (not only mirror pairs). Default true. */
  nearIdentical?: boolean;
  /** Ids never collapsed (docs the query names). */
  exempt?: ReadonlySet<string>;
}

/**
 * `hits` (in rank order) with each duplicate pair collapsed to its kept hit,
 * which takes the earlier slot and the higher score.
 */
export function collapseDuplicateHits<T extends DuplicateCandidate>(
  db: Database,
  hits: readonly T[],
  options: CollapseOptions = {}
): T[] {
  const mirrors = options.mirrors ?? {};
  const nearIdentical = options.nearIdentical ?? true;
  const exempt = options.exempt ?? new Set<string>();
  if (hits.length < 2 || (!nearIdentical && Object.keys(mirrors).length === 0)) return [...hits];
  const texts = docTexts(db, [...new Set(hits.map((h) => h.id))]);
  const kept: T[] = [];
  for (const hit of hits) {
    if (exempt.has(hit.id)) {
      kept.push(hit);
      continue;
    }
    const at = kept.findIndex(
      (k) =>
        !exempt.has(k.id) &&
        k.id !== hit.id &&
        isDuplicatePair(k, hit, texts.get(k.id), texts.get(hit.id), mirrors, nearIdentical)
    );
    if (at < 0) {
      if (!kept.some((k) => k.id === hit.id)) kept.push(hit);
      continue;
    }
    const incumbent = kept[at]!;
    if (prefersChallenger(incumbent, hit, mirrors)) {
      kept[at] = { ...hit, score: Math.max(hit.score, incumbent.score) };
    }
  }
  return kept;
}
