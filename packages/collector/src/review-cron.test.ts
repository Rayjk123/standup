import { expect, test, describe } from "bun:test";
import {
  createStore,
  createTicket,
  getSetting,
  setSetting,
  updateTicketStatus,
  upsertProject,
  getOpenTicketsByProjectLens,
} from "@standup/store";
import type { Project } from "@standup/shared";
import { tick, runProjectFanOut, type LensRunner, type RanTodayState } from "./review-cron.js";

// ── fixtures ────────────────────────────────────────────────────────────────

const TODAY = new Date(2026, 9, 13, 10, 0, 0);
const TODAY_ISO = "2026-10-13";
const TOMORROW = new Date(2026, 9, 14, 10, 0, 0);
const SIX_LENSES = ["l1", "l2", "l3", "l4", "l5", "l6"];

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "web",
    name: "web",
    branch: "main",
    repos: ["/repos/web"],
    dailyReviewActive: true,
    reviewLenses: ["bugs", "security"],
    ...overrides,
  } as Project;
}

/** A lens runner that records each call and resolves on the next microtask. */
function recorder(): { runLens: LensRunner; calls: string[] } {
  const calls: string[] = [];
  const runLens: LensRunner = async (p, lens) => {
    calls.push(`${p.id}/${lens}`);
  };
  return { runLens, calls };
}

/** An in-memory store with the `web` and `api` projects (tickets FK to them). */
function store() {
  const { db } = createStore(":memory:");
  upsertProject(db, project());
  upsertProject(db, project({ id: "api", name: "api" }));
  return { db };
}

function deps(projects: Project[], runLens: LensRunner, now: Date = TODAY) {
  const state: RanTodayState = new Map();
  return { runLens, now: () => now, projects: () => projects, state };
}

// ── tick ────────────────────────────────────────────────────────────────────

