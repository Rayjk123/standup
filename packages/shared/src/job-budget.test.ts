import { describe, expect, test } from "bun:test";
import {
  JOB_BUDGET_DEFAULTS,
  describeJobBudget,
  formatMinutes,
  jobBudgetLevel,
  jobBudgetRaise,
  jobBudgetValueError,
  resolveJobBudget,
} from "./job-budget.js";

describe("resolveJobBudget", () => {
  test("each dimension takes the most specific layer that sets it, else the default", () => {
    expect(resolveJobBudget({})).toEqual({
      usd: JOB_BUDGET_DEFAULTS.usd,
      minutes: JOB_BUDGET_DEFAULTS.minutes,
      source: { usd: "default", minutes: "default" },
    });
    expect(resolveJobBudget({ user: { usd: 10 }, project: { minutes: 60 }, job: { usd: null } })).toEqual({
      usd: 10,
      minutes: 60,
      source: { usd: "user", minutes: "project" },
    });
    expect(resolveJobBudget({ user: { usd: 10 }, job: { usd: 2 } }).usd).toBe(2);
  });

  test("0 means no limit and stops the inheritance there", () => {
    expect(resolveJobBudget({ project: { usd: 0 }, user: { usd: 10 } })).toMatchObject({ usd: null, source: { usd: "project" } });
  });

  test("the built-in default has no spend limit and an 8h time limit", () => {
    expect(JOB_BUDGET_DEFAULTS).toEqual({ usd: null, minutes: 480 });
    expect(resolveJobBudget({})).toMatchObject({ usd: null, minutes: 480 });
  });

  test("each layer over the built-in default: owner, then project, then job", () => {
    const user = { usd: 20, minutes: 120 };
    expect(resolveJobBudget({ user })).toMatchObject({ usd: 20, minutes: 120, source: { usd: "user", minutes: "user" } });
    // An owner layer of 0 keeps no limit; one that leaves a dimension unset takes the built-in.
    expect(resolveJobBudget({ user: { usd: 0, minutes: null } })).toMatchObject({
      usd: null,
      minutes: 480,
      source: { usd: "user", minutes: "default" },
    });
    expect(resolveJobBudget({ user, project: { usd: 5 } })).toMatchObject({ usd: 5, minutes: 120, source: { usd: "project", minutes: "user" } });
    expect(resolveJobBudget({ user, project: { usd: 5 }, job: { usd: 0, minutes: 30 } })).toMatchObject({
      usd: null,
      minutes: 30,
      source: { usd: "job", minutes: "job" },
    });
  });
});

describe("jobBudgetLevel", () => {
  test("near from 80% of either dimension, exceeded at 100%", () => {
    const b = { usd: 1, minutes: 100 };
    expect(jobBudgetLevel(b, 0.79, 10)).toBe("ok");
    expect(jobBudgetLevel(b, 0.8, 10)).toBe("near");
    expect(jobBudgetLevel(b, 0.1, 85)).toBe("near");
    expect(jobBudgetLevel(b, 1, 10)).toBe("exceeded");
    expect(jobBudgetLevel(b, 0.1, 100)).toBe("exceeded");
    expect(jobBudgetLevel({ usd: null, minutes: null }, 1e6, 1e6)).toBe("ok");
  });
});

describe("jobBudgetRaise", () => {
  test("names a higher limit or a lifted one, and nothing for a lower one", () => {
    expect(jobBudgetRaise({ usd: 1, minutes: 60 }, { usd: 2, minutes: 60 })).toBe("spend $1.00 → $2.00");
    expect(jobBudgetRaise({ usd: 1, minutes: 60 }, { usd: 1, minutes: null })).toBe("time 1h → no limit");
    expect(jobBudgetRaise({ usd: 1, minutes: 60 }, { usd: 0.5, minutes: 30 })).toBeNull();
    expect(jobBudgetRaise({ usd: null, minutes: null }, { usd: 5, minutes: 5 })).toBeNull();
  });

  test("no limit is above any number: lifting a limit raises, setting one under no limit doesn't", () => {
    // Number → no limit: a raise.
    expect(jobBudgetRaise({ usd: 25, minutes: 480 }, { usd: null, minutes: 480 })).toBe("spend $25.00 → no limit");
    // No limit → no limit: not a raise (budgetUsd 0 under an unlimited default).
    expect(jobBudgetRaise({ usd: null, minutes: 480 }, { usd: null, minutes: 480 })).toBeNull();
    // No limit → a number: a lowering, not a raise.
    expect(jobBudgetRaise({ usd: null, minutes: 480 }, { usd: 10, minutes: 480 })).toBeNull();
    // Equal numbers are not a raise.
    expect(jobBudgetRaise({ usd: 10, minutes: 480 }, { usd: 10, minutes: 480 })).toBeNull();
  });
});

test("value validation, minutes and description", () => {
  expect(jobBudgetValueError("usd", 5)).toBeNull();
  expect(jobBudgetValueError("usd", null)).toBeNull();
  expect(jobBudgetValueError("usd", -1)).not.toBeNull();
  expect(jobBudgetValueError("minutes", "10")).not.toBeNull();
  expect(formatMinutes(35)).toBe("35m");
  expect(formatMinutes(90)).toBe("1h 30m");
  expect(formatMinutes(480)).toBe("8h");
  expect(describeJobBudget({ usd: 1, minutes: 120, spentUsd: 1.2, elapsedMinutes: 35 })).toBe("$1.20 of $1.00 · 35m of 2h");
  expect(describeJobBudget({ usd: null, minutes: null, spentUsd: 3, elapsedMinutes: 1 })).toBe("$3.00, no limit");
});
