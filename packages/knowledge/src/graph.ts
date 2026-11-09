import { GLOBAL_PROJECT_ID } from "@standup/shared";
import type { KnowledgeStore } from "./store.js";
import type { KnowledgeDoc, KnowledgeEdge, DraftDispute } from "./types.js";
import { cosineSimilarity } from "./search.js";

/**
 * Cross-project knowledge graph derivation.
 *
 * Edges are a rebuildable projection of authored signals: the
 * `related:`/`edges:` links an author writes in a doc's frontmatter, the
 * `[[slug]]` wikilinks in its body, the specific tags the docs share, and the
 * session that authored them. Markdown stays the source of truth;
 * this compiles it into `knowledge_edges` the same way the FTS index compiles
 * the body. Nothing here is scoped to a project — the point of the graph is
 * the links that cross the project boundary a per-project view hides.
 */

// Mirrors OpenClaw's memory-wiki MAX_SHARED_SOURCE_FANOUT: a doc that shares
// tags with dozens of others would otherwise fan out into a hairball of weak
// edges. Keep each doc's few strongest co-citations, drop the rest. Small on
// purpose: at 24 nearly every doc saturated the cap, so degree measured the cap
// rather than the doc.
export const CO_CITATION_MAX_FANOUT = 6;

/**
 * A tag carried by more than this many docs names a category (`cdk`, `deploy`,
 * `gotcha`, a project name), not a relation between two particular docs, so it
 * never forms a co-citation edge on its own. Measured on a real corpus: pairs
 * linked only through such tags are no more similar in content than random
 * pairs, while pairs sharing a rare tag are clearly closer.
 */
export const CO_CITATION_MAX_TAG_DOCS = 8;

/**
 * Cosine floor two embedded docs must clear for a shared tag to link them.
 * Sits just above the typical unrelated pair (on a real corpus the median of
 * all pairs is ~0.66), so it removes tag matches whose content is unrelated
 * without second-guessing ones the content backs up.
 */
export const CO_CITATION_MIN_COSINE = 0.7;

/**
 * How far below a tag's own median pairwise cosine a pair may sit and still be
 * linked by that tag. A tag with two meanings (`hooks` for git hooks and for
 * Claude Code HTTP hooks) splits its docs into two clusters: pairs inside a
 * cluster are close, pairs across clusters are not, and with both populations
 * present the median lands between them, so median − margin cuts the
 * cross-meaning pairs. A single-meaning tag's pairs sit near their median and
 * all clear it. The median (not a mean or a top percentile) is used so one
 * outlier pair cannot move the floor, and the global CO_CITATION_MIN_COSINE
 * stays the lower bound, so the per-tag floor only ever tightens it.
 */
export const CO_CITATION_TAG_MEDIAN_MARGIN = 0.05;

/**
 * Tags known to carry more than one meaning in this corpus, so sharing one is
 * no evidence two docs are about the same thing: `hooks` (git hooks vs Claude
 * Code HTTP hooks), `gateway` (Standup's port gateway vs the OpenClaw Gateway),
 * `roadmap` (the Standup roadmap vs the Frost Watch roadmap). Such a tag
 * never forms a co-citation edge on its own; it still counts toward the weight
 * and evidence of a pair a specific tag already links.
 */
export const CO_CITATION_AMBIGUOUS_TAGS: ReadonlySet<string> = new Set(["hooks", "gateway", "roadmap"]);

/** Weight of a body `[[slug]]` link — below a frontmatter `related` link (1), which an author curated as an edge. */
export const WIKILINK_WEIGHT = 0.8;

/** Cap on the link line quoted as a wikilink edge's evidence. */
export const WIKILINK_EVIDENCE_MAX_CHARS = 200;

/** Weight of a same-authoring-session edge: a weak hint, below every authored link. */
export const PROVENANCE_WEIGHT = 0.5;

/**
 * Max provenance edges kept per doc. A session that writes many docs would
 * otherwise link them into a clique (n·(n−1)/2 edges); the cap keeps each doc's
 * few closest siblings, the same bound co-citation uses.
 */
export const PROVENANCE_MAX_FANOUT = CO_CITATION_MAX_FANOUT;

export interface DeriveEdgeOptions {
  /** Max docs a tag may carry and still form a co-citation edge. */
  coCitationMaxTagDocs?: number;
  /** Max co-citation edges kept per doc. */
  coCitationMaxFanout?: number;
  /** Cosine floor for a co-citation edge between two embedded docs. */
  coCitationMinCosine?: number;
  /** Tags that never form a co-citation edge on their own. */
  coCitationAmbiguousTags?: ReadonlySet<string>;
  /** Max provenance (same authoring session) edges kept per doc. */
  provenanceMaxFanout?: number;
  /** Per-doc content vectors (deriveDocVectors); without them co-citation is tag-only. */
  docVectors?: Map<string, number[]>;
}

function edgeId(kind: string, src: string, dst: string): string {
  return `${kind}:${src}:${dst}`;
}

