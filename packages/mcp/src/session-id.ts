import { readdir, stat } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

let cached: string | null = null;

function encodeProjectDir(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

/**
 * Resolves this MCP server's real Claude Code session id: CLAUDE_CODE_SESSION_ID
 * when Claude Code exports it, else by finding the transcript file it's writing to. Claude Code stores transcripts at
 * ~/.claude/projects/<cwd-with-slashes-as-dashes>/<session-uuid>.jsonl —
 * the same uuid shown by /status and used as session_id in every hook
 * payload. This is the actual identifier, not a proxy for it: cwd alone
 * can't tell two sessions in the same directory apart, but each has its own
 * transcript file.
 *
 * Resolved lazily on first use and cached rather than at module load: right
 * after the MCP server starts, the transcript may not exist yet, or may be
 * ambiguous against a session that just ended in the same directory. By the
 * time a tool is actually called, at least one turn has happened, so this
 * session's transcript reliably exists and — among any others sharing the
 * directory — is the one most recently written to.
 *
 * Returns null if no transcript can be found (unexpected layout, permission
 * issue, etc.) — callers should fall back to the cwd-based heuristic rather
 * than fail outright.
 */
export async function resolveSessionId(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  // Claude Code exports the session id to the MCP servers it spawns. It is
  // authoritative, unlike the transcript scan below, which looks only in the
  // directory for the process cwd: a session resumed from another directory
  // (e.g. `$HOME`) keeps writing its original transcript elsewhere, so the scan
  // would pick whichever unrelated session last wrote under that cwd.
  const fromEnv = env.CLAUDE_CODE_SESSION_ID?.trim();
  if (fromEnv) return fromEnv;
  if (cached) return cached;

  const projectDir = join(homedir(), ".claude", "projects", encodeProjectDir(cwd));

  let files: string[];
  try {
    files = (await readdir(projectDir)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return null;
  }

  if (files.length === 0) return null;

  if (files.length === 1) {
    cached = files[0].slice(0, -".jsonl".length);
    return cached;
  }

  // Multiple transcripts in this directory (including past, ended
  // sessions) — the one actively being appended to is this session's.
  const withMtimes = await Promise.all(
    files.map(async (f) => ({ file: f, mtimeMs: (await stat(join(projectDir, f))).mtimeMs }))
  );
  withMtimes.sort((a, b) => b.mtimeMs - a.mtimeMs);

  cached = withMtimes[0].file.slice(0, -".jsonl".length);
  return cached;
}
