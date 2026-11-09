// ============================================================================
// Pipeline presets — the named base flows a project's pipeline starts from.
//
// Every optional stage lives in one catalog (PIPELINE_CATALOG: the default
// pipeline plus the isolated live check); a preset is the first layer over it,
// switching stages off with `skip`. The owner's, the project's, the job's and
// the launch's layers then apply on top, so any of them can turn a stage back
// on or off — except that a layer naming a preset resets what the layers
// beneath it set (see resolvePipelineLayers). No node imports: the web
// bundles this file.
// ============================================================================

import {
  DEFAULT_PIPELINE,
  PIPELINE_PRESET_IDS,
  resolvePipeline,
  type PipelineDefinition,
  type PipelineOverride,
  type PipelinePresetId,
  type PipelineStageDef,
} from "./pipeline.js";
import { CODE_REVIEW_STAGE_KIND } from "./code-review.js";

const LIVE_CHECK_STAGE: PipelineStageDef = {
  id: "live_check",
  kind: "live_check",
  title: "Live check",
  required: true,
  description:
    "The change runs on an isolated collector (its own ports, env -i, a private tmux socket via -S — never the shared tmux server or the live collector) and representative live requests behave as expected.",
  skipWhen: [{ fact: "docs_only" }],
  skippable: true,
  edges: [
    { to: "deploy", when: { outcome: "passed" } },
    { to: "coding", when: { outcome: "failed" }, loop: { maxTraversals: 4 } },
  ],
};

/**
 * Every stage a pipeline may have, in order: the default pipeline with the
 * isolated live check between review and deploy. A preset or layer switches
 * the ones a flow doesn't use off.
 */
export const PIPELINE_CATALOG: PipelineDefinition = (() => {
  const stages = JSON.parse(JSON.stringify(DEFAULT_PIPELINE.stages)) as PipelineStageDef[];
  const review = stages.findIndex((s) => s.id === "review");
  for (const e of stages[review]!.edges) if (e.to === "deploy") e.to = "live_check";
  stages.splice(review + 1, 0, JSON.parse(JSON.stringify(LIVE_CHECK_STAGE)) as PipelineStageDef);
  return { version: 1, stages };
})();

export interface PipelinePreset {
  id: PipelinePresetId;
  title: string;
  description: string;
  /** The layer the preset puts first over PIPELINE_CATALOG. */
  layer: PipelineOverride;
  /**
   * Stages Persona may never skip, waive or close out on a run of the preset
   * while the project's pipeline still has them: they escalate to the owner.
   */
  protectedStages: readonly string[];
}

export const PIPELINE_PRESETS: Readonly<Record<PipelinePresetId, PipelinePreset>> = {
  full: {
    id: "full",
    title: "Full (deploy and code review)",
    description: "Code, tests, adversarial review, deploy to a personal dev environment with live validation, screenshots, a code review, and the review packet with its code review link.",
    layer: { stages: { live_check: { skip: true } } },
    protectedStages: [CODE_REVIEW_STAGE_KIND],
  },
  light: {
    id: "light",
    title: "Light (no code review to open)",
    description: "Code, tests, adversarial review, a live check on an isolated collector, screenshots for UI, and the review packet. No deploy and no code review.",
    layer: { stages: { deploy: { skip: true }, [CODE_REVIEW_STAGE_KIND]: { skip: true } } },
    protectedStages: [],
  },
};

export function isPipelinePresetId(v: unknown): v is PipelinePresetId {
  return typeof v === "string" && (PIPELINE_PRESET_IDS as readonly string[]).includes(v);
}

/** The preset the layers name — the last one that names one — else `auto`. */
export function pipelinePresetOf(
  layers: Array<PipelineOverride | null | undefined>,
  auto: PipelinePresetId
): PipelinePresetId {
  let preset = auto;
  for (const layer of layers) if (layer && isPipelinePresetId(layer.preset)) preset = layer.preset;
  return preset;
}

/**
 * Resolves `layers` (lowest first: the user's, the project's, the job's, the
 * launch's) over the catalog and the preset they name, or `auto` (the
 * project's own) when none does. The preset's layer applies immediately
 * before the last layer that names it — first when none does — so naming a
 * preset replaces what the layers beneath it set (a project layer naming
 * `light` drops the code_review stage a user layer turned on), while the naming
 * layer's own patches and every layer above it still win over the preset.
 * Throws PipelineConfigError like resolvePipeline; layer indexes in its
 * messages count the preset's layer where it was inserted.
 */
export function resolvePipelineLayers(
  layers: Array<PipelineOverride | null | undefined>,
  auto: PipelinePresetId
): { enabled: boolean; definition: PipelineDefinition; preset: PipelinePresetId } {
  const preset = pipelinePresetOf(layers, auto);
  let at = 0;
  layers.forEach((layer, i) => {
    if (layer && isPipelinePresetId(layer.preset)) at = i;
  });
  const ordered = [...layers.slice(0, at), PIPELINE_PRESETS[preset].layer, ...layers.slice(at)];
  const resolved = resolvePipeline(PIPELINE_CATALOG, ordered);
  return { ...resolved, preset };
}

/** The stages of `definition` a person reads — what a spec or layer became — leaving out start and complete. */
export function pipelineStageSummary(definition: PipelineDefinition): Array<{ id: string; title: string; required: boolean }> {
  return definition.stages
    .filter((s) => s.kind !== "start" && s.kind !== "complete")
    .map((s) => ({ id: s.id, title: s.title, required: s.required }));
}
