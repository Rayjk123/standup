import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "path";
import { ENV, HOME, INSTALL, LINKS, LIVE_PATH, MIRRORS, R, ROOT, TOKEN, VIRTUAL, bash, held, shape } from "./scratch-harness.js";

/*
 * An isolated scratch collector started in a tmux session on a private
 * socket under the scratch root: every root the collector's code defaults
 * (packages/collector/src/index.ts) overridden under /tmp, bound to loopback
 * on a port no live Standup process uses, with every network and reaping
 * feature off. The session's start dir is the worktree, or a copy of its
 * source in a temp dir beside the scratch root; the tmux client itself may
 * run under an `env -i` of its own, handed the worker's PATH as `"$PATH"`.
 */

// Reading the collector's whole source for one call takes about a second.
setDefaultTimeout(120_000);

const OFF = "STANDUP_BIND_HOST=127.0.0.1 STANDUP_GATEWAY=0 STANDUP_PERSONA=0 STANDUP_REVIEW_TUNNELS=0 STANDUP_DIGEST=0 STANDUP_IDLE_REAP=0";
const ROOTS = [
  `TMUX_TMPDIR=${R}/tmux`,
  `ICONS_DIR=${R}/icons`,
  `STANDUP_PROJECT_DOCS_DIR=${R}/docs`,
  `STANDUP_PROJECTS_PATH=${R}/projects.json`,
  `STANDUP_WRITE_TOKEN_FILE=${R}/data/secrets/write.token`,
].join(" ");
/** A copy of the worktree's source in a temp dir beside the scratch root (`git worktree add`, `cp -r` or `git archive` there). */
const SIBLING = `${R}-src`;
/** A copy of the worktree's source inside the scratch root. */
const INSIDE = join(R, "src");

/** The collector's run inside the session: its own `env -i`, the port given as STANDUP_PORT. */
const inner = (env = `${ENV} ${TOKEN} ${ROOTS} STANDUP_PORT=29777 ${OFF}`) => `${env} bun run packages/collector/src/index.ts > ${R}/collector.log 2>&1`;

/** The tmux client's own `env -i`, with the worker's PATH handed on as `PATH="$PATH"`. */
const OUTER = `env -i PATH="$PATH" HOME=${R}/home TMPDIR=${R}/tmp`;

function start(opts: { outer?: string; socket?: string; cwd?: string; run?: string } = {}): string {
  const { outer = "", socket = `-S ${R}/tmux.sock`, cwd = ROOT, run = inner() } = opts;
  return `${outer ? `${outer} ` : ""}tmux ${socket} new-session -d -s scratch -c ${cwd} '${run}'`;
}

const withEnv = (env: string) => inner(`${ENV} ${TOKEN} ${env}`);

let path: string | undefined;
beforeEach(() => {
  // `"$PATH"` expands to the classifying process's own PATH: the worker's.
  path = process.env.PATH;
  process.env.PATH = LIVE_PATH;
});
afterEach(() => {
  process.env.PATH = path;
  MIRRORS.clear();
  LINKS.clear();
  delete VIRTUAL[join(INSIDE, ".git")];
});

describe("an isolated scratch collector start on a private tmux socket", () => {
  test("plain `tmux -S`, from the worktree: no hold", () => {
    expect(shape(bash(start()))).toEqual({ action: "allow" });
  });

  test("the tmux client under its own `env -i` (`env -i … tmux -S … new-session … 'env -i …'`), from the worktree: no hold", () => {
    expect(shape(bash(start({ outer: OUTER })))).toEqual({ action: "allow" });
    // The client's env holding only HOME is a complete isolation of its own, under a root of its own.
    expect(shape(bash(start({ outer: `env -i HOME=${R}/home` })))).toEqual({ action: "allow" });
    expect(shape(bash(start({ outer: "env -i HOME=/tmp/other/home" })))).toEqual({ action: "allow" });
  });

  test("from a copy of the source beside the scratch root: no hold", () => {
    MIRRORS.add(SIBLING);
    expect(shape(bash(start({ cwd: SIBLING })))).toEqual({ action: "allow" });
    expect(shape(bash(start({ outer: OUTER, cwd: SIBLING })))).toEqual({ action: "allow" });
  });
});

