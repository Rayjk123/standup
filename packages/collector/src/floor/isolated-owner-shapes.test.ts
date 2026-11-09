import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { ruleCheck, type AllowCheckInput } from "../persona/allow-check.js";
import { classifyToolCall } from "./classify.js";
import { FLOOR_GATE, floorQuestion, floorScratchInstanceOf, withoutScratchLabel } from "./gate.js";
import { stricterHold } from "./routes.js";
import { COLLECTOR, DATA, ENV, LINKS, LIVE_PATH, LOGIN, OFF_NET, R, REPO, ROOT, SHADOWED, TMUX_COLLECTOR, TOKEN, VIRTUAL, bash, config, probes, scratchEnv, shape } from "./scratch-harness.js";

/*
 * The calls the owner's workers ran that the live floor held, each in the
 * exact shape the worker wrote it (scratch-harness.ts swaps in the fake
 * install and home): isolated test runs of the floor and Persona tests, the
 * runner's help, the scratch console login and a scratch collector.
 */

// Reading the collector's whole source for one call takes about a second.
setDefaultTimeout(300_000);

afterEach(() => {
  LINKS.clear();
  SHADOWED.clear();
});

const VARS =
  "HOME=$R/home XDG_DATA_HOME=$R/data XDG_CONFIG_HOME=$R/config XDG_CACHE_HOME=$R/cache XDG_STATE_HOME=$R/state TMPDIR=$R/tmp TMP=$R/tmp TEMP=$R/tmp DB_PATH=$R/standup.db STANDUP_SQLITE_PATH=$R/standup.db KNOWLEDGE_DIR=$R/knowledge STANDUP_INTERNAL_ROOT=$R/internal";
const PATHS = "/home/alice/.bun/bin:/home/alice/.local/share/mise/installs/node/24.20.0/bin:/home/alice/.local/bin:/usr/local/bin:/usr/bin:/bin";

/** The owner's isolated test run: `cd` into the package, the root as `R`, the run under `env -i`, its log under the root. */
const isolatedTests = (tests: string) => `cd ${COLLECTOR} && R=${R} && env -i PATH=${PATHS} ${VARS} bun test ${tests} > $R/t.log 2>&1`;

/** `run` with the files `files` names in the fake filesystem. */
function withFiles<T>(files: Record<string, string>, run: () => T): T {
  Object.assign(VIRTUAL, files);
  try {
    return run();
  } finally {
    for (const f of Object.keys(files)) delete VIRTUAL[f];
  }
}

describe("(A) a floor module the worker edited, in an isolated test run", () => {
  const classify = join(COLLECTOR, "src", "floor", "classify.ts");
  const text = readFileSync(join(REPO, "packages", "collector", "src", "floor", "classify.ts"), "utf8");

  test("its pattern tables and the functions the run may not call hold nothing", () => {
    expect(withFiles({ [classify]: `${text}\n// an edit\n` }, () => bash(isolatedTests("src/floor/scratch-instance.test.ts"), ROOT))).toEqual({ action: "allow" });
  });

  test("a real call the edit adds still holds", () => {
    const v = withFiles({ [classify]: `${text}\nprocess.kill(-1, "SIGTERM");\n` }, () => shape(bash(isolatedTests("src/floor/scratch-instance.test.ts"), ROOT)));
    expect({ action: v.action, category: v.category }).toEqual({ action: "hold", category: "destructive" });
  });
});

