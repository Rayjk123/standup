import { describe, expect, test } from "bun:test";
import {
  BUILTIN_PIPELINE_STAGE_KINDS,
  DEFAULT_PIPELINE,
  MAX_EVIDENCE_ARRAY,
  MAX_EVIDENCE_BYTES,
  MAX_EVIDENCE_STRING,
  PipelineConfigError,
  getPipelineStageKind,
  isHttpUrl,
  isOutwardStage,
  registerPipelineStageKind,
  registeredPipelineStageKinds,
  checkApplies,
  computeFacts,
  conditionMatches,
  currentEpochAttempts,
  describeStage,
  evaluateOutcome,
  globMatches,
  incompleteRequiredStages,
  loopBudget,
  planTransition,
  resolvePipeline,
  reviewBlockedOnlyByWontfix,
  stageStates,
  validateDefinition,
  validateEvidence,
  type PipelineDefinition,
  type PipelineStageAttempt,
  type PipelineStageDef,
} from "./pipeline.js";

function stage(def: PipelineDefinition, id: string): PipelineStageDef {
  const s = def.stages.find((x) => x.id === id);
  if (!s) throw new Error(`no stage ${id}`);
  return s;
}

function ids(def: PipelineDefinition): string[] {
  return def.stages.map((s) => s.id);
}

function cloneDefault(): PipelineDefinition {
  return JSON.parse(JSON.stringify(DEFAULT_PIPELINE)) as PipelineDefinition;
}

function attempt(stageId: string, status: PipelineStageAttempt["status"], nextStage?: string, n = 0): PipelineStageAttempt {
  return {
    id: `${stageId}-${n}`,
    runId: "r",
    stageId,
    attempt: 1,
    status,
    nextStage,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
  };
}

describe("validateDefinition", () => {
  test("the default pipeline is valid", () => {
    expect(validateDefinition(DEFAULT_PIPELINE)).toEqual([]);
  });

  test("rejects a non-object and a wrong version", () => {
    expect(validateDefinition(null)[0]).toContain("definition");
    const def = { ...cloneDefault(), version: 2 };
    expect(validateDefinition(def)).toContain("version: must be 1");
  });

  test("names an unknown edge target", () => {
    const def = cloneDefault();
    stage(def, "review").edges[0]!.to = "nowhere";
    expect(validateDefinition(def)).toEqual([`stages[3] ("review").edges[0].to: unknown stage "nowhere"`]);
  });

  test("rejects duplicate ids, a missing start and a missing complete", () => {
    const dup = cloneDefault();
    dup.stages.push({ ...stage(dup, "coding") });
    expect(validateDefinition(dup).some((e) => e.includes(`duplicate stage id "coding"`))).toBe(true);

    const noStart = cloneDefault();
    noStart.stages = noStart.stages.filter((s) => s.id !== "start");
    expect(validateDefinition(noStart).some((e) => e.includes(`id "start"`))).toBe(true);

    const noComplete = cloneDefault();
    noComplete.stages = noComplete.stages.filter((s) => s.id !== "complete");
    stage(noComplete, "code_review").edges = [];
    expect(validateDefinition(noComplete).some((e) => e.includes(`id "complete"`))).toBe(true);
  });

  test("rejects an unreachable stage", () => {
    const def = cloneDefault();
    def.stages.push({ id: "orphan", kind: "coding", title: "Orphan", required: false, edges: [{ to: "complete" }] });
    expect(validateDefinition(def)).toContain(`stages[${def.stages.length - 1}] ("orphan"): unreachable from "start"`);
  });

  test("rejects an unbounded cycle and an out-of-range loop bound", () => {
    const def = cloneDefault();
    delete stage(def, "validation").edges[1]!.loop;
    expect(validateDefinition(def).some((e) => e.includes("unbounded cycle"))).toBe(true);

    const big = cloneDefault();
    stage(big, "review").edges[1]!.loop = { maxTraversals: 11 };
    expect(validateDefinition(big)).toEqual([
      `stages[3] ("review").edges[1].loop.maxTraversals: must be an integer from 1 to 10`,
    ]);
  });

  test("names bad stage fields", () => {
    const def = cloneDefault();
    (stage(def, "review") as unknown as Record<string, unknown>).blockOn = "low";
    (stage(def, "coding") as unknown as Record<string, unknown>).kind = "bogus";
    const errors = validateDefinition(def);
    expect(errors).toContain(`stages[3] ("review").blockOn: must be "high" or "medium"`);
    expect(errors.some((e) => e.startsWith(`stages[1] ("coding").kind`))).toBe(true);
  });
});

