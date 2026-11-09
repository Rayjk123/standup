import { describe, expect, test } from "bun:test";
import {
  DEFAULT_NOTIFY_PREFS,
  isValidTimezone,
  notifyChannelsFor,
  parseBriefTime,
  resolveNotifyPrefs,
  validateNotifyOverride,
} from "./notify.js";
import type { NotifyOverride, NotifyPrefs } from "./notify.js";

function errorsOf(raw: unknown, projectLayer = false): string[] {
  const r = validateNotifyOverride(raw, { projectLayer });
  return r.ok ? [] : r.errors;
}

describe("validateNotifyOverride", () => {
  test("accepts a full global layer and keeps only its fields, deduping channels", () => {
    const r = validateNotifyOverride({
      routes: { decision: { channels: ["push", "push", "slack"], when: "approvals_only" }, brief: { when: "always" } },
      brief: { enabled: true, time: "07:05" },
      timezone: "America/New_York",
    });
    expect(r).toEqual({
      ok: true,
      value: {
        routes: { decision: { channels: ["push", "slack"], when: "approvals_only" }, brief: { when: "always" } },
        brief: { enabled: true, time: "07:05" },
        timezone: "America/New_York",
      },
    });
  });

  test("an empty object is a valid, empty layer; a non-object is refused", () => {
    expect(validateNotifyOverride({})).toEqual({ ok: true, value: {} });
    for (const raw of [null, undefined, "x", 3, []]) expect(errorsOf(raw)).toEqual(["the override must be an object"]);
  });

  test("unknown fields are refused at every level", () => {
    expect(errorsOf({ colour: "red" })).toEqual(["unknown field: colour"]);
    expect(errorsOf({ routes: { email: { channels: [] } } })).toEqual(["unknown update kind: email"]);
    expect(errorsOf({ routes: { done: { channels: [], loud: true } } })).toEqual(["routes.done: unknown field loud"]);
    expect(errorsOf({ brief: { at: "08:00" } })).toEqual(["brief: unknown field at"]);
  });

  test("a channel outside slack/push and a condition outside the kind's set are refused", () => {
    expect(errorsOf({ routes: { done: { channels: ["email"] } } })).toEqual(["routes.done.channels must list only slack, push"]);
    expect(errorsOf({ routes: { done: { channels: "slack" } } })).toEqual(["routes.done.channels must list only slack, push"]);
    // needs_you belongs to progress, not done.
    expect(errorsOf({ routes: { done: { when: "needs_you" } } })).toEqual(["routes.done.when must be one of always, failures_only"]);
    expect(errorsOf({ routes: { progress: { when: 1 } } })).toEqual(["routes.progress.when must be one of always, needs_you, never"]);
    expect(errorsOf({ routes: { decision: "slack" } })).toEqual(["routes.decision must be an object"]);
    expect(errorsOf({ routes: [] })).toEqual(["routes must be an object"]);
  });

  test("a bad brief time, enabled flag or timezone is refused", () => {
    for (const time of ["8:30", "24:00", "08:60", "0830", "08:30:00", 830]) {
      expect(errorsOf({ brief: { time } })).toEqual(["brief.time must be HH:MM (24-hour)"]);
    }
    expect(errorsOf({ brief: { enabled: "yes" } })).toEqual(["brief.enabled must be true or false"]);
    expect(errorsOf({ brief: "on" })).toEqual(["brief must be an object"]);
    expect(errorsOf({ timezone: "Mars/Olympus_Mons" })).toEqual(["timezone must be an IANA zone, e.g. America/New_York"]);
    expect(errorsOf({ timezone: 5 })).toEqual(["timezone must be an IANA zone, e.g. America/New_York"]);
  });

  test("every problem is reported at once", () => {
    expect(errorsOf({ x: 1, brief: { time: "nope" }, timezone: "Nowhere/Land" })).toHaveLength(3);
  });

  test("a project layer may route only decision, progress and done", () => {
    expect(
      validateNotifyOverride({ routes: { decision: { channels: [] }, progress: { when: "always" }, done: { when: "failures_only" } } }, { projectLayer: true }).ok
    ).toBe(true);
    expect(errorsOf({ routes: { brief: { channels: ["push"] } } }, true)).toEqual([
      "routes.brief is set for every project at once, not per project",
    ]);
    expect(errorsOf({ brief: { enabled: false } }, true)).toEqual(["the brief is set for every project at once, not per project"]);
    expect(errorsOf({ timezone: "UTC" }, true)).toEqual(["the timezone is set for every project at once, not per project"]);
    // The same fields are fine on the global layer.
    expect(errorsOf({ routes: { brief: { channels: ["push"] } }, brief: { enabled: false }, timezone: "UTC" })).toEqual([]);
  });
});

describe("parseBriefTime / isValidTimezone", () => {
  test("parses HH:MM and rejects the rest", () => {
    expect(parseBriefTime("08:30")).toEqual({ hour: 8, minute: 30 });
    expect(parseBriefTime("23:59")).toEqual({ hour: 23, minute: 59 });
    expect(parseBriefTime("00:00")).toEqual({ hour: 0, minute: 0 });
    expect(parseBriefTime("24:00")).toBeNull();
    expect(parseBriefTime(" 08:30")).toBeNull();
  });

  test("knows IANA zones", () => {
    expect(isValidTimezone("Europe/Berlin")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("Not/AZone")).toBe(false);
  });
});

