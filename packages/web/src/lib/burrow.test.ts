import { describe, expect, test } from "bun:test";
import type { Ask, Launch, PersonaJob, PipelineRun, Session } from "@standup/shared";
import { bunnyActivity, bunnyState, buildBurrow, burrowLaunchIds, type BunnyActivity, type PendingReview } from "./burrow";

const STAGES = [
  { id: "start", kind: "start" },
  { id: "coding", kind: "coding" },
  { id: "validation", kind: "validation" },
  { id: "review", kind: "review" },
  { id: "live_check", kind: "live_check" },
  { id: "deploy", kind: "deploy" },
  { id: "screenshot", kind: "screenshot" },
  { id: "code_review", kind: "code_review" },
  { id: "human_review", kind: "human_review" },
  { id: "complete", kind: "complete" },
  { id: "lint-pass", kind: "custom_lint" },
];

function run(over: Partial<PipelineRun> = {}): PipelineRun {
  return {
    id: "r1",
    launchId: "l1",
    owner: "owner",
    definition: { version: 1, stages: STAGES.map((s) => ({ ...s, title: s.id, required: true, edges: [] })) },
    definitionHash: "h",
    currentStage: "coding",
    status: "active",
    facts: {},
    stopBlocks: 0,
    stageEnteredAt: "2026-10-14T00:00:00Z",
    createdAt: "2026-10-14T00:00:00Z",
    updatedAt: "2026-10-14T00:00:00Z",
    attempts: [],
    ...over,
  };
}

function session(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    projectId: "standup",
    title: "Session title",
    cwd: "/tmp/x",
    status: "running",
    startedAt: new Date("2026-10-14T00:00:00Z"),
    owned: true,
    ...over,
  } as Session;
}

const running = { status: "running" } as const;

function job(over: Partial<PersonaJob>): PersonaJob {
  return { id: "j", title: "Job", status: "active", sessionIds: [], launchIds: [], ...over } as PersonaJob;
}

function jobView(state: string): PersonaJob["view"] {
  return { state } as unknown as PersonaJob["view"];
}

