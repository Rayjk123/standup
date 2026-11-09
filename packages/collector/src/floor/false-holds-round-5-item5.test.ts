import { describe, expect, test } from "bun:test";
import { exampleCorpProfile } from "../org-profile/fixtures/example-corp.js";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type AwsTarget, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * Commands that make no AWS call, run while AWS credentials are about: in
 * the process environment, assigned on the command line, in ~/.aws, or
 * fetched by an earlier credential CLI step. Only a real aws CLI, cdk or SDK call is
 * read for the account it acts on. Code that loads the SDK (not a type-only
 * import, not a name in its text) is read for the SDK calls it makes, by
 * their shapes. The machine is virtual and the account probe is a stub.
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

const PACKAGE_JSON = JSON.stringify({
  name: "standup",
  scripts: { test: "bun test", typecheck: "tsc --noEmit" },
  dependencies: { "@aws-sdk/client-s3": "^3.0.0" },
});
const SAFE_TEST = 'import { test, expect } from "bun:test";\ntest("adds", () => expect(1 + 1).toBe(2));\n';

/** Scripts `bun <file>` runs: what each one does with the SDK. */
const SCRIPTS: Record<string, string> = {
  // Only a type from the SDK; the code sets a map entry and sends nothing.
  "types-only.ts": [
    'import type { S3Client } from "@aws-sdk/client-s3";',
    "const seen = new Map<string, S3Client | null>();",
    'seen.set("a", null);',
    "console.log(seen.size);",
    "",
  ].join("\n"),
  // Names the SDK only in text it prints.
  "mentions.ts": ['const deps = ["@aws-sdk/client-s3", "aws-sdk"];', "const out = new Set<string>();", "for (const d of deps) out.add(d);", "console.log([...out]);", ""].join("\n"),
  // Reads with the SDK and builds a Set on the side.
  "sdk-read.ts": [
    'import { S3Client, ListBucketsCommand } from "@aws-sdk/client-s3";',
    "const s3 = new S3Client({});",
    "const names = new Set<string>();",
    "const out = await s3.send(new ListBucketsCommand({}));",
    "for (const b of out.Buckets ?? []) names.add(b.Name!);",
    "",
  ].join("\n"),
  // Deletes an object.
  "sdk-delete.ts": [
    'import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";',
    "const s3 = new S3Client({});",
    'await s3.send(new DeleteObjectCommand({ Bucket: "b", Key: "k" }));',
    "",
  ].join("\n"),
  // Writes an object through the v2 SDK's method call.
  "sdk-v2-put.js": ['const AWS = require("aws-sdk");', "const s3 = new AWS.S3();", 's3.putObject({ Bucket: "b", Key: "k", Body: "x" }).promise();', ""].join("\n"),
  // A boto3 delete.
  "boto-delete.py": ["import boto3", 's3 = boto3.client("s3")', 's3.delete_object(Bucket="b", Key="k")', ""].join("\n"),
};

const FILES: Record<string, string> = {
  [join(ROOT, ".git")]: `gitdir: ${COMMON}/worktrees/feat-1\n`,
  [join(ROOT, "package.json")]: PACKAGE_JSON,
  [join(ROOT, "src", "app.test.ts")]: SAFE_TEST,
  [join(HOME, ".aws", "config")]: "[default]\nregion = us-west-2\n",
  [join(HOME, ".aws", "credentials")]: "[default]\naws_access_key_id = AKIAEXAMPLE\naws_secret_access_key = secret\n",
  ...Object.fromEntries(Object.entries(SCRIPTS).map(([name, text]) => [join(ROOT, "scripts", name), text])),
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
function resolved(command: string, account: string): { verdict: FloorVerdict; asked: AwsTarget[] } {
  const asked: AwsTarget[] = [];
  const verdict = classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: ROOT }, config, probes(() => account, asked));
  return { verdict, asked };
}

