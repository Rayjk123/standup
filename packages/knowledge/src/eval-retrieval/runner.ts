import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { installFixedClock } from "./clock.js";
import { EvalEmbeddings, EVAL_EMBED_PROVIDER_ID, installEvalEmbeddingProvider, type EmbeddingUsage } from "./embedding-cache.js";
import { buildRetrievalFixture } from "./fixture.js";
import {
  injectMetrics,
  mean,
  pushMetrics,
  rate,
  realQueryMetrics,
  summarizeReal,
  summarizeTaskPull,
  taskQueryMetrics,
  type InjectMetrics,
  type PushMetrics,
  type RealQueryMetrics,
  type RealSummary,
  type TaskPullSummary,
  type TaskQueryMetrics,
} from "./metrics.js";
import type { RankWeights } from "../search.js";
import { PUSH_RELEVANCE_BARS } from "../push.js";
import { PUSH_SURFACES, runInject, runRecall, runSearch, type PushInstance, type SurfaceContext } from "./surfaces.js";
import { REAL_CATEGORIES, type Hit, type RealCase, type UsefulnessTask } from "./types.js";

/** The pull surfaces tiers R and U query. */
export const PULL_SURFACES = ["search", "recall"] as const;
export type PullSurface = (typeof PULL_SURFACES)[number];

export interface RetrievalEvalOptions {
  /** packages/knowledge/eval/corpus */
  corpusDir: string;
  /** packages/knowledge/eval/fixture-repo */
  fixtureRepoDir: string;
  /** packages/knowledge/eval/retrieval (cases-real.json, tasks.json) */
  casesDir: string;
  /** packages/knowledge/eval/embeddings (read only) */
  baseEmbeddingsDir: string;
  /** packages/knowledge/eval/retrieval/embeddings */
  harnessEmbeddingsDir: string;
  /** Where the temp store and corpus copy are built. */
  workDir: string;
  /** The instant every clock read sees during the run. */
  now: Date;
  label: string;
  /** Fetch embeddings missing from both caches from local Ollama. */
  fetchMissing: boolean;
  /** Ollama base URL for those fetches; defaults to OLLAMA_URL (localhost). */
  ollamaUrl?: string;
  /** The resolved requesting user (tunnel identity) for every surface. */
  user: string;
  /** The host user the collector would resolve (hostUserAlias). */
  hostUser: string;
  /** Ordering-score weights for every surface; unset = the resolved defaults. */
  rankWeights?: Partial<RankWeights>;
}

export interface QueryHits {
  hits: Array<{ ref: string; relevant: boolean; marked?: boolean; relevance?: number; score?: number }>;
}

export interface RealCaseResult extends QueryHits {
  id: string;
  category: RealCase["category"];
  surface: PullSurface;
  metrics: RealQueryMetrics;
}

export interface TaskQueryResult extends QueryHits {
  task: string;
  id: string;
  query: string;
  project: string;
  surface: PullSurface;
  metrics: TaskQueryMetrics;
}

export interface TaskResult {
  id: string;
  project: string;
  helpfulDocs: number;
  pull: Record<PullSurface, TaskPullSummary>;
  inject: InjectMetrics & { code: string[]; product: string[]; helpful: string[] };
  push: PushMetrics & {
    log: Array<{ event: string; query: string; pushed: string[]; relevance: Array<number | null>; helpful: string[] }>;
  };
}

