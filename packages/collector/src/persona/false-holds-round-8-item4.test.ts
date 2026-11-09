import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FLOOR_OWNER_GATE } from "../floor/gate.js";
import { callSignals, ruleCheck, type AllowCheckInput } from "./allow-check.js";
import { setActiveOrgProfile } from "../org-profile/load.js";
import { exampleCorpProfile } from "../org-profile/fixtures/example-corp.js";

// The example.corp fixture profile: corp-creds writes credentials for `--account` and `--role`.
beforeAll(() => setActiveOrgProfile(exampleCorpProfile()));
afterAll(() => setActiveOrgProfile());

const PERSONAL = "222222222222";
const NONPROD = "333333333333";
const STS = "$(aws sts get-caller-identity --query Account --output text)";
const DEPLOY = "npx cdk deploy MyStack --exclusively";
const DROP_BUCKET = "aws s3 rb s3://data-bucket --force";
const STS_CALL = "aws sts get-caller-identity";

/** An `aws` hold whose floor reason names no account, in a job that names neither the account nor the step's target. */
function held(call: string, over: Partial<AllowCheckInput> = {}): AllowCheckInput {
  return {
    owner: "alice",
    selfAliases: ["alice"],
    gate: FLOOR_OWNER_GATE,
    category: "aws",
    floorReason: "changes AWS resources in an account the floor couldn't tell",
    toolName: "Bash",
    call,
    personaReason: "the job deploys its stack to the owner's dev account",
    job: { title: "orders", goal: "fix the orders lambda's latency" },
    brief: "fix the orders lambda's latency",
    ownerMessages: ["fix the orders lambda latency"],
    preferences: [],
    worktreeRoot: "/srv/ws/wt",
    personalAwsAccounts: [PERSONAL],
    nonProdAwsAccounts: [NONPROD, PERSONAL],
    ...over,
  };
}

describe("a listed personal account placed by an sts guard", () => {
  const placed: Array<[string, string]> = [
    ["[ sts ] = quoted, then cdk deploy", `[ "${STS}" = "${PERSONAL}" ] && cdk deploy MyStack --exclusively`],
    ["test sts = bare, then s3 cp", `test "${STS}" = ${PERSONAL} && aws s3 cp x s3://b/`],
    ["sts | grep -q, then npx cdk deploy", `aws sts get-caller-identity | grep -q ${PERSONAL} && npx cdk deploy MyStack --exclusively`],
    [
      "corp-creds, a bare sts check, then npx cdk deploy",
      `corp-creds credentials refresh --account ${PERSONAL} --role Admin && aws sts get-caller-identity && npx cdk deploy MyStack --exclusively`,
    ],
    ["acct=$(sts); [ ] || exit 1; cdk deploy", `acct=${STS}; [ "$acct" = ${PERSONAL} ] || exit 1; cdk deploy MyStack`],
    ["acct=$(sts) && [ ] && cdk deploy", `acct=${STS} && [ "$acct" = "${PERSONAL}" ] && cdk deploy MyStack`],
    ["if [ sts != ]; then exit 1; fi; cdk deploy", `if [ "${STS}" != "${PERSONAL}" ]; then echo wrong; exit 1; fi; cdk deploy X`],
    ["[[ sts == ]] || exit 1; cdk deploy", `[[ "${STS}" == "${PERSONAL}" ]] || exit 1; cdk deploy X`],
    ["[ ] || { echo; exit 1; }; cdk deploy", `[ "${STS}" = "${PERSONAL}" ] || { echo "wrong account"; exit 1; }; cdk deploy X`],
    ["multi-line: [ ] && newline-continued", `[ "${STS}" = "${PERSONAL}" ] && \\\n  cdk deploy MyStack --exclusively`],
    ["multi-line: acct, [ ] || exit 1, cdk deploy", `cd /srv/ws/wt/cdk\nacct=${STS}\n[ "$acct" = "${PERSONAL}" ] || exit 1\nnpx cdk deploy MyStack --exclusively`],
    ["multi-line: if !=; then exit; fi", `if [ "${STS}" != "${PERSONAL}" ]; then\n  echo "wrong account"\n  exit 1\nfi\ncdk deploy X`],
    [
      "multi-line: set -e, corp-creds, sts guard || exit 1, deploy",
      `set -euo pipefail\ncorp-creds credentials refresh --account ${PERSONAL} --role Admin\n[ "${STS}" = "${PERSONAL}" ] || exit 1\nnpx cdk deploy MyStack --exclusively`,
    ],
  ];
  test.each(placed)("%s passes", (_what, call) => {
    expect(ruleCheck(held(call))).toEqual({ verdict: "allow", reason: expect.any(String) });
  });

  test.each(placed)("%s attributes the account", (_what, call) => {
    expect(callSignals({ toolName: "Bash", call, floorReason: "x" }).attributedAccounts).toContain(PERSONAL);
  });
});

