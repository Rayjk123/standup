import { describe, expect, test } from "bun:test";
import {
  createAsk,
  createLaunch,
  createPersonaJob,
  createSession,
  createStore,
  getAsk,
  getLaunch,
  getSession,
  linkPersonaJobLaunch,
  setSessionCreatedActor,
  updateLaunchStatus,
  upsertProject,
} from "@standup/store";
import type { Store } from "@standup/store";
import type { Launch, Session, WsMessage } from "@standup/shared";
import { OWNER_TOKEN_HEADER } from "@standup/shared/owner-token";
import { closeRefusal, closeSession, isOpenPersonaWorker, sessionOwner } from "./session-close.js";
import { createServer, resolveUserAlias } from "./server.js";
import { generateOwnerSecrets } from "./owner-secret.js";

const HOST = "alice";

function seed(store: Store, id: string, extra: Partial<Session> = {}): Session {
  upsertProject(store.db, { id: "p", name: "P", branch: "main", repos: [] });
  createSession(store.db, { id, projectId: "p", title: id, cwd: "/x", status: "idle", ...extra });
  return getSession(store.db, id)!;
}

function seedLaunch(store: Store, sessionId: string, status: Launch["status"], tmuxSession = `standup-${sessionId}`): void {
  createLaunch(store.db, { id: `${sessionId}-l`, projectId: "p", task: "t", worktreePath: "/x", branch: "b", sessionId, status: "running" });
  store.db.run("UPDATE launches SET tmux_session = ? WHERE id = ?", [tmuxSession, `${sessionId}-l`]);
  if (status !== "running") updateLaunchStatus(store.db, `${sessionId}-l`, status);
}

/** Close deps with no tmux: every stop is recorded, and `alive` names the panes that exist. */
function fakeDeps(alive: string[] = []) {
  const frames: WsMessage[] = [];
  const stops: string[] = [];
  const forgotten: string[] = [];
  return {
    frames,
    stops,
    forgotten,
    deps: {
      broadcast: (m: WsMessage) => frames.push(m),
      paneExists: (name: string) => alive.includes(name),
      forget: (id: string) => forgotten.push(id),
      stopLaunch: async (db: Store["db"], launch: Launch) => {
        stops.push(launch.id);
        updateLaunchStatus(db, launch.id, "failed", "Stopped by you");
        return { ok: true, log: [] };
      },
    },
  };
}

