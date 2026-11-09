import { describe, expect, test } from "bun:test";
import { exampleCorpProfile } from "../org-profile/fixtures/example-corp.js";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * A RegExp's source in code that runs commands is read as the code's text,
 * as any other literal is, whatever the code does with the RegExp: one only
 * matched with (`.test(…)`, a string literal's `split`) is read the same as
 * one handed to a call that runs it. Here that text is a `git push`, held as
 * outward.
 */

const HOME = "/fake/home";
const DATA = `${HOME}/.local/share/standup`;
const ROOT = `${DATA}/worktrees/standup/feat-1`;
const INSTALL = "/fake/install";
const SCRIPT = `${ROOT}/scripts/probe.ts`;

const config: FloorConfig = {
  v: 1,
  orgProfile: exampleCorpProfile(),
  collectorUrl: "http://127.0.0.1:17777",
  launchId: "launch-1",
  root: ROOT,
  sharedBranches: ["main", "mainline"],
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

function probes(files: Record<string, string>): Partial<FloorProbes> {
  const all: Record<string, string> = {
    [`${ROOT}/.git`]: "gitdir: /fake/repo/.git/worktrees/feat-1\n",
    [`${ROOT}/package.json`]: JSON.stringify({ name: "probe", scripts: { test: "bun test" } }),
    ["/fake/repo/.git/HEAD"]: "ref: refs/heads/main\n",
    ...files,
  };
  const dirs = new Set<string>(["/", "/tmp", ROOT]);
  for (const f of Object.keys(all)) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  dirs.delete(`${ROOT}/.git`);
  const defs: ShellDefinitions = { aliases: new Map(), functions: new Map() };
  parseShellSnapshot("", defs);
  const bare = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    gitCommonDir: (dir) => (dir === ROOT ? "/fake/repo/.git" : null),
    readFile: (p) => (p in all ? { ok: true, text: all[p]! } : { ok: false, reason: "missing" }),
    exists: (p) => p in all || dirs.has(bare(p)),
    isDirectory: (p) => dirs.has(bare(p)),
    listDir: (raw) => {
      const p = bare(raw);
      return dirs.has(p) ? [...new Set([...Object.keys(all), ...dirs].filter((f) => f.startsWith(`${p === "/" ? "" : p}/`)).map((f) => f.slice(p.length + 1).split("/")[0]!))] : null;
    },
    realpath: (p) => (p in all || dirs.has(p) ? p : null),
    homeDir: () => HOME,
    env: (name) => (name.startsWith("GIT_") ? undefined : process.env[name]),
    shellDefinitions: () => defs,
    awsAccount: () => null,
    now: () => Date.now(),
    gitTree: () => null,
    gitBlob: () => ({ ok: false, reason: "missing" }),
  };
}

/** A script in the worktree run with bun, with `text` as its content. */
function runScript(text: string): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command: `bun ${SCRIPT.slice(ROOT.length + 1)}` }, cwd: ROOT }, config, probes({ [SCRIPT]: text }));
}

const summary = (v: FloorVerdict) => (v.action === "allow" ? "allow" : v.category);
const IMPORT = 'import { execSync } from "child_process";\n';
const PUSH = "git push origin HEAD";

describe("a RegExp source the code only matches with is still read as the code's text", () => {
  test.each([
    ["a direct .test and .exec on a binding", `const RE = new RegExp("${PUSH}");\nexport const pushes = (s: string) => RE.test(s) || RE.exec(s) !== null;\nexecSync("git status");\n`],
    ["a direct .test on the RegExp itself", `export const pushes = (s: string) => new RegExp("${PUSH}").test(s);\nexecSync("git status");\n`],
    ["a string literal's replace, match and split handed the binding", `const RE = new RegExp("${PUSH}");\nexport const parts = () => ["a-b".replace(RE, ""), "c-d".match(RE), \`e-f\`.split(RE)];\nexecSync("git status");\n`],
    ["a string literal's split handed the RegExp itself", `export const parts = () => "a-b".split(new RegExp("${PUSH}"));\nexecSync("git status");\n`],
    ["the first statement of the code a string literal's search", `"a-b".search(new RegExp("${PUSH}"));\nexecSync("git status");\n`],
    [
      "RegExp named as a type, an instanceof and a typeof",
      `const RE: RegExp = new RegExp("${PUSH}");\nconst all: Array<RegExp> = [];\nexport const first = (p: RegExp): RegExp[] => [p];\nexport const isRe = (v: unknown, w: string | RegExp) => v instanceof RegExp && typeof RegExp === "function" && RE.test(String(w)) && all.length === 0;\nexecSync("git status");\n`,
    ],
  ])("%s", (_what, body) => {
    expect({ body, verdict: summary(runScript(IMPORT + body)) }).toEqual({ body, verdict: "outward" });
  });
});

