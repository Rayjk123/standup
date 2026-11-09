/**
 * A standup.db runs to gigabytes — nearly all transcript events no migration
 * reads — so the runner must plan, back up and roll back in memory that does
 * not grow with the DB. These tests run the CLI on a DB padded with a large
 * filler table and hold it to a peak RSS well under the DB's size, while the
 * apply still makes exactly the dry run's plan and the rollback restores every
 * knowledge table row for row.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmod, mkdtemp, rm, stat } from "fs/promises";
import fs from "fs";
import fsPromises from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { KnowledgeStore, type KnowledgeDoc } from "@standup/knowledge";
import { DEFAULT_MIGRATIONS, rollbackMigrations, runMigrations } from "./index.ts";
import { KNOWLEDGE_TABLES, diffKnowledge, snapshotKnowledge } from "./db-state.ts";

const RUN = join(import.meta.dir, "run.ts");
const PEAK_RSS = join(import.meta.dir, "peak-rss.ts");
const MB = 1024 * 1024;
const SECRET_BODY = "deploy to account 123456789012 with Server=db;Password=hunter2very;";

let root: string;
let dbPath: string;
let backupDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kb-migrations-large-"));
  dbPath = join(root, "standup.db");
  backupDir = join(root, "backup");
});

afterEach(async () => {
  await chmod(dbPath, 0o644).catch(() => {});
  await rm(root, { recursive: true, force: true });
});

function doc(overrides: Partial<KnowledgeDoc>): KnowledgeDoc {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    projectId: "proj",
    slug: "doc",
    title: "Doc",
    body: "body",
    updatedAt: new Date("2026-08-16T00:00:00Z"),
    filePath: "/x/doc.md",
    originClass: "owner",
    sourceKind: "code",
    ...overrides,
  };
}

/**
 * A small knowledge corpus the default migrations rewrite (a home mirror to
 * re-own, secrets to redact, an unlabeled doc to relabel), padded with a
 * `transcript_events` table of `fillerMb` MB of random blobs.
 */
function seed(fillerMb: number): void {
  const db = new Database(dbPath);
  const store = new KnowledgeStore(db);
  const rows = [
    doc({ id: "home", projectId: "global", slug: "native-mem-home-claude-md", sourceKind: "native-memory", scope: "global", body: SECRET_BODY }),
    doc({ id: "shared", slug: "runbook", scope: "project", body: SECRET_BODY }),
    doc({ id: "wide", slug: "wide", scope: "global", body: SECRET_BODY }),
    doc({ id: "plain", slug: "notes", body: "unlabeled" }),
    doc({ id: "fact", slug: "fact", body: "a labeled fact" }),
  ];
  for (const r of rows) {
    store.upsertDoc(r);
    store.upsertChunk({ id: `${r.id}-c`, knowledgeId: r.id, chunkIndex: 0, text: r.body, embedding: [1, 0] });
  }
  db.run("CREATE TABLE transcript_events (id INTEGER PRIMARY KEY, session_id TEXT, payload BLOB)");
  const blob = 64 * 1024;
  const insert = db.prepare(
    "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?) " +
      "INSERT INTO transcript_events (session_id, payload) SELECT 's' || (i % 7), randomblob(?) FROM n"
  );
  const total = Math.ceil((fillerMb * MB) / blob);
  db.transaction(() => {
    for (let done = 0; done < total; done += 1000) insert.run(Math.min(1000, total - done), blob);
  })();
  db.run("PRAGMA journal_mode = DELETE");
  db.close();
}

/** The filler table summarized by SQL aggregates, so the test never reads it row by row either. */
function fillerDigest(path: string): { n: number; bytes: number; sum: number } {
  const db = new Database(path, { readonly: true });
  try {
    return db
      .query("SELECT COUNT(*) AS n, SUM(length(payload)) AS bytes, SUM(id * unicode(hex(substr(payload, 1, 4)))) AS sum FROM transcript_events")
      .get() as { n: number; bytes: number; sum: number };
  } finally {
    db.close();
  }
}

