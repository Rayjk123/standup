import { describe, expect, test } from "bun:test";
import { moduleView, type Requested } from "./live-code.js";

/** The view's text with blank lines dropped, for comparing what was kept. */
function kept(text: string, requested: Requested | undefined, loading = false): string | null {
  const v = moduleView(text, requested, loading);
  return v === null ? null : v.text.split("\n").map((l) => l.trimEnd()).filter(Boolean).join("\n");
}

function imports(text: string, requested: Requested | undefined): Record<string, string[] | "all"> {
  const out: Record<string, string[] | "all"> = {};
  for (const [spec, names] of moduleView(text, requested)?.imports ?? []) out[spec] = names === null ? "all" : [...names].sort();
  return out;
}

const LIB = [
  'import { execSync } from "child_process";',
  'import { helper } from "./helper.js";',
  "export const NAME = \"lib\";",
  "export function used(): string {",
  "  return inner();",
  "}",
  "function inner(): string {",
  "  return helper();",
  "}",
  "export function unused(): void {",
  '  execSync("tmux kill-server");',
  "}",
  "export const arrow = (x: number): number => x + 1;",
  "export class Box {",
  "  open() {",
  '    execSync("git push");',
  "  }",
  "}",
  "export interface Shape {",
  "  standupDataDir: string;",
  '  kind: "push" | "deploy";',
  "}",
].join("\n");

