import type {
  KnowledgeDocFile,
  ScopeAudience,
  SearchOptions,
  SearchResult,
} from "@standup/knowledge";

/**
 * Near-duplicate detection for the knowledge write path — one rule shared by
 * propose, accept, the distiller and Persona's remember, so every way a doc
 * enters the corpus is held to the same bar.
 *
 * A candidate is compared against the accepted docs its author's AUDIENCE can
 * see (its project, scope=global docs, its own personal docs — not just the
 * home project), on three signals:
 *
 * - cosine: the best raw cosine between the candidate's text and any chunk of
 *   the existing doc (search with the text arm weighted out, so `rawScore` is
 *   exactly the embedding arm's doc-level max chunk similarity). Absent without
 *   an embedding provider.
 * - lexical: Jaccard and containment of the two significant-token sets.
 * - title: Jaccard of the two titles' tokens.
 *
 * The thresholds below were chosen on this corpus's real duplicate pairs (byte
 * copies across a frozen copy project, paraphrased re-derivations of one fix,
 * forks of one design doc across two projects) against same-subsystem pairs
 * that are NOT duplicates, for precision first: a false positive refuses a
 * write the agent then has to re-aim at an existing slug, a false negative
 * adds one redundant doc.
 */

/** Cosine at or above which a candidate duplicates an existing doc on embedding
 *  similarity alone. Measured: byte copies and light edits score ≥ 0.95;
 *  distinct docs about the same subsystem peak around 0.92. */
export const DUP_COSINE_STRICT = 0.95;

/**
 * Cosine at or above which a candidate duplicates an existing doc when its
 * title or vocabulary also agrees. Measured paraphrased copies of one doc land
 * at 0.885–0.94 with near-identical titles; a sibling doc about another
 * component of the same system (control plane vs data plane) reaches 0.89 with
 * a title that shares only the system's name.
 */
export const DUP_COSINE = 0.87;
/** With DUP_COSINE: a title this similar marks a duplicate outright… */
export const DUP_TITLE_SAME = 0.75;
/** …and one this similar marks it once the cosine also reaches DUP_COSINE_TITLED. */
export const DUP_TITLE_SIMILARITY = 0.5;
export const DUP_COSINE_TITLED = 0.9;
/** With DUP_COSINE: a body-token Jaccard this high marks a duplicate. */
export const DUP_JACCARD_WITH_COSINE = 0.4;

/** A restatement under a reworded title: cosine this high with at least
 *  DUP_TITLE_LOOSE title overlap. Measured on two docs giving the same
 *  workaround under different titles (0.924, title 0.36); the nearest distinct
 *  pair, a product spec and its implementation doc, scored 0.909. */
export const DUP_COSINE_REWORDED = 0.915;
export const DUP_TITLE_LOOSE = 0.3;

/** A doc under the same slug in another project is a fork of it when the two
 *  are this close: measured forks of one design doc across two projects sit at
 *  0.85–0.96 cosine, unrelated docs that share a generic slug far below. */
export const DUP_FORK_COSINE = 0.83;
export const DUP_FORK_JACCARD = 0.3;

/** DUP_COSINE_STRICT under the name the distiller exports. */
export const NEAR_DUP_THRESHOLD = DUP_COSINE_STRICT;

/**
 * Lexical near-dup gate, applied to every candidate regardless of whether an
 * embedding provider is configured — so dedup holds in the default
 * text-search-only install, where there is no cosine. A candidate is a
 * near-duplicate when the significant-token (≥3 chars, stopwords dropped) sets
 * of the two texts overlap by at least this Jaccard ratio, OR one text is
 * almost entirely contained in the other AND the two are of COMPARABLE size
 * (see NEAR_DUP_CONTAINMENT_THRESHOLD / NEAR_DUP_SIZE_RATIO_FLOOR).
 */
export const NEAR_DUP_LEXICAL_THRESHOLD = 0.6;
/** Overlap coefficient (|A∩B| / min(|A|,|B|)) bar for the containment arm. */
export const NEAR_DUP_CONTAINMENT_THRESHOLD = 0.8;
/**
 * The containment arm fires only when the two significant-token sets are of
 * comparable size — the smaller must be at least this fraction of the larger.
 * Containment divides by the SMALLER set, so a short candidate whose few tokens
 * happen to be a subset of a much longer doc's vocabulary would otherwise score
 * high containment while stating new information.
 */
