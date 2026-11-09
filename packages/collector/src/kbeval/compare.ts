import { aggregate, type PairMetrics } from "./metrics.js";
import {
  INTEGRITY_VIOLATION_KEYS,
  type CodeSearchSummary,
  type IntegrityReport,
  type MetricSet,
} from "./types.js";

/** The slice of a results file the gate compares. */
export interface Comparable {
  provenance: { casesLockHash: string };
  config: {
    /**
     * Engine the code surface would search with on the run's host. Optional because
     * a reference may record only whether `rg` was installed (`ripgrep`), which
     * carries no backend to compare against.
     */
    codeSearchBackend?: string;
    vec: boolean;
  };
  metrics: { overall: MetricSet; bySurface: Record<string, MetricSet> };
  integrity: IntegrityReport;
  /** Per-case code-search outcomes; optional in a reference recorded without them. */
  codeSearch?: CodeSearchSummary;
  /** Per-case metrics by surface, which an exception is checked against. */
  cases?: Array<{ id: string; surfaces: Record<string, { metrics: PairMetrics }> }>;
  /** Approved regressions the gate tolerates (recorded in the reference). */
  exceptions?: GateException[];
}

/**
 * One approved regression: a ranked metric of one surface that may drop
 * because of one case. The gate ignores the drop only when recomputing the
 * metric without that case (in both runs) leaves no violation, and fails when
 * that case's own value falls below the value recorded at approval.
 */
export interface GateException {
  surface: string;
  metric: (typeof RANKED_KEYS)[number];
  caseId: string;
  reason: string;
  approvedBy: string;
  /** The case's own value of the metric on the surface when the exception was recorded. */
  recordedValue: number;
}

/** What the host offers code search in the fixture repo (see probeCodeSearchHost). */
export interface CodeSearchHost {
  /** `git --version` as major.minor.patch, or null when git cannot run. */
  gitVersion: string | null;
  /** Whether the fixture repo is inside a git work tree. */
  insideWorkTree: boolean;
  /** Untracked, non-ignored files under the fixture repo, which every engine searches. */
  untracked: string[];
}

/** Oldest git whose `git grep` takes `-m`, which the code surface's per-file match cap needs. */
export const GIT_GREP_MIN_VERSION: readonly [number, number] = [2, 38];

/**
 * Why this host cannot reproduce the reference's code-search conditions, each
 * a gate failure naming its cause. A `git-grep` reference needs runnable git
 * of at least GIT_GREP_MIN_VERSION and a fixture repo inside a git checkout;
 * without them searches fall back to the JS walker and the code surface is
 * not comparable. Untracked files in the fixture repo change what any engine
 * searches, so they fail the gate whatever the reference's engine.
 */
export function codeSearchHostViolations(referenceBackend: string | undefined, host: CodeSearchHost): string[] {
  const out: string[] = [];
  if (referenceBackend === "git-grep") {
    const unavailable = (why: string) =>
      out.push(`reference code-search engine git-grep is unavailable on this host: ${why}; the code surface is not comparable`);
    const version = host.gitVersion?.match(/^(\d+)\.(\d+)/);
    if (host.gitVersion === null) unavailable("git cannot run");
    else if (
      version &&
      (Number(version[1]) < GIT_GREP_MIN_VERSION[0] ||
        (Number(version[1]) === GIT_GREP_MIN_VERSION[0] && Number(version[2]) < GIT_GREP_MIN_VERSION[1]))
    ) {
      unavailable(`git ${host.gitVersion} lacks \`git grep -m\` (needs ${GIT_GREP_MIN_VERSION.join(".")}+)`);
    }
    if (!host.insideWorkTree) unavailable("the fixture repo is not inside a git checkout");
  }
  if (host.untracked.length > 0) {
    const shown = host.untracked.slice(0, 5).join(", ") + (host.untracked.length > 5 ? ", …" : "");
    out.push(
      `fixture repo has ${host.untracked.length} untracked file(s) the code search reads (${shown}); commit or remove them`
    );
  }
  return out;
}

/** Absolute drops tolerated before the gate fails. */
export const RANKED_DROP_TOLERANCE = 0.02;
export const NEGATIVE_DROP_TOLERANCE = 0.03;

/** Absolute change tolerated in a context surface's set metrics. */
export const CONTEXT_TOLERANCE = 0.02;

export const RANKED_KEYS = ["recallAt5", "mrrAt10", "ndcgAt10", "pAt5"] as const;
const CONTEXT_KEYS = ["inContextRecall", "inContextHit"] as const;
const EPS = 1e-9;

/** Integrity counts the gate ratchets on, with the fingerprint check folded in as 0/1. */
export function integrityViolations(report: IntegrityReport): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of INTEGRITY_VIOLATION_KEYS) out[key] = report[key] ?? 0;
  out.fingerprintWithoutModelDigest =
    report.embeddingFingerprint !== null && !report.fingerprintHasModelDigest ? 1 : 0;
  return out;
}

