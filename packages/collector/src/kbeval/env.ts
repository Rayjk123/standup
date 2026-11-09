import type { Database } from "bun:sqlite";
import { createHash } from "crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { homedir, tmpdir } from "os";
import { delimiter, join, relative, resolve, sep } from "path";
import { stringify as stringifyToml } from "smol-toml";
import type { EmbeddingProvider } from "@standup/knowledge";
import { createStore, getProjects, type Store } from "@standup/store";
import { searchableTempDir } from "../code-search.js";
import { contradictionDispute } from "../knowledge-coherence.js";
import { KnowledgeSync } from "../knowledge-sync.js";
import { evidencePassDeps, runEvidencePass } from "../knowledge-reverify.js";
import { reverifyOperationalResolver } from "../knowledge-staleness.js";
import { encodeClaudeProjectDir } from "../native-memory-ingest.js";
import { ProjectsRegistry } from "../projects-registry.js";
import { resolveIdentityConfigFromEnv } from "../identity.js";
import { createServer } from "../server.js";
import type { SurfaceContext } from "./surfaces.js";

/** The corpus synced as an extra project beside the registered ones, so its docs are indexed whether or not it is registered. */
const EXTRA_CORPUS_PROJECT_ID = "standup";

/** Fixed file mtimes for the replayed corpus: version n of every doc lands at BASE + n minutes. */
const BASE_MTIME_MS = Date.UTC(2026, 0, 1, 0, 0, 0);
const STEP_MS = 60_000;

export interface EvalEnv {
  store: Store;
  db: Database;
  ctx: SurfaceContext;
  knowledgeDir: string;
  /** Edit-replay bookkeeping (fixture tier). */
  replay: {
    editedDocs: number;
    versions: number;
    syncs: number;
    verdicts: number;
    /** The boot-time re-verification evidence pass (fixture tier): docs checked, the slugs it capped or re-anchored, and findings by kind. */
    evidence?: { checked: number; capped: string[]; anchored: string[]; findings: Record<string, number> };
  };
  close(): void;
}

interface ProjectSpec {
  id: string;
  name: string;
  repo: string | null;
  reserved?: boolean;
  related?: string[];
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

/** sha256 over every file under the given roots (relative path + content), in sorted order. */
export function hashTree(roots: string[]): string {
  const hash = createHash("sha256");
  const walk = (root: string, dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(root, full);
      else if (st.isFile()) {
        hash.update(relative(root, full).split(sep).join("/"));
        hash.update("\0");
        hash.update(readFileSync(full));
        hash.update("\0");
      }
    }
  };
  for (const root of roots) if (existsSync(root)) walk(root, root);
  return hash.digest("hex");
}

