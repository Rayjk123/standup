import { describe, expect, test } from "bun:test";
import { randomBytes } from "crypto";
import {
  createLaunch,
  createSteer,
  createStore,
  createTaskRun,
  getActiveTaskRunByWorktree,
  getLaunch,
  getLaunchBySession,
  getLaunchHookAuth,
  getPendingAsksBySession,
  getRecentEventsBySession,
  getSession,
  setLaunchHookTokenHash,
  updateLaunchStatus,
  upsertProject,
} from "@standup/store";
import type { Store } from "@standup/store";
import { HOOK_CLIENT_TIMEOUT_SECONDS, STANDUP_HOOK_EVENTS } from "@standup/shared";
import { createServer } from "./server.js";
import {
  HOOK_TOKEN_ENV,
  HOOK_TOKEN_HEADER,
  WORKER_HOOK_PATH,
  buildFloorHookSettings,
  workerTokenHash,
  type FloorConfig,
} from "./floor/gate.js";
import { authorizeHookEvent } from "./hook-auth.js";

/*
 * The /hook route takes a launched worker's events only from its own
 * token-presenting hooks once its token is proven (hook-auth.ts). These drive
 * the real route with forged and real events and check what was recorded.
 */

const WT_A = "/work/wt-a";
const WT_B = "/work/wt-b";
const WT_LEGACY = "/work/wt-legacy";
const OWNER_CWD = "/home/owner/repo";

interface World {
  store: Store;
  app: ReturnType<typeof createServer>;
  tokenA: string;
  tokenB: string;
}

function token(): string {
  return randomBytes(32).toString("hex");
}

/** Launches A and B have hook tokens; the legacy launch predates them. */
function makeWorld(): World {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [OWNER_CWD] });
  upsertProject(store.db, { id: "scratch", name: "scratch", branch: "main", repos: [] });
  const app = createServer(store, () => {}, null);
  const tokens = { tokenA: token(), tokenB: token() };
  for (const [id, wt, t] of [
    ["la", WT_A, tokens.tokenA],
    ["lb", WT_B, tokens.tokenB],
    ["ll", WT_LEGACY, undefined],
  ] as const) {
    createLaunch(store.db, { id, projectId: "p", task: `task ${id}`, worktreePath: wt, branch: `b-${id}`, status: "running" });
    if (t) setLaunchHookTokenHash(store.db, id, workerTokenHash(t));
  }
  return { store, app, ...tokens };
}

function hook(w: World, body: Record<string, unknown>, hookToken?: string) {
  return w.app.request(hookToken ? WORKER_HOOK_PATH : "/hook", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(hookToken ? { [HOOK_TOKEN_HEADER]: hookToken } : {}) },
    body: JSON.stringify({ transcript_path: "/none.jsonl", ...body }),
  });
}

const events = (w: World, sessionId: string) => getRecentEventsBySession(w.store.db, sessionId, 500).length;
const prompt = (sessionId: string, cwd: string) => ({ session_id: sessionId, cwd, hook_event_name: "UserPromptSubmit", prompt: "go" });

/**
 * Brings each worker's session in through its own hook (proving its token),
 * and the owner's and the legacy worker's through the global one. The owner's
 * session predates the launches.
 */
async function started(w: World) {
  expect((await hook(w, prompt("sa", WT_A), w.tokenA)).status).toBe(200);
  expect((await hook(w, prompt("sb", WT_B), w.tokenB)).status).toBe(200);
  expect((await hook(w, prompt("sl", WT_LEGACY))).status).toBe(200);
  expect((await hook(w, prompt("so", OWNER_CWD))).status).toBe(200);
  w.store.db.run("UPDATE sessions SET started_at = '2020-01-01 00:00:00' WHERE id = 'so'");
  expect(getLaunchBySession(w.store.db, "sa")?.id).toBe("la");
  expect(getLaunchBySession(w.store.db, "sb")?.id).toBe("lb");
  expect(getLaunchBySession(w.store.db, "sl")?.id).toBe("ll");
  expect(getLaunchHookAuth(w.store.db, "la")).toBe(true);
  expect(getLaunchHookAuth(w.store.db, "ll")).toBe(false);
}

