import { setSystemTime } from "bun:test";
import type { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tryEnableSqliteVecExtension, ensureCosineCalibration, GRAPH_RERANK_ENABLED } from "@standup/knowledge";
import { detectCodeSearchBackend, type CodeSearchBackend } from "../code-search.js";
import { applyOrgReviewTerms } from "../knowledge-query-rewrite.js";
import { DEFAULT_ORG_PROFILE } from "../org-profile/default.js";
import { activeOrgProfile } from "../org-profile/load.js";
import { computeCasesLock, diffCasesLock, loadCases, lockHash, readCasesLock, splitFor } from "./cases.js";
import type { CodeSearchHost, GateException } from "./compare.js";
import {
  CachedEmbeddingSource,
  EMBED_MODEL,
  EMBED_PROVIDER_ID,
  EmbeddingCache,
  fetchOllamaDigest,
  installEmbeddingProvider,
  type EmbeddingSource,
  type EmbeddingStats,
} from "./embedding-cache.js";
import { buildFixtureEnv, buildSnapshotEnv, FIXTURE_HOST_USER, hashTree, type EvalEnv } from "./env.js";
import { checkIntegrity } from "./integrity.js";
import { loadDocMeta, policyViolations } from "./policy.js";
import { aggregate, computePairMetrics, round, roundNumbers, type PairMetrics } from "./metrics.js";
import {
  currentPersonaAdapter,
  runCode,
  runInject,
  runPersona,
  runSearch,
  type PersonaContextAdapter,
  type SurfaceContext,
} from "./surfaces.js";
import {
  runSurfacesFor,
  type CodeSearchSummary,
  type EvalCase,
  type Hit,
  type IntegrityReport,
  type MetricSet,
  type RunSurface,
  type Surface,
  type SurfaceRun,
} from "./types.js";

export const RESULTS_SCHEMA_VERSION = 1;

/** The fixed clock every run evaluates under, so confidence decay is reproducible. */
export const DEFAULT_EVAL_NOW = "2026-10-01T00:00:00.000Z";

export type Tier = "fixture" | "snapshot";

/** Where a tier's inputs and outputs live, relative to packages/knowledge/eval. */
export interface TierPaths {
  casesDir: string;
  lockPath: string;
  embeddingsDir: string;
  resultsDir: string;
  baselinePath: string;
  acceptedPath: string;
}

export function tierPaths(evalDir: string, tier: Tier): TierPaths {
  const base = tier === "fixture" ? evalDir : join(evalDir, "local");
  return {
    casesDir: join(base, "cases"),
    lockPath: join(base, "cases.lock"),
    embeddingsDir: join(base, "embeddings"),
    resultsDir: join(base, "results"),
    baselinePath: join(base, "baseline.json"),
    acceptedPath: join(base, "accepted.json"),
  };
}

export interface RunOptions {
  tier: Tier;
  evalDir: string;
  label?: string;
  /** Snapshot tier: the DB to copy and run against. */
  snapshotPath?: string;
  /** Snapshot tier: the source checkout code search reads (defaults to local/repo). */
  snapshotRepoDir?: string;
  /** Fixture tier overrides (tests point these at a temp corpus). */
  corpusDir?: string;
  fixtureRepoDir?: string;
  casesDir?: string;
  refreshEmbeddings?: boolean;
  prune?: boolean;
  /** Run with no embedding provider at all (FTS-only), as a host without Ollama does. */
  noEmbeddings?: boolean;
  /** Replaces the cache-backed embedding source (tests). */
  embeddingSource?: EmbeddingSource;
  vec?: boolean;
  /**
   * `false` hides ripgrep for the run (STANDUP_RG_PATH=""), so the code
   * surface uses git grep or the JS walker as on a host without `rg`.
   * Omitted, the host's own `rg` resolution decides.
   */
  ripgrep?: boolean;
  now?: string;
  surfaces?: Surface[];
  /** Only these case ids (debugging; a filtered run is not comparable to a full one). */
  caseIds?: string[];
  personaAdapter?: PersonaContextAdapter;
  /**
   * Rewrites the run's temp DB before anything is measured (`--migrate`: the
   * knowledge-data migrations, applied DB-only). Returns one summary line per
   * migration, recorded in the results config.
   */
  migrate?: (db: Database, tier: Tier) => Promise<string[]>;
  /** Write results/<label>.json (default true). */
  writeResults?: boolean;
  log?: (line: string) => void;
}