export const NEAR_DUP_SIZE_RATIO_FLOOR = 0.5;

/** Words too common to discriminate one doc from another; dropped before the
 *  lexical comparison so shared filler doesn't inflate similarity. */
const LEXICAL_STOPWORDS = new Set([
  "the", "and", "for", "are", "was", "were", "this", "that", "these", "those",
  "with", "from", "into", "not", "but", "can", "will", "would", "should", "could",
  "use", "used", "using", "how", "what", "why", "when", "where", "which", "who",
  "its", "our", "your", "you", "has", "have", "had", "does", "did", "then",
]);

/** Significant-token set of a text for the lexical comparison. */
export function lexicalTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (raw.length >= 3 && !LEXICAL_STOPWORDS.has(raw)) out.add(raw);
  }
  return out;
}

/** Title tokens: shorter words count (a title is short), stopwords still drop. */
function titleTokens(title: string): Set<string> {
  const out = new Set<string>();
  for (const raw of title.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= 2 && !LEXICAL_STOPWORDS.has(raw)) out.add(raw);
  }
  return out;
}

function jaccardOf(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Lexical overlap of two texts: Jaccard, and containment when the sets are of
 *  comparable size (0 otherwise). */
export function lexicalOverlap(a: string, b: string): { jaccard: number; containment: number } {
  const ta = lexicalTokens(a);
  const tb = lexicalTokens(b);
  if (ta.size === 0 || tb.size === 0) return { jaccard: 0, containment: 0 };
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const smaller = Math.min(ta.size, tb.size);
  const larger = Math.max(ta.size, tb.size);
  return {
    jaccard: inter / (ta.size + tb.size - inter),
    containment: smaller / larger >= NEAR_DUP_SIZE_RATIO_FLOOR ? inter / smaller : 0,
  };
}

/**
 * Whether two texts are lexically near-duplicate: high Jaccard of their
 * significant-token sets, or one set almost wholly contained in the other.
 */
export function isLexicalNearDup(a: string, b: string): boolean {
  const { jaccard, containment } = lexicalOverlap(a, b);
  return jaccard >= NEAR_DUP_LEXICAL_THRESHOLD || containment >= NEAR_DUP_CONTAINMENT_THRESHOLD;
}

/**
 * The write-time REFUSAL bar: a proposal this close to a published doc is not
 * written at all, and the caller is told to update that doc instead. It sits
 * strictly above every isDuplicate arm (strict cosine 0.95, cosine 0.87 with
 * agreement, titled 0.90, reworded 0.915, lexical Jaccard 0.6 / containment
 * 0.8), because a refusal costs the caller a second call aimed at the existing
 * slug while a duplicate below this bar still reaches a reviewer or is reported
 * with its differences. It is meant to fire only on copies: the same body with
 * whitespace, markdown or title case changed. A paraphrase, an added section or
 * a corrected value stays below it.
 *
 * With an embedding: cosine at least DUPLICATE_REJECT_COSINE (above the 0.95
 * at which byte copies and light edits start; measured paraphrases peak at
 * 0.94) and either the titles agree (DUPLICATE_REJECT_TITLE) or the title+body
 * token sets nearly coincide (DUPLICATE_REJECT_JACCARD_WITH_COSINE, twice the
 * 0.4 isDuplicate asks beside a cosine).
 */
export const DUPLICATE_REJECT_COSINE = 0.97;
export const DUPLICATE_REJECT_TITLE = 0.75;
export const DUPLICATE_REJECT_JACCARD_WITH_COSINE = 0.8;
/**
 * Without an embedding: the significant-token sets of title+body must overlap
 * by this Jaccard AND this containment. A one-word change in a 25-token doc
 * scores 0.92 Jaccard, so a short doc is refused only when its vocabulary is
 * unchanged; a long one tolerates a word or two of drift.
 */
export const DUPLICATE_REJECT_LEXICAL_JACCARD = 0.95;
export const DUPLICATE_REJECT_LEXICAL_CONTAINMENT = 0.98;
/**
 * Every refusal other than an identical body also needs the two full texts
 * (title + whitespace-collapsed body) of nearly the same length and each one's
 * significant-token set almost wholly inside the other's. The neighbor search
 * embeds only the candidate's first 2000 characters, so a doc that copies an
 * existing one and adds a section past that point scores a copy's cosine;
 * these full-text checks see the added section.
 */
export const DUPLICATE_REJECT_SIZE_RATIO = 0.9;
export const DUPLICATE_REJECT_TWO_WAY_CONTAINMENT = 0.95;

/**
 * The band in which a proposal that is NOT a duplicate is still close enough to
 * an existing doc to suggest updating that doc: cosine from this value up to
 * the isDuplicate bar, or without an embedding a token Jaccard from
 * UPDATE_HINT_JACCARD up to NEAR_DUP_LEXICAL_THRESHOLD. The proposal publishes
 * either way.
 */
export const UPDATE_HINT_COSINE = 0.8;
export const UPDATE_HINT_JACCARD = 0.45;

/** Whitespace-collapsed body, for the identical-copy check. */
function normalizedBody(body: string): string {
  return body.replace(/\s+/g, " ").trim();
}

/** The similarity signals between a candidate and one existing doc. */
export interface DupFeatures {
  /** Same body, whitespace aside. */
  identical: boolean;
  /** Same slug (in another project — a doc is never compared with itself). */
  sameSlug: boolean;
  /**
   * Each doc is about a subject the other never mentions: a word of its title
   * or slug that its own body repeats and the other doc's text lacks. Two
   * runbooks filled in from one template (restart the ingest service / restart
   * the billing service) overlap almost word for word but are this.
   */
  differentSubjects: boolean;
  /** The two name different values (see valueDifferences). */
  valuesDiffer: boolean;
  /** valuesDiffer with markdown code spans read as plain text, so wrapping a
   *  name in backticks is not a changed value. */
  valuesDifferAsText: boolean;
  /** Doc-level max chunk cosine; undefined without an embedding provider. */
  cosine?: number;
  jaccard: number;
  containment: number;
  titleSimilarity: number;
  /** Shorter over longer length of the two full texts (title + whitespace-collapsed body). */
  sizeRatio: number;
  /** The smaller of the two containments of the full significant-token sets
   *  (|A∩B| / max(|A|,|B|)), with no size floor. */
  twoWayContainment: number;
}

/** The text a candidate is compared as: title and body. */
export interface DedupSubject {
  slug: string;
  title: string;
  body: string;
}

/** A word normalized for subject matching: lowercased, a plural "s" dropped. */
function stem(word: string): string {
  const w = word.toLowerCase();
  return w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;
}

function wordCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const raw of text.split(/[^A-Za-z0-9_]+/)) {
    if (!raw) continue;
    const w = stem(raw);
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return counts;
}

