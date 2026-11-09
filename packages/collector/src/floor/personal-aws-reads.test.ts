import { describe, expect, test } from "bun:test";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import { floorQuestion, type FloorCall, type FloorConfig, type FloorHold, type FloorVerdict } from "./gate.js";
import { personalAccountHold, stricterHold } from "./routes.js";

/*
 * The worker's shell holds credentials for the owner's personal AWS account.
 * The hook never resolves credentials, so it sees an account it can't
 * determine; the collector resolves them to the personal account. An AWS CLI
 * read runs under either view. A change, a signed request the floor can't
 * read as only a read, and an operation it can't name stay held: the hook
 * holds them as owner-only `aws`, and the collector relabels the hold as
 * Persona's `personal-aws` with the hook's own description of the step.
 * The machine is virtual.
 */

const HOME = "/fake/home";
const DATA = `${HOME}/.local/share/standup`;
const ROOT = `${DATA}/worktrees/standup/feat-1`;
const INSTALL = "/fake/install";
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

/** The personal account's credentials in the worker's env. */
const ENV: Record<string, string> = {
  HOME,
  PATH: "/usr/local/bin:/usr/bin:/bin",
  AWS_REGION: "us-west-2",
  AWS_ACCESS_KEY_ID: "AKIAEXAMPLEEXAMPLE00",
  AWS_SECRET_ACCESS_KEY: "s".repeat(40),
  AWS_SESSION_TOKEN: "t".repeat(40),
};

/** A SigV4 signer that takes its HTTP method and path from argv. */
const SIGNER = [
  "import sys, json, requests, boto3",
  "from botocore.auth import SigV4Auth",
  "from botocore.awsrequest import AWSRequest",
  "method, path = sys.argv[1], sys.argv[2]",
  'url = "https://abc123.execute-api.us-west-2.amazonaws.com/prod" + path',
  "creds = boto3.Session().get_credentials()",
  "req = AWSRequest(method=method, url=url)",
  'SigV4Auth(creds, "execute-api", "us-west-2").add_auth(req)',
  "r = requests.request(method, url, headers=dict(req.headers))",
  "print(r.text)",
  "",
].join("\n");

const FILES: Record<string, string> = {
  [`${ROOT}/.git`]: "gitdir: /fake/repo/.git/worktrees/feat-1\n",
  ["/tmp/x/dp.py"]: SIGNER,
  ["/tmp/x/poll.sh"]: '#!/bin/bash\nfor i in 1 2 3; do\n  python -I /tmp/x/dp.py GET "/batches/$1?status=done"\n  sleep 5\ndone\n',
  ["/usr/bin/aws"]: "\u0000binary",
  ["/usr/bin/python"]: "\u0000binary",
  ["/usr/bin/bash"]: "\u0000binary",
  ["/bin/bash"]: "\u0000binary",
};

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
    awsAccount: () => account,
    env: (name) => ENV[name],
    now: () => Date.now(),
  };
}

const call = (command: string): FloorCall => ({ toolName: "Bash", toolInput: { command }, cwd: ROOT });
const classify = (c: FloorCall, cfg: FloorConfig, account: string | null): FloorVerdict => classifyToolCall(c, cfg, probes(account));

/** What the hook decides (it never resolves credentials), and the hold the collector raises for it once they resolve to the personal account. */
function decided(command: string): { hook: FloorVerdict; raised: FloorHold | null } {
  const c = call(command);
  const hook = classify(c, config, null);
  if (hook.action === "allow") return { hook, raised: null };
  const { action: _, ...client } = hook;
  const server = classify(c, config, PERSONAL);
  return { hook, raised: personalAccountHold(client, c, config, server, [PERSONAL], (cc, cfg) => classify(cc, cfg, null)) };
}

