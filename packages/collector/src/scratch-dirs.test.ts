import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";
import { SCRATCH_MARKER } from "@standup/shared/scratch";
import {
  createLaunch,
  createPersonaJob,
  createSession,
  createStore,
  endSession,
  linkPersonaJobLaunch,
  markLaunchReaped,
  updateLaunchStatus,
  updatePersonaJob,
  upsertProject,
} from "@standup/store";
import { SCRATCH_MAX_AGE_MS, checkScratchFs, ensureScratchDir, hasScratchMarker, removeScratchDir, scratchKeptByStore, sweepScratchDirs, usableScratchRoot } from "./scratch-dirs.js";

/** The workers' tmux server as these tests see it: no panes, so no check reaches real tmux. */
const paneAlive = () => false;
const liveness = { paneAlive };

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function freshRoot(): string {
  const base = mkdtempSync(join(tmpdir(), "standup-scratch-test-"));
  made.push(base);
  return join(base, "standup-scratch");
}

/** Sets a dir's mtime `ageMs` before `now`. */
function age(dir: string, now: number, ageMs: number): void {
  const t = new Date(now - ageMs);
  utimesSync(dir, t, t);
}

describe("ensureScratchDir", () => {
  test("makes a 0700 dir under the root and is idempotent", () => {
    const root = freshRoot();
    const dir = ensureScratchDir("L1", root);
    expect(dir).toBe(join(root, "L1"));
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    writeFileSync(join(dir, "f"), "x");
    expect(ensureScratchDir("L1", root)).toBe(dir);
    expect(existsSync(join(dir, "f"))).toBe(true);
  });

  test("tightens a dir open to others", () => {
    const root = freshRoot();
    mkdirSync(join(root, "L2"), { recursive: true, mode: 0o755 });
    ensureScratchDir("L2", root);
    expect(statSync(join(root, "L2")).mode & 0o777).toBe(0o700);
  });

  test("refuses a bad id and a symlink in place of the dir", () => {
    const root = freshRoot();
    for (const bad of ["..", "a/b", "", ".x"]) expect(() => ensureScratchDir(bad, root)).toThrow("not a usable launch id");
    mkdirSync(root, { recursive: true });
    const elsewhere = mkdtempSync(join(tmpdir(), "standup-scratch-elsewhere-"));
    made.push(elsewhere);
    symlinkSync(elsewhere, join(root, "L3"));
    expect(() => ensureScratchDir("L3", root)).toThrow("not a directory of this user's");
  });

  test("marks the dir with its launch id, and adds the mark to an unmarked dir of the same name", () => {
    const root = freshRoot();
    const dir = ensureScratchDir("L1", root);
    expect(readFileSync(join(dir, SCRATCH_MARKER), "utf8").trim()).toBe("L1");
    expect(hasScratchMarker(dir, "L1")).toBe(true);
    mkdirSync(join(root, "L2"), { recursive: true });
    ensureScratchDir("L2", root);
    expect(hasScratchMarker(join(root, "L2"), "L2")).toBe(true);
  });

  test("refuses a dir marked as another launch's, or whose marker is a symlink", () => {
    const root = freshRoot();
    mkdirSync(join(root, "L1"), { recursive: true });
    writeFileSync(join(root, "L1", SCRATCH_MARKER), "L9\n");
    expect(() => ensureScratchDir("L1", root)).toThrow("marked as another launch's");
    const outside = mkdtempSync(join(tmpdir(), "standup-scratch-outside-"));
    made.push(outside);
    writeFileSync(join(outside, "m"), "L2\n");
    mkdirSync(join(root, "L2"), { recursive: true });
    symlinkSync(join(outside, "m"), join(root, "L2", SCRATCH_MARKER));
    expect(() => ensureScratchDir("L2", root)).toThrow("marked as another launch's");
  });
});

