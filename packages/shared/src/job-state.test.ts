import { describe, expect, test } from "bun:test";
import { deriveJobState, type JobStateFacts, type PersonaJobAction } from "./job-state.js";

const T0 = "2026-10-08T10:00:00.000Z";
const T1 = "2026-10-08T10:05:00.000Z";
const T2 = "2026-10-08T10:10:00.000Z";

function facts(extra: Partial<JobStateFacts> = {}): JobStateFacts {
  return {
    status: "active",
    createdAt: T0,
    updatedAt: T0,
    pendingApprovals: 0,
    startingLaunches: 0,
    sessions: [],
    ...extra,
  };
}

/** What a `waiting_user` set by Persona itself leaves the owner to act on: its note in the thread. */
const THREAD: PersonaJobAction[] = [{ kind: "message", id: "thread-1", label: "reply to Persona in the Persona tab" }];

const running = { id: "s1", status: "running" as const, lastActivityAt: T1 };
const idle = { id: "s2", status: "idle" as const, lastActivityAt: T1 };
const ended = { id: "s3", status: "idle" as const, endedAt: T1, lastActivityAt: T1 };

describe("deriveJobState: needs you", () => {
  test("a pending approval for the owner needs them, even while a worker runs", () => {
    const { view } = deriveJobState(facts({ pendingApprovals: 1, sessions: [running] }));
    expect(view.state).toBe("needs_you");
    expect(view.needs).toEqual(["approval"]);
  });

  test("an open ask_user question needs them", () => {
    const { view } = deriveJobState(facts({ openAskAt: T1, sessions: [idle] }));
    expect(view.state).toBe("needs_you");
    expect(view.needs).toEqual(["question"]);
  });

  test("an explicit waiting_user nothing has answered needs them", () => {
    const { view, waitingSuperseded } = deriveJobState(
      facts({ status: "waiting_user", waiting: { since: T1, source: "persona" }, actions: THREAD, sessions: [running] })
    );
    expect(view.state).toBe("needs_you");
    expect(view.needs).toEqual(["waiting"]);
    expect(view.actions).toEqual(THREAD);
    expect(waitingSuperseded).toBe(false);
  });

  test("a waiting_user with no recorded start stands", () => {
    const { view, waitingSuperseded } = deriveJobState(facts({ status: "waiting_user", actions: THREAD, ownerRespondedAt: T2 }));
    expect(view.state).toBe("needs_you");
    expect(waitingSuperseded).toBe(false);
  });

  test("a waiting_user with nothing to act on does not need them", () => {
    const { view } = deriveJobState(
      facts({ status: "waiting_user", waiting: { since: T1, source: "persona" }, actions: [], sessions: [running] })
    );
    expect(view.state).toBe("running");
    expect(view.needs).toBeUndefined();
    expect(view.actions).toBeUndefined();
  });

  test("every reason is listed together, with what to act on", () => {
    const card: PersonaJobAction = { kind: "approval", id: "card-1", label: "decide the approval card" };
    const packet: PersonaJobAction = { kind: "review", id: "pkt-1", label: "decide the review packet in the Review tab" };
    const { view } = deriveJobState(
      facts({
        status: "waiting_user",
        waiting: { since: T1, source: "persona" },
        pendingApprovals: 2,
        openAskAt: T1,
        actions: [card, packet],
      })
    );
    expect(view.needs).toEqual(["approval", "question", "waiting"]);
    expect(view.actions).toEqual([card, packet]);
  });
});

