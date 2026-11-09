import { describe, expect, test } from "bun:test";
import { classifyToolCall, knownMcpServer, type FloorProbes } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";
import { homeCookieFile, homeSecretFile } from "./home-credentials.js";
import { DEFAULT_ORG_PROFILE } from "../org-profile/default.js";
import { mergeOrgProfile } from "../org-profile/load.js";
import { exampleCorpProfile } from "../org-profile/fixtures/example-corp.js";

/*
 * The safety floor reads an org's vocabulary from the launch's org profile
 * (FloorConfig.orgProfile): its review and credential CLIs, CLI rules, SSO
 * dirs and cookie, internal hosts, and MCP tools. The built-in default names
 * none of an org's tools, and still holds the generic outward steps.
 */

const HOME = "/home/tester";
const DATA = `${HOME}/.local/share/standup`;
const ROOT = `${HOME}/code/standup-worktrees/proj/fix-1`;
const INSTALL = "/opt/standup";

const base: FloorConfig = {
  v: 1,
  collectorUrl: "http://localhost:7777",
  launchId: "launch-1",
  root: ROOT,
  sharedBranches: ["main"],
  personalAwsAccounts: [],
  waitSeconds: 60,
  standupDataDir: DATA,
  floorPaths: [`${INSTALL}/packages/collector/src/floor`],
  installDir: INSTALL,
  protectedPaths: [`${DATA}/secrets`],
  tmpDirs: ["/tmp"],
  workerToken: "x".repeat(64),
  replyPublicKey: "test",
};
const corp: FloorConfig = { ...base, orgProfile: exampleCorpProfile() };

/** Another worktree of the launch's job, below the data dir's `worktrees/`. */
const JOB_ROOT = `${DATA}/worktrees/proj/fix-2`;

const DIRS = new Set<string>([ROOT, "/tmp", "/", HOME, `${HOME}/.corp-sso`, INSTALL, JOB_ROOT]);
const FILES: Record<string, string> = { [`${HOME}/.corp-sso/cookie`]: "session=1\n", [`${ROOT}/.git`]: "gitdir: /tmp/x\n" };

function probes(): Partial<FloorProbes> {
  return {
    gitBranch: () => "fix-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    readFile: (p) => (p in FILES ? { ok: true, text: FILES[p]! } : { ok: false, reason: "missing" }),
    exists: (p) => p in FILES || DIRS.has(p),
    isDirectory: (p) => DIRS.has(p),
    listDir: () => [],
    realpath: (p) => (p in FILES || DIRS.has(p) ? p : null),
    homeDir: () => HOME,
    shellDefinitions: () => ({ aliases: new Map(), functions: new Map() }),
    awsAccount: () => null,
    now: () => Date.now(),
  };
}

const bash = (command: string, config = corp): FloorVerdict => classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: ROOT }, config, probes());
const tool = (toolName: string, toolInput: Record<string, unknown>, config = corp): FloorVerdict =>
  classifyToolCall({ toolName, toolInput, cwd: ROOT }, config, probes());

const category = (v: FloorVerdict) => (v.action === "hold" ? v.category : v.action);

describe("the org's code-review CLI", () => {
  test("is a Persona-decidable review hold, a lone help flag allowed", () => {
    expect(category(bash("corp-review --issue I-1 --description d.md"))).toBe("review");
    expect(category(bash("corp-review --help"))).toBe("allow");
  });

  test("is held where code runs it, and run through a wrapper stays a review hold", () => {
    expect(category(bash(`node -e 'require("child_process").execSync("corp-review --all")'`))).not.toBe("allow");
    expect(category(bash(`python3 -c 'import os; os.system("corp-review --all")'`))).not.toBe("allow");
    expect(category(bash("corp-env corp-review --draft"))).toBe("review");
  });

  test("is no review CLI under the default profile", () => {
    expect(category(bash("corp-review --issue I-1", base))).not.toBe("review");
  });
});

describe("the org's CLI rules", () => {
  test("hold what they name, as the category they say", () => {
    expect(category(bash("corp-deploy pipeline promote prod"))).toBe("outward");
    expect(category(bash("corp-tickets create --title x"))).toBe("outward");
    expect(category(bash("corp-deploy status"))).toBe("allow");
  });

  test("hold nothing under the default profile", () => {
    expect(category(bash("corp-deploy pipeline promote prod", base))).toBe("allow");
  });
});