const READS = [
  "aws sqs get-queue-attributes --queue-url https://sqs.us-west-2.amazonaws.com/111122223333/q --attribute-names All",
  'aws sqs get-queue-attributes --queue-url "$Q" --attribute-names All --output json | jq .',
  "aws --region us-west-2 --no-cli-pager sqs get-queue-attributes --queue-url u",
  "Q=$(aws sqs get-queue-url --queue-name q --query QueueUrl --output text); aws sqs get-queue-attributes --queue-url $Q",
  "for i in 1 2 3; do aws sqs get-queue-attributes --queue-url u; sleep 5; done",
  "timeout 30 aws sqs get-queue-attributes --queue-url u --profile dev",
  "aws ec2 describe-instances",
  "aws cloudformation describe-stacks --stack-name s",
  "aws lambda list-functions",
  "aws s3api list-objects-v2 --bucket b",
  "aws s3api head-object --bucket b --key k",
  "aws sts get-caller-identity",
  "aws logs filter-log-events --log-group-name g --start-time $(date +%s000)",
  "aws dynamodb scan --table-name t --max-items 5",
  "aws s3 ls s3://b/",
  `corp-creds credentials refresh --account ${PERSONAL} --role Admin && aws sqs get-queue-attributes --queue-url u`,
];

const WRITES = [
  "aws sqs send-message --queue-url https://sqs.us-west-2.amazonaws.com/111122223333/q --message-body x",
  "aws sqs create-queue --queue-name q",
  "aws s3api put-object --bucket b --key k --body f",
  "aws dynamodb update-item --table-name t --key k",
  "aws lambda delete-function --function-name f",
  "aws stepfunctions start-execution --state-machine-arn a",
  "aws lambda invoke --function-name f out.json",
];

describe("personal AWS credentials in the shell: reads", () => {
  test.each(READS)("%s is allowed by the hook and the collector", (command) => {
    expect(classify(call(command), config, null)).toEqual({ action: "allow" });
    expect(classify(call(command), config, PERSONAL)).toEqual({ action: "allow" });
  });
});

