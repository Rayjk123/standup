import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join, resolve } from "path";
import { classifyToolCall } from "./classify.js";
import type { FloorConfig } from "./gate.js";
import { DATA, HOME, INSTALL, LINKS, LIVE_PATH, ROOT, VIRTUAL, WORKER_ENV, bash, config, probes, shape } from "./scratch-harness.js";

/*
 * A worker's test run under `env -i`, HOME, TMPDIR, the four XDG dirs and
 * DB_PATH repointed into one fresh /tmp root: the root made by
 * `mktemp -d -p /tmp` in the same command (with or without a template) or a
 * literal /tmp/tmp.XXXX dir, its dirs made with a brace-expanded `mkdir -p`,
 * the run wrapped in `timeout` and its output sent to a log in the root.
 * `PATH="$PATH"` expands to the classifying process's own PATH, so the tests
 * hand it a worker-shaped one.
 */

setDefaultTimeout(600_000);

const MKTEMP = "R=$(mktemp -d -p /tmp)";
const MKDIRS = "mkdir -p $R/home $R/tmp $R/xdg/{config,data,state,cache} $R/data";
const VARS = "HOME=$R/home TMPDIR=$R/tmp XDG_CONFIG_HOME=$R/xdg/config XDG_DATA_HOME=$R/xdg/data XDG_STATE_HOME=$R/xdg/state XDG_CACHE_HOME=$R/xdg/cache DB_PATH=$R/data/standup.db";
const EXTRA = "TMP=$R/tmp TEMP=$R/tmp STANDUP_SQLITE_PATH=$R/data/standup.db TMUX_TMPDIR=$R/tmp";
const ONE = "packages/collector/src/floor/tree-deletes.test.ts";

/** The owner's command: `assign` sets R (empty for a literal root), `tests` names what bun runs. */
function run({ assign = MKTEMP, vars = VARS, tests = "", wrap = "timeout 900 ", log = " > $R/full.log 2>&1", pre = "" } = {}): string {
  const head = assign ? `${assign} && ` : "";
  return `${head}${pre}${MKDIRS} && env -i PATH="$PATH" ${vars} ${wrap}bun test${tests ? ` ${tests}` : ""}${log}`;
}

/** The same command with every `$R` written out as `root`. */
const literal = (root: string, opts: Parameters<typeof run>[0] = {}) => run({ ...opts, assign: "" }).replaceAll("$R", root);

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

let saved: Array<[string, string | undefined]> = [];
beforeEach(() => {
  saved = ["PATH", "TMPDIR"].map((n) => [n, process.env[n]]);
  process.env.PATH = LIVE_PATH;
  process.env.TMPDIR = WORKER_ENV.TMPDIR;
});
afterEach(() => {
  for (const [n, v] of saved) setEnv(n, v);
});

const ALLOWED: Array<[string, string]> = [
  ["the owner's exact command", run()],
  ["one test file", run({ tests: ONE })],
  ["with TMP, TEMP, STANDUP_SQLITE_PATH and TMUX_TMPDIR too", run({ vars: `${VARS} ${EXTRA}` })],
  ["with the extra vars and one test file", run({ vars: `${VARS} ${EXTRA}`, tests: ONE })],
  ["a mktemp template", run({ assign: "R=$(mktemp -d -p /tmp land-XXXXXX)" })],
  ["no timeout wrapper", run({ wrap: "" })],
  ["no log redirect", run({ log: "" })],
  ["`;` after the assignment", run().replace(" && mkdir", "; mkdir")],
  ["a literal /tmp/tmp.XXXX root", literal("/tmp/tmp.Ab12Cd34Ef")],
  ["a literal root, one test file, the extra vars", literal("/tmp/tmp.Ab12Cd34Ef", { tests: ONE, vars: `${VARS} ${EXTRA}` })],
  ["R a literal /tmp/tmp.XXXX root", run({ assign: "R=/tmp/tmp.Ab12Cd34Ef" })],
];

describe("a bun test run isolated under one fresh /tmp root, from the worktree", () => {
  for (const [name, command] of ALLOWED) {
    test(`${name}: no hold`, () => {
      expect({ command, verdict: shape(bash(command, ROOT)) }).toEqual({ command, verdict: { action: "allow" } });
    });
  }
});

const HELD: Array<[string, string, string?]> = [
  ["HOME outside /tmp", run({ vars: VARS.replace("HOME=$R/home", "HOME=/opt/scratch/home") })],
  ["HOME the real home dir", run({ vars: VARS.replace("HOME=$R/home", `HOME=${HOME}`) })],
  ["HOME the data dir", run({ vars: VARS.replace("HOME=$R/home", `HOME=${DATA}`) })],
  ["R inherited, never set", run({ assign: "" })],
  ["R set from another variable", run({ assign: "R=$X" })],
  ["R set from a file", run({ assign: "R=$(cat /tmp/root)" })],
  ["a mktemp root under the data dir", run({ assign: `R=$(mktemp -d -p ${DATA})` })],
  ["a mktemp root under the real home", run({ assign: `R=$(mktemp -d -p ${HOME})` })],
  ["a --preload flag naming code outside the worktree", run({ tests: "--preload /opt/x.ts" })],
  ["a --preload flag outside the worktree, no timeout", run({ tests: "--preload /opt/x.ts", wrap: "" })],
  ["an --env-file flag outside the worktree, no timeout", run({ tests: "--env-file=/opt/.env", wrap: "" })],
  ["a planted dotfile in $R/home before the run", run({ pre: "echo x > $R/home/.bunfig.toml && " })],
  ["a planted file in $R/xdg/config before the run", run({ pre: "mkdir -p $R/xdg/config && echo x > $R/xdg/config/x && " })],
];

