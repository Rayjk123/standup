import { expect, test, describe } from "bun:test";
import { createStore } from "../store.js";
import {
  recordRetrievals,
  getRetrievalUsage,
  getRetrievalBreakdown,
  getLaunchInjectedDocs,
  getPushUptake,
  getSessionSeenDocs,
  getSessionInjectedDocs,
  BUDGET_DROP_REASON,
} from "./knowledge-retrievals.js";
import { createTaskRun, updateTaskRunStatus } from "./task-runs.js";
import { createSession, updateSessionStatus } from "./sessions.js";
import { attachSessionToLaunch, createLaunch } from "./launches.js";
import { upsertProject } from "./projects.js";
import { ensureKnowledgeRetrievalLatencyColumn } from "../migrations.js";

function setup() {
  return createStore(":memory:");
}

/** Create a session's task run and drive it to a terminal state for the feedback join. */
function runWithOutcome(
  db: import("bun:sqlite").Database,
  sessionId: string,
  outcome: "succeeded" | "failed"
) {
  const id = `run-${sessionId}`;
  createTaskRun(db, { id, projectId: "p", worktreePath: `/tmp/${sessionId}`, sessionId });
  updateTaskRunStatus(db, id, "running");
  updateTaskRunStatus(db, id, outcome);
}

describe("knowledge_retrievals telemetry", () => {
  test("records a retrieval and reads it back as per-doc usage", () => {
    const store = setup();
    recordRetrievals(store.db, [
      {
        docProject: "standup",
        docSlug: "architecture",
        query: "how does search work",
        rank: 0,
        score: 0.9,
        surface: "search",
        sessionId: "s1",
        queryProject: "standup",
      },
    ]);

    const usage = getRetrievalUsage(store.db);
    expect(usage).toHaveLength(1);
    expect(usage[0].docProject).toBe("standup");
    expect(usage[0].docSlug).toBe("architecture");
    expect(usage[0].retrievals).toBe(1);
    expect(usage[0].lastRetrievedAt).toBeTruthy();
    store.close();
  });

  test("aggregates repeated retrievals of the same doc and orders by count", () => {
    const store = setup();
    recordRetrievals(store.db, [
      { docProject: "p", docSlug: "hot", query: "q1", rank: 0, surface: "search" },
      { docProject: "p", docSlug: "hot", query: "q2", rank: 0, surface: "inject", injected: true },
      { docProject: "p", docSlug: "cold", query: "q3", rank: 1, surface: "search" },
    ]);

    const usage = getRetrievalUsage(store.db);
    expect(usage).toHaveLength(2);
    // Most-retrieved first.
    expect(usage[0].docSlug).toBe("hot");
    expect(usage[0].retrievals).toBe(2);
    expect(usage[1].docSlug).toBe("cold");
    expect(usage[1].retrievals).toBe(1);
    store.close();
  });

  test("scopes usage by the retrieved doc's project", () => {
    const store = setup();
    recordRetrievals(store.db, [
      { docProject: "a", docSlug: "one", query: "q", rank: 0, surface: "search" },
      { docProject: "b", docSlug: "two", query: "q", rank: 0, surface: "search" },
    ]);

    const scoped = getRetrievalUsage(store.db, "a");
    expect(scoped).toHaveLength(1);
    expect(scoped[0].docProject).toBe("a");
    store.close();
  });

  test("nullable score and optional correlation persist and an empty batch is a no-op", () => {
    const store = setup();
    // No score, no session — an injection-style / project-scoped read.
    recordRetrievals(store.db, [
      { docProject: "p", docSlug: "d", query: "q", rank: 0, surface: "inject" },
    ]);
    recordRetrievals(store.db, []); // no-op, must not throw

    const row = store.db
      .query("SELECT score, session_id, surface FROM knowledge_retrievals")
      .get() as { score: number | null; session_id: string | null; surface: string };
    expect(row.score).toBeNull();
    expect(row.session_id).toBeNull();
    expect(row.surface).toBe("inject");

    expect(getRetrievalUsage(store.db)).toHaveLength(1);
    store.close();
  });
});