/** A minimal body for each event type the collector handles. */
function eventBody(event: string, sessionId: string, cwd: string): Record<string, unknown> {
  const base = { session_id: sessionId, cwd, hook_event_name: event };
  switch (event) {
    case "SessionStart":
      return { ...base, source: "resume" };
    case "SessionEnd":
      return { ...base, reason: "other" };
    case "UserPromptSubmit":
      return { ...base, prompt: "do the thing" };
    case "PreToolUse":
      return { ...base, tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "tu1" };
    case "PostToolUse":
      return { ...base, tool_name: "Bash", tool_input: { command: "ls" }, tool_response: { stdout: "" }, tool_use_id: "tu1" };
    case "SubagentStart":
      return { ...base, agent_id: "ag1", agent_type: "Explore" };
    case "SubagentStop":
      return { ...base, agent_id: "ag1", agent_type: "Explore", stop_hook_active: false };
    case "Stop":
      return { ...base, stop_hook_active: false };
    case "Notification":
      return { ...base, message: "Claude needs your permission to use Bash", notification_type: "permission_prompt" };
    default:
      return base;
  }
}

describe("forged and real hook events for a worker session", () => {
  test("a forged event with no token is ignored: 202, and nothing is recorded", async () => {
    const w = makeWorld();
    await started(w);
    const before = events(w, "sa");
    const res = await hook(w, eventBody("Stop", "sa", WT_A));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ignored: true });
    expect(events(w, "sa")).toBe(before);
    expect(getSession(w.store.db, "sa")?.status).toBe("running");
  });

  test("a forged prompt doesn't take the worker's steers; its own hook delivers them once", async () => {
    const w = makeWorld();
    await started(w);
    createSteer(w.store.db, "sa", "switch to the smaller fix");
    const forged = await hook(w, eventBody("UserPromptSubmit", "sa", WT_A));
    expect(forged.status).toBe(202);
    expect(JSON.stringify(await forged.json())).not.toContain("smaller fix");
    const real = await hook(w, eventBody("UserPromptSubmit", "sa", WT_A), w.tokenA);
    expect(JSON.stringify(await real.json())).toContain("switch to the smaller fix");
    const again = await hook(w, eventBody("UserPromptSubmit", "sa", WT_A), w.tokenA);
    expect(JSON.stringify(await again.json())).not.toContain("smaller fix");
  });

  test("a forged SessionEnd doesn't end the worker's session, and a forged Notification raises no ask", async () => {
    const w = makeWorld();
    await started(w);
    expect((await hook(w, eventBody("SessionEnd", "sa", WT_A))).status).toBe(202);
    expect(getSession(w.store.db, "sa")?.endedAt).toBeUndefined();
    expect((await hook(w, eventBody("Notification", "sa", WT_A))).status).toBe(202);
    expect(getPendingAsksBySession(w.store.db, "sa")).toHaveLength(0);
  });

  test("an event carrying another session's token is refused 403 with a body that names nothing", async () => {
    const w = makeWorld();
    await started(w);
    const before = events(w, "sa");
    const res = await hook(w, eventBody("Stop", "sa", WT_A), w.tokenB);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "hook token refused" });
    expect(events(w, "sa")).toBe(before);
  });

  test("a made-up token is refused 403 for an enforced session, and ignored elsewhere", async () => {
    const w = makeWorld();
    await started(w);
    const before = events(w, "sa");
    expect((await hook(w, eventBody("Stop", "sa", WT_A), token())).status).toBe(403);
    expect(events(w, "sa")).toBe(before);
    // A hook whose env var didn't resolve sends the literal name: the global copy carries the event.
    const owner = events(w, "so");
    expect((await hook(w, eventBody("Stop", "so", OWNER_CWD), `$${HOOK_TOKEN_ENV}`)).status).toBe(202);
    expect(events(w, "so")).toBe(owner);
    // A cleaned launch's token resolves to nothing live, and its session no longer enforces.
    updateLaunchStatus(w.store.db, "lb", "cleaned");
    expect((await hook(w, eventBody("Stop", "sb", WT_B), w.tokenB)).status).toBe(202);
  });

  test("a token that ended its own session still can't claim the owner's sessions", async () => {
    const w = makeWorld();
    await started(w);
    expect((await hook(w, eventBody("SessionEnd", "sa", WT_A), w.tokenA)).status).toBe(200);
    // An owner session begun after the launch, outside its worktree.
    expect((await hook(w, prompt("so-new", OWNER_CWD))).status).toBe(200);
    expect((await hook(w, eventBody("Stop", "so-new", OWNER_CWD), w.tokenA)).status).toBe(403);
    // One in the worktree, first seen longer ago than the claim window.
    expect((await hook(w, prompt("so-old", WT_A))).status).toBe(200);
    w.store.db.run("UPDATE sessions SET started_at = datetime('now', '-120 seconds') WHERE id = 'so-old'");
    expect((await hook(w, eventBody("Stop", "so-old", WT_A), w.tokenA)).status).toBe(403);
    expect(getLaunchBySession(w.store.db, "so-new")).toBeNull();
    expect(getLaunchBySession(w.store.db, "so-old")).toBeNull();
    // Its owner keeps reporting.
    expect((await hook(w, eventBody("Stop", "so-new", OWNER_CWD))).status).toBe(200);
  });

  test("an event with the session's own token is processed", async () => {
    const w = makeWorld();
    await started(w);
    const before = events(w, "sa");
    expect((await hook(w, eventBody("Stop", "sa", WT_A), w.tokenA)).status).toBe(200);
    expect(events(w, "sa")).toBe(before + 1);
  });

  test("an event naming a subagent child of a worker session needs the worker's token, and never rebinds the launch", async () => {
    const w = makeWorld();
    await started(w);
    expect((await hook(w, eventBody("SubagentStart", "sa", WT_A), w.tokenA)).status).toBe(200);
    expect(getSession(w.store.db, "sa:ag1")?.parentSessionId).toBe("sa");
    expect((await hook(w, eventBody("Stop", "sa:ag1", WT_A))).status).toBe(202);
    expect((await hook(w, eventBody("Stop", "sa:ag1", WT_A), w.tokenB)).status).toBe(403);
    expect((await hook(w, eventBody("Stop", "sa:ag1", WT_A), w.tokenA)).status).toBe(200);
    expect(getLaunch(w.store.db, "la")?.sessionId).toBe("sa");
  });

  test("a forged session that claims a launch before its worker reports in loses it to the worker's first token event", async () => {
    const w = makeWorld();
    createTaskRun(w.store.db, { id: "run-a", projectId: "p", worktreePath: WT_A });
    expect((await hook(w, prompt("forged", WT_A))).status).toBe(200);
    expect(getLaunch(w.store.db, "la")?.sessionId).toBe("forged");
    expect(getActiveTaskRunByWorktree(w.store.db, WT_A)?.sessionId).toBe("forged");
    expect((await hook(w, prompt("sa", WT_A), w.tokenA)).status).toBe(200);
    expect(getLaunch(w.store.db, "la")?.sessionId).toBe("sa");
    expect(getActiveTaskRunByWorktree(w.store.db, WT_A)?.sessionId).toBe("sa");
    expect(getLaunchHookAuth(w.store.db, "la")).toBe(true);
    expect(getLaunchBySession(w.store.db, "forged")).toBeNull();
    // From then on the worker's tokenless copies are ignored.
    expect((await hook(w, eventBody("Stop", "sa", WT_A))).status).toBe(202);
  });

  test("a tokenless session in a proven launch's worktree is its own session, never attached", async () => {
    const w = makeWorld();
    await started(w);
    expect((await hook(w, prompt("nested", WT_A))).status).toBe(200);
    expect(getSession(w.store.db, "nested")?.projectId).toBe("p");
    expect(getLaunchBySession(w.store.db, "nested")).toBeNull();
    expect(getLaunch(w.store.db, "la")?.sessionId).toBe("sa");
    const before = events(w, "sa");
    expect((await hook(w, eventBody("Stop", "nested", WT_A))).status).toBe(200);
    expect(events(w, "sa")).toBe(before);
  });

  test("after /clear ends the worker's session, its new session id is claimed by its token, whichever copy lands first", async () => {
    const w = makeWorld();
    createTaskRun(w.store.db, { id: "run-a", projectId: "p", worktreePath: WT_A });
    await started(w);
    expect(getActiveTaskRunByWorktree(w.store.db, WT_A)?.sessionId).toBe("sa");
    expect((await hook(w, eventBody("SessionEnd", "sa", WT_A), w.tokenA)).status).toBe(200);
    expect(getSession(w.store.db, "sa")?.endedAt).toBeDefined();
    // The global copy of the new session's first event lands first.
    expect((await hook(w, prompt("sa2", WT_A))).status).toBe(200);
    expect(getSession(w.store.db, "sa2")).not.toBeNull();
    expect(getLaunchBySession(w.store.db, "sa2")).toBeNull();
    expect((await hook(w, prompt("sa2", WT_A), w.tokenA)).status).toBe(200);
    expect(getLaunchBySession(w.store.db, "sa2")?.id).toBe("la");
    expect(getActiveTaskRunByWorktree(w.store.db, WT_A)?.sessionId).toBe("sa2");
    expect((await hook(w, eventBody("Stop", "sa2", WT_A))).status).toBe(202);
  });

  test("a forged event reviving the worker's ended session after /clear can't lock the worker out", async () => {
    const w = makeWorld();
    await started(w);
    expect((await hook(w, eventBody("SessionEnd", "sa", WT_A), w.tokenA)).status).toBe(200);
    // A forged tokenless event revives the ended session before the new one is claimed.
    expect((await hook(w, prompt("sa", WT_A))).status).toBe(200);
    expect(getSession(w.store.db, "sa")?.endedAt).toBeUndefined();
    // The worker's new session still joins its launch, and is enforced again.
    expect((await hook(w, prompt("sa2", WT_A), w.tokenA)).status).toBe(200);
    expect(getLaunch(w.store.db, "la")?.sessionId).toBe("sa2");
    expect(getLaunchHookAuth(w.store.db, "la")).toBe(true);
    expect((await hook(w, eventBody("Stop", "sa2", WT_A))).status).toBe(202);
  });

  test("a claim never takes over a task run another launch's session holds", async () => {
    const w = makeWorld();
    await started(w);
    // Another launch shares the worktree path (in-place launches do) and holds the active run.
    createLaunch(w.store.db, { id: "l3", projectId: "p", task: "t3", worktreePath: WT_A, branch: "b3", sessionId: "s3", status: "running" });
    w.store.db.run("INSERT INTO sessions (id, project_id, cwd, status) VALUES ('s3', 'p', ?, 'running')", [WT_A]);
    createTaskRun(w.store.db, { id: "run-3", projectId: "p", worktreePath: WT_A, sessionId: "s3" });
    expect((await hook(w, eventBody("SessionEnd", "sa", WT_A), w.tokenA)).status).toBe(200);
    expect((await hook(w, prompt("sa2", WT_A), w.tokenA)).status).toBe(200);
    expect(getLaunch(w.store.db, "la")?.sessionId).toBe("sa2");
    expect(getActiveTaskRunByWorktree(w.store.db, WT_A)?.sessionId).toBe("s3");
  });

  test("the worker's first event: the global copy landing first is taken once more, then the token copy claims and proves", async () => {
    const w = makeWorld();
    createTaskRun(w.store.db, { id: "run-a", projectId: "p", worktreePath: WT_A });
    const first = { session_id: "sa", cwd: WT_A, hook_event_name: "SessionStart", source: "startup" };
    expect((await hook(w, first)).status).toBe(200);
    expect((await hook(w, first, w.tokenA)).status).toBe(200);
    expect(events(w, "sa")).toBe(2);
    expect(getLaunch(w.store.db, "la")?.sessionId).toBe("sa");
    expect(getLaunchHookAuth(w.store.db, "la")).toBe(true);
    expect(getActiveTaskRunByWorktree(w.store.db, WT_A)?.sessionId).toBe("sa");
    // From the next event on, only the token copy counts.
    expect((await hook(w, prompt("sa", WT_A))).status).toBe(202);
    expect((await hook(w, prompt("sa", WT_A), w.tokenA)).status).toBe(200);
    expect(events(w, "sa")).toBe(3);
  });

  test("the global copy of a SessionEnd the worker's hook delivered is ignored, and the proof stands", async () => {
    const w = makeWorld();
    await started(w);
    expect((await hook(w, eventBody("SessionEnd", "sa", WT_A), w.tokenA)).status).toBe(200);
    const before = events(w, "sa");
    expect((await hook(w, eventBody("SessionEnd", "sa", WT_A))).status).toBe(202);
    expect(events(w, "sa")).toBe(before);
    expect(getLaunchHookAuth(w.store.db, "la")).toBe(true);
  });

  test("a worker that /resumes back to its earlier session takes it back, without hook errors", async () => {
    const w = makeWorld();
    await started(w);
    w.store.db.run("UPDATE sessions SET started_at = datetime('now', '-600 seconds') WHERE id = 'sa'");
    expect((await hook(w, eventBody("SessionEnd", "sa", WT_A), w.tokenA)).status).toBe(200);
    expect((await hook(w, prompt("sa2", WT_A), w.tokenA)).status).toBe(200);
    expect(getLaunch(w.store.db, "la")?.sessionId).toBe("sa2");
    // `/resume sa` from inside the pane, with sa2 still live.
    expect((await hook(w, prompt("sa", WT_A), w.tokenA)).status).toBe(200);
    expect(getLaunch(w.store.db, "la")?.sessionId).toBe("sa");
    expect((await hook(w, eventBody("Stop", "sa", WT_A), w.tokenA)).status).toBe(200);
  });

  test("hide: a token can't take back the worker's old session once the owner has resumed it by hand", async () => {
    const w = makeWorld();
    await started(w);
    expect((await hook(w, eventBody("SessionEnd", "sa", WT_A), w.tokenA)).status).toBe(200);
    expect((await hook(w, prompt("sa2", WT_A), w.tokenA)).status).toBe(200);
    // The owner resumes sa by hand and works in it.
    expect((await hook(w, prompt("sa", WT_A))).status).toBe(200);
    expect((await hook(w, eventBody("PreToolUse", "sa", WT_A))).status).toBe(200);
    expect((await hook(w, eventBody("Stop", "sa", WT_A), w.tokenA)).status).toBe(403);
    expect(getLaunch(w.store.db, "la")?.sessionId).toBe("sa2");
    const before = events(w, "sa");
    expect((await hook(w, eventBody("Stop", "sa", WT_A))).status).toBe(200);
    expect(events(w, "sa")).toBe(before + 1);
  });

  test("a worker /resuming back takes its old session even when the global copy lands first", async () => {
    const w = makeWorld();
    await started(w);
    expect((await hook(w, eventBody("SessionEnd", "sa", WT_A), w.tokenA)).status).toBe(200);
    expect((await hook(w, prompt("sa2", WT_A), w.tokenA)).status).toBe(200);
    expect((await hook(w, prompt("sa", WT_A))).status).toBe(200);
    expect((await hook(w, prompt("sa", WT_A), w.tokenA)).status).toBe(200);
    expect(getLaunch(w.store.db, "la")?.sessionId).toBe("sa");
  });

  test("a worker's token can't claim a second session while its own session runs", async () => {
    const w = makeWorld();
    await started(w);
    expect((await hook(w, prompt("extra", WT_A), w.tokenA)).status).toBe(403);
    expect(getLaunch(w.store.db, "la")?.sessionId).toBe("sa");
  });

  test("a worker's token never claims a session that predates its launch", async () => {
    const w = makeWorld();
    await started(w);
    expect((await hook(w, eventBody("SessionEnd", "sa", WT_A), w.tokenA)).status).toBe(200);
    expect((await hook(w, eventBody("Stop", "so", OWNER_CWD), w.tokenA)).status).toBe(403);
    expect(getLaunchBySession(w.store.db, "so")).toBeNull();
  });
});