// Canonical ordering for an undirected pair, so A–B and B–A collapse to one
// edge with a stable id.
function ordered(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/**
 * Resolves a frontmatter edge target to a doc. A target is either
 * `projectId/slug` (explicit) or a bare `slug` — a bare slug prefers a doc in
 * the source doc's own project, then falls back to a globally unique slug, and
 * is left unresolved (dropped) if it's ambiguous across projects.
 */
function resolveTarget(
  target: string,
  src: KnowledgeDoc,
  byKey: Map<string, KnowledgeDoc>,
  bySlug: Map<string, KnowledgeDoc[]>
): KnowledgeDoc | undefined {
  if (target.includes("/")) return byKey.get(target);
  const sameProject = byKey.get(`${src.projectId}/${target}`);
  if (sameProject) return sameProject;
  const candidates = bySlug.get(target) ?? [];
  return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * Resolves a body wikilink target. Like resolveTarget, but a bare slug missing
 * from the source doc's project tries the global project before falling back
 * to a slug unique across the corpus: prose links to shared conventions
 * (`[[commit-message-conventions]]`) by bare slug, and the global copy is the
 * one meant even when another project holds a doc of the same name.
 */
function resolveWikilinkTarget(
  target: string,
  src: KnowledgeDoc,
  byKey: Map<string, KnowledgeDoc>,
  bySlug: Map<string, KnowledgeDoc[]>
): KnowledgeDoc | undefined {
  if (target.includes("/")) return byKey.get(target);
  return (
    byKey.get(`${src.projectId}/${target}`) ??
    byKey.get(`${GLOBAL_PROJECT_ID}/${target}`) ??
    resolveTarget(target, src, byKey, bySlug)
  );
}

/** A `[[target]]` reference in a doc body and the source line it sits on. */
export interface Wikilink {
  /** `slug` or `projectId/slug`, with any `|label` or `#heading` suffix removed. */
  target: string;
  /** The line holding the link, trimmed. */
  line: string;
}

// `[[target]]`, `[[target|label]]`, `[[target#heading]]`. The target may not
// contain brackets, a pipe or a newline.
const WIKILINK_RE = /\[\[([^[\]|\n]+?)(?:\|[^[\]\n]*)?\]\]/g;
// A fenced code block opens and closes on a line of three or more backticks or
// tildes, indented at most three spaces (CommonMark).
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
// An inline code span: a run of backticks, the shortest content, the same run.
const INLINE_CODE_RE = /(`+)[^`]*?\1/g;

/**
 * The `[[slug]]` / `[[project/slug]]` links in a markdown body, in order. Links
 * inside fenced code blocks or inline code spans are text about the syntax, not
 * links (a TOML `[[project]]` table, a doc explaining `[[slug]]`), so they are
 * skipped. A target that is not a plain slug path (spaces, empty) is skipped.
 */
export function parseWikilinks(body: string): Wikilink[] {
  const links: Wikilink[] = [];
  let fence: string | null = null;
  for (const raw of body.split("\n")) {
    const fenceMatch = FENCE_RE.exec(raw);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const text = raw.replace(INLINE_CODE_RE, (m) => " ".repeat(m.length));
    for (const m of text.matchAll(WIKILINK_RE)) {
      const target = m[1].split("#")[0].trim();
      if (!target || /\s/.test(target)) continue;
      links.push({ target, line: raw.trim() });
    }
  }
  return links;
}

function capEvidence(line: string): string {
  return line.length <= WIKILINK_EVIDENCE_MAX_CHARS
    ? line
    : `${line.slice(0, WIKILINK_EVIDENCE_MAX_CHARS - 1)}…`;
}

/**
 * The claim-string contract binding the coherence WRITER
 * (knowledge-coherence.contradictionDispute) to this graph READER: a
 * contradiction dispute's claim is `Contradicts <targetSlug>`. Both sides go
 * through `formatContradictsClaim`/`parseContradictsClaim` so the literal cannot
 * drift out of sync across the package boundary. Matching only this prefix is
 * also the guard that keeps a doc↔code fact-check "disputed" dispute — whose
 * claim quotes the draft's own text — from being read as a doc↔doc contradiction.
 */
export const CONTRADICTS_CLAIM_PREFIX = "Contradicts ";

/** Format the contradiction dispute claim naming the opposing doc. */
export function formatContradictsClaim(targetSlug: string): string {
  return `${CONTRADICTS_CLAIM_PREFIX}${targetSlug}`;
}

/** The target slug of a `Contradicts <slug>` claim, or null if the claim isn't one. */
export function parseContradictsClaim(claim: string): string | null {
  if (!claim.startsWith(CONTRADICTS_CLAIM_PREFIX)) return null;
  const target = claim.slice(CONTRADICTS_CLAIM_PREFIX.length).trim();
  return target.length > 0 ? target : null;
}

/**
 * The doc's `Contradicts <slug>` disputes — the doc↔doc conflict state the
 * coherence pass wrote, isolated from any doc↔code fact-check disputes by the
 * same prefix guard deriveEdges uses. The re-verify pass folds a fresh code
 * verdict onto these rather than clobbering them, so a code fact-check never
 * silently drops a contradiction the human still needs to resolve.
 */
export function contradictionDisputes(doc: KnowledgeDoc): DraftDispute[] {
  return (doc.disputes ?? []).filter((d) => parseContradictsClaim(d.claim) !== null);
}

/**
 * Whether a doc is an endpoint of a coherence-flagged contradiction: it carries
 * a `Contradicts <slug>` dispute. deriveEdges re-projects that state into a
 * `contradicts` graph edge, and the re-verification cron uses the same signal to
 * push a flagged doc ahead of a merely-aging one for human review — one source,
 * two consumers.
 */
export function isContradictionEndpoint(doc: KnowledgeDoc): boolean {
  return contradictionDisputes(doc).length > 0;
}

/**
 * Undirected co-citation edges between docs sharing at least one SPECIFIC tag
 * — one carried by at most CO_CITATION_MAX_TAG_DOCS docs. Weight is the number
 * of shared specific tags. Pairs are ranked by that count, then by how rare the
 * shared tags are (summed inverse document frequency), and a greedy per-doc
 * fanout cap keeps only each doc's strongest links. The evidence names the
 * shared tags rather than a bare count.
 *
 * With `docVectors`, a pair whose docs are BOTH embedded must also agree in
 * content for a tag to link them: a shared tag is a hint, and two docs that
 * share `testing` but are about different systems are not related. The bar is
 * per tag — the larger of coCitationMinCosine and the tag's own median
 * pairwise cosine minus CO_CITATION_TAG_MEDIAN_MARGIN — so a tag whose docs
 * split into two unrelated groups drops its cross-group pairs. A pair with an
 * unembedded side is judged on its tags alone.
 *
 * A tag in `coCitationAmbiguousTags` never links a pair on its own: the pair is
 * kept only if at least one other tag links it, and the ambiguous tag then
 * counts toward its weight and evidence like any other.
 */
function coCitationEdges(docs: KnowledgeDoc[], options: DeriveEdgeOptions): KnowledgeEdge[] {
  const maxTagDocs = options.coCitationMaxTagDocs ?? CO_CITATION_MAX_TAG_DOCS;
  const maxFanout = options.coCitationMaxFanout ?? CO_CITATION_MAX_FANOUT;
  const minCosine = options.coCitationMinCosine ?? CO_CITATION_MIN_COSINE;
  const ambiguous = options.coCitationAmbiguousTags ?? CO_CITATION_AMBIGUOUS_TAGS;
  const vectors = options.docVectors;
  // Pair cosine, or null when either side is unembedded. Memoized: a pair that
  // shares several tags is scored once.
  const cosines = new Map<string, number | null>();
  const pairCosine = (a: string, b: string): number | null => {
    const key = `${a}|${b}`;
    if (cosines.has(key)) return cosines.get(key)!;
    const va = vectors?.get(a);
    const vb = vectors?.get(b);
    const cosine = va && vb ? cosineSimilarity(va, vb) : null;
    cosines.set(key, cosine);
    return cosine;
  };
  const byTag = new Map<string, KnowledgeDoc[]>();
  for (const d of docs) {
    for (const t of new Set(d.tags ?? [])) {
      const arr = byTag.get(t) ?? [];
      arr.push(d);
      byTag.set(t, arr);
    }
  }

  const pairs = new Map<
    string,
    { a: string; b: string; tags: string[]; rarity: number; anchored: boolean }
  >();
  for (const [tag, group] of byTag) {
    if (group.length < 2 || group.length > maxTagDocs) continue;
    const rarity = Math.log(docs.length / group.length);
    const tagPairs: Array<{ a: string; b: string; cosine: number | null }> = [];
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (group[i].id === group[j].id) continue;
        const [a, b] = ordered(group[i].id, group[j].id);
        tagPairs.push({ a, b, cosine: pairCosine(a, b) });
      }
    }
    const floor = tagCosineFloor(tagPairs, minCosine);
    const isAmbiguous = ambiguous.has(tag);
    for (const { a, b, cosine } of tagPairs) {
      if (cosine !== null && cosine < floor) continue;
      const key = `${a}|${b}`;
      const cur = pairs.get(key);
      if (cur) {
        cur.tags.push(tag);
        cur.rarity += rarity;
        cur.anchored ||= !isAmbiguous;
      } else {
        pairs.set(key, { a, b, tags: [tag], rarity, anchored: !isAmbiguous });
      }
    }
  }

  // Add strongest pairs first, skipping either endpoint that has hit the cap —
  // greedy but deterministic (shared count desc, rarity desc, then id) so
  // recompiles are stable.
  const degree = new Map<string, number>();
  const sorted = [...pairs.values()].filter((p) => p.anchored).sort(
    (x, y) =>
      y.tags.length - x.tags.length ||
      y.rarity - x.rarity ||
      `${x.a}|${x.b}`.localeCompare(`${y.a}|${y.b}`)
  );

  const edges: KnowledgeEdge[] = [];
  for (const { a, b, tags } of sorted) {
    if ((degree.get(a) ?? 0) >= maxFanout) continue;
    if ((degree.get(b) ?? 0) >= maxFanout) continue;
    degree.set(a, (degree.get(a) ?? 0) + 1);
    degree.set(b, (degree.get(b) ?? 0) + 1);
    // Sort the shared tags so the evidence reads stably across recompiles
    // regardless of the order docs happened to be folded in.
    const shared = [...tags].sort();
    edges.push({
      id: edgeId("co-citation", a, b),
      srcDocId: a,
      dstDocId: b,
      kind: "co-citation",
      weight: shared.length,
      evidence: `shared tags: ${shared.join(", ")}`,
    });
  }
  return edges;
}