describe("moduleView", () => {
  test("an entry, or a module read whole, keeps all its text", () => {
    expect(moduleView(LIB, undefined)!.text).toBe(LIB);
    expect(moduleView(LIB, null)!.text).toBe(LIB);
  });

  test("a module imported for some names keeps its top-level code and what those names reach", () => {
    const text = kept(LIB, new Set(["used"]))!;
    expect(text).toContain("export function used()");
    expect(text).toContain("function inner()");
    expect(text).toContain('export const NAME = "lib";');
    for (const gone of ["tmux kill-server", "git push", "x + 1", "standupDataDir"]) expect(text).not.toContain(gone);
    // A type's names are blanked; its literals stay, so the words in it read as data.
    expect(text).toContain('_: "push" | "deploy";');
    // The imports the kept code uses, with the names it uses; an unused one is left out.
    expect(imports(LIB, new Set(["used"]))).toEqual({ "./helper.js": ["helper"] });
    expect(text).not.toContain("child_process");
  });

  test("with no names, only what runs on load", () => {
    expect(kept(LIB, new Set())).toBe('export const NAME = "lib";\nexport interface _ {\n  _: _;\n  _: "push" | "deploy";\n}');
  });

  test("top-level code that calls a definition keeps it", () => {
    const text = 'function boot() {\n  run();\n}\nfunction run() {\n  console.log("x");\n}\nfunction idle() {\n  console.log("y");\n}\nboot();\n';
    expect(kept(text, new Set())).toBe('function boot() {\n  run();\n}\nfunction run() {\n  console.log("x");\n}\nboot();');
  });

  test("what isn't a plain definition is code that runs", () => {
    for (const text of [
      "(function () {\n  go();\n})();\n",
      "!function () {\n  go();\n}();\n",
      "export const x = (() => go())();\n",
      "export class A {\n  static x = go();\n}\n",
      "export class A {\n  [go()]() {}\n}\n",
      "export class A extends mixin(B) {}\n",
      "@decorate\nexport class A {}\n",
      "export const f = () => go\n(1);\n",
      "export const a = 1, f = () => go();\n",
      "export default go();\n",
      "module.exports = { f: () => go() };\n",
    ]) {
      expect({ text, kept: kept(text, new Set()) }).toEqual({ text, kept: text.trimEnd() });
    }
  });

  test("text it can't read reliably, or code using eval, isn't pruned", () => {
    expect(moduleView('const s = "unclosed;\nfunction f() {}\n', new Set())).toBeNull();
    expect(moduleView("function f() {\n", new Set())).toBeNull();
    expect(moduleView("function f() {\n  go();\n}\neval(\"f()\");\n", new Set())).toBeNull();
    expect(moduleView("export const run = (s: string) => eval(s);\n", new Set(["run"]))).toBeNull();
  });

  test("regex literals and templates don't throw the brackets off", () => {
    const text = "export function quote(s: string): string {\n  return `'${s.replace(/'/g, `'\\\\''`)}'`;\n}\nconst RE = /[{(]/;\nfunction gone() {\n  go();\n}\n";
    const out = kept(text, new Set(["quote"]))!;
    expect(out).toContain("export function quote");
    expect(out).not.toContain("go()");
  });

  test("names an importer uses, by each import form", () => {
    const text = [
      'import { a as b, c, type T } from "./named.js";',
      'import D from "./default.js";',
      'import * as ns from "./ns.js";',
      'import * as whole from "./whole.js";',
      'import type { U } from "./types.js";',
      'import "./side.js";',
      'export { x as y } from "./re.js";',
      'export * from "./star.js";',
      "b();",
      "D();",
      "ns.f();",
      "keep(whole);",
      'require("./req.js");',
    ].join("\n");
    expect(imports(text, new Set(["y", "z"]))).toEqual({
      "./named.js": ["a"],
      "./default.js": ["default"],
      "./ns.js": ["f"],
      "./whole.js": "all",
      "./side.js": [],
      "./re.js": ["x"],
      "./star.js": ["y", "z"],
      "./req.js": "all",
    });
    expect([...moduleView(text, undefined)!.typesOnly]).toEqual(["./types.js"]);
  });

  test("exported aliases reach the definitions they stand for", () => {
    const text = "function inner() {\n  go();\n}\nfunction other() {}\nexport { inner as outer };\nexport default other;\n";
    expect(kept(text, new Set(["outer"]))).toContain("go()");
    expect(kept(text, new Set(["default"]))).toContain("function other() {}");
    expect(kept(text, new Set(["default"]))).not.toContain("go()");
  });

  test("loading: a definition only handed on as a value escapes, and building values doesn't act", () => {
    const text = 'import { join } from "path";\nfunction handler() {\n  go();\n}\nexport const ROUTES = { a: handler };\nexport const DIR = join("/tmp", "x");\n';
    const v = moduleView(text, new Set(), true)!;
    expect([...v.escapes]).toEqual(["handler"]);
    expect(v.text).not.toContain("go()");
    expect(v.acts).toBe(false);
  });

  test("loading: a call to anything but builtins that build values, or its own code, acts", () => {
    const acts = (text: string) => moduleView(text, new Set(), true)!.acts;
    expect(acts('import { execSync } from "child_process";\nexecSync("x");\n')).toBe(true);
    expect(acts('import { readFileSync } from "fs";\nexport const T = readFileSync("/x", "utf8");\n')).toBe(true);
    expect(acts("export const r = [1].map((x) => fetch(String(x)));\n")).toBe(true);
    expect(acts("const fns = [go];\nfns[0]();\n")).toBe(true);
    expect(acts('import { boot } from "./boot.js";\nboot();\n')).toBe(false);
    expect(acts("export const fs = { read: (p: string) => readFileSync(p), write(p: string) { writeFileSync(p, \"\"); } };\n")).toBe(false);
    expect(acts("export const fs = { read: (p: string) => readFileSync(p) };\nfs.read(\"/x\");\n")).toBe(true);
    expect(acts("export const n = [...new Set([1, 2])].map(String).join(\",\");\n")).toBe(false);
    expect(acts('import { join } from "path";\nexport const p = join("/tmp", "x");\n')).toBe(false);
  });

  test("loading: ways to run code while looking like building values still act", () => {
    const acts = (text: string) => moduleView(text, new Set(), true)!.acts;
    for (const text of [
      // A runner imported under a builtin's name.
      'import { execSync as join } from "child_process";\njoin("git push");\n',
      'import { execSync } from "child_process";\nconst map = execSync;\nmap("git push");\n',
      // Methods, getters and classes, which the language may call on its own.
      'const o = { toString() { go(); return ""; } };\nexport const s = `${o}`;\n',
      "const o = { get v() { go(); return 1; } };\nexport const v = o.v;\n",
      "const o = { toString: () => go() };\nexport const s = String(o);\n",
      "const o = { [Symbol.iterator]: function* () { go(); } };\nexport const a = [...o];\n",
      'export class A extends execSync("x") {}\n',
      // A definition handed to a call that runs it now, or later.
      "function go() {\n  execSync(\"x\");\n}\nexport const a = [1].map(go);\n",
      "function go() {\n  execSync(\"x\");\n}\nsetTimeout(go, 1);\n",
      // Methods of an imported object, or of a global client.
      'import { client } from "some-sdk";\nexport const k = client.keys();\n',
      'Bun.redis.set("k", "v");\n',
      // A key the language calls on its own, holding a function by name.
      'import { go } from "pkg";\nconst o = { toString: go };\nexport const s = String(o);\n',
      'import { go } from "pkg";\nconst o = { valueOf: go };\nexport const n = Number(o);\n',
      'import { go } from "pkg";\nconst then = go;\nexport const v = await { then };\n',
      'import { go } from "pkg";\nconst a = [{ toString: go }, 1];\na.sort();\n',
      // A parameter's method stored with an imported function.
      'import { go } from "pkg";\nfunction f(x: { push(n: number): void }) {\n  return x.push(1);\n}\nconst o = { push: go };\nf(o);\n',
      'import { go } from "pkg";\nconst f = (x: { push(n: number): void }) => x.push(1);\nf({ push: go });\n',
    ]) {
      expect({ text, acts: acts(text) }).toEqual({ text, acts: true });
    }
  });
});