describe("a listed account the call doesn't place is never called prod or unlisted", () => {
  test.each([
    ["a comment", `aws lambda update-function-code --function-name f --zip-file fileb://f.zip # ${PERSONAL}`],
    ["an echo", `echo ${PERSONAL}; cdk deploy MyStack`],
    ["a guard joined with ||", `[ "${STS}" = "${PERSONAL}" ] || cdk deploy MyStack`],
    ["a guard after the deploy", `cdk deploy MyStack && [ "${STS}" = "${PERSONAL}" ]`],
  ])("%s is flagged, saying the account isn't placed", (_what, call) => {
    for (const lists of [{ nonProdAwsAccounts: [NONPROD] }, { nonProdAwsAccounts: [NONPROD, PERSONAL] }]) {
      const v = ruleCheck(held(call, lists));
      expect(v.verdict).toBe("flag");
      expect(v.reason).not.toContain("prod or unlisted");
      expect(v.reason).toContain(PERSONAL);
    }
  });
});

describe("true positives beside an sts guard stay flagged", () => {
  test.each([
    ["an unlisted account", `[ "${STS}" = "111122223333" ] && cdk deploy MyStack`, "prod or unlisted"],
    ["a --profile of the call's own", `[ "${STS}" = "${PERSONAL}" ] && cdk deploy MyStack --profile prod`, ""],
    ["an AWS_PROFILE of the call's own", `[ "${STS}" = "${PERSONAL}" ] && AWS_PROFILE=prod cdk deploy MyStack`, ""],
    ["a second unlisted account", `[ "${STS}" = "${PERSONAL}" ] && aws s3 cp x s3://b/ && aws sts assume-role --role-arn arn:aws:iam::111122223333:role/Admin --role-session-name s`, "111122223333"],
    ["a != guard with no exit", `if [ "${STS}" != "${PERSONAL}" ]; then echo wrong; fi; cdk deploy X`, ""],
    ["a != guard without an exit, joined by ||", `[ "${STS}" != "${PERSONAL}" ] || cdk deploy X`, ""],
    ["an = guard whose failure exits but then runs", `[ "${STS}" = "${PERSONAL}" ] || echo wrong; cdk deploy X`, ""],
    ["an if = guard that exits on match", `if [ "${STS}" = "${PERSONAL}" ]; then exit 1; fi; cdk deploy X`, ""],
    ["a step before the guard", `cdk deploy Other; acct=${STS}; [ "$acct" = ${PERSONAL} ] || exit 1; cdk deploy X`, ""],
    ["acct set again before the guard", `acct=${STS}; acct=${PERSONAL}; [ "$acct" = ${PERSONAL} ] || exit 1; cdk deploy X`, ""],
    ["acct read by printf -v before the guard", `acct=${STS}; printf -v acct %s ${PERSONAL}; [ "$acct" = ${PERSONAL} ] || exit 1; cdk deploy X`, ""],
    ["acct set from something other than sts", `acct=$(cat acct.txt); [ "$acct" = ${PERSONAL} ] || exit 1; cdk deploy X`, ""],
    ["an exit in a pipeline", `[ "${STS}" = "${PERSONAL}" ] || exit 1 | cat; cdk deploy X`, ""],
    ["an exit in the background", `[ "${STS}" = "${PERSONAL}" ] || exit 1 & cdk deploy X`, ""],
    ["a != guard joined with ||", `[ "${STS}" != "${PERSONAL}" ] || exit 1; cdk deploy X`, ""],
    ["an echo running a substitution in the mismatch branch", `[ "${STS}" = "${PERSONAL}" ] || { echo $(cdk deploy Other); exit 1; }; cdk deploy X`, ""],
    ["set -e then set +e before corp-creds", `set -e\nset +e\ncorp-creds credentials refresh --account ${PERSONAL} --role Admin\ncdk deploy X`, ""],
    ["set -e with corp-creds || true", `set -e\ncorp-creds credentials refresh --account ${PERSONAL} --role Admin || true\ncdk deploy X`, ""],
    ["no set -e: corp-creds on its own line", `corp-creds credentials refresh --account ${PERSONAL} --role Admin\ncdk deploy X`, ""],
    ["set -e after the deploy", `cdk deploy Other\nset -e\ncorp-creds credentials refresh --account ${PERSONAL} --role Admin\ncdk deploy X`, ""],
    ["a guard on another variable", `acct=${STS}; [ "$other" = ${PERSONAL} ] || exit 1; cdk deploy X`, ""],
    ["a guard whose mismatch branch runs a step", `[ "${STS}" = "${PERSONAL}" ] || { cdk deploy Other; exit 1; }; cdk deploy X`, ""],
    ["a guard in a subshell", `( [ "${STS}" = "${PERSONAL}" ] || exit 1 ); cdk deploy X`, ""],
  ])("%s", (_what, call, why) => {
    const v = ruleCheck(held(call));
    expect(v.verdict).toBe("flag");
    if (why) expect(v.reason).toContain(why);
  });
});

