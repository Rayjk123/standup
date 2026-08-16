import { spawn } from "bun";

export interface RipgrepMatch {
  file: string;
  line: number;
  text: string;
}

export interface RipgrepResult {
  matches: RipgrepMatch[];
  truncated: boolean;
}

/**
 * Default line budget, sized for the agent-facing `ripgrep` tool where the
 * results go straight into a context window.
 *
 * Retrieval callers that aggregate matches rather than showing them should
 * pass their own, much larger, budget — see the note on `maxMatches`.
 */
const MAX_MATCHES = 200;
const TIMEOUT_MS = 10_000;

// Flags that would change rg's output format and break line parsing.
const BLOCKED_FLAGS = new Set(["--json", "-l", "--files-with-matches", "-c", "--count"]);

export async function runRipgrep(
  pattern: string,
  cwd: string,
  path = ".",
  flags: string[] = [],
  /**
   * Line budget. Defaults to a size suited to showing results to an agent.
   *
   * This is not merely a size limit — it decides which *files* a caller ever
   * sees, because rg emits in traversal (alphabetical path) order and the
   * budget is spent in that order. A ranking caller that truncates here is
   * silently ranking a prefix of the repository: with the default 200 and a
   * per-file cap of 10, everything after roughly the first 20 matching files
   * is invisible, so `packages/web/` loses to `packages/collector/` on path
   * position rather than relevance. Callers that score results must pass a
   * budget comfortably above their real match volume.
   */
  maxMatches: number = MAX_MATCHES
): Promise<RipgrepResult> {
  const safeFlags = flags.filter((f) => !BLOCKED_FLAGS.has(f));

  const args = ["rg", "--line-number", "--no-heading", "--color=never", ...safeFlags, pattern, path];

  const proc = spawn(args, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeout = setTimeout(() => proc.kill(), TIMEOUT_MS);

  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  clearTimeout(timeout);

  // rg exits 1 when there are no matches — not an error.
  if (proc.exitCode !== 0 && proc.exitCode !== 1) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`ripgrep failed (exit ${proc.exitCode}): ${stderr.trim()}`);
  }

  const lines = stdout.split("\n").filter(Boolean);
  const matches: RipgrepMatch[] = [];

  for (const line of lines) {
    // Format: path:lineNumber:text
    const match = line.match(/^(.+?):(\d+):(.*)$/);
    if (!match) continue;

    matches.push({
      file: match[1],
      line: parseInt(match[2], 10),
      text: match[3],
    });

    if (matches.length >= maxMatches) break;
  }

  let truncated = lines.length > matches.length;

  // Drop the trailing file when the budget cut through it. rg emits all of a
  // file's matches together, so a cut mid-file leaves that file with an
  // arbitrary subset of its hits — which reads to a scoring caller as "this
  // file mentions fewer of the query's terms" and demotes it for a reason
  // that is purely an artifact of where the budget ran out. Better to omit it
  // than to rank it on a partial view.
  if (truncated && matches.length > 0) {
    const lastFile = matches[matches.length - 1].file;
    const trimmed = matches.filter((m) => m.file !== lastFile);
    // Unless it is the only file, in which case a partial view beats none.
    if (trimmed.length > 0) {
      matches.length = 0;
      matches.push(...trimmed);
    }
  }

  return { matches, truncated };
}
