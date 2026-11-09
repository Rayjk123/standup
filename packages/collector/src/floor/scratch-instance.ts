/*
 * A worker's isolated scratch Standup instance: a program run under an inline
 * `env -i` whose home, XDG, temp, DB, knowledge and internal dirs and owner
 * token file all lie under one fresh root below /tmp (the floor's complete
 * isolation, Classifier.isolationRoot), bound to 127.0.0.1 on ports no live
 * Standup process uses, with the collector's network features off.
 *
 * The floor (classify.ts) decides whether a call is one, from its own parse
 * of the call and its probes of the filesystem, and records the result on its
 * hold (FloorHold.scratch). The collector writes that into the ask's question
 * ahead of anything the worker controls (scratchInstanceLabel), and the
 * Persona allow check reads it back from there (scratchInstanceOf): it never
 * takes the worker's word, or re-reads the worker's text, for it.
 */

/** The env a scratch collector takes the port it binds from. */
export const ISOLATION_PORT_ENV = ["PORT", "STANDUP_PORT", "COLLECTOR_PORT"] as const;

/**
 * The env a scratch collector must start with to stay off the network: bound
 * to loopback, with no gateway, Persona, review tunnels or digests. Without
 * one of these the collector binds, tunnels, or sends on its own.
 */
export const SCRATCH_COLLECTOR_ENV: ReadonlyArray<readonly [string, string]> = [
  ["STANDUP_BIND_HOST", "127.0.0.1"],
  ["STANDUP_GATEWAY", "0"],
  ["STANDUP_PERSONA", "0"],
  ["STANDUP_REVIEW_TUNNELS", "0"],
  ["STANDUP_DIGEST", "0"],
];

/**
 * The collector's switches a scratch instance may set but needn't: off is
 * their only value it takes. The idle reaper pauses only the scratch DB's
 * workers, on the tmux server the instance's own TMUX_TMPDIR names (the floor
 * holds a scratch collector without one), so it can't reach live workers.
 */
const SCRATCH_OPTIONAL_OFF_ENV: ReadonlyArray<readonly [string, string]> = [["STANDUP_IDLE_REAP", "0"]];

/** Every collector switch a scratch instance may set, to the one value it takes. */
const SCRATCH_SWITCHES: ReadonlyMap<string, string> = new Map([...SCRATCH_COLLECTOR_ENV, ...SCRATCH_OPTIONAL_OFF_ENV]);

/**
 * The env Standup's processes bind or dial a port by: the collector's and its
 * WebSocket's (and their slot listeners'), the console's and vite's, and the
 * scratch console's (packages/web/e2e/vite.scratch.config.ts).
 */
export const SCRATCH_PORT_ENV: ReadonlySet<string> = new Set([
  ...ISOLATION_PORT_ENV,
  "WS_PORT",
  "STANDUP_LISTEN_PORT",
  "STANDUP_LISTEN_WS_PORT",
  "STANDUP_WEB_PORT",
  "STANDUP_VITE_PORT",
  "SCRATCH_API_PORT",
  "SCRATCH_WS_PORT",
  "SCRATCH_WEB_PORT",
]);

/** The env Standup's code takes a URL or origin from: where it sends, or what it prints to sign in at. */
export const SCRATCH_URL_ENV: ReadonlySet<string> = new Set(["STANDUP_CONSOLE_ORIGIN", "COLLECTOR_URL", "STANDUP_WEB_URL"]);

/** The env that names the files Standup keeps its own tokens in: under a scratch root, they are the scratch instance's. */
export const SCRATCH_TOKEN_FILE_ENV: ReadonlySet<string> = new Set(["STANDUP_OWNER_TOKEN_FILE", "STANDUP_WRITE_TOKEN_FILE"]);

/**
 * Env that loads code into, or reconfigures, the interpreter a run starts
 * with: a scratch instance's run is handed none of it, whatever its value.
 */
export const LOADER_ENV: ReadonlySet<string> = new Set([
  "BUN_OPTIONS",
  "BUN_CONFIG_REGISTRY",
  "BUN_INSTALL",
  "BUN_INSTALL_CACHE_DIR",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_REPL_EXTERNAL_MODULE",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "DYLD_INSERT_LIBRARIES",
  "BASH_ENV",
  "ENV",
  "ZDOTDIR",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PYTHONHOME",
  "PERL5OPT",
  "PERL5LIB",
  "RUBYOPT",
  "RUBYLIB",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_EXEC_PATH",
  "STANDUP_PLAYWRIGHT_DIR",
  "STANDUP_INSTALL_DIR",
]);