describe("retrieval feedback — session-outcome breakdown", () => {
  test("attributes each retrieval to its correlated session's terminal outcome", () => {
    const store = setup();
    upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
    runWithOutcome(store.db, "win", "succeeded");
    runWithOutcome(store.db, "lose", "failed");

    // Same doc pulled in a session that succeeded and one that failed, plus a
    // third pull with no correlated session at all.
    recordRetrievals(store.db, [
      { docProject: "p", docSlug: "doc", query: "q", rank: 0, surface: "search", sessionId: "win" },
      { docProject: "p", docSlug: "doc", query: "q", rank: 0, surface: "search", sessionId: "lose" },
      { docProject: "p", docSlug: "doc", query: "q", rank: 0, surface: "search" },
    ]);

    const [row] = getRetrievalUsage(store.db, "p");
    expect(row.retrievals).toBe(3);
    expect(row.succeededRetrievals).toBe(1);
    expect(row.failedRetrievals).toBe(1);
    store.close();
  });

  test("'lost', cancelled, and in-flight runs all count as neither (unknown, not failure)", () => {
    const store = setup();
    upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
    // lost — the pane vanished with no explicit report; outcome is unknown, so
    // it must NOT be charged as a failure (a launch that did good work but
    // never called report_task is routinely reconciled to 'lost').
    createTaskRun(store.db, { id: "r-lost", projectId: "p", worktreePath: "/tmp/lost", sessionId: "lost" });
    updateTaskRunStatus(store.db, "r-lost", "lost");
    // cancelled — terminal but not an outcome signal.
    createTaskRun(store.db, { id: "r-canc", projectId: "p", worktreePath: "/tmp/canc", sessionId: "canc" });
    updateTaskRunStatus(store.db, "r-canc", "cancelled");
    // still running — no verdict yet.
    createTaskRun(store.db, { id: "r-run", projectId: "p", worktreePath: "/tmp/run", sessionId: "run" });
    updateTaskRunStatus(store.db, "r-run", "running");

    recordRetrievals(store.db, [
      { docProject: "p", docSlug: "doc", query: "q", rank: 0, surface: "search", sessionId: "lost" },
      { docProject: "p", docSlug: "doc", query: "q", rank: 0, surface: "search", sessionId: "canc" },
      { docProject: "p", docSlug: "doc", query: "q", rank: 0, surface: "search", sessionId: "run" },
    ]);

    const [row] = getRetrievalUsage(store.db, "p");
    expect(row.retrievals).toBe(3);
    expect(row.succeededRetrievals).toBe(0);
    expect(row.failedRetrievals).toBe(0); // none: no decisive verdict for any
    store.close();
  });

  test("an interactive session with no task run counts by its own terminal status", () => {
    const store = setup();
    upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
    // No task_runs rows here at all — these are plain `claude`/ad-hoc sessions,
    // the dominant caller of the MCP tools. Their outcome is the session's own
    // status: 'done' (agent finished with nothing pending) is the "it worked"
    // proxy; anything else is an in-flight non-verdict.
    createSession(store.db, { id: "done", projectId: "p", title: "t", cwd: "/tmp", status: "running" });
    updateSessionStatus(store.db, "done", "done");
    createSession(store.db, { id: "idle", projectId: "p", title: "t", cwd: "/tmp", status: "running" });
    updateSessionStatus(store.db, "idle", "idle");
    createSession(store.db, { id: "live", projectId: "p", title: "t", cwd: "/tmp", status: "running" });

    recordRetrievals(store.db, [
      { docProject: "p", docSlug: "doc", query: "q", rank: 0, surface: "search", sessionId: "done" },
      { docProject: "p", docSlug: "doc", query: "q", rank: 0, surface: "search", sessionId: "idle" },
      { docProject: "p", docSlug: "doc", query: "q", rank: 0, surface: "search", sessionId: "live" },
    ]);

    const [row] = getRetrievalUsage(store.db, "p");
    expect(row.retrievals).toBe(3);
    expect(row.succeededRetrievals).toBe(1); // only the 'done' session
    expect(row.failedRetrievals).toBe(0);
    store.close();
  });

  test("a launched run reconciled to 'lost' but whose session finished 'done' counts as succeeded", () => {
    const store = setup();
    upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
    // The mis-signal scenario: a console launch does good work grounded in the
    // doc, the pane exits without an explicit report_task, the sweep marks the
    // run 'lost' — but the session itself reached 'done'. The doc helped, so it
    // must land in succeeded, never failed.
    createSession(store.db, { id: "s", projectId: "p", title: "t", cwd: "/tmp", status: "running" });
    updateSessionStatus(store.db, "s", "done");
    createTaskRun(store.db, { id: "r", projectId: "p", worktreePath: "/tmp/s", sessionId: "s" });
    updateTaskRunStatus(store.db, "r", "lost");

    recordRetrievals(store.db, [
      { docProject: "p", docSlug: "doc", query: "q", rank: 0, surface: "search", sessionId: "s" },
    ]);

    const [row] = getRetrievalUsage(store.db, "p");
    expect(row.succeededRetrievals).toBe(1);
    expect(row.failedRetrievals).toBe(0);
    store.close();
  });

  test("an explicit task-run 'failed' outranks a session that reached 'done'", () => {
    const store = setup();
    upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
    // A launch that explicitly reported failure is authoritative even if the
    // turn-end classifier separately marked the session 'done'.
    createSession(store.db, { id: "s", projectId: "p", title: "t", cwd: "/tmp", status: "running" });
    updateSessionStatus(store.db, "s", "done");
    createTaskRun(store.db, { id: "r", projectId: "p", worktreePath: "/tmp/s", sessionId: "s" });
    updateTaskRunStatus(store.db, "r", "running");
    updateTaskRunStatus(store.db, "r", "failed");

    recordRetrievals(store.db, [
      { docProject: "p", docSlug: "doc", query: "q", rank: 0, surface: "search", sessionId: "s" },
    ]);

    const [row] = getRetrievalUsage(store.db, "p");
    expect(row.succeededRetrievals).toBe(0);
    expect(row.failedRetrievals).toBe(1);
    store.close();
  });

  test("resolves a session with multiple runs to its latest run's outcome (exactly one row per session)", () => {
    const store = setup();
    upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
    // An earlier failed run, then a later succeeded run for the SAME session
    // (e.g. a retried dispatch). The latest wins, and it must not double-count.
    createTaskRun(store.db, { id: "r-old", projectId: "p", worktreePath: "/tmp/s", sessionId: "s" });
    updateTaskRunStatus(store.db, "r-old", "failed");
    store.db.run("UPDATE task_runs SET created_at = datetime('now','-1 hour') WHERE id = 'r-old'");
    createTaskRun(store.db, { id: "r-new", projectId: "p", worktreePath: "/tmp/s", sessionId: "s" });
    updateTaskRunStatus(store.db, "r-new", "running");
    updateTaskRunStatus(store.db, "r-new", "succeeded");

    recordRetrievals(store.db, [
      { docProject: "p", docSlug: "doc", query: "q", rank: 0, surface: "search", sessionId: "s" },
    ]);

    const [row] = getRetrievalUsage(store.db, "p");
    expect(row.retrievals).toBe(1);
    expect(row.succeededRetrievals).toBe(1);
    expect(row.failedRetrievals).toBe(0);
    store.close();
  });
});