function compareSet(label: string, cur: MetricSet, ref: MetricSet, out: string[]): void {
  for (const key of RANKED_KEYS) {
    const a = cur[key];
    const b = ref[key];
    if (a === null || b === null) {
      if (b !== null && a === null) out.push(`${label}.${key}: was ${b}, now not measured`);
      continue;
    }
    if (a < b - RANKED_DROP_TOLERANCE - EPS) {
      out.push(`${label}.${key} dropped ${b} → ${a} (tolerance ${RANKED_DROP_TOLERANCE})`);
    }
  }
  for (const key of CONTEXT_KEYS) {
    const a = cur[key] ?? null;
    const b = ref[key] ?? null;
    if (b !== null && a === null) out.push(`${label}.${key}: was ${b}, now not measured`);
    else if (a !== null && b !== null && a < b - CONTEXT_TOLERANCE - EPS) {
      out.push(`${label}.${key} dropped ${b} → ${a} (tolerance ${CONTEXT_TOLERANCE})`);
    }
  }
  const sa = cur.staleInContext ?? null;
  const sb = ref.staleInContext ?? null;
  if (sa !== null && sb !== null && sa > sb + CONTEXT_TOLERANCE + EPS) {
    out.push(`${label}.staleInContext increased ${sb} → ${sa} (tolerance ${CONTEXT_TOLERANCE})`);
  }
  const na = cur.negativeEmptyRate;
  const nb = ref.negativeEmptyRate;
  if (na !== null && nb !== null && na < nb - NEGATIVE_DROP_TOLERANCE - EPS) {
    out.push(`${label}.negativeEmptyRate dropped ${nb} → ${na} (tolerance ${NEGATIVE_DROP_TOLERANCE})`);
  }
  if (cur.leakageRate !== null && ref.leakageRate !== null && cur.leakageRate > ref.leakageRate + EPS) {
    out.push(`${label}.leakageRate increased ${ref.leakageRate} → ${cur.leakageRate}`);
  }
  if (cur.leakedHits > ref.leakedHits) {
    out.push(`${label}.leakedHits increased ${ref.leakedHits} → ${cur.leakedHits}`);
  }
  const pc = cur.policyLeakage;
  const pr = ref.policyLeakage;
  if (pc && pr) {
    if (pc.rate !== null && pr.rate !== null && pc.rate > pr.rate + EPS) {
      out.push(`${label}.policyLeakage.rate increased ${pr.rate} → ${pc.rate}`);
    }
    if (pc.hits > pr.hits) out.push(`${label}.policyLeakage.hits increased ${pr.hits} → ${pc.hits}`);
    for (const rule of Object.keys(pc.byRule).sort()) {
      if ((pc.byRule[rule] ?? 0) > (pr.byRule[rule] ?? 0)) {
        out.push(`${label}.policyLeakage.byRule.${rule} increased ${pr.byRule[rule] ?? 0} → ${pc.byRule[rule]}`);
      }
    }
  }
}

/**
 * Every way `current` regresses against the `reference` run: ranked metrics
 * dropping by more than the tolerance (overall and per surface), a context
 * surface's in-context recall or hit rate dropping or its
 * stale-in-context rate rising by more than the tolerance, the negative
 * empty-rate dropping, any leakage increase, any
 * integrity count increase, a different cases.lock, or a different code-search
 * environment — including any `code`-surface case whose search did not run as
 * ok/degraded, or a per-case backend mix that differs from the reference's.
 */
export function compareResults(current: Comparable, reference: Comparable): string[] {
  const out: string[] = [];
  if (current.provenance.casesLockHash !== reference.provenance.casesLockHash) {
    out.push(
      `cases.lock differs from the reference (${reference.provenance.casesLockHash.slice(0, 12)} → ${current.provenance.casesLockHash.slice(0, 12)}); re-baseline deliberately`
    );
  }
  if (
    reference.config.codeSearchBackend !== undefined &&
    current.config.codeSearchBackend !== reference.config.codeSearchBackend
  ) {
    out.push(
      `code-search backend differs from the reference run (${reference.config.codeSearchBackend} → ${current.config.codeSearchBackend}); the code surface is not comparable`
    );
  }
  compareCodeSearch(current.codeSearch, reference.codeSearch, out);
  if (current.config.vec !== reference.config.vec) {
    out.push(`sqlite-vec setting differs from the reference run (${reference.config.vec} → ${current.config.vec})`);
  }
  compareSet("overall", current.metrics.overall, reference.metrics.overall, out);
  for (const surface of Object.keys(reference.metrics.bySurface).sort()) {
    const cur = current.metrics.bySurface[surface];
    if (!cur) {
      out.push(`surface ${surface} is in the reference but was not run`);
      continue;
    }
    compareSet(surface, cur, reference.metrics.bySurface[surface], out);
  }
  const ci = integrityViolations(current.integrity);
  const ri = integrityViolations(reference.integrity);
  for (const key of Object.keys(ci).sort()) {
    if ((ci[key] ?? 0) > (ri[key] ?? 0)) out.push(`integrity.${key} increased ${ri[key] ?? 0} → ${ci[key]}`);
  }
  return applyExceptions(current, reference, out);
}

