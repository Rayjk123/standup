import { expect, test, describe } from "bun:test";
import { createStore } from "../store.js";
import type { Store } from "../store.js";
import { runMigrations } from "../migrations.js";
import {
  upsertProject,
  ownerKeyFor,
  getProfile,
  listProfiles,
  upsertProfile,
  deleteProfile,
  getProjectDefaultProfile,
  getPersonalDefaultProfile,
  getGlobalDefaultProfile,
  setProjectDefaultProfile,
  setPersonalDefaultProfile,
  setGlobalDefaultProfile,
  resolveActiveProfileName,
  resolveActiveProfile,
  createOrchestrationRun,
  getOrchestrationRun,
  updateOrchestrationRunStatus,
  bumpOrchestrationRound,
  heartbeatOrchestrationRun,
  reconcileLostOrchestrationRuns,
  getActiveOrchestrationRunByTicket,
  getActiveOrchestrationRunBySession,
  getLatestOrchestrationRunByTicket,
  supersedeOrchestrationRunsForTicket,
  recordGateResult,
  getGateResults,
  validateOrchestrationProfileDefinition,
  OrchestrationRunTransitionError,
  GLOBAL_ORCH_OWNER_KEY,
} from "../index.js";
import type { OrchestrationProfile, OrchestrationScope, OrchestrationStep } from "@standup/shared";
import { MAX_REVIEW_ROUNDS } from "@standup/shared";

function setUp(): Store {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
  return store;
}

function sampleProfile(name: string, scope: OrchestrationScope): OrchestrationProfile {
  return {
    name,
    scope,
    steps: [
      { kind: "gate", name: "build", command: "bun run build" },
      { kind: "review", rounds: 2, blockOnSeverity: "high" },
    ],
    maxReviewRounds: 3,
    blockOnSeverity: "high",
  };
}

describe("migration idempotency", () => {
  test("running migrations again on an already-migrated db does not error", () => {
    const store = createStore(":memory:"); // createStore runs them once
    expect(() => runMigrations(store.db)).not.toThrow();
    expect(() => runMigrations(store.db)).not.toThrow();
    // The orchestration tables exist and are usable after the re-run.
    expect(listProfiles(store.db)).toEqual([]);
  });

  test("both per-scope default columns exist on a fresh migration", () => {
    const store = createStore(":memory:");
    const cols = (table: string) =>
      (store.db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (c) => c.name
      );
    expect(cols("projects")).toContain("orchestration_profile");
    expect(cols("user_prefs")).toContain("orchestration_profile");
  });

  test("re-running a partially-applied migration 047 does not throw duplicate-column", () => {
    const store = createStore(":memory:");
    // Simulate a 047 that added its columns but rolled back its version stamp
    // (an aborted upgrade): the version row is gone, so the migration body
    // re-runs against a schema that already has the columns. Because the columns
    // come from the guarded repair — never a bare ALTER in the body — the re-run
    // is a clean no-op instead of a "duplicate column" brick.
    store.db.run("DELETE FROM schema_version WHERE version = 47");
    expect(() => runMigrations(store.db)).not.toThrow();
    const cols = (store.db.query("PRAGMA table_info(projects)").all() as Array<{ name: string }>).map(
      (c) => c.name
    );
    expect(cols).toContain("orchestration_profile");
  });
});

