import {
  searchCode,
  type CodeSearchBackend,
  type CodeSearchStatus,
  type CodeSearchMatch,
} from "./code-search.js";

export type RipgrepMatch = CodeSearchMatch;

export interface RipgrepResult {
  matches: RipgrepMatch[];
  truncated: boolean;
  /** Engine that answered — "rg" only when ripgrep is installed here. */
  backend: CodeSearchBackend;
  status: CodeSearchStatus;
  error?: string;
  /** Why ripgrep did not answer, when a fallback did. */
  fallbackReason?: string;
}

/**
 * Default line budget, sized for the agent-facing `ripgrep` tool where the
 * results go straight into a context window.
 *
 * Retrieval callers that aggregate matches rather than showing them should
 * pass their own, much larger, budget — see the note on `maxMatches`.
 */
const MAX_MATCHES = 200;

// Flags that would change the output format and break line parsing.
const BLOCKED_FLAGS = new Set(["--json", "-l", "--files-with-matches", "-c", "--count"]);

/**
 * rg-flavored front door to searchCode for the `ripgrep` MCP tool and
 * /api/ripgrep: it takes rg's flag vocabulary and returns their response shape,
 * while the search itself degrades to `git grep` or a JS walker on a host
 * without ripgrep. The
 * recognized flags are the ones callers actually pass: `-i`, `--max-count N`
 * and `--glob` (including rg's `!pattern` negation); anything else is dropped
 * rather than forwarded, since a flag only ripgrep understands would change the
 * result between backends.
 */
export async function runRipgrep(
  pattern: string,
  cwd: string,
  path = ".",
  flags: string[] = [],
  /**
   * Line budget. Defaults to a size suited to showing results to an agent.
   *
   * This is not merely a size limit — it decides which *files* a caller ever
   * sees, because matches arrive in traversal order and the budget is spent in
   * that order. A ranking caller that truncates here is silently ranking a
   * prefix of the repository: with the default 200 and a per-file cap of 10,
   * everything after roughly the first 20 matching files is invisible, so
   * `packages/web/` loses to `packages/collector/` on path position rather than
   * relevance. Callers that score results must pass a budget comfortably above
   * their real match volume.
   */
  maxMatches: number = MAX_MATCHES
): Promise<RipgrepResult> {
  const safeFlags = flags.filter((f) => !BLOCKED_FLAGS.has(f));

  let caseInsensitive = false;
  let maxCount: number | undefined;
  const excludes: string[] = [];
  const includes: string[] = [];

  for (let i = 0; i < safeFlags.length; i++) {
    const flag = safeFlags[i];
    if (flag === "-i" || flag === "--ignore-case") {
      caseInsensitive = true;
    } else if (flag === "--max-count" || flag === "-m") {
      const value = parseInt(safeFlags[++i] ?? "", 10);
      if (Number.isFinite(value)) maxCount = value;
    } else if (flag.startsWith("--max-count=")) {
      const value = parseInt(flag.slice("--max-count=".length), 10);
      if (Number.isFinite(value)) maxCount = value;
    } else if (flag === "--glob" || flag === "-g") {
      const glob = safeFlags[++i];
      if (!glob) continue;
      if (glob.startsWith("!")) excludes.push(glob.slice(1));
      else includes.push(glob);
    }
  }

  const result = await searchCode({
    pattern,
    cwd,
    path,
    caseInsensitive,
    maxCount,
    maxMatches,
    excludes,
    includes,
  });

  return {
    matches: result.matches,
    truncated: result.truncated,
    backend: result.backend,
    status: result.status,
    ...(result.error ? { error: result.error } : {}),
    ...(result.fallbackReason ? { fallbackReason: result.fallbackReason } : {}),
  };
}
