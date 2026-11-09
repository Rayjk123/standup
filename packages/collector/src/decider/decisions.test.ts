import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createStore, listDeciderDecisions, type Store } from "@standup/store";
import { buildProjectDecision, inferMainProject, type ProjectCandidate } from "../project-inference.js";
import { decideTurnEnd } from "../auto-checkpoint.js";
import { suggestLaunchSettings } from "./suggest.js";

const CANDIDATES: ProjectCandidate[] = [
  { id: "alpha", name: "Alpha Service", repos: ["~/code/alpha"] },
  { id: "beta", name: "Beta Web", repos: [] },
];
const INPUT = { task: "Fix the login form on the Beta website", cwd: "/tmp/scratch/x", candidates: CANDIDATES };

let store: Store;
let logs: string[];
const originalLog = console.log;
beforeEach(() => {
  store = createStore(":memory:");
  logs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
});
afterEach(() => {
  console.log = originalLog;
});

describe("project routing through the Decider port", () => {
  test("the decision lists each candidate and NONE, with the task alone as state", () => {
    const req = buildProjectDecision(INPUT);
    expect(Object.keys(req.options)).toEqual(["alpha", "beta", "NONE"]);
    expect(req.options.alpha).toContain("~/code/alpha");
    expect(req.state).toBe(INPUT.task);
    // The scratch cwd reads as "keep it in scratch" to a decision model.
    expect(req.state).not.toContain("/tmp/scratch/x");
  });

  test("the claude matcher routes the launch, and the decision is recorded", async () => {
    const result = await inferMainProject(INPUT, async () => "beta", { db: store.db, alias: "ana", launchId: "L1" });
    expect(result).toBe("beta");
    expect(logs).toContain("[infer] matched beta");
    expect(listDeciderDecisions(store.db)[0]).toMatchObject({ kind: "project", backend: "claude", launchId: "L1", alias: "ana" });
  });

  test("NONE keeps the launch in scratch", async () => {
    expect(await inferMainProject(INPUT, async () => "NONE")).toBeNull();
    expect(logs.some((l) => l.startsWith("[infer] declined (NONE/ambiguous)"))).toBe(true);
  });

  test("no reply keeps the launch in scratch", async () => {
    expect(await inferMainProject(INPUT, async () => null)).toBeNull();
    expect(logs.some((l) => l.startsWith("[infer] error"))).toBe(true);
  });
});

describe("turn-end classification through the Decider port", () => {
  test("each label maps back to its state, with the reason kept", async () => {
    const cases = [
      ["NEEDS_YOU\nIt asked which branch to use.", "needs_you", "It asked which branch to use."],
      ["DONE\nThe tests pass and it reported.", "done", "The tests pass and it reported."],
      ["IDLE\nIt stopped mid-exchange.", "idle", "It stopped mid-exchange."],
      ["garbled", "idle", "garbled"],
    ] as const;
    for (const [reply, state, reason] of cases) {
      expect(await decideTurnEnd({ db: store.db, sessionId: "s1", alias: "ana" }, "user: hi", async () => reply)).toEqual({
        state,
        reason,
      });
    }
    const rows = listDeciderDecisions(store.db, { alias: "ana", kind: "turn_end" });
    expect(rows.map((r) => r.choice)).toEqual(["IDLE", "IDLE", "DONE", "NEEDS_YOU"]);
    expect(rows.every((r) => r.backend === "claude" && r.sessionId === "s1")).toBe(true);
  });

  test("no reply is no classification", async () => {
    expect(await decideTurnEnd({}, "user: hi", async () => null)).toBeNull();
  });
});

describe("launch suggestions", () => {
  test("effort and model are asked separately and returned with backend and latency", async () => {
    const prompts: string[] = [];
    const s = await suggestLaunchSettings({ db: store.db, alias: "ana" }, "Add a retry to the poller", {
      runModel: async (prompt) => {
        prompts.push(prompt);
        return prompt.includes("reasoning effort") ? "medium" : "sonnet";
      },
    });
    expect(s.effort).toMatchObject({ choice: "medium", confidence: null, backend: "claude" });
    expect(s.model).toMatchObject({ choice: "sonnet", confidence: null, backend: "claude" });
    expect(prompts).toHaveLength(2);
    expect(listDeciderDecisions(store.db)).toHaveLength(2);
  });

  test("with nothing answering the suggestion is empty, not an error", async () => {
    const s = await suggestLaunchSettings({}, "Do a thing", { runModel: async () => null });
    expect(s.effort?.choice).toBeNull();
    expect(s.model?.choice).toBeNull();
  });
});
