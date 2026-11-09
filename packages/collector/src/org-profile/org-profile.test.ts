import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  DEFAULT_ORG_PROFILE,
  ORG_PROFILE_ENV,
  filesForSelf,
  isOrgInternalHost,
  isOrgReviewCli,
  loadOrgProfile,
  mergeOrgProfile,
  orgCliRulesMatching,
  orgCodeReviewRemote,
  orgCredentialCli,
  orgCredentialProgramPattern,
  orgKnownMcpServer,
  orgKnownPluginPrefix,
  orgProfilePath,
  orgReadOnlyMcpTool,
  orgReviewWriteTool,
  orgReviewWriteRule,
  orgCheckoutTool,
  orgCodeReviewProject,
  operandMatches,
  orgSelfFiledTool,
  orgWebFetchHost,
  activeOrgProfile,
  setActiveOrgProfile,
  OrgProfileError,
  readCarriedOrgProfile,
  repeatsGroup,
  orgWrapperCli,
  orgHttpClient,
  orgProgramNames,
  orgWebFetchPage,
  genericCredentialStepAccounts,
} from "./index.js";
import { EXAMPLE_CORP_PROFILE_PATH, exampleCorpProfile } from "./fixtures/example-corp.js";

describe("orgProfilePath", () => {
  test("the env var wins, else the Standup config dir", () => {
    expect(orgProfilePath({ [ORG_PROFILE_ENV]: "/etc/org.json" }, "/home/u")).toBe("/etc/org.json");
    expect(orgProfilePath({}, "/home/u")).toBe("/home/u/.config/standup/org-profile.json");
    expect(orgProfilePath({ [ORG_PROFILE_ENV]: "  " }, "/home/u")).toBe("/home/u/.config/standup/org-profile.json");
  });

  test.each([
    ["~/org.json", "/home/u/org.json"],
    ["~/cfg/../org.json", "/home/u/org.json"],
    ["/etc//standup/./org.json", "/etc/standup/org.json"],
    ["org.json", "org.json"],
    ["./cfg/org.json", "./cfg/org.json"],
    ["~other/org.json", "~other/org.json"],
  ])("%p reads as %p", (set, path) => {
    expect(orgProfilePath({ [ORG_PROFILE_ENV]: set }, "/home/u")).toBe(path);
  });
});

describe("a relative STANDUP_ORG_PROFILE", () => {
  test.each(["org.json", "./cfg/org.json", "~other/org.json"])("%p is refused before anything is read", (set) => {
    const seen: string[] = [];
    const load = loadOrgProfile({
      env: { [ORG_PROFILE_ENV]: set },
      home: "/home/u",
      read: (p) => {
        seen.push(p);
        return "{}";
      },
    });
    expect(seen).toEqual([]);
    expect(load.profile).toBe(DEFAULT_ORG_PROFILE);
    expect(load.errors).toHaveLength(1);
    expect(load.errors[0]).toContain("must be an absolute path");
  });

  test("makes activeOrgProfile throw", () => {
    const before = process.env[ORG_PROFILE_ENV];
    process.env[ORG_PROFILE_ENV] = "relative/org-profile.json";
    setActiveOrgProfile();
    try {
      expect(() => activeOrgProfile()).toThrow(OrgProfileError);
    } finally {
      if (before === undefined) delete process.env[ORG_PROFILE_ENV];
      else process.env[ORG_PROFILE_ENV] = before;
      setActiveOrgProfile();
    }
  });
});

describe("loadOrgProfile", () => {
  test("no file: the default, no errors", () => {
    const load = loadOrgProfile({ env: {}, home: "/nowhere", read: () => undefined });
    expect(load.profile).toBe(DEFAULT_ORG_PROFILE);
    expect(load.path).toBeNull();
    expect(load.errors).toEqual([]);
  });

  test("invalid JSON or an unreadable file keeps the default and reports why", () => {
    const bad = loadOrgProfile({ env: {}, home: "/h", read: () => "{not json" });
    expect(bad.profile).toBe(DEFAULT_ORG_PROFILE);
    expect(bad.errors[0]).toContain("not valid JSON");
    const unreadable = loadOrgProfile({
      env: {},
      home: "/h",
      read: () => {
        throw new Error("EACCES");
      },
    });
    expect(unreadable.profile).toBe(DEFAULT_ORG_PROFILE);
    expect(unreadable.errors[0]).toContain("EACCES");
  });

  test("reads the file the env var names", () => {
    const seen: string[] = [];
    const load = loadOrgProfile({
      env: { [ORG_PROFILE_ENV]: EXAMPLE_CORP_PROFILE_PATH },
      read: (p) => {
        seen.push(p);
        return readFileSync(p, "utf8");
      },
    });
    expect(seen).toEqual([EXAMPLE_CORP_PROFILE_PATH]);
    expect(load.profile.name).toBe("example.corp");
    expect(load.errors).toEqual([]);
  });
});