describe("injected-vs-dropped split (K2)", () => {
  test("persists the injected flag and launch id, and rolls up injected vs dropped", () => {
    const store = setup();
    recordRetrievals(store.db, [
      // Injected into a launch's opening prompt, correlated by launch (no session
      // exists yet at prompt-build time).
      {
        docProject: "p",
        docSlug: "doc",
        query: "q",
        rank: 0,
        score: 0.9,
        surface: "inject",
        injected: true,
        launchId: "L1",
      },
      // Retrieved for the same launch but squeezed out by the char budget.
      {
        docProject: "p",
        docSlug: "doc",
        query: "q",
        rank: 1,
        score: 0.4,
        surface: "inject",
        injected: false,
        launchId: "L1",
      },
    ]);

    const row = store.db
      .query("SELECT injected, launch_id FROM knowledge_retrievals WHERE rank = 0")
      .get() as { injected: number | null; launch_id: string | null };
    expect(row.injected).toBe(1);
    expect(row.launch_id).toBe("L1");

    const [usage] = getRetrievalUsage(store.db, "p");
    expect(usage.retrievals).toBe(2);
    expect(usage.injected).toBe(1);
    expect(usage.dropped).toBe(1);
    store.close();
  });

  test("a ranking-only search retrieval persists NULL and counts toward neither half", () => {
    const store = setup();
    recordRetrievals(store.db, [
      { docProject: "p", docSlug: "doc", query: "q", rank: 0, surface: "search" },
    ]);

    const row = store.db
      .query("SELECT injected FROM knowledge_retrievals")
      .get() as { injected: number | null };
    expect(row.injected).toBeNull();

    const [usage] = getRetrievalUsage(store.db, "p");
    expect(usage.injected).toBe(0);
    expect(usage.dropped).toBe(0);
    store.close();
  });
});