describe("bunnyActivity", () => {
  const byStage: Array<[string, BunnyActivity]> = [
    ["coding", "smithing"],
    ["validation", "fishing"],
    ["review", "cooking"],
    ["live_check", "gardening"],
    ["deploy", "gardening"],
    ["screenshot", "painting"],
    ["code_review", "painting"],
    ["human_review", "painting"],
    ["start", "idle"],
    ["complete", "idle"],
  ];
  for (const [stage, activity] of byStage) {
    test(`a run at ${stage} is ${activity}`, () => {
      expect(bunnyActivity({ session: running, run: run({ currentStage: stage }) })).toBe(activity);
    });
  }

  test("an unknown stage kind falls back to the session's status", () => {
    expect(bunnyActivity({ session: running, run: run({ currentStage: "lint-pass" }) })).toBe("smithing");
    expect(bunnyActivity({ session: { status: "idle" }, run: run({ currentStage: "lint-pass" }) })).toBe("idle");
  });

  test("a stage id the definition doesn't list falls back to the session's status", () => {
    expect(bunnyActivity({ session: { status: "idle" }, run: run({ currentStage: "gone" }) })).toBe("idle");
  });

  test("with no run, a running session codes and any other open one idles", () => {
    expect(bunnyActivity({ session: running })).toBe("smithing");
    expect(bunnyActivity({ session: { status: "idle" } })).toBe("idle");
    expect(bunnyActivity({ session: { status: "done" } })).toBe("idle");
  });

  test("a wait says why: a question the worker asked, or a decision its job or held run needs", () => {
    expect(bunnyState({ session: running, ownerAsk: true })).toMatchObject({ wait: "question", state: "has a question for you" });
    expect(bunnyState({ session: { status: "waiting" } })).toMatchObject({ wait: "question" });
    expect(bunnyState({ session: running, run: run({ status: "waiting_user" }) })).toMatchObject({ wait: "decision", state: "needs your decision" });
    expect(bunnyState({ session: running, job: job({ view: jobView("needs_you") }) })).toMatchObject({ wait: "decision" });
    expect(bunnyState({ session: running }).wait).toBeUndefined();
  });

  test("a stalled session dozes, apart from a paused one", () => {
    expect(bunnyActivity({ session: { status: "stalled" } })).toBe("quiet");
    expect(bunnyActivity({ session: { status: "stalled" }, run: run({ currentStage: "validation" }) })).toBe("quiet");
    const parked = run({ parked: { reason: "r", by: "worker", actor: "w", at: "t" } });
    expect(bunnyActivity({ session: { status: "stalled" }, run: parked })).toBe("sleeping");
    expect(bunnyActivity({ session: { status: "stalled" }, reaped: true })).toBe("sleeping");
  });

  test("a held run at human review has sent its packet", () => {
    const held = run({ currentStage: "human_review", status: "waiting_user" });
    expect(bunnyState({ session: running, run: held, job: job({}) })).toEqual({ activity: "painting", state: "review packet sent" });
  });

  test("a closed job's worker reads as one with no job", () => {
    const held = run({ currentStage: "validation", status: "waiting_user" });
    expect(bunnyActivity({ session: running, run: held, job: job({ status: "done" }) })).toBe("sign");
  });

  test("each stage has its own words", () => {
    const words = (stage: string) => bunnyState({ session: running, run: run({ currentStage: stage }) }).state;
    expect(["review", "deploy", "code_review", "human_review"].map(words)).toEqual([
      "reviewing",
      "deploying",
      "opening the code review",
      "writing the review packet",
    ]);
  });

  test("anything waiting on the owner holds up a sign, over the stage", () => {
    const atReview = run({ currentStage: "review" });
    expect(bunnyActivity({ session: running, run: atReview, ownerAsk: true })).toBe("sign");
    expect(bunnyActivity({ session: { status: "waiting" }, run: atReview })).toBe("sign");
    expect(bunnyActivity({ session: running, run: run({ status: "waiting_user" }) })).toBe("sign");
    expect(bunnyActivity({ session: running, job: job({ status: "waiting_user" }) })).toBe("sign");
    expect(bunnyActivity({ session: running, job: job({ view: jobView("needs_you") }) })).toBe("sign");
  });

  test("what Persona decides is not the owner's (the Board's rule): a Persona-handled ask, any held run under a job", () => {
    const atReview = run({ currentStage: "review" });
    expect(bunnyActivity({ session: { status: "waiting" }, run: atReview, personaAsk: true })).toBe("cooking");
    // A held run under an active job is Persona deciding: it keeps its stage's activity.
    for (const waitingKind of ["exhausted", "stalled", "owner_input", undefined] as const) {
      const held = run({ currentStage: "validation", status: "waiting_user", waitingKind });
      expect(bunnyActivity({ session: running, run: held, job: job({}) })).toBe("fishing");
      // With no job, the owner decides it.
      expect(bunnyActivity({ session: running, run: held })).toBe("sign");
    }
    // A stored waiting_user the derived state has since cleared.
    expect(bunnyActivity({ session: running, job: job({ status: "waiting_user", view: jobView("running") }) })).toBe("smithing");
  });

  test("a job that needs the owner raises one sign, on its newest worker", () => {
    const needs = job({ view: jobView("needs_you") });
    expect(bunnyActivity({ session: running, job: needs, jobLead: true })).toBe("sign");
    expect(bunnyActivity({ session: running, job: needs, jobLead: false })).toBe("smithing");
  });

  test("a parked run and a reaped worker sleep, unless the owner is also needed", () => {
    const parked = run({ currentStage: "validation", parked: { reason: "waiting on a merge", by: "worker", actor: "w", at: "t" } });
    expect(bunnyActivity({ session: running, run: parked })).toBe("sleeping");
    expect(bunnyActivity({ session: running, run: parked, ownerAsk: true })).toBe("sign");
    expect(bunnyActivity({ session: { status: "done" }, run: run({ currentStage: "coding" }), reaped: true })).toBe("sleeping");
  });

  test("a complete or disabled run doesn't set the activity", () => {
    expect(bunnyActivity({ session: running, run: run({ status: "complete", currentStage: "complete" }) })).toBe("smithing");
    expect(bunnyActivity({ session: { status: "idle" }, run: run({ status: "disabled", currentStage: "review" }) })).toBe("idle");
  });
});

