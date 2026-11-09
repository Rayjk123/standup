import { describe, expect, test } from "bun:test";
import type { BoardTask, Launch, PersonaCommitment, PersonaJob, Session } from "@standup/shared";
import {
  isTiedLaunch,
  isTiedWorker,
  liveWorkersPath,
  parseLiveWorkers,
  personaTies,
  writeLiveWorkers,
} from "./liveWorkers";

const job = (id: string, over: Partial<PersonaJob> = {}): PersonaJob =>
  ({ id, owner: "o", threadId: "t", title: id, goal: "", status: "active", launchIds: [], sessionIds: [], createdAt: "", updatedAt: "", ...over }) as PersonaJob;
const session = (id: string, over: Partial<Session> = {}): Session =>
  ({ id, projectId: "p", title: id, cwd: "/tmp", status: "running", startedAt: new Date(), ...over }) as Session;
const commitment = (assignee: PersonaCommitment["assignee"], over: Partial<PersonaCommitment> = {}): PersonaCommitment =>
  ({ id: `c-${assignee}`, owner: "o", assignee, action: "", doneCheck: "", status: "open", source: "persona", openedAt: "", ...over }) as PersonaCommitment;
const launch = (id: string, sessionId?: string): Launch => ({ id, sessionId }) as Launch;

describe("live workers query", () => {
  test("round-trips open and a session or launch selection, keeping the board filter", () => {
    const params = new URLSearchParams("source=ticket&q=feed");
    const opened = writeLiveWorkers(params, { open: true, selection: { kind: "s", id: "s1" } });
    expect(opened.toString()).toBe("source=ticket&q=feed&workers=1&session=s1");
    expect(parseLiveWorkers(opened)).toEqual({ open: true, showAll: false, selection: { kind: "s", id: "s1" } });
    const launchOpen = writeLiveWorkers(opened, { open: true, selection: { kind: "l", id: "l1" } });
    expect(parseLiveWorkers(launchOpen)).toEqual({ open: true, showAll: false, selection: { kind: "l", id: "l1" } });
    expect(launchOpen.has("session")).toBe(false);
    const closed = writeLiveWorkers(launchOpen, { open: false, showAll: true, selection: null });
    expect(closed.toString()).toBe("source=ticket&q=feed");
    expect(parseLiveWorkers(closed)).toEqual({ open: false, showAll: false, selection: null });
  });

  test("workers=all opens on every session and survives a round trip", () => {
    const all = writeLiveWorkers(new URLSearchParams(), { open: true, showAll: true, selection: { kind: "s", id: "s1" } });
    expect(all.toString()).toBe("workers=all&session=s1");
    expect(parseLiveWorkers(all)).toEqual({ open: true, showAll: true, selection: { kind: "s", id: "s1" } });
    expect(parseLiveWorkers(new URLSearchParams("workers=0")).open).toBe(false);
  });

  test("liveWorkersPath opens the Board's drawer, encoding the id", () => {
    expect(liveWorkersPath()).toBe("/board?workers=1");
    expect(liveWorkersPath({ kind: "s", id: "a b&c" })).toBe("/board?workers=1&session=a+b%26c");
    expect(parseLiveWorkers(new URL(`http://x${liveWorkersPath({ kind: "s", id: "a b&c" })}`).searchParams).selection).toEqual({
      kind: "s",
      id: "a b&c",
    });
  });
});

describe("personaTies", () => {
  test("ties open jobs' sessions and launches, a launch's bound session, and open commitments' workers", () => {
    const ties = personaTies(
      [
        job("open", { sessionIds: ["s-job"], launchIds: ["l-bound", "l-pending"] }),
        job("waiting", { status: "waiting_user", sessionIds: ["s-wait"] }),
        job("closed", { status: "done", sessionIds: ["s-closed"], launchIds: ["l-closed"] }),
      ],
      [commitment("worker:s-commit"), commitment("worker:s-done", { status: "done" }), commitment("persona"), commitment("owner")],
      [launch("l-bound", "s-bound"), launch("l-closed", "s-closed-launch")]
    );
    expect([...ties.sessionIds].sort()).toEqual(["s-bound", "s-commit", "s-job", "s-wait"]);
    expect([...ties.launchIds].sort()).toEqual(["l-bound", "l-pending"]);
  });

  test("an open job card's links tie its workers; a closed or non-job card's don't", () => {
    const card = (id: string, over: Partial<BoardTask>): BoardTask => ({ id, status: "coding", links: {}, ...over }) as BoardTask;
    const ties = personaTies([], null, [], [
      card("job", { links: { jobId: "j1", sessionIds: ["s-card"], launchIds: ["l-card"] } }),
      card("done", { status: "done", links: { jobId: "j2", sessionIds: ["s-done"] } }),
      card("ticket", { source: "ticket", links: { sessionIds: ["s-ticket"] } }),
    ]);
    expect([...ties.sessionIds]).toEqual(["s-card"]);
    expect([...ties.launchIds]).toEqual(["l-card"]);
  });

  test("each tie names its job and stage; a card's stage wins, and a job tie wins over a commitment's", () => {
    const card = { id: "c", title: "Card title", status: "validation", stage: "review", links: { jobId: "j1", sessionIds: ["s1"] } } as unknown as BoardTask;
    const ties = personaTies(
      [job("j1", { title: "Job title", sessionIds: ["s1"] }), job("j2", { title: "Other job", launchIds: ["l2"] })],
      [commitment("worker:s1", { action: "Report back" }), commitment("worker:s3", { action: "Post the counts", jobId: "j9" })],
      [launch("l2", "s2")],
      [card]
    );
    expect(ties.bySession.get("s1")).toEqual({ kind: "job", label: "Card title", jobId: "j1", stage: "review", status: "validation" });
    expect(ties.bySession.get("s2")).toEqual({ kind: "job", label: "Other job", jobId: "j2" });
    expect(ties.bySession.get("s3")).toEqual({ kind: "commitment", label: "Post the counts", jobId: "j9" });
  });

  test("a tied worker is a live root; a subagent child or an ended session is not listed by itself", () => {
    const ties = personaTies([job("j", { sessionIds: ["root", "ended", "child"] })], null, []);
    expect(isTiedWorker(session("root"), ties)).toBe(true);
    expect(isTiedWorker(session("ended", { endedAt: new Date() }), ties)).toBe(false);
    expect(isTiedWorker(session("child", { parentSessionId: "root" }), ties)).toBe(false);
    expect(isTiedWorker(session("other"), ties)).toBe(false);
    expect(isTiedLaunch(launch("x"), ties)).toBe(false);
  });
});