export interface CaseResult {
  id: string;
  category: string;
  split: string;
  silver: boolean;
  query: string;
  audience: { projectId: string; user?: string };
  surfaces: Record<
    string,
    {
      hitCount: number;
      hits: Array<Omit<Hit, "kind"> & { kind: string }>;
      extraRefs?: string[];
      metrics: PairMetrics;
      detail?: Record<string, unknown>;
      error?: string;
    }
  >;
}

export interface EvalResults {
  schemaVersion: number;
  tier: Tier;
  label: string;
  provenance: {
    gitHead: string | null;
    casesLockHash: string;
    casesLockMatches: boolean;
    casesLockProblems: string[];
    corpusHash: string;
    embeddingModel: string;
    embeddingModelDigest: string | null;
  };
  config: {
    now: string;
    vec: boolean;
    graphRerank: boolean;
    embeddings: boolean;
    /**
     * Engine the code surface would search the fixture repo (or this
     * checkout) with on this host: ripgrep when installed, else `git grep` or
     * the JS walker. What each case's search actually did is in `codeSearch`.
     */
    codeSearchBackend: CodeSearchBackend;
    surfaces: Surface[];
    caseFilter: string[] | null;
    personaAdapter: string;
    /** One summary line per data migration applied to the run's DB (--migrate). */
    migrations?: string[];
    /** The cosine band the run's relevance was read through (calibration.ts). */
    relevanceCalibration?: {
      status: string;
      low: number;
      high: number;
      /** Calibration probe/title embeddings the cache lacked (each leaves the band at the defaults). */
      embeddingMisses?: number;
    };
  };
  load: EvalEnv["replay"];
  embeddings: EmbeddingStats & { pruned: number; cacheSize: number | null };
  integrity: IntegrityReport;
  codeSearch: CodeSearchSummary;
  metrics: {
    overall: MetricSet;
    bySurface: Record<string, MetricSet>;
    byCategory: Record<string, MetricSet>;
    bySplit: Record<string, MetricSet>;
    byLabel: Record<string, MetricSet>;
    bySurfaceCategory: Record<string, MetricSet>;
    bySurfaceSplit: Record<string, MetricSet>;
  };
  errors: string[];
  cases: CaseResult[];
  /** Approved regressions the gate tolerates; recorded only in accepted.json (`--accept --exception`). */
  exceptions?: GateException[];
  /** Run-specific values excluded from determinism comparisons. */
  run: { generatedAt: string; durationMs: number; productionLogLines?: number; productionLogSample?: string[] };
}

function gitHead(cwd: string): string | null {
  const res = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd, stdout: "pipe", stderr: "pipe" });
  return res.exitCode === 0 ? res.stdout.toString().trim() : null;
}

/** Runs git in `cwd`, returning its stdout, or null when git cannot run or exits non-zero. */
function gitOutput(args: string[], cwd: string): string | null {
  try {
    const res = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    return res.exitCode === 0 ? res.stdout.toString() : null;
  } catch {
    return null;
  }
}

/** The host's code-search conditions in a fixture repo, for codeSearchHostViolations. */
export function probeCodeSearchHost(fixtureRepoDir: string): CodeSearchHost {
  const gitVersion = gitOutput(["--version"], fixtureRepoDir)?.match(/(\d+\.\d+(?:\.\d+)?)/)?.[1] ?? null;
  const insideWorkTree = gitOutput(["rev-parse", "--is-inside-work-tree"], fixtureRepoDir)?.trim() === "true";
  const untracked = insideWorkTree
    ? (gitOutput(["ls-files", "-z", "--others", "--exclude-standard", "--", "."], fixtureRepoDir) ?? "")
        .split("\0")
        .filter((f) => f.length > 0)
        .sort()
    : [];
  return { gitVersion, insideWorkTree, untracked };
}