describe("knowledge_retrievals observability", () => {
  test("persists components, algorithm version and placement columns", () => {
    const store = setup();
    recordRetrievals(store.db, [
      {
        docProject: "p",
        docSlug: "doc",
        query: "q",
        rank: 0,
        score: 0.03,
        surface: "search",
        components: { score: 0.03, rawScore: 0.6, signals: { text: 0.4 } },
        algoVersion: "2026-10-05.1",
        rawScore: 0.6,
        relevance: 0.6,
        layer: "docs",
        sourceKind: "code",
        scope: "project",
      },
    ]);
    const row = store.db
      .query(
        "SELECT components_json, algo_version, raw_score, relevance, layer, source_kind, scope, doc_owner, drop_reason FROM knowledge_retrievals"
      )
      .get() as Record<string, unknown>;
    expect(JSON.parse(row.components_json as string)).toEqual({ score: 0.03, rawScore: 0.6, signals: { text: 0.4 } });
    expect(row).toMatchObject({
      algo_version: "2026-10-05.1",
      raw_score: 0.6,
      relevance: 0.6,
      layer: "docs",
      source_kind: "code",
      scope: "project",
      doc_owner: null,
      drop_reason: null,
    });
    store.close();
  });

  test("gated candidates and doc fetches are counted apart from returned retrievals", () => {
    const store = setup();
    recordRetrievals(store.db, [
      { docProject: "p", docSlug: "doc", query: "q", rank: 0, surface: "inject", injected: true },
      { docProject: "p", docSlug: "doc", query: "q2", rank: 0, surface: "search", dropReason: "floor" },
      { docProject: "p", docSlug: "doc", query: "q3", rank: 0, surface: "inject", injected: false, dropReason: BUDGET_DROP_REASON },
      { docProject: "p", docSlug: "doc", query: "doc", rank: 0, surface: "doc_get" },
    ]);
    const [usage] = getRetrievalUsage(store.db, "p");
    // The injection and the budget-dropped injection were returned; the floor
    // drop was not; the fetch is its own count.
    expect(usage.retrievals).toBe(2);
    expect(usage.injected).toBe(1);
    expect(usage.dropped).toBe(1);
    expect(usage.gated).toBe(1);
    expect(usage.docGets).toBe(1);
    // The fetch carries no session, so nothing ties it to a surfacing.
    expect(usage.cited).toBe(0);
    expect(usage.lastUsedAt).toBeTruthy();
    store.close();
  });

  test("cited counts a fetch of a doc the same session was handed by a search or injection first", () => {
    const store = setup();
    upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
    for (const id of ["s1", "s2", "s-L1"]) createSession(store.db, { id, projectId: "p", title: "t", cwd: `/tmp/${id}`, status: "running" });
    store.db.run("INSERT INTO launches (id, project_id, task, worktree_path, branch) VALUES ('L1', 'p', 't', '/tmp/wt-L1', 'b')");
    /** Records `rows` stamped `stamp`. */
    const at = (stamp: string, rows: Parameters<typeof recordRetrievals>[1]) => {
      const { last } = store.db.query("SELECT COALESCE(MAX(id), 0) AS last FROM knowledge_retrievals").get() as { last: number };
      recordRetrievals(store.db, rows);
      store.db.run("UPDATE knowledge_retrievals SET created_at = ? WHERE id > ?", [stamp, last]);
    };
    const docGet = (docSlug: string, sessionId?: string) => ({ docProject: "p", docSlug, query: docSlug, rank: 0, surface: "doc_get" as const, ...(sessionId ? { sessionId } : {}) });
    // Ordered stamps, oldest first, so "at or before the fetch" is exact.
    at("2026-01-01 00:00:01", [
      { docProject: "p", docSlug: "searched", query: "q", rank: 0, surface: "search", sessionId: "s1" },
      { docProject: "p", docSlug: "injected", query: "t", rank: 0, surface: "inject", injected: true, launchId: "L1" },
      { docProject: "p", docSlug: "budget-dropped", query: "t", rank: 1, surface: "inject", injected: false, dropReason: BUDGET_DROP_REASON, launchId: "L1" },
      { docProject: "p", docSlug: "gated", query: "q", rank: 1, surface: "search", sessionId: "s1", dropReason: "floor" },
      { docProject: "p", docSlug: "other-session", query: "q", rank: 2, surface: "search", sessionId: "s2" },
    ]);
    attachSessionToLaunch(store.db, "L1", "s-L1");
    at("2026-01-01 00:00:02", [
      docGet("searched", "s1"),
      docGet("searched", "s1"),
      docGet("injected", "s-L1"),
      docGet("budget-dropped", "s-L1"),
      docGet("gated", "s1"),
      docGet("other-session", "s1"),
      docGet("unsurfaced", "s1"),
      docGet("searched"),
    ]);
    // A search after the fetch does not make the earlier fetch a citation.
    at("2026-01-01 00:00:02", [docGet("late", "s1")]);
    at("2026-01-01 00:00:03", [{ docProject: "p", docSlug: "late", query: "q", rank: 0, surface: "search", sessionId: "s1" }]);

    const cited = new Map(getRetrievalUsage(store.db, "p").map((u) => [u.docSlug, u.cited]));
    expect(Object.fromEntries(cited)).toEqual({
      searched: 2,
      injected: 1,
      "budget-dropped": 0,
      gated: 0,
      "other-session": 0,
      unsurfaced: 0,
      late: 0,
    });
    store.close();
  });

  test("a doc only ever gated has no last use", () => {
    const store = setup();
    recordRetrievals(store.db, [
      { docProject: "p", docSlug: "gated", query: "q", rank: 0, surface: "search", dropReason: "cutoff" },
    ]);
    const [usage] = getRetrievalUsage(store.db, "p");
    expect(usage.retrievals).toBe(0);
    expect(usage.gated).toBe(1);
    expect(usage.lastUsedAt).toBeUndefined();
    store.close();
  });

  test("an inject row reaches its launched session's outcome through the launch", () => {
    for (const outcome of ["succeeded", "failed"] as const) {
      const store = setup();
      upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
      store.db.run(
        "INSERT INTO launches (id, project_id, task, worktree_path, branch) VALUES ('L1', 'p', 't', '/tmp/wt-L1', 'b')"
      );
      // Injection is recorded at prompt-build time, before the session exists.
      recordRetrievals(store.db, [
        { docProject: "p", docSlug: "doc", query: "t", rank: 0, surface: "inject", injected: true, launchId: "L1" },
      ]);
      expect(getRetrievalUsage(store.db, "p")[0].succeededRetrievals).toBe(0);

      createSession(store.db, { id: "s-L1", projectId: "p", title: "t", cwd: "/tmp/wt-L1", status: "running" });
      attachSessionToLaunch(store.db, "L1", "s-L1");
      runWithOutcome(store.db, "s-L1", outcome);

      const [usage] = getRetrievalUsage(store.db, "p");
      expect(usage.succeededRetrievals).toBe(outcome === "succeeded" ? 1 : 0);
      expect(usage.failedRetrievals).toBe(outcome === "failed" ? 1 : 0);
      store.close();
    }
  });

  test("a doc retrieved but not used earns no outcome and no last use", () => {
    const store = setup();
    upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
    createSession(store.db, { id: "s-ok", projectId: "p", title: "t", cwd: "/tmp/ok", status: "running" });
    runWithOutcome(store.db, "s-ok", "succeeded");
    recordRetrievals(store.db, [
      { docProject: "p", docSlug: "budget-dropped", query: "q", rank: 1, surface: "inject", injected: false, dropReason: BUDGET_DROP_REASON, sessionId: "s-ok" },
      { docProject: "p", docSlug: "injected", query: "q", rank: 0, surface: "inject", injected: true, sessionId: "s-ok" },
      { docProject: "p", docSlug: "searched", query: "q", rank: 0, surface: "search", sessionId: "s-ok" },
    ]);
    const bySlug = new Map(getRetrievalUsage(store.db, "p").map((u) => [u.docSlug, u]));
    for (const unused of ["budget-dropped"]) {
      expect(bySlug.get(unused)).toMatchObject({ retrievals: 1, succeededRetrievals: 0, failedRetrievals: 0 });
      expect(bySlug.get(unused)?.lastUsedAt).toBeUndefined();
    }
    for (const used of ["injected", "searched"]) {
      expect(bySlug.get(used)).toMatchObject({ retrievals: 1, succeededRetrievals: 1 });
      expect(bySlug.get(used)?.lastUsedAt).toBeTruthy();
    }
    store.close();
  });

  test("a viewer sees only their own personal-layer rows", () => {
    const store = setup();
    recordRetrievals(store.db, [
      { docProject: "p", docSlug: "alice-notes", query: "q", rank: 0, surface: "search", layer: "personal", docOwner: "alice" },
      { docProject: "p", docSlug: "team-doc", query: "q", rank: 1, surface: "search", layer: "docs" },
      { docProject: "p", docSlug: "legacy", query: "q", rank: 2, surface: "search" },
    ]);
    const slugs = (viewer: string | null) =>
      getRetrievalUsage(store.db, "p", { viewer }).map((u) => u.docSlug).sort();
    expect(slugs("alice")).toEqual(["alice-notes", "legacy", "team-doc"]);
    expect(slugs("bob")).toEqual(["legacy", "team-doc"]);
    expect(slugs(null)).toEqual(["legacy", "team-doc"]);
    // In-process reads with no viewer option see every row.
    expect(getRetrievalUsage(store.db, "p").map((u) => u.docSlug).sort()).toEqual(["alice-notes", "legacy", "team-doc"]);

    const breakdown = getRetrievalBreakdown(store.db, "p", { viewer: "bob" });
    expect(breakdown.byLayer.map((r) => r.layer).sort()).toEqual(["docs", "unknown"]);
    store.close();
  });

  test("breaks rows down by layer and by drop reason, per surface", () => {
    const store = setup();
    recordRetrievals(store.db, [
      { docProject: "p", docSlug: "a", query: "q", rank: 0, surface: "inject", layer: "docs", injected: true },
      { docProject: "p", docSlug: "b", query: "q", rank: 1, surface: "inject", layer: "docs", dropReason: "verdict" },
      { docProject: "p", docSlug: "c", query: "q", rank: 0, surface: "search", layer: "intent" },
    ]);
    const { byLayer, byDropReason } = getRetrievalBreakdown(store.db, "p");
    expect(byLayer).toEqual([
      { layer: "docs", surface: "inject", rows: 2, docs: 2, returned: 1, gated: 1, injected: 1 },
      { layer: "intent", surface: "search", rows: 1, docs: 1, returned: 1, gated: 0, injected: 0 },
    ]);
    expect(byDropReason).toEqual([
      { reason: "returned", surface: "inject", rows: 1, docs: 1 },
      { reason: "returned", surface: "search", rows: 1, docs: 1 },
      { reason: "verdict", surface: "inject", rows: 1, docs: 1 },
    ]);
    store.close();
  });
});