/** The checkout this file is in, classified with the real probes as its own worktree (real-repo.test.ts). */
const REPO = resolve(import.meta.dir, "..", "..", "..", "..");
const REAL_DATA = join("/", "fake", "home", ".local", "share", "standup");
const realConfig: FloorConfig = {
  v: 1,
  collectorUrl: "http://127.0.0.1:17777",
  launchId: "11111111-2222-3333-4444-555555555555",
  root: REPO,
  sharedBranches: ["main", "mainline"],
  personalAwsAccounts: [],
  waitSeconds: 60,
  standupDataDir: REAL_DATA,
  floorPaths: [join(REAL_DATA, "floor")],
  installDir: join(REAL_DATA, "install"),
  protectedPaths: [join(REAL_DATA, "secrets")],
  tmpDirs: ["/tmp"],
  workerToken: "x".repeat(64),
  replyPublicKey: "test",
};

describe("the same run against this checkout, real probes", () => {
  for (const [name, command] of ALLOWED) {
    test(`${name}: no hold`, () => {
      const v = classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: REPO }, realConfig, { gitBranch: () => "standup/feat-1", homeDir: () => join("/", "fake", "home") });
      expect({ command, verdict: v }).toEqual({ command, verdict: { action: "allow" } });
    });
  }
});

/** The harness's config with the launch's own scratch dir (the worker's TMPDIR) set, as the launcher sets it. */
const launchConfig: FloorConfig = { ...config, scratchRoot: join(HOME, ".cache", "standup-scratch"), scratchDir: WORKER_ENV.TMPDIR, scratchId: "launch-1" };

describe("the same run from a launch with its own scratch dir", () => {
  for (const [name, command] of ALLOWED) {
    test(`${name}: no hold`, () => {
      const v = classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: ROOT }, launchConfig, probes());
      expect({ command, verdict: shape(v) }).toEqual({ command, verdict: { action: "allow" } });
    });
  }
});

/** Files outside the worktree a run's flags may name: an env file that points DB_PATH at the live DB, code that deletes the data dir. */
const OUTSIDE: Record<string, string> = {
  "/opt/.env": `DB_PATH=${DATA}/standup.db\n`,
  "/opt/x.ts": `import { rmSync } from "fs";\nrmSync("${DATA}", { recursive: true, force: true });\n`,
};

describe("near the isolated run, the holds that stay", () => {
  beforeAll(() => Object.assign(VIRTUAL, OUTSIDE));
  afterAll(() => {
    for (const f of Object.keys(OUTSIDE)) delete VIRTUAL[f];
  });

  for (const [name, command] of HELD) {
    test(`${name}: held`, () => {
      expect({ command, action: bash(command, ROOT).action }).toEqual({ command, action: "hold" });
    });
  }

  test("`bun run <script>` of code outside the worktree: held", () => {
    const command = run().replace("bun test", "bun run /opt/x.ts");
    expect({ command, action: bash(command, ROOT).action }).toEqual({ command, action: "hold" });
  });

  // A root an earlier run already used holds what that run left, which reads the same as what a command planted.
  test("a literal root an earlier run left a HOME config file in: held", () => {
    const root = "/tmp/tmp.Used000001";
    const file = join(root, "home", ".claude.json");
    VIRTUAL[file] = "{}";
    try {
      expect(shape(bash(literal(root), ROOT)).reason).toContain("sets HOME, so tools read their configuration from");
      expect(bash(run({ assign: `R=${root}` }), ROOT).action).toBe("hold");
    } finally {
      delete VIRTUAL[file];
    }
  });

  test("a literal root an earlier run left a link out of: held", () => {
    const root = "/tmp/tmp.Used000002";
    // The harness lists a dir's VIRTUAL entries, so the link is one too; its lstat and realpath read LINKS first.
    const file = join(root, "tmp", "x", "via");
    VIRTUAL[file] = "";
    LINKS.set(file, "/proc");
    try {
      expect(shape(bash(literal(root), ROOT)).reason).toContain("sets HOME, so tools read their configuration from");
    } finally {
      delete VIRTUAL[file];
      LINKS.clear();
    }
  });

  test("the same run from the install dir: held", () => {
    expect(bash(run(), INSTALL).action).toBe("hold");
  });

  test("HOME pointing at a different /tmp root than the rest is not a mktemp-proven root", () => {
    const command = run({ vars: VARS.replace("HOME=$R/home", "HOME=/tmp/other/home") });
    expect(bash(command, ROOT).action).toBe("hold");
  });

  test("the hold names the HOME move for a root outside /tmp", () => {
    expect(shape(bash(run({ vars: VARS.replaceAll("$R", join("/", "opt", "s")) }), ROOT)).action).toBe("hold");
  });
});