/** A UUID-shaped id derived from `seed`, so doc ids (and their rank tie-breaks) are stable across runs. */
export function deterministicId(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Rewrites the random ids the loader assigned to deterministic ones, carrying
 * every reference (FTS rows, chunks, edges) along, so search tie-breaks on id
 * are reproducible. FTS rows that already point at no doc keep pointing at no
 * doc — the relationship between rows is preserved exactly, only the opaque
 * id values change.
 */
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
    // Orphan FTS rows first, keyed on their stable rowid, so a fresh doc id can never collide with one.
    const orphans = db
      .query("SELECT rowid AS rid, id FROM knowledge_fts ORDER BY rowid")
      .all() as Array<{ rid: number; id: string }>;
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

/** The YAML front matter of a markdown file, or {} when it has none. */
export function frontMatter(raw: string): Record<string, unknown> {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const parsed = Bun.YAML.parse(m[1]);
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

/**
 * The absolute source path the native-memory ingest would have stamped as a
 * mirror's `native_memory_from` marker, for a corpus doc that names only its
 * tier (`home`, `project`, `auto-memory`). Mirrors the ingest's slug scheme:
 * native-mem-home-claude-md, native-mem-home-rule-<x>, native-mem-project-*,
 * native-mem-memory-<x>.
 */
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

/**
 * A corpus file as the production ingest would have written it: a
 * `native_memory_from: <tier>` shorthand is rewritten to the absolute source
 * path the native-memory ingest stamps. Everything else is byte-identical.
 */
function corpusFileContent(
  source: string,
  projectId: string,
  slug: string,
  repoFor: (projectId: string) => string | undefined
): string {
  const raw = readFileSync(source, "utf-8");
  const fm = frontMatter(raw) as { native_memory_from?: unknown; owner_user?: string };
  if (typeof fm.native_memory_from !== "string" || fm.native_memory_from.startsWith("/")) return raw;
  const path = nativeMemorySourcePath(fm.native_memory_from, slug, fm.owner_user, repoFor(projectId), projectId);
  if (!path) return raw;
  return raw.replace(/^native_memory_from:.*$/m, `native_memory_from: ${JSON.stringify(path)}`);
}

interface VerdictSpec {
  projectId: string;
  slug: string;
  verdict: string;
  tags: string[];
  contradicts?: string[];
}

/**
 * Applies `verdict:` front matter the way the verification layer records it
 * (KnowledgeSync.recordDocVerdict — the loader never reads a verdict, it lives
 * in the DB). A contradicted doc carries a contradiction dispute naming each
 * counterpart: its `contradicts:` slugs when given, else the other contradicted
 * docs in its project that share the most tags with it.
 */
function applyVerdicts(sync: KnowledgeSync, specs: VerdictSpec[]): number {
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
    sync.recordDocVerdict(
      spec.projectId,
      spec.slug,
      spec.verdict,
      others.map((slug) => contradictionDispute(slug, ""))
    );
  }
  return specs.length;
}

function setMtime(path: string, ms: number): void {
  const t = new Date(ms);
  utimesSync(path, t, t);
}

function makeContext(
  store: Store,
  app: SurfaceContext["app"],
  repoFor: (projectId: string) => string | undefined,
  emptyCwd: string,
  embeddingProvider: EmbeddingProvider | null
): SurfaceContext {
  return {
    app,
    db: store.db,
    identityHeader: resolveIdentityConfigFromEnv().userIdentifier.header,
    repoFor,
    emptyCwd,
    embeddingProvider,
    embeddingConfig: {},
  };
}

export interface FixtureEnvOptions {
  corpusDir: string;
  fixtureRepoDir: string;
  embeddingProvider: EmbeddingProvider | null;
}

/**
 * The host user the fixture tier runs as (STANDUP_HOST_USER, see runEval):
 * the owner the committed corpus and Persona cases are written for. The
 * collector believes a loopback identity header for the personal layer only
 * when it names the host (scopingUser), and unowned legacy home mirrors reach
 * only the host, so a host-dependent alias would make Persona's recall depend
 * on the runner's `$USER`.
 */
export const FIXTURE_HOST_USER = "owner";

/** The single commit date of every pinned eval repo: before every fixture doc's date, so each doc anchors to it. */
export const PINNED_REPO_DATE = "2026-08-01T00:00:00.000Z";

/** A pinned repo's history beyond its first commit (see buildPinnedRepo). */
export interface PinnedHistory {
  /** A file whose last lines land one per commit after the first, so the file has drift. */
  grow?: { path: string; dates: readonly string[] };
  /** A branch, never merged, that adds one file. */
  unmergedBranch?: { name: string; path: string; content: string; date: string };
}

/**
 * The fixture repo's pinned history. The first commit (PINNED_REPO_DATE)
 * holds the whole tree except the last lines of `src/knowledge/search.ts`,
 * which land one per commit through September — enough commits after the
 * docs that name the file for the drift check to see them. A `wikilinks`
 * branch adds `parseWikilinks` and is never merged, matching the corpus's
 * account that wikilink parsing exists only on an unmerged branch. The work
 * tree at HEAD is the fixture tree exactly.
 */
export const FIXTURE_REPO_HISTORY: PinnedHistory = {
  grow: {
    path: "src/knowledge/search.ts",
    dates: [
      "2026-09-05T00:00:00.000Z",
      "2026-09-10T00:00:00.000Z",
      "2026-09-15T00:00:00.000Z",
      "2026-09-20T00:00:00.000Z",
      "2026-09-25T00:00:00.000Z",
    ],
  },
  unmergedBranch: {
    name: "wikilinks",
    path: "src/knowledge/wikilinks.ts",
    content:
      "/** Extracts `[[slug]]` and `[[project/slug]]` references from a doc body. */\n" +
      "export function parseWikilinks(body: string): string[] {\n" +
      "  return [...body.matchAll(/\\[\\[([^\\]]+)\\]\\]/g)].map((m) => m[1]);\n" +
      "}\n",
    date: "2026-09-26T00:00:00.000Z",
  },
};

/**
 * Copies `source` to `dest` and makes it a git repo whose history is fixed —
 * author, committer and every date pinned — so every sha is the same on every
 * run and every machine, whatever checkout (or none) `source` sits in. The
 * first commit, dated PINNED_REPO_DATE, holds the tree; `history` optionally
 * adds the commits and branch described by PinnedHistory. HEAD is `main` with
 * the work tree equal to `source`.
 */
export function buildPinnedRepo(source: string, dest: string, history: PinnedHistory = {}): string {
  mkdirSync(dest, { recursive: true });
  cpSync(source, dest, { recursive: true });
  const base = {
    ...process.env,
    GIT_AUTHOR_NAME: "kbeval",
    GIT_AUTHOR_EMAIL: "kbeval@example.invalid",
    GIT_COMMITTER_NAME: "kbeval",
    GIT_COMMITTER_EMAIL: "kbeval@example.invalid",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const git = (args: string[], date = PINNED_REPO_DATE) => {
    const env = { ...base, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
    const r = Bun.spawnSync(["git", ...args], { cwd: dest, env, stdout: "ignore", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${args[0]} failed in pinned repo: ${r.stderr.toString()}`);
  };
  const commit = (message: string, date: string) => {
    git(["add", "-A"], date);
    git(["commit", "-q", "--no-gpg-sign", "--allow-empty", "-m", message], date);
  };

  const grown = history.grow && existsSync(join(dest, history.grow.path)) ? history.grow : null;
  const full = grown ? readFileSync(join(dest, grown.path), "utf-8").split("\n") : [];
  const held = grown ? Math.min(grown.dates.length, Math.max(0, full.length - 1)) : 0;
  if (grown) writeFileSync(join(dest, grown.path), full.slice(0, full.length - held).join("\n"));

  git(["init", "-q", "-b", "main"]);
  commit("fixture", PINNED_REPO_DATE);
  if (grown) {
    for (let i = 1; i <= held; i++) {
      writeFileSync(join(dest, grown.path), full.slice(0, full.length - held + i).join("\n"));
      commit(`extend ${grown.path} (${i}/${held})`, grown.dates[i - 1]);
    }
  }
  const branch = history.unmergedBranch;
  if (branch) {
    git(["checkout", "-q", "-b", branch.name], branch.date);
    mkdirSync(join(dest, branch.path, ".."), { recursive: true });
    writeFileSync(join(dest, branch.path), branch.content);
    commit(`add ${branch.path}`, branch.date);
    git(["checkout", "-q", "main"], branch.date);
  }
  return dest;
}
/**
 * Builds the fixture tier the way the collector boots: a fresh DB on the real
 * schema, projects seeded through the registry, the corpus loaded through
 * KnowledgeSync (reindexOnProviderChange → syncAll → vec index), and
 * each doc's edit history replayed through syncProject in order — the same
 * call the file watcher makes on a change.
 */
export async function buildFixtureEnv(opts: FixtureEnvOptions): Promise<EvalEnv> {
  // The fixture's pinned repos are code-search roots, so they go where code search searches.
  const root = mkdtempSync(join(searchableTempDir(), "standup-kbeval-"));
  const knowledgeDir = join(root, "knowledge");
  const emptyCwd = join(root, "empty-cwd");
  mkdirSync(knowledgeDir, { recursive: true });
  mkdirSync(emptyCwd, { recursive: true });
  process.env.KNOWLEDGE_DIR = knowledgeDir;
  // A case whose project has no repo asks from this empty directory, standing
  // in for a session's own cwd — which the collector's routes let code search
  // run in. The harness has no session, so the directory is allowed explicitly.
  process.env.STANDUP_CODE_SEARCH_ROOTS = emptyCwd;

  const projectsPath = join(opts.corpusDir, "projects.json");
  const specs: ProjectSpec[] = existsSync(projectsPath)
    ? (JSON.parse(readFileSync(projectsPath, "utf-8")) as ProjectSpec[])
    : [];
  const repoById = new Map<string, string>();
  for (const p of specs) {
    if (!p.repo) continue;
    repoById.set(p.id, p.repo === "fixture-repo" ? resolve(opts.fixtureRepoDir) : resolve(opts.corpusDir, "..", p.repo));
  }
  // Each repo a project is registered with is a pinned git repo built from the
  // source tree (buildPinnedRepo), so git answers come from the fixture alone,
  // never from the checkout the fixture sits in. The corpus keeps naming the
  // source path, as it always has.
  const registeredRepoById = new Map<string, string>();
  for (const [id, dir] of repoById) {
    const history = dir === resolve(opts.fixtureRepoDir) ? FIXTURE_REPO_HISTORY : {};
    registeredRepoById.set(id, existsSync(dir) ? buildPinnedRepo(dir, join(root, "repos", id), history) : dir);
  }
  const tomlPath = join(root, "projects.toml");
  writeFileSync(
    tomlPath,
    stringifyToml({
      project: specs.map((p) => ({
        id: p.id,
        name: p.name ?? p.id,
        repos: registeredRepoById.has(p.id) ? [registeredRepoById.get(p.id)!] : [],
        branch: "main",
        ...(p.reserved ? { reserved: true } : {}),
        ...(p.related ? { related: p.related } : {}),
      })),
    })
  );

  const store = createStore(join(root, "standup.db"));
  await new ProjectsRegistry(store.db, tomlPath).bootstrap();

  // Initial on-disk state: version 1 of every edited doc, the final file of every other doc.
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
  const repoOf = (projectId: string) => repoById.get(projectId);
  const place = (key: string, source: string, ms: number) => {
    const dest = target(key);
    const [projectId, slug] = key.split("/");
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(dest, corpusFileContent(source, projectId, slug, repoOf));
    setMtime(dest, ms);
  };
  for (const key of [...finals.keys()].sort()) {
    const history = versions.get(key);
    const first = history ? Math.min(...history.keys()) : undefined;
    place(key, first !== undefined ? history!.get(first)! : finals.get(key)!, BASE_MTIME_MS);
  }

  const provider = opts.embeddingProvider;
  const sync = new KnowledgeSync(store.db, knowledgeDir, provider, {}, [EXTRA_CORPUS_PROJECT_ID]);
  await sync.reindexOnProviderChange();
  await sync.syncAll();

  // Replay: every later version in order, then the final file, each synced as the watcher would.
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
      await sync.syncProject(project);
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
    await sync.syncProject(project);
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
  const verdicts = applyVerdicts(sync, verdictSpecs);

  // The re-verification cron's deterministic evidence pass, as the collector
  // runs it shortly after boot for every project re-verification can reach. It
  // writes no doc, only the findings table the freshness gate reads. The model
  // pass is not run.
  const evidence = { checked: 0, capped: [] as string[], anchored: [] as string[], findings: {} as Record<string, number> };
  const reachable = reverifyOperationalResolver(store.db);
  for (const project of getProjects(store.db)) {
    const repo = project.repos[0];
    if (!repo || !reachable(project.id)) continue;
    const pass = await runEvidencePass(
      { ...evidencePassDeps(store.db, knowledgeDir), now: () => new Date(PINNED_REPO_DATE) },
      project.id,
      sync.getDocs(project.id),
      repo
    );
    evidence.checked += pass.checked;
    evidence.capped.push(...pass.capped.map((c) => `${project.id}/${c.slug}`));
    evidence.anchored.push(...pass.anchored.map((slug) => `${project.id}/${slug}`));
    for (const found of Object.values(pass.findings)) {
      for (const e of found) evidence.findings[e.kind] = (evidence.findings[e.kind] ?? 0) + 1;
    }
  }

  stabilizeIds(store.db);
  sync.ensureVecIndex();

  const app = createServer(store, () => {}, provider, sync, undefined, knowledgeDir, join(root, "icons"), {});
  const registered = new Map(getProjects(store.db).map((p) => [p.id, p.repos[0]]));
  const ctx = makeContext(store, app, (id) => registered.get(id) ?? undefined, emptyCwd, provider);

  return {
    store,
    db: store.db,
    ctx,
    knowledgeDir,
    replay: { editedDocs: versions.size, versions: versionCount, syncs, verdicts, evidence },
    close() {
      sync.stopWatching();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** The collector's live data dir and DB, which the snapshot tier must never open. */
function livePaths(): { dataDir: string; db: string } {
  const dataDir = join(homedir(), ".local", "share", "standup");
  return { dataDir, db: process.env.DB_PATH ?? join(dataDir, "standup.db") };
}

function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Refuses the live DB (or its -wal/-shm sidecars) and any file under the
 * collector's live data dir — except under its `worktrees/` subtree, which
 * holds checkouts (this repo's own eval inputs included), not live state.
 * Symlinked homes are resolved before comparing.
 */
export function assertSafeDbCopy(path: string): string {
  const target = realOrResolved(path);
  const { dataDir, db } = livePaths();
  const candidates = [target, resolve(path)];
  const liveDbs = [resolve(db), realOrResolved(db)].flatMap((p) => [p, `${p}-wal`, `${p}-shm`]);
  if (candidates.some((c) => liveDbs.includes(c))) {
    throw new Error(`refusing to open the live Standup DB (${path}); pass a copy`);
  }
  for (const dir of [resolve(dataDir), realOrResolved(dataDir)]) {
    const worktrees = join(dir, "worktrees") + sep;
    for (const c of candidates) {
      if ((c === dir || c.startsWith(dir + sep)) && !c.startsWith(worktrees)) {
        throw new Error(`refusing to open ${path}: it is under the live Standup data dir ${dir}; copy it elsewhere first`);
      }
    }
  }
  if (!existsSync(target)) throw new Error(`snapshot DB not found: ${path}`);
  return target;
}

export interface SnapshotEnvOptions {
  dbPath: string;
  repoDir?: string;
  embeddingProvider: EmbeddingProvider | null;
}

/**
 * Serves the same routes over a real standup.db. The given file is never
 * opened for writing: it is copied (with any -wal/-shm sidecars) into a temp
 * dir first, because createStore migrates, KnowledgeStore ensures its tables on
 * construct, and the read routes record retrieval telemetry. No knowledge sync
 * is attached: there is no corpus dir to reconcile against, and a sync against
 * an empty dir would delete every doc.
 */
export function buildSnapshotEnv(opts: SnapshotEnvOptions): EvalEnv {
  const source = assertSafeDbCopy(opts.dbPath);
  const root = mkdtempSync(join(tmpdir(), "standup-kbeval-snap-"));
  // The DB copy stays in the private temp dir; only the cwd cases search from goes where code search searches.
  const emptyCwd = mkdtempSync(join(searchableTempDir(), "standup-kbeval-cwd-"));
  const dbPath = join(root, "snapshot.db");
  copyFileSync(source, dbPath);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(source + suffix)) copyFileSync(source + suffix, dbPath + suffix);
  }
  const store = createStore(dbPath);
  const app = createServer(store, () => {}, opts.embeddingProvider, undefined, undefined, "", join(root, "icons"), {});
  const repo = opts.repoDir && existsSync(opts.repoDir) ? resolve(opts.repoDir) : undefined;
  // The snapshot's projects name repo paths on the host it was taken from, and
  // the cases ask from the local repo copy or an empty cwd instead (see
  // buildFixtureEnv), so both are allowed as code-search roots.
  process.env.STANDUP_CODE_SEARCH_ROOTS = [emptyCwd, ...(repo ? [repo] : [])].join(delimiter);
  const ctx = makeContext(store, app, () => repo, emptyCwd, opts.embeddingProvider);
  return {
    store,
    db: store.db,
    ctx,
    knowledgeDir: "",
    replay: { editedDocs: 0, versions: 0, syncs: 0, verdicts: 0 },
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
      rmSync(emptyCwd, { recursive: true, force: true });
    },
  };
}
