import { spawn, which } from "bun";
import { existsSync, readdirSync, realpathSync, statSync } from "fs";
import { homedir, tmpdir } from "os";
import { basename, delimiter, isAbsolute, join, relative, resolve, sep } from "path";
import {
  contains,
  hasHiddenSegment,
  isSecretFileName,
  inSearchScope,
  type CodeSearchMatch,
  type WalkOutcome,
  type WalkRequest,
} from "./code-search-walk.js";
import { homeCredentialPaths, homeSecretFile } from "./floor/home-credentials.js";
import { internalRoot } from "./internal-cwd.js";
import { activeOrgProfile } from "./org-profile/load.js";
import type { OrgProfile } from "./org-profile/types.js";

export type { CodeSearchMatch } from "./code-search-walk.js";

/**
 * Pattern search over a repository, with ripgrep as the fast path and two
 * fallbacks behind it, for hosts without ripgrep installed:
 *
 *   1. `rg`, resolved from STANDUP_RG_PATH, PATH, then the usual install dirs.
 *   2. `git grep` when the search root is inside a git work tree.
 *   3. a pure-JS walker, run in a Worker that is terminated at the deadline.
 *
 * Every result carries the `backend` that produced it and a `status` — "ok" for
 * ripgrep, "degraded" for either fallback, "unavailable" when nothing could run
 * (or nothing was found before the time budget ran out) — so a caller can
 * report which engine answered rather than presenting a fallback's narrower
 * view as the full one. `fallbackReason` says why a faster engine did not.
 *
 * The three engines are not identical, and the differences are bounded
 * deliberately:
 *
 *   - Regex dialect. ripgrep uses the Rust regex crate, `git grep -E` POSIX
 *     ERE, the walker JavaScript's RegExp. The patterns this codebase generates
 *     are alternations of escaped literal terms (see `literalAlternation`),
 *     which mean the same thing in all three. An arbitrary caller pattern is
 *     passed through as written; when a fallback's engine rejects it the search
 *     drops to the next backend rather than erroring. Only the walker runs a
 *     backtracking engine in-process, which is why it runs off the event loop.
 *   - Which files are searched. All three skip hidden entries below the searched
 *     path (ripgrep's default). `git grep` and the walker inside a work tree see
 *     tracked files plus untracked-not-ignored ones; the walker outside a work
 *     tree honors .gitignore files and skips vendor/build directory names and
 *     binary files.
 *
 * No backend returns anything outside the given root: the path argument and
 * glob arguments are rejected when they escape it, the walker never follows
 * symlinks, and every match is re-checked against the root afterwards. On top of
 * that boundary, some directories are never searched at all — Standup's own
 * knowledge and data directories (unreviewed drafts, the live DB) and the
 * well-known credential stores under the home directory (see protectedPaths).
 * A search rooted inside one of them is refused; one rooted above one of them
 * skips it. See knowledge-isolation.test.ts.
 */

export type CodeSearchBackend = "rg" | "git-grep" | "js";

export type CodeSearchStatus = "ok" | "degraded" | "unavailable";

export interface CodeSearchOptions {
  /** Regex, in the dialect shared by the three engines (see literalAlternation). */
  pattern: string;
  /** Search root. Nothing outside it is ever read. */
  cwd: string;
  /** Subpath of `cwd` to search; defaults to the whole root. */
  path?: string;
  caseInsensitive?: boolean;
  /** Per-file match cap, like `rg --max-count`. */
  maxCount?: number;
  /** Total line budget across all files (see the note on budget spending). */
  maxMatches?: number;
  /** Globs to skip, matched against the path relative to the root. */
  excludes?: string[];
  /** Globs to restrict the search to, matched against the path relative to the root. */
  includes?: string[];
  /** Files larger than this are skipped by the walker. */
  maxBytes?: number;
  timeoutMs?: number;
}

export interface CodeSearchResult {
  matches: CodeSearchMatch[];
  backend: CodeSearchBackend;
  status: CodeSearchStatus;
  truncated: boolean;
  error?: string;
  /** Why a faster backend did not answer, when a fallback did. */
  fallbackReason?: string;
}

/**
 * Default line budget, sized for the agent-facing `ripgrep` tool where the
 * results go straight into a context window.
 *
 * Retrieval callers that aggregate matches rather than showing them should pass
 * their own, much larger, budget — see the note on `maxMatches` below.
 */
const DEFAULT_MAX_MATCHES = 200;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 1_000_000;

/**
 * How long past its deadline a walker Worker is given to report before it is
 * terminated. The walker checks the deadline before every line, so a healthy
 * one reports well inside this; only a pattern stuck inside one line needs it.
 */
const WALKER_GRACE_MS = 30;

/** How long stderr is still read after the search process has exited. */
const STDERR_GRACE_MS = 200;

