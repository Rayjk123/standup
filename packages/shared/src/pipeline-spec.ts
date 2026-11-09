// ============================================================================
// Plain-words pipeline specs — "for standup: no code review, isolated live check,
// review packet" — compiled to a PipelineOverride layer by a fixed phrase
// table. Deterministic on purpose: the owner can read what each clause became,
// and a clause the table doesn't know is refused, never guessed at. Persona
// translates freer phrasing into a structured override itself. No node
// imports: the web bundles this file.
// ============================================================================

import {
  MAX_EVIDENCE_STRING,
  MAX_PIPELINE_LOOP_TRAVERSALS,
  type PipelineOverride,
  type PipelinePresetId,
  type PipelineStagePatch,
} from "./pipeline.js";
import { CODE_REVIEW_STAGE_KIND } from "./code-review.js";

/** One clause of a spec and what it did to the layer. */
export interface PipelineSpecClause {
  text: string;
  effect: string;
}

export interface CompiledPipelineSpec {
  /** The layer the spec compiles to; its `spec` field carries the source text. */
  override: PipelineOverride;
  clauses: PipelineSpecClause[];
  /** Clauses no phrase matched; a spec with any is refused. */
  unknown: string[];
  /** The project a leading "for <project>:" named, as written. */
  project?: string;
}

/**
 * The stage ids a target phrase names. A bare "review" names no stage: it
 * could mean the code review ("code review" / "PR" / "pull request"), the
 * adversarial review ("adversarial review" / "reviewers" / "review rounds") or
 * the review packet ("review packet" / "human review"), so a clause that says
 * only "review" is refused rather than guessed at.
 */
const TARGETS: Array<{ stage: string; phrases: string[] }> = [
  {
    stage: CODE_REVIEW_STAGE_KIND,
    phrases: [
      "code review",
      "code reviews",
      "a code review",
      "code review stage",
      "code review link",
      "pr",
      "prs",
      "a pr",
      "pull request",
      "pull requests",
      "a pull request",
      "merge request",
      "merge requests",
    ],
  },
  {
    stage: "deploy",
    phrases: [
      "deploy",
      "deploys",
      "deployment",
      "deploy to personal",
      "deploy to my personal stack",
      "deploy to a personal stack",
      "deploy to personal stack",
      "deploy to my dev environment",
      "deploy to a dev environment",
      "deploy to dev",
      "personal deploy",
      "live validation",
      "deploy and live validation",
      "deploy and live-validate",
    ],
  },
  {
    stage: "live_check",
    phrases: [
      "live check",
      "live checks",
      "isolated live check",
      "isolated check",
      "isolated collector",
      "isolated collector check",
      "live check on an isolated collector",
      "live check on isolated collector",
    ],
  },
  {
    stage: "screenshot",
    phrases: ["screenshot", "screenshots", "desktop screenshots", "ui screenshots", "screenshots for ui", "screenshots of ui changes"],
  },
  { stage: "human_review", phrases: ["review packet", "a review packet", "human review", "packet", "owner review"] },
  { stage: "review", phrases: ["adversarial review", "adversarial reviews", "reviewers", "review rounds"] },
  { stage: "validation", phrases: ["validation", "tests", "typecheck", "build and tests", "tests and typecheck"] },
];

const PRESET_PHRASES: Array<{ preset: PipelinePresetId; phrases: string[] }> = [
  {
    preset: "full",
    phrases: ["full", "full flow", "full pipeline", "reviewed flow", "production flow", "production pipeline"],
  },
  {
    preset: "light",
    phrases: ["light", "light flow", "light pipeline", "lighter flow", "lightweight", "lightweight flow", "standup flow", "persona flow"],
  },
];

/**
 * Clauses that turn the code_review stage off, for help text (the console's
 * spec examples, the composer's pipeline help, a refusal's suggestions) that
 * points at them. Each compiles to `code_review: off`.
 */
export const CODE_REVIEW_OFF_PHRASES = ["no code review", "no PR", "no pull request"] as const;

/** Example clauses a refusal suggests in place of the ones the table couldn't map. */
const SPEC_EXAMPLES = [
  ...CODE_REVIEW_OFF_PHRASES,
  "isolated live check",
  "deploy to personal",
  "no screenshots",
  "review packet",
  "3 reviewers",
  "block on high",
  "max 3 rounds",
  "preset light",
];

