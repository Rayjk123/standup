import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createStore,
  listDeciderDecisions,
  putGlobalDeciderPrefs,
  putUserDeciderPrefs,
  type Store,
} from "@standup/store";
import { claudeDecider, deciderClaudeModel, matchOptionKey } from "./claude.js";
import { resolveKindConfig } from "./config.js";
import { runDecision } from "./run.js";
import type { Decider, DecisionRequest } from "./types.js";

const REQ: DecisionRequest = {
  kind: "project",
  state: "Task: fix the beta login form",
  question: "Which registered project does this task belong to?",
  options: { alpha: "Alpha", beta: "Beta", NONE: "scratch" },
};

function fakeClaude(reply: string | null): Decider & { calls: number } {
  const inner = claudeDecider({ runModel: async () => reply });
  const d = {
    backend: "claude" as const,
    calls: 0,
    decide(req: DecisionRequest, opts: { timeoutMs: number }) {
      d.calls += 1;
      return inner.decide(req, opts);
    },
  };
  return d;
}

let store: Store;
const originalLog = console.log;
beforeEach(() => {
  store = createStore(":memory:");
  console.log = () => {};
});
afterEach(() => {
  console.log = originalLog;
});

describe("runDecision", () => {
  test("the claude answer is used and recorded", async () => {
    const claude = fakeClaude("beta");
    const out = await runDecision({ db: store.db, alias: "ana" }, REQ, { claude, claudeTimeoutMs: 1000 });
    expect(out.answer).toEqual({ choice: "beta", confidence: null });
    expect(out.backend).toBe("claude");
    expect(out.routedTo).toBe("claude");
    expect(out.fallbackReason).toBeNull();
    expect(claude.calls).toBe(1);

    const [row] = listDeciderDecisions(store.db);
    expect(row).toMatchObject({
      kind: "project",
      backend: "claude",
      routedTo: "claude",
      choice: "beta",
      confidence: null,
      fallbackReason: null,
      detail: null,
      alias: "ana",
    });
  });

  test("a failing backend leaves no answer, records the failure and never throws", async () => {
    const out = await runDecision({ db: store.db }, REQ, { claude: fakeClaude(null), claudeTimeoutMs: 1000 });
    expect(out.answer).toBeNull();
    expect(out.detail).toBe("no reply");
    expect(listDeciderDecisions(store.db)[0]).toMatchObject({ choice: null, detail: "no reply" });
  });

  test("a throwing backend is caught", async () => {
    const claude: Decider = {
      backend: "claude",
      async decide() {
        throw new Error("kaboom");
      },
    };
    const out = await runDecision({}, REQ, { claude, claudeTimeoutMs: 1000 });
    expect(out.answer).toBeNull();
    expect(out.detail).toBe("kaboom");
  });

  test("without a db nothing is recorded", async () => {
    const out = await runDecision({}, REQ, { claude: fakeClaude("alpha"), claudeTimeoutMs: 1000 });
    expect(out.answer?.choice).toBe("alpha");
    expect(out.record).toBeNull();
  });

  test("an unreadable settings layer routes on the defaults", async () => {
    store.db.exec("DROP TABLE user_decider_prefs");
    const out = await runDecision({ db: store.db, alias: "ana" }, REQ, { claude: fakeClaude("alpha"), claudeTimeoutMs: 1000 });
    expect(out.routedTo).toBe("claude");
    expect(out.answer?.choice).toBe("alpha");
  });
});

describe("resolveKindConfig", () => {
  test("the user layer overrides the global layer, which overrides the default", () => {
    expect(resolveKindConfig("project", {}, {})).toMatchObject({ backend: "claude", source: "default", defaultBackend: "claude" });
    expect(resolveKindConfig("project", {}, { project: "claude" })).toMatchObject({ source: "global" });
    expect(resolveKindConfig("project", { project: "claude" }, { project: "claude" })).toMatchObject({ source: "user" });
  });

  test("effort and model are suggestion-only", () => {
    expect(resolveKindConfig("model", {}, {}).suggestionOnly).toBe(true);
    expect(resolveKindConfig("effort", {}, {}).suggestionOnly).toBe(true);
    expect(resolveKindConfig("project", {}, {}).suggestionOnly).toBe(false);
  });

  test("runDecision reports the layer's routing", async () => {
    putGlobalDeciderPrefs(store.db, { project: "claude" });
    putUserDeciderPrefs(store.db, "ana", { project: "claude" });
    const out = await runDecision({ db: store.db, alias: "ana" }, REQ, { claude: fakeClaude("alpha"), claudeTimeoutMs: 1000 });
    expect(out.routedTo).toBe("claude");
  });
});

describe("claudeDecider", () => {
  test("the generic parser maps a free-text reply onto an option key", () => {
    expect(matchOptionKey("beta", REQ.options)).toBe("beta");
    expect(matchOptionKey("`Beta`.", REQ.options)).toBe("beta");
    expect(matchOptionKey("I'd say alpha", REQ.options)).toBe("alpha");
    expect(matchOptionKey("gamma", REQ.options)).toBeNull();
    expect(matchOptionKey("", REQ.options)).toBeNull();
  });

  test("the model comes from STANDUP_DECIDER_MODEL, else the helper's default", () => {
    expect(deciderClaudeModel({})).toBeUndefined();
    expect(deciderClaudeModel({ STANDUP_DECIDER_MODEL: "  " })).toBeUndefined();
    expect(deciderClaudeModel({ STANDUP_DECIDER_MODEL: "sonnet" })).toBe("sonnet");
  });

  test("an unmatched reply is an invalid answer", async () => {
    await expect(fakeClaude("gamma").decide(REQ, { timeoutMs: 10 })).rejects.toMatchObject({ reason: "invalid_answer" });
  });
});
