import { homedir } from "os";
import { join } from "path";

/**
 * Where the collector's SQLite database lives: DB_PATH, else
 * ~/.local/share/standup/standup.db.
 *
 * Must live outside the source tree: `bun run --watch` restarts on any file
 * change under its cwd, and SQLite's WAL mode rewrites -wal/-shm files on every
 * insert, so a DB path inside packages/collector/ causes a restart loop driven
 * by the collector's own writes.
 */
export function defaultDbPath(): string {
  return process.env.DB_PATH ?? join(homedir(), ".local", "share", "standup", "standup.db");
}
