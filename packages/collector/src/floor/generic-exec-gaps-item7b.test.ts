import { describe, expect, test } from "bun:test";
import { classifyToolCall, parseShellSnapshot, type AwsTarget, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * Ambient AWS credentials (a prod or unknown account in the worker's env and
 * ~/.aws) matter only to a step that can reach AWS: the AWS CLI, a credential CLI, cdk,
 * code that loads an AWS SDK or signs SigV4 requests. A command that never
 * talks to AWS runs the same whatever account those credentials name. A
 * mutating AWS call under them, and a read of the credentials file, still
 * hold. The machine is virtual.
 */

const HOME = "/fake/home";
const DATA = `${HOME}/.local/share/standup`;
const ROOT = `${DATA}/worktrees/standup/feat-1`;
const INSTALL = "/fake/install";
const PROD = "777788889999";
const PERSONAL = "111122223333";

const config: FloorConfig = {
  v: 1,
  collectorUrl: "http://127.0.0.1:17777",
  launchId: "launch-1",
  root: ROOT,
  sharedBranches: ["main", "mainline"],
  personalAwsAccounts: [PERSONAL],
  waitSeconds: 60,
  standupDataDir: DATA,
  floorPaths: [`${INSTALL}/packages/collector/src/floor`],
  installDir: INSTALL,
  protectedPaths: [`${DATA}/secrets`],
  tmpDirs: ["/tmp"],
  workerToken: "x".repeat(64),
  replyPublicKey: "test",
};

/** A worker's environment: prod credentials in the env, and a PATH through the install's node_modules/.bin dirs. */
const ENV: Record<string, string> = {
  HOME,
  PATH: [
    `${ROOT}/node_modules/.bin`,
    `${INSTALL}/node_modules/.bin`,
    `${INSTALL}/packages/node_modules/.bin`,
    `${HOME}/.bun/bin`,
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].join(":"),
  AWS_PROFILE: "prod",
  AWS_REGION: "us-east-1",
  AWS_ACCESS_KEY_ID: "AKIAEXAMPLEEXAMPLE00",
  AWS_SECRET_ACCESS_KEY: "s".repeat(40),
  AWS_SESSION_TOKEN: "t".repeat(40),
};

const FILES: Record<string, string> = {
  [`${ROOT}/.git`]: "gitdir: /fake/repo/.git/worktrees/feat-1\n",
  [`${ROOT}/package.json`]: '{ "name": "x", "scripts": { "test": "bun test" } }\n',
  [`${ROOT}/packages/foo/src/a.test.ts`]: 'import { expect, test } from "bun:test";\ntest("a", () => expect(1 + 1).toBe(2));\n',
  [`${ROOT}/scripts/x.mjs`]: 'import { readFileSync } from "fs";\nconst text = readFileSync(new URL("../package.json", import.meta.url), "utf8");\nconsole.log(JSON.parse(text).name);\n',
  [`${ROOT}/scripts/s3-clean.mjs`]: 'import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";\nconst c = new S3Client({});\nawait c.send(new DeleteObjectCommand({ Bucket: "b", Key: "k" }));\n',
  [`${ROOT}/scripts/p.py`]: "import json\nprint(json.dumps({'a': 1}))\n",
  [`${ROOT}/packages/foo/src/sdk.test.ts`]: 'import { expect, mock, test } from "bun:test";\nimport { S3Client } from "@aws-sdk/client-s3";\nmock.module("@aws-sdk/client-s3", () => ({ S3Client: class { send() { return {}; } } }));\ntest("s", async () => expect(await new S3Client({}).send({} as never)).toEqual({}));\n',
  [`${HOME}/.aws/credentials`]: `[prod]\naws_access_key_id = AKIAEXAMPLEEXAMPLE00\naws_secret_access_key = ${"s".repeat(40)}\n`,
  [`${HOME}/.aws/config`]: "[profile prod]\nregion = us-east-1\n",
  [`${HOME}/.bun/bin/bun`]: "\u0000binary",
  ["/usr/bin/node"]: "\u0000binary",
  ["/usr/bin/git"]: "\u0000binary",
  ["/usr/bin/aws"]: "\u0000binary",
  ["/usr/bin/env"]: "\u0000binary",
  ["/usr/bin/ls"]: "\u0000binary",
};

/** The credential targets the awsAccount probe was asked about, since the last reset. */
let asked: AwsTarget[] = [];

function probes(account: string | null): Partial<FloorProbes> {
  const dirs = new Set<string>(["/", "/tmp", ROOT]);
  for (const f of Object.keys(FILES)) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  dirs.delete(`${ROOT}/.git`);
  const defs: ShellDefinitions = { aliases: new Map(), functions: new Map() };
  parseShellSnapshot("", defs);
  const bare = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    gitCommonDir: (dir) => (dir === ROOT ? "/fake/repo/.git" : null),
    readFile: (p) => (!(p in FILES) ? { ok: false, reason: "missing" } : FILES[p]!.startsWith("\u0000") ? { ok: false, reason: "binary" } : { ok: true, text: FILES[p]! }),
    exists: (p) => p in FILES || dirs.has(bare(p)),
    isDirectory: (p) => dirs.has(bare(p)),
    listDir: (raw) => {
      const p = bare(raw);
      return dirs.has(p) ? [...new Set([...Object.keys(FILES), ...dirs].filter((f) => f.startsWith(`${p === "/" ? "" : p}/`)).map((f) => f.slice(p.length + 1).split("/")[0]!))] : null;
    },
    realpath: (p) => (p in FILES || dirs.has(p) ? p : null),
    homeDir: () => HOME,
    shellDefinitions: () => defs,
    awsAccount: (target) => {
      asked.push(target);
      return account;
    },
    env: (name) => ENV[name],
    now: () => Date.now(),
  };
}