describe("the default profile still holds generic outward steps", () => {
  const cases = [
    "git push origin HEAD",
    "gh pr create --fill",
    "gh release create v1.0.0",
    "kubectl apply -f deploy.yaml",
    "kubectl delete pod x",
    "terraform apply -auto-approve",
    "npm publish",
    "docker push registry.example.com/app:1",
    "pipeline promote release-1",
    "pipelines start app-prod",
    // A GraphQL schema registry's CLI: each publishes or deletes a schema or operations in the registry.
    "rover subgraph publish app@current --name accounts --schema accounts.graphql",
    "rover graph publish app@current --schema schema.graphql",
    "rover --profile ci subgraph delete app@current --name accounts",
    "rover persisted-queries publish app@current --manifest m.json",
    // A `<topic>:<command>` GraphQL CLI pushing a service's schema or a client's operations to its registry.
    "graphql-tool service:push --graph=app --variant=prod",
    "graphql-tool client:push --variant=prod",
    "graphql-tool --config gql.config.js service:delete --variant=old",
    "graphql-tool schema:publish --key $KEY",
    "npx graphql-tool service:push --graph=app",
    // Review CLIs every install may have: each posts the change for review.
    "glab mr create --fill",
    "hub pull-request -m x",
    "git review",
    "arc diff",
    "repo upload .",
  ];
  for (const command of cases) {
    test(command, () => {
      const v = bash(command, base);
      expect(v.action).toBe("hold");
      expect(category(v)).not.toBe("review");
    });
  }

  test("a schema registry CLI's local and read-only steps are its own business", () => {
    for (const command of [
      "rover --version",
      "rover subgraph check app@current --name accounts --schema accounts.graphql",
      "rover subgraph introspect http://localhost:4001",
      "graphql-tool service:check --graph=app",
      "graphql-tool client:codegen --target=typescript",
      "graphql-tool service:download schema.json",
    ]) {
      expect([command, category(bash(command, base))]).toEqual([command, "allow"]);
    }
  });
});

describe("a profile's own CLIs never drop or soften a built-in hold", () => {
  const withEntries = (raw: Record<string, unknown>): FloorConfig => {
    const { profile, errors } = mergeOrgProfile(DEFAULT_ORG_PROFILE, raw);
    expect(errors).toEqual([]);
    return { ...base, orgProfile: profile };
  };
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["cdk deploy Prod", { credentialClis: [{ program: "cdk", subcommand: ["login"] }] }, "cdk deploy Prod"],
    ["helm upgrade --install app ./chart", { reviewClis: ["helm"] }, "helm upgrade --install app ./chart"],
    ["terraform apply", { credentialClis: [{ program: "terraform", subcommand: ["login"] }] }, "terraform apply"],
    ["npm publish", { reviewClis: ["npm"] }, "npm publish"],
    ["sam sync", { reviewClis: ["sam"] }, "sam sync --stack-name prod"],
  ];
  for (const [name, raw, command] of cases) {
    test(name, () => {
      const before = bash(command, base);
      expect(before.action).toBe("hold");
      const after = bash(command, withEntries(raw));
      expect(after.action).toBe("hold");
      expect(category(after)).toBe(category(before));
    });
  }

  test("a review CLI's own code-review step stays a review hold", () => {
    const cfg = withEntries({ reviewClis: ["corp-review"] });
    expect(category(bash("corp-review --issue I-1 --description d.md", cfg))).toBe("review");
  });
});

describe("the default profile reads long runs of options in bounded time", () => {
  const programs = [...new Set(DEFAULT_ORG_PROFILE.outwardRules.flatMap((r) => r.program.split("|")))];
  for (const program of programs) {
    test(program, () => {
      const command = `${program} ${"--a ".repeat(60)}publishx; git push origin HEAD:main`;
      const started = performance.now();
      const v = bash(command, base);
      expect(performance.now() - started).toBeLessThan(2000);
      expect(v.action).toBe("hold");
    });
  }
});

describe("the default profile carries no org's vocabulary", () => {
  const org = exampleCorpProfile();
  test("an org's review CLI is no Persona-decidable review hold", () => {
    for (const cli of org.reviewClis) {
      const v = bash(`${cli} --all --issue I-1`, base);
      expect([cli, category(v)]).not.toEqual([cli, "review"]);
      expect([cli, category(bash(`${cli} --all --issue I-1`, { ...base, orgProfile: org }))]).toEqual([cli, "review"]);
    }
  });

  test("an org's read-only MCP tools are held as outward", () => {
    for (const [server, tools] of Object.entries(org.mcp.readOnlyTools)) {
      const name = `mcp__${server}__${tools[0]}`;
      expect([name, category(tool(name, {}, base))]).toEqual([name, "outward"]);
      expect([name, category(tool(name, {}, { ...base, orgProfile: org }))]).toEqual([name, "allow"]);
      expect(knownMcpServer(server, DEFAULT_ORG_PROFILE)).toBe(false);
    }
  });

  test("an org's credential CLIs and SSO cookie are still held without the org's profile", () => {
    for (const rule of org.credentialClis) {
      const command = `${rule.program} credentials refresh --account 111122223333 --role Admin`;
      expect([command, bash(command, base).action]).toEqual([command, "hold"]);
    }
    for (const file of org.sso.cookieFiles) {
      const command = `base64 ~/${file}`;
      expect([command, bash(command, base).action, bash(command).action]).toEqual([command, "hold", "hold"]);
    }
  });

  test("an org's internal hosts are read as internal only under its profile, but for internal-looking names", () => {
    for (const host of org.internalHostSuffixes) {
      const url = `https://wiki.${host}/page`;
      // Internal: a fetch there is outward. Not internal: a plain public page, whose address Persona reads.
      expect([host, category(tool("WebFetch", { url, prompt: "summarize" }, { ...base, orgProfile: org }))]).toEqual([host, "outward"]);
    }
    const page = (url: string) => category(tool("WebFetch", { url, prompt: "summarize" }, base));
    expect(page("https://wiki.apps.example.net/page")).not.toBe("outward");
    // A `.corp` or `.example` name, or a host under a `corp` or `internal` label, is internal for every profile.
    expect(page("https://wiki.example.corp/page")).toBe("outward");
    expect(page("https://wiki.corp-dev.example/page")).toBe("outward");
    expect(page("https://wiki.corp.example.net/page")).toBe("outward");
    expect(page("https://tools.internal.example.net/page")).toBe("outward");
    // Such a label with only a top-level domain after it is a public site's own name.
    for (const url of ["https://lan.dev/docs", "https://www.private.com/page", "https://vpn.com/pricing", "https://corp.com/about"]) {
      expect([url, page(url)]).not.toEqual([url, "outward"]);
    }
  });
});