/** Env with no path or address in it that a scratch run may carry: locale, terminal, colour and the test runner's mode. */
const PLAIN_ENV = /^(?:LANG|LANGUAGE|LC_[A-Z]+|TERM|COLORTERM|TZ|NO_COLOR|FORCE_COLOR|CI|NODE_ENV|USER|LOGNAME)$/;

/**
 * The flags of `bun`, `bunx` and `node` that load code or config before the
 * program's own, or change the code it runs from the source the floor reads:
 * preloads, loaders, config and env files; values substituted in while
 * parsing (`--define`, `-d`, `--feature`) and calls dropped (`--drop`); JSX
 * compiled to calls of a function or module the flag names; which file an
 * import resolves to (`--conditions`, node's `-C`, `--main-fields`,
 * `--extension-order`, `--preserve-symlinks`); and a debugger or connection
 * opened before the program's code (`--inspect*`, `--*-preconnect`). Read as
 * a prefix, so a value run on (`-r./p.ts`, `-dK:V`, `--preload./p.ts`) and
 * node's `--env-file-if-exists` and `--experimental-config-file` count too.
 */
const LOADER_FLAG =
  /^(?:-[rcidlC]|--(?:require|preload|import|loader|experimental-loader|experimental-config-file|experimental-default-config-file|config|env-file|tsconfig-override|cwd|install|define|drop|feature|jsx-factory|jsx-fragment|jsx-import-source|jsx-runtime|conditions|main-fields|extension-order|preserve-symlinks|inspect|fetch-preconnect|redis-preconnect|sql-preconnect))/;

/** A scratch root the label can carry: an absolute path of plain segments, below /tmp or another temp dir. */
const PLAIN_ROOT = /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;

/**
 * What the floor found: the call is one isolated scratch instance's run,
 * under `root`. `assignments` are the token-file env words (SCRATCH_TOKEN_FILE_ENV,
 * `NAME=value` as the command spells them) `env -i` hands it, whose values
 * the floor put under the root: a word once for each scratch-instance run the
 * floor read it in.
 */
export interface ScratchInstance {
  root: string;
  assignments: string[];
}

/** How a run's env and args are weighed: the live Standup ports (the collector's, its WebSocket's, the console's and vite's). */
export interface ScratchContext {
  livePorts: readonly string[];
}

/** The port a URL or origin names, explicit or by its scheme's default, or null when it isn't one. */
function urlParts(value: string): { host: string; port: string } | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (!/^(?:https?|wss?):$/.test(url.protocol) || url.username || url.password) return null;
  const port = url.port || (url.protocol === "https:" || url.protocol === "wss:" ? "443" : "80");
  return { host: url.hostname, port };
}

/** Every port named beside a loopback or any-address host in `value` (`127.0.0.1:7777`, `localhost%3a7777`). */
function hostPorts(value: string): string[] {
  const out: string[] = [];
  for (const m of value.matchAll(/(?:localhost|127(?:\.\d{1,3}){3}|\[?::1?\]?|0\.0\.0\.0)(?::|%3a)0*(\d{1,5})(?!\d)/gi)) out.push(String(Number(m[1])));
  return out;
}

/** A loopback host name or literal: localhost, 127.0.0.0/8 or ::1. */
const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)$/i;

/** Why a run's env reaches past a scratch instance (scratchEnvRefusal): `live` names a live Standup port, `remote` a host off loopback. */
export interface ScratchEnvRefusal {
  kind: "live" | "remote" | "other";
  reason: string;
}

/**
 * Why a run's own env (`env`: name to value, null for one the floor couldn't
 * read) reaches past a scratch instance, or null when it doesn't.
 *
 * Always: a port env var (SCRATCH_PORT_ENV) set to a live Standup port, a URL
 * or origin (SCRATCH_URL_ENV) at a live port or on a host off loopback, or
 * any value naming a live port beside a loopback or any-address host.
 *
 * With `strict` (a scratch instance's run, scratchInstanceRefusal), besides:
 * a value the floor can't read in any of those, a port that isn't a plain
 * decimal one, a URL that isn't http(s)/ws(s) on a 127.0.0.1 literal, and one
 * of the collector's switches (SCRATCH_SWITCHES, its bind host among them)
 * set other than off. `localhost` is not 127.0.0.1: it resolves
 * through the resolver's config, and may name ::1.
 */