const NEGATIONS = /^(?:no|skip|skips|skipping|without|drop|don't|dont|do not|never|not|disable|off)\s+/;
const AFFIRMATIONS = /^(?:with|add|require|requires|need|needs|keep|include|do|always|enable|use|and|then|plus)\s+/;

function normalize(clause: string): string {
  return clause
    .toLowerCase()
    .trim()
    .replace(/^(?:[-*•]|\d+[.)])\s+/, "")
    .replace(/[.!]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stageFor(phrase: string): string | undefined {
  const p = phrase.replace(/^(?:an?|the)\s+/, "").replace(/\s+stage$/, "");
  return TARGETS.find((t) => t.phrases.includes(p) || t.phrases.includes(phrase))?.stage;
}

function presetFor(phrase: string): PipelinePresetId | undefined {
  const p = phrase.replace(/^(?:the|a|use|preset:?)\s+/, "").replace(/\s+preset$/, "");
  return PRESET_PHRASES.find((t) => t.phrases.includes(p))?.preset;
}

/**
 * Compiles a plain-words spec to a pipeline layer. Clauses split on commas,
 * semicolons, newlines and " and then "; a leading "for <project>:" is
 * reported, not applied. Recognized clauses: a preset ("full", "production
 * flow", "light", "standup flow"); a stage on or off ("no code review", "no
 * PR", "isolated live check", "deploy to personal", "no screenshots", "review
 * packet", "no adversarial review"); "N reviewers"; "block on high|medium";
 * "max N rounds".
 * A positive live check turns deploy off unless the spec asks for a deploy too.
 */
export function compilePipelineSpec(text: string): CompiledPipelineSpec {
  const source = text.slice(0, MAX_EVIDENCE_STRING);
  let body = source.trim();
  let project: string | undefined;
  const forProject = /^for\s+([^:\n]{1,80}):\s*/i.exec(body);
  if (forProject) {
    project = forProject[1]!.trim();
    body = body.slice(forProject[0].length);
  }

  const stages: Record<string, PipelineStagePatch> = {};
  const clauses: PipelineSpecClause[] = [];
  const unknown: string[] = [];
  let preset: PipelinePresetId | undefined;
  let maxRounds: number | undefined;
  let deployAsked = false;
  let liveCheckOn = false;
  const patch = (id: string, p: PipelineStagePatch) => (stages[id] = { ...stages[id], ...p });

  const parts = body
    .split(/[,;\n]|\s+and then\s+/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const raw of parts) {
    const clause = normalize(raw);
    if (!clause) continue;

    const asPreset = presetFor(clause);
    if (asPreset) {
      preset = asPreset;
      clauses.push({ text: raw, effect: `preset ${asPreset}` });
      continue;
    }

    const reviewers = /^(?:at least\s+)?(\d{1,2})\s+(?:independent\s+|adversarial\s+)?reviewers?$/.exec(clause);
    if (reviewers) {
      const n = Number(reviewers[1]);
      if (n >= 1) {
        patch("review", { minReviewers: n });
        clauses.push({ text: raw, effect: `review: at least ${n} reviewer(s)` });
        continue;
      }
    }

    const blockOn = /^block(?:s|ing)? (?:only )?on (high|medium)(?: findings| severity)?$/.exec(clause);
    if (blockOn) {
      patch("review", { blockOn: blockOn[1] as "high" | "medium" });
      clauses.push({ text: raw, effect: `review: blocks on ${blockOn[1]} and above` });
      continue;
    }

    const rounds = /^(?:max|at most|up to)\s+(\d{1,2})\s+(?:rework\s+|review\s+|fix\s+)?(?:rounds?|loops?)$/.exec(clause);
    if (rounds) {
      const n = Number(rounds[1]);
      if (n >= 1 && n <= MAX_PIPELINE_LOOP_TRAVERSALS) {
        maxRounds = n;
        clauses.push({ text: raw, effect: `rework loops: at most ${n} round(s)` });
        continue;
      }
    }

    const negated = NEGATIONS.exec(clause);
    const target = negated ? clause.slice(negated[0].length) : clause.replace(AFFIRMATIONS, "");
    const stage = stageFor(target);
    if (!stage) {
      unknown.push(raw);
      continue;
    }
    if (negated) {
      patch(stage, { skip: true });
      if (stage === "live_check") liveCheckOn = false;
      clauses.push({ text: raw, effect: `${stage}: off` });
    } else {
      patch(stage, { skip: false });
      if (stage === "deploy") deployAsked = true;
      if (stage === "live_check") liveCheckOn = true;
      clauses.push({ text: raw, effect: `${stage}: on` });
    }
  }
  if (liveCheckOn && !deployAsked && stages.deploy?.skip === undefined) {
    patch("deploy", { skip: true });
    clauses.push({ text: "(isolated live check)", effect: "deploy: off — the live check stands in for it" });
  }

  const override: PipelineOverride = { spec: source.trim() };
  if (preset) override.preset = preset;
  if (maxRounds !== undefined) override.maxRounds = maxRounds;
  if (Object.keys(stages).length > 0) override.stages = stages;
  return { override, clauses, unknown, ...(project ? { project } : {}) };
}

const projectWords = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * Whether the project a spec's "for <project>:" names (`named`) is
 * `project`. Compared case-insensitively and ignoring everything but letters
 * and digits, it must be the project's id or its full name, or the leading
 * words of its id ("standup" names "standup-self", "stand" doesn't).
 */
export function specNamesProject(named: string, project: { id: string; name?: string | null }): boolean {
  const words = projectWords(named);
  if (words.length === 0) return false;
  const flat = words.join("");
  const id = projectWords(project.id);
  if (flat === id.join("") || (project.name && flat === projectWords(project.name).join(""))) return true;
  return words.length <= id.length && words.every((w, i) => id[i] === w);
}

/**
 * Why a layer compiled from a spec naming `compiled.project` can't be set
 * where it is being set, or null: a spec for one project never goes on the
 * owner's own layer (`target` null), and on a project's, job's or launch's
 * layer it must name that project (specNamesProject). A job not yet tied to
 * a project (`target` undefined) takes it as written.
 */
export function specProjectRefusal(
  compiled: Pick<CompiledPipelineSpec, "project"> | undefined,
  target: { id: string; name?: string | null } | null | undefined
): string | null {
  const named = compiled?.project;
  if (!named || target === undefined) return null;
  if (!target) return `this spec is for ${named}; set it on that project`;
  return specNamesProject(named, target) ? null : `this spec is for ${named}, not ${target.id}; set it on that project`;
}

/**
 * What a pipeline layer touches, as the words of the phrase table name them:
 * the ids of the stages it patches or adds, its preset, "rounds" for
 * `maxRounds` and "pipeline" for `enabled`.
 */
export function pipelineLayerTouches(layer: PipelineOverride): string[] {
  const touched = new Set<string>(Object.keys(layer.stages ?? {}));
  for (const added of Array.isArray(layer.add) ? layer.add : []) {
    if (added && typeof added.stage?.id === "string") touched.add(added.stage.id);
  }
  if (layer.preset) touched.add(layer.preset);
  if (layer.maxRounds !== undefined) touched.add("rounds");
  if (layer.enabled !== undefined) touched.add("pipeline");
  return [...touched];
}

/** Words that name what a layer touches beyond the phrase table's stages and presets (see pipelineLayerTouches). */
const EXTRA_TERMS: Array<{ term: string; pattern: RegExp }> = [
  { term: "review", pattern: /\b(?:reviews?|reviewers?|block(?:s|ing)?\s+on)\b/ },
  { term: "rounds", pattern: /\b(?:rounds?|loops?)\b/ },
  { term: "pipeline", pattern: /\b(?:pipelines?|flows?)\b/ },
];

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The stage ids, preset ids and terms (see pipelineLayerTouches) `text`
 * names in the phrase table's words — longest phrase first, so "code review"
 * names code_review and "review packet" names human_review, not review.
 */
export function pipelineTermsNamed(text: string): Set<string> {
  let rest = ` ${text.toLowerCase().replace(/\s+/g, " ")} `;
  const named = new Set<string>();
  const phrases = [
    ...TARGETS.flatMap((t) => t.phrases.map((p) => ({ term: t.stage, p }))),
    ...PRESET_PHRASES.flatMap((t) => t.phrases.map((p) => ({ term: t.preset as string, p }))),
  ].sort((a, b) => b.p.length - a.p.length);
  for (const { term, p } of phrases) {
    const re = new RegExp(`(?<![a-z0-9])${escapeRegExp(p)}(?![a-z0-9])`, "g");
    if (re.test(rest)) {
      named.add(term);
      rest = rest.replace(re, " ");
    }
  }
  for (const { term, pattern } of EXTRA_TERMS) if (pattern.test(rest)) named.add(term);
  return named;
}

/**
 * A layer from a request that carries a plain-words `spec`, a structured
 * `override`, or both (the override's fields win over the spec's, stage by
 * stage). Returns the refusal for a spec with clauses it couldn't map, or for
 * neither being given.
 */
export function pipelineLayerFromInput(input: {
  spec?: unknown;
  override?: unknown;
}): { ok: true; override: PipelineOverride; compiled?: CompiledPipelineSpec } | { ok: false; error: string; unknown?: string[] } {
  const hasSpec = typeof input.spec === "string" && input.spec.trim().length > 0;
  const hasOverride = input.override !== undefined && input.override !== null;
  if (input.spec !== undefined && input.spec !== null && typeof input.spec !== "string") {
    return { ok: false, error: "spec must be a string" };
  }
  if (!hasSpec && !hasOverride) return { ok: false, error: "give a plain-words spec or a structured override" };
  if (hasOverride && (typeof input.override !== "object" || Array.isArray(input.override))) {
    return { ok: false, error: "override must be an object {preset?, enabled?, stages?, add?}" };
  }
  if (!hasSpec) return { ok: true, override: input.override as PipelineOverride };
  const compiled = compilePipelineSpec(input.spec as string);
  if (compiled.unknown.length > 0) {
    return {
      ok: false,
      error: `couldn't map ${compiled.unknown.length} clause(s) of the spec to a stage: ${compiled.unknown.map((u) => `"${u}"`).join(", ")} — rephrase them (e.g. ${SPEC_EXAMPLES.map((e) => `"${e}"`).join(", ")}) or give a structured override`,
      unknown: compiled.unknown,
    };
  }
  if (!hasOverride) return { ok: true, override: compiled.override, compiled };
  const extra = input.override as PipelineOverride;
  const stages: Record<string, PipelineStagePatch> = { ...compiled.override.stages };
  for (const [id, p] of Object.entries(extra.stages ?? {})) stages[id] = { ...stages[id], ...p };
  const override: PipelineOverride = { ...compiled.override, ...extra, spec: compiled.override.spec };
  if (Object.keys(stages).length > 0) override.stages = stages;
  return { ok: true, override, compiled };
}
