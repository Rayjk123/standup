/**
 * The knowledge-data migration convention. A migration rewrites knowledge data
 * that already exists — rows in a standup.db and, when a knowledge dir is
 * given, the markdown files those rows are indexed from. Each one:
 *
 *  - has a stable `id` (run order is the order of MIGRATIONS in index.ts) and a
 *    one-line `description`;
 *  - first PLANS: it computes every change it would make — doc ref, target
 *    (db or file), field, and before→after for metadata or the redacted spans'
 *    offsets and rule names for text, never a secret value — down to each
 *    chunk, FTS and vec row a delete cascades to, and the files it would write
 *    or delete;
 *  - applies exactly that plan with raw SQL in one transaction (applyDb) and
 *    text splices of the named front-matter keys and body (applyFiles);
 *  - is idempotent: a second apply plans nothing.
 *
 * runMigrations runs every step on a scratch copy of the DB (and of the
 * knowledge dir, when one is given) first. Step one is the schema upgrade
 * (SCHEMA_STEP_ID): what constructing a KnowledgeStore does to an older DB —
 * added columns, a rebuilt FTS index, healed orphans — reported as the diff it
 * makes, since every later step plans against the upgraded schema. Each
 * migration then plans against the scratch copies and applies its DB and file
 * parts there, so the next one plans against the state it will really see.
 * That pass is the dry run, and writes nothing outside its scratch copies,
 * which it removes. An apply then takes
 * a backup (a copy of the DB and of every knowledge file the plan touches, with
 * a manifest), repeats every step on the real DB, checks each step plans
 * exactly what the dry run reported, and applies it. On any failure it restores
 * the backup itself; until an apply completes (or is rolled back) its backup is
 * marked incomplete and a new apply on the same DB is refused.
 *
 * The markdown files are the source of truth: the collector's sync reconciles
 * `source_kind`, `scope`, `owner_user` and `origin_class` from each file on
 * every pass, and rewrites the body whenever a file's mtime advances. A
 * migration that changes one of those therefore writes the file too when a
 * knowledge dir is given — files first, then the DB, so a crash leaves the
 * files ahead and a re-run converges. Without one (DB-only mode, e.g. a
 * snapshot copy with no corpus) it changes the DB alone — correct for a DB that
 * is never synced against a corpus, and reverted by the next sync of a DB that
 * is.
 */

