import { expect, test, describe } from "bun:test";
import { createStore } from "../store.js";
import {
  upsertProject,
  putUserPrefs,
  putUserProjectPrefs,
  getUserProjectPrefs,
  getEffectiveUserPrefs,
} from "../index.js";

/**
 * The overlay's merge/precedence contract (see mergeUserPrefs): getEffectiveUserPrefs layers
 * a user's per-(alias, project) overlay on top of their global profile, mirroring
 * CLAUDE.md's global + per-project layering. `personalInstructions` are additive
 * (global first, then project); `reviewRigor` / `deployTarget` are single choices
 * the project OVERRIDES when it sets them, else the global stands.
 */

const GLOBAL = {
  personalInstructions: "Global: be terse.",
  reviewRigor: "Global rigor: High only.",
  deployTarget: { account: "111", role: "GlobalRole", command: "global-deploy" },
};

describe("getEffectiveUserPrefs — global + per-project overlay merge", () => {
  test("layers project instructions after global and lets the project override structured fields", () => {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "webapp", name: "webapp", branch: "main", repos: [] });
    putUserPrefs(store.db, "alice", GLOBAL);
    putUserProjectPrefs(store.db, "alice", "webapp", {
      personalInstructions: "Project: prefer functional style.",
      reviewRigor: "Project rigor: adversarial, all High + Medium.",
      deployTarget: { account: "222", command: "cdk deploy WebApp" },
    });

    const eff = getEffectiveUserPrefs(store.db, "alice", "webapp")!;
    expect(eff.alias).toBe("alice");
    expect(eff.projectId).toBe("webapp");
    // BOTH texts apply — global first, then the project text refines it.
    expect(eff.personalInstructions).toBe(
      "Global: be terse.\n\nProject: prefer functional style."
    );
    // Structured fields: the project value wins wholesale when the overlay sets it.
    expect(eff.reviewRigor).toBe("Project rigor: adversarial, all High + Medium.");
    expect(eff.deployTarget).toEqual({ account: "222", command: "cdk deploy WebApp" });
    store.close();
  });

  test("a structured field the overlay omits falls back to the global value", () => {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "docs", name: "docs", branch: "main", repos: [] });
    putUserPrefs(store.db, "alice", GLOBAL);
    // Overlay carries only project instructions; the structured fields are unset.
    putUserProjectPrefs(store.db, "alice", "docs", {
      personalInstructions: "Project: cite sources.",
    });

    const eff = getEffectiveUserPrefs(store.db, "alice", "docs")!;
    expect(eff.personalInstructions).toBe("Global: be terse.\n\nProject: cite sources.");
    // Neither structured field is set on the overlay → both fall back to global.
    expect(eff.reviewRigor).toBe("Global rigor: High only.");
    expect(eff.deployTarget).toEqual({
      account: "111",
      role: "GlobalRole",
      command: "global-deploy",
    });
    store.close();
  });

  test("an EMPTY overlay falls back entirely to the global profile", () => {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "blank", name: "blank", branch: "main", repos: [] });
    putUserPrefs(store.db, "alice", GLOBAL);
    // Blank strings and an all-empty deploy target normalize to unset, so the
    // stored overlay row carries no content of its own.
    putUserProjectPrefs(store.db, "alice", "blank", {
      personalInstructions: "   ",
      reviewRigor: "",
      deployTarget: { account: "", role: "  ", command: "" },
    });

    const overlay = getUserProjectPrefs(store.db, "alice", "blank")!;
    expect(overlay.personalInstructions).toBeUndefined();
    expect(overlay.reviewRigor).toBeUndefined();
    expect(overlay.deployTarget).toBeUndefined();

    const eff = getEffectiveUserPrefs(store.db, "alice", "blank")!;
    // No project text appended, and the structured fields are the global's.
    expect(eff.personalInstructions).toBe("Global: be terse.");
    expect(eff.reviewRigor).toBe("Global rigor: High only.");
    expect(eff.deployTarget).toEqual({
      account: "111",
      role: "GlobalRole",
      command: "global-deploy",
    });
    store.close();
  });

  test("no overlay for the project is just the global profile", () => {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "webapp", name: "webapp", branch: "main", repos: [] });
    putUserPrefs(store.db, "alice", GLOBAL);

    const eff = getEffectiveUserPrefs(store.db, "alice", "webapp")!;
    expect(eff.personalInstructions).toBe("Global: be terse.");
    expect(eff.reviewRigor).toBe("Global rigor: High only.");
    store.close();
  });

  test("the overlay is per-user — one alias's project text never leaks to another", () => {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "webapp", name: "webapp", branch: "main", repos: [] });
    // Alice keeps a project overlay; Bob has only a global profile, no overlay.
    putUserPrefs(store.db, "alice", { personalInstructions: "Alice global." });
    putUserProjectPrefs(store.db, "alice", "webapp", {
      personalInstructions: "Alice project: prefer functional style.",
    });
    putUserPrefs(store.db, "bob", { personalInstructions: "Bob global." });

    const bob = getEffectiveUserPrefs(store.db, "bob", "webapp")!;
    expect(bob.alias).toBe("bob");
    expect(bob.personalInstructions).toBe("Bob global.");
    expect(bob.personalInstructions).not.toContain("functional style");
    store.close();
  });

  test("a write for an unknown project id is rejected by the project FK", () => {
    const store = createStore(":memory:");
    putUserPrefs(store.db, "alice", GLOBAL);
    // No project row exists for "ghost"; the overlay's project_id FK refuses it,
    // so an overlay can never outlive (or precede) its project.
    expect(() =>
      putUserProjectPrefs(store.db, "alice", "ghost", {
        personalInstructions: "Project text for a project that isn't there.",
      })
    ).toThrow();
    expect(getUserProjectPrefs(store.db, "alice", "ghost")).toBeNull();
    store.close();
  });
});
