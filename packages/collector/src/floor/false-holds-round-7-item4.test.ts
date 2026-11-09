import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join, resolve } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * An output option handed to a script (`--out`, `--out=`, `-o`, `--output`)
 * is the script's own argument, not a shell redirect: the write it implies is
 * judged by the path. A path the floor can place is fine in the worktree,
 * /tmp or the launch's scratch dir and held in the install, the data dir or a
 * secret. A path it can't expand (`--out "$D/x.png"`) is weighed like a
 * redirect to the same path: held only when the text names a denylist target
 * or a guarded file. Running the install's screenshot helper names the
 * install, but that word is the program being run, so it alone doesn't hold
 * the write; any other spelling of a denylist target in the call still does.
 */

const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
const COMMON = join("/", "fake", "repo", ".git");
const SCRATCH_ROOT = join(HOME, ".cache", "standup-scratch");
const S = join(SCRATCH_ROOT, "launch-1");
const SHOT = join(INSTALL, "scripts", "pipeline-screenshot.ts");
const SHOTS = join("/", "tmp", "standup-screenshots-1");
const OTHER = join(INSTALL, "scripts", "gen-report.ts");

function configFor(root: string): FloorConfig {
  return {
    v: 1,
    collectorUrl: "http://127.0.0.1:17777",
    launchId: "launch-1",
    scratchRoot: SCRATCH_ROOT,
    scratchDir: S,
    root,
    sharedBranches: ["main", "mainline"],
    personalAwsAccounts: [],
    waitSeconds: 60,
    standupDataDir: DATA,
    floorPaths: [join(INSTALL, "packages", "collector", "src", "floor")],
    installDir: INSTALL,
    protectedPaths: [join(DATA, "secrets")],
    tmpDirs: ["/tmp"],
    workerToken: "x".repeat(64),
    replyPublicKey: "test",
  };
}

const FILES: Record<string, string> = {
  [join(ROOT, ".git")]: `gitdir: ${COMMON}/worktrees/feat-1\n`,
  [SHOT]: readFileSync(resolve(import.meta.dir, "../../../../scripts/pipeline-screenshot.ts"), "utf8"),
  [join(INSTALL, "packages", "shared", "src", "topology.ts")]: readFileSync(resolve(import.meta.dir, "../../../shared/src/topology.ts"), "utf8"),
  [join(SHOTS, "x.png")]: "png",
  [join("/", "tmp", "x.json")]: "{}",
  [join(ROOT, "scripts", "gen.ts")]: "import { writeFileSync } from 'fs';\nwriteFileSync(process.argv[3]!, 'x');\n",
  [OTHER]: "import { writeFileSync } from 'fs';\nwriteFileSync(process.argv[3]!, 'x');\n",
};
const DIRS = ["/", "/tmp", SHOTS, ROOT, join(ROOT, "scripts"), join(INSTALL, "scripts"), S, join(DATA, "secrets")];

function probes(): Partial<FloorProbes> {
  const dirs = new Set<string>(DIRS);
  for (const f of [...Object.keys(FILES), ...DIRS]) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  dirs.delete(join(ROOT, ".git"));
  const defs: ShellDefinitions = { aliases: new Map(), functions: new Map() };
  parseShellSnapshot("", defs);
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    gitCommonDir: (dir) => (dir === ROOT ? COMMON : null),
    readFile: (p) => (p in FILES ? { ok: true, text: FILES[p]! } : { ok: false, reason: "missing" }),
    exists: (p) => p in FILES || dirs.has(p),
    executable: () => false,
    isDirectory: (p) => dirs.has(p),
    listDir: (p) => (dirs.has(p) ? [...new Set([...Object.keys(FILES), ...dirs].filter((f) => f.startsWith(`${p === "/" ? "" : p}/`)).map((f) => f.slice((p === "/" ? 0 : p.length) + 1).split("/")[0]!))] : null),
    realpath: (p) => (p in FILES || dirs.has(p) ? p : null),
    lstat: (p) => (p in FILES ? { symlink: false, file: true, nlink: 1 } : dirs.has(p) ? { symlink: false, file: false, nlink: 1 } : null),
    homeDir: () => HOME,
    env: () => undefined,
    shellDefinitions: () => defs,
    awsAccount: () => null,
    now: () => Date.now(),
    gitTree: () => null,
    gitAncestor: () => null,
    gitBlob: () => ({ ok: false, reason: "missing" }),
  };
}

function bash(command: string): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: ROOT }, configFor(ROOT), probes());
}

function expectAllowed(label: string, v: FloorVerdict): void {
  expect({ label, v }).toEqual({ label, v: { action: "allow" } });
}

function expectHeld(label: string, v: FloorVerdict, category?: string): void {
  expect({ label, v }).toMatchObject({ label, v: category ? { action: "hold", category } : { action: "hold" } });
}

