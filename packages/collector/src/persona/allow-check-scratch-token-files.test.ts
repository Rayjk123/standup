import { describe, expect, test } from "bun:test";
import { join } from "path";
import { FLOOR_OWNER_GATE } from "../floor/gate.js";
import { ruleCheck, scratchRunShape, secretMismatch, type AllowCheckInput } from "./allow-check.js";

/*
 * A scratch collector started under `env -i` with every path it sets below
 * one fresh /tmp/ root `$R` points its owner and write token files there too:
 * those are its own tokens, not the owner's. Token files anywhere else, a root
 * that isn't fresh, a run without `env -i` or its root vars, and any read of a
 * token file stay secret moves. Data-dir paths are built at run time so this
 * file carries no literal Standup path.
 */

const HOME = join("/", "home", "alice");
const REAL_OWNER_TOKEN = join(HOME, ".local", "share", "standup", "secrets", "owner.token");

const FLOOR_REASON =
  "starts a Standup collector (/srv/ws/wt/packages/collector/src/index.ts) without STANDUP_BIND_HOST=127.0.0.1, STANDUP_GATEWAY=0: it may bind past loopback";

function hold(call: string): AllowCheckInput {
  return {
    owner: "alice",
    selfAliases: ["alice"],
    gate: FLOOR_OWNER_GATE,
    category: "floor-tamper",
    floorReason: FLOOR_REASON,
    toolName: "Bash",
    call,
    personaReason: "the brief starts a scratch collector",
    job: { title: "floor route", goal: "fix the floor route" },
    brief: "Start a scratch collector under /tmp to test the floor route against it.",
    ownerMessages: ["fix the floor route"],
    preferences: [],
    worktreeRoot: "/srv/ws/wt",
  };
}

const MKTEMP = "R=$(mktemp -d -p /tmp sc-XXXXXX)";

/** The scratch env, with every path under `r` and the token files given by `tokens`. */
function env(r = "$R", tokens = `STANDUP_WRITE_TOKEN_FILE=${r}/write-token STANDUP_OWNER_TOKEN_FILE=${r}/owner-token`): string {
  return (
    `env -i PATH=$PATH HOME=${r}/home XDG_CONFIG_HOME=${r}/xdg/config XDG_DATA_HOME=${r}/xdg/data TMPDIR=${r}/tmp ` +
    `DB_PATH=${r}/standup.db KNOWLEDGE_DIR=${r}/kb STANDUP_INTERNAL_ROOT=${r}/internal ${tokens} PORT=29777`
  );
}

const RUN = "bun packages/collector/src/index.ts > $TMPDIR/c.log 2>&1 &";

/** Steps that set R past its fresh-root assignment, each pointing it at the real data dir. */
const SHARE = join(HOME, ".local", "share", "standup");
const REBINDS: ReadonlyArray<readonly [string, string]> = [
  ["printf -v", `printf -v R %s "${SHARE}"`],
  ["printf -vR", `printf -vR %s "${SHARE}"`],
  ["an append", "R+=/../../home/alice/.local/share/standup"],
  ["an element", `R[0]=${SHARE}`],
  ["select", `select R in ${SHARE}; do break; done <<< 1`],
  ["declare", `declare R=${SHARE}`],
  ["typeset", `typeset R=${SHARE}`],
  ["a nameref to it", `declare -n ref=R; ref=${SHARE}`],
  ["a bare nameref", `local -n ref; ref=R; ref=${SHARE}`],
  ["mapfile", "mapfile -t R < x"],
  ["readarray", "readarray R < x"],
  ["getopts", "getopts ab R"],
  ["vared", "vared R"],
  ["a file descriptor", "exec {R}>x"],
  ["readonly", `readonly R=${SHARE}`],
  ["zsh print -v", `print -v R ${SHARE}`],
  ["zsh ${R::=…}", `: \${R::=${SHARE}}`],
  ["${R:=…}", `: \${R:=${SHARE}}`],
  ["${R/…/…}", `echo \${R/tmp/home}`],
  ["a bare word", "echo R"],
];