/** Hook-push usefulness over the task tier, and the launch injection with and without the hooks. */
export interface PushOverall {
  /** The bar a pushed hit's relevance cleared, per hook event (PUSH_RELEVANCE_BARS). */
  bars: Record<string, number>;
  /** Helpful pushed docs over all pushed docs (tasks with helpful docs). */
  microPrecision: number | null;
  /** Macro mean over the tasks that pushed anything. */
  precision: number | null;
  /** Tasks with helpful docs that got at least one helpful pushed doc. */
  hitRate: number | null;
  /** Mean docs pushed per task, every task. */
  pushedPerTask: number | null;
  /** Pushes carrying no helpful doc over all pushes, every task. */
  noiseRate: number | null;
  /** Tasks with no helpful doc in the corpus that were pushed nothing. */
  honestEmptyRate: number | null;
  byEvent: Record<string, { firings: number; pushes: number; pushed: number; helpfulPushed: number; precision: number | null }>;
  /** Launch injection alone vs injection plus pushes, over the tasks with helpful docs. */
  withoutHooks: { hitRate: number | null; microPrecision: number | null };
  withHooks: { hitRate: number | null; microPrecision: number | null };
  /** Uptake (a pushed doc opened later in the same session) needs a live agent. */
  uptake: string;
}

export interface UsefulnessOverall {
  /** Macro means over the tasks that have helpful docs. */
  pull: Record<PullSurface, { pullHit5: number | null; helpfulRecall5: number | null; mrr10: number | null; noiseRate: number | null }>;
  /** Over the tasks with no helpful doc in the corpus: share of their queries that came back empty. */
  honestEmpty: Record<PullSurface, number | null>;
  inject: {
    /** Macro mean over tasks that injected anything. */
    precision: number | null;
    /** Helpful injected docs over all injected docs. */
    microPrecision: number | null;
    hitRate: number | null;
    /** Honest-empty tasks that injected nothing. */
    honestEmptyRate: number | null;
  };
  push: PushOverall;
  /** The push metrics with one bar for every event, at each bar of PUSH_BAR_SWEEP: the calibration table for PUSH_RELEVANCE_BARS. */
  pushSweep: Array<{
    bar: number;
    microPrecision: number | null;
    hitRate: number | null;
    pushedPerTask: number | null;
    noiseRate: number | null;
    withHooksHitRate: number | null;
    withHooksMicroPrecision: number | null;
  }>;
}

/** The relevance bars the push calibration sweep reruns every simulated session at. */
export const PUSH_BAR_SWEEP: readonly number[] = [0.4, 0.5, 0.55, 0.6, 0.65, 0.7, 0.8];

export interface RetrievalEvalResults {
  label: string;
  now: string;
  load: { docs: number; editedDocs: number; versions: number; syncs: number; verdicts: number };
  real: {
    cases: RealCaseResult[];
    summary: Record<PullSurface, Record<string, RealSummary>>;
  };
  usefulness: {
    queries: TaskQueryResult[];
    tasks: TaskResult[];
    overall: UsefulnessOverall;
  };
  push: string;
}

export interface RetrievalEvalRun {
  results: RetrievalEvalResults;
  /** Run facts that legitimately differ between runs (cache traffic). */
  run: { embeddings: EmbeddingUsage };
}

export function loadRealCases(casesDir: string): RealCase[] {
  return JSON.parse(readFileSync(join(casesDir, "cases-real.json"), "utf-8")) as RealCase[];
}

export function loadTasks(casesDir: string): UsefulnessTask[] {
  return JSON.parse(readFileSync(join(casesDir, "tasks.json"), "utf-8")) as UsefulnessTask[];
}

/** Every doc a label names, so a typo fails the run instead of scoring as a miss. */
function labelledRefs(cases: RealCase[], tasks: UsefulnessTask[]): string[] {
  const refs = new Set<string>();
  for (const c of cases) {
    for (const r of c.relevant) refs.add(r.doc);
    for (const r of c.stale?.fresh ?? []) refs.add(r);
    for (const r of c.stale?.stale ?? []) refs.add(r);
  }
  for (const t of tasks) for (const q of t.queries) for (const r of q.helpful) refs.add(r);
  return [...refs].sort();
}

function hitList(hits: readonly Hit[], relevant: ReadonlySet<string>): QueryHits["hits"] {
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return hits.map((h) => ({
    ref: h.ref,
    relevant: relevant.has(h.contentKey),
    ...(h.marked ? { marked: true } : {}),
    ...(h.relevance !== undefined ? { relevance: round(h.relevance) } : {}),
    ...(h.score !== undefined ? { score: round(h.score) } : {}),
  }));
}