describe("resolvePipeline", () => {
  test("no layers yields the default, enabled", () => {
    const r = resolvePipeline(DEFAULT_PIPELINE, [null, undefined]);
    expect(r.enabled).toBe(true);
    expect(r.definition).toEqual(DEFAULT_PIPELINE);
  });

  test("does not mutate the base", () => {
    const before = JSON.stringify(DEFAULT_PIPELINE);
    resolvePipeline(DEFAULT_PIPELINE, [{ stages: { review: { minReviewers: 3 }, screenshot: { skip: true } } }]);
    expect(JSON.stringify(DEFAULT_PIPELINE)).toBe(before);
  });

  test("patches merge scalars with the later layer winning", () => {
    const r = resolvePipeline(DEFAULT_PIPELINE, [
      { stages: { review: { minReviewers: 3, blockOn: "high" } } },
      { stages: { review: { minReviewers: 4 } } },
    ]);
    const review = stage(r.definition, "review");
    expect(review.minReviewers).toBe(4);
    expect(review.blockOn).toBe("high");
    expect(review.title).toBe("Adversarial review");
  });

  test("a patch's edges replace the stage's edges wholesale", () => {
    const r = resolvePipeline(DEFAULT_PIPELINE, [{ stages: { review: { edges: [{ to: "deploy" }] } } }]);
    expect(stage(r.definition, "review").edges).toEqual([{ to: "deploy" }]);
  });

  test("skip removes a stage and rewires edges into it to its passed successor", () => {
    const r = resolvePipeline(DEFAULT_PIPELINE, [{ stages: { deploy: { skip: true } } }]);
    expect(ids(r.definition)).not.toContain("deploy");
    expect(stage(r.definition, "review").edges[0]).toEqual({ to: "screenshot", when: { outcome: "passed" } });
  });

  test("skip rewires transitively and keeps a redirected loop bound", () => {
    const r = resolvePipeline(DEFAULT_PIPELINE, [{ stages: { screenshot: { skip: true }, code_review: { skip: true } } }]);
    expect(stage(r.definition, "deploy").edges[0]!.to).toBe("human_review");

    const c = resolvePipeline(DEFAULT_PIPELINE, [{ stages: { coding: { skip: true } } }]);
    const back = stage(c.definition, "review").edges[1]!;
    expect(back.to).toBe("validation");
    expect(back.loop).toEqual({ maxTraversals: 4 });
    expect(stage(c.definition, "start").edges[0]!.to).toBe("validation");
  });

  test("skip:false in a later layer restores the stage", () => {
    const r = resolvePipeline(DEFAULT_PIPELINE, [
      { stages: { deploy: { skip: true } } },
      { stages: { deploy: { skip: false } } },
    ]);
    expect(ids(r.definition)).toContain("deploy");
    expect(stage(r.definition, "review").edges[0]!.to).toBe("deploy");
  });

  test("add inserts a stage after another", () => {
    const r = resolvePipeline(DEFAULT_PIPELINE, [
      { add: [{ after: "review", stage: { id: "security", kind: "review", title: "Security review", required: true, edges: [] } }] },
    ]);
    expect(ids(r.definition).slice(3, 6)).toEqual(["review", "security", "deploy"]);
    expect(stage(r.definition, "review").edges[0]!.to).toBe("security");
    expect(stage(r.definition, "security").edges).toEqual([{ to: "deploy", when: { outcome: "passed" } }]);
  });

  test("an added stage keeps edges it declares", () => {
    const edges = [
      { to: "screenshot", when: { outcome: "passed" as const } },
      { to: "coding", when: { outcome: "failed" as const }, loop: { maxTraversals: 2 } },
    ];
    const r = resolvePipeline(DEFAULT_PIPELINE, [
      { add: [{ after: "deploy", stage: { id: "soak", kind: "validation", title: "Soak", required: false, edges } }] },
    ]);
    expect(stage(r.definition, "deploy").edges[0]!.to).toBe("soak");
    expect(stage(r.definition, "soak").edges).toEqual(edges);
  });

  test("an added stage that strands another is refused", () => {
    expect(() =>
      resolvePipeline(DEFAULT_PIPELINE, [
        {
          add: [
            { after: "deploy", stage: { id: "soak", kind: "validation", title: "Soak", required: false, edges: [{ to: "code_review" }] } },
          ],
        },
      ])
    ).toThrow(`stages[6] ("screenshot"): unreachable from "start"`);
  });

  test("enabled: the later layer wins", () => {
    expect(resolvePipeline(DEFAULT_PIPELINE, [{ enabled: false }]).enabled).toBe(false);
    expect(resolvePipeline(DEFAULT_PIPELINE, [{ enabled: false }, { enabled: true }]).enabled).toBe(true);
    expect(resolvePipeline(DEFAULT_PIPELINE, [{ enabled: false }, {}]).enabled).toBe(false);
  });

  test("refuses skipping start or complete", () => {
    expect(() => resolvePipeline(DEFAULT_PIPELINE, [{ stages: { start: { skip: true } } }])).toThrow(PipelineConfigError);
    try {
      resolvePipeline(DEFAULT_PIPELINE, [{ stages: { complete: { skip: true } } }]);
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(PipelineConfigError);
      expect((e as PipelineConfigError).errors).toEqual(["layer[0].stages.complete.skip: the complete stage cannot be skipped"]);
    }
  });

  test("refuses an unknown stage id", () => {
    try {
      resolvePipeline(DEFAULT_PIPELINE, [{ stages: { nope: { required: false } } }]);
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as PipelineConfigError).errors).toEqual([`layer[0].stages.nope: unknown stage "nope"`]);
    }
  });

  test("refuses a patch that creates an unbounded cycle", () => {
    expect(() =>
      resolvePipeline(DEFAULT_PIPELINE, [
        { stages: { review: { edges: [{ to: "deploy", when: { outcome: "passed" } }, { to: "coding", when: { outcome: "failed" } }] } } },
      ])
    ).toThrow(/unbounded cycle/);
  });
});

