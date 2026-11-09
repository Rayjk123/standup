import { describe, expect, test } from "bun:test";
import {
  attachSessionToLaunch,
  createCheckpoint,
  createLaunch,
  createPersonaJob,
  createSession,
  createStore,
  getOrCreatePersonaConsoleThread,
  linkPersonaJobLaunch,
  upsertProject,
} from "@standup/store";
import type { WsMessage } from "@standup/shared";
import { hostUserAlias } from "../host-user.js";
import { launchOwnsWorktree, onEnterHumanReview, resolveReviewWorker, reviewRefs, reviewOwnerForLaunch } from "./stage.js";
import type { GitRunner } from "./stage.js";

/** A git that answers from `answers` by joined args, recording every call. */
function fakeGit(answers: Record<string, string | null>) {
  const calls: string[] = [];
  const git: GitRunner = (args, cwd) => {
    calls.push(`${cwd}: ${args.join(" ")}`);
    const key = args.join(" ");
    return key in answers ? answers[key]! : null;
  };
  return { git, calls };
}

const BASE = "b".repeat(40);
const HEAD = "h".repeat(40);

function world(requester?: string) {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "P", branch: "main", repos: [] });
  createLaunch(store.db, {
    id: "l1",
    projectId: "p",
    task: "t",
    worktreePath: "/wt",
    branch: "b",
    status: "running",
    ...(requester ? { requester, launchedBy: requester } : {}),
  });
  createSession(store.db, { id: "s1", projectId: "p", title: "t", cwd: "/wt", status: "idle" });
  attachSessionToLaunch(store.db, "l1", "s1");
  return store;
}

describe("reviewRefs", () => {
  test("reads branch, head, the merge base with origin/main and the changed files", () => {
    const { git } = fakeGit({
      "rev-parse --abbrev-ref HEAD": "feat/x",
      "rev-parse HEAD": HEAD,
      "merge-base HEAD origin/main": BASE,
      [`diff --name-only ${BASE}..HEAD`]: "a.ts\nsrc/b.ts\n",
      [`diff --shortstat ${BASE}..HEAD`]: "2 files changed",
    });
    expect(reviewRefs("/wt", git)).toEqual({ branch: "feat/x", headSha: HEAD, baseSha: BASE, changedFiles: ["a.ts", "src/b.ts"], diffStat: "2 files changed" });
  });

  test("falls back to main when origin/main has no merge base; no base means no changed files", () => {
    const fallback = fakeGit({ "merge-base HEAD main": BASE, [`diff --name-only ${BASE}..HEAD`]: "" });
    expect(reviewRefs("/wt", fallback.git)).toMatchObject({ baseSha: BASE, changedFiles: [] });
    expect(fallback.calls).toContain("/wt: merge-base HEAD origin/main");
    expect(reviewRefs("/wt", fakeGit({ "rev-parse --abbrev-ref HEAD": "HEAD" }).git)).toEqual({
      branch: undefined,
      headSha: undefined,
      baseSha: undefined,
      changedFiles: null,
      diffStat: undefined,
    });
  });

  test("the newest merge base wins, so a remote left behind by local merges isn't the base", () => {
    const LOCAL = "l".repeat(40);
    const STALE = "s".repeat(40);
    // The branch was rebased onto local main; origin/main is 198 commits behind it.
    const { git, calls } = fakeGit({
      "rev-parse --abbrev-ref HEAD": "standup/x",
      "rev-parse HEAD": HEAD,
      "merge-base HEAD main": LOCAL,
      "merge-base HEAD origin/main": STALE,
      [`merge-base --is-ancestor ${STALE} ${LOCAL}`]: "",
      [`diff --name-only ${LOCAL}..HEAD`]: "a.ts\n",
      [`diff --name-only ${STALE}..HEAD`]: Array.from({ length: 858 }, (_, i) => `f${i}.ts`).join("\n"),
    });
    expect(reviewRefs("/wt", git, "main")).toMatchObject({ baseSha: LOCAL, changedFiles: ["a.ts"] });
    // Reading it took no fetch or push.
    expect(calls.some((c) => /\b(fetch|push)\b/.test(c))).toBe(false);
  });

  test("a local branch behind its remote is not the base either", () => {
    const BEHIND = "1".repeat(40);
    const AHEAD = "2".repeat(40);
    const { git } = fakeGit({
      "rev-parse HEAD": HEAD,
      "merge-base HEAD main": BEHIND,
      "merge-base HEAD origin/main": AHEAD,
      [`merge-base --is-ancestor ${BEHIND} ${AHEAD}`]: "",
      [`diff --name-only ${AHEAD}..HEAD`]: "a.ts\n",
    });
    expect(reviewRefs("/wt", git, "main")).toMatchObject({ baseSha: AHEAD, changedFiles: ["a.ts"] });
  });

  test("unrelated merge bases fall back to the first candidate", () => {
    const ONE = "1".repeat(40);
    const TWO = "2".repeat(40);
    const { git } = fakeGit({
      "rev-parse HEAD": HEAD,
      "merge-base HEAD release": ONE,
      "merge-base HEAD main": TWO,
      [`diff --name-only ${ONE}..HEAD`]: "a.ts\n",
    });
    expect(reviewRefs("/wt", git, "release")).toMatchObject({ baseSha: ONE });
  });
});