describe("the generic credential reading, whatever the profile", () => {
  const personal = (config: FloorConfig): FloorConfig => ({ ...config, personalAwsAccounts: ["111122223333"] });
  test("a credential print or export is owner-reserved floor-tamper", () => {
    const cases = [
      "corp-creds credentials show",
      "corp-creds cred get --account 111122223333",
      "some-cli --profile p credentials export",
      "some-cli creds show",
      "some-cli export-credentials",
      "docker-credential-pass get",
    ];
    for (const command of cases) {
      for (const config of [base, corp]) {
        const v = bash(command, config);
        expect([command, category(v), v.action === "hold" && v.ownerReserved === true]).toEqual([command, "floor-tamper", true]);
      }
    }
    for (const command of ["some-cli credentials list", "some-cli get credentials", "corp-creds --version"]) {
      expect([command, category(bash(command, base))]).toEqual([command, "allow"]);
    }
  });

  test("a verb the floor can't read where a print verb would stand is held as a print", () => {
    const cases = [
      "some-cli credentials $VERB",
      'some-cli credentials "$VERB"',
      "some-cli --profile p creds $(pick-verb)",
      "some-cli credentials $VERB --account 111122223333 --role Admin",
      "docker-credential-pass $VERB",
    ];
    for (const command of cases) {
      for (const config of [base, corp, personal(base)]) {
        const v = bash(command, config);
        expect([command, category(v), v.action === "hold" && v.ownerReserved === true]).toEqual([command, "floor-tamper", true]);
      }
    }
    // Past the verb, an argument the floor can't read is a write's, not a print's.
    expect(category(bash("some-cli credentials update $ARGS", base))).toBe("aws");
    const v = bash("some-cli credentials $VERB", base);
    expect(v.action === "hold" && v.reason).toContain("can't read its verb");
  });

  test("beside a credential noun, -a and -r name the account and role", () => {
    expect(category(bash("some-cli credentials refresh -a 444455556666 -r Admin", base))).toBe("aws");
    expect(category(bash("some-cli credentials refresh -a 444455556666 -r ReadOnly", base))).toBe("allow");
    expect(category(bash("some-cli update -a 444455556666 -r Admin", base))).toBe("allow");
  });

  test("an unknown program's write pins no account: a later AWS change runs in an account the floor doesn't know", () => {
    const command = (step: string) => `${step} && aws s3 rm s3://bucket/key`;
    expect(category(bash("aws s3 rm s3://bucket/key", personal(base)))).toBe("aws");
    expect(category(bash(command("deploy-tool --account 111122223333 --role Admin"), personal(base)))).toBe("aws");
    expect(category(bash(command("deploy-tool --account 111122223333 --role Admin --profile other"), personal(base)))).toBe("aws");
    // An account named without a role may switch credentials all the same.
    const pinned = "corp-creds credentials refresh --account 111122223333 --role Admin";
    expect(category(bash(`${pinned} && assume-tool assume 444455556666 && aws s3 rm s3://bucket/key`, personal(corp)))).toBe("aws");
    expect(category(bash(`${pinned} && assume-tool login --account 444455556666 && aws s3 rm s3://bucket/key`, personal(corp)))).toBe("aws");
    expect(category(bash(`${pinned} && assume-tool assume 444455556666`, personal(corp)))).toBe("allow");
    // A listed credential CLI's write does pin the account it names.
    expect(category(bash(command("corp-creds credentials refresh --account 111122223333 --role Admin"), personal(corp)))).toBe("allow");
    expect(category(bash(command("corp-creds credentials refresh --account 444455556666 --role Admin"), personal(corp)))).toBe("aws");
  });

  test("a long run of role options is read in bounded time", () => {
    const command = `deploy-tool ${"--role Admin ".repeat(5000)}--account 444455556666`;
    const started = performance.now();
    expect(category(bash(command, base))).toBe("aws");
    expect(performance.now() - started).toBeLessThan(5000);
  });

  test("a profile's credential CLI keeps the generic reading of the calls its rule doesn't match", () => {
    expect(category(bash("corp-creds login --account 444455556666 --role Admin", corp))).toBe("aws");
    expect(category(bash("corp-creds login --account 444455556666 --role Admin", base))).toBe("aws");
  });

  test("`<program> run|exec … -- <command>` reads the command it runs", () => {
    expect(category(bash("corp-assume run --account 444455556666 --role ReadOnly -- git push origin HEAD", base))).toBe("outward");
    expect(category(bash("some-wrapper exec -- git push origin HEAD", base))).toBe("outward");
    expect(category(bash("some-wrapper exec -- rm -rf /", base))).not.toBe("allow");
    expect(category(bash("some-wrapper run -- ls", base))).toBe("allow");
    // Option words after `--` are the program's own arguments.
    expect(category(bash("some-runner run app -- --port 8080", base))).toBe("allow");
    expect(category(bash("corp-assume run 111122223333 --role Admin -- aws s3 ls", personal(base)))).toBe("allow");
    expect(category(bash("corp-assume run 111122223333 --role Admin -- aws s3 ls", personal(corp)))).toBe("allow");
    // The wrapped command runs under whatever credentials the wrapper switched to, not the account the shell pinned.
    const pinned = "corp-creds credentials refresh --account 111122223333 --role Admin";
    expect(category(bash(`${pinned} && aws s3 rm s3://b/k`, personal(corp)))).toBe("allow");
    expect(category(bash(`${pinned} && some-vault exec prod -- aws s3 rm s3://b/k`, personal(corp)))).toBe("aws");
    expect(category(bash(`${pinned} && some-vault exec prod -- aws s3 ls`, personal(corp)))).toBe("allow");
  });
});