describe("a worker token can't hijack or hide the owner's sessions", () => {
  /** The worker ends its own session through its token, opening the window it would claim through. */
  async function workerEndedItself(w: World) {
    await started(w);
    expect((await hook(w, eventBody("SessionEnd", "sa", WT_A), w.tokenA)).status).toBe(200);
  }

  test("hijack: the token can't claim an owner session begun after the launch, wherever it runs", async () => {
    for (const cwd of [OWNER_CWD, WT_A]) {
      const w = makeWorld();
      await workerEndedItself(w);
      expect((await hook(w, prompt("owner-new", cwd))).status).toBe(200);
      if (cwd === WT_A) w.store.db.run("UPDATE sessions SET started_at = datetime('now', '-120 seconds') WHERE id = 'owner-new'");
      const steer = createSteer(w.store.db, "owner-new", "owner's steer");
      for (const event of ["SessionStart", "UserPromptSubmit", "Stop", "Notification"]) {
        const res = await hook(w, eventBody(event, "owner-new", cwd), w.tokenA);
        expect(res.status).toBe(403);
        expect(JSON.stringify(await res.json())).not.toContain("owner's steer");
      }
      expect(getLaunchBySession(w.store.db, "owner-new")).toBeNull();
      expect(getLaunch(w.store.db, "la")?.sessionId).toBe("sa");
      expect(getPendingAsksBySession(w.store.db, "owner-new")).toHaveLength(0);
      // The owner's own hook still delivers the steer to the owner's session.
      const real = await hook(w, eventBody("UserPromptSubmit", "owner-new", cwd));
      expect(real.status).toBe(200);
      expect(JSON.stringify(await real.json())).toContain(steer.body);
    }
  });

  test("hide: after the attempt, every owner event is still recorded, none answered 202", async () => {
    const w = makeWorld();
    await workerEndedItself(w);
    expect((await hook(w, prompt("owner-new", OWNER_CWD))).status).toBe(200);
    expect((await hook(w, eventBody("SessionStart", "owner-new", OWNER_CWD), w.tokenA)).status).toBe(403);
    for (const event of STANDUP_HOOK_EVENTS) {
      if (event === "SessionEnd") continue;
      const before = events(w, "owner-new");
      expect((await hook(w, eventBody(event, "owner-new", OWNER_CWD))).status).toBe(200);
      expect(events(w, "owner-new")).toBe(before + 1);
    }
    expect(getSession(w.store.db, "owner-new")?.endedAt).toBeUndefined();
  });

  test("hide: a worker session resumed by hand after its worker exited is recorded, not ignored", async () => {
    const w = makeWorld();
    await workerEndedItself(w);
    for (const event of ["UserPromptSubmit", "PreToolUse", "Stop"]) {
      const before = events(w, "sa");
      expect((await hook(w, eventBody(event, "sa", WT_A))).status).toBe(200);
      expect(events(w, "sa")).toBe(before + 1);
    }
  });

  test("hijack: after ending its own session, the token can't claim a new session outside its worktree (another launch's)", async () => {
    const w = makeWorld();
    await workerEndedItself(w);
    expect((await hook(w, prompt("sy", WT_B), w.tokenA)).status).toBe(403);
    expect(getSession(w.store.db, "sy")).toBeNull();
    expect(getLaunch(w.store.db, "la")?.sessionId).toBe("sa");
  });

  test("hijack: a fresh owner session in the worktree that has reported more than once can't be claimed", async () => {
    const w = makeWorld();
    await workerEndedItself(w);
    expect((await hook(w, prompt("owner-fresh", WT_A))).status).toBe(200);
    expect((await hook(w, eventBody("PreToolUse", "owner-fresh", WT_A))).status).toBe(200);
    expect((await hook(w, eventBody("Stop", "owner-fresh", WT_A), w.tokenA)).status).toBe(403);
    expect(getLaunchBySession(w.store.db, "owner-fresh")).toBeNull();
    expect((await hook(w, eventBody("Stop", "owner-fresh", WT_A))).status).toBe(200);
  });

  test("while the worker runs, its token still can't take over the owner's session", async () => {
    const w = makeWorld();
    await started(w);
    expect((await hook(w, prompt("owner-new", OWNER_CWD))).status).toBe(200);
    expect((await hook(w, eventBody("Stop", "owner-new", OWNER_CWD), w.tokenA)).status).toBe(403);
    expect((await hook(w, eventBody("Stop", "owner-new", OWNER_CWD))).status).toBe(200);
  });
});

