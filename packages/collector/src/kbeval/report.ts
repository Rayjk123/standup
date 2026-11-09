import type { EvalResults } from "./runner.js";
import { CONTEXT_SURFACES, type MetricSet } from "./types.js";

const COLUMNS: Array<[string, (m: MetricSet) => number | null | string]> = [
  ["pairs", (m) => String(m.pairs)],
  ["R@5", (m) => m.recallAt5],
  ["MRR@10", (m) => m.mrrAt10],
  ["nDCG@10", (m) => m.ndcgAt10],
  ["P@5", (m) => m.pAt5],
  ["negEmpty", (m) => m.negativeEmptyRate],
  ["leak", (m) => m.leakageRate],
  ["leakHits", (m) => String(m.leakedHits)],
  ["policyLeak", (m) => m.policyLeakage.rate],
  ["policyHits", (m) => String(m.policyLeakage.hits)],
  ["codeHit", (m) => m.codeHitRate],
  ["injP", (m) => m.injectionPrecision],
  ["offTopic", (m) => m.offTopicInjectionRate],
  ["fresh>stale", (m) => m.freshOverStaleRate],
  ["staleFlag", (m) => m.staleFlagRate],
  ["staleHit", (m) => m.staleHitRate],
];

const CONTEXT_COLUMNS: Array<[string, (m: MetricSet) => number | null | string]> = [
  ["pairs", (m) => String(m.pairs)],
  ["judged", (m) => String(m.contextCases)],
  ["inCtxRecall", (m) => m.inContextRecall],
  ["inCtxHit", (m) => m.inContextHit],
  ["staleCases", (m) => String(m.staleContextCases)],
  ["staleInCtx", (m) => m.staleInContext],
  ["leak", (m) => m.leakageRate],
  ["leakHits", (m) => String(m.leakedHits)],
  ["policyLeak", (m) => m.policyLeakage.rate],
  ["policyHits", (m) => String(m.policyLeakage.hits)],
];

function cell(v: number | null | string): string {
  if (v === null) return "–";
  if (typeof v === "string") return v;
  return v.toFixed(3);
}

function table(title: string, rows: Array<[string, MetricSet]>, columns = COLUMNS): string {
  const header = `| ${title} | ${columns.map(([n]) => n).join(" | ")} |`;
  const sep = `|${" --- |".repeat(columns.length + 1)}`;
  const body = rows.map(([name, m]) => `| ${name} | ${columns.map(([, f]) => cell(f(m))).join(" | ")} |`);
  return [header, sep, ...body].join("\n");
}

/** Set-metric rows for the context surfaces, overall and by split. */
function contextRows(m: EvalResults["metrics"]): Array<[string, MetricSet]> {
  const rows: Array<[string, MetricSet]> = [];
  for (const surface of CONTEXT_SURFACES) {
    if (!m.bySurface[surface]) continue;
    rows.push([surface, m.bySurface[surface]]);
    for (const [key, set] of Object.entries(m.bySurfaceSplit)) {
      if (key.startsWith(`${surface}/`)) rows.push([key, set]);
    }
  }
  return rows;
}

/** The compact stdout summary: metrics by surface, category, split and label, then integrity. */
export function formatMarkdown(r: EvalResults): string {
  const m = r.metrics;
  const i = r.integrity;
  const context = contextRows(m);
  const parts = [
    `## Knowledge eval — ${r.tier} tier (${r.label})`,
    "",
    table("surface", [["**overall**", m.overall], ...Object.entries(m.bySurface)]),
    "",
    ...(context.length > 0
      ? [
          "In-context docs (set metrics; not part of the ranked aggregates above):",
          "",
          table("context surface", context, CONTEXT_COLUMNS),
          "",
        ]
      : []),
    table("category", Object.entries(m.byCategory)),
    "",
    table("split / label", [...Object.entries(m.bySplit), ...Object.entries(m.byLabel)]),
    "",
    `**Index integrity:** ${i.docs} docs, ${i.ftsRows} fts rows (${i.orphanFtsRows} orphan, ` +
      `${i.docsStaleFts} docs stale, ${i.docsMissingFts} missing, ${i.docsDuplicateFts} duplicated); ` +
      `${i.chunks} chunks (${i.orphanChunks} orphan, ${i.tailChunks} tail, ${i.docsWithoutChunks} docs without chunks); ` +
      `vec ${i.vecEnabled ? `${i.vecRows} rows, ${i.vecChunkMismatch} mismatched` : "off"}; ` +
      `fingerprint ${JSON.stringify(i.embeddingFingerprint)} (model digest: ${i.fingerprintHasModelDigest ? "yes" : "no"})`,
    `**Policy leakage by rule (hits):** ${Object.entries(m.overall.policyLeakage.byRule)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")}`,
    `**Embeddings:** ${r.embeddings.hits} cache hits, ${r.embeddings.misses} misses, ${r.embeddings.fetched} fetched` +
      (r.config.embeddings ? "" : " (embeddings off)"),
    `**Env:** code search ${r.config.codeSearchBackend}${r.config.codeSearchBackend === "rg" ? "" : " (ripgrep missing; fallback engine)"}, vec ${r.config.vec ? "on" : "off"}, graph rerank ${r.config.graphRerank ? "on" : "off"}, now ${r.config.now}`,
  ];
  if (r.codeSearch) {
    const counts = (m: Record<string, number>) =>
      Object.keys(m)
        .sort()
        .map((k) => `${k} ${m[k]}`)
        .join(", ");
    parts.push(
      `**Code search (${r.codeSearch.cases} code cases):** ${counts(r.codeSearch.byStatus)}; by backend ${counts(r.codeSearch.byBackend)}` +
        (r.codeSearch.failing.length > 0 ? `; not run: ${r.codeSearch.failing.slice(0, 5).join("; ")}` : "")
    );
  }
  if (r.errors.length > 0) parts.push(`**Errors (${r.errors.length}):** ${r.errors.slice(0, 5).join("; ")}`);
  return parts.join("\n");
}