/** Steps that link, mount, copy or move another dir into R, or reach it past `$R/<plain tail>`. */
const SPOILERS: ReadonlyArray<readonly [string, string]> = [
  ["ln -s", "ln -s ~ $R/h"],
  ["ln to the data dir", `ln -s ${SHARE} $R/d`],
  ["cp -a", `cp -a ${SHARE} $R/d`],
  ["cp -s", `cp -s ${SHARE}/standup.db $R/standup.db`],
  ["mv", `mv ${SHARE} $R/d`],
  ["mount --bind", `mount --bind ${SHARE} $R/d`],
  ["bindfs", `bindfs ${SHARE} $R/d`],
  ["tar -x", "tar -xf x.tar -C $R"],
  ["unzip", "unzip x.zip -d $R"],
  ["rsync", `rsync -a ${SHARE}/ $R/d/`],
  ["cd into it", "cd $R && ln -s ~ h"],
  ["a substitution", "echo $(ln -s ~ $R/h)"],
  ["a backtick", "echo `ln -s ~ $R/h`"],
  ["a pipe into a shell", "echo ln -s ~ $R/h | sh"],
  ["a pipe out of a step naming it", "cat $R/x | tee y"],
  ["a glob under /tmp", "printf x > /tmp/sc-*/h"],
  ["/tmp itself", "ls /tmp"],
  ["sudo", "sudo touch $R/x"],
  ["a bare $R", "touch $R"],
  ["cd into it", "cd $R"],
  ["pushd into it", "pushd $R"],
  ["cd to /tmp", "cd /tmp"],
  ["cd to a dir under /tmp", "cd /tmp/sc-1"],
  ["cd to a relative dir", "cd tmp"],
  ["cd to a variable", "cd $D"],
  ["cd to a substitution", "cd $(pwd)"],
  ["cd home", "cd ~"],
  ["cd with no operand", "cd"],
  ["cd through ..", "cd /srv/ws/wt/../.."],
  ["awk", `awk 'BEGIN { system("ln -s ~ /tmp/x") }'`],
  ["sed", "sed -n 1p $R/x"],
  ["bun -e", `bun -e "require('fs').symlinkSync('/', process.argv.at(-1))" $R/h`],
  ["node -e", `node -e "require('fs').symlinkSync('/', process.argv.at(-1))" $R/h`],
  ["a bun run outside env -i", "bun scripts/link.ts $R/h"],
  ["a second env -i start", "env -i PATH=$PATH HOME=$R/home bun scripts/link.ts $R/h"],
  ["an env -i start with inline code", `env -i PATH=$PATH bun -e "1" $R/h`],
  ["a redirect into a script", "echo x > $R/l.sh"],
  ["a redirect into a module", "printf x >> $R/l.mjs"],
  ["curl -o", "curl -s -o $R/x http://127.0.0.1:29777/"],
  ["curl -sO", "curl -sO http://127.0.0.1:29777/x"],
  ["curl --output", "curl --output $R/x http://127.0.0.1:29777/"],
  ["curl -K", "curl -K $R/cfg http://127.0.0.1:29777/"],
  ["curl past the loopback", "curl -s http://example.com/x"],
  ["a bare :", ": $R/x"],
  ["a >& redirect into a script", "echo x >& $R/l.sh"],
  ["a &> redirect into a script", "echo x &> $R/l.sh"],
  ["a &>> redirect into a script", "echo x &>> $R/l.sh"],
  ["a >| redirect into a script", "echo x >| $R/l.sh"],
];

/** JS that links the run's own owner-token file to the real one, the real path encoded so no literal names it. */
const LINK =
  "require('fs').symlinkSync(Buffer.from('L2hvbWUvYWxpY2UvLmxvY2FsL3NoYXJlL3N0YW5kdXAvc2VjcmV0cy9vd25lci50b2tlbg==', 'base64').toString(), process.env.STANDUP_OWNER_TOKEN_FILE)";
/** The same link as a data: URL module with no `;` (a `;` would split the step). */
const LINK_URL = `data:text/javascript,import('fs').then((fs) => fs.symlinkSync(atob('L2hvbWUvYWxpY2UvLmxvY2FsL3NoYXJlL3N0YW5kdXAvc2VjcmV0cy9vd25lci50b2tlbg=='), process.env.STANDUP_OWNER_TOKEN_FILE))`;

/** Starts (after the env) that run code other than their one file. */
const START_CODE: ReadonlyArray<readonly [string, string]> = [
  ["node -pe", `node -pe "${LINK}"`],
  ["node -r", "node -r ./l.txt packages/collector/src/index.ts > $TMPDIR/c.log 2>&1 &"],
  ["bun --preload", "bun --preload ./l packages/collector/src/index.ts > $TMPDIR/c.log 2>&1 &"],
  ["node --import of a data: URL", `node --import="${LINK_URL}" packages/collector/src/index.ts > $TMPDIR/c.log 2>&1 &`],
  ["node - reading a here-string", `node - <<< "${LINK}"`],
  ["an input redirect", "node packages/collector/src/index.ts < x"],
  ["bun exec", "bun exec 'ln -sf /x $STANDUP_OWNER_TOKEN_FILE'"],
  ["bun x", "bun x some-linker-pkg"],
  ["bun run", "bun run link-tokens"],
  ["bun test", "bun test packages/collector/src/index.ts"],
  ["an absolute file", "bun /tmp/x.ts"],
  ["a file through ..", "bun ../x.ts"],
  ["a file that is no module", "bun packages/collector/src/index.txt"],
  ["a word after the file", "bun packages/collector/src/index.ts --preload ./l"],
  ["NODE_OPTIONS", "NODE_OPTIONS=--require=./l.txt node packages/collector/src/index.ts > $TMPDIR/c.log 2>&1 &"],
  ["BUN_OPTIONS", "BUN_OPTIONS=--preload=./l bun packages/collector/src/index.ts > $TMPDIR/c.log 2>&1 &"],
  ["NODE_PATH", "NODE_PATH=./x node packages/collector/src/index.ts > $TMPDIR/c.log 2>&1 &"],
  ["BUN_INSTALL", "BUN_INSTALL=./x bun packages/collector/src/index.ts > $TMPDIR/c.log 2>&1 &"],
  ["LD_PRELOAD", "LD_PRELOAD=./x.so bun packages/collector/src/index.ts > $TMPDIR/c.log 2>&1 &"],
];