describe("getLaunchInjectedDocs", () => {
  test("returns a launch's injected docs deduped, best rank first, capped at the limit", () => {
    const store = setup();
    recordRetrievals(store.db, [
      { docProject: "p", docSlug: "second", query: "q1", rank: 1, surface: "inject", injected: true, launchId: "L1" },
      { docProject: "p", docSlug: "first", query: "q1", rank: 2, surface: "inject", injected: true, launchId: "L1" },
      // The same doc under a second query keeps its best rank and appears once.
      { docProject: "p", docSlug: "first", query: "q2", rank: 0, surface: "inject", injected: true, launchId: "L1" },
      { docProject: "q", docSlug: "third", query: "q2", rank: 3, surface: "inject", injected: true, launchId: "L1" },
      // Excluded: dropped by the budget, another surface, another launch.
      { docProject: "p", docSlug: "dropped", query: "q1", rank: 0, surface: "inject", injected: false, launchId: "L1", dropReason: BUDGET_DROP_REASON },
      { docProject: "p", docSlug: "searched", query: "q1", rank: 0, surface: "search", launchId: "L1" },
      { docProject: "p", docSlug: "other", query: "q1", rank: 0, surface: "inject", injected: true, launchId: "L2" },
    ]);

    expect(getLaunchInjectedDocs(store.db, "L1")).toEqual([
      { docProject: "p", docSlug: "first" },
      { docProject: "p", docSlug: "second" },
      { docProject: "q", docSlug: "third" },
    ]);
    expect(getLaunchInjectedDocs(store.db, "L1", 2).map((d) => d.docSlug)).toEqual(["first", "second"]);
    expect(getLaunchInjectedDocs(store.db, "missing")).toEqual([]);
    store.close();
  });

  test("carries titles from the knowledge index when it exists", () => {
    const store = setup();
    store.db.exec("CREATE TABLE knowledge (id TEXT PRIMARY KEY, project_id TEXT, slug TEXT, title TEXT)");
    store.db.exec("INSERT INTO knowledge (id, project_id, slug, title) VALUES ('p/a', 'p', 'a', 'Doc A')");
    recordRetrievals(store.db, [
      { docProject: "p", docSlug: "a", query: "q", rank: 0, surface: "inject", injected: true, launchId: "L1" },
      { docProject: "p", docSlug: "b", query: "q", rank: 1, surface: "inject", injected: true, launchId: "L1" },
    ]);

    expect(getLaunchInjectedDocs(store.db, "L1")).toEqual([
      { docProject: "p", docSlug: "a", title: "Doc A" },
      { docProject: "p", docSlug: "b" },
    ]);
    store.close();
  });
});