describe("review-cron tick", () => {
  test("runs every lens once and records the day", async () => {
    const { db } = store();
    const { runLens, calls } = recorder();
    await tick(db, "/cfg.json", deps([project()], runLens));
    expect(calls).toEqual(["web/bugs", "web/security"]);
    expect(getSetting(db, "daily_review_last_run:web")).toBe(TODAY_ISO);
  });

  test("daily gate: a project already run today is skipped, and runs again tomorrow", async () => {
    const { db } = store();
    setSetting(db, "daily_review_last_run:web", TODAY_ISO);
    const { runLens, calls } = recorder();
    await tick(db, "/cfg.json", deps([project()], runLens, TODAY));
    expect(calls).toEqual([]);

    await tick(db, "/cfg.json", deps([project()], runLens, TOMORROW));
    expect(calls).toEqual(["web/bugs", "web/security"]);
    expect(getSetting(db, "daily_review_last_run:web")).toBe("2026-10-14");
  });

  test("projects without dailyReviewActive are never reviewed", async () => {
    const { db } = store();
    const { runLens, calls } = recorder();
    await tick(db, "/cfg.json", deps([project({ dailyReviewActive: false })], runLens));
    expect(calls).toEqual([]);
    expect(getSetting(db, "daily_review_last_run:web")).toBeNull();
  });

  test("a lens with an open ticket is skipped; the others still run", async () => {
    const { db } = store();
    createTicket(db, { projectId: "web", lens: "bugs", title: "Null deref", body: "b" });
    const { runLens, calls } = recorder();
    await tick(db, "/cfg.json", deps([project()], runLens));
    expect(calls).toEqual(["web/security"]);
    expect(getSetting(db, "daily_review_last_run:web")).toBe(TODAY_ISO);
  });

  test("a missing repo runs nothing but still closes the day", async () => {
    const { db } = store();
    const { runLens, calls } = recorder();
    await tick(db, "/cfg.json", deps([project({ repos: [] })], runLens));
    expect(calls).toEqual([]);
    expect(getSetting(db, "daily_review_last_run:web")).toBe(TODAY_ISO);
  });

  test("cap: with 6 lenses, 4 run now, 2 on the next tick, then the day is closed", async () => {
    const { db } = store();
    const { runLens, calls } = recorder();
    const d = deps([project({ reviewLenses: SIX_LENSES })], runLens);

    await tick(db, "/cfg.json", d);
    expect(calls).toEqual(["web/l1", "web/l2", "web/l3", "web/l4"]);
    expect(getSetting(db, "daily_review_last_run:web")).toBeNull();

    await tick(db, "/cfg.json", d);
    expect(calls).toEqual(["web/l1", "web/l2", "web/l3", "web/l4", "web/l5", "web/l6"]);
    expect(getSetting(db, "daily_review_last_run:web")).toBe(TODAY_ISO);

    await tick(db, "/cfg.json", d);
    expect(calls).toHaveLength(6);
  });

  test("a deferred day that rolls over starts the new day from the full lens set", async () => {
    const { db } = store();
    const { runLens, calls } = recorder();
    const p = [project({ reviewLenses: SIX_LENSES })];
    const state: RanTodayState = new Map();

    await tick(db, "/cfg.json", { runLens, projects: () => p, state, now: () => TODAY });
    calls.length = 0;
    await tick(db, "/cfg.json", { runLens, projects: () => p, state, now: () => TOMORROW });
    expect(calls).toEqual(["web/l1", "web/l2", "web/l3", "web/l4"]);
  });

  test("a stale tick finishing after midnight keeps the new day's progress", async () => {
    const { db } = store();
    const p = [project({ reviewLenses: SIX_LENSES })];
    const state: RanTodayState = new Map();
    const calls: string[] = [];
    const releases: (() => void)[] = [];
    // Lens runs stay in flight until released, so two ticks can overlap.
    const runLens: LensRunner = (_p, lens) => {
      calls.push(lens);
      return new Promise<void>((res) => releases.push(res));
    };
    // The runner is invoked from a microtask, so let pending calls land first.
    const releaseAll = async () => {
      await new Promise((r) => setTimeout(r, 0));
      while (releases.length) releases.shift()!();
    };
    const at = (now: Date) => ({ runLens, projects: () => p, state, now: () => now });
    const lateToday = new Date(2026, 9, 13, 23, 50, 0);
    const earlyTomorrow = new Date(2026, 9, 14, 0, 10, 0);

    // Day D: l1–l4 run, l5–l6 deferred.
    const first = tick(db, "/cfg.json", at(lateToday));
    await releaseAll();
    await first;
    // Day D's second tick holds l5–l6 in flight while day D+1's tick starts:
    // it gets the two free slots (l1, l2) and defers l3–l6.
    const stale = tick(db, "/cfg.json", at(lateToday));
    const fresh = tick(db, "/cfg.json", at(earlyTomorrow));
    await releaseAll();
    await Promise.all([stale, fresh]);
    expect(calls).toEqual(["l1", "l2", "l3", "l4", "l5", "l6", "l1", "l2"]);

    // The next D+1 tick runs only what D+1 still owes.
    calls.length = 0;
    const next = tick(db, "/cfg.json", at(earlyTomorrow));
    await releaseAll();
    await next;
    expect(calls).toEqual(["l3", "l4", "l5", "l6"]);
    expect(getSetting(db, "daily_review_last_run:web")).toBe("2026-10-14");
  });

  test("a fan-out that throws still records the day, so the cron doesn't hot-loop", async () => {
    const { db } = store();
    // A store failure: the open-ticket lookup throws before any lens starts.
    db.run("DROP TABLE tickets");
    const { runLens, calls } = recorder();
    const d = deps([project()], runLens);
    await tick(db, "/cfg.json", d);
    expect(getSetting(db, "daily_review_last_run:web")).toBe(TODAY_ISO);
    await tick(db, "/cfg.json", d);
    expect(calls).toEqual([]);
  });

  test("a failing lens runner does not leak a slot or keep the day open", async () => {
    const { db } = store();
    const calls: string[] = [];
    const runLens: LensRunner = (_p, lens) => {
      calls.push(lens);
      if (lens === "l1") throw new Error("sync boom");
      return Promise.reject(new Error("async boom"));
    };
    await tick(db, "/cfg.json", deps([project({ reviewLenses: ["l1", "l2"] })], runLens));
    expect(getSetting(db, "daily_review_last_run:web")).toBe(TODAY_ISO);

    // Slots were released: a fresh project still gets all 4.
    const { runLens: rec, calls: after } = recorder();
    const deferred = await runProjectFanOut(
      db,
      project({ id: "api", reviewLenses: SIX_LENSES }),
      "/cfg.json",
      rec
    );
    expect(after).toEqual(["api/l1", "api/l2", "api/l3", "api/l4"]);
    expect(deferred).toEqual(["l5", "l6"]);
    expect(calls).toEqual(["l1", "l2"]);
  });
});