/**
 * The cosine a pair of embedded docs must clear for one tag to link them:
 * max(globalFloor, median of the tag's embedded pairwise cosines −
 * CO_CITATION_TAG_MEDIAN_MARGIN). Pairs with an unembedded side carry no cosine
 * and do not enter the median. Deterministic: the median of a sorted list.
 */
function tagCosineFloor(tagPairs: ReadonlyArray<{ cosine: number | null }>, globalFloor: number): number {
  const sims = tagPairs
    .map((p) => p.cosine)
    .filter((s): s is number => s !== null)
    .sort((x, y) => x - y);
  if (sims.length === 0) return globalFloor;
  const mid = sims.length >> 1;
  const median = sims.length % 2 === 1 ? sims[mid] : (sims[mid - 1] + sims[mid]) / 2;
  return Math.max(globalFloor, median - CO_CITATION_TAG_MEDIAN_MARGIN);
}

/**
 * Undirected `provenance` edges between docs written by the same authoring
 * session (a non-empty `sourceSessionId`). One session often writes several
 * unrelated docs, so the edge is weak (PROVENANCE_WEIGHT) and, when both docs
 * are embedded, must clear the same content floor a co-citation does. Each doc
 * keeps at most `provenanceMaxFanout` of them, its closest siblings first
 * (cosine desc, pairs without a cosine after, then id), so a prolific session
 * yields a bounded neighborhood rather than a clique. Native-memory and
 * project-doc mirrors carry no session id and get none.
 */
