import { expect, test } from "bun:test";
import { join, resolve } from "path";
import { BUDGET_MS, classifyToolCall } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * The commands every worker runs, classified against this repository itself
 * with the real probes: reading the files a test run executes must not hold
 * the repository's own suite. Paths come from this file's location, so none of
 * Standup's own path or port literals appear here.
 */

const REPO = resolve(import.meta.dir, "..", "..", "..", "..");
const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");

const config: FloorConfig = {
  v: 1,
  collectorUrl: "http://127.0.0.1:17777",
  launchId: "11111111-2222-3333-4444-555555555555",
  root: REPO,
  sharedBranches: ["main", "mainline"],
  personalAwsAccounts: [],
  waitSeconds: 60,
  standupDataDir: DATA,
  floorPaths: [join(DATA, "floor")],
  installDir: join(DATA, "install"),
  protectedPaths: [join(DATA, "secrets")],
  tmpDirs: ["/tmp"],
  workerToken: "x".repeat(64),
  replyPublicKey: "test",
};

function bash(command: string): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: REPO }, config, { gitBranch: () => "standup/feat-1", homeDir: () => HOME });
}

for (const command of [
  "bun test",
  "bun test packages/collector",
  "bun run typecheck",
  "bun test packages/collector/src/floor/classify.test.ts",
  `bun -e 'import { DEFAULT_PIPELINE } from "./packages/shared/src/pipeline.ts"; console.log(DEFAULT_PIPELINE.stages.map((s) => s.id).join(" "));'`,
]) {
  test(command, () => {
    const started = Date.now();
    const verdict = bash(command);
    expect({ command, verdict }).toEqual({ command, verdict: { action: "allow" } });
    // Inside the classifier's own budget, so a real tool call on this host is not held for time. A classification
    // that ran past the budget is already a hold above; this also counts the work after its last budget check.
    expect(Date.now() - started).toBeLessThan(BUDGET_MS);
  }, 30_000);
}

// A plain `bun test` reads every test file in the repository and the modules they import: it is allowed with half
// the budget to spare, so a host busy with other work doesn't push it into a hold. The faster of two runs is timed,
// so one stalled by that work alone doesn't fail it.
test("bun test classifies within half the budget", () => {
  const times: number[] = [];
  for (let k = 0; k < 2; k++) {
    const started = performance.now();
    expect(bash("bun test")).toEqual({ action: "allow" });
    times.push(performance.now() - started);
  }
  expect(Math.min(...times)).toBeLessThan(BUDGET_MS / 2);
}, 60_000);