describe("a RegExp source the code hands on, or matches with through methods it may have rebound, is read as the code's text", () => {
  test.each([
    // The source handed on through a template's `${…}`, `String(re)` or a string `eval`.
    ["its .source in a template's interpolation", `const re = new RegExp("${PUSH}");\nre.test("x");\nexecSync(\`\${re.source}\`);\n`],
    ["the binding alone in a template's interpolation", `const re = new RegExp("${PUSH}");\nre.test("x");\nexecSync(\`\${re}\`.slice(1, -1));\n`],
    ["its source in a template run as a shell line", `const re = new RegExp("${PUSH}");\nre.test("x");\nexecSync(\`cd /tmp && \${re.source}\`);\n`],
    ["String(re) beside a .test", `const re = new RegExp("${PUSH}");\nre.test("x");\nexecSync(String(re).slice(1, -1));\n`],
    ["a name in a string eval runs", `const re = new RegExp("${PUSH}");\nre.test("x");\neval("execSync(re.source)");\n`],
    // A receiver with a matching method of its own that runs what it is handed.
    ["a user-defined replace handed the RegExp", `const o = { replace: (p: RegExp) => execSync(p.source) };\no.replace(new RegExp("${PUSH}"));\n`],
    ["a user-defined match handed the binding", `const re = new RegExp("${PUSH}");\nconst runner = { match(p: RegExp) { execSync(p.source); } };\nrunner.match(re);\n`],
    ["a user-defined split on a parameter", `function cut(s: { split(p: RegExp): void }) { s.split(new RegExp("${PUSH}")); }\ncut({ split: (p) => { execSync(p.source); } });\n`],
    ["a string-typed parameter's replace, which a caller may hand any object", `export const strip = (s: string) => s.replace(new RegExp("${PUSH}"), "");\nstrip({ replace: (p: RegExp) => execSync(p.source) } as unknown as string);\n`],
    ["a tagged template's result", `const tag = (_s: TemplateStringsArray) => ({ split: (p: RegExp) => execSync(p.source) });\ntag\`a-b\`.split(new RegExp("${PUSH}"));\n`],
    ["a call's result", `const make = () => ({ replace: (p: RegExp) => execSync(p.source) });\nmake().replace(new RegExp("${PUSH}"), "");\n`],
    // A tagged template's result, tagged after `}`, a generic's `>` or a line break.
    ["a template tagged by a function expression", `const y = function () { return { split: (p: RegExp) => execSync(p.source) }; }\`a\`.split(new RegExp("${PUSH}"));\n`],
    ["a template tagged by a generic call", `const tag = <T,>(_s: TemplateStringsArray) => ({ split: (p: RegExp) => execSync(p.source) });\ntag<string>\`a\`.split(new RegExp("${PUSH}"));\n`],
    ["a template on the line after its tag", `const tag = (_s: TemplateStringsArray) => ({ split: (p: RegExp) => execSync(p.source) });\nconst y = tag\n\`a\`.split(new RegExp("${PUSH}"));\n`],
    // A parameter, catch binding or destructured name of `RegExp` shadows the global.
    ["an arrow parameter named RegExp, through a binding", `((RegExp: any) => { const re = RegExp("${PUSH}"); re.test("x"); })(execSync);\n`],
    ["an arrow parameter named RegExp, inline", `((RegExp: any) => RegExp("${PUSH}").test("x"))(execSync);\n`],
    ["an untyped arrow parameter named RegExp", `const run = RegExp => RegExp("${PUSH}").test("x");\nrun(execSync);\n`],
    ["a function parameter named RegExp", `function g(RegExp: any) { return RegExp("${PUSH}").test("x"); }\ng(execSync);\n`],
    ["a second function parameter named RegExp", `function g(a: number, RegExp: any) { return RegExp("${PUSH}").test("x"); }\ng(1, execSync);\n`],
    ["a catch binding named RegExp", `try { throw execSync; } catch (RegExp: any) { RegExp("${PUSH}").test("x"); }\n`],
    ["a destructured alias named RegExp", `const { run: RegExp } = { run: execSync } as any;\nRegExp("${PUSH}").test("x");\n`],
    ["a destructured default named RegExp", `const { x: RegExp = execSync } = {} as any;\nRegExp("${PUSH}").test("x");\n`],
    ["a destructured default named RegExp in a parameter", `function g({ x: RegExp = execSync }: any) { return RegExp("${PUSH}").test("x"); }\ng({});\n`],
    ["an object property arrow with a parameter named RegExp", `const o = { run: RegExp => RegExp("${PUSH}").test("x") };\no.run(execSync);\n`],
    // Code that rebinds what the matching methods do.
    ["RegExp.prototype.test patched", `RegExp.prototype.test = function (this: RegExp) { execSync(this.source); return true; };\nnew RegExp("${PUSH}").test("x");\n`],
    ["RegExp.prototype.exec patched through a computed key", `RegExp["prototype"].exec = function (this: RegExp) { execSync(this.source); return null; };\nconst re = new RegExp("${PUSH}");\nre.exec("x");\n`],
    ["a RegExp's prototype reached through getPrototypeOf", `Object.getPrototypeOf(/x/).test = function (this: RegExp) { execSync(this.source); return true; };\nnew RegExp("${PUSH}").test("x");\n`],
    ["a RegExp's prototype reached through __proto__", `(/x/ as any).__proto__.test = function (this: RegExp) { execSync(this.source); return true; };\nnew RegExp("${PUSH}").test("x");\n`],
    ["String.prototype.split patched", `String.prototype.split = function (p: any) { execSync(p.source); return []; } as any;\n"a-b".split(new RegExp("${PUSH}"));\n`],
    ["a well-known symbol method", `const re = new RegExp("${PUSH}");\nObject.assign(RegExp, { [Symbol.split]: () => execSync(re.source) });\n"a-b".split(re);\n`],
    ["RegExp itself rebound", `globalThis.RegExp = class { constructor(public source: string) {} test() { execSync(this.source); return true; } } as any;\nnew RegExp("${PUSH}").test("x");\n`],
    ["a binding rebound by a logical assignment", `let re: any = new RegExp("${PUSH}");\nconst src = re.source;\nre &&= { test: () => execSync(src) };\nre.test("x");\n`],
    ["a binding rebound by a nullish assignment after a .test", `let re: any = new RegExp("${PUSH}");\nre.test("x");\nre ??= 0;\nexecSync("git status");\n`],
    ["RegExp rebound through a string key",`(globalThis as any)["RegExp"] = function (s: string) { return { test: () => execSync(s) }; };\nnew RegExp("${PUSH}").test("x");\n`],
  ])("%s", (_what, body) => {
    const v = runScript(IMPORT + body);
    expect({ body, verdict: summary(v) }).toEqual({ body, verdict: "outward" });
  });

  test("a prototype patched in a local module the code imports", () => {
    const patch = `${ROOT}/scripts/patch.ts`;
    const files = {
      [patch]: `${IMPORT}RegExp.prototype.test = function (this: RegExp) { execSync(this.source); return true; };\nexport {};\n`,
      [SCRIPT]: `import "./patch.ts";\nexport const pushes = (s: string) => new RegExp("${PUSH}").test(s);\nconsole.log(pushes("x"));\n`,
    };
    const v = classifyToolCall({ toolName: "Bash", toolInput: { command: `bun ${SCRIPT.slice(ROOT.length + 1)}` }, cwd: ROOT }, config, probes(files));
    expect(summary(v)).toBe("outward");
  });

  test.each([
    ["a user-defined replace handed the RegExp", `const o = { replace: (p: RegExp) => execSync(p.source) };\no.replace(new RegExp("git status --short"));\n`],
    ["its .source in a template's interpolation", `const re = new RegExp("git status --short");\nre.test("x");\nexecSync(\`\${re.source}\`);\n`],
    ["RegExp.prototype.test patched", `RegExp.prototype.test = function (this: RegExp) { execSync(this.source); return true; };\nnew RegExp("git status --short").test("x");\n`],
  ])("the same code with a read-only pattern is allowed: %s", (_what, body) => {
    expect(summary(runScript(IMPORT + body))).toBe("allow");
  });
});