function provenanceEdges(docs: KnowledgeDoc[], options: DeriveEdgeOptions): KnowledgeEdge[] {
  const maxFanout = options.provenanceMaxFanout ?? PROVENANCE_MAX_FANOUT;
  const minCosine = options.coCitationMinCosine ?? CO_CITATION_MIN_COSINE;
  const vectors = options.docVectors;
  const bySession = new Map<string, string[]>();
  for (const d of docs) {
    const session = d.sourceSessionId?.trim();
    if (!session) continue;
    const ids = bySession.get(session) ?? [];
    if (!ids.includes(d.id)) ids.push(d.id);
    bySession.set(session, ids);
  }

  const candidates: Array<{ a: string; b: string; cosine: number | null }> = [];
  for (const ids of bySession.values()) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const [a, b] = ordered(ids[i], ids[j]);
        const va = vectors?.get(a);
        const vb = vectors?.get(b);
        const cosine = va && vb ? cosineSimilarity(va, vb) : null;
        if (cosine !== null && cosine < minCosine) continue;
        candidates.push({ a, b, cosine });
      }
    }
  }
  candidates.sort(
    (x, y) =>
      (y.cosine ?? -Infinity) - (x.cosine ?? -Infinity) ||
      `${x.a}|${x.b}`.localeCompare(`${y.a}|${y.b}`)
  );

  const degree = new Map<string, number>();
  const edges: KnowledgeEdge[] = [];
  for (const { a, b } of candidates) {
    if ((degree.get(a) ?? 0) >= maxFanout) continue;
    if ((degree.get(b) ?? 0) >= maxFanout) continue;
    degree.set(a, (degree.get(a) ?? 0) + 1);
    degree.set(b, (degree.get(b) ?? 0) + 1);
    edges.push({
      id: edgeId("provenance", a, b),
      srcDocId: a,
      dstDocId: b,
      kind: "provenance",
      weight: PROVENANCE_WEIGHT,
      evidence: "same authoring session",
    });
  }
  return edges;
}

// ---------------------------------------------------------------------------
// Why nodes FLOAT, and how de-float fixes it.
//
// deriveEdges emits FOUR kinds, each keyed off AUTHORED metadata: `related`
// (a frontmatter link or a body `[[slug]]` wikilink), `co-citation` (>=1
// shared specific tag), `provenance` (the same authoring session) and
// `contradicts` (a coherence dispute). One session routinely writes several
// unrelated docs (a bulk ingest, a long multi-project job), so a provenance
// edge is weak, content-gated when both docs are embedded, and fanout-capped
// rather than a clique. A doc gets NO edge — it floats — when it has none of
// those overlaps with any other doc: a singleton whose tags are unique, absent
// or only generic, a doc that links to nothing and shares no session, a
// native-memory import (a CLAUDE.md/rules mirror) that shares no specific tag
// with the curated corpus.
// An all-singletons graph is unreadable, so de-float is
// warranted: deriveDefloatEdges (below) connects each OTHERWISE-floating doc to
// its nearest semantic neighbors so it joins the graph, while leaving the
// already-connected docs to the authored metadata that linked them.
// ---------------------------------------------------------------------------

/**
 * Derives the full edge set from a corpus. Pure — takes docs, returns edges —
 * so the derivation is unit-testable without a database.
 */
