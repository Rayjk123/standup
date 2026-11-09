import { describe, expect, test } from "bun:test";
import { exampleCorpProfile } from "../org-profile/fixtures/example-corp.js";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type AwsTarget, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * Code that names an AWS SDK only as text (a package it checks for, a message
 * it prints) while AWS credentials are about. Such a name counts as an SDK
 * load only where the code can load a module by a computed name: Python's
 * `__import__`, `importlib` or a `getattr` that may reach a loader, JS's
 * `require` used other than with a literal or for `require.resolve(…)`. The
 * machine is virtual and the account probe is a stub.
 */

const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
const COMMON = join("/", "fake", "repo", ".git");
const PERSONAL = "111111111111";
const OTHER_ACCOUNT = "999999999999";

const config: FloorConfig = {
  v: 1,
  orgProfile: exampleCorpProfile(),
  collectorUrl: "http://127.0.0.1:17777",
  launchId: "launch-1",
  root: ROOT,
  sharedBranches: ["main", "mainline"],
  personalAwsAccounts: [PERSONAL],
  waitSeconds: 60,
  standupDataDir: DATA,
  floorPaths: [join(INSTALL, "packages", "collector", "src", "floor")],
  installDir: INSTALL,
  protectedPaths: [join(DATA, "secrets")],
  tmpDirs: ["/tmp"],
  workerToken: "x".repeat(64),
  replyPublicKey: "test",
};

/** Scripts that name an SDK only as text, and make no AWS call. */
const CLEAN: Record<string, string> = {
  // Asks pip about boto3 and reads its own attribute by a plain name.
  "pip-show.py": [
    "import subprocess, sys",
    'subprocess.run([sys.executable, "-m", "pip", "show", "boto3"])',
    "class A:",
    "    def f(self):",
    '        return getattr(self, "name", None)',
    "print(A().f())",
    "",
  ].join("\n"),
  // Reads and sets parsed arguments by plain names beside a message naming the SDK.
  "args.py": [
    "import argparse, subprocess",
    "p = argparse.ArgumentParser()",
    'p.add_argument("--verbose", action="store_true")',
    "ns = p.parse_args()",
    'if getattr(ns, "verbose"):',
    '    print("boto3 and botocore are optional here")',
    'setattr(ns, "count", 1)',
    'subprocess.run(["git", "status"])',
    "",
  ].join("\n"),
  // Looks up where the SDK packages would resolve from, then messages a child process.
  "resolve.js": [
    'const { fork } = require("child_process");',
    'const mods = ["@aws-sdk/client-s3", "aws-sdk"];',
    "for (const m of mods) {",
    "  try { console.log(require.resolve(m)); } catch { console.log(`${m} missing`); }",
    "}",
    'console.log(require.resolve.paths("aws-sdk"));',
    'const child = fork("./worker.js");',
    "child.send({ ok: true });",
    "",
  ].join("\n"),
  "worker.js": 'process.on("message", (m) => console.log(m));\n',
};

