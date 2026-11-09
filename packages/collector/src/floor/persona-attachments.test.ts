import { describe, expect, test } from "bun:test";
import { classifyToolCall, type FloorProbes } from "./classify.js";
import { decodeFloorConfig, encodeFloorConfig, type FloorCategory, type FloorVerdict } from "./gate.js";
import { buildLaunchFloorConfig } from "./launch.js";

/*
 * The owner's media uploads to Persona (`<dataDir>/persona-attachments/`) are
 * a private path: reading or listing one is held for Persona (standup-ops,
 * not owner-reserved) through the same checks as the protected paths. The
 * protected-path, DB and data-dir checks run first and win, so a path that
 * climbs out of the folder keeps its own category. Known limit: an
 * unfiltered walk from above the data dir (`ls -R ~`) can show upload names;
 * their contents are guarded by the read hold.
 */

const HOME = "/home/tester";
const DATA = `${HOME}/.local/share/standup`;
const ROOT = `${DATA}/worktrees/standup/feat-1`;
const ATT = `${DATA}/persona-attachments`;
const SHA = "0123456789abcdef".repeat(4);
const PNG = `${ATT}/${SHA}.png`;
const SECRET = `${DATA}/secrets/owner-token`;
const MEDIA_REASON = "reads an owner media upload in persona-attachments";

const config = buildLaunchFloorConfig(
  { launchId: "launch-1", root: ROOT, workerToken: "x".repeat(64), replyPublicKey: "test" },
  { DB_PATH: `${DATA}/standup.db`, HOME }
);

const FILES: Record<string, string> = {
  [PNG]: "png",
  [`${DATA}/standup.db`]: "db",
  [SECRET]: "t",
  [`${DATA}/worker-tokens/launch-2`]: "t",
  [`${DATA}/review-media/${SHA}.png`]: "png",
  [`${ROOT}/a.png`]: "png",
};
const DIRS = new Set<string>(["/", "/tmp", ROOT, ATT]);
for (const f of Object.keys(FILES)) {
  for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) DIRS.add(d);
}

const probes: Partial<FloorProbes> = {
  gitBranch: () => "standup/feat-1",
  gitAlias: () => null,
  gitHooksDir: () => null,
  readFile: (p) => (p in FILES ? { ok: true, text: FILES[p]! } : { ok: false, reason: "missing" }),
  exists: (p) => p in FILES || DIRS.has(p),
  isDirectory: (p) => DIRS.has(p),
  listDir: () => [],
  realpath: (p) => (p in FILES || DIRS.has(p) ? p : null),
  homeDir: () => HOME,
  shellDefinitions: () => ({ aliases: new Map(), functions: new Map() }),
  awsAccount: () => null,
  now: () => Date.now(),
};

const bash = (command: string, cwd = ROOT): FloorVerdict => classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd }, config, probes);
const tool = (toolName: string, toolInput: Record<string, unknown>): FloorVerdict => classifyToolCall({ toolName, toolInput, cwd: ROOT }, config, probes);

function expectHold(v: FloorVerdict, category: FloorCategory): void {
  expect(v).toMatchObject({ action: "hold", category });
}

function expectReserved(v: FloorVerdict): void {
  expect(v).toMatchObject({ action: "hold", category: "floor-tamper", ownerReserved: true });
}

