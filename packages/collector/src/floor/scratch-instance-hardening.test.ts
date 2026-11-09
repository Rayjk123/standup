import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "path";
import { classifyToolCall } from "./classify.js";
import { FLOOR_GATE, floorQuestion, floorScratchInstanceOf, type FloorVerdict } from "./gate.js";
import { stricterHold } from "./routes.js";
import { SCRATCH_COLLECTOR_ENV, scratchInstanceRefusal } from "./scratch-instance.js";
import { COLLECTOR, DATA, ENV, INSTALL, LINKS, LIVE_PATH, R, ROOT, TMUX_COLLECTOR, TOKEN, VIRTUAL, bash, config, held, probes, scratchEnv, shape } from "./scratch-harness.js";
import { ruleCheck, type AllowCheckInput } from "../persona/allow-check.js";
import { floorReasonOf, scratchOf } from "../persona/tools.js";

/*
 * What the scratch-instance recognition must not loosen (scratch-harness.ts
 * sets up the fake install, data dir and worktree): each call here is held
 * at the level stated, or recognised exactly as the owner's own scratch
 * collector is.
 */

// Reading the collector's whole source for one call takes about a second.
setDefaultTimeout(60_000);

afterEach(() => {
  LINKS.clear();
});

const BIN = join(INSTALL, "node_modules", ".bin");
const SECRET = join(DATA, "secrets", "owner.token");

/** How strict a verdict is: an allow, a Persona-decidable hold, an owner-only hold, a HIGH RISK (owner-reserved) one. */
function strictness(v: FloorVerdict): number {
  if (v.action === "allow") return 0;
  return v.ownerReserved ? 3 : v.ownerOnly ? 2 : 1;
}

/** `command` with the files `files` names in the fake filesystem while `run` reads it. */
function withFiles<T>(files: Record<string, string>, run: () => T): T {
  Object.assign(VIRTUAL, files);
  try {
    return run();
  } finally {
    for (const f of Object.keys(files)) delete VIRTUAL[f];
  }
}

describe("item 1: the install's tooling dirs leave a PATH only on a whole-call scratch-instance run", () => {
  // Each builds a write or read target from the PATH it sets: the install's tsc, its floor source, the owner token.
  const cases: Array<[string, (name: string) => string]> = [
    ["a parameter expansion of it, into tsc", (n) => `${n}=${BIN}:/usr/bin:/bin; cp /tmp/x "\${${n}%%:*}/tsc"`],
    ["`command -v tsc`", (n) => `${n}=${BIN}:/usr/bin:/bin; cp /tmp/x "$(command -v tsc)"`],
    ["`printenv`, into the floor source", (n) => `${n}=${BIN}:/usr/bin:/bin; cp /tmp/x "$(printenv ${n} | cut -d: -f1)/../../packages/collector/src/floor/classify.ts"`],
    ["an `IFS=:` loop over it", (n) => `${n}=${BIN}:/usr/bin:/bin; IFS=:; for d in $${n}; do cp /tmp/x "$d/tsc"; done`],
    ["`echo … | cut | xargs cp`", (n) => `echo ${n}=${BIN}:/usr/bin:/bin | cut -d= -f2 | cut -d: -f1 | xargs -I{} cp /tmp/x {}/tsc`],
    ["a read of the owner token", (n) => `${n}=${BIN}:/usr/bin:/bin; cat "\${${n}%%:*}/../../../home/.local/share/standup/secrets/owner.token"`],
    ["a command's own prefix assignment", (n) => `${n}=${BIN}:/usr/bin:/bin sh -c 'cp /tmp/x "\${${n}%%:*}/tsc"'`],
  ];

  for (const [what, build] of cases) {
    test(`${what}: held, and no looser than the same command through \`P=\``, () => {
      const viaPath = bash(build("PATH"));
      const viaP = bash(build("P"));
      expect({ what, action: viaPath.action }).toEqual({ what, action: "hold" });
      expect(strictness(viaPath)).toBeGreaterThanOrEqual(strictness(viaP));
    });
  }

  test("the install's tsc, the floor source and the owner token, at the level each is held", () => {
    expect(shape(bash(cases[0]![1]("PATH")))).toMatchObject({ category: "floor-tamper", reserved: true });
    // `command -v` finding a program in the install names that file: the write target is left unknown.
    expect(shape(bash(cases[1]![1]("PATH")))).toMatchObject({ category: "destructive" });
    expect(shape(bash(cases[5]![1]("PATH")))).toMatchObject({ category: "floor-tamper", reserved: true });
    expect(shape(bash(cases[6]![1]("PATH")))).toMatchObject({ category: "floor-tamper", reserved: true });
  });
});