/** Scripts that load the SDK by a computed name and change AWS resources. */
const HELD: Record<string, string> = {
  "importlib.py": ["import importlib, subprocess", 'subprocess.run(["true"])', 'importlib.import_module("boto3").client("s3").delete_bucket(Bucket="b")', ""].join("\n"),
  "builtins.py": ['b = getattr(__builtins__, "__import__")("boto3")', 'b.client("s3").delete_bucket(Bucket="b")', ""].join("\n"),
  "sys-modules.py": ["import sys", 'imp = getattr(sys.modules["builtins"], "__import__")', 'imp("boto3").client("s3").delete_bucket(Bucket="b")', ""].join("\n"),
  // A loader reached only through getattr: by a name built from pieces, by a loader's own name, or through an alias of getattr.
  "getattr-built.py": ["import pkgutil", 'r = getattr(pkgutil, "resolve_" + "name")', 'r("boto3").client("s3").delete_bucket(Bucket="b")', ""].join("\n"),
  "getattr-loader.py": ["import pkgutil", 'r = getattr(pkgutil, "resolve_name")', 'r("boto3").client("s3").delete_bucket(Bucket="b")', ""].join("\n"),
  "getattr-alias.py": ["import pkgutil", "ga = getattr", 'r = ga(pkgutil, "resolve_name")', 'r("boto3").client("s3").delete_bucket(Bucket="b")', ""].join("\n"),
  "getattr-computed.py": ["import pkgutil, sys", "r = getattr(pkgutil, sys.argv[1])", 'r("boto3").client("s3").delete_bucket(Bucket="b")', ""].join("\n"),
  // A module that loads modules, its locator reached by getattr of any name or called directly.
  "pydoc-getattr.py": ["import pydoc", 'c = getattr(pydoc, "locate")("boto3").client("s3")', 'c.delete_bucket(Bucket="b")', ""].join("\n"),
  "pydoc-locate.py": ["import pydoc", 'pydoc.locate("boto3").client("s3").delete_bucket(Bucket="b")', ""].join("\n"),
  "pydoc-alias.py": ["from pydoc import locate as find_it", 'find_it("boto3").client("s3").delete_bucket(Bucket="b")', ""].join("\n"),
  "pkgutil-resolve.py": ["import pkgutil", 'pkgutil.resolve_name("boto3").client("s3").delete_bucket(Bucket="b")', ""].join("\n"),
  "sys-getattr.py": ["import sys", 'g = getattr(sys, "_getframe")', 'g(0).f_builtins["__im" + "port__"]("boto3").client("s3").delete_bucket(Bucket="b")', ""].join("\n"),
  // A path require.resolve finds, then loaded.
  "resolve-load.js": ['const p = require.resolve("@aws-sdk/client-s3");', "const { S3 } = require(p);", 'new S3({}).deleteBucket({ Bucket: "b" });', ""].join("\n"),
  // require.resolve beside a load through require.main.
  "resolve-main.js": ['const name = "@aws-sdk/client-s3";', "require.resolve(name);", "const { S3 } = require.main.require(name);", 'new S3({}).deleteBucket({ Bucket: "b" });', ""].join("\n"),
  // require.resolve replaced by require, then called.
  "resolve-swapped.js": ["require.resolve = require;", 'const { S3 } = require.resolve("@aws-sdk/client-s3");', 'new S3({}).deleteBucket({ Bucket: "b" });', ""].join("\n"),
  // A direct SDK change.
  "direct.py": ["import boto3", 'boto3.client("s3").delete_bucket(Bucket="b")', ""].join("\n"),
};

const FILES: Record<string, string> = {
  [join(ROOT, ".git")]: `gitdir: ${COMMON}/worktrees/feat-1\n`,
  [join(ROOT, "package.json")]: JSON.stringify({ name: "x", scripts: { test: "bun test" } }),
  [join(HOME, ".aws", "config")]: "[default]\nregion = us-west-2\n",
  [join(HOME, ".aws", "credentials")]: "[default]\naws_access_key_id = AKIAEXAMPLE\naws_secret_access_key = secret\n",
  ...Object.fromEntries(Object.entries({ ...CLEAN, ...HELD }).map(([name, text]) => [join(ROOT, "scripts", name), text])),
};

/** The process environment: credentials and a profile, as after `corp-creds credentials refresh`. */
const AMBIENT: Record<string, string> = {
  HOME,
  AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
  AWS_SECRET_ACCESS_KEY: "secret",
  AWS_SESSION_TOKEN: "token",
  AWS_PROFILE: "dev",
  AWS_REGION: "us-west-2",
};

function probes(account: (t: AwsTarget) => string | null, asked: AwsTarget[]): Partial<FloorProbes> {
  const dirs = new Set<string>(["/", "/tmp", ROOT]);
  for (const f of Object.keys(FILES)) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
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
    isDirectory: (p) => dirs.has(p),
    executable: () => false,
    listDir: (p) => (dirs.has(p) ? [...new Set([...Object.keys(FILES), ...dirs].filter((f) => f.startsWith(`${p === "/" ? "" : p}/`)).map((f) => f.slice(p.length + 1).split("/")[0]!))] : null),
    realpath: (p) => (p in FILES || dirs.has(p) ? p : null),
    lstat: (p) => (p in FILES ? { symlink: false, file: true, nlink: 1 } : dirs.has(p) ? { symlink: false, file: false, nlink: 1 } : null),
    homeDir: () => HOME,
    shellDefinitions: () => defs,
    awsAccount: (t) => {
      asked.push(t);
      return account(t);
    },
    env: (name) => AMBIENT[name],
    now: () => Date.now(),
    gitTree: () => null,
    gitAncestor: () => null,
    gitBlob: () => ({ ok: false, reason: "missing" }),
  };
}

/** The verdict with the account unknown (the hook), plus every credential the classifier asked about. */
function hook(command: string): { verdict: FloorVerdict; asked: AwsTarget[] } {
  const asked: AwsTarget[] = [];
  const verdict = classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: ROOT }, config, probes(() => null, asked));
  return { verdict, asked };
}

