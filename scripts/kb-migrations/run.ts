#!/usr/bin/env bun
/**
 * Runs the knowledge-data migrations against an explicitly named DB copy.
 *
 *   bun run scripts/kb-migrations/run.ts --db <path> [--knowledge-dir <dir>]
 *     [--apply] [--backup-dir <dir>] [--only <id,...>] [--host-user <alias>]
 *     [--plan-dir <project>=<dir>]… [--scratch-dir <dir>] [--summary]
 *   bun run scripts/kb-migrations/run.ts --rollback <backup-dir> [--db <path>] [--knowledge-dir <dir>]
 *
 * A dry run unless --apply: it prints the host user personal-layer docs are
 * re-owned by, then every change each step would make (doc ref, field,
 * before→after, or the redacted spans' offsets and rule names — never a secret
 * value), the schema upgrade first; --summary prints the counts alone. A dry
 * run opens the DB read-only and plans on a scratch copy under --scratch-dir
 * (default: the OS temp dir), as large as the DB. --apply
 * first backs up the DB and every file it touches and prints the backup dir; a
 * failed apply restores that backup itself and says so. --rollback restores a
 * backup's knowledge tables and files. Opt-in migrations (003, 005) appear in a dry run but are applied only when
 * named in --only. Refuses the live DB and knowledge dir — the defaults under
 * HOME and whatever DB_PATH / KNOWLEDGE_DIR name, by path, symlink or hardlink —
 * unless --i-know-this-is-live. See runner.ts for the convention and each
 * migration file for what it changes.
 */

import { Database } from "bun:sqlite";
import { resolve } from "path";
import { hostUserAlias, hostUserSource } from "../../packages/collector/src/host-user.ts";
import {
  MIGRATIONS,
  MigrationFailure,
  assertMigratableDbPath,
  assertMigratableKnowledgeDir,
  backupTargets,
  formatReport,
  rollbackMigrations,
  runMigrations,
} from "./index.ts";

const USAGE =
  "usage: bun run scripts/kb-migrations/run.ts --db <path> [--knowledge-dir <dir>] [--apply] [--backup-dir <dir>] " +
  "[--only <id,...>] [--host-user <alias>] [--plan-dir <project>=<dir>]... [--scratch-dir <dir>] [--summary] " +
  "[--i-know-this-is-live]\n" +
  "       bun run scripts/kb-migrations/run.ts --rollback <backup-dir> [--db <path>] [--knowledge-dir <dir>]";

function parse(argv: string[]) {
  const flags = {
    db: undefined as string | undefined,
    knowledgeDir: undefined as string | undefined,
    apply: false,
    backupDir: undefined as string | undefined,
    scratchDir: undefined as string | undefined,
    rollback: undefined as string | undefined,
    only: undefined as string[] | undefined,
    hostUser: undefined as string | undefined,
    planDirs: new Map<string, string>(),
    summary: false,
    allowLive: false,
  };
  const value = (i: number, name: string) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${name} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--db":
        flags.db = value(i++, a);
        break;
      case "--knowledge-dir":
        flags.knowledgeDir = value(i++, a);
        break;
      case "--apply":
        flags.apply = true;
        break;
      case "--backup-dir":
        flags.backupDir = resolve(value(i++, a));
        break;
      case "--scratch-dir":
        flags.scratchDir = resolve(value(i++, a));
        break;
      case "--rollback":
        flags.rollback = resolve(value(i++, a));
        break;
      case "--only":
        flags.only = value(i++, a).split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--host-user":
        flags.hostUser = value(i++, a);
        break;
      case "--plan-dir": {
        const [project, dir] = value(i++, a).split("=", 2);
        if (!project || !dir) throw new Error("--plan-dir takes <project>=<dir>");
        flags.planDirs.set(project, resolve(dir));
        break;
      }
      case "--summary":
        flags.summary = true;
        break;
      case "--i-know-this-is-live":
        flags.allowLive = true;
        break;
      default:
        throw new Error(`unknown flag ${a}`);
    }
  }
  if (!flags.db && !flags.rollback) throw new Error("--db is required");
  if (flags.rollback && flags.apply) throw new Error("--rollback and --apply are exclusive");
  return flags;
}

let flags: ReturnType<typeof parse>;
try {
  flags = parse(process.argv.slice(2));
} catch (err) {
  console.error((err as Error).message);
  console.error(USAGE);
  process.exit(2);
}

if (flags.rollback) {
  const recorded = await backupTargets(flags.rollback);
  const target = flags.db ?? recorded.dbPath;
  const targetDir = flags.knowledgeDir ?? recorded.knowledgeDir;
  try {
    const result = await rollbackMigrations(flags.rollback, {
      dbPath: assertMigratableDbPath(target, flags.allowLive),
      knowledgeDir: targetDir ? assertMigratableKnowledgeDir(targetDir, flags.allowLive) : undefined,
    });
    console.log(
      `rolled back the knowledge tables of ${result.dbPath} from ${flags.rollback} (was ${recorded.status}): ` +
        `${result.filesRestored} file(s) restored, ${result.filesDeleted} deleted`
    );
    process.exit(0);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}

const dbPath = assertMigratableDbPath(flags.db!, flags.allowLive);
const knowledgeDir = flags.knowledgeDir
  ? assertMigratableKnowledgeDir(flags.knowledgeDir, flags.allowLive)
  : undefined;
const named = flags.only ? MIGRATIONS.filter((m) => flags.only!.includes(m.id)) : undefined;
if (flags.only && named!.length !== flags.only.length) {
  console.error(`unknown migration id in --only; known: ${MIGRATIONS.map((m) => m.id).join(", ")}`);
  process.exit(2);
}
const selected = named ?? (flags.apply ? MIGRATIONS.filter((m) => !m.optIn) : MIGRATIONS);
const hostUser = flags.hostUser ?? hostUserAlias();
console.log(
  `host user: ${hostUser} (${flags.hostUser ? "--host-user" : hostUserSource()}; ` +
    "the collector must resolve the same alias — pass --host-user or set STANDUP_HOST_USER for both)"
);

// A dry run only reads the DB; every write it plans lands on a scratch copy.
const db = new Database(dbPath, flags.apply ? undefined : { readonly: true });
try {
  const reports = await runMigrations(db, selected, {
    apply: flags.apply,
    knowledgeDir,
    hostUser,
    planDirs: flags.planDirs,
    backupDir: flags.backupDir,
    scratchDir: flags.scratchDir,
  });
  for (const report of reports) {
    console.log(formatReport(report, !flags.summary && !flags.apply));
    if (MIGRATIONS.find((m) => m.id === report.id)?.optIn) console.log(`  note: opt-in — applied only with --only ${report.id}`);
    for (const note of report.notes) console.log(`  note: ${note}`);
  }
  if (!flags.apply) console.log("(dry run — pass --apply to write)");
} catch (err) {
  if (!(err instanceof MigrationFailure)) {
    console.error((err as Error).message);
    process.exit(1);
  }
  console.error(err.message);
  console.error(`backup: ${err.backupDir}`);
  if (!err.rolledBack) {
    console.error(`restore it with: bun run scripts/kb-migrations/run.ts --rollback ${err.backupDir}`);
  }
  process.exit(1);
} finally {
  db.close();
}
