import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { exampleCorpProfile } from "../org-profile/fixtures/example-corp.js";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { classifyToolCall, type FloorProbes } from "./classify.js";
import { OWNER_ONLY_CATEGORIES } from "./gate.js";
import type { FloorCategory, FloorConfig, FloorVerdict } from "./gate.js";

/*
 * How the safety floor treats the pipeline's screenshot helper, against a real
 * scratch layout: a temp worktree holding a copy of scripts/pipeline-screenshot.ts,
 * a fake Standup data dir, and a fake secrets dir as the protected path (never
 * the real one).
 *
 * The floor does not judge the URL a local command fetches: the helper is
 * allowed with a remote URL just as with a local one, and it is the helper
 * itself that refuses anything but loopback, data: and in-root file: pages
 * (scripts/pipeline-screenshot.test.ts). What the floor does catch is a
 * command naming the protected secrets, whichever argument names it. The
 * outward steps the pipeline sequences (cdk deploy, the org's review CLI) keep the holds they
 * have without a pipeline.
 */

const SCRIPT_SOURCE = resolve(import.meta.dir, "../../../../scripts/pipeline-screenshot.ts");

let base: string;
let secrets: string;
let root: string;
let config: FloorConfig;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "floor-shot-")));
  const data = join(base, "data");
  const install = join(base, "install");
  root = join(data, "worktrees", "standup", "feat-1");
  secrets = join(data, "secrets");
  for (const d of [join(root, "scripts"), join(install, "scripts"), secrets, join(install, "packages/collector/src/floor"), join(base, "home")]) {
    mkdirSync(d, { recursive: true });
  }
  writeFileSync(join(secrets, "owner-secret"), "not-a-real-secret\n");
  writeFileSync(join(root, "scripts", "pipeline-screenshot.ts"), readFileSync(SCRIPT_SOURCE, "utf8"));
  writeFileSync(join(install, "scripts", "pipeline-screenshot.ts"), readFileSync(SCRIPT_SOURCE, "utf8"));
  writeFileSync(join(root, ".git"), `gitdir: ${join(base, "repo.git")}\n`);
  config = {
    v: 1,
    orgProfile: exampleCorpProfile(),
    collectorUrl: "http://localhost:7777",
    launchId: "launch-1",
    root,
    sharedBranches: ["main", "mainline"],
    personalAwsAccounts: [],
    waitSeconds: 60,
    standupDataDir: data,
    floorPaths: [join(install, "packages/collector/src/floor")],
    installDir: install,
    protectedPaths: [secrets],
    tmpDirs: ["/tmp"],
    workerToken: "x".repeat(64),
    replyPublicKey: "test",
  };
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

/** Real filesystem reads; git, the shell snapshot, the home dir and AWS are pinned so the user's own setup can't leak in. */
function probes(): Partial<FloorProbes> {
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    homeDir: () => join(base, "home"),
    shellDefinitions: () => ({ aliases: new Map(), functions: new Map() }),
    awsAccount: () => null,
  };
}

const bash = (command: string): FloorVerdict =>
  classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: root }, config, probes());

function expectHold(v: FloorVerdict, category: FloorCategory, ownerOnly: boolean): void {
  expect(v.action).toBe("hold");
  if (v.action !== "hold") return;
  expect(v.category).toBe(category);
  expect(v.ownerOnly).toBe(ownerOnly);
  expect(OWNER_ONLY_CATEGORIES.has(v.category)).toBe(ownerOnly);
}

describe("the floor and the pipeline screenshot helper", () => {
  test("protectedPaths is the scratch secrets dir, not the real one", () => {
    expect(config.protectedPaths).toEqual([secrets]);
    expect(secrets.startsWith(base)).toBe(true);
  });

  // The worker's own copy is read as code: it renames and deletes its staged
  // capture one file at a time and names /tmp only as a page root, which
  // counts as no write to /tmp while the copy reads byte for byte as the
  // install's. Its --out is read as the file it saves
  // (false-holds-round-6-item4.test.ts). The install's copy, run as shipped,
  // is allowed too (screenshot-install.test.ts).
  test("a local capture into /tmp with the worker's own copy is allowed", () => {
    expect(bash("bun scripts/pipeline-screenshot.ts http://localhost:5173/x --out /tmp/standup-screenshots-1000/a.png")).toEqual({ action: "allow" });
  });

  test("the worker's copy changed from the install's, naming /tmp, holds", () => {
    const path = join(root, "scripts", "pipeline-screenshot.ts");
    const shipped = readFileSync(SCRIPT_SOURCE, "utf8");
    writeFileSync(path, `${shipped}\nimport { readdirSync as _r, unlinkSync as _u } from "fs";\nfor (const f of _r("/tmp")) _u(join("/tmp", f));\n`);
    try {
      expectHold(bash("bun scripts/pipeline-screenshot.ts http://localhost:5173/x --out /tmp/standup-screenshots-1000/a.png"), "destructive", false);
    } finally {
      writeFileSync(path, shipped);
    }
  });

  test("a remote URL is no different to the floor; the helper is what refuses it", () => {
    expect(bash("bun scripts/pipeline-screenshot.ts https://example.com/?d=secret --out /tmp/standup-screenshots-1000/a.png")).toEqual({ action: "allow" });
  });

  test("naming the protected secrets is floor-tamper, as the URL or as the output", () => {
    expectHold(bash(`bun scripts/pipeline-screenshot.ts file://${secrets}/owner-secret --out /tmp/a.png`), "floor-tamper", true);
    expectHold(bash(`bun scripts/pipeline-screenshot.ts http://localhost:5173/ --out ${secrets}/a.png`), "floor-tamper", true);
    expectHold(bash(`cat ${secrets}/owner-secret`), "floor-tamper", true);
  });
});

describe("outward steps the pipeline sequences keep their floor holds", () => {
  test("cdk deploy is an owner-only outward hold", () => {
    const v = bash("cdk deploy MyStack");
    expectHold(v, "outward", true);
    expect(v.action === "hold" && v.reason).toContain("cdk deploy");
  });

  test("the org's review CLI is a review hold (not owner-only)", () => {
    const v = bash("corp-review --draft --issue X");
    expectHold(v, "review", false);
    expect(v.action === "hold" && v.reason).toContain("code review");
  });
});