describe("the generic credential reading under the default profile", () => {
  // 111122223333 is the owner's personal account; 444455556666 is not.
  const personal: FloorConfig = { ...base, personalAwsAccounts: ["111122223333"] };
  const table = (cases: Array<[string, string]>, config: FloorConfig = personal) => {
    for (const [command, expected] of cases) expect([command, category(bash(command, config))]).toEqual([command, expected]);
  };

  test("an account or role value the floor can't read is an AWS hold, `--opt value` or `--opt=value`", () => {
    table([
      ["some-cli credentials update --account $ACCT --role Admin", "aws"],
      ["some-cli credentials update --account=$ACCT --role Admin", "aws"],
      ['some-cli credentials update --account="$ACCT" --role Admin', "aws"],
      ["some-cli credentials update -a $ACCT -r Admin", "aws"],
      ["some-cli credentials update --account 111122223333 --role $ROLE", "aws"],
      ["some-cli credentials update --account 111122223333 --role=$ROLE", "aws"],
      ["some-cli credentials update --account=$ACCT", "aws"],
      ["some-cli credentials update --role=$ROLE", "aws"],
      ["deploy-tool --account=$ACCT --role Admin", "aws"],
      ["deploy-tool --account-id=$ACCT --role Admin", "aws"],
      ["deploy-tool --account 111122223333 --role-name=$ROLE", "aws"],
      ["deploy-tool --account 111122223333 --role $ROLE", "aws"],
      ["deploy-tool --account 111122223333 --role", "aws"],
    ]);
  });

  test("any other argument the floor can't read in a credential write is an AWS hold: it may name the account", () => {
    table([
      ["some-cli credentials update --account 111122223333 --role Admin $EXTRA", "aws"],
      ["some-cli credentials update $ARGS", "aws"],
      ["some-cli credentials update --account 111122223333 $ROLE_FLAG", "aws"],
      ["deploy-tool --account 111122223333 --role Admin $EXTRA", "aws"],
      ["deploy-tool --role Admin $ACCOUNT_FLAG", "aws"],
      // Readable, the same calls in the personal account are allowed.
      ["some-cli credentials update --account 111122223333 --role Admin", "allow"],
      ["deploy-tool --account 111122223333 --role Admin", "allow"],
    ]);
    const v = bash("some-cli credentials update --account 111122223333 --role Admin $EXTRA", personal);
    expect(v.action === "hold" && v.reason).toContain("can't read");
  });

  test("beside a credential noun, an account with no role gets unspecified-role credentials", () => {
    table([
      ["some-cli credentials update --account 444455556666", "aws"],
      ["some-cli credentials update --account=444455556666", "aws"],
      ["some-cli credentials update -a 444455556666", "aws"],
      ["some-cli credentials update 444455556666", "aws"],
      ["some-cli credentials update --account 111122223333", "allow"],
      ["some-cli credentials update 111122223333", "allow"],
      // A role with no account is for an account the floor doesn't know.
      ["some-cli credentials update --role Admin", "aws"],
      ["some-cli credentials update --role ReadOnly", "allow"],
      // Away from a credential noun, an account alone is no hold of its own.
      ["deploy-tool --account 444455556666", "allow"],
      ["assume-tool assume 444455556666", "allow"],
    ]);
    const v = bash("some-cli credentials update --account 444455556666", personal);
    expect(v.action === "hold" && v.reason).toContain("unspecified-role");
    expect(category(bash("some-cli credentials update --account 111122223333", base))).toBe("aws");
  });

  test("the `=` form reads as the spaced one", () => {
    table([
      ["some-cli credentials update --account=444455556666 --role=Admin", "aws"],
      ["some-cli credentials update --account=444455556666 --role=ReadOnly", "allow"],
      ["some-cli credentials update --account=111122223333 --role=Admin", "allow"],
      ["deploy-tool --account-id=444455556666 --role-name=Admin", "aws"],
      ["deploy-tool --account-id=111122223333 --role-name=Admin", "allow"],
      // The last occurrence wins, whichever form it takes.
      ["deploy-tool --account 111122223333 --account=444455556666 --role Admin", "aws"],
      ["deploy-tool --account=444455556666 --account 111122223333 --role Admin", "allow"],
    ]);
  });

  test("a personal account may be written with any role, another account only read-only", () => {
    table([
      ["deploy-tool --account 111122223333 --role Admin", "allow"],
      ["deploy-tool --account 444455556666 --role Admin", "aws"],
      ["deploy-tool --account 444455556666 --role ReadOnly", "allow"],
      ["deploy-tool --role Admin 444455556666", "aws"],
      ["deploy-tool --role Admin 111122223333", "allow"],
    ]);
    expect(category(bash("deploy-tool --account 111122223333 --role Admin", base))).toBe("aws");
  });

  test("an exec wrapper's `--` command is read too, in an account the floor doesn't know", () => {
    table([
      ["some-vault exec --account 111122223333 --role Admin -- ls", "allow"],
      ["some-vault exec --account 444455556666 --role Admin -- ls", "aws"],
      ["some-vault exec --account 111122223333 --role Admin -- git push origin HEAD", "outward"],
      ["some-vault exec --account 111122223333 --role Admin -- aws s3 rm s3://b/k", "aws"],
      ["some-vault exec --account $ACCT --role Admin -- ls", "aws"],
      ["some-vault exec --account=$ACCT --role Admin -- ls", "aws"],
      ["some-vault run 444455556666 --role Admin -- ls", "aws"],
      // A word after `--` is the wrapped command's own: one the floor can't read there is no credential argument.
      ["some-vault exec --account 111122223333 --role Admin -- ls $DIR", "allow"],
    ]);
  });

  test("an exec wrapper naming only an account or only a role still gets credentials", () => {
    table([
      // An account with no role gets unspecified-role credentials.
      ["some-vault run 444455556666 -- ls", "aws"],
      ["some-vault exec --account 444455556666 -- ls", "aws"],
      ["some-vault exec --account-id=444455556666 -- ls", "aws"],
      ["some-vault run 111122223333 -- ls", "allow"],
      ["some-vault exec --account 111122223333 -- ls", "allow"],
      // A role with no account is for an account the floor doesn't know.
      ["some-vault exec --role Admin -- ls", "aws"],
      ["some-vault exec --role-name=Admin -- ls", "aws"],
      ["some-vault exec --role ReadOnly -- ls", "allow"],
      // The wrapper's own options name its credentials, whatever the wrapped command's say.
      ["some-vault exec --role Admin -- deploy-tool --role ReadOnly", "aws"],
      ["some-vault exec --account 444455556666 -- deploy-tool --account 111122223333", "aws"],
      // Naming neither, the wrapper switches no credentials of its own.
      ["some-vault exec -- ls", "allow"],
      ["some-vault exec -- deploy-tool --role Admin", "allow"],
    ]);
    const v = bash("some-vault run 444455556666 -- ls", personal);
    expect(v.action === "hold" && v.reason).toContain("unspecified-role");
  });

  test("a credential write verb naming neither an account nor a role gets unspecified-role credentials for an unknown account", () => {
    table([
      ["some-cli credentials update", "aws"],
      ["some-cli credentials refresh", "aws"],
      ["some-cli creds renew", "aws"],
      ["some-cli cred update --profile dev", "aws"],
      ["some-cli --verbose credentials refresh", "aws"],
      ["some-cli aws credentials update", "aws"],
      ["cloud-creds refresh", "aws"],
      ["cloud-creds update --profile dev", "aws"],
      // A read-only role is still allowed, wherever the account is.
      ["some-cli credentials refresh --role ReadOnly", "allow"],
      ["some-cli credentials refresh --account 111122223333", "allow"],
      // Other verbs beside a credential noun, and write verbs away from one, are no write by themselves.
      ["some-cli credentials list", "allow"],
      ["some-cli update", "allow"],
      ["some-cli refresh cache", "allow"],
      ["deploy-tool update credentials", "allow"],
      // A wrapper naming neither leaves the wrapped command's own write to be read as its own.
      ["some-vault exec -- other-cli credentials refresh", "aws"],
    ]);
    for (const command of ["some-cli credentials update", "cloud-creds refresh"]) {
      const v = bash(command, personal);
      expect([command, v.action === "hold" && v.reason]).toEqual([command, expect.stringContaining("unspecified-role")]);
    }
    expect(category(bash("some-cli credentials refresh", base))).toBe("aws");
    expect(category(bash("some-cli credentials refresh", corp))).toBe("aws");
  });

  test("a credential write naming neither unpins the account: a later AWS change runs in an account the floor doesn't know", () => {
    const pinned = "corp-creds credentials refresh --account 111122223333 --role Admin";
    const pin = { ...corp, personalAwsAccounts: ["111122223333"] };
    expect(category(bash(`${pinned} && aws s3 rm s3://bucket/key`, pin))).toBe("allow");
    for (const step of ["some-cli credentials update", "some-cli creds refresh", "cloud-creds renew"]) {
      const command = `${pinned} && ${step} && aws s3 rm s3://bucket/key`;
      expect([command, category(bash(command, pin))]).toEqual([command, "aws"]);
      const after = `${pinned} && ${step} --role ReadOnly && aws s3 rm s3://bucket/key`;
      expect([after, category(bash(after, pin))]).toEqual([after, "aws"]);
    }
  });
});