describe("deriveJobState: an answered waiting_user is superseded", () => {
  test("by an owner reply after it was set", () => {
    const d = deriveJobState(
      facts({ status: "waiting_user", waiting: { since: T1, source: "persona" }, ownerRespondedAt: T2, sessions: [idle] })
    );
    expect(d.waitingSuperseded).toBe(true);
    expect(d.view.state).toBe("idle");
    expect(d.view.needs).toBeUndefined();
  });

  test("by the owner deciding one of the job's cards after it was set", () => {
    const d = deriveJobState(
      facts({ status: "waiting_user", waiting: { since: T1, source: "persona" }, lastApprovalDecidedAt: T2, sessions: [running] })
    );
    expect(d.waitingSuperseded).toBe(true);
    expect(d.view.state).toBe("running");
  });

  test("not by a reply or decision from before it was set", () => {
    const d = deriveJobState(
      facts({
        status: "waiting_user",
        waiting: { since: T2, source: "persona" },
        ownerRespondedAt: T1,
        lastApprovalDecidedAt: T1,
        actions: THREAD,
      })
    );
    expect(d.waitingSuperseded).toBe(false);
    expect(d.view.state).toBe("needs_you");
  });

  test("a hand-off waiting clears once the worker that raised it runs again; Persona's own does not", () => {
    expect(
      deriveJobState(facts({ status: "waiting_user", waiting: { since: T1, source: "handoff" }, workerResumedAt: T2 }))
        .waitingSuperseded
    ).toBe(true);
    expect(
      deriveJobState(facts({ status: "waiting_user", waiting: { since: T1, source: "persona" }, workerResumedAt: T2 }))
        .waitingSuperseded
    ).toBe(false);
  });

  test("a hand-off waiting stands while other workers on the job keep running", () => {
    const busy = { id: "s2", status: "running" as const, lastActivityAt: T2 };
    const d = deriveJobState(
      facts({ status: "waiting_user", waiting: { since: T1, source: "handoff" }, actions: THREAD, sessions: [busy] })
    );
    expect(d.waitingSuperseded).toBe(false);
    expect(d.view).toMatchObject({ state: "needs_you", needs: ["waiting"] });
  });

  test("a resume from before the hand-off answers nothing", () => {
    expect(
      deriveJobState(facts({ status: "waiting_user", waiting: { since: T2, source: "handoff" }, workerResumedAt: T1 }))
        .waitingSuperseded
    ).toBe(false);
  });

  test("a pending card still needs the owner after the waiting is answered", () => {
    const d = deriveJobState(
      facts({
        status: "waiting_user",
        waiting: { since: T1, source: "persona" },
        ownerRespondedAt: T2,
        pendingApprovals: 1,
      })
    );
    expect(d.waitingSuperseded).toBe(true);
    expect(d.view.needs).toEqual(["approval"]);
  });
});

describe("deriveJobState: running and idle", () => {
  test("running when any live session runs", () => {
    expect(deriveJobState(facts({ sessions: [idle, running] })).view.state).toBe("running");
  });

  test("running while a launch is still starting", () => {
    expect(deriveJobState(facts({ startingLaunches: 1 })).view.state).toBe("running");
  });

  test("an ended session reporting running does not count", () => {
    const zombie = { id: "s4", status: "running" as const, endedAt: T1 };
    expect(deriveJobState(facts({ sessions: [zombie] })).view.state).toBe("idle");
  });

  test("idle when every session is idle, waiting or ended", () => {
    const waiting = { id: "s5", status: "waiting" as const };
    expect(deriveJobState(facts({ sessions: [idle, ended, waiting] })).view.state).toBe("idle");
  });

  test("idle with no sessions at all", () => {
    expect(deriveJobState(facts()).view.state).toBe("idle");
  });
});

describe("deriveJobState: closed jobs", () => {
  for (const status of ["done", "failed", "cancelled"] as const) {
    test(`${status} stays ${status}, whatever is still open`, () => {
      const d = deriveJobState(
        facts({ status, pendingApprovals: 1, openAskAt: T1, sessions: [running], waiting: { since: T0, source: "persona" } })
      );
      expect(d.view.state).toBe(status);
      expect(d.view.needs).toBeUndefined();
      expect(d.waitingSuperseded).toBe(false);
    });
  }
});

describe("deriveJobState: last activity and checkpoint", () => {
  test("last activity is the latest of the job's and its workers' times", () => {
    const d = deriveJobState(
      facts({ updatedAt: T0, sessions: [{ id: "s1", status: "idle", lastActivityAt: T2 }], ownerRespondedAt: T1 })
    );
    expect(d.view.lastActivityAt).toBe(T2);
  });

  test("an unreadable time is skipped", () => {
    const d = deriveJobState(facts({ updatedAt: T1, sessions: [{ id: "s1", status: "idle", lastActivityAt: "nope" }] }));
    expect(d.view.lastActivityAt).toBe(T1);
  });

  test("the checkpoint is shown when newer than the note", () => {
    const checkpoint = { sessionId: "s1", summary: "tests green", at: T2 };
    expect(deriveJobState(facts({ note: "n", noteAt: T1, latestCheckpoint: checkpoint })).view.checkpoint).toEqual(checkpoint);
  });

  test("the checkpoint is hidden when the note is newer", () => {
    const checkpoint = { sessionId: "s1", summary: "tests green", at: T1 };
    expect(deriveJobState(facts({ note: "n", noteAt: T2, latestCheckpoint: checkpoint })).view.checkpoint).toBeUndefined();
  });

  test("the checkpoint is shown when there is no note, or the note's time is unknown", () => {
    const checkpoint = { sessionId: "s1", summary: "tests green", at: T1 };
    expect(deriveJobState(facts({ latestCheckpoint: checkpoint })).view.checkpoint).toEqual(checkpoint);
    expect(deriveJobState(facts({ note: "old", latestCheckpoint: checkpoint })).view.checkpoint).toEqual(checkpoint);
  });
});
