import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import {
  DEFAULT_SCOPE,
  DISPUTED_CONFIDENCE,
  draftFileExists,
  layerOf,
  spliceFrontmatter,
  writeDraftFile,
  type KnowledgeDraftInput,
  type OriginClass,
  type Scope,
  type SourceKind,
} from "@standup/knowledge";
import {
  NEAR_DUP_CONTAINMENT_THRESHOLD,
  NEAR_DUP_LEXICAL_THRESHOLD,
  NEAR_DUP_SIZE_RATIO_FLOOR,
  dupFeatures,
  isHighConfidenceDuplicate,
  lexicalTokens,
} from "./knowledge-dedup.js";
import { MIRROR_PROJECTS } from "./projects-registry.js";

/**
 * Corpus maintenance for duplicated knowledge, run by the collector on its own
 * database:
 *
 *  - Mirror copies are retired. A doc in a reserved mirror project
 *    (MIRROR_PROJECTS) whose canonical project has a doc of the same slug, scope
 *    and owner that it copies — the same body (whitespace aside), or a
 *    high-confidence duplicate (isHighConfidenceDuplicate) naming no different
 *    value — is superseded in favor of it: verdict `superseded`, a tombstone
 *    dispute "Superseded by <canonical>/<slug>" (the contradiction resolver's
 *    shape, after any findings the copy already carried), confidence
 *    DISPUTED_CONFIDENCE — in the file too when a knowledge dir is given, since
 *    confidence is file-authoritative. The copy keeps its row, file and body; a
 *    copy with no such counterpart is kept.
 *  - Near-duplicate clusters inside one project are only ever merged through
 *    review: each cluster gets one draft replacing the kept doc's slug,
 *    carrying its body followed by the other members' bodies, for a human to
 *    edit down and accept. Nothing is retired or deleted for a cluster; the
 *    draft names the absorbed slugs, which stay published until retired by
 *    hand. Only docs that share a layer, scope and owner cluster together, and
 *    personal, activity, native-memory and ingest-owned docs never cluster.
 *
 * Both halves are idempotent: a retired copy is not retired again, and a
 * cluster whose kept slug already has a pending draft is skipped.
 */

/** The tombstone claim prefix the contradiction resolver's supersede writes. */
export const SUPERSEDED_CLAIM_PREFIX = "Superseded by ";

/** Longest stretch, in ms, the cluster scan runs before yielding to the event loop. */
export const CLUSTER_SCAN_SLICE_MS = 20;

/** A set of near-duplicate docs in one project to merge through a review draft. */
export interface MergeCluster {
  projectId: string;
  slugs: readonly string[];
}

export interface ClusterScanOptions {
  /** Wall-clock deadline (in `now` ms): the scan stops once past it. */
  deadline?: number;
  /** Clock for the deadline and the yield slices. Default Date.now. */
  now?: () => number;
}

export interface ClusterScan {
  /** Clusters of the groups scanned to the end; a group cut off by the deadline contributes none. */
  clusters: MergeCluster[];
  /** Whether every group was scanned before the deadline. */
  complete: boolean;
  /** Candidate pairs whose token sets were compared. */
  comparisons: number;
}

export interface MirrorCollapseDeps extends ClusterScanOptions {
  db: Database;
  /** Reserved mirror project → canonical project. Default MIRROR_PROJECTS. */
  mirrors?: Readonly<Record<string, string>>;
  /**
   * The knowledge dir: with it, a retired copy's file confidence is spliced
   * and merge drafts are written. Without it the run is DB-only and no draft
   * is filed.
   */
  knowledgeDir?: string;
  /** Count the file patches and drafts a run with `knowledgeDir` would write, writing none. */
  dryRun?: boolean;
  /**
   * The clusters to merge. Default: detected (detectNearDuplicateClusters).
   * Named clusters are held to the same rules: ineligible members and members
   * of another layer, scope or owner than the kept doc are dropped.
   */
  clusters?: readonly MergeCluster[];
}

export interface MirrorCollapseCounts {
  /** Mirror copies superseded by this run. */
  superseded: number;
  /** Mirror copies an earlier run (or the resolver) already superseded. */
  alreadySuperseded: number;
  /** Mirror docs kept: no canonical counterpart, or one that differs. */
  kept: number;
  /** Retired copies whose file confidence was spliced. */
  filesPatched: number;
  /** Merge drafts written. */
  mergeDrafts: number;
  /** Clusters skipped because their kept slug already has a pending draft. */
  mergeDraftsPending: number;
  /** Clusters skipped because fewer than two eligible live members remain. */
  clustersSettled: number;
  /** 1 when the cluster scan stopped at the deadline before scanning every group. */
  clusterScanIncomplete: number;
}

