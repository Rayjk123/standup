import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FLOOR_OWNER_GATE } from "../floor/gate.js";
import { ruleCheck, type AllowCheckInput } from "./allow-check.js";
import { setActiveOrgProfile } from "../org-profile/load.js";
import { DEFAULT_ORG_PROFILE } from "../org-profile/default.js";
import { exampleCorpProfile } from "../org-profile/fixtures/example-corp.js";

// The default profile names no credential CLI: every credential step is read by the generic reading alone.
beforeAll(() => setActiveOrgProfile(DEFAULT_ORG_PROFILE));
afterAll(() => setActiveOrgProfile());

const PERSONAL = "222222222222";
const OTHER = "111122223333";

const STS = "$(aws sts get-caller-identity --query Account --output text)";
const STS_GUARD = `[ "${STS}" = "${PERSONAL}" ] && `;
const EXIT_GUARD = `[ "${STS}" != "${PERSONAL}" ] && exit 1; `;
const DEPLOY = "npx cdk deploy alice-dev-Orders-Service --exclusively";

function awsHold(call: string): AllowCheckInput {
  return {
    owner: "alice",
    selfAliases: ["alice"],
    gate: FLOOR_OWNER_GATE,
    category: "aws",
    floorReason: "changes AWS resources",
    toolName: "Bash",
    call,
    personaReason: "the job redeploys its stack in the owner's dev account",
    job: { title: "orders", goal: "fix the orders lambda's latency" },
    brief: "fix the orders lambda's latency",
    ownerMessages: ["fix the orders lambda latency"],
    preferences: ["Any personal stack deployment is fine"],
    worktreeRoot: "/srv/ws/wt",
    personalAwsAccounts: [PERSONAL],
  };
}

describe("allow check — credential steps run through a shell script or a prefix command", () => {
  test.each([
    // Inside a shell's `-c` script, eval's words or env -S's string.
    ["sh -c with a write verb on a program named for credentials", "sh -c 'cloud-creds refresh'"],
    ["bash -c with a role beside a credential noun", 'bash -c "cloud-cli credentials update --role Admin"'],
    ["bash -lc with a write verb beside a credential noun", "bash -lc 'cloud-cli credentials refresh'"],
    ["sh -c with a credential step after a cd", "sh -c 'cd infra && cloud-creds refresh'"],
    ["sh -c with an account option the reader can't read", "sh -c 'cloud-cli credentials update --account $ACCT'"],
    ["sh -c with an account and no role or noun", `sh -c 'cloud-cli assume ${OTHER}'`],
    ["sh -c nested in sh -c", `sh -c 'sh -c "cloud-creds refresh"'`],
    ["sudo bash -c", "sudo bash -c 'cloud-creds refresh'"],
    ["eval", "eval 'cloud-creds refresh'"],
    ["env -S", "env -S 'cloud-creds refresh'"],
    // Behind a prefix command.
    ["env with an assignment", "env FOO=1 cloud-creds refresh"],
    ["env -u", "env -u AWS_REGION cloud-creds refresh"],
    ["sudo", "sudo cloud-creds refresh"],
    ["sudo -u", "sudo -u bob cloud-cli credentials update --no-cache"],
    ["nice -n", "nice -n 10 cloud-creds refresh"],
    ["timeout", "timeout 30 cloud-creds refresh"],
    ["timeout -s", "timeout -s KILL 30s docker-credential-x renew"],
    ["command", "command cloud-creds refresh"],
    ["exec", "exec cloud-creds refresh"],
    ["prefixes chained", "sudo env FOO=1 nice -n 5 timeout 30 cloud-creds refresh"],
    ["env with an account and no role or noun", `env FOO=1 cloud-cli assume ${OTHER}`],
  ])("an sts guard credits nothing across a credential step: %s", (_label, step) => {
    for (const call of [`${STS_GUARD}${step} && ${DEPLOY}`, `${EXIT_GUARD}${step}; ${DEPLOY}`, `${STS_GUARD}${step}; ${DEPLOY}`]) {
      expect({ call, verdict: ruleCheck(awsHold(call)).verdict }).toEqual({ call, verdict: "flag" });
    }
  });

  test.each([
    ["sh -c with no credential step", "sh -c 'git status && ls -la'"],
    ["sh -c with a commit message naming credentials", `sh -c 'git commit -m "rotate credentials"'`],
    ["a prefix of a program naming nothing of credentials", "env FOO=1 git status"],
    ["a prefix of a word reader", "timeout 30 grep -rn credentials docs"],
    ["command -v of a program named for credentials", "command -v cloud-creds"],
    ["a cluster of sudo options before a program naming nothing of credentials", "sudo -iu bob git status"],
  ])("an sts guard places the deploy across a step that is no credential step: %s", (_label, step) => {
    const call = `${STS_GUARD}${step} && ${DEPLOY}`;
    expect({ call, verdict: ruleCheck(awsHold(call)).verdict }).toEqual({ call, verdict: "allow" });
  });

  test.each([
    ["sudo with a cluster of options ending in -u", "sudo -iu bob cloud-creds refresh"],
    ["env with a cluster of options ending in -S", "env -iS 'cloud-creds refresh'"],
    ["a redirect before the program", ">/dev/null cloud-creds refresh"],
    ["a redirect among sudo's options", "sudo >/dev/null cloud-creds refresh"],
    ["an escaped sudo", "\\sudo cloud-creds refresh"],
    ["su -c", "su bob -c 'cloud-creds refresh'"],
    ["runuser -u", "runuser -u bob -- cloud-creds refresh"],
    ["flock -c", "flock /tmp/l -c 'cloud-creds refresh'"],
    ["find -exec", "find . -exec cloud-creds refresh \\;"],
    ["a command substitution", "echo $(cloud-creds refresh)"],
  ])("an sts guard credits nothing across a credential step behind another wrapper: %s", (_label, step) => {
    const call = `${STS_GUARD}${step} && ${DEPLOY}`;
    expect({ call, verdict: ruleCheck(awsHold(call)).verdict }).toEqual({ call, verdict: "flag" });
  });
});

