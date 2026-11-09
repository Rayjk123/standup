import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "path";
import { classifyToolCall } from "./classify.js";
import { FLOOR_GATE, floorQuestion, floorScratchInstanceOf, withoutScratchLabel } from "./gate.js";
import { stricterHold } from "./routes.js";
import { scratchEnvRefusal, scratchInstanceRefusal } from "./scratch-instance.js";
import {
  COLLECTOR,
  COLLECTOR_RUN,
  DATA,
  ENV,
  HOME,
  INSTALL,
  LINKS,
  LIVE_PATH,
  LOGIN,
  R,
  ROOT,
  TMUX_COLLECTOR,
  TOKEN,
  VIRTUAL,
  VITE,
  WEB,
  bash,
  config,
  held,
  probes,
  scratchEnv,
  shape,
} from "./scratch-harness.js";
import { ruleCheck, type AllowCheckInput } from "../persona/allow-check.js";

/*
 * A worker's isolated scratch Standup instance (scratch-harness.ts): a run
 * under `env -i` with every dir Standup's code finds its home, data, DB and
 * owner token by under one fresh /tmp root.
 */

// Reading the collector's whole source for one call takes about a second.
setDefaultTimeout(60_000);

afterEach(() => {
  LINKS.clear();
});

function expectAllowed(command: string, cwd = ROOT): void {
  expect({ command, verdict: shape(bash(command, cwd)) }).toEqual({ command, verdict: { action: "allow" } });
}

const SHOT_PAGE = "'data:text/html,<h1>scratch</h1>'";

describe("the cases a worker's scratch instance was held for", () => {
  test("case 1: the console login script under the scratch env reads the scratch token, not the owner's", () => {
    expectAllowed(LOGIN);
    // The root written through a variable, as a worker spells it after `R=…;`.
    expectAllowed(`R=${R}; ${LOGIN.replaceAll(R, "$R")}`);
  });

  test("case 2: the scratch console's dev server, from packages/web", () => {
    expectAllowed(VITE, WEB);
  });

  test("case 3: a scratch collector in a tmux session on its own socket, from packages/collector", () => {
    expectAllowed(TMUX_COLLECTOR(), COLLECTOR);
    // Without TMUX_TMPDIR under the root, `env -i` leaves the collector's own tmux calls (its reaper's
    // `kill-session`, the legacy session listing) on the shared default socket: Persona's to weigh, not HIGH RISK.
    const h = held(TMUX_COLLECTOR(""), COLLECTOR);
    expect({ category: h.category, reserved: h.reserved }).toEqual({ category: "destructive", reserved: false });
    expect(h.reason).toContain("without TMUX_TMPDIR set to a dir under");
  });

  test("case 4: `bun test` with HOME and the XDG dirs under one /tmp root, with the worker's own PATH", () => {
    expectAllowed(`${ENV} bun test src/floor/shell.test.ts`, COLLECTOR);
    expectAllowed(`env -i PATH=${LIVE_PATH} HOME=${R}/home XDG_CONFIG_HOME=${R}/config bun test src/floor/shell.test.ts`, COLLECTOR);
    expectAllowed(`${scratchEnv(R, '"$PATH"')} bun test src/floor/shell.test.ts`, COLLECTOR);
  });

  test("case 5: the repo's screenshot helper capturing a data: page into /tmp", () => {
    expectAllowed(`bun scripts/pipeline-screenshot.ts ${SHOT_PAGE} --out /tmp/shots-1/a.png`);
    expectAllowed(`${ENV} bun scripts/pipeline-screenshot.ts ${SHOT_PAGE} --out ${R}/tmp/a.png`);
    expectAllowed(`bun scripts/pipeline-screenshot.ts 'data:text/html,<h1>a</h1><p>b%20c</p><ul><li>d</li></ul>' --out /tmp/shots-1/a.png`);
  });

  test("case 5 still holds a data: page that loads or runs anything, or names a live port", () => {
    // The helper's network guard leaves the console's port open, so a page that requests anything is no scratch page.
    for (const page of [
      "'data:text/html,<img src=http://127.0.0.1:5173/x>'",
      "'data:text/html,<script>fetch(1)</script>'",
      "'data:text/html,<body onload=x()>'",
      "'data:text/html,<div style=\"background:url(x)\">'",
      "'data:text/html,<a href=x>y</a>'",
      "'data:text/html,&#60;img&#62;'",
      "'data:text/html,%3Cscript%3Ex()%3C/script%3E'",
      "'data:text/html;base64,PGgxPmhpPC9oMT4='",
      "'data:text/html,see 127.0.0.1:7777'",
      // Any media type or parameter but text/html in UTF-8: the browser may parse it otherwise than the floor reads it.
      "'data:text/html;charset=utf-7,<h1>hi</h1>'",
      "'data:application/xhtml+xml,<h1>hi</h1>'",
      "'data:image/svg+xml,<h1>hi</h1>'",
      "'data:text/html,<h1 >hi</h1>'",
    ]) {
      const v = bash(`bun scripts/pipeline-screenshot.ts ${page} --out /tmp/shots-1/a.png`);
      expect({ page, action: v.action }).toEqual({ page, action: "hold" });
    }
  });
});