describe("commands that make no AWS call ignore the credentials about", () => {
  const clean = [
    "AWS_PROFILE=dev bun test",
    "AWS_PROFILE=dev AWS_REGION=us-west-2 bun test src/app.test.ts",
    "export AWS_REGION=us-west-2; bun run typecheck",
    "export AWS_PROFILE=dev AWS_REGION=us-west-2 && bun test",
    "env AWS_PROFILE=x node -e 'console.log(1)'",
    "env AWS_ACCESS_KEY_ID=AKIAEXAMPLE AWS_SECRET_ACCESS_KEY=s bun --version",
    "ls ~/.aws",
    "ls -la ~/.aws/",
    "git status",
    "echo $AWS_PROFILE",
    "printenv AWS_REGION",
    "bun test",
  ];

  test.each(clean)("allows %p and asks for no account", (command) => {
    const { verdict, asked } = hook(command);
    expect(verdict).toEqual({ action: "allow" });
    expect(asked).toEqual([]);
  });

  test.each(clean)("allows %p when the credentials are another account's", (command) => {
    expect(resolved(command, OTHER_ACCOUNT).verdict).toEqual({ action: "allow" });
  });

  // An SDK named only in text loads nothing; a send of a read command the code imports from the SDK changes nothing; a Set's `.add(` is no SDK call.
  test.each(["bun scripts/mentions.ts", "bun scripts/sdk-read.ts", "AWS_PROFILE=dev bun scripts/sdk-read.ts"])("allows %p, whose SDK use changes nothing", (command) => {
    expect(hook(command).verdict).toEqual({ action: "allow" });
  });

  // A type-only import loads no SDK, so a Map's `.set(` beside it is the Map's.
  test.each(["bun scripts/types-only.ts", "AWS_PROFILE=dev bun scripts/types-only.ts"])("allows %p, which imports only the SDK's types", (command) => {
    expect(hook(command).verdict).toEqual({ action: "allow" });
    expect(resolved(command, OTHER_ACCOUNT).verdict).toEqual({ action: "allow" });
  });
});

describe("real AWS calls are still read for their account", () => {
  const mutating = [
    "AWS_PROFILE=x aws s3 rm s3://b/k",
    "aws s3 rm s3://b/k",
    "export AWS_PROFILE=x; aws s3 rm s3://b/k",
    "env AWS_PROFILE=x aws s3 rm s3://b/k",
    "bun scripts/sdk-delete.ts",
    "AWS_PROFILE=x bun scripts/sdk-delete.ts",
    "node scripts/sdk-v2-put.js",
    "python3 scripts/boto-delete.py",
  ];

  test.each(mutating)("holds %p in an unknown account", (command) => {
    expect(hook(command).verdict).toMatchObject({ action: "hold", category: "aws" });
  });

  test.each(mutating)("holds %p in another account", (command) => {
    expect(resolved(command, OTHER_ACCOUNT).verdict).toMatchObject({ action: "hold", category: "aws" });
  });

  test("cdk deploy holds", () => {
    expect(hook("cdk deploy MyStack").verdict.action).toBe("hold");
    expect(hook("AWS_PROFILE=x npx cdk deploy MyStack --require-approval never").verdict.action).toBe("hold");
  });

  test("writing the credentials file still holds", () => {
    expect(hook("echo x > ~/.aws/credentials").verdict.action).toBe("hold");
  });

  test("credentials for an account that isn't personal still hold, whatever follows", () => {
    expectHold(hook(`corp-creds credentials refresh --account ${OTHER_ACCOUNT} --role Admin; git status`).verdict);
    expect(hook(`corp-creds credentials refresh --account ${PERSONAL} --role Admin && bun test`).verdict).toEqual({ action: "allow" });
  });
});

function expectHold(v: FloorVerdict): void {
  expect(v).toMatchObject({ action: "hold", category: "aws" });
}

