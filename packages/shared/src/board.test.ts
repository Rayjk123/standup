import { describe, expect, test } from "bun:test";
import {
  boardAreas,
  boardConflictMap,
  BRIEF_PATHS_MAX,
  briefPaths,
  deriveBoardStatus,
  findConflicts,
  GOAL_NOTE_SCORE,
  GOAL_OVERLAP_THRESHOLD,
  GOAL_STRONG_OVERLAP,
  goalEvidence,
  goalTerms,
  mirrorJobOnBacklog,
  jobStatusBoardStatus,
  leadRun,
  matchesBoardQuery,
  MAX_TASK_CONFLICTS,
  packageOfPath,
  ticketBoardStatus,
  type BoardConflict,
  type BoardJobFacts,
  type BoardRunFacts,
  type BoardTask,
} from "./board.js";

const T0 = "2026-10-12T10:00:00.000Z";
const T1 = "2026-10-12T11:00:00.000Z";

function run(stage: string, over: Partial<BoardRunFacts> = {}): BoardRunFacts {
  return { runId: `run-${stage}`, stage, stageKind: stage, status: "active", updatedAt: T0, ...over };
}

function facts(over: Partial<BoardJobFacts> = {}): BoardJobFacts {
  return { status: "active", runs: [], pendingPacket: false, planAwaiting: false, queuedLaunches: 0, ...over };
}