/** The subject words of a doc: title and slug words its body repeats. */
function subjectWords(doc: { slug: string; title: string; body: string }): string[] {
  const body = wordCounts(doc.body);
  const words = new Set<string>();
  for (const raw of `${doc.title} ${doc.slug}`.split(/[^A-Za-z0-9_]+/)) {
    const w = stem(raw);
    if (w.length >= 3 && !LEXICAL_STOPWORDS.has(w) && (body.get(w) ?? 0) >= 2) words.add(w);
  }
  return [...words];
}

/** Whether `doc` has a subject word that `other`'s whole text lacks. */
function hasOwnSubject(
  doc: { slug: string; title: string; body: string },
  other: { slug: string; title: string; body: string }
): boolean {
  const otherWords = wordCounts(`${other.slug} ${other.title} ${other.body}`);
  return subjectWords(doc).some((w) => !otherWords.has(w));
}

/** Tokens that name a value — anything with a digit (us-east-1, 30s, v2.4) or
 *  a backticked name — the parts a correction changes. */
function valueTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/`([^`\n]{1,60})`|[A-Za-z0-9_.:/-]*\d[A-Za-z0-9_.:/-]*/g)) {
    const v = (m[1] ?? m[0]).replace(/[.:]+$/, "");
    if (v.length >= 2) out.add(v);
  }
  return out;
}

/**
 * The named values that differ between a candidate and an existing doc, as
 * "x here, y there" lines (at most a few each way), so a near-duplicate that
 * corrects a value is reported as what it changes rather than as a copy.
 */
export function valueDifferences(candidate: string, existing: string): string[] {
  const here = valueTokens(candidate);
  const there = valueTokens(existing);
  const onlyHere = [...here].filter((v) => !there.has(v)).slice(0, 4);
  const onlyThere = [...there].filter((v) => !here.has(v)).slice(0, 4);
  return [
    ...(onlyHere.length > 0 ? [`${onlyHere.join(" ")} here`] : []),
    ...(onlyThere.length > 0 ? [`${onlyThere.join(" ")} in the existing doc`] : []),
  ];
}

/** A body with its backticks dropped, so a code span reads as its plain text. */
function withoutCodeSpans(body: string): string {
  return body.replace(/`/g, "");
}