export function scratchEnvRefusal(env: ReadonlyMap<string, string | null>, ctx: ScratchContext, strict = true): ScratchEnvRefusal | null {
  const live = new Set(ctx.livePorts.map((p) => String(Number(p))));
  const other = (reason: string): ScratchEnvRefusal | null => (strict ? { kind: "other", reason } : null);
  for (const [name, value] of env) {
    if (value === null) {
      if (SCRATCH_PORT_ENV.has(name) || SCRATCH_URL_ENV.has(name) || SCRATCH_SWITCHES.has(name)) {
        const r = other(`${name} is set to a value the floor can't read`);
        if (r) return r;
      }
      continue;
    }
    if (SCRATCH_PORT_ENV.has(name)) {
      if (!/^\d{1,5}$/.test(value.trim()) || Number(value) < 1 || Number(value) > 65535) {
        const r = other(`${name}=${value} is not a port`);
        if (r) return r;
        continue;
      }
      if (live.has(String(Number(value)))) return { kind: "live", reason: `${name}=${value} is a live Standup port` };
      continue;
    }
    if (SCRATCH_URL_ENV.has(name)) {
      const parts = urlParts(value);
      if (parts === null) {
        const r = other(`${name}=${value} is not an http or ws URL`);
        if (r) return r;
        if (hostPorts(value).some((p) => live.has(p))) return { kind: "live", reason: `${name}=${value} names a live Standup port` };
        continue;
      }
      if (live.has(parts.port)) return { kind: "live", reason: `${name}=${value} is on a live Standup port` };
      if (!LOOPBACK.test(parts.host)) return { kind: "remote", reason: `${name}=${value} is on ${parts.host}, off this host's loopback` };
      if (parts.host !== "127.0.0.1") {
        const r = other(`${name}=${value} is not on 127.0.0.1`);
        if (r) return r;
      }
      continue;
    }
    const off = SCRATCH_SWITCHES.get(name);
    if (off !== undefined && value !== off) {
      const r = other(`${name}=${value} is not ${off}`);
      if (r) return r;
    }
    if (hostPorts(value).some((p) => live.has(p))) return { kind: "live", reason: `${name}=${value} names a live Standup port` };
  }
  return null;
}

/**
 * Why a run is not an isolated scratch instance's, or null when it is. `env`
 * is the run's own env after an inline `env -i` (`cleared`), with every dir
 * the floor's complete isolation moves already under one root (the caller
 * checks that); `args` its words, the program first. Beyond
 * scratchEnvRefusal: the env was cleared, it carries no `$TMUX` and no loader
 * env (LOADER_ENV), only the names a scratch instance takes (`allowed`, plus
 * PATH, locale and terminal ones), and `bun`,
 * `bunx` or `node` gets no flag that loads code or config before the program's
 * own (a preload, a loader, a config or env file).
 */
export function scratchInstanceRefusal(
  env: ReadonlyMap<string, string | null>,
  args: ReadonlyArray<string | null>,
  cleared: boolean,
  allowed: ReadonlySet<string>,
  ctx: ScratchContext
): string | null {
  if (!cleared) return "its env isn't cleared with an inline `env -i`";
  for (const [name, value] of env) {
    if (name === "TMUX") {
      if (value === "") continue;
      return "TMUX is set, so a bare tmux in the run reaches the server it names";
    }
    if (LOADER_ENV.has(name)) return `it is handed ${name}, which loads code into, or reconfigures, what the run starts`;
    if (name === "PATH" || PLAIN_ENV.test(name) || allowed.has(name) || SCRATCH_PORT_ENV.has(name) || SCRATCH_URL_ENV.has(name) || SCRATCH_TOKEN_FILE_ENV.has(name)) continue;
    if (SCRATCH_SWITCHES.has(name)) continue;
    return `it is handed ${name}, which a scratch instance doesn't take`;
  }
  const reaches = scratchEnvRefusal(env, ctx, true);
  if (reaches !== null) return reaches.reason;
  const program = args[0];
  if (program == null) return "its program can't be read";
  const base = program.slice(program.lastIndexOf("/") + 1);
  if (/^(?:bun|bunx|node)$/.test(base)) {
    // `bun test` takes its own flags after its filters too (`bun test x.test.ts --preload ./p.ts`): every word of it is read.
    let testing = false;
    for (const a of args.slice(1)) {
      if (a === null) return "a word before its script can't be read";
      if (base === "bun" && !testing && /^(?:run|test|x)$/.test(a)) {
        testing = a === "test";
        continue;
      }
      if (!a.startsWith("-")) {
        if (testing) continue;
        break;
      }
      if (LOADER_FLAG.test(a)) return `\`${base} ${a}\` loads code or config before the program's own`;
    }
  }
  return null;
}

