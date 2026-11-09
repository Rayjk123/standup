import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FLOOR_OWNER_GATE } from "../floor/gate.js";
import { ALLOW_CHECK_SYSTEM_PROMPT, allowCheckPrompt, ruleCheck, runAllowCheck, type AllowChecker, type AllowCheckInput } from "./allow-check.js";
import { setActiveOrgProfile } from "../org-profile/load.js";
import { exampleCorpProfile } from "../org-profile/fixtures/example-corp.js";

// The example.corp fixture profile: corp-creds writes credentials for `--account` and `--role`.
beforeAll(() => setActiveOrgProfile(exampleCorpProfile()));
afterAll(() => setActiveOrgProfile());

const PERSONAL = "222222222222";
const NONPROD = "333333333333";
const UNLISTED = "111122223333";

const STS_GUARD = (account: string) => `[ "$(aws sts get-caller-identity --query Account --output text)" = "${account}" ] && `;

function awsHold(account: string, over: Partial<AllowCheckInput> = {}): AllowCheckInput {
  return {
    owner: "alice",
    selfAliases: ["alice"],
    gate: FLOOR_OWNER_GATE,
    category: "aws",
    floorReason: `changes AWS resources in account ${account} (credentials: arn:aws:sts::${account}:assumed-role/Admin/alice-session)`,
    toolName: "Bash",
    call: `corp-creds credentials refresh --account ${account} --role Admin && aws lambda update-function-code --function-name orders --zip-file fileb://f.zip`,
    personaReason: "the job redeploys its lambda in the owner's dev account",
    job: { title: "orders", goal: "fix the orders lambda's latency" },
    brief: "fix the orders lambda's latency",
    ownerMessages: ["fix the orders lambda latency"],
    preferences: [],
    worktreeRoot: "/srv/ws/wt",
    personalAwsAccounts: [PERSONAL],
    nonProdAwsAccounts: [NONPROD],
    ...over,
  };
}

/** A model layer that records each prompt it is sent and allows. */
function recordingModel(): AllowChecker & { seen: string[] } {
  const seen: string[] = [];
  return {
    name: "stub",
    seen,
    async check(i) {
      seen.push(allowCheckPrompt(i));
      return { verdict: "allow", reason: "ok" };
    },
  };
}