export function dupFeatures(
  subject: DedupSubject,
  existing: { slug: string; title: string; body: string },
  cosine: number | undefined
): DupFeatures {
  const subjectText = `${subject.title}\n${subject.body}`;
  const existingText = `${existing.title}\n${existing.body}`;
  const lex = lexicalOverlap(subjectText, existingText);
  const subjectLength = normalizedBody(subjectText).length;
  const existingLength = normalizedBody(existingText).length;
  const longer = Math.max(subjectLength, existingLength);
  const subjectTokens = lexicalTokens(subjectText);
  const existingTokens = lexicalTokens(existingText);
  let shared = 0;
  for (const t of subjectTokens) if (existingTokens.has(t)) shared++;
  const largerSet = Math.max(subjectTokens.size, existingTokens.size);
  return {
    identical: normalizedBody(subject.body) === normalizedBody(existing.body),
    sameSlug: subject.slug === existing.slug,
    differentSubjects: hasOwnSubject(subject, existing) && hasOwnSubject(existing, subject),
    valuesDiffer: valueDifferences(subject.body, existing.body).length > 0,
    valuesDifferAsText: valueDifferences(withoutCodeSpans(subject.body), withoutCodeSpans(existing.body)).length > 0,
    ...(cosine !== undefined ? { cosine } : {}),
    jaccard: lex.jaccard,
    containment: lex.containment,
    titleSimilarity: jaccardOf(titleTokens(subject.title), titleTokens(existing.title)),
    sizeRatio: longer === 0 ? 1 : Math.min(subjectLength, existingLength) / longer,
    twoWayContainment: largerSet === 0 ? 0 : shared / largerSet,
  };
}

/**
 * Whether the signals mark the candidate a duplicate of the existing doc. An
 * identical body always is, and so is a near-identical embedding. Otherwise two
 * docs each about a subject the other never names, filled with different
 * values, are not (runbooks from one template); two that name the same values
 * in different words are judged on the other signals. Token overlap alone is
 * never enough: the lexical arm also needs the titles or the embeddings to agree.
 */
export function isDuplicate(f: DupFeatures): boolean {
  if (f.identical) return true;
  const c = f.cosine;
  if (c !== undefined && c >= DUP_COSINE_STRICT) return true;
  if (f.differentSubjects && f.valuesDiffer) return false;
  const lexical = f.jaccard >= NEAR_DUP_LEXICAL_THRESHOLD || f.containment >= NEAR_DUP_CONTAINMENT_THRESHOLD;
  if (lexical && (f.titleSimilarity >= DUP_TITLE_SIMILARITY || (c !== undefined && c >= DUP_COSINE))) {
    return true;
  }
  if (f.sameSlug && f.jaccard >= DUP_FORK_JACCARD && (c === undefined || c >= DUP_FORK_COSINE)) return true;
  if (c === undefined) return false;
  if (c >= DUP_COSINE_STRICT) return true;
  if (f.sameSlug && c >= DUP_FORK_COSINE) return true;
  if (c >= DUP_COSINE_REWORDED && f.titleSimilarity >= DUP_TITLE_LOOSE) return true;
  if (c < DUP_COSINE) return false;
  if (f.jaccard >= DUP_JACCARD_WITH_COSINE) return true;
  if (f.titleSimilarity >= DUP_TITLE_SAME) return true;
  return f.titleSimilarity >= DUP_TITLE_SIMILARITY && c >= DUP_COSINE_TITLED;
}