/** The worktree the holds run in. */
const WORKTREE = "/srv/ws/wt";
const REPRESENTATIVE = `${MKTEMP} && ${env()} ${RUN}`;

const reason = (call: string) => ({ call, reason: ruleCheck(hold(call)).reason });
const noSecret = (call: string) => ({ call, reason: expect.not.stringContaining("secrets") });
const ownerSecret = (call: string) => ({ call, reason: expect.stringContaining("Standup's owner secrets") });

describe("allow check — a scratch collector's own token files under its fresh /tmp root", () => {
  test("the representative start is no secret move", () => {
    expect(reason(REPRESENTATIVE)).toEqual(noSecret(REPRESENTATIVE));
  });

  test.each([
    ["a /tmp template", `R=$(mktemp -d /tmp/sc-XXXXXX) && ${env()} ${RUN}`],
    ["--tmpdir=/tmp", `R=$(mktemp -d --tmpdir=/tmp sc-XXXXXX) && ${env()} ${RUN}`],
    ["-p before -d", `R=$(mktemp -p /tmp -d sc-XXXXXX) && ${env()} ${RUN}`],
    ["a quoted substitution", `R="$(mktemp -d -p /tmp sc-XXXXXX)" && ${env()} ${RUN}`],
    ["a cd to the worktree first", `cd ${WORKTREE} && ${MKTEMP} && ${env()} ${RUN}`],
    ["a cd to the worktree after the root", `${MKTEMP} && cd ${WORKTREE} && ${env()} ${RUN}`],
    ["a pushd to the worktree after the root", `${MKTEMP} && pushd ${WORKTREE}/ && ${env()} ${RUN}`],
    ["a cd to a relative dir before the root", `cd packages && ${MKTEMP} && ${env()} ${RUN}`],
    ["a mkdir joined by &&", `${MKTEMP} && mkdir -p $R/home && ${env()} ${RUN}`],
    ["${R}", `${MKTEMP} && ${env("${R}")} ${RUN}`],
    ["quoted values", `${MKTEMP} && ${env("$R", 'STANDUP_WRITE_TOKEN_FILE="$R/write-token" STANDUP_OWNER_TOKEN_FILE="$R/owner-token"')} ${RUN}`],
    ["nohup", `${MKTEMP} && nohup ${env()} ${RUN}`],
    ["a token in a subdir", `${MKTEMP} && ${env("$R", "STANDUP_OWNER_TOKEN_FILE=$R/secrets/owner.token")} ${RUN}`],
    ["a token two plain dirs down", `${MKTEMP} && ${env("$R", "STANDUP_OWNER_TOKEN_FILE=$R/a/b/owner-token")} ${RUN}`],
    // A literal /tmp/<name> reads as a literal /tmp/ path does: the floor resolves a link there and names what it reaches.
    ["a literal /tmp/<name> root", `R=/tmp/sc-1 && ${env()} ${RUN}`],
    ["a literal /tmp/<name> root after a cd to the worktree", `cd ${WORKTREE} && R=/tmp/sc-1 && ${env()} ${RUN}`],
  ])("with %s, is no secret move", (_label, call) => {
    expect(reason(call)).toEqual(noSecret(call));
  });

  test.each([
    ["the real data dir's owner token", `${MKTEMP} && ${env("$R", `STANDUP_OWNER_TOKEN_FILE=${REAL_OWNER_TOKEN}`)} ${RUN}`],
    ["~/.local/share/standup/secrets", `${MKTEMP} && ${env("$R", "STANDUP_OWNER_TOKEN_FILE=~/.local/share/standup/secrets/owner.token")} ${RUN}`],
    ["$HOME/.standup/owner-token", `${MKTEMP} && ${env("$R", "STANDUP_OWNER_TOKEN_FILE=$HOME/.standup/owner-token")} ${RUN}`],
    ["~/.standup/owner-token", `${MKTEMP} && ${env("$R", "STANDUP_OWNER_TOKEN_FILE=~/.standup/owner-token")} ${RUN}`],
    ["another root's token", `${MKTEMP} && Q=$(mktemp -d -p /tmp q-XXXXXX) && ${env("$R", "STANDUP_OWNER_TOKEN_FILE=$Q/owner-token")} ${RUN}`],
    ["an unset root's token", `${MKTEMP} && ${env("$R", "STANDUP_OWNER_TOKEN_FILE=$Q/owner-token")} ${RUN}`],
    ["a token that climbs out of the root", `${MKTEMP} && ${env("$R", "STANDUP_OWNER_TOKEN_FILE=$R/../owner-token")} ${RUN}`],
    ["R=/tmp itself", `R=/tmp && ${env()} ${RUN}`],
    ["mktemp under TMPDIR", `R=$(mktemp -d) && ${env()} ${RUN}`],
    ["mktemp -t", `R=$(mktemp -d -t sc-XXXXXX) && ${env()} ${RUN}`],
    ["mktemp -p elsewhere", `R=$(mktemp -d -p ${HOME} sc-XXXXXX) && ${env()} ${RUN}`],
    ["a file, not a dir", `R=$(mktemp -p /tmp sc-XXXXXX) && ${env()} ${RUN}`],
    ["a root set after the start", `${env()} ${RUN} ${MKTEMP}; true`],
    // A failed mktemp leaves R empty: a step a `;`, newline or `||` joins still runs, at `/<tail>`.
    ["a ; join", `${MKTEMP}; mkdir -p $R/home; ${env()} ${RUN}`],
    ["a ; join after an && one", `${MKTEMP} && mkdir -p $R/home; ${env()} ${RUN}`],
    ["a newline join", `${MKTEMP}\n${env()} ${RUN}`],
    ["a bare --tmpdir (mktemp fails)", `R=$(mktemp -d --tmpdir /tmp sc-XXXXXX) && ${env()} ${RUN}`],
    ["a home tail", `${MKTEMP} && ${env().replace("HOME=$R/home", `HOME=$R${HOME}`)} ${RUN}`],
    ["a data-dir tail", `${MKTEMP} && ${env().replace("DB_PATH=$R/standup.db", `DB_PATH=$R${SHARE}/standup.db`)} ${RUN}`],
    ["a /local/home tail", `${MKTEMP} && ${env().replace("HOME=$R/home", "HOME=$R/local/home/alice")} ${RUN}`],
    ["a /Users tail", `${MKTEMP} && ${env().replace("HOME=$R/home", "HOME=$R/Users/alice")} ${RUN}`],
    ["a /root tail", `${MKTEMP} && ${env().replace("HOME=$R/home", "HOME=$R/root")} ${RUN}`],
    ...START_CODE.map(([label, start]) => [`a start with ${label}`, `${MKTEMP} && ${env()} ${start}`] as const),
    ["a root set twice", `${MKTEMP} && R=${HOME} && ${env()} ${RUN}`],
    ["a root read over", `${MKTEMP} && read R < x && ${env()} ${RUN}`],
    ...REBINDS.map(([label, step]) => [`a root rebound by ${label}`, `${MKTEMP} && ${step} && ${env()} ${RUN}`] as const),
    ...SPOILERS.map(([label, step]) => [`a root spoiled by ${label}`, `${MKTEMP} && ${step} && ${env()} ${RUN}`] as const),
    ["a root set by || ",`${MKTEMP} || ${env()} ${RUN}`],
    ["HOME elsewhere", `${MKTEMP} && ${env().replace("HOME=$R/home", `HOME=${HOME}`)} ${RUN}`],
    ["no HOME", `${MKTEMP} && ${env().replace("HOME=$R/home ", "")} ${RUN}`],
    ["no DB_PATH", `${MKTEMP} && ${env().replace("DB_PATH=$R/standup.db ", "")} ${RUN}`],
    ["a path under another root", `${MKTEMP} && ${env().replace("KNOWLEDGE_DIR=$R/kb", "KNOWLEDGE_DIR=/tmp/other/kb")} ${RUN}`],
    ["no env -i", `${MKTEMP} && ${env().replace("env -i ", "")} ${RUN}`],
    ["env without -i", `${MKTEMP} && ${env().replace("env -i ", "env ")} ${RUN}`],
  ])("with %s, is still a secret move", (_label, call) => {
    expect(reason(call)).toEqual(ownerSecret(call));
  });

  test.each([
    ["cat", `${REPRESENTATIVE} sleep 2; cat $R/owner-token`],
    ["curl with it", `${REPRESENTATIVE} sleep 2; curl -H "x-standup-owner-token: $(cat $R/owner-token)" http://127.0.0.1:29777/api/x`],
    ["the env's own program", `${MKTEMP} && ${env()} cat $STANDUP_OWNER_TOKEN_FILE`],
    ["the real token", `${REPRESENTATIVE} cat ${REAL_OWNER_TOKEN}`],
  ])("a read of a token beside the start (%s) is still a secret move", (_label, call) => {
    expect(reason(call)).toEqual({ call, reason: expect.stringContaining("reads or moves secrets") });
  });

  test("an owner-token file under a root rebound by printf -v is still a secret move", () => {
    const call = `${MKTEMP} && printf -v R %s "$HOME/.local/share" && ${env("$R", "STANDUP_OWNER_TOKEN_FILE=$R/standup/secrets/owner.token")} ${RUN}`;
    expect(reason(call)).toEqual(ownerSecret(call));
  });

  test.each([
    ["zsh print -v", `print -v R ${SHARE}`],
    ["zsh ${R::=…}", `: \${R::=${SHARE}}`],
  ])("a root rebound by %s (the Bash tool runs zsh here) still names the owner token", (_label, step) => {
    const verdict = ruleCheck(hold(`${MKTEMP} && ${step} && ${env()} ${RUN}`));
    expect(verdict.verdict).toBe("flag");
    expect(verdict.reason ?? "").toContain("secrets");
  });

  test("a symlink to the real home under the fresh root still reaches the owner's token", () => {
    const call = `${MKTEMP} && ln -s ~ $R/h && ${env("$R", "STANDUP_OWNER_TOKEN_FILE=$R/h/.local/share/standup/secrets/owner.token")} ${RUN}`;
    const verdict = ruleCheck(hold(call));
    expect(verdict.verdict).toBe("flag");
    expect(verdict.reason ?? "").toContain("secrets");
  });

  test.each([
    ["the data dir's layout", "STANDUP_OWNER_TOKEN_FILE=$R/h/.local/share/standup/secrets/owner.token"],
    ["a dot dir one level down", "STANDUP_OWNER_TOKEN_FILE=$R/.standup/owner-token"],
    ["a dot dir two levels down", "STANDUP_OWNER_TOKEN_FILE=$R/a/.standup/owner-token"],
  ])("a token file under a dot dir in the root (%s) is still a secret move", (_label, tokens) => {
    const call = `${MKTEMP} && ${env("$R", tokens)} ${RUN}`;
    expect(reason(call)).toEqual(ownerSecret(call));
  });

  test("the floor's wording for owner-side secrets still flags the scratch start", () => {
    const v = ruleCheck({ ...hold(REPRESENTATIVE), floorReason: "starts a collector; code in src/x.ts uses the owner token helpers, which read owner-side secrets" });
    expect(v.reason).toContain("reads or moves secrets");
  });
});