function task(id: string, over: Partial<BoardTask> = {}): BoardTask {
  return {
    id,
    source: "job",
    sourceId: id,
    owner: "o",
    projectId: "standup",
    title: `task ${id}`,
    status: "coding",
    links: { jobId: `job-${id}` },
    areas: { files: [], packages: [] },
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

describe("deriveBoardStatus", () => {
  const cases: { name: string; facts: BoardJobFacts; want: { status: string; flag?: string; waitingOn?: string } }[] = [
    { name: "a new job with nothing launched is queued", facts: facts(), want: { status: "queued" } },
    { name: "a launch queued for host room", facts: facts({ queuedLaunches: 1 }), want: { status: "queued", waitingOn: "host room to start" } },
    { name: "a plan awaiting approval is planned", facts: facts({ planAwaiting: true }), want: { status: "queued", flag: "planned", waitingOn: "plan approval" } },
    { name: "a run at start with a plan awaiting is planned", facts: facts({ planAwaiting: true, runs: [run("start")] }), want: { status: "queued", flag: "planned" } },
    { name: "coding", facts: facts({ runs: [run("coding")] }), want: { status: "coding" } },
    { name: "validation", facts: facts({ runs: [run("validation")] }), want: { status: "validation" } },
    { name: "adversarial review shares the validation column", facts: facts({ runs: [run("review")] }), want: { status: "validation" } },
    { name: "live check", facts: facts({ runs: [run("live_check")] }), want: { status: "live_check" } },
    { name: "deploy shares the live-check column", facts: facts({ runs: [run("deploy")] }), want: { status: "live_check" } },
    { name: "screenshot shares the live-check column", facts: facts({ runs: [run("screenshot")] }), want: { status: "live_check" } },
    // 6: code_review and human_review with no packet pending are the worker opening the review or writing its packet.
    { name: "human review with no packet pending is validation", facts: facts({ runs: [run("human_review")] }), want: { status: "validation", waitingOn: undefined } },
    { name: "an active code_review run with no packet is validation, code review in progress", facts: facts({ runs: [run("code_review")] }), want: { status: "validation", waitingOn: "code review in progress" } },
    { name: "a packet sent back while the run is held at code_review is not in review", facts: facts({ pendingPacket: false, runs: [run("code_review")] }), want: { status: "validation", waitingOn: "code review in progress" } },
    // 3: a pending packet.
    { name: "a pending packet is in review", facts: facts({ pendingPacket: true, runs: [run("screenshot")] }), want: { status: "in_review", waitingOn: "owner review of the packet" } },
    { name: "a waiting run with a pending packet is in review", facts: facts({ pendingPacket: true, runs: [run("human_review", { status: "waiting_user", waitingReason: "x" })] }), want: { status: "in_review", waitingOn: "owner review of the packet" } },
    { name: "a pending packet wins over a run waiting on owner input", facts: facts({ pendingPacket: true, runs: [run("code_review", { status: "waiting_user", waitingKind: "owner_input", waitingReason: "review landed: close it" })] }), want: { status: "in_review", waitingOn: "owner review of the packet" } },
    { name: "a pending packet wins over a parked run", facts: facts({ pendingPacket: true, runs: [run("human_review", { parkedReason: "waiting on job abc" })] }), want: { status: "in_review", flag: undefined, waitingOn: "owner review of the packet" } },
    { name: "a hand-off waiting whose only action is the packet's review stays in review", facts: facts({ status: "waiting_user", viewState: "needs_you", needs: ["waiting"], actions: [{ kind: "review" }], waitingSource: "handoff", pendingPacket: true, runs: [run("human_review", { status: "waiting_user", waitingKind: "owner_input" })] }), want: { status: "in_review", waitingOn: "owner review of the packet" } },
    { name: "Persona's escalation with a packet pending is waiting on the owner",facts: facts({ status: "waiting_user", viewState: "needs_you", needs: ["waiting"], actions: [{ kind: "review" }], waitingSource: "persona", pendingPacket: true, runs: [run("human_review", { status: "waiting_user", waitingReason: "the owner decides the API shape" })] }), want: { status: "waiting", waitingOn: "the owner" } },
    { name: "a review-only waiting of unknown source is waiting", facts: facts({ status: "waiting_user", viewState: "needs_you", needs: ["waiting"], actions: [{ kind: "review" }], pendingPacket: true }), want: { status: "waiting", waitingOn: "the owner" } },
    // 2: the owner has a decision beyond the packet.
    { name: "a waiting with more behind it than the packet's review is waiting", facts: facts({ status: "waiting_user", viewState: "needs_you", needs: ["waiting"], actions: [{ kind: "review" }, { kind: "pipeline" }], pendingPacket: true, runs: [run("human_review")] }), want: { status: "waiting", waitingOn: "the owner" } },
    { name: "an approval card wins over a pending packet", facts: facts({ viewState: "needs_you", needs: ["approval"], actions: [{ kind: "approval" }, { kind: "review" }], pendingPacket: true, runs: [run("human_review")] }), want: { status: "waiting", waitingOn: "owner approval" } },
    { name: "a question wins over a pending packet", facts: facts({ viewState: "needs_you", needs: ["question"], actions: [{ kind: "message" }], pendingPacket: true }), want: { status: "waiting", waitingOn: "an answer from the owner" } },
    { name: "a waiting with no packet pending is waiting", facts: facts({ status: "waiting_user", viewState: "needs_you", needs: ["waiting"], actions: [{ kind: "pipeline" }], runs: [run("coding", { status: "waiting_user", waitingKind: "exhausted" })] }), want: { status: "waiting", waitingOn: "the owner" } },
    { name: "a stored waiting_user with no view known is waiting even with a packet pending", facts: facts({ status: "waiting_user", pendingPacket: true }), want: { status: "waiting", waitingOn: "the owner" } },
    { name: "a waiting run on a job waiting on its owner is waiting", facts: facts({ status: "waiting_user", runs: [run("review", { status: "waiting_user", waitingReason: "wontfix waiver" })] }), want: { status: "waiting", waitingOn: "wontfix waiver" } },
    // 5: every blocked run is Persona's to decide, whatever its kind or reason.
    { name: "a waiting run on an active job is Persona deciding, in the run's stage column", facts: facts({ runs: [run("review", { status: "waiting_user", waitingReason: "wontfix waiver" })] }), want: { status: "validation", waitingOn: "Persona deciding: wontfix waiver" } },
    { name: "an owner-input wait at code_review is Persona deciding in the validation column", facts: facts({ runs: [run("code_review", { status: "waiting_user", waitingKind: "owner_input", waitingReason: "the change already landed" })] }), want: { status: "validation", waitingOn: "Persona deciding: the change already landed" } },
    { name: "an owner-input wait with no reason is Persona deciding", facts: facts({ runs: [run("code_review", { status: "waiting_user", waitingKind: "owner_input" })] }), want: { status: "validation", waitingOn: "Persona deciding" } },
    { name: "an owner-input wait at human review with no packet is Persona deciding", facts: facts({ runs: [run("human_review", { status: "waiting_user", waitingKind: "owner_input", waitingReason: "the picked attempt's worker has ended" })] }), want: { status: "validation", waitingOn: "Persona deciding: the picked attempt's worker has ended" } },
    { name: "a wontfix hold stays in the validation column", facts: facts({ runs: [run("review", { status: "waiting_user", waitingKind: "owner_input", waitingReason: "wontfix findings" })] }), want: { status: "validation", waitingOn: "Persona deciding: wontfix findings" } },
    { name: "another run Persona decides wins over the lead run's stage", facts: facts({ runs: [run("human_review", { runId: "a" }), run("coding", { runId: "b", status: "waiting_user", waitingKind: "owner_input", waitingReason: "pick a branch" })] }), want: { status: "coding", waitingOn: "Persona deciding: pick a branch" } },
    { name: "another run Persona decides puts the card in that run's stage column", facts: facts({ runs: [run("live_check", { runId: "a" }), run("validation", { runId: "b", status: "waiting_user", waitingKind: "exhausted", waitingReason: "retries spent" })] }), want: { status: "validation", waitingOn: "Persona deciding: retries spent" } },
    { name: "an exhausted waiting run is Persona deciding", facts: facts({ runs: [run("validation", { status: "waiting_user", waitingKind: "exhausted", waitingReason: "retries spent" })] }), want: { status: "validation", waitingOn: "Persona deciding: retries spent" } },
    { name: "a stalled waiting run is Persona deciding", facts: facts({ runs: [run("coding", { status: "waiting_user", waitingKind: "stalled", waitingReason: "no heartbeat" })] }), want: { status: "coding", waitingOn: "Persona deciding: no heartbeat" } },
    // 4: a parked run waits on another job, in the lead run's stage column.
    { name: "a parked run stays in its stage column, flagged parked", facts: facts({ runs: [run("coding", { parkedReason: "waiting on job abc" })] }), want: { status: "coding", flag: "parked", waitingOn: "parked: waiting on job abc" } },
    { name: "another run parked flags the lead run's stage column", facts: facts({ runs: [run("live_check", { runId: "a" }), run("coding", { runId: "b", parkedReason: "waiting on job abc" })] }), want: { status: "live_check", flag: "parked", waitingOn: "parked: waiting on job abc" } },
    { name: "a parked run wins over another run Persona decides", facts: facts({ runs: [run("review", { runId: "a", status: "waiting_user", waitingKind: "stalled" }), run("coding", { runId: "b", parkedReason: "waiting on job abc" })] }), want: { status: "validation", flag: "parked", waitingOn: "parked: waiting on job abc" } },
    { name: "a stored waiting_user job whose known view isn't needs_you reads its run", facts: facts({ status: "waiting_user", viewState: "running", runs: [run("coding")] }), want: { status: "coding" } },
    { name: "a stored waiting_user job with no view is waiting", facts: facts({ status: "waiting_user", runs: [run("coding")] }), want: { status: "waiting", waitingOn: "the owner" } },
    { name: "a finished run with a plan awaiting approval is planned", facts: facts({ planAwaiting: true, runs: [run("complete", { status: "complete" })] }), want: { status: "queued", flag: "planned", waitingOn: "plan approval" } },
    { name: "an active job whose runs all finished awaits Persona's close-out", facts: facts({ runs: [run("complete", { status: "complete" })] }), want: { status: "in_review", waitingOn: "Persona to close out" } },
    { name: "an active job with a finished run and a launch queued is queued", facts: facts({ queuedLaunches: 1, runs: [run("complete", { status: "complete" })] }), want: { status: "queued", waitingOn: "host room to start" } },
    { name: "an active job with a finished run and another launch running is coding", facts: facts({ viewState: "running", liveLaunches: 1, runs: [run("complete", { status: "complete" })] }), want: { status: "coding" } },
    { name: "a finished run with only its own worker still running awaits close-out", facts: facts({ viewState: "running", runs: [run("complete", { status: "complete" })] }), want: { status: "in_review", waitingOn: "Persona to close out" } },
    { name: "a run at the complete stage never closes an active job", facts: facts({ runs: [run("complete")] }), want: { status: "in_review" } },
    { name: "only disabled runs with a worker running is coding", facts: facts({ viewState: "running", runs: [run("coding", { status: "disabled" })] }), want: { status: "coding" } },
    { name: "only disabled runs with nothing running is queued", facts: facts({ viewState: "idle", runs: [run("coding", { status: "disabled" })] }), want: { status: "queued" } },
    { name: "a finished run with another launch's session running is coding whatever the view says", facts: facts({ viewState: "idle", liveLaunches: 1, runs: [run("complete", { status: "complete" })] }), want: { status: "coding" } },
    { name: "no run and a launch still starting is queued though the view reads running", facts: facts({ viewState: "running", queuedLaunches: 1 }), want: { status: "queued", waitingOn: "host room to start" } },
    { name: "only disabled runs and a launch still starting is queued though the view reads running", facts: facts({ viewState: "running", queuedLaunches: 1, runs: [run("coding", { status: "disabled" })] }), want: { status: "queued", waitingOn: "host room to start" } },
    { name: "no run, a worker running and another launch starting is coding", facts: facts({ viewState: "running", queuedLaunches: 1, liveLaunches: 1 }), want: { status: "coding" } },
    { name: "a job that needs its owner wins over its stage", facts: facts({ viewState: "needs_you", needs: ["approval"], runs: [run("coding")] }), want: { status: "waiting", waitingOn: "owner approval" } },
    { name: "a stored waiting_user job", facts: facts({ status: "waiting_user" }), want: { status: "waiting", waitingOn: "the owner" } },
    { name: "a done job is done whatever its run says", facts: facts({ status: "done", runs: [run("coding")] }), want: { status: "done" } },
    { name: "a failed job", facts: facts({ status: "failed" }), want: { status: "failed" } },
    { name: "a cancelled job", facts: facts({ status: "cancelled", viewState: "needs_you" }), want: { status: "failed", flag: "cancelled" } },
    { name: "a custom stage reads its kind", facts: facts({ runs: [run("my_tests", { stageKind: "validation" })] }), want: { status: "validation" } },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const got = deriveBoardStatus(c.facts);
      expect(got.status).toBe(c.want.status as never);
      if ("flag" in c.want) expect(got.flag).toBe(c.want.flag as never);
      if ("waitingOn" in c.want) expect(got.waitingOn).toBe(c.want.waitingOn);
    });
  }

  test("a job advancing through its pipeline moves across every column", () => {
    const steps: [BoardJobFacts, string][] = [
      [facts(), "queued"],
      [facts({ runs: [run("start")] }), "queued"],
      [facts({ runs: [run("coding")] }), "coding"],
      [facts({ runs: [run("validation")] }), "validation"],
      [facts({ runs: [run("review")] }), "validation"],
      [facts({ runs: [run("live_check")] }), "live_check"],
      [facts({ runs: [run("screenshot")] }), "live_check"],
      [facts({ runs: [run("human_review")], pendingPacket: true }), "in_review"],
      [facts({ runs: [run("human_review", { status: "complete" })], status: "done" }), "done"],
    ];
    expect(steps.map(([f]) => deriveBoardStatus(f).status)).toEqual(steps.map(([, s]) => s) as never);
  });

  test("the stage and run id of the lead run are reported", () => {
    const got = deriveBoardStatus(facts({ runs: [run("coding", { runId: "r1" })] }));
    expect(got).toMatchObject({ stage: "coding", runId: "r1" });
  });

  test("a card Persona decides on a run other than the lead reports that run's stage and id", () => {
    const got = deriveBoardStatus(
      facts({
        runs: [
          run("human_review", { runId: "a" }),
          run("coding", { runId: "b", status: "waiting_user", waitingKind: "owner_input", waitingReason: "pick a branch" }),
        ],
      })
    );
    expect(got).toMatchObject({ status: "coding", stage: "coding", runId: "b" });
  });

  test("a parked card reports the lead run's stage and id", () => {
    const got = deriveBoardStatus(facts({ runs: [run("live_check", { runId: "a" }), run("coding", { runId: "b", parkedReason: "on job x" })] }));
    expect(got).toMatchObject({ status: "live_check", flag: "parked", stage: "live_check", runId: "a" });
  });
});