interface DocRow {
  id: string;
  project_id: string;
  slug: string;
  title: string;
  body: string;
  file_path: string | null;
  verdict: string | null;
  disputes_json: string | null;
  confidence: number | null;
  origin_class: string | null;
  source_kind: string | null;
  source_session_id: string | null;
  generated_from_sha: string | null;
  scope: string | null;
  owner_user: string | null;
  tags_json: string | null;
  generated_at: string | null;
  updated_at: string | null;
}

const DOC_COLUMNS = `id, project_id, slug, title, body, file_path, verdict, disputes_json, confidence, origin_class,
  source_kind, source_session_id, generated_from_sha, scope, owner_user, tags_json, generated_at, updated_at`;

/** Front-matter keys that mark a corpus file as owned by an ingest (project docs, native memory). */
const INGEST_MARKER_RE = /^(?:ingested_from|native_memory_from):/m;

const docText = (r: DocRow) => `${r.title}\n${r.body}`;
const scopeOf = (r: DocRow) => r.scope ?? DEFAULT_SCOPE;
const layerOfRow = (r: DocRow) =>
  layerOf({ scope: scopeOf(r), sourceKind: r.source_kind ?? undefined, slug: r.slug });

function parseJsonArray(json: string | null): unknown[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function projectRows(db: Database, projectId: string): DocRow[] {
  return db
    .query(`SELECT ${DOC_COLUMNS} FROM knowledge WHERE project_id = ? ORDER BY slug`)
    .all(projectId) as DocRow[];
}

/** The tombstoned disputes of a copy retired in favor of `canonical`. */
function tombstoneDisputes(copy: DocRow, canonical: DocRow): string {
  const carried =
    copy.verdict === "disputed" || copy.verdict === "contradicted" ? parseJsonArray(copy.disputes_json) : [];
  const ref = `${canonical.project_id}/${canonical.slug}`;
  return JSON.stringify([
    ...carried,
    {
      claim: `${SUPERSEDED_CLAIM_PREFIX}${ref}`,
      finding: `Copy of ${ref} in the mirror project ${copy.project_id}; retired in favor of the canonical doc.`,
      evidence: "knowledge-mirror-collapse — revive by editing the doc",
    },
  ]);
}

/**
 * Splices DISPUTED_CONFIDENCE into a doc file's front matter; false when there
 * is no file or nothing to change. A dry run reports the change without writing.
 */
async function patchConfidence(knowledgeDir: string, projectId: string, slug: string, dryRun: boolean): Promise<boolean> {
  const path = join(knowledgeDir, projectId, `${slug}.md`);
  if (!existsSync(path)) return false;
  const raw = await readFile(path, "utf-8");
  const next = spliceFrontmatter(raw, { confidence: DISPUTED_CONFIDENCE });
  if (next === raw) return false;
  if (!dryRun) await writeFile(path, next, "utf-8");
  return true;
}

/**
 * Whether the mirror copy duplicates the canonical doc of its slug: same scope
 * and owner, and either the same body (whitespace aside) or a high-confidence
 * duplicate that names no value the other lacks.
 */
function copies(copy: DocRow, canonical: DocRow): boolean {
  if (scopeOf(copy) !== scopeOf(canonical) || (copy.owner_user ?? null) !== (canonical.owner_user ?? null)) return false;
  const f = dupFeatures(copy, canonical, undefined);
  if (f.identical) return true;
  return isHighConfidenceDuplicate(f) && !f.valuesDiffer;
}

/**
 * Whether a doc may join a merge cluster at all: live, not personal (scope
 * user or a home native-memory mirror), not an activity note, not a
 * native-memory mirror.
 */
function clusterable(r: DocRow): boolean {
  if (r.verdict === "superseded") return false;
  if (scopeOf(r) === "user" || r.source_kind === "native-memory") return false;
  const layer = layerOfRow(r);
  return layer !== "personal" && layer !== "activity";
}

/** Docs cluster only with docs of the same layer, scope and owner. */
const clusterKey = (r: DocRow) => `${layerOfRow(r)}\u0000${scopeOf(r)}\u0000${r.owner_user ?? ""}`;

/** Whether the doc's corpus file carries an ingest marker in its front matter. */
function ingestOwned(r: DocRow): boolean {
  if (!r.file_path || !existsSync(r.file_path)) return false;
  try {
    const raw = readFileSync(r.file_path, "utf-8");
    const fence = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
    return fence !== null && INGEST_MARKER_RE.test(fence[1]!);
  } catch {
    return false;
  }
}

/**
 * The least overlap two token sets isLexicalNearDup accepts can share, as a
 * fraction of the smaller set's size and of the larger's. Jaccard J needs
 * |a∩b| ≥ J/(1+J)·(|a|+|b|), which is at least 2J/(1+J)·min and J/(1+J)·max;
 * containment C over sets whose size ratio is at least R needs
 * |a∩b| ≥ C·min ≥ C·R·max. Shaved by an epsilon so float rounding at a
 * threshold never drops a pair.
 */
const JACCARD_OVERLAP = NEAR_DUP_LEXICAL_THRESHOLD / (1 + NEAR_DUP_LEXICAL_THRESHOLD);
const MIN_OVERLAP_OF_SMALLER = Math.min(2 * JACCARD_OVERLAP, NEAR_DUP_CONTAINMENT_THRESHOLD) - 1e-9;
const MIN_OVERLAP_OF_LARGER =
  Math.min(JACCARD_OVERLAP, NEAR_DUP_CONTAINMENT_THRESHOLD * NEAR_DUP_SIZE_RATIO_FLOOR) - 1e-9;

/**
 * The prefix (rarest tokens first) of a set that must hold a token of any
 * accepted partner, when every accepted pair overlaps by at least
 * `fraction`·|set|: the first shared token sits within it.
 */
const prefixLength = (size: number, fraction: number) => Math.max(1, size - Math.ceil(fraction * size) + 1);
/** The smallest size ratio at which either arm of isLexicalNearDup can fire (Jaccard ≤ the size ratio). */
const MIN_SIZE_RATIO = Math.min(NEAR_DUP_SIZE_RATIO_FLOOR, NEAR_DUP_LEXICAL_THRESHOLD);

/** isLexicalNearDup over two precomputed token sets (see lexicalOverlap). */
function tokenSetsNearDup(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const t of small) if (large.has(t)) inter++;
  const jaccard = inter / (a.size + b.size - inter);
  const containment = small.size / large.size >= NEAR_DUP_SIZE_RATIO_FLOOR ? inter / small.size : 0;
  return jaccard >= NEAR_DUP_LEXICAL_THRESHOLD || containment >= NEAR_DUP_CONTAINMENT_THRESHOLD;
}