function serializeHit(h: Hit): Omit<Hit, "kind"> & { kind: string } {
  return {
    ref: h.ref,
    rank: h.rank,
    kind: h.kind,
    ...(h.score !== undefined ? { score: round(h.score) } : {}),
    ...(h.rawScore !== undefined ? { rawScore: round(h.rawScore) } : {}),
    ...(h.relevance !== undefined ? { relevance: round(h.relevance) } : {}),
    ...(h.excerpt !== undefined ? { excerpt: h.excerpt.slice(0, 400) } : {}),
    flags: {
      ...h.flags,
      ...(h.flags.currentConfidence !== undefined ? { currentConfidence: round(h.flags.currentConfidence) } : {}),
    },
    ...(h.why ? { why: { components: roundNumbers(h.why.components) } } : {}),
  };
}

/**
 * Tallies each `code`-surface case's search outcome (recorded in its detail by
 * runCode). A case fails when its status is not ok/degraded, when it has no
 * recorded outcome ("missing"), or when its search reported an error at all —
 * a search that errored (a dead walker, a timeout, an rg file error) is not a
 * clean search whatever status it carries.
 */
export function summarizeCodeSearch(cases: CaseResult[]): CodeSearchSummary {
  const summary: CodeSearchSummary = { cases: 0, byStatus: {}, byBackend: {}, failing: [] };
  for (const c of cases) {
    const code = c.surfaces.code;
    if (!code) continue;
    const report = code.detail?.codeSearch as
      | { status?: string; backend?: string | null; error?: string }
      | null
      | undefined;
    const status = report?.status ?? "missing";
    const backend = report?.backend ?? "none";
    summary.cases++;
    summary.byStatus[status] = (summary.byStatus[status] ?? 0) + 1;
    summary.byBackend[backend] = (summary.byBackend[backend] ?? 0) + 1;
    if ((status !== "ok" && status !== "degraded") || report?.error) {
      summary.failing.push(`${c.id}: ${status}${report?.error ? ` (${report.error})` : ""}`);
    }
  }
  return summary;
}

/** Each case surface's runs, keyed by run surface (see runSurfacesFor). */
const SURFACE_RUNNERS: Record<
  Surface,
  (ctx: SurfaceContext, c: EvalCase, persona?: PersonaContextAdapter) => Promise<Partial<Record<RunSurface, SurfaceRun>>>
> = {
  search: async (ctx, c) => ({ search: await runSearch(ctx, c) }),
  code: async (ctx, c) => ({ code: await runCode(ctx, c) }),
  inject: async (ctx, c) => ({ inject: await runInject(ctx, c) }),
  persona: async (ctx, c, persona) => {
    const { context, recall } = await runPersona(ctx, c, persona);
    return { persona: context, "persona-recall": recall };
  },
};

function groupBy(
  pairs: Array<{ key: string[]; metrics: PairMetrics }>,
  index: number
): Record<string, MetricSet> {
  const groups = new Map<string, PairMetrics[]>();
  for (const p of pairs) {
    const k = p.key[index];
    groups.set(k, [...(groups.get(k) ?? []), p.metrics]);
  }
  const out: Record<string, MetricSet> = {};
  for (const k of [...groups.keys()].sort()) out[k] = aggregate(groups.get(k)!);
  return out;
}

/**
 * Routes production console output (boot logs, swallowed background failures)
 * away from stdout for the duration of a run, keeping the first
 * line of each distinct message so the report can say what was logged.
 */
