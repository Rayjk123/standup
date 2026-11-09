import { describe, expect, test } from "bun:test";
import {
  cancelAsk,
  createAsk,
  createLaunch,
  createPersonaApproval,
  createPersonaJob,
  createPlanApproval,
  createSession,
  createSessionMessage,
  createSteer,
  createStore,
  getCheckpointsBySession,
  getLaunch,
  getSession,
  insertEvent,
  linkPersonaJobLaunch,
  setLaunchKeepAlive,
  updatePersonaJob,
  upsertProject,
} from "@standup/store";
import type { Store } from "@standup/store";
import type { Launch, LaunchKind, PersonaJob, PersonaInboxKind, Session, WsMessage } from "@standup/shared";
import {
  createIdleReaper,
  findReapable,
  formatIdle,
  idleReapThresholds,
  pauseSettled,
  reapIdleWorkers,
  type IdleReaperDeps,
} from "./idle-reaper.js";
import { createPersonaEventRouter, IDLE_NOTICE_GATE, IDLE_PROMPT_NOTICE } from "./persona/events.js";
import { stopSession } from "./session-stop.js";

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const RULE = "─".repeat(80);
const FOOTER = "  ⏵⏵ bypass permissions on (shift+tab to cycle)";
const IDLE = ["● Done.", RULE, "❯ ", RULE, FOOTER].join("\n");
const BUSY = ["✽ Doodling… (12m 25s · ↓ 15.4k tokens)", RULE, "❯ ", RULE, FOOTER].join("\n");
const BACKGROUND = ["● Started the dev server.", RULE, "❯ ", RULE, `${FOOTER} · 2 background tasks`].join("\n");
const DRAFTING = ["● Done.", RULE, "❯ also rebase onto main and", RULE, FOOTER].join("\n");
const PLACEHOLDER_PROMPT = ["● Done.", RULE, '❯ Try "refactor the parser"', RULE, FOOTER].join("\n");

interface Worker {
  status?: Session["status"];
  kind?: LaunchKind;
  harness?: "claude" | "codex";
  launch?: boolean;
}

/** A launched worker settled at its prompt, its last activity now (a Stop hook). */
function setUp(worker: Worker = {}): { store: Store; sessionId: string; launchId: string } {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
  createSession(store.db, { id: "s1", projectId: "p", title: "fix the bug", cwd: "/w", status: worker.status ?? "idle" });
  if (worker.launch !== false) {
    createLaunch(store.db, {
      id: "l1",
      projectId: "p",
      task: "t",
      worktreePath: "/w",
      branch: "b",
      tmuxSession: "standup-l1",
      sessionId: "s1",
      status: "running",
      kind: worker.kind,
      harness: worker.harness,
    });
  }
  insertEvent(store.db, "s1", "Stop", { hook_event_name: "Stop", session_id: "s1" });
  return { store, sessionId: "s1", launchId: "l1" };
}

function deps(over: Partial<IdleReaperDeps> & { screen?: string; at?: number } = {}): IdleReaperDeps & { stopped: string[] } {
  const stopped: string[] = [];
  const screen = over.screen ?? IDLE;
  const at = over.at ?? Date.now() + 3 * HOUR;
  return {
    now: () => at,
    pane: { exists: () => true, capture: () => screen },
    onWorkerServer: () => true,
    attached: () => false,
    stop: async (session) => {
      stopped.push(session.id);
    },
    env: {},
    ...over,
    stopped,
  };
}

function job(store: Store, status?: PersonaJob["status"]): PersonaJob {
  const created = createPersonaJob(store.db, { owner: "alice", threadId: "t", title: "job", goal: "g" });
  linkPersonaJobLaunch(store.db, created.id, "l1");
  return status ? updatePersonaJob(store.db, created.id, { status })! : created;
}

const reapableIds = (store: Store, d: IdleReaperDeps) => findReapable(store.db, d).map((c) => c.session.id);