describe("closeSession", () => {
  test("a session the owner launched has its live pane stopped", async () => {
    const store = createStore(":memory:");
    const session = seed(store, "launched");
    seedLaunch(store, "launched", "running");
    const f = fakeDeps(["standup-launched"]);
    const result = await closeSession(store.db, f.deps, session);
    expect(result).toMatchObject({ ok: true, closed: "pane" });
    expect(f.stops).toEqual(["launched-l"]);
    expect(getSession(store.db, "launched")!.endedAt).toBeTruthy();
    expect(f.frames.map((m) => m.type)).toContain("launch:stopped");
  });

  test("a monitored session has only its record ended, its asks cancelled and its subagents ended", async () => {
    const store = createStore(":memory:");
    const session = seed(store, "monitored", { status: "running" });
    seed(store, "monitored-child", { parentSessionId: "monitored", status: "running" });
    const ask = createAsk(store.db, "monitored", "ask_human", "still there?");
    const f = fakeDeps();
    const result = await closeSession(store.db, f.deps, session);
    expect(result).toMatchObject({ ok: true, closed: "record" });
    expect(f.stops).toEqual([]);
    expect(getSession(store.db, "monitored")).toMatchObject({ status: "idle" });
    expect(getSession(store.db, "monitored")!.endedAt).toBeTruthy();
    expect(getSession(store.db, "monitored-child")!.endedAt).toBeTruthy();
    expect(getAsk(store.db, ask.id)!.status).not.toBe("pending");
    expect(f.frames.filter((m) => m.type === "session:end").map((m) => (m.payload as { sessionId: string }).sessionId)).toEqual([
      "monitored",
      "monitored-child",
    ]);
    expect(f.forgotten).toEqual(["monitored", "monitored-child"]);
  });

  test("an orphaned session whose launch is gone is ended without touching the launch", async () => {
    const store = createStore(":memory:");
    const session = seed(store, "orphan", { status: "waiting" });
    seedLaunch(store, "orphan", "failed");
    const f = fakeDeps();
    const result = await closeSession(store.db, f.deps, session);
    expect(result).toMatchObject({ ok: true, closed: "record" });
    expect(f.stops).toEqual([]);
    expect(getLaunch(store.db, "orphan-l")!.status).toBe("failed");
    expect(getSession(store.db, "orphan")!.endedAt).toBeTruthy();
  });

  test("a failed launch whose pane is still alive has the pane stopped", async () => {
    const store = createStore(":memory:");
    const session = seed(store, "lingering");
    seedLaunch(store, "lingering", "failed");
    const f = fakeDeps(["standup-lingering"]);
    expect((await closeSession(store.db, f.deps, session)).closed).toBe("pane");
    expect(f.stops).toEqual(["lingering-l"]);
  });

  test("deleteFromList removes the session and its children after ending it", async () => {
    const store = createStore(":memory:");
    const session = seed(store, "gone");
    seed(store, "gone-child", { parentSessionId: "gone" });
    createAsk(store.db, "gone", "ask_human", "q?");
    const f = fakeDeps();
    const result = await closeSession(store.db, f.deps, session, { deleteFromList: true });
    expect(result.deleted).toMatchObject({ asks: 1 });
    expect(getSession(store.db, "gone")).toBeNull();
    expect(getSession(store.db, "gone-child")).toBeNull();
    expect(f.frames.at(-1)!.type).toBe("session:deleted");
  });

  test("deleting a monitored session mid-turn is refused and changes nothing", async () => {
    const store = createStore(":memory:");
    const session = seed(store, "busy", { status: "running" });
    const f = fakeDeps();
    const result = await closeSession(store.db, f.deps, session, { deleteFromList: true });
    expect(result.refused).toContain("mid-turn");
    expect(getSession(store.db, "busy")!.endedAt).toBeUndefined();
    expect(f.frames).toEqual([]);
    // Waiting on a prompt in the terminal is mid-turn too.
    const prompting = seed(store, "prompting", { status: "waiting" });
    expect((await closeSession(store.db, f.deps, prompting, { deleteFromList: true })).refused).toContain("mid-turn");
  });

  test("an already-ended session reports so and can still be deleted", async () => {
    const store = createStore(":memory:");
    seed(store, "ended");
    store.db.run("UPDATE sessions SET ended_at = datetime('now') WHERE id = 'ended'");
    const f = fakeDeps();
    expect((await closeSession(store.db, f.deps, getSession(store.db, "ended")!)).closed).toBe("already_ended");
    expect(f.frames.filter((m) => m.type === "session:end")).toEqual([]);
  });
});

describe("closeRefusal", () => {
  test("an open Persona job's worker is refused until its job closes", () => {
    const store = createStore(":memory:");
    const session = seed(store, "worker");
    seedLaunch(store, "worker", "running");
    const job = createPersonaJob(store.db, { owner: HOST, threadId: "t", title: "Fix the parser", goal: "g" });
    linkPersonaJobLaunch(store.db, job.id, "worker-l");
    expect(isOpenPersonaWorker(store.db, session, getLaunch(store.db, "worker-l"))).toBe(true);
    expect(closeRefusal(store.db, session, HOST, HOST)).toMatchObject({ status: 409, code: "persona_worker" });
    store.db.run("UPDATE persona_jobs SET status = 'done' WHERE id = ?", [job.id]);
    expect(isOpenPersonaWorker(store.db, session, getLaunch(store.db, "worker-l"))).toBe(false);
    expect(closeRefusal(store.db, session, HOST, HOST)).toBeNull();
  });

  test("a session belongs to its owner, else its creator, else the host", () => {
    const store = createStore(":memory:");
    const legacy = seed(store, "legacy");
    expect(sessionOwner(legacy, HOST)).toBe(HOST);
    expect(closeRefusal(store.db, legacy, HOST, HOST)).toBeNull();
    setSessionCreatedActor(store.db, "legacy", "bob");
    const bobs = getSession(store.db, "legacy")!;
    expect(closeRefusal(store.db, bobs, HOST, HOST)).toMatchObject({ status: 403, code: "other_user" });
    expect(closeRefusal(store.db, bobs, "bob", HOST)).toBeNull();
  });

  test("a subagent is refused: it ends with its parent", () => {
    const store = createStore(":memory:");
    seed(store, "root");
    const child = seed(store, "child", { parentSessionId: "root" });
    expect(closeRefusal(store.db, child, HOST, HOST)).toMatchObject({ status: 409, code: "subagent" });
  });
});