describe("validateEvidence", () => {
  const def = DEFAULT_PIPELINE;

  test("coding needs a summary", () => {
    expect(validateEvidence(stage(def, "coding"), {})).toEqual(["evidence.summary (non-empty string describing the change)"]);
    expect(validateEvidence(stage(def, "coding"), { summary: "did it", changedFiles: ["a.ts"] })).toEqual([]);
  });

  test("validation needs commands", () => {
    expect(validateEvidence(stage(def, "validation"), {})).toEqual([
      "evidence.commands (non-empty array of {command, exitCode, summary})",
    ]);
    expect(validateEvidence(stage(def, "validation"), { commands: [{ command: "bun test", summary: "ok" }] })).toEqual([
      "evidence.commands[0].exitCode (integer)",
    ]);
    expect(
      validateEvidence(stage(def, "validation"), { commands: [{ command: "bun test", exitCode: 0, summary: "ok" }] })
    ).toEqual([]);
  });

  test("review needs at least minReviewers well-formed reviewers", () => {
    const one = { reviewers: [{ name: "a", findings: [] }] };
    expect(validateEvidence(stage(def, "review"), one)).toEqual([
      "evidence.reviewers (at least 2 independent reviewers; got 1)",
    ]);
    const bad = { reviewers: [{ name: "a", findings: [{ severity: "urgent", title: "x", status: "open" }] }, { name: "a", findings: [] }] };
    const errors = validateEvidence(stage(def, "review"), bad);
    expect(errors).toContain(`evidence.reviewers[0].findings[0].severity ("high", "medium" or "low")`);
    expect(errors).toContain("evidence.reviewers[1].name (reviewer names must be distinct)");
  });

  test("deploy needs account, stacks and live samples", () => {
    expect(validateEvidence(stage(def, "deploy"), {})).toEqual([
      "evidence.account (the account deployed to)",
      "evidence.stacks (non-empty array of deployed stack names)",
      "evidence.liveSamples (non-empty array of {request, response, ok})",
    ]);
  });

  test("screenshot needs minScreenshots paths", () => {
    expect(validateEvidence(stage(def, "screenshot"), { screenshots: [] })).toEqual([
      "evidence.screenshots (array of at least 1 {path, caption?} with absolute .png paths)",
    ]);
    expect(validateEvidence(stage(def, "screenshot"), { screenshots: [{ path: "/tmp/a.png" }] })).toEqual([]);
  });

  test("code_review needs a review reference, and an issue id only where the stage asks the owner for one", () => {
    expect(validateEvidence(stage(def, "code_review"), {})).toEqual(["evidence.reviewId or evidence.url (the code review)"]);
    expect(validateEvidence(stage(def, "code_review"), { reviewId: "R-1" })).toEqual([]);
    const withIssue = { ...stage(def, "code_review"), ownerInput: "issue_id" as const };
    expect(validateEvidence(withIssue, {})).toEqual([
      "evidence.issueId (the issue id the owner gave for the code review)",
      "evidence.reviewId or evidence.url (the code review)",
    ]);
    expect(validateEvidence(withIssue, { issueId: "P1", reviewId: "R-1" })).toEqual([]);
  });

  test("the default pipeline's code_review stage asks the owner for nothing", () => {
    expect(stage(def, "code_review").ownerInput).toBeUndefined();
  });

  test("start and complete need nothing", () => {
    expect(validateEvidence(stage(def, "start"), undefined)).toEqual([]);
    expect(validateEvidence(stage(def, "complete"), undefined)).toEqual([]);
  });
});