/** A scratch start whose log goes under its own root, as scratchRunShape reads one. */
const LOGGED = "bun packages/collector/src/index.ts > $R/c.log 2>&1 &";
const shape = (call: string) => ({ call, shape: scratchRunShape("Bash", "floor-tamper", call, "/srv/ws/wt") });

describe("allow check — a scratch run rooted at a fresh /tmp root variable", () => {
  test.each([
    ["mktemp -p /tmp", `${MKTEMP} && ${env()} ${LOGGED}`],
    ["a /tmp template", `R=$(mktemp -d /tmp/sc-XXXXXX) && ${env()} ${LOGGED}`],
    ["a literal /tmp/<name> root", `R=/tmp/sc-1 && ${env()} ${LOGGED}`],
    ["${R}", `${MKTEMP} && ${env("${R}")} ${LOGGED.replace("$R", "${R}")}`],
    ["quoted values", `${MKTEMP} && ${env().replace("HOME=$R/home", 'HOME="$R/home"')} ${LOGGED}`],
    ["a mkdir first", `${MKTEMP} && mkdir -p $R/home $R/tmux && ${env()} ${LOGGED}`],
    ["a health check after", `${MKTEMP} && ${env()} ${LOGGED} sleep 2; curl -s http://127.0.0.1:29777/api/health; tail -n 20 $R/c.log`],
    ["a stop after", `${MKTEMP} && ${env()} ${LOGGED} echo $! > $R/pid; sleep 2; kill $(cat $R/pid)`],
    ["a cd to the worktree first", `cd ${WORKTREE} && ${MKTEMP} && ${env()} ${LOGGED}`],
    ["a cd to the worktree after the root", `${MKTEMP} && cd ${WORKTREE} && ${env()} ${LOGGED}`],
  ])("with %s, has a scratch run's shape", (_label, call) => {
    expect(shape(call)).toEqual({ call, shape: true });
  });

  test.each([
    ["mktemp under TMPDIR", `R=$(mktemp -d) && ${env()} ${LOGGED}`],
    ["R=/tmp itself", `R=/tmp && ${env()} ${LOGGED}`],
    ["a root set twice", `${MKTEMP} && R=${HOME} && ${env()} ${LOGGED}`],
    ["a root read over", `${MKTEMP} && read R < x && ${env()} ${LOGGED}`],
    ...REBINDS.map(([label, step]) => [`a root rebound by ${label}`, `${MKTEMP} && ${step} && ${env()} ${LOGGED}`] as const),
    ...SPOILERS.map(([label, step]) => [`a root spoiled by ${label}`, `${MKTEMP} && ${step} && ${env()} ${LOGGED}`] as const),
    ["a link to the data dir taken as DB_PATH", `${MKTEMP} && ln -s ${SHARE} $R/d && ${env().replace("DB_PATH=$R/standup.db", "DB_PATH=$R/d/standup.db")} ${LOGGED}`],
    ["a literal root named past its step", `R=/tmp/sc-1 && touch /tmp/sc-1/x && ${env()} ${LOGGED}`],
    ["a piped root", `${MKTEMP} | ${env()} ${LOGGED}`],
    ["a root set after its use", `${env()} ${LOGGED} ${MKTEMP}; true`],
    ["a mkdir joined by ;", `${MKTEMP}; mkdir -p $R/home; ${env()} ${LOGGED}`],
    ["a bare --tmpdir (mktemp fails)", `R=$(mktemp -d --tmpdir /tmp sc-XXXXXX) && ${env()} ${LOGGED}`],
    ["a home tail", `${MKTEMP} && ${env().replace("HOME=$R/home", `HOME=$R${HOME}`)} ${LOGGED}`],
    ...START_CODE.map(([label, start]) => [`a start with ${label}`, `${MKTEMP} && ${env()} ${start}`] as const),
    ["a single-quoted root", `${MKTEMP} && ${env().replace("HOME=$R/home", "HOME='$R/home'")} ${LOGGED}`],
    ["HOME elsewhere", `${MKTEMP} && ${env().replace("HOME=$R/home", `HOME=${HOME}`)} ${LOGGED}`],
    ["a root climbed out of", `${MKTEMP} && ${env().replace("HOME=$R/home", "HOME=$R/../home")} ${LOGGED}`],
    ["another unset variable", `${MKTEMP} && ${env().replace("KNOWLEDGE_DIR=$R/kb", "KNOWLEDGE_DIR=$Q/kb")} ${LOGGED}`],
    ["a log under the worker's TMPDIR", REPRESENTATIVE],
    ["a read of the real write token", `${MKTEMP} && ${env()} ${LOGGED} cat ~/.standup/write-token`],
  ])("with %s, has no scratch run's shape", (_label, call) => {
    expect(shape(call)).toEqual({ call, shape: false });
  });

  test("a $R-rooted scratch start the brief asks for is allowed like a literal /tmp one", () => {
    const rooted = `${MKTEMP} && ${env()} ${LOGGED}`;
    const literal = `${env("/tmp/sc-1")} ${LOGGED.replace("$R", "/tmp/sc-1")}`;
    expect(ruleCheck(hold(literal))).toEqual({ verdict: "allow", reason: expect.any(String) });
    expect(ruleCheck(hold(rooted))).toEqual({ verdict: "allow", reason: expect.any(String) });
    // A floor reason naming more than its isolation unplaces it, as it does a literal one.
    const more = { ...hold(rooted), floorReason: `Ends sessions outside this worker: \`kill-session\`. ${FLOOR_REASON}` };
    expect(ruleCheck(more).verdict).toBe("flag");
  });

  test("the start run from the worktree (`cd <worktree> && R=$(mktemp …) && env -i …`) has no secrets flag and is allowed as a scratch run", () => {
    const call = `cd ${WORKTREE} && ${MKTEMP} && ${env()} ${LOGGED}`;
    expect(shape(call)).toEqual({ call, shape: true });
    expect(ruleCheck(hold(call))).toEqual({ verdict: "allow", reason: expect.any(String) });
    // Its log under the worker's TMPDIR leaves the shape, but still moves no secret.
    const logged = `cd ${WORKTREE} && ${REPRESENTATIVE}`;
    expect(reason(logged)).toEqual(noSecret(logged));
  });
});

