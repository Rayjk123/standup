import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import {
  createStore,
  upsertProject,
  createSession,
  setSessionCreatedActor,
  createLaunch,
  updateLaunchStatus,
  markLaunchReaped,
  createPersonaJob,
  linkPersonaJobLaunch,
  endSession,
  setLaunchReviewTokenHash,
  updatePersonaJob,
} from "@standup/store";
import type { Store } from "@standup/store";
import { DEFAULT_IDENTITY_HEADER, WORKER_TOKEN_HEADER } from "@standup/shared";
import { workerTokenHash } from "./floor/gate.js";
import { createServer } from "./server.js";

/**
 * whats_happening from a worker Persona launched: every worker Persona starts is
 * owned by the owner it acts for, so the caller and its sibling workers share
 * one actor. The route must exclude only the caller's own session, list the
 * siblings — running, idle and idle-paused — with their status and Persona job,
 * and keep a paused worker listed after the 24h recency window. The host user
 * is the owner here, as on a single-owner box; a job title reaches only an
 * identity proven to own the job.
 */

interface WorkItem {
  sessionId: string;
  title: string;
  status: string;
  actor?: string;
  job?: { id: string; title: string };
}

const OWNER = "owner";
const CALLER_TOKEN = "caller-worker-token";

/** A worker session launched by Persona for `jobId`, owned by `owner` (OWNER by default). */
function launchWorker(
  store: Store,
  id: string,
  opts: { jobId?: string; status?: "running" | "idle"; owner?: string } = {}
): void {
  const owner = opts.owner ?? OWNER;
  createSession(store.db, {
    id,
    projectId: "p1",
    title: `worker ${id}`,
    cwd: `/tmp/wt/${id}`,
    status: opts.status ?? "running",
  });
  setSessionCreatedActor(store.db, id, owner);
  createLaunch(store.db, {
    id: `launch-${id}`,
    projectId: "p1",
    task: `task ${id}`,
    worktreePath: `/tmp/wt/${id}`,
    branch: `b-${id}`,
    sessionId: id,
    status: "running",
    requester: owner,
    launchedBy: owner,
  });
  if (opts.jobId) linkPersonaJobLaunch(store.db, opts.jobId, `launch-${id}`);
}

/** Stops `id`'s idle pane the way the reaper does, its last activity `hoursAgo` back. */
function pauseWorker(store: Store, id: string, hoursAgo = 0): void {
  endSession(store.db, id);
  markLaunchReaped(store.db, `launch-${id}`, "idle");
  if (hoursAgo > 0) {
    store.db.run(
      `UPDATE sessions SET started_at = datetime('now', '-${hoursAgo + 2} hours'), ended_at = datetime('now', '-${hoursAgo} hours') WHERE id = ?`,
      [id]
    );
  }
}

function setUp(): { store: Store; app: ReturnType<typeof createServer>; jobId: string } {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p1", name: "p1", branch: "main", repos: [] });
  const job = createPersonaJob(store.db, {
    owner: OWNER,
    threadId: "thread-1",
    title: "Nightly improvements",
    goal: "ship five fixes",
  });
  // The caller: one of the job's workers, asking what its siblings are doing.
  launchWorker(store, "caller", { jobId: job.id });
  setLaunchReviewTokenHash(store.db, "launch-caller", workerTokenHash(CALLER_TOKEN));
  return { store, app: createServer(store, () => {}, null), jobId: job.id };
}