function captureConsole(): { restore(): void; lines(): number; sample(): string[] } {
  const original = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  const seen = new Map<string, number>();
  let total = 0;
  const sink = (...args: unknown[]) => {
    total++;
    const first = args
      .map((a) => (a instanceof Error ? a.message : typeof a === "string" ? a : String(a)))
      .join(" ")
      .split("\n")[0]
      .slice(0, 200);
    seen.set(first, (seen.get(first) ?? 0) + 1);
  };
  console.log = sink;
  console.error = sink;
  console.warn = sink;
  console.info = sink;
  return {
    restore() {
      Object.assign(console, original);
    },
    lines: () => total,
    sample: () =>
      [...seen.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 10)
        .map(([line, n]) => `${n}× ${line}`),
  };
}

interface EnvVarSnapshot {
  restore(): void;
}

function setEnv(vars: Record<string, string | undefined>): EnvVarSnapshot {
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    previous[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return {
    restore() {
      for (const [k, v] of Object.entries(previous)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

/**
 * Runs every case against its surfaces on a freshly loaded tier and returns the
 * schema-versioned results (also written to results/<label>.json unless
 * disabled). Everything outside `run` is deterministic for a given code tree,
 * corpus, cases and embedding cache.
 */
export async function runEval(opts: RunOptions): Promise<EvalResults> {
  const started = performance.now();
  const log = opts.log ?? (() => {});
  const paths = tierPaths(opts.evalDir, opts.tier);
  const casesDir = opts.casesDir ?? paths.casesDir;
  const corpusDir = opts.corpusDir ?? join(opts.evalDir, "corpus");
  const fixtureRepoDir = opts.fixtureRepoDir ?? join(opts.evalDir, "fixture-repo");
  const now = opts.now ?? DEFAULT_EVAL_NOW;
  const label = opts.label ?? "run";
  const errors: string[] = [];

  const env = setEnv({
    // Recorded so the fixture loader's KNOWLEDGE_DIR override is undone afterwards.
    KNOWLEDGE_DIR: process.env.KNOWLEDGE_DIR,
    // Likewise for the env loaders' code-search roots (see buildFixtureEnv).
    STANDUP_CODE_SEARCH_ROOTS: process.env.STANDUP_CODE_SEARCH_ROOTS,
    STANDUP_DISABLE_VEC: opts.vec ? undefined : "1",
    ...(opts.ripgrep === false ? { STANDUP_RG_PATH: "" } : {}),
  });
  if (opts.vec) tryEnableSqliteVecExtension();

  const allCases = loadCases(casesDir);
  const cases = opts.caseIds ? allCases.filter((c) => opts.caseIds!.includes(c.id)) : allCases;
  const currentLock = computeCasesLock(casesDir);
  const lockProblems = diffCasesLock(currentLock, readCasesLock(opts.casesDir ? join(casesDir, "..", "cases.lock") : paths.lockPath));

  // Embedding source: the committed cache (refreshed from Ollama on request), a test fake, or none.
  let cache: EmbeddingCache | null = null;
  let source: EmbeddingSource | null = null;
  let digest: string | null = null;
  if (!opts.noEmbeddings) {
    if (opts.embeddingSource) {
      source = opts.embeddingSource;
    } else {
      cache = new EmbeddingCache(paths.embeddingsDir);
      digest = opts.refreshEmbeddings ? await fetchOllamaDigest() : cache.modelDigest;
      if (opts.refreshEmbeddings) cache.modelDigest = digest;
      source = new CachedEmbeddingSource(cache, digest ?? "unknown-digest", opts.refreshEmbeddings === true);
    }
  }
  const restoreProvider = source ? installEmbeddingProvider(source, digest) : () => {};
  const provider = source ? EMBED_PROVIDER_ID : null;

  setSystemTime(new Date(now));
  const consoleCapture = captureConsole();
  // The fixture corpus is the same owner's on every host; a snapshot is the
  // running host's own. Set beside the try so its finally always undoes it.
  const hostEnv = setEnv(opts.tier === "fixture" ? { STANDUP_HOST_USER: FIXTURE_HOST_USER } : {});
  let restoreReviewTerms = (): void => {};
  let built: EvalEnv | null = null;
  try {
    // Injection plans read the org's review noun the way the collector's boot
    // sets it. The fixture tier reads none, so its results don't depend on the
    // host's org profile; a snapshot reads the host's own. The finally puts
    // back the terms in force before the run.
    restoreReviewTerms = applyOrgReviewTerms(opts.tier === "fixture" ? DEFAULT_ORG_PROFILE : activeOrgProfile());
    built =
      opts.tier === "fixture"
        ? await buildFixtureEnv({ corpusDir, fixtureRepoDir, embeddingProvider: provider })
        : buildSnapshotEnv({
            dbPath: opts.snapshotPath!,
            repoDir: opts.snapshotRepoDir ?? join(opts.evalDir, "local", "repo"),
            embeddingProvider: provider,
          });
    const evalEnv = built;
    const migrations = opts.migrate ? await opts.migrate(evalEnv.db, opts.tier) : undefined;
    for (const line of migrations ?? []) log(`[kbeval] migrated: ${line}`);
    // The index-time relevance calibration production runs once the corpus is
    // embedded (KnowledgeSync.ensureRelevanceCalibration): each tier measures
    // its own cosine band.
    // Calibration embeds its probes and sampled titles through the same cache
    // as the cases; one miss leaves the band uncalibrated (the defaults), so
    // the misses it ran into are recorded beside the band.
    const missesBefore = source?.stats().misses ?? 0;
    const calibration = provider
      ? await ensureCosineCalibration(evalEnv.db, provider, evalEnv.ctx.embeddingConfig)
      : null;
    const calibrationMisses = (source?.stats().misses ?? 0) - missesBefore;
    if (calibration) {
      log(`[kbeval] relevance cosine band: ${calibration.status} ${calibration.low.toFixed(4)}–${calibration.high.toFixed(4)}`);
      if (calibration.status !== "calibrated" && calibrationMisses > 0) {
        log(
          `[kbeval] relevance calibration fell back to the default band: ${calibrationMisses} probe/title embedding(s) ` +
            "missing from the cache — run with --refresh-embeddings"
        );
      }
    }
    log(`[kbeval] loaded ${opts.tier} tier; running ${cases.length} case(s)`);

    const docMeta = loadDocMeta(evalEnv.db);
    const wanted = new Set<Surface>(opts.surfaces ?? ["search", "code", "inject", "persona"]);
    const pairs: Array<{ key: string[]; metrics: PairMetrics }> = [];
    const caseResults: CaseResult[] = [];
    for (const c of cases) {
      const split = splitFor(c.id);
      const result: CaseResult = {
        id: c.id,
        category: c.category,
        split,
        silver: c.silver === true,
        query: c.query,
        audience: c.audience,
        surfaces: {},
      };
      for (const surface of c.surface) {
        if (!wanted.has(surface)) continue;
        let runs: Partial<Record<RunSurface, SurfaceRun>> = {};
        let error: string | undefined;
        try {
          runs = await SURFACE_RUNNERS[surface](evalEnv.ctx, c, opts.personaAdapter);
        } catch (err) {
          error = String(err);
          errors.push(`${c.id}/${surface}: ${error}`);
        }
        for (const runSurface of runSurfacesFor(surface)) {
          const run = runs[runSurface] ?? { hits: [] };
          const metrics = computePairMetrics(c, runSurface, run.hits, run.extraRefs);
          metrics.policy = policyViolations(c, runSurface, run.hits, run.extraRefs ?? [], docMeta);
          pairs.push({
            key: [
              runSurface,
              c.category,
              split,
              c.silver ? "silver" : "gold",
              `${runSurface}/${c.category}`,
              `${runSurface}/${split}`,
            ],
            metrics,
          });
          result.surfaces[runSurface] = {
            hitCount: run.hits.length,
            hits: run.hits.slice(0, 10).map(serializeHit),
            ...(run.extraRefs && run.extraRefs.length > 0 ? { extraRefs: run.extraRefs } : {}),
            metrics,
            ...(run.detail ? { detail: run.detail } : {}),
            ...(error ? { error } : {}),
          };
        }
      }
      caseResults.push(result);
    }

    const integrity = checkIntegrity(evalEnv.db, digest);

    let pruned = 0;
    if (cache && opts.refreshEmbeddings) {
      if (opts.prune) pruned = cache.prune();
      cache.save();
    }
    const stats = source
      ? source.stats()
      : { hits: 0, misses: 0, fetched: 0, missKeys: [] };

    const results: EvalResults = {
      schemaVersion: RESULTS_SCHEMA_VERSION,
      tier: opts.tier,
      label,
      provenance: {
        gitHead: gitHead(opts.evalDir),
        casesLockHash: lockHash(currentLock),
        casesLockMatches: lockProblems.length === 0,
        casesLockProblems: lockProblems,
        corpusHash:
          opts.tier === "fixture" ? hashTree([corpusDir, fixtureRepoDir]) : snapshotCorpusHash(evalEnv),
        embeddingModel: EMBED_MODEL,
        embeddingModelDigest: digest,
      },
      config: {
        now,
        vec: opts.vec === true,
        graphRerank: GRAPH_RERANK_ENABLED,
        embeddings: source !== null,
        codeSearchBackend: detectCodeSearchBackend(
          opts.tier === "fixture" ? fixtureRepoDir : process.cwd()
        ).backend,
        surfaces: [...wanted].sort() as Surface[],
        caseFilter: opts.caseIds ? [...opts.caseIds].sort() : null,
        personaAdapter: (opts.personaAdapter ?? currentPersonaAdapter).name,
        ...(migrations ? { migrations } : {}),
        ...(calibration
          ? {
              relevanceCalibration: {
                status: calibration.status,
                low: calibration.low,
                high: calibration.high,
                ...(calibrationMisses > 0 ? { embeddingMisses: calibrationMisses } : {}),
              },
            }
          : {}),
      },
      load: evalEnv.replay,
      embeddings: { ...stats, pruned, cacheSize: cache ? cache.size : null },
      integrity,
      codeSearch: summarizeCodeSearch(caseResults),
      metrics: {
        overall: aggregate(pairs.map((p) => p.metrics)),
        bySurface: groupBy(pairs, 0),
        byCategory: groupBy(pairs, 1),
        bySplit: groupBy(pairs, 2),
        byLabel: groupBy(pairs, 3),
        bySurfaceCategory: groupBy(pairs, 4),
        bySurfaceSplit: groupBy(pairs, 5),
      },
      errors,
      cases: caseResults,
      run: { generatedAt: "", durationMs: 0 },
    };
    // The clock is frozen during the run; stamp real wall time once it is released.
    setSystemTime();
    results.run = {
      generatedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - started),
      productionLogLines: consoleCapture.lines(),
      productionLogSample: consoleCapture.sample(),
    };

    if (opts.writeResults !== false) {
      mkdirSync(paths.resultsDir, { recursive: true });
      writeFileSync(join(paths.resultsDir, `${label}.json`), JSON.stringify(results, null, 2) + "\n");
    }
    return results;
  } finally {
    consoleCapture.restore();
    setSystemTime();
    built?.close();
    restoreProvider();
    hostEnv.restore();
    env.restore();
    restoreReviewTerms();
  }
}

/** A content hash of the docs in a snapshot DB (project/slug + body), for provenance. */
function snapshotCorpusHash(evalEnv: EvalEnv): string {
  const rows = evalEnv.db
    .query("SELECT project_id, slug, body FROM knowledge ORDER BY project_id, slug")
    .all() as Array<{ project_id: string; slug: string; body: string }>;
  const hasher = createHash("sha256");
  for (const r of rows) hasher.update(`${r.project_id}/${r.slug}\u0000${r.body}\u0000`);
  return hasher.digest("hex");
}

/** The deterministic part of a results file — everything except the `run` stamp. */
export function deterministicView(results: EvalResults): Omit<EvalResults, "run"> {
  const { run: _run, ...rest } = results;
  return rest;
}