describe("resolveNotifyPrefs", () => {
  test("no layers: the defaults, as a copy that can't mutate them", () => {
    const prefs = resolveNotifyPrefs([]);
    expect(prefs).toEqual(DEFAULT_NOTIFY_PREFS);
    prefs.routes.decision.channels.push("slack");
    prefs.brief.time = "01:00";
    expect(DEFAULT_NOTIFY_PREFS.routes.decision.channels).toEqual(["slack", "push"]);
    expect(DEFAULT_NOTIFY_PREFS.brief.time).toBe("08:30");
  });

  test("the project layer overrides the global layer field by field", () => {
    const global: NotifyOverride = {
      routes: { done: { channels: ["push"], when: "failures_only" }, progress: { channels: ["slack"] } },
      brief: { enabled: true, time: "07:00" },
      timezone: "Europe/Berlin",
    };
    const project: NotifyOverride = { routes: { done: { channels: [] }, decision: { when: "approvals_only" } } };
    const prefs = resolveNotifyPrefs([global, project]);
    // done: project's channels, global's condition.
    expect(prefs.routes.done).toEqual({ channels: [], when: "failures_only" });
    // progress: global's channels, the default condition.
    expect(prefs.routes.progress).toEqual({ channels: ["slack"], when: "needs_you" });
    // decision: default channels, project's condition.
    expect(prefs.routes.decision).toEqual({ channels: ["slack", "push"], when: "approvals_only" });
    expect(prefs.routes.brief).toEqual(DEFAULT_NOTIFY_PREFS.routes.brief);
    expect(prefs.brief).toEqual({ enabled: true, time: "07:00" });
    expect(prefs.timezone).toBe("Europe/Berlin");
  });

  test("null layers are skipped; a project layer's brief, timezone and brief route are ignored", () => {
    const project = { routes: { brief: { channels: ["push"] }, done: { channels: ["push"] } }, brief: { enabled: false }, timezone: "UTC" } as NotifyOverride;
    const prefs = resolveNotifyPrefs([null, project]);
    expect(prefs.routes.brief).toEqual(DEFAULT_NOTIFY_PREFS.routes.brief);
    expect(prefs.routes.done.channels).toEqual(["push"]);
    expect(prefs.brief.enabled).toBeUndefined();
    expect(prefs.timezone).toBeUndefined();
  });

  test("a stored layer with a bad field still applies its valid fields", () => {
    const stored = { routes: { done: { channels: ["email"], when: "failures_only" } }, brief: { time: "25:00", enabled: false }, timezone: "Nowhere/Land" } as unknown as NotifyOverride;
    const prefs = resolveNotifyPrefs([stored]);
    expect(prefs.routes.done).toEqual({ channels: [], when: "failures_only" });
    expect(prefs.brief).toEqual({ enabled: false, time: "08:30" });
    expect(prefs.timezone).toBeUndefined();
  });
});

describe("notifyChannelsFor", () => {
  const prefsWith = (routes: Partial<NotifyPrefs["routes"]>): NotifyPrefs => resolveNotifyPrefs([{ routes } as NotifyOverride]);

  test("always: the route's channels whatever the facts", () => {
    const prefs = prefsWith({ done: { channels: ["slack", "push"], when: "always" } });
    expect(notifyChannelsFor(prefs, "done")).toEqual(["slack", "push"]);
    expect(notifyChannelsFor(prefs, "done", { failed: true })).toEqual(["slack", "push"]);
  });

  test("failures_only: only a job closed failed or cancelled", () => {
    const prefs = prefsWith({ done: { channels: ["push"], when: "failures_only" } });
    expect(notifyChannelsFor(prefs, "done", { failed: false })).toEqual([]);
    expect(notifyChannelsFor(prefs, "done")).toEqual([]);
    expect(notifyChannelsFor(prefs, "done", { failed: true })).toEqual(["push"]);
  });

  test("needs_you: only progress about a job waiting on the user", () => {
    const prefs = prefsWith({ progress: { channels: ["slack"], when: "needs_you" } });
    expect(notifyChannelsFor(prefs, "progress", { needsYou: false })).toEqual([]);
    expect(notifyChannelsFor(prefs, "progress", { needsYou: true })).toEqual(["slack"]);
  });

  test("approvals_only: approvals, not questions", () => {
    const prefs = prefsWith({ decision: { channels: ["slack", "push"], when: "approvals_only" } });
    expect(notifyChannelsFor(prefs, "decision", { approval: false })).toEqual([]);
    expect(notifyChannelsFor(prefs, "decision", { approval: true })).toEqual(["slack", "push"]);
  });

  test("never: nothing, even when the user is needed", () => {
    const prefs = prefsWith({ progress: { channels: ["slack", "push"], when: "never" } });
    expect(notifyChannelsFor(prefs, "progress", { needsYou: true })).toEqual([]);
  });

  test("defaults: decisions to Slack and push, done to the console only, the brief to Slack, progress only when needed (and to nowhere)", () => {
    const prefs = resolveNotifyPrefs([]);
    expect(notifyChannelsFor(prefs, "decision", { approval: false })).toEqual(["slack", "push"]);
    expect(notifyChannelsFor(prefs, "done")).toEqual([]);
    expect(notifyChannelsFor(prefs, "brief")).toEqual(["slack"]);
    expect(notifyChannelsFor(prefs, "progress", { needsYou: true })).toEqual([]);
  });

  test("the returned channels are a copy", () => {
    const prefs = resolveNotifyPrefs([]);
    notifyChannelsFor(prefs, "decision").push("slack");
    expect(prefs.routes.decision.channels).toEqual(["slack", "push"]);
  });
});