export function deriveEdges(docs: KnowledgeDoc[], options: DeriveEdgeOptions = {}): KnowledgeEdge[] {
  const byKey = new Map<string, KnowledgeDoc>();
  const bySlug = new Map<string, KnowledgeDoc[]>();
  for (const d of docs) {
    byKey.set(`${d.projectId}/${d.slug}`, d);
    const arr = bySlug.get(d.slug) ?? [];
    arr.push(d);
    bySlug.set(d.slug, arr);
  }

  const edges: KnowledgeEdge[] = [];

  // 1. Explicit, directed edges an author wrote: frontmatter `related` targets,
  //    then body `[[slug]]` wikilinks. Both are `related` edges keyed by the
  //    same (src, dst) id; where a doc names a target both ways the frontmatter
  //    edge (weight 1) is kept over the wikilink (WIKILINK_WEIGHT), and a target
  //    linked on several lines keeps its first line as evidence.
  const relatedById = new Map<string, KnowledgeEdge>();
  for (const d of docs) {
    for (const target of d.related ?? []) {
      const dst = resolveTarget(target, d, byKey, bySlug);
      if (!dst || dst.id === d.id) continue;
      const id = edgeId("related", d.id, dst.id);
      if (relatedById.has(id)) continue;
      relatedById.set(id, {
        id,
        srcDocId: d.id,
        dstDocId: dst.id,
        kind: "related",
        weight: 1,
        confidence: 1,
        evidence: `frontmatter related: ${target}`,
      });
    }
  }
  for (const d of docs) {
    for (const { target, line } of parseWikilinks(d.body ?? "")) {
      const dst = resolveWikilinkTarget(target, d, byKey, bySlug);
      if (!dst || dst.id === d.id) continue;
      const id = edgeId("related", d.id, dst.id);
      if (relatedById.has(id)) continue;
      relatedById.set(id, {
        id,
        srcDocId: d.id,
        dstDocId: dst.id,
        kind: "related",
        weight: WIKILINK_WEIGHT,
        evidence: capEvidence(line),
      });
    }
  }
  edges.push(...relatedById.values());

  // 2. Compiler-derived backlinks: shared specific tags (co-citation),
  //    undirected, naming the shared tags so the edge answers "how do these
  //    relate" rather than giving a bare count.
  edges.push(...coCitationEdges(docs, options));

  // 3. Same-authoring-session backlinks (provenance), undirected and capped.
  edges.push(...provenanceEdges(docs, options));

  // 4. Coherence-derived contradiction edges — a pure re-projection of the
  //    verdict the coherence pass already persisted. That pass writes a
  //    `Contradicts <slug>` dispute on both docs of a conflicting pair; each
  //    such dispute names its counterpart, resolved the same way a `related`
  //    target is. The pair is undirected (a contradiction is mutual), so it
  //    emits both directions like a mutual `related` pair — reachable and
  //    warned-on from either end. Weight counts the disputes naming the pair:
  //    the coherence pass stamps `Contradicts <other>` on BOTH docs, so a real
  //    mutual conflict resolves to weight 2 (each doc's dispute maps to the same
  //    ordered pair). A named slug that no longer resolves (renamed/removed doc)
  //    is dropped rather than left a half-edge.
  const contradictions = new Map<
    string,
    { a: string; b: string; w: number; detail?: string }
  >();
  for (const d of docs) {
    for (const dispute of d.disputes ?? []) {
      const target = parseContradictsClaim(dispute.claim);
      if (!target) continue;
      const dst = resolveTarget(target, d, byKey, bySlug);
      if (!dst || dst.id === d.id) continue;
      const [a, b] = ordered(d.id, dst.id);
      const key = `${a}|${b}`;
      // The dispute's own words are what makes the conflict legible: the
      // finding (why they oppose), falling back to the evidence command. The
      // first non-empty one the pair yields wins, so the edge carries the
      // actual "what's the contradiction" rather than a constant.
      const detail = dispute.finding?.trim() || dispute.evidence?.trim() || undefined;
      const cur = contradictions.get(key);
      if (cur) {
        cur.w += 1;
        if (!cur.detail && detail) cur.detail = detail;
      } else {
        contradictions.set(key, { a, b, w: 1, detail });
      }
    }
  }
  for (const { a, b, w, detail } of contradictions.values()) {
    for (const [src, dst] of [
      [a, b],
      [b, a],
    ] as const) {
      edges.push({
        id: edgeId("contradicts", src, dst),
        srcDocId: src,
        dstDocId: dst,
        kind: "contradicts",
        weight: w,
        evidence: detail ?? "coherence: contradiction flagged",
      });
    }
  }

  return edges;
}

/**
 * Recompiles the whole graph from the store's current docs and persists it.
 * Returns the edges written so a caller can report a count without re-reading.
 */
export function compileGraph(store: KnowledgeStore): KnowledgeEdge[] {
  // Memoize on a cheap corpus fingerprint. /graph, /stats, and /neighbors each
  // recompile the graph on EVERY request, and the de-float branch below reads +
  // JSON.parses every chunk embedding and runs O(F·N) cosine — a cost that on a
  // real corpus (where floaters are the norm) fires on essentially every read.
  // Reusing the last compile whenever the corpus is unchanged collapses a burst
  // of reads into ONE compile and keeps that scan off the request path. The
  // knowledge_edges rows the cached compile wrote are still current (compileGraph
  // is their only writer), so a cache hit needs no re-derive and no re-persist.
  const revision = store.corpusRevision();
  const cached = store.getCachedGraphEdges(revision);
  if (cached) return cached;

  const docs = store.getAllDocs();
  // The content vectors gate co-citation (a shared tag must be backed by
  // similar content) and drive de-float. Reading every chunk embedding is the
  // only non-trivial cost here; the memo above keeps it to once per corpus
  // revision.
  const docVectors = docVectorsFromStore(store);
  const edges = deriveEdges(docs, { docVectors });
  // De-float: any doc the authored/derived edges above left with NO edge is
  // attached to its nearest semantic neighbors, appended to this SAME edge set
  // so both persist together — replaceAllEdges wipes the table first, so a
  // semantic pass in a separate call would be dropped.
  edges.push(...deriveDefloatEdges(docs, edges, docVectors));
  store.replaceAllEdges(edges);
  store.cacheGraphEdges(revision, edges);
  return edges;
}

// ---------------------------------------------------------------------------
// Semantic-similarity edges — the edge the graph-aware retrieval rerank walks.
//
// Unlike the co-citation edges above (which key off authored metadata — tags),
// a semantic edge keys off the DOC'S CONTENT vector,
// derived by aggregating its knowledge_chunks embeddings. The doc-level
// knowledge.embedding_json column is never populated by any ingest path (see
// store.ts projectScalars), so the ONLY faithful source of a doc's embedding is
// the mean of its chunk vectors — the same vectors searchEmbeddings scores. A
// per-doc aggregate makes the edge query-INDEPENDENT: it is a fixed property of
// the corpus, computable once, so it can lift a low-lexical-overlap doc that a
// query-side embedding (unavailable on the FTS-only offline path) never would.
// ---------------------------------------------------------------------------

/** Default cap on how many semantic neighbors a doc keeps — bounded fanout, like CO_CITATION_MAX_FANOUT. */
export const SEMANTIC_MAX_FANOUT = 8;
/** Default floor on the cosine similarity a semantic edge must clear to exist at all. */
export const SEMANTIC_MIN_SIM = 0.5;

export interface SemanticEdgeOptions {
  /** Max neighbors kept per doc (bounded fanout). */
  topN?: number;
  /** Minimum cosine similarity for an edge to exist. */
  minSim?: number;
}