describe("sessions with no proven token", () => {
  test("the owner's own session reports through the global hook as before", async () => {
    const w = makeWorld();
    await started(w);
    const before = events(w, "so");
    expect((await hook(w, eventBody("Stop", "so", OWNER_CWD))).status).toBe(200);
    expect(events(w, "so")).toBe(before + 1);
  });

  test("a worker token presented for the owner's session is refused 403", async () => {
    const w = makeWorld();
    await started(w);
    const before = events(w, "so");
    expect((await hook(w, eventBody("Stop", "so", OWNER_CWD), w.tokenA)).status).toBe(403);
    expect(events(w, "so")).toBe(before);
  });

  test("a session launched before hook tokens keeps reporting through the global hook", async () => {
    const w = makeWorld();
    await started(w);
    const before = events(w, "sl");
    expect((await hook(w, eventBody("Stop", "sl", WT_LEGACY))).status).toBe(200);
    expect(events(w, "sl")).toBe(before + 1);
    expect((await hook(w, eventBody("Stop", "sl", WT_LEGACY), w.tokenA)).status).toBe(403);
  });

  test("a launch whose token never arrives keeps its session reporting through the global hook", async () => {
    const w = makeWorld();
    expect((await hook(w, prompt("sb", WT_B))).status).toBe(200);
    expect(getLaunchBySession(w.store.db, "sb")?.id).toBe("lb");
    expect((await hook(w, eventBody("Stop", "sb", WT_B))).status).toBe(200);
    expect(getLaunchHookAuth(w.store.db, "lb")).toBe(false);
  });

  test("a failed in-place launch never hides the owner's new sessions in its repo", async () => {
    const w = makeWorld();
    createLaunch(w.store.db, { id: "lf", projectId: "p", task: "t", worktreePath: OWNER_CWD, branch: "main", status: "failed", inPlace: true });
    setLaunchHookTokenHash(w.store.db, "lf", workerTokenHash(token()));
    w.store.db.run("UPDATE launches SET hook_auth = 1 WHERE id = 'lf'");
    expect((await hook(w, prompt("owner-new", OWNER_CWD))).status).toBe(200);
    expect(getSession(w.store.db, "owner-new")).not.toBeNull();
  });

  test("once its worker has exited, a worker session resumed by hand reports through the global hook", async () => {
    const w = makeWorld();
    await started(w);
    expect((await hook(w, eventBody("SessionEnd", "sa", WT_A), w.tokenA)).status).toBe(200);
    // The launch is still `running` until it is cleaned.
    expect(getLaunch(w.store.db, "la")?.status).toBe("running");
    const before = events(w, "sa");
    expect((await hook(w, prompt("sa", WT_A))).status).toBe(200);
    expect(events(w, "sa")).toBe(before + 1);
  });

  test("a launch's own hook arriving without its token is ignored, since the global copy carries the event", async () => {
    const w = makeWorld();
    await started(w);
    for (const [sid, cwd] of [["so", OWNER_CWD], ["sl", WT_LEGACY]] as const) {
      const before = events(w, sid);
      const res = await w.app.request(WORKER_HOOK_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json", [HOOK_TOKEN_HEADER]: "" },
        body: JSON.stringify(eventBody("Stop", sid, cwd)),
      });
      expect(res.status).toBe(202);
      expect(events(w, sid)).toBe(before);
    }
  });

  test("once its launch is no longer live, a worker session resumed by hand reports again", async () => {
    const w = makeWorld();
    await started(w);
    expect((await hook(w, eventBody("Stop", "sa", WT_A))).status).toBe(202);
    updateLaunchStatus(w.store.db, "la", "cleaned");
    expect((await hook(w, eventBody("Stop", "sa", WT_A))).status).toBe(200);
  });

  test("an owner session's SessionStart in a proven worker's worktree never relinks that launch", async () => {
    const w = makeWorld();
    await started(w);
    const decision = authorizeHookEvent(w.store.db, { sessionId: "so", cwd: WT_A, eventName: "SessionStart" }, undefined);
    expect(decision).toEqual({ ok: true, attachToLaunch: false });
  });
});