describe("(B) an isolated test run whose files name secret paths as fixtures", () => {
  const persona = join(COLLECTOR, "src", "persona");
  const NAMES = [
    'import { expect, test } from "bun:test";',
    'import { mkdtempSync, symlinkSync } from "fs";',
    'import { join } from "path";',
    'const CASES = ["cat /proc/self/environ", "cat ~/.local/share/standup/secrets/owner.token"];',
    'const refuse = (input: { file_path: string }) => (input.file_path.startsWith("/proc/") ? "kernel or device" : null);',
    'test("fixtures", () => {',
    '  expect(refuse({ file_path: "/proc/self/environ" })).toContain("kernel or device");',
    '  expect(refuse({ file_path: "~/.local/share/standup/secrets/owner.token" })).toBeNull();',
    '  const d = mkdtempSync("/tmp/fixture-");',
    '  symlinkSync("/proc/self/environ", join(d, "env"));',
    "  expect(CASES).toHaveLength(2);",
    "});",
    "",
  ].join("\n");
  // On a real host `/proc/self` is the classifying process's own `/proc/<pid>`.
  const realProc = () => LINKS.set("/proc/self", "/proc/4242");

  test("`bun test src/persona` in the owner's shape: no hold", () => {
    SHADOWED.add(persona);
    realProc();
    expect(withFiles({ [join(persona, "names-secrets.test.ts")]: NAMES }, () => bash(isolatedTests("src/persona"), ROOT))).toEqual({ action: "allow" });
  });

  test("a file that reads the owner token, directly, through a const or by Bun.file, is still held HIGH RISK", () => {
    SHADOWED.add(persona);
    realProc();
    const TOK = join(DATA, "secrets", "owner.token");
    for (const body of [
      `readFileSync("${TOK}", "utf8");`,
      `const T = "${TOK}";\ntest("x", () => { readFileSync(T, "utf8"); });`,
      `const T = "${TOK}";\ntest("x", async () => { await Bun.file(T).text(); });`,
      `test("x", () => { readFileSync("/proc/4243/environ", "utf8"); });`,
    ]) {
      const file = `import { readFileSync } from "fs";\nimport { test } from "bun:test";\n${body}\n`;
      const v = withFiles({ [join(persona, "names-secrets.test.ts")]: NAMES, [join(persona, "reads.test.ts")]: file }, () => shape(bash(isolatedTests("src/persona"), ROOT)));
      expect({ body, category: v.category, reserved: v.reserved }).toEqual({ body, category: "floor-tamper", reserved: true });
    }
  });
});

describe("(C) the runner's help and version run no test", () => {
  test("`bun test --help`, `-h` and `--version` read no test file; `bun test` still does", () => {
    const persona = join(COLLECTOR, "src", "persona");
    SHADOWED.add(persona);
    const reads = `import { readFileSync } from "fs";\nimport { test } from "bun:test";\ntest("x", () => { readFileSync("${join(DATA, "secrets", "owner.token")}", "utf8"); });\n`;
    withFiles({ [join(persona, "reads.test.ts")]: reads }, () => {
      for (const command of ["bun test --help", "bun test -h", "bun test --version", "bun test src/persona --help"]) {
        expect({ command, verdict: bash(`cd ${COLLECTOR} && ${command}`, ROOT) }).toEqual({ command, verdict: { action: "allow" } });
      }
      expect(shape(bash(`cd ${COLLECTOR} && bun test src/persona`, ROOT)).category).toBe("floor-tamper");
      // A test name filter that reads `--help` is the filter's value, not the flag.
      expect(shape(bash(`cd ${COLLECTOR} && bun test src/persona -t --help`, ROOT)).category).toBe("floor-tamper");
    });
  });
});

/** The allow check on Persona's allow of the floor's own hold of `command` from `cwd`, with the hold's scratch marker. */
function allowCheck(command: string, cwd: string): { held: boolean; reserved: boolean; scratch: boolean; reason: string | null } {
  const call = { toolName: "Bash", toolInput: { command }, cwd };
  const server = classifyToolCall(call, config, probes());
  if (server.action !== "hold") return { held: false, reserved: false, scratch: false, reason: null };
  const { scratch: _scratch, ...client } = server;
  const question = floorQuestion(call, stricterHold(client, server));
  const scratchInstance = floorScratchInstanceOf(question);
  const input: AllowCheckInput = {
    owner: "alice",
    selfAliases: ["alice"],
    gate: FLOOR_GATE,
    category: server.category,
    floorReason: withoutScratchLabel(question.slice(question.indexOf("): ") + 3, question.indexOf("\n\n"))),
    toolName: "Bash",
    call: command,
    personaReason: "the brief checks the change against a scratch instance",
    job: { title: "console change", goal: "check the change against a scratch instance" },
    brief: "Start a scratch instance under /tmp to check the change.",
    ownerMessages: ["check it on a scratch instance"],
    preferences: [],
    worktreeRoot: ROOT,
    ...(scratchInstance ? { scratchInstance } : {}),
  };
  return { held: true, reserved: !!server.ownerReserved, scratch: scratchInstance !== null, reason: ruleCheck(input).reason };
}

