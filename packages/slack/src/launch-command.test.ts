// Launch-command grammar. Pure parser, no I/O: verify task + project extraction
// across the accepted forms, the leading-mention tolerance, and that a
// non-launch message parses to null (so the router keeps its ask/steer behavior).

import { describe, expect, test } from "bun:test";
import { parseLaunchCommand } from "./launch-command.js";

describe("parseLaunchCommand", () => {
  test('form 1: "launch <task> in <project>" splits task from the trailing project', () => {
    expect(parseLaunchCommand("launch add a health check in standup")).toEqual({
      task: "add a health check",
      project: "standup",
      projectInferred: true,
    });
  });

  test('form 2: "launch: <task> project=<id>" extracts the explicit id (not inferred)', () => {
    expect(parseLaunchCommand("launch: add a health check project=standup")).toEqual({
      task: "add a health check",
      project: "standup",
    });
  });

  test("no project clause → task only (caller applies its default)", () => {
    expect(parseLaunchCommand("launch fix the flaky test")).toEqual({
      task: "fix the flaky test",
    });
  });

  test("a task containing ' in ' still targets the LAST ' in ' as the project", () => {
    expect(parseLaunchCommand("launch fix the bug in the parser in compiler-proj")).toEqual({
      task: "fix the bug in the parser",
      project: "compiler-proj",
      projectInferred: true,
    });
  });

  test("a bare ' in ' with no project clause is flagged inferred (caller downgrades a miss)", () => {
    // The greedy split still names a "project", but projectInferred lets the
    // caller fall back to the default project when it doesn't resolve — so an
    // ordinary "fix the bug in the parser" doesn't 404 on a phantom project.
    expect(parseLaunchCommand("launch fix the bug in the parser")).toEqual({
      task: "fix the bug",
      project: "the parser",
      projectInferred: true,
    });
  });

  test("a leading bot @-mention is tolerated", () => {
    expect(parseLaunchCommand("<@U0BOT> launch build the login page in web")).toEqual({
      task: "build the login page",
      project: "web",
      projectInferred: true,
    });
  });

  test("project= wins over a ' in ' that appears in the task", () => {
    expect(parseLaunchCommand("launch wire up sign in project=auth")).toEqual({
      task: "wire up sign in",
      project: "auth",
    });
  });

  test("a quoted project= value is unwrapped (multi-word name)", () => {
    expect(parseLaunchCommand('launch: add tests project="My Project"')).toEqual({
      task: "add tests",
      project: "My Project",
    });
  });

  test("a multi-word project name after ' in ' is kept whole", () => {
    expect(parseLaunchCommand("launch add tests in My Project")).toEqual({
      task: "add tests",
      project: "My Project",
      projectInferred: true,
    });
  });

  test("the launch verb is case-insensitive and the colon is optional", () => {
    expect(parseLaunchCommand("Launch: refactor the store")).toEqual({
      task: "refactor the store",
    });
  });

  test("a non-launch message parses to null", () => {
    expect(parseLaunchCommand("run the tests")).toBeNull();
    expect(parseLaunchCommand("please launch this later")).toBeNull(); // 'launch' not at the start
    expect(parseLaunchCommand("")).toBeNull();
    expect(parseLaunchCommand(undefined)).toBeNull();
  });

  test("the verb alone (no task) is not a launch command", () => {
    expect(parseLaunchCommand("launch")).toBeNull();
    expect(parseLaunchCommand("launch:")).toBeNull();
    expect(parseLaunchCommand("launch   ")).toBeNull();
  });

  test("project= with an empty task is rejected", () => {
    expect(parseLaunchCommand("launch project=standup")).toBeNull();
  });

  describe("requireMentionOf (mirror-thread surface)", () => {
    test("a bare 'launch …' is NOT a command when a bot mention is required", () => {
      // The hijack the finding describes: an ordinary steer/ask reply that happens
      // to start with 'launch' must not be treated as a Standup launch command.
      expect(parseLaunchCommand("launch it with vitest", { requireMentionOf: "U0BOT" })).toBeNull();
      expect(
        parseLaunchCommand("launch the dev server and tail the logs", { requireMentionOf: "U0BOT" }),
      ).toBeNull();
    });

    test("an explicit mention of THIS bot makes it a launch command", () => {
      expect(
        parseLaunchCommand("<@U0BOT> launch add a health check in standup", { requireMentionOf: "U0BOT" }),
      ).toEqual({ task: "add a health check", project: "standup", projectInferred: true });
    });

    test("a labeled mention (<@id|label>) of this bot still parses", () => {
      expect(
        parseLaunchCommand("<@U0BOT|standup> launch fix the bug in web", { requireMentionOf: "U0BOT" }),
      ).toEqual({ task: "fix the bug", project: "web", projectInferred: true });
    });

    test("a mention of a DIFFERENT user is not a command for this bot", () => {
      expect(
        parseLaunchCommand("<@U0SOMEONE> launch do a thing in web", { requireMentionOf: "U0BOT" }),
      ).toBeNull();
    });
  });

  describe("launch flags (harness / model / effort)", () => {
    test("harness=, model=, effort= are pulled out of the body, wherever they appear", () => {
      expect(
        parseLaunchCommand("launch harness=codex model=gpt-5-codex effort=high add a health check in standup"),
      ).toEqual({
        task: "add a health check",
        project: "standup",
        projectInferred: true,
        harness: "codex",
        model: "gpt-5-codex",
        effort: "high",
      });
    });

    test("flags coexist with an explicit project= clause", () => {
      expect(parseLaunchCommand("launch: refactor the store harness=codex project=standup")).toEqual({
        task: "refactor the store",
        project: "standup",
        harness: "codex",
      });
    });

    test("a command with no flags is unchanged (no present-but-undefined keys)", () => {
      expect(parseLaunchCommand("launch fix the flaky test")).toEqual({ task: "fix the flaky test" });
    });

    test("model= does not swallow the model= inside no such prefix, and effort is independent", () => {
      // Only the three known flags are extracted; the rest is the task.
      expect(parseLaunchCommand("launch effort=low tidy the logs")).toEqual({
        task: "tidy the logs",
        effort: "low",
      });
    });

    test("a quoted flag value is unwrapped", () => {
      expect(parseLaunchCommand('launch model="gpt-5-codex" build it')).toEqual({
        task: "build it",
        model: "gpt-5-codex",
      });
    });
  });
});