describe("item 2: node and bun env files and options env leave no isolation for the login script", () => {
  const ENV_FILE = { "/tmp/envdir/.env": `STANDUP_OWNER_TOKEN_FILE=${SECRET}\n` };

  test("the plain node run under the scratch env is the isolated one", () => {
    expect(bash(`${ENV} ${TOKEN} node scripts/console-login.ts`)).toEqual({ action: "allow" });
  });

  for (const command of [
    `${ENV} ${TOKEN} node --env-file=/tmp/envdir/.env scripts/console-login.ts`,
    `${ENV} ${TOKEN} node --env-file /tmp/envdir/.env scripts/console-login.ts`,
    `${ENV} ${TOKEN} node --env-file-if-exists=/tmp/envdir/.env scripts/console-login.ts`,
    `${ENV} ${TOKEN} NODE_OPTIONS=--max-old-space-size=512 node scripts/console-login.ts`,
    `${ENV} ${TOKEN} BUN_OPTIONS=--smol bun scripts/console-login.ts`,
  ]) {
    test(`HIGH RISK: ${command.slice(ENV.length + TOKEN.length + 2)}`, () => {
      const h = withFiles(ENV_FILE, () => held(command));
      expect({ category: h.category, reserved: h.reserved, scratch: h.scratch }).toEqual({ category: "floor-tamper", reserved: true, scratch: undefined });
      expect(h.reason).toContain("the owner login script");
    });
  }
});

describe("item 3: a bun loader flag with its value run on holds as the spaced form does", () => {
  const PRELOAD = { [join(ROOT, "p.ts")]: `console.log(require("fs").readFileSync(${JSON.stringify(SECRET)}, "utf8"));\n`, [join(ROOT, "bunfig.toml")]: `preload = ["./p.ts"]\n` };
  const run = (flags: string, tail: string) => `${ENV} ${TOKEN} bun ${flags} ${tail}`;

  for (const tail of ["scripts/console-login.ts", "run scripts/console-login.ts", "-e 1"]) {
    test(`before \`${tail}\``, () => {
      withFiles(PRELOAD, () => {
        const spaced = shape(bash(run("--preload ./p.ts", tail)));
        expect(spaced).toMatchObject({ action: "hold", category: "floor-tamper", reserved: true });
        for (const flags of ["-r./p.ts", "--preload./p.ts", "-c./bunfig.toml"]) {
          const v = shape(bash(run(flags, tail)));
          expect({ flags, category: v.category, reserved: v.reserved }).toEqual({ flags, category: spaced.category, reserved: spaced.reserved });
        }
      });
    });
  }

  test("the predicate refuses each attached form", () => {
    const env = new Map<string, string | null>([["HOME", `${R}/home`], ["TMUX", ""]]);
    for (const flags of [["-r./p.ts"], ["--preload./p.ts"], ["-c./bunfig.toml"], ["run", "-r./p.ts"]]) {
      const why = scratchInstanceRefusal(env, ["bun", ...flags, "scripts/console-login.ts"], true, new Set(["HOME"]), { livePorts: [] });
      expect({ flags, refused: why !== null }).toEqual({ flags, refused: true });
    }
  });
});

