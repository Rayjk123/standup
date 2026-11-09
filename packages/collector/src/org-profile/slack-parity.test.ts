// The Slack adapter reads the org profile on its own (it does not depend on the
// collector): packages/slack/src/env.ts resolves the profile file and picks out
// `identity.emailDomain` to decide which Slack users merge into an alias. These
// cases hold it to the collector's reading, so the domain Slack merges on is
// one the collector also uses for co-author emails.
import { describe, expect, test } from "bun:test";
import { isAbsolute } from "path";
import { orgProfileEmailDomain, orgProfileFile } from "../../../slack/src/env.js";
import { loadOrgProfile, orgProfilePath } from "./load.js";

const HOME = "/home/tester";

describe("Slack resolves the org profile file the collector reads", () => {
  test.each([
    [{}],
    [{ STANDUP_ORG_PROFILE: "" }],
    [{ STANDUP_ORG_PROFILE: "   " }],
    [{ STANDUP_ORG_PROFILE: "~" }],
    [{ STANDUP_ORG_PROFILE: "~/" }],
    [{ STANDUP_ORG_PROFILE: "~/profiles/org.json" }],
    [{ STANDUP_ORG_PROFILE: " ~/profiles/../org.json " }],
    [{ STANDUP_ORG_PROFILE: "/etc/standup//org.json" }],
    [{ STANDUP_ORG_PROFILE: "relative/org.json" }],
    [{ STANDUP_ORG_PROFILE: "~other/org.json" }],
  ] as const)("%p", (env) => {
    const collector = orgProfilePath(env, HOME);
    expect(orgProfileFile(env, HOME)).toBe(isAbsolute(collector) ? collector : undefined);
  });
});

describe("Slack merges on a profile email domain only when the collector uses the same one", () => {
  const PATH = "/home/tester/.config/standup/org-profile.json";

  test.each([
    ["corp.example"],
    ["Corp.Example"],
    ["  corp.example  "],
    ["corp"],
    ["mail.corp-1.example"],
    ["@corp.example"],
    [".corp.example"],
    ["corp-.example"],
    ["corp..example"],
    ["corp.example."],
    ["not a domain"],
    ["*.corp.example"],
    ["corp.example/path"],
    [""],
    ["   "],
    [42],
    [null],
    [["corp.example"]],
  ] as const)("identity.emailDomain %p", (emailDomain) => {
    const text = JSON.stringify({ name: "Example", identity: { emailDomain } });
    const read = (p: string) => (p === PATH ? text : undefined);
    const load = loadOrgProfile({ env: {}, home: HOME, read });
    const slack = orgProfileEmailDomain({}, { home: HOME, read });
    if (slack !== undefined) {
      expect(load.errors).toEqual([]);
      expect(slack).toBe(load.profile.identity.emailDomain!);
    }
    if (load.errors.length === 0 && load.profile.identity.emailDomain && !load.profile.identity.emailDomain.startsWith(".")) {
      expect(slack).toBe(load.profile.identity.emailDomain);
    }
  });

  test("a mixed-case domain reads the same on both sides", () => {
    const text = JSON.stringify({ identity: { emailDomain: "Corp.Example" } });
    const read = (p: string) => (p === PATH ? text : undefined);
    expect(loadOrgProfile({ env: {}, home: HOME, read }).profile.identity.emailDomain).toBe("corp.example");
    expect(orgProfileEmailDomain({}, { home: HOME, read })).toBe("corp.example");
  });
});