describe("profile CRUD", () => {
  test("upsert / get / list / delete round-trip", () => {
    const store = setUp();
    const ownerKey = ownerKeyFor("project", { projectId: "p" });
    expect(getProfile(store.db, "project", ownerKey, "ship")).toBeNull();

    const saved = upsertProfile(store.db, "project", ownerKey, sampleProfile("ship", "project"));
    expect(saved.name).toBe("ship");
    expect(saved.scope).toBe("project");
    expect(saved.steps).toHaveLength(2);
    expect(saved.steps[0]).toEqual({ kind: "gate", name: "build", command: "bun run build" });
    expect(saved.maxReviewRounds).toBe(3);
    expect(saved.blockOnSeverity).toBe("high");

    // get round-trips the stored definition exactly.
    expect(getProfile(store.db, "project", ownerKey, "ship")).toEqual(saved);

    // Re-upsert is a full replace keyed on (scope, owner, name) — one row, new steps.
    upsertProfile(store.db, "project", ownerKey, {
      name: "ship",
      scope: "project",
      steps: [{ kind: "human_pause", prompt: "ok to ship?" }],
    });
    const list = listProfiles(store.db, { scope: "project", ownerKey });
    expect(list).toHaveLength(1);
    expect(list[0]!.steps).toEqual([{ kind: "human_pause", prompt: "ok to ship?" }]);
    expect(list[0]!.maxReviewRounds).toBeUndefined();

    deleteProfile(store.db, "project", ownerKey, "ship");
    expect(getProfile(store.db, "project", ownerKey, "ship")).toBeNull();
    expect(listProfiles(store.db, { scope: "project", ownerKey })).toHaveLength(0);
  });

  test("list narrows by scope + owner", () => {
    const store = setUp();
    upsertProfile(store.db, "global", GLOBAL_ORCH_OWNER_KEY, sampleProfile("g", "global"));
    upsertProfile(store.db, "personal", "alice", sampleProfile("a", "personal"));
    upsertProfile(store.db, "personal", "bob", sampleProfile("b", "personal"));

    expect(listProfiles(store.db, { scope: "personal", ownerKey: "alice" }).map((p) => p.name)).toEqual(["a"]);
    expect(listProfiles(store.db, { scope: "global", ownerKey: GLOBAL_ORCH_OWNER_KEY }).map((p) => p.name)).toEqual(["g"]);
    expect(listProfiles(store.db)).toHaveLength(3);
  });

  test("ownerKeyFor derives the key per scope and rejects a missing identifier", () => {
    expect(ownerKeyFor("global", {})).toBe(GLOBAL_ORCH_OWNER_KEY);
    expect(ownerKeyFor("personal", { alias: "alice" })).toBe("alice");
    expect(ownerKeyFor("project", { projectId: "p" })).toBe("p");
    expect(() => ownerKeyFor("personal", {})).toThrow();
    expect(() => ownerKeyFor("project", {})).toThrow();
  });

  test("deleting a profile clears a same-scope default that pointed at it", () => {
    const store = setUp();
    // Project scope.
    upsertProfile(store.db, "project", "p", sampleProfile("ship", "project"));
    setProjectDefaultProfile(store.db, "p", "ship");
    deleteProfile(store.db, "project", "p", "ship");
    expect(getProjectDefaultProfile(store.db, "p")).toBeNull();
    expect(resolveActiveProfile(store.db, { projectId: "p" })).toBeNull();

    // Personal scope.
    upsertProfile(store.db, "personal", "alice", sampleProfile("mine", "personal"));
    setPersonalDefaultProfile(store.db, "alice", "mine");
    deleteProfile(store.db, "personal", "alice", "mine");
    expect(getPersonalDefaultProfile(store.db, "alice")).toBeNull();

    // Global scope.
    upsertProfile(store.db, "global", GLOBAL_ORCH_OWNER_KEY, sampleProfile("g", "global"));
    setGlobalDefaultProfile(store.db, "g");
    deleteProfile(store.db, "global", GLOBAL_ORCH_OWNER_KEY, "g");
    expect(getGlobalDefaultProfile(store.db)).toBeNull();
  });

  test("deleting a profile leaves a default that pointed at a different name", () => {
    const store = setUp();
    upsertProfile(store.db, "project", "p", sampleProfile("keep", "project"));
    upsertProfile(store.db, "project", "p", sampleProfile("drop", "project"));
    setProjectDefaultProfile(store.db, "p", "keep");
    deleteProfile(store.db, "project", "p", "drop");
    expect(getProjectDefaultProfile(store.db, "p")).toBe("keep");
  });
});