/**
 * Whether the signals mark the candidate a copy of the existing doc with high
 * enough confidence to refuse the write (see DUPLICATE_REJECT_COSINE). Always a
 * subset of isDuplicate. An identical body always is; otherwise both must be
 * about the same subject and name the same values (a correction is an update,
 * not a copy), the full texts must match in size and vocabulary
 * (DUPLICATE_REJECT_SIZE_RATIO), and the cosine arm applies when there is a
 * cosine, the lexical arm when there is none.
 */
export function isHighConfidenceDuplicate(f: DupFeatures): boolean {
  if (f.identical) return true;
  if (!isDuplicate(f)) return false;
  if (f.differentSubjects || f.valuesDifferAsText) return false;
  if (f.sizeRatio < DUPLICATE_REJECT_SIZE_RATIO || f.twoWayContainment < DUPLICATE_REJECT_TWO_WAY_CONTAINMENT) {
    return false;
  }
  if (f.cosine !== undefined) {
    return (
      f.cosine >= DUPLICATE_REJECT_COSINE &&
      (f.titleSimilarity >= DUPLICATE_REJECT_TITLE || f.jaccard >= DUPLICATE_REJECT_JACCARD_WITH_COSINE)
    );
  }
  return f.jaccard >= DUPLICATE_REJECT_LEXICAL_JACCARD && f.containment >= DUPLICATE_REJECT_LEXICAL_CONTAINMENT;
}

/** Whether a distinct neighbor sits in the "update it instead?" band (see UPDATE_HINT_COSINE). */
export function isUpdateCandidate(f: DupFeatures): boolean {
  if (isDuplicate(f)) return false;
  return f.cosine !== undefined ? f.cosine >= UPDATE_HINT_COSINE : f.jaccard >= UPDATE_HINT_JACCARD;
}

/** One number to rank and report a neighbor by: 1 for an identical copy, else
 *  the cosine when there is one, else the token Jaccard. */
export function similarityOf(f: DupFeatures): number {
  if (f.identical) return 1;
  return f.cosine ?? f.jaccard;
}

/** An existing doc near a candidate, with how near. */
export interface NearestDoc {
  /** The doc's search id. */
  id: string;
  projectId: string;
  slug: string;
  title: string;
  similarity: number;
  duplicate: boolean;
  /** A copy past the refusal bar (isHighConfidenceDuplicate). */
  highConfidence: boolean;
  features: DupFeatures;
  /** Named values that differ between the two (see valueDifferences). */
  differences: string[];
  originClass?: string;
  sourceSessionId?: string;
  scope?: string;
}

export interface NearestDeps {
  search: (projectId: string, query: string, options?: SearchOptions) => Promise<SearchResult[]>;
  readAcceptedDoc: (projectId: string, slug: string) => Promise<KnowledgeDocFile | null>;
  /** Whether search fuses an embedding arm; undefined reads as yes. Without
   *  one there is no cosine and only the lexical arms apply. */
  embeddingsEnabled?: boolean;
  /** A doc's live verdict — a superseded doc is a retired copy, never a match. */
  getVerdict?: (projectId: string, slug: string) => string | undefined;
}

export interface NearestOptions {
  /** The audience whose visible docs are compared against. Omitted = the
   *  project's own docs only. */
  audience?: ScopeAudience;
  /** How many neighbors to return. */
  limit?: number;
  /** `projectId/slug` refs never matched (the candidate itself, a doc it
   *  replaces). */
  exclude?: readonly string[];
}

/** Search breadth. The fused order favors the searching project (a cross-project
 *  multiplier), so a byte copy in another project can rank below a dozen merely
 *  related local docs; the hits are re-ranked by raw similarity before scoring. */
const NEAREST_CANDIDATES = 30;
/** How many of the re-ranked hits are read and scored. */
const NEAREST_SCORED = 10;

/**
 * The existing docs nearest `subject` within the audience, most similar first,
 * each marked whether it is a duplicate. Searches the candidate's own text
 * (title + body prefix); with embeddings the text arm is weighted out so each
 * hit's rawScore is its raw doc-level cosine, and the best-scoring hits by that
 * raw similarity (not the fused rank) are compared. Each one's authoritative body
 * is read for the lexical and identical-copy signals.
 */