/** Stops the scan at the deadline and yields to the event loop every CLUSTER_SCAN_SLICE_MS. */
class ScanClock {
  private sliceStart: number;
  constructor(
    private readonly now: () => number,
    private readonly deadline: number
  ) {
    this.sliceStart = now();
  }
  expired(): boolean {
    return this.now() > this.deadline;
  }
  async maybeYield(): Promise<void> {
    if (this.now() - this.sliceStart < CLUSTER_SCAN_SLICE_MS) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
    this.sliceStart = this.now();
  }
}

/**
 * Connected components of isLexicalNearDup among one group's docs, or null when
 * the deadline cut the scan off. Each doc is tokenized once; candidate pairs
 * come from a prefix filter and a size band (MIN_SIZE_RATIO), so only
 * plausible pairs are compared. Docs are visited smallest first with tokens
 * ordered rarest first: each is indexed under its prefix as the smaller of a
 * pair (MIN_OVERLAP_OF_SMALLER) and probes the index with its prefix as the
 * larger (MIN_OVERLAP_OF_LARGER).
 */
async function scanGroup(
  rows: readonly DocRow[],
  clock: ScanClock,
  stats: { comparisons: number }
): Promise<string[][] | null> {
  const sets = rows.map((r) => lexicalTokens(docText(r)));
  const df = new Map<string, number>();
  for (const s of sets) for (const t of s) df.set(t, (df.get(t) ?? 0) + 1);
  const rarestFirst = (x: string, y: string) => df.get(x)! - df.get(y)! || (x < y ? -1 : x > y ? 1 : 0);
  // Ascending size, so every earlier doc is no larger than the current one.
  const order = rows.map((_, i) => i).filter((i) => sets[i]!.size > 0);
  order.sort((x, y) => sets[x]!.size - sets[y]!.size);

  const parent = rows.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const ingest = new Map<number, boolean>();
  const isIngest = (i: number) => {
    let v = ingest.get(i);
    if (v === undefined) ingest.set(i, (v = ingestOwned(rows[i]!)));
    return v;
  };
  const index = new Map<string, number[]>();
  for (const i of order) {
    if (clock.expired()) return null;
    await clock.maybeYield();
    const set = sets[i]!;
    const tokens = [...set].sort(rarestFirst);
    const seen = new Set<number>();
    for (const t of tokens.slice(0, prefixLength(tokens.length, MIN_OVERLAP_OF_LARGER))) {
      for (const j of index.get(t) ?? []) {
        if (seen.has(j)) continue;
        seen.add(j);
        if (sets[j]!.size / set.size < MIN_SIZE_RATIO) continue;
        if (find(i) === find(j)) continue;
        stats.comparisons++;
        if (!tokenSetsNearDup(set, sets[j]!)) continue;
        if (isIngest(i) || isIngest(j)) continue;
        parent[find(i)] = find(j);
      }
    }
    for (const t of tokens.slice(0, prefixLength(tokens.length, MIN_OVERLAP_OF_SMALLER))) {
      const posting = index.get(t);
      if (posting) posting.push(i);
      else index.set(t, [i]);
    }
  }
  const groups = new Map<number, string[]>();
  rows.forEach((r, i) => {
    const root = find(i);
    const slugs = groups.get(root);
    if (slugs) slugs.push(r.slug);
    else groups.set(root, [r.slug]);
  });
  return [...groups.values()].filter((slugs) => slugs.length > 1);
}