describe("default resolution precedence", () => {
  test("override > project > personal > global > null", () => {
    const store = setUp();
    // Each scope's default names a profile that actually exists there — a name
    // resolves only when it loads, since resolveActiveProfileName delegates to
    // resolveActiveProfile (a dangling name falls through rather than resolving).
    upsertProfile(store.db, "global", GLOBAL_ORCH_OWNER_KEY, sampleProfile("G", "global"));
    upsertProfile(store.db, "personal", "alice", sampleProfile("P", "personal"));
    upsertProfile(store.db, "project", "p", sampleProfile("PR", "project"));
    upsertProfile(store.db, "project", "p", sampleProfile("O", "project"));

    // Nothing set anywhere.
    expect(resolveActiveProfileName(store.db, { projectId: "p", alias: "alice" })).toBeNull();

    // Global only.
    setGlobalDefaultProfile(store.db, "G");
    expect(getGlobalDefaultProfile(store.db)).toBe("G");
    expect(resolveActiveProfileName(store.db, { projectId: "p", alias: "alice" })).toBe("G");

    // Personal beats global.
    setPersonalDefaultProfile(store.db, "alice", "P");
    expect(getPersonalDefaultProfile(store.db, "alice")).toBe("P");
    expect(resolveActiveProfileName(store.db, { projectId: "p", alias: "alice" })).toBe("P");

    // Project beats personal.
    setProjectDefaultProfile(store.db, "p", "PR");
    expect(getProjectDefaultProfile(store.db, "p")).toBe("PR");
    expect(resolveActiveProfileName(store.db, { projectId: "p", alias: "alice" })).toBe("PR");

    // Override beats every layer.
    expect(
      resolveActiveProfileName(store.db, { projectId: "p", alias: "alice", launchOverride: "O" })
    ).toBe("O");

    // Clearing the project default falls back to personal.
    setProjectDefaultProfile(store.db, "p", null);
    expect(getProjectDefaultProfile(store.db, "p")).toBeNull();
    expect(resolveActiveProfileName(store.db, { projectId: "p", alias: "alice" })).toBe("P");

    // Clearing global reads as unset (blank string normalizes to null).
    setGlobalDefaultProfile(store.db, null);
    expect(getGlobalDefaultProfile(store.db)).toBeNull();
  });

  test("resolveActiveProfile loads the row from the resolving layer", () => {
    const store = setUp();
    upsertProfile(store.db, "project", "p", sampleProfile("ship", "project"));
    setProjectDefaultProfile(store.db, "p", "ship");

    const prof = resolveActiveProfile(store.db, { projectId: "p", alias: "alice" });
    expect(prof?.name).toBe("ship");
    expect(prof?.scope).toBe("project");

    // An override names a personal profile — loaded from the personal layer.
    upsertProfile(store.db, "personal", "alice", sampleProfile("mine", "personal"));
    const overridden = resolveActiveProfile(store.db, {
      projectId: "p",
      alias: "alice",
      launchOverride: "mine",
    });
    expect(overridden?.name).toBe("mine");
    expect(overridden?.scope).toBe("personal");

    // Nothing resolves to a stored profile -> null.
    expect(resolveActiveProfile(store.db, { alias: "nobody" })).toBeNull();
  });

  test("a dangling default falls through; name and loaded row never disagree", () => {
    const store = setUp();
    // The project default names a profile that was never stored (dangling); the
    // personal layer holds a real one. Both resolvers must skip the ghost and
    // land on the personal profile — the name resolver agrees with the row
    // resolver because it is defined in terms of it.
    setProjectDefaultProfile(store.db, "p", "ghost");
    upsertProfile(store.db, "personal", "alice", sampleProfile("mine", "personal"));
    setPersonalDefaultProfile(store.db, "alice", "mine");
    expect(resolveActiveProfile(store.db, { projectId: "p", alias: "alice" })?.name).toBe("mine");
    expect(resolveActiveProfileName(store.db, { projectId: "p", alias: "alice" })).toBe("mine");

    // Every layer dangles -> both resolve to null, never to a ghost name.
    setPersonalDefaultProfile(store.db, "alice", "alsoGhost");
    setGlobalDefaultProfile(store.db, "stillGhost");
    expect(resolveActiveProfile(store.db, { projectId: "p", alias: "alice" })).toBeNull();
    expect(resolveActiveProfileName(store.db, { projectId: "p", alias: "alice" })).toBeNull();
  });
});