// ── runProjectFanOut ────────────────────────────────────────────────────────

describe("runProjectFanOut", () => {
  test("hands the runner the expanded repo path and the mcp config", async () => {
    const { db } = store();
    const seen: unknown[] = [];
    const runLens: LensRunner = async (_p, lens, repoPath, cfg, openTitles) => {
      seen.push({ lens, repoPath, cfg, openTitles });
    };
    const deferred = await runProjectFanOut(
      db,
      project({ reviewLenses: ["bugs"] }),
      "/cfg.json",
      runLens
    );
    expect(deferred).toEqual([]);
    expect(seen).toEqual([
      { lens: "bugs", repoPath: "/repos/web", cfg: "/cfg.json", openTitles: [] },
    ]);
  });

  test("skips lenses already run today", async () => {
    const { db } = store();
    const { runLens, calls } = recorder();
    await runProjectFanOut(db, project(), "/cfg.json", runLens, new Set(["bugs"]));
    expect(calls).toEqual(["web/security"]);
  });
});

// ── getOpenTicketsByProjectLens ─────────────────────────────────────────────

describe("getOpenTicketsByProjectLens", () => {
  test("returns only active tickets for the given project and lens", () => {
    const { db } = store();
    const proposed = createTicket(db, { projectId: "web", lens: "bugs", title: "a", body: "" });
    const approved = createTicket(db, { projectId: "web", lens: "bugs", title: "b", body: "" });
    updateTicketStatus(db, approved.id, "approved");
    const dismissed = createTicket(db, { projectId: "web", lens: "bugs", title: "c", body: "" });
    updateTicketStatus(db, dismissed.id, "dismissed");
    const shipped = createTicket(db, { projectId: "web", lens: "bugs", title: "d", body: "" });
    for (const s of ["approved", "developing", "needs_review", "shipped"] as const) {
      updateTicketStatus(db, shipped.id, s);
    }
    createTicket(db, { projectId: "web", lens: "security", title: "other lens", body: "" });
    createTicket(db, { projectId: "api", lens: "bugs", title: "other project", body: "" });

    const titles = getOpenTicketsByProjectLens(db, "web", "bugs").map((t) => t.title).sort();
    expect(titles).toEqual([proposed.title, approved.title]);
  });

  test("developing and needs_review count as open", () => {
    const { db } = store();
    const t = createTicket(db, { projectId: "web", lens: "bugs", title: "x", body: "" });
    updateTicketStatus(db, t.id, "approved");
    updateTicketStatus(db, t.id, "developing");
    expect(getOpenTicketsByProjectLens(db, "web", "bugs")).toHaveLength(1);
    updateTicketStatus(db, t.id, "needs_review");
    expect(getOpenTicketsByProjectLens(db, "web", "bugs")).toHaveLength(1);
  });
});
