/*
 * Which commands a test file runs in a fixture directory of its own: a temp
 * dir it makes at run time, where `git config remote.origin.url …` or
 * `git remote add …` change a throwaway repository, not the worktree's. Read
 * from the file's skeleton (comments removed, each string literal replaced by
 * `\u0001<index>\u0002`). Everything here answers "placed" only when it can
 * follow the directory to a temp dir under the system's temp root; anything
 * it can't follow (a parameter, an import, a helper the file doesn't declare,
 * a name bound some way it doesn't read) is not placed, and the command is
 * read as running where the runner starts.
 */

/** A file's code as the floor scans it. */
export interface ScannedCode {
  skeleton: string;
  literals: readonly string[];
}

/**
 * Command text that moves to another directory or repository before it acts,
 * or tells git where its repository or its programs are: there it no longer
 * runs where the call that runs it put it.
 */
const SHELL_MOVES_DIR = /(?:^|[\s;&|(`{])(?:cd|pushd|popd|chdir)(?=$|[\s;&|)`}])|(?:^|\s)(?:-C|--chdir|--git-dir|--work-tree|--separate-git-dir|--exec-path|--namespace|--super-prefix)(?=$|[\s=])|\bGIT_(?:DIR|WORK_TREE|COMMON_DIR|CONFIG\w*)\b/;

/**
 * Environment variables that move where git finds its repository, the config
 * it reads besides its global and system files, the temp root, or what runs:
 * a command given one of them no longer acts on the repository in its working
 * directory. HOME, XDG_CONFIG_HOME and GIT_CONFIG_GLOBAL/SYSTEM/NOSYSTEM only
 * pick the global and system files, which a placed command doesn't write.
 */
export const GIT_REDIRECT_ENV = /^(?:GIT_(?:DIR|WORK_TREE|COMMON_DIR|CONFIG|CONFIG_COUNT|CONFIG_KEY_\w*|CONFIG_VALUE_\w*|CONFIG_PARAMETERS|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|EXEC_PATH|TEMPLATE_DIR|SSH\w*|ASKPASS|PROXY_COMMAND)|PATH|TMPDIR|TMP|TEMP|BASH_ENV|ENV|NODE_OPTIONS|BUN_OPTIONS|BUN_CONFIG_\w*)$/;

/** The options a call that runs a command may pass and still run it where its `cwd` says. */
const SINK_OPTION_KEYS = /^(?:cwd|env|stdio|stdin|stdout|stderr|encoding|input|timeout|maxBuffer|killSignal|windowsHide|signal|cmd|reject|buffer|stripFinalNewline|lines)$/;

/** Most calls one file may run and still have their directories followed; past it, nothing in the file is placed. */
const MAX_SINKS = 2000;

/** Most distinct directory expressions one file has followed. */
const MAX_DIRS = 400;

const NAME = /^[A-Za-z_$][\w$]*$/;
const FS_MODULE = /^(?:node:)?fs(?:\/promises)?$/;
const OS_MODULE = /^(?:node:)?os$/;
const PATH_MODULE = /^(?:node:)?path(?:\/posix)?$/;

function esc(name: string): string {
  return name.replace(/\$/g, "\\$");
}

/**
 * Command text that is git alone, acting where it is run: every step starts
 * with `git`, none moves to another directory or repository, and none pipes
 * into, wraps or redirects to another program (`sh -c`, `xargs`, `npm exec`).
 */