describe("allow check — an org profile's credential CLIs behind a prefix command or in a shell script", () => {
  beforeAll(() => setActiveOrgProfile(exampleCorpProfile()));
  afterAll(() => setActiveOrgProfile(DEFAULT_ORG_PROFILE));

  test.each([
    ["the CLI naming no account", "corp-assume assume"],
    ["the CLI after an assignment", "FOO=1 corp-assume assume"],
    ["env with an assignment", "env FOO=1 corp-assume assume"],
    ["sudo", "sudo corp-assume assume"],
    ["sudo with a cluster of options ending in -u", "sudo -iu bob corp-assume assume"],
    ["sh -c", "sh -c 'corp-assume assume'"],
    ["sudo with a role", "sudo corp-assume session --role Admin"],
    ["sh -c with a role", "sh -c 'corp-assume session --role Admin'"],
    ["timeout before an exec wrapper", "timeout 30 corp-assume exec --role Admin -- ls"],
    ["sudo with another account, which no guard reads", `sudo corp-creds credentials refresh --account ${OTHER}`],
    ["bash -c with another account", `bash -c 'corp-creds credentials refresh --account ${OTHER}'`],
    ["a command substitution", "echo $(corp-assume assume)"],
  ])("an sts guard credits nothing across the step: %s", (_label, step) => {
    for (const call of [`${STS_GUARD}${step} && ${DEPLOY}`, `${EXIT_GUARD}${step}; ${DEPLOY}`]) {
      expect({ call, verdict: ruleCheck(awsHold(call)).verdict }).toEqual({ call, verdict: "flag" });
    }
  });

  test.each([
    ["a prefix of a program naming nothing of credentials", "env FOO=1 git status"],
    ["sh -c with no credential step", "sh -c 'git status'"],
    ["the CLI run as the program, writing the personal account", `corp-creds credentials refresh --account ${PERSONAL}`],
  ])("an sts guard places the deploy across a step that is no credential step: %s", (_label, step) => {
    const call = `${STS_GUARD}${step} && ${DEPLOY}`;
    expect({ call, verdict: ruleCheck(awsHold(call)).verdict }).toEqual({ call, verdict: "allow" });
  });
});