describe("every hook event type", () => {
  for (const event of STANDUP_HOOK_EVENTS) {
    test(`${event}: no token is ignored, another session's token is refused, its own token is processed`, async () => {
      const w = makeWorld();
      await started(w);
      const body = eventBody(event, "sa", WT_A);
      const before = events(w, "sa");

      expect((await hook(w, body)).status).toBe(202);
      expect(events(w, "sa")).toBe(before);
      expect((await hook(w, body, w.tokenB)).status).toBe(403);
      expect(events(w, "sa")).toBe(before);

      expect((await hook(w, body, w.tokenA)).status).toBe(200);
      expect(events(w, "sa")).toBe(before + 1);
      if (event === "SessionEnd") expect(getSession(w.store.db, "sa")?.endedAt).toBeDefined();
    });

    test(`${event}: the owner's session and a pre-change launch's session report without a token`, async () => {
      const w = makeWorld();
      await started(w);
      for (const [sid, cwd] of [["so", OWNER_CWD], ["sl", WT_LEGACY]] as const) {
        const before = events(w, sid);
        expect((await hook(w, eventBody(event, sid, cwd))).status).toBe(200);
        expect(events(w, sid)).toBe(before + 1);
      }
    });
  }
});

describe("the launch's settings", () => {
  const config = { collectorUrl: "http://127.0.0.1:7777/", workerToken: "t".repeat(64), waitSeconds: 60 } as FloorConfig;

  test("carry an HTTP hook for every event Standup reports, presenting the hook token from the env, under a URL of its own", () => {
    const json = buildFloorHookSettings(config, "/bin/bun", "/floor/hook.ts");
    const settings = JSON.parse(json) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>>;
    };
    for (const event of STANDUP_HOOK_EVENTS) {
      const http = settings.hooks[event]!.flatMap((e) => e.hooks).filter((h) => h.type === "http");
      expect(http).toEqual([
        {
          type: "http",
          url: `http://127.0.0.1:7777${WORKER_HOOK_PATH}`,
          headers: { [HOOK_TOKEN_HEADER]: `$${HOOK_TOKEN_ENV}` },
          allowedEnvVars: [HOOK_TOKEN_ENV],
          ...(HOOK_CLIENT_TIMEOUT_SECONDS[event] !== undefined ? { timeout: HOOK_CLIENT_TIMEOUT_SECONDS[event] } : {}),
        },
      ]);
    }
    // The floor's own command hook stays first on PreToolUse.
    expect(settings.hooks.PreToolUse![0]!.matcher).toBe("*");
    expect(settings.hooks.PreToolUse![0]!.hooks[0]!.type).toBe("command");
    // Distinct from the global hook's URL, which Claude Code would otherwise deduplicate it against.
    expect(WORKER_HOOK_PATH).not.toBe("/hook");
  });

  test("bound the knowledge-push events' token hook with a client timeout, so a busy collector cannot stall the worker", () => {
    const settings = JSON.parse(buildFloorHookSettings(config, "/bin/bun", "/floor/hook.ts")) as {
      hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>;
    };
    for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse"]) {
      const http = settings.hooks[event]!.flatMap((e) => e.hooks).filter((h) => h.type === "http");
      expect(http).toHaveLength(1);
      expect(http[0]!.timeout).toBe(5);
    }
    const stop = settings.hooks.Stop!.flatMap((e) => e.hooks).filter((h) => h.type === "http");
    expect(stop[0]!.timeout).toBeUndefined();
  });
});