describe("what still holds", () => {
  test("the login script after a bun option whose value is the next word", () => {
    // Read as the option's value, that word is not the script bun runs.
    for (const flag of ["--unhandled-rejections strict", "--user-agent x", "--cpu-prof-dir /tmp/p", "--disable-warning x", "--redirect-warnings /tmp/w"]) {
      const h = held(`bun ${flag} scripts/console-login.ts`);
      expect({ flag, category: h.category, reserved: h.reserved }).toEqual({ flag, category: "floor-tamper", reserved: true });
    }
  });

  test("the real owner token, as the token file or by its path", () => {
    for (const command of [
      LOGIN.replace(TOKEN, `STANDUP_OWNER_TOKEN_FILE=${join(DATA, "secrets", "owner.token")}`),
      `${ENV} bun -e 'console.log(require("fs").readFileSync("${join(DATA, "secrets", "owner.token")}", "utf8"))'`,
      `cat ${join(DATA, "secrets", "owner.token")}`,
    ]) {
      const h = held(command);
      expect({ command, category: h.category, reserved: h.reserved }).toEqual({ command, category: "floor-tamper", reserved: true });
    }
  });

  test("a token file outside /tmp", () => {
    const h = held(LOGIN.replace(TOKEN, `STANDUP_OWNER_TOKEN_FILE=${join(HOME, "scratch", "owner.token")}`));
    expect({ category: h.category, reserved: h.reserved }).toEqual({ category: "floor-tamper", reserved: true });
  });

  test("the live data dir as the run's DB or data", () => {
    for (const command of [LOGIN.replace(`DB_PATH=${R}/standup.db`, `DB_PATH=${join(DATA, "standup.db")}`), LOGIN.replace(`KNOWLEDGE_DIR=${R}/knowledge`, `KNOWLEDGE_DIR=${join(DATA, "knowledge")}`)]) {
      const h = held(command);
      expect({ command, category: h.category, reserved: h.reserved }).toEqual({ command, category: "floor-tamper", reserved: true });
    }
  });

  test("tmux without its own socket, or with one in the live data dir's tmux dir", () => {
    for (const socket of ["", `-S ${join(DATA, "tmux", "workers")}`, `-S ${join(DATA, "tmux", "other")}`]) {
      const h = held(TMUX_COLLECTOR(undefined, socket), COLLECTOR);
      expect({ socket, scratch: h.scratch }).toEqual({ socket, scratch: undefined });
    }
    // A socket in the live data dir is Standup's own: HIGH RISK (on main the workers' socket was a Persona-decidable standup-ops hold).
    for (const socket of [join(DATA, "tmux", "workers"), join(DATA, "tmux", "other")]) {
      const run = held(TMUX_COLLECTOR(undefined, `-S ${socket}`), COLLECTOR);
      expect({ socket, reserved: run.reserved, scratch: run.scratch }).toEqual({ socket, reserved: true, scratch: undefined });
      const list = held(`tmux -S ${socket} list-sessions`, COLLECTOR);
      expect({ socket, category: list.category, reserved: list.reserved }).toEqual({ socket, category: "standup-ops", reserved: true });
    }
  });

  test("the install's own login script, or one run from inside the install", () => {
    for (const [command, cwd] of [
      [`${ENV} ${TOKEN} bun ${join(INSTALL, "scripts", "console-login.ts")}`, ROOT],
      [LOGIN, INSTALL],
    ] as const) {
      const h = held(command, cwd);
      expect({ command, cwd, category: h.category, reserved: h.reserved }).toEqual({ command, cwd, category: "floor-tamper", reserved: true });
    }
  });

  test("bun moved to a dir with an env file, handed one, or moved into the install", () => {
    // An env file there may set the token file back to the owner's, whatever `env -i` cleared.
    VIRTUAL[join("/", "tmp", "envdir", ".env")] = `STANDUP_OWNER_TOKEN_FILE=${join(DATA, "secrets", "owner.token")}\n`;
    try {
      const script = join(ROOT, "scripts", "console-login.ts");
      for (const command of [
        `${ENV} bun --cwd /tmp/envdir ${script}`,
        `${ENV} bun --cwd=/tmp/envdir ${script}`,
        `${ENV} bun run --cwd /tmp/envdir ${script}`,
        `${ENV} bun --env-file=/tmp/envdir/.env ${script}`,
        `${ENV} ${TOKEN} bun --cwd ${INSTALL} ${script}`,
        // Behind a wrapper, whose own isolation bun would otherwise inherit.
        `${ENV} timeout 600 bun --env-file=/tmp/envdir/.env ${script}`,
        `${ENV} nohup bun --cwd /tmp/envdir ${script}`,
        // Past the script or a value-taking flag, where bun still reads them.
        `${ENV} bun --console-depth 3 --cwd /tmp/envdir ${script}`,
        `${ENV} bun ${script} --env-file /tmp/envdir/.env`,
      ]) {
        const h = held(command);
        expect({ command, category: h.category, reserved: h.reserved }).toEqual({ command, category: "floor-tamper", reserved: true });
      }
    } finally {
      delete VIRTUAL[join("/", "tmp", "envdir", ".env")];
    }
  });

  test("a PATH into the install past its node_modules/.bin dirs", () => {
    for (const dir of [join(INSTALL, "scripts"), join(INSTALL, "packages", "collector", "src"), join(INSTALL, "node_modules")]) {
      const h = held(`${scratchEnv(R, `${dir}:/usr/bin:/bin`)} ${TOKEN} bun scripts/console-login.ts`);
      expect({ dir, reserved: h.reserved }).toEqual({ dir, reserved: true });
    }
  });

  test("a node_modules/.bin dir in the install holding anything but links into its node_modules", () => {
    const bin = join(INSTALL, "node_modules", ".bin");
    // A link out to the install's own source (a workspace package's bin) is not installed tooling.
    LINKS.set(join(bin, "tsc"), join(INSTALL, "packages", "mcp", "src", "cli.ts"));
    expect(held(`${scratchEnv(R, `${bin}:/usr/bin:/bin`)} ${TOKEN} bun scripts/console-login.ts`).reserved).toBe(true);
  });

  test("a scratch root that is a link into the live data dir", () => {
    LINKS.set(R, join(DATA, "scratch-link"));
    const h = held(LOGIN);
    expect({ category: h.category, reserved: h.reserved }).toEqual({ category: "floor-tamper", reserved: true });
  });

  test("a scratch root whose dirs resolve into the live data dir", () => {
    LINKS.set(join(R, "home"), join(DATA, "home"));
    expect(held(LOGIN).reserved).toBe(true);
  });

  test("live Standup ports", () => {
    for (const [command, cwd] of [
      [VITE.replace("SCRATCH_WEB_PORT=30743", "SCRATCH_WEB_PORT=5173"), WEB],
      [LOGIN.replace("http://127.0.0.1:30743", "http://127.0.0.1:7777"), ROOT],
      [COLLECTOR_RUN().replace("COLLECTOR_PORT=30741", "COLLECTOR_PORT=7777"), COLLECTOR],
    ] as const) {
      // HIGH RISK, as on main (where the web port was an owner-only floor-tamper hold, and the others HIGH RISK).
      const h = held(command, cwd);
      expect({ command, category: h.category, reserved: h.reserved, scratch: h.scratch }).toEqual({ command, category: "floor-tamper", reserved: true, scratch: undefined });
    }
  });

  test("a host off loopback", () => {
    // HIGH RISK, as on main. An origin on another host sends what the run builds off this host.
    const h = held(LOGIN.replace("http://127.0.0.1:30743", "http://203.0.113.9:30743"));
    expect({ category: h.category, reserved: h.reserved, scratch: h.scratch }).toEqual({ category: "outward", reserved: true, scratch: undefined });
    // A collector bound past loopback: owner-only, as main holds an isolated collector start bound past loopback
    // (false-holds-round-8-item17). Main holds this exact command HIGH RISK only for the collector code's
    // data-dir reads, which it doesn't credit to this run's isolation.
    const bound = bash(COLLECTOR_RUN().replace("STANDUP_BIND_HOST=127.0.0.1", "STANDUP_BIND_HOST=0.0.0.0"), COLLECTOR);
    expect(bound.action === "hold" && { category: bound.category, ownerOnly: bound.ownerOnly, reserved: !!bound.ownerReserved, scratch: bound.scratch }).toEqual({
      category: "outward",
      ownerOnly: true,
      reserved: false,
      scratch: undefined,
    });
  });

  test("vars under two different /tmp roots", () => {
    const h = held(LOGIN.replace(`DB_PATH=${R}/standup.db`, "DB_PATH=/tmp/other-root/standup.db"));
    expect({ category: h.category, reserved: h.reserved }).toEqual({ category: "floor-tamper", reserved: true });
  });

  test("the scratch env without `env -i`: the worker's own TMPDIR is a live dir", () => {
    const h = held(LOGIN.replace(`env -i PATH=${LIVE_PATH} `, "").replace(/ TMPDIR=\S+ TMP=\S+ TEMP=\S+/, ""));
    expect({ category: h.category, reserved: h.reserved }).toEqual({ category: "floor-tamper", reserved: true });
  });

  test("a chained step outside the isolation", () => {
    const h = held(`${TMUX_COLLECTOR()} && git push origin HEAD`, COLLECTOR);
    expect({ category: h.category, scratch: h.scratch }).toEqual({ category: "outward", scratch: undefined });
  });
});

