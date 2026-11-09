import { expect, test, describe } from "bun:test";
import { CLAUDE_MODELS, CODEX_MODELS } from "@standup/shared";
import type { ClaudeModel, CodexEffort, CodexModelInfo } from "@standup/shared";
import {
  CLAUDE_MODEL_GROUPS,
  CLAUDE_MODEL_OPTIONS,
  CODEX_DEFAULT_EFFORT_VALUE,
  CODEX_DEFAULT_MODEL_VALUE,
  CODEX_EFFORT_OPTIONS,
  CODEX_MODEL_OPTIONS,
  CODEX_MODEL_PLACEHOLDER,
  LAUNCH_MODEL_GROUPS,
  claudeModelLabel,
  codexEffortFor,
  codexEffortOptions,
  launchClaudeModel,
  launchCodexModel,
  launchControlKind,
  launchModelEffortLabels,
  launchModelHarness,
  launchModelLabel,
} from "./launchOptions";

/**
 * The composer's launch-time model/effort controls, split by harness. The web
 * package has no component-test harness, so — as with knowledgeScope.ts — the
 * option sets and the harness gate are pinned at the logic level: which controls
 * render (Codex only for a Codex launch), the Codex effort ladder, and the
 * pre-filled defaults.
 */

describe("Codex option sets + defaults", () => {
  test("the full effort ladder runs minimal → ultra, each labeled", () => {
    expect(CODEX_EFFORT_OPTIONS.map((o) => o.value)).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    for (const o of CODEX_EFFORT_OPTIONS) expect(o.label).toBeTruthy();
    expect(CODEX_EFFORT_OPTIONS.find((o) => o.value === "xhigh")?.label).toBe("X-high");
  });

  test("the model control offers the catalog's ids and the effort control pre-selects medium", () => {
    expect(CODEX_MODEL_OPTIONS.map((o) => o.value)).toEqual(CODEX_MODELS);
    for (const o of CODEX_MODEL_OPTIONS) expect(o.label).toContain(o.value);
    // The free-text escape hatch shows a placeholder, not a value: an untouched
    // Codex launch sends no model at all.
    expect(CODEX_MODEL_PLACEHOLDER).toBe(CODEX_MODELS[0] ?? "Codex model id");
    expect(CODEX_DEFAULT_EFFORT_VALUE).toBe("medium");
  });

  test("with the empty default catalog the Codex group offers only the CLI's own model", () => {
    expect(CODEX_MODEL_OPTIONS).toEqual([]);
    expect(CODEX_MODEL_PLACEHOLDER).toBe("Codex model id");
    const codexGroup = LAUNCH_MODEL_GROUPS.find((g) => g.harness === "codex");
    expect(codexGroup?.options).toEqual([{ value: CODEX_DEFAULT_MODEL_VALUE, label: "Codex (its own model)" }]);
  });
});