/**
 * Near-duplicate clusters among each non-mirror project's clusterable docs,
 * grouped by layer, scope and owner: connected components of isLexicalNearDup,
 * with ingest-owned docs left out. Stops at `deadline`, keeping the clusters of
 * the groups it finished.
 */
export async function detectNearDuplicateClusters(
  db: Database,
  mirrors: Readonly<Record<string, string>> = MIRROR_PROJECTS,
  opts: ClusterScanOptions = {}
): Promise<ClusterScan> {
  const clock = new ScanClock(opts.now ?? Date.now, opts.deadline ?? Number.POSITIVE_INFINITY);
  const stats = { comparisons: 0 };
  const projects = (db.query("SELECT DISTINCT project_id FROM knowledge ORDER BY project_id").all() as Array<{
    project_id: string;
  }>)
    .map((r) => r.project_id)
    .filter((p) => mirrors[p] === undefined);
  const clusters: MergeCluster[] = [];
  for (const projectId of projects) {
    const groups = new Map<string, DocRow[]>();
    for (const r of projectRows(db, projectId)) {
      if (!clusterable(r)) continue;
      const key = clusterKey(r);
      const group = groups.get(key);
      if (group) group.push(r);
      else groups.set(key, [r]);
    }
    for (const rows of groups.values()) {
      if (rows.length < 2) continue;
      const found = await scanGroup(rows, clock, stats);
      if (found === null) return { clusters, complete: false, comparisons: stats.comparisons };
      for (const slugs of found) clusters.push({ projectId, slugs });
    }
  }
  return { clusters, complete: true, comparisons: stats.comparisons };
}

/** Kept member first: owner-written, then the longest body, then the older, then the shorter slug. */
function keptOrder(a: DocRow, b: DocRow): number {
  const owner = (r: DocRow) => (r.origin_class === "owner" ? 0 : 1);
  const age = (r: DocRow) => {
    const at = Date.parse(r.generated_at ?? r.updated_at ?? "");
    return Number.isFinite(at) ? at : Number.POSITIVE_INFINITY;
  };
  return (
    owner(a) - owner(b) ||
    b.body.length - a.body.length ||
    age(a) - age(b) ||
    a.slug.length - b.slug.length ||
    a.slug.localeCompare(b.slug)
  );
}

/**
 * The review draft that merges a cluster into its kept member: it replaces the
 * kept slug, carries the kept doc's provenance, and names the absorbed slugs,
 * which accepting the draft leaves published.
 */