describe("SDK code is read for the operations it runs, not the SDK names it carries", () => {
  const run = (name: string, text: string): FloorVerdict => {
    FILES[join(ROOT, "scripts", name)] = text;
    return hook(`${name.endsWith(".py") ? "python3" : "bun"} scripts/${name}`).verdict;
  };

  // A send of a read command, and a Set's `.add(` or a Map's `.set(` beside it, change nothing.
  test("reads beside built-in methods named like a verb are allowed", () => {
    const text = [
      'import { S3Client, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";',
      "const s3 = new S3Client({});",
      'const key = process.argv[2] ?? "";',
      'if (key.startsWith("a/")) setTimeout(() => {}, 1);',
      'await s3.send(new HeadObjectCommand({ Bucket: "b", Key: key }));',
      'await s3.send(new GetObjectCommand({ Bucket: "b", Key: key }));',
      "",
    ].join("\n");
    expect(run("reads.ts", text)).toEqual({ action: "allow" });
    const collected = [
      'import type { _Object } from "@aws-sdk/client-s3"',
      'import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3"',
      "const byKey = new Map<string, _Object>()",
      "const sizes = new Set<number>()",
      'const out = await new S3Client({}).send(new ListObjectsV2Command({ Bucket: "b" }))',
      "for (const o of out.Contents ?? []) { byKey.set(o.Key!, o); sizes.add(o.Size ?? 0) }",
      "byKey.clear()",
      "",
    ].join("\n");
    expect(run("collect.ts", collected)).toEqual({ action: "allow" });
    const py = ["import boto3", 'c = boto3.client("s3")', "seen = set()", 'for o in c.list_objects_v2(Bucket="b").get("Contents", []):', '    seen.add(o["Key"])', ""].join("\n");
    expect(hook(`python3 -c '${py.replaceAll("'", "")}'`).verdict).toEqual({ action: "allow" });
  });

  const held: [string, string][] = [
    // A type and a runtime command from the same import.
    ["mixed.ts", 'import { type S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";\nexport const c = new DeleteObjectCommand({ Bucket: "b", Key: "k" });\n'],
    // The SDK loaded by a computed name.
    ["computed.js", 'const name = "@aws-sdk/client-s3";\nconst sdk = require(name);\nnew sdk.S3Client({}).send(new sdk.DeleteObjectCommand({ Bucket: "b", Key: "k" }));\n'],
    // A dynamic import.
    ["dynamic.ts", 'const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");\nawait new S3Client({}).send(new PutObjectCommand({ Bucket: "b", Key: "k", Body: "x" }));\n'],
    // A send of a command the code doesn't name.
    ["unnamed.ts", 'import * as s3 from "@aws-sdk/client-s3";\nconst C = (s3 as any)[process.argv[2]!];\nawait new s3.S3Client({}).send(new C({}));\n'],
    // A read and an unlisted mutating command sent together.
    ["route53.ts", 'import { Route53Client, ListHostedZonesCommand, ChangeResourceRecordSetsCommand } from "@aws-sdk/client-route-53";\nconst r = new Route53Client({});\nawait r.send(new ListHostedZonesCommand({}));\nawait r.send(new ChangeResourceRecordSetsCommand({ HostedZoneId: "z", ChangeBatch: { Changes: [] } }));\n'],
    // The v2 SDK's managed upload.
    ["upload.js", 'const AWS = require("aws-sdk");\nnew AWS.S3().upload({ Bucket: "b", Key: "k", Body: "x" }).promise();\n'],
    // A v3 client method named for the operation.
    ["aggregated.ts", 'import { S3 } from "@aws-sdk/client-s3";\nawait new S3({}).deleteObject({ Bucket: "b", Key: "k" });\n'],
    // A boto3 resource action.
    ["resource.py", 'import boto3\nboto3.resource("s3").Object("b", "k").delete()\n'],
    // An SQS send.
    ["sqs.py", 'import boto3\nboto3.client("sqs").send_message(QueueUrl="q", MessageBody="m")\n'],
    // The v2 DocumentClient's write, SNS publish and Lambda invoke, each named by the bare verb.
    ["docclient.js", 'const AWS = require("aws-sdk");\nnew AWS.DynamoDB.DocumentClient().put({ TableName: "t", Item: {} }).promise();\n'],
    ["publish.js", 'const AWS = require("aws-sdk");\nnew AWS.SNS().publish({ TopicArn: "t", Message: "m" }).promise();\n'],
    ["invoke.js", 'const AWS = require("aws-sdk");\nnew AWS.Lambda().invoke({ FunctionName: "f" }).promise();\n'],
    // A type alias written without semicolons before the runtime import.
    ["asi.ts", 'export type Key = string\nimport { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3"\nawait new S3Client({}).send(new DeleteObjectCommand({ Bucket: "b", Key: "k" }))\n'],
    // Operations whose names match a built-in elsewhere.
    ["sagemaker.ts", 'import { SageMaker } from "@aws-sdk/client-sagemaker";\nawait new SageMaker({}).createContext({ ContextName: "c", Source: { SourceUri: "u" } });\n'],
    ["transfer.ts", 'import { Transfer } from "@aws-sdk/client-transfer";\nawait new Transfer({}).createServer({});\n'],
    // boto3 loaded by __import__.
    ["dunder.py", 'b = __import__("boto3")\nb.client("s3").delete_object(Bucket="b", Key="k")\n'],
  ];

  test.each(held)("holds %p", (name, text) => {
    expectHold(run(name, text));
  });

  const loaders: [string, string][] = [
    // The SDK loaded through createRequire.
    ["create-require.mjs", 'import { createRequire } from "module";\nconst req = createRequire(import.meta.url);\nconst { S3 } = req("@aws-sdk/client-s3");\nawait new S3({}).deleteBucket({ Bucket: "b" });\n'],
    // require under another name.
    ["renamed-require.js", 'const req = require;\nconst { S3 } = req("@aws-sdk/client-s3");\nnew S3({}).deleteBucket({ Bucket: "b" });\n'],
    ["require-call.js", 'const { S3 } = require.call(null, "@aws-sdk/client-s3");\nnew S3({}).deleteBucket({ Bucket: "b" });\n'],
    // importlib.import_module under another name.
    ["renamed-import.py", 'import importlib\nim = importlib.import_module\nim("boto3").client("s3").delete_object(Bucket="b", Key="k")\n'],
  ];

  test.each(loaders)("holds %p, which loads the SDK under a name of its own", (name, text) => {
    expectHold(run(name, text));
  });

  const sends: [string, string][] = [
    // A read, then a command whose class the code computes.
    [
      "computed-command.ts",
      'import * as s3 from "@aws-sdk/client-s3";\nconst c = new s3.S3Client({});\nawait c.send(new s3.ListBucketsCommand({}));\nconst op = process.argv[2]!;\nconst C = (s3 as any)[op + "Command"];\nawait c.send(new C(JSON.parse(process.argv[3]!)));\n',
    ],
    // A command built by a call.
    ["built.ts", 'import { S3Client, ListBucketsCommand } from "@aws-sdk/client-s3";\nconst c = new S3Client({});\nawait c.send(new ListBucketsCommand({}));\ndeclare function build(): any;\nawait c.send(build());\n'],
    // A command held in a variable.
    ["held.ts", 'import { S3Client, ListBucketsCommand } from "@aws-sdk/client-s3";\nconst c = new S3Client({});\nconst cmd: any = JSON.parse(process.argv[2]!);\nawait c.send(new ListBucketsCommand({}));\nawait c.send(cmd);\n'],
  ];

  test.each(sends)("holds %p, whose send may carry any command", (name, text) => {
    expectHold(run(name, text));
  });

  // An import of types only loads no SDK, so a Map's `.set(` beside it is no SDK call.
  test("an import of types only is allowed beside a call named like a change", () => {
    expect(hook("bun scripts/types-only.ts").verdict).toEqual({ action: "allow" });
    expect(run("types-multi.ts", 'import type {\n  S3Client,\n  _Object,\n} from "@aws-sdk/client-s3";\nexport type { PutObjectCommandInput } from "@aws-sdk/client-s3";\nconst m = new Map<string, _Object | S3Client>();\nm.set("a", {} as _Object);\nconsole.log(m.size);\n')).toEqual({ action: "allow" });
  });

  // A send of a read command imported from the SDK, on a client with no middleware or request handler of the code's own.
  test("a send of a named read is allowed", () => {
    expect(hook("bun scripts/sdk-read.ts").verdict).toEqual({ action: "allow" });
    expect(run("ns-read.ts", 'import * as s3 from "@aws-sdk/client-s3";\nconst c = new s3.S3Client({});\nconst out = await c.send(new s3.ListBucketsCommand({}));\nconsole.log(out.Buckets?.length);\n')).toEqual({ action: "allow" });
  });

  test("inline SDK code that mutates still holds", () => {
    expectHold(hook(`node -e 'const { S3Client, DeleteObjectCommand } = require("@aws-sdk/client-s3"); new S3Client({}).send(new DeleteObjectCommand({ Bucket: "b", Key: "k" }));'`).verdict);
    expectHold(hook(`python3 -c 'import boto3; boto3.client("s3").delete_object(Bucket="b", Key="k")'`).verdict);
  });
});

