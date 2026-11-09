import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { attachSessionToLaunch, createLaunch, createSession, createStore, insertEvent, upsertProject } from "@standup/store";
import { createPermissionAsk, noticeTarget } from "../held-call.js";
import { permissionAskReadOnly, readOnlyShapeRefusal, sedScriptReadOnly } from "./permission-read-only.js";
import { decide } from "./policy.js";

/*
 * A read-only text pipeline over the worker's own worktree, a sed
 * substitution among its steps, is answered by Persona's allow once with no
 * owner card. sed that writes, reads another file or runs stays held.
 */

/** The pipeline a worker ran to read its unit-test totals out of the build's HTML report. */
const REPORT_PIPELINE = "sed -e 's/<[^>]*>/ /g' build/unit-tests/index.html | tr -s ' \\n' ' ' | grep -o -E 'Tests run: [0-9]+|Failures: [0-9]+'";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("sedScriptReadOnly", () => {
  const readOnly: string[] = [
    "s/<[^>]*>/ /g",
    "150,400p",
    "$p",
    "5,$p",
    "s/a/b/",
    "s/a/b/2g",
    "s|/usr|/opt|gI",
    "s/a\\/b/c/",
    "s/[]a]x/y/",
    "s/[^]a]x/y/",
    "/^#/d",
    "/start/,/end/p",
    "1~2d",
    "0,/x/s//y/",
    "/x/!d",
    "y/abc/xyz/",
    "s/a/b/;s/c/d/",
    "s/a/b/\ns/c/d/",
    "/x/{s/a/b/;p}",
    "10q",
    "q 3",
    "=",
    // `D` restarts without reading input only while a newline is left, and only `N` (reading a line) adds one.
    "$!N;P;D",
    "N;P;D",
    "$!N;/^\\(.*\\)\\n\\1$/!P;D",
    "h;$!N;P;D",
    "H;$!N;P;D",
    "G",
    "s/.*/[&]/",
    "s/.*/&&&&/",
    "s/a/\\&\\&\\&\\&\\&/",
    "G;G",
  ];
  for (const script of readOnly) {
    test(`read-only: ${JSON.stringify(script)}`, () => {
      expect(sedScriptReadOnly(script)).toBe(true);
    });
  }

  const held: string[] = [
    "s/a/b/w out.txt",
    "s/a/b/gw out.txt",
    "s/a/b/e",
    "s/x/date/e",
    "w out.txt",
    "1w out.txt",
    "W out.txt",
    "e date",
    "1e date",
    "r /etc/passwd",
    "R other.txt",
    "F",
    "a\\\ntext",
    "i text",
    "c text",
    "l",
    ":a;N;ba",
    "s/a/b",
    "s/[/]/x/",
    "s/[]/]x/y/",
    "s\\a\\b\\",
    "y/a/b/g",
    "p w",
    "1,",
    // `D` beside a command that adds a newline without reading input can restart the cycle forever.
    "G;D",
    "H;x;D",
    "x;G;D",
    "$!N;G;P;D",
    "1{N;h};g;D",
    "N;s/\\n/&&/;D",
    "s/^/a\\n/;D",
    "y/a/\\n/;D",
    "D;G",
    // Each copy of the match or append of a space doubles it: a few repeated grow sed past any memory.
    "s/.*/&&&&&&&&/",
    "s/.*/&&&/;s/.*/&&&/",
    "s/.*/&&&&&&&&/;s/.*/&&&&&&&&/;s/.*/&&&&&&&&/;s/.*/&&&&&&&&/",
    "s/\\(.*\\)/\\1\\1\\1\\1\\1/",
    "s/.*/\\0\\0\\0&&/",
    Array(30).fill("h;G").join(";"),
    "G;G;G;G;G",
    "H;H;H;g;H;H",
    "G;h",
    "H;g;h",
    "x;G",
    "G;G;H;H",
    "x;s/^/a/;s/.*/&&&&/;x",
  ];
  for (const script of held) {
    test(`held: ${JSON.stringify(script)}`, () => {
      expect(sedScriptReadOnly(script)).toBe(false);
    });
  }
});

