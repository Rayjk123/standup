import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { createStore, type Store } from "@standup/store";
import { chunkMarkdown, embedChunks, type EmbeddingProvider } from "../embeddings.js";
import { formatContradictsClaim } from "../graph.js";
import { KnowledgeLoader } from "../loader.js";
import { KnowledgeStore } from "../store.js";
import { DEFAULT_SOURCE_KIND } from "../types.js";

/**
 * Boots the knowledge eval's synthetic fixture corpus into a temp SQLite store
 * using only knowledge/store APIs, the way the collector's fixture tier
 * (collector `kbeval/env.ts` buildFixtureEnv) does, minus every part that
 * needs collector modules:
 *
 *  - Indexing mirrors KnowledgeSync.syncProject (collector `knowledge-sync.ts`):
 *    KnowledgeLoader.loadProject → KnowledgeStore.upsertDoc for a doc whose file
 *    is newer than the stored row → chunkMarkdown + embedChunks + upsertChunk,
 *    tail chunks truncated; a stored doc whose file is gone is deleted; an
 *    unchanged doc only has its file-authoritative columns reconciled. Not
 *    mirrored: the embedding fingerprint/canary check, background backfill and
 *    relevance calibration (the fixture tier runs none of them either).
 *  - Edit replay, fixed mtimes, the `native_memory_from` shorthand rewrite,
 *    `verdict:` front matter and deterministic ids follow env.ts exactly.
 *  - Not reproduced: projects are not registered (search reads none of the
 *    projects table; related projects are computed from `projects.json` by the
 *    caller), repos are not built as pinned git repos, and the re-verification
 *    evidence pass does not run — so no doc carries an evidence cap or a
 *    re-anchored date, and the freshness mirror sees decay only.
 *
 * The import graph stays inside the store, loader, embeddings, graph and
 * search modules: no collector module, and not the package index, backend or
 * writer.
 */

/** Fixed file mtimes: version n of every doc lands at BASE + n minutes (as env.ts). */
const BASE_MTIME_MS = Date.UTC(2026, 0, 1, 0, 0, 0);
const STEP_MS = 60_000;
const SCRATCH_PROJECT_ID = "scratch";

export interface ProjectSpec {
  id: string;
  name?: string;
  repo: string | null;
  reserved?: boolean;
  related?: string[];
  /** For a reserved mirror project: the canonical project it copies (MIRROR_PROJECTS). */
  mirrorOf?: string;
}

export interface FixtureOptions {
  corpusDir: string;
  fixtureRepoDir: string;
  /** Parent directory the temp store and corpus copy are created under. */
  workDir: string;
  embeddingProvider: EmbeddingProvider | null;
}

export interface FixtureEnv {
  store: Store;
  db: Database;
  knowledgeDir: string;
  projects: ProjectSpec[];
  load: { docs: number; editedDocs: number; versions: number; syncs: number; verdicts: number };
  close(): void;
}

function listDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .sort();
}

function listMarkdown(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md") && statSync(join(dir, name)).isFile())
    .sort();
}

