import { lstatSync, readdirSync, readFileSync } from "fs";
import { basename, dirname, join, relative, sep } from "path";

/**
 * The pure-JS backend of code search, and the path rules every backend shares.
 *
 * `walkAndMatch` is synchronous and runs a caller-supplied regex, so it is only
 * ever run inside a Worker (code-search-worker.ts) that searchCode terminates at
 * its deadline: a pathological pattern then costs a thread that gets killed,
 * never the collector's event loop. Nothing here imports Bun's process APIs, so
 * the module loads the same in a Worker as on the main thread.
 */

export interface CodeSearchMatch {
  file: string;
  line: number;
  text: string;
}

export interface WalkRequest {
  /** Search root, as a real path. */
  root: string;
  /** Absolute path under `root` to search (a directory or one file). */
  target: string;
  /**
   * Root-relative files to search, when the caller already has the list (a git
   * work tree's tracked + untracked-not-ignored files). Without it the tree
   * under `target` is walked, honoring .gitignore files on the way down.
   */
  files?: string[];
  pattern: string;
  flags: string;
  maxCount?: number;
  maxMatches: number;
  excludes: string[];
  includes: string[];
  maxBytes: number;
  /**
   * When the walk must stop, as `performance.timeOrigin + performance.now()`:
   * an absolute time on the monotonic clock, which the caller's kill timer and
   * the Worker read alike (and which a test that freezes Date leaves alone).
   */
  deadlineAt: number;
  /** Absolute paths below `root` that are never read (see protectedPaths). */
  refused: string[];
}

export interface WalkOutcome {
  truncated: boolean;
  timedOut: boolean;
}

/** Ceiling on how many files the walker opens, so a huge tree still returns. */
const WALKER_MAX_FILES = 20_000;

/** Bytes inspected for a NUL before a file is treated as binary. */
const BINARY_SNIFF_BYTES = 8_192;

/**
 * Directories a walk outside any git work tree never descends into. With no
 * index to say what is tracked, these are skipped by name so a node_modules or
 * build tree can't dominate the budget; inside a work tree the file list comes
 * from git instead and a tracked `build/` is searched like anything else.
 */
const UNTRACKED_SKIP_DIRS = new Set([
  "node_modules",
  "build",
  "dist",
  "out",
  "target",
  "coverage",
  "venv",
  "__pycache__",
]);

/**
 * File names that hold credentials or command history wherever they appear.
 * Most are dot-files and already skipped as hidden, but naming one as the
 * searched path would otherwise reach it; the rest (`credentials`, an SSH key
 * copied into a tree) are refused by name so no backend returns their lines.
 */
const SECRET_FILE_NAMES = new Set([
  ".env",
  ".bash_history",
  ".zsh_history",
  ".sh_history",
  ".python_history",
  ".psql_history",
  ".mysql_history",
  ".node_repl_history",
  ".sqlite_history",
  "credentials",
  "credentials.json",
  ".netrc",
  "_netrc",
  ".git-credentials",
  ".pgpass",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
]);

