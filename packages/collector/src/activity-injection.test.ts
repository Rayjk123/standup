import { expect, test, describe } from "bun:test";
import {
  createStore,
  upsertProject,
  createSession,
  assignSessionOwner,
  createLaunch,
  createPersonaJob,
  linkPersonaJobLaunch,
} from "@standup/store";
import { formatActivityContext, buildOpeningPrompt, launchActivityContext } from "./launcher.js";

/**
 * Launch-time injection of the ephemeral cross-agent activity view: a launching
 * agent is told (compactly) what other agents are doing in this project right
 * now. Nothing is excluded — the new session doesn't exist yet, and the
 * launching actor's other sessions are its sibling workers (Persona launches
 * every worker as the owner). A row names its Persona job only when the
 * launching actor owns the job. The block is absent when the project has no work.
 */
function seedProject() {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "web", name: "web", branch: "main", repos: [] });
  return store;
}

function seedSession(
  store: ReturnType<typeof seedProject>,
  id: string,
  ownerActor: string,
  title: string
) {
  createSession(store.db, {
    id,
    projectId: "web",
    title,
    cwd: "/repo",
    status: "running",
  });
  assignSessionOwner(store.db, id, ownerActor);
}

/** A session launched for a Persona job owned by `jobOwner`. */
function seedJobWorker(store: ReturnType<typeof seedProject>, id: string, jobOwner: string, jobTitle: string) {
  seedSession(store, id, jobOwner, `worker ${id}`);
  createLaunch(store.db, {
    id: `launch-${id}`,
    projectId: "web",
    task: "t",
    worktreePath: `/wt/${id}`,
    branch: `b-${id}`,
    sessionId: id,
    status: "running",
    requester: jobOwner,
  });
  const job = createPersonaJob(store.db, { owner: jobOwner, threadId: `thread-${id}`, title: jobTitle, goal: "g" });
  linkPersonaJobLaunch(store.db, job.id, `launch-${id}`);
}

function openingPrompt(store: ReturnType<typeof seedProject>, launchingActor: string): string {
  return buildOpeningPrompt(
    store.db,
    "Do the task",
    launchingActor,
    "web",
    undefined,
    "",
    "",
    false,
    "claude",
    undefined,
    launchActivityContext(store.db, "web", launchingActor)
  );
}

describe("formatActivityContext", () => {
  test("renders a bounded bullet block with title / status / actor / job", () => {
    const block = formatActivityContext([
      { sessionId: "s1", title: "Wire the auth flow", status: "running", actor: "bob", lastActivityAt: "x" },
      { sessionId: "s2", title: "", status: "done", lastActivityAt: "x" },
      {
        sessionId: "s3",
        title: "Fix the reaper",
        status: "paused",
        actor: "alice",
        job: { id: "j1", title: "Nightly improvements" },
        lastActivityAt: "x",
      },
    ]);
    expect(block).toContain("Active work in this project (active, paused, or seen in the last 24h):");
    expect(block).toContain("- Wire the auth flow — running — bob");
    // No actor -> no trailing " — actor"; empty title -> Untitled.
    expect(block).toContain("- Untitled — done");
    expect(block).toContain("- Fix the reaper — paused — alice — job: Nightly improvements");
  });

  test("caps a long title so one line can't pad out the opening prompt", () => {
    const block = formatActivityContext([
      { sessionId: "s1", title: "z".repeat(300), status: "running", actor: "bob", lastActivityAt: "x" },
    ]);
    expect(block).toContain("…");
    expect((block.match(/z/g) ?? []).length).toBeLessThanOrEqual(80);
  });

  test("empty for no work — no dangling header", () => {
    expect(formatActivityContext([])).toBe("");
  });
});

describe("activity injection into the opening prompt", () => {
  test("present when a teammate has active work", () => {
    const store = seedProject();
    seedSession(store, "teammate", "bob", "Refactor the store");

    const prompt = openingPrompt(store, "alice");
    expect(prompt).toContain("Active work in this project");
    expect(prompt).toContain("Refactor the store");
    expect(prompt).toContain("bob");
    store.close();
  });

  test("lists the launching actor's own sibling workers with their job", () => {
    const store = seedProject();
    seedJobWorker(store, "sibling", "alice", "Nightly improvements");

    const prompt = openingPrompt(store, "alice");
    expect(prompt).toContain("worker sibling — running — alice — job: Nightly improvements");
    store.close();
  });

  test("never names another user's Persona job", () => {
    const store = seedProject();
    seedJobWorker(store, "carols", "carol", "Private plan from a DM");

    const prompt = openingPrompt(store, "alice");
    expect(prompt).toContain("worker carols — running — carol");
    expect(prompt).not.toContain("Private plan from a DM");
    store.close();
  });

  test("absent when the project has no work at all", () => {
    const store = seedProject();
    const prompt = openingPrompt(store, "alice");
    expect(prompt).not.toContain("Active work in this project");
    // Still a normal prompt otherwise.
    expect(prompt).toContain("Do the task");
    store.close();
  });
});