describe("activeOrgProfile", () => {
  const withProfileFile = (path: string | undefined, run: () => void) => {
    const before = process.env[ORG_PROFILE_ENV];
    if (path === undefined) delete process.env[ORG_PROFILE_ENV];
    else process.env[ORG_PROFILE_ENV] = path;
    setActiveOrgProfile();
    try {
      run();
    } finally {
      if (before === undefined) delete process.env[ORG_PROFILE_ENV];
      else process.env[ORG_PROFILE_ENV] = before;
      setActiveOrgProfile();
    }
  };

  test("a profile file with an invalid entry is refused, on every read, with each error", () => {
    withProfileFile(join(import.meta.dir, "fixtures", "invalid-profile.json"), () => {
      expect(() => activeOrgProfile()).toThrow(OrgProfileError);
      let caught: unknown;
      try {
        activeOrgProfile();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(OrgProfileError);
      expect((caught as OrgProfileError).errors).toEqual(["outwardRules[0].subcommand[0]: is not a valid regular expression"]);
      expect((caught as OrgProfileError).message).toContain("invalid-profile.json");
    });
  });

  test("a file that isn't JSON is refused too", () => {
    withProfileFile(join(import.meta.dir, "org-profile.test.ts"), () => {
      expect(() => activeOrgProfile()).toThrow(OrgProfileError);
    });
  });

  test("a valid file is in force; no file, the default", () => {
    withProfileFile(EXAMPLE_CORP_PROFILE_PATH, () => {
      expect(activeOrgProfile().name).toBe("example.corp");
    });
    withProfileFile(join(import.meta.dir, "fixtures", "no-such-profile.json"), () => {
      expect(activeOrgProfile()).toBe(DEFAULT_ORG_PROFILE);
    });
  });
});

describe("the default profile", () => {
  test("names no org vocabulary", () => {
    expect(DEFAULT_ORG_PROFILE.internalHostSuffixes).toEqual([]);
    expect(DEFAULT_ORG_PROFILE.ownerHostPatterns).toEqual([]);
    expect(DEFAULT_ORG_PROFILE.sso).toEqual({ dirs: [], cookieFiles: [], loginClis: [] });
    expect(DEFAULT_ORG_PROFILE.credentialClis).toEqual([]);
    expect(DEFAULT_ORG_PROFILE.reviewClis).toEqual([]);
    expect(DEFAULT_ORG_PROFILE.wrapperClis).toEqual([]);
    expect(DEFAULT_ORG_PROFILE.httpClients).toEqual([]);
    expect(DEFAULT_ORG_PROFILE.mcp).toEqual({ readOnlyTools: {}, reviewWriteTools: [], checkoutTools: [], selfFiledTools: [], pluginPrefixes: [] });
    expect(DEFAULT_ORG_PROFILE.webFetchDomains).toEqual([]);
    expect(DEFAULT_ORG_PROFILE.webFetchPages).toEqual([]);
    expect(DEFAULT_ORG_PROFILE.identity).toEqual({});
  });

  test("is what an install without a profile file runs with", () => {
    const load = loadOrgProfile({ env: {}, home: "/nowhere", read: () => undefined });
    expect(load.profile).toBe(DEFAULT_ORG_PROFILE);
  });
});

describe("the example.corp fixture", () => {
  test("is a profile of its own, not merged into the default", () => {
    const corp = exampleCorpProfile();
    expect(corp.reviewClis).toEqual(["corp-review"]);
    expect(DEFAULT_ORG_PROFILE.reviewClis).toEqual([]);
    expect(DEFAULT_ORG_PROFILE.wrapperClis).toEqual([]);
    expect(corp.outwardRules.slice(0, DEFAULT_ORG_PROFILE.outwardRules.length)).toEqual(DEFAULT_ORG_PROFILE.outwardRules);
  });
});

describe("wrapper CLIs", () => {
  test("are read with their value options", () => {
    const { profile, errors } = mergeOrgProfile(DEFAULT_ORG_PROFILE, { wrapperClis: [{ program: "x-env", valueOptions: ["--stage", "-s"] }, { program: "x-each" }] });
    expect(errors).toEqual([]);
    expect(orgWrapperCli(profile, "x-env")).toEqual({ program: "x-env", valueOptions: ["--stage", "-s"] });
    expect(orgWrapperCli(profile, "x-each")).toEqual({ program: "x-each" });
    expect(orgWrapperCli(profile, "x-other")).toBeUndefined();
    expect(orgWrapperCli(DEFAULT_ORG_PROFILE, "x-env")).toBeUndefined();
  });

  test.each([
    [{ wrapperClis: "x" }, "wrapperClis: must be a list"],
    [{ wrapperClis: [{ program: "/bin/x" }] }, "wrapperClis[0].program"],
    [{ wrapperClis: [{ program: "x", valueOptions: ["stage"] }] }, "wrapperClis[0].valueOptions[0]"],
    [{ wrapperClis: [{ program: "x", shell: true }] }, "wrapperClis[0].shell: not a wrapper field"],
  ])("%p is refused", (raw, error) => {
    const { profile, errors } = mergeOrgProfile(DEFAULT_ORG_PROFILE, raw);
    expect(errors.some((e) => e.includes(error))).toBe(true);
    expect(profile.wrapperClis).toEqual([]);
  });
});

describe("HTTP clients", () => {
  test("are read with their kind", () => {
    const { profile, errors } = mergeOrgProfile(DEFAULT_ORG_PROFILE, {
      httpClients: [
        { program: "x-curl", kind: "curl-wrapper" },
        { program: "y-curl", kind: "curl-like" },
      ],
    });
    expect(errors).toEqual([]);
    expect(orgHttpClient(profile, "x-curl")).toEqual({ program: "x-curl", kind: "curl-wrapper" });
    expect(orgHttpClient(profile, "y-curl")).toEqual({ program: "y-curl", kind: "curl-like" });
    expect(orgHttpClient(profile, "curl")).toBeUndefined();
    expect(orgHttpClient(DEFAULT_ORG_PROFILE, "x-curl")).toBeUndefined();
  });

  test.each([
    [{ httpClients: "x" }, "httpClients: must be a list"],
    [{ httpClients: [{ program: "/bin/x", kind: "curl-wrapper" }] }, "httpClients[0].program"],
    [{ httpClients: [{ program: "x" }] }, "httpClients[0].kind: must be one of curl-wrapper, curl-like"],
    [{ httpClients: [{ program: "x", kind: "wget" }] }, "httpClients[0].kind"],
    [{ httpClients: [{ program: "x", kind: "curl-like", auth: "kerberos" }] }, "httpClients[0].auth: not an HTTP client field"],
  ])("%p is refused", (raw, error) => {
    const { profile, errors } = mergeOrgProfile(DEFAULT_ORG_PROFILE, raw);
    expect(errors.some((e) => e.includes(error))).toBe(true);
    expect(profile.httpClients).toEqual([]);
  });

  test.each([
    [{ reviewClis: ["x-curl"] }, "reviewClis"],
    [{ wrapperClis: [{ program: "x-curl" }] }, "wrapperClis"],
    [{ credentialClis: [{ program: "x-curl", subcommand: [], accountOption: "--account", roleOption: "--role" }] }, "credentialClis"],
    [{ outwardRules: [{ program: "x-curl|y-curl", subcommand: ["post"], category: "outward", reason: "posts" }] }, "outwardRules"],
  ])("an HTTP client also named by %p is refused", (extra, list) => {
    const { errors } = mergeOrgProfile(DEFAULT_ORG_PROFILE, { ...extra, httpClients: [{ program: "x-curl", kind: "curl-like" }] });
    expect(errors).toContainEqual(expect.stringContaining(`httpClients: x-curl is also in ${list}`));
  });

  test("an HTTP client no other list names loads", () => {
    const { errors } = mergeOrgProfile(DEFAULT_ORG_PROFILE, {
      reviewClis: ["x-review"],
      outwardRules: [{ program: "x-deploy", subcommand: ["go"], category: "outward", reason: "deploys" }],
      httpClients: [{ program: "x-curl", kind: "curl-like" }],
    });
    expect(errors).toEqual([]);
  });
});

describe("WebFetch pages", () => {
  const corp = exampleCorpProfile();
  test.each([
    ["https://www.example.corp/blogs/a-post/", true],
    ["https://www.example.corp/lambda/pricing", true],
    ["http://www.example.corp/blogs", true],
    ["https://www.example.corp/pricing/", false],
    ["https://www.example.corp/blogsx", false],
    ["https://www.example.corp/blogs/a?q=1", false],
    ["https://www.example.corp:8443/blogs/a", false],
    ["https://u:p@www.example.corp/blogs/a", false],
    ["https://sub.www.example.corp/blogs/a", false],
    ["https://www.example.corp/blogs/%2e%2e/x", false],
    ["ftp://www.example.corp/blogs/a", false],
  ])("%p is a listed page: %p", (url, listed) => {
    expect(orgWebFetchPage(corp, url)).toBe(listed);
    expect(orgWebFetchPage(DEFAULT_ORG_PROFILE, url)).toBe(false);
  });

  test.each([
    [{ webFetchPages: "x" }, "webFetchPages: must be a list"],
    [{ webFetchPages: [{ host: "https://x", paths: ["a"] }] }, "webFetchPages[0].host"],
    [{ webFetchPages: [{ host: "x.example", paths: [] }] }, "webFetchPages[0].paths"],
    [{ webFetchPages: [{ host: "x.example", paths: ["(a+)+"] }] }, "webFetchPages[0].paths[0]: repeats a group"],
  ])("%p is refused", (raw, error) => {
    const { profile, errors } = mergeOrgProfile(DEFAULT_ORG_PROFILE, raw);
    expect(errors.some((e) => e.includes(error))).toBe(true);
    expect(profile.webFetchPages).toEqual([]);
  });
});

describe("orgProgramNames", () => {
  test("names the org's review, credential, SSO login and wrapper CLIs", () => {
    expect([...orgProgramNames(exampleCorpProfile())].sort()).toEqual(["corp-assume", "corp-creds", "corp-each", "corp-env", "corp-review", "corp-sso-login"]);
    expect([...orgProgramNames(DEFAULT_ORG_PROFILE)]).toEqual([]);
  });
});

describe("genericCredentialStepAccounts", () => {
  test.each([
    ["deploy-tool --account 111122223333 --role Admin", ["111122223333"]],
    ["deploy-tool --role=Admin --account-id=111122223333", ["111122223333"]],
    ["deploy-tool --role Admin --account $ACCT", ["$ACCT"]],
    ["deploy-tool --role Admin 111122223333", ["111122223333"]],
    // A role alone, away from a credential noun, is no write.
    ["deploy-tool --role Admin", null],
    ["kubectl create rolebinding rb --role=viewer --user=alice", null],
    ["some-cli credentials update --role Admin", []],
    ["some-cli credentials refresh -a 444455556666 -r Admin", ["444455556666"]],
    // `-a` and `-r` name an account and a role only beside a credential noun; a bare 12-digit word names an account anyway.
    ["some-cli update -a 111122223333-x -r Admin", null],
    ["some-cli update -a 444455556666 -r Admin", ["444455556666"]],
    // An account named without a role or credential noun may switch the credentials a later AWS call uses.
    ["deploy-tool --account 111122223333", ["111122223333"]],
    ["deploy-tool --account=$ACCT", ["$ACCT"]],
    ["some-cli assume 444455556666", ["444455556666"]],
    ["/opt/bin/some-cli assume '444455556666'", ["'444455556666'"]],
    // A program that only prints, reads or tests its words switches nothing by naming an account.
    ["grep -qx 444455556666", null],
    ["grep -a 444455556666 notes.txt", null],
    ['[ "$(aws sts get-caller-identity --query Account --output text)" = "444455556666" ]', null],
    ['if [ "$acct" != 444455556666 ]', null],
    ["test $acct = 444455556666", null],
    ["echo 444455556666", null],
    ["LC_ALL=C /usr/bin/grep -q 444455556666", null],
    ["grep -rn credentials --role Admin .", null],
    // Beside a credential noun an account alone is a write, as the floor reads it.
    ["some-cli credentials update --account 444455556666", ["444455556666"]],
    ["some-cli credentials update --account=$ACCT", ["$ACCT"]],
    ["some-cli credentials update 444455556666", ["444455556666"]],
    // Any verb beside a credential noun is read as a write, not only a write verb: it may write an account no one can tell.
    ["some-cli credentials list", []],
    // A program named for credentials writes them by any verb, one the reader can't read too.
    ["cloud-creds refresh", []],
    ["cloud-creds update --no-cache", []],
    ["docker-credential-x renew", []],
    ["cloud-creds $VERB", ["$VERB"]],
    ['cloud-creds "$VERB"', ['"$VERB"']],
    ["cloud-creds", []],
    ["cloud-creds list", []],
    ["/opt/bin/corp_creds.sh refresh", []],
    ["if cloud-creds refresh", []],
    ["cloud-creds refresh --account 444455556666", ["444455556666"]],
    // A step naming no role, account or credential noun is no credential step to the generic reading.
    ["some-cli assume", null],
    ["some-cli assume --role Admin", null],
    // A credential noun inside a quoted message is no operand, as the shell splits words.
    ['git commit -m "rotate credentials"', null],
    ["git commit -m 'rotate the creds'", null],
    ['git commit -m "rotate credentials" credentials', []],
    // A word the reader can't read may name the account, as the floor holds it.
    ["some-cli credentials update $ARGS", ["$ARGS"]],
    ['some-cli credentials update "$ARGS"', ['"$ARGS"']],
    ["deploy-tool --role Admin $ACCOUNT_FLAG", ["$ACCOUNT_FLAG"]],
    // A run|exec wrapper's own words: an account or role there is a write, a credential noun after `--` is the wrapped
    // command's.
    ["some-vault run 444455556666 -- ls", ["444455556666"]],
    ["some-vault exec --account 444455556666 -- ls", ["444455556666"]],
    ["some-vault exec --role Admin -- ls", []],
    ["some-vault exec --role Admin -- ls $DIR", []],
    ["some-vault exec -- other-cli credentials list", null],
    ["some-vault exec -- other-cli credentials update $ARGS", null],
    ["some-vault exec creds -- ls $DIR", []],
    ["ls -la", null],
  ])("%p reads as %p", (step, accounts) => {
    expect(genericCredentialStepAccounts(step)).toEqual(accounts);
  });
});

describe("mergeOrgProfile", () => {
  test("lists append to the default's and never replace them", () => {
    const { profile, errors } = mergeOrgProfile(DEFAULT_ORG_PROFILE, {
      outwardRules: [{ program: "x-deploy", subcommand: [], category: "outward", reason: "deploys" }],
      sso: { dirs: [".x-sso"] },
    });
    expect(errors).toEqual([]);
    expect(profile.outwardRules.length).toBe(DEFAULT_ORG_PROFILE.outwardRules.length + 1);
    expect(profile.outwardRules.slice(0, -1)).toEqual(DEFAULT_ORG_PROFILE.outwardRules);
    expect(profile.sso.dirs).toEqual([...DEFAULT_ORG_PROFILE.sso.dirs, ".x-sso"]);
  });

  test("does not mutate the default", () => {
    const before = JSON.stringify(DEFAULT_ORG_PROFILE);
    mergeOrgProfile(DEFAULT_ORG_PROFILE, { mcp: { readOnlyTools: { s: ["t"] } }, reviewClis: ["r"] });
    expect(JSON.stringify(DEFAULT_ORG_PROFILE)).toBe(before);
  });

  const invalid: Array<[string, unknown, string]> = [
    ["not an object", [], "JSON object"],
    ["unknown top-level key", { outwardRule: [] }, "outwardRule: not a profile field"],
    ["bad regex", { outwardRules: [{ program: "x", subcommand: ["("], category: "outward", reason: "r" }] }, "outwardRules[0].subcommand[0]"],
    ["bad program regex", { outwardRules: [{ program: "x(", subcommand: [], category: "outward", reason: "r" }] }, "outwardRules[0].program"],
    ["a whole-line pattern", { outwardRules: [{ pattern: "^x deploy", category: "outward", reason: "r" }] }, "outwardRules[0]: must be"],
    ["bad category", { outwardRules: [{ program: "x", subcommand: [], category: "allow", reason: "r" }] }, "outwardRules[0].category"],
    ["value option that isn't one", { outwardRules: [{ program: "x", valueOptions: ["C"], subcommand: [], category: "outward", reason: "r" }] }, "outwardRules[0].valueOptions[0]"],
    ["anywhere not boolean", { outwardRules: [{ program: "x", subcommand: [], anywhere: "yes", category: "outward", reason: "r" }] }, "outwardRules[0].anywhere"],
    ["repeated group in a subcommand", { outwardRules: [{ program: "x", subcommand: ["(?:a|a)*b"], category: "outward", reason: "r" }] }, "outwardRules[0].subcommand[0]: repeats a group"],
    ["repeated group in a program", { outwardRules: [{ program: "(?:x-)+deploy", subcommand: [], category: "outward", reason: "r" }] }, "outwardRules[0].program: repeats a group"],
    ["repeated group in a credential subcommand", { credentialClis: [{ program: "c", subcommand: ["(?:cred)+"] }] }, "credentialClis[0].subcommand[0]: repeats a group"],
    ["repeated group in a remote pattern", { codeReview: { remotePatterns: ["(a+)+$"] } }, "codeReview.remotePatterns[0]: repeats a group"],
    ["repeated group in a link pattern", { codeReview: { linkFormat: { urlPattern: "^https://x/(?:\\w+/){1,}" } } }, "codeReview.linkFormat.urlPattern: repeats a group"],
    ["repeated group in a checkout id pattern", { mcp: { checkoutTools: [{ server: "s", tool: "t", idField: "id", idPattern: "(\\d+)*", dirField: "dir", defaultName: "R-{id}" }] } }, "mcp.checkoutTools[0].idPattern: repeats a group"],
    ["absolute sso dir", { sso: { dirs: ["/etc/sso"] } }, "sso.dirs[0]"],
    ["sso dir climbing out", { sso: { dirs: ["a/../../b"] } }, "sso.dirs[0]"],
    ["review cli with a path", { reviewClis: ["/usr/bin/x"] }, "reviewClis[0]"],
    ["host suffix with a scheme", { internalHostSuffixes: ["https://x"] }, "internalHostSuffixes[0]"],
    ["owner host glob with a space", { ownerHostPatterns: ["dev box"] }, "ownerHostPatterns[0]"],
    ["credential cli without program", { credentialClis: [{ subcommand: [] }] }, "credentialClis[0].program"],
    ["credential cli bad option", { credentialClis: [{ program: "c", subcommand: [], accountOption: "account" }] }, "credentialClis[0].accountOption"],
    ["url template without {id}", { codeReview: { linkFormat: { urlTemplate: "https://x/" } } }, "codeReview.linkFormat.urlTemplate"],
    ["bad remote pattern", { codeReview: { remotePatterns: ["["] } }, "codeReview.remotePatterns[0]"],
    ["bad provision pattern", { codeReview: { provisionPatterns: ["("] } }, "codeReview.provisionPatterns[0]"],
    ["bad launch-subdir pattern", { codeReview: { launchSubdirPatterns: ["["] } }, "codeReview.launchSubdirPatterns[0]"],
    ["credential cli bad subcommand pattern", { credentialClis: [{ program: "c", subcommand: ["("] }] }, "credentialClis[0].subcommand[0]"],
    ["credential cli bad alias", { credentialClis: [{ program: "c", subcommand: [], accountAliases: ["a"] }] }, "credentialClis[0].accountAliases[0]"],
    ["credential cli positional not boolean", { credentialClis: [{ program: "c", subcommand: [], positionalAccount: "yes" }] }, "credentialClis[0].positionalAccount"],
    ["credential cli bad profile option", { credentialClis: [{ program: "c", subcommand: [], profileOption: "profile" }] }, "credentialClis[0].profileOption"],
    ["review write tool bad file field", { mcp: { reviewWriteTools: [{ server: "s", tool: "t", fileField: "a b" }] } }, "mcp.reviewWriteTools[0].fileField"],
    ["review write tool without a tool", { mcp: { reviewWriteTools: [{ server: "s" }] } }, "mcp.reviewWriteTools[0]"],
    ["checkout tool bad id pattern", { mcp: { checkoutTools: [{ server: "s", tool: "t", idField: "id", idPattern: "(", dirField: "dir", defaultName: "R-{id}" }] } }, "mcp.checkoutTools[0].idPattern"],
    ["checkout tool name with a slash", { mcp: { checkoutTools: [{ server: "s", tool: "t", idField: "id", idPattern: "(\\d+)", dirField: "dir", defaultName: "../{id}" }] } }, "mcp.checkoutTools[0].defaultName"],
    ["checkout tool name without {id}", { mcp: { checkoutTools: [{ server: "s", tool: "t", idField: "id", idPattern: "(\\d+)", dirField: "dir", defaultName: "review" }] } }, "mcp.checkoutTools[0].defaultName"],
    ["checkout tool without a dir field", { mcp: { checkoutTools: [{ server: "s", tool: "t", idField: "id", idPattern: "(\\d+)", defaultName: "R-{id}" }] } }, "mcp.checkoutTools[0].dirField"],
  ];
  for (const [name, raw, expected] of invalid) {
    test(`drops and reports: ${name}`, () => {
      const { profile, errors } = mergeOrgProfile(DEFAULT_ORG_PROFILE, raw);
      expect(errors.some((e) => e.includes(expected))).toBe(true);
      expect(profile.outwardRules).toEqual(DEFAULT_ORG_PROFILE.outwardRules);
      expect(profile.reviewClis).toEqual(DEFAULT_ORG_PROFILE.reviewClis);
    });
  }
});

describe("the example.corp fixture validates and exercises every field", () => {
  const p = exampleCorpProfile();
  test("every list and section is populated", () => {
    expect(p.internalHostSuffixes.length).toBeGreaterThan(0);
    expect(p.ownerHostPatterns).toEqual(["devbox-{owner}-*"]);
    expect(p.sso.dirs.length).toBeGreaterThan(DEFAULT_ORG_PROFILE.sso.dirs.length);
    expect(p.sso.cookieFiles.length).toBeGreaterThan(0);
    expect(p.sso.loginClis.length).toBeGreaterThan(0);
    expect(p.credentialClis.length).toBeGreaterThan(0);
    expect(p.reviewClis.length).toBeGreaterThan(0);
    expect(p.outwardRules.length).toBeGreaterThan(DEFAULT_ORG_PROFILE.outwardRules.length);
    expect(p.wrapperClis.some((r) => r.valueOptions?.length)).toBe(true);
    expect(new Set(p.httpClients.map((c) => c.kind))).toEqual(new Set(["curl-wrapper", "curl-like"]));
    expect(Object.keys(p.mcp.readOnlyTools).length).toBeGreaterThan(0);
    expect(p.mcp.reviewWriteTools.length).toBeGreaterThan(0);
    expect(p.mcp.reviewWriteTools.some((r) => r.fileField)).toBe(true);
    expect(p.mcp.checkoutTools.length).toBeGreaterThan(0);
    expect(p.mcp.selfFiledTools.length).toBeGreaterThan(0);
    expect(p.credentialClis.some((r) => r.accountAliases?.length && r.roleAliases?.length && r.profileOption && r.printSubcommands?.length)).toBe(true);
    expect(p.credentialClis.some((r) => r.positionalAccount && r.execSubcommands?.length)).toBe(true);
    expect(p.codeReview.provisionPatterns.length).toBeGreaterThan(0);
    expect(p.codeReview.launchSubdirPatterns.length).toBeGreaterThan(0);
    expect(p.mcp.pluginPrefixes.length).toBeGreaterThan(0);
    expect(p.webFetchDomains.length).toBeGreaterThan(0);
    expect(p.webFetchPages.length).toBeGreaterThan(0);
    expect(p.identity.emailDomain).toBe("example.corp");
    expect(p.codeReview.remotePatterns.length).toBeGreaterThan(0);
    expect(p.codeReview.cutCommand).toBeTruthy();
    expect(p.codeReview.reviseCommand).toBeTruthy();
    expect(p.codeReview.linkFormat.urlPattern).toBeTruthy();
  });
});

describe("profile readings", () => {
  const corp = exampleCorpProfile();
  const neutral = DEFAULT_ORG_PROFILE;

  test("internal hosts", () => {
    const cases: Array<[string, boolean, boolean]> = [
      ["example.corp", true, false],
      ["code.example.corp", true, false],
      ["CODE.EXAMPLE.CORP.", true, false],
      ["notexample.corp", false, false],
      ["example.corp.evil.com", false, false],
      ["github.com", false, false],
    ];
    for (const [host, inCorp, inDefault] of cases) {
      expect([host, isOrgInternalHost(corp, host)]).toEqual([host, inCorp]);
      expect([host, isOrgInternalHost(neutral, host)]).toEqual([host, inDefault]);
    }
  });

  test("outward rules: the default's generic steps, and the org's beside them", () => {
    const cases: Array<[string, string | null, string | null]> = [
      ["git push origin main ", "outward", "outward"],
      ["git -C x push ", "outward", "outward"],
      ["git --no-pager -c a=b push ", "outward", "outward"],
      // A subcommand's own `push`, `delete` or `publish` word is no such step.
      ["git -C x stash push -m wip ", null, null],
      ["git --no-pager stash push ", null, null],
      ["kubectl get pods delete ", null, null],
      ["kubectl -n prod delete pod x ", "outward", "outward"],
      ["npm run publish-docs ", null, null],
      ["docker -H tcp://h push img ", "outward", "outward"],
      ["terraform -chdir=infra apply ", "outward", "outward"],
      ["gh pr create --fill ", "outward", "outward"],
      ["gh pr view 3 ", null, null],
      ["gh release create v1 ", "outward", "outward"],
      ["kubectl apply -f x.yaml ", "outward", "outward"],
      ["kubectl get pods ", null, null],
      ["terraform apply ", "outward", "outward"],
      ["terraform plan ", null, null],
      ["npm publish ", "outward", "outward"],
      ["npm install ", null, null],
      ["docker push img ", "outward", "outward"],
      ["docker image push img ", "outward", "outward"],
      ["docker image ls ", null, null],
      ["git -C push status ", null, null],
      ["git -- push ", "outward", "outward"],
      ["/usr/bin/git push ", null, null],
      ["gh -R o/r pr merge 3 ", "outward", "outward"],
      ["gh --repo pr view ", null, null],
      ["git", null, null],
      ["", null, null],
      ["corp-deploy pipeline promote ", null, "outward"],
      ["corp-deploy --stage x release ", null, "outward"],
      ["corp-deploy status ", null, null],
      ["corp-tickets create ", null, "outward"],
      ["corp-tickets -q ops update ", null, "outward"],
      ["corp-tickets list create ", null, null],
    ];
    for (const [named, inDefault, inCorp] of cases) {
      const got: Array<string | null> = [named, orgCliRulesMatching(neutral, named)[0]?.category ?? null];
      expect(got).toEqual([named, inDefault]);
      const corpGot: Array<string | null> = [named, orgCliRulesMatching(corp, named)[0]?.category ?? null];
      expect(corpGot).toEqual([named, inCorp]);
    }
  });

  test("outward rules take linear time on long runs of options, matching or not", () => {
    const programs = [...new Set([...neutral.outwardRules, ...corp.outwardRules].flatMap((r) => r.program.split("|")))];
    const runs = ["--a ", "-a ", "--a=b ", "-C ", "-C x ", "-- ", "a "];
    for (const program of programs) {
      for (const run of runs) {
        for (const tail of ["publishx", "push", "pr create", "apply", "promote"]) {
          const named = `${program} ${run.repeat(400)}${tail} `;
          const started = performance.now();
          orgCliRulesMatching(neutral, named);
          orgCliRulesMatching(corp, named);
          expect([named.slice(0, 40), performance.now() - started < 50]).toEqual([named.slice(0, 40), true]);
        }
      }
    }
  });

  test.each([
    ["(?:a|a)*b", true],
    ["(a+)+$", true],
    ["(?:\\w+ ){2,}", true],
    ["(?:x){3}", true],
    ["(?:R-)?(\\d{1,9})(?::\\d+)?", false],
    ["cred\\S*", false],
    ["\\(a\\)*", false],
    ["[)]*", false],
    ["[\\])]+", false],
    ["[]a)*", true],
    ["[^]a)+", true],
    ["create|merge", false],
  ])("repeatsGroup(%p) is %p", (source, repeats) => {
    expect(repeatsGroup(source)).toBe(repeats);
  });

  test("every built-in pattern of the default and fixture profiles passes the loader's checks", () => {
    for (const p of [neutral, corp]) {
      expect(readCarriedOrgProfile(JSON.parse(JSON.stringify(p)))).toEqual(p);
    }
  });

  test("review and credential CLIs", () => {
    expect(isOrgReviewCli(corp, "corp-review")).toBe(true);
    expect(isOrgReviewCli(neutral, "corp-review")).toBe(false);
    expect(orgCredentialCli(corp, "corp-creds")?.accountOption).toBe("--account");
    expect(orgCredentialCli(neutral, "corp-creds")).toBeUndefined();
    const pattern = orgCredentialProgramPattern(corp)!;
    expect(pattern.test("corp-creds credentials refresh")).toBe(true);
    expect(pattern.test("x && corp-sso-login")).toBe(true);
    expect(pattern.test("my-corp-creds-wrapper")).toBe(false);
    expect(orgCredentialProgramPattern(neutral)).toBeNull();
  });

  test("MCP tools", () => {
    expect(orgReadOnlyMcpTool(corp, "corp-mcp", "SearchCode")).toBe(true);
    expect(orgReadOnlyMcpTool(corp, "plugin_corp-agents_corp-mcp", "SearchCode")).toBe(true);
    expect(orgReadOnlyMcpTool(corp, "corp-mcp", "CreateTicket")).toBe(false);
    expect(orgReadOnlyMcpTool(corp, "corp-docs-mcp", "Anything")).toBe(true);
    expect(orgReadOnlyMcpTool(corp, "corp-docs-mcp", "")).toBe(false);
    expect(orgReadOnlyMcpTool(neutral, "corp-mcp", "SearchCode")).toBe(false);
    expect(orgKnownMcpServer(corp, "corp-mcp")).toBe(true);
    expect(orgKnownMcpServer(neutral, "corp-mcp")).toBe(false);
    expect(orgKnownPluginPrefix(corp, "plugin_corp-agents_corp-mcp")).toBe(true);
    expect(orgKnownPluginPrefix(neutral, "plugin_corp-agents_corp-mcp")).toBe(false);
    expect(orgReviewWriteTool(corp, "corp-mcp", "ReviewWrite", { action: "update-description" })).toBe(true);
    expect(orgReviewWriteTool(corp, "corp-mcp", "ReviewWrite", { action: "merge" })).toBe(false);
  });

  test("self-filed tools", () => {
    const rule = orgSelfFiledTool(corp, "corp-mcp", "CreateTicket")!;
    const cases: Array<[Record<string, unknown>, boolean]> = [
      [{ title: "x" }, true],
      [{ title: "x", assignee: "currentUser" }, true],
      [{ title: "x", assignee: "someone" }, false],
      [{ title: "x", watchers: ["bob"] }, false],
      [{ title: "x", delegate: "carol" }, false],
      [{ title: "x", assignee: "" }, true],
    ];
    for (const [input, expected] of cases) expect([input, filesForSelf(rule, input)]).toEqual([input, expected]);
    expect(orgSelfFiledTool(neutral, "corp-mcp", "CreateTicket")).toBeUndefined();
  });

  test("review write and checkout rules", () => {
    expect(orgReviewWriteRule(corp, "corp-mcp", "ReviewWrite", { action: "update-description" })?.fileField).toBe("description");
    expect(orgReviewWriteRule(corp, "corp-mcp", "ReviewWrite", { action: "merge" })).toBeUndefined();
    expect(orgCheckoutTool(corp, "plugin_corp-agents_corp-mcp", "CheckoutReview")?.defaultName).toBe("R-{id}");
    expect(orgCheckoutTool(neutral, "corp-mcp", "CheckoutReview")).toBeUndefined();
  });

  test("credential subcommand words match whole operands", () => {
    const cases: Array<[string, string | null, boolean]> = [
      ["refresh", "refresh", true],
      ["refresh", "refreshes", false],
      ["renew|refresh", "refresh", true],
      ["cred(?:entials)?", "cred", true],
      ["cred(?:entials)?", "credentials", true],
      ["cred(?:entials)?", "credentialsx", false],
      ["update", null, false],
    ];
    for (const [source, operand, expected] of cases) expect([source, operand, operandMatches(source, operand)]).toEqual([source, operand, expected]);
  });

  test("projects the generic code-review adapter takes by their provision or launch subdir", () => {
    expect(orgCodeReviewProject(corp, { provision: "corp-provision --name x" })).toBe(true);
    expect(orgCodeReviewProject(corp, { launchSubdir: "pkgs/app" })).toBe(true);
    expect(orgCodeReviewProject(corp, { launchSubdir: "src/app", provision: "git worktree add" })).toBe(false);
    expect(orgCodeReviewProject(corp, {})).toBe(false);
    expect(orgCodeReviewProject(neutral, { provision: "corp-provision", launchSubdir: "pkgs/app" })).toBe(false);
  });

  test("WebFetch hosts and code-review remotes", () => {
    expect(orgWebFetchHost(corp, "docs.example.corp")).toBe(true);
    expect(orgWebFetchHost(corp, "api.docs.example.corp")).toBe(true);
    expect(orgWebFetchHost(neutral, "docs.example.corp")).toBe(false);
    expect(orgCodeReviewRemote(corp, "ssh://git@code.example.corp/acme/app.git")).toBe(true);
    expect(orgCodeReviewRemote(corp, "https://github.com/a/b.git")).toBe(false);
    expect(orgCodeReviewRemote(neutral, "ssh://git@code.example.corp/acme/app.git")).toBe(false);
  });
});
