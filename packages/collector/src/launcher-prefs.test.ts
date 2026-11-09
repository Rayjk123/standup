import { expect, test, describe } from "bun:test";
import { createStore, putUserPrefs, putUserProjectPrefs, upsertProject } from "@standup/store";
import type { UserPrefs } from "@standup/shared";
import { formatUserPrefsInstruction, buildOpeningPrompt } from "./launcher.js";

/**
 * Per-user profile injection (§A/§B): the launching user's profile is appended
 * to the opening prompt (alongside the checkpoint instruction) so the agent
 * behaves per that user's prefs even on a shared collector.
 */

describe("formatUserPrefsInstruction", () => {
  test("returns empty for no profile", () => {
    expect(formatUserPrefsInstruction(null)).toBe("");
    expect(formatUserPrefsInstruction(undefined)).toBe("");
  });

  test("returns empty when every field is blank", () => {
    const prefs: UserPrefs = { alias: "alice", updatedAt: new Date() };
    expect(formatUserPrefsInstruction(prefs)).toBe("");
  });

  test("includes freeform personal instructions and names the user", () => {
    const prefs: UserPrefs = {
      alias: "alice",
      personalInstructions: "Always write tests first.",
      updatedAt: new Date(),
    };
    const out = formatUserPrefsInstruction(prefs);
    expect(out).toContain("Always write tests first.");
    expect(out).toContain("alice");
  });

  test("renders review rigor and deploy target as directives", () => {
    const prefs: UserPrefs = {
      alias: "bob",
      reviewRigor: "Adversarial review, fix all High + Medium.",
      deployTarget: { account: "111122223333", role: "Admin", command: "npx cdk deploy" },
      updatedAt: new Date(),
    };
    const out = formatUserPrefsInstruction(prefs);
    expect(out).toContain("Review rigor: Adversarial review, fix all High + Medium.");
    expect(out).toContain("account 111122223333");
    expect(out).toContain("role Admin");
    expect(out).toContain("npx cdk deploy");
    // Deploy target is context, never credentials.
    expect(out).toContain("ambient");
  });

  test("omits deploy target when it carries no field", () => {
    const prefs: UserPrefs = {
      alias: "carol",
      personalInstructions: "Be terse.",
      deployTarget: {},
      updatedAt: new Date(),
    };
    const out = formatUserPrefsInstruction(prefs);
    expect(out).toContain("Be terse.");
    expect(out).not.toContain("Deploy target");
  });
});

describe("buildOpeningPrompt injection", () => {
  test("injects the launching user's instructions alongside the checkpoint instruction", () => {
    const store = createStore(":memory:");
    putUserPrefs(store.db, "alice", {
      personalInstructions: "Always write tests first.",
      reviewRigor: "Fix all High + Medium.",
    });

    const prompt = buildOpeningPrompt(store.db, "Do the task", "alice");
    // The task and the always-present checkpoint instruction are still there...
    expect(prompt).toContain("Do the task");
    expect(prompt).toContain("checkpoint");
    // ...and so is this user's profile.
    expect(prompt).toContain("Always write tests first.");
    expect(prompt).toContain("Fix all High + Medium.");
    store.close();
  });

  test("a launch by another user injects that user's profile, not alice's", () => {
    const store = createStore(":memory:");
    putUserPrefs(store.db, "alice", { personalInstructions: "Alice-only rule." });

    const prompt = buildOpeningPrompt(store.db, "Do the task", "bob");
    expect(prompt).not.toContain("Alice-only rule.");
    // Still carries the checkpoint instruction — the injection is additive.
    expect(prompt).toContain("checkpoint");
    store.close();
  });

  test("no requester and no profile leaves the prompt unchanged but for the checkpoint instruction", () => {
    const store = createStore(":memory:");
    const withUser = buildOpeningPrompt(store.db, "Do the task", "nobody");
    const withoutUser = buildOpeningPrompt(store.db, "Do the task", undefined);
    // A user with no saved profile injects nothing, same as no requester at all.
    expect(withUser).toBe(withoutUser);
    expect(withoutUser).toContain("Do the task");
    store.close();
  });
});

describe("buildOpeningPrompt — per-project overlay (§H)", () => {
  function setUp() {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "web", name: "web", branch: "main", repos: [] });
    return store;
  }

  test("injects the MERGED global + project instructions when launching in a project", () => {
    const store = setUp();
    putUserPrefs(store.db, "alice", { personalInstructions: "GLOBAL rule." });
    putUserProjectPrefs(store.db, "alice", "web", { personalInstructions: "WEB rule." });

    const prompt = buildOpeningPrompt(store.db, "Do the task", "alice", "web");
    expect(prompt).toContain("GLOBAL rule.");
    expect(prompt).toContain("WEB rule.");
    // Project text comes AFTER the global text.
    expect(prompt.indexOf("GLOBAL rule.")).toBeLessThan(prompt.indexOf("WEB rule."));
    store.close();
  });

  test("the project's structured fields override the global ones in the prompt", () => {
    const store = setUp();
    putUserPrefs(store.db, "alice", { reviewRigor: "global rigor" });
    putUserProjectPrefs(store.db, "alice", "web", { reviewRigor: "web rigor" });

    const prompt = buildOpeningPrompt(store.db, "Do the task", "alice", "web");
    expect(prompt).toContain("Review rigor: web rigor");
    expect(prompt).not.toContain("global rigor");
    store.close();
  });

  test("an empty overlay falls back to the global profile in the prompt", () => {
    const store = setUp();
    putUserPrefs(store.db, "alice", { personalInstructions: "GLOBAL rule." });
    // No overlay saved for web.
    const prompt = buildOpeningPrompt(store.db, "Do the task", "alice", "web");
    expect(prompt).toContain("GLOBAL rule.");
    store.close();
  });

  test("per-user isolation — X's project overlay never reaches Y's prompt", () => {
    const store = setUp();
    putUserProjectPrefs(store.db, "alice", "web", { personalInstructions: "Alice-web-only." });
    const bobPrompt = buildOpeningPrompt(store.db, "Do the task", "bob", "web");
    expect(bobPrompt).not.toContain("Alice-web-only.");
    // Still carries the checkpoint instruction — the injection is additive.
    expect(bobPrompt).toContain("checkpoint");
    store.close();
  });
});