describe("allow check — a fresh root beside code that may link it", () => {
  const linkedEnv =
    "env -i PATH=$PATH HOME=$R/home TMPDIR=$R/tmp DB_PATH=$R/standup.db KNOWLEDGE_DIR=$R/kb STANDUP_INTERNAL_ROOT=$R/internal " +
    "STANDUP_WRITE_TOKEN_FILE=$R/h/write-token STANDUP_OWNER_TOKEN_FILE=$R/h/owner-token PORT=29777";
  const LINK_JS = "require('fs').symlinkSync(require('os').homedir()+'/.loc'+'al/share/stand'+'up/sec'+'rets', process.argv.at(-1))";

  test.each([
    ["bun -e", `${MKTEMP} && mkdir -p $R/home && bun -e "${LINK_JS}" $R/h && ${linkedEnv} ${RUN}`],
    ["node -e", `${MKTEMP} && mkdir -p $R/home && node -e "${LINK_JS}" $R/h && ${linkedEnv} ${RUN}`],
    ["a script cat writes into the root, then bun runs", `${MKTEMP} && cat > $R/l.mjs <<'EOF'\n${LINK_JS.replace("process.argv.at(-1)", "process.argv[2]")}\nEOF\nbun $R/l.mjs $R/h && ${linkedEnv} ${RUN}`],
    ["awk's system()", `${MKTEMP} && awk 'BEGIN { system("ln -s ~/.local/share/standup/secrets " ARGV[1]) }' $R/h && ${linkedEnv} ${RUN}`],
    ["a heredoc body run by the start", `${MKTEMP} && cat > $R/l.txt <<'EOF'\n${LINK_JS}\nEOF\n${linkedEnv} ${RUN}`],
  ])("a root that %s may link into the real data dir still names the token files as secrets", (_label, call) => {
    expect(secretMismatch(hold(call))).not.toBeNull();
    expect(ruleCheck(hold(call)).reason ?? "").toContain("secrets");
  });

  /** The owner's start: from the worktree, its dirs made, the run, a health check and log read, then a stop by its pid file. */
  const ownerStart = (log: string) =>
    `cd ${WORKTREE} && ${MKTEMP} && mkdir -p $R/home $R/tmp && ${env()} bun packages/collector/src/index.ts > ${log} 2>&1 & echo $! > $R/pid; ` +
    `sleep 2; curl -s http://127.0.0.1:29777/api/health; tail -n 20 ${log}; kill $(cat $R/pid)`;

  test("the owner's whole start, check and stop moves no secret", () => {
    const call = ownerStart("$TMPDIR/c.log");
    expect(reason(call)).toEqual(noSecret(call));
  });

  test("the owner's whole start, check and stop, logging under its root, has a scratch run's shape and is allowed", () => {
    const call = ownerStart("$R/c.log");
    expect(shape(call)).toEqual({ call, shape: true });
    expect(ruleCheck(hold(call))).toEqual({ verdict: "allow", reason: expect.any(String) });
  });
});

