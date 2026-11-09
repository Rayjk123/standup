import { describe, expect, test } from "bun:test";
import { classifyToolCall } from "./classify.js";
import type { FloorCall, FloorConfig, FloorHold, FloorVerdict } from "./gate.js";
import { buildLaunchFloorConfig, DEFAULT_NONPROD_AWS_ACCOUNTS, DEFAULT_PERSONAL_AWS_ACCOUNTS } from "./launch.js";
import { personalAccountHold } from "./routes.js";
import { exampleCorpProfile } from "../org-profile/fixtures/example-corp.js";

/*
 * An install that lists its personal dev account as non-prod as well as
 * personal: a call there the floor places (a credential CLI's --account, an
 * sts guard, resolved credentials) is allowed as before, and one it can't
 * place as personal is held as `nonprod-aws`, never as owner-only
 * prod-or-unlisted `aws`. With neither list set, no account is either.
 */

const PERSONAL = "111122223333";
const NONPROD = "444455556666";
const ROOT = "/srv/ws/wt";
const defaults: FloorConfig = {
  ...buildLaunchFloorConfig(
    { launchId: "L1", root: ROOT },
    { STANDUP_HOST_USER: "alice", STANDUP_PERSONAL_AWS_ACCOUNTS: PERSONAL, STANDUP_FLOOR_NONPROD_AWS_ACCOUNTS: `${NONPROD},${PERSONAL}` }
  ),
  orgProfile: exampleCorpProfile(),
};
const withoutOverlap: FloorConfig = { ...defaults, nonProdAwsAccounts: [NONPROD] };
const bash = (command: string): FloorCall => ({ toolName: "Bash", toolInput: { command }, cwd: ROOT });
const classify = (command: string, config: FloorConfig, account: string | null) =>
  classifyToolCall(bash(command), config, { awsAccount: () => account });
const summary = (v: FloorVerdict) => (v.action === "allow" ? "allow" : `${v.category}${v.ownerOnly ? " owner-only" : ""}`);

describe("a personal dev account listed as non-prod too", () => {
  test("is listed as both personal and non-prod; no account is either by default", () => {
    expect(DEFAULT_PERSONAL_AWS_ACCOUNTS).toEqual([]);
    expect(DEFAULT_NONPROD_AWS_ACCOUNTS).toEqual([]);
    expect(buildLaunchFloorConfig({ launchId: "L1", root: ROOT }, {}).personalAwsAccounts).toEqual([]);
    expect(defaults.personalAwsAccounts).toEqual([PERSONAL]);
    expect(defaults.nonProdAwsAccounts).toEqual([NONPROD, PERSONAL]);
  });

  test.each([
    [`corp-creds credentials refresh --account ${PERSONAL} --role Admin && aws s3 rm s3://b/k`, null],
    ["aws s3 rm s3://b/k", PERSONAL],
    ["aws lambda update-function-code --function-name f --zip-file fileb://f.zip", PERSONAL],
  ])("%s placed in the personal account is decided as without the non-prod listing", (command, account) => {
    expect(summary(classify(command, defaults, account))).toBe(summary(classify(command, withoutOverlap, account)));
  });

  test("a mutation the floor places only for invokes is held as nonprod-aws, not owner-only aws", () => {
    const invokesOnly = { ...defaults, personalAwsInvokesOnly: true };
    const v = classify("aws s3 rm s3://b/k", invokesOnly, PERSONAL);
    expect(summary(v)).toBe("nonprod-aws");
    expect(summary(classify("aws s3 rm s3://b/k", { ...invokesOnly, nonProdAwsAccounts: [NONPROD] }, PERSONAL))).toBe("aws owner-only");
  });

  test.each([
    ["an undetermined account", "aws s3 rm s3://b/k", null],
    ["an unlisted account", "aws s3 rm s3://b/k", "777788889999"],
    ["the personal account only echoed", `echo ${PERSONAL}; aws s3 rm s3://b/k`, null],
  ])("%s stays owner-only aws", (_what, command, account) => {
    expect(summary(classify(command, defaults, account))).toBe("aws owner-only");
  });

  test("the collector relabels a stale hook's hold in the account as personal-aws, ahead of non-prod", () => {
    const client: FloorHold = {
      category: "aws",
      ownerOnly: true,
      reason: `\`aws s3 rm\` changes AWS resources in account ${PERSONAL}, which is not a personal account`,
      step: "aws s3 rm s3://b/k",
    };
    const same = (): FloorVerdict => ({ action: "hold", ...client });
    const relabelled = personalAccountHold(client, bash("aws s3 rm s3://b/k"), defaults, { action: "allow" }, [], same);
    expect(relabelled).toMatchObject({ category: "personal-aws", ownerOnly: false });
    expect(relabelled.reason).toContain(`personal account ${PERSONAL}`);
    const other: FloorHold = { ...client, reason: client.reason.replace(PERSONAL, "777788889999") };
    expect(personalAccountHold(other, bash("aws s3 rm s3://b/k"), defaults, { action: "allow" }, [], () => ({ action: "hold", ...other }))).toBe(other);
  });
});
