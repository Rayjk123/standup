/**
 * The composer's launch-time model/effort controls. Claude and Codex have
 * distinct model spaces and effort ladders, and the two spaces don't overlap — so
 * the MODEL a launch picks is what names its harness, and one model list can
 * carry both. Picking a Codex id drives Codex; picking a Claude value (or a
 * pinned id) drives Claude; picking nothing leaves the harness to the project.
 * The effort ladder follows from that same resolution.
 *
 * This module carries the decision as pure logic — the web package has no
 * component-test harness, so the option sets, the harness derivation, and the
 * control gate are pinned here (the same pattern knowledgeScope.ts uses for the
 * scope control).
 */
import {
  CLAUDE_MODELS,
  CODEX_DEFAULT_EFFORT,
  CODEX_EFFORTS,
  CODEX_MODEL_CATALOG,
  CODEX_MODELS,
} from "@standup/shared";
import type { ClaudeEffort, ClaudeModel, CodexEffort, CodexModelInfo, HarnessId } from "@standup/shared";

/** Claude effort levels, lowest to highest — the values `claude --effort` and `/effort` accept. */
export const CLAUDE_EFFORTS: ClaudeEffort[] = ["low", "medium", "high", "xhigh", "max"];

/** Codex reasoning-effort options, in the order the control offers them; `xhigh` reads "X-high", as Claude's does. */
export const CODEX_EFFORT_OPTIONS: { value: CodexEffort; label: string }[] = CODEX_EFFORTS.map(
  (value) => ({ value, label: value === "xhigh" ? "X-high" : value.charAt(0).toUpperCase() + value.slice(1) })
);

/**
 * Codex model options, in the order the control offers them, plus the free-text
 * escape hatch's placeholder. The list mirrors CODEX_MODEL_CATALOG (empty by
 * default) and is a convenience, not an allowlist — the control
 * also offers "Other…" for any id the list doesn't carry, and asserting no model
 * at all leaves the Codex CLI's own configured model in place. Each label names
 * the id too, since the id is what reaches `codex exec -m`.
 */
export const CODEX_MODEL_OPTIONS: { value: string; label: string }[] = CODEX_MODEL_CATALOG.map(
  (m) => ({ value: m.id, label: `${m.label}${m.recommended ? " (recommended)" : ""} · ${m.id}` })
);

/**
 * The reasoning-effort options a Codex model takes, in ladder order: the
 * catalog's own levels for a model it names, every level for any other id (a
 * free-form id's levels aren't known, and the CLI is the judge).
 */
export function codexEffortOptions(
  modelId: string,
  catalog: readonly CodexModelInfo[] = CODEX_MODEL_CATALOG
): { value: CodexEffort; label: string }[] {
  const efforts = catalog.find((m) => m.id === modelId)?.efforts;
  return efforts ? CODEX_EFFORT_OPTIONS.filter((o) => efforts.includes(o.value)) : CODEX_EFFORT_OPTIONS;
}

/**
 * The effort a Codex launch sends for a model: the chosen one when the model
 * takes it, else the default when it takes that, else the model's lowest level —
 * so switching models never sends a level the new model rejects.
 */
export function codexEffortFor(
  modelId: string,
  chosen: CodexEffort,
  catalog: readonly CodexModelInfo[] = CODEX_MODEL_CATALOG
): CodexEffort {
  const options = codexEffortOptions(modelId, catalog).map((o) => o.value);
  if (options.includes(chosen)) return chosen;
  if (options.includes(CODEX_DEFAULT_EFFORT)) return CODEX_DEFAULT_EFFORT;
  return options[0] ?? chosen;
}

/**
 * What the Codex free-text model input shows when empty: the first offered id
 * as an example, else a hint. Never a default.
 */
export const CODEX_MODEL_PLACEHOLDER = CODEX_MODELS[0] ?? "Codex model id";

/**
 * Claude model options, grouped by family in the order the controls offer them:
 * each family's `latest` alias first, then that family's pinned versions. The
 * VALUE is what `claude --model` (and the running session's `/model`) receives
 * verbatim — an alias tracks the newest model in the family, a pinned id holds
 * one version, which is the whole point of offering both.
 *
 * Derived from CLAUDE_MODELS so the labels can never drift from the set the
 * server validates against: a family alias is labeled "<Family> (latest)", a
 * pinned id "<Family> <version>" (`claude-opus-4-8` → "Opus 4.8").
 */
