import { afterAll, describe, expect, test } from "bun:test";
import { join } from "path";
import { COLLECTOR, DATA, ENV, OFF_NET, R, ROOT, TOKEN, VIRTUAL, bash, shape } from "./scratch-harness.js";

/*
 * 1. A scratch harness under a complete /tmp isolation that runs the
 *    worktree's code by its absolute path: the path lies in the data dir under
 *    the real home and spells `worktrees/`, which reads as naming the real home
 *    and climbing a path. It names only where the code is, so the defaults the
 *    code falls back to (defaultDbPath, standupDataDir) resolve under the
 *    scratch root and the run is judged by those.
 * 2. `ln -s` with a relative target: the link resolves it from its own dir,
 *    not the cwd.
 */

const DB_PATH_TS = `${ROOT}/packages/collector/src/db-path.ts`;
/** DB_PATH_TS as a JS string spells it with each `/` escaped: the same value, other source text. */
const ESCAPED = DB_PATH_TS.replaceAll("/", "\\/");

const HARNESSES: Record<string, string> = {
  [join(R, "db-path.ts")]: `import { defaultDbPath } from "${ROOT}/packages/collector/src/db-path.ts";\nconsole.log(defaultDbPath());\n`,
  [join(R, "data-dir.ts")]: `import { standupDataDir } from "${ROOT}/packages/shared/src/owner-token.ts";\nconsole.log(standupDataDir());\n`,
  // Code that climbs from the worktree's path reaches the live data dir.
  [join(R, "climbs.ts")]: `import { dirname } from "path";\nimport { defaultDbPath } from "${ROOT}/packages/collector/src/db-path.ts";\nconsole.log(defaultDbPath(), dirname(dirname(dirname("${ROOT}"))));\n`,
  [join(R, "dotdot.ts")]: `import { defaultDbPath } from "${ROOT}/packages/collector/src/db-path.ts";\nconsole.log(defaultDbPath(), "${ROOT}/../../../standup.db");\n`,
  // A worktree path used as data, not as a module to load, may be cut back to the real home.
  [join(R, "exec.ts")]: `import { Database } from "bun:sqlite";\nimport { defaultDbPath } from "${ROOT}/packages/collector/src/db-path.ts";\nconsole.log(defaultDbPath());\nnew Database(/^(.+?)\\/w/.exec("${ROOT}/packages")![1] + "/standup.db");\n`,
  [join(R, "parse.ts")]: `import { parse } from "path";\nimport { defaultDbPath } from "${ROOT}/packages/collector/src/db-path.ts";\nconsole.log(defaultDbPath(), parse(parse(parse(parse("${ROOT}/packages").dir).dir).dir).dir);\n`,
  [join(R, "charcode.ts")]: `import { join } from "path";\nimport { defaultDbPath } from "${ROOT}/packages/collector/src/db-path.ts";\nconst u = String.fromCharCode(46, 46);\nconsole.log(defaultDbPath(), join("${ROOT}/packages", u, u, u, u, "standup.db"));\n`,
  [join(R, "tail.ts")]: `import { Database } from "bun:sqlite";\nimport { join } from "path";\nconst h = /^(.+?)\\/\\.l/.exec("${ROOT}/packages")![1];\nnew Database(join(h, ".local/share/standup", "standup.db"));\n`,
  [join(R, "dbpath-climb.ts")]: `import { Database } from "bun:sqlite";\nimport { dirname } from "path";\nimport { defaultDbPath } from "${ROOT}/packages/collector/src/db-path.ts";\nconsole.log(defaultDbPath());\nnew Database(dirname(dirname(dirname(dirname("${ROOT}/packages")))) + "/standup" + ".db");\n`,
  // A call that only looks like a module load, and a module load beside an escaped copy used as data.
  [join(R, "method.ts")]: `import { Database } from "bun:sqlite";\nimport { defaultDbPath } from "${ROOT}/packages/collector/src/db-path.ts";\nconsole.log(defaultDbPath());\nconst x = { import: (s: string) => s };\nnew Database(/^(.+?)\\/w/.exec(x.import("${ROOT}/packages"))![1] + "/standup.db");\n`,
  [join(R, "tagged.ts")]: `import { Database } from "bun:sqlite";\nimport { defaultDbPath } from "${ROOT}/packages/collector/src/db-path.ts";\nconsole.log(defaultDbPath());\nconst from = (s: TemplateStringsArray) => s[0]!;\nnew Database(/^(.+?)\\/w/.exec(from\`${ROOT}/packages\`)![1] + "/standup.db");\n`,
  [join(R, "escaped.ts")]: `import { Database } from "bun:sqlite";\nimport { defaultDbPath } from "${ROOT}/packages/collector/src/db-path.ts";\nconsole.log(defaultDbPath());\nconst s = "${ESCAPED}";\nnew Database(Array.from(s).filter((_, i) => i < 10).join("") + "/.local/share/standup/standup.db");\n`,
  // The same, with a line the scan can't close standing in for the escaped copy's import.
  [join(R, "decoy.ts")]: `import { Database } from "bun:sqlite";\nimport { defaultDbPath } from "${DB_PATH_TS}";\nconsole.log(defaultDbPath());\nconst re = /'x;import "${DB_PATH_TS}"/;\nconst s = "${ESCAPED}";\nnew Database(Array.from(s).filter((_, i) => i < 10).join("") + "/.local/share/standup/standup.db");\n`,
  // Import text inside a regex literal or a template is data the code can read back.
  [join(R, "source.ts")]: `import { Database } from "bun:sqlite";\nimport { defaultDbPath } from "${DB_PATH_TS}";\nconsole.log(defaultDbPath());\nconst s = /;import "${DB_PATH_TS}"/.source;\nnew Database(Array.from(s).filter((_, i) => i > 8 && i < 19).join("") + "/.local/share/standup/standup.db");\n`,
  [join(R, "template.ts")]: `import { Database } from "bun:sqlite";\nimport { defaultDbPath } from "${DB_PATH_TS}";\nconsole.log(defaultDbPath());\nconst s = \`\nimport "${DB_PATH_TS}"\n\`;\nnew Database(Array.from(s).filter((_, i) => i > 8 && i < 19).join("") + "/.local/share/standup/standup.db");\n`,
  [join(R, "py.py")]: `import sqlite3\ndef g():\n    yield from "${ROOT}/packages/collector/src/db-path.ts"\nhome = "".join(list(g())[:10])\nsqlite3.connect(home + "/.local/share/standup/standup.db")\n`,
  // A climb in a template's code, and a quote in a regex literal that shifts what the scan reads as code.
  [join(R, "template-climb.ts")]: `import { Database } from "bun:sqlite";\nimport { dirname } from "path";\nimport "${DB_PATH_TS}";\nnew Database(\`\${dirname(dirname(dirname(process.env.HOME!)))}/.local/share/standup/standup.db\`);\n`,
  [join(R, "regex-tick.ts")]: `import { Database } from "bun:sqlite";\nimport { defaultDbPath } from "${DB_PATH_TS}";\nconsole.log(defaultDbPath());\nconst r = /\`/;\nconst s = \`\nimport "${DB_PATH_TS}"\n\`;\nnew Database(Array.from(s).filter((_, i) => i > 8 && i < 19).join("") + "/.local/share/standup/standup.db");\n`,
  // Bun's file import is the module's path; a module can export its own location.
  [join(R, "file-import.ts")]: `import { Database } from "bun:sqlite";\nimport p from "${DB_PATH_TS}" with { type: "file" };\nnew Database(Array.from(p).filter((_, i) => i < 10).join("") + "/.local/share/standup/standup.db");\n`,
  [join(ROOT, "where.ts")]: "export const here = import.meta.dir;\n",
  [join(R, "where-import.ts")]: `import { Database } from "bun:sqlite";\nimport { here } from "${ROOT}/where.ts";\nnew Database(Array.from(here).filter((_, i) => i < 10).join("") + "/.local/share/standup/standup.db");\n`,
  // The live data dir spelled in full is the live DB's dir, whatever the env.
  [join(R, "live.ts")]: `import { writeFileSync } from "fs";\nwriteFileSync("${DATA}/notes.txt", "x");\n`,
  [join(R, "live-db.ts")]: `import { Database } from "bun:sqlite";\nnew Database("${DATA}/standup.db");\n`,
};
Object.assign(VIRTUAL, HARNESSES);
afterAll(() => {
  for (const f of Object.keys(HARNESSES)) delete VIRTUAL[f];
});