describe("codexEffortOptions / codexEffortFor", () => {
  const ALL: CodexEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
  /** A stand-in catalog: models with their own levels, and one with none listed. */
  const CATALOG: CodexModelInfo[] = [
    { id: "acme-coder-max", label: "Acme Coder Max", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
    { id: "acme-coder-lite", label: "Acme Coder Lite", efforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "acme-coder-mini", label: "Acme Coder Mini", efforts: ["low", "medium", "high", "xhigh"] },
    { id: "acme-coder-plain", label: "Acme Coder" },
  ];
  const levels = (id: string): string[] => codexEffortOptions(id, CATALOG).map((o) => o.value);

  test.each([
    ["acme-coder-max", ["low", "medium", "high", "xhigh", "max", "ultra"]],
    ["acme-coder-lite", ["low", "medium", "high", "xhigh", "max"]],
    ["acme-coder-mini", ["low", "medium", "high", "xhigh"]],
    ["acme-coder-plain", ALL],
    ["some-future-codex-model", ALL],
    ["", ALL],
  ])("%s offers its own levels", (id, expected) => {
    expect(levels(id)).toEqual(expected as string[]);
  });

  test.each([
    ["acme-coder-max", "ultra", "ultra"],
    ["acme-coder-max", "minimal", "medium"],
    ["acme-coder-mini", "ultra", "medium"],
    ["some-future-codex-model", "minimal", "minimal"],
    ["", "high", "high"],
  ] as const)("%s with %s chosen sends %s", (id, chosen, sent) => {
    expect(codexEffortFor(id, chosen, CATALOG)).toBe(sent);
  });

  test("the default catalog offers every level for any id and sends the chosen one", () => {
    expect(codexEffortOptions("gpt-5-codex").map((o) => o.value)).toEqual(ALL);
    expect(codexEffortFor("gpt-5-codex", "ultra")).toBe("ultra");
  });
});

describe("Claude model options — families and pinned versions", () => {
  test("every offered value is one the server accepts, exactly once", () => {
    // The groups are the UI's view of CLAUDE_MODELS (the set the server
    // validates against), so a value can never be offered that a launch rejects.
    expect(CLAUDE_MODEL_OPTIONS.map((o) => o.value)).toEqual(CLAUDE_MODELS);
  });

  test("each family groups its latest alias with its pinned versions", () => {
    expect(CLAUDE_MODEL_GROUPS.map((g) => g.family)).toEqual(["Opus", "Sonnet", "Haiku", "Fable"]);
    const opus = CLAUDE_MODEL_GROUPS.find((g) => g.family === "Opus")!;
    expect(opus.options[0]).toEqual({ value: "opus", label: "Opus (latest)" });
    expect(opus.options.map((o) => o.label)).toContain("Opus 4.8");
  });

  test("a specific version is selectable — the whole point of the pinned ids", () => {
    const values = CLAUDE_MODEL_OPTIONS.map((o) => o.value);
    expect(values).toContain("claude-opus-5");
    expect(values).toContain("claude-opus-4-8");
    expect(values).toContain("claude-opus-4-7");
  });

  test("the list reaches back through the older versions, not just the current ones", () => {
    // The point of "all the models": a session can be pinned to a superseded
    // version, so the picker offers every version the CLI still accepts.
    const values = CLAUDE_MODEL_OPTIONS.map((o) => o.value);
    const superseded: ClaudeModel[] = [
      "claude-opus-4-5",
      "claude-opus-4-1",
      "claude-opus-4",
      "claude-sonnet-4-5",
      "claude-sonnet-3-7",
      "claude-haiku-3-5",
    ];
    for (const model of superseded) {
      expect(values).toContain(model);
    }
  });
});

describe("LAUNCH_MODEL_GROUPS — one list across both harnesses", () => {
  test("Claude's families come first, then Codex — every value offered exactly once", () => {
    expect(LAUNCH_MODEL_GROUPS.map((g) => g.family)).toEqual([
      "Opus",
      "Sonnet",
      "Haiku",
      "Fable",
      "Codex",
    ]);
    expect(LAUNCH_MODEL_GROUPS.map((g) => g.harness)).toEqual([
      "claude",
      "claude",
      "claude",
      "claude",
      "codex",
    ]);
    const values = LAUNCH_MODEL_GROUPS.flatMap((g) => g.options.map((o) => o.value));
    expect(new Set(values).size).toBe(values.length);
    expect(values).toEqual([
      ...CLAUDE_MODELS,
      CODEX_DEFAULT_MODEL_VALUE,
      ...CODEX_MODELS,
    ]);
  });

  test("each group's harness is the one its own values imply", () => {
    // The invariant that lets the harness pill go away: the group heading and the
    // harness a pick resolves to can never disagree.
    for (const group of LAUNCH_MODEL_GROUPS) {
      for (const o of group.options) expect(launchModelHarness(o.value)).toBe(group.harness);
    }
  });
});

describe("launchModelHarness — the pick names the harness", () => {
  test("no pick names no harness, so the project's default still governs", () => {
    expect(launchModelHarness("")).toBeUndefined();
  });

  test("a Claude value (alias or pinned) drives Claude", () => {
    expect(launchModelHarness("opus")).toBe("claude");
    expect(launchModelHarness("claude-opus-4-8")).toBe("claude");
  });

  test("a Codex id drives Codex — including one typed into the free-text entry", () => {
    expect(launchModelHarness("gpt-5-codex")).toBe("codex");
    // Claude's set is closed, so an id it doesn't carry is a Codex one. That is
    // what makes the escape hatch work without a harness control.
    expect(launchModelHarness("some-other-provider.model-9")).toBe("codex");
  });

  test("the Codex sentinel drives Codex while asserting no model", () => {
    expect(launchModelHarness(CODEX_DEFAULT_MODEL_VALUE)).toBe("codex");
    expect(launchCodexModel(CODEX_DEFAULT_MODEL_VALUE)).toBeUndefined();
    expect(launchClaudeModel(CODEX_DEFAULT_MODEL_VALUE)).toBeUndefined();
  });
});

describe("launchClaudeModel / launchCodexModel — routing a pick to its own field", () => {
  test("a Claude pick fills only the Claude model field", () => {
    expect(launchClaudeModel("claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(launchCodexModel("claude-opus-4-8")).toBeUndefined();
  });

  test("a Codex pick fills only the Codex model field", () => {
    // The leak this prevents: sending one pick to both fields would label the
    // session with a model its harness never ran.
    expect(launchCodexModel("gpt-5-codex")).toBe("gpt-5-codex");
    expect(launchClaudeModel("gpt-5-codex")).toBeUndefined();
  });

  test("no pick fills neither, so the launch asserts no model at all", () => {
    expect(launchClaudeModel("")).toBeUndefined();
    expect(launchCodexModel("")).toBeUndefined();
  });
});

describe("launchModelLabel", () => {
  test("a Claude value is prettified and a Codex id the catalog doesn't name is shown verbatim", () => {
    expect(launchModelLabel("claude-opus-4-8")).toBe("Opus 4.8");
    expect(launchModelLabel("opus")).toBe("Opus (latest)");
    expect(launchModelLabel("gpt-5-codex")).toBe("gpt-5-codex");
    expect(launchModelLabel("some-future-codex-model")).toBe("some-future-codex-model");
  });

  test("an empty pick reads default, and the Codex sentinel reads as the harness", () => {
    expect(launchModelLabel("")).toBe("default");
    expect(launchModelLabel(CODEX_DEFAULT_MODEL_VALUE)).toBe("Codex");
  });
});

describe("claudeModelLabel", () => {
  test("a family alias reads as latest — it tracks the newest model, not a version", () => {
    expect(claudeModelLabel("opus")).toBe("Opus (latest)");
    expect(claudeModelLabel("sonnet")).toBe("Sonnet (latest)");
  });

  test("a pinned id reads as its own version, not the newest one", () => {
    // The bug this closes: every opus id used to render "Opus 5", so a session
    // pinned to 4.8 was labeled as the model it deliberately wasn't.
    expect(claudeModelLabel("claude-opus-4-8")).toBe("Opus 4.8");
    expect(claudeModelLabel("claude-opus-5")).toBe("Opus 5");
    expect(claudeModelLabel("claude-haiku-4-5")).toBe("Haiku 4.5");
    expect(claudeModelLabel("claude-fable-5-1")).toBe("Fable 5.1");
  });

  test("a trailing date stamp is not a version segment", () => {
    expect(claudeModelLabel("claude-opus-5-20260101")).toBe("Opus 5");
    expect(claudeModelLabel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(claudeModelLabel("claude-sonnet-4-5-20250929-v1")).toBe("Sonnet 4.5");
  });

  test("an unrecognized value is shown raw rather than hidden", () => {
    expect(claudeModelLabel("gpt-5-codex")).toBe("gpt-5-codex");
  });
});

describe("launchControlKind — whose effort ladder to show", () => {
  test("shows the Codex controls only when the launch will drive Codex", () => {
    // A picked Codex model.
    expect(launchControlKind("codex", undefined)).toBe("codex");
    // No override, but the project defaults to codex.
    expect(launchControlKind("", "codex")).toBe("codex");
  });

  test("shows the Claude controls for a Claude launch and for the bare default", () => {
    expect(launchControlKind("claude", undefined)).toBe("claude");
    // No override, no project default → the default harness (claude).
    expect(launchControlKind("", undefined)).toBe("claude");
    expect(launchControlKind("", "claude")).toBe("claude");
  });

  test("the picked model's harness wins over the project's default", () => {
    // Codex project, but a Claude model is picked → claude controls.
    expect(launchControlKind("claude", "codex")).toBe("claude");
    // Claude project, but a Codex model is picked → codex controls.
    expect(launchControlKind("codex", "claude")).toBe("codex");
  });
});

describe("launchModelEffortLabels — per-harness model/effort labels", () => {
  // A stub that marks what it touched, so a test can prove friendlyModel is
  // applied ONLY to the live/Claude model and never to a free-form codex id.
  const pretty = (id: string) => `pretty(${id})`;

  test("a codex launch shows its own codexModel/codexEffort, not the Claude fields", () => {
    // The exact leak the fix closes: a codex session has no Claude transcript
    // (no liveModel) and its Claude model/effort columns are unset, so reading
    // them would render "default". It must read codexModel/codexEffort instead.
    const { model, effort } = launchModelEffortLabels(
      { harness: "codex", codexModel: "gpt-5-codex", codexEffort: "high" },
      pretty
    );
    expect(model).toBe("gpt-5-codex");
    expect(effort).toBe("high");
  });

  test("a codex model id is shown verbatim — friendlyModel is never applied to it", () => {
    const { model } = launchModelEffortLabels(
      { harness: "codex", codexModel: "gpt-5-codex", codexEffort: "medium" },
      pretty
    );
    expect(model).not.toContain("pretty(");
  });

  test("a codex launch with no codex model/effort falls back to default", () => {
    // Even with stray Claude fields present (a pre-fix persisted row), a codex
    // launch must not surface them — it reads only its own columns.
    const { model, effort } = launchModelEffortLabels(
      { harness: "codex", model: "opus", effort: "high" },
      pretty
    );
    expect(model).toBe("default");
    expect(effort).toBe("default");
  });

  test("a claude launch prettifies the live model and shows the live effort", () => {
    const { model, effort } = launchModelEffortLabels(
      { harness: "claude", liveModel: "claude-opus-5-20250101", liveEffort: "high", model: "sonnet" },
      pretty
    );
    expect(model).toBe("pretty(claude-opus-5-20250101)");
    expect(effort).toBe("high");
  });

  test("a claude launch with no live value falls back to the persisted model/effort", () => {
    // The persisted Claude model is labeled too — it may be a pinned id
    // (`claude-opus-4-8`), which would otherwise show raw in the pill.
    const { model, effort } = launchModelEffortLabels(
      { harness: "claude", model: "claude-opus-4-8", effort: "medium" },
      pretty
    );
    expect(model).toBe("pretty(claude-opus-4-8)");
    expect(effort).toBe("medium");
  });

  test("a bare launch (no harness, no fields) shows default / default", () => {
    const { model, effort } = launchModelEffortLabels({}, pretty);
    expect(model).toBe("default");
    expect(effort).toBe("default");
  });

  test("the live value wins over the persisted one regardless of harness", () => {
    // Future-proof: if a codex session ever reports a live model, it wins and is
    // passed through friendlyModel (which returns free-form ids unchanged).
    const { model, effort } = launchModelEffortLabels(
      { harness: "codex", liveModel: "gpt-5-codex", liveEffort: "low", codexModel: "gpt-4", codexEffort: "high" },
      pretty
    );
    expect(model).toBe("pretty(gpt-5-codex)");
    expect(effort).toBe("low");
  });
});
