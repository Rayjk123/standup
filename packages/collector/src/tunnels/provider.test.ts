import { describe, expect, test } from "bun:test";
import {
  commandTunnelConfigProblems,
  commandTunnelProvider,
  disabledTunnelProvider,
  fillTunnelCommand,
  parseTunnelList,
  resolveTunnelProvider,
  tunnelVouchesForHeader,
  type TunnelProvider,
} from "./provider.js";
import { resolveIdentity, resolveIdentityConfigFromEnv } from "../identity.js";

const COMMAND_ENV = {
  STANDUP_TUNNEL_PROVIDER: "command",
  STANDUP_TUNNEL_CREATE: "mytunnel expose {port} --name {name} --region {region} --allow {allow}",
  STANDUP_TUNNEL_URL: "https://{name}.tunnels.example.com",
  STANDUP_TUNNEL_LIST: "mytunnel ls --json",
  STANDUP_TUNNEL_DOMAIN: "tunnels.example.com",
  STANDUP_TUNNEL_IDENTITY_HEADER: "X-Tunnel-User",
  STANDUP_TUNNEL_OWNER_ALLOW: "alice",
};
const AUTH_OK = { identityHeader: "x-tunnel-user" };

describe("disabledTunnelProvider — the built-in default", () => {
  test("opens nothing, has no URL and lists nothing", async () => {
    expect(disabledTunnelProvider.enabled).toBe(false);
    expect(disabledTunnelProvider.createArgv({ port: 5200, suffix: "x" })).toBeNull();
    expect(disabledTunnelProvider.url("alice-x")).toBe("");
    expect(await disabledTunnelProvider.list()).toEqual([]);
    expect(disabledTunnelProvider.domain).toBeUndefined();
  });
});

describe("resolveTunnelProvider", () => {
  const cases: Array<[string, Record<string, string | undefined>, string, number]> = [
    ["unset is disabled", {}, "disabled", 0],
    ["explicit disabled", { STANDUP_TUNNEL_PROVIDER: "disabled" }, "disabled", 0],
    ["off", { STANDUP_TUNNEL_PROVIDER: "off" }, "disabled", 0],
    ["unknown falls back to disabled", { STANDUP_TUNNEL_PROVIDER: "magic" }, "disabled", 1],
    ["command without templates is disabled", { STANDUP_TUNNEL_PROVIDER: "command" }, "disabled", 1],
    ["command without {name} is disabled", { ...COMMAND_ENV, STANDUP_TUNNEL_CREATE: "mytunnel expose {port}" }, "disabled", 1],
    ["command with a non-http URL is disabled", { ...COMMAND_ENV, STANDUP_TUNNEL_URL: "ftp://{name}" }, "disabled", 1],
    ["a complete command provider", COMMAND_ENV, "command", 0],
    ["command saying nothing of authentication is disabled", { ...COMMAND_ENV, STANDUP_TUNNEL_IDENTITY_HEADER: undefined }, "disabled", 1],
    ["command acknowledged as unauthenticated", { ...COMMAND_ENV, STANDUP_TUNNEL_IDENTITY_HEADER: undefined, STANDUP_TUNNEL_UNAUTHENTICATED: "1" }, "command", 0],
    ["command claiming both is disabled", { ...COMMAND_ENV, STANDUP_TUNNEL_UNAUTHENTICATED: "true" }, "disabled", 1],
    ["command with a malformed identity header is disabled", { ...COMMAND_ENV, STANDUP_TUNNEL_IDENTITY_HEADER: "x user" }, "disabled", 1],
    ["{allow} without an owner-only audience is disabled", { ...COMMAND_ENV, STANDUP_TUNNEL_OWNER_ALLOW: undefined }, "disabled", 1],
    ["{allow} with a blank owner-only audience is disabled", { ...COMMAND_ENV, STANDUP_TUNNEL_OWNER_ALLOW: "  " }, "disabled", 1],
    [
      "no {allow} needs no owner-only audience",
      { ...COMMAND_ENV, STANDUP_TUNNEL_CREATE: "mytunnel expose {port} --name {name}", STANDUP_TUNNEL_OWNER_ALLOW: undefined },
      "command",
      0,
    ],
  ];
  for (const [name, env, id, warnings] of cases) {
    test(name, () => {
      const warned: string[] = [];
      expect(resolveTunnelProvider(env, (m) => warned.push(m)).id).toBe(id);
      expect(warned).toHaveLength(warnings);
    });
  }
});

