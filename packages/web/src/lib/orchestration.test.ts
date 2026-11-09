import { expect, test, describe } from "bun:test";
import type { OrchestrationProfile } from "@standup/shared";
import {
  STEP_KINDS,
  STEP_KIND_LABELS,
  newStepDraft,
  stepToDraft,
  stepDraftToStep,
  profileToForm,
  blankProfileForm,
  formToDefinition,
  moveStep,
  removeStep,
  validateProfileForm,
  type ProfileForm,
  type StepDraft,
} from "./orchestration";

/**
 * The orchestration step-editor's pure logic — the step kinds it offers, the
 * add/remove/reorder operations, the draft <-> stored-step round trip, and the
 * client validation mirror. The web package has no component-test harness (see
 * knowledgeScope.test), so these pin the editor's contract at the logic level.
 */

describe("step kinds offered", () => {
  test("exactly the three offered kinds, each labeled (human_pause is not offered)", () => {
    expect([...STEP_KINDS].sort()).toEqual(["deploy", "gate", "review"]);
    for (const k of STEP_KINDS) expect(STEP_KIND_LABELS[k]).toBeTruthy();
  });

  test("a fresh draft of each offered kind carries that kind's blank fields", () => {
    expect(newStepDraft("gate")).toEqual({ kind: "gate", name: "", command: "" });
    expect(newStepDraft("deploy")).toEqual({ kind: "deploy", account: "", role: "", command: "" });
    expect(newStepDraft("review")).toEqual({ kind: "review", rounds: "", blockOnSeverity: "", lens: "" });
  });
});

describe("add / remove / reorder steps", () => {
  const steps: StepDraft[] = [
    { kind: "gate", name: "a", command: "true" },
    { kind: "review", rounds: "", blockOnSeverity: "", lens: "" },
    { kind: "human_pause", prompt: "wait" },
  ];

  test("moveStep down swaps with the next; up swaps with the previous", () => {
    expect(moveStep(steps, 0, 1).map((s) => s.kind)).toEqual(["review", "gate", "human_pause"]);
    expect(moveStep(steps, 2, -1).map((s) => s.kind)).toEqual(["gate", "human_pause", "review"]);
  });

  test("moveStep past either end is a no-op (returns an unchanged copy)", () => {
    expect(moveStep(steps, 0, -1).map((s) => s.kind)).toEqual(["gate", "review", "human_pause"]);
    expect(moveStep(steps, 2, 1).map((s) => s.kind)).toEqual(["gate", "review", "human_pause"]);
  });

  test("moveStep does not mutate its input", () => {
    const before = steps.map((s) => s.kind);
    moveStep(steps, 0, 1);
    expect(steps.map((s) => s.kind)).toEqual(before);
  });

  test("removeStep drops exactly the indexed step", () => {
    expect(removeStep(steps, 1).map((s) => s.kind)).toEqual(["gate", "human_pause"]);
    expect(removeStep(steps, 1)).toHaveLength(2);
  });
});

describe("draft -> stored step serialization", () => {
  test("gate trims name and command", () => {
    expect(stepDraftToStep({ kind: "gate", name: " build ", command: " bun run build " })).toEqual({
      kind: "gate",
      name: "build",
      command: "bun run build",
    });
  });

  test("deploy folds account/role/command into a target, omitting blanks", () => {
    expect(
      stepDraftToStep({ kind: "deploy", account: "111122223333", role: "", command: "npx cdk deploy" })
    ).toEqual({ kind: "deploy", target: { account: "111122223333", command: "npx cdk deploy" } });
  });

  test("a fully-blank deploy serializes to no target (server then rejects it)", () => {
    expect(stepDraftToStep({ kind: "deploy", account: "", role: "", command: "" })).toEqual({
      kind: "deploy",
    });
  });

  test("review parses rounds and drops empty severity/lens", () => {
    expect(
      stepDraftToStep({ kind: "review", rounds: "3", blockOnSeverity: "high", lens: "security" })
    ).toEqual({ kind: "review", rounds: 3, blockOnSeverity: "high", lens: "security" });
    expect(stepDraftToStep({ kind: "review", rounds: "", blockOnSeverity: "", lens: "" })).toEqual({
      kind: "review",
    });
  });

  test("human_pause trims the prompt", () => {
    expect(stepDraftToStep({ kind: "human_pause", prompt: " confirm? " })).toEqual({
      kind: "human_pause",
      prompt: "confirm?",
    });
  });

  test("stepToDraft hydrates a stored step's fields as editable strings", () => {
    expect(stepToDraft({ kind: "review", rounds: 2, blockOnSeverity: "medium", lens: "perf" })).toEqual({
      kind: "review",
      rounds: "2",
      blockOnSeverity: "medium",
      lens: "perf",
    });
    expect(stepToDraft({ kind: "deploy", target: { account: "9", command: "go" } })).toEqual({
      kind: "deploy",
      account: "9",
      role: "",
      command: "go",
    });
  });
});