/** One doc's semantic neighbor: the far doc id and the cosine similarity that links them. */
export interface SemanticNeighbor {
  docId: string;
  similarity: number;
}

/** Per-doc adjacency the rerank walks: src doc id → its semantic neighbors, strongest first. */
export type SemanticNeighborIndex = Map<string, SemanticNeighbor[]>;

/**
 * Aggregates each doc's chunk embeddings into ONE per-doc vector (the mean of
 * its chunk vectors). Pure: takes the (knowledgeId, embedding) rows the store
 * already exposes and returns a docId→vector map. A doc with no chunks (no
 * embedding coverage) is absent from the result — it has no semantic position,
 * so it neither emits nor receives a semantic edge. Chunks of differing width
 * (a provider switch left the corpus mixed) are skipped for the minority width;
 * the modal width wins, matching the store's single-width invariant.
 */
export function deriveDocVectors(
  chunks: ReadonlyArray<{ knowledgeId: string; embedding: number[] }>
): Map<string, number[]> {
  // Group embeddings by doc, tracking each doc's dominant width so a stray
  // wrong-width vector can't corrupt the mean.
  const byDoc = new Map<string, number[][]>();
  for (const c of chunks) {
    if (!Array.isArray(c.embedding) || c.embedding.length === 0) continue;
    const arr = byDoc.get(c.knowledgeId) ?? [];
    arr.push(c.embedding);
    byDoc.set(c.knowledgeId, arr);
  }

  const vectors = new Map<string, number[]>();
  for (const [docId, embs] of byDoc) {
    // The modal width for this doc; skip any vector that disagrees.
    const widthCounts = new Map<number, number>();
    for (const e of embs) widthCounts.set(e.length, (widthCounts.get(e.length) ?? 0) + 1);
    let width = 0;
    let best = -1;
    for (const [w, n] of widthCounts) if (n > best) { best = n; width = w; }
    if (width === 0) continue;

    const mean = new Array<number>(width).fill(0);
    let n = 0;
    for (const e of embs) {
      if (e.length !== width) continue;
      for (let i = 0; i < width; i++) mean[i] += e[i];
      n++;
    }
    if (n === 0) continue;
    for (let i = 0; i < width; i++) mean[i] /= n;
    vectors.set(docId, mean);
  }
  return vectors;
}

/** Reads the store's chunk embeddings and aggregates them per doc. Convenience over deriveDocVectors. */
export function docVectorsFromStore(store: KnowledgeStore): Map<string, number[]> {
  const chunks = store.getAllChunksWithEmbeddings();
  return deriveDocVectors(
    chunks.map((c) => ({ knowledgeId: c.knowledgeId, embedding: c.embedding }))
  );
}

/**
 * Directed semantic-similarity edges: for each doc, its top-N most cosine-similar
 * peers above the floor, strongest first. Directed (src doc → neighbor) and
 * per-doc capped, so the fanout is bounded like the co-citation edges; the top-N
 * of A and of B need not agree, which is honest — A's nearest neighbor need not
 * count A among its own nearest. Deterministic: sims sorted desc then by id, so
 * a recompile is stable. Weight carries the cosine so the rerank can scale its
 * boost by edge strength.
 */
export function deriveSemanticEdges(
  docVectors: Map<string, number[]>,
  options: SemanticEdgeOptions = {}
): KnowledgeEdge[] {
  const topN = options.topN ?? SEMANTIC_MAX_FANOUT;
  const minSim = options.minSim ?? SEMANTIC_MIN_SIM;
  const ids = [...docVectors.keys()].sort();

  const edges: KnowledgeEdge[] = [];
  for (const src of ids) {
    const srcVec = docVectors.get(src)!;
    const scored: SemanticNeighbor[] = [];
    for (const dst of ids) {
      if (dst === src) continue;
      const similarity = cosineSimilarity(srcVec, docVectors.get(dst)!);
      if (similarity >= minSim) scored.push({ docId: dst, similarity });
    }
    scored.sort((a, b) => b.similarity - a.similarity || a.docId.localeCompare(b.docId));
    for (const { docId: dst, similarity } of scored.slice(0, topN)) {
      edges.push({
        id: edgeId("semantic-similarity", src, dst),
        srcDocId: src,
        dstDocId: dst,
        kind: "semantic-similarity",
        weight: similarity,
        confidence: similarity,
        evidence: `cosine ${similarity.toFixed(3)} over aggregated chunk embeddings`,
      });
    }
  }
  return edges;
}

// ---------------------------------------------------------------------------
// De-float edges — the float-targeted counterpart of deriveSemanticEdges.
//
// deriveSemanticEdges connects EVERY doc to its top-N peers (the adjacency the
// search rerank walks). For the VISUAL graph that is a hairball: it over-links
// docs the authored metadata already connected. De-float instead attaches ONLY
// the docs that would otherwise float — a bounded fix that makes an
// all-singletons graph navigable without collapsing it into a fully-connected
// mesh. Similarity is the same aggregated-chunk cosine deriveSemanticEdges uses
// (never recomputed); a floater with no embedding falls back to a title/tag
// TOKEN overlap so an FTS-only corpus still de-floats.
// ---------------------------------------------------------------------------

/** Neighbors added per otherwise-floating doc — bounded so de-float can't build a hairball. */
export const DEFLOAT_MAX_NEIGHBORS = 3;
/**
 * Cap on a single target's INCOMING de-float edges. maxNeighbors bounds a
 * floater's out-degree, but nothing stops many floaters all naming the same
 * nearest doc; this caps that doc's in-degree so a near-duplicate cluster can't
 * turn it into a dense star hub.
 */