describe("buildBurrow", () => {
  const launch = (over: Partial<Launch>): Launch => ({ id: "l1", sessionId: "s1", createdAt: new Date("2026-10-14T00:00:00Z"), ...over }) as Launch;

  test("one bunny per open root session; ended roots and subagent children are not bunnies", () => {
    const sessions = [
      session({ id: "a" }),
      session({ id: "b", endedAt: new Date() }),
      session({ id: "c", status: "done", endedAt: new Date() }),
      session({ id: "a:x", parentSessionId: "a", kind: "subagent" }),
    ];
    const bunnies = buildBurrow({ sessions, launches: [], runs: [], asks: [], jobs: [] });
    expect(bunnies.map((b) => b.sessionId)).toEqual(["a"]);
  });

  test("only workers are bunnies: owned, launched, Persona's, or a job's; the owner's own terminal is not", () => {
    const sessions = [
      session({ id: "owned" }),
      session({ id: "launched", owned: false }),
      session({ id: "persona", owned: false, personaWorker: true }),
      session({ id: "jobs", owned: false }),
      session({ id: "terminal", owned: false }),
    ];
    const bunnies = buildBurrow({
      sessions,
      launches: [launch({ id: "l1", sessionId: "launched" })],
      runs: [],
      asks: [],
      jobs: [job({ sessionIds: ["jobs"] })],
    });
    expect(bunnies.map((b) => b.sessionId)).toEqual(["jobs", "launched", "owned", "persona"]);
  });

  test("a reaped worker stays, asleep and paused, while its launch can resume it", () => {
    const ended = new Date();
    const sessions = [session({ id: "s1", status: "done", endedAt: ended }), session({ id: "s2", status: "done", endedAt: ended })];
    const launches = [
      launch({ id: "l1", sessionId: "s1", status: "running", reapedAt: ended }),
      launch({ id: "l2", sessionId: "s2", status: "cleaned", reapedAt: ended }),
    ];
    const bunnies = buildBurrow({ sessions, launches, runs: [], asks: [], jobs: [] });
    expect(bunnies.map((b) => [b.sessionId, b.activity, b.state])).toEqual([["s1", "sleeping", "paused"]]);
    expect(burrowLaunchIds(sessions, launches)).toEqual(["l1"]);
  });

  test("a stalled worker dozes and reads as gone quiet", () => {
    const [bunny] = buildBurrow({ sessions: [session({ id: "s1", status: "stalled" })], launches: [], runs: [], asks: [], jobs: [] });
    expect(bunny).toMatchObject({ activity: "quiet", state: "gone quiet", ariaLabel: "Session title: gone quiet" });
  });

  test("a job's one decision raises one sign: on its newest worker only", () => {
    const at = (m: number) => new Date(Date.UTC(2026, 9, 14, 0, m));
    const needs = job({ id: "j", view: jobView("needs_you"), sessionIds: ["old", "new"] });
    const sessions = [session({ id: "old", startedAt: at(1) }), session({ id: "new", startedAt: at(2) })];
    const bunnies = buildBurrow({ sessions, launches: [], runs: [], asks: [], jobs: [needs] });
    expect(bunnies.map((b) => [b.sessionId, b.activity])).toEqual([
      ["old", "smithing"],
      ["new", "sign"],
    ]);
  });

  test("the sign goes to the job's stuck worker, over a newer one still at work", () => {
    const at = (m: number) => new Date(Date.UTC(2026, 9, 14, 0, m));
    const needs = job({ id: "j", view: jobView("needs_you"), sessionIds: ["old", "new"] });
    const sessions = [session({ id: "old", startedAt: at(1) }), session({ id: "new", startedAt: at(2) })];
    const launches = [launch({ id: "l-old", sessionId: "old" }), launch({ id: "l-new", sessionId: "new" })];
    const runs = [
      run({ id: "r-old", launchId: "l-old", currentStage: "review", status: "waiting_user" }),
      run({ id: "r-new", launchId: "l-new", currentStage: "validation" }),
    ];
    const bunnies = buildBurrow({ sessions, launches, runs, asks: [], jobs: [needs] });
    expect(bunnies.map((b) => [b.sessionId, b.activity])).toEqual([
      ["old", "sign"],
      ["new", "fishing"],
    ]);
  });

  test("a subagent's own live subagents count toward the root's tiny bunnies", () => {
    const sessions = [
      session({ id: "a" }),
      session({ id: "a:x", parentSessionId: "a", kind: "subagent" }),
      session({ id: "a:x:y", parentSessionId: "a:x", kind: "subagent" }),
    ];
    expect(buildBurrow({ sessions, launches: [], runs: [], asks: [], jobs: [] })[0].subagents).toBe(2);
  });

  test("a grandchild's pending ask raises its root's sign", () => {
    const sessions = [
      session({ id: "a" }),
      session({ id: "a:x", parentSessionId: "a", kind: "subagent" }),
      session({ id: "a:x:y", parentSessionId: "a:x", kind: "subagent" }),
    ];
    const asks = [{ id: "q", sessionId: "a:x:y", status: "pending" } as Ask];
    expect(buildBurrow({ sessions, launches: [], runs: [], asks, jobs: [] })[0].activity).toBe("sign");
  });

  test("a teammate's worker waiting on a question is at the door but waits on them, not the viewer", () => {
    const theirs = session({ id: "t", ownerActor: "alice", status: "waiting" } as Partial<Session>);
    const mine = session({ id: "m", ownerActor: "owner", status: "running" } as Partial<Session>);
    const asks = [
      { id: "q1", sessionId: "t", status: "pending", createdAt: new Date() } as Ask,
      { id: "q2", sessionId: "m", status: "pending", createdAt: new Date() } as Ask,
    ];
    const bunnies = buildBurrow({ sessions: [theirs, mine], launches: [], runs: [], asks, jobs: [], viewer: "owner" });
    const byId = Object.fromEntries(bunnies.map((b) => [b.sessionId, b]));
    expect(byId.t).toMatchObject({ activity: "sign", wait: "teammate", state: "waiting on alice" });
    expect(byId.m).toMatchObject({ activity: "sign", wait: "question" });
    // With no viewer known every question is the viewer's, as the alert strip has it.
    expect(buildBurrow({ sessions: [theirs], launches: [], runs: [], asks, jobs: [] })[0].wait).toBe("question");
  });

  test("a subagent's question is answered by whoever answers for its root", () => {
    const theirs = session({ id: "t", ownerActor: "alice" } as Partial<Session>);
    const child = session({ id: "t:1", parentSessionId: "t", kind: "subagent" } as Partial<Session>);
    const asks = [{ id: "q", sessionId: "t:1", status: "pending", createdAt: new Date() } as Ask];
    const [bunny] = buildBurrow({ sessions: [theirs, child], launches: [], runs: [], asks, jobs: [], viewer: "owner" });
    expect(bunny).toMatchObject({ sessionId: "t", wait: "teammate", state: "waiting on alice" });
  });

  test("until Persona's jobs are in, a Persona worker's held run isn't the viewer's decision", () => {
    const worker = session({ id: "p", personaWorker: true } as Partial<Session>);
    const inputs = {
      sessions: [worker],
      launches: [launch({ id: "lp", sessionId: "p" })],
      runs: [run({ id: "rp", launchId: "lp", status: "waiting_user" })],
      asks: [],
      jobs: [],
    };
    expect(buildBurrow({ ...inputs, jobsKnown: false })[0].wait).toBeUndefined();
    // Once they are in and it has no job, the held run is the viewer's, as the Board has it.
    expect(buildBurrow({ ...inputs, jobsKnown: true })[0].wait).toBe("decision");
  });

  test("a teammate's waiting session or held run waits on them, even with no ask", () => {
    const waiting = session({ id: "w", ownerActor: "alice", status: "waiting" } as Partial<Session>);
    const held = session({ id: "h", ownerActor: "alice" } as Partial<Session>);
    const launches = [launch({ id: "lh", sessionId: "h" })];
    const runs = [run({ id: "rh", launchId: "lh", status: "waiting_user" })];
    const bunnies = buildBurrow({ sessions: [waiting, held], launches, runs, asks: [], jobs: [], viewer: "owner" });
    expect(bunnies.map((b) => [b.sessionId, b.wait, b.state]).sort()).toEqual([
      ["h", "teammate", "waiting on alice"],
      ["w", "teammate", "waiting on alice"],
    ]);
  });

  test("a waiting worker carries when its oldest question was asked", () => {
    const asks = [
      { id: "a", sessionId: "s1", status: "pending", createdAt: new Date("2026-10-14T10:00:00Z") } as Ask,
      { id: "b", sessionId: "s1", status: "pending", createdAt: new Date("2026-10-14T09:00:00Z") } as Ask,
    ];
    const [bunny] = buildBurrow({ sessions: [session({ id: "s1" })], launches: [], runs: [], asks, jobs: [] });
    expect(bunny.waitingSince).toBe(new Date("2026-10-14T09:00:00Z").getTime());
  });

  test("a teammate's question dates its wait too; a waiting session with no ask listed has no known time", () => {
    const theirs = session({ id: "t", ownerActor: "alice" } as Partial<Session>);
    const asks = [{ id: "q", sessionId: "t", status: "pending", createdAt: new Date("2026-10-14T09:00:00Z") } as Ask];
    const [bunny] = buildBurrow({ sessions: [theirs], launches: [], runs: [], asks, jobs: [], viewer: "owner" });
    expect(bunny).toMatchObject({ wait: "teammate", waitingSince: new Date("2026-10-14T09:00:00Z").getTime() });
    const waiting = session({ id: "w", status: "waiting" });
    const launches = [launch({ id: "lw", sessionId: "w" })];
    const runs = [run({ id: "rw", launchId: "lw", stageEnteredAt: "2026-10-14T01:00:00Z" } as Partial<PipelineRun>)];
    const [w] = buildBurrow({ sessions: [waiting], launches, runs, asks: [], jobs: [] });
    expect(w.wait).toBe("question");
    expect(w.waitingSince).toBeUndefined();
  });

  test("a held run whose session waits on a Persona ask is dated by its stage, for the viewer or a teammate", () => {
    const since = "2026-10-14T01:00:00Z";
    const build = (over: Partial<Session>) =>
      buildBurrow({
        sessions: [session({ id: "s", status: "waiting", ...over } as Partial<Session>)],
        launches: [launch({ id: "l", sessionId: "s" })],
        runs: [run({ id: "r", launchId: "l", status: "waiting_user", stageEnteredAt: since } as Partial<PipelineRun>)],
        asks: [{ id: "q", sessionId: "s", status: "pending", personaHandled: true, createdAt: new Date() } as Ask],
        jobs: [],
        viewer: "owner",
      })[0];
    expect(build({ ownerActor: "owner" } as Partial<Session>)).toMatchObject({ wait: "decision", waitingSince: new Date(since).getTime() });
    expect(build({ ownerActor: "alice" } as Partial<Session>)).toMatchObject({ wait: "teammate", waitingSince: new Date(since).getTime() });
  });

  test("an ask Persona handles doesn't hold up a sign", () => {
    const asks = [{ id: "q", sessionId: "s1", status: "pending", personaHandled: true } as Ask];
    const [bunny] = buildBurrow({ sessions: [session({ id: "s1", status: "waiting" })], launches: [], runs: [], asks, jobs: [] });
    expect(bunny.activity).toBe("idle");
  });

  test("a turn-complete root with no end stamp stays: idle, or a sign when its run waits on the owner", () => {
    const sessions = [session({ id: "s1", status: "done" }), session({ id: "s2", status: "done" })];
    const launches = [launch({ id: "l1", sessionId: "s1" }), launch({ id: "l2", sessionId: "s2" })];
    const runs = [run({ id: "r2", launchId: "l2", currentStage: "human_review", status: "waiting_user" })];
    const bunnies = buildBurrow({ sessions, launches, runs, asks: [], jobs: [] });
    expect(bunnies.map((b) => [b.sessionId, b.activity])).toEqual([
      ["s1", "idle"],
      ["s2", "sign"],
    ]);
    expect(burrowLaunchIds(sessions, launches)).toEqual(["l1", "l2"]);
  });

  test("bunnies keep their order, oldest first, however the session list is sorted", () => {
    const at = (m: number) => new Date(Date.UTC(2026, 9, 14, 0, m));
    const sessions = [
      session({ id: "c", startedAt: at(3) }),
      session({ id: "a", startedAt: at(1) }),
      session({ id: "b2", startedAt: at(2) }),
      session({ id: "b1", startedAt: at(2) }),
    ];
    const order = (list: Session[]) => buildBurrow({ sessions: list, launches: [], runs: [], asks: [], jobs: [] }).map((b) => b.sessionId);
    expect(order(sessions)).toEqual(["a", "b1", "b2", "c"]);
    expect(order([...sessions].reverse())).toEqual(["a", "b1", "b2", "c"]);
  });

  test("a subagent's pending ask raises its parent's sign", () => {
    const sessions = [session({ id: "a" }), session({ id: "a:x", parentSessionId: "a", kind: "subagent" })];
    const asks = [{ id: "q", sessionId: "a:x", status: "pending" } as Ask];
    expect(buildBurrow({ sessions, launches: [], runs: [], asks, jobs: [] })[0].activity).toBe("sign");
  });

  test("the newest job naming a session wins (jobs come newest first)", () => {
    const job = (id: string, title: string) => ({ id, title, status: "active", sessionIds: ["s1"], launchIds: [] }) as unknown as PersonaJob;
    const [bunny] = buildBurrow({ sessions: [session({ id: "s1" })], launches: [], runs: [], asks: [], jobs: [job("new", "Newer"), job("old", "Older")] });
    expect(bunny.title).toBe("Newer");
  });

  test("running subagents count as tiny bunnies; finished ones don't", () => {
    const sessions = [
      session({ id: "a" }),
      session({ id: "a:1", parentSessionId: "a", status: "running" }),
      session({ id: "a:2", parentSessionId: "a", status: "running" }),
      session({ id: "a:3", parentSessionId: "a", status: "done", endedAt: new Date() }),
    ];
    const [bunny] = buildBurrow({ sessions, launches: [], runs: [], asks: [], jobs: [] });
    expect(bunny.subagents).toBe(2);
    expect(bunny.ariaLabel).toBe("Session title: coding, 2 subagents");
  });

  test("the session's launch's run sets the stage; the newest run of a launch wins", () => {
    const runs = [
      run({ id: "old", currentStage: "coding", createdAt: "2026-10-14T00:00:00Z" }),
      run({ id: "new", currentStage: "validation", createdAt: "2026-10-14T01:00:00Z" }),
    ];
    const [bunny] = buildBurrow({ sessions: [session({ id: "s1" })], launches: [launch({})], runs, asks: [], jobs: [] });
    expect(bunny.activity).toBe("fishing");
  });

  test("a pending ask of the session holds up a sign; a resolved one doesn't", () => {
    const ask = (status: Ask["status"]) => ({ id: "q", sessionId: "s1", status }) as Ask;
    const sessions = [session({ id: "s1" })];
    expect(buildBurrow({ sessions, launches: [], runs: [], asks: [ask("pending")], jobs: [] })[0].activity).toBe("sign");
    expect(buildBurrow({ sessions, launches: [], runs: [], asks: [ask("answered")], jobs: [] })[0].activity).toBe("smithing");
  });

  test("a job's session shows the job title and links to the job's drawer; another links to its session", () => {
    const job = { id: "j 1", title: "Bunny burrow", status: "active", sessionIds: ["s1"], launchIds: [] } as unknown as PersonaJob;
    const bunnies = buildBurrow({
      sessions: [session({ id: "s1" }), session({ id: "s2", title: "Loose session" })],
      launches: [],
      runs: [],
      asks: [],
      jobs: [job],
    });
    expect(bunnies[0]).toMatchObject({ title: "Bunny burrow", href: "/persona?job=j%201", ariaLabel: "Bunny burrow: coding" });
    expect(bunnies[1]).toMatchObject({ title: "Loose session", href: "/work/s/s2" });
  });

  test("a job found through the session's launch counts too", () => {
    const job = { id: "j", title: "Via launch", status: "waiting_user", sessionIds: [], launchIds: ["l1"] } as unknown as PersonaJob;
    const [bunny] = buildBurrow({ sessions: [session({ id: "s1" })], launches: [launch({})], runs: [], asks: [], jobs: [job] });
    expect(bunny).toMatchObject({ title: "Via launch", activity: "sign" });
  });
});