/** Whether `root` can stand in a scratch-instance label: a plain absolute path, no `..`. */
export function plainScratchRoot(root: string): boolean {
  return PLAIN_ROOT.test(root) && !root.split("/").includes("..") && !root.split("/").includes(".");
}

/** The label's opening, which floorQuestion keeps any reason from starting with. */
export const SCRATCH_LABEL_OPEN = "[isolated scratch instance under ";

/**
 * The label floorQuestion writes after the category (and the high-risk label,
 * when there is one) for a hold the collector's own classification found to
 * be one scratch instance's run (FloorHold.scratch).
 */
export function scratchInstanceLabel(s: ScratchInstance): string {
  const words = s.assignments.filter(scratchLabelWord);
  return `${SCRATCH_LABEL_OPEN}${s.root}${words.length ? `; ${words.join(", ")} there` : ""}] `;
}

/** A token-file assignment word a label can carry: `NAME=` of SCRATCH_TOKEN_FILE_ENV, then plain path, quote and `$R` characters (no blank, comma or bracket). */
const LABEL_WORD = /^(?:"?)([A-Z][A-Z0-9_]*)=[A-Za-z0-9_./${}"'+:=-]+$/;

/** Whether `word` can stand in a scratch-instance label (LABEL_WORD) as a token-file assignment. */
export function scratchLabelWord(word: string): boolean {
  const m = LABEL_WORD.exec(word);
  return !!m && SCRATCH_TOKEN_FILE_ENV.has(m[1]!);
}

const LABEL = /^\[isolated scratch instance under (\/[A-Za-z0-9._/-]+?)(?:; ([^\s,\]]+(?:, [^\s,\]]+)*) there)?\] /;

/**
 * The scratch instance a floor reason (the question's first paragraph after
 * the category, high-risk label already cut) opens with, and the reason
 * without it. floorQuestion writes the label ahead of the reason and keeps a
 * reason from spelling it, so it is the collector's own.
 */
export function splitScratchLabel(reason: string): { scratch: ScratchInstance | null; reason: string } {
  const m = LABEL.exec(reason);
  if (!m || !plainScratchRoot(m[1]!)) return { scratch: null, reason };
  const words = m[2] ? m[2].split(", ") : [];
  if (!words.every(scratchLabelWord)) return { scratch: null, reason };
  return { scratch: { root: m[1]!, assignments: words }, reason: reason.slice(m[0].length) };
}

/** `text` as a regular expression's literal source. */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** A shell word's edges: the start or end of the text, a blank, or an operator. */
const WORD_EDGE_BEFORE = "(?<![^\\s;&|()])";
const WORD_EDGE_AFTER = "(?![^\\s;&|()])";

/** How many times `command` spells `word` as a whole word (WORD_EDGE_BEFORE, WORD_EDGE_AFTER). */
export function wordCount(command: string, word: string): number {
  return command.match(new RegExp(`${WORD_EDGE_BEFORE}${literal(word)}${WORD_EDGE_AFTER}`, "g"))?.length ?? 0;
}

/**
 * `command` with each token-file assignment word the floor vouched for
 * (ScratchInstance.assignments: the word as the command spells it, once for
 * each scratch-instance run the floor read it in) written as
 * `<scratch-token-file>`: the floor resolved those values under the scratch
 * root. Only exact whole words are rewritten, and only when the command spells
 * each exactly as many times as the floor read it. If, after that, the
 * command still spells any token-file assignment (`NAME=`, read with its
 * quotes and backslashes dropped, as the shell joins them) the floor didn't
 * vouch for, in a script's text, a here-doc, a program's argument, the
 * command is left as written. Every other word is left as written, so a read
 * of the same file by its path still reads as one.
 */
export function withoutScratchAssignments(command: string, scratch: ScratchInstance | null | undefined): string {
  if (!scratch || scratch.assignments.length === 0) return command;
  let out = command;
  for (const word of new Set(scratch.assignments)) {
    const re = new RegExp(`${WORD_EDGE_BEFORE}${literal(word)}${WORD_EDGE_AFTER}`, "g");
    const vouched = scratch.assignments.filter((w) => w === word).length;
    if ((out.match(re)?.length ?? 0) !== vouched) return command;
    out = out.replace(re, "<scratch-token-file>");
  }
  const joined = out.replace(/\\\r?\n/g, "").replace(/["'\\]/g, "");
  for (const name of SCRATCH_TOKEN_FILE_ENV) if (new RegExp(`${name}\\s*=`).test(joined)) return command;
  return out;
}