export function placedGitText(text: string): boolean {
  if (SHELL_MOVES_DIR.test(text) || /(?:^|\s)(?:-c|--config-env)(?=$|[\s=])/.test(text)) return false;
  const steps = text.replace(/\s\d?>\s*\/dev\/null\b|\s2>&1\b/g, " ").split(/&&|\|\||;|\n/);
  return steps.every((s) => !/[|&`<>]|\$\(/.test(s) && /^(?:git(?:\s|$)|$)/.test(s.trim())) && steps.some((s) => s.trim() !== "");
}

/** Whether every bracket in `text` closes, in order. */
function balanced(text: string): boolean {
  const open: string[] = [];
  for (const c of text) {
    if (c === "(" || c === "[" || c === "{") open.push(c);
    else if (c === ")" || c === "]" || c === "}") {
      if (open.pop() !== (c === ")" ? "(" : c === "]" ? "[" : "{")) return false;
    }
  }
  return open.length === 0;
}

/** The text between the bracket at `open` and the one that closes it, or null when it never closes. */
function bracketed(text: string, open: number): string | null {
  for (let k = open, depth = 0; k < text.length; k++) {
    const c = text[k]!;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if ((c === ")" || c === "]" || c === "}") && --depth === 0) return text.slice(open + 1, k);
  }
  return null;
}

/** The inside of `text` when it is one bracketed whole (`{ … }`, `[ … ]`), or null. */
function whole(text: string, open: string): string | null {
  if (!text.startsWith(open)) return null;
  const inner = bracketed(text, 0);
  return inner !== null && inner.length + 2 === text.length ? inner : null;
}

/** `text` split at the commas at its own bracket depth. */
function topLevelParts(text: string): string[] {
  const parts: string[] = [];
  let from = 0;
  for (let k = 0, depth = 0; k <= text.length; k++) {
    const c = text[k];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === undefined || (c === "," && depth === 0)) {
      const part = text.slice(from, k).trim();
      if (part) parts.push(part);
      from = k + 1;
    }
  }
  return parts;
}

/** The expression starting at `from`: up to a `,`, `;` or line end at its own depth, or the bracket that closes around it. */
function exprAt(text: string, from: number): string {
  let k = from;
  while (k < text.length && /\s/.test(text[k]!)) k++;
  const start = k;
  for (let depth = 0; k < text.length; k++) {
    const c = text[k]!;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && (c === "," || c === ";" || c === "\n")) break;
  }
  return text.slice(start, k).trim();
}

/** An object literal's properties; `key` is null for a spread, a computed key or a method, whose effect the floor can't read. */
function objectProps(body: string, literals: readonly string[]): Array<{ key: string | null; value: string }> {
  return topLevelParts(body).map((p) => {
    const m = /^(?:([A-Za-z_$][\w$]*)|\u0001(\d+)\u0002)\s*(?::([\s\S]*))?$/.exec(p);
    if (!m) return { key: null, value: p };
    const key = m[1] ?? literals[Number(m[2])] ?? "";
    return { key, value: m[3] !== undefined ? m[3].trim() : key };
  });
}

/** An expression without what doesn't change its value: `await`, TS casts and non-null marks, wrapping parentheses. */
function unwrap(raw: string): string {
  let expr = raw.trim();
  for (let prev = ""; prev !== expr; ) {
    prev = expr;
    expr = expr.replace(/^await\s+/, "").replace(/\s+(?:as|satisfies)\s+[\w$.]+(?:<[^<>]*>)?(?:\[\])?$/, "").replace(/!$/, "").trim();
    const inner = whole(expr, "(");
    if (inner !== null) expr = inner.trim();
  }
  return expr;
}

/**
 * Whether code sets an environment variable that moves git (see
 * `GIT_REDIRECT_ENV`) in its own process, which every command it and the
 * files run with it start inherits, or reaches that environment some way the
 * floor can't follow: an alias of `process.env`, `Reflect`, a computed key, an
 * import of `env`. Reads of a named variable and `...process.env` are fine.
 */
export function envMovesGit(code: ScannedCode): boolean {
  const sk = code.skeleton;
  if (/\bReflect\s*\.|\b(?:process|Bun|globalThis)\s*\[|\bglobalThis\s*\.\s*(?:process|Bun)\b|\brequire\s*\(\s*\u0001\d+\u0002\s*\)\s*\.\s*env\b/.test(sk)) return true;
  for (const m of sk.matchAll(/\bimport\s+([^;]*?)\s*\bfrom\s*\u0001(\d+)\u0002|\brequire\s*\(\s*\u0001(\d+)\u0002\s*\)/g)) {
    const mod = code.literals[Number(m[2] ?? m[3])] ?? "";
    if (!/^(?:node:)?process$|^bun$/.test(mod)) continue;
    // `import { $ } from "bun"` is the shell; the process itself, its env, or all of the module is the environment.
    if (m[3] !== undefined || !/^(?:type\s+)?\{[^}]*\}$/.test(m[1]!.trim()) || /\benv\b/.test(m[1]!)) return true;
  }
  for (const m of sk.matchAll(/\b(?:process|Bun)\s*\.\s*env\b/g)) {
    const before = sk.slice(Math.max(0, m.index - 12), m.index);
    const after = sk.slice(m.index + m[0].length);
    if (/\.\.\.\s*$/.test(before) || /(?<![\w$.])env\s*:\s*$/.test(before) && /^\s*[,})]/.test(after)) continue;
    const key = /^\s*(?:\??\.\s*([A-Za-z_$][\w$]*)|\[\s*\u0001(\d+)\u0002\s*\])/.exec(after);
    if (!key) return true;
    const assigned = /^\s*(?:[-+*/%&|^]|\*\*|\?\?|\|\||&&)?=(?![=>])/.test(after.slice(key[0].length));
    if (assigned && GIT_REDIRECT_ENV.test(key[1] ?? code.literals[Number(key[2])] ?? "")) return true;
  }
  return false;
}

/**
 * The relative modules code loads (`import … from "./x"`, `import "./x"`,
 * `export … from`, `import("./x")`, `require("./x")`), or "" for one whose
 * name is computed, which the floor can't follow.
 */
export function localImports(code: ScannedCode): string[] {
  const out: string[] = [];
  for (const m of code.skeleton.matchAll(/\b(?:import|export)\b[^;\u0001]*?\bfrom\s*\u0001(\d+)\u0002|\bimport\s*\u0001(\d+)\u0002|\b(?:import|require)\s*\(\s*(?:\u0001(\d+)\u0002\s*\)|(?!\u0001))/g)) {
    const id = m[1] ?? m[2] ?? m[3];
    const spec = id === undefined ? "" : code.literals[Number(id)] ?? "";
    if (spec === "" || /^\.{1,2}(?:\/|$)|^\//.test(spec)) out.push(spec);
  }
  return out;
}

/** Whether a dotenv file the runner loads sets a variable that moves git. */
export function dotenvMovesGit(text: string): boolean {
  return [...text.matchAll(/^[ \t]*(?:export[ \t]+)?([A-Za-z_]\w*)[ \t]*=/gm)].some((m) => GIT_REDIRECT_ENV.test(m[1]!));
}

/**
 * Whether code can turn a directory it made into another repository's: a
 * link (which can point a fixture path at the worktree), a `.git` file it
 * writes (a gitfile naming another repository), or a git step that attaches a
 * directory to an existing repository (`worktree add`, `--separate-git-dir`).
 */
function retargetsDirs(code: ScannedCode, texts: readonly string[]): boolean {
  const sk = code.skeleton;
  if (replacesDirHelpers(code)) return true;
  if (texts.some((t) => /\bworktree\s+add\b|--separate-git-dir\b/.test(t))) return true;
  if (/\b(?:sym)?link(?:Sync)?\s*\(/.test(sk) || code.literals.some((l) => /^\s*gitdir:/i.test(l))) return true;
  for (const m of sk.matchAll(/\b(?:writeFile|appendFile|copyFile|cp|rename|write|outputFile)(?:Sync)?\s*\(/g)) {
    const args = bracketed(sk, m.index + m[0].length - 1) ?? sk.slice(m.index);
    if ([...args.matchAll(/\u0001(\d+)\u0002/g)].some((l) => /(?:^|[\\/])\.git[\\/]?$/.test(code.literals[Number(l[1])] ?? ""))) return true;
  }
  return false;
}

/** The standard functions the floor follows a fixture directory through. */
const DIR_HELPERS = /^(?:tmpdir|mkdtemp(?:Sync)?|realpath(?:Sync)?|join|resolve|makeTempDir(?:Sync)?)$/;

/**
 * Whether code swaps out a module or function the floor relies on to know a
 * directory is a temp dir: a module mock of `os`, `fs` or `path` (Bun's
 * `mock.module` rewrites imports already made), a spy on one of their
 * functions, or an assignment over one (`os.tmpdir = …`).
 */
function replacesDirHelpers(code: ScannedCode): boolean {
  const sk = code.skeleton;
  const lit = (id: string | undefined) => (id === undefined ? "" : code.literals[Number(id)] ?? "");
  for (const m of sk.matchAll(/\b(?:mock\s*\.\s*module|(?:jest|vi)\s*\.\s*(?:mock|doMock|unstable_mockModule)|mockModule)\s*\(\s*(?:\u0001(\d+)\u0002)?/g)) {
    if (m[1] === undefined || /^(?:node:)?(?:os|fs|fs\/promises|path|path\/posix)$/.test(lit(m[1]))) return true;
  }
  for (const m of sk.matchAll(/\bspyOn\s*\(\s*[^,()]*,\s*(?:\u0001(\d+)\u0002)?/g)) {
    if (m[1] === undefined || DIR_HELPERS.test(lit(m[1]))) return true;
  }
  for (const m of sk.matchAll(/(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*\u0001(\d+)\u0002\s*\])\s*(?:\?\?|\|\||&&)?=(?![=>])/g)) {
    if (DIR_HELPERS.test(m[1] ?? lit(m[2]))) return true;
  }
  return /\b(?:defineProperty|defineProperties|assign)\s*\(\s*(?:os|fs|path|require\s*\()/.test(sk);
}

/** The `.cwd(…)` argument chained onto a Bun shell template (skeleton text after it), or null when there is none or an `.env(…)` is chained too. */
function shellChainCwd(after: string): string | null {
  let cwd: string | null = null;
  for (let rest = after; ; ) {
    const m = /^\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(rest);
    if (!m) return cwd;
    const arg = bracketed(rest, m[0].length - 1);
    if (arg === null || m[1] === "env") return null;
    if (m[1] === "cwd") cwd = arg;
    rest = rest.slice(m[0].length + arg.length + 1);
  }
}

/** One command a file runs: its text, and how the floor can tell where it runs. */
export interface SinkRun {
  text: string;
  /** The skeleton of a call's arguments (`execSync(…)`, `spawnSync(…)`). */
  args?: string;
  /** The skeleton after a Bun shell template (its `.cwd(…)` chain). */
  chain?: string;
}

/**
 * The commands among `runs` (each placed under the text it is read as) that
 * run in a fixture directory of the file's own. `placeable` says whether the
 * run as a whole leaves git alone (its environment, a dotenv file, another
 * file it runs or imports); it is asked only when a command could be placed,
 * and when it is false nothing is.
 */
export function placedRuns(code: ScannedCode, runs: readonly SinkRun[], placeable: () => boolean): Map<SinkRun, string> {
  const out = new Map<SinkRun, string>();
  // Only text that is git alone can be placed; with none, the run's own check (which reads every module it loads) isn't needed.
  if (!runs.some((r) => /^\s*git\s/.test(r.text) && (r.args !== undefined || r.chain !== undefined))) return out;
  if (runs.length > MAX_SINKS || envMovesGit(code) || retargetsDirs(code, runs.map((r) => r.text)) || !placeable()) return out;
  // A global `$.env(…)` reaches every Bun shell template the file runs.
  const shellEnv = /(?<![\w$.])\$\s*\.\s*env\s*\(/.test(code.skeleton);
  const dirs = new FixtureDirs(code);
  for (const run of runs) {
    const text = run.args !== undefined ? dirs.call(run.args, run.text) : run.chain !== undefined && !shellEnv ? dirs.shell(run.chain, run.text) : null;
    if (text !== null) out.set(run, text);
  }
  return out;
}

/**
 * Command words that can put a link, a mount or another tree in a
 * directory's place (`ln -s`, `mv`, `cp`, an archive unpacked).
 */
const SHELL_PLACES_TREE = /(?:^|[\s;&|(`{])(?:ln|mv|cp|rsync|tar|unzip|bsdtar|cpio|mount|bindfs)(?=$|[\s;&|)`}])/;

/**
 * A test of names for code (`code`): whether the file binds a name, every
 * way it binds it, only to a directory it makes fresh under the system's temp
 * root (see FixtureDirs.follow: `mkdtemp(join(tmpdir(), …))`, `tmpdir()`, a
 * path below one that doesn't climb out, a name bound only to one). Nothing
 * is when the file swaps the helpers that tell (replacesDirHelpers) or can
 * put a link or another tree where such a dir was: a link or rename call, or
 * a literal that runs a command that does.
 */
export function freshTempNames(code: ScannedCode): (name: string) => boolean {
  const sk = code.skeleton;
  if (replacesDirHelpers(code) || /\b(?:sym)?link(?:Sync)?\s*\(|\brename(?:Sync)?\s*\(|\b(?:cp|copyFile|move|copy)(?:Sync)?\s*\(/.test(sk) || code.literals.some((l) => SHELL_PLACES_TREE.test(l))) return () => false;
  const dirs = new FixtureDirs(code);
  return (name) => NAME.test(name) && dirs.dir(name);
}

/** What a binding the code makes gives a name: an expression, or a property of one (`const { dir } = make()`). */
interface Bound {
  expr: string;
  prop?: string;
}

/** Follows the directories one file's calls run their commands in. */
class FixtureDirs {
  private readonly sk: string;
  private readonly literals: readonly string[];
  private readonly dirs = new Map<string, boolean>();
  private readonly bound = new Map<string, Bound[] | null>();
  private readonly returns = new Map<string, string[] | null>();
  private readonly modules = new Map<string, string | null>();
  private params: string | null = null;
  private patterns: Array<{ declared: boolean; pattern: string; value: string }> | null = null;

  constructor(code: ScannedCode) {
    this.sk = code.skeleton;
    this.literals = code.literals;
  }

  /**
   * The text a call runs placed, from its arguments' skeleton and its literal
   * argv joined, or null: the call's own options object (no spread, only
   * options that don't change what runs, an env that doesn't move git) gives a
   * `cwd` the floor follows to a fixture directory, the argv is literal up to
   * one trailing value, and the text is git alone. `git -C ${dir} …` with
   * such a dir runs placed as the rest.
   */
  call(args: string, text: string): string | null {
    if (!balanced(args)) return null;
    let options: string | null = null;
    const argv: string[] = [];
    for (const part of topLevelParts(args)) {
      const obj = whole(part, "{");
      if (obj === null) {
        argv.push(part);
        continue;
      }
      if (options !== null) return null;
      options = obj;
    }
    let cwd: string | null = null;
    for (const p of options === null ? [] : objectProps(options, this.literals)) {
      if (p.key === null || !SINK_OPTION_KEYS.test(p.key)) return null;
      if (p.key === "cwd") cwd = p.value;
      else if (p.key === "env" && !this.envKeepsRepo(p.value)) return null;
      else if (p.key === "cmd") argv.push(p.value);
    }
    const moved = /^git\s+-C\s+\$\{\s*([A-Za-z_$][\w$]*)\s*\}\s+/.exec(text);
    if (moved) return argv.length === 1 && cwd === null ? this.movedText(text, moved[1]!) : null;
    if (cwd === null || !this.literalArgv(argv) || !placedGitText(text)) return null;
    return this.dir(cwd) ? text : null;
  }

  /**
   * `git -C ${dir} …` text run placed, as the text without the `-C`: every
   * step must name the same fixture dir (a step without it runs where the
   * process is), and each step is literal up to one trailing value.
   */
  private movedText(text: string, name: string): string | null {
    const steps = text.split(/&&|\|\||;|\n/).map((s) => s.trim()).filter(Boolean);
    const head = new RegExp(String.raw`^git\s+-C\s+\$\{\s*${esc(name)}\s*\}\s+`);
    if (!steps.every((s) => head.test(s))) return null;
    const rest = steps.map((s) => `git ${s.replace(head, "")}`);
    if (!rest.every((s) => this.literalWords([s])) || !placedGitText(rest.join(" && "))) return null;
    return this.dir(name) ? rest.join(" && ") : null;
  }

  /** The text a Bun shell template runs placed, given the skeleton after it, or null. */
  shell(chain: string, text: string): string | null {
    const cwd = shellChainCwd(chain);
    return cwd !== null && this.literalWords([text]) && placedGitText(text) && this.dir(cwd) ? text : null;
  }

  /**
   * Whether a call's argv parts (skeleton) are literals or arrays of
   * literals, with at most one computed value, last and after git, its
   * subcommand and one more word: a value can't then be an option or a
   * subcommand that sends git elsewhere.
   */
  private literalArgv(argv: readonly string[]): boolean {
    const words: Array<string | null> = [];
    for (const part of argv) {
      const lit = /^\u0001(\d+)\u0002$/.exec(part);
      if (lit) {
        words.push(...this.wordsOf(this.literals[Number(lit[1])] ?? ""));
        continue;
      }
      const items = whole(part, "[");
      if (items === null) return false;
      for (const item of topLevelParts(items)) {
        const one = /^\u0001(\d+)\u0002$/.exec(item);
        if (one) words.push((this.literals[Number(one[1])] ?? "").includes("${") ? null : this.literals[Number(one[1])]!);
        else if (NAME.test(item)) words.push(null);
        else return false;
      }
    }
    return this.lastOnly(words);
  }

  /** `literalArgv` for text written as one string (a template's `${…}` is a computed value). */
  private literalWords(texts: readonly string[]): boolean {
    return this.lastOnly(texts.flatMap((t) => this.wordsOf(t)));
  }

  private wordsOf(text: string): Array<string | null> {
    return text.split(/\s+/).filter(Boolean).map((w) => (w.includes("${") ? null : w));
  }

  private lastOnly(words: ReadonlyArray<string | null>): boolean {
    const computed = words.findIndex((w) => w === null);
    return computed < 0 || (computed === words.length - 1 && computed >= 3);
  }

  /** Whether an `env` option keeps git on the repository it runs in: the process's own, or an object of it plus variables that don't move git. */
  private envKeepsRepo(value: string): boolean {
    if (/^(?:process|Bun)\s*\.\s*env$/.test(value)) return true;
    const body = whole(value, "{");
    if (body === null) return false;
    return objectProps(body, this.literals).every((p) => (p.key === null ? /^\.\.\.\s*(?:process|Bun)\s*\.\s*env$/.test(p.value) : !GIT_REDIRECT_ENV.test(p.key)));
  }

  /** Whether a `cwd` expression is a fixture directory: see `follow`. */
  dir(expr: string): boolean {
    const key = expr.trim();
    const known = this.dirs.get(key);
    if (known !== undefined) return known;
    if (this.dirs.size >= MAX_DIRS) return false;
    const placed = this.follow(key, new Set());
    this.dirs.set(key, placed);
    return placed;
  }

  /**
   * Whether an expression is a directory the code makes under the system's
   * temp root: `mkdtemp(join(tmpdir(), …))`, `tmpdir()`, the real path of one,
   * a path below one that doesn't climb back out, or a name, a fixture
   * object's property, or a local helper whose every value is one of those.
   */
  private follow(raw: string, seen: ReadonlySet<string>): boolean {
    const expr = unwrap(raw);
    if (!expr || seen.size > 8) return false;
    const call = /^((?:[A-Za-z_$][\w$]*\s*\.\s*)*)([A-Za-z_$][\w$]*)\s*\(/.exec(expr);
    if (call) {
      const inner = bracketed(expr, call[0].length - 1);
      if (inner === null || call[0].length + inner.length + 1 !== expr.length) return false;
      const owner = call[1]!.replace(/\s/g, "").split(".").filter(Boolean);
      const callee = call[2]!;
      const parts = topLevelParts(inner);
      if (!owner.length) {
        if (seen.has(callee)) return false;
        const returns = this.localReturns(callee);
        if (returns !== null) return returns.length > 0 && returns.every((r) => this.follow(r, new Set([...seen, callee])));
      }
      if (this.builtin(owner, callee, FS_MODULE, /^mkdtemp(?:Sync)?$/)) return parts.length >= 1 && this.underTemp(parts[0]!, seen);
      if (this.builtin(owner, callee, OS_MODULE, /^tmpdir$/)) return parts.length === 0;
      if (owner.length === 1 && owner[0] === "Deno" && /^makeTempDir(?:Sync)?$/.test(callee) && this.unbound("Deno")) return parts.length === 0;
      if (this.builtin(owner, callee, FS_MODULE, /^realpath(?:Sync)?$/)) return parts.length === 1 && this.follow(parts[0]!, seen);
      if (this.builtin(owner, callee, PATH_MODULE, /^(?:join|resolve)$/)) return parts.length > 1 && this.follow(parts[0]!, seen) && parts.slice(1).every((p) => this.descends(p));
      return false;
    }
    const member = /^([A-Za-z_$][\w$]*)(?:\s*\??\.\s*([A-Za-z_$][\w$]*))?$/.exec(expr);
    if (!member) return false;
    const root = member[1]!;
    if (seen.has(root)) return false;
    const values = this.bindingsOf(root);
    if (values === null || !values.length) return false;
    const next = new Set([...seen, root]);
    if (member[2] !== undefined) return !this.mutated(root) && values.every((v) => v.prop === undefined && this.propOf(v.expr, member[2]!, next));
    return values.every((v) => (v.prop === undefined ? this.follow(v.expr, next) : this.propOf(v.expr, v.prop, next)));
  }

  /** Whether an object expression's property `prop` is a fixture directory: an object literal, a name bound to one, or a local helper returning one. */
  private propOf(raw: string, prop: string, seen: ReadonlySet<string>): boolean {
    const expr = unwrap(raw);
    if (seen.size > 8) return false;
    const body = whole(expr, "{");
    if (body !== null) {
      const props = objectProps(body, this.literals);
      if (props.some((p) => p.key === null)) return false;
      const hit = props.filter((p) => p.key === prop);
      return hit.length === 1 && this.follow(hit[0]!.value, seen);
    }
    if (NAME.test(expr)) {
      const values = this.bindingsOf(expr);
      return !seen.has(expr) && !this.mutated(expr) && values !== null && values.length > 0 && values.every((v) => v.prop === undefined && this.propOf(v.expr, prop, new Set([...seen, expr])));
    }
    const call = /^([A-Za-z_$][\w$]*)\s*\(/.exec(expr);
    if (!call || seen.has(call[1]!)) return false;
    const inner = bracketed(expr, call[0].length - 1);
    if (inner === null || call[0].length + inner.length + 1 !== expr.length) return false;
    const returns = this.localReturns(call[1]!);
    return returns !== null && returns.length > 0 && returns.every((r) => this.propOf(r, prop, new Set([...seen, call[1]!])));
  }

  /** A prefix `mkdtemp` is handed that lies under the system's temp root: `join(tmpdir(), "x-")`, `` `${tmpdir()}/x-` ``, `tmpdir() + "/x-"`, or a name bound only to one. */
  private underTemp(raw: string, seen: ReadonlySet<string>): boolean {
    const expr = unwrap(raw);
    const lit = /^\u0001(\d+)\u0002$/.exec(expr);
    if (lit) {
      const v = this.literals[Number(lit[1])] ?? "";
      const m = /^\$\{\s*(?:([A-Za-z_$][\w$]*)\s*\.\s*)?tmpdir\s*\(\s*\)\s*\}([\s\S]*)$/.exec(v);
      return m !== null && this.builtin(m[1] ? [m[1]] : [], "tmpdir", OS_MODULE, /^tmpdir$/) && /^[\\/]/.test(m[2]!) && this.descendsText(m[2]!.slice(1));
    }
    const concat = /^([\s\S]+?)\s*\+\s*\u0001(\d+)\u0002$/.exec(expr);
    if (concat) return this.follow(concat[1]!, seen) && /^[\\/]/.test(this.literals[Number(concat[2])] ?? "") && this.descendsText((this.literals[Number(concat[2])] ?? "").slice(1));
    const join = /^((?:[A-Za-z_$][\w$]*\s*\.\s*)*)(join|resolve)\s*\(/.exec(expr);
    if (join) {
      const inner = bracketed(expr, join[0].length - 1);
      if (inner === null || join[0].length + inner.length + 1 !== expr.length) return false;
      if (!this.builtin(join[1]!.replace(/\s/g, "").split(".").filter(Boolean), join[2]!, PATH_MODULE, /^(?:join|resolve)$/)) return false;
      const parts = topLevelParts(inner);
      return parts.length > 1 && this.follow(parts[0]!, seen) && parts.slice(1).every((p) => this.descends(p));
    }
    if (!NAME.test(expr) || seen.has(expr)) return false;
    const values = this.bindingsOf(expr);
    return values !== null && values.length > 0 && values.every((v) => v.prop === undefined && this.underTemp(v.expr, new Set([...seen, expr])));
  }

  /** A path part that only goes down: a literal with no `..` step, no root or home, and nothing computed. */
  private descends(part: string): boolean {
    const lit = /^\u0001(\d+)\u0002$/.exec(part.trim());
    return lit !== null && this.descendsText(this.literals[Number(lit[1])] ?? "") && !/^[\\/~]/.test(this.literals[Number(lit[1])] ?? "");
  }

  /** Literal path text that only goes down; the only values computed into it are unique-name parts that can't hold a `/` (`x-${Date.now()}`). */
  private descendsText(v: string): boolean {
    const named = v.replace(/\$\{\s*(?:Date\s*\.\s*now\(\)|process\s*\.\s*pid|performance\s*\.\s*now\(\)|(?:crypto\s*\.\s*)?randomUUID\(\)|Math\s*\.\s*random\(\)(?:\s*\.\s*toString\(\d*\))?(?:\s*\.\s*slice\(\d+(?:,\s*\d+)?\))?)\s*\}/g, "x");
    return !named.includes("${") && !/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(named);
  }

  /**
   * Whether `owner.callee` is the standard library's: a name the file imports
   * or requires from a module `mod` matches (`import { tmpdir } from "os"`,
   * `import os from "node:os"` with `os.tmpdir`), and doesn't rebind.
   */
  private builtin(owner: readonly string[], callee: string, mod: RegExp, name: RegExp): boolean {
    if (!name.test(callee)) return false;
    if (owner.length === 0) return mod.test(this.moduleOf(callee) ?? "") && this.localReturns(callee) === null;
    if (owner.length === 1) return mod.test(this.moduleOf(owner[0]!) ?? "");
    // `fs.promises.mkdtemp`
    return owner.length === 2 && owner[1] === "promises" && mod === FS_MODULE && mod.test(this.moduleOf(owner[0]!) ?? "");
  }

  /** The module a name is imported or required from, when that is the only way the file binds it. */
  private moduleOf(name: string): string | null {
    const known = this.modules.get(name);
    if (known !== undefined) return known;
    const n = esc(name);
    const word = new RegExp(String.raw`(?<![\w$.])${n}(?![\w$])`);
    let mod: string | null = null;
    for (const m of this.sk.matchAll(/\bimport\s+(?:type\s+)?((?:[A-Za-z_$][\w$]*\s*,?\s*)?(?:\{[^{}]*\}|\*\s*as\s+[A-Za-z_$][\w$]*)?)\s*from\s*\u0001(\d+)\u0002/g)) {
      // `import { tmpdir as t }` binds `t`, not `tmpdir`.
      const clause = m[1]!.replace(/\b[A-Za-z_$][\w$]*\s+as\s+(?=[A-Za-z_$])/g, "");
      if (word.test(clause)) mod = mod === null ? this.literals[Number(m[2])] ?? "" : "";
    }
    for (const m of this.sk.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*|\{[^{}]*\})\s*=\s*require\s*\(\s*\u0001(\d+)\u0002\s*\)/g)) {
      const clause = m[1]!.replace(/\b[A-Za-z_$][\w$]*\s*:\s*(?=[A-Za-z_$])/g, "");
      if (word.test(clause)) mod = mod === null ? this.literals[Number(m[2])] ?? "" : "";
    }
    // Any other binding of the name, and it is the file's own.
    if (mod !== null && (this.plainBindings(name).length > 0 || this.paramText().match(word))) mod = "";
    this.modules.set(name, mod);
    return mod;
  }

  private unbound(name: string): boolean {
    return this.moduleOf(name) === null && this.bindingsOf(name)?.length === 0;
  }

  /** The `=` bindings of a name, each as its value's skeleton. */
  private plainBindings(name: string): string[] {
    const n = esc(name);
    const out: string[] = [];
    for (const b of this.sk.matchAll(new RegExp(String.raw`(?<![\w$.])${n}\s*(?::\s*[^=;,\n(){}]+?)?\s*(?:\?\?|\|\||&&)?=(?![=>])`, "g"))) out.push(exprAt(this.sk, b.index + b[0].length));
    return out;
  }

  /**
   * Every value the file binds `name` to, or null when it binds it some way
   * the floor doesn't follow: as a parameter, a loop or catch variable, by an
   * import, a compound assignment, or a destructuring assignment.
   */
  private bindingsOf(name: string): Bound[] | null {
    if (this.bound.has(name)) return this.bound.get(name)!;
    const n = esc(name);
    const word = new RegExp(String.raw`(?<![\w$.])${n}(?![\w$])`);
    let out: Bound[] | null = this.plainBindings(name).map((expr) => ({ expr }));
    if (
      name === "this" ||
      word.test(this.paramText()) ||
      this.moduleOf(name) !== null ||
      new RegExp(String.raw`(?<![\w$.])${n}\s*(?:[-+*/%&|^]|\*\*|<<|>>>?)=(?!=)|(?<![\w$.])${n}\s*=>`).test(this.sk)
    ) {
      out = null;
    } else {
      for (const d of this.destructurings()) {
        if (!word.test(d.pattern)) continue;
        // Only `const { dir } = …` / `const { dir: d } = …` binds it in a way that's followed; a key of that name binds something else.
        const parts = d.pattern.startsWith("{") ? topLevelParts(d.pattern.slice(1, -1)) : null;
        const props = parts?.map((p) => /^(?:([A-Za-z_$][\w$]*)\s*:\s*)?([A-Za-z_$][\w$]*)$/.exec(p));
        const hit = props?.find((m) => m?.[2] === name);
        if (!props || props.some((m, k) => m === null && word.test(parts![k]!))) {
          out = null;
          break;
        }
        if (!hit) continue;
        if (!d.declared) {
          out = null;
          break;
        }
        out.push({ expr: d.value, prop: hit[1] ?? name });
      }
    }
    this.bound.set(name, out);
    return out;
  }

  /**
   * Every destructuring pattern the file assigns to, with whether it
   * declares and the value it takes apart: each bracketed `{ … }` / `[ … ]`
   * an `=` follows. Built once, in one pass over the brackets.
   */
  private destructurings(): Array<{ declared: boolean; pattern: string; value: string }> {
    if (this.patterns !== null) return this.patterns;
    const sk = this.sk;
    const found: Array<{ declared: boolean; pattern: string; value: string }> = [];
    const stack: number[] = [];
    for (let k = 0; k < sk.length; k++) {
      const c = sk[k]!;
      if (c === "(" || c === "[" || c === "{") stack.push(k);
      else if ((c === ")" || c === "]" || c === "}") && stack.length) {
        const open = stack.pop()!;
        if (c === ")") continue;
        const eq = /^\s*(?::[^=;\n{}()]{1,200})?=(?![=>])/.exec(sk.slice(k + 1, k + 240));
        if (!eq) continue;
        found.push({ declared: /\b(?:const|let|var)\s*$/.test(sk.slice(Math.max(0, open - 8), open)), pattern: sk.slice(open, k + 1), value: exprAt(sk, k + 1 + eq[0].length) });
      }
    }
    this.patterns = found;
    return found;
  }

  /**
   * Whether the code changes a property of the object a name holds
   * (`o.cwd = …`, `Object.assign(o, …)`) or hands the object itself anywhere
   * it could be changed: bound to another name, passed to a call, put in an
   * array or object, spread.
   */
  private mutated(name: string): boolean {
    const n = esc(name);
    return new RegExp(
      String.raw`(?<![\w$.])${n}\s*(?:\??\.\s*[\w$]+|\[[^\]]*\])\s*(?:[-+*/%&|^]|\*\*|\?\?|\|\||&&)?=(?![=>])|\b(?:assign|defineProperty|defineProperties|set)\s*\(\s*${n}\b|[=(,[:]\s*${n}\s*(?:[;\n,)\]}]|$)|\.\.\.\s*${n}(?![\w$])`,
    ).test(this.sk);
  }

  /**
   * Every parameter list in the file, joined: those of functions, methods and
   * arrows, catch clauses and for…of/in heads. Built once, by matching each
   * bracket that a body or an arrow follows.
   */
  private paramText(): string {
    if (this.params !== null) return this.params;
    const sk = this.sk;
    const lists: string[] = [];
    const stack: number[] = [];
    for (let k = 0; k < sk.length; k++) {
      const c = sk[k]!;
      if (c === "(") stack.push(k);
      else if (c === ")" && stack.length) {
        const open = stack.pop()!;
        const before = sk.slice(Math.max(0, open - 8), open);
        const after = /^\s*(?::[^{;=()]+)?\s*(\{|=>)/.exec(sk.slice(k + 1, k + 120));
        if (/\b(?:if|while|switch|with)\s*$/.test(before)) continue;
        if (after || /\b(?:catch|for)\s*$/.test(before)) lists.push(sk.slice(open + 1, k));
      }
    }
    this.params = lists.join("\n");
    return this.params;
  }

  /**
   * What a function the code declares itself returns (`function f() { …; return dir; }`,
   * `const f = () => dir`), or null when it isn't declared exactly once in a shape the floor reads.
   */
  private localReturns(name: string): string[] | null {
    if (this.returns.has(name)) return this.returns.get(name)!;
    const found = this.readReturns(name);
    this.returns.set(name, found);
    return found;
  }

  private readReturns(name: string): string[] | null {
    const n = esc(name);
    const decls = [...this.sk.matchAll(new RegExp(String.raw`\bfunction\s*\*?\s*${n}\s*(?=\()|(?<![\w$.])${n}\s*=\s*(?=(?:async\s+)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>))`, "g"))];
    if (decls.length !== 1) return null;
    let rest = this.sk.slice(decls[0]!.index + decls[0]![0].length);
    const keyword = /^(?:async\s+)?function\s*\*?\s*[\w$]*\s*/.exec(rest);
    const fn = decls[0]![0].startsWith("function") || keyword !== null;
    if (keyword) rest = rest.slice(keyword[0].length);
    rest = rest.replace(/^async\s+/, "");
    if (rest.startsWith("(")) {
      const params = bracketed(rest, 0);
      if (params === null) return null;
      rest = rest.slice(params.length + 2);
    } else {
      const param = /^[A-Za-z_$][\w$]*/.exec(rest);
      if (!param) return null;
      rest = rest.slice(param[0].length);
    }
    const head = /^\s*(?::\s*[^{=;]+)?\s*(=>)?\s*/.exec(rest)!;
    if (fn === (head[1] !== undefined)) return null;
    rest = rest.slice(head[0].length);
    if (!rest.startsWith("{")) return fn ? null : [exprAt(rest, 0)];
    const body = bracketed(rest, 0);
    if (body === null) return null;
    return [...body.matchAll(/(?<![\w$.])return\b/g)].map((r) => exprAt(body, r.index + r[0].length));
  }
}