describe("getSessionInjectedDocs", () => {
  test("returns one project's docs injected into the launch the session attached to", () => {
    const store = setup();
    upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
    createLaunch(store.db, { id: "L1", projectId: "p", task: "t", worktreePath: "/wt/L1", branch: "b1" });
    createLaunch(store.db, { id: "L2", projectId: "p", task: "t", worktreePath: "/wt/L2", branch: "b2" });
    attachSessionToLaunch(store.db, "L1", "s1");
    attachSessionToLaunch(store.db, "L2", "s2");
    recordRetrievals(store.db, [
      // Other-project rows outrank the own-project ones; the limit must not cut them off.
      { docProject: "global", docSlug: "g0", query: "q", rank: 0, surface: "inject", injected: true, launchId: "L1" },
      { docProject: "global", docSlug: "g1", query: "q", rank: 1, surface: "inject", injected: true, launchId: "L1" },
      { docProject: "p", docSlug: "first", query: "q", rank: 2, surface: "inject", injected: true, launchId: "L1" },
      { docProject: "p", docSlug: "second", query: "q", rank: 3, surface: "inject", injected: true, launchId: "L1" },
      // Excluded: budget-dropped, another surface, another session's launch.
      { docProject: "p", docSlug: "dropped", query: "q", rank: 0, surface: "inject", injected: false, launchId: "L1", dropReason: BUDGET_DROP_REASON },
      { docProject: "p", docSlug: "searched", query: "q", rank: 0, surface: "search", sessionId: "s1" },
      { docProject: "p", docSlug: "other", query: "q", rank: 0, surface: "inject", injected: true, launchId: "L2" },
    ]);

    expect(getSessionInjectedDocs(store.db, "s1", "p", 2).map((d) => d.docSlug)).toEqual(["first", "second"]);
    expect(getSessionInjectedDocs(store.db, "missing", "p")).toEqual([]);
    store.close();
  });
});