describe("the org's wrapper CLIs", () => {
  test("the command a wrapper runs is read as if it ran on its own", () => {
    expect(category(bash("corp-env git push origin HEAD"))).toBe("outward");
    expect(category(bash("corp-each -p pkg git push origin HEAD"))).toBe("outward");
    expect(category(bash("corp-each 'git push origin HEAD'"))).toBe("outward");
    expect(category(bash("corp-each --package pkg 'make test'"))).toBe("allow");
    expect(category(bash("corp-env make test"))).toBe("allow");
  });

  test("a wrapper started inside the Standup install is build tooling there, as make is", () => {
    for (const command of [`cd ${INSTALL} && corp-env build`, `cd ${INSTALL} && corp-each -p collector build`, `corp-env --cwd ${INSTALL} build`]) {
      const v = bash(command);
      expect([command, category(v), v.action === "hold" && v.ownerReserved === true]).toEqual([command, "floor-tamper", true]);
    }
    expect({
      help: category(bash(`cd ${INSTALL} && corp-env --help`)),
      outside: category(bash("corp-env build")),
      // Without the org's profile the program is nothing the floor knows to build there.
      unknown: category(bash(`cd ${INSTALL} && corp-env build`, base)),
    }).toEqual({ help: "allow", outside: "allow", unknown: "allow" });
  });
});

