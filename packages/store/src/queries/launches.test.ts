import { expect, test, describe, afterAll } from "bun:test";
import { mkdtemp, mkdir, symlink, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { createStore } from "../store.js";
import {
  upsertProject,
  createLaunch,
  getLaunchByIdempotencyKey,
  getCodexLaunches,
  findLaunchByCwd,
  getLaunch,
  getLaunchBySession,
  getLaunchList,
  getLaunchesBySession,
  markLaunchReaped,
  setLaunchKeepAlive,
  setLaunchPhase,
  setLaunchProvisionSnapshot,
  appendLaunchLog,
  updateLaunchStatus,
  updateLaunchModelEffort,
  createSession,
  attachSessionToLaunch,
  endSession,
} from "../index.js";

/**
 * Launch attachment has to survive symlinked worktree roots the same way
 * project matching does: a launch's worktree_path is stored from the
 * configured root (e.g. `~/code/...`) while the SessionStart hook reports
 * the OS-resolved realpath (e.g. `/Volumes/code/...` when that root is a
 * symlinked mount). A literal prefix compare treats those as different trees,
 * so the session never attaches and the launch is stranded sessionless,
 * rendering forever as "provisioning workspace…" — the bug these tests pin.
 */

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function symlinkedWorktree() {
  const base = await mkdtemp(join(tmpdir(), "standup-launch-"));
  dirs.push(base);
  const real = join(base, "real");
  await mkdir(join(real, "wt", "src", "Pkg"), { recursive: true });
  const link = join(base, "link");
  await symlink(real, link);
  // real/wt reached two ways: canonical, and via the symlinked parent.
  return {
    canonicalWt: join(real, "wt"),
    viaLinkWt: join(link, "wt"),
    canonicalSubdir: join(real, "wt", "src", "Pkg"),
  };
}

function launch(id: string, worktreePath: string) {
  return {
    id,
    projectId: "p",
    task: "t",
    worktreePath,
    branch: "main",
  };
}

describe("findLaunchByCwd across a symlinked worktree root", () => {
  test("matches when worktree_path is stored via a symlink and the cwd is canonical", async () => {
    const { canonicalWt, viaLinkWt } = await symlinkedWorktree();
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
    createLaunch(store.db, launch("L1", viaLinkWt));

    expect(findLaunchByCwd(store.db, canonicalWt)?.id).toBe("L1");
  });

  test("matches a launchSubdir cwd reported under the resolved realpath", async () => {
    const { viaLinkWt, canonicalSubdir } = await symlinkedWorktree();
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
    // Stored via symlink; hook reports the deep realpath (worktree + subdir).
    createLaunch(store.db, launch("L1", viaLinkWt));

    expect(findLaunchByCwd(store.db, canonicalSubdir)?.id).toBe("L1");
  });

  test("does not match a sibling worktree sharing a string prefix", async () => {
    const { canonicalWt } = await symlinkedWorktree();
    const sibling = `${canonicalWt}-other`;
    await mkdir(sibling, { recursive: true });
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
    createLaunch(store.db, launch("L1", canonicalWt));

    expect(findLaunchByCwd(store.db, sibling)).toBeNull();
  });
});

describe("launch provisioning progress", () => {
  function seed() {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
    createLaunch(store.db, {
      id: "L1",
      projectId: "p",
      task: "t",
      worktreePath: "/tmp/L1",
      branch: "main",
      provisioned: true,
    });
    return store;
  }

  test("setLaunchPhase records the current phase", () => {
    const store = seed();
    setLaunchPhase(store.db, "L1", "building");
    expect(getLaunch(store.db, "L1")?.phase).toBe("building");
  });

  test("appendLaunchLog accumulates streamed output", () => {
    const store = seed();
    appendLaunchLog(store.db, "L1", "line one\n");
    appendLaunchLog(store.db, "L1", "line two\n");
    expect(getLaunch(store.db, "L1")?.log).toBe("line one\nline two\n");
  });

  test("getLaunchList carries every field getLaunch does but the log", () => {
    const store = seed();
    createLaunch(store.db, {
      id: "L2",
      projectId: "p",
      task: "codex task",
      worktreePath: "/tmp/L2",
      branch: "b2",
      baseBranch: "main",
      tmuxSession: "standup-L2",
      model: "opus",
      effort: "high",
      requester: "alice",
      launchedBy: "persona",
      harness: "codex",
      codexEventLog: "/tmp/L2/events.jsonl",
      codexModel: "gpt-5-codex",
      codexEffort: "medium",
      bypassPermissions: true,
    });
    for (const id of ["L1", "L2"]) {
      setLaunchPhase(store.db, id, "building");
      appendLaunchLog(store.db, id, "x".repeat(5000));
    }
    updateLaunchStatus(store.db, "L2", "failed", "build broke");
    markLaunchReaped(store.db, "L1", "idle");
    setLaunchKeepAlive(store.db, "L1", true);

    const listed = getLaunchList(store.db);
    expect(listed.map((l) => l.id).sort()).toEqual(["L1", "L2"]);
    for (const l of listed) {
      const { log, ...rest } = getLaunch(store.db, l.id)!;
      expect(log).toHaveLength(5000);
      expect(l).toEqual(rest);
      expect("log" in l && l.log !== undefined).toBe(false);
    }

    // The per-session lookup the snapshot decorates sessions with leaves it out too.
    createSession(store.db, { id: "S2", projectId: "p", title: "t", cwd: "/tmp/L2", status: "running" });
    attachSessionToLaunch(store.db, "L2", "S2");
    const bySession = getLaunchesBySession(store.db, ["S2"]).get("S2")!;
    const { log: _log, ...rest } = getLaunch(store.db, "L2")!;
    expect(bySession).toEqual(rest);
    expect(bySession.log).toBeUndefined();
  });

  test("a terminal status clears the phase", () => {
    const store = seed();
    setLaunchPhase(store.db, "L1", "starting");
    updateLaunchStatus(store.db, "L1", "running");
    expect(getLaunch(store.db, "L1")?.phase).toBeUndefined();
    expect(getLaunch(store.db, "L1")?.status).toBe("running");
  });
});

describe("launch idempotency key", () => {
  function store() {
    const s = createStore(":memory:");
    upsertProject(s.db, { id: "p", name: "p", branch: "main", repos: [] });
    return s;
  }

  test("getLaunchByIdempotencyKey finds a launch stamped with the key", () => {
    const s = store();
    createLaunch(s.db, {
      id: "L1",
      projectId: "p",
      task: "t",
      worktreePath: "/tmp/L1",
      branch: "main",
      idempotencyKey: "slack:C1:170.5",
    });
    expect(getLaunchByIdempotencyKey(s.db, "slack:C1:170.5")?.id).toBe("L1");
    expect(getLaunchByIdempotencyKey(s.db, "nope")).toBeNull();
  });

  test("a launch created without a key is not found by any key", () => {
    const s = store();
    createLaunch(s.db, { id: "L1", projectId: "p", task: "t", worktreePath: "/tmp/L1", branch: "main" });
    // A null key must never be treated as a match — the partial index excludes it.
    expect(getLaunchByIdempotencyKey(s.db, "")).toBeNull();
  });

  test("a second launch reusing a key violates the UNIQUE index (the double-spawn backstop)", () => {
    const s = store();
    createLaunch(s.db, {
      id: "L1",
      projectId: "p",
      task: "t",
      worktreePath: "/tmp/L1",
      branch: "main",
      idempotencyKey: "dup",
    });
    expect(() =>
      createLaunch(s.db, {
        id: "L2",
        projectId: "p",
        task: "t",
        worktreePath: "/tmp/L2",
        branch: "main",
        idempotencyKey: "dup",
      }),
    ).toThrow();
  });
});

describe("harness selection + codex fleet-usage enumeration", () => {
  function store() {
    const s = createStore(":memory:");
    upsertProject(s.db, { id: "p", name: "p", branch: "main", repos: [] });
    return s;
  }

  test("harness and codex_event_log round-trip through createLaunch/getLaunch", () => {
    const s = store();
    createLaunch(s.db, {
      id: "L1",
      projectId: "p",
      task: "t",
      worktreePath: "/tmp/L1",
      branch: "main",
      harness: "codex",
      codexEventLog: "/tmp/codex-L1.jsonl",
    });
    const row = getLaunch(s.db, "L1");
    expect(row?.harness).toBe("codex");
    expect(row?.codexEventLog).toBe("/tmp/codex-L1.jsonl");
  });

  test("a claude launch stores no harness/sidecar (unset = claude)", () => {
    const s = store();
    createLaunch(s.db, { id: "L1", projectId: "p", task: "t", worktreePath: "/tmp/L1", branch: "main" });
    const row = getLaunch(s.db, "L1");
    expect(row?.harness).toBeUndefined();
    expect(row?.codexEventLog).toBeUndefined();
  });

  test("codex_model and codex_effort round-trip through createLaunch/getLaunch", () => {
    const s = store();
    createLaunch(s.db, {
      id: "L1",
      projectId: "p",
      task: "t",
      worktreePath: "/tmp/L1",
      branch: "main",
      harness: "codex",
      codexModel: "gpt-5-codex",
      codexEffort: "high",
    });
    const row = getLaunch(s.db, "L1");
    expect(row?.codexModel).toBe("gpt-5-codex");
    expect(row?.codexEffort).toBe("high");
  });

  test("a launch that sets no codex model/effort reads them back as unset (NULL = CLI default)", () => {
    const s = store();
    createLaunch(s.db, { id: "L1", projectId: "p", task: "t", worktreePath: "/tmp/L1", branch: "main" });
    const row = getLaunch(s.db, "L1");
    expect(row?.codexModel).toBeUndefined();
    expect(row?.codexEffort).toBeUndefined();
  });

  test("getCodexLaunches returns only codex launches with a sidecar, filtered by active state", () => {
    const s = store();
    // A codex launch with a sidecar (active), a claude launch (excluded), and a
    // finished codex launch (only surfaced when activeOnly is false).
    createLaunch(s.db, {
      id: "codex-active",
      projectId: "p",
      task: "t",
      worktreePath: "/tmp/A",
      branch: "main",
      status: "running",
      harness: "codex",
      codexEventLog: "/tmp/A.jsonl",
    });
    createLaunch(s.db, {
      id: "claude-one",
      projectId: "p",
      task: "t",
      worktreePath: "/tmp/B",
      branch: "main",
      status: "running",
    });
    createLaunch(s.db, {
      id: "codex-done",
      projectId: "p",
      task: "t",
      worktreePath: "/tmp/C",
      branch: "main",
      harness: "codex",
      codexEventLog: "/tmp/C.jsonl",
    });
    updateLaunchStatus(s.db, "codex-done", "cleaned");

    const active = getCodexLaunches(s.db, { activeOnly: true });
    expect(active.map((l) => l.id)).toEqual(["codex-active"]);

    const all = getCodexLaunches(s.db, { activeOnly: false }).map((l) => l.id).sort();
    expect(all).toEqual(["codex-active", "codex-done"]);
  });

  test("a codex launch whose observed session ended drops out of the active view", () => {
    const s = store();
    createLaunch(s.db, {
      id: "codex-run",
      projectId: "p",
      task: "t",
      worktreePath: "/tmp/R",
      branch: "main",
      status: "running",
      harness: "codex",
      codexEventLog: "/tmp/R.jsonl",
    });
    createSession(s.db, {
      id: "sess-R",
      projectId: "p",
      title: "t",
      cwd: "/tmp/R",
      status: "running",
    });
    attachSessionToLaunch(s.db, "codex-run", "sess-R");

    // While the session is live the run is active.
    expect(getCodexLaunches(s.db, { activeOnly: true }).map((l) => l.id)).toEqual(["codex-run"]);

    // Ending the session drops the run from the active view even though the launch
    // row still reads `running` — the same signal an active Claude session leaves
    // getActiveSessions on. It stays in the `all` view for historical telemetry.
    endSession(s.db, "sess-R");
    expect(getCodexLaunches(s.db, { activeOnly: true })).toEqual([]);
    expect(getCodexLaunches(s.db, { activeOnly: false }).map((l) => l.id)).toEqual(["codex-run"]);
  });

  test("a codex launch without a sidecar is not enumerated for telemetry", () => {
    const s = store();
    createLaunch(s.db, {
      id: "codex-nolog",
      projectId: "p",
      task: "t",
      worktreePath: "/tmp/N",
      branch: "main",
      status: "running",
      harness: "codex",
    });
    expect(getCodexLaunches(s.db, { activeOnly: false })).toEqual([]);
  });
});

describe("getLaunchBySession when a session id maps to more than one launch", () => {
  function store() {
    const s = createStore(":memory:");
    upsertProject(s.db, { id: "p", name: "p", branch: "main", repos: [] });
    return s;
  }

  // Adopting an ended session reuses its session id, so the dead worktree
  // launch and the live adopted launch share it. The resolver must return the
  // one that can actually be driven, or the Work page steers a stale tmux
  // session and reports "tmux session is no longer running".
  test("prefers a live launch over a dead one sharing the session id, even when the dead one is newer", () => {
    const s = store();
    // The dead worktree launch is inserted first — mirroring the real order
    // (original launch, then adopt) — so a query without ORDER BY returns it.
    createLaunch(s.db, {
      id: "worktree-dead",
      projectId: "p",
      task: "t",
      worktreePath: "/tmp/dead",
      branch: "main",
      sessionId: "sess-shared",
      tmuxSession: "standup-old-dead-pane",
      status: "failed",
    });
    createLaunch(s.db, {
      id: "adopted-live",
      kind: "adopted",
      projectId: "p",
      task: "t",
      worktreePath: "/tmp/live",
      branch: "main",
      sessionId: "sess-shared",
      tmuxSession: "standup-adopt-sess",
      status: "running",
    });
    // Make the dead row strictly newer so created_at DESC alone would pick it —
    // only the live-status tiebreaker keeps the resolver on the adopted one.
    s.db.run("UPDATE launches SET created_at = '2026-01-02 00:00:00' WHERE id = 'worktree-dead'");
    s.db.run("UPDATE launches SET created_at = '2026-01-01 00:00:00' WHERE id = 'adopted-live'");

    expect(getLaunchBySession(s.db, "sess-shared")?.id).toBe("adopted-live");
  });

  test("among launches of equal liveness, returns the most recent", () => {
    const s = store();
    createLaunch(s.db, {
      id: "older",
      projectId: "p",
      task: "t",
      worktreePath: "/tmp/older",
      branch: "main",
      sessionId: "sess-two-live",
      status: "running",
    });
    createLaunch(s.db, {
      id: "newer",
      projectId: "p",
      task: "t",
      worktreePath: "/tmp/newer",
      branch: "main",
      sessionId: "sess-two-live",
      status: "running",
    });
    // created_at is second-granular, so force a strict ordering to pin the
    // tiebreaker rather than relying on same-second insertion order.
    s.db.run("UPDATE launches SET created_at = '2026-01-01 00:00:00' WHERE id = 'older'");
    s.db.run("UPDATE launches SET created_at = '2026-01-01 00:00:05' WHERE id = 'newer'");

    expect(getLaunchBySession(s.db, "sess-two-live")?.id).toBe("newer");
  });

  test("returns null when no launch has the session id", () => {
    const s = store();
    expect(getLaunchBySession(s.db, "sess-none")).toBeNull();
  });
});

describe("updateLaunchModelEffort", () => {
  function seeded() {
    const s = createStore(":memory:");
    upsertProject(s.db, { id: "p", name: "p", branch: "main", repos: [] });
    createLaunch(s.db, {
      ...launch("L", "/tmp/L"),
      model: "sonnet",
      effort: "medium",
    });
    return s;
  }

  test("persists both a model and an effort", () => {
    const s = seeded();
    updateLaunchModelEffort(s.db, "L", { model: "claude-opus-4-8", effort: "max" });
    const row = getLaunch(s.db, "L");
    expect(row?.model).toBe("claude-opus-4-8");
    expect(row?.effort).toBe("max");
  });

  test("an omitted field keeps its stored value", () => {
    const s = seeded();
    updateLaunchModelEffort(s.db, "L", { effort: "high" });
    expect(getLaunch(s.db, "L")?.model).toBe("sonnet");
    expect(getLaunch(s.db, "L")?.effort).toBe("high");

    updateLaunchModelEffort(s.db, "L", { model: "haiku" });
    expect(getLaunch(s.db, "L")?.model).toBe("haiku");
    expect(getLaunch(s.db, "L")?.effort).toBe("high");
  });
});

describe("a launch's provision snapshot", () => {
  const snapshot = { checkouts: { "src/A#1.2": { head: "a".repeat(40), reflog: 3, log: "d" } }, dirty: { "src/A/x": "h" } };

  test("round-trips, and reads as none until it is recorded", () => {
    const s = createStore(":memory:");
    upsertProject(s.db, { id: "p", name: "p", branch: "main", repos: [] });
    createLaunch(s.db, launch("L", "/tmp/L"));
    expect(getLaunch(s.db, "L")?.provisionSnapshot).toBeUndefined();
    setLaunchProvisionSnapshot(s.db, "L", snapshot);
    expect(getLaunch(s.db, "L")?.provisionSnapshot).toEqual(snapshot);
  });

  test.each([
    ["not JSON", "{"],
    ["no checkouts", JSON.stringify({ dirty: {} })],
    ["a reflog length that isn't a count", JSON.stringify({ checkouts: { k: { head: "a", reflog: "3", log: "d" } }, dirty: {} })],
    ["a checkout with no reflog digest", JSON.stringify({ checkouts: { k: { head: "a", reflog: 3 } }, dirty: {} })],
    ["a digest that isn't a string", JSON.stringify({ checkouts: {}, dirty: { f: 1 } })],
  ])("one with %s reads as none", (_label, raw) => {
    const s = createStore(":memory:");
    upsertProject(s.db, { id: "p", name: "p", branch: "main", repos: [] });
    createLaunch(s.db, launch("L", "/tmp/L"));
    s.db.run("UPDATE launches SET provision_snapshot = ? WHERE id = ?", [raw, "L"]);
    expect(getLaunch(s.db, "L")?.provisionSnapshot).toBeUndefined();
  });
});