describe("the command provider", () => {
  test("fills its create template, dropping an unset optional value with its option", () => {
    const p = resolveTunnelProvider(COMMAND_ENV);
    expect(p.createArgv({ port: 5200, suffix: "fix-login" })).toEqual(["mytunnel", "expose", "5200", "--name", "fix-login", "--allow", "alice"]);
    expect(fillTunnelCommand(COMMAND_ENV.STANDUP_TUNNEL_CREATE, { port: "5200", name: "fix-login" })).toEqual([
      "mytunnel", "expose", "5200", "--name", "fix-login",
    ]);
    expect(p.createArgv({ port: 5200, suffix: "fix-login", region: "eu-west-1", allow: "bob" })).toEqual([
      "mytunnel", "expose", "5200", "--name", "fix-login", "--region", "eu-west-1", "--allow", "bob",
    ]);
  });

  test("a request with no audience is owner-only: {allow} takes the configured owner-only value", () => {
    const p = resolveTunnelProvider({ ...COMMAND_ENV, STANDUP_TUNNEL_OWNER_ALLOW: " owner-only " });
    const cases: Array<[string, string | undefined, string[]]> = [
      ["unset", undefined, ["--allow", "owner-only"]],
      ["blank", "  ", ["--allow", "owner-only"]],
      ["named", "bob,group:reviewers", ["--allow", "bob,group:reviewers"]],
    ];
    for (const [, allow, tail] of cases) {
      const argv = p.createArgv({ port: 5200, suffix: "fix-login", ...(allow !== undefined ? { allow } : {}) });
      expect(argv!.slice(-2)).toEqual(tail);
    }
    const direct = commandTunnelProvider({ create: "t {port} --name {name} --allow {allow}", url: "https://{name}.x", ownerAllow: "me" });
    expect(direct.createArgv({ port: 1, suffix: "a" })).toEqual(["t", "1", "--name", "a", "--allow", "me"]);
  });

  test("a malformed or missing owner-only audience disables the provider, naming STANDUP_TUNNEL_OWNER_ALLOW", () => {
    for (const ownerAllow of ["me; rm", undefined]) {
      const warned: string[] = [];
      expect(resolveTunnelProvider({ ...COMMAND_ENV, STANDUP_TUNNEL_OWNER_ALLOW: ownerAllow }, (m) => warned.push(m)).id).toBe("disabled");
      expect(warned.join("\n")).toContain("STANDUP_TUNNEL_OWNER_ALLOW");
    }
  });

  test("an unset optional token drops the option before it only in the separate `--opt {token}` form", () => {
    const cases: Array<[string, string, Record<string, string | undefined>, string[]]> = [
      ["separate form drops the option", "t {port} --name {name} --region {region}", {}, ["t", "1", "--name", "a"]],
      ["short separate form drops the option", "t {port} --name {name} -r {region}", {}, ["t", "1", "--name", "a"]],
      ["joined form keeps the flag before it", "t {port} --audience-only --region={region}", {}, ["t", "1", "--audience-only"]],
      ["joined form keeps a valued flag before it", "t {port} --allow=me --region={region}", {}, ["t", "1", "--allow=me"]],
      ["a valued flag before a bare token stays", "t {port} --allow=me {region}", {}, ["t", "1", "--allow=me"]],
      ["`--` before a bare token stays", "t {port} -- {region}", {}, ["t", "1", "--"]],
      ["a filled value before a bare token stays", "t --name {name} {region}", { name: "-x" }, ["t", "--name", "-x"]],
      ["a value word with an embedded token drops its option", "t {port} --tag region:{region} --private", {}, ["t", "1", "--private"]],
      ["an option word with an embedded token drops only itself", "t {port} --private -r={region}", {}, ["t", "1", "--private"]],
      ["a set joined value fills in place", "t {port} --region={region}", { region: "eu" }, ["t", "1", "--region=eu"]],
      // The documented ambiguity: a no-value flag can't be told from an option awaiting its value.
      ["a bare token right after a no-value flag drops that flag", "t {port} --private {region}", {}, ["t", "1"]],
      ["a bare token before a no-value flag keeps it", "t {port} {region} --private", {}, ["t", "1", "--private"]],
    ];
    for (const [label, template, extra, argv] of cases) {
      expect([label, fillTunnelCommand(template, { port: "1", name: "a", ...extra })]).toEqual([label, argv]);
    }
  });

  test("a template without {allow} opens owner-only requests and refuses a named audience", () => {
    const p = resolveTunnelProvider({ ...COMMAND_ENV, STANDUP_TUNNEL_CREATE: "t {port} --name {name} --private", STANDUP_TUNNEL_OWNER_ALLOW: undefined });
    expect(p.id).toBe("command");
    const cases: Array<[string, string | undefined, string[] | null]> = [
      ["unset", undefined, ["t", "1", "--name", "a", "--private"]],
      ["blank", "  ", ["t", "1", "--name", "a", "--private"]],
      ["named", "bob", null],
      ["a group", "group:reviewers", null],
    ];
    for (const [label, allow, argv] of cases) {
      expect([label, p.createArgv({ port: 1, suffix: "a", ...(allow !== undefined ? { allow } : {}) })]).toEqual([label, argv]);
      // audienceProblem names the refusal exactly when createArgv refuses.
      const problem = p.audienceProblem!(allow);
      expect([label, problem === undefined]).toEqual([label, argv !== null]);
      if (problem) expect(problem).toContain("has no {allow}");
    }
  });

  test("a template with {allow} can pass any audience", () => {
    const p = resolveTunnelProvider(COMMAND_ENV);
    for (const allow of [undefined, "", "bob", "group:reviewers"]) expect(p.audienceProblem!(allow)).toBeUndefined();
  });

  test("an owner-only audience with no {allow} to pass it disables the provider", () => {
    const warned: string[] = [];
    const env = { ...COMMAND_ENV, STANDUP_TUNNEL_CREATE: "t {port} --name {name}" };
    expect(resolveTunnelProvider(env, (m) => warned.push(m)).id).toBe("disabled");
    expect(warned.join("\n")).toContain("has no {allow}");
    expect(commandTunnelConfigProblems({ create: "t {port} {name}", url: "https://{name}.x", ownerAllow: "me", ...AUTH_OK })).toHaveLength(1);
  });

  test("a value is one word: shell text in it is never split or run", () => {
    expect(fillTunnelCommand("t {port} --name {name}", { port: "1", name: "a;$(id) b" })).toEqual(["t", "1", "--name", "a;$(id) b"]);
  });

  test("names the URL and domain", () => {
    const p = resolveTunnelProvider(COMMAND_ENV);
    expect(p.url("alice-fix")).toBe("https://alice-fix.tunnels.example.com");
    expect(p.domain).toBe("tunnels.example.com");
  });

  test("lists through its list command, and returns null without one", async () => {
    const seen: string[][] = [];
    const p = resolveTunnelProvider(COMMAND_ENV, () => {}, async (argv) => {
      seen.push(argv);
      return JSON.stringify([{ name: "alice-x", pid: 7, localPort: 5200, hostname: "h" }]);
    });
    expect(await p.list()).toEqual([{ name: "alice-x", pid: 7, localPort: 5200, hostname: "h" }]);
    expect(seen).toEqual([["mytunnel", "ls", "--json"]]);
    const unlisted = commandTunnelProvider({ create: "t {port} {name}", url: "https://{name}.x" });
    expect(await unlisted.list()).toBeNull();
    const failing = commandTunnelProvider({ create: "t {port} {name}", url: "https://{name}.x", list: "t ls" }, async () => null);
    expect(await failing.list()).toBeNull();
  });
});