/** The verdict with the credentials resolving to `account` (the collector's re-classification). */
function resolved(command: string, account: string): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: ROOT }, config, probes(() => account, []));
}

function run(name: string): string {
  return `${name.endsWith(".py") ? "python3" : "node"} scripts/${name}`;
}

describe("code that names an AWS SDK only as text makes no AWS call", () => {
  const clean = Object.keys(CLEAN)
    .filter((n) => n !== "worker.js")
    .flatMap((n) => [run(n), `AWS_PROFILE=dev ${run(n)}`, `env AWS_PROFILE=dev AWS_REGION=us-west-2 ${run(n)}`]);

  test.each(clean)("allows %p and asks for no account", (command) => {
    const { verdict, asked } = hook(command);
    expect(verdict).toEqual({ action: "allow" });
    expect(asked).toEqual([]);
  });

  test.each(clean)("allows %p when the credentials are another account's", (command) => {
    expect(resolved(command, OTHER_ACCOUNT)).toEqual({ action: "allow" });
  });

  test("inline code naming the SDK as text is allowed", () => {
    expect(hook(`python3 -c 'import subprocess, platform; subprocess.run(["pip", "show", "boto3"]); print(getattr(platform, "system")())'`).verdict).toEqual({ action: "allow" });
    expect(hook(`node -e 'try { console.log(require.resolve("@aws-sdk/client-s3")) } catch { process.exitCode = 1 }'`).verdict).toEqual({ action: "allow" });
  });
});

describe("SDK code loaded by a computed name, and real AWS calls, still hold", () => {
  test.each(Object.keys(HELD).map(run))("holds %p in an unknown account", (command) => {
    expect(hook(command).verdict).toMatchObject({ action: "hold", category: "aws" });
  });

  test.each(Object.keys(HELD).map(run))("holds %p in another account", (command) => {
    expect(resolved(command, OTHER_ACCOUNT)).toMatchObject({ action: "hold", category: "aws" });
  });

  test("inline code loading the SDK by a computed name holds", () => {
    expect(hook(`python3 -c 'import importlib; importlib.import_module("boto3").client("s3").delete_bucket(Bucket="b")'`).verdict).toMatchObject({ action: "hold", category: "aws" });
    expect(hook(`python3 -c 'import pydoc; c = getattr(pydoc, "locate")("boto3").client("s3"); c.delete_bucket(Bucket="b")'`).verdict).toMatchObject({ action: "hold", category: "aws" });
    expect(hook(`python3 -c 'import pydoc; c = pydoc.locate("boto3").client("s3"); c.delete_bucket(Bucket="b")'`).verdict).toMatchObject({ action: "hold", category: "aws" });
    expect(hook(`python3 -c 'import sys; getattr(sys, "_getframe")(0).f_builtins["__im" + "port__"]("boto3").client("s3").delete_bucket(Bucket="b")'`).verdict).toMatchObject({ action: "hold", category: "aws" });
    expect(hook(`python3 -c 'import pkgutil; pkgutil.resolve_name("boto3").client("s3").delete_bucket(Bucket="b")'`).verdict).toMatchObject({ action: "hold", category: "aws" });
    expect(hook(`node -e 'const n = "@aws-sdk/client-s3"; require.resolve(n); const { S3 } = require(n); new S3({}).deleteBucket({ Bucket: "b" })'`).verdict).toMatchObject({ action: "hold", category: "aws" });
  });

  test.each(["aws s3 rm s3://b/k", "AWS_PROFILE=x aws s3 rm s3://b/k", "env AWS_PROFILE=x aws s3 rm s3://b/k"])("holds %p", (command) => {
    expect(hook(command).verdict).toMatchObject({ action: "hold", category: "aws" });
  });

  test("code that runs the aws CLI holds", () => {
    expect(hook(`python3 -c 'import subprocess; subprocess.run(["aws", "s3", "rm", "s3://b/k"])'`).verdict).toMatchObject({ action: "hold" });
  });

  test("credentials for an account that isn't personal hold", () => {
    expect(hook(`corp-creds credentials refresh --account ${OTHER_ACCOUNT} --role Admin; python3 scripts/pip-show.py`).verdict).toMatchObject({ action: "hold", category: "aws" });
    expect(hook(`corp-creds credentials refresh --account ${PERSONAL} --role Admin; python3 scripts/pip-show.py`).verdict).toEqual({ action: "allow" });
  });
});
