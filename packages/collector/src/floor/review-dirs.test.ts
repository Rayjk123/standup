import { describe, expect, test } from "bun:test";
import { classifyToolCall, type FloorProbes } from "./classify.js";
import type { FloorCategory, FloorVerdict } from "./gate.js";
import { buildLaunchFloorConfig } from "./launch.js";

/*
 * Stored review media (`<dataDir>/review-media/`) and every launch's review
 * scratch dir (`<dataDir>/review-scratch/<launchId>/`) hold captures of other
 * users' work: the floor holds a worker reading them, except its own
 * launch's scratch dir, where it saves its own screenshots.
 */

const HOME = "/home/tester";
const DATA = `${HOME}/.local/share/standup`;
const ROOT = `${DATA}/worktrees/standup/feat-1`;
const MEDIA = `${DATA}/review-media`;
const SCRATCH_ROOT = `${DATA}/review-scratch`;
const OWN = `${SCRATCH_ROOT}/launch-1`;
const OTHER = `${SCRATCH_ROOT}/launch-2`;
const SHA = "a".repeat(64);

const config = buildLaunchFloorConfig(
  { launchId: "launch-1", root: ROOT, workerToken: "x".repeat(64), replyPublicKey: "test" },
  { DB_PATH: `${DATA}/standup.db`, HOME }
);

const FILES: Record<string, string> = {
  [`${MEDIA}/${SHA}.png`]: "png",
  [`${OWN}/shot.png`]: "png",
  [`${OTHER}/shot.png`]: "png",
  [`${ROOT}/a.png`]: "png",
};
const DIRS = new Set<string>(["/", "/tmp", ROOT, MEDIA, SCRATCH_ROOT, OWN, OTHER]);
for (const f of Object.keys(FILES)) {
  for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) DIRS.add(d);
}
const LINKS: Record<string, string> = { [`${OWN}/link.png`]: `${OTHER}/shot.png` };

const probes: Partial<FloorProbes> = {
  gitBranch: () => "standup/feat-1",
  gitAlias: () => null,
  gitHooksDir: () => null,
  readFile: (p) => (p in FILES ? { ok: true, text: FILES[p]! } : { ok: false, reason: "missing" }),
  exists: (p) => p in FILES || DIRS.has(p) || p in LINKS,
  isDirectory: (p) => DIRS.has(p),
  listDir: () => [],
  realpath: (p) => LINKS[p] ?? (p in FILES || DIRS.has(p) ? p : null),
  homeDir: () => HOME,
  shellDefinitions: () => ({ aliases: new Map(), functions: new Map() }),
  awsAccount: () => null,
  now: () => Date.now(),
};

const bash = (command: string): FloorVerdict =>
  classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: ROOT }, config, probes);
const tool = (toolName: string, toolInput: Record<string, unknown>): FloorVerdict =>
  classifyToolCall({ toolName, toolInput, cwd: ROOT }, config, probes);

function expectHold(v: FloorVerdict, category: FloorCategory = "floor-tamper"): void {
  expect(v.action).toBe("hold");
  if (v.action === "hold") expect(v.category).toBe(category);
}

describe("review media and scratch dirs", () => {
  test("both are among the launch's protected paths", () => {
    expect(config.protectedPaths).toEqual(expect.arrayContaining([MEDIA, SCRATCH_ROOT]));
  });

  test("stored review media is held, by tool and by shell", () => {
    expectHold(tool("Read", { file_path: `${MEDIA}/${SHA}.png` }));
    expectHold(tool("Glob", { pattern: "*.png", path: MEDIA }));
    expectHold(tool("Grep", { pattern: "x", path: MEDIA }));
    expectHold(bash(`cat ${MEDIA}/${SHA}.png`));
    expectHold(bash(`cp ${MEDIA}/${SHA}.png ${ROOT}/x.png`));
    expectHold(bash(`cat ~/.local/share/standup/review-media/${SHA}.png`));
    expectHold(tool("Write", { file_path: `${MEDIA}/${SHA}.png`, content: "x" }));
  });

  test("another launch's scratch dir, and the scratch root, are held", () => {
    expectHold(tool("Read", { file_path: `${OTHER}/shot.png` }));
    expectHold(tool("Glob", { pattern: `${SCRATCH_ROOT}/*/*.png` }));
    expectHold(tool("LS", { path: SCRATCH_ROOT }));
    expectHold(bash(`cat ${OTHER}/shot.png`));
    expectHold(bash(`cp ${OTHER}/shot.png ${OWN}/s.png`));
    expectHold(bash(`ls ${SCRATCH_ROOT}`));
    expectHold(bash(`cat ${OWN}/../launch-2/shot.png`));
    expectHold(tool("Write", { file_path: `${OTHER}/shot.png`, content: "x" }));
  });

  test("a link in the worker's own scratch dir to another launch's capture is held", () => {
    expectHold(tool("Read", { file_path: `${OWN}/link.png` }));
  });

  test("the worker's own scratch dir stays its own", () => {
    expect(tool("Read", { file_path: `${OWN}/shot.png` })).toEqual({ action: "allow" });
    expect(tool("Write", { file_path: `${OWN}/new.png`, content: "x" })).toEqual({ action: "allow" });
    expect(tool("Glob", { pattern: "*.png", path: OWN })).toEqual({ action: "allow" });
    expect(bash(`cp ${ROOT}/a.png ${OWN}/a.png`)).toEqual({ action: "allow" });
    expect(bash(`ls ${OWN}`)).toEqual({ action: "allow" });
    expect(bash(`cat ${OWN}/shot.png`)).toEqual({ action: "allow" });
  });
});