describe("scratch root guard", () => {
  /** A marked dir `L1` under a fresh temp root (named `standup-scratch…`), and an unrelated temp dir with one too. */
  function decoys(): { decoy: string; other: string } {
    const decoy = mkdtempSync(join(tmpdir(), "standup-scratch-guard-"));
    const other = mkdtempSync(join(tmpdir(), "guard-other-"));
    made.push(decoy, other);
    ensureScratchDir("L1", decoy);
    ensureScratchDir("L1", other);
    return { decoy, other };
  }

  /** Roots the guard refuses, each but the empty, `/` and relative ones naming a real dir holding a marked `L1`. */
  function refusedRoots(decoy: string, other: string): string[] {
    return [
      "",
      "/",
      "rel/standup-scratch",
      join(dirname(decoy), "x") + "/../" + basename(decoy),
      `${dirname(decoy)}//${basename(decoy)}`,
      `${decoy}/`,
      `${decoy}/.`,
      other,
    ];
  }

  test("usableScratchRoot accepts only an absolute, normalized standup-scratch root", () => {
    const { decoy, other } = decoys();
    expect(usableScratchRoot(decoy)).toBe(true);
    expect(usableScratchRoot("/home/me/.cache/standup-scratch")).toBe(true);
    for (const root of [...refusedRoots(decoy, other), "/tmp/x/../standup-scratch", "/tmp/other"]) expect(usableScratchRoot(root)).toBe(false);
  });

  test("removeScratchDir refuses a bad root and leaves the marked dir under it", () => {
    const { decoy, other } = decoys();
    for (const root of [...refusedRoots(decoy, other), "/tmp/x/../standup-scratch", "/tmp/other"]) {
      expect(removeScratchDir("L1", root)).toBe(false);
    }
    expect(hasScratchMarker(join(decoy, "L1"), "L1")).toBe(true);
    expect(hasScratchMarker(join(other, "L1"), "L1")).toBe(true);
  });

  test("removeScratchDir refuses an empty, dot or path id under a good root", () => {
    const { decoy } = decoys();
    for (const id of ["", ".", "..", "a/b"]) expect(removeScratchDir(id, decoy)).toBe(false);
    expect(existsSync(decoy)).toBe(true);
    expect(hasScratchMarker(join(decoy, "L1"), "L1")).toBe(true);
  });

  test("sweepScratchDirs does nothing under a bad root", () => {
    const { decoy, other } = decoys();
    const store = createStore(":memory:");
    const far = Date.now() + 10 * SCRATCH_MAX_AGE_MS;
    for (const root of [...refusedRoots(decoy, other), "/tmp/x/../standup-scratch", "/tmp/other"]) {
      expect(sweepScratchDirs(store.db, { root, now: far, isKept: () => false, isKnown: () => true, log: () => {} })).toEqual([]);
    }
    expect(hasScratchMarker(join(decoy, "L1"), "L1")).toBe(true);
    expect(hasScratchMarker(join(other, "L1"), "L1")).toBe(true);
    // The same sweep under the good root does remove it.
    expect(sweepScratchDirs(store.db, { root: decoy, now: far, isKept: () => false, isKnown: () => true, log: () => {} })).toEqual(["L1"]);
  });
});

describe("removeScratchDir", () => {
  test("removes the dir and its contents without following symlinks inside", () => {
    const root = freshRoot();
    const dir = ensureScratchDir("L1", root);
    const outside = mkdtempSync(join(tmpdir(), "standup-scratch-outside-"));
    made.push(outside);
    writeFileSync(join(outside, "keep"), "x");
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "nested", "f"), "x");
    symlinkSync(outside, join(dir, "link"));
    expect(removeScratchDir("L1", root)).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(outside, "keep"))).toBe(true);
  });

  test("leaves a symlink at the dir's path, a file, a missing dir and a bad id alone", () => {
    const root = freshRoot();
    mkdirSync(root, { recursive: true });
    const outside = mkdtempSync(join(tmpdir(), "standup-scratch-outside-"));
    made.push(outside);
    writeFileSync(join(outside, "keep"), "x");
    symlinkSync(outside, join(root, "L1"));
    expect(removeScratchDir("L1", root)).toBe(false);
    expect(lstatSync(join(root, "L1")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(outside, "keep"))).toBe(true);
    writeFileSync(join(root, "L2"), "x");
    expect(removeScratchDir("L2", root)).toBe(false);
    expect(existsSync(join(root, "L2"))).toBe(true);
    expect(removeScratchDir("missing", root)).toBe(false);
    expect(removeScratchDir("..", root)).toBe(false);
    expect(existsSync(root)).toBe(true);
  });

  test("leaves a dir with no marker, or one naming another launch", () => {
    const root = freshRoot();
    mkdirSync(join(root, "L1"), { recursive: true });
    writeFileSync(join(root, "L1", "precious"), "x");
    expect(removeScratchDir("L1", root)).toBe(false);
    expect(existsSync(join(root, "L1", "precious"))).toBe(true);
    writeFileSync(join(root, "L1", SCRATCH_MARKER), "L2\n");
    expect(removeScratchDir("L1", root)).toBe(false);
    expect(existsSync(join(root, "L1", "precious"))).toBe(true);
  });
});

