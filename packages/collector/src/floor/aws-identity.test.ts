import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { awsKeysFor, createAwsIdentity, iniSection, type AwsKeys } from "./aws-identity.js";
import type { AwsTarget } from "./classify.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const CREDENTIALS = [
  "[default]",
  "aws_access_key_id = AKIADEFAULT",
  "aws_secret_access_key = s-default",
  "aws_session_token = t-default",
  "",
  "[dev]",
  "aws_access_key_id=AKIADEV",
  "aws_secret_access_key=s-dev",
  "",
].join("\n");

const home = (config?: string) => {
  const h = mkdtempSync(join(tmpdir(), "aws-identity-"));
  dirs.push(h);
  mkdirSync(join(h, ".aws"));
  writeFileSync(join(h, ".aws", "credentials"), CREDENTIALS);
  if (config !== undefined) writeFileSync(join(h, ".aws", "config"), config);
  return h;
};

const target = (t: Partial<AwsTarget> = {}): AwsTarget => ({ env: {}, profile: null, region: null, cwd: null, ...t });

describe("awsKeysFor", () => {
  test("reads the default profile's static keys", () => {
    expect(awsKeysFor(target(), { env: {}, home: home() })).toEqual({ accessKeyId: "AKIADEFAULT", secretAccessKey: "s-default", sessionToken: "t-default" });
  });

  test("honors --profile, then the call's AWS_PROFILE, then the inherited one", () => {
    const h = home();
    expect(awsKeysFor(target({ profile: "dev" }), { env: { AWS_PROFILE: "default" }, home: h })?.accessKeyId).toBe("AKIADEV");
    expect(awsKeysFor(target({ env: { AWS_PROFILE: "dev" } }), { env: {}, home: h })?.accessKeyId).toBe("AKIADEV");
    expect(awsKeysFor(target(), { env: { AWS_PROFILE: "dev" }, home: h })?.accessKeyId).toBe("AKIADEV");
    expect(awsKeysFor(target({ profile: "prod" }), { env: {}, home: h })).toBeNull();
  });

  test("uses keys in the environment over the files", () => {
    const keys = awsKeysFor(target({ env: { AWS_ACCESS_KEY_ID: "AKIAENV", AWS_SECRET_ACCESS_KEY: "s-env" } }), { env: {}, home: home() });
    expect(keys).toEqual({ accessKeyId: "AKIAENV", secretAccessKey: "s-env" });
    expect(awsKeysFor(target({ env: { AWS_ACCESS_KEY_ID: "AKIAENV" } }), { env: {}, home: home() })).toBeNull();
  });

  test("answers null for credentials the CLI would get some other way", () => {
    for (const setting of ["role_arn = arn:aws:iam::111122223333:role/R", "credential_process = /bin/creds", "sso_session = s", "source_profile = dev"]) {
      expect(awsKeysFor(target(), { env: {}, home: home(`[default]\n${setting}\n`) })).toBeNull();
    }
    expect(awsKeysFor(target({ profile: "dev" }), { env: {}, home: home("[profile dev]\nrole_arn = arn:aws:iam::1:role/R\n") })).toBeNull();
    expect(awsKeysFor(target(), { env: {}, home: home("[profile dev]\nrole_arn = arn:aws:iam::1:role/R\n[default]\nregion = us-east-1\n") })?.accessKeyId).toBe("AKIADEFAULT");
    expect(awsKeysFor(target(), { env: { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/creds" }, home: home() })).toBeNull();
    expect(awsKeysFor(target({ env: { AWS_ROLE_ARN: "arn" } }), { env: {}, home: home() })).toBeNull();
  });

  test("answers null when the call moves HOME or the profiles disagree", () => {
    const h = home();
    expect(awsKeysFor(target({ env: { HOME: "/tmp/elsewhere" } }), { env: {}, home: h })).toBeNull();
    expect(awsKeysFor(target(), { env: { AWS_PROFILE: "dev", AWS_DEFAULT_PROFILE: "default" }, home: h })).toBeNull();
  });

  test("answers null without a credentials file", () => {
    const h = mkdtempSync(join(tmpdir(), "aws-identity-"));
    dirs.push(h);
    expect(awsKeysFor(target(), { env: {}, home: h })).toBeNull();
  });
});

test("iniSection reads one section's keys", () => {
  expect(iniSection("[a]\nx = 1\n# c\n[b]\ny=2\n", "b")).toEqual(new Map([["y", "2"]]));
  expect(iniSection("[a]\nx = 1\n", "b")).toBeNull();
});

describe("createAwsIdentity", () => {
  const make = (answer: (keys: AwsKeys) => Promise<string | null>) => {
    let t = 0;
    const calls: string[] = [];
    const id = createAwsIdentity({
      env: {},
      home: home(),
      now: () => t,
      callerAccount: async (keys) => {
        calls.push(keys.accessKeyId);
        return answer(keys);
      },
    });
    return { id, calls, advance: (ms: number) => (t += ms) };
  };

  test("asks STS once per credential set and caches the account", async () => {
    const { id, calls, advance } = make(async () => "111122223333");
    expect(id.cached(target())).toBeUndefined();
    expect(await id.resolve(target())).toBe("111122223333");
    expect(id.cached(target())).toBe("111122223333");
    expect(await id.resolve(target())).toBe("111122223333");
    expect(calls).toEqual(["AKIADEFAULT"]);
    expect(await id.resolve(target({ profile: "dev" }))).toBe("111122223333");
    expect(calls).toEqual(["AKIADEFAULT", "AKIADEV"]);
    advance(16 * 60_000);
    expect(id.cached(target())).toBeUndefined();
  });

  test("a failure, a throw or a malformed answer is null, cached briefly", async () => {
    for (const answer of [async () => null, async () => Promise.reject(new Error("timeout")), async () => "not-an-account"]) {
      const { id, calls, advance } = make(answer);
      expect(await id.resolve(target())).toBeNull();
      expect(id.cached(target())).toBeNull();
      advance(31_000);
      expect(id.cached(target())).toBeUndefined();
      expect(calls).toHaveLength(1);
    }
  });

  test("unreadable credentials are null without asking STS", async () => {
    const { id, calls } = make(async () => "111122223333");
    expect(id.cached(target({ profile: "prod" }))).toBeNull();
    expect(await id.resolve(target({ profile: "prod" }))).toBeNull();
    expect(calls).toEqual([]);
  });
});