describe("stored profile -> form round trip", () => {
  const profile: OrchestrationProfile = {
    name: "ship-safely",
    scope: "project",
    steps: [
      { kind: "gate", name: "build", command: "bun run build" },
      { kind: "deploy", target: { account: "1", role: "Admin", command: "deploy" } },
      { kind: "review", rounds: 2, blockOnSeverity: "medium", lens: "bugs" },
    ],
    maxReviewRounds: 3,
    blockOnSeverity: "high",
  };

  test("profileToForm hydrates name, drafts, and profile-level fields as strings", () => {
    const form = profileToForm(profile);
    expect(form.originalName).toBe("ship-safely");
    expect(form.name).toBe("ship-safely");
    expect(form.maxReviewRounds).toBe("3");
    expect(form.blockOnSeverity).toBe("high");
    expect(form.steps.map((s) => s.kind)).toEqual(["gate", "deploy", "review"]);
    const deploy = form.steps[1];
    expect(deploy).toEqual({ kind: "deploy", account: "1", role: "Admin", command: "deploy" });
  });

  test("formToDefinition reproduces the stored definition", () => {
    const def = formToDefinition(profileToForm(profile));
    expect(def).toEqual({
      steps: profile.steps,
      maxReviewRounds: 3,
      blockOnSeverity: "high",
    });
  });

  test("a blank form serializes to an empty step list and no profile-level options", () => {
    expect(formToDefinition(blankProfileForm())).toEqual({ steps: [] });
  });
});

describe("client validation mirror", () => {
  const base = (over: Partial<ProfileForm>): ProfileForm => ({ ...blankProfileForm(), name: "p", ...over });

  test("a well-formed profile passes", () => {
    expect(
      validateProfileForm(
        base({ steps: [{ kind: "gate", name: "b", command: "true" }], maxReviewRounds: "3" })
      )
    ).toBeNull();
  });

  test("name rules match the server's wording", () => {
    expect(validateProfileForm(base({ name: "  " }))).toBe("name is required");
    expect(validateProfileForm(base({ name: "a/b" }))).toBe("name must not contain '/'");
    expect(validateProfileForm(base({ name: "a".repeat(201) }))).toBe(
      "name must be at most 200 characters"
    );
    expect(validateProfileForm(base({ name: "a\tb" }))).toBe(
      "name must not contain control characters"
    );
  });

  test("maxReviewRounds must be a positive integer when set", () => {
    expect(validateProfileForm(base({ maxReviewRounds: "0" }))).toBe(
      "maxReviewRounds must be a positive integer"
    );
    expect(validateProfileForm(base({ maxReviewRounds: "2" }))).toBeNull();
  });

  test("per-kind required fields are enforced with indexed messages", () => {
    expect(validateProfileForm(base({ steps: [{ kind: "gate", name: "", command: "x" }] }))).toBe(
      "step 0 (gate): name is required"
    );
    expect(validateProfileForm(base({ steps: [{ kind: "gate", name: "n", command: "" }] }))).toBe(
      "step 0 (gate): command is required"
    );
    expect(
      validateProfileForm(base({ steps: [{ kind: "deploy", account: "", role: "", command: "" }] }))
    ).toBe("step 0 (deploy): a target or a command is required");
    expect(
      validateProfileForm(
        base({ steps: [{ kind: "review", rounds: "-1", blockOnSeverity: "", lens: "" }] })
      )
    ).toBe("step 0 (review): rounds must be a positive integer");
  });

  test("rejects a human_pause step — deferred until a resume mechanism exists", () => {
    expect(validateProfileForm(base({ steps: [{ kind: "human_pause", prompt: "confirm?" }] }))).toBe(
      "step 0 (human_pause): human_pause steps are not yet supported (a resume mechanism is coming); remove this step"
    );
  });

  test("a deploy with any one of account/role/command is accepted", () => {
    expect(
      validateProfileForm(base({ steps: [{ kind: "deploy", account: "1", role: "", command: "" }] }))
    ).toBeNull();
  });
});