describe("validation checks", () => {
  const LIVE_CHECK = {
    command: "bun run test:live",
    paths: ["packages/web/**", "packages/collector/src/ws*.ts", "packages/collector/src/persona/runtime.ts", "packages/gateway/src/**"],
  };
  const passing = { commands: [{ command: "bun test", exitCode: 0, summary: "" }] };

  test("the default pipeline declares none", () => {
    expect(DEFAULT_PIPELINE.stages.every((s) => s.checks === undefined)).toBe(true);
  });

  test("a layer patches the validation stage's checks", () => {
    const r = resolvePipeline(DEFAULT_PIPELINE, [null, { stages: { validation: { checks: [LIVE_CHECK] } } }]);
    expect(stage(r.definition, "validation").checks).toEqual([LIVE_CHECK]);
    const cleared = resolvePipeline(DEFAULT_PIPELINE, [
      { stages: { validation: { checks: [LIVE_CHECK] } } },
      { stages: { validation: { checks: [] } } },
    ]);
    expect(stage(cleared.definition, "validation").checks).toEqual([]);
  });

  test("validateDefinition names malformed checks", () => {
    const at = `stages[2] ("validation").checks`;
    const errorsFor = (checks: unknown) => {
      const def = cloneDefault();
      (stage(def, "validation") as unknown as Record<string, unknown>).checks = checks;
      return validateDefinition(def);
    };
    expect(errorsFor([LIVE_CHECK, { command: "make lint", timeoutMs: 600_000 }])).toEqual([]);
    expect(errorsFor("bun test")).toEqual([`${at}: must be an array of {command, paths?, timeoutMs?}`]);
    expect(errorsFor([{ command: "  " }])).toEqual([`${at}[0].command: must be a non-empty string`]);
    expect(errorsFor([{ command: "x", paths: [] }])).toEqual([`${at}[0].paths: must be a non-empty array of non-empty glob strings`]);
    expect(errorsFor([{ command: "x", paths: ["ok/**", 3] }])).toEqual([
      `${at}[0].paths: must be a non-empty array of non-empty glob strings`,
    ]);
    expect(errorsFor([{ command: "x", timeoutMs: 10 }])).toEqual([`${at}[0].timeoutMs: must be an integer from 1000 to 3600000`]);
    // Past the validation budget is still valid config: a run clamps it, and a layer that stopped validating would be dropped whole.
    expect(errorsFor([{ command: "x", timeoutMs: 1_800_000 }])).toEqual([]);
    expect(errorsFor([{ command: "x", timeoutMs: 4_000_000 }])).toEqual([
      `${at}[0].timeoutMs: must be an integer from 1000 to 3600000`,
    ]);
    expect(errorsFor([{ command: "x", cwd: "/" }])).toEqual([`${at}[0].cwd: unknown check field`]);
    expect(errorsFor(Array.from({ length: 11 }, () => ({ command: "x" })))).toEqual([`${at}: at most 10 checks`]);

    const onReview = cloneDefault();
    (stage(onReview, "review") as unknown as Record<string, unknown>).checks = [{ command: "x" }];
    expect(validateDefinition(onReview)).toEqual([`stages[3] ("review").checks: only a validation stage runs checks`]);
  });

  test("a malformed check in a layer is refused", () => {
    expect(() => resolvePipeline(DEFAULT_PIPELINE, [{ stages: { validation: { checks: [{ command: "" }] } } }])).toThrow(
      PipelineConfigError
    );
  });

  test("checkApplies matches the change's files against the check's paths", () => {
    expect(checkApplies(LIVE_CHECK, ["packages/web/src/hooks/useWs.ts"])).toBe(true);
    expect(checkApplies(LIVE_CHECK, ["packages/collector/src/ws-hub.ts"])).toBe(true);
    expect(checkApplies(LIVE_CHECK, ["packages/collector/src/persona/runtime.ts"])).toBe(true);
    expect(checkApplies(LIVE_CHECK, ["packages/collector/src/persona/policy.ts", "README.md"])).toBe(false);
    expect(checkApplies(LIVE_CHECK, ["docs/pipeline.md"])).toBe(false);
    expect(checkApplies(LIVE_CHECK, [])).toBe(true);
    expect(checkApplies({ command: "x" }, ["README.md"])).toBe(true);
  });

  test("validateEvidence takes the server's check results and refuses malformed ones", () => {
    const v = stage(DEFAULT_PIPELINE, "validation");
    expect(validateEvidence(v, { ...passing, checks: [{ command: "c", met: true, output: "", skipped: true }] })).toEqual([]);
    expect(validateEvidence(v, { ...passing, checks: "all good" })).toEqual([
      "evidence.checks (array of {command, met: boolean, output, skipped?})",
    ]);
    expect(validateEvidence(v, { ...passing, checks: [{ command: "c", met: "yes", output: "" }] })).toEqual([
      "evidence.checks[0] ({command, met: boolean, output, skipped?})",
    ]);
  });

  test("evaluateOutcome fails on any check that wasn't met; skipped checks don't count as run", () => {
    const v = stage(DEFAULT_PIPELINE, "validation");
    const failed = evaluateOutcome(v, {
      ...passing,
      checks: [
        { command: "make lint", met: true, output: "" },
        { command: "bun run test:live", met: false, output: "1 fail" },
      ],
    });
    expect(failed.outcome).toBe("failed");
    expect(failed.reason).toBe("validation check failed (`bun run test:live`); last output:\n1 fail");
    const silent = evaluateOutcome(v, { ...passing, checks: [{ command: "bun run test:live", met: false, output: " \n" }] });
    expect(silent.reason).toBe("validation check failed (`bun run test:live`); it printed nothing");
    const passed = evaluateOutcome(v, {
      ...passing,
      checks: [
        { command: "make lint", met: true, output: "" },
        { command: "bun run test:live", met: true, output: "no changed file matches its paths", skipped: true },
      ],
    });
    expect(passed).toEqual({ outcome: "passed", reason: "1 command(s) exited 0; 1 check(s) passed" });
  });
});

