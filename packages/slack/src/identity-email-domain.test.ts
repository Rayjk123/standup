import { describe, expect, test } from "bun:test";
import { identityEmailDomainFrom, orgProfileEmailDomain, orgProfileFile, type TextReader } from "./env.js";

const HOME = "/home/tester";
const DEFAULT_PATH = "/home/tester/.config/standup/org-profile.json";

/** A reader serving one file at `path`; every other path reads as missing. */
function fileAt(path: string, text: string): TextReader {
  return (p) => (p === path ? text : undefined);
}

const profile = (emailDomain: unknown) => JSON.stringify({ name: "Example", identity: { emailDomain } });

describe("orgProfileFile", () => {
  test.each([
    [{}, DEFAULT_PATH],
    [{ STANDUP_ORG_PROFILE: "  " }, DEFAULT_PATH],
    [{ STANDUP_ORG_PROFILE: "/etc/standup/profile.json" }, "/etc/standup/profile.json"],
    [{ STANDUP_ORG_PROFILE: "~/profiles/org.json" }, "/home/tester/profiles/org.json"],
    [{ STANDUP_ORG_PROFILE: "relative/org.json" }, undefined],
  ] as const)("%p resolves to %p", (env, expected) => {
    expect(orgProfileFile(env, HOME)).toBe(expected);
  });
});

describe("orgProfileEmailDomain", () => {
  test.each([
    ["a plain domain", profile("Example.COM"), "example.com"],
    ["surrounding blanks", profile("  corp.example "), "corp.example"],
    ["a single label, which the collector accepts", profile("corp"), "corp"],
    ["a leading @, which the collector refuses", profile("@example.com"), undefined],
    ["a leading dot, which no email address is at", profile(".example.com"), undefined],
    ["a blank domain", profile("  "), undefined],
    ["no identity block", JSON.stringify({ name: "Example" }), undefined],
    ["an identity that is not an object", JSON.stringify({ identity: "corp.example" }), undefined],
    ["a non-string domain", profile(42), undefined],
    ["not a domain name", profile("not a domain"), undefined],
    ["a label ending in a hyphen", profile("corp-.example"), undefined],
    ["a file that is not JSON", "{ nope", undefined],
    ["a JSON array", "[]", undefined],
  ] as const)("%s", (_label, text, expected) => {
    expect(orgProfileEmailDomain({}, { home: HOME, read: fileAt(DEFAULT_PATH, text) })).toBe(expected);
  });

  test("no profile file gives no domain", () => {
    expect(orgProfileEmailDomain({}, { home: HOME, read: () => undefined })).toBeUndefined();
  });

  test("an unreadable file gives no domain", () => {
    const read: TextReader = () => {
      throw new Error("EACCES");
    };
    expect(orgProfileEmailDomain({}, { home: HOME, read })).toBeUndefined();
  });

  test("reads the file STANDUP_ORG_PROFILE names", () => {
    const env = { STANDUP_ORG_PROFILE: "~/org.json" };
    expect(orgProfileEmailDomain(env, { home: HOME, read: fileAt("/home/tester/org.json", profile("corp.example")) })).toBe(
      "corp.example"
    );
    expect(orgProfileEmailDomain(env, { home: HOME, read: fileAt(DEFAULT_PATH, profile("corp.example")) })).toBeUndefined();
  });

  test("a relative STANDUP_ORG_PROFILE reads nothing", () => {
    let reads = 0;
    const read: TextReader = () => {
      reads++;
      return profile("corp.example");
    };
    expect(orgProfileEmailDomain({ STANDUP_ORG_PROFILE: "org.json" }, { home: HOME, read })).toBeUndefined();
    expect(reads).toBe(0);
  });
});

describe("identityEmailDomainFrom", () => {
  const withProfile = { home: HOME, read: fileAt(DEFAULT_PATH, profile("corp.example")) };
  const noProfile = { home: HOME, read: () => undefined };

  test.each([
    ["unset defaults to the org profile's domain", {}, withProfile, "corp.example"],
    ["blank defaults to the org profile's domain", { SLACK_IDENTITY_EMAIL_DOMAIN: "  " }, withProfile, "corp.example"],
    ["set overrides the org profile", { SLACK_IDENTITY_EMAIL_DOMAIN: "Slack.Example" }, withProfile, "slack.example"],
    ["set without an org profile", { SLACK_IDENTITY_EMAIL_DOMAIN: "@slack.example" }, noProfile, "slack.example"],
    ["set to a non-domain merges no one", { SLACK_IDENTITY_EMAIL_DOMAIN: "none" }, withProfile, undefined],
    ["neither configured merges no one", {}, noProfile, undefined],
  ] as const)("%s", (_label, env, opts, expected) => {
    expect(identityEmailDomainFrom(env, opts)).toBe(expected);
  });
});
