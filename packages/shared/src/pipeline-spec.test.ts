import { describe, expect, test } from "bun:test";
import { DEFAULT_PIPELINE, PipelineConfigError, evaluateOutcome, resolvePipeline, validateEvidence } from "./pipeline.js";
import { PIPELINE_CATALOG, pipelinePresetOf, pipelineStageSummary, resolvePipelineLayers } from "./pipeline-presets.js";
import {
  CODE_REVIEW_OFF_PHRASES,
  compilePipelineSpec,
  pipelineLayerFromInput,
  pipelineLayerTouches,
  pipelineTermsNamed,
  specNamesProject,
  specProjectRefusal,
} from "./pipeline-spec.js";

const ids = (layers: Parameters<typeof resolvePipelineLayers>[0], auto: "full" | "light" = "full") =>
  pipelineStageSummary(resolvePipelineLayers(layers, auto).definition).map((s) => s.id);

describe("presets", () => {
  test("full resolves to exactly the default pipeline", () => {
    const { definition, preset } = resolvePipelineLayers([], "full");
    expect(preset).toBe("full");
    expect(definition).toEqual(DEFAULT_PIPELINE);
  });

  test("light has an isolated live check and the review packet, but no deploy and no code review", () => {
    expect(ids([], "light")).toEqual(["coding", "validation", "review", "live_check", "screenshot", "human_review"]);
    const def = resolvePipelineLayers([], "light").definition;
    const review = def.stages.find((s) => s.id === "review")!;
    expect(review.edges).toContainEqual({ to: "live_check", when: { outcome: "passed" } });
    const live = def.stages.find((s) => s.id === "live_check")!;
    expect(live.edges).toEqual([
      { to: "screenshot", when: { outcome: "passed" } },
      { to: "coding", when: { outcome: "failed" }, loop: { maxTraversals: 4 } },
    ]);
  });

  test("the last layer naming a preset wins over the project's own", () => {
    expect(pipelinePresetOf([{ preset: "light" }, null, { preset: "full" }], "light")).toBe("full");
    expect(pipelinePresetOf([{}, { stages: {} }], "light")).toBe("light");
    expect(ids([{ preset: "light" }], "full")).not.toContain("code_review");
  });

  test("layers apply user < project < job < launch over the preset", () => {
    const user = { stages: { screenshot: { skip: true } } };
    const project = { stages: { code_review: { skip: false } } };
    const job = { stages: { screenshot: { skip: false } } };
    const launch = { stages: { code_review: { skip: true } } };
    expect(ids([user], "light")).not.toContain("screenshot");
    expect(ids([user, project], "light")).toContain("code_review");
    expect(ids([user, project, job], "light")).toContain("screenshot");
    expect(ids([user, project, job, launch], "light")).not.toContain("code_review");
  });

  test("project preset light overrides user code_review on", () => {
    // The preset applies just before the last layer naming it, so it resets what the user's layer set…
    const user = { stages: { code_review: { skip: false } } };
    expect(ids([user, { preset: "light" }], "full")).not.toContain("code_review");
    // …while the naming layer's own patches, and the layers above it, still win over the preset.
    expect(ids([user, { preset: "light", stages: { code_review: { skip: false } } }], "full")).toContain("code_review");
    expect(ids([user, { preset: "light" }, { stages: { code_review: { skip: false } } }], "full")).toContain("code_review");
    // With no layer naming one, the project's own preset comes first and every layer applies over it.
    expect(ids([user], "light")).toContain("code_review");
  });

  test("a bad preset name is refused", () => {
    expect(() => resolvePipeline(PIPELINE_CATALOG, [{ preset: "nope" as never }])).toThrow(PipelineConfigError);
  });
});

describe("the live_check stage kind", () => {
  const stage = PIPELINE_CATALOG.stages.find((s) => s.id === "live_check")!;
  test("needs an environment and live samples", () => {
    expect(validateEvidence(stage, {})).toEqual([
      "evidence.environment (what ran the change, e.g. an isolated collector and its port)",
      "evidence.liveSamples (non-empty array of {request, response, ok})",
    ]);
    expect(validateEvidence(stage, { environment: "collector :17801", isolation: { ports: ["x"] }, liveSamples: [] })).toHaveLength(2);
  });
  test("a sample that wasn't ok fails it", () => {
    const ok = { environment: "collector :17801", isolation: { ports: [17801], tmuxSocket: "/tmp/s" }, liveSamples: [{ request: "GET /health", response: "200", ok: true }] };
    expect(validateEvidence(stage, ok)).toEqual([]);
    expect(evaluateOutcome(stage, ok).outcome).toBe("passed");
    expect(evaluateOutcome(stage, { ...ok, liveSamples: [{ request: "GET /x", response: "500", ok: false }] }).outcome).toBe("failed");
  });
});