/** Every row (with its rowid) and the DDL of each knowledge table, for row-equality. */
function dumpKnowledge(path: string): Record<string, unknown[]> {
  const db = new Database(path, { readonly: true });
  const encode = (_k: string, v: unknown) => (v instanceof Uint8Array ? Buffer.from(v).toString("base64") : v);
  try {
    const out: Record<string, unknown[]> = {};
    const readable = snapshotKnowledge(db).tables;
    for (const table of KNOWLEDGE_TABLES) {
      const ddl = readable.get(table)?.ddl ?? null;
      out[`${table}:ddl`] = [ddl];
      if (ddl === null || !readable.get(table)?.columns.length) continue;
      const rowid = /WITHOUT ROWID/i.test(ddl) ? "" : "rowid AS __rowid, ";
      out[table] = (db.query(`SELECT ${rowid}* FROM "${table}"`).all() as unknown[]).map((r) => JSON.stringify(r, encode)).sort();
    }
    return out;
  } finally {
    db.close();
  }
}

/**
 * Runs the CLI with `args` as a child process, returning its exit code, output
 * and peak RSS in bytes, as the child measured its own (peak-rss.ts); a run that
 * didn't report one reads as infinite.
 */
async function runCli(args: string[]): Promise<{ code: number; out: string; maxRss: number }> {
  const rssFile = join(root, `peak-rss-${crypto.randomUUID()}`);
  const child = Bun.spawn(["bun", "run", "--preload", PEAK_RSS, RUN, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, DB_PATH: "", KNOWLEDGE_DIR: "", PEAK_RSS_FILE: rssFile },
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const reported = Number(await Bun.file(rssFile).text().catch(() => ""));
  const maxRss = reported > 0 ? reported : Number.POSITIVE_INFINITY;
  return { code, out: out + err, maxRss };
}

const defaultIds = DEFAULT_MIGRATIONS.map((m) => m.id).join(",");
const unique = (keys: string[]) => [...new Set(keys)].sort();

/**
 * Dry run, apply and rollback through the CLI on a DB of `fillerMb` MB of
 * filler, each held under `rssCapMb` MB of peak RSS, checking the dry run
 * writes nothing (the DB file is read-only to it), the apply's knowledge diff
 * is exactly the dry run's plan, the rollback is row-equal, and the filler is
 * never touched. Returns the peak RSS of each run and the DB's size.
 */
async function migrateLargeDb(fillerMb: number, rssCapMb: number) {
  seed(fillerMb);
  const dbSize = (await stat(dbPath)).size;
  expect(dbSize).toBeGreaterThan(fillerMb * MB);
  const filler = fillerDigest(dbPath);
  const before = dumpKnowledge(dbPath);
  const beforeDb = new Database(dbPath, { readonly: true });
  const snapBefore = snapshotKnowledge(beforeDb);
  beforeDb.close();
  const { mtimeMs } = await stat(dbPath);

  // The dry run plans on a scratch copy: a read-only DB file is no obstacle and stays untouched.
  await chmod(dbPath, 0o444);
  const dry = await runCli(["--db", dbPath, "--host-user", "alice", "--only", defaultIds]);
  expect(dry.code, dry.out).toBe(0);
  await chmod(dbPath, 0o644);
  expect((await stat(dbPath)).mtimeMs).toBe(mtimeMs);
  expect(dumpKnowledge(dbPath)).toEqual(before);
  const planned = unique([...dry.out.matchAll(/^ {2}db {3}(\S+) ([^:\s]+):/gm)].map((m) => `${m[1]} ${m[2]}`));
  expect(planned.length).toBeGreaterThan(0);
  expect(planned).toContain("global/native-mem-home-claude-md scope");
  expect(planned).toContain("proj/runbook body");

  const apply = await runCli(["--db", dbPath, "--host-user", "alice", "--apply", "--backup-dir", backupDir, "--summary"]);
  expect(apply.code, apply.out).toBe(0);
  expect(apply.out).toContain(" applied ");
  const afterDb = new Database(dbPath, { readonly: true });
  const actual = unique(diffKnowledge(snapBefore, snapshotKnowledge(afterDb)).map((c) => `${c.ref} ${c.field}`));
  afterDb.close();
  expect(actual).toEqual(planned);
  expect(fillerDigest(dbPath)).toEqual(filler);

  const rollback = await runCli(["--rollback", backupDir]);
  expect(rollback.code, rollback.out).toBe(0);
  expect(dumpKnowledge(dbPath)).toEqual(before);
  expect(fillerDigest(dbPath)).toEqual(filler);

  for (const run of [dry, apply, rollback]) expect(run.maxRss).toBeLessThan(rssCapMb * MB);
  return { dbSize, dry: dry.maxRss, apply: apply.maxRss, rollback: rollback.maxRss };
}

const report = (r: Awaited<ReturnType<typeof migrateLargeDb>>) =>
  `db ${(r.dbSize / MB).toFixed(0)} MB; peak RSS dry ${(r.dry / MB).toFixed(0)} MB, apply ${(r.apply / MB).toFixed(0)} MB, ` +
  `rollback ${(r.rollback / MB).toFixed(0)} MB`;

describe("migrating a DB far larger than the runner's memory", () => {
  test("a dry run, apply and rollback on a 400 MB DB each peak well under its size", async () => {
    console.log(report(await migrateLargeDb(400, 200)));
  }, 120_000);

  test("no copy, backup or restore reads the DB file or a non-knowledge table into memory", async () => {
    seed(8);
    const before = dumpKnowledge(dbPath);
    const reads: string[] = [];
    const watch = (name: string) => (path: unknown) => {
      if (String(path).endsWith(".db")) reads.push(`${name} ${path}`);
    };
    const spies = [
      spyOn(Database.prototype, "serialize").mockImplementation(() => {
        throw new Error("serialize reads the whole DB into memory");
      }),
      spyOn(fs, "readFileSync").mockImplementation(((orig) => (...a: Parameters<typeof fs.readFileSync>) => {
        watch("readFileSync")(a[0]);
        return orig(...a);
      })(fs.readFileSync.bind(fs)) as typeof fs.readFileSync),
      spyOn(fsPromises, "readFile").mockImplementation(((orig) => (...a: Parameters<typeof fsPromises.readFile>) => {
        watch("readFile")(a[0]);
        return orig(...a);
      })(fsPromises.readFile.bind(fsPromises)) as typeof fsPromises.readFile),
      spyOn(fsPromises, "copyFile").mockImplementation(((orig) => (...a: Parameters<typeof fsPromises.copyFile>) => {
        watch("copyFile")(a[0]);
        return orig(...a);
      })(fsPromises.copyFile.bind(fsPromises)) as typeof fsPromises.copyFile),
    ];
    const statements: string[] = [];
    const query = Database.prototype.query;
    const querySpy = spyOn(Database.prototype, "query").mockImplementation(function (this: Database, sql: string) {
      statements.push(sql);
      return query.call(this, sql);
    } as typeof Database.prototype.query);
    try {
      const source = new Database(dbPath, { readonly: true });
      const dry = await runMigrations(source, DEFAULT_MIGRATIONS, { apply: false, hostUser: "alice" });
      source.close();
      expect(dry.some((r) => r.changes.length > 0)).toBe(true);
      const db = new Database(dbPath);
      await runMigrations(db, DEFAULT_MIGRATIONS, { apply: true, hostUser: "alice", backupDir });
      db.close();
      await rollbackMigrations(backupDir);
    } finally {
      for (const spy of [...spies, querySpy]) spy.mockRestore();
    }
    expect(reads).toEqual([]);
    expect(statements.filter((sql) => /transcript_events/.test(sql))).toEqual([]);
    expect(dumpKnowledge(dbPath)).toEqual(before);
  }, 60_000);
});