describe("allow check — the owner's personal AWS accounts in the model layer", () => {
  test("the system prompt says a listed personal account is the owner's own and no reason to flag, and prod stays prod", () => {
    expect(ALLOW_CHECK_SYSTEM_PROMPT).toContain("personal dev accounts is the owner's own, not production");
    expect(ALLOW_CHECK_SYSTEM_PROMPT).toContain("is no reason to flag");
    expect(ALLOW_CHECK_SYSTEM_PROMPT).toContain("named prod is still production in any account");
    expect(ALLOW_CHECK_SYSTEM_PROMPT).toContain("an account not listed there may be prod");
  });

  test.each([
    ["a credential CLI step", awsHold(PERSONAL)],
    ["an sts guard", awsHold(PERSONAL, { call: `${STS_GUARD(PERSONAL)}aws lambda update-function-code --function-name orders --zip-file fileb://f.zip` })],
  ])("a call placed in a listed personal account through %s reaches the model with that account named as the owner's personal dev account", async (_label, hold) => {
    const model = recordingModel();
    const record = await runAllowCheck(hold, { model, modelTimeoutMs: 1_000 });
    expect(record.steps.map((s) => s.checker)).toEqual(["rules", "stub"]);
    expect(record.verdict).toBe("allow");
    expect(model.seen).toHaveLength(1);
    expect(model.seen[0]).toContain(`AWS accounts the call names that are the owner's (alice) own personal dev accounts, not production: ${PERSONAL}`);
  });

  test("an account named only by the floor's reason (STS-resolved) is stated too", () => {
    const hold = awsHold(PERSONAL, { call: "aws lambda update-function-code --function-name orders --zip-file fileb://f.zip" });
    expect(allowCheckPrompt(hold)).toContain(`personal dev accounts, not production: ${PERSONAL}`);
  });

  test("an unlisted account, or the same account with no personal list, gets no personal line", () => {
    for (const hold of [awsHold(UNLISTED), awsHold(PERSONAL, { personalAwsAccounts: [] }), awsHold(PERSONAL, { personalAwsAccounts: undefined })]) {
      const prompt = allowCheckPrompt(hold);
      expect(prompt).not.toContain("personal dev accounts");
      expect(prompt).not.toContain("not production:");
    }
  });

  test("a personal account named only in an echo isn't stated as where the call acts", () => {
    const hold = awsHold(PERSONAL, {
      floorReason: "changes AWS resources (credentials: profile work)",
      call: `echo "not ${PERSONAL}" && aws --profile work lambda update-function-code --function-name orders --zip-file fileb://f.zip`,
      nonProdAwsAccounts: [],
    });
    expect(allowCheckPrompt(hold)).not.toContain("personal dev accounts, not production");
  });

  test("a personal account named only in a comment isn't stated either", () => {
    const hold = awsHold(PERSONAL, {
      floorReason: "changes AWS resources (credentials: profile work)",
      call: `aws --profile work lambda update-function-code --function-name orders --zip-file fileb://f.zip # ${PERSONAL}`,
    });
    expect(allowCheckPrompt(hold)).not.toContain("personal dev accounts");
  });

  test("a listed account the call doesn't name isn't stated", () => {
    expect(allowCheckPrompt(awsHold(UNLISTED, { personalAwsAccounts: [PERSONAL, "444455556666"] }))).not.toContain("personal dev accounts");
  });

  test("a listed non-prod account is stated as non-prod, never as personal", () => {
    const prompt = allowCheckPrompt(awsHold(NONPROD));
    expect(prompt).toContain(`AWS accounts the call names that the owner listed as non-prod, not production: ${NONPROD}`);
    expect(prompt).not.toContain("personal dev accounts");
  });

  test("an account in both lists is stated once, as personal", () => {
    const prompt = allowCheckPrompt(awsHold(PERSONAL, { nonProdAwsAccounts: [PERSONAL] }));
    expect(prompt).toContain(`personal dev accounts, not production: ${PERSONAL}`);
    expect(prompt).not.toContain("listed as non-prod");
  });
});

describe("allow check — the owner's personal AWS accounts in the rules", () => {
  test.each([
    ["a credential CLI step with an Admin role", awsHold(PERSONAL)],
    ["an sts guard", awsHold(PERSONAL, { call: `${STS_GUARD(PERSONAL)}aws lambda update-function-code --function-name orders --zip-file fileb://f.zip` })],
    ["a guarded cdk deploy of a personal stack", awsHold(PERSONAL, { call: `${STS_GUARD(PERSONAL)}npx cdk deploy alice-dev-Orders-Service --exclusively` })],
  ])("a guarded change in a listed personal account through %s is not flagged as prod", (_label, hold) => {
    expect(ruleCheck(hold)).toEqual({ verdict: "allow", reason: expect.any(String) });
  });

  test("the same call in an unlisted account is still flagged as prod or unlisted", () => {
    expect(ruleCheck(awsHold(UNLISTED)).reason).toContain(`AWS account ${UNLISTED}, which is prod or unlisted`);
    expect(ruleCheck(awsHold(PERSONAL, { personalAwsAccounts: [] })).reason).toContain("prod or unlisted");
  });

  test.each([
    ["a stack named prod", `${STS_GUARD(PERSONAL)}npx cdk deploy Orders-Service-prod --exclusively`],
    ["--stage prod", `${STS_GUARD(PERSONAL)}npx serverless deploy --stage prod`],
    ["STAGE=prod", `${STS_GUARD(PERSONAL)}STAGE=prod npx cdk deploy --all`],
  ])("a prod deploy in a listed personal account is still flagged (%s)", (_label, call) => {
    const v = ruleCheck(awsHold(PERSONAL, { call }));
    expect(v.verdict).toBe("flag");
    expect(v.reason).toContain("targets production");
  });

  test("a secrets read in a listed personal account is still flagged", () => {
    const v = ruleCheck(awsHold(PERSONAL, { call: `${STS_GUARD(PERSONAL)}aws secretsmanager get-secret-value --secret-id x` }));
    expect(v.verdict).toBe("flag");
    expect(v.reason).toContain("secrets");
  });
});