export async function runRetrievalEval(opts: RetrievalEvalOptions): Promise<RetrievalEvalRun> {
  const restoreClock = installFixedClock(opts.now.getTime());
  const embeddings = new EvalEmbeddings({
    baseDir: opts.baseEmbeddingsDir,
    harnessDir: opts.harnessEmbeddingsDir,
    fetchMissing: opts.fetchMissing,
    ollamaUrl: opts.ollamaUrl,
  });
  const restoreProvider = installEvalEmbeddingProvider(embeddings);
  const env = await buildRetrievalFixture({
    corpusDir: opts.corpusDir,
    fixtureRepoDir: opts.fixtureRepoDir,
    workDir: opts.workDir,
    embeddingProvider: EVAL_EMBED_PROVIDER_ID,
  });
  try {
    const rows = env.db.query("SELECT project_id, slug, body FROM knowledge").all() as Array<{
      project_id: string;
      slug: string;
      body: string;
    }>;
    const keyByRef = new Map(
      rows.map((r) => [`${r.project_id}/${r.slug}`, createHash("sha256").update(r.body.trim()).digest("hex").slice(0, 16)])
    );
    const contentKeyOf = (ref: string) => keyByRef.get(ref) ?? `missing:${ref}`;

    const cases = loadRealCases(opts.casesDir);
    const tasks = loadTasks(opts.casesDir);
    const missing = labelledRefs(cases, tasks).filter((ref) => !keyByRef.has(ref));
    if (missing.length > 0) throw new Error(`labels name docs the fixture does not hold: ${missing.join(", ")}`);

    const ctx: SurfaceContext = {
      db: env.db,
      embeddingProvider: EVAL_EMBED_PROVIDER_ID,
      projects: env.projects,
      user: opts.user,
      hostUser: opts.hostUser,
      now: opts.now,
      contentKeyOf,
      ...(opts.rankWeights ? { rankWeights: opts.rankWeights } : {}),
    };
    const keys = (refs: readonly string[]) => new Set(refs.map(contentKeyOf));
    const pull = (surface: PullSurface, project: string, query: string) =>
      surface === "search" ? runSearch(ctx, project, query) : runRecall(ctx, query);

    const realResults: RealCaseResult[] = [];
    for (const c of cases) {
      const relevant = keys(c.relevant.map((r) => r.doc));
      for (const surface of PULL_SURFACES) {
        const hits = await pull(surface, c.project, c.query);
        realResults.push({
          id: c.id,
          category: c.category,
          surface,
          metrics: realQueryMetrics(hits, relevant, {
            expectEmpty: c.expectEmpty,
            ...(c.stale ? { fresh: keys(c.stale.fresh), stale: keys(c.stale.stale) } : {}),
          }),
          hits: hitList(hits, relevant),
        });
      }
    }
    const realSummary = {} as Record<PullSurface, Record<string, RealSummary>>;
    for (const surface of PULL_SURFACES) {
      const mine = realResults.filter((r) => r.surface === surface);
      const bucket: Record<string, RealSummary> = {};
      for (const category of REAL_CATEGORIES) {
        const rowsOf = mine.filter((r) => r.category === category).map((r) => r.metrics);
        if (rowsOf.length > 0) bucket[category] = summarizeReal(rowsOf);
      }
      bucket["overall-answerable"] = summarizeReal(mine.filter((r) => r.metrics.answerable).map((r) => r.metrics));
      bucket["overall"] = summarizeReal(mine.map((r) => r.metrics));
      realSummary[surface] = bucket;
    }

    const pushNote = PUSH_SURFACES.map((p) => p.event).join(", ");
    const queryResults: TaskQueryResult[] = [];
    const taskResults: TaskResult[] = [];
    const sweepRows: Record<number, TaskResult[]> = {};
    for (const task of tasks) {
      const taskHelpful = [...new Set(task.queries.flatMap((q) => q.helpful))].sort();
      const pullSummary = {} as Record<PullSurface, TaskPullSummary>;
      for (const surface of PULL_SURFACES) {
        const metricsRows: TaskQueryMetrics[] = [];
        for (const q of task.queries) {
          const project = q.project ?? task.project;
          const helpful = keys(q.helpful);
          const hits = await pull(surface, project, q.query);
          const metrics = taskQueryMetrics(hits, helpful);
          metricsRows.push(metrics);
          queryResults.push({ task: task.id, id: q.id, query: q.query, project, surface, metrics, hits: hitList(hits, helpful) });
        }
        pullSummary[surface] = summarizeTaskPull(metricsRows, taskHelpful.length > 0);
      }
      const injected = await runInject(ctx, task.project, task.brief);
      const all = [...injected.code, ...injected.product];
      const helpfulKeys = keys(taskHelpful);
      // One simulated session: the launch's injected docs seed the dedup set,
      // then each hook fires in session order.
      const seen = new Set(all.map((h) => h.ref));
      const firings: PushInstance[] = [];
      for (const surface of PUSH_SURFACES) firings.push(...(await surface.run(ctx, task, seen)));
      taskResults.push({
        id: task.id,
        project: task.project,
        helpfulDocs: taskHelpful.length,
        pull: pullSummary,
        inject: {
          ...injectMetrics(all, helpfulKeys),
          code: injected.code.map((h) => h.ref),
          product: injected.product.map((h) => h.ref),
          helpful: all.filter((h) => helpfulKeys.has(h.contentKey)).map((h) => h.ref),
        },
        push: {
          ...pushMetrics(firings, all, helpfulKeys),
          log: firings.map((f) => ({
            event: f.event,
            query: f.query,
            pushed: f.hits.map((h) => h.ref),
            relevance: f.hits.map((h) => (h.relevance === undefined ? null : Math.round(h.relevance * 1000) / 1000)),
            helpful: f.hits.filter((h) => helpfulKeys.has(h.contentKey)).map((h) => h.ref),
          })),
        },
      });
      const shipped = taskResults[taskResults.length - 1];
      for (const bar of PUSH_BAR_SWEEP) {
        const swept = new Set(all.map((h) => h.ref));
        const sweptFirings: PushInstance[] = [];
        for (const surface of PUSH_SURFACES) sweptFirings.push(...(await surface.run(ctx, task, swept, bar)));
        (sweepRows[bar] ??= []).push({ ...shipped, push: { ...pushMetrics(sweptFirings, all, helpfulKeys), log: [] } });
      }
    }

    const answerableTasks = taskResults.filter((t) => t.helpfulDocs > 0);
    const emptyTasks = taskResults.filter((t) => t.helpfulDocs === 0);
    const overallPull = {} as UsefulnessOverall["pull"];
    const honestEmpty = {} as UsefulnessOverall["honestEmpty"];
    for (const surface of PULL_SURFACES) {
      const pick = (f: (s: TaskPullSummary) => number | null) =>
        mean(answerableTasks.map((t) => f(t.pull[surface])).filter((v): v is number => v !== null));
      overallPull[surface] = {
        pullHit5: pick((s) => s.pullHit5),
        helpfulRecall5: pick((s) => s.helpfulRecall5),
        mrr10: pick((s) => s.mrr10),
        noiseRate: mean(taskResults.map((t) => t.pull[surface].noiseRate).filter((v): v is number => v !== null)),
      };
      honestEmpty[surface] = mean(emptyTasks.map((t) => t.pull[surface].emptyRate).filter((v): v is number => v !== null));
    }
    const injectedTotal = answerableTasks.reduce((s, t) => s + t.inject.injected, 0);
    const helpfulTotal = answerableTasks.reduce((s, t) => s + t.inject.helpfulInjected, 0);
    const overall: UsefulnessOverall = {
      pull: overallPull,
      honestEmpty,
      inject: {
        precision: mean(answerableTasks.map((t) => t.inject.precision).filter((v): v is number => v !== null)),
        microPrecision: injectedTotal > 0 ? helpfulTotal / injectedTotal : null,
        hitRate: rate(answerableTasks.map((t) => t.inject.hit)),
        honestEmptyRate: rate(emptyTasks.map((t) => t.inject.injected === 0)),
      },
      push: summarizePush(taskResults, injectedTotal, helpfulTotal),
      pushSweep: PUSH_BAR_SWEEP.map((bar) => {
        const s = summarizePush(sweepRows[bar] ?? [], injectedTotal, helpfulTotal);
        return {
          bar,
          microPrecision: s.microPrecision,
          hitRate: s.hitRate,
          pushedPerTask: s.pushedPerTask,
          noiseRate: s.noiseRate,
          withHooksHitRate: s.withHooks.hitRate,
          withHooksMicroPrecision: s.withHooks.microPrecision,
        };
      }),
    };

    embeddings.save();
    return {
      results: {
        label: opts.label,
        now: opts.now.toISOString(),
        load: env.load,
        real: { cases: realResults, summary: realSummary },
        usefulness: { queries: queryResults, tasks: taskResults, overall },
        push: pushNote,
      },
      run: { embeddings: embeddings.stats() },
    };
  } finally {
    env.close();
    restoreProvider();
    restoreClock();
  }
}