describe("the owner's media uploads", () => {
  test("the folder is a private path held as standup-ops, not a protected one", () => {
    expect(config.privatePaths?.filter((p) => p.path === ATT)).toEqual([{ path: ATT, category: "standup-ops", reason: expect.stringContaining(MEDIA_REASON) }]);
    expect(config.protectedPaths).not.toContain(ATT);
  });

  test("the config decoder takes only known categories for a private path", () => {
    expect(decodeFloorConfig(encodeFloorConfig(config)).privatePaths).toEqual(config.privatePaths);
    const forged = { ...config, privatePaths: [{ path: ATT, category: "allow", reason: "x" }] };
    expect(() => decodeFloorConfig(Buffer.from(JSON.stringify(forged), "utf8").toString("base64url"))).toThrow(
      "malformed safety-floor config"
    );
  });

  const reads: Array<[string, () => FloorVerdict]> = [
    ["Read of an upload", () => tool("Read", { file_path: PNG })],
    ["Read through ~", () => tool("Read", { file_path: `~/.local/share/standup/persona-attachments/${SHA}.png` })],
    ["Grep of the folder", () => tool("Grep", { pattern: "x", path: ATT })],
    ["Glob in the folder", () => tool("Glob", { pattern: "*.png", path: ATT })],
    ["Glob with an absolute pattern", () => tool("Glob", { pattern: `${ATT}/*` })],
    ["LS of the folder", () => tool("LS", { path: ATT })],
    ["cat", () => bash(`cat ${PNG}`)],
    ["head", () => bash(`head -c 64 ${PNG}`)],
    ["cp out", () => bash(`cp ${PNG} ${ROOT}/x.png`)],
    ["a `<` redirect", () => bash(`file - < ${PNG}`)],
    ["ls of the folder", () => bash(`ls -la ${ATT}`)],
    ["ls through ~", () => bash("ls ~/.local/share/standup/persona-attachments")],
    ["a shell glob", () => bash(`ls ${ATT}/*`)],
    ["grep -r from inside the folder", () => bash("grep -r x", ATT)],
    ["ls from inside the folder", () => bash("ls", ATT)],
    ["a bare name from inside the folder", () => bash(`cat ${SHA}.png`, ATT)],
  ];
  for (const [name, run] of reads) {
    test(`${name} is held for Persona with the media reason`, () => {
      const v = run();
      expectHold(v, "standup-ops");
      if (v.action === "hold") {
        expect(v.ownerReserved).toBeUndefined();
        expect(v.reason).toContain(MEDIA_REASON);
      }
    });
  }

  test("a write into the folder stays standup-ops, as on mainline", () => {
    expectHold(tool("Write", { file_path: PNG, content: "x" }), "standup-ops");
    expectHold(tool("Write", { file_path: `${ATT}/${"1".repeat(64)}.png`, content: "x" }), "standup-ops");
    expectHold(bash(`cp ${ROOT}/a.png ${ATT}/${"1".repeat(64)}.png`), "standup-ops");
  });

  test("walks from above the data dir stay allowed, as on mainline; listing the data dir itself is Persona's to allow", () => {
    for (const command of ["ls -R ~", "du -a ~", "find ~ -type f", "find ~ -name notes.txt"]) expect(bash(command)).toEqual({ action: "allow" });
    expect(bash(`cat ${ROOT}/a.png`)).toEqual({ action: "allow" });
    expectHold(bash(`ls ${DATA}`), "standup-ops");
  });
});

describe("paths that climb out of the folder keep their own category", () => {
  const climbs: Array<[string, () => FloorVerdict]> = [
    ["Read of the DB through the folder", () => tool("Read", { file_path: `${ATT}/../standup.db` })],
    ["cat of the DB through the folder", () => bash(`cat ${ATT}/../standup.db`)],
    ["cp of the DB through the folder", () => bash(`cp ${ATT}/../standup.db ${ROOT}/x.db`)],
    ["a secret through the folder", () => bash(`cat ${ATT}/../secrets/owner-token`)],
    ["a worker token through the folder", () => bash(`cat ${ATT}/../worker-tokens/launch-2`)],
    ["review media through the folder", () => tool("Read", { file_path: `${ATT}/../review-media/${SHA}.png` })],
    ["code climbing out of a literal", () => bash(`python3 -c "open('${ATT}/../standup.db')"`)],
    ["code joining a climb onto the folder", () => bash(`python3 -c "d='${ATT}'; open(d+'/../standup.db')"`)],
    ["code taking the folder's parent", () => bash(`python3 -c "import os; open(os.path.dirname(os.path.dirname('${PNG}'))+'/standup.db')"`)],
    ["code naming an upload and the DB", () => bash(`python3 -c "open('${PNG}'); open('${DATA}/standup.db')"`)],
    ["code cutting the folder off a path", () => bash(`python3 -c "d='${ATT}'; open(d.rsplit('/',1)[0]+'/stan'+'dup.db')"`)],
    // Code naming an upload could climb back out of it in ways a literal scan can't follow, so it keeps mainline's DB hold.
    ["python naming an upload", () => bash(`python3 -c "print(open('${PNG}','rb').read(4))"`)],
    ["node naming an upload", () => bash(`node -e "require('fs').readFileSync('${PNG}')"`)],
  ];
  for (const [name, run] of climbs) {
    test(`${name} stays owner-reserved`, () => expectReserved(run()));
  }

  test("secrets, worker tokens, review media and the DB are unchanged", () => {
    expectReserved(tool("Read", { file_path: SECRET }));
    expectReserved(tool("Read", { file_path: `${DATA}/worker-tokens/launch-2` }));
    expectReserved(tool("Read", { file_path: `${DATA}/review-media/${SHA}.png` }));
    expectReserved(tool("Read", { file_path: `${DATA}/standup.db` }));
    expectReserved(tool("Grep", { pattern: "x", path: DATA }));
    expectHold(tool("Write", { file_path: `${DATA}/internal/persona/state.json`, content: "x" }), "floor-tamper");
  });
});