describe("orchestration run ledger", () => {
  function newRun(
    store: Store,
    id: string,
    extra: { ticketId?: string; sessionId?: string; maxRounds?: number } = {}
  ) {
    return createOrchestrationRun(store.db, {
      id,
      profileName: "ship",
      scope: "project",
      ownerKey: "p",
      projectId: "p",
      ...extra,
    });
  }

  test("queued -> running -> succeeded stamps ended_at + summary", () => {
    const store = setUp();
    const run = newRun(store, "R1");
    expect(run.status).toBe("queued");
    expect(run.round).toBe(0);
    expect(run.maxRounds).toBe(3);
    expect(run.endedAt).toBeUndefined();

    const running = updateOrchestrationRunStatus(store.db, "R1", "running");
    expect(running.status).toBe("running");
    expect(running.endedAt).toBeUndefined();

    const done = updateOrchestrationRunStatus(store.db, "R1", "succeeded", { summary: "clean" });
    expect(done.status).toBe("succeeded");
    expect(done.endedAt).toBeDefined();
    expect(done.summary).toBe("clean");
  });

  test("bumpOrchestrationRound advances round while staying running", () => {
    const store = setUp();
    newRun(store, "R1", { maxRounds: 4 });
    updateOrchestrationRunStatus(store.db, "R1", "running");
    expect(bumpOrchestrationRound(store.db, "R1")!.round).toBe(1);
    const r2 = bumpOrchestrationRound(store.db, "R1")!;
    expect(r2.round).toBe(2);
    expect(r2.status).toBe("running");

    // A terminal run cannot be bumped.
    updateOrchestrationRunStatus(store.db, "R1", "succeeded");
    expect(() => bumpOrchestrationRound(store.db, "R1")).toThrow();
  });

  test("bumpOrchestrationRound returns null at the round cap and does not advance", () => {
    const store = setUp();
    newRun(store, "R1", { maxRounds: 2 });
    updateOrchestrationRunStatus(store.db, "R1", "running"); // round 0
    expect(bumpOrchestrationRound(store.db, "R1")!.round).toBe(1);
    expect(bumpOrchestrationRound(store.db, "R1")!.round).toBe(2); // at the cap
    // A further bump (round 3) would exceed max_rounds (2): no update, null.
    expect(bumpOrchestrationRound(store.db, "R1")).toBeNull();
    expect(getOrchestrationRun(store.db, "R1")?.round).toBe(2);
    expect(getOrchestrationRun(store.db, "R1")?.status).toBe("running");
  });

  test("an illegal edge throws and does not mutate the row", () => {
    const store = setUp();
    newRun(store, "R1");
    // queued cannot jump straight to succeeded.
    expect(() => updateOrchestrationRunStatus(store.db, "R1", "succeeded")).toThrow(
      OrchestrationRunTransitionError
    );
    expect(getOrchestrationRun(store.db, "R1")?.status).toBe("queued");

    // A terminal state has no outbound edges.
    updateOrchestrationRunStatus(store.db, "R1", "cancelled");
    expect(() => updateOrchestrationRunStatus(store.db, "R1", "running")).toThrow(
      OrchestrationRunTransitionError
    );
    expect(getOrchestrationRun(store.db, "R1")?.status).toBe("cancelled");
  });

  test("heartbeat bumps last_event_at without changing status", () => {
    const store = setUp();
    newRun(store, "R1");
    updateOrchestrationRunStatus(store.db, "R1", "running");
    const beat = heartbeatOrchestrationRun(store.db, "R1");
    expect(beat.status).toBe("running");
    expect(beat.lastEventAt).toBeTruthy();
  });

  test("active-run lookups by ticket and session, freed by a terminal state", () => {
    const store = setUp();
    newRun(store, "R1", { ticketId: "TK1", sessionId: "S1" });
    expect(getActiveOrchestrationRunByTicket(store.db, "TK1")?.id).toBe("R1");
    expect(getActiveOrchestrationRunBySession(store.db, "S1")?.id).toBe("R1");

    updateOrchestrationRunStatus(store.db, "R1", "running");
    updateOrchestrationRunStatus(store.db, "R1", "succeeded");
    expect(getActiveOrchestrationRunByTicket(store.db, "TK1")).toBeNull();
    expect(getActiveOrchestrationRunBySession(store.db, "S1")).toBeNull();
  });

  test("reconcile marks a silent dead run lost, leaves a live one", () => {
    const store = setUp();
    newRun(store, "dead");
    newRun(store, "alive");
    updateOrchestrationRunStatus(store.db, "dead", "running");
    updateOrchestrationRunStatus(store.db, "alive", "running");
    // Age both past the grace window.
    store.db.run(
      "UPDATE orchestration_runs SET last_event_at = datetime('now','-10 minutes') WHERE id IN ('dead','alive')"
    );

    const lost = reconcileLostOrchestrationRuns(store.db, { isAlive: (r) => r.id === "alive" });
    expect(lost.map((r) => r.id)).toEqual(["dead"]);
    expect(getOrchestrationRun(store.db, "dead")?.status).toBe("lost");
    expect(getOrchestrationRun(store.db, "dead")?.error).toBeTruthy();
    expect(getOrchestrationRun(store.db, "alive")?.status).toBe("running");
  });

  test("reconcile respects the grace window", () => {
    const store = setUp();
    newRun(store, "recent");
    updateOrchestrationRunStatus(store.db, "recent", "running"); // last_event_at = now
    const lost = reconcileLostOrchestrationRuns(store.db, {
      isAlive: () => false,
      graceMs: 2 * 60 * 1000,
    });
    expect(lost).toHaveLength(0);
    expect(getOrchestrationRun(store.db, "recent")?.status).toBe("running");
  });

  test("reconcile reaps a stranded queued run as well as a stranded running one", () => {
    const store = setUp();
    newRun(store, "stuckQueued"); // never flipped to running (controller died early)
    newRun(store, "stuckRunning");
    updateOrchestrationRunStatus(store.db, "stuckRunning", "running");
    store.db.run(
      "UPDATE orchestration_runs SET last_event_at = datetime('now','-10 minutes') WHERE id IN ('stuckQueued','stuckRunning')"
    );

    const lost = reconcileLostOrchestrationRuns(store.db, { isAlive: () => false });
    expect(lost.map((r) => r.id).sort()).toEqual(["stuckQueued", "stuckRunning"]);
    expect(getOrchestrationRun(store.db, "stuckQueued")?.status).toBe("lost");
    expect(getOrchestrationRun(store.db, "stuckRunning")?.status).toBe("lost");
  });

  test("supersede invalidates a ticket's succeeded run and no-ops when there is none", () => {
    const store = setUp();
    // No succeeded run yet -> a clean no-op.
    expect(() => supersedeOrchestrationRunsForTicket(store.db, "TK1")).not.toThrow();

    newRun(store, "R1", { ticketId: "TK1" });
    updateOrchestrationRunStatus(store.db, "R1", "running");
    updateOrchestrationRunStatus(store.db, "R1", "succeeded");
    expect(getLatestOrchestrationRunByTicket(store.db, "TK1")?.status).toBe("succeeded");

    supersedeOrchestrationRunsForTicket(store.db, "TK1");
    const latest = getLatestOrchestrationRunByTicket(store.db, "TK1");
    expect(latest?.status).toBe("superseded");
    expect(latest?.endedAt).toBeDefined();
    expect(latest?.summary).toContain("superseded");

    // Idempotent: the run is no longer succeeded, so a second call touches nothing.
    expect(() => supersedeOrchestrationRunsForTicket(store.db, "TK1")).not.toThrow();
    expect(getLatestOrchestrationRunByTicket(store.db, "TK1")?.status).toBe("superseded");
  });

  test("rework also cancels an in-flight run, so the choke stays blocked until a fresh run succeeds", () => {
    const store = setUp();
    // A run kicked off while the ticket sat in needs_review (R1 terminal, no
    // active-run reuse) is still `running` when the rework edge fires.
    newRun(store, "R1", { ticketId: "TK1" });
    updateOrchestrationRunStatus(store.db, "R1", "running");

    supersedeOrchestrationRunsForTicket(store.db, "TK1");

    // The active run is cancelled (terminal), so the ticket has no active run and
    // its latest run is not `succeeded` — the completion choke stays blocked.
    expect(getOrchestrationRun(store.db, "R1")?.status).toBe("cancelled");
    expect(getActiveOrchestrationRunByTicket(store.db, "TK1")).toBeNull();
    expect(getLatestOrchestrationRunByTicket(store.db, "TK1")?.status).toBe("cancelled");
  });

  test("succeeded -> superseded is the only edge off a terminal; other terminals are closed", () => {
    const store = setUp();
    newRun(store, "R1", { ticketId: "TK1" });
    updateOrchestrationRunStatus(store.db, "R1", "running");
    updateOrchestrationRunStatus(store.db, "R1", "succeeded");
    expect(updateOrchestrationRunStatus(store.db, "R1", "superseded").status).toBe("superseded");
    // superseded is itself terminal — no further edges.
    expect(() => updateOrchestrationRunStatus(store.db, "R1", "running")).toThrow(
      OrchestrationRunTransitionError
    );

    // A failed run has no edge to superseded.
    newRun(store, "R2", { ticketId: "TK2" });
    updateOrchestrationRunStatus(store.db, "R2", "failed");
    expect(() => updateOrchestrationRunStatus(store.db, "R2", "superseded")).toThrow(
      OrchestrationRunTransitionError
    );
  });

  test("the active-run partial unique index rejects a second in-flight run per ticket", () => {
    const store = setUp();
    newRun(store, "R1", { ticketId: "TK1" }); // queued — in flight
    // A second active run for the same ticket violates idx_orch_runs_active_ticket.
    expect(() => newRun(store, "R2", { ticketId: "TK1" })).toThrow();

    // Terminal runs are outside the partial index, so once R1 ends a new run is fine.
    updateOrchestrationRunStatus(store.db, "R1", "running");
    updateOrchestrationRunStatus(store.db, "R1", "succeeded");
    expect(() => newRun(store, "R3", { ticketId: "TK1" })).not.toThrow();
    expect(getActiveOrchestrationRunByTicket(store.db, "TK1")?.id).toBe("R3");

    // A NULL ticket_id is not constrained (NULLs stay distinct in a unique index).
    expect(() => newRun(store, "N1")).not.toThrow();
    expect(() => newRun(store, "N2")).not.toThrow();
  });
});

