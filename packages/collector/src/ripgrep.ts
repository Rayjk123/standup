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

const MAX_MATCHES = 200;
const TIMEOUT_MS = 10_000;

// Flags that would change rg's output format and break line parsing.
const BLOCKED_FLAGS = new Set(["--json", "-l", "--files-with-matches", "-c", "--count"]);

export async function runRipgrep(
  pattern: string,
  cwd: string,
  path = ".",
  flags: string[] = []
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

    if (matches.length >= MAX_MATCHES) break;
  }

  return {
    matches,
    truncated: lines.length > matches.length,
  };
}