describe("the scratch-instance marker on a hold", () => {
  const MARKER = { root: R, assignments: [TOKEN] };

  test("a scratch instance's run held for something else carries it", () => {
    expect(held(TMUX_COLLECTOR(""), COLLECTOR).scratch).toEqual(MARKER);
  });

  test("worker-controlled loader env, preload flags, a cleared env missing, a localhost origin or a second root leave it off", () => {
    const variants = [
      // Loader env handed to the run.
      TMUX_COLLECTOR("BUN_OPTIONS=--smol"),
      TMUX_COLLECTOR("NODE_OPTIONS=--max-old-space-size=512"),
      // A preload flag before the script.
      TMUX_COLLECTOR("").replace("bun run src/index.ts", "bun --preload ./src/index.ts run src/index.ts"),
      // No `env -i`: the run keeps the env the shell started with.
      TMUX_COLLECTOR("").replace(`env -i PATH=${LIVE_PATH} `, "env -u TMUX -u TMUX_PANE "),
      // An origin on localhost, not the 127.0.0.1 literal.
      TMUX_COLLECTOR("STANDUP_CONSOLE_ORIGIN=http://localhost:30743"),
      // A second run under another root beside it.
      `${TMUX_COLLECTOR("")}; ${scratchEnv("/tmp/tmp.other1")} bun test src/floor/shell.test.ts`,
      // A tmux socket outside the root, or a tmux command that types into a pane beside the run.
      TMUX_COLLECTOR("", "-S /tmp/elsewhere.sock"),
      `${TMUX_COLLECTOR("")}; tmux -S ${R}/tmux.sock send-keys -t scratch 'echo hi' Enter`,
      // A `NAME=value` argument whose value climbs from the worktree into the live data dir.
      TMUX_COLLECTOR("").replace("bun run src/index.ts", "bun run src/index.ts STANDUP_OWNER_TOKEN_FILE=../../../../../secrets/owner.token"),
      // An address argument off 127.0.0.1, or a scheme other than http(s)/ws(s).
      TMUX_COLLECTOR("").replace("bun run src/index.ts", "bun run src/index.ts https://203.0.113.9/x"),
      TMUX_COLLECTOR("").replace("bun run src/index.ts", "bun run src/index.ts file:///etc/hostname"),
      // A second tmux command chained after the first, or a tmux config file the floor doesn't read.
      `${TMUX_COLLECTOR("")} \\; send-keys -t scratch 'echo hi' Enter`,
      TMUX_COLLECTOR("", `-f ${R}/tmux.conf -S ${R}/tmux.sock`),
    ];
    // Each is held as the plain run is (the collector's tmux calls on the shared socket), now with no marker.
    for (const command of variants) expect({ command, scratch: held(command, COLLECTOR).scratch }).toEqual({ command, scratch: undefined });
  });

  test("an allowed call carries none", () => {
    expect(bash(TMUX_COLLECTOR(), COLLECTOR)).toEqual({ action: "allow" });
  });

  test("end to end: the collector's hold, the ask's question and the allow check on Persona's allow", () => {
    const command = `R=${R}; ${COLLECTOR_RUN("").replaceAll(R, "$R")}`;
    const call = { toolName: "Bash", toolInput: { command }, cwd: COLLECTOR };
    const server = classifyToolCall(call, config, probes());
    // The marker names the assignment word as the command spells it.
    expect(server.action === "hold" && server.scratch).toEqual({ root: R, assignments: [TOKEN.replaceAll(R, "$R")] });
    if (server.action !== "hold") return;
    // The hook's own hold, which names no marker, against the collector's re-classification.
    const { scratch: _scratch, ...client } = server;
    const question = floorQuestion(call, stricterHold(client, server));
    const scratchInstance = floorScratchInstanceOf(question);
    expect(scratchInstance).toEqual(server.scratch!);
    const input: AllowCheckInput = {
      owner: "alice",
      selfAliases: ["alice"],
      gate: FLOOR_GATE,
      category: server.category,
      floorReason: withoutScratchLabel(question.slice(question.indexOf("): ") + 3, question.indexOf("\n\n"))),
      toolName: "Bash",
      call: command,
      personaReason: "the brief starts a scratch collector to check the change",
      job: { title: "collector change", goal: "check the collector change against a scratch collector" },
      brief: "Start a scratch collector under /tmp to check the change.",
      ownerMessages: ["check it on a scratch collector"],
      preferences: [],
      worktreeRoot: ROOT,
    };
    // The secrets flag lifts; the hold's own risk (the collector's `kill-session` on the shared server) is still flagged.
    expect(ruleCheck(input).reason).toContain("Standup's owner secrets");
    const checked = ruleCheck({ ...input, scratchInstance: scratchInstance! });
    expect(checked.reason).not.toContain("secrets");
    expect(checked.reason).toContain("kills a process");
  });
});