export const CLAUDE_MODEL_GROUPS: {
  family: string;
  options: { value: ClaudeModel; label: string }[];
}[] = groupClaudeModels(CLAUDE_MODELS);

/** The same Claude model options, flattened — for controls that show one list. */
export const CLAUDE_MODEL_OPTIONS: { value: ClaudeModel; label: string }[] =
  CLAUDE_MODEL_GROUPS.flatMap((g) => g.options);

/**
 * Splits a Claude model value into its family and (for a versioned one) its
 * dotted version: `opus` → Opus/undefined, `claude-opus-4-8` → Opus/"4.8",
 * `claude-haiku-4-5-20251001` → Haiku/"4.5". Returns no family for anything that
 * names none, so a caller can fall back to the raw value.
 */
function parseClaudeModel(value: string): { family?: string; version?: string } {
  // Each version segment is at most two digits and must not run into more of
  // them — that lookahead is what keeps an 8-digit date stamp out of the version
  // (`claude-opus-5-20260101` is Opus 5, not "Opus 5.20").
  const match = /(opus|sonnet|haiku|fable)(?:-(\d{1,2})(?!\d))?(?:-(\d{1,2})(?!\d))?/.exec(
    value.toLowerCase()
  );
  if (!match) return {};
  const family = match[1].charAt(0).toUpperCase() + match[1].slice(1);
  const version = match[2] ? [match[2], match[3]].filter(Boolean).join(".") : undefined;
  return { family, version };
}

/**
 * The display name for a Claude model value, whichever form it takes: a family
 * alias reads "<Family> (latest)" (it tracks the newest model, so naming a
 * version would be a lie), a versioned id reads "<Family> <version>"
 * (`claude-opus-4-8` → "Opus 4.8"). Anything that names no family falls back to
 * the raw value rather than hiding it.
 */
export function claudeModelLabel(value: string): string {
  const { family, version } = parseClaudeModel(value);
  if (!family) return value;
  return version ? `${family} ${version}` : `${family} (latest)`;
}

function groupClaudeModels(
  models: ClaudeModel[]
): { family: string; options: { value: ClaudeModel; label: string }[] }[] {
  const groups: { family: string; options: { value: ClaudeModel; label: string }[] }[] = [];
  for (const value of models) {
    const family = parseClaudeModel(value).family ?? value;
    const option = { value, label: claudeModelLabel(value) };
    const group = groups.find((g) => g.family === family);
    if (group) group.options.push(option);
    else groups.push({ family, options: [option] });
  }
  return groups;
}

/** The Codex reasoning effort the control pre-selects. */
export const CODEX_DEFAULT_EFFORT_VALUE: CodexEffort = CODEX_DEFAULT_EFFORT;

/**
 * "Codex, whatever model it's configured for" — the Codex counterpart to a Claude
 * family alias. It names the harness while asserting no model, so no `-m` is
 * passed and the Codex CLI's own `model` (from ~/.codex/config.toml) governs. A
 * sentinel for the picker, never a model id: launchCodexModel() maps it to
 * undefined so it can't reach `codex exec -m`.
 */
export const CODEX_DEFAULT_MODEL_VALUE = "codex";

/**
 * Every model a launch can pick, grouped in the order the control offers them:
 * each Claude family (its `latest` alias, then its pinned versions), then Codex.
 * One list rather than a model control behind a harness control — the two model
 * spaces are disjoint, so the pick alone says which CLI to drive, and a separate
 * harness picker could only contradict it.
 */
export const LAUNCH_MODEL_GROUPS: {
  family: string;
  harness: HarnessId;
  options: { value: string; label: string }[];
}[] = [
  ...CLAUDE_MODEL_GROUPS.map((group) => ({
    family: group.family,
    harness: "claude" as HarnessId,
    options: group.options.map((o) => ({ value: o.value as string, label: o.label })),
  })),
  {
    family: "Codex",
    harness: "codex" as HarnessId,
    options: [
      { value: CODEX_DEFAULT_MODEL_VALUE, label: "Codex (its own model)" },
      ...CODEX_MODEL_OPTIONS,
    ],
  },
];

