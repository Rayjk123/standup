import type {
  DeployTarget,
  OrchestrationProfile,
  OrchestrationStep,
} from "@standup/shared";

/** The two severities a review step (or a whole profile) may block on. */
export type OrchestrationSeverity = "high" | "medium";

/** The discriminant of an orchestration step. */
export type StepKind = OrchestrationStep["kind"];

/**
 * A form-friendly draft of one step: every field is a string (and severities a
 * `"" | high | medium` select value) so an input stays controlled even mid-edit,
 * before it parses to a number or narrows to a real step. Serialized to an
 * `OrchestrationStep` on Save by {@link stepDraftToStep}.
 */
export type StepDraft =
  | { kind: "gate"; name: string; command: string }
  | { kind: "deploy"; account: string; role: string; command: string }
  | { kind: "review"; rounds: string; blockOnSeverity: "" | OrchestrationSeverity; lens: string }
  | { kind: "human_pause"; prompt: string };

/**
 * The whole editor's working state for one profile. `originalName` is the name
 * the profile loaded under (null for a brand-new one) — it identifies the row an
 * edit replaces and is what keeps the name field fixed on an existing profile
 * (the store has no rename; a changed name would upsert a second profile).
 */
export interface ProfileForm {
  originalName: string | null;
  name: string;
  steps: StepDraft[];
  maxReviewRounds: string;
  blockOnSeverity: "" | OrchestrationSeverity;
}

/** The body of the PUT /api/orchestration/profiles `definition`. */
export interface ProfileDefinitionBody {
  steps: OrchestrationStep[];
  maxReviewRounds?: number;
  blockOnSeverity?: OrchestrationSeverity;
}

/**
 * The step kinds the add-step selector offers, in order. `human_pause` is a
 * valid stored kind (a legacy profile may carry one) but is intentionally NOT
 * offered: it has no resume mechanism yet, so a run parked on it would lock the
 * ticket's completion choke. Validation rejects a new profile that includes one.
 */
export const STEP_KINDS: StepKind[] = ["gate", "deploy", "review"];

/** Human-readable one-liners for each step kind, for the kind selector. */
export const STEP_KIND_LABELS: Record<StepKind, string> = {
  gate: "Gate — shell command must exit 0",
  deploy: "Deploy — run a deploy, must exit 0",
  review: "Review — bounded adversarial loop",
  human_pause: "Human pause — park and await a person",
};

/** Longest profile name the store accepts (it is a URL segment + storage key). */
export const MAX_ORCH_PROFILE_NAME_LENGTH = 200;

/** A fresh, empty draft for a newly added step of the given kind. */
export function newStepDraft(kind: StepKind): StepDraft {
  switch (kind) {
    case "gate":
      return { kind: "gate", name: "", command: "" };
    case "deploy":
      return { kind: "deploy", account: "", role: "", command: "" };
    case "review":
      return { kind: "review", rounds: "", blockOnSeverity: "", lens: "" };
    case "human_pause":
      return { kind: "human_pause", prompt: "" };
  }
}

/** Hydrate a stored step into its editable draft. */
export function stepToDraft(step: OrchestrationStep): StepDraft {
  switch (step.kind) {
    case "gate":
      return { kind: "gate", name: step.name ?? "", command: step.command ?? "" };
    case "deploy":
      return {
        kind: "deploy",
        account: step.target?.account ?? "",
        role: step.target?.role ?? "",
        // The single command field maps to the deploy target's command, falling
        // back to a step-level command a profile authored elsewhere may carry.
        command: step.target?.command ?? step.command ?? "",
      };
    case "review":
      return {
        kind: "review",
        rounds: step.rounds != null ? String(step.rounds) : "",
        blockOnSeverity: step.blockOnSeverity ?? "",
        lens: step.lens ?? "",
      };
    case "human_pause":
      return { kind: "human_pause", prompt: step.prompt ?? "" };
  }
}