/** The YAML front matter of a markdown file, or {} when it has none. */
export function frontMatter(raw: string): Record<string, unknown> {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const parsed = Bun.YAML.parse(m[1]);
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

/** The directory name Claude Code keeps a project's auto-memory under (collector `native-memory-ingest.ts`). */
function encodeClaudeProjectDir(absPath: string): string {
  return absPath.replace(/[^A-Za-z0-9]/g, "-");
}

/** The absolute source path the native-memory ingest stamps for a tier shorthand (env.ts nativeMemorySourcePath). */
export function nativeMemorySourcePath(
  tier: string,
  slug: string,
  ownerUser: string | undefined,
  repo: string | undefined,
  projectId: string
): string | null {
  const home = `/home/${ownerUser ?? "owner"}`;
  const repoPath = repo ?? `/repos/${projectId}`;
  const rest = slug.replace(/^native-mem-/, "");
  if (tier === "home") {
    if (rest === "home-claude-md") return `${home}/.claude/CLAUDE.md`;
    if (rest.startsWith("home-rule-")) return `${home}/.claude/rules/${rest.slice("home-rule-".length)}.md`;
    return `${home}/.claude/${rest}.md`;
  }
  if (tier === "project") {
    if (rest.startsWith("project-rule-")) return `${repoPath}/.claude/rules/${rest.slice("project-rule-".length)}.md`;
    return `${repoPath}/.claude/CLAUDE.md`;
  }
  if (tier === "auto-memory") {
    const name = rest.replace(/^memory-/, "");
    return `${home}/.claude/projects/${encodeClaudeProjectDir(repoPath)}/memory/${name}.md`;
  }
  return null;
}

function corpusFileContent(source: string, projectId: string, slug: string, repo: string | undefined): string {
  const raw = readFileSync(source, "utf-8");
  const fm = frontMatter(raw) as { native_memory_from?: unknown; owner_user?: string };
  if (typeof fm.native_memory_from !== "string" || fm.native_memory_from.startsWith("/")) return raw;
  const path = nativeMemorySourcePath(fm.native_memory_from, slug, fm.owner_user, repo, projectId);
  if (!path) return raw;
  return raw.replace(/^native_memory_from:.*$/m, `native_memory_from: ${JSON.stringify(path)}`);
}

/** A UUID-shaped id derived from `seed` (env.ts deterministicId). */
export function deterministicId(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Rewrites loader-minted ids to ids derived from project/slug, references carried along (env.ts stabilizeIds). */
export function stabilizeIds(db: Database): void {
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    const docs = db.query("SELECT id, project_id, slug FROM knowledge").all() as Array<{
      id: string;
      project_id: string;
      slug: string;
    }>;
    const docIds = new Set(docs.map((d) => d.id));
    const orphans = db.query("SELECT rowid AS rid, id FROM knowledge_fts ORDER BY rowid").all() as Array<{
      rid: number;
      id: string;
    }>;
    for (const o of orphans) {
      if (docIds.has(o.id)) continue;
      db.run("UPDATE knowledge_fts SET id = ? WHERE rowid = ?", [deterministicId(`fts-orphan:${o.rid}`), o.rid]);
    }
    for (const d of docs) {
      const next = deterministicId(`doc:${d.project_id}/${d.slug}`);
      if (next === d.id) continue;
      db.run("UPDATE knowledge SET id = ? WHERE id = ?", [next, d.id]);
      db.run("UPDATE knowledge_fts SET id = ? WHERE id = ?", [next, d.id]);
      db.run("UPDATE knowledge_chunks SET knowledge_id = ? WHERE knowledge_id = ?", [next, d.id]);
      db.run("UPDATE knowledge_edges SET src_doc_id = ? WHERE src_doc_id = ?", [next, d.id]);
      db.run("UPDATE knowledge_edges SET dst_doc_id = ? WHERE dst_doc_id = ?", [next, d.id]);
    }
    const chunks = db
      .query("SELECT rowid AS rid, knowledge_id, chunk_index FROM knowledge_chunks ORDER BY rowid")
      .all() as Array<{ rid: number; knowledge_id: string; chunk_index: number }>;
    for (const c of chunks) {
      db.run("UPDATE knowledge_chunks SET id = ? WHERE rowid = ?", [
        deterministicId(`chunk:${c.knowledge_id}#${c.chunk_index}`),
        c.rid,
      ]);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

/** The fields KnowledgeSync fingerprints a doc file by, to tell a same-mtime rewrite apart. */
function fileContentHash(doc: {
  title: string;
  body: string;
  tags?: string[];
  confidence?: number;
  lastVerifiedAt?: string;
  halfLifeDays?: number;
  generatedFromSha?: string;
  generatedAt?: string;
  sourceSessionId?: string;
}): string {
  return Bun.hash(
    JSON.stringify([
      doc.title,
      doc.body,
      doc.tags ?? [],
      doc.confidence ?? null,
      doc.lastVerifiedAt ?? null,
      doc.halfLifeDays ?? null,
      doc.generatedFromSha ?? null,
      doc.generatedAt ?? null,
      doc.sourceSessionId ?? null,
    ])
  ).toString(16);
}

/** The minimal KnowledgeSync.syncProject mirror described in the module header. */
class FixtureIndexer {
  private store: KnowledgeStore;
  private loader: KnowledgeLoader;
  private syncedContent = new Map<string, string>();

  constructor(
    db: Database,
    knowledgeDir: string,
    private provider: EmbeddingProvider | null
  ) {
    this.store = new KnowledgeStore(db);
    this.loader = new KnowledgeLoader(knowledgeDir);
  }

  async syncProject(projectId: string): Promise<void> {
    const docs = await this.loader.loadProject(projectId);
    const seen = new Set<string>();
    for (const doc of docs) {
      seen.add(doc.slug);
      const existing = this.store.getDoc(projectId, doc.slug);
      const key = `${projectId}/${doc.slug}`;
      const content = fileContentHash(doc);
      const rewrittenInPlace = this.syncedContent.has(key) && this.syncedContent.get(key) !== content;
      this.syncedContent.set(key, content);
      if (existing && existing.updatedAt.getTime() >= doc.updatedAt.getTime() && !rewrittenInPlace) {
        if (
          existing.originClass !== doc.originClass ||
          existing.sourceKind !== doc.sourceKind ||
          existing.scope !== doc.scope ||
          (existing.ownerUser ?? undefined) !== (doc.ownerUser ?? undefined)
        ) {
          this.store.reconcileFileColumns(
            projectId,
            doc.slug,
            doc.originClass ?? "untrusted",
            doc.sourceKind ?? DEFAULT_SOURCE_KIND,
            doc.scope ?? "project",
            doc.ownerUser
          );
        }
        continue;
      }
      const storedId = this.store.upsertDoc(doc);
      if (!this.provider) continue;
      await this.embedDoc(storedId, doc.title, doc.body);
    }
    for (const stored of this.store.getDocsByProject(projectId)) {
      if (!seen.has(stored.slug)) {
        this.store.deleteDoc(projectId, stored.slug);
        this.syncedContent.delete(`${projectId}/${stored.slug}`);
      }
    }
  }

  private async embedDoc(knowledgeId: string, title: string, body: string): Promise<void> {
    const chunks = chunkMarkdown(title, body);
    const embeddings = await embedChunks(
      chunks.map((chunk) => chunk.embedText),
      this.provider!,
      {}
    );
    const failed: number[] = [];
    chunks.forEach((chunk, index) => {
      const embedding = embeddings[index];
      if (!embedding) {
        failed.push(index);
        return;
      }
      this.store.upsertChunk({ id: randomUUID(), knowledgeId, chunkIndex: index, text: chunk.text, embedding });
    });
    this.store.deleteChunks(knowledgeId, failed);
    this.store.truncateChunks(knowledgeId, chunks.length);
  }

  /** Records a `verdict:` the way KnowledgeSync.recordDocVerdict does (a DB-only field). */
  recordDocVerdict(projectId: string, slug: string, verdict: string, disputes: unknown[]): void {
    this.store.setDocVerdict(projectId, slug, verdict, disputes);
  }

  ensureVecIndex(): void {
    this.store.ensureVecIndex();
  }
}

interface VerdictSpec {
  projectId: string;
  slug: string;
  verdict: string;
  tags: string[];
  contradicts?: string[];
}

/** The dispute the coherence layer records for a contradiction (collector `knowledge-coherence.ts` contradictionDispute). */
function contradictionDispute(otherSlug: string): { claim: string; finding: string; evidence: string } {
  return {
    claim: formatContradictsClaim(otherSlug),
    finding: "An accepted doc states an opposing claim; a human must resolve which is correct.",
    evidence: `Contradiction with ${otherSlug} — resolve by editing or discarding one of the two docs`,
  };
}

/** env.ts applyVerdicts: a contradicted doc names its counterparts (explicit, or the contradicted peers sharing most tags). */
function applyVerdicts(indexer: FixtureIndexer, specs: VerdictSpec[]): number {
  for (const spec of specs) {
    let others: string[] = [];
    if (spec.verdict === "contradicted") {
      if (spec.contradicts && spec.contradicts.length > 0) {
        others = spec.contradicts;
      } else {
        const peers = specs.filter(
          (o) => o.verdict === "contradicted" && o.projectId === spec.projectId && o.slug !== spec.slug
        );
        const overlap = (o: VerdictSpec) => o.tags.filter((t) => spec.tags.includes(t)).length;
        const best = Math.max(0, ...peers.map(overlap));
        others = best > 0 ? peers.filter((o) => overlap(o) === best).map((o) => o.slug).sort() : [];
      }
    }
    indexer.recordDocVerdict(spec.projectId, spec.slug, spec.verdict, others.map((slug) => contradictionDispute(slug)));
  }
  return specs.length;
}

function setMtime(path: string, ms: number): void {
  const t = new Date(ms);
  utimesSync(path, t, t);
}

export async function buildRetrievalFixture(opts: FixtureOptions): Promise<FixtureEnv> {
  mkdirSync(opts.workDir, { recursive: true });
  const root = mkdtempSync(join(opts.workDir, "fixture-"));
  const knowledgeDir = join(root, "knowledge");
  mkdirSync(knowledgeDir, { recursive: true });

  const projectsPath = join(opts.corpusDir, "projects.json");
  const projects: ProjectSpec[] = existsSync(projectsPath)
    ? (JSON.parse(readFileSync(projectsPath, "utf-8")) as ProjectSpec[])
    : [];
  const repoById = new Map<string, string>();
  for (const p of projects) {
    if (!p.repo) continue;
    repoById.set(p.id, p.repo === "fixture-repo" ? resolve(opts.fixtureRepoDir) : resolve(opts.corpusDir, "..", p.repo));
  }

  const store = createStore(join(root, "standup.db"));

  const editsRoot = join(opts.corpusDir, "_edits");
  const versions = new Map<string, Map<number, string>>();
  for (const project of listDirs(editsRoot)) {
    for (const file of listMarkdown(join(editsRoot, project))) {
      const m = file.match(/^(.+)\.(\d+)\.md$/);
      if (!m) continue;
      const key = `${project}/${m[1]}`;
      const byN = versions.get(key) ?? new Map<number, string>();
      byN.set(Number(m[2]), join(editsRoot, project, file));
      versions.set(key, byN);
    }
  }
  const finals = new Map<string, string>();
  for (const project of listDirs(opts.corpusDir)) {
    if (project.startsWith("_") || project.startsWith(".")) continue;
    for (const file of listMarkdown(join(opts.corpusDir, project))) {
      finals.set(`${project}/${file.slice(0, -3)}`, join(opts.corpusDir, project, file));
    }
  }
  const target = (key: string) => join(knowledgeDir, `${key}.md`);
  const place = (key: string, source: string, ms: number) => {
    const dest = target(key);
    const [projectId, slug] = key.split("/");
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(dest, corpusFileContent(source, projectId, slug, repoById.get(projectId)));
    setMtime(dest, ms);
  };
  for (const key of [...finals.keys()].sort()) {
    const history = versions.get(key);
    const first = history ? Math.min(...history.keys()) : undefined;
    place(key, first !== undefined ? history!.get(first)! : finals.get(key)!, BASE_MTIME_MS);
  }

  const indexer = new FixtureIndexer(store.db, knowledgeDir, opts.embeddingProvider);
  const known = [...new Set([...projects.map((p) => p.id), SCRATCH_PROJECT_ID])];
  for (const id of known) await indexer.syncProject(id);

  let syncs = 0;
  let versionCount = 0;
  const allNs = new Set<number>();
  for (const byN of versions.values()) for (const n of byN.keys()) allNs.add(n);
  const ordered = [...allNs].sort((a, b) => a - b);
  for (const n of ordered) {
    const touched = new Set<string>();
    for (const [key, byN] of [...versions.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (!byN.has(n) || n === Math.min(...byN.keys())) continue;
      place(key, byN.get(n)!, BASE_MTIME_MS + n * STEP_MS);
      touched.add(key.split("/")[0]);
      versionCount++;
    }
    for (const project of [...touched].sort()) {
      await indexer.syncProject(project);
      syncs++;
    }
  }
  const finalMs = BASE_MTIME_MS + ((ordered.at(-1) ?? 0) + 1) * STEP_MS;
  const touchedFinal = new Set<string>();
  for (const key of [...versions.keys()].sort()) {
    if (!finals.has(key)) continue;
    place(key, finals.get(key)!, finalMs);
    touchedFinal.add(key.split("/")[0]);
    versionCount++;
  }
  for (const project of [...touchedFinal].sort()) {
    await indexer.syncProject(project);
    syncs++;
  }

  const verdictSpecs: VerdictSpec[] = [];
  for (const key of [...finals.keys()].sort()) {
    const fm = frontMatter(readFileSync(finals.get(key)!, "utf-8")) as {
      verdict?: unknown;
      tags?: unknown;
      contradicts?: unknown;
    };
    if (typeof fm.verdict !== "string" || !fm.verdict) continue;
    const [projectId, slug] = key.split("/");
    verdictSpecs.push({
      projectId,
      slug,
      verdict: fm.verdict,
      tags: Array.isArray(fm.tags) ? fm.tags.map(String) : [],
      contradicts: Array.isArray(fm.contradicts) ? fm.contradicts.map(String) : undefined,
    });
  }
  const verdicts = applyVerdicts(indexer, verdictSpecs);

  stabilizeIds(store.db);
  indexer.ensureVecIndex();

  const docs = (store.db.query("SELECT COUNT(*) AS n FROM knowledge").get() as { n: number }).n;
  return {
    store,
    db: store.db,
    knowledgeDir,
    projects,
    load: { docs, editedDocs: versions.size, versions: versionCount, syncs, verdicts },
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