describe("evaluateOutcome", () => {
  const def = DEFAULT_PIPELINE;

  test("coding, screenshot and code_review pass", () => {
    expect(evaluateOutcome(stage(def, "coding"), { summary: "x" }).outcome).toBe("passed");
    expect(evaluateOutcome(stage(def, "screenshot"), { screenshots: [{ path: "/tmp/a.png" }] }).outcome).toBe("passed");
    expect(evaluateOutcome(stage(def, "code_review"), { issueId: "P1", reviewId: "R-1" }).outcome).toBe("passed");
  });

  test("validation fails on a non-zero exit or an unmet criterion", () => {
    const v = stage(def, "validation");
    expect(evaluateOutcome(v, { commands: [{ command: "bun test", exitCode: 0, summary: "" }] }).outcome).toBe("passed");
    const failed = evaluateOutcome(v, { commands: [{ command: "bun test", exitCode: 1, summary: "" }] });
    expect(failed.outcome).toBe("failed");
    expect(failed.reason).toContain("`bun test` exited 1");
    expect(
      evaluateOutcome(v, {
        commands: [{ command: "bun test", exitCode: 0, summary: "" }],
        criterion: { command: "curl x", met: false, output: "" },
      }).outcome
    ).toBe("failed");
  });

  test("a command failing only tests that also fail on the base commit passes; a failure only on the branch fails", () => {
    const v = stage(def, "validation");
    const base = { commit: "abc1234", exitCode: 1, failing: ["a > flaky", "b > broken on main"] };
    const run = (failing: string[] | undefined, baseline: unknown = base) => ({
      commands: [
        { command: "bunx tsc -b", exitCode: 0, summary: "" },
        { command: "bun test", exitCode: 1, summary: "2 fail", ...(failing ? { failing } : {}), ...(baseline ? { baseline } : {}) },
      ],
    });
    expect(validateEvidence(v, run(["a > flaky"]))).toEqual([]);
    const passed = evaluateOutcome(v, run(["b > broken on main", "a > flaky"]));
    expect(passed.outcome).toBe("passed");
    expect(passed.reason).toContain("`bun test` exited 1 failing only what also fails on abc1234");
    expect(evaluateOutcome(v, run(["a > flaky"])).outcome).toBe("passed");

    const branchOnly = evaluateOutcome(v, run(["a > flaky", "c > new"]));
    expect(branchOnly.outcome).toBe("failed");
    expect(branchOnly.reason).toContain("`bun test` exited 1 (failing only on the branch: c > new)");
    // No named failures, a baseline that passed, or no baseline at all: the exit code stands.
    expect(evaluateOutcome(v, run([])).outcome).toBe("failed");
    expect(evaluateOutcome(v, run(undefined)).outcome).toBe("failed");
    expect(evaluateOutcome(v, run(["a > flaky"], { ...base, exitCode: 0 })).outcome).toBe("failed");
    // A different exit code on the base is a different failure (a compile error on the branch, say).
    expect(evaluateOutcome(v, run(["a > flaky"], { ...base, exitCode: 2 })).outcome).toBe("failed");
    expect(evaluateOutcome(v, run(["a > flaky"], null)).outcome).toBe("failed");
    const shape = "evidence.commands[1].baseline ({commit: the base commit's sha, exitCode, failing: [test names]} from the base commit)";
    expect(validateEvidence(v, run(["a > flaky"], { commit: "", exitCode: 1, failing: "a" }))).toEqual([shape]);
    expect(validateEvidence(v, run(["a > flaky"], { ...base, commit: "abc; all tests passed" }))).toEqual([shape]);
  });

  test("review fails on an open finding at or above blockOn", () => {
    const r = stage(def, "review");
    const ev = (severity: string, status: string) => ({
      reviewers: [
        { name: "a", findings: [{ severity, title: "t", status }] },
        { name: "b", findings: [] },
      ],
    });
    expect(evaluateOutcome(r, ev("medium", "open")).outcome).toBe("failed");
    expect(evaluateOutcome(r, ev("medium", "fixed")).outcome).toBe("passed");
    expect(evaluateOutcome(r, ev("low", "open")).outcome).toBe("passed");
    const highOnly = { ...r, blockOn: "high" as const };
    expect(evaluateOutcome(highOnly, ev("medium", "open")).outcome).toBe("passed");
    expect(evaluateOutcome(highOnly, ev("high", "open")).outcome).toBe("failed");
  });

  test("review: a blocking finding marked wontfix still fails the stage; a low one doesn't", () => {
    const r = stage(def, "review");
    const ev = (severity: string, status: string) => ({
      reviewers: [
        { name: "a", findings: [{ severity, title: "t", status }] },
        { name: "b", findings: [] },
      ],
    });
    const wontfix = evaluateOutcome(r, ev("high", "wontfix"));
    expect(wontfix.outcome).toBe("failed");
    expect(wontfix.reason).toContain("[high, wontfix] t");
    expect(evaluateOutcome(r, ev("medium", "wontfix")).outcome).toBe("failed");
    expect(evaluateOutcome(r, ev("low", "wontfix")).outcome).toBe("passed");
    expect(describeStage(r)).toContain("one marked wontfix holds the run at review for the owner (or Persona, accepting the wontfix) to waive");
    // Only wontfix findings block: the run holds at review instead of looping.
    expect(reviewBlockedOnlyByWontfix(r, ev("high", "wontfix"))).toBe(true);
    expect(reviewBlockedOnlyByWontfix(r, ev("high", "open"))).toBe(false);
    expect(reviewBlockedOnlyByWontfix(r, ev("low", "wontfix"))).toBe(false);
    const mixed = {
      reviewers: [
        { name: "a", findings: [{ severity: "high", title: "t", status: "wontfix" }] },
        { name: "b", findings: [{ severity: "medium", title: "u", status: "open" }] },
      ],
    };
    expect(reviewBlockedOnlyByWontfix(r, mixed)).toBe(false);
  });

  test("currentEpochAttempts keeps only the run's current epoch", () => {
    const a = (id: string, epoch?: number) => ({ id, runId: "r", stageId: "validation", attempt: 1, status: "failed" as const, createdAt: "t", ...(epoch !== undefined ? { epoch } : {}) });
    expect(currentEpochAttempts({ attempts: [a("x"), a("y", 1)] }).map((x) => x.id)).toEqual(["x"]);
    expect(currentEpochAttempts({ epoch: 1, attempts: [a("x"), a("y", 1)] }).map((x) => x.id)).toEqual(["y"]);
  });

  test("deploy fails on a live sample that was not ok", () => {
    const d = stage(def, "deploy");
    const base = { account: "1", stacks: ["S"] };
    expect(evaluateOutcome(d, { ...base, liveSamples: [{ request: "GET /", response: "200", ok: true }] }).outcome).toBe("passed");
    const bad = evaluateOutcome(d, {
      ...base,
      liveSamples: [
        { request: "GET /", response: "200", ok: true },
        { request: "GET /x", response: "500", ok: false },
      ],
    });
    expect(bad.outcome).toBe("failed");
    expect(bad.reason).toContain("GET /x");
  });
});