/** Serialize one draft to the `OrchestrationStep` shape the API stores. */
export function stepDraftToStep(draft: StepDraft): OrchestrationStep {
  switch (draft.kind) {
    case "gate":
      return { kind: "gate", name: draft.name.trim(), command: draft.command.trim() };
    case "deploy": {
      const target: DeployTarget = {};
      if (draft.account.trim()) target.account = draft.account.trim();
      if (draft.role.trim()) target.role = draft.role.trim();
      if (draft.command.trim()) target.command = draft.command.trim();
      const step: Extract<OrchestrationStep, { kind: "deploy" }> = { kind: "deploy" };
      // Only attach a target when a field is set — an empty target is meaningless
      // and, unlike the server's lenient check, our client rejects it up front.
      if (Object.keys(target).length > 0) step.target = target;
      return step;
    }
    case "review": {
      const step: Extract<OrchestrationStep, { kind: "review" }> = { kind: "review" };
      const rounds = draft.rounds.trim();
      if (rounds) step.rounds = Number(rounds);
      if (draft.blockOnSeverity) step.blockOnSeverity = draft.blockOnSeverity;
      if (draft.lens.trim()) step.lens = draft.lens.trim();
      return step;
    }
    case "human_pause":
      return { kind: "human_pause", prompt: draft.prompt.trim() };
  }
}

/** Load an existing profile into the editor form. */
export function profileToForm(profile: OrchestrationProfile): ProfileForm {
  return {
    originalName: profile.name,
    name: profile.name,
    steps: (profile.steps ?? []).map(stepToDraft),
    maxReviewRounds: profile.maxReviewRounds != null ? String(profile.maxReviewRounds) : "",
    blockOnSeverity: profile.blockOnSeverity ?? "",
  };
}

/** A blank form for authoring a new profile. */
export function blankProfileForm(): ProfileForm {
  return { originalName: null, name: "", steps: [], maxReviewRounds: "", blockOnSeverity: "" };
}

/** Build the PUT body's `definition` from the form, dropping empty optionals. */
export function formToDefinition(form: ProfileForm): ProfileDefinitionBody {
  const def: ProfileDefinitionBody = { steps: form.steps.map(stepDraftToStep) };
  const mrr = form.maxReviewRounds.trim();
  if (mrr) def.maxReviewRounds = Number(mrr);
  if (form.blockOnSeverity) def.blockOnSeverity = form.blockOnSeverity;
  return def;
}

/** Swap the step at `index` with its neighbor in `dir` (-1 up, +1 down). */
export function moveStep<T>(steps: readonly T[], index: number, dir: -1 | 1): T[] {
  const next = [...steps];
  const target = index + dir;
  if (index < 0 || index >= next.length || target < 0 || target >= next.length) {
    return next;
  }
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** Remove the step at `index`. */
export function removeStep<T>(steps: readonly T[], index: number): T[] {
  return steps.filter((_, i) => i !== index);
}

function hasControlChar(s: string): boolean {
  return Array.from(s).some((ch) => {
    const code = ch.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
}

/** True for a blank string or one that parses to a positive integer. */
function isBlankOrPositiveInt(raw: string): boolean {
  const t = raw.trim();
  if (!t) return true;
  const n = Number(t);
  return Number.isInteger(n) && n > 0;
}

/**
 * Client mirror of validateOrchestrationProfileDefinition in @standup/store:
 * returns the first failure's message (matching the server's wording so the
 * inline error reads the same whichever side catches it), or null when valid.
 * The server stays the source of truth — this just spares an obviously-bad
 * round-trip.
 */
export function validateProfileForm(form: ProfileForm): string | null {
  const name = form.name.trim();
  if (!name) return "name is required";
  if (name.length > MAX_ORCH_PROFILE_NAME_LENGTH) {
    return `name must be at most ${MAX_ORCH_PROFILE_NAME_LENGTH} characters`;
  }
  if (name.includes("/")) return "name must not contain '/'";
  if (hasControlChar(name)) return "name must not contain control characters";

  if (!isBlankOrPositiveInt(form.maxReviewRounds)) {
    return "maxReviewRounds must be a positive integer";
  }

  for (let i = 0; i < form.steps.length; i++) {
    const s = form.steps[i];
    switch (s.kind) {
      case "gate":
        if (!s.name.trim()) return `step ${i} (gate): name is required`;
        if (!s.command.trim()) return `step ${i} (gate): command is required`;
        break;
      case "deploy":
        if (!s.account.trim() && !s.role.trim() && !s.command.trim()) {
          return `step ${i} (deploy): a target or a command is required`;
        }
        break;
      case "review":
        if (!isBlankOrPositiveInt(s.rounds)) {
          return `step ${i} (review): rounds must be a positive integer`;
        }
        break;
      case "human_pause":
        return `step ${i} (human_pause): human_pause steps are not yet supported (a resume mechanism is coming); remove this step`;
    }
  }
  return null;
}
