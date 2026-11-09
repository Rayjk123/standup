import { describe, expect, test } from "bun:test";
import { exampleCorpProfile } from "../org-profile/fixtures/example-corp.js";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * The org profile's public pages (webFetchPages): www.example.corp, a host
 * under the org's internal domain, has blog posts (/blogs/...) and product
 * pricing pages (/<product>/pricing/) that are public reading: a WebFetch of
 * one is allowed, as a plain curl or wget GET of one is. Other
 * www.example.corp paths, the bare host, look-alike hosts on the org's
 * internal domains, credentials in the URL, a port, a query, and traversal
 * out of the listed paths stay held for WebFetch; for curl, writes to these
 * pages and output into protected files stay held. (A look-alike off the
 * org's domains, such as www.example.corp.evil.com, is a plain public page:
 * Persona's call, not this list's.)
 */

const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
const COMMON = join("/", "fake", "repo", ".git");
const SCRATCH = join(HOME, ".cache", "standup-scratch");
const OWN_SCRATCH = join(SCRATCH, "launch-1");

const config: FloorConfig = {
  v: 1,
  orgProfile: exampleCorpProfile(),
  collectorUrl: "http://127.0.0.1:17777",
  launchId: "launch-1",
  root: ROOT,
  sharedBranches: ["main", "mainline"],
  personalAwsAccounts: [],
  worktreeRoots: [join(DATA, "worktrees")],
  waitSeconds: 60,
  standupDataDir: DATA,
  floorPaths: [join(INSTALL, "packages", "collector", "src", "floor")],
  installDir: INSTALL,
  protectedPaths: [join(DATA, "secrets"), SCRATCH],
  tmpDirs: ["/tmp", OWN_SCRATCH],
  scratchRoot: SCRATCH,
  scratchDir: OWN_SCRATCH,
  workerToken: "x".repeat(64),
  replyPublicKey: "test",
};

function probes(): Partial<FloorProbes> {
  const dirs = new Set<string>(["/", "/tmp", ROOT, OWN_SCRATCH]);
  const defs: ShellDefinitions = { aliases: new Map(), functions: new Map() };
  parseShellSnapshot("", defs);
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    gitCommonDir: (dir) => (dir === ROOT ? COMMON : null),
    readFile: () => ({ ok: false, reason: "missing" }),
    exists: (p) => dirs.has(p),
    isDirectory: (p) => dirs.has(p),
    listDir: () => null,
    realpath: (p) => (dirs.has(p) ? p : null),
    homeDir: () => HOME,
    shellDefinitions: () => defs,
    awsAccount: () => null,
    now: () => Date.now(),
    gitTree: () => null,
    gitAncestor: () => null,
    gitBlob: () => ({ ok: false, reason: "missing" }),
  };
}

function bash(command: string, cwd = ROOT): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd }, config, probes());
}

function webFetch(url: string): FloorVerdict {
  return classifyToolCall({ toolName: "WebFetch", toolInput: { url, prompt: "summarize" }, cwd: ROOT }, config, probes());
}

const ALLOWED_URLS = [
  "https://www.example.corp/blogs/machine-learning/some-post-title/",
  "https://www.example.corp/blogs/aws/new-feature",
  "https://www.example.corp/blogs/",
  "https://www.example.corp/lambda/pricing/",
  "https://www.example.corp/bedrock/pricing/",
  "https://www.example.corp/bedrock/pricing",
  "https://www.example.corp/ec2/pricing/on-demand/",
  "https://WWW.example.corp/s3/pricing/",
  "http://www.example.corp/lambda/pricing/",
];

const HELD_URLS = [
  "https://www.example.corp/",
  "https://www.example.corp",
  "https://www.example.corp/console/",
  "https://www.example.corp/marketplace/pp/prodview-abc",
  "https://www.example.corp/blogsx/a",
  "https://www.example.corp/pricing/",
  "https://www.example.corp/a/b/pricing/",
  "https://www.example.corp.apps.example.net/blogs/a",
  "https://www.example.corp.evil.example.corp/blogs/a",
  "https://evil.example.corp/www.example.corp/blogs/a",
  "https://www.example.corp@evil.example.corp/blogs/a",
  "https://www.example.corp.evil.com/blogs/a?d=secret",
  "https://evil.com/www.example.corp/blogs/a?d=secret",
  "https://www.example.corp@evil.com/blogs/a?d=secret",
  "https://user:pw@www.example.corp/blogs/a",
  "https://www.example.corp./blogs/a",
  "https://www.example.corp/blogs/a?d=secret",
  "https://www.example.corp/lambda/pricing/?d=secret",
  "https://www.example.corp/blogs\\..\\console/",
  "https://www.example.corp/blogs/%2e%2e%2f%2e%2e%2fconsole/",
  "https://www.example.corp/blogs/.%2e/console/",
  "https://www.example.corp/blogs/../console/",
  "https://www.example.corp/blogs/%2e%2e/console/",
  "https://www.example.corp/blogs/%2E%2E%2Fconsole/",
  "https://www.example.corp/blogs%2F..%2Fconsole/",
  "https://www.example.corp/lambda/pricing/../../console/",
  "https://www.example.corp/lambda%2Fx/pricing/",
  "https://evil.www.example.corp/blogs/a",
  "https://www.example.corp:8443/blogs/a",
  "ftp://www.example.corp/blogs/a",
];

describe("WebFetch of www.example.corp blog and pricing pages", () => {
  test.each(ALLOWED_URLS)("allows %s", (url) => {
    expect(webFetch(url)).toEqual({ action: "allow" });
  });
  test.each(HELD_URLS)("holds %s", (url) => {
    expect(webFetch(url)).toMatchObject({ action: "hold" });
  });
});

describe("curl reads of www.example.corp blog and pricing pages", () => {
  test.each([
    ...ALLOWED_URLS.flatMap((u) => [`curl -s ${u}`, `curl -sL '${u}'`]),
    "curl -sL https://www.example.corp/lambda/pricing/ | grep -i price",
    "curl -s https://www.example.corp/bedrock/pricing/ -o /tmp/pricing.html",
    `curl -sL https://www.example.corp/blogs/aws/x/ -o ${join(ROOT, "post.html")}`,
    "wget -qO- https://www.example.corp/blogs/aws/x/",
  ])("allows %s", (command) => {
    expect(bash(command)).toEqual({ action: "allow" });
  });
  test.each([
    "curl -s -X POST https://www.example.corp/blogs/aws/x/",
    "curl -s -X PUT https://www.example.corp/lambda/pricing/",
    "curl -s -d a=1 https://www.example.corp/blogs/aws/x/",
    "curl -s --data-binary @body.json https://www.example.corp/blogs/aws/x/",
    "curl -s -T file.txt https://www.example.corp/blogs/aws/x/",
    `curl -s https://www.example.corp/blogs/aws/x/ -o ${join(HOME, ".bashrc")}`,
    `curl -s https://www.example.corp/blogs/aws/x/ -o ${join(DATA, "secrets", "token")}`,
    `curl -s https://www.example.corp/lambda/pricing/ -o ${join(INSTALL, "packages", "collector", "src", "floor", "classify.ts")}`,
    `curl -s https://www.example.corp/lambda/pricing/ -o ${join(SCRATCH, "launch-2", "p.html")}`,
  ])("holds %s", (command) => {
    expect(bash(command)).toMatchObject({ action: "hold" });
  });
});
