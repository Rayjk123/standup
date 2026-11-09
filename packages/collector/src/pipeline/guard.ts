import { CODE_REVIEW_STAGE_KIND, DEFAULT_BLOCK_ON, DEFAULT_MIN_REVIEWERS, DEFAULT_MIN_SCREENSHOTS, DEFAULT_UI_PATHS, HUMAN_REVIEW_STAGE_KIND } from "@standup/shared";
import type { PipelineDefinition, PipelinePresetId, PipelineStageDef } from "@standup/shared";
import { canonicalJson } from "../floor/gate.js";
import { definitionUiPaths } from "./runners.js";

/**
 * The guard on what Persona does to a pipeline: a layer it sets may reshape a
 * project's flow, but not weaken the stages the owner relies on. The check
 * compares the pipeline as it resolves before and after the change — never
 * the layer's shape — so a preset, a skip, a rerouted edge or a disabled
 * pipeline all read the same way.
 */

/** Stage kinds Persona may not weaken on any project's pipeline. */
export const ALWAYS_GUARDED_KINDS: readonly string[] = ["validation", "review", HUMAN_REVIEW_STAGE_KIND];

/** Stage kinds Persona may not weaken where the project's own preset is full. */
export const FULL_GUARDED_KINDS: readonly string[] = [CODE_REVIEW_STAGE_KIND, "deploy", "screenshot"];

/** The reason a change to a stage's validation checks carries: only the owner sets them. */
export const CHECKS_REASON = "validation checks are the owner's to set";

/**
 * The reason a change to the review tunnel carries: its commands (`setup`,
 * `serve`) run on the owner's host and its access list (`allow`, `region`,
 * `namePattern`) decides who reaches the branch build, so only the owner
 * sets them.
 */
export const REVIEW_TUNNEL_REASON = "review tunnel settings are the owner's to set";

/**
 * The stage kinds guarded on a project whose own preset is `autoPreset`
 * (null: the project isn't known yet, so only the kinds every project
 * guards).
 */
export function guardedStageKinds(autoPreset: PipelinePresetId | null): string[] {
  return [...ALWAYS_GUARDED_KINDS, ...(autoPreset === "full" ? FULL_GUARDED_KINDS : [])];
}

/**
 * The stages reachable from `from` (start when absent) along any edge — any
 * outcome, any fact — never entering `without`.
 */
function reachable(def: PipelineDefinition, opts: { from?: string; without?: string } = {}): Set<string> {
  const byId = new Map(def.stages.map((s) => [s.id, s]));
  const from = opts.from ?? def.stages.find((s) => s.kind === "start")?.id;
  const seen = new Set<string>();
  const queue = from !== undefined && from !== opts.without ? [from] : [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const stage = byId.get(id);
    if (!stage) continue;
    for (const e of stage.edges) if (e.to !== opts.without && !seen.has(e.to)) queue.push(e.to);
  }
  return seen;
}

function completeId(def: PipelineDefinition): string | undefined {
  return def.stages.find((s) => s.kind === "complete")?.id;
}

/** Whether a run can reach complete along any edges without passing through `id`. */
function bypassable(def: PipelineDefinition, id: string): boolean {
  const complete = completeId(def);
  return complete !== undefined && reachable(def, { without: id }).has(complete);
}

/**
 * Where a failed outcome at `stage` may lead, as planTransition takes it: the
 * targets of its edges in order that can match a failed outcome under some
 * facts (an edge with no outcome condition matches it too), up to the first
 * one that matches it whatever the facts are.
 */
function failedTargets(stage: PipelineStageDef): string[] {
  const targets: string[] = [];
  for (const e of stage.edges) {
    if (e.when?.outcome === "passed") continue;
    targets.push(e.to);
    if (e.when?.fact === undefined) break;
  }
  return targets;
}

/**
 * The failed-outcome targets of `stage` from which a run can reach complete
 * without passing through the stage again: a failure there moves on past it
 * instead of looping back to work that must pass it.
 */
function leakingFailures(def: PipelineDefinition, stage: PipelineStageDef): string[] {
  const complete = completeId(def);
  if (complete === undefined) return [];
  return failedTargets(stage).filter((to) => to === complete || reachable(def, { from: to, without: stage.id }).has(complete));
}

/** The value a stage that omits a `min*` threshold gets; one not listed reads as 0. */
const MIN_FIELD_DEFAULTS: Readonly<Record<string, number>> = {
  minReviewers: DEFAULT_MIN_REVIEWERS,
  minScreenshots: DEFAULT_MIN_SCREENSHOTS,
};

const MIN_FIELD = /^min[A-Z]/;

/** A stage's `min*` threshold `key`, or the default it gets when it omits it. */
function minThreshold(stage: PipelineStageDef, key: string): number {
  const value = (stage as unknown as Record<string, unknown>)[key];
  return typeof value === "number" ? value : (MIN_FIELD_DEFAULTS[key] ?? 0);
}

/** The words a person reads for a lower `min*` threshold. */
function fewer(id: string, key: string, now: number, was: number): string {
  if (key === "minReviewers") return `${id} needs fewer reviewers (${now} instead of ${was})`;
  if (key === "minScreenshots") return `${id} needs fewer screenshots (${now} instead of ${was})`;
  return `${id} lowers ${key} (${now} instead of ${was})`;
}

/** The globs a change is read as UI by: `paths`, or the defaults when there are none (as computeFacts takes them). */
function uiGlobs(paths: readonly string[] | undefined): readonly string[] {
  return paths && paths.length > 0 ? paths : DEFAULT_UI_PATHS;
}

