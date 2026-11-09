import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FLOOR_OWNER_GATE } from "../floor/gate.js";
import { ruleCheck, type AllowCheckInput } from "./allow-check.js";
import { setActiveOrgProfile } from "../org-profile/load.js";
import { DEFAULT_ORG_PROFILE } from "../org-profile/default.js";

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

describe("allow check — generic credential steps under the default profile", () => {
  test.each([
    ["an sts guard", `${STS_GUARD}${DEPLOY}`],
    ["an exit guard", `${EXIT_GUARD}${DEPLOY}`],
    ["an sts grep guard", `aws sts get-caller-identity --query Account --output text | grep -qx ${PERSONAL} && ${DEPLOY}`],
    ["an sts guard, a cd and an echo", `${STS_GUARD}cd infra/orders && echo ${PERSONAL} && ${DEPLOY}`],
    // A role option alone, away from a credential noun, is no credential step, as the floor reads it.
    ["an sts guard and a role option on another command", `${STS_GUARD}deploy-tool login --role Admin && ${DEPLOY}`],
    ["an exit guard and a grep naming credentials", `${EXIT_GUARD}grep -rn credentials docs; ${DEPLOY}`],
    // A credential noun inside a quoted message is no operand.
    ["an sts guard and a commit message naming credentials", `${STS_GUARD}git commit -m "rotate credentials" && ${DEPLOY}`],
    // A step naming no role, account or credential noun is no credential step to the generic reading, as the floor reads it.
    ["an sts guard and an assume naming nothing", `${STS_GUARD}cloud-cli assume && ${DEPLOY}`],
    ["an sts guard and an assume naming a role alone", `${STS_GUARD}cloud-cli assume --role Admin && ${DEPLOY}`],
  ])("%s with no credential step after it places the deploy", (_label, call) => {
    expect(ruleCheck(awsHold(call)).verdict).toBe("allow");
  });

  test.each([
    // A credential step naming a role alone, a write verb alone, or an account with no role or noun.
    ["a role alone beside a credential noun", "cloud-cli credentials update --role Admin --no-cache"],
    ["a role and a word the reader can't read", "deploy-tool login --role Admin $ARGS"],
    ["a role alone with -r beside a credential noun", "cloud-cli creds refresh -r Admin"],
    ["a write verb alone", "cloud-cli credentials refresh"],
    ["a write verb alone with options", "cloud-cli credentials update --no-cache"],
    ["another verb beside a credential noun", "cloud-cli credentials list"],
    ["a write verb alone on a program named for credentials", "cloud-creds refresh"],
    ["a write verb and options on a program named for credentials", "cloud-creds update --no-cache"],
    ["a renew on a credential helper", "docker-credential-x renew"],
    ["a verb the reader can't read on a program named for credentials", "cloud-creds $VERB"],
    ["a program named for credentials with no operand", "cloud-creds"],
    ["an account with no role or noun", `cloud-cli assume ${OTHER}`],
    ["an account option with no role or noun", `deploy-tool --account ${OTHER}`],
    ["an account option the reader can't read", "deploy-tool --account $ACCT"],
    ["an account a path to the program names", `/opt/bin/cloud-cli assume ${OTHER}`],
    // A credential step naming an account and a role.
    ["an account and a role", `cloud-cli credentials update --account ${OTHER} --role Admin --no-cache`],
    ["the guarded account and a role", `cloud-cli credentials update --account ${PERSONAL} --role Admin`],
    ["a wrapper naming a role", `cloud-vault exec --role Admin -- ${DEPLOY}`],
  ])("an sts guard credits nothing across a credential step: %s", (_label, step) => {
    for (const call of [`${STS_GUARD}${step} && ${DEPLOY}`, `${EXIT_GUARD}${step}; ${DEPLOY}`, `${STS_GUARD}${step}; ${DEPLOY}`]) {
      expect({ call, verdict: ruleCheck(awsHold(call)).verdict }).toEqual({ call, verdict: "flag" });
    }
  });
});