/** The caller worker's whats_happening call, as its MCP server sends it: correlation plus its worker token. */
async function whatsHappening(app: ReturnType<typeof createServer>): Promise<WorkItem[]> {
  const res = await app.request("/api/active-work", {
    method: "POST",
    headers: { "content-type": "application/json", [WORKER_TOKEN_HEADER]: CALLER_TOKEN },
    body: JSON.stringify({ session_id: "caller", cwd: "/tmp/wt/caller", scoped: true }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { work: WorkItem[] }).work;
}

let savedToken: string | undefined;
let savedBind: string | undefined;
let savedUser: string | undefined;
beforeEach(() => {
  savedToken = process.env.STANDUP_WRITE_TOKEN;
  savedBind = process.env.STANDUP_BIND_HOST;
  savedUser = process.env.USER;
  delete process.env.STANDUP_WRITE_TOKEN;
  delete process.env.STANDUP_BIND_HOST;
  process.env.USER = OWNER;
});
afterEach(() => {
  if (savedToken === undefined) delete process.env.STANDUP_WRITE_TOKEN;
  else process.env.STANDUP_WRITE_TOKEN = savedToken;
  if (savedBind === undefined) delete process.env.STANDUP_BIND_HOST;
  else process.env.STANDUP_BIND_HOST = savedBind;
  if (savedUser === undefined) delete process.env.USER;
  else process.env.USER = savedUser;
});

describe("POST /api/active-work — workers launched by the caller's own owner", () => {
  test("running launched workers are listed with their job and status; the caller's own session is not", async () => {
    const { store, app, jobId } = setUp();
    launchWorker(store, "w-run-1", { jobId });
    launchWorker(store, "w-run-2", { jobId });

    const work = await whatsHappening(app);
    const ids = work.map((w) => w.sessionId);
    expect(ids).toContain("w-run-1");
    expect(ids).toContain("w-run-2");
    expect(ids).not.toContain("caller");
    const run1 = work.find((w) => w.sessionId === "w-run-1");
    expect(run1?.status).toBe("running");
    expect(run1?.actor).toBe(OWNER);
    expect(run1?.job).toEqual({ id: jobId, title: "Nightly improvements" });
    store.close();
  });

  test("idle launched workers are listed as idle", async () => {
    const { store, app, jobId } = setUp();
    launchWorker(store, "w-idle", { jobId, status: "idle" });

    const work = await whatsHappening(app);
    const idle = work.find((w) => w.sessionId === "w-idle");
    expect(idle?.status).toBe("idle");
    expect(idle?.job?.id).toBe(jobId);
    store.close();
  });

  test("an idle-paused worker reads paused, and stays listed after the 24h window", async () => {
    const { store, app, jobId } = setUp();
    launchWorker(store, "w-paused", { jobId });
    launchWorker(store, "w-paused-old", { jobId });
    // The reaper stopped both idle panes: the session reads ended, the launch
    // stays running with reaped_at set, so a message resumes the worker.
    for (const id of ["w-paused", "w-paused-old"]) {
      endSession(store.db, id);
      markLaunchReaped(store.db, `launch-${id}`, "idle");
    }
    // One of them went quiet two days ago — outside the recency window.
    store.db.run(
      "UPDATE sessions SET started_at = datetime('now', '-50 hours'), ended_at = datetime('now', '-48 hours') WHERE id = 'w-paused-old'"
    );

    const work = await whatsHappening(app);
    expect(work.find((w) => w.sessionId === "w-paused")?.status).toBe("paused");
    const old = work.find((w) => w.sessionId === "w-paused-old");
    expect(old?.status).toBe("paused");
    expect(old?.job?.title).toBe("Nightly improvements");
    store.close();
  });

  test("a reaped worker whose launch was cleaned is no longer paused and drops out after the window", async () => {
    const { store, app } = setUp();
    launchWorker(store, "w-gone");
    endSession(store.db, "w-gone");
    markLaunchReaped(store.db, "launch-w-gone", "idle");
    updateLaunchStatus(store.db, "launch-w-gone", "cleaned");
    store.db.run(
      "UPDATE sessions SET started_at = datetime('now', '-50 hours'), ended_at = datetime('now', '-48 hours') WHERE id = 'w-gone'"
    );

    const ids = (await whatsHappening(app)).map((w) => w.sessionId);
    expect(ids).not.toContain("w-gone");
    store.close();
  });

  test("a paused worker of a closed job is not paused: nothing resumes it, so it drops out after the window", async () => {
    const { store, app, jobId } = setUp();
    const closed = createPersonaJob(store.db, { owner: OWNER, threadId: "thread-2", title: "Old job", goal: "g" });
    launchWorker(store, "w-closed", { jobId: closed.id });
    launchWorker(store, "w-closed-recent", { jobId: closed.id });
    launchWorker(store, "w-open", { jobId });
    pauseWorker(store, "w-closed", 48);
    pauseWorker(store, "w-closed-recent");
    pauseWorker(store, "w-open", 48);
    updatePersonaJob(store.db, closed.id, { status: "done" });

    const work = await whatsHappening(app);
    const ids = work.map((w) => w.sessionId);
    expect(ids).not.toContain("w-closed");
    // Inside the window it still shows, under its own status rather than paused.
    expect(work.find((w) => w.sessionId === "w-closed-recent")?.status).toBe("idle");
    expect(work.find((w) => w.sessionId === "w-open")?.status).toBe("paused");
    store.close();
  });

  test("paused follows the session's live launch, as getLaunchBySession picks it, not merely the newest row", async () => {
    const { store, app, jobId } = setUp();
    launchWorker(store, "w-adopted", { jobId });
    pauseWorker(store, "w-adopted", 48);
    // A newer, dead launch row for the same session id (an adoption that failed).
    createLaunch(store.db, {
      id: "launch-w-adopted-2",
      projectId: "p1",
      task: "t",
      worktreePath: "/tmp/wt/w-adopted-2",
      branch: "b-adopted-2",
      sessionId: "w-adopted",
      status: "failed",
    });
    store.db.run("UPDATE launches SET created_at = datetime('now', '+1 minute') WHERE id = 'launch-w-adopted-2'");

    const work = await whatsHappening(app);
    const adopted = work.find((w) => w.sessionId === "w-adopted");
    expect(adopted?.status).toBe("paused");
    expect(adopted?.job?.id).toBe(jobId);
    store.close();
  });

  test("a job's title shows only to its owner; another project member sees the worker without it", async () => {
    const { store, app, jobId } = setUp();
    launchWorker(store, "w-run", { jobId });
    createSession(store.db, { id: "carol-s", projectId: "p1", title: "carol's", cwd: "/tmp/carol", status: "running" });
    setSessionCreatedActor(store.db, "carol-s", "carol");

    const res = await app.request("/api/active-work", {
      method: "POST",
      headers: { "content-type": "application/json", [DEFAULT_IDENTITY_HEADER]: "carol" },
      body: JSON.stringify({ session_id: "carol-s", cwd: "/tmp/carol" }),
    });
    const work = ((await res.json()) as { work: WorkItem[] }).work;
    const run = work.find((w) => w.sessionId === "w-run");
    expect(run?.status).toBe("running");
    expect(run?.job).toBeUndefined();
    expect(JSON.stringify(work)).not.toContain("Nightly improvements");
    store.close();
  });

  test("a worker whose job runs for another user resolves through its worker token, not the host user", async () => {
    process.env.USER = "hostop";
    const { store, app } = setUp();
    const guestJob = createPersonaJob(store.db, { owner: "guest", threadId: "thread-g", title: "Guest job", goal: "g" });
    launchWorker(store, "g-caller", { jobId: guestJob.id, owner: "guest" });
    launchWorker(store, "g-sibling", { jobId: guestJob.id, owner: "guest" });
    setLaunchReviewTokenHash(store.db, "launch-g-caller", workerTokenHash("guest-worker-token"));
    const body = JSON.stringify({ session_id: "g-caller", cwd: "/tmp/wt/g-caller" });

    // Without the token the local call reads as the host user, who owns no
    // session here, so the project can't be resolved — and says so.
    const bare = await app.request("/api/active-work", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(await bare.json()).toEqual({ work: [], unresolved: true });

    const res = await app.request("/api/active-work", {
      method: "POST",
      headers: { "content-type": "application/json", [WORKER_TOKEN_HEADER]: "guest-worker-token" },
      body,
    });
    const work = ((await res.json()) as { work: WorkItem[] }).work;
    const ids = work.map((w) => w.sessionId);
    expect(ids).toContain("g-sibling");
    expect(ids).not.toContain("g-caller");
    expect(work.find((w) => w.sessionId === "g-sibling")?.job?.title).toBe("Guest job");

    // A wrong token confers nothing.
    const forged = await app.request("/api/active-work", {
      method: "POST",
      headers: { "content-type": "application/json", [WORKER_TOKEN_HEADER]: "not-the-token" },
      body,
    });
    expect(((await forged.json()) as { work: WorkItem[] }).work).toEqual([]);
    store.close();
  });

  test("a worker token reads as the launch's trusted owner, never its caller-named requester", async () => {
    process.env.USER = "hostop";
    const { store, app, jobId } = setUp();
    launchWorker(store, "w-run", { jobId });
    // A guest's worker whose launch named OWNER as its requester.
    createSession(store.db, { id: "g-forger", projectId: "p1", title: "forger", cwd: "/tmp/wt/g-forger", status: "running" });
    setSessionCreatedActor(store.db, "g-forger", "guest");
    createLaunch(store.db, {
      id: "launch-g-forger",
      projectId: "p1",
      task: "t",
      worktreePath: "/tmp/wt/g-forger",
      branch: "b-forger",
      sessionId: "g-forger",
      status: "running",
      requester: OWNER,
      launchedBy: "guest",
    });
    setLaunchReviewTokenHash(store.db, "launch-g-forger", workerTokenHash("forger-token"));

    const res = await app.request("/api/active-work", {
      method: "POST",
      headers: { "content-type": "application/json", [WORKER_TOKEN_HEADER]: "forger-token" },
      body: JSON.stringify({ session_id: "g-forger" }),
    });
    const work = ((await res.json()) as { work: WorkItem[] }).work;
    expect(work.find((w) => w.sessionId === "w-run")?.status).toBe("running");
    expect(JSON.stringify(work)).not.toContain("Nightly improvements");
    store.close();
  });

  test("a call without a worker token sees the sibling workers but no job title, even as the host owner", async () => {
    const { store, app, jobId } = setUp();
    launchWorker(store, "w-run", { jobId });
    createSession(store.db, { id: "bob-s", projectId: "p1", title: "bob's", cwd: "/tmp/bob", status: "running" });
    setSessionCreatedActor(store.db, "bob-s", "bob");

    // Header-less loopback with the caller's session: reads as the host owner,
    // with no proof of it.
    const local = await app.request("/api/active-work", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "caller", cwd: "/tmp/wt/caller" }),
    });
    const localWork = ((await local.json()) as { work: WorkItem[] }).work;
    expect(localWork.find((w) => w.sessionId === "w-run")?.status).toBe("running");
    expect(JSON.stringify(localWork)).not.toContain("Nightly improvements");

    // The Slack adapter's shape: loopback, no header, the invoker named in `actor`.
    const slack = await app.request("/api/active-work", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "p1", actor: "bob" }),
    });
    const slackWork = ((await slack.json()) as { work: WorkItem[] }).work;
    expect(slackWork.find((w) => w.sessionId === "w-run")?.status).toBe("running");
    expect(JSON.stringify(slackWork)).not.toContain("Nightly improvements");
    store.close();
  });

  test("a body actor naming the job owner never unlocks the job's title", async () => {
    process.env.USER = "hostop";
    const { store, app, jobId } = setUp();
    launchWorker(store, "w-run", { jobId });

    // A header-less loopback call naming OWNER and one of OWNER's sessions:
    // honored for scope (the Slack adapter's override), so the sibling shows,
    // but never as proof of owning the job.
    const res = await app.request("/api/active-work", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "caller", actor: OWNER }),
    });
    const work = ((await res.json()) as { work: WorkItem[] }).work;
    expect(work.find((w) => w.sessionId === "w-run")?.status).toBe("running");
    expect(JSON.stringify(work)).not.toContain("Nightly improvements");
    store.close();
  });

  test("a subagent caller excludes its own root session, not its owner's other workers", async () => {
    const { store, app, jobId } = setUp();
    launchWorker(store, "w-sibling", { jobId });
    createSession(store.db, {
      id: "caller:agent-1",
      projectId: "p1",
      title: "subagent",
      cwd: "/tmp/wt/caller",
      status: "running",
      parentSessionId: "caller",
    });
    setSessionCreatedActor(store.db, "caller:agent-1", OWNER);

    const res = await app.request("/api/active-work", {
      method: "POST",
      headers: { "content-type": "application/json", [DEFAULT_IDENTITY_HEADER]: OWNER },
      body: JSON.stringify({ session_id: "caller:agent-1" }),
    });
    const ids = ((await res.json()) as { work: WorkItem[] }).work.map((w) => w.sessionId);
    expect(ids).toContain("w-sibling");
    expect(ids).not.toContain("caller");
    store.close();
  });
});