/** The pair metrics of every case but `caseId`, all of them or one surface's. */
function pairsWithout(run: Comparable, caseId: string, surface: string | null): PairMetrics[] {
  const out: PairMetrics[] = [];
  for (const c of run.cases ?? []) {
    if (c.id === caseId) continue;
    for (const [s, entry] of Object.entries(c.surfaces)) {
      if (surface === null || s === surface) out.push(entry.metrics);
    }
  }
  return out;
}

/** A case's own value of a ranked metric on one surface, or null when it has none. */
export function caseMetricValue(
  run: Pick<Comparable, "cases">,
  surface: string,
  metric: GateException["metric"],
  caseId: string
): number | null {
  const metrics = run.cases?.find((c) => c.id === caseId)?.surfaces[surface]?.metrics;
  if (!metrics) return null;
  return metrics[metric] ?? null;
}

/**
 * Drops the violations the reference's exceptions fully explain. A violation of
 * `<surface>.<metric>` (or `overall.<metric>`) is explained when the metric,
 * recomputed in both runs without the excepted case, no longer violates. Each
 * exception also fails the gate on its own when the case's current value is
 * below the value recorded at approval, or when the case is gone.
 */
function applyExceptions(current: Comparable, reference: Comparable, violations: string[]): string[] {
  const exceptions = reference.exceptions ?? [];
  if (exceptions.length === 0) return violations;
  let out = violations;
  const extra: string[] = [];
  for (const e of exceptions) {
    const now = caseMetricValue(current, e.surface, e.metric, e.caseId);
    if (now === null) {
      extra.push(`exception ${e.surface}.${e.metric} for case ${e.caseId}: the case was not measured on ${e.surface}`);
    } else if (now < e.recordedValue - EPS) {
      extra.push(
        `exception ${e.surface}.${e.metric} for case ${e.caseId} got worse: ${e.recordedValue} → ${now}`
      );
    }
    if (!current.cases || !reference.cases) continue;
    for (const label of [e.surface, "overall"]) {
      const prefix = `${label}.${e.metric} dropped `;
      if (!out.some((v) => v.startsWith(prefix))) continue;
      const scope = label === "overall" ? null : label;
      const recomputed: string[] = [];
      compareSet(
        label,
        aggregate(pairsWithout(current, e.caseId, scope)),
        aggregate(pairsWithout(reference, e.caseId, scope)),
        recomputed
      );
      if (!recomputed.some((v) => v.startsWith(prefix))) out = out.filter((v) => !v.startsWith(prefix));
    }
  }
  return [...out, ...extra];
}

/**
 * Parses `--exception <surface:metric:caseId:reason>` into an exception
 * recorded against `run`, with the case's current value as its floor.
 */
export function parseException(spec: string, approvedBy: string, run: Pick<Comparable, "cases">): GateException {
  const [surface, metric, caseId, ...rest] = spec.split(":");
  const reason = rest.join(":").trim();
  if (!surface || !metric || !caseId || !reason) {
    throw new Error(`--exception needs surface:metric:caseId:reason, got "${spec}"`);
  }
  if (!(RANKED_KEYS as readonly string[]).includes(metric)) {
    throw new Error(`--exception metric must be one of ${RANKED_KEYS.join(", ")}, got "${metric}"`);
  }
  const value = caseMetricValue(run, surface, metric as GateException["metric"], caseId);
  if (value === null) throw new Error(`--exception: case ${caseId} has no ${metric} on ${surface} in this run`);
  return { surface, metric: metric as GateException["metric"], caseId, reason, approvedBy, recordedValue: value };
}

/**
 * The code surface's per-case outcomes. Every `code` case must have searched
 * (status ok or degraded) whatever the reference holds — a reference recorded
 * without per-case outcomes still gets this check rather than skipping it — and
 * when the reference has them, the count of cases per backend must match.
 */
function compareCodeSearch(
  current: CodeSearchSummary | undefined,
  reference: CodeSearchSummary | undefined,
  out: string[]
): void {
  if (!current) {
    out.push("code-search outcomes were not recorded for this run; the code surface is unverified");
    return;
  }
  for (const failing of current.failing) out.push(`code search did not run for ${failing}`);
  if (!reference) return;
  const backends = [...new Set([...Object.keys(current.byBackend), ...Object.keys(reference.byBackend)])].sort();
  const differs = backends.some((b) => (current.byBackend[b] ?? 0) !== (reference.byBackend[b] ?? 0));
  if (differs) {
    const show = (m: Record<string, number>) =>
      backends.map((b) => `${b}=${m[b] ?? 0}`).join(", ");
    out.push(`code-search backend mix differs from the reference (${show(reference.byBackend)} → ${show(current.byBackend)})`);
  }
}