/** Where a `rg` binary tends to live when it is not on PATH. */
const RG_INSTALL_PATHS = [
  "/usr/bin/rg",
  "/usr/local/bin/rg",
  "/opt/homebrew/bin/rg",
  "/home/linuxbrew/.linuxbrew/bin/rg",
  "/snap/bin/rg",
];

const WALKER_URL = new URL("./code-search-worker.ts", import.meta.url).href;

/**
 * Walker Workers allowed to run at once. A terminated Worker can keep its
 * thread busy for a while after its deadline, so without a cap a burst of
 * pathological searches multiplies threads and CPU; past the cap a search
 * waits for a slot, within its own deadline.
 */
const MAX_CONCURRENT_WALKERS = 4;

/** Longest a terminated walker's slot stays held while waiting for its "close". */
const WALKER_RELEASE_BACKSTOP_MS = 5_000;

/**
 * The home directory, read from HOME on every call so each path rule here
 * agrees on one value (and a test can point it at a temporary directory).
 */
export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME || homedir();
}

/**
 * Escapes each term and joins them into an alternation, so the generated
 * pattern means the same thing to the Rust regex crate, POSIX ERE and
 * JavaScript RegExp. Callers that build a pattern from query terms use this
 * rather than a bare `terms.join("|")`, which breaks on any term carrying a
 * metacharacter and breaks differently per engine.
 */
