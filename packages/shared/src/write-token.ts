/**
 * The per-user local write token: a random secret the collector persists to a
 * file only its own OS user can read (dir 0700, file 0600). A same-user local
 * agent (the MCP server a Claude Code session spawns) reads it and presents it as
 * `x-standup-write-token`, which authorizes the gated writes (self-fix, profile
 * and coordination writes) on a shared/multiplayer or network-exposed collector
 * without an operator having to distribute STANDUP_WRITE_TOKEN. Remote callers
 * (tunnel teammates, raw network clients) and other OS users on the host cannot
 * read the file, so the gate stays closed to them.
 *
 * Node-only (fs/os/crypto) — imported through the `@standup/shared/write-token`
 * subpath so the browser bundle never pulls it in.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** `STANDUP_WRITE_TOKEN_FILE` overrides the default `~/.standup/write-token`. */
export function localWriteTokenPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.STANDUP_WRITE_TOKEN_FILE?.trim();
  return override || join(homedir(), ".standup", "write-token");
}

/** The token stored at `path`, or undefined when the file is missing/empty/unreadable. */
export function readLocalWriteToken(path: string = localWriteTokenPath()): string | undefined {
  try {
    const token = readFileSync(path, "utf8").trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns the token at `path`, creating it (32 random bytes, hex) when absent. An
 * existing token is reused so a collector restart does not invalidate the token
 * running MCP servers already read. Permissions are (re)tightened to 0700/0600 on
 * every call so a file loosened by hand is not left group/world-readable.
 */
export function ensureLocalWriteToken(path: string = localWriteTokenPath()): string {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const existing = readLocalWriteToken(path);
  if (existing) {
    chmodSync(path, 0o600);
    return existing;
  }
  const token = randomBytes(32).toString("hex");
  try {
    // "wx" fails if another process created the file first; that winner's token
    // is then the one to use.
    writeFileSync(path, token + "\n", { mode: 0o600, flag: "wx" });
  } catch (err) {
    const raced = readLocalWriteToken(path);
    if (raced) return raced;
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    // An empty file already exists: overwrite it.
    writeFileSync(path, token + "\n", { mode: 0o600 });
  }
  chmodSync(path, 0o600);
  return token;
}

/** Constant-time comparison of a presented token against an expected one. */
export function tokenMatches(
  presented: string | null | undefined,
  expected: string | null | undefined
): boolean {
  const p = presented?.trim();
  const e = expected?.trim();
  if (!p || !e) return false;
  const a = Buffer.from(p);
  const b = Buffer.from(e);
  return a.length === b.length && timingSafeEqual(a, b);
}