/** The task tier's push summary (see PushOverall). `injected*` are the answerable tasks' injection totals. */
export function summarizePush(tasks: readonly TaskResult[], injectedTotal: number, injectedHelpful: number): PushOverall {
  const answerable = tasks.filter((t) => t.helpfulDocs > 0);
  const empty = tasks.filter((t) => t.helpfulDocs === 0);
  const pushed = answerable.reduce((s, t) => s + t.push.pushed, 0);
  const helpful = answerable.reduce((s, t) => s + t.push.helpfulPushed, 0);
  const pushes = tasks.reduce((s, t) => s + t.push.pushes, 0);
  const noisy = tasks.reduce((s, t) => s + t.push.noisyPushes, 0);
  const byEvent: PushOverall["byEvent"] = {};
  for (const t of tasks) {
    for (const [event, c] of Object.entries(t.push.byEvent)) {
      const sum = (byEvent[event] ??= { firings: 0, pushes: 0, pushed: 0, helpfulPushed: 0, precision: null });
      sum.firings += c.firings;
      sum.pushes += c.pushes;
      sum.pushed += c.pushed;
      sum.helpfulPushed += c.helpfulPushed;
    }
  }
  for (const sum of Object.values(byEvent)) sum.precision = sum.pushed > 0 ? sum.helpfulPushed / sum.pushed : null;
  const unionDocs = answerable.reduce((s, t) => s + t.push.withHooks.docs, 0);
  const unionHelpful = answerable.reduce((s, t) => s + t.push.withHooks.helpful, 0);
  return {
    bars: { ...PUSH_RELEVANCE_BARS },
    microPrecision: pushed > 0 ? helpful / pushed : null,
    precision: mean(answerable.map((t) => t.push.precision).filter((v): v is number => v !== null)),
    hitRate: rate(answerable.map((t) => t.push.hit)),
    pushedPerTask: mean(tasks.map((t) => t.push.pushed)),
    noiseRate: pushes > 0 ? noisy / pushes : null,
    honestEmptyRate: rate(empty.map((t) => t.push.pushed === 0)),
    byEvent,
    withoutHooks: {
      hitRate: rate(answerable.map((t) => t.inject.hit)),
      microPrecision: injectedTotal > 0 ? injectedHelpful / injectedTotal : null,
    },
    withHooks: {
      hitRate: rate(answerable.map((t) => t.push.withHooks.hit)),
      microPrecision: unionDocs > 0 ? unionHelpful / unionDocs : null,
    },
    uptake: "not observable on fixtures (no agent); measured live via getPushUptake",
  };
}