describe("sweepScratchDirs", () => {
  const now = Date.now();
  const old = SCRATCH_MAX_AGE_MS + 60_000;

  test("removes old unclaimed dirs, keeps fresh and claimed ones, skips odd entries", () => {
    const root = freshRoot();
    for (const id of ["old-free", "old-kept", "fresh-free"]) ensureScratchDir(id, root);
    age(join(root, "old-free"), now, old);
    age(join(root, "old-kept"), now, old);
    writeFileSync(join(root, "old-file"), "x");
    mkdirSync(join(root, ".hidden"));
    age(join(root, ".hidden"), now, old);
    mkdirSync(join(root, "old-unmarked"));
    age(join(root, "old-unmarked"), now, old);
    const store = createStore(":memory:");
    const removed = sweepScratchDirs(store.db, { root, now, isKept: (id) => id === "old-kept", isKnown: () => true });
    expect(removed).toEqual(["old-free"]);
    expect(existsSync(join(root, "old-kept"))).toBe(true);
    expect(existsSync(join(root, "fresh-free"))).toBe(true);
    expect(existsSync(join(root, "old-file"))).toBe(true);
    expect(existsSync(join(root, ".hidden"))).toBe(true);
    expect(existsSync(join(root, "old-unmarked"))).toBe(true);
  });

  test("honours maxAgeMs and a missing root", () => {
    const root = freshRoot();
    const store = createStore(":memory:");
    expect(sweepScratchDirs(store.db, { root, now, paneAlive })).toEqual([]);
    ensureScratchDir("a", root);
    age(join(root, "a"), now, 10_000);
    expect(sweepScratchDirs(store.db, { root, now, maxAgeMs: 60_000, isKept: () => false, isKnown: () => true })).toEqual([]);
    expect(sweepScratchDirs(store.db, { root, now, maxAgeMs: 5_000, isKept: () => false, isKnown: () => true })).toEqual(["a"]);
  });

  test("leaves a dir no known launch owns, logging it once", () => {
    const root = freshRoot();
    const store = createStore(":memory:");
    ensureScratchDir("stranger", root);
    age(join(root, "stranger"), now, old);
    const logs: string[] = [];
    expect(sweepScratchDirs(store.db, { root, now, paneAlive, isKept: () => false, log: (m) => logs.push(m) })).toEqual([]);
    expect(sweepScratchDirs(store.db, { root, now, paneAlive, isKept: () => false, log: (m) => logs.push(m) })).toEqual([]);
    expect(existsSync(join(root, "stranger"))).toBe(true);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("stranger");
  });

  test("by default keeps a live launch's dir and a reaped launch's with an open job", () => {
    const root = freshRoot();
    const store = createStore(":memory:");
    const db = store.db;
    upsertProject(db, { id: "p", name: "p", branch: "main", repos: [] });
    const ids = ["live", "failed", "reaped-open", "reaped-closed", "unknown"];
    for (const [i, id] of ids.entries()) {
      if (id !== "unknown") createLaunch(db, { id, projectId: "p", task: "t", worktreePath: `/wt/${i}`, branch: `b${i}` });
      ensureScratchDir(id, root);
      age(join(root, id), now, old);
    }
    updateLaunchStatus(db, "live", "running");
    updateLaunchStatus(db, "failed", "failed");
    for (const id of ["reaped-open", "reaped-closed"]) {
      updateLaunchStatus(db, id, "cleaned");
      markLaunchReaped(db, id, "idle");
    }
    const open = createPersonaJob(db, { owner: "o", threadId: "t", title: "j", goal: "g" });
    linkPersonaJobLaunch(db, open.id, "reaped-open");
    const closed = createPersonaJob(db, { owner: "o", threadId: "t", title: "j2", goal: "g" });
    linkPersonaJobLaunch(db, closed.id, "reaped-closed");
    updatePersonaJob(db, closed.id, { status: "done" });

    expect(scratchKeptByStore(db, "live", liveness)).toBe(true);
    expect(scratchKeptByStore(db, "reaped-open", liveness)).toBe(true);
    expect(scratchKeptByStore(db, "unknown", liveness)).toBe(false);
    expect(sweepScratchDirs(db, { root, now, paneAlive, log: () => {} }).sort()).toEqual(["failed", "reaped-closed"]);
    expect(existsSync(join(root, "live"))).toBe(true);
    expect(existsSync(join(root, "reaped-open"))).toBe(true);
    expect(existsSync(join(root, "unknown"))).toBe(true);
  });

  test("keeps a starting launch's dir even when its job is closed", () => {
    const store = createStore(":memory:");
    const db = store.db;
    upsertProject(db, { id: "p", name: "p", branch: "main", repos: [] });
    createLaunch(db, { id: "starting", projectId: "p", task: "t", worktreePath: "/wt/s", branch: "b", status: "starting" });
    const closed = createPersonaJob(db, { owner: "o", threadId: "t", title: "j", goal: "g" });
    linkPersonaJobLaunch(db, closed.id, "starting");
    updatePersonaJob(db, closed.id, { status: "done" });
    expect(scratchKeptByStore(db, "starting", liveness)).toBe(true);
  });

  test("keeps the original launch's dir while an adoption of its session is live, and a paused worker's", () => {
    const root = freshRoot();
    const store = createStore(":memory:");
    const db = store.db;
    upsertProject(db, { id: "p", name: "p", branch: "main", repos: [] });
    createSession(db, { id: "s1", projectId: "p", title: "w", cwd: "/wt/1", status: "running" });
    endSession(db, "s1");
    createLaunch(db, { id: "first", projectId: "p", task: "t", worktreePath: "/wt/1", branch: "b1", status: "failed", sessionId: "s1" });
    createLaunch(db, { id: "again", projectId: "p", task: "t", worktreePath: "/wt/1", branch: "b1", status: "running", sessionId: "s1", kind: "adopted" });
    createSession(db, { id: "s2", projectId: "p", title: "w", cwd: "/wt/2", status: "running" });
    endSession(db, "s2");
    createLaunch(db, { id: "paused", projectId: "p", task: "t", worktreePath: "/wt/2", branch: "b2", status: "running", sessionId: "s2" });
    markLaunchReaped(db, "paused", "idle");
    createLaunch(db, { id: "stopped", projectId: "p", task: "t", worktreePath: "/wt/3", branch: "b3", status: "failed" });
    for (const id of ["first", "paused", "stopped"]) {
      ensureScratchDir(id, root);
      age(join(root, id), now, old);
    }

    expect(scratchKeptByStore(db, "first", liveness)).toBe(true);
    expect(scratchKeptByStore(db, "paused", liveness)).toBe(true);
    expect(scratchKeptByStore(db, "stopped", liveness)).toBe(false);
    expect(sweepScratchDirs(db, { root, now, paneAlive, log: () => {} })).toEqual(["stopped"]);

    // Once the adoption is stopped too, the original launch's dir is unclaimed.
    updateLaunchStatus(db, "again", "failed");
    expect(scratchKeptByStore(db, "first", liveness)).toBe(false);
  });
});

describe("checkScratchFs", () => {
  test("returns the fstype and warns only on tmpfs", () => {
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    expect(checkScratchFs({ root: "/r", findmnt: () => "xfs\n", warn })).toBe("xfs");
    expect(warnings).toEqual([]);
    expect(checkScratchFs({ root: "/r", findmnt: () => "tmpfs\n", warn })).toBe("tmpfs");
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("/r is on tmpfs");
  });

  test("tolerates findmnt being missing or printing nothing", () => {
    const warn = () => {
      throw new Error("no warning expected");
    };
    expect(checkScratchFs({ root: "/r", findmnt: () => null, warn })).toBeNull();
    expect(checkScratchFs({ root: "/r", findmnt: () => "", warn })).toBeNull();
  });

  test("passes the root to findmnt", () => {
    const seen: string[] = [];
    checkScratchFs({ root: "/the/root", findmnt: (p) => (seen.push(p), "ext4"), warn: () => {} });
    expect(seen).toEqual(["/the/root"]);
  });
});