// The tool runs a command as the left side of an `&&`, where the shell ignores errexit: `set -e` guards nothing.
describe("set -e places no account", () => {
  test.each([
    ["set -e, [ sts = ] on its own line", `set -e\n[ "${STS}" = "${PERSONAL}" ]\n${DROP_BUCKET}`],
    ["set -e, [[ sts == ]] on its own line", `set -e\n[[ "${STS}" == "${PERSONAL}" ]]\n${DROP_BUCKET}`],
    ["set -o errexit, [ sts = ] on its own line", `set -o errexit\n[ "${STS}" = "${PERSONAL}" ]\n${DROP_BUCKET}`],
    ["set -euo pipefail, corp-creds on its own line", `set -euo pipefail\ncorp-creds credentials refresh --account ${PERSONAL} --role Admin\n${DROP_BUCKET}`],
    [
      "set -euo pipefail, corp-creds, a bare sts call, deploy",
      `set -euo pipefail\ncorp-creds credentials refresh --account ${PERSONAL} --role Admin\n${STS_CALL}\nnpx cdk deploy MyStack --exclusively`,
    ],
  ])("%s is flagged and attributes nothing", (_what, call) => {
    expect(ruleCheck(held(call)).verdict).toBe("flag");
    expect(callSignals({ toolName: "Bash", call, floorReason: "x" }).attributedAccounts).not.toContain(PERSONAL);
  });
});

describe("an sts account variable that may hold something else places nothing", () => {
  test.each([
    ["set in a pipeline", `export acct=${PERSONAL}; acct=${STS} | :; [ "$acct" = ${PERSONAL} ] && aws s3 rb s3://data-bucket --force`],
    ["set in a pipeline, read as ${acct}", `export acct=${PERSONAL}; acct=${STS} | :; [ "\${acct}" = ${PERSONAL} ] && aws s3 rb s3://data-bucket --force`],
    ["set in the background", `acct=${STS} & [ "$acct" = ${PERSONAL} ] && aws s3 rb s3://data-bucket --force`],
    ["reset by ${acct::=}", `acct=${STS}; : \${acct::=${PERSONAL}}; [ "$acct" = ${PERSONAL} ] || exit 1; aws s3 rb s3://data-bucket --force`],
    ["reset by ${acct::=}, joined with &&", `acct=${STS} && : \${acct::=${PERSONAL}} && [ "$acct" = ${PERSONAL} ] && aws s3 rb s3://data-bucket --force`],
    ["reset by ${acct:=}", `acct=${STS}; : \${acct:=${PERSONAL}}; [ "$acct" = ${PERSONAL} ] || exit 1; aws s3 rb s3://data-bucket --force`],
    ["set after && from an earlier value", `export acct=${PERSONAL}; ls /nonexistent && acct=${STS}; [ "$acct" = ${PERSONAL} ] && aws s3 rb s3://data-bucket --force`],
    ["set after ||", `false || acct=${STS}; [ "$acct" = ${PERSONAL} ] || exit 1; aws s3 rb s3://data-bucket --force`],
    ["named before its sts assignment", `acct=${PERSONAL}\nacct=${STS}\n[ "$acct" = ${PERSONAL} ] || exit 1\n${DROP_BUCKET}`],
  ])("%s is flagged and attributes nothing", (_what, call) => {
    expect(ruleCheck(held(call)).verdict).toBe("flag");
    expect(callSignals({ toolName: "Bash", call, floorReason: "x" }).attributedAccounts).not.toContain(PERSONAL);
  });
});