const COLLECTOR_ENV = `${ENV} ${TOKEN} TMUX_TMPDIR=${R}/tmux COLLECTOR_PORT=29777 WS_PORT=29778 ${OFF_NET}`;

describe("an isolated harness running the worktree's code by its path", () => {
  test("is judged by the scratch paths its env sets: allowed, or a hold that isn't high risk", () => {
    for (const command of [`${ENV} bun ${R}/db-path.ts`, `${ENV} bun ${R}/data-dir.ts`, `${COLLECTOR_ENV} bun run ${COLLECTOR}/src/index.ts`]) {
      const v = shape(bash(command));
      expect({ command, reserved: v.reserved ?? false }).toEqual({ command, reserved: false });
    }
    const start = `${COLLECTOR_ENV} bun run ${COLLECTOR}/src/index.ts`;
    expect({ command: start, verdict: shape(bash(start)) }).toEqual({ command: start, verdict: { action: "allow" } });
    // A module loaded by its worktree path may hand the code that path, so what it licenses holds for Persona to decide.
    for (const command of [`${ENV} bun ${R}/db-path.ts`, `${ENV} bun ${R}/data-dir.ts`]) {
      const v = shape(bash(command));
      expect({ command, action: v.action, category: v.category, reserved: v.reserved }).toEqual({ command, action: "hold", category: "unclassified", reserved: false });
    }
  }, 120_000);

  test("a loaded module that hands the code its path is still held", () => {
    for (const command of [`${ENV} bun ${R}/file-import.ts`, `${ENV} bun ${R}/where-import.ts`]) {
      expect({ command, action: bash(command).action }).toEqual({ command, action: "hold" });
    }
  }, 120_000);

  test("still holds as high risk without the isolation, or when the code climbs out of the worktree", () => {
    for (const command of [
      `bun ${R}/db-path.ts`,
      `HOME=${R}/home bun ${R}/data-dir.ts`,
      `${ENV} bun ${R}/climbs.ts`,
      `${ENV} bun ${R}/dotdot.ts`,
      `${ENV} bun ${R}/exec.ts`,
      `${ENV} bun ${R}/parse.ts`,
      `${ENV} bun ${R}/charcode.ts`,
      `${ENV} bun ${R}/tail.ts`,
      `DB_PATH=${R}/standup.db bun ${R}/dbpath-climb.ts`,
      `DB_PATH=${R}/standup.db bun ${R}/exec.ts`,
      `${ENV} bun ${R}/method.ts`,
      `${ENV} bun ${R}/tagged.ts`,
      `${ENV} bun ${R}/escaped.ts`,
      `${ENV} bun ${R}/decoy.ts`,
      `${ENV} bun ${R}/source.ts`,
      `${ENV} bun ${R}/template.ts`,
      `${ENV} bun ${R}/template-climb.ts`,
      `${ENV} bun ${R}/regex-tick.ts`,
    ]) {
      const v = shape(bash(command));
      expect({ command, action: v.action, category: v.category, reserved: v.reserved }).toEqual({ command, action: "hold", category: "floor-tamper", reserved: true });
    }
  }, 120_000);

  test("a write to or read of the live data dir is still held", () => {
    for (const command of [`${ENV} python3 ${R}/py.py`, `${ENV} bun ${R}/live.ts`,`${ENV} bun ${R}/live-db.ts`, `${ENV} sh -c 'echo x > ${DATA}/notes.txt'`, `echo x > ${DATA}/notes.txt`]) {
      expect({ command, action: bash(command).action }).toEqual({ command, action: "hold" });
    }
    const db = shape(bash(`${ENV} bun ${R}/live-db.ts`));
    expect(db).toMatchObject({ category: "floor-tamper", reserved: true });
  }, 120_000);
});