describe("conditionMatches and computeFacts", () => {
  test("conditions", () => {
    expect(conditionMatches({}, null, {})).toBe(true);
    expect(conditionMatches({ outcome: "passed" }, "failed", {})).toBe(false);
    expect(conditionMatches({ fact: "ui_changed" }, null, { ui_changed: true })).toBe(true);
    expect(conditionMatches({ fact: "ui_changed", not: true }, null, { ui_changed: false })).toBe(true);
    expect(conditionMatches({ fact: "ui_changed", not: true }, null, {})).toBe(false);
    expect(conditionMatches({ outcome: "passed", fact: "docs_only" }, "passed", { docs_only: false })).toBe(false);
  });

  test("globs", () => {
    expect(globMatches("packages/web/**", "packages/web/src/App.tsx")).toBe(true);
    expect(globMatches("**/*.tsx", "App.tsx")).toBe(true);
    expect(globMatches("**/*.tsx", "a/b/App.tsx")).toBe(true);
    expect(globMatches("*.css", "a/b.css")).toBe(false);
    expect(globMatches("src/?.ts", "src/a.ts")).toBe(true);
  });

  test("facts from changed files", () => {
    expect(computeFacts(["packages/store/src/x.ts"])).toEqual({ ui_changed: false, docs_only: false });
    expect(computeFacts(["packages/web/src/App.tsx", "README.md"])).toEqual({ ui_changed: true, docs_only: false });
    expect(computeFacts(["docs/design/x.md", "README.md"])).toEqual({ ui_changed: false, docs_only: true });
    expect(computeFacts(["site/index.vue"], ["site/**"]).ui_changed).toBe(true);
    expect(computeFacts([])).toEqual({ ui_changed: false, docs_only: false });
  });
});