describe("leadRun", () => {
  test("the most-advanced live run wins", () => {
    const got = leadRun([run("coding", { runId: "a" }), run("live_check", { runId: "b" }), run("validation", { runId: "c" })]);
    expect(got?.runId).toBe("b");
  });
  test("a live run beats a further-along finished one", () => {
    const got = leadRun([run("complete", { runId: "old", status: "complete" }), run("coding", { runId: "new" })]);
    expect(got?.runId).toBe("new");
  });
  test("ties go to the latest update", () => {
    const got = leadRun([run("coding", { runId: "a", updatedAt: T0 }), run("coding", { runId: "b", updatedAt: T1 })]);
    expect(got?.runId).toBe("b");
  });
  test("disabled runs are ignored once nothing is live", () => {
    expect(leadRun([run("coding", { status: "disabled" })])).toBeUndefined();
  });
});

describe("ticketBoardStatus", () => {
  test("maps every ticket status", () => {
    expect(ticketBoardStatus("proposed")).toEqual({ status: "queued", waitingOn: "owner approval" });
    expect(ticketBoardStatus("approved").status).toBe("queued");
    expect(ticketBoardStatus("developing").status).toBe("coding");
    expect(ticketBoardStatus("needs_review").status).toBe("in_review");
    expect(ticketBoardStatus("shipped").status).toBe("done");
    expect(ticketBoardStatus("dismissed")).toEqual({ status: "failed", flag: "cancelled" });
  });
  test("a job's stored status alone gives its coarse column", () => {
    expect(jobStatusBoardStatus("active").status).toBe("queued");
    expect(jobStatusBoardStatus("waiting_user").status).toBe("waiting");
    expect(jobStatusBoardStatus("done").status).toBe("done");
    expect(jobStatusBoardStatus("cancelled").flag).toBe("cancelled");
  });
});