describe("a personal account also listed non-prod needs a guard or the owner, not the job", () => {
  const job = { personaReason: `the job works in ${PERSONAL}`, job: { title: "buckets", goal: `clean up buckets in ${PERSONAL}` }, brief: `clean up buckets in ${PERSONAL}` };
  test.each([
    ["a comment", `aws s3 rb s3://data-bucket --force # ${PERSONAL}`],
    ["an echo", `echo ${PERSONAL}; aws s3 rb s3://data-bucket --force`],
  ])("%s is flagged as a personal account not placed by a guard", (_what, call) => {
    const v = ruleCheck(held(call, job));
    expect(v.verdict).toBe("flag");
    expect(v.reason).toContain("a listed personal account not placed by a guard");
    expect(v.reason).toContain("the owner never named it");
  });

  test("a non-prod account that isn't personal still passes when the job names it", () => {
    const call = `aws s3 rb s3://data-bucket --force # ${NONPROD}`;
    const named = { personaReason: `the job works in ${NONPROD}`, job: { title: "buckets", goal: `clean up buckets in ${NONPROD}` }, brief: `clean up buckets in ${NONPROD}` };
    expect(ruleCheck(held(call, named)).reason).not.toContain("listed personal account");
  });
});

describe("a guard beside a redirected or dropped check places nothing", () => {
  test.each([
    ["PATH set before the guard", `export PATH=/tmp/fake:$PATH; [ "${STS}" = "${PERSONAL}" ] || exit 1; aws s3 rb s3://data-bucket --force`],
    ["AWS_ENDPOINT_URL_STS set before the guard", `export AWS_ENDPOINT_URL_STS=http://127.0.0.1:9; [ "${STS}" = "${PERSONAL}" ] || exit 1; aws s3 rb s3://data-bucket --force`],
    ["--endpoint-url in the sts substitution", `[ "$(aws sts get-caller-identity --endpoint-url http://127.0.0.1:9 --query Account --output text)" = "${PERSONAL}" ] && aws s3 rb s3://data-bucket --force`],
    ["--endpoint-url in an sts grep guard", `aws sts get-caller-identity --endpoint-url http://127.0.0.1:9 | grep -q ${PERSONAL} && aws s3 rb s3://data-bucket --force`],
    ["unset AWS_PROFILE after the guard", `[ "${STS}" = "${PERSONAL}" ] && unset AWS_PROFILE && aws s3 rb s3://data-bucket --force`],
    ["env -u AWS_PROFILE after the guard", `[ "${STS}" = "${PERSONAL}" ] && env -u AWS_PROFILE aws s3 rb s3://data-bucket --force`],
    ["PATH set with a quoted name", `export PA""TH=/tmp/fake:$PATH; [ "${STS}" = "${PERSONAL}" ] || exit 1; ${DEPLOY}`],
    ["AWS_ENDPOINT_URL_STS set with a quoted name", `export AWS_ENDPOINT_URL""_STS=http://127.0.0.1:9; [ "${STS}" = "${PERSONAL}" ] || exit 1; ${DEPLOY}`],
    ["AWS_PROFILE unset with a quoted name", `[ "${STS}" = "${PERSONAL}" ] && unset AWS""_PROFILE && ${DEPLOY}`],
    ["AWS_PROFILE unset with an escaped name", `[ "${STS}" = "${PERSONAL}" ] && unset A\\WS_PROFILE && ${DEPLOY}`],
    ["export -n after the guard", `[ "${STS}" = "${PERSONAL}" ] && export -n AWS_PROFILE && ${DEPLOY}`],
    ["typeset +x after the guard", `[ "${STS}" = "${PERSONAL}" ] && typeset +x AWS_PROFILE && ${DEPLOY}`],
    ["declare +x after the guard", `[ "${STS}" = "${PERSONAL}" ] && declare +x AWS_PROFILE && ${DEPLOY}`],
    ["HOME set after the guard", `[ "${STS}" = "${PERSONAL}" ] && HOME=/tmp/other ${DEPLOY}`],
    ["export HOME after the guard", `[ "${STS}" = "${PERSONAL}" ] || exit 1; export HOME=/tmp/other; ${DEPLOY}`],
    ["a file sourced after the guard", `[ "${STS}" = "${PERSONAL}" ] && source ./env.sh && ${DEPLOY}`],
    ["a file dotted after the guard", `[ "${STS}" = "${PERSONAL}" ] || exit 1; . ./env.sh; ${DEPLOY}`],
    ["corp-creds with a variable account", `corp-creds credentials refresh --account $ACCT --role Admin; [ "${STS}" = "${PERSONAL}" ] || exit 1; ${DEPLOY}`],
    ["corp-creds with a short account", `corp-creds credentials refresh --account 1234 --role Admin && [ "${STS}" = "${PERSONAL}" ] && ${DEPLOY}`],
    ["a credential CLI the profile doesn't list, after the guard", `[ "${STS}" = "${PERSONAL}" ] || exit 1; team-creds login --account ${PERSONAL} --role Admin; ${DEPLOY}`],
    ["a credential CLI the profile doesn't list, with a variable account", `team-creds login --account-id $ACCT --role-name Admin && [ "${STS}" = "${PERSONAL}" ] && ${DEPLOY}`],
  ])("%s is flagged and attributes nothing", (_what, call) => {
    expect(ruleCheck(held(call)).verdict).toBe("flag");
    expect(callSignals({ toolName: "Bash", call, floorReason: "x" }).attributedAccounts).not.toContain(PERSONAL);
  });
});