/**
 * The harness a picked model implies, or undefined when nothing is picked (the
 * project's own default then governs). Claude's model space is the closed
 * CLAUDE_MODELS set, so anything else that names a model is a Codex id —
 * including one typed into the free-text entry, which is why this asks the Claude
 * set rather than the Codex convenience list.
 */
export function launchModelHarness(value: string): HarnessId | undefined {
  if (!value) return undefined;
  if (value === CODEX_DEFAULT_MODEL_VALUE) return "codex";
  return (CLAUDE_MODELS as string[]).includes(value) ? "claude" : "codex";
}

/** The `claude --model` value a pick asserts, if the pick is a Claude one at all. */
export function launchClaudeModel(value: string): ClaudeModel | undefined {
  return launchModelHarness(value) === "claude" ? (value as ClaudeModel) : undefined;
}

/** The `codex exec -m` id a pick asserts — none for the harness-only sentinel. */
export function launchCodexModel(value: string): string | undefined {
  if (launchModelHarness(value) !== "codex") return undefined;
  return value === CODEX_DEFAULT_MODEL_VALUE ? undefined : value;
}

/**
 * The display name for any picked model value: a Claude value reads as its
 * family/version (`claude-opus-4-8` → "Opus 4.8"), a Codex id in
 * CODEX_MODEL_CATALOG reads as its catalog label, any other Codex id reads
 * verbatim, and an empty pick reads "default".
 */
export function launchModelLabel(value: string): string {
  if (!value) return "default";
  if (value === CODEX_DEFAULT_MODEL_VALUE) return "Codex";
  if (launchModelHarness(value) === "claude") return claudeModelLabel(value);
  return CODEX_MODEL_CATALOG.find((m) => m.id === value)?.label ?? value;
}

/**
 * Which harness's effort ladder the composer should show, resolved
 * most-specific-wins: the harness the picked model implies (see
 * launchModelHarness), else the selected project's own harness default, else
 * Claude (the default harness). So an untouched composer shows the ladder for
 * whatever a launch would actually spawn — Codex's reasoning levels only when the
 * launch will drive Codex.
 */
export function launchControlKind(
  modelHarness: HarnessId | "",
  projectHarness: HarnessId | undefined
): "claude" | "codex" {
  const effective = modelHarness || projectHarness || "claude";
  return effective === "codex" ? "codex" : "claude";
}

/**
 * The model + effort labels a launch/session row shows, resolved per harness. A
 * Codex launch has its OWN free-form model + reasoning-effort columns
 * (codexModel/codexEffort) and never carries the Claude `--model`/`--effort`
 * fields, so a codex row must read its own columns — otherwise it falls back to
 * the (always-unset) Claude fields and shows "default", never its real model.
 *
 * Precedence: the live value observed from the session's own transcript/events
 * wins when present (a mid-session `/model` or `/effort` change is ground truth);
 * else the launch-persisted value for the RESOLVED harness (codex → codexModel/
 * codexEffort, claude → model/effort); else "default".
 *
 * `modelLabel` (callers pass claudeModelLabel) prettifies a Claude model value
 * (`claude-opus-4-8` → "Opus 4.8"), and is applied to the live value AND to a
 * persisted Claude model — a launch may pin a full model id, so showing that
 * column raw would put `claude-opus-4-8` in the pill. Never applied to a Codex
 * id, which is free-form and shown verbatim. Taken as a parameter so a test can
 * mark what the labeler touched.
 */
export function launchModelEffortLabels(
  row: {
    harness?: HarnessId;
    liveModel?: string;
    liveEffort?: string;
    model?: string;
    effort?: string;
    codexModel?: string;
    codexEffort?: string;
  },
  modelLabel: (value: string) => string
): { model: string; effort: string } {
  const isCodex = row.harness === "codex";
  const model = row.liveModel
    ? modelLabel(row.liveModel)
    : isCodex
      ? row.codexModel ?? "default"
      : row.model
        ? modelLabel(row.model)
        : "default";
  const effort = row.liveEffort ?? (isCodex ? row.codexEffort : row.effort) ?? "default";
  return { model, effort };
}