describe("the org's credential CLI", () => {
  test("a write for an unlisted account with a role is an AWS hold, a print is floor-tamper", () => {
    expect(category(bash("corp-creds credentials refresh --account 111122223333 --role Admin"))).toBe("aws");
    expect(category(bash("corp-creds credentials show"))).toBe("floor-tamper");
  });

  test("anything else it does is the program's own business", () => {
    expect(category(bash("corp-creds --version"))).toBe("allow");
    expect(category(bash("corp-creds profile list"))).toBe("allow");
    expect(category(bash("corp-assume list"))).toBe("allow");
  });

  test("subcommand patterns, option aliases and the last occurrence decide the write", () => {
    const cases: Array<[string, string]> = [
      ["corp-creds cred refresh -a 111122223333 -r Admin", "aws"],
      ["corp-creds credentials refresh --account=111122223333 --role=ReadOnly", "allow"],
      ["corp-creds credentials refresh -a 111122223333 -r ReadOnly", "allow"],
      ["corp-creds credentials refresh --account 111122223333 --role ReadOnly --role Admin", "aws"],
      // Off the rule's subcommand, the generic reading of its account and role still holds it.
      ["corp-creds credentialsx refresh --account 111122223333 --role Admin", "aws"],
      ["corp-creds credentialsx refresh --account 111122223333", "allow"],
      ["corp-creds cred show", "floor-tamper"],
      ["corp-creds credentials refresh --account $ACCT --role Admin", "aws"],
    ];
    for (const [command, expected] of cases) expect([command, category(bash(command))]).toEqual([command, expected]);
  });

  test("a listed personal account may be written with any role", () => {
    const personal: FloorConfig = { ...corp, personalAwsAccounts: ["111122223333"] };
    expect(category(bash("corp-creds credentials refresh --account 111122223333 --role Admin", personal))).toBe("allow");
    expect(category(bash("corp-assume assume 111122223333 --role Admin", personal))).toBe("allow");
    expect(category(bash("corp-assume assume 444455556666 --role Admin", personal))).toBe("aws");
  });

  test("a positional account is read, and an exec subcommand's command after `--` is read too", () => {
    const personal: FloorConfig = { ...corp, personalAwsAccounts: ["111122223333"] };
    expect(category(bash("corp-assume run 111122223333 --role Admin -- aws s3 ls", personal))).toBe("allow");
    expect(category(bash("corp-assume run 111122223333 --role Admin -- git push origin HEAD", personal))).toBe("outward");
    expect(category(bash("corp-assume run --account 444455556666 --role Admin -- aws s3 ls", personal))).toBe("aws");
  });

  test("is no credential CLI under the default profile: only its account and role options are read", () => {
    // Any program naming an account and a role reads as a credential write for it.
    expect(category(bash("corp-creds credentials refresh --account 111122223333 --role Admin", base))).toBe("aws");
    expect(category(bash("corp-creds credentials refresh --account 111122223333 --role ReadOnly", base))).toBe("allow");
    expect(category(bash("corp-creds credentials refresh --account 111122223333 --role Admin", { ...base, personalAwsAccounts: ["111122223333"] }))).toBe("allow");
    expect(category(bash("corp-assume assume 444455556666 --role Admin", base))).toBe("aws");
    expect(category(bash("corp-creds credentials refresh --account $ACCT --role Admin", base))).toBe("aws");
    // Its print subcommand is read generically too; beside a credential noun, a write naming no role gets
    // unspecified-role credentials, allowed only for a personal account.
    expect(category(bash("corp-creds credentials show", base))).toBe("floor-tamper");
    expect(category(bash("corp-creds credentials refresh --account 111122223333", base))).toBe("aws");
    expect(category(bash("corp-creds credentials refresh --account 111122223333", { ...base, personalAwsAccounts: ["111122223333"] }))).toBe("allow");
  });
});