import { Database } from "bun:sqlite";
import { chmod, copyFile, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, unlink, utimes, writeFile } from "fs/promises";
import { existsSync, readFileSync, realpathSync, statSync } from "fs";
import { homedir, tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { KnowledgeStore, type RedactionSpan } from "@standup/knowledge";
import { ensureKnowledgeChangeColumns } from "@standup/store";
import { copyDatabase, diffKnowledge, processesHolding, restoreKnowledgeTables, snapshotKnowledge } from "./db-state.ts";

export interface MigrationOptions {
  /** Write the changes; without it the migration only reports them. */
  apply: boolean;
  /** The knowledge dir the DB is indexed from. Omitted = DB-only mode. */
  knowledgeDir?: string;
  /** The alias personal-layer docs are owned by. */
  hostUser: string;
  /** projectId → that project's repo design-doc dir (`<repo>/plan`), the DB-only
   *  signal for which docs the project-docs ingest mirrored. */
  planDirs?: ReadonlyMap<string, string>;
  /** Where an apply writes its backup. Defaults to
   *  `<db dir>/kb-migration-backups/<timestamp>`. */
  backupDir?: string;
  /** Where the dry run's scratch copies of the DB and knowledge dir go. Defaults
   *  to the OS temp dir; a scratch DB copy is as large as the DB. */
  scratchDir?: string;
}

/** One change a migration makes (or would make). Never carries a secret value. */
export interface Change {
  /** `<projectId>/<slug>`, plus `#<chunk id>` for a chunk or vec row; `schema:<table>` for a table. */
  ref: string;
  target: "db" | "file";
  /**
   * What changes: a `knowledge` column (`scope`, `owner_user`, `source_kind`,
   * `title`, `body`), `fts.<column>`, `chunk.<column>`, `vec.<column>`, or a
   * whole row (`row`, `fts`, `chunk`, `vec`); for a file, a front-matter key,
   * `body`, or `file`.
   */
  field: string;
  /** `set` (before→after), `redact` (spans), `rewrite` (a text value replaced; no values reported), `insert`, `delete`. */
  action: "set" | "redact" | "rewrite" | "insert" | "delete";
  /** For `set`: the value before and after. */
  before?: string | null;
  after?: string | null;
  /** For `redact`: the spans replaced, as offsets into the old text plus rule names. */
  spans?: readonly RedactionSpan[];
}

export interface MigrationPlan {
  /** Change totals by kind. */
  counts: Record<string, number>;
  changes: Change[];
  /** Knowledge-dir-relative paths apply writes or deletes. */
  files: string[];
  notes: string[];
  /** Writes and deletes the planned files. */
  applyFiles(): Promise<void>;
  /** Makes the planned DB changes in one transaction. */
  applyDb(): void;
}

export interface KbMigration {
  id: string;
  description: string;
  /** Run only when named in `--only`: an owner decision, never part of a default run. */
  optIn?: boolean;
  plan(db: Database, options: MigrationOptions): Promise<MigrationPlan>;
}

export interface MigrationReport {
  id: string;
  applied: boolean;
  /** What changed (or would change), by kind of change. */
  counts: Record<string, number>;
  changes: Change[];
  notes: string[];
  /** The backup taken before this run applied. */
  backupDir?: string;
}

/** The id the schema-upgrade step reports under, ahead of every migration. */
export const SCHEMA_STEP_ID = "000-schema-upgrade";

/** Where a backup stands: an apply in flight or that failed leaves it incomplete. */
export type BackupStatus = "in-progress" | "complete" | "rolled-back" | "failed";

/** The backup manifest a rollback restores from. */
interface BackupManifest {
  createdAt: string;
  status: BackupStatus;
  dbPath: string;
  knowledgeDir?: string;
  migrations: string[];
  /** Knowledge-dir-relative path → its state before the first apply. */
  files: Record<string, { existed: boolean; mtimeMs?: number }>;
  /** Why the apply failed, when it did. */
  error?: string;
}

const MANIFEST = "manifest.json";
const DB_COPY = "standup.db";

/** The marker next to a DB naming the backup of an apply that has not completed. */
export const pendingMarker = (dbPath: string) => `${dbPath}.kb-migration-pending`;

/** An apply that failed: its error, the backup it took, and whether that backup was restored. */
export class MigrationFailure extends Error {
  constructor(
    readonly cause: unknown,
    readonly backupDir: string,
    readonly rolledBack: boolean,
    readonly rollbackError?: unknown
  ) {
    super(
      `apply failed: ${(cause as Error)?.message ?? String(cause)}; ` +
        (rolledBack
          ? `the backup at ${backupDir} was restored`
          : `restoring the backup at ${backupDir} also failed: ${(rollbackError as Error)?.message ?? String(rollbackError)}`)
    );
  }
}

async function readManifest(dir: string): Promise<BackupManifest> {
  return JSON.parse(await readFile(join(dir, MANIFEST), "utf-8")) as BackupManifest;
}

async function writeManifest(dir: string, manifest: BackupManifest): Promise<void> {
  await writeFile(join(dir, MANIFEST), JSON.stringify(manifest, null, 2) + "\n");
}

class Backup {
  private constructor(
    readonly dir: string,
    private manifest: BackupManifest
  ) {}

  /** Copies the DB into a fresh backup dir and marks the DB as mid-apply. */
  static async take(db: Database, options: MigrationOptions): Promise<Backup> {
    const dbPath = resolve(db.filename);
    const dir = resolve(
      options.backupDir ??
        join(dirname(dbPath), "kb-migration-backups", new Date().toISOString().replace(/[:.]/g, "-"))
    );
    if (existsSync(join(dir, MANIFEST))) throw new Error(`backup dir already holds a backup: ${dir}`);
    await mkdir(join(dir, "files"), { recursive: true });
    copyDatabase(db, join(dir, DB_COPY));
    const manifest: BackupManifest = {
      createdAt: new Date().toISOString(),
      status: "in-progress",
      dbPath,
      knowledgeDir: options.knowledgeDir,
      migrations: [],
      files: {},
    };
    await writeManifest(dir, manifest);
    await writeFile(pendingMarker(dbPath), dir + "\n");
    return new Backup(dir, manifest);
  }

  /** Copies each file not already backed up, recording whether it existed. */
  async addFiles(migrationId: string, files: readonly string[]): Promise<void> {
    this.manifest.migrations.push(migrationId);
    const root = this.manifest.knowledgeDir;
    if (root) {
      for (const rel of files) {
        if (this.manifest.files[rel]) continue;
        const source = join(root, rel);
        if (existsSync(source)) {
          const target = join(this.dir, "files", rel);
          await mkdir(dirname(target), { recursive: true });
          await copyFile(source, target);
          this.manifest.files[rel] = { existed: true, mtimeMs: (await stat(source)).mtimeMs };
        } else {
          this.manifest.files[rel] = { existed: false };
        }
      }
    }
    await writeManifest(this.dir, this.manifest);
  }

  /** Records the apply as complete and clears the DB's mid-apply marker. */
  async complete(): Promise<void> {
    this.manifest.status = "complete";
    await writeManifest(this.dir, this.manifest);
    await rm(pendingMarker(this.manifest.dbPath), { force: true });
  }

  /** Restores this backup into the open `db` and its knowledge dir, recording the outcome. */
  async restore(db: Database, cause: unknown): Promise<void> {
    this.manifest.error = (cause as Error)?.message ?? String(cause);
    try {
      restoreKnowledgeTables(db, join(this.dir, DB_COPY));
      if (this.manifest.knowledgeDir) await restoreFiles(this.dir, this.manifest, this.manifest.knowledgeDir);
      this.manifest.status = "rolled-back";
      await writeManifest(this.dir, this.manifest);
      await rm(pendingMarker(this.manifest.dbPath), { force: true });
    } catch (err) {
      this.manifest.status = "failed";
      await writeManifest(this.dir, this.manifest).catch(() => {});
      throw err;
    }
  }
}

/** Throws when another process has `dbPath` open, or an apply on it has not completed. */
function assertDbFree(dbPath: string, action: string): void {
  const holders = processesHolding(dbPath);
  if (holders.length > 0) {
    throw new Error(`refusing to ${action} ${dbPath}: it is open in process ${holders.join(", ")} (stop the collector first)`);
  }
}

function assertNoPendingApply(dbPath: string): void {
  const marker = pendingMarker(dbPath);
  if (!existsSync(marker)) return;
  const dir = readFileSync(marker, "utf-8").trim();
  throw new Error(
    `refusing to apply: an earlier apply on ${dbPath} did not complete and its backup ${dir} was not restored; ` +
      `run --rollback ${dir} first`
  );
}

/**
 * The schema upgrade the collector makes to `db`'s knowledge tables — a
 * KnowledgeStore's, plus knowledge_changes' personal/owner_user columns — as
 * the diff it causes.
 */
function upgradeSchema(db: Database): MigrationReport {
  const before = snapshotKnowledge(db);
  new KnowledgeStore(db);
  ensureKnowledgeChangeColumns(db);
  const changes = diffKnowledge(before, snapshotKnowledge(db));
  const count = (pred: (c: Change) => boolean) => changes.filter(pred).length;
  return {
    id: SCHEMA_STEP_ID,
    applied: false,
    counts: {
      tables: count((c) => c.ref.startsWith("schema:")),
      rowsInserted: count((c) => !c.ref.startsWith("schema:") && c.action === "insert"),
      rowsDeleted: count((c) => !c.ref.startsWith("schema:") && c.action === "delete"),
      fieldsChanged: count((c) => c.action === "set" || c.action === "rewrite"),
    },
    changes,
    notes: changes.length > 0 ? ["the collector makes this upgrade on its next start in any case"] : [],
  };
}

/**
 * Runs the schema upgrade and then each migration's plan and DB part on
 * `work`, applying files too when `writeFiles`, and returns one report per
 * step. `onStep` runs before a step with changes writes anything.
 */
async function runSteps(
  work: Database,
  migrations: readonly KbMigration[],
  options: MigrationOptions,
  writeFiles: boolean,
  onStep: (report: MigrationReport, files: readonly string[]) => Promise<void> = async () => {}
): Promise<MigrationReport[]> {
  const reports: MigrationReport[] = [];
  const schema = upgradeSchema(work);
  await onStep(schema, []);
  reports.push(schema);
  for (const migration of migrations) {
    const plan = await migration.plan(work, options);
    const report: MigrationReport = { id: migration.id, applied: false, counts: plan.counts, changes: plan.changes, notes: plan.notes };
    if (plan.changes.length > 0) {
      await onStep(report, plan.files);
      if (writeFiles) await plan.applyFiles();
      plan.applyDb();
    }
    reports.push(report);
  }
  return reports;
}

/** Runs `fn` against a scratch copy of `db` in a temp dir under `parent`, removed afterwards. */
async function withScratchCopy<T>(db: Database, parent: string, fn: (scratch: Database) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(parent, "kb-migration-plan-"));
  const path = join(dir, DB_COPY);
  copyDatabase(db, path);
  const scratch = new Database(path);
  try {
    return await fn(scratch);
  } finally {
    scratch.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Makes every dir (0700) and file (0600) under `dir` owner-only and writable,
 * so a scratch copy of a read-only tree can be planned against and removed.
 */
async function makePrivateAndWritable(dir: string): Promise<void> {
  await chmod(dir, 0o700);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await makePrivateAndWritable(path);
    else if (entry.isFile()) await chmod(path, 0o600);
  }
}

/**
 * Runs `fn` with options whose knowledge dir is a scratch copy of
 * `options.knowledgeDir` (timestamps kept, symlinks resolved) in a private temp dir, removed
 * afterwards; with no knowledge dir, with `options` as they are.
 */
async function withScratchFiles<T>(options: MigrationOptions, fn: (scratch: MigrationOptions) => Promise<T>): Promise<T> {
  if (!options.knowledgeDir) return fn(options);
  const dir = await mkdtemp(join(options.scratchDir ?? tmpdir(), "kb-migration-files-"));
  const knowledgeDir = join(dir, "knowledge");
  try {
    // Symlinked files are copied as files, so a planned write never reaches through one.
    if (existsSync(options.knowledgeDir)) {
      await cp(realpathSync(options.knowledgeDir), knowledgeDir, { recursive: true, preserveTimestamps: true, dereference: true });
    } else {
      await mkdir(knowledgeDir);
    }
    await makePrivateAndWritable(knowledgeDir);
    return await fn({ ...options, knowledgeDir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Runs the schema upgrade and `migrations` in order against `db`, returning one
 * report per step (the schema upgrade first). Without `apply` this is the dry
 * run, on a scratch copy. With `apply`, when the dry run has any change, it
 * backs up the DB and every file the plan touches, re-runs every step on `db`
 * checking each plans what the dry run did, and marks the backup complete — or,
 * on any failure, restores the backup and throws a MigrationFailure naming it.
 */
export async function runMigrations(
  db: Database,
  migrations: readonly KbMigration[],
  options: MigrationOptions
): Promise<MigrationReport[]> {
  const fileBacked = db.filename && db.filename !== ":memory:";
  if (options.apply) {
    if (!fileBacked) throw new Error("a migration apply needs a file-backed DB to back up");
    assertNoPendingApply(resolve(db.filename));
    assertDbFree(resolve(db.filename), "migrate");
  }
  const planned = await withScratchCopy(db, options.scratchDir ?? tmpdir(), (scratch) =>
    withScratchFiles(options, (scratchOptions) => runSteps(scratch, migrations, scratchOptions, Boolean(scratchOptions.knowledgeDir)))
  );
  if (!options.apply || planned.every((r) => r.changes.length === 0)) return planned;

  const backup = await Backup.take(db, options);
  try {
    const applied = await runSteps(db, migrations, options, true, async (report, files) => {
      const expected = planned.find((r) => r.id === report.id);
      if (JSON.stringify(expected?.changes ?? []) !== JSON.stringify(report.changes)) {
        throw new Error(`${report.id} planned differently on the DB than in the dry run; nothing of it was applied`);
      }
      await backup.addFiles(report.id, files);
    });
    await backup.complete();
    return applied.map((r) => ({ ...r, applied: r.changes.length > 0, ...(r.changes.length > 0 ? { backupDir: backup.dir } : {}) }));
  } catch (err) {
    try {
      await backup.restore(db, err);
    } catch (rollbackError) {
      throw new MigrationFailure(err, backup.dir, false, rollbackError);
    }
    throw new MigrationFailure(err, backup.dir, true);
  }
}

/** The DB and knowledge dir a backup was taken from, and where it stands. */
export async function backupTargets(
  backupDir: string
): Promise<{ dbPath: string; knowledgeDir?: string; status: BackupStatus }> {
  const manifest = await readManifest(backupDir);
  return { dbPath: manifest.dbPath, knowledgeDir: manifest.knowledgeDir, status: manifest.status };
}

/** Whether the file at `path` already holds the backed-up state. */
async function fileMatches(path: string, backupPath: string, state: { existed: boolean; mtimeMs?: number }): Promise<boolean> {
  if (!state.existed) return !existsSync(path);
  if (!existsSync(path)) return false;
  const [current, saved] = await Promise.all([readFile(path), readFile(backupPath)]);
  return current.equals(saved) && (state.mtimeMs === undefined || (await stat(path)).mtimeMs === state.mtimeMs);
}

/**
 * Puts each backed-up knowledge file back: rewritten byte-for-byte with its old
 * mtime, or deleted when it did not exist before. A file already in its
 * backed-up state is left alone, so a file the apply never reached (say, in a
 * read-only dir) needs no write.
 */
async function restoreFiles(
  backupDir: string,
  manifest: BackupManifest,
  root: string
): Promise<{ filesRestored: number; filesDeleted: number }> {
  let filesRestored = 0;
  let filesDeleted = 0;
  for (const [rel, state] of Object.entries(manifest.files)) {
    const path = join(root, rel);
    const saved = join(backupDir, "files", rel);
    if (await fileMatches(path, saved, state)) continue;
    if (state.existed) {
      await mkdir(dirname(path), { recursive: true });
      await copyFile(saved, path);
      // utimes takes seconds as a number at sub-millisecond precision; a Date
      // would truncate the backed-up mtime to whole milliseconds.
      if (state.mtimeMs !== undefined) await utimes(path, Date.now() / 1000, state.mtimeMs / 1000);
      filesRestored++;
    } else {
      await unlink(path);
      filesDeleted++;
    }
  }
  return { filesRestored, filesDeleted };
}

/**
 * Restores a backup runMigrations took: the knowledge tables of the DB (every
 * other table is left as it is now), and every backed-up knowledge file.
 * Refuses while another process has the DB open. `dbPath` / `knowledgeDir`
 * default to the paths the backup was taken from.
 */
export async function rollbackMigrations(
  backupDir: string,
  targets: { dbPath?: string; knowledgeDir?: string } = {}
): Promise<{ dbPath: string; filesRestored: number; filesDeleted: number }> {
  const manifest = await readManifest(backupDir);
  const dbPath = targets.dbPath ?? manifest.dbPath;
  assertDbFree(dbPath, "roll back");
  const db = new Database(dbPath);
  try {
    restoreKnowledgeTables(db, join(backupDir, DB_COPY));
  } finally {
    db.close();
  }
  const root = targets.knowledgeDir ?? manifest.knowledgeDir;
  const result = root ? await restoreFiles(backupDir, manifest, root) : { filesRestored: 0, filesDeleted: 0 };
  manifest.status = "rolled-back";
  await writeManifest(backupDir, manifest);
  const marker = pendingMarker(resolve(manifest.dbPath));
  if (existsSync(marker) && readFileSync(marker, "utf-8").trim() === resolve(backupDir)) await rm(marker, { force: true });
  return { dbPath, ...result };
}

/** The ref + field + detail of one change, as a dry run prints it. */
export function formatChange(change: Change): string {
  const head = `  ${change.target.padEnd(4)} ${change.ref} ${change.field}`;
  if (change.action === "delete" || change.action === "insert" || change.action === "rewrite") {
    return `${head}: ${change.action}`;
  }
  if (change.action === "set") return `${head}: ${change.before ?? "∅"} → ${change.after ?? "∅"}`;
  const spans = (change.spans ?? []).map((s) => `[${s.start},${s.end}) ${s.pattern}`).join(", ");
  return `${head}: redact ${spans}`;
}

/** One line per report: `<id> applied|dry-run|no changes key=n …`, then (with `detail`) one line per change. */
export function formatReport(report: MigrationReport, detail = false): string {
  const counts = Object.entries(report.counts)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  const state = report.applied ? "applied" : report.changes.length === 0 ? "no changes" : "dry-run";
  const lines = [`${report.id} ${state} ${counts}`.trim()];
  if (report.backupDir) lines.push(`  backup: ${report.backupDir}`);
  if (detail) lines.push(...report.changes.map(formatChange));
  return lines.join("\n");
}

/** The paths a migration never opens by default: the collector's default DB and
 *  knowledge dir under HOME, and whatever DB_PATH / KNOWLEDGE_DIR point it at. */
export function protectedPaths(env: NodeJS.ProcessEnv = process.env): { dbs: string[]; knowledgeDirs: string[] } {
  const home = env.HOME || homedir();
  const dbs = [join(home, ".local", "share", "standup", "standup.db"), env.DB_PATH].filter(
    (p): p is string => !!p
  );
  const knowledgeDirs = [join(home, ".config", "standup", "knowledge"), env.KNOWLEDGE_DIR].filter(
    (p): p is string => !!p
  );
  return { dbs, knowledgeDirs };
}

function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Whether `a` and `b` are the same file: same resolved path, or the same dev+inode (a hardlink). */
function sameFile(a: string, b: string): boolean {
  if (realOrResolved(a) === realOrResolved(b) || resolve(a) === resolve(b)) return true;
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
}

/**
 * Throws unless `path` is a DB a migration may open: an existing file that is
 * not a protected DB (protectedPaths), nor its -wal/-shm, by path, symlink or
 * hardlink. `allowLive` lifts the refusal.
 */
export function assertMigratableDbPath(path: string, allowLive: boolean, env: NodeJS.ProcessEnv = process.env): string {
  const target = realOrResolved(path);
  const isLive = protectedPaths(env).dbs.some((db) =>
    ["", "-wal", "-shm"].some((suffix) => sameFile(path, `${db}${suffix}`))
  );
  if (isLive && !allowLive) {
    throw new Error(`refusing to migrate the live DB ${target}; pass --i-know-this-is-live to override`);
  }
  if (!existsSync(target)) throw new Error(`DB not found: ${path}`);
  return target;
}

/** Throws when `dir` is a protected knowledge dir (protectedPaths) and `allowLive` is not set. */
export function assertMigratableKnowledgeDir(
  dir: string,
  allowLive: boolean,
  env: NodeJS.ProcessEnv = process.env
): string {
  const target = realOrResolved(dir);
  if (protectedPaths(env).knowledgeDirs.some((live) => sameFile(dir, live)) && !allowLive) {
    throw new Error(`refusing to migrate the live knowledge dir ${target}; pass --i-know-this-is-live to override`);
  }
  if (!existsSync(target)) throw new Error(`knowledge dir not found: ${dir}`);
  return target;
}