describe("the shared predicate", () => {
  const live = { livePorts: ["7777", "7778", "5173", "15173"] };
  const env = (pairs: Record<string, string | null>) => new Map(Object.entries(pairs));
  const OK = { HOME: `${R}/home`, STANDUP_OWNER_TOKEN_FILE: `${R}/o`, COLLECTOR_PORT: "30741", STANDUP_CONSOLE_ORIGIN: "http://127.0.0.1:30743", TMUX: "" };
  const allowed = new Set(["HOME"]);

  test("a scratch instance's env and args pass", () => {
    expect(scratchInstanceRefusal(env(OK), ["bun", "run", "src/index.ts"], true, allowed, live)).toBeNull();
    expect(scratchInstanceRefusal(env(OK), ["bunx", "vite", "--config", "e2e/vite.scratch.config.ts"], true, allowed, live)).toBeNull();
  });

  test("each refusal", () => {
    const cases: Array<[string, string | null]> = [
      ["not cleared", scratchInstanceRefusal(env(OK), ["bun", "x.ts"], false, allowed, live)],
      ["TMUX set", scratchInstanceRefusal(env({ ...OK, TMUX: "/tmp/tmux-1000/default,1,0" }), ["bun", "x.ts"], true, allowed, live)],
      ["BUN_OPTIONS", scratchInstanceRefusal(env({ ...OK, BUN_OPTIONS: "--preload ./x.ts" }), ["bun", "x.ts"], true, allowed, live)],
      ["NODE_OPTIONS", scratchInstanceRefusal(env({ ...OK, NODE_OPTIONS: "--require ./x.js" }), ["node", "x.js"], true, allowed, live)],
      ["an unknown name", scratchInstanceRefusal(env({ ...OK, FOO: "1" }), ["bun", "x.ts"], true, allowed, live)],
      ["--preload", scratchInstanceRefusal(env(OK), ["bun", "--preload", "./x.ts", "run", "y.ts"], true, allowed, live)],
      ["run --config", scratchInstanceRefusal(env(OK), ["bun", "run", "--config=./bunfig.toml", "y.ts"], true, allowed, live)],
      ["node --import", scratchInstanceRefusal(env(OK), ["node", "--import", "./x.mjs", "y.js"], true, allowed, live)],
      ["live port", scratchInstanceRefusal(env({ ...OK, COLLECTOR_PORT: "7777" }), ["bun", "x.ts"], true, allowed, live)],
      ["localhost origin", scratchInstanceRefusal(env({ ...OK, STANDUP_CONSOLE_ORIGIN: "http://localhost:30743" }), ["bun", "x.ts"], true, allowed, live)],
      ["0.0.0.0 bind", scratchInstanceRefusal(env({ ...OK, STANDUP_BIND_HOST: "0.0.0.0" }), ["bun", "x.ts"], true, allowed, live)],
      ["gateway on", scratchInstanceRefusal(env({ ...OK, STANDUP_GATEWAY: "1" }), ["bun", "x.ts"], true, allowed, live)],
      ["unread port", scratchInstanceRefusal(env({ ...OK, COLLECTOR_PORT: null }), ["bun", "x.ts"], true, allowed, live)],
    ];
    for (const [what, why] of cases) expect({ what, refused: why !== null }).toEqual({ what, refused: true });
  });

  test("the floor's own hold weighs only live ports and hosts off loopback", () => {
    expect(scratchEnvRefusal(env({ STANDUP_CONSOLE_ORIGIN: "http://localhost:30743", COLLECTOR_PORT: null }), live, false)).toBeNull();
    expect(scratchEnvRefusal(env({ COLLECTOR_URL: "http://localhost:7777" }), live, false)?.kind).toBe("live");
    expect(scratchEnvRefusal(env({ COLLECTOR_URL: "https://collector.example.com" }), live, false)?.kind).toBe("remote");
    expect(scratchEnvRefusal(env({ SOME_URL: "see 127.0.0.1:7778" }), live, false)?.kind).toBe("live");
  });
});
