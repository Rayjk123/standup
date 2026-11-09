import { expect, test, describe } from "bun:test";
import { createStore } from "@standup/store";
import { buildOpeningPrompt, formatOrchestrationInstruction } from "./launcher.js";
import type { OrchestrationProfile } from "@standup/shared";

/**
 * Orchestration steering: a launch that resolves to an orchestration profile
 * carries that profile's ordered steps as steering in its opening prompt (a peer
 * of the plan-first steering), injected right after the plan-first block. Pure
 * rendering, so it is exercised without spawning a real launch.
 */

const profile: OrchestrationProfile = {
  name: "ship-it",
  scope: "project",
  steps: [
    { kind: "gate", name: "Build", command: "bun run build" },
    {
      kind: "deploy",
      target: { account: "111122223333", role: "Admin" },
      command: "npx cdk deploy",
    },
    { kind: "review", rounds: 2, blockOnSeverity: "medium" },
    { kind: "human_pause", prompt: "confirm before prod" },
  ],
};

describe("orchestration steering in the opening prompt", () => {
  test("buildOpeningPrompt injects the steering only when a profile is passed", () => {
    const store = createStore(":memory:");
    try {
      const withProfile = buildOpeningPrompt(
        store.db,
        "task",
        undefined,
        undefined,
        undefined,
        "",
        "",
        false,
        "claude",
        undefined,
        "",
        profile
      );
      // The preamble contract, the named profile, and a step's rendered command.
      expect(withProfile).toContain("task");
      expect(withProfile).toContain("ORCHESTRATION PROFILE");
      expect(withProfile).toContain('Active profile "ship-it"');
      expect(withProfile).toContain("bun run build");
      expect(withProfile).toContain("it must exit 0");

      // No profile passed -> the prompt is left exactly as it was.
      const withoutProfile = buildOpeningPrompt(store.db, "task");
      expect(withoutProfile).not.toContain("ORCHESTRATION PROFILE");
      expect(withoutProfile).not.toContain("ship-it");
    } finally {
      store.db.close();
    }
  });
});

describe("formatOrchestrationInstruction renders each step kind", () => {
  test("gate / deploy / review / human_pause render as ordered directives", () => {
    const rendered = formatOrchestrationInstruction(profile);
    expect(rendered).toContain('Active profile "ship-it" — complete these steps in order:');
    // gate: named shell command that must exit 0.
    expect(rendered).toContain("1. Build: run `bun run build`; it must exit 0.");
    // deploy: account/role destination AND the deploy command.
    expect(rendered).toContain(
      "2. Deploy to account 111122223333/role Admin — run `npx cdk deploy`; it must exit 0."
    );
    // review: bounded loop honoring the step's rounds + severity.
    expect(rendered).toContain(
      "Run an adversarial review of your diff (up to 2 rounds); fix every high and medium finding, then re-review until clean."
    );
    // human_pause: park and await a human.
    expect(rendered).toContain("Stop and wait for human approval: confirm before prod");
  });

  test("review rounds/severity fall back to the profile-wide knobs", () => {
    const rendered = formatOrchestrationInstruction({
      name: "review-only",
      scope: "global",
      steps: [{ kind: "review" }],
      maxReviewRounds: 4,
      blockOnSeverity: "high",
    });
    expect(rendered).toContain("up to 4 rounds");
    expect(rendered).toContain("fix every high finding");
  });

  test("deploy with only a command (no target) still renders", () => {
    const rendered = formatOrchestrationInstruction({
      name: "cmd-only",
      scope: "global",
      steps: [{ kind: "deploy", command: "make deploy" }],
    });
    expect(rendered).toContain("Deploy: run `make deploy`; it must exit 0.");
  });
});