describe("an SDK load is not hidden by text that reads like a type-only import, nor a mutation by a read's name", () => {
  const run = (name: string, text: string): FloorVerdict => {
    FILES[join(ROOT, "scripts", name)] = text;
    return hook(`${name.endsWith(".js") ? "node" : "bun"} scripts/${name}`).verdict;
  };
  const held: [string, string][] = [
    // A string ending in a type-only import's head, then the load in a template.
    ["type-text.js", 'const t = "import type A from "; const { S3 } = require(`@aws-sdk/client-s3`); const u = "";\nnew S3({}).deleteBucket({ Bucket: "b" });\n'],
    ["export-text.ts", 'const t = "export type A from "; const { S3Client, DeleteBucketCommand } = await import(`@aws-sdk/client-s3`); const u = "";\nawait new S3Client({}).send(new DeleteBucketCommand({ Bucket: "b" }));\n'],
    // A type-only import and a runtime one on the same line.
    ["same-line.ts", 'import type { S3Client } from "@aws-sdk/client-s3"; import { S3 } from "@aws-sdk/client-s3";\nawait new S3({}).deleteBucket({ Bucket: "b" });\n'],
    // A read's name bound to a command the code computes or picks by a string.
    ["argv-named.ts", 'import * as s3 from "@aws-sdk/client-s3";\nconst c = new s3.S3Client({});\nconst ListBucketsCommand = (s3 as any)[process.argv[2]!];\nawait c.send(new ListBucketsCommand({ Bucket: process.argv[3] }));\n'],
    ["string-named.ts", 'import * as s3 from "@aws-sdk/client-s3";\nconst c = new s3.S3Client({});\nconst GetObjectCommand = (s3 as any)["DeleteBucketCommand"];\nawait c.send(new GetObjectCommand({ Bucket: "b" }));\n'],
    // A read's name imported from a module of the code's own, or renamed from another command.
    ["local-read.ts", 'import { S3Client } from "@aws-sdk/client-s3";\nimport { ListBucketsCommand } from "./commands";\nawait new S3Client({}).send(new ListBucketsCommand({}));\n'],
    ["renamed-read.js", 'const { S3Client, ["Delete" + "BucketCommand"]: GetObjectCommand } = require("@aws-sdk/client-s3");\nnew S3Client({}).send(new GetObjectCommand({ Bucket: "b" }));\n'],
    // A namespace member assigned over, or a namespace the code doesn't import from the SDK.
    ["ns-assigned.ts", 'import * as s3 from "@aws-sdk/client-s3";\nconst c = new s3.S3Client({});\n(s3 as any).ListBucketsCommand = (s3 as any).DeleteBucketCommand;\nawait c.send(new s3.ListBucketsCommand({ Bucket: "b" }));\n'],
    ["ns-local.ts", 'import { S3Client } from "@aws-sdk/client-s3";\nimport * as cmds from "./commands";\nawait new S3Client({}).send(new cmds.ListBucketsCommand({}));\n'],
  ];

  test.each(held)("holds %p", (name, text) => {
    expectHold(run(name, text));
  });
});