describe("planTransition", () => {
  const def = DEFAULT_PIPELINE;

  test("follows the passed edge", () => {
    const t = planTransition(def, { currentStage: "coding", attempts: [], facts: {} }, "passed");
    expect(t).toEqual({ kind: "move", to: "validation", edge: stage(def, "coding").edges[0]!, skipped: [] });
  });

  test("a review loop is exhausted after 4 rounds", () => {
    const prior = Array.from({ length: 3 }, (_, i) => attempt("review", "failed", "coding", i));
    const fourth = planTransition(def, { currentStage: "review", attempts: prior, facts: {} }, "failed");
    expect(fourth.kind).toBe("move");

    const all = [...prior, attempt("review", "failed", "coding", 3)];
    const fifth = planTransition(def, { currentStage: "review", attempts: all, facts: {} }, "failed");
    expect(fifth).toEqual({ kind: "exhausted", reason: "review → coding loop did not converge after 4 rounds" });

    // A different loop edge keeps its own budget.
    const validation = planTransition(def, { currentStage: "validation", attempts: all, facts: {} }, "failed");
    expect(validation.kind).toBe("move");
  });

  test("auto-skips screenshot when no UI changed", () => {
    const t = planTransition(def, { currentStage: "deploy", attempts: [], facts: { ui_changed: false } }, "passed");
    expect(t).toEqual({
      kind: "move",
      to: "code_review",
      edge: stage(def, "deploy").edges[0]!,
      skipped: [{ stageId: "screenshot", reason: "auto-skipped: ui_changed is false" }],
    });
  });

  test("auto-skips screenshot for docs-only work even when UI paths matched", () => {
    const t = planTransition(def, { currentStage: "deploy", attempts: [], facts: { ui_changed: true, docs_only: true } }, "passed");
    expect(t.kind === "move" && t.to).toBe("code_review");
    expect(t.kind === "move" && t.skipped[0]!.reason).toBe("auto-skipped: docs_only is true");
  });

  test("enters screenshot when UI changed", () => {
    const t = planTransition(def, { currentStage: "deploy", attempts: [], facts: { ui_changed: true, docs_only: false } }, "passed");
    expect(t.kind === "move" && t.to).toBe("screenshot");
  });

  test("no matching edge is exhausted", () => {
    const t = planTransition(def, { currentStage: "coding", attempts: [], facts: {} }, "failed");
    expect(t.kind).toBe("exhausted");
  });

  test("loopBudget counts a loop whose target auto-skips the way planTransition does", () => {
    const skipping: PipelineDefinition = {
      version: 1,
      stages: [
        { id: "start", kind: "start", title: "Start", required: false, edges: [{ to: "a" }] },
        { id: "a", kind: "coding", title: "A", required: true, edges: [{ to: "b" }] },
        {
          id: "b",
          kind: "validation",
          title: "B",
          required: true,
          edges: [
            { to: "done", when: { outcome: "passed" } },
            { to: "s", when: { outcome: "failed" }, loop: { maxTraversals: 3 } },
          ],
        },
        { id: "s", kind: "screenshot", title: "S", required: false, skipWhen: [{ fact: "ui_changed", not: true }], edges: [{ to: "a" }] },
        { id: "done", kind: "complete", title: "Done", required: false, edges: [] },
      ],
    };
    const facts = { ui_changed: false };
    // Two failed rounds that went past the skipped stage straight to a.
    const prior = [attempt("b", "failed", "a", 0), attempt("b", "failed", "a", 1)];
    expect(loopBudget(skipping, prior, facts)).toEqual([{ from: "b", to: "s", used: 2, max: 3 }]);
    expect(planTransition(skipping, { currentStage: "b", attempts: prior, facts }, "failed").kind).toBe("move");
    const third = [...prior, attempt("b", "failed", "a", 2)];
    expect(loopBudget(skipping, third, facts)[0]!.used).toBe(3);
    expect(planTransition(skipping, { currentStage: "b", attempts: third, facts }, "failed").kind).toBe("exhausted");
    // Without facts nothing auto-skips, so only moves into s count.
    expect(loopBudget(skipping, third)[0]!.used).toBe(0);
  });
});

describe("run views", () => {
  const def = DEFAULT_PIPELINE;

  test("stageStates marks stages ahead as pending after a loop back", () => {
    const attempts = [
      attempt("start", "passed", "coding", 0),
      attempt("coding", "passed", "validation", 1),
      attempt("validation", "passed", "review", 2),
      attempt("review", "failed", "coding", 3),
    ];
    const states = stageStates(def, { currentStage: "coding", status: "active", attempts });
    expect(states.start).toEqual({ state: "passed", attempts: 1 });
    expect(states.coding).toEqual({ state: "current", attempts: 1 });
    expect(states.validation!.state).toBe("pending");
    expect(states.review).toEqual({ state: "pending", attempts: 1 });
    expect(incompleteRequiredStages(def, { currentStage: "coding", status: "active", attempts })).toEqual([
      "coding",
      "validation",
      "review",
      "deploy",
      "screenshot",
      "code_review",
      "human_review",
    ]);
  });

  test("a skipped screenshot does not count as incomplete", () => {
    const attempts = [
      attempt("coding", "passed", "validation", 1),
      attempt("validation", "passed", "review", 2),
      attempt("review", "passed", "deploy", 3),
      attempt("deploy", "passed", "code_review", 4),
      attempt("screenshot", "skipped", "code_review", 5),
    ];
    expect(incompleteRequiredStages(def, { currentStage: "code_review", status: "active", attempts })).toEqual(["code_review", "human_review"]);
    const done = [...attempts, attempt("code_review", "passed", "human_review", 6), attempt("human_review", "passed", "complete", 7)];
    expect(incompleteRequiredStages(def, { currentStage: "complete", status: "complete", attempts: done })).toEqual([]);
    expect(stageStates(def, { currentStage: "complete", status: "complete", attempts: done }).complete!.state).toBe("passed");
  });

  test("describeStage names the evidence shape", () => {
    expect(describeStage(stage(def, "validation"))).toContain("commands: [{command, exitCode, summary}]");
    expect(describeStage(stage(def, "code_review"))).not.toContain("ask_human");
    expect(describeStage({ ...stage(def, "code_review"), ownerInput: "issue_id" })).toContain("ask_human");
    expect(describeStage(stage(def, "screenshot"))).toContain("Skipped automatically when ui_changed is false or docs_only is true");
  });
});

