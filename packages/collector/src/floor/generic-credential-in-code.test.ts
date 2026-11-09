import { describe, expect, test } from "bun:test";
import { classifyToolCall, type FloorProbes } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";
import { exampleCorpProfile } from "../org-profile/fixtures/example-corp.js";

/*
 * A credential CLI with no handler of its own is read by its words
 * (genericCredentialCall) wherever the floor reads a command: on the
 * command line, and in code, as the text or argv a call that runs commands
 * is handed. The default profile names no credential CLI, so the reading
 * in code is the same under it as under an org's profile.
 */

const HOME = "/home/tester";
const DATA = `${HOME}/.local/share/standup`;
const ROOT = `${HOME}/code/standup-worktrees/proj/fix-1`;
const INSTALL = "/opt/standup";

// 111122223333 is the owner's personal account; 444455556666 is not.
const base: FloorConfig = {
  v: 1,
  collectorUrl: "http://localhost:7777",
  launchId: "launch-1",
  root: ROOT,
  sharedBranches: ["main"],
  personalAwsAccounts: ["111122223333"],
  waitSeconds: 60,
  standupDataDir: DATA,
  floorPaths: [`${INSTALL}/packages/collector/src/floor`],
  installDir: INSTALL,
  protectedPaths: [`${DATA}/secrets`],
  tmpDirs: ["/tmp"],
  workerToken: "x".repeat(64),
  replyPublicKey: "test",
};
const corp: FloorConfig = { ...base, orgProfile: exampleCorpProfile() };

const FILES: Record<string, string> = {
  [`${ROOT}/.git`]: "gitdir: /tmp/x\n",
  [`${ROOT}/package.json`]: '{"name":"x"}\n',
  [`${ROOT}/creds.ts`]: 'import { execSync } from "child_process";\nexecSync("some-cli credentials update --account 444455556666 --role Admin");\n',
  [`${ROOT}/creds-personal.ts`]: 'import { execSync } from "child_process";\nexecSync("some-cli credentials update --account 111122223333 --role Admin");\n',
  [`${ROOT}/creds-argv.ts`]: 'import { spawnSync } from "child_process";\nspawnSync("deploy-tool", ["--account", "444455556666", "--role", "Admin"]);\n',
  [`${ROOT}/creds-print.py`]: 'import subprocess\nsubprocess.run(["vault-creds", "show"])\n',
  [`${ROOT}/creds-data.ts`]: 'export const help = "some-cli credentials update --account 444455556666 --role Admin";\nconsole.log(help);\n',
};
const DIRS = new Set<string>([ROOT, "/tmp", "/", HOME, INSTALL]);
for (const f of [...Object.keys(FILES), ...DIRS]) {
  for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) DIRS.add(d);
}

function probes(): Partial<FloorProbes> {
  return {
    gitBranch: () => "fix-1",
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
}

const bash = (command: string, config: FloorConfig): FloorVerdict => classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: ROOT }, config, probes());
const category = (v: FloorVerdict) => (v.action === "hold" ? v.category : v.action);

const CASES: Array<[string, string]> = [
  // Text a call that runs commands is handed.
  [`python3 -c 'import subprocess; subprocess.run("some-cli credentials update --account 444455556666 --role Admin", shell=True)'`, "aws"],
  [`python3 -c 'import subprocess; subprocess.run("some-cli credentials update --account 111122223333 --role Admin", shell=True)'`, "allow"],
  [`python3 -c 'import subprocess; subprocess.run("some-cli credentials update --account 444455556666 --role ReadOnly", shell=True)'`, "allow"],
  [`python3 -c 'import os; os.system("deploy-tool --account-id=444455556666 --role-name=Admin")'`, "aws"],
  [`python3 -c 'import os; os.system("cloud-creds refresh")'`, "aws"],
  [`node -e 'require("child_process").execSync("some-cli credentials show")'`, "floor-tamper"],
  [`node -e 'require("child_process").execSync("tool export-credentials --format env")'`, "floor-tamper"],
  [`node -e 'require("child_process").execSync("some-vault exec --role Admin -- ls")'`, "aws"],
  // An argv a call that runs commands is handed.
  [`python3 -c 'import subprocess; subprocess.run(["some-cli", "credentials", "update", "--account", "444455556666", "--role", "Admin"])'`, "aws"],
  [`python3 -c 'import subprocess; subprocess.run(["some-cli", "credentials", "update", "--account", "111122223333", "--role", "Admin"])'`, "allow"],
  [`python3 -c 'import subprocess; subprocess.run(["docker-credential-pass", "get"])'`, "floor-tamper"],
  // Files a runner executes: the commands their calls are handed.
  ["bun creds.ts", "aws"],
  ["bun creds-personal.ts", "allow"],
  ["bun creds-argv.ts", "aws"],
  ["python3 creds-print.py", "floor-tamper"],
  // A data-only program prints the words, as on the command line.
  [`python3 -c 'import os; os.system("echo some-cli credentials show")'`, "allow"],
  // Words with no credential reading are no credential call.
  [`python3 -c 'import os; os.system("some-cli build --verbose")'`, "allow"],
  // A string no call that runs commands is handed is the code's text.
  [`python3 -c 'print("some-cli credentials show")'`, "allow"],
  ["bun creds-data.ts", "allow"],
];

describe("the generic credential reading applies to commands found in code", () => {
  for (const [label, config] of [
    ["the default profile", base],
    ["an org profile", corp],
  ] as const) {
    test(`under ${label}`, () => {
      for (const [command, expected] of CASES) expect([command, category(bash(command, config))]).toEqual([command, expected]);
    });
  }

  test("the hold names the credential call it read", () => {
    const v = bash(`python3 -c 'import os; os.system("some-cli credentials update --account 444455556666 --role Admin")'`, base);
    expect(v.action === "hold" && v.reason).toContain("some-cli credentials update");
  });
});