describe("(1) the scratch console login, run with `bun` or `bun run`", () => {
  const login = LOGIN.replace("bun scripts/console-login.ts", "bun run scripts/console-login.ts");
  const spellings: Record<string, string> = {};
  for (const [run, text] of [["bun", LOGIN], ["bun run", login]] as const) {
    spellings[`${run}, literal`] = text;
    spellings[`${run}, $R`] = `R=${R}; ${text.replaceAll(R, "$R")}`;
    spellings[`${run}, literal, PATH="$PATH"`] = text.replace(`PATH=${LIVE_PATH}`, 'PATH="$PATH"');
    spellings[`${run}, $R, PATH="$PATH"`] = `R=${R}; ${text.replace(`PATH=${LIVE_PATH}`, 'PATH="$PATH"').replaceAll(R, "$R")}`;
  }

  test("from the worker's worktree, every spelling: no hold, so no allow check finds a secrets mismatch", () => {
    for (const [spelling, command] of Object.entries(spellings)) {
      expect({ spelling, check: allowCheck(command, ROOT) }).toEqual({ spelling, check: { held: false, reserved: false, scratch: false, reason: null } });
    }
  });

  test("with the owner's own token file it is still held HIGH RISK", () => {
    const v = shape(bash(login.replace(TOKEN, `STANDUP_OWNER_TOKEN_FILE=${join(DATA, "secrets", "owner.token")}`)));
    expect({ category: v.category, reserved: v.reserved }).toEqual({ category: "floor-tamper", reserved: true });
  });
});

describe("(2) a scratch collector from a Standup worktree, with no tmux wrapper", () => {
  const run = (prog: string, env = `${ENV} TMUX_TMPDIR=${R}/tmux`) => `${env} ${TOKEN} COLLECTOR_PORT=30741 WS_PORT=30742 ${OFF_NET} ${prog}`;
  const starts: Array<[string, string, string]> = [
    ["bun run src/index.ts", run("bun run src/index.ts"), COLLECTOR],
    ["bun src/index.ts", run("bun src/index.ts"), COLLECTOR],
    ["from the worktree root", run("bun run packages/collector/src/index.ts"), ROOT],
    ["backgrounded, its log under the root", `${run("bun run src/index.ts")} > ${R}/c.log 2>&1 &`, COLLECTOR],
    ["under nohup, backgrounded", `nohup ${run("bun run src/index.ts")} > ${R}/c.log 2>&1 &`, COLLECTOR],
    ['PATH="$PATH"', run("bun run src/index.ts", `${scratchEnv(R, '"$PATH"')} TMUX_TMPDIR=${R}/tmux`), COLLECTOR],
    ["$R", `R=${R}; ${run("bun run src/index.ts", `${scratchEnv("$R")} TMUX_TMPDIR=$R/tmux`).replaceAll(R, "$R")}`, COLLECTOR],
  ];

  test("each start, and the start in a tmux session on a private socket: no hold", () => {
    for (const [what, command, cwd] of [...starts, ["tmux -S on a private socket", TMUX_COLLECTOR(), COLLECTOR] as const]) {
      expect({ what, check: allowCheck(command, cwd) }).toEqual({ what, check: { held: false, reserved: false, scratch: false, reason: null } });
    }
  });

  test("without TMUX_TMPDIR it is Persona's to weigh, and the allow check finds no secrets or HTTP-write mismatch", () => {
    for (const command of [run("bun run src/index.ts", ENV), TMUX_COLLECTOR("")]) {
      const check = allowCheck(command, COLLECTOR);
      expect({ command, held: check.held, reserved: check.reserved, scratch: check.scratch }).toEqual({ command, held: true, reserved: false, scratch: true });
      expect(check.reason).not.toContain("secrets");
      expect(check.reason).not.toContain("http-write");
    }
  });

  test("bound past loopback, with the gateway on, or on a live port: still held", () => {
    const base = run("bun run src/index.ts");
    for (const [what, command, category] of [
      ["STANDUP_BIND_HOST=0.0.0.0", base.replace("STANDUP_BIND_HOST=127.0.0.1", "STANDUP_BIND_HOST=0.0.0.0"), "outward"],
      ["STANDUP_GATEWAY=1", base.replace("STANDUP_GATEWAY=0", "STANDUP_GATEWAY=1"), "outward"],
      ["COLLECTOR_PORT=7777", base.replace("COLLECTOR_PORT=30741", "COLLECTOR_PORT=7777"), "floor-tamper"],
    ] as const) {
      const v = shape(bash(command, COLLECTOR));
      expect({ what, action: v.action, category: v.category }).toEqual({ what, action: "hold", category });
    }
  });
});