export const DEFLOAT_MAX_IN_DEGREE = DEFLOAT_MAX_NEIGHBORS;
/** Cosine floor a de-float edge must clear when the floating doc has an embedding. */
export const DEFLOAT_MIN_COSINE = 0.8;
/** Jaccard floor (over title tokens + tags) a de-float edge must clear on the no-embedding fallback. */
export const DEFLOAT_MIN_TOKEN_OVERLAP = 0.3;

// Filler words that carry no subject signal, dropped from the fallback token bag
// so a shared "the"/"with" can't fabricate a token-overlap edge between two
// unrelated docs.
const TOKEN_STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "into", "over", "how",
  "what", "are", "was", "its", "being", "not", "how-to", "using", "via",
]);

export interface DefloatOptions {
  /** Max de-float neighbors kept per floating doc (bounded out-degree). */
  maxNeighbors?: number;
  /** Max de-float edges kept pointing AT any one doc (bounded in-degree — prevents star hubs). */
  maxInDegree?: number;
  /** Minimum cosine for an embedding-path de-float edge to exist. */
  minCosine?: number;
  /** Minimum title/tag token Jaccard for a fallback de-float edge to exist. */
  minTokenOverlap?: number;
}

/**
 * The lexical token bag of a doc — lowercased title words plus its tags — used
 * ONLY by the de-float fallback when a doc has no embedding. Tokens shorter than
 * three characters and a few stopwords are dropped so overlap reflects real
 * subject words rather than filler. A floater's tags are unique or generic (a
 * shared specific one would already be a co-citation edge), so tags alone
 * rarely clear the Jaccard floor; the useful overlap comes from the title terms.
 */
function docTokens(doc: KnowledgeDoc): Set<string> {
  const bag = new Set<string>();
  const add = (raw: string) => {
    const t = raw.toLowerCase();
    if (t.length >= 3 && !TOKEN_STOPWORDS.has(t)) bag.add(t);
  };
  for (const w of doc.title.split(/[^a-z0-9]+/i)) if (w) add(w);
  for (const tag of doc.tags ?? []) if (tag) add(tag);
  return bag;
}

/** Jaccard overlap of two token bags — |A∩B| / |A∪B| — 0 when either is empty. */
function tokenJaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Directed `semantic-similarity` edges that attach otherwise-FLOATING docs to
 * their nearest neighbors. A doc floats when `metadataEdges` (the deriveEdges
 * output) gave it no edge; only those floaters get an edge here, and each keeps
 * at most `maxNeighbors` of them, so the pass lifts the disconnected without
 * over-connecting the docs the authored metadata already linked.
 *
 * A floater WITH an aggregated chunk vector links to the peers whose cosine
 * clears `minCosine`; a floater WITHOUT one falls back to a title/tag token
 * Jaccard clearing `minTokenOverlap`. Either way the candidates are sorted
 * strongest-first (ties broken by id for a stable recompile) and truncated to
 * `maxNeighbors`. A floater whose every candidate sits below the floor gets NO
 * edge and stays floating — an honest island is better than a fabricated link.
 *
 * `maxNeighbors` bounds each floater's OUT-degree, but a near-duplicate cluster
 * could still make ONE popular doc every floater's nearest neighbor — a dense
 * star hub. So a final pass caps each TARGET's IN-degree at `maxInDegree`,
 * dropping its weakest incoming edges past the cap (ties broken by src id for a
 * stable recompile). That cap never re-strands a floater: an edge that is its
 * source floater's ONLY surviving de-float edge is exempt from the drop, so when
 * a floater's sole qualifying neighbor is an over-subscribed hub the hub stays
 * slightly over the cap rather than dropping the floater back into an island.
 *
 * Bounded: for F floaters over N docs this is O(F·N) similarity comparisons with
 * NO LLM calls (the embeddings already exist), strictly cheaper than the
 * all-pairs deriveSemanticEdges; it emits at most F·maxNeighbors edges and no
 * target keeps more than `maxInDegree` of them.
 */