export function contains(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Credential and shell-history file names, and every `.env.*` variant. */
export function isSecretFileName(name: string): boolean {
  return SECRET_FILE_NAMES.has(name) || name.startsWith(".env.");
}

/**
 * Whether a path below `base` passes through a dot-entry. Hidden files and
 * directories are skipped by default, as ripgrep skips them; the base itself
 * may be hidden (a session can run inside `~/.claude/worktrees/...`).
 */
export function hasHiddenSegment(base: string, absolute: string): boolean {
  const rel = relative(base, absolute);
  if (rel === "") return false;
  return rel.split(sep).some((segment) => segment.startsWith(".") && segment !== "..");
}

/**
 * The one check every backend's output goes through: inside the root and the
 * searched path, not hidden below the searched path, not a credentials file,
 * and not under a refused directory.
 */
export function inSearchScope(
  root: string,
  target: string,
  refused: readonly string[],
  absolute: string
): boolean {
  if (!contains(root, absolute) || !contains(target, absolute)) return false;
  if (hasHiddenSegment(target, absolute)) return false;
  if (isSecretFileName(basename(absolute))) return false;
  return !refused.some((p) => contains(p, absolute));
}

/** Glob → RegExp over a root-relative path, with `**` crossing directories. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // `**/` matches any number of leading directories, including none.
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if (ch === "[") {
      const parsed = bracketClass(glob, i);
      if (parsed) {
        out += parsed.regex;
        i = parsed.end;
      } else {
        out += "\\[";
      }
    } else {
      out += ch.replace(/[\\^$.+()[\]{}|]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * A glob bracket expression starting at `start` (`[abc]`, `[a-z]`, `[!x]` or
 * `[^x]`, with a leading `]` taken literally, as git and ripgrep read them) as
 * a RegExp class that never matches `/`, plus the index of its closing `]`; or
 * null when the bracket is unterminated and so a literal `[`.
 */
function bracketClass(glob: string, start: number): { regex: string; end: number } | null {
  let i = start + 1;
  const negate = glob[i] === "!" || glob[i] === "^";
  if (negate) i++;
  let body = "";
  if (glob[i] === "]") {
    body += "\\]";
    i++;
  }
  for (; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "]") return { regex: negate ? `[^/${body}]` : `(?!/)[${body}]`, end: i };
    body += ch === "\\" || ch === "[" || ch === "^" ? `\\${ch}` : ch;
  }
  return null;
}

export function globMatches(glob: string, relPath: string): boolean {
  const re = globToRegExp(glob);
  if (re.test(relPath)) return true;
  // A basename-only glob applies at any depth, as it does for rg and for the
  // git pathspec searchCode builds.
  const base = relPath.split("/").pop() ?? relPath;
  return !glob.includes("/") && re.test(base);
}

interface IgnoreRule {
  /** Root-relative directory holding the .gitignore ("" for the root). */
  base: string;
  regex: RegExp;
  /** The pattern contained a non-trailing slash, so it is anchored to `base`. */
  anchored: boolean;
  negate: boolean;
  dirOnly: boolean;
}

function parseIgnoreFile(content: string, base: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of content.split("\n")) {
    let line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const negate = line.startsWith("!");
    if (negate) line = line.slice(1);
    const dirOnly = line.endsWith("/");
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.includes("/");
    if (line.startsWith("/")) line = line.slice(1);
    if (line.length === 0) continue;
    rules.push({ base, regex: globToRegExp(line), anchored, negate, dirOnly });
  }
  return rules;
}

/** gitignore semantics, simplified: the last matching rule wins. */
function isIgnored(rules: readonly IgnoreRule[], relPath: string, isDir: boolean): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    if (rule.base !== "" && !relPath.startsWith(rule.base + "/")) continue;
    const local = rule.base === "" ? relPath : relPath.slice(rule.base.length + 1);
    const subject = rule.anchored ? local : (local.split("/").pop() ?? local);
    if (rule.regex.test(subject)) ignored = !rule.negate;
  }
  return ignored;
}

function toPosix(rel: string): string {
  return sep === "/" ? rel : rel.split(sep).join("/");
}

/**
 * Tests every line of every in-scope file against the pattern, handing each
 * file's matches to `emit` as soon as the file is done (so a search killed at
 * its deadline still has everything found before it). The deadline is checked
 * before every line, not just between files, so one large file can't overrun it.
 */
export function walkAndMatch(req: WalkRequest, emit: (matches: CodeSearchMatch[]) => void): WalkOutcome {
  const regex = new RegExp(req.pattern, req.flags);
  let emitted = 0;
  let files = 0;
  let truncated = false;
  let timedOut = false;

  const expired = (): boolean => {
    if (performance.timeOrigin + performance.now() >= req.deadlineAt) timedOut = true;
    return timedOut;
  };

  const searchFile = (absolute: string, relPath: string): void => {
    if (truncated || expired()) return;
    if (!inSearchScope(req.root, req.target, req.refused, absolute)) return;
    if (req.excludes.some((g) => globMatches(g, relPath))) return;
    if (req.includes.length > 0 && !req.includes.some((g) => globMatches(g, relPath))) return;
    if (files >= WALKER_MAX_FILES) {
      truncated = true;
      return;
    }
    let content: string;
    try {
      // lstat, so a tracked symlink is never followed out of the tree.
      const stat = lstatSync(absolute);
      if (!stat.isFile() || stat.size > req.maxBytes) return;
      files++;
      const buffer = readFileSync(absolute);
      if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return;
      content = buffer.toString("utf8");
    } catch {
      return;
    }
    const lines = content.split("\n");
    // A trailing newline terminates the last line; it does not start another.
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const found: CodeSearchMatch[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (expired()) break;
      if (!regex.test(lines[i])) continue;
      found.push({ file: relPath, line: i + 1, text: lines[i] });
      if (req.maxCount !== undefined && found.length >= req.maxCount) break;
      if (emitted + found.length > req.maxMatches) {
        truncated = true;
        break;
      }
    }
    if (found.length > 0) {
      emitted += found.length;
      emit(found);
    }
  };

  const visit = (absolute: string, inherited: readonly IgnoreRule[]): void => {
    if (truncated || expired()) return;
    let entries;
    try {
      entries = readdirSync(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    let rules = inherited;
    const relDir = toPosix(relative(req.root, absolute));
    if (entries.some((e) => e.name === ".gitignore" && e.isFile())) {
      try {
        rules = [...inherited, ...parseIgnoreFile(readFileSync(join(absolute, ".gitignore"), "utf8"), relDir)];
      } catch {
        // An unreadable .gitignore leaves the inherited rules in force.
      }
    }
    // Alphabetical, so the budget is spent the same way on every host.
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (truncated || timedOut) return;
      // Hidden entries are skipped, as ripgrep skips them by default.
      if (entry.name.startsWith(".")) continue;
      const child = join(absolute, entry.name);
      const relPath = toPosix(relative(req.root, child));
      // Symlinks are never followed: that is both how ripgrep behaves by
      // default and what keeps a link out of the tree from widening the search.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (UNTRACKED_SKIP_DIRS.has(entry.name)) continue;
        if (req.refused.some((p) => contains(p, child))) continue;
        if (isIgnored(rules, relPath, true)) continue;
        visit(child, rules);
      } else if (entry.isFile()) {
        if (isIgnored(rules, relPath, false)) continue;
        searchFile(child, relPath);
      }
    }
  };

  if (req.files) {
    for (const rel of req.files) {
      if (truncated || expired()) break;
      searchFile(join(req.root, rel), rel);
    }
    return { truncated, timedOut };
  }

  let rootStat;
  try {
    rootStat = lstatSync(req.target);
  } catch {
    return { truncated, timedOut };
  }
  const targetDir = rootStat.isDirectory() ? req.target : dirname(req.target);
  const inherited = ancestorIgnoreRules(req.root, targetDir);
  if (rootStat.isDirectory()) visit(req.target, inherited);
  else if (rootStat.isFile()) {
    const relPath = toPosix(relative(req.root, req.target));
    if (!isIgnored(inherited, relPath, false)) searchFile(req.target, relPath);
  }
  return { truncated, timedOut };
}

/**
 * The .gitignore rules of every directory from the root down to (not including)
 * `dir`, so a search of a subdirectory honors the ignores above it.
 */
function ancestorIgnoreRules(root: string, dir: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  const rel = toPosix(relative(root, dir));
  const segments = rel === "" ? [] : rel.split("/");
  for (let depth = 0; depth < segments.length; depth++) {
    const base = segments.slice(0, depth).join("/");
    try {
      rules.push(...parseIgnoreFile(readFileSync(join(root, base, ".gitignore"), "utf8"), base));
    } catch {
      // No .gitignore at this level.
    }
  }
  return rules;
}