describe("an output option is the program's own argument", () => {
  test.each([
    `bun ${SHOT} http://localhost:5173 --out ${SHOTS}/x.png`,
    `bun ${SHOT} http://localhost:5173 --out=${SHOTS}/x.png`,
    `bun ${SHOT} http://localhost:5173 -o ${SHOTS}/x.png`,
    `bun ${SHOT} http://localhost:5173 --output ${SHOTS}/x.png`,
    `bun ${SHOT} http://localhost:5173 --out ${S}/x.png`,
    `bun ${SHOT} http://localhost:5173 --out ${ROOT}/x.png`,
    `mkdir -p ${SHOTS} && bun ${SHOT} http://localhost:5173 --out ${SHOTS}/x.png 2>&1 | tail -5`,
    `bun ${SHOT} --record http://localhost:5173 --out /tmp/x.webm`,
    "some-tool --out /tmp/x.json",
    "some-tool --out=/tmp/x.json",
    "some-tool -o /tmp/x.json",
    "some-tool --output /tmp/x.json",
    "some-tool --out $UNKNOWN/x.json",
    `bun scripts/gen.ts --out ${S}/x.json`,
    `bun scripts/gen.ts --out=${ROOT}/x.json`,
    "bun scripts/gen.ts -o /tmp/x.json",
    "bun scripts/gen.ts --output /tmp/x.json",
  ])("allows %p", (command) => {
    expectAllowed(command, bash(command));
  });
});

describe("an output path the floor can't place, handed to the install's helper", () => {
  test.each([
    `bun ${SHOT} http://localhost:5173 --out $UNKNOWN/x.png`,
    `bun ${SHOT} http://localhost:5173 --out "$UNKNOWN/x.png"`,
    `bun ${SHOT} http://localhost:5173 --out=$UNKNOWN/x.png`,
    `bun ${SHOT} http://localhost:5173 -o "$UNKNOWN/x.png"`,
    `bun ${SHOT} http://localhost:5173 --output $UNKNOWN/x.png`,
    `bun ${SHOT} --record http://localhost:5173 --out $UNKNOWN/x.webm`,
    `bun "${SHOT}" http://localhost:5173 --out "$UNKNOWN/x.png"`,
    `bun ${SHOT} http://localhost:5173 --out $UNKNOWN/x.png 2>&1 | tail -3`,
    `bun scripts/gen.ts --out $UNKNOWN/x.json`,
  ])("allows %p, as a redirect to the same path is", (command) => {
    expectAllowed(command, bash(command));
  });

  test("the same path as a redirect is allowed too", () => {
    expectAllowed("redirect", bash("echo hi > $UNKNOWN/x.png"));
  });
});

describe("what stays held", () => {
  test.each([
    [`echo hi > ${DATA}/x`, "standup-ops"],
    [`echo hi >> ${DATA}/standup.db`, undefined],
    [`bun ${SHOT} http://localhost:5173 --out ${DATA}/x.png`, "standup-ops"],
    [`bun ${SHOT} http://localhost:5173 --out=${DATA}/x.png`, "standup-ops"],
    [`bun ${SHOT} http://localhost:5173 --out ${INSTALL}/x.png`, "floor-tamper"],
    [`bun ${SHOT} http://localhost:5173 -o ${INSTALL}/x.png`, "floor-tamper"],
    [`bun ${SHOT} http://localhost:5173 --out ${DATA}/secrets/x.png`, undefined],
    [`bun scripts/gen.ts --out ${DATA}/standup.db`, "floor-tamper"],
    [`bun scripts/gen.ts --output=${INSTALL}/packages/collector/src/floor/gate.ts`, "floor-tamper"],
  ])("holds %p", (command, category) => {
    expectHeld(command, bash(command), category);
  });

  test.each([
    // A second spelling of the install, which the unplaced path may be built from.
    `X=$(cat ${INSTALL}/p); bun ${SHOT} http://localhost:5173 --out $X/x.png`,
    `bun ${SHOT} http://localhost:5173 --out "$(cat ${SHOT}.out)/x.png"`,
    `echo ${INSTALL}; bun ${SHOT} http://localhost:5173 --out $UNKNOWN/x.png`,
    `X=$(cat ${DATA}/p); bun ${SHOT} http://localhost:5173 --out "$X/x.png"`,
    `X=$(cat ${DATA}/p); bun scripts/gen.ts --out "$X/x.json"`,
    // A guarded file name the path may be built from.
    `bun ${SHOT} http://localhost:5173 --out $UNKNOWN/.ssh/x.png`,
    `bun scripts/gen.ts --out $UNKNOWN/.bashrc`,
    // A glob may match a link an earlier call left: not a value the floor couldn't expand.
    `bun ${SHOT} http://localhost:5173 --out /tmp/o/ln?.png`,
    `bun ${SHOT} http://localhost:5173 --out=/tmp/o/ln[k].png`,
    // The helper named twice: neither spelling is taken out.
    `bun ${SHOT} http://localhost:5173 --out $UNKNOWN/x.png; cat ${SHOT}`,
    // Another install script: its own path names the install, so the unplaced path stays held.
    `bun ${OTHER} --out $UNKNOWN/x.png`,
    `bun ${OTHER} -o "$UNKNOWN/x.png"`,
  ])("holds %p", (command) => {
    expectHeld(command, bash(command));
  });
});