function fmt(value: number | null | undefined): string {
  return value === null || value === undefined ? "-" : value.toFixed(3);
}

/** A markdown summary of one run: tier R per surface and category, tier U per task, then per-query top hits. */
export function renderMarkdown(results: RetrievalEvalResults): string {
  const lines: string[] = [];
  lines.push(`# Retrieval eval — ${results.label}`, "");
  lines.push(`Clock pinned to ${results.now}. Fixture: ${results.load.docs} docs, ${results.load.verdicts} verdicts.`, "");
  lines.push("## Tier R — real-shaped golden", "");
  for (const surface of PULL_SURFACES) {
    lines.push(`### ${surface}`, "");
    lines.push("| category | n | P@1 | R@5 | MRR@10 | FN (empty) | miss@5 | correct-empty | dup-slot | stale-first |");
    lines.push("|---|---|---|---|---|---|---|---|---|---|");
    for (const [category, s] of Object.entries(results.real.summary[surface])) {
      lines.push(
        `| ${category} | ${s.n} | ${fmt(s.p1)} | ${fmt(s.r5)} | ${fmt(s.mrr10)} | ${fmt(s.falseNegativeRate)} | ${fmt(s.miss5Rate)} | ${fmt(s.correctEmptyRate)} | ${fmt(s.duplicateSlotRate)} | ${fmt(s.staleRankedFirstRate)} |`
      );
    }
    lines.push("");
  }
  lines.push("## Tier U — task usefulness", "");
  for (const surface of PULL_SURFACES) {
    lines.push(`### pull: ${surface}`, "");
    lines.push("| task | helpful docs | queries | hit@5 | helpful R@5 | MRR@10 | noise | empty |");
    lines.push("|---|---|---|---|---|---|---|---|");
    for (const t of results.usefulness.tasks) {
      const s = t.pull[surface];
      lines.push(
        `| ${t.id} | ${t.helpfulDocs} | ${s.queries} | ${fmt(s.pullHit5)} | ${fmt(s.helpfulRecall5)} | ${fmt(s.mrr10)} | ${fmt(s.noiseRate)} | ${fmt(s.emptyRate)} |`
      );
    }
    const o = results.usefulness.overall.pull[surface];
    lines.push(
      `| **overall** (tasks with helpful docs; noise over all) | | | ${fmt(o.pullHit5)} | ${fmt(o.helpfulRecall5)} | ${fmt(o.mrr10)} | ${fmt(o.noiseRate)} | honest-empty ${fmt(results.usefulness.overall.honestEmpty[surface])} |`
    );
    lines.push("");
  }
  lines.push("### inject (launch brief)", "");
  lines.push("| task | injected | helpful injected | precision | hit | code block | product block |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const t of results.usefulness.tasks) {
    lines.push(
      `| ${t.id} | ${t.inject.injected} | ${t.inject.helpfulInjected} | ${fmt(t.inject.precision)} | ${t.inject.hit ? "yes" : "no"} | ${t.inject.code.join(", ") || "-"} | ${t.inject.product.join(", ") || "-"} |`
    );
  }
  const oi = results.usefulness.overall.inject;
  lines.push(
    `| **overall** | | | macro ${fmt(oi.precision)} / micro ${fmt(oi.microPrecision)} | hit rate ${fmt(oi.hitRate)} | honest-empty ${fmt(oi.honestEmptyRate)} | |`
  );
  const op = results.usefulness.overall.push;
  const bars = Object.entries(op.bars)
    .map(([event, bar]) => `${event} ${bar}`)
    .join(", ");
  lines.push("", `### push (hooks: ${results.push}; relevance bars ${bars})`, "");
  lines.push("| task | firings | pushes | pushed | helpful pushed | precision | hit | noisy pushes | with hooks: docs / helpful / hit |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const t of results.usefulness.tasks) {
    const p = t.push;
    lines.push(
      `| ${t.id} | ${p.firings} | ${p.pushes} | ${p.pushed} | ${p.helpfulPushed} | ${fmt(p.precision)} | ${p.hit ? "yes" : "no"} | ${p.noisyPushes} | ${p.withHooks.docs} / ${p.withHooks.helpful} / ${p.withHooks.hit ? "yes" : "no"} |`
    );
  }
  lines.push(
    `| **overall** | | | per task ${fmt(op.pushedPerTask)} | | macro ${fmt(op.precision)} / micro ${fmt(op.microPrecision)} | hit rate ${fmt(op.hitRate)} | noise ${fmt(op.noiseRate)} | honest-empty ${fmt(op.honestEmptyRate)} |`
  );
  lines.push("");
  lines.push("| event | firings | pushes | pushed | helpful pushed | precision |");
  lines.push("|---|---|---|---|---|---|");
  for (const [event, c] of Object.entries(op.byEvent)) {
    lines.push(`| ${event} | ${c.firings} | ${c.pushes} | ${c.pushed} | ${c.helpfulPushed} | ${fmt(c.precision)} |`);
  }
  lines.push("");
  lines.push("| tasks with helpful docs | hit rate | micro precision |");
  lines.push("|---|---|---|");
  lines.push(`| inject alone (without hooks) | ${fmt(op.withoutHooks.hitRate)} | ${fmt(op.withoutHooks.microPrecision)} |`);
  lines.push(`| inject + push (with hooks) | ${fmt(op.withHooks.hitRate)} | ${fmt(op.withHooks.microPrecision)} |`);
  lines.push("", "Bar sweep (one bar for every event; the shipped bars are above):", "");
  lines.push("| bar | push micro precision | push hit rate | pushed per task | noise | with hooks: hit rate | with hooks: micro precision |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const s of results.usefulness.overall.pushSweep) {
    lines.push(
      `| ${s.bar} | ${fmt(s.microPrecision)} | ${fmt(s.hitRate)} | ${fmt(s.pushedPerTask)} | ${fmt(s.noiseRate)} | ${fmt(s.withHooksHitRate)} | ${fmt(s.withHooksMicroPrecision)} |`
    );
  }
  lines.push("", `Uptake: ${op.uptake}.`, "");
  lines.push("Pushes: `[H]` = helpful.", "");
  for (const t of results.usefulness.tasks) {
    for (const f of t.push.log.filter((x) => x.pushed.length > 0)) {
      const shown = f.pushed.map((ref, i) => `${ref} (${f.relevance[i] ?? "-"})${f.helpful.includes(ref) ? " [H]" : ""}`);
      lines.push(`- **${t.id} / ${f.event}** "${f.query.slice(0, 80)}" → ${shown.join("; ")}`);
    }
  }
  lines.push("");
  lines.push("## Per-query top hits (search)", "", "`[H]` = helpful / relevant, `[!]` = marked by the surface.", "");
  for (const q of results.usefulness.queries.filter((x) => x.surface === "search")) {
    const top = q.hits.slice(0, 5).map((h) => `${h.ref}${h.relevant ? " [H]" : ""}${h.marked ? " [!]" : ""}`);
    lines.push(`- **${q.task} / ${q.id}** (${q.project}) "${q.query}" → ${top.length > 0 ? top.join("; ") : "(nothing)"}`);
  }
  lines.push("");
  for (const c of results.real.cases.filter((x) => x.surface === "search")) {
    const top = c.hits.slice(0, 5).map((h) => `${h.ref}${h.relevant ? " [H]" : ""}${h.marked ? " [!]" : ""}`);
    lines.push(`- **${c.category} / ${c.id}** → ${top.length > 0 ? top.join("; ") : "(nothing)"}`);
  }
  lines.push("");
  return lines.join("\n");
}