describe("item 5: combined and unknown `env` options read as the separated ones", () => {
  const LOGIN_RUN = `${ENV.replace("env -i ", "")} ${TOKEN} bun scripts/console-login.ts`;

  for (const [combined, separated] of [
    [`-iC ${INSTALL}`, `-i -C ${INSTALL}`],
    [`-iC ${join(INSTALL, "packages", "web")}`, `-i -C ${join(INSTALL, "packages", "web")}`],
    ["-iu TMUX", "-i -u TMUX"],
    ["-i0", "-i -0"],
    ["-iZ", "-i -Z"],
  ] as const) {
    test(`\`env ${combined}\` as \`env ${separated}\``, () => {
      const a = shape(bash(`env ${combined} ${LOGIN_RUN}`));
      const b = shape(bash(`env ${separated} ${LOGIN_RUN}`));
      expect({ action: a.action, category: a.category, reserved: a.reserved }).toEqual({ action: b.action, category: b.category, reserved: b.reserved });
    });
  }

  test("into the install, or past an option env doesn't have: HIGH RISK", () => {
    for (const opts of [`-iC ${INSTALL}`, `-iC ${join(INSTALL, "packages", "web")}`, "-iZ", "-i -Z"]) {
      const h = held(`env ${opts} ${LOGIN_RUN}`);
      expect({ opts, category: h.category, reserved: h.reserved }).toEqual({ opts, category: "floor-tamper", reserved: true });
    }
  });

  test("a long option env doesn't have leaves the program unread: held", () => {
    // GNU env refuses an unknown long option and runs nothing; an abbreviation of one of its own is read as that option.
    const h = held(`env -i --frob ${LOGIN_RUN}`);
    expect(h.category).toBe("unclassified");
    expect(h.scratch).toBeUndefined();
  });
});

describe("items 10 and 11: a shared tmux dir or socket, or a bare live address, leaves the marker off", () => {
  test("the plain run carries the marker", () => {
    expect(held(TMUX_COLLECTOR(""), COLLECTOR).scratch).toEqual({ root: R, assignments: [TOKEN] });
  });

  test("a scratch root under /tmp/tmux-1000", () => {
    const root = "/tmp/tmux-1000/scratch";
    expect(held(TMUX_COLLECTOR("").replaceAll(R, root), COLLECTOR).scratch).toBeUndefined();
  });

  test("a tmux socket named default", () => {
    expect(held(TMUX_COLLECTOR("", `-S ${R}/default`), COLLECTOR).scratch).toBeUndefined();
  });

  test("a bare 127.0.0.1:7777 argument", () => {
    expect(held(TMUX_COLLECTOR("").replace("bun run src/index.ts", "bun run src/index.ts 127.0.0.1:7777"), COLLECTOR).scratch).toBeUndefined();
  });
});

describe("item 12: `bun test` reads its loader flags after its filters too", () => {
  test("the predicate refuses `--preload` past a filter", () => {
    const env = new Map<string, string | null>([["HOME", `${R}/home`], ["TMUX", ""]]);
    for (const tail of [["--preload", "./p.ts"], ["--preload=./p.ts"], ["-r./p.ts"]]) {
      const why = scratchInstanceRefusal(env, ["bun", "test", "x.test.ts", ...tail], true, new Set(["HOME"]), { livePorts: [] });
      expect({ tail, refused: why !== null }).toEqual({ tail, refused: true });
    }
    expect(scratchInstanceRefusal(env, ["bun", "test", "x.test.ts", "--timeout", "5000"], true, new Set(["HOME"]), { livePorts: [] })).toBeNull();
  });

  test("a preload that reads the owner token, past the filter, is HIGH RISK", () => {
    const h = withFiles({ [join(COLLECTOR, "p.ts")]: `require("fs").readFileSync(${JSON.stringify(SECRET)});\n` }, () =>
      held(`${ENV} bun test src/floor/shell.test.ts --preload ./p.ts`, COLLECTOR)
    );
    expect({ category: h.category, reserved: h.reserved, scratch: h.scratch }).toEqual({ category: "floor-tamper", reserved: true, scratch: undefined });
  });
});