describe("idle reaper thresholds", () => {
  test("defaults to 2h, and 15m once the job is closed; STANDUP_IDLE_REAP=0 disables", () => {
    expect(idleReapThresholds({})).toEqual({ enabled: true, idleMs: 2 * HOUR, closedJobMs: 15 * MINUTE });
    expect(idleReapThresholds({ STANDUP_IDLE_REAP_MS: "60000", STANDUP_IDLE_REAP_CLOSED_MS: "1000" })).toEqual({
      enabled: true,
      idleMs: 60_000,
      closedJobMs: 1000,
    });
    expect(idleReapThresholds({ STANDUP_IDLE_REAP: "0" }).enabled).toBe(false);
    expect(idleReapThresholds({ STANDUP_IDLE_REAP_MS: "junk" }).idleMs).toBe(2 * HOUR);
  });

  test("a worker just under the threshold stays; just over it is reapable", () => {
    const { store } = setUp();
    expect(reapableIds(store, deps({ at: Date.now() + 2 * HOUR - MINUTE }))).toEqual([]);
    expect(reapableIds(store, deps({ at: Date.now() + 2 * HOUR + MINUTE }))).toEqual(["s1"]);
  });

  test("a closed job's worker is reapable after 15 minutes; an open job's is not", () => {
    const open = setUp();
    job(open.store);
    expect(reapableIds(open.store, deps({ at: Date.now() + 20 * MINUTE }))).toEqual([]);
    const closed = setUp();
    job(closed.store, "done");
    const found = findReapable(closed.store.db, deps({ at: Date.now() + 20 * MINUTE }));
    expect(found.map((c) => c.session.id)).toEqual(["s1"]);
    expect(found[0]!.jobClosed).toBe(true);
  });

  test("disabled reaps nothing", () => {
    const { store } = setUp();
    expect(reapableIds(store, deps({ env: { STANDUP_IDLE_REAP: "0" } }))).toEqual([]);
  });

  test("formatIdle", () => {
    expect(formatIdle(2 * HOUR)).toBe("2h");
    expect(formatIdle(90 * MINUTE)).toBe("1h 30m");
    expect(formatIdle(15 * MINUTE)).toBe("15m");
  });
});

describe("idle reaper exemptions", () => {
  test("a keep-alive launch is never reaped", () => {
    const { store } = setUp();
    setLaunchKeepAlive(store.db, "l1", true);
    expect(reapableIds(store, deps())).toEqual([]);
  });

  test("an adopted launch (the owner's own conversation) is never reaped", () => {
    const { store } = setUp({ kind: "adopted" });
    expect(reapableIds(store, deps())).toEqual([]);
  });

  test("a bootstrap launch is reaped like a worktree one", () => {
    const { store } = setUp({ kind: "bootstrap" });
    expect(reapableIds(store, deps())).toEqual(["s1"]);
  });

  test("a session with no launch is never considered", () => {
    const { store } = setUp({ launch: false });
    expect(reapableIds(store, deps())).toEqual([]);
  });

  test("a codex launch is never reaped", () => {
    const { store } = setUp({ harness: "codex" });
    expect(reapableIds(store, deps())).toEqual([]);
  });

  test("an already reaped launch is not reaped again", async () => {
    const { store } = setUp();
    const d = deps();
    await reapIdleWorkers(store.db, d);
    expect(reapableIds(store, d)).toEqual([]);
  });
});