describe("personal AWS credentials in the shell: changes stay held", () => {
  test.each(WRITES)("%s is held, at Persona's personal-aws gate once the account resolves", (command) => {
    const { hook, raised } = decided(command);
    expect(hook).toMatchObject({ action: "hold", category: "aws", ownerOnly: true });
    expect(raised).toMatchObject({ category: "personal-aws", ownerOnly: false });
    expect(raised!.reason).toStartWith(`\`aws ${command.split(" ")[1]} ${command.split(" ")[2]}\` changes AWS resources in personal account ${PERSONAL};`);
  });

  test.each([
    ["an explicit GET", "python -I /tmp/x/dp.py GET '/batches/abc?status=done'"],
    ["a POST", "python -I /tmp/x/dp.py POST /batches"],
    ["a poll loop of GETs", "bash /tmp/x/poll.sh abc"],
  ])("a signer taking its method from argv, with %s, is held as a signed request, not a change", (_what, command) => {
    const { hook, raised } = decided(command);
    expect(hook).toMatchObject({ action: "hold", category: "aws", ownerOnly: true, step: "/tmp/x/dp.py" });
    expect(raised).toMatchObject({ category: "personal-aws", ownerOnly: false, step: "/tmp/x/dp.py" });
    expect(raised!.reason).toStartWith(
      `code in /tmp/x/dp.py sends a SigV4-signed request to abc123.execute-api.us-west-2.amazonaws.com, which runs the account's own code, in personal account ${PERSONAL};`
    );
    expect(raised!.reason).not.toContain("changes AWS resources");
  });

  test("the question Persona is asked carries the relabelled reason", () => {
    const command = "python -I /tmp/x/dp.py GET '/batches/abc?status=done'";
    const { raised } = decided(command);
    const held = stricterHold(raised!, classify(call(command), config, PERSONAL));
    expect(held).toEqual(raised!);
    expect(floorQuestion(call(command), held)).toContain(`personal account ${PERSONAL}`);
    expect(floorQuestion(call(command), held)).not.toContain("couldn't determine");
  });

  test("an account id the command quotes is not read as the account the reason names", () => {
    const { raised } = decided(`aws $S get-role --role-arn arn:aws:iam::${PERSONAL}:role/x`);
    expect(raised).toMatchObject({ category: "personal-aws", ownerOnly: false });
    expect(raised!.reason).toEndWith(
      `, which may change AWS resources in personal account ${PERSONAL}; the command doesn't name the account; the credentials it runs with belong to it, so its hook held the call`
    );
    expect(raised!.reason).not.toContain("couldn't determine");
    expect(raised!.reason).not.toContain("set up before");
  });

  test("an account phrase inside the command the reason quotes is left as written", () => {
    const command = `aws $S x "account ${PERSONAL}, which is not a personal account)"`;
    const { hook, raised } = decided(command);
    expect(hook).toMatchObject({ action: "hold", category: "aws" });
    expect(raised).toMatchObject({ category: "personal-aws", ownerOnly: false });
    expect(raised!.reason).toContain(`\`${command}\``);
    expect(raised!.reason).not.toContain("set up before");
    expect(raised!.reason).toContain(`which may change AWS resources in personal account ${PERSONAL};`);
  });

  test("a reason with an unpaired backtick is quoted whole, never rewritten", () => {
    const command = `aws $S x 'a\`b account ${PERSONAL}, which is not a personal account;'`;
    const { raised } = decided(command);
    expect(raised).toMatchObject({ category: "personal-aws", ownerOnly: false });
    expect(raised!.reason).toStartWith(`the hook held a step in personal account ${PERSONAL}: can't read the AWS service or operation in \`${command}\``);
    expect(raised!.reason).not.toContain("set up before");
  });

  test("an account phrase before the isolation note is placed", () => {
    const client: FloorHold = {
      category: "aws",
      ownerOnly: true,
      reason: `code in /tmp/x/dp.py sends a SigV4-signed request to a URL only known at run time in an account the floor couldn't determine (under the run's complete isolation, beside a program run alongside it)`,
      step: "/tmp/x/dp.py",
    };
    const raised = personalAccountHold(client, call("python -I /tmp/x/dp.py GET /"), config, { action: "allow" }, [PERSONAL], () => ({ action: "hold", ...client }));
    expect(raised.reason).toStartWith(`code in /tmp/x/dp.py sends a SigV4-signed request to a URL only known at run time in personal account ${PERSONAL} (under the run's`);
  });

  test("a stale hook's hold that names the account keeps its own wording", () => {
    const client: FloorHold = {
      category: "aws",
      ownerOnly: true,
      reason: `\`corp-creds credentials refresh\` gets Admin credentials for account ${PERSONAL}, which is not a personal account`,
      step: "corp-creds credentials refresh",
    };
    const c = call(`corp-creds credentials refresh --account ${PERSONAL} --role Admin`);
    const raised = personalAccountHold(client, c, config, { action: "allow" }, [], () => ({ action: "hold", ...client }));
    expect(raised).toMatchObject({ category: "personal-aws", ownerOnly: false });
    expect(raised.reason).toBe(
      `\`corp-creds credentials refresh\` gets Admin credentials for personal account ${PERSONAL}; this worker's floor was set up before the collector listed it as personal, so its hook held the call`
    );
  });

  test("a reason clipped before its account phrase is quoted whole, with the account beside it", () => {
    const client: FloorHold = { category: "aws", ownerOnly: true, reason: "code in /tmp/x/dp.py sends a SigV4-signed request to a very long host…", step: "/tmp/x/dp.py" };
    const raised = personalAccountHold(client, call("python -I /tmp/x/dp.py GET /"), config, { action: "allow" }, [PERSONAL], () => ({ action: "hold", ...client }));
    expect(raised.reason).toStartWith(`the hook held a step in personal account ${PERSONAL}: code in /tmp/x/dp.py sends`);
    expect(raised.reason).not.toContain("changes AWS resources");
  });

  test("an operation the floor can't name keeps its description, with the account placed", () => {
    const { raised } = decided("aws $SVC get-queue-attributes --queue-url u");
    expect(raised).toMatchObject({ category: "personal-aws", ownerOnly: false });
    expect(raised!.reason).toStartWith(
      `can't read the AWS service or operation in \`aws $SVC get-queue-attributes --queue-url u\`, which may change AWS resources in personal account ${PERSONAL};`
    );
  });
});