describe("the org's checkout tool", () => {
  test("without a dir it lands in the tool's own location", () => {
    expect(category(tool("mcp__corp-mcp__CheckoutReview", { reviewId: "R-42" }))).toBe("allow");
  });

  test("below the worker's own ground it is allowed; below the live data dir it is held", () => {
    expect(category(tool("mcp__corp-mcp__CheckoutReview", { reviewId: "R-42", workingDirectory: ROOT }))).toBe("allow");
    expect(category(tool("mcp__corp-mcp__CheckoutReview", { reviewId: "42", workingDirectory: DATA }))).not.toBe("allow");
  });

  test("a review id or dir it can't read is read as an unread call: held where the call names a denylist target", () => {
    expect(category(tool("mcp__corp-mcp__CheckoutReview", { reviewId: "../x" }))).toBe("allow");
    expect(category(tool("mcp__corp-mcp__CheckoutReview", { reviewId: "../x", workingDirectory: DATA }))).not.toBe("allow");
    expect(category(tool("mcp__corp-mcp__CheckoutReview", { reviewId: "R-42", workingDirectory: 7, name: DATA }))).not.toBe("allow");
    expect(category(tool("mcp__corp-mcp__CheckoutReview", { reviewId: "R-42", workingDirectory: DATA, name: ["x"] }))).not.toBe("allow");
  });

  test("is an unlisted tool under the default profile", () => {
    expect(category(tool("mcp__corp-mcp__CheckoutReview", { reviewId: "R-42" }, base))).toBe("outward");
  });
});