function bash(command: string, account: string | null): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: ROOT }, config, probes(account));
}

const NO_AWS = [
  "bun test packages/foo",
  "bun test packages/foo/src/a.test.ts",
  "git status",
  "node scripts/x.mjs",
  "bun scripts/x.mjs",
  "env -i PATH=/usr/bin:/bin bun test packages/foo",
  "AWS_PROFILE=prod bun test packages/foo",
  "ls packages",
  "export AWS_PROFILE=prod; bun test packages/foo",
  "AWS_PROFILE=prod AWS_REGION=us-east-1 node scripts/x.mjs",
  "bun run test",
  "npm test",
  "python3 scripts/p.py",
  "bun test packages/foo/src/sdk.test.ts",
  "echo $AWS_PROFILE",
  "ls ~/.aws",
  "cat ~/.aws/config",
  "env | grep -c AWS_",
  "HOME=/tmp/h bun test packages/foo",
];

describe("ambient AWS credentials and a command that never reaches AWS", () => {
  for (const [label, account] of [["a prod account", PROD], ["an account the floor can't determine", null]] as const) {
    test(`under ${label}, is allowed`, () => {
      const held = NO_AWS.map((command) => ({ command, verdict: bash(command, account) })).filter((r) => r.verdict.action !== "allow");
      expect(held).toEqual([]);
    });
  }

  test("never asks which account the credentials belong to", () => {
    const askedBy = NO_AWS.map((command) => {
      asked = [];
      bash(command, PROD);
      return { command, asked: asked.length };
    }).filter((r) => r.asked > 0);
    expect(askedBy).toEqual([]);
  });
});

describe("ambient AWS credentials and a step that reaches AWS (kept holds)", () => {
  for (const [label, account] of [["a prod account", PROD], ["an account the floor can't determine", null]] as const) {
    test(`under ${label}, a mutating AWS call holds`, () => {
      for (const command of [
        "aws s3 rm s3://bucket/key",
        "aws s3 rm s3://bucket/key --profile prod",
        "AWS_PROFILE=prod aws dynamodb delete-table --table-name t",
        "node scripts/s3-clean.mjs",
      ]) {
        const v = bash(command, account);
        expect({ command, action: v.action }).toEqual({ command, action: "hold" });
      }
    });
  }

  test("cdk deploy holds", () => {
    const v = bash("npx cdk deploy MyStack", PROD);
    expect(v.action).toBe("hold");
  });

  test("reading the shared credentials file holds as a secret", () => {
    for (const command of ["cat ~/.aws/credentials", `cat ${HOME}/.aws/credentials`, "aws configure export-credentials"]) {
      const v = bash(command, PROD);
      expect({ command, action: v.action }).toEqual({ command, action: "hold" });
    }
  });

  test("a mutating AWS call in a personal account is allowed", () => {
    expect(bash("aws s3 rm s3://bucket/key", PERSONAL)).toEqual({ action: "allow" });
  });
});