describe("SDK changes inside interpolation, behind comment markers, or made by a client's middleware or handler hold", () => {
  const run = (name: string, text: string): FloorVerdict => {
    FILES[join(ROOT, "scripts", name)] = text;
    return hook(`${name.endsWith(".py") ? "python3" : "node"} scripts/${name}`).verdict;
  };
  const held: [string, string][] = [
    ["py-plain.py", 'import boto3\ns3 = boto3.client("s3")\nprint(s3.delete_bucket(Bucket="b"))\n'],
    ["py-fstring.py", 'import boto3\ns3 = boto3.client("s3")\nprint(f"{s3.delete_bucket(Bucket=\'b\')}")\n'],
    ["py-hash-triple.py", 'import boto3\ns3 = boto3.client("s3")\nx = 1#"""\ns3.delete_bucket(Bucket="b")\nx = 2#"""\n'],
    ["js-template-v2.js", 'const AWS = require("aws-sdk");\nconst s3 = new AWS.S3();\nconsole.log(`${s3.deleteBucket({ Bucket: "b" }, () => 0)}`);\n'],
    ["js-template-ns.mjs", 'import * as s3 from "@aws-sdk/client-s3";\nconst c = new s3.S3Client({});\nconsole.log(`${await c.send(new s3.DeleteBucketCommand({ Bucket: "b" }))}`);\n'],
    ["js-comment-template.js", 'const AWS = require("aws-sdk");\nconst s3 = new AWS.S3();\nlet x = 1// `\ns3.deleteBucket({ Bucket: "b" }, () => 0);\nx = 2// `\n'],
    [
      "js-middleware.mjs",
      'import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";\nconst c = new S3Client({});\nc.middlewareStack.add((next) => async (args) => { args.request.method = "DELETE"; return next(args); }, { step: "finalizeRequest" });\nawait c.send(new GetObjectCommand({ Bucket: "b", Key: "k" }));\n',
    ],
    [
      "js-handler.mjs",
      'import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";\nimport { NodeHttpHandler } from "@smithy/node-http-handler";\nconst h = new NodeHttpHandler();\nconst c = new S3Client({ requestHandler: { handle: (req, o) => { req.method = "DELETE"; return h.handle(req, o); } } });\nawait c.send(new GetObjectCommand({ Bucket: "b", Key: "k" }));\n',
    ],
  ];

  test.each(held)("holds %p", (name, text) => {
    expectHold(run(name, text));
  });
});