describe("gate results", () => {
  test("record and read back a run's step outcomes in order", () => {
    const store = setUp();
    createOrchestrationRun(store.db, {
      id: "R1",
      profileName: "ship",
      scope: "project",
      ownerKey: "p",
      projectId: "p",
    });
    recordGateResult(store.db, {
      runId: "R1",
      round: 0,
      stepIndex: 0,
      kind: "gate",
      passed: true,
      detail: "exit 0",
    });
    const failed = recordGateResult(store.db, {
      runId: "R1",
      round: 0,
      stepIndex: 1,
      kind: "review",
      passed: false,
      detail: "1 high finding",
    });
    expect(failed.passed).toBe(false);
    expect(failed.detail).toBe("1 high finding");

    const results = getGateResults(store.db, "R1");
    expect(results).toHaveLength(2);
    expect(results[0]!.passed).toBe(true);
    expect(results[0]!.kind).toBe("gate");
    expect(results[1]!.kind).toBe("review");
    expect(results[1]!.passed).toBe(false);
  });
});

describe("profile definition validation", () => {
  test("a well-formed profile passes", () => {
    expect(validateOrchestrationProfileDefinition(sampleProfile("ship", "project")).ok).toBe(true);
  });

  test("rejects an empty, oversized, slashed, or control-char name", () => {
    const withName = (name: string): OrchestrationProfile => ({
      ...sampleProfile("x", "project"),
      name,
    });
    expect(validateOrchestrationProfileDefinition(withName("")).ok).toBe(false);
    expect(validateOrchestrationProfileDefinition(withName("x".repeat(201))).ok).toBe(false);
    expect(validateOrchestrationProfileDefinition(withName("a/b")).ok).toBe(false);
    expect(validateOrchestrationProfileDefinition(withName("a\tb")).ok).toBe(false);
  });

  test("rejects non-array steps and an unknown kind", () => {
    expect(
      validateOrchestrationProfileDefinition({
        name: "p",
        scope: "project",
        steps: "nope" as unknown as OrchestrationStep[],
      }).ok
    ).toBe(false);
    expect(
      validateOrchestrationProfileDefinition({
        name: "p",
        scope: "project",
        steps: [{ kind: "explode" } as unknown as OrchestrationStep],
      }).ok
    ).toBe(false);
  });

  test("rejects steps missing the fields their kind requires", () => {
    const bad = (step: unknown) =>
      validateOrchestrationProfileDefinition({
        name: "p",
        scope: "project",
        steps: [step as OrchestrationStep],
      }).ok;
    expect(bad({ kind: "gate", name: "", command: "x" })).toBe(false);
    expect(bad({ kind: "gate", name: "b", command: "" })).toBe(false);
    expect(bad({ kind: "deploy" })).toBe(false);
    expect(bad({ kind: "review", rounds: 0 })).toBe(false);
    expect(bad({ kind: "review", rounds: 1.5 })).toBe(false);
    expect(bad({ kind: "review", blockOnSeverity: "low" })).toBe(false);
  });

  test("accepts deploy-by-command and in-range review knobs", () => {
    const ok = (step: OrchestrationStep) =>
      validateOrchestrationProfileDefinition({ name: "p", scope: "project", steps: [step] }).ok;
    expect(ok({ kind: "deploy", command: "./ship.sh" })).toBe(true);
    expect(ok({ kind: "review", rounds: 3, blockOnSeverity: "medium" })).toBe(true);
  });

  test("rejects a human_pause step — deferred until a resume mechanism exists", () => {
    const result = validateOrchestrationProfileDefinition({
      name: "p",
      scope: "project",
      steps: [{ kind: "human_pause", prompt: "ok?" }],
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain("not yet supported");
  });

  test("a deploy step must resolve a command — a target with only an account is rejected", () => {
    const validates = (step: unknown) =>
      validateOrchestrationProfileDefinition({
        name: "p",
        scope: "project",
        steps: [step as OrchestrationStep],
      }).ok;
    // A target that pins only an account carries no runnable command -> reject,
    // so the loop never records a no-op skip that lets the run succeed un-deployed.
    expect(validates({ kind: "deploy", target: { account: "123" } })).toBe(false);
    // A command carried ON the target is deployable.
    expect(validates({ kind: "deploy", target: { command: "./ship.sh" } })).toBe(true);
  });

  test("rejects review knobs above the hard round cap", () => {
    const ok = (profile: OrchestrationProfile) =>
      validateOrchestrationProfileDefinition(profile).ok;
    expect(
      ok({ name: "p", scope: "project", maxReviewRounds: MAX_REVIEW_ROUNDS + 1, steps: [] })
    ).toBe(false);
    expect(
      ok({
        name: "p",
        scope: "project",
        steps: [{ kind: "review", rounds: MAX_REVIEW_ROUNDS + 1 }],
      })
    ).toBe(false);
    // Exactly at the cap is allowed.
    expect(
      ok({
        name: "p",
        scope: "project",
        maxReviewRounds: MAX_REVIEW_ROUNDS,
        steps: [{ kind: "review", rounds: MAX_REVIEW_ROUNDS }],
      })
    ).toBe(true);
  });
});