/**
 * Whether UI paths `after` stop counting a glob `before` counted as UI. Only
 * dropping one weakens: added globs read more changes as UI, which asks for
 * more screenshots, not fewer.
 */
function uiPathsNarrow(before: readonly string[] | undefined, after: readonly string[] | undefined): boolean {
  const now = new Set(uiGlobs(after));
  return uiGlobs(before).some((g) => !now.has(g));
}

/** Whether a stage's skip conditions read `ui_changed`, which the definition's UI paths decide. */
function readsUiChanged(stage: PipelineStageDef): boolean {
  return (stage.skipWhen ?? []).some((c) => c.fact === "ui_changed");
}

/**
 * How `after` weakens `before` (resolved pipelines) for the stages of the
 * `guarded` kinds, in words a person reads; empty when it doesn't. Paths are
 * read along every edge, whatever outcome or fact it is taken on. A guarded
 * stage of `before` weakens when `after` removes it, makes it unreachable from
 * start, lets a run reach complete around it, sends its failure somewhere a
 * run can complete from without passing it again (on, not back), makes it no
 * longer required, makes it skippable or adds conditions that skip it, stops
 * it running as an outward step or asking the owner's gate, lowers any of its
 * `min*` thresholds, or drops a glob from its UI paths (or, for a stage that
 * skips on `ui_changed`, from the UI paths that set that fact) — adding one
 * only reads more changes as UI; a review stage also weakens
 * when it blocks only on high findings. Attempt caps and loop bounds don't
 * count: a run that runs out of them stops and waits. A pipeline turned off
 * weakens all of them, and any stage whose validation checks differ reads
 * CHECKS_REASON: checks are the owner's alone. Likewise a resolved review
 * tunnel that differs in any field reads REVIEW_TUNNEL_REASON.
 */
export function definitionWeakens(
  before: { enabled: boolean; definition: PipelineDefinition },
  after: { enabled: boolean; definition: PipelineDefinition },
  guarded: readonly string[]
): string[] {
  if (before.enabled && !after.enabled) return ["the pipeline is turned off"];
  const reasons: string[] = [];
  const afterById = new Map(after.definition.stages.map((s) => [s.id, s]));
  const beforeById = new Map(before.definition.stages.map((s) => [s.id, s]));
  const reachedBefore = reachable(before.definition);
  const reachedAfter = reachable(after.definition);
  for (const s of before.definition.stages) {
    if (!guarded.includes(s.kind)) continue;
    const a = afterById.get(s.id);
    if (!a) {
      reasons.push(`${s.id} is removed`);
      continue;
    }
    if (reachedBefore.has(s.id) && !reachedAfter.has(s.id)) {
      reasons.push(`${s.id} can no longer be reached`);
      continue;
    }
    if (!bypassable(before.definition, s.id) && bypassable(after.definition, s.id)) {
      // Every way out of a stage a run can go around leads on without it; that one reason covers them.
      reasons.push(`${s.id} can be routed around`);
    } else {
      const leakedBefore = new Set(leakingFailures(before.definition, s));
      const leaked = leakingFailures(after.definition, a).filter((to) => !leakedBefore.has(to));
      if (leaked.length > 0) reasons.push(`a failed ${s.id} goes on to ${leaked.join(", ")} instead of back`);
    }
    if (s.required && !a.required) reasons.push(`${s.id} is no longer required`);
    if (!s.skippable && a.skippable) reasons.push(`${s.id} becomes skippable`);
    const conditions = new Set((s.skipWhen ?? []).map((c) => canonicalJson(c)));
    if ((a.skipWhen ?? []).some((c) => !conditions.has(canonicalJson(c)))) reasons.push(`${s.id} gets new conditions that skip it`);
    if (s.outward && !a.outward) reasons.push(`${s.id} no longer runs as an outward step`);
    if (s.requireOwnerGate && !a.requireOwnerGate) reasons.push(`${s.id} no longer asks the owner's gate`);
    const minKeys = new Set([...Object.keys(s), ...Object.keys(a)].filter((k) => MIN_FIELD.test(k)));
    for (const key of minKeys) {
      const was = minThreshold(s, key);
      const now = minThreshold(a, key);
      if (now < was) reasons.push(fewer(s.id, key, now, was));
    }
    if (s.kind === "review" && (s.blockOn ?? DEFAULT_BLOCK_ON) === "medium" && (a.blockOn ?? DEFAULT_BLOCK_ON) === "high") {
      reasons.push(`${s.id} blocks only on high findings (was medium)`);
    }
    const definitionUiBefore = definitionUiPaths(before.definition);
    const definitionUiAfter = definitionUiPaths(after.definition);
    if (
      canonicalJson(s.uiPaths ?? null) !== canonicalJson(a.uiPaths ?? null) &&
      uiPathsNarrow(s.uiPaths ?? definitionUiBefore, a.uiPaths ?? definitionUiAfter)
    ) {
      reasons.push(`${s.id}'s UI paths change`);
    } else if ((readsUiChanged(s) || readsUiChanged(a)) && uiPathsNarrow(definitionUiBefore, definitionUiAfter)) {
      reasons.push(`the UI paths that decide whether ${s.id} applies change`);
    }
  }
  const checksChanged = after.definition.stages.some(
    (a) => canonicalJson(a.checks ?? []) !== canonicalJson(beforeById.get(a.id)?.checks ?? [])
  );
  if (checksChanged) reasons.push(CHECKS_REASON);
  if (canonicalJson(after.definition.reviewTunnel ?? null) !== canonicalJson(before.definition.reviewTunnel ?? null)) {
    reasons.push(REVIEW_TUNNEL_REASON);
  }
  return reasons;
}
