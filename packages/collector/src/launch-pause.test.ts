import { describe, expect, test } from "bun:test";
import { createLaunch, createSession, createStore, getLaunch, getSession, upsertProject } from "@standup/store";
import type { Store } from "@standup/store";
import type { Launch } from "@standup/shared";
import { workerTmuxSocket } from "@standup/shared/owner-token";
import { pauseKillArgv, stopLaunch, type PauseDeps } from "./launcher.js";
import { stopSession } from "./session-stop.js";

/*
 * Pausing an idle worker kills its pane on the workers' tmux server only: the
 * socket named with -S and the session by its exact name, never the shared
 * default server or a session whose name merely starts the same way.
 */

function setUp(): { store: Store; launch: Launch } {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
  createSession(store.db, { id: "s1", projectId: "p", title: "w", cwd: "/w", status: "idle" });
  const launch = createLaunch(store.db, { id: "l1", projectId: "p", task: "t", worktreePath: "/w", branch: "b", tmuxSession: "standup-l1", sessionId: "s1", status: "running" });
  return { store, launch };
}

function recorder(over: { ok?: boolean; onWorkers?: boolean } = {}): PauseDeps & { ran: string[][]; asked: string[] } {
  const ran: string[][] = [];
  const asked: string[] = [];
  return {
    ran,
    asked,
    run: async (cmd) => {
      ran.push(cmd);
      return { ok: over.ok ?? true, output: over.ok === false ? "can't find session" : "" };
    },
    onWorkerServer: (session) => {
      asked.push(session);
      return over.onWorkers ?? true;
    },
  };
}

describe("pausing a launch's pane", () => {
  test("kills exactly its session on the workers' socket", async () => {
    const { store, launch } = setUp();
    const deps = recorder();
    const res = await stopLaunch(store.db, launch, undefined, { pause: true, ...deps });
    expect(res.ok).toBe(true);
    expect(deps.asked).toEqual(["standup-l1"]);
    expect(deps.ran).toEqual([["tmux", "-S", workerTmuxSocket(), "kill-session", "-t", "=standup-l1"]]);
    expect(pauseKillArgv("standup-l1")).toEqual(["tmux", "-S", workerTmuxSocket(), "kill-session", "-t", "=standup-l1"]);
    // A pause keeps the launch live for resumption.
    expect(getLaunch(store.db, "l1")?.status).toBe("running");
  });

  test("a session not on the workers' server is left alone and the pause fails", async () => {
    const { store, launch } = setUp();
    const deps = recorder({ onWorkers: false });
    const res = await stopLaunch(store.db, launch, undefined, { pause: true, ...deps });
    expect(res.ok).toBe(false);
    expect(deps.ran).toEqual([]);
  });

  test("a kill that fails fails the pause", async () => {
    const { store, launch } = setUp();
    const res = await stopLaunch(store.db, launch, undefined, { pause: true, ...recorder({ ok: false }) });
    expect(res.ok).toBe(false);
  });

  test("a failed pause leaves the session live", async () => {
    const { store, launch } = setUp();
    const deps = recorder({ onWorkers: false });
    const res = await stopSession(
      store.db,
      { broadcast: () => {}, stopLaunch: (db, l, opts) => stopLaunch(db, l, undefined, { ...opts, ...deps }) },
      { id: "s1" },
      launch,
      { reapReason: "idle 2h" }
    );
    expect(res.ok).toBe(false);
    expect(getSession(store.db, "s1")?.endedAt).toBeUndefined();
  });
});

describe("stopSession's after-stop step", () => {
  const stopped = async () => ({ ok: true, log: [] as string[] });

  test("runs once a deliberate stop has ended the session", async () => {
    const { store, launch } = setUp();
    const seen: Array<{ id: string; ended: boolean }> = [];
    await stopSession(
      store.db,
      { broadcast: () => {}, stopLaunch: stopped, afterStop: (l) => void seen.push({ id: l.id, ended: getSession(store.db, "s1")?.endedAt !== undefined }) },
      { id: "s1" },
      launch
    );
    expect(seen).toEqual([{ id: "l1", ended: true }]);
  });

  test("doesn't run for a pause", async () => {
    const { store, launch } = setUp();
    const seen: string[] = [];
    await stopSession(store.db, { broadcast: () => {}, stopLaunch: stopped, afterStop: (l) => void seen.push(l.id) }, { id: "s1" }, launch, { reapReason: "idle 2h" });
    expect(seen).toEqual([]);
  });

  test("a failing step doesn't fail the stop", async () => {
    const { store, launch } = setUp();
    const res = await stopSession(
      store.db,
      {
        broadcast: () => {},
        stopLaunch: stopped,
        afterStop: async () => {
          throw new Error("boom");
        },
      },
      { id: "s1" },
      launch
    );
    expect(res.ok).toBe(true);
  });
});