export async function findNearestDocs(
  deps: NearestDeps,
  projectId: string,
  subject: DedupSubject,
  options: NearestOptions = {}
): Promise<NearestDoc[]> {
  const exclude = new Set(options.exclude ?? []);
  exclude.add(`${projectId}/${subject.slug}`);
  const query = `${subject.title}\n${subject.body}`.slice(0, 2000);
  const embeddings = deps.embeddingsEnabled !== false;
  const hits = await deps.search(projectId, query, {
    corpus: options.audience ? "all" : "project",
    limit: NEAREST_CANDIDATES,
    ...(options.audience ? { audience: options.audience } : {}),
    ...(embeddings ? { textWeight: 0, embeddingWeight: 1 } : {}),
  });
  // A backend that omits rawScore ranks only; its score is the best stand-in.
  const similarityHit = (h: SearchResult) => h.rawScore ?? h.score;
  const ranked = [...hits].sort((a, b) => similarityHit(b) - similarityHit(a));
  const out: NearestDoc[] = [];
  const seen = new Set<string>();
  for (const hit of ranked) {
    if (seen.size >= NEAREST_SCORED) break;
    const ref = `${hit.projectId}/${hit.slug}`;
    if (exclude.has(ref) || seen.has(ref)) continue;
    seen.add(ref);
    if (deps.getVerdict?.(hit.projectId, hit.slug) === "superseded") continue;
    const existing = await deps.readAcceptedDoc(hit.projectId, hit.slug);
    if (!existing) continue;
    const cosine = embeddings ? similarityHit(hit) : undefined;
    const features = dupFeatures(subject, { ...existing, slug: hit.slug }, cosine);
    out.push({
      id: hit.id,
      projectId: hit.projectId,
      slug: hit.slug,
      title: existing.title,
      similarity: similarityOf(features),
      duplicate: isDuplicate(features),
      highConfidence: isHighConfidenceDuplicate(features),
      features,
      differences: valueDifferences(subject.body, existing.body),
      originClass: existing.originClass,
      sourceSessionId: existing.sourceSessionId,
      scope: existing.scope,
    });
  }
  out.sort((a, b) => Number(b.duplicate) - Number(a.duplicate) || b.similarity - a.similarity);
  return out.slice(0, options.limit ?? 3);
}

/** The response to a proposal refused as a copy of a published doc. */
export interface DuplicateRefusal {
  ok: false;
  published: false;
  refused: "duplicate";
  duplicateOf: { project: string; slug: string; id: string; title: string };
  message: string;
}

/**
 * The refusal for a proposal homed in `projectId` that copies `dup`: names the
 * doc and the propose_knowledge call that updates it (with its project when it
 * lives elsewhere).
 */
export function duplicateRefusal(projectId: string, dup: NearestDoc): DuplicateRefusal {
  const project = dup.projectId === projectId ? "" : `, project "${dup.projectId}"`;
  return {
    ok: false,
    published: false,
    refused: "duplicate",
    duplicateOf: { project: dup.projectId, slug: dup.slug, id: dup.id, title: dup.title },
    message:
      `This duplicates ${dup.projectId}/${dup.slug}. Update that doc instead: call propose_knowledge with ` +
      `slug "${dup.slug}"${project}.`,
  };
}

/** The "update it instead?" hint for a published proposal close to `near`. */
export function updateHint(projectId: string, near: NearestDoc): string {
  const project = near.projectId === projectId ? "" : ` and project "${near.projectId}"`;
  return (
    `Close to ${near.projectId}/${near.slug} — consider updating it instead: propose_knowledge with ` +
    `slug "${near.slug}"${project}.`
  );
}

/** The compact form of a neighbor a write response carries. */
export function nearestSummary(n: NearestDoc): {
  project: string;
  slug: string;
  title: string;
  similarity: number;
  duplicate: boolean;
} {
  return {
    project: n.projectId,
    slug: n.slug,
    title: n.title,
    similarity: Math.round(n.similarity * 1000) / 1000,
    duplicate: n.duplicate,
  };
}