describe("readOnlyShapeRefusal: sed in a pipeline", () => {
  const readOnly: Array<[string, string]> = [
    ["the build report pipeline", REPORT_PIPELINE],
    ["sed with a positional substitution", "sed 's/<[^>]*>/ /g' build/report.html | head -5"],
    ["sed -n with a substitution that prints", "sed -n 's/^Tests run: //p' build/report.txt"],
    ["sed -E and two -e scripts", "sed -E -e 's/a+/b/g' -e '/^$/d' notes.txt"],
    ["sed reading stdin", "cat a.txt | sed 's/x/y/'"],
  ];
  for (const [name, command] of readOnly) {
    test(`read-only: ${name}`, () => {
      expect(readOnlyShapeRefusal("Bash", { command })).toBeNull();
    });
  }

  const held: Array<[string, string, string]> = [
    ["sed -i", "sed -i 's/a/b/' x.ts", "sed -i"],
    ["sed --in-place", "sed --in-place 's/a/b/' x.ts", "--in-place"],
    ["sed -i joined to -e", "sed -ie 's/a/b/' x.ts", "sed -ie"],
    ["sed -f a script file", "sed -f script.sed x.ts", "sed -f"],
    ["sed s///w", "sed 's/x/y/w out' x.ts", "can write"],
    ["sed s///w in a second -e", "sed -e 's/a/b/' -e 's/x/y/w out' x.ts", "can write"],
    ["sed s///e", "sed 's/x/date/e' x.ts", "can write"],
    ["sed w", "sed -n '/x/w out.txt' x.ts", "can write"],
    ["sed W", "sed 'W out.txt' x.ts", "can write"],
    ["sed e", "sed 'e date' x.ts", "can write"],
    ["sed r", "sed 'r /etc/passwd' x.ts", "can write"],
    ["sed copying the match past memory", "sed -e 's/.*/&&&&&&&&/' -e 's/.*/&&&&&&&&/' x.ts", "can write"],
    ["sed appending the hold space past memory", `sed '${Array(30).fill("h;G").join(";")}' x.ts`, "can write"],
    ["the pipeline into a file", `${REPORT_PIPELINE} > totals.txt`, "writes a file"],
    ["the pipeline through tee", `${REPORT_PIPELINE} | tee totals.txt`, "tee is not"],
  ];
  for (const [name, command, why] of held) {
    test(`held: ${name}`, () => {
      const refusal = readOnlyShapeRefusal("Bash", { command });
      expect(refusal).not.toBeNull();
      expect(refusal!).toContain(why);
    });
  }
});

/** A launched worker with a real worktree whose `build` links to a build directory outside it, as some build tools' do. */
function setUp() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "perm-ro-pipe-")));
  dirs.push(base);
  const home = join(base, "home");
  const dataDir = join(home, ".local", "share", "standup");
  const root = join(dataDir, "worktrees", "p", "feat-1");
  mkdirSync(root, { recursive: true });
  const buildDir = join(base, "build-output", "feat-1");
  mkdirSync(join(buildDir, "unit-tests"), { recursive: true });
  writeFileSync(join(buildDir, "unit-tests", "index.html"), "<html><body><p>Tests run: 12</p><p>Failures: 0</p></body></html>\n");
  symlinkSync(buildDir, join(root, "build"));
  const env: Record<string, string> = { HOME: home, DB_PATH: join(dataDir, "standup.db"), TMPDIR: join(base, "tmp") };
  mkdirSync(env.TMPDIR!, { recursive: true });
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "P", branch: "main", repos: [root] });
  const launchId = randomUUID();
  createLaunch(store.db, { id: launchId, projectId: "p", task: "t", worktreePath: root, branch: "feat-1" });
  const sessionId = randomUUID();
  createSession(store.db, { id: sessionId, projectId: "p", title: "worker", cwd: root, status: "running" });
  attachSessionToLaunch(store.db, launchId, sessionId);
  let seq = 0;
  const prompt = (command: string, cwd: string = root) => {
    insertEvent(store.db, sessionId, "PreToolUse", { tool_use_id: `toolu_${++seq}`, agent_id: "agent-a", tool_name: "Bash", tool_input: { command }, cwd });
    return createPermissionAsk(store.db, sessionId, "Claude needs your permission", noticeTarget(store.db, sessionId));
  };
  return { store, env, root, prompt };
}

describe("Persona's allow once on the pipeline", () => {
  const cases: Array<[string, (root: string) => { command: string; cwd?: (root: string) => string }, boolean]> = [
    ["the pipeline, relative to the worktree", () => ({ command: REPORT_PIPELINE }), true],
    ["the pipeline, by absolute path", (root) => ({ command: REPORT_PIPELINE.replace("build/", `${root}/build/`) }), true],
    ["the pipeline after a cd into the build dir", () => ({ command: `cd build && ${REPORT_PIPELINE.replace("build/", "")}` }), true],
    ["the pipeline run from a subdirectory", () => ({ command: REPORT_PIPELINE.replace("build/", "../build/"), cwd: (root) => join(root, "build") }), true],
    ["sed -i on the report", () => ({ command: "sed -i 's/<[^>]*>/ /g' build/unit-tests/index.html" }), false],
    ["sed w out of the report", () => ({ command: "sed 's/<[^>]*>/ /gw out.txt' build/unit-tests/index.html" }), false],
    ["the pipeline into a file", () => ({ command: `${REPORT_PIPELINE} > totals.txt` }), false],
    ["the pipeline through tee", () => ({ command: `${REPORT_PIPELINE} | tee totals.txt` }), false],
  ];
  for (const [name, make, readOnly] of cases) {
    test(`${readOnly ? "answered" : "held"}: ${name}`, () => {
      const h = setUp();
      const { command, cwd } = make(h.root);
      const verdict = permissionAskReadOnly(h.store.db, h.prompt(command, cwd?.(h.root)), { env: h.env });
      expect(verdict.readOnly ? "read-only" : verdict.why).toEqual(readOnly ? "read-only" : expect.any(String));
      expect(verdict.readOnly).toBe(readOnly);
      const decision = decide("answer_ask", { owned: true, askKind: "permission_prompt", text: "1", permissionReadOnly: verdict.readOnly });
      expect(decision).toMatchObject(readOnly ? { rule: "act" } : { rule: "ask", holdRule: "permission-prompt" });
    });
  }
});
