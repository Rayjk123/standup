import { expect, test, describe } from "bun:test";
import type { Launch, Session } from "@standup/shared";
import {
  answerableSession,
  isMine,
  isMineLaunch,
  responsibleActor,
  isMyResponsibility,
} from "./attribution";

const session = (over: Partial<Session>): Session =>
  ({
    id: "s1",
    projectId: "p1",
    title: "t",
    cwd: "/tmp",
    status: "running",
    startedAt: new Date(),
    ...over,
  }) as Session;

const launch = (over: Partial<Launch>): Launch =>
  ({
    id: "L1",
    kind: "worktree",
    projectId: "p1",
    task: "t",
    worktreePath: "/tmp/wt",
    branch: "b",
    status: "starting",
    createdAt: new Date(),
    ...over,
  }) as Launch;

describe("isMine (session)", () => {
  test("created / owned / participated is mine", () => {
    expect(isMine(session({ createdActor: "alice" }), "alice")).toBe(true);
    expect(isMine(session({ ownerActor: "alice" }), "alice")).toBe(true);
    expect(isMine(session({ participantActors: ["bob", "alice"] }), "alice")).toBe(true);
  });

  test("someone else's session is not mine, and an empty user matches nothing", () => {
    expect(isMine(session({ createdActor: "bob" }), "alice")).toBe(false);
    expect(isMine(session({ createdActor: "alice" }), "")).toBe(false);
  });
});

describe("responsibleActor (who a 'waiting on you' alert routes to)", () => {
  test("owner wins over creator and participants", () => {
    expect(
      responsibleActor(
        session({
          ownerActor: "alice",
          createdActor: "bob",
          participantActors: ["carol"],
        })
      )
    ).toBe("alice");
  });

  test("creator when unowned, else the earliest participant", () => {
    expect(
      responsibleActor(session({ createdActor: "bob", participantActors: ["carol"] }))
    ).toBe("bob");
    expect(
      responsibleActor(session({ participantActors: ["carol", "dave"] }))
    ).toBe("carol");
  });

  test("an unattributed or missing session is nobody's", () => {
    expect(responsibleActor(session({}))).toBeUndefined();
    expect(responsibleActor(undefined)).toBeUndefined();
  });
});

describe("isMyResponsibility (whose alarm a blocked session fires)", () => {
  test("only the responsible user's alarm fires — a teammate-owned session is not mine", () => {
    const owned = session({ ownerActor: "alice" });
    expect(isMyResponsibility(owned, "alice")).toBe(true);
    // The leak this closes: bob no longer gets alice's block as his own alarm.
    expect(isMyResponsibility(owned, "bob")).toBe(false);
  });

  test("a participant who is not the responsible actor sees it as someone else's", () => {
    // owner alice is responsible; bob merely participated → soft, not bob's alarm.
    const s = session({ ownerActor: "alice", participantActors: ["bob"] });
    expect(isMyResponsibility(s, "bob")).toBe(false);
  });

  test("an unattributed session surfaces to everyone rather than vanishing", () => {
    expect(isMyResponsibility(session({}), "alice")).toBe(true);
  });

  test("an unresolved viewer identity still sees every alarm", () => {
    expect(isMyResponsibility(session({ ownerActor: "alice" }), "")).toBe(true);
  });
});

describe("answerableSession (whose attribution an ask routes by)", () => {
  const root = session({ id: "r", ownerActor: "alice" });
  const child = session({ id: "r:1", parentSessionId: "r" });
  const grandchild = session({ id: "r:1:1", parentSessionId: "r:1" });
  const own = session({ id: "r:2", parentSessionId: "r", ownerActor: "bob" });
  const byId = new Map([root, child, grandchild, own].map((s) => [s.id, s]));

  test("a subagent with no actors of its own answers as its nearest attributed parent", () => {
    expect(answerableSession("r:1", byId)?.id).toBe("r");
    expect(answerableSession("r:1:1", byId)?.id).toBe("r");
  });

  test("a subagent someone has answered before still answers as its parent, not as that participant", () => {
    const answered = session({ id: "r:3", parentSessionId: "r", participantActors: ["bob"] });
    expect(answerableSession("r:3", new Map([root, answered].map((s) => [s.id, s])))?.id).toBe("r");
    // With no attributed parent, its participant is the last resort.
    const orphan = session({ id: "o:1", parentSessionId: "o", participantActors: ["bob"] });
    expect(answerableSession("o:1", new Map([[orphan.id, orphan]]))?.id).toBe("o:1");
  });

  test("a session with its own attribution answers for itself", () => {
    expect(answerableSession("r:2", byId)?.id).toBe("r:2");
    expect(answerableSession("r", byId)?.id).toBe("r");
  });

  test("with no attributed parent, or a parent cycle, it is the asking session", () => {
    const loose = session({ id: "a", parentSessionId: "b" });
    const back = session({ id: "b", parentSessionId: "a" });
    expect(answerableSession("a", new Map([loose, back].map((s) => [s.id, s])))?.id).toBe("a");
    expect(answerableSession("missing", byId)).toBeUndefined();
  });
});

describe("isMineLaunch (still-provisioning, sessionless launch)", () => {
  test("a launch I dispatched is mine", () => {
    expect(isMineLaunch(launch({ requester: "alice" }), "alice")).toBe(true);
  });

  test("a teammate's in-flight launch is NOT mine (the leak this closes)", () => {
    // The bug: "Mine" showed every user's provisioning launch to everyone.
    expect(isMineLaunch(launch({ requester: "bob" }), "alice")).toBe(false);
  });

  test("a launch with no requester (automatic) is nobody's, and an empty user matches nothing", () => {
    expect(isMineLaunch(launch({ requester: undefined }), "alice")).toBe(false);
    expect(isMineLaunch(launch({ requester: "alice" }), "")).toBe(false);
  });
});
