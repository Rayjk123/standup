// ============================================================================
// Persona job budgets — the time and spend a job may use (its workers'
// sessions plus Persona's own turns on it) before Persona is told and new
// launches for it wait on the owner. A budget resolves per dimension from the
// job's own value, else the owner's layer for the job's project, else the
// owner's global layer, else JOB_BUDGET_DEFAULTS. Every layer is scoped to the
// owner: one user's settings never reach another user's jobs.
// ============================================================================

/**
 * The built-in budget of a job no layer sets: USD and wall-clock minutes,
 * null for no limit. Spend has no limit unless the owner sets one.
 */
export const JOB_BUDGET_DEFAULTS: { readonly usd: number | null; readonly minutes: number | null } = { usd: null, minutes: 480 };

/** The share of a budget at which Persona is told the job is near it. */
export const JOB_BUDGET_NEAR_FRACTION = 0.8;

/** Upper bounds a budget value is validated against. */
export const JOB_BUDGET_MAX_USD = 10_000;
export const JOB_BUDGET_MAX_MINUTES = 60 * 24 * 30;

/**
 * One layer of budget settings. Per dimension: a number sets it (0 means no
 * limit on that dimension), absent or null leaves it to the layer beneath.
 */
export interface JobBudgetLayer {
  usd?: number | null;
  minutes?: number | null;
}

/** Where a resolved budget dimension came from. */
export type JobBudgetSource = "job" | "project" | "user" | "default";

/** A job's budget after layering: null on a dimension means no limit. */
export interface ResolvedJobBudget {
  usd: number | null;
  minutes: number | null;
  source: { usd: JobBudgetSource; minutes: JobBudgetSource };
}

/** How far a job is through its budget. */
export type JobBudgetLevel = "ok" | "near" | "exceeded";

/** A job's budget as served on the job: the resolved limits, the spend and time used, and the level. */
export interface PersonaJobBudget extends ResolvedJobBudget {
  /** Persona's turns attributed to the job plus its workers' cost (as of `checkedAt`). */
  spentUsd: number;
  personaUsd: number;
  workerUsd: number;
  /** Wall-clock minutes since the job opened (until it closed, for a closed job), less time spent waiting on the owner. */
  elapsedMinutes: number;
  level: JobBudgetLevel;
  /** When the workers' cost was last read from their transcripts; absent before the first check. */
  checkedAt?: string;
}

function layerValue(v: number | null | undefined): number | null | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Number.isFinite(v) || v < 0) return undefined;
  return v === 0 ? null : v;
}

/**
 * Resolves a job's budget from its layers, the most specific first: the job's
 * own values, the owner's layer for the job's project, the owner's global
 * layer. A dimension no layer sets takes JOB_BUDGET_DEFAULTS.
 */
export function resolveJobBudget(layers: {
  job?: JobBudgetLayer | null;
  project?: JobBudgetLayer | null;
  user?: JobBudgetLayer | null;
}): ResolvedJobBudget {
  const pick = (key: "usd" | "minutes"): { value: number | null; source: JobBudgetSource } => {
    for (const source of ["job", "project", "user"] as const) {
      const value = layerValue(layers[source]?.[key]);
      if (value !== undefined) return { value, source };
    }
    return { value: JOB_BUDGET_DEFAULTS[key], source: "default" };
  };
  const usd = pick("usd");
  const minutes = pick("minutes");
  return { usd: usd.value, minutes: minutes.value, source: { usd: usd.source, minutes: minutes.source } };
}

/** The larger of the spend and time shares used, 0 when neither dimension has a limit. */
export function jobBudgetFraction(budget: Pick<ResolvedJobBudget, "usd" | "minutes">, spentUsd: number, elapsedMinutes: number): number {
  const usd = budget.usd ? spentUsd / budget.usd : 0;
  const minutes = budget.minutes ? elapsedMinutes / budget.minutes : 0;
  return Math.max(usd, minutes);
}

/** The level a job's use puts it at: exceeded at 100%, near from JOB_BUDGET_NEAR_FRACTION. */
export function jobBudgetLevel(budget: Pick<ResolvedJobBudget, "usd" | "minutes">, spentUsd: number, elapsedMinutes: number): JobBudgetLevel {
  const fraction = jobBudgetFraction(budget, spentUsd, elapsedMinutes);
  if (fraction >= 1) return "exceeded";
  if (fraction >= JOB_BUDGET_NEAR_FRACTION) return "near";
  return "ok";
}

/**
 * How `next` gives a job more than `current` — per dimension, a higher limit,
 * or no limit where there was one — described ("$5.00 → $10.00"); null when
 * it gives no more on either dimension.
 */
export function jobBudgetRaise(current: Pick<ResolvedJobBudget, "usd" | "minutes">, next: Pick<ResolvedJobBudget, "usd" | "minutes">): string | null {
  const parts: string[] = [];
  const usd = (v: number | null) => (v === null ? "no limit" : `$${v.toFixed(2)}`);
  const min = (v: number | null) => (v === null ? "no limit" : formatMinutes(v));
  const raises = (a: number | null, b: number | null) => a !== null && (b === null || b > a);
  if (raises(current.usd, next.usd)) parts.push(`spend ${usd(current.usd)} → ${usd(next.usd)}`);
  if (raises(current.minutes, next.minutes)) parts.push(`time ${min(current.minutes)} → ${min(next.minutes)}`);
  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * Validates one budget value from a request: a non-negative number within the
 * dimension's bound, or null/absent to clear it. Returns the error, or null.
 */
export function jobBudgetValueError(key: "usd" | "minutes", v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const max = key === "usd" ? JOB_BUDGET_MAX_USD : JOB_BUDGET_MAX_MINUTES;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > max) {
    return `${key} must be a number from 0 (no limit) to ${max}, or null to inherit`;
  }
  return null;
}

/** "$1.20 of $1.00 · 35m of 8h" — the job's use against each limited dimension. */
export function describeJobBudget(b: Pick<PersonaJobBudget, "usd" | "minutes" | "spentUsd" | "elapsedMinutes">): string {
  const parts: string[] = [];
  if (b.usd !== null) parts.push(`$${b.spentUsd.toFixed(2)} of $${b.usd.toFixed(2)}`);
  if (b.minutes !== null) parts.push(`${formatMinutes(b.elapsedMinutes)} of ${formatMinutes(b.minutes)}`);
  return parts.length > 0 ? parts.join(" · ") : `$${b.spentUsd.toFixed(2)}, no limit`;
}

/** 35 → "35m", 90 → "1h 30m", 480 → "8h". */
export function formatMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h}h ${rest}m` : `${h}h`;
}

/** Persona's own spend for one user, served on /api/usage/me. */
export interface PersonaUsage {
  turns: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** The user's jobs with their budgets, newest first. */
  jobs: PersonaJobSpend[];
}

/** One job's line in the per-job breakdown. */
export interface PersonaJobSpend {
  jobId: string;
  title: string;
  status: string;
  budget: PersonaJobBudget;
}