describe("the review owner and worker", () => {
  test("the owner is who the collector resolved as launching it, else its Persona job's owner, else no one", () => {
    const store = world("alice");
    expect(reviewOwnerForLaunch(store.db, { launchedBy: "alice", requester: "mallory", id: "l1" } as never)).toBe("alice");
    // A caller-named requester alone is never an owner, nor is the host a fallback.
    expect(reviewOwnerForLaunch(store.db, { id: "l1", requester: "alice" } as never)).toBeNull();
    expect(reviewOwnerForLaunch(store.db, { id: "other", requester: "anonymous" } as never)).toBeNull();
    expect(reviewOwnerForLaunch(store.db, { id: "other", launchedBy: "anonymous" } as never)).toBeNull();
    expect(reviewOwnerForLaunch(store.db, { id: "other", launchedBy: "  " } as never)).toBeNull();
    expect(reviewOwnerForLaunch(store.db, { id: "other" } as never)).not.toBe(hostUserAlias());
    const job = createPersonaJob(store.db, { owner: "carol", threadId: getOrCreatePersonaConsoleThread(store.db, "carol").id, title: "t", goal: "g" });
    linkPersonaJobLaunch(store.db, job.id, "l1");
    expect(reviewOwnerForLaunch(store.db, { id: "l1", requester: "alice" } as never)).toBe("carol");
  });

  test("only a launch Standup made a checkout for owns its worktree", () => {
    expect(launchOwnsWorktree({ kind: "worktree" } as never)).toBe(true);
    expect(launchOwnsWorktree({ kind: "bootstrap" } as never)).toBe(true);
    expect(launchOwnsWorktree({ kind: "adopted" } as never)).toBe(false);
  });

  test("an in-place launch, a fixer reusing another launch's tree, and a provisioned dir don't own their worktree", () => {
    expect(launchOwnsWorktree({ kind: "worktree", inPlace: true } as never)).toBe(false);
    expect(launchOwnsWorktree({ kind: "worktree", provisioned: true } as never)).toBe(false);
    expect(launchOwnsWorktree({ kind: "bootstrap", inPlace: true } as never)).toBe(false);
    expect(launchOwnsWorktree({ kind: "worktree", inPlace: false, provisioned: false } as never)).toBe(true);
  });

  test("the steer queued on entering review needs a proven socket", () => {
    const store = world("alice");
    const frames: WsMessage[] = [];
    onEnterHumanReview(store.db, { owner: "alice", launchId: "l1", sessionId: "s1" }, { git: () => null, broadcast: (m) => frames.push(m) });
    expect(frames[0]).toMatchObject({ type: "steer:queued", audience: "alice", requireProof: true });
  });

  test("a subagent session resolves to its parent's launch", () => {
    const store = world("alice");
    createSession(store.db, { id: "child", projectId: "p", title: "t", cwd: "/wt", status: "idle", parentSessionId: "s1" });
    const byId = (id: string | null | undefined) => (id ? { id } : null) as never;
    const worker = resolveReviewWorker(store.db, { sessionId: "child" }, byId)!;
    expect(worker.launch.id).toBe("l1");
    expect(worker.owner).toBe("alice");
    expect(worker.worktree).toBe("/wt");
    expect(resolveReviewWorker(store.db, { sessionId: "ghost" }, () => null)).toBeNull();
  });
});

describe("onEnterHumanReview", () => {
  const answers = {
    "rev-parse --abbrev-ref HEAD": "feat/x",
    "rev-parse HEAD": HEAD,
    "merge-base HEAD origin/main": BASE,
    [`diff --name-only ${BASE}..HEAD`]: "a.ts",
  };

  test("creates a draft with the refs, builds the brief and queues it as a steer", () => {
    const store = world("alice");
    createCheckpoint(store.db, "s1", "self-reported", "Wired the routes");
    const frames: WsMessage[] = [];
    const { git } = fakeGit(answers);
    const out = onEnterHumanReview(store.db, { owner: "alice", launchId: "l1", sessionId: "s1", worktree: "/wt" }, { git, broadcast: (m) => frames.push(m) });
    expect(out.packet).toMatchObject({ owner: "alice", launchId: "l1", status: "draft", branch: "feat/x", commitSha: HEAD, baseSha: BASE });
    expect(out.brief).toContain(`git diff ${BASE}..${HEAD}`);
    expect(out.brief).toContain("- a.ts");
    expect(out.brief).toContain("Wired the routes");
    expect(out.brief).toContain(out.packet.id);
    const steers = store.db.query("SELECT id, body FROM steers WHERE session_id = 's1'").all() as Array<{ id: string; body: string }>;
    expect(steers).toEqual([{ id: out.steerId!, body: out.brief }]);
    expect(frames.map((f) => f.type)).toEqual(["steer:queued"]);
    expect(frames[0]!.audience).toBe("alice");
  });

  test("names the launch's review scratch dir in the brief", () => {
    const store = world("alice");
    const { git } = fakeGit(answers);
    const out = onEnterHumanReview(
      store.db,
      { owner: "alice", launchId: "l1", sessionId: "s1", worktree: "/wt", scratchDir: "/data/review-scratch/l1" },
      { git, queueSteer: false }
    );
    expect(out.brief).toContain("Review scratch dir: /data/review-scratch/l1");
  });

  test("reuses the owner's draft and can skip the steer", () => {
    const store = world("alice");
    const { git } = fakeGit(answers);
    const first = onEnterHumanReview(store.db, { owner: "alice", launchId: "l1", sessionId: "s1", worktree: "/wt" }, { git });
    const again = onEnterHumanReview(store.db, { owner: "alice", launchId: "l1", sessionId: "s1", worktree: "/wt" }, { git, queueSteer: false });
    expect(again.packet.id).toBe(first.packet.id);
    expect(again.steerId).toBeUndefined();
    expect((store.db.query("SELECT COUNT(*) AS n FROM steers").get() as { n: number }).n).toBe(1);
  });
});