export function deriveDefloatEdges(
  docs: KnowledgeDoc[],
  metadataEdges: KnowledgeEdge[],
  docVectors: Map<string, number[]>,
  options: DefloatOptions = {}
): KnowledgeEdge[] {
  const maxNeighbors = options.maxNeighbors ?? DEFLOAT_MAX_NEIGHBORS;
  const maxInDegree = options.maxInDegree ?? DEFLOAT_MAX_IN_DEGREE;
  const minCosine = options.minCosine ?? DEFLOAT_MIN_COSINE;
  const minTokenOverlap = options.minTokenOverlap ?? DEFLOAT_MIN_TOKEN_OVERLAP;

  // The docs the authored/derived edges already touch — the ones NOT to link.
  const connected = new Set<string>();
  for (const e of metadataEdges) {
    connected.add(e.srcDocId);
    connected.add(e.dstDocId);
  }
  const floating = docs.filter((d) => !connected.has(d.id));
  if (floating.length === 0) return [];

  // Token bags are only needed for the fallback path, but a floater's neighbor
  // can be ANY doc, so build them once for every doc rather than per comparison.
  const tokensById = new Map<string, Set<string>>();
  for (const d of docs) tokensById.set(d.id, docTokens(d));

  const edges: KnowledgeEdge[] = [];
  for (const src of floating) {
    const srcVec = docVectors.get(src.id);
    const scored: Array<{ dst: string; similarity: number; embedded: boolean }> = [];
    for (const other of docs) {
      if (other.id === src.id) continue;
      if (srcVec) {
        // Embedding path: only peers that also carry a vector are comparable.
        const otherVec = docVectors.get(other.id);
        if (!otherVec) continue;
        const similarity = cosineSimilarity(srcVec, otherVec);
        if (similarity >= minCosine) scored.push({ dst: other.id, similarity, embedded: true });
      } else {
        // Fallback path: the floater has no embedding, so link by token overlap.
        const similarity = tokenJaccard(tokensById.get(src.id)!, tokensById.get(other.id)!);
        if (similarity >= minTokenOverlap) scored.push({ dst: other.id, similarity, embedded: false });
      }
    }
    scored.sort((a, b) => b.similarity - a.similarity || a.dst.localeCompare(b.dst));
    for (const { dst, similarity, embedded } of scored.slice(0, maxNeighbors)) {
      edges.push({
        id: edgeId("semantic-similarity", src.id, dst),
        srcDocId: src.id,
        dstDocId: dst,
        kind: "semantic-similarity",
        weight: similarity,
        confidence: similarity,
        evidence: embedded
          ? `de-float: cosine ${similarity.toFixed(3)} over aggregated chunk embeddings`
          : `de-float: title/tag overlap ${similarity.toFixed(3)} (no embedding)`,
      });
    }
  }

  // In-degree cap: bucket the emitted edges by target and, for any target over
  // the cap, drop its weakest incoming edges (strongest kept, ties broken by src
  // id so a recompile is stable). Sorting the per-target buckets does not reorder
  // `edges`, so the survivors keep their per-floater, strongest-first order.
  //
  // The cap must never re-strand a floater: de-float exists to give every
  // otherwise-floating doc >=1 neighbor, so an edge that is its SOURCE floater's
  // only surviving de-float edge is exempt from the drop even when its target is
  // over the cap. `survivingBySrc` tracks each source's remaining edge count and
  // is decremented as edges are dropped, so we shed the weakest edges whose source
  // keeps another link and stop short only when every remaining over-cap edge is
  // some floater's sole attachment — the hub then stays slightly over the cap
  // rather than trading a floater back into an island (a bounded, near-duplicate
  // excess that never spills into a hairball).
  const incomingByTarget = new Map<string, KnowledgeEdge[]>();
  const survivingBySrc = new Map<string, number>();
  for (const e of edges) {
    const arr = incomingByTarget.get(e.dstDocId) ?? [];
    arr.push(e);
    incomingByTarget.set(e.dstDocId, arr);
    survivingBySrc.set(e.srcDocId, (survivingBySrc.get(e.srcDocId) ?? 0) + 1);
  }
  const dropped = new Set<string>();
  for (const incoming of incomingByTarget.values()) {
    if (incoming.length <= maxInDegree) continue;
    incoming.sort(
      (a, b) => (b.weight ?? 0) - (a.weight ?? 0) || a.srcDocId.localeCompare(b.srcDocId)
    );
    // Walk weakest-first (the sort is strongest-first), dropping only edges whose
    // source retains another link, until the target is back at the cap.
    let overflow = incoming.length - maxInDegree;
    for (let i = incoming.length - 1; i >= 0 && overflow > 0; i--) {
      const e = incoming[i];
      if ((survivingBySrc.get(e.srcDocId) ?? 0) <= 1) continue; // sole link — keep it
      dropped.add(e.id);
      survivingBySrc.set(e.srcDocId, (survivingBySrc.get(e.srcDocId) ?? 0) - 1);
      overflow--;
    }
  }
  return dropped.size === 0 ? edges : edges.filter((e) => !dropped.has(e.id));
}

/** Groups semantic edges into the per-source adjacency the rerank walks (strongest first). */
export function buildSemanticNeighborIndex(edges: KnowledgeEdge[]): SemanticNeighborIndex {
  const index: SemanticNeighborIndex = new Map();
  for (const e of edges) {
    if (e.kind !== "semantic-similarity") continue;
    const arr = index.get(e.srcDocId) ?? [];
    arr.push({ docId: e.dstDocId, similarity: e.weight ?? 0 });
    index.set(e.srcDocId, arr);
  }
  for (const arr of index.values()) {
    arr.sort((a, b) => b.similarity - a.similarity || a.docId.localeCompare(b.docId));
  }
  return index;
}

/**
 * One-call derivation of the semantic neighbor index from a store: aggregate
 * chunk embeddings per doc, derive the edges, group them. This is the "graph
 * machinery" the rerank consumes — the shipped edge, not one faked off the
 * never-populated doc-level embedding column.
 */
export function semanticNeighborIndexFromStore(
  store: KnowledgeStore,
  options: SemanticEdgeOptions = {}
): SemanticNeighborIndex {
  return buildSemanticNeighborIndex(
    deriveSemanticEdges(docVectorsFromStore(store), options)
  );
}

/**
 * semanticNeighborIndexFromStore memoized on the store's corpusRevision, so the
 * graph-aware retrieval rerank reuses ONE all-pairs cosine build across a burst
 * of searches and rebuilds only when the corpus changes. This is the memo that
 * keeps the rerank's neighbor derivation off the per-query hot path; the arm's
 * caller invokes it only when the rerank flag is on, so a corpus that never
 * enables the arm never triggers the build. Only the default-parameter index is
 * cached: a caller overriding topN/minSim wants a different adjacency, so it
 * bypasses the shared cache rather than poisoning it for the default path.
 */
export function memoizedSemanticNeighborIndex(
  store: KnowledgeStore,
  options: SemanticEdgeOptions = {}
): SemanticNeighborIndex {
  const useCache = options.topN === undefined && options.minSim === undefined;
  const revision = store.corpusRevision();
  if (useCache) {
    const cached = store.getCachedSemanticIndex(revision);
    if (cached) return cached;
  }
  const index = semanticNeighborIndexFromStore(store, options);
  if (useCache) store.cacheSemanticIndex(revision, index);
  return index;
}