describe("items 4 and 14: the owner's scratch collector, from the worker's own worktree", () => {
  // The collector's real off switches, by the names its source reads (SCRATCH_COLLECTOR_ENV).
  const offSwitches = SCRATCH_COLLECTOR_ENV.map(([name, value]) => `${name}=${value}`).join(" ");
  const collectorRun = (root: string, tmux: boolean) =>
    [
      scratchEnv(root, LIVE_PATH),
      `STANDUP_OWNER_TOKEN_FILE=${root}/data/secrets/owner.token`,
      ...(tmux ? [`TMUX_TMPDIR=${root}/tmux`] : []),
      "COLLECTOR_PORT=30741 WS_PORT=30742",
      offSwitches,
      "bun run src/index.ts",
    ].join(" ");
  const command = (spelling: "$R" | "literal", tmux: boolean) =>
    spelling === "$R"
      ? `R=${R}; tmux -S $R/tmux.sock new-session -d -s scratch "${collectorRun("$R", tmux)}"`
      : `tmux -S ${R}/tmux.sock new-session -d -s scratch "${collectorRun(R, tmux)}"`;

  test("the off switches are the collector's own names", () => {
    for (const name of ["STANDUP_BIND_HOST", "STANDUP_GATEWAY", "STANDUP_PERSONA", "STANDUP_REVIEW_TUNNELS", "STANDUP_DIGEST"]) expect(offSwitches).toContain(`${name}=`);
  });

  for (const spelling of ["$R", "literal"] as const) {
    test(`with TMUX_TMPDIR under the root (${spelling}): no hold`, () => {
      expect(bash(command(spelling, true), COLLECTOR)).toEqual({ action: "allow" });
    });

    test(`without TMUX_TMPDIR (${spelling}): a Persona-decidable hold, and the allow check finds no secrets mismatch`, () => {
      const cmd = command(spelling, false);
      const call = { toolName: "Bash", toolInput: { command: cmd }, cwd: COLLECTOR };
      const server = classifyToolCall(call, config, probes());
      expect(server.action).toBe("hold");
      if (server.action !== "hold") return;
      // The collector's own tmux calls (its reaper's `kill-session`) reach the shared default server.
      expect({ category: server.category, ownerOnly: !!server.ownerOnly, reserved: !!server.ownerReserved }).toEqual({ category: "destructive", ownerOnly: false, reserved: false });
      const token = `STANDUP_OWNER_TOKEN_FILE=${spelling === "$R" ? "$R" : R}/data/secrets/owner.token`;
      expect(server.scratch).toEqual({ root: R, assignments: [token] });
      // The hook's own hold names no marker; the collector's re-classification adds it to the question.
      const { scratch: _scratch, ...client } = server;
      const question = floorQuestion(call, stricterHold(client, server));
      expect(floorScratchInstanceOf(question)).toEqual(server.scratch!);
      // Persona's tools read the question as the allow check is handed it.
      expect(scratchOf(question)).toEqual({ scratchInstance: server.scratch! });
      const input: AllowCheckInput = {
        owner: "alice",
        selfAliases: ["alice"],
        gate: FLOOR_GATE,
        category: server.category,
        floorReason: floorReasonOf(question),
        toolName: "Bash",
        call: cmd,
        personaReason: "the brief starts a scratch collector to check the change",
        job: { title: "collector change", goal: "check the collector change against a scratch collector" },
        brief: "Start a scratch collector under /tmp to check the change.",
        ownerMessages: ["check it on a scratch collector"],
        preferences: [],
        worktreeRoot: ROOT,
        ...scratchOf(question),
      };
      const checked = ruleCheck(input);
      expect(checked.reason).not.toContain("secrets");
      // What it flags is the hold's own risk: the collector's `kill-session` on the shared server.
      expect(checked.reason).toContain("kills a process");
    });
  }
});