describe("near misses still hold", () => {
  const cases: Record<string, () => string> = {
    "the shared tmux server (no -S)": () => start({ socket: "" }),
    "the shared tmux server, client under `env -i`": () => start({ outer: OUTER, socket: "" }),
    "a socket outside /tmp": () => start({ socket: `-S ${join(HOME, "scratch.sock")}` }),
    "a socket outside /tmp, client under `env -i`": () => start({ outer: OUTER, socket: `-S ${join(HOME, "scratch.sock")}` }),
    "the shared server's socket, client under `env -i`": () => start({ outer: OUTER, socket: "-S /tmp/tmux-1000/default" }),
    "STANDUP_PERSONA unset": () => start({ run: withEnv(`${ROOTS} STANDUP_PORT=29777 ${OFF.replace("STANDUP_PERSONA=0 ", "")}`) }),
    "STANDUP_PERSONA unset, client under `env -i`": () => start({ outer: OUTER, run: withEnv(`${ROOTS} STANDUP_PORT=29777 ${OFF.replace("STANDUP_PERSONA=0 ", "")}`) }),
    "TMUX_TMPDIR unset": () => start({ run: withEnv(`${ROOTS.replace(`TMUX_TMPDIR=${R}/tmux `, "")} STANDUP_PORT=29777 ${OFF}`) }),
    "TMUX_TMPDIR unset, client under `env -i`": () => start({ outer: OUTER, run: withEnv(`${ROOTS.replace(`TMUX_TMPDIR=${R}/tmux `, "")} STANDUP_PORT=29777 ${OFF}`) }),
    "bind host 0.0.0.0": () => start({ run: withEnv(`${ROOTS} STANDUP_PORT=29777 ${OFF.replace("STANDUP_BIND_HOST=127.0.0.1", "STANDUP_BIND_HOST=0.0.0.0")}`) }),
    "bind host 0.0.0.0, client under `env -i`": () => start({ outer: OUTER, run: withEnv(`${ROOTS} STANDUP_PORT=29777 ${OFF.replace("STANDUP_BIND_HOST=127.0.0.1", "STANDUP_BIND_HOST=0.0.0.0")}`) }),
    "the live collector port": () => start({ run: withEnv(`${ROOTS} STANDUP_PORT=7777 ${OFF}`) }),
    "the live collector port, client under `env -i`": () => start({ outer: OUTER, run: withEnv(`${ROOTS} STANDUP_PORT=7777 ${OFF}`) }),
    "the live collector port on the client's own env": () => start({ outer: `${OUTER} STANDUP_PORT=7777` }),
    "-c the install": () => start({ cwd: INSTALL }),
    "-c the install, client under `env -i`": () => start({ outer: OUTER, cwd: INSTALL }),
  };
  for (const [name, command] of Object.entries(cases)) {
    test(`${name}: held`, () => {
      expect({ name, action: bash(command()).action }).toEqual({ name, action: "hold" });
    });
  }

  test("a copy beside the root that links to the install: held", () => {
    LINKS.set(SIBLING, INSTALL);
    expect(bash(start({ cwd: SIBLING })).action).toBe("hold");
    expect(bash(start({ outer: OUTER, cwd: SIBLING })).action).toBe("hold");
  });

  test("a copy inside the scratch root: too big for the floor to walk for links out of the root, so no isolation, and held as the collector's code reads", () => {
    MIRRORS.add(INSIDE);
    // A file in the copy lists it in the root, so the floor walks into it (linksOutOf).
    VIRTUAL[join(INSIDE, ".git")] = "gitdir: /fake/install/.git/worktrees/src\n";
    const h = held(start({ cwd: INSIDE }));
    expect({ category: h.category, reserved: h.reserved }).toEqual({ category: "floor-tamper", reserved: true });
    expect(h.reason).toContain("names Standup's data dir");
  });
});