export function literalAlternation(terms: readonly string[]): string {
  return terms.map((t) => t.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")).join("|");
}

/**
 * Path to a usable `rg`, or null. STANDUP_RG_PATH wins — it is both the
 * operator escape hatch for a non-standard install and the seam tests use to
 * simulate a host without ripgrep — then PATH, then the common install dirs.
 */
export function resolveRipgrepPath(): string | null {
  const override = process.env.STANDUP_RG_PATH;
  if (override !== undefined) {
    // An explicitly configured path that does not exist means "no ripgrep",
    // never "look somewhere else": silently searching a different binary than
    // the operator named would hide the misconfiguration.
    return override.length > 0 && isExecutableFile(override) ? override : null;
  }
  const onPath = which("rg");
  if (onPath) return onPath;
  for (const candidate of [...RG_INSTALL_PATHS, join(homeDir(), ".cargo", "bin", "rg")]) {
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Which backend a search from `cwd` would use, without running one — for the
 * knowledge health panel and the eval harness's environment record.
 */
export function detectCodeSearchBackend(cwd: string = process.cwd()): {
  backend: CodeSearchBackend;
  status: CodeSearchStatus;
  rgPath: string | null;
} {
  const rgPath = resolveRipgrepPath();
  if (rgPath) return { backend: "rg", status: "ok", rgPath };
  const proc = Bun.spawnSync(["git", "rev-parse", "--is-inside-work-tree"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode === 0 && proc.stdout.toString().trim() === "true") {
    return { backend: "git-grep", status: "degraded", rgPath: null };
  }
  return { backend: "js", status: "degraded", rgPath: null };
}

/**
 * Directories and files no search ever reads, and the carve-outs inside them.
 *
 * `refused` holds Standup's knowledge directory (KNOWLEDGE_DIR and the default
 * `~/.config/standup`, where unreviewed drafts live), its data directory (the
 * live DB, internal subprocess roots) and the home directory's credential
 * stores (cloud, cluster, package-registry, VCS-host and database credentials,
 * plus the org profile's SSO dirs and cookie files).
 * `exempt` holds the one subtree of the data directory that is real
 * work: the worktrees Standup provisions for launched sessions, which are
 * searched like any other checkout.
 *
 * The home directory comes from homeDir, so a test can point it at a
 * temporary directory.
 */
export function protectedPaths(
  env: NodeJS.ProcessEnv = process.env,
  profile: OrgProfile = activeOrgProfile()
): {
  refused: string[];
  exempt: string[];
} {
  const home = homeDir(env);
  const dataDir = join(home, ".local", "share", "standup");
  const refused = [
    join(home, ".config", "standup"),
    dataDir,
    internalRoot(env),
    ...homeCredentialPaths(profile).map((rel) => join(home, ...rel.split("/"))),
  ];
  if (env.KNOWLEDGE_DIR) refused.push(resolve(env.KNOWLEDGE_DIR));
  if (env.DB_PATH) {
    const db = resolve(env.DB_PATH);
    refused.push(db, `${db}-wal`, `${db}-shm`);
  }
  return {
    refused: withRealPaths(refused),
    exempt: withRealPaths([join(dataDir, "worktrees")]),
  };
}

/** Each path as given and, when it exists through a symlink, as its real path too. */
function withRealPaths(paths: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    out.add(p);
    try {
      out.add(realpathSync(p));
    } catch {
      // Not present on this host; the given path still guards a later creation.
    }
  }
  return [...out];
}

/**
 * Why `absolute` may not be searched, or null when it may: it lies inside a
 * refused path and not inside an exempt subtree of one.
 */
export function refusedReason(absolute: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const { refused, exempt } = protectedPaths(env);
  if (exempt.some((p) => contains(p, absolute))) return null;
  const hit = refused.find((p) => contains(p, absolute));
  if (hit) return `refusing to search ${absolute}: it is inside ${hit}, which holds Standup's own data or credentials`;
  if (homeSecretStores(env)(absolute)) {
    return `refusing to search ${absolute}: it is a cookie store or a credential or token cache below the home directory, which signs requests in as its owner`;
  }
  return null;
}

/**
 * A test for cookie stores and credential or token caches below one of the
 * home directory's dot entries (homeSecretFile): the same files the safety
 * floor holds as home secrets under every org profile, whether or not the
 * profile names the tool that wrote them. The worktrees Standup provisions
 * are searched like any other checkout.
 */
export function homeSecretStores(env: NodeJS.ProcessEnv = process.env): (absolute: string) => boolean {
  const { exempt } = protectedPaths(env);
  const homes = withRealPaths([homeDir(env)]);
  return (absolute) =>
    !exempt.some((p) => contains(p, absolute)) &&
    homes.some(
      (home) => absolute !== home && contains(home, absolute) && homeSecretFile(toPosix(relative(home, absolute)))
    );
}

/**
 * System configuration and kernel trees, which hold host secrets and never a
 * checkout. (Not /var or /tmp: temp dirs and macOS's per-user /var/folders
 * hold legitimate scratch checkouts.)
 */
const SYSTEM_DIRS = ["/etc", "/private/etc", "/proc", "/sys", "/dev", "/boot", "/run"];

/**
 * Why `absolute` is too broad to search from, or null when it is not: the
 * filesystem root, the home directory, an ancestor of either, any user's home
 * directory, a path inside another user's home, or a system directory. A project repo or session
 * cwd under the home directory is fine; the home directory itself is where
 * every credential store, browser profile and config of the user lives, which
 * no code search needs to sweep.
 */
export function broadRootReason(absolute: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const own = withRealPaths([homeDir(env)]);
  const others: string[] = [];
  for (const base of ["/home", "/Users"]) {
    let entries: string[] = [];
    try {
      entries = readdirSync(base);
    } catch {
      continue;
    }
    for (const name of entries) {
      const real = realOrResolved(join(base, name));
      if (!own.includes(real)) others.push(join(base, name), real);
    }
  }
  if (!own.includes("/root")) others.push("/root");
  const candidate = realOrResolved(absolute);
  if ([...own, ...others].some((home) => contains(candidate, home))) {
    return `refusing to search ${absolute}: it is a home directory, the filesystem root, or above one`;
  }
  // A home's top-level dot-directories (~/.config, ~/.local, ~/.claude, …) hold
  // config, tokens and app state, never a checkout — except the worktrees
  // Standup provisions under its data directory.
  const ownHome = own.find((home) => contains(home, candidate));
  if (ownHome) {
    const top = relative(ownHome, candidate).split(sep)[0];
    const exempt = withRealPaths([join(homeDir(env), ".local", "share", "standup", "worktrees")]);
    if (top.startsWith(".") && !exempt.some((p) => contains(p, candidate))) {
      return `refusing to search ${absolute}: it is inside ${join(ownHome, top)}, a home dot-directory`;
    }
  }
  if (others.some((home) => contains(home, candidate))) {
    return `refusing to search ${absolute}: it is inside another user's home directory`;
  }
  const system = SYSTEM_DIRS.find((dir) => contains(dir, candidate));
  if (system) return `refusing to search ${absolute}: it is inside the system directory ${system}`;
  return null;
}

/**
 * A temp dir code search searches a checkout in: the temp dir, unless
 * broadRootReason refuses a dir in it (a launched worker's TMPDIR is in the
 * owner's home, under ~/.cache), then /tmp. It is checked under the real HOME
 * and under a stand-in one, so it holds for a search run with either. Spelled
 * as its real path, the one git and the search report.
 */
export function searchableTempDir(): string {
  const dir = realpathSync(tmpdir());
  const checkout = join(dir, "checkout");
  const searchable = broadRootReason(checkout) === null && broadRootReason(checkout, { ...process.env, HOME: join(dir, "home") }) === null;
  return searchable ? dir : realpathSync("/tmp");
}

/**
 * Extra roots an operator (or the eval harness) allows code search to run in,
 * beyond registered project repos and the calling session's cwd —
 * STANDUP_CODE_SEARCH_ROOTS, a PATH-style list.
 */
export function extraCodeSearchRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.STANDUP_CODE_SEARCH_ROOTS ?? "")
    .split(delimiter)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Whether `cwd` is one of `roots` or below one, comparing real paths so a
 * symlinked mount of the same checkout still matches. A leading `~` in a root
 * is expanded, as project repo paths are written with one.
 */
export function isWithinRoots(cwd: string, roots: readonly string[]): boolean {
  if (!cwd) return false;
  const candidate = realOrResolved(cwd);
  return roots.some((root) => {
    if (!root) return false;
    const expanded = root.replace(/^~(?=$|\/)/, homeDir());
    return contains(realOrResolved(expanded), candidate);
  });
}

function realOrResolved(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

export async function searchCode(options: CodeSearchOptions): Promise<CodeSearchResult> {
  const {
    pattern,
    cwd,
    path = ".",
    caseInsensitive = false,
    maxCount,
    maxMatches = DEFAULT_MAX_MATCHES,
    excludes = [],
    includes = [],
    maxBytes = DEFAULT_MAX_BYTES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;
  const deadline = nowAbsolute() + timeoutMs;

  const root = resolveRoot(cwd);
  if (!root) {
    return unavailable("js", `search root does not exist: ${cwd}`);
  }
  const target = resolveWithin(root, path);
  if (!target) {
    return unavailable("js", `path escapes the search root: ${path}`);
  }
  const escaping = [...includes, ...excludes].find(escapesRoot);
  if (escaping !== undefined) {
    return unavailable("js", `glob escapes the search root: ${escaping}`);
  }
  const refusal =
    broadRootReason(root) ??
    broadRootReason(target.absolute) ??
    refusedReason(root) ??
    refusedReason(target.absolute) ??
    (isSecretFileName(basename(target.absolute))
      ? `refusing to search ${target.absolute}: it is named like a credentials or history file`
      : null);
  if (refusal) return unavailable("js", refusal);

  // Refused paths below the root are skipped by every backend at the source
  // and filtered from their output again afterwards. Cookie stores and
  // credential caches are told by name, so their lines are dropped from the
  // output.
  const refusedBelow = protectedPaths().refused.filter((p) => p !== root && contains(root, p));
  const secretStore = homeSecretStores();
  const inScope = (m: CodeSearchMatch): boolean => {
    const absolute = resolve(root, m.file);
    return inSearchScope(root, target.absolute, refusedBelow, absolute) && !secretStore(absolute);
  };
  const searchHidden = hasHiddenSegment(root, target.absolute);
  const remaining = (): number => Math.max(0, deadline - nowAbsolute());

  let fallbackReason: string | undefined;
  const rgPath = resolveRipgrepPath();
  if (!rgPath) {
    fallbackReason = "ripgrep is not installed on this host";
  } else {
    const spawned = await runGrepProcess(
      [
        rgPath,
        "--line-number",
        "--no-heading",
        "--color=never",
        ...(caseInsensitive ? ["-i"] : []),
        ...(maxCount !== undefined ? ["--max-count", String(maxCount)] : []),
        ...excludes.flatMap((g) => ["--glob", `!${g}`]),
        ...includes.flatMap((g) => ["--glob", g]),
        ...refusedBelow.flatMap((p) => {
          const rel = toPosix(relative(root, p));
          return ["--glob", `!/${rel}`, "--glob", `!/${rel}/**`];
        }),
        "--regexp",
        pattern,
        "--",
        target.argument,
      ],
      root,
      remaining(),
      maxMatches
    );
    // rg exits 1 when there are no matches, and 2 when any file could not be
    // read — matches it did print are still real.
    if (spawned.ok || spawned.exitCode === 1 || (spawned.exitCode === 2 && spawned.stdout.length > 0)) {
      const result = applyBudget(parseColonSeparated(spawned.stdout).filter(inScope), maxMatches, "rg", "ok", spawned);
      return spawned.exitCode === 2 && !result.error
        ? { ...result, error: `ripgrep reported errors: ${firstLine(spawned.stderr)}` }
        : result;
    }
    fallbackReason = `ripgrep could not run this search: ${firstLine(spawned.stderr) || `exit ${spawned.exitCode}`}`;
  }

  const inGit = await isGitWorkTree(root);
  const ere = toPosixEre(pattern);
  if (inGit && ere === null) {
    fallbackReason = `${fallbackReason}; git grep cannot express this pattern in POSIX ERE`;
  } else if (inGit && ere !== null) {
    const spawned = await runGrepProcess(
      [
        "git",
        "grep",
        "-z",
        "--line-number",
        "-I",
        "--no-color",
        "--untracked",
        "-E",
        ...(caseInsensitive ? ["-i"] : []),
        ...(maxCount !== undefined ? ["-m", String(maxCount)] : []),
        "-e",
        ere,
        "--",
        ...gitPathspecs(root, target.argument, includes, excludes, refusedBelow, searchHidden),
      ],
      root,
      remaining(),
      maxMatches
    );
    // git grep exits 1 on no matches; 128 means it rejected the pattern or the
    // pathspec, which the walker may still be able to run.
    if (spawned.ok || spawned.exitCode === 1) {
      const parsed = await dropPhantomLastLines(root, parseNulSeparated(spawned.stdout).filter(inScope));
      return withFallbackReason(
        applyBudget(
          asRipgrepPaths(parsed, target.argument),
          maxMatches,
          "git-grep",
          "degraded",
          spawned
        ),
        fallbackReason
      );
    }
    fallbackReason = `${fallbackReason}; git grep could not run this search: ${
      firstLine(spawned.stderr) || `exit ${spawned.exitCode}`
    }`;
  }

  const flags = caseInsensitive ? "i" : "";
  try {
    new RegExp(pattern, flags);
  } catch {
    return withFallbackReason(unavailable("js", `unsupported search pattern: ${pattern}`), fallbackReason);
  }
  const files = inGit ? await gitFileList(root, target.argument, remaining()) : undefined;
  const walked = await runWalker({
    root,
    target: target.absolute,
    ...(files ? { files } : {}),
    pattern,
    flags,
    maxCount,
    maxMatches,
    excludes,
    includes,
    maxBytes,
    deadlineAt: deadline,
    refused: refusedBelow,
  });
  if (walked.error) {
    return withFallbackReason(
      { matches: [], backend: "js", status: "unavailable", truncated: walked.truncated, error: walked.error },
      fallbackReason
    );
  }
  const result = applyBudget(
    asRipgrepPaths(walked.matches, target.argument).filter(inScope),
    maxMatches,
    "js",
    "degraded",
    { ok: true, exitCode: 0, stdout: "", stderr: "", timedOut: walked.timedOut, stoppedEarly: false }
  );
  return withFallbackReason(walked.truncated ? { ...result, truncated: true } : result, fallbackReason);
}

/**
 * Wall-clock milliseconds on the monotonic clock: comparable between the main
 * thread and a Worker (each has its own timeOrigin), and unaffected by a test
 * that freezes Date.
 */
function nowAbsolute(): number {
  return performance.timeOrigin + performance.now();
}

const CLASS_ESCAPES: Record<string, string> = { d: "0-9", s: "[:space:]", w: "[:alnum:]_" };
const NEGATED_CLASS_ESCAPES: Record<string, string> = { D: "0-9", S: "[:space:]", W: "[:alnum:]_" };

/**
 * `pattern` rewritten for `git grep -E` (POSIX ERE), or null when it uses a
 * construct ERE cannot express the same way, in which case the walker runs it.
 *
 * ERE has no `\d`, and GNU's `\s`/`\w` are extensions, so the shorthand classes
 * become bracket expressions. Without this, ERE reads `\d` as a literal `d` and
 * reports no matches rather than rejecting the pattern. Groups with `(?`,
 * other letter or digit escapes (`\t`, `\x41`, `\p{..}`, backreferences) and
 * bracket contents whose meaning differs between the dialects (POSIX classes,
 * a leading `]`, escapes inside brackets other than the shorthands) return
 * null.
 */
export function toPosixEre(pattern: string): string | null {
  let out = "";
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      const next = pattern[i + 1];
      if (next === undefined) return null;
      i++;
      if (CLASS_ESCAPES[next]) {
        out += inClass ? CLASS_ESCAPES[next] : `[${CLASS_ESCAPES[next]}]`;
      } else if (NEGATED_CLASS_ESCAPES[next]) {
        if (inClass) return null;
        out += `[^${NEGATED_CLASS_ESCAPES[next]}]`;
      } else if (/[A-Za-z0-9]/.test(next)) {
        // Word boundaries are the one letter escape GNU ERE shares with JS.
        if (inClass || (next !== "b" && next !== "B")) return null;
        out += `\\${next}`;
      } else if (inClass) {
        // A backslash is literal inside a POSIX bracket expression, so the
        // escaped character is written bare — except those whose bare form
        // would change the bracket's meaning.
        if ("]^-\\[".includes(next)) return null;
        out += next;
      } else {
        out += `\\${next}`;
      }
      continue;
    }
    if (inClass) {
      if (ch === "[" && /[:.=]/.test(pattern[i + 1] ?? "")) return null;
      if (ch === "]") inClass = false;
      out += ch;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      out += ch;
      if (pattern[i + 1] === "^") {
        out += "^";
        i++;
      }
      if (pattern[i + 1] === "]") return null;
      continue;
    }
    if (ch === "(" && pattern[i + 1] === "?") return null;
    out += ch;
  }
  return inClass ? null : out;
}

function unavailable(backend: CodeSearchBackend, error: string): CodeSearchResult {
  return { matches: [], backend, status: "unavailable", truncated: false, error };
}

function withFallbackReason(result: CodeSearchResult, reason: string | undefined): CodeSearchResult {
  return reason ? { ...result, fallbackReason: reason } : result;
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

function toPosix(rel: string): string {
  return sep === "/" ? rel : rel.split(sep).join("/");
}

/** A glob that could address a path outside the root it is matched under. */
function escapesRoot(glob: string): boolean {
  return glob.startsWith("/") || glob.startsWith("~") || glob.split("/").includes("..");
}

function isExecutableFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The search root as a real path, or null when it does not exist. */
function resolveRoot(cwd: string): string | null {
  if (!cwd) return null;
  try {
    return realpathSync(resolve(cwd));
  } catch {
    return null;
  }
}

/**
 * Resolves `path` inside `root`, rejecting anything that leaves it — `..`
 * segments, an absolute path elsewhere, or a symlink pointing out of the tree.
 * Returns both the absolute path (for the walker) and the root-relative form to
 * hand a subprocess, so neither can be talked into reading a sibling directory.
 */
function resolveWithin(root: string, path: string): { absolute: string; argument: string } | null {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path);
  if (!contains(root, absolute)) return null;
  // Resolve symlinks too, but only when the path exists: a not-yet-created
  // path is harmless, and rejecting it would differ from rg's "no such file".
  if (existsSync(absolute)) {
    let real: string;
    try {
      real = realpathSync(absolute);
    } catch {
      return null;
    }
    if (!contains(root, real)) return null;
  }
  const rel = relative(root, absolute);
  return { absolute, argument: rel === "" ? "." : toPosix(rel) };
}

async function isGitWorkTree(cwd: string): Promise<boolean> {
  try {
    const proc = spawn(["git", "rev-parse", "--is-inside-work-tree"], { cwd, stdout: "pipe", stderr: "pipe" });
    const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return proc.exitCode === 0 && stdout.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Pathspecs for `git grep`, relative to the root it runs in. git ORs positive
 * pathspecs, so include globs replace the searched path rather than joining it
 * (a `.` beside them would match everything); a basename include is anchored
 * under the searched path, and the scope filter drops anything a path-shaped
 * include matched outside it. Exclusions (caller globs, hidden entries, refused
 * directories) are ANDed on by git.
 */
function gitPathspecs(
  root: string,
  argument: string,
  includes: readonly string[],
  excludes: readonly string[],
  refusedBelow: readonly string[],
  searchHidden: boolean
): string[] {
  const under = argument === "." ? "" : `${argument}/`;
  const positive =
    includes.length > 0
      ? includes.map((g) => (g.includes("/") ? `:(glob)${g}` : `:(glob)${under}**/${g}`))
      : [argument];
  return [
    ...positive,
    ...excludes.map((g) => `:(exclude,glob)${gitGlob(g)}`),
    // The searched path itself may be hidden (an explicit `.github`); only
    // what is below it is skipped, which the scope filter enforces.
    ...(searchHidden ? [] : [":(exclude,glob)**/.*", ":(exclude,glob)**/.*/**"]),
    ...refusedBelow.map((p) => `:(exclude)${toPosix(relative(root, p))}`),
  ];
}

/**
 * Root-relative files a git work tree holds under `argument`: tracked plus
 * untracked-not-ignored, the same set `git grep --untracked` searches. Null when
 * git cannot list them, in which case the walker reads the tree itself.
 */
async function gitFileList(root: string, argument: string, timeoutMs: number): Promise<string[] | undefined> {
  const listed = await runGrepProcess(
    ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", argument],
    root,
    timeoutMs,
    Number.POSITIVE_INFINITY
  );
  if (!listed.ok || listed.timedOut) return undefined;
  return [...new Set(listed.stdout.split("\0").filter((f) => f.length > 0))];
}

interface SpawnOutcome {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Killed after printing more lines than the budget could use. */
  stoppedEarly: boolean;
}

function spawnPiped(args: string[], cwd: string) {
  return spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
}

/**
 * Runs a search subprocess, streaming its stdout and killing it once it has
 * printed one line more than `maxLines` (enough for the budget to know it was
 * cut) or when `timeoutMs` runs out.
 */
async function runGrepProcess(
  args: string[],
  cwd: string,
  timeoutMs: number,
  maxLines: number
): Promise<SpawnOutcome> {
  const spawned = ((): { proc: ReturnType<typeof spawnPiped> } | { error: string } => {
    try {
      return { proc: spawnPiped(args, cwd) };
    } catch (err) {
      // A binary that vanished between resolution and spawn, or an unreadable
      // cwd: treat as "this backend cannot run" so the next one is tried.
      return { error: String(err) };
    }
  })();
  if ("error" in spawned) {
    return { ok: false, exitCode: null, stdout: "", stderr: spawned.error, timedOut: false, stoppedEarly: false };
  }
  const proc = spawned.proc;
  let timedOut = false;
  let stoppedEarly = false;
  const reader = proc.stdout.getReader();
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
    // A child the process spawned can hold the pipe open after the kill, so
    // the read is cancelled rather than left waiting for that child to exit.
    void reader.cancel().catch(() => {});
  }, timeoutMs);

  const readStdout = async (): Promise<string> => {
    const decoder = new TextDecoder();
    let text = "";
    let lines = 0;
    for (;;) {
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        next = await reader.read();
      } catch {
        break;
      }
      if (next.done) break;
      const chunk = decoder.decode(next.value, { stream: true });
      text += chunk;
      for (let i = chunk.indexOf("\n"); i !== -1; i = chunk.indexOf("\n", i + 1)) lines++;
      if (lines > maxLines) {
        stoppedEarly = true;
        proc.kill();
        void reader.cancel().catch(() => {});
        break;
      }
    }
    return text + decoder.decode();
  };
  // Both pipes are drained concurrently: a process that fills its stderr pipe
  // while nobody reads it would otherwise block until the timeout.
  const stderrText = new Response(proc.stderr).text();
  const stdout = await readStdout();
  await proc.exited;
  // Once the process is gone, stderr is waited on only briefly: after a kill a
  // surviving child may still hold it open.
  const stderr = await Promise.race([
    stderrText,
    Bun.sleep(STDERR_GRACE_MS).then(() => ""),
  ]);
  clearTimeout(timer);
  return {
    // A killed process has whatever it had already written, which is a
    // truncated result rather than a failure.
    ok: proc.exitCode === 0 || timedOut || stoppedEarly,
    exitCode: proc.exitCode,
    // Only complete lines: a kill can land mid-line.
    stdout: stoppedEarly || timedOut ? stdout.slice(0, stdout.lastIndexOf("\n") + 1) : stdout,
    stderr,
    timedOut,
    stoppedEarly,
  };
}

let activeWalkers = 0;
const walkerQueue: Array<() => void> = [];

/**
 * Waits for one of the MAX_CONCURRENT_WALKERS slots, giving up (false) if none
 * frees before `deadlineAt`.
 */
function acquireWalkerSlot(deadlineAt: number): Promise<boolean> {
  if (activeWalkers < MAX_CONCURRENT_WALKERS) {
    activeWalkers++;
    return Promise.resolve(true);
  }
  return new Promise((resolvePromise) => {
    const grant = (): void => {
      clearTimeout(timer);
      activeWalkers++;
      resolvePromise(true);
    };
    const timer = setTimeout(() => {
      const at = walkerQueue.indexOf(grant);
      if (at >= 0) walkerQueue.splice(at, 1);
      resolvePromise(false);
    }, Math.max(0, deadlineAt - nowAbsolute()));
    walkerQueue.push(grant);
  });
}

function releaseWalkerSlot(): void {
  activeWalkers--;
  walkerQueue.shift()?.();
}

/**
 * Runs the JS walker in a Worker and terminates it at the deadline (plus a short
 * grace for its final message). The walker is synchronous and runs the
 * caller's regex, so a catastrophically backtracking pattern can spin inside
 * one line indefinitely; terminating the Worker is what bounds it, and the
 * event loop keeps serving meanwhile. The Worker checks the same absolute
 * deadline the kill timer is set from.
 */
async function runWalker(
  request: WalkRequest
): Promise<WalkOutcome & { matches: CodeSearchMatch[]; error?: string }> {
  if (!(await acquireWalkerSlot(request.deadlineAt))) {
    return { matches: [], truncated: true, timedOut: true };
  }
  return new Promise((resolvePromise) => {
    const matches: CodeSearchMatch[] = [];
    let worker: Worker;
    try {
      worker = new Worker(WALKER_URL);
    } catch (err) {
      releaseWalkerSlot();
      resolvePromise({ matches, truncated: false, timedOut: false, error: `search worker could not start: ${err}` });
      return;
    }
    // The slot is freed when the Worker's thread has actually stopped ("close"),
    // not when it is told to: a terminated Worker can spin inside one regex for
    // a while first, and counting it free then would let threads pile up. The
    // backstop frees it regardless, so a close that never arrives can't leak it.
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      clearTimeout(backstop);
      releaseWalkerSlot();
    };
    let backstop: ReturnType<typeof setTimeout> | undefined;
    worker.addEventListener("close", release);
    let settled = false;
    const finish = (outcome: WalkOutcome & { error?: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      backstop = setTimeout(release, WALKER_RELEASE_BACKSTOP_MS);
      resolvePromise({ matches, ...outcome });
    };
    const timer = setTimeout(
      () => finish({ truncated: true, timedOut: true }),
      Math.max(0, request.deadlineAt - nowAbsolute()) + WALKER_GRACE_MS
    );
    worker.onmessage = (event: MessageEvent) => {
      const data = event.data as
        | { type: "matches"; matches: CodeSearchMatch[] }
        | ({ type: "done" } & WalkOutcome);
      if (data.type === "matches") matches.push(...data.matches);
      else finish({ truncated: data.truncated, timedOut: data.timedOut });
    };
    worker.onerror = (event: ErrorEvent) => {
      finish({ truncated: true, timedOut: false, error: `search worker failed: ${event.message}` });
    };
    worker.postMessage(request);
  });
}

/** `path:line:text`, as rg and plain `grep -n` emit it. */
function parseColonSeparated(stdout: string): CodeSearchMatch[] {
  const matches: CodeSearchMatch[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const m = line.match(/^(.+?):(\d+):(.*)$/);
    if (!m) continue;
    matches.push({ file: m[1], line: parseInt(m[2], 10), text: m[3] });
  }
  return matches;
}

/**
 * `path\0line\0text\n`, which is what `git grep -z` emits. The NUL separators
 * are what make a path containing a colon parse correctly, so the git backend
 * asks for them rather than reusing the colon format.
 */
function parseNulSeparated(stdout: string): CodeSearchMatch[] {
  const matches: CodeSearchMatch[] = [];
  for (const record of stdout.split("\n")) {
    if (!record) continue;
    const parts = record.split("\0");
    if (parts.length < 3) continue;
    const line = parseInt(parts[1], 10);
    if (!Number.isFinite(line)) continue;
    matches.push({ file: parts[0], line, text: parts.slice(2).join("\0") });
  }
  return matches;
}

/**
 * Removes the empty "line" `git grep` reports past a file's final newline when
 * the pattern matches the empty string (`^$`); ripgrep treats that newline as
 * ending the last line, not starting another. Only empty-text matches are
 * checked, so this costs a read only for patterns that can match nothing.
 */
async function dropPhantomLastLines(root: string, matches: CodeSearchMatch[]): Promise<CodeSearchMatch[]> {
  if (!matches.some((m) => m.text === "")) return matches;
  const lineCounts = new Map<string, number>();
  const out: CodeSearchMatch[] = [];
  for (const m of matches) {
    if (m.text !== "") {
      out.push(m);
      continue;
    }
    let count = lineCounts.get(m.file);
    if (count === undefined) {
      try {
        const content = await Bun.file(resolve(root, m.file)).text();
        count = content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
      } catch {
        count = Number.POSITIVE_INFINITY;
      }
      lineCounts.set(m.file, count);
    }
    if (m.line <= count) out.push(m);
  }
  return out;
}

/**
 * Rewrites a fallback's paths into the form ripgrep would have produced, which
 * is the searched path joined with the match's location: searching "." yields
 * "./file.ts". The fallbacks report paths relative to the search root instead,
 * so a `.` search needs the prefix added; a subdirectory search already carries
 * it. Callers (and their stored excerpts) see one path shape regardless of
 * which engine answered.
 */
function asRipgrepPaths(matches: CodeSearchMatch[], argument: string): CodeSearchMatch[] {
  if (argument !== ".") return matches;
  return matches.map((m) => ({ ...m, file: m.file.startsWith("./") ? m.file : `./${m.file}` }));
}

/**
 * Spends the line budget and reports whether it ran out, preserving the
 * file-boundary rule the retrieval callers depend on.
 *
 * The budget is not merely a size limit — it decides which *files* a caller
 * ever sees, because every backend emits in traversal order and the budget is
 * spent in that order. A ranking caller that truncates here is silently ranking
 * a prefix of the repository, so callers that score results must pass a budget
 * comfortably above their real match volume.
 *
 * A search that ran out of time before finding anything is "unavailable": its
 * empty result says nothing about the tree.
 */
function applyBudget(
  all: CodeSearchMatch[],
  maxMatches: number,
  backend: CodeSearchBackend,
  status: CodeSearchStatus,
  spawned: SpawnOutcome
): CodeSearchResult {
  const matches = all.slice(0, maxMatches);
  const truncated = all.length > matches.length || spawned.timedOut || spawned.stoppedEarly;

  // Drop the trailing file when the budget cut through it. Matches arrive
  // grouped by file, so a cut mid-file leaves that file with an arbitrary
  // subset of its hits — which reads to a scoring caller as "this file mentions
  // fewer of the query's terms" and demotes it for a reason that is purely an
  // artifact of where the budget ran out. Better to omit it than to rank it on
  // a partial view.
  if (truncated && matches.length > 0) {
    const lastFile = matches[matches.length - 1].file;
    const trimmed = matches.filter((m) => m.file !== lastFile);
    // Unless it is the only file, in which case a partial view beats none.
    if (trimmed.length > 0) {
      matches.length = 0;
      matches.push(...trimmed);
    }
  }

  return {
    matches,
    backend,
    status: spawned.timedOut && matches.length === 0 ? "unavailable" : status,
    truncated,
    ...(spawned.timedOut ? { error: "code search timed out before finishing" } : {}),
  };
}

/**
 * Translates a shell-style glob into a git pathspec glob. A pattern naming only
 * a basename (`*.eval.ts`) has to be anchored with `**​/` for git to match it at
 * any depth, which is what rg's `--glob` already does.
 */
function gitGlob(glob: string): string {
  return glob.includes("/") ? glob : `**/${glob}`;
}