describe("allow check — what a fresh root's start may run", () => {
  test.each([
    ["a plain node start", `${MKTEMP} && ${env()} node packages/collector/src/index.ts > $TMPDIR/c.log 2>&1 &`],
    ["a printf into a .txt before a plain bun start", `${MKTEMP} && printf '%s' "x" > l.txt && ${env()} ${RUN}`],
    ["a bun start with --smol", `${MKTEMP} && ${env()} bun --smol packages/collector/src/index.ts > $TMPDIR/c.log 2>&1 &`],
    ["a bun start with --no-env-file", `${MKTEMP} && ${env()} bun --no-env-file packages/collector/src/index.ts > $TMPDIR/c.log 2>&1 &`],
    ["a ./ file", `${MKTEMP} && ${env()} bun ./packages/collector/src/index.ts > $TMPDIR/c.log 2>&1 &`],
    ["an .mjs file", `${MKTEMP} && ${env()} node scripts/start.mjs > $TMPDIR/c.log 2>&1 &`],
  ])("%s is no secret move", (_label, call) => {
    expect(reason(call)).toEqual(noSecret(call));
  });

  test.each([
    ["node -pe (combined -p and -e)", `${MKTEMP} && ${env()} node -pe "${LINK}"`],
    ["node -r of a printf-written .txt (CJS loads any extension as JS)", `${MKTEMP} && printf '%s' "${LINK}" > l.txt && ${env()} node -r ./l.txt packages/collector/src/index.ts > $TMPDIR/c.log 2>&1 &`],
    ["bun --preload of a printf-written file", `${MKTEMP} && printf '%s' "${LINK}" > l && ${env()} bun --preload ./l packages/collector/src/index.ts > $TMPDIR/c.log 2>&1 &`],
    ["node --import of a data: URL", `${MKTEMP} && ${env()} node --import="${LINK_URL}" packages/collector/src/index.ts > $TMPDIR/c.log 2>&1 &`],
    ["node - reading a here-string", `${MKTEMP} && ${env()} node - <<< "${LINK}"`],
    ["bun exec running a shell string", `${MKTEMP} && ${env()} bun exec 'ln -sf /home/alice/.lo*/sh*/st*/se*/ow* $STANDUP_OWNER_TOKEN_FILE'`],
    ["bun x running a package's bin", `${MKTEMP} && ${env()} bun x some-linker-pkg`],
    ["bun run of a package.json script", `${MKTEMP} && ${env()} bun run link-tokens`],
  ])("an env -i start with %s is not trusted as a fresh root", (_label, call) => {
    expect(reason(call)).toEqual(ownerSecret(call));
  });

  test("a `>&` redirect into a script spoils the root like `>` does", () => {
    const call = `${MKTEMP} && echo x >& $R/l.sh && ${env()} ${RUN}`;
    expect(reason(call)).toEqual(ownerSecret(call));
  });

  test.each([
    ["a schemeless outside host", "curl -s example.com/x"],
    ["--resolve to an outside address", "curl -s --resolve localhost:29777:93.184.216.34 http://localhost:29777/x"],
    ["--proxy without a scheme", "curl -s --proxy evil.example:8080 http://127.0.0.1:29777/x"],
    ["--connect-to", "curl -s --connect-to 127.0.0.1:29777:evil.example:443 http://127.0.0.1:29777/x"],
  ])("a curl past the loopback (%s) leaves no scratch run's shape", (_label, step) => {
    const call = `${MKTEMP} && ${env()} ${LOGGED} sleep 2; ${step}`;
    expect(shape(call)).toEqual({ call, shape: false });
  });
});