// Under the default profile no credential CLI is listed: any program naming a role and an account is read the
// floor's generic way, and no guard places an account beside it.
describe("under the default profile, a credential step of any program places nothing", () => {
  beforeAll(() => setActiveOrgProfile());
  afterAll(() => setActiveOrgProfile(exampleCorpProfile()));

  test.each([
    ["a role and an account option, after the guard", `[ "${STS}" = "${PERSONAL}" ] || exit 1; corp-creds credentials refresh --account ${PERSONAL} --role Admin; ${DEPLOY}`],
    ["a role and a variable account, before the guard", `team-creds login --account $ACCT --role Admin && [ "${STS}" = "${PERSONAL}" ] && ${DEPLOY}`],
    ["credential short flags beside a credential noun", `[ "${STS}" = "${PERSONAL}" ] || exit 1; team-creds creds update -a ${PERSONAL} -r Admin; ${DEPLOY}`],
  ])("%s is flagged and attributes nothing", (_what, call) => {
    expect(ruleCheck(held(call)).verdict).toBe("flag");
    expect(callSignals({ toolName: "Bash", call, floorReason: "x" }).attributedAccounts).not.toContain(PERSONAL);
  });

  test("a guard with no credential step beside it still places the account", () => {
    const call = `[ "${STS}" = "${PERSONAL}" ] || exit 1; ${DEPLOY}`;
    expect(ruleCheck(held(call)).verdict).toBe("allow");
    expect(callSignals({ toolName: "Bash", call, floorReason: "x" }).attributedAccounts).toContain(PERSONAL);
  });

  test("a role option with no account names no credential write", () => {
    const call = `[ "${STS}" = "${PERSONAL}" ] || exit 1; kubectl create rolebinding rb --role=viewer --user=alice; ${DEPLOY}`;
    expect(callSignals({ toolName: "Bash", call, floorReason: "x" }).attributedAccounts).toContain(PERSONAL);
  });
});