describe("idle reaper blockers", () => {
  const blocked = (arrange: (store: Store) => void, over: Parameters<typeof deps>[0] = {}) => {
    const { store } = setUp();
    arrange(store);
    return reapableIds(store, deps(over));
  };

  test("a pending ask blocks; the idle notice alone does not", () => {
    expect(blocked((s) => createAsk(s.db, "s1", "ask_human", "which branch?"))).toEqual([]);
    expect(
      blocked((s) => createAsk(s.db, "s1", "permission_prompt", IDLE_PROMPT_NOTICE, undefined, { gate: IDLE_NOTICE_GATE }))
    ).toEqual(["s1"]);
  });

  test("a plan awaiting submission or approval blocks", () => {
    expect(blocked((s) => createPlanApproval(s.db, { launchId: "l1", projectId: "p", worktreePath: "/w" }))).toEqual([]);
  });

  test("a pending approval card on the session blocks", () => {
    expect(
      blocked((s) => createPersonaApproval(s.db, { owner: "alice", action: "send_to_session", summary: "s", args: { sessionId: "s1" } }))
    ).toEqual([]);
  });

  test("a pending floor-hold allow card for one of its asks blocks", () => {
    expect(
      blocked((s) => {
        const ask = createAsk(s.db, "s1", "ask_human", "Allow git push?", undefined, { gate: "safety_floor" });
        createPersonaApproval(s.db, { owner: "alice", action: "answer_ask", summary: "s", args: { askId: ask.id, answer: "Allow" } });
        cancelAsk(s.db, ask.id);
      })
    ).toEqual([]);
  });

  test("a decided card does not block", () => {
    expect(
      blocked((s) => {
        const card = createPersonaApproval(s.db, { owner: "alice", action: "send_to_session", summary: "s", args: { sessionId: "s1" } });
        s.db.run("UPDATE persona_approvals SET status = 'approved' WHERE id = ?", [card.id]);
      })
    ).toEqual(["s1"]);
  });

  test("a queued steer blocks", () => {
    expect(blocked((s) => createSteer(s.db, "s1", "rebase first"))).toEqual([]);
  });

  test("a queued mailbox message blocks", () => {
    expect(blocked((s) => createSessionMessage(s.db, { toSessionId: "s1", body: "ping" }))).toEqual([]);
  });

  test("a tool call in flight blocks; one that finished does not", () => {
    expect(blocked((s) => insertEvent(s.db, "s1", "PreToolUse", { tool_name: "Bash", tool_use_id: "t1" }))).toEqual([]);
    expect(
      blocked((s) => {
        insertEvent(s.db, "s1", "PreToolUse", { tool_name: "Bash", tool_use_id: "t1" });
        insertEvent(s.db, "s1", "PostToolUse" as never, { tool_name: "Bash", tool_use_id: "t1" });
      })
    ).toEqual(["s1"]);
  });

  const subagent = (s: Store) =>
    createSession(s.db, {
      id: "child",
      projectId: "p",
      title: "explore",
      cwd: "/w",
      status: "running",
      parentSessionId: "s1",
      kind: "subagent",
      agentType: "Explore",
      agentId: "a1",
    });

  test("an open subagent blocks while the parent's own events are hours old", () => {
    const quietParent = (s: Store) => s.db.run("UPDATE events SET created_at = datetime('now', '-3 hours') WHERE session_id = 's1'");
    expect(blocked(quietParent, { at: Date.now() })).toEqual(["s1"]);
    expect(
      blocked(
        (s) => {
          quietParent(s);
          subagent(s);
        },
        { at: Date.now() }
      )
    ).toEqual([]);
  });

  test("a subagent silent past the stale window does not block", () => {
    expect(blocked(subagent)).toEqual(["s1"]);
  });

  test("a busy pane blocks", () => {
    expect(blocked(() => {}, { screen: BUSY })).toEqual([]);
  });

  test("background tasks in the footer block", () => {
    expect(blocked(() => {}, { screen: BACKGROUND })).toEqual([]);
  });

  test("a gone pane is left to the dead-session reaper", () => {
    expect(blocked(() => {}, { pane: { exists: () => false, capture: () => IDLE } })).toEqual([]);
  });

  test("text in the composer blocks; the placeholder hint does not", () => {
    expect(blocked(() => {}, { screen: DRAFTING })).toEqual([]);
    expect(blocked(() => {}, { screen: PLACEHOLDER_PROMPT })).toEqual(["s1"]);
  });

  test("an attached tmux client blocks", () => {
    const seen: string[] = [];
    expect(
      blocked(() => {}, {
        attached: (launch) => {
          seen.push(launch.id);
          return true;
        },
      })
    ).toEqual([]);
    expect(seen).toEqual(["l1"]);
  });

  test("a session not on the workers' tmux server is not a candidate", () => {
    const asked: string[] = [];
    expect(
      blocked(() => {}, {
        onWorkerServer: (session) => {
          asked.push(session);
          return false;
        },
      })
    ).toEqual([]);
    expect(asked).toEqual(["standup-l1"]);
  });

  test("a session that is not idle or done blocks", () => {
    for (const status of ["running", "waiting", "stalled"] as const) {
      const { store } = setUp({ status });
      expect(reapableIds(store, deps())).toEqual([]);
    }
    const done = setUp({ status: "done" });
    expect(reapableIds(done.store, deps())).toEqual(["s1"]);
  });
});

