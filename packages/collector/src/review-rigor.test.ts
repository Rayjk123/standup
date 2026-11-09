import { expect, test, describe } from "bun:test";
import {
  createStore,
  upsertProject,
  createLaunch,
  createSession,
  setSessionCreatedActor,
  createTaskRun,
  putUserPrefs,
} from "@standup/store";
import { reviewAgentNudge, reviewRigorForLaunch } from "./server.js";

/**
 * Spec §B: review rigor is injected as instruction AND is the launching user's
 * default when they trigger a review flow. reviewRigorForLaunch resolves that
 * default for a launch (via the session's created_actor, then the ledger
 * requester), and reviewAgentNudge folds it into the review-agent gate's nudge.
 */

describe("reviewAgentNudge", () => {
  test("base message when the user saved no rigor", () => {
    const out = reviewAgentNudge(undefined);
    expect(out).toContain("marked ready for review");
    expect(out).toContain("report its URL with the report_ticket_status tool (reviewUrl)");
    expect(out).not.toContain("Review to this bar");
  });

  test("appends the user's rigor as the review bar", () => {
    const out = reviewAgentNudge("Adversarial review, fix all High + Medium.");
    expect(out).toContain("marked ready for review");
    expect(out).toContain("Review to this bar");
    expect(out).toContain("Adversarial review, fix all High + Medium.");
  });

  test("a blank rigor is treated as none", () => {
    expect(reviewAgentNudge("   ")).toBe(reviewAgentNudge(undefined));
  });

  test("directs co-author trailers to the commit message, not the review's body", () => {
    const out = reviewAgentNudge(undefined, {
      providerId: "generic",
      command: "review-tool --issue I-1 --description /wt/.standup-review-description.md",
      coAuthors: ["Co-authored-by: Ana <ana@example.com>"],
      placeholders: [],
    });
    expect(out).toContain("COMMIT MESSAGE");
    expect(out).toContain("Co-authored-by: Ana <ana@example.com>");
  });
});

describe("reviewRigorForLaunch", () => {
  function setUp() {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
    return store;
  }

  test("resolves the rigor from the session's created_actor", () => {
    const store = setUp();
    putUserPrefs(store.db, "alice", { reviewRigor: "Fix all High + Medium." });
    createSession(store.db, {
      id: "S1",
      projectId: "p",
      title: "",
      cwd: "/wt/one",
      status: "running",
    });
    setSessionCreatedActor(store.db, "S1", "alice");
    const launch = createLaunch(store.db, {
      id: "L1",
      projectId: "p",
      task: "impl",
      worktreePath: "/wt/one",
      branch: "standup/one",
      tmuxSession: "tmux-one",
    });
    launch.sessionId = "S1";

    expect(reviewRigorForLaunch(store.db, launch)).toBe("Fix all High + Medium.");
    store.close();
  });

  test("falls back to the ledger requester when the session carries no actor", () => {
    const store = setUp();
    putUserPrefs(store.db, "bob", { reviewRigor: "High only." });
    const launch = createLaunch(store.db, {
      id: "L2",
      projectId: "p",
      task: "impl",
      worktreePath: "/wt/two",
      branch: "standup/two",
      tmuxSession: "tmux-two",
    });
    createTaskRun(store.db, {
      id: "R2",
      projectId: "p",
      worktreePath: "/wt/two",
      requester: "bob",
    });

    expect(reviewRigorForLaunch(store.db, launch)).toBe("High only.");
    store.close();
  });

  test("undefined when the launching user saved no rigor", () => {
    const store = setUp();
    putUserPrefs(store.db, "carol", { personalInstructions: "Be terse." });
    const launch = createLaunch(store.db, {
      id: "L3",
      projectId: "p",
      task: "impl",
      worktreePath: "/wt/three",
      branch: "standup/three",
      tmuxSession: "tmux-three",
    });
    createTaskRun(store.db, {
      id: "R3",
      projectId: "p",
      worktreePath: "/wt/three",
      requester: "carol",
    });

    expect(reviewRigorForLaunch(store.db, launch)).toBeUndefined();
    store.close();
  });

  test("undefined when no launching user is known", () => {
    const store = setUp();
    const launch = createLaunch(store.db, {
      id: "L4",
      projectId: "p",
      task: "impl",
      worktreePath: "/wt/four",
      branch: "standup/four",
      tmuxSession: "tmux-four",
    });

    expect(reviewRigorForLaunch(store.db, launch)).toBeUndefined();
    store.close();
  });
});