// Each of these places nothing: heredoc or herestring text, a mismatch test that errors, an sts variable reset under a
// disguised name, or credentials written to a profile the deploy doesn't use.
describe("a guard that doesn't guard the deploy places nothing", () => {
  test.each([
    ["a guard inside a quoted heredoc", `: <<'EOF'\n[ "${STS}" = "${PERSONAL}" ] || exit 1\nEOF\n${DEPLOY}`],
    ["a guard inside a heredoc, then &&", `: <<'EOF' &&\n[ "${STS}" = "${PERSONAL}" ] || exit 1\nEOF\n${DEPLOY}`],
    ["a guard inside a heredoc joined by &&", `: <<EOF && ${DEPLOY}\n[ "${STS}" = "${PERSONAL}" ] && exit 0\nEOF`],
    ["a guard inside a herestring", `: <<<x"\n[ ${STS} = ${PERSONAL} ] || exit 1\n"\n${DEPLOY}; echo "done"`],
    ["a -ne mismatch test && exit", `[ "$(aws sts get-caller-identity)" -ne ${PERSONAL} ] && exit 1; ${DEPLOY}`],
    ["an if -ne mismatch test", `if [ "${STS}" -ne ${PERSONAL} ]; then exit 1; fi; ${DEPLOY}`],
    ["a [[ -ne ]] mismatch test", `[[ "${STS}" -ne ${PERSONAL} ]] && exit 1; ${DEPLOY}`],
    ["a -ne mismatch test on an sts variable", `acct=${STS}; [ "$acct" -ne ${PERSONAL} ] && exit 1; ${DEPLOY}`],
    ["acct reset by export with a quoted name", `acct=${STS}; export "ac"ct=${PERSONAL}; [ "$acct" = ${PERSONAL} ] || exit 1; ${DEPLOY}`],
    ["acct reset by export with an escaped name", `acct=${STS}; export ac\\ct=${PERSONAL}; [ "$acct" = ${PERSONAL} ] || exit 1; ${DEPLOY}`],
    ["acct reset by export with a quoted name, joined by &&", `acct=${STS} && export "ac"ct=${PERSONAL} && [ "$acct" = ${PERSONAL} ] && ${DEPLOY}`],
    ["acct reset by declare with a variable name", `acct=${STS}; n=acct; declare "$n"=${PERSONAL}; [ "$acct" = ${PERSONAL} ] || exit 1; ${DEPLOY}`],
    ["corp-creds writing a named profile, deploy on the default", `corp-creds credentials refresh --account ${PERSONAL} --role Admin --profile dev && ${DEPLOY}`],
    [
      "corp-creds and an sts guard on a named profile, deploy on the default",
      `corp-creds credentials refresh --account ${PERSONAL} --role Admin --profile dev; [ "$(aws sts get-caller-identity --profile dev --query Account --output text)" = ${PERSONAL} ] || exit 1; ${DEPLOY}`,
    ],
    ["an sts guard on a named profile, deploy on the default", `[ "$(aws sts get-caller-identity --profile dev --query Account --output text)" = ${PERSONAL} ] && ${DEPLOY}`],
    ["an sts grep guard on a named profile, deploy on the default", `aws sts get-caller-identity --profile dev | grep -q ${PERSONAL} && ${DEPLOY}`],
    ["corp-creds writing a named profile, exported in a pipeline", `corp-creds credentials refresh --account ${PERSONAL} --role Admin --profile dev && export AWS_PROFILE=dev | cat && ${DEPLOY}`],
    ["corp-creds writing a named profile, exported in the background", `corp-creds credentials refresh --account ${PERSONAL} --role Admin --profile dev; export AWS_PROFILE=dev & ${DEPLOY}`],
  ])("%s is flagged and attributes nothing", (_what, call) => {
    expect(ruleCheck(held(call)).verdict).toBe("flag");
    expect(callSignals({ toolName: "Bash", call, floorReason: "x" }).attributedAccounts).not.toContain(PERSONAL);
  });

  test.each([
    ["corp-creds and the deploy on the same profile", `corp-creds credentials refresh --account ${PERSONAL} --role Admin --profile dev && ${DEPLOY} --profile dev`],
    ["corp-creds writing a profile the shell exports", `corp-creds credentials refresh --account ${PERSONAL} --role Admin --profile dev && export AWS_PROFILE=dev && ${DEPLOY}`],
    ["an sts guard and the deploy on the same profile", `[ "$(aws sts get-caller-identity --profile dev --query Account --output text)" = ${PERSONAL} ] || exit 1; AWS_PROFILE=dev ${DEPLOY}`],
  ])("%s still places the account", (_what, call) => {
    expect(callSignals({ toolName: "Bash", call, floorReason: "x" }).attributedAccounts).toContain(PERSONAL);
  });
});