describe("areas", () => {
  test("packages come from a container dir's children, else the top directory", () => {
    expect(packageOfPath("packages/web/src/App.tsx")).toBe("packages/web");
    expect(packageOfPath("apps/site/pages/index.tsx")).toBe("apps/site");
    expect(packageOfPath("crates/core/src/lib.rs")).toBe("crates/core");
    expect(packageOfPath("./scripts/dev.ts")).toBe("scripts");
    expect(packageOfPath("README.md")).toBeUndefined();
  });
  test("a file directly in a container dir falls in no package; src/ is an ordinary top directory", () => {
    expect(packageOfPath("packages/tsconfig.json")).toBeUndefined();
    expect(packageOfPath("src/index.ts")).toBe("src");
    expect(packageOfPath("src/server/app.ts")).toBe("src");
    expect(boardAreas(["src/a.ts", "src/b.ts"]).packages).toEqual(["src"]);
  });
  test("boardAreas normalizes and dedupes", () => {
    expect(boardAreas(["./packages/web/src/A.tsx", "packages/web/src/A.tsx", "/docs/x.md", ""])).toEqual({
      files: ["docs/x.md", "packages/web/src/A.tsx"],
      packages: ["docs", "packages/web"],
    });
  });
});

describe("findConflicts", () => {
  const board = [
    task("a", { areas: { files: ["packages/web/src/components/Console.tsx"], packages: ["packages/web"] } }),
    task("b", { areas: { files: ["packages/store/src/migrations.ts"], packages: ["packages/store"] } }),
    task("c", { title: "Program backlog items for long-running jobs with persistent memory" }),
    task("d", { status: "done", areas: { files: ["packages/web/src/components/Console.tsx"], packages: ["packages/web"] } }),
    task("e", { projectId: "other", areas: { files: ["packages/web/src/components/Console.tsx"], packages: ["packages/web"] } }),
  ];

  test("an exact file overlap is reported, strongest first", () => {
    const got = findConflicts({ projectId: "standup", files: ["packages/web/src/components/Console.tsx"] }, board);
    expect(got[0]?.taskId).toBe("a");
    expect(got[0]?.reasons.find((r) => r.kind === "files")).toEqual({ kind: "files", overlap: ["packages/web/src/components/Console.tsx"] });
  });
  test("a directory overlaps the files under it", () => {
    const got = findConflicts({ projectId: "standup", files: ["packages/store/src"] }, board);
    expect(got.map((c) => c.taskId)).toEqual(["b"]);
  });
  test("a shared package is a weaker overlap", () => {
    const got = findConflicts({ projectId: "standup", packages: ["packages/web"] }, board);
    expect(got.map((c) => c.taskId)).toEqual(["a"]);
    expect(got[0]?.score).toBeLessThan(0.6);
  });
  test("an overlapping goal is reported with its shared terms", () => {
    const got = findConflicts({ projectId: "standup", goal: "Long-running jobs keep persistent memory across program backlogs" }, board);
    expect(got.map((c) => c.taskId)).toEqual(["c"]);
    const reason = got[0]?.reasons[0];
    expect(reason?.kind).toBe("goal");
    if (reason?.kind === "goal") expect(reason.sharedTerms).toContain("memory");
  });
  test("an unrelated goal is not reported", () => {
    expect(findConflicts({ goal: "Rotate the Slack signing secret" }, board)).toEqual([]);
  });
  test("closed tasks, other projects' files, the task itself and its own job are skipped", () => {
    const files = ["packages/web/src/components/Console.tsx"];
    expect(findConflicts({ projectId: "standup", files }, board).map((c) => c.taskId)).toEqual(["a"]);
    expect(findConflicts({ projectId: "standup", files, excludeTaskId: "a" }, board)).toEqual([]);
    expect(findConflicts({ projectId: "standup", files, excludeJobId: "job-a" }, board)).toEqual([]);
  });
  test("a probe without a project checks every project", () => {
    const got = findConflicts({ files: ["packages/web/src/components/Console.tsx"] }, board);
    expect(got.map((c) => c.taskId).sort()).toEqual(["a", "e"]);
  });
  test("several reasons raise the score", () => {
    const one = findConflicts({ projectId: "standup", packages: ["packages/web"] }, board)[0]!;
    const two = findConflicts({ projectId: "standup", files: ["packages/web/src/components/Console.tsx"] }, board)[0]!;
    expect(two.reasons.length).toBe(2);
    expect(two.score).toBeGreaterThan(one.score);
  });
  test("boardConflictMap pairs overlapping open tasks both ways", () => {
    const map = boardConflictMap([
      task("x", { areas: { files: ["packages/a/src/f.ts"], packages: ["packages/a"] } }),
      task("y", { areas: { files: ["packages/a/src/f.ts"], packages: ["packages/a"] } }),
      task("z", { areas: { files: ["packages/b/src/g.ts"], packages: ["packages/b"] } }),
    ]);
    expect(map.get("x")?.map((c) => c.taskId)).toEqual(["y"]);
    expect(map.get("y")?.map((c) => c.taskId)).toEqual(["x"]);
    expect(map.has("z")).toBe(false);
  });
  test("a task without a project gets no file or package overlap with a project's probe", () => {
    const loose = [task("n", { projectId: undefined, areas: { files: ["packages/web/src/x.ts"], packages: ["packages/web"] } })];
    expect(findConflicts({ projectId: "standup", files: ["packages/web/src/x.ts"] }, loose)).toEqual([]);
    expect(findConflicts({ files: ["packages/web/src/x.ts"] }, loose).map((c) => c.taskId)).toEqual(["n"]);
  });
  test("boardConflictMap: a project-less task and a project's task share no file overlap in either direction", () => {
    const files = { files: ["packages/web/src/x.ts"], packages: ["packages/web"] };
    const map = boardConflictMap([task("n", { projectId: undefined, areas: files }), task("p", { areas: files })]);
    expect(map.has("n")).toBe(false);
    expect(map.has("p")).toBe(false);
    const loose = boardConflictMap([task("n1", { projectId: undefined, areas: files }), task("n2", { projectId: undefined, areas: files })]);
    expect(loose.get("n1")?.map((c) => c.taskId)).toEqual(["n2"]);
    expect(loose.get("n2")?.map((c) => c.taskId)).toEqual(["n1"]);
  });
  test("boardConflictMap keeps at most MAX_TASK_CONFLICTS per task, strongest first", () => {
    const shared = "packages/a/src/f.ts";
    const strong = Array.from({ length: 4 }, (_, i) =>
      task(`s${i}`, { areas: { files: [shared, `packages/a/src/g${i}.ts`, "packages/a/src/h.ts"], packages: ["packages/a"] } })
    );
    const weak = Array.from({ length: 12 }, (_, i) => task(`w${i}`, { areas: { files: [`packages/a/src/only${i}.ts`], packages: ["packages/a"] } }));
    const probe = task("probe", { areas: { files: [shared, "packages/a/src/h.ts"], packages: ["packages/a"] } });
    const got = boardConflictMap([probe, ...strong, ...weak]).get("probe")!;
    expect(MAX_TASK_CONFLICTS).toBe(10);
    expect(got).toHaveLength(MAX_TASK_CONFLICTS);
    expect(got.slice(0, 4).map((c) => c.taskId).sort()).toEqual(["s0", "s1", "s2", "s3"]);
    for (let i = 1; i < got.length; i++) expect(got[i - 1]!.score).toBeGreaterThanOrEqual(got[i]!.score);
  });
  test("a goal overlap needs at least two shared terms, whatever the Jaccard score", () => {
    const one = [task("g", { title: "Telemetry" })];
    expect(findConflicts({ title: "telemetry" }, one)).toEqual([]);
    const two = [task("g", { title: "Telemetry exporter" })];
    expect(findConflicts({ title: "telemetry exporter" }, two).map((c) => c.taskId)).toEqual(["g"]);
  });
  test("a very long goal is read only up to its cap for terms", () => {
    const long = `${"filler ".repeat(400)} zebrafish quokka`;
    const board = [task("l", { title: "x", goal: long })];
    expect(findConflicts({ title: "zebrafish quokka" }, board)).toEqual([]);
  });
  test("boardConflictMap over 500 open tasks finishes well under a second", () => {
    const many = Array.from({ length: 500 }, (_, i) =>
      task(`m${i}`, {
        title: `Widget${i % 50} gizmo${i % 50} rework`,
        goal: Array.from({ length: 300 }, (_, k) => `w${i}x${k}`).join(" "),
        areas: {
          files: Array.from({ length: 50 }, (_, j) => `packages/p${i % 20}/src/dir${j % 7}/file${j}.ts`),
          packages: [`packages/p${i % 20}`],
        },
      })
    );
    const started = performance.now();
    const map = boardConflictMap(many);
    const elapsed = performance.now() - started;
    expect(map.size).toBe(500);
    expect(elapsed).toBeLessThan(1000);
  });
  describe("realistic briefs", () => {
    const LIFECYCLE_BRIEF = [
      "Goal: make the Board's task cards in the Standup console show where each Persona job really is. The card's column is derived in deriveBoardStatus (packages/shared/src/board.ts) from the job's pipeline runs, review packets and launches; the projection in packages/collector/src/board/projection.ts gathers those facts and the board adapter reprojects a card on every pipeline, review and launch frame.",
      "Acceptance: a job whose worker submitted its review packet sits In review until the owner decides it; a blocked pipeline run reads Persona deciding in its stage column; a parked run stays in its column flagged parked. Board lifecycle tests in board.test.ts and the adapter tests in packages/collector/src/board/adapter.test.ts cover each column.",
      "Context: the board adapter subscribes to the broadcast tap; board cards are stored in board_tasks. Constraints: run bun test for the board files and bun run typecheck; don't touch packages/web.",
    ].join("\n\n");
    const CONFLICT_BRIEF = [
      "Goal: tighten how the Board flags work that collides with a Persona job already in flight. When launch_session starts a worker, the board's conflict check compares the new brief with every open task card on the board and notes overlapping jobs; today the goal score never fires because whole briefs are compared. Score goals by the overlap of their distinctive terms, and probe with the job's title plus the head of the brief.",
      "Acceptance: two briefs about the Board's task cards are flagged as a conflict and two briefs about unrelated areas are not. Tests in packages/shared/src/board.test.ts and packages/collector/src/persona/board-tool.test.ts.",
      "Constraints: run bun test and bun run typecheck; keep findConflicts and boardConflictMap fast over 500 open cards.",
    ].join("\n\n");
    /** The same brief without the "flagged" it shares with the lifecycle brief by coincidence. */
    const CONFLICT_REWORDED_BRIEF = CONFLICT_BRIEF.replace("flagged as a conflict", "reported as a conflict");
    const SLACK_BRIEF = [
      "Goal: rotate the Slack app's signing secret without dropping events. The Slack relay in packages/slack verifies each request's signature against the signing secret read at startup; accept both the old and the new secret for a grace window, then retire the old one.",
      "Acceptance: a request signed with either secret is accepted during the window and one signed with the retired secret is rejected after it. Tests in packages/slack/src/verify.test.ts.",
      "Constraints: run bun test and bun run typecheck; never log a secret.",
    ].join("\n\n");
    const KNOWLEDGE_BRIEF = [
      "Goal: re-verify knowledge docs whose cited files changed since they were written. The nightly reverify cron in packages/knowledge reads each doc's file pointers, diffs them against the repo at mainline, and marks a doc stale when a cited symbol moved or vanished, proposing a fix as a draft for the owner.",
      "Acceptance: a doc citing a renamed function is marked stale with a drafted correction; a doc whose citations are unchanged is left alone. Tests in packages/knowledge/src/reverify.test.ts.",
      "Constraints: run bun test and bun run typecheck; keep the cron under a minute for 2,000 docs.",
    ].join("\n\n");
    const SLACK_DM_BRIEF = [
      "Goal: route Persona's approval cards to the owner's Slack DMs instead of the team channel. Today packages/collector/src/persona/notify.ts posts every approval card a Persona job raises to the project's channel, where teammates see the owner's pending decisions. Look up the owner's Slack user id from the persona owner settings, open a DM conversation with conversations.open, and post the card there; fall back to the channel only when no DM can be opened. The console's Persona tab shows where each card went.",
      "Acceptance: an approval card for a job owned by alice is posted to alice's DM; a failed DM open falls back to the channel with a note in the job's thread. Tests in packages/collector/src/persona/notify.test.ts.",
      "Constraints: run bun test for the persona files and bun run typecheck; don't touch packages/web.",
    ].join("\n\n");
    /** What launch_session probes with: the job's title and the head of its brief. */
    const probe = (title: string, brief: string) => ({ projectId: "standup", title, goal: brief.slice(0, 600) });
    const board = [
      task("lifecycle", { title: "Board card lifecycle: true columns for Persona jobs", goal: LIFECYCLE_BRIEF }),
      task("slack", { title: "Rotate the Slack signing secret", goal: SLACK_BRIEF }),
      task("knowledge", { title: "Reverify stale knowledge docs", goal: KNOWLEDGE_BRIEF }),
    ];

    test("two briefs about the same area are flagged, strongly enough for launch_session's note", () => {
      const got = findConflicts(probe("Board conflict detection for launch_session", CONFLICT_BRIEF), board);
      expect(got.map((c) => c.taskId)).toEqual(["lifecycle"]);
      const reason = got[0]!.reasons.find((r) => r.kind === "goal");
      expect(reason?.kind).toBe("goal");
      if (reason?.kind === "goal") {
        expect(reason.score).toBeGreaterThanOrEqual(GOAL_OVERLAP_THRESHOLD);
        expect(reason.sharedTerms).toEqual(expect.arrayContaining(["board", "card"]));
      }
      // launch_session notes conflicts scoring at least 0.5.
      expect(got[0]!.score).toBeGreaterThanOrEqual(0.5);
    });

    /** The goal comparison of a probe with one task among `tasks`. */
    const evidenceOf = (p: ReturnType<typeof probe>, tasks: BoardTask[], taskId: string) => goalEvidence(p, tasks).find((e) => e.taskId === taskId)!;

    test("the same-area pair clears the evidence floor without its incidental shared word (4.75 and 3.0 against 2.5)", () => {
      expect(CONFLICT_REWORDED_BRIEF).not.toContain("flagged");
      const original = evidenceOf(probe("Board conflict detection for launch_session", CONFLICT_BRIEF), board, "lifecycle");
      expect(original.sharedTerms).toContain("flagged");
      expect(original.floor).toBe(2.5);
      expect(original.evidence).toBeCloseTo(4.75, 5);
      const reworded = evidenceOf(probe("Board conflict detection for launch_session", CONFLICT_REWORDED_BRIEF), board, "lifecycle");
      expect(reworded.sharedTerms).not.toContain("flagged");
      expect(reworded.sharedTerms).toContain("board");
      // A margin of half a term: eroding it fails here first.
      expect(reworded.evidence).toBeCloseTo(3.0, 5);
      expect(reworded.evidence - reworded.floor).toBeGreaterThanOrEqual(0.5);
      expect(reworded.share).toBeGreaterThanOrEqual(GOAL_STRONG_OVERLAP);
      expect(reworded.reported).toBe(true);
      // Still reported, and still strong enough for launch_session's note.
      const got = findConflicts(probe("Board conflict detection for launch_session", CONFLICT_REWORDED_BRIEF), board);
      expect(got.map((c) => c.taskId)).toEqual(["lifecycle"]);
      expect(got[0]!.reasons.map((r) => r.kind)).toEqual(["goal"]);
      expect(got[0]!.score).toBeGreaterThanOrEqual(GOAL_NOTE_SCORE);
    });

    test("the unrelated Standup pair and the repo-noun pair stay under the evidence floor (1.25 and 1.75 against 2.5)", () => {
      const dm = probe("Persona Slack: route approval cards to DMs", SLACK_DM_BRIEF);
      const unrelated = evidenceOf(dm, board, "lifecycle");
      expect(unrelated.evidence).toBeCloseTo(1.25, 5);
      expect(unrelated.floor - unrelated.evidence).toBeGreaterThanOrEqual(1);
      expect(unrelated.reported).toBe(false);
      // The one distinctive word the DM brief shares with the Slack brief counts at most 1.75.
      const slack = evidenceOf(dm, board, "slack");
      expect(slack.sharedTerms).toEqual(["slack"]);
      expect(slack.evidence).toBeLessThanOrEqual(1.75);
      expect(slack.reported).toBe(false);
      const nouns = goalEvidence({ projectId: "standup", goal: "persona console owner pipeline worker session in packages/collector/src/persona/a.ts" }, [
        task("n", { goal: "persona console owner pipeline worker session in packages/collector/src/persona/b.ts" }),
      ])[0]!;
      expect(nouns.share).toBe(1);
      expect(nouns.evidence).toBeCloseTo(1.75, 5);
      expect(nouns.reported).toBe(false);
    });

    test("two briefs about unrelated areas are not flagged", () => {
      expect(findConflicts(probe("Rotate the Slack signing secret", SLACK_BRIEF), [board[0]!, board[2]!])).toEqual([]);
      expect(findConflicts(probe("Reverify stale knowledge docs", KNOWLEDGE_BRIEF), [board[0]!, board[1]!])).toEqual([]);
      const unrelated = [task("conflict", { title: "Board conflict detection for launch_session", goal: CONFLICT_BRIEF }), board[1]!];
      expect(findConflicts(probe("Reverify stale knowledge docs", KNOWLEDGE_BRIEF), unrelated)).toEqual([]);
    });

    test("two unrelated Standup briefs sharing only repo nouns raise no launch note", () => {
      const dm = probe("Persona Slack: route approval cards to DMs", SLACK_DM_BRIEF);
      // Against the lifecycle brief alone, and on the whole board.
      for (const tasks of [[board[0]!], board]) {
        const got = findConflicts(dm, tasks);
        for (const c of got) expect(c.score).toBeLessThan(GOAL_NOTE_SCORE);
        expect(got.filter((c) => c.taskId === "lifecycle")).toEqual([]);
      }
      // And the other way round: the lifecycle probe against the Slack DM card.
      const back = findConflicts(probe("Board card lifecycle: true columns for Persona jobs", LIFECYCLE_BRIEF), [
        task("dm", { title: "Persona Slack: route approval cards to DMs", goal: SLACK_DM_BRIEF }),
        board[1]!,
        board[2]!,
      ]);
      for (const c of back) expect(c.score).toBeLessThan(GOAL_NOTE_SCORE);
    });

    test("a goal overlap below GOAL_STRONG_OVERLAP scores under the note's cutoff", () => {
      expect(GOAL_OVERLAP_THRESHOLD).toBeLessThan(GOAL_STRONG_OVERLAP);
      const words = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}q`).join(" ");
      const tasks = [
        task("w", { goal: `zebrafish quokka axolotl ${words("tk", 60)}` }),
        task("f1", { title: "filler one" }),
        task("f2", { title: "filler two" }),
      ];
      const shareOf = (c: BoardConflict): number => {
        const reason = c.reasons.find((r) => r.kind === "goal");
        return reason?.kind === "goal" ? reason.score : Number.NaN;
      };
      // Three rare terms shared out of a 49-term probe: reported, but short of a note.
      const weak = findConflicts({ projectId: "standup", goal: `zebrafish quokka axolotl ${words("pr", 46)}` }, tasks);
      expect(weak.map((c) => c.taskId)).toEqual(["w"]);
      expect(shareOf(weak[0]!)).toBeGreaterThanOrEqual(GOAL_OVERLAP_THRESHOLD);
      expect(shareOf(weak[0]!)).toBeLessThan(GOAL_STRONG_OVERLAP);
      expect(weak[0]!.score).toBeLessThan(GOAL_NOTE_SCORE);
      // The same three out of a 20-term probe: strong, and noted.
      const strong = findConflicts({ projectId: "standup", goal: `zebrafish quokka axolotl ${words("pr", 17)}` }, tasks);
      expect(shareOf(strong[0]!)).toBeGreaterThanOrEqual(GOAL_STRONG_OVERLAP);
      expect(strong[0]!.score).toBeGreaterThanOrEqual(GOAL_NOTE_SCORE);
    });

    test("common repo nouns and a path's directories weigh less than distinctive terms", () => {
      // Sharing only repo nouns and directory names isn't a conflict.
      const nouns = findConflicts({ projectId: "standup", goal: "persona console owner pipeline worker session in packages/collector/src/persona/a.ts" }, [
        task("n", { goal: "persona console owner pipeline worker session in packages/collector/src/persona/b.ts" }),
      ]);
      expect(nouns.every((c) => c.score < GOAL_NOTE_SCORE)).toBe(true);
      // Sharing as many distinctive terms is.
      const distinct = findConflicts({ projectId: "standup", goal: "zebrafish quokka axolotl mantis narwhal pangolin" }, [
        task("d", { goal: "zebrafish quokka axolotl mantis narwhal pangolin" }),
      ]);
      expect(distinct[0]!.score).toBeGreaterThanOrEqual(GOAL_NOTE_SCORE);
    });

    test("boardConflictMap pairs the two Board briefs and nothing else", () => {
      const map = boardConflictMap([...board, task("conflict", { title: "Board conflict detection for launch_session", goal: CONFLICT_BRIEF })]);
      expect(map.get("conflict")?.map((c) => c.taskId)).toEqual(["lifecycle"]);
      expect(map.get("lifecycle")?.map((c) => c.taskId)).toEqual(["conflict"]);
      expect(map.has("slack")).toBe(false);
      expect(map.has("knowledge")).toBe(false);
    });
  });

  test("a long goal needs three shared terms, a short one two", () => {
    const long = [task("l", { title: "alpha bravo charlie delta echo foxtrot golf" })];
    expect(findConflicts({ title: "alpha bravo hotel india juliet kilo lima" }, long)).toEqual([]);
    expect(findConflicts({ title: "alpha bravo charlie india juliet kilo lima" }, long).map((c) => c.taskId)).toEqual(["l"]);
    const short = [task("s", { title: "alpha bravo charlie" })];
    expect(findConflicts({ title: "alpha bravo" }, short).map((c) => c.taskId)).toEqual(["s"]);
  });

  test("two shared terms clear a long goal's floor when no other card names them, not when every card does", () => {
    const fillers = [task("f1", { title: "mango papaya guava lychee durian quince" }), task("f2", { title: "cobalt nickel zinc copper argon xenon" })];
    const long = task("l", { title: "alpha bravo charlie delta echo foxtrot golf" });
    const probe = { title: "alpha bravo hotel india juliet kilo lima" };
    const rare = goalEvidence(probe, [long, ...fillers]).find((e) => e.taskId === "l")!;
    // On four cards, a term only the two name counts 1.75.
    expect(rare.evidence).toBeCloseTo(3.5, 5);
    expect(findConflicts(probe, [long, ...fillers]).map((c) => c.taskId)).toEqual(["l"]);
    const common = [task("f1", { title: "alpha bravo papaya guava lychee durian" }), task("f2", { title: "alpha bravo zinc copper argon xenon" })];
    const plain = goalEvidence(probe, [long, ...common]).find((e) => e.taskId === "l")!;
    expect(plain.evidence).toBeCloseTo(2, 5);
    expect(findConflicts(probe, [long, ...common]).filter((c) => c.taskId === "l")).toEqual([]);
  });

  test("a file collision outranks the strongest goal overlap", () => {
    const words = "zebrafish quokka axolotl mantis narwhal pangolin";
    const tasks = [
      task("goal", { goal: words }),
      task("file", { title: "unrelated", areas: { files: ["packages/a/src/f.ts"], packages: ["packages/a"] } }),
    ];
    const probe = { projectId: "standup", goal: words, files: ["packages/a/src/f.ts"] };
    const got = findConflicts(probe, tasks);
    expect(got.map((c) => c.taskId)).toEqual(["file", "goal"]);
    expect(got[1]!.score).toBeGreaterThanOrEqual(GOAL_NOTE_SCORE);
    expect(got[1]!.score).toBeLessThan(0.6);
    const map = boardConflictMap([task("p", { goal: words, areas: { files: ["packages/a/src/f.ts"], packages: ["packages/a"] } }), ...tasks]);
    expect(map.get("p")?.map((c) => c.taskId)).toEqual(["file", "goal"]);
  });

  test("briefPaths reads the file paths a brief cites", () => {
    const brief =
      "Change packages/shared/src/board.ts (and ./packages/web/src/App.tsx). Leave packages/web alone, and/or skip ../outside/x.ts; " +
      "see https://code.example.com/packages/Foo/blobs/x.ts. Tests in packages/shared/src/board.test.ts and packages/shared/src/board.ts again.";
    expect(briefPaths(brief)).toEqual(["packages/shared/src/board.ts", "packages/web/src/App.tsx", "packages/shared/src/board.test.ts"]);
    const many = Array.from({ length: 80 }, (_, i) => `src/f${i}.ts`).join(" ");
    expect(briefPaths(many)).toHaveLength(BRIEF_PATHS_MAX);
    expect(briefPaths(many, 3)).toEqual(["src/f0.ts", "src/f1.ts", "src/f2.ts"]);
    expect(briefPaths("no paths here")).toEqual([]);
  });

  test("goalTerms drops stopwords and folds plurals", () => {
    expect([...goalTerms("Add the boards and tasks to the console")].sort()).toEqual(["board", "console"]);
  });

  test("goalTerms drops the default-branch names a brief diffs against", () => {
    for (const branch of ["main", "mainline", "trunk"]) {
      expect([branch, [...goalTerms(`diff the console against the repo at ${branch}`)].sort()]).toEqual([branch, ["console", "diff", "repo"]]);
    }
  });
});

describe("mirrorJobOnBacklog", () => {
  test("takes the job card's column, stage, waiting-on, areas and links, and keeps its own identity, title and goal", () => {
    const job = task("j", {
      status: "in_review",
      flag: "parked",
      stage: "human_review",
      waitingOn: "owner review of the packet",
      links: { jobId: "j", packetId: "p1", runId: "r1" },
      areas: { files: ["packages/a/src/f.ts"], packages: ["packages/a"] },
    });
    const backlog = {
      ...task("b", { source: "backlog" as const, owner: "o", projectId: undefined, title: "Backlog item", goal: "the item" }),
      status: "queued" as const,
      links: { backlogItemId: "item-1", jobId: "j" },
    };
    expect(mirrorJobOnBacklog(backlog, job)).toEqual({
      source: "backlog",
      sourceId: "b",
      owner: "o",
      projectId: "standup",
      title: "Backlog item",
      goal: "the item",
      status: "in_review",
      flag: "parked",
      stage: "human_review",
      waitingOn: "owner review of the packet",
      links: { jobId: "j", packetId: "p1", runId: "r1", backlogItemId: "item-1" },
      areas: { files: ["packages/a/src/f.ts"], packages: ["packages/a"] },
    });
  });
});

describe("matchesBoardQuery", () => {
  const t = task("q", {
    title: "Board tab",
    goal: "Persona board",
    status: "coding",
    areas: { files: ["packages/web/src/components/BoardView.tsx"], packages: ["packages/web"] },
  });
  test("filters by status, source, project, text and files", () => {
    expect(matchesBoardQuery(t, { status: ["coding"] })).toBe(true);
    expect(matchesBoardQuery(t, { status: ["done"] })).toBe(false);
    expect(matchesBoardQuery(t, { source: ["ticket"] })).toBe(false);
    expect(matchesBoardQuery(t, { projectId: "other" })).toBe(false);
    expect(matchesBoardQuery(t, { text: "persona BOARD" })).toBe(true);
    expect(matchesBoardQuery(t, { text: "slack" })).toBe(false);
    expect(matchesBoardQuery(t, { files: ["packages/web/src"] })).toBe(true);
    expect(matchesBoardQuery(t, { files: ["packages/web"] })).toBe(true);
    expect(matchesBoardQuery(t, { files: ["packages/store"] })).toBe(false);
  });
  test("closed tasks drop out with includeClosed false", () => {
    expect(matchesBoardQuery({ ...t, status: "done" }, { includeClosed: false })).toBe(false);
  });
});