describe("allow check — a scratch root whose mktemp fails leaves $R empty", () => {
  // GNU mktemp takes --tmpdir's DIR only after `=`: `--tmpdir /tmp t.XXXXXX` is two templates and fails,
  // so R is empty, and the `;` join runs the start anyway with every `$R/<tail>` at `/<tail>`.
  const ENV =
    `env -i PATH=$PATH HOME=$R${HOME} TMPDIR=$R/tmp DB_PATH=$R${SHARE}/standup.db KNOWLEDGE_DIR=$R${SHARE}/knowledge ` +
    `STANDUP_INTERNAL_ROOT=$R${SHARE}/internal PORT=29777`;
  const START = "bun packages/collector/src/index.ts > $R/c.log 2>&1 &";

  test("a failing `mktemp -d --tmpdir /tmp …` joined by `;` is no scratch run", () => {
    const call = `R=$(mktemp -d --tmpdir /tmp sc-XXXXXX); ${ENV} ${START}`;
    expect(ruleCheck(hold(call)).verdict).toBe("flag");
  });

  test("the same start with `-p /tmp` joined by `;` is no scratch run either (mktemp may fail: /tmp full, ENOSPC)", () => {
    const call = `R=$(mktemp -d -p /tmp sc-XXXXXX); ${ENV} ${START}`;
    expect(ruleCheck(hold(call)).verdict).toBe("flag");
  });

  test("steps after the start may be joined by `;`: the start's own chain is what reads the root", () => {
    const call = `${MKTEMP} && ${env()} ${LOGGED} echo $! > $R/pid; sleep 2; kill $(cat $R/pid)`;
    expect(shape(call)).toEqual({ call, shape: true });
  });
});