describe("knowledge_retrievals.latency_ms", () => {
  const latencyOf = (db: import("bun:sqlite").Database) =>
    (db.query("SELECT latency_ms AS l FROM knowledge_retrievals ORDER BY id").all() as Array<{ l: number | null }>).map(
      (r) => r.l
    );

  test.each([
    ["a whole number", 42, 42],
    ["a fraction, rounded", 12.6, 13],
    ["absent", undefined, null],
    ["not finite", Number.NaN, null],
  ])("records %s", (_name, latencyMs, stored) => {
    const store = setup();
    recordRetrievals(store.db, [
      { docProject: "p", docSlug: "a", query: "q", rank: 0, surface: "search", latencyMs: latencyMs as number | undefined },
    ]);
    expect(latencyOf(store.db)).toEqual([stored as number | null]);
    store.close();
  });

  test("a table without the column gets it from the schema repair, idempotently, keeping its rows", () => {
    const store = setup();
    recordRetrievals(store.db, [{ docProject: "p", docSlug: "a", query: "q", rank: 0, surface: "search" }]);
    store.db.exec("ALTER TABLE knowledge_retrievals DROP COLUMN latency_ms");
    ensureKnowledgeRetrievalLatencyColumn(store.db);
    ensureKnowledgeRetrievalLatencyColumn(store.db);
    expect(latencyOf(store.db)).toEqual([null]);
    recordRetrievals(store.db, [{ docProject: "p", docSlug: "b", query: "q", rank: 0, surface: "search", latencyMs: 7 }]);
    expect(latencyOf(store.db)).toEqual([null, 7]);
    store.close();
  });
});