describe("POST /api/sessions/:id/close", () => {
  const secrets = generateOwnerSecrets();
  const OWNER = resolveUserAlias(undefined);

  function app(store: Store) {
    const stops: string[] = [];
    const server = createServer(store, () => {}, null, undefined, undefined, "", "", {}, undefined, undefined, undefined, undefined, { ownerSecrets: secrets }, {}, {
      stopLaunch: async (db, launch) => {
        stops.push(launch.id);
        updateLaunchStatus(db, launch.id, "failed", "Stopped by you");
        return { ok: true, log: [] };
      },
      paneAlive: () => false,
    });
    const close = (id: string, body: unknown = {}, ownerToken: string | null = secrets.ownerToken) =>
      server.request(`/api/sessions/${id}/close`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(ownerToken ? { [OWNER_TOKEN_HEADER]: ownerToken } : {}) },
        body: JSON.stringify(body),
      });
    return { server, close, stops };
  }

  test("needs the owner token", async () => {
    const store = createStore(":memory:");
    seed(store, "monitored");
    const { close } = app(store);
    expect((await close("monitored", {}, null)).status).toBe(403);
    expect(getSession(store.db, "monitored")!.endedAt).toBeUndefined();
  });

  test("closes a launched, a monitored and an orphaned session", async () => {
    const store = createStore(":memory:");
    seed(store, "launched");
    seedLaunch(store, "launched", "running");
    seed(store, "monitored", { status: "running" });
    seed(store, "orphan", { status: "waiting" });
    seedLaunch(store, "orphan", "cleaned");
    const { close, stops } = app(store);

    expect(await (await close("launched")).json()).toMatchObject({ ok: true, closed: "pane" });
    expect(await (await close("monitored")).json()).toMatchObject({ ok: true, closed: "record" });
    expect(await (await close("orphan")).json()).toMatchObject({ ok: true, closed: "record" });
    expect(stops).toEqual(["launched-l"]);
    expect(getLaunch(store.db, "orphan-l")!.status).toBe("cleaned");
    for (const id of ["launched", "monitored", "orphan"]) expect(getSession(store.db, id)!.endedAt).toBeTruthy();
  });

  test("deleteFromList deletes it; a Persona worker and another user's session are refused", async () => {
    const store = createStore(":memory:");
    seed(store, "scratch");
    seed(store, "worker");
    seedLaunch(store, "worker", "running");
    linkPersonaJobLaunch(store.db, createPersonaJob(store.db, { owner: OWNER, threadId: "t", title: "Job", goal: "g" }).id, "worker-l");
    seed(store, "bobs");
    setSessionCreatedActor(store.db, "bobs", "bob");
    const { close, server } = app(store);

    const listed = (await (await server.request("/api/sessions?all=1")).json()) as Session[];
    expect(listed.find((s) => s.id === "worker")?.personaWorker).toBe(true);
    expect(listed.find((s) => s.id === "scratch")?.personaWorker).toBe(false);

    expect(await (await close("scratch", { deleteFromList: true })).json()).toMatchObject({ ok: true, deleted: { events: 0 } });
    expect(getSession(store.db, "scratch")).toBeNull();
    const worker = await close("worker");
    expect(worker.status).toBe(409);
    expect(await worker.json()).toMatchObject({ code: "persona_worker" });
    const bobs = await close("bobs");
    expect(bobs.status).toBe(403);
    expect(await bobs.json()).toMatchObject({ code: "other_user" });
    expect(getSession(store.db, "worker")!.endedAt).toBeUndefined();
    expect(getSession(store.db, "bobs")!.endedAt).toBeUndefined();
    expect((await close("nope")).status).toBe(404);
  });
});