describe("tunnelVouchesForHeader", () => {
  const unauthenticated = resolveTunnelProvider({ ...COMMAND_ENV, STANDUP_TUNNEL_IDENTITY_HEADER: undefined, STANDUP_TUNNEL_UNAUTHENTICATED: "1" });
  const authenticated = resolveTunnelProvider(COMMAND_ENV);
  const cases: Array<[string, TunnelProvider, string, boolean]> = [
    ["no tunnel opens", disabledTunnelProvider, "x-tunnel-user", true],
    ["the service stamps this header", authenticated, "X-TUNNEL-USER", true],
    ["the service stamps another header", authenticated, "x-forwarded-user", false],
    ["the service authenticates no one", unauthenticated, "x-tunnel-user", false],
  ];
  for (const [name, provider, header, vouches] of cases) {
    test(name, () => {
      expect(tunnelVouchesForHeader(provider, header)).toBe(vouches);
    });
  }

  test("the identity header read on loopback is trusted only while the tunnel provider vouches for it", () => {
    const env = { STANDUP_IDENTITY_HEADER: "x-tunnel-user" };
    expect(resolveIdentityConfigFromEnv(env, disabledTunnelProvider).loopbackIsTrusted).toBe(true);
    expect(resolveIdentityConfigFromEnv(env, authenticated).loopbackIsTrusted).toBe(true);
    const open = resolveIdentityConfigFromEnv(env, unauthenticated);
    expect(open.loopbackIsTrusted).toBe(false);
    // A forged header on loopback is then ignored: the request is the host's own, not the named user's.
    const forged = resolveIdentity((name) => (name === "x-tunnel-user" ? "mallory" : undefined), "127.0.0.1", open, "owner");
    expect(forged.user).not.toBe("mallory");
    const trusted = resolveIdentity((name) => (name === "x-tunnel-user" ? "bob" : undefined), "127.0.0.1", resolveIdentityConfigFromEnv(env, authenticated), "owner");
    expect(trusted.user).toBe("bob");
  });
});