describe("hook push telemetry", () => {
  function seeded() {
    const store = setup();
    upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
    for (const id of ["s1", "s2", "s-L1"]) createSession(store.db, { id, projectId: "p", title: "t", cwd: `/tmp/${id}`, status: "running" });
    store.db.run("INSERT INTO launches (id, project_id, task, worktree_path, branch) VALUES ('L1', 'p', 't', '/tmp/wt-L1', 'b')");
    return store;
  }
  const at = (db: import("bun:sqlite").Database, stamp: string, rows: Parameters<typeof recordRetrievals>[1]) => {
    const { last } = db.query("SELECT COALESCE(MAX(id), 0) AS last FROM knowledge_retrievals").get() as { last: number };
    recordRetrievals(db, rows);
    db.run("UPDATE knowledge_retrievals SET created_at = ? WHERE id > ?", [stamp, last]);
  };

  test("getSessionSeenDocs: pushes, returned searches, fetches and the launch's injection; not gated, dropped or other sessions", () => {
    const store = seeded();
    recordRetrievals(store.db, [
      { docProject: "p", docSlug: "pushed", query: "q", rank: 0, surface: "push:UserPromptSubmit", sessionId: "s1", injected: true },
      { docProject: "p", docSlug: "searched", query: "q", rank: 0, surface: "search", sessionId: "s1" },
      { docProject: "p", docSlug: "fetched", query: "q", rank: 0, surface: "doc_get", sessionId: "s1" },
      { docProject: "p", docSlug: "gated", query: "q", rank: 1, surface: "search", sessionId: "s1", dropReason: "floor" },
      { docProject: "p", docSlug: "other", query: "q", rank: 0, surface: "search", sessionId: "s2" },
      { docProject: "p", docSlug: "injected", query: "t", rank: 0, surface: "inject", injected: true, launchId: "L1" },
      { docProject: "p", docSlug: "launch-pushed", query: "t", rank: 0, surface: "push:launch", injected: true, launchId: "L1" },
      { docProject: "p", docSlug: "budget", query: "t", rank: 1, surface: "inject", injected: false, dropReason: BUDGET_DROP_REASON, launchId: "L1" },
    ]);
    expect([...getSessionSeenDocs(store.db, "s1")].sort()).toEqual(["p/fetched", "p/pushed", "p/searched"]);
    expect([...getSessionSeenDocs(store.db, "s1", "L1")].sort()).toEqual([
      "p/fetched",
      "p/injected",
      "p/launch-pushed",
      "p/pushed",
      "p/searched",
    ]);
    expect([...getSessionSeenDocs(store.db, "nobody")]).toEqual([]);
    store.close();
  });

  test("getPushUptake: pushed and opened-after-push since the cutoff, by event", () => {
    const store = seeded();
    at(store.db, "2026-01-01 00:00:00", [
      { docProject: "p", docSlug: "old", query: "q", rank: 0, surface: "push:SessionStart", sessionId: "s1", injected: true },
    ]);
    at(store.db, "2026-02-01 00:00:01", [
      { docProject: "p", docSlug: "a", query: "q", rank: 0, surface: "push:SessionStart", sessionId: "s1", injected: true },
      { docProject: "p", docSlug: "b", query: "q", rank: 1, surface: "push:SessionStart", sessionId: "s1", injected: true },
      { docProject: "p", docSlug: "c", query: "q", rank: 0, surface: "push:UserPromptSubmit", sessionId: "s1", injected: true },
      { docProject: "p", docSlug: "d", query: "q", rank: 0, surface: "push:PreToolUse", sessionId: "s2", injected: true },
      { docProject: "p", docSlug: "e", query: "t", rank: 0, surface: "push:launch", injected: true, launchId: "L1" },
    ]);
    attachSessionToLaunch(store.db, "L1", "s-L1");
    at(store.db, "2026-02-01 00:00:00", [{ docProject: "p", docSlug: "c", query: "c", rank: 0, surface: "doc_get", sessionId: "s1" }]);
    at(store.db, "2026-02-01 00:00:05", [
      { docProject: "p", docSlug: "a", query: "a", rank: 0, surface: "doc_get", sessionId: "s1" },
      { docProject: "p", docSlug: "d", query: "d", rank: 0, surface: "doc_get", sessionId: "s1" },
      { docProject: "p", docSlug: "e", query: "e", rank: 0, surface: "doc_get", sessionId: "s-L1" },
    ]);
    const uptake = getPushUptake(store.db, Date.parse("2026-01-15T00:00:00Z"));
    // a opened after its push; b never; c fetched before it was pushed; d by another session; e via the launch's session.
    expect(uptake).toEqual({
      pushed: 5,
      opened: 2,
      byEvent: {
        PreToolUse: { pushed: 1, opened: 0 },
        SessionStart: { pushed: 2, opened: 1 },
        UserPromptSubmit: { pushed: 1, opened: 0 },
        launch: { pushed: 1, opened: 1 },
      },
    });
    expect(getPushUptake(store.db, Date.parse("2025-12-01T00:00:00Z")).pushed).toBe(6);
    expect(getPushUptake(store.db, Date.parse("2026-03-01T00:00:00Z"))).toEqual({ pushed: 0, opened: 0, byEvent: {} });
    store.close();
  });
});