describe("the org's SSO", () => {
  test("reading its cookie is a secret read; under the default profile the cookie is still a home cookie store", () => {
    expect(category(bash(`base64 ${HOME}/.corp-sso/cookie`))).not.toBe("allow");
    expect(category(bash(`base64 ${HOME}/.corp-sso/cookie`, base))).not.toBe("allow");
    expect(category(bash(`cat ${HOME}/.corp-sso/cookie`, base))).not.toBe("allow");
  });

  test("homeCookieFile names cookie stores below the home dir's dot entries only", () => {
    const cases: Array<[string, boolean]> = [
      [".corp-sso/cookie", true],
      [".config/google-chrome/Default/Cookies", true],
      [".mozilla/firefox/p.default/cookies.sqlite", true],
      [".erlang.cookie", true],
      [".cache/tool/session-cookie.json", true],
      ["cookies.txt", false],
      ["notes/cookie", false],
      [".config/app/cookie.ts", false],
      [".corp-sso/config", false],
      ["../.corp-sso/cookie", false],
    ];
    for (const [rel, expected] of cases) expect({ rel, cookie: homeCookieFile(rel) }).toEqual({ rel, cookie: expected });
  });

  test("homeSecretFile adds credential and token caches below the home dir's dot entries", () => {
    const cases: Array<[string, boolean]> = [
      [".corp-sso/cookie", true],
      [".sso-tool/credentials", true],
      [".config/some-cli/credentials.json", true],
      [".tool/.credentials.json", true],
      [".cache/huggingface/token", true],
      [".config/app/access_token.json", true],
      [".local/share/app/id-token.json", true],
      [".config/app/tokenizer.json", false],
      [".cache/huggingface/hub/models--x/snapshots/1/added_tokens.json", false],
      [".config/app/credentials.ts", false],
      [".config/app/settings.json", false],
      ["notes/credentials", false],
      ["../.tool/credentials", false],
    ];
    for (const [rel, expected] of cases) expect({ rel, secret: homeSecretFile(rel) }).toEqual({ rel, secret: expected });
    expect(category(bash(`cat ${HOME}/.sso-tool/credentials`, base))).toBe("floor-tamper");
    expect(category(bash(`cat ${HOME}/.sso-tool/config`, base))).toBe("allow");
  });

  test("a cookie store on the worker's own ground below a home dot entry is its own, not the owner's secret", () => {
    const scratchRoot = `${HOME}/.cache/standup-scratch`;
    const config: FloorConfig = { ...base, scratchRoot, scratchDir: `${scratchRoot}/launch-1`, worktreeRoots: [`${DATA}/worktrees`], jobRoots: [JOB_ROOT] };
    const own = [`${DATA}/review-scratch/launch-1/cookies.json`, `${scratchRoot}/launch-1/cookies.txt`, `${JOB_ROOT}/e2e/cookies.json`];
    for (const path of own) {
      expect({ path, read: category(bash(`cat ${path}`, config)) }).toEqual({ path, read: "allow" });
      expect({ path, write: category(bash(`echo '[]' > ${path}`, config)) }).toEqual({ path, write: "allow" });
    }
    for (const path of [`${HOME}/.cache/tool/cookies.json`, `${HOME}/.local/share/other/cookies.txt`]) {
      expect({ path, read: category(bash(`cat ${path}`, config)) }).not.toEqual({ path, read: "allow" });
    }
  });
});

describe("the org's MCP tools", () => {
  test("a listed read-only tool is allowed; an unlisted one is outward", () => {
    expect(category(tool("mcp__corp-mcp__SearchCode", { q: "x" }))).toBe("allow");
    expect(category(tool("mcp__corp-docs-mcp__Anything", {}))).toBe("allow");
    expect(category(tool("mcp__corp-mcp__DeleteRepo", { repo: "x" }))).toBe("outward");
    expect(category(tool("mcp__corp-mcp__SearchCode", { q: "x" }, base))).toBe("outward");
  });

  test("a self-filed record passes; one for someone else, or with a field that must stay unset, is outward", () => {
    expect(category(tool("mcp__corp-mcp__CreateTicket", { title: "x" }))).toBe("allow");
    expect(category(tool("mcp__corp-mcp__CreateTicket", { title: "x", assignee: "currentUser" }))).toBe("allow");
    expect(category(tool("mcp__corp-mcp__CreateTicket", { title: "x", assignee: "bob" }))).toBe("outward");
    expect(category(tool("mcp__corp-mcp__CreateTicket", { title: "x", watchers: ["bob"] }))).toBe("outward");
    expect(category(tool("mcp__corp-mcp__CreateTicket", { title: "x" }, base))).toBe("outward");
  });

  test("a review write tool is a review hold for its action only", () => {
    expect(category(tool("mcp__corp-mcp__ReviewWrite", { action: "update-description", description: "new text" }))).toBe("review");
    expect(category(tool("mcp__corp-mcp__ReviewWrite", { action: "merge" }))).toBe("outward");
  });

  test("a review write's file field is read as a read of the file it names", () => {
    const write = (description: unknown) => category(tool("mcp__corp-mcp__ReviewWrite", { action: "update-description", description }));
    expect(write(`${ROOT}/description.md`)).toBe("review");
    expect(write(`${HOME}/.corp-sso/cookie`)).toBe("floor-tamper");
    expect(write("notes/description.md")).toBe("outward");
    expect(write({ path: "x" })).toBe("outward");
  });

  test("knownMcpServer reads the profile", () => {
    expect(knownMcpServer("corp-mcp", exampleCorpProfile())).toBe(true);
    expect(knownMcpServer("corp-mcp", DEFAULT_ORG_PROFILE)).toBe(false);
  });
});

describe("WebFetch", () => {
  test("the org's documentation domain is readable only under its profile", () => {
    expect(category(tool("WebFetch", { url: "https://docs.example.corp/guide", prompt: "summarize" }))).toBe("allow");
    expect(category(tool("WebFetch", { url: "https://docs.example.corp/guide", prompt: "summarize" }, base))).not.toBe("allow");
  });
});