describe("evidence limits and urls", () => {
  const def = DEFAULT_PIPELINE;

  test("a code_review url must be http(s)", () => {
    expect(validateEvidence(stage(def, "code_review"), { issueId: "P1", url: "javascript:alert(1)" })).toEqual([
      "evidence.url (an http:// or https:// URL)",
    ]);
    expect(validateEvidence(stage(def, "code_review"), { issueId: "P1", url: "https://code.example/reviews/R-1" })).toEqual([]);
    expect(isHttpUrl("http://localhost:3000/x")).toBe(true);
    expect(isHttpUrl("data:text/html,x")).toBe(false);
  });

  test("where the stage asks for an issue id, the review gate's code_review record needs none; a worker's does", () => {
    const withIssue = { ...stage(def, "code_review"), ownerInput: "issue_id" as const };
    expect(validateEvidence(withIssue, { url: "https://code.example/reviews/R-1", source: "review_gate" })).toEqual([]);
    expect(validateEvidence(withIssue, { url: "https://code.example/reviews/R-1" })[0]).toContain("evidence.issueId");
    expect(validateEvidence(stage(def, "code_review"), { url: "https://code.example/reviews/R-1" })).toEqual([]);
  });

  test("oversized evidence is refused: total size, array length and string length", () => {
    const coding = stage(def, "coding");
    expect(validateEvidence(coding, { summary: "x".repeat(MAX_EVIDENCE_STRING + 1) })).toEqual([
      `evidence.summary (at most ${MAX_EVIDENCE_STRING} characters)`,
    ]);
    const files = Array.from({ length: MAX_EVIDENCE_ARRAY + 1 }, (_, i) => `f${i}.ts`);
    expect(validateEvidence(coding, { summary: "x", changedFiles: files })).toEqual([
      `evidence.changedFiles (at most ${MAX_EVIDENCE_ARRAY} entries)`,
    ]);
    const big = { summary: "x", commits: Array.from({ length: 10 }, () => "y".repeat(8000)) };
    expect(validateEvidence(coding, big)[0]).toContain(`at most ${MAX_EVIDENCE_BYTES / 1024} KB`);
    expect(validateEvidence(coding, { summary: "x", commits: ["abc"] })).toEqual([]);
  });

  test("deploy is skippable and auto-skipped for a docs-only change", () => {
    const deploy = stage(def, "deploy");
    expect(deploy.skippable).toBe(true);
    expect(deploy.skipWhen).toEqual([{ fact: "docs_only" }]);
    const plan = planTransition(def, { currentStage: "review", attempts: [], facts: { docs_only: true, ui_changed: false } }, "passed");
    expect(plan).toMatchObject({ kind: "move", to: "code_review" });
  });
});

describe("the stage-kind registry", () => {
  test("built-in kinds are registered and can't be replaced", () => {
    const builtins = BUILTIN_PIPELINE_STAGE_KINDS as readonly string[];
    expect(registeredPipelineStageKinds().filter((k) => builtins.includes(k))).toEqual([...BUILTIN_PIPELINE_STAGE_KINDS]);
    expect(getPipelineStageKind("deploy")?.outward).toBe(true);
    expect(() =>
      registerPipelineStageKind({ kind: "review", validateEvidence: () => [], evaluateOutcome: () => ({ outcome: "passed", reason: "" }), describe: () => "" })
    ).toThrow("built-in");
  });

  test("an unregistered kind is refused by validateDefinition; a registered one is accepted and dispatched", () => {
    const withKind = (kind: string): PipelineDefinition => ({
      version: 1,
      stages: [
        { id: "start", kind: "start", title: "Start", required: false, edges: [{ to: "gate" }] },
        { id: "gate", kind, title: "Gate", required: true, edges: [{ to: "complete" }] },
        { id: "complete", kind: "complete", title: "Done", required: false, edges: [] },
      ],
    });
    expect(validateDefinition(withKind("legal_signoff"))[0]).toContain("must be a registered stage kind");
    registerPipelineStageKind({
      kind: "legal_signoff",
      outward: true,
      validateEvidence: (_s, ev) => (ev.ticket ? [] : ["evidence.ticket (the legal ticket)"]),
      evaluateOutcome: (_s, ev) => (ev.approved ? { outcome: "passed", reason: "approved" } : { outcome: "failed", reason: "rejected" }),
      describe: () => "{ticket, approved}",
      defaults: { title: "Legal sign-off", required: true, description: "Legal approved the change." },
    });
    expect(validateDefinition(withKind("legal_signoff"))).toEqual([]);
    const gate = stage(withKind("legal_signoff"), "gate");
    expect(validateEvidence(gate, {})).toEqual(["evidence.ticket (the legal ticket)"]);
    expect(evaluateOutcome(gate, { ticket: "L-1", approved: false }).outcome).toBe("failed");
    expect(isOutwardStage(gate)).toBe(true);
    expect(describeStage(gate)).toContain("Evidence: {ticket, approved}.");
    // An added stage of the kind takes its defaults for what it leaves out.
    const { definition } = resolvePipeline(DEFAULT_PIPELINE, [
      { add: [{ after: "code_review", stage: { id: "legal", kind: "legal_signoff" } as unknown as PipelineStageDef }] },
    ]);
    expect(stage(definition, "legal")).toMatchObject({ title: "Legal sign-off", required: true, edges: [{ to: "human_review", when: { outcome: "passed" } }] });
    expect(stage(definition, "code_review").edges[0]!.to).toBe("legal");
  });
});