describe("reapIdleWorkers", () => {
  test("marks the launch reaped, stops it, and records a checkpoint and one system line", async () => {
    const { store } = setUp();
    const owned = job(store);
    const posted: Array<{ jobId: string; text: string }> = [];
    const frames: WsMessage[] = [];
    const d = deps({ post: (j, text) => posted.push({ jobId: j.id, text }), broadcast: (m) => frames.push(m) });

    const reaped = await reapIdleWorkers(store.db, d);

    expect(reaped.map((r) => r.session.id)).toEqual(["s1"]);
    expect(d.stopped).toEqual(["s1"]);
    const launch = getLaunch(store.db, "l1")!;
    expect(launch.reapedAt).toBeInstanceOf(Date);
    expect(launch.reapReason).toBe("idle 3h");
    expect(launch.status).toBe("running");
    const checkpoint = getCheckpointsBySession(store.db, "s1").at(-1)!;
    expect(checkpoint.source).toBe("structural");
    expect(checkpoint.summary).toBe("Paused after 3h idle to free memory; resumes on the next message.");
    expect(posted).toEqual([{ jobId: owned.id, text: 'Paused worker "fix the bug" after 3h idle; it resumes on the next message.' }]);
    expect(frames.map((f) => f.type)).toEqual(["checkpoint:new"]);
  });

  test("a stop that fails clears the reaped mark", async () => {
    const { store } = setUp();
    const reaped = await reapIdleWorkers(
      store.db,
      deps({
        stop: async () => {
          throw new Error("boom");
        },
      })
    );
    expect(reaped).toEqual([]);
    expect(getLaunch(store.db, "l1")?.reapedAt).toBeUndefined();
  });

  test("a worker that turned busy after the candidate list was read is not paused", async () => {
    const { store } = setUp();
    const screens = [IDLE, BUSY];
    const d = deps({ pane: { exists: () => true, capture: () => screens.shift() ?? BUSY } });
    expect(await reapIdleWorkers(store.db, d)).toEqual([]);
    expect(d.stopped).toEqual([]);
    expect(getLaunch(store.db, "l1")?.reapedAt).toBeUndefined();
  });

  test("a steer queued after the candidate list was read keeps the worker up", async () => {
    const { store } = setUp();
    let captures = 0;
    const d = deps({
      pane: {
        exists: () => true,
        capture: () => {
          if (++captures === 1) createSteer(store.db, "s1", "one more thing");
          return IDLE;
        },
      },
    });
    expect(await reapIdleWorkers(store.db, d)).toEqual([]);
    expect(d.stopped).toEqual([]);
  });

  test("work queued while the pane was closing wakes the worker once the pause settles", async () => {
    const { store } = setUp();
    const woken: Array<{ sessionId: string; reapedAt: Date | undefined }> = [];
    const d = deps({
      stop: async () => {
        createSessionMessage(store.db, { toSessionId: "s1", body: "ping" });
      },
      wake: async (sessionId) => {
        woken.push({ sessionId, reapedAt: getLaunch(store.db, "l1")?.reapedAt });
      },
    });
    expect((await reapIdleWorkers(store.db, d)).map((c) => c.session.id)).toEqual(["s1"]);
    expect(woken).toHaveLength(1);
    expect(woken[0]!.sessionId).toBe("s1");
    expect(woken[0]!.reapedAt).toBeInstanceOf(Date);
  });

  test("a pause with nothing queued wakes nothing", async () => {
    const { store } = setUp();
    const woken: string[] = [];
    await reapIdleWorkers(store.db, deps({ wake: async (id) => void woken.push(id) }));
    expect(woken).toEqual([]);
  });

  test("pauseSettled waits for a pause in progress, and resolves at once otherwise", async () => {
    const { store } = setUp();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let stopEntered!: () => void;
    const entered = new Promise<void>((resolve) => (stopEntered = resolve));
    const reaping = reapIdleWorkers(
      store.db,
      deps({
        stop: async () => {
          stopEntered();
          await gate;
        },
      })
    );
    await entered;
    let settled = false;
    const waiter = pauseSettled("l1").then(() => {
      settled = true;
    });
    await Bun.sleep(5);
    expect(settled).toBe(false);
    release();
    await waiter;
    expect(settled).toBe(true);
    await reaping;
    await pauseSettled("l1");
    await pauseSettled("no-such-launch");
  });

  test("the pause ends the session and emits no lost-worker event to Persona", async () => {
    const { store } = setUp();
    job(store);
    createAsk(store.db, "s1", "permission_prompt", IDLE_PROMPT_NOTICE, undefined, { gate: IDLE_NOTICE_GATE });
    const enqueued: Array<{ kind: PersonaInboxKind; payload: Record<string, unknown> }> = [];
    const route = createPersonaEventRouter({
      db: store.db,
      owner: "alice",
      coalesceMs: 0,
      enqueue: (kind, payload) => enqueued.push({ kind, payload }),
      isSelfActing: () => false,
    });
    const frames: WsMessage[] = [];
    const broadcast = (m: WsMessage) => {
      frames.push(m);
      route(m);
    };
    const paused: Array<{ launchId: string; pause: boolean }> = [];
    const d = deps({
      broadcast,
      stop: async (session: Session, launch: Launch, reason: string) => {
        await stopSession(
          store.db,
          { broadcast, stopLaunch: async (_db, l, opts) => (paused.push({ launchId: l.id, pause: opts.pause }), { ok: true, log: [] }) },
          session,
          launch,
          { reapReason: reason }
        );
      },
    });

    await reapIdleWorkers(store.db, d);
    // The dying worker's own SessionEnd hook reaches the router too.
    broadcast({ type: "session:end", payload: { sessionId: "s1" }, timestamp: "" });

    expect(paused).toEqual([{ launchId: "l1", pause: true }]);
    expect(getSession(store.db, "s1")?.endedAt).toBeInstanceOf(Date);
    expect(frames.map((f) => f.type)).toContain("launch:reaped");
    expect(frames.map((f) => f.type)).not.toContain("launch:stopped");
    expect(enqueued.filter((e) => e.kind === "worker_event")).toEqual([]);
  });
});

describe("createIdleReaper", () => {
  test("a tick while one is running reaps nothing", async () => {
    const { store } = setUp();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const reaper = createIdleReaper(
      store.db,
      deps({
        stop: async () => {
          await gate;
        },
      })
    );
    const first = reaper.tick();
    expect(await reaper.tick()).toEqual([]);
    release();
    expect((await first).map((c) => c.session.id)).toEqual(["s1"]);
  });
});