describe("a review packet waiting on the owner", () => {
  const launch = (over: Partial<Launch>): Launch => ({ id: "l1", sessionId: "s1", createdAt: new Date("2026-10-14T00:00:00Z"), ...over }) as Launch;
  const packet = (over: Partial<PendingReview> = {}): PendingReview => ({ id: "rp1", launchId: "l1", jobId: null, sessionId: null, ...over });
  const nook = { activity: "cooking" as BunnyActivity, state: "review packet waiting on you", href: "/review/rp1" };
  const ended = new Date("2026-10-14T01:00:00Z");

  test("an idle worker with a pending packet reads in the nook, and opens the packet", () => {
    const [bunny] = buildBurrow({ sessions: [session({ status: "idle" })], launches: [launch({})], runs: [], asks: [], jobs: [], pendingReviews: [packet()] });
    expect(bunny).toMatchObject({ ...nook, ariaLabel: "Session title: review packet waiting on you" });
  });

  test("a paused worker (reaped, or its run parked) with a pending packet reads in the nook", () => {
    const reaped = buildBurrow({
      sessions: [session({ status: "done", endedAt: ended })],
      launches: [launch({ status: "running", reapedAt: ended })],
      runs: [],
      asks: [],
      jobs: [],
      pendingReviews: [packet()],
    });
    expect(reaped.map((b) => ({ activity: b.activity, state: b.state, href: b.href }))).toEqual([nook]);
    const parked = buildBurrow({
      sessions: [session({ status: "idle" })],
      launches: [launch({})],
      runs: [run({ currentStage: "human_review", parked: { reason: "waiting" } as PipelineRun["parked"] })],
      asks: [],
      jobs: [],
      pendingReviews: [packet()],
    });
    expect(parked[0]).toMatchObject(nook);
  });

  test("an ended worker with a pending packet is back, in the nook: one bunny per packet, its newest session", () => {
    const sessions = [
      session({ id: "old", status: "done", endedAt: ended, startedAt: new Date("2026-10-14T00:00:00Z") }),
      session({ id: "new", status: "done", endedAt: ended, startedAt: new Date("2026-10-14T00:30:00Z") }),
      session({ id: "gone", status: "done", endedAt: ended }),
    ];
    const launches = [launch({ id: "l1", sessionId: "old", status: "cleaned" }), launch({ id: "l1", sessionId: "new", status: "cleaned" }), launch({ id: "l2", sessionId: "gone" })];
    const bunnies = buildBurrow({ sessions, launches, runs: [], asks: [], jobs: [], pendingReviews: [packet()] });
    expect(bunnies.map((b) => ({ id: b.sessionId, activity: b.activity, state: b.state, href: b.href }))).toEqual([{ id: "new", ...nook }]);
    // Its runs are read too.
    expect(burrowLaunchIds(sessions, launches, [], [packet()])).toEqual(["l1"]);
    // Without the packet it is gone, as any ended worker is.
    expect(buildBurrow({ sessions, launches, runs: [], asks: [], jobs: [] })).toEqual([]);
  });

  test("a held run whose packet was sent reads in the nook; a working or waiting worker keeps its place", () => {
    const sent = buildBurrow({
      sessions: [session({ status: "idle" })],
      launches: [launch({})],
      runs: [run({ currentStage: "human_review", status: "waiting_user" })],
      asks: [],
      jobs: [job({ sessionIds: ["s1"], view: jobView("working") })],
      pendingReviews: [packet({ launchId: null, jobId: "j" })],
    });
    expect(sent[0]).toMatchObject({ activity: "cooking", state: "review packet waiting on you", href: "/review/rp1" });
    const coding = buildBurrow({ sessions: [session()], launches: [launch({})], runs: [run()], asks: [], jobs: [], pendingReviews: [packet()] });
    expect(coding[0]).toMatchObject({ activity: "smithing", href: "/work/s/s1" });
    const asking = buildBurrow({ sessions: [session({ status: "waiting" })], launches: [launch({})], runs: [], asks: [], jobs: [], pendingReviews: [packet()] });
    expect(asking[0]).toMatchObject({ activity: "sign", wait: "question" });
  });
});

describe("burrowLaunchIds", () => {
  test("the launches of open root sessions, sorted and unique", () => {
    const sessions = [session({ id: "a" }), session({ id: "b", endedAt: new Date() }), session({ id: "c" })];
    const launches = [
      { id: "l3", sessionId: "c" },
      { id: "l2", sessionId: "b" },
      { id: "l1", sessionId: "a" },
      { id: "l0" },
    ] as Launch[];
    expect(burrowLaunchIds(sessions, launches)).toEqual(["l1", "l3"]);
  });
});