function mergeDraft(kept: DocRow, others: readonly DocRow[]): KnowledgeDraftInput {
  const sections = others.map((o) => `## Merged from \`${o.slug}\`\n\n${o.body.trim()}`);
  const absorbed = others.map((o) => `\`${o.slug}\``).join(", ");
  const note = `> Merge draft: replaces \`${kept.slug}\` and absorbs ${absorbed}. Accepting it leaves the absorbed docs published; retire each by hand once the merge is accepted.`;
  const tags = parseJsonArray(kept.tags_json).filter((t): t is string => typeof t === "string");
  return {
    slug: kept.slug,
    title: kept.title,
    body: [note, kept.body.trim(), ...sections].join("\n\n"),
    related: others.map((o) => o.slug),
    replacesSlug: kept.slug,
    ...(tags.length > 0 ? { tags } : {}),
    ...(kept.generated_from_sha ? { generatedFromSha: kept.generated_from_sha } : {}),
    ...(kept.generated_at ? { generatedAt: kept.generated_at } : {}),
    ...(kept.source_session_id ? { sourceSessionId: kept.source_session_id } : {}),
    ...(kept.origin_class ? { originClass: kept.origin_class as OriginClass } : {}),
    ...(kept.source_kind ? { sourceKind: kept.source_kind as SourceKind } : {}),
    ...(kept.scope ? { scope: kept.scope as Scope } : {}),
    ...(kept.owner_user ? { ownerUser: kept.owner_user } : {}),
  };
}

/**
 * Retires mirror copies of canonical docs and files merge drafts for
 * near-duplicate clusters (see the module comment). Returns what it did.
 */
export async function collapseMirrorDuplicates(deps: MirrorCollapseDeps): Promise<MirrorCollapseCounts> {
  const { db, knowledgeDir } = deps;
  const dryRun = deps.dryRun ?? false;
  const mirrors = deps.mirrors ?? MIRROR_PROJECTS;
  const counts: MirrorCollapseCounts = {
    superseded: 0,
    alreadySuperseded: 0,
    kept: 0,
    filesPatched: 0,
    mergeDrafts: 0,
    mergeDraftsPending: 0,
    clustersSettled: 0,
    clusterScanIncomplete: 0,
  };

  const retire = db.query("UPDATE knowledge SET verdict = 'superseded', disputes_json = ?, confidence = ? WHERE id = ?");
  const retired: DocRow[] = [];
  for (const [mirror, canonicalProject] of Object.entries(mirrors)) {
    const canonical = new Map(projectRows(db, canonicalProject).map((r) => [r.slug, r] as const));
    const edits: Array<{ copy: DocRow; disputes: string }> = [];
    for (const copy of projectRows(db, mirror)) {
      if (copy.verdict === "superseded") {
        counts.alreadySuperseded++;
        retired.push(copy);
        continue;
      }
      const original = canonical.get(copy.slug);
      if (!original || original.verdict === "superseded" || !copies(copy, original)) {
        counts.kept++;
        continue;
      }
      edits.push({ copy, disputes: tombstoneDisputes(copy, original) });
    }
    db.transaction(() => {
      for (const e of edits) retire.run(e.disputes, DISPUTED_CONFIDENCE, e.copy.id);
    })();
    counts.superseded += edits.length;
    retired.push(...edits.map((e) => e.copy));
  }
  if (knowledgeDir) {
    for (const r of retired) {
      if (await patchConfidence(knowledgeDir, r.project_id, r.slug, dryRun)) counts.filesPatched++;
    }
  }

  let clusters = deps.clusters;
  if (!clusters) {
    const scan = await detectNearDuplicateClusters(db, mirrors, { deadline: deps.deadline, now: deps.now });
    clusters = scan.clusters;
    if (!scan.complete) counts.clusterScanIncomplete = 1;
  }
  for (const cluster of clusters) {
    const bySlug = new Map(projectRows(db, cluster.projectId).map((r) => [r.slug, r] as const));
    const eligible = [...new Set(cluster.slugs)]
      .map((slug) => bySlug.get(slug))
      .filter((r): r is DocRow => r !== undefined && clusterable(r) && !ingestOwned(r))
      .sort(keptOrder);
    const key = eligible[0] ? clusterKey(eligible[0]) : "";
    const members = eligible.filter((r) => clusterKey(r) === key);
    if (members.length < 2) {
      counts.clustersSettled++;
      continue;
    }
    if (!knowledgeDir) continue;
    const [kept, ...others] = members as [DocRow, ...DocRow[]];
    if (draftFileExists(knowledgeDir, cluster.projectId, kept.slug)) {
      counts.mergeDraftsPending++;
      continue;
    }
    if (!dryRun) await writeDraftFile(knowledgeDir, cluster.projectId, mergeDraft(kept, others));
    counts.mergeDrafts++;
  }
  return counts;
}