describe("allow check — the collector's write token", () => {
  const REAL_WRITE_TOKEN = join(HOME, ".standup", "write-token");

  test.each([
    ["cat ~/.standup/write-token", "cat ~/.standup/write-token"],
    ["cat $HOME/.standup/write-token", "cat $HOME/.standup/write-token"],
    ["a copy of the home's token", `cp ${REAL_WRITE_TOKEN} /tmp/x`],
    ["a ./ segment", "cat ~/.standup/./write-token"],
    ["a token through /tmp/..", `cat /tmp/..${REAL_WRITE_TOKEN}`],
    ["the env var at the home's token", "STANDUP_WRITE_TOKEN_FILE=$HOME/.standup/write-token bun run src/index.ts"],
    ["a scratch env at the home's token", `${MKTEMP} && ${env("$R", "STANDUP_WRITE_TOKEN_FILE=$HOME/.standup/write-token")} ${RUN}`],
    ["a scratch env at ~'s token", `${MKTEMP} && ${env("$R", "STANDUP_WRITE_TOKEN_FILE=~/.standup/write-token")} ${RUN}`],
    // A token file deeper than one plain dir under the root is not spelled out as the root's own.
    ["a scratch env at its home's token", `${MKTEMP} && ${env("$R", "STANDUP_WRITE_TOKEN_FILE=$R/home/.standup/write-token")} ${RUN}`],
  ])("%s is a secret move", (_label, call) => {
    expect(reason(call)).toEqual({ call, reason: expect.stringContaining("Standup's write token") });
  });

  test("a read of the scratch home's token beside the start is a secret move", () => {
    // `$R/home/<name>` spells a home's layout, so the root isn't fresh and its owner token is read as the owner's too.
    const call = `${REPRESENTATIVE} cat $R/home/.standup/write-token`;
    expect(reason(call)).toEqual({ call, reason: expect.stringContaining("reads or moves secrets") });
  });

  test.each([
    ["a scratch home's token under /tmp", "cat /tmp/r/home/.standup/write-token"],
    ["the env var at a /tmp token", "STANDUP_WRITE_TOKEN_FILE=/tmp/r/home/.standup/write-token bun run src/index.ts"],
    ["a scratch env at its root's token", `${MKTEMP} && ${env("$R", "STANDUP_WRITE_TOKEN_FILE=$R/write-token")} ${RUN}`],
    ["the source file", "cat packages/shared/src/write-token.ts"],
    ["the import", 'grep -rn "@standup/shared/write-token" packages'],
    ["the header", "grep -n x-standup-write-token packages/collector/src/server.ts"],
  ])("%s is no secret move", (_label, call) => {
    expect(reason(call)).toEqual(noSecret(call));
  });
});