describe("compilePipelineSpec", () => {
  test("the owner's example compiles to the light shape", () => {
    const c = compilePipelineSpec("for standup: no code review, isolated live check, review packet");
    expect(c.project).toBe("standup");
    expect(c.unknown).toEqual([]);
    expect(c.override.stages).toEqual({
      code_review: { skip: true },
      live_check: { skip: false },
      human_review: { skip: false },
      deploy: { skip: true },
    });
    expect(c.override.spec).toBe("for standup: no code review, isolated live check, review packet");
    expect(ids([c.override], "full")).toEqual(["coding", "validation", "review", "live_check", "screenshot", "human_review"]);
  });

  test.each([
    ["preset light", { preset: "light" }],
    ["Production flow", { preset: "full" }],
    ["full pipeline", { preset: "full" }],
    ["standup flow", { preset: "light" }],
  ])("%s names a preset", (spec, expected) => {
    expect(compilePipelineSpec(spec).override).toMatchObject(expected);
  });

  test.each([
    ["no code review", "code_review", { skip: true }],
    ["skip code review", "code_review", { skip: true }],
    ["pull request", "code_review", { skip: false }],
    ["no PR", "code_review", { skip: true }],
    ["no pull request", "code_review", { skip: true }],
    ["deploy to personal", "deploy", { skip: false }],
    ["no deploy", "deploy", { skip: true }],
    ["no live check", "live_check", { skip: true }],
    ["no screenshots", "screenshot", { skip: true }],
    ["desktop screenshots", "screenshot", { skip: false }],
    ["no human review", "human_review", { skip: true }],
    ["no adversarial review", "review", { skip: true }],
    ["no validation", "validation", { skip: true }],
    ["3 reviewers", "review", { minReviewers: 3 }],
    ["block on high", "review", { blockOn: "high" as const }],
  ])("%s", (spec, stage, patch) => {
    const c = compilePipelineSpec(spec);
    expect(c.unknown).toEqual([]);
    expect(c.override.stages?.[stage]).toEqual(patch);
  });

  test("a deploy asked for alongside the live check stays on", () => {
    const c = compilePipelineSpec("live check, deploy to personal");
    expect(c.override.stages?.deploy).toEqual({ skip: false });
    expect(ids([c.override], "light")).toEqual(expect.arrayContaining(["live_check", "deploy"]));
  });

  test("max N rounds bounds the validation, review, live-check and deploy loops", () => {
    const c = compilePipelineSpec("max 2 rounds, live check, deploy");
    const def = resolvePipelineLayers([c.override], "full").definition;
    const loops = def.stages
      .filter((s) => ["validation", "review", "live_check", "deploy"].includes(s.id))
      .flatMap((s) => s.edges.filter((e) => e.loop).map((e) => e.loop!.maxTraversals));
    expect(loops).toHaveLength(4);
    expect(loops.length).toBeGreaterThan(0);
    expect(new Set(loops)).toEqual(new Set([2]));
  });

  test("max N rounds compiles to the layer's maxRounds, never to whole edge arrays", () => {
    const c = compilePipelineSpec("max 3 rounds");
    expect(c.override).toEqual({ spec: "max 3 rounds", maxRounds: 3 });
    // A later layer's edges for a stage don't escape the bound, and its own reroute survives.
    const reroute = { stages: { review: { edges: [{ to: "deploy", when: { outcome: "passed" as const } }, { to: "coding", when: { outcome: "failed" as const }, loop: { maxTraversals: 9 } }] } } };
    const def = resolvePipelineLayers([c.override, reroute], "full").definition;
    const loops = def.stages.flatMap((s) => s.edges.filter((e) => e.loop).map((e) => e.loop!.maxTraversals));
    expect(loops.length).toBeGreaterThan(0);
    expect(new Set(loops)).toEqual(new Set([3]));
    // The last layer that sets it wins.
    const later = resolvePipelineLayers([c.override, { maxRounds: 1 }], "full").definition;
    expect(new Set(later.stages.flatMap((s) => s.edges.filter((e) => e.loop).map((e) => e.loop!.maxTraversals)))).toEqual(new Set([1]));
  });

  test.each([0, 11, 2.5, "3"])("maxRounds %p is refused", (n) => {
    expect(() => resolvePipelineLayers([{ maxRounds: n as number }], "full")).toThrow(PipelineConfigError);
  });

  test("bullets and newlines split clauses", () => {
    const c = compilePipelineSpec("- no code review\n- 3 reviewers\n* review packet");
    expect(c.unknown).toEqual([]);
    expect(c.clauses.map((x) => x.effect)).toEqual(["code_review: off", "review: at least 3 reviewer(s)", "human_review: on"]);
  });

  test("a clause it can't map is reported, not guessed", () => {
    const c = compilePipelineSpec("no code review, make it fast, ship to prod");
    expect(c.unknown).toEqual(["make it fast", "ship to prod"]);
  });

  test.each(["no review", "skip the reviews", "without a review", "with review", "reviews"])(
    "a bare review names no stage and is refused: %p",
    (spec) => {
      const c = compilePipelineSpec(spec);
      expect(c.unknown).toEqual([spec]);
      expect(c.override.stages).toBeUndefined();
    }
  );

  test.each([
    ["no pull request", { skip: true }],
    ["skip the PRs", { skip: true }],
    ["without a merge request", { skip: true }],
    ["with code review", { skip: false }],
  ])("a code review phrase names code_review: %p", (spec, patch) => {
    const c = compilePipelineSpec(spec);
    expect(c.unknown).toEqual([]);
    expect(c.override.stages).toEqual({ code_review: patch });
  });

  test("the code review, the adversarial review and the review packet keep their own phrases", () => {
    const c = compilePipelineSpec("no PR, no adversarial review, review packet, 2 reviewers");
    expect(c.unknown).toEqual([]);
    expect(c.override.stages).toEqual({
      code_review: { skip: true },
      review: { skip: true, minReviewers: 2 },
      human_review: { skip: false },
    });
  });

  test.each(["deploy to a dev environment", "deploy to my dev environment", "deploy to dev", "deploy to my personal stack"])("%p turns deploy on", (spec) => {
    const c = compilePipelineSpec(spec);
    expect(c.unknown).toEqual([]);
    expect(c.override.stages).toEqual({ deploy: { skip: false } });
  });

  test.each([...CODE_REVIEW_OFF_PHRASES])("the help phrase %p turns code_review off", (phrase) => {
    const c = compilePipelineSpec(phrase);
    expect(c.unknown).toEqual([]);
    expect(c.override.stages).toEqual({ code_review: { skip: true } });
  });

  test("a refused spec suggests every code_review off phrase", () => {
    const r = pipelineLayerFromInput({ spec: "make it fast" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    for (const phrase of CODE_REVIEW_OFF_PHRASES) expect(r.error).toContain(`"${phrase}"`);
  });
});

describe("what a layer touches and what the owner's words name", () => {
  test("pipelineLayerTouches names stages, the preset, rounds and the pipeline itself", () => {
    expect(pipelineLayerTouches({ preset: "light", maxRounds: 2, enabled: false, stages: { code_review: { skip: true } } }).sort()).toEqual(
      ["code_review", "light", "pipeline", "rounds"].sort()
    );
  });

  test.each([
    ["keep me posted on the pull request", ["code_review"]],
    ["no validation please", ["validation"]],
    ["skip the code review", ["code_review"]],
    ["no review on this one", ["review"]],
    ["no reviews in this pipeline", ["review", "pipeline"]],
    ["use fewer reviews in the flow", ["review", "pipeline"]],
    ["no adversarial review on this one", ["review"]],
    ["no PR", ["code_review"]],
    ["add a review packet", ["human_review"]],
    ["3 reviewers on lite", ["review"]],
    ["use the light flow", ["light"]],
    ["use the light flow for this project", ["light"]],
    ["max 2 rounds", ["rounds"]],
    ["turn the pipeline off", ["pipeline"]],
  ])("%s names %p", (text, terms) => {
    expect([...pipelineTermsNamed(text)].sort()).toEqual([...terms].sort());
  });
});

describe("a spec's for <project>:", () => {
  test.each([
    ["standup", { id: "standup" }, true],
    ["Standup", { id: "standup-self", name: "Standup itself" }, true],
    ["standup itself", { id: "su", name: "Standup Itself" }, true],
    ["stand", { id: "standup" }, false],
    ["payments-platform", { id: "payments_platform" }, true],
    ["other", { id: "standup", name: "Standup" }, false],
  ])("%s names %p: %p", (named, project, expected) => {
    expect(specNamesProject(named, project)).toBe(expected);
  });

  test("specProjectRefusal refuses a project's spec on the owner's own layer and on another project", () => {
    const compiled = compilePipelineSpec("for standup: no code review");
    expect(specProjectRefusal(compiled, null)).toBe("this spec is for standup; set it on that project");
    expect(specProjectRefusal(compiled, { id: "payments" })).toContain("not payments");
    expect(specProjectRefusal(compiled, { id: "standup" })).toBeNull();
    expect(specProjectRefusal(compiled, undefined)).toBeNull();
    expect(specProjectRefusal(compilePipelineSpec("no code review"), null)).toBeNull();
  });
});

describe("pipelineLayerFromInput", () => {
  test("refuses a spec with unknown clauses, naming them", () => {
    const r = pipelineLayerFromInput({ spec: "no code review, vibes only" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.unknown).toEqual(["vibes only"]);
  });
  test("a structured override wins over the spec, stage by stage", () => {
    const r = pipelineLayerFromInput({ spec: "no code review, no screenshots", override: { stages: { code_review: { skip: false } }, preset: "light" } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.override.stages).toEqual({ code_review: { skip: false }, screenshot: { skip: true } });
      expect(r.override.preset).toBe("light");
      expect(r.override.spec).toBe("no code review, no screenshots");
    }
  });
  test("needs one of the two", () => {
    expect(pipelineLayerFromInput({}).ok).toBe(false);
    expect(pipelineLayerFromInput({ override: { stages: {} } }).ok).toBe(true);
  });
});