describe("ln -s with a relative target resolves it from the link's dir", () => {
  test("a link in a /tmp dir is allowed wherever the cwd is", () => {
    for (const [command, cwd] of [
      ["mkdir -p /tmp/snap/a/b/c && ln -s ../../../x /tmp/snap/a/b/c/link", ROOT],
      ["mkdir -p /tmp/snap/a && ln -s ../x /tmp/snap/a/link", ROOT],
      ["ln -s ../../../standup.db /tmp/snap/a/link", ROOT],
      ["mkdir -p /tmp/snap/a && ln -sf ../../../x /tmp/snap/a/", ROOT],
      ["mkdir -p /tmp/snap/a && ln -s -t /tmp/snap/a ../../../x", ROOT],
      ["ln -s ../../../x /tmp/snap/a/link", join(ROOT, "packages")],
    ] as const) {
      expect({ command, verdict: shape(bash(command, cwd)) }).toEqual({ command, verdict: { action: "allow" } });
    }
  }, 120_000);

  test("a link whose resolved target is a guarded path is still held", () => {
    for (const [command, cwd] of [
      // From /tmp, `../../..` is `/`, a dir above the data dir.
      ["ln -s ../../.. /tmp/link", ROOT],
      // In the worktree, three dirs up is the data dir.
      ["ln -s ../../../standup.db ./db-link", ROOT],
      ["ln -s ../../../secrets ./secrets-link", ROOT],
      [`ln -s ../standup.db ${DATA}/worktrees/link`, "/tmp"],
      // `-r` resolves the target from the cwd.
      ["ln -sr ../../../standup.db /tmp/snap/a/link", ROOT],
      // A hard link's target is resolved from the cwd.
      ["ln ../../../standup.db /tmp/snap/a/link", ROOT],
      // `-S xs` is a backup suffix, not `-s`: a hard link.
      ["ln -Sxs ../../../standup.db /tmp/snap/a/l && sqlite3 /tmp/snap/a/l .dump", ROOT],
      ["ln -bSs ../../../secrets/owner.token /tmp/snap/a/tok && cat /tmp/snap/a/tok", ROOT],
      // An abbreviated `--relative` is `--relative`.
      ["ln -s --rel ../../../standup.db /tmp/snap/a/l && sqlite3 /tmp/snap/a/l .dump", ROOT],
      ["ln --symbolic --relat ../../../secrets/owner.token /tmp/snap/a/tok", ROOT],
      // `-n`/`-T` replace the dest link itself, in the cwd.
      ["ln -sfn ../../../standup.db /tmp/snap/a", ROOT],
      ["ln -sfT ../../../secrets/owner.token /tmp/snap/a", ROOT],
      // A `~` dest, and a dir above the dest turned into a link earlier in the command.
      ["ln -s .local/share/standup/standup.db ~/l", "/fake/home"],
      ["ln -s . x && mv x d && ln -s standup/standup.db d/l", "/fake/home/.local/share"],
      // A link made in /tmp and then moved or copied resolves its target from where it lands.
      [`ln -s ../../../../standup.db /tmp/snap/l && mv /tmp/snap/l ${ROOT}/packages/l && sqlite3 ${ROOT}/packages/l .dump`, join(ROOT, "packages")],
      ["ln -s ../../../../secrets/owner.token /tmp/snap/l && mv /tmp/snap/l ./l && cat ./l", join(ROOT, "packages")],
      ["ln -s ../../../../secrets/owner.token /tmp/snap/l && cp -P /tmp/snap/l ./l && cat ./l", join(ROOT, "packages")],
      // A dir made earlier in the command takes the link inside it.
      [`mkdir ${ROOT}/n && ln -s ../../../../standup.db ${ROOT}/n && sqlite3 ${ROOT}/n/standup.db .dump`, join(ROOT, "packages")],
      [`mkdir ${ROOT}/n && ln -s ../../../../secrets ${ROOT}/n && cat ${ROOT}/n/secrets/owner.token`, join(ROOT, "packages")],
    ] as const) {
      expect({ command, action: bash(command, cwd).action }).toEqual({ command, action: "hold" });
    }
  }, 120_000);
});