describe("parseTunnelList", () => {
  test("reads an array or a tunnels array, names as name or tunnelName, numbers flat or under meta", () => {
    expect(
      parseTunnelList(
        JSON.stringify({
          tunnels: [
            { tunnelName: "alice-acme-web", meta: { pid: 12, localPort: 5201, hostname: "h" } },
            { name: "alice-x", pid: 3 },
            { nope: true },
          ],
        })
      )
    ).toEqual([
      { name: "alice-acme-web", pid: 12, localPort: 5201, hostname: "h" },
      { name: "alice-x", pid: 3 },
    ]);
    expect(parseTunnelList("[]")).toEqual([]);
    expect(parseTunnelList("not json")).toBeNull();
    expect(parseTunnelList("{}")).toBeNull();
  });
});

describe("commandTunnelConfigProblems", () => {
  test("names each missing or malformed template", () => {
    expect(commandTunnelConfigProblems({ ...AUTH_OK })).toEqual(["STANDUP_TUNNEL_CREATE is not set", "STANDUP_TUNNEL_URL is not set"]);
    expect(commandTunnelConfigProblems({ create: "t '{port} {name}", url: "https://{name}.x", ...AUTH_OK })).toEqual([
      "STANDUP_TUNNEL_CREATE has an unterminated quote",
    ]);
    expect(commandTunnelConfigProblems({ create: "t {port} {name}", url: "https://{name}.x", domain: "not a domain", ...AUTH_OK })).toEqual([
      "STANDUP_TUNNEL_DOMAIN is not a DNS domain",
    ]);
    expect(commandTunnelConfigProblems({ create: "t {port} {name}", url: "https://{name}.x", ...AUTH_OK })).toEqual([]);
    expect(commandTunnelConfigProblems({ create: "t {port} {name}", url: "https://{name}.x", unauthenticated: true })).toEqual([]);
  });

  test("a command provider must say whether its service authenticates the requests it forwards", () => {
    const problems = commandTunnelConfigProblems({ create: "t {port} {name}", url: "https://{name}.x" });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("STANDUP_TUNNEL_IDENTITY_HEADER");
    expect(problems[0]).toContain("STANDUP_TUNNEL_UNAUTHENTICATED");
  });
});
