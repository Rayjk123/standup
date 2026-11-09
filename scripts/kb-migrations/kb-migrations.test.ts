import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { chmod, link, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join, relative } from "path";
import {
  DISPUTED_CONFIDENCE,
  KnowledgeLoader,
  KnowledgeStore,
  applyRedactions,
  frontmatterBody,
  readRawDocFile,
  spliceFrontmatter,
  type KnowledgeDoc,
  type RedactionSpan,
} from "@standup/knowledge";
import {
  DEFAULT_MIGRATIONS,
  MIGRATIONS,
  MigrationFailure,
  SCHEMA_STEP_ID,
  assertMigratableDbPath,
  assertMigratableKnowledgeDir,
  backupTargets,
  formatReport,
  pendingMarker,
  rollbackMigrations,
  runMigrations,
  type Change,
  type KbMigration,
  type MigrationOptions,
} from "./index.ts";
import { ensureKnowledgeChangeColumns, getRecentKnowledgeChanges } from "@standup/store";
import { diffKnowledge, processesHolding, snapshotKnowledge } from "./db-state.ts";
import { listDocFiles, readDocText, writeDocText } from "./markdown.ts";

let root: string;
let dbPath: string;
let knowledgeDir: string;
let planDir: string;
let backupDir: string;

beforeEach(async () => {
  // Real path: the live-target guards return the canonical path, and TMPDIR may sit behind a symlink.
  root = await realpath(await mkdtemp(join(tmpdir(), "kb-migrations-")));
  dbPath = join(root, "standup.db");
  knowledgeDir = join(root, "knowledge");
  planDir = join(root, "repo", "plan");
  backupDir = join(root, "backup");
  await mkdir(planDir, { recursive: true });
});

afterEach(async () => {
  await chmod(join(knowledgeDir, "ro"), 0o755).catch(() => {});
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

async function writeDocFile(projectId: string, slug: string, frontmatter: string, body: string): Promise<void> {
  await mkdir(join(knowledgeDir, projectId), { recursive: true });
  await writeFile(join(knowledgeDir, projectId, `${slug}.md`), `---\n${frontmatter}\n---\n\n${body}\n`);
}

const SECRET_BODY = "deploy to account 123456789012 with Server=db;Password=hunter2very;";
/** Team data a redactor must never touch, in a project-scoped runbook. */
const TEAM_BODY =
  "Beta account 444455556666; partition_key: tenantIdWithRegion; sortKey: createdAt; " +
  "nextToken = resp.NextToken; request 550e8400-e29b-41d4-a716-446655440000; built 202610050541; " +
  "card 4111-1111-1111-1111; arn:aws:iam::444455556666:role/Deploy; kms_key_id: 1234abcd-12ab-34cd-56ef-1234567890ab\n" +
  'DB_PASSWORD=\nDB_HOST=localhost\nconst password = form.get("password")\npassword = var.db_password\npassword: hunter2team';

/** A small corpus with every case the migrations handle, in the DB and on disk. */
async function seed(): Promise<Database> {
  const db = new Database(dbPath);
  const store = new KnowledgeStore(db);
  const rows: KnowledgeDoc[] = [
    doc({ id: "home", projectId: "global", slug: "native-mem-home-claude-md", sourceKind: "native-memory", scope: "global", body: SECRET_BODY }),
    doc({ id: "stale", projectId: "proj", slug: "native-mem-home-claude-md", sourceKind: "native-memory", scope: "project", body: SECRET_BODY }),
    doc({ id: "curated", projectId: "proj", slug: "native-mem-home-rules-x", sourceKind: "native-memory", scope: "project", body: "curated" }),
    doc({ id: "shared", projectId: "proj", slug: "runbook", scope: "project", body: SECRET_BODY }),
    doc({ id: "team", projectId: "proj", slug: "team-runbook", scope: "project", sourceKind: "runbook", body: TEAM_BODY }),
    doc({ id: "wide", projectId: "proj", slug: "wide", scope: "global", body: SECRET_BODY }),
    doc({ id: "mine", projectId: "proj", slug: "my-note", scope: "user", ownerUser: "alice", body: SECRET_BODY }),
    doc({ id: "plan", projectId: "proj", slug: "design", body: "# Design\n\na plan" }),
    doc({ id: "lookalike", projectId: "proj", slug: "roadmap", body: "hand-written notes" }),
    doc({ id: "plain", projectId: "proj", slug: "notes", body: "unlabeled" }),
    doc({ id: "labeled", projectId: "proj", slug: "fact", body: "a labeled fact" }),
    doc({ id: "scratchy", projectId: "scratch", slug: "broad", scope: "global", originClass: "agent", body: "broad claim" }),
  ];
  // A deleted doc leaves rowid gaps, which a restore must keep (the vec mirror is keyed on chunk rowids).
  store.upsertDoc(doc({ id: "gone-doc", slug: "gone" }));
  store.upsertChunk({ id: "gone-doc-c", knowledgeId: "gone-doc", chunkIndex: 0, text: "gone", embedding: [1, 1] });
  for (const r of rows) {
    store.upsertDoc(r);
    store.upsertChunk({ id: `${r.id}-c`, knowledgeId: r.id, chunkIndex: 0, text: r.body, embedding: [1, 0] });
    store.upsertChunk({ id: `${r.id}-c2`, knowledgeId: r.id, chunkIndex: 1, text: `${r.title}\n${r.body}`, embedding: [0, 1] });
  }
  store.deleteDoc("proj", "gone");
  db.run("CREATE TABLE sessions_like (id TEXT PRIMARY KEY, note TEXT)");
  db.run("INSERT INTO sessions_like VALUES ('s1', 'collector data')");
  await writeDocFile(
    "global",
    "native-mem-home-claude-md",
    "# mirrored from the home config\ntitle: Doc\nsource_kind: native-memory\norigin_class: owner\n" +
      "last_verified_at: 2026-08-16\ntags: [home, config]\nnative_memory_from: /h/.claude/CLAUDE.md",
    SECRET_BODY
  );
  await writeDocFile("proj", "native-mem-home-claude-md", "title: Doc\nsource_kind: native-memory\nnative_memory_from: /h/.claude/CLAUDE.md", SECRET_BODY);
  await writeDocFile("proj", "native-mem-home-rules-x", "title: Doc\nsource_kind: native-memory", "curated");
  await writeDocFile(
    "proj",
    "runbook",
    "title: Doc # inline note\nsource_kind: code\nrelated:\n  - fact\nsummary: >\n  folded\n  text\nlast_verified_at: 2026-08-16",
    SECRET_BODY
  );
  await writeDocFile("proj", "team-runbook", "title: Team\nsource_kind: runbook", TEAM_BODY);
  await writeDocFile("proj", "wide", "title: Doc\nsource_kind: code\nscope: global", SECRET_BODY);
  await writeDocFile("proj", "my-note", "title: Doc\nsource_kind: code\nscope: user\nowner_user: alice", SECRET_BODY);
  await writeDocFile("proj", "design", '# ingested\ntitle: Doc\ningested_from: "/repo/plan/design.md"\ntags: [plan]', "# Design\n\na plan");
  await writeDocFile("proj", "notes", "title: Doc", "unlabeled");
  await writeDocFile("proj", "fact", "title: Doc\nsource_kind: code", "a labeled fact");
  await writeDocFile("scratch", "broad", "title: Broad\nsource_kind: code\nscope: global\norigin_class: agent", "broad claim");
  return db;
}

/**
 * Puts the seeded DB back on an older knowledge schema — the FTS table without
 * its slug column and stemming, a chunk column missing — and leaves an orphan
 * chunk behind, so the schema upgrade has work to report.
 */
function ageSchema(db: Database): void {
  db.run("DROP TABLE knowledge_fts");
  db.run("CREATE VIRTUAL TABLE knowledge_fts USING fts5(id UNINDEXED, title, body, tags)");
  db.run("INSERT INTO knowledge_fts (id, title, body, tags) SELECT id, title, body, '' FROM knowledge");
  db.run("ALTER TABLE knowledge_chunks DROP COLUMN chunker_version");
  db.run("INSERT INTO knowledge_chunks (id, knowledge_id, chunk_index, text, embedding_json) VALUES ('orphan-c', 'gone', 0, 'x', '[1,0]')");
}

const row = (db: Database, id: string) =>
  db.query("SELECT scope, owner_user, source_kind, body FROM knowledge WHERE id = ?").get(id) as {
    scope: string;
    owner_user: string | null;
    source_kind: string;
    body: string;
  } | null;

const encode = (_k: string, v: unknown) => (v instanceof Uint8Array ? Buffer.from(v).toString("base64") : v);

/** Every row of every table (with rowids, and the FTS and vec tables read through their modules), for row-equality. */
function dumpDb(path: string): Record<string, unknown[]> {
  const db = new Database(path, { readonly: true });
  try {
    const tables = db
      .query(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' " +
          "AND name NOT LIKE 'knowledge_fts_%' AND name NOT LIKE 'knowledge_chunks_vec_%' ORDER BY name"
      )
      .all() as Array<{ name: string; sql: string }>;
    const out: Record<string, unknown[]> = {};
    for (const { name, sql } of tables) {
      if (name === "knowledge_chunks_vec" && !snapshotKnowledge(db).tables.get(name)?.columns.length) continue;
      const rowid = /WITHOUT ROWID/i.test(sql) ? "" : "rowid AS __rowid, ";
      out[name] = (db.query(`SELECT ${rowid}* FROM "${name}"`).all() as unknown[]).map((r) => JSON.stringify(r, encode)).sort();
      out[`${name}:ddl`] = [sql];
    }
    return out;
  } finally {
    db.close();
  }
}

/** Every file under `dir`: relative path → bytes + mtime. */
async function dumpFiles(dir: string): Promise<Record<string, { bytes: string; mtimeMs: number }>> {
  const out: Record<string, { bytes: string; mtimeMs: number }> = {};
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out[relative(dir, p)] = { bytes: (await readFile(p)).toString("base64"), mtimeMs: (await stat(p)).mtimeMs };
    }
  };
  await walk(dir);
  return out;
}

/** A change as the plan-versus-diff comparison keys it: a redaction or rewrite is a value change; a set keeps its values. */
function changeKey(c: Change): string {
  const kind = c.action === "set" ? `set ${c.before} -> ${c.after}` : c.action === "redact" || c.action === "rewrite" ? "change" : c.action;
  return `${c.target} ${c.ref} ${c.field} ${kind}`;
}

const uniqueSorted = (keys: string[]) => [...new Set(keys)].sort();

/** The front matter of `raw` as blocks: each top-level key with its continuation lines, and each other line. */
function frontmatterBlocks(raw: string): Array<{ key: string | null; text: string }> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(raw);
  const blocks: Array<{ key: string | null; text: string }> = [];
  for (const line of m ? m[1].split("\n") : []) {
    const key = /^([A-Za-z_][\w-]*):/.exec(line)?.[1] ?? null;
    const last = blocks[blocks.length - 1];
    if (key === null && last?.key && /^(?:[ \t]|-)/.test(line)) last.text += `\n${line}`;
    else blocks.push({ key, text: line });
  }
  return blocks;
}

/**
 * The file changes between two trees, keyed like changeKey: a deleted file, each
 * front-matter key whose block differs, and a changed body. Throws when a line
 * outside a changed key moved or changed, which a text splice never does.
 */
function fileChanges(
  before: Record<string, { bytes: string }>,
  after: Record<string, { bytes: string }>
): { keys: string[]; bodies: Map<string, { before: string; after: string }> } {
  const keys: string[] = [];
  const bodies = new Map<string, { before: string; after: string }>();
  const text = (b: { bytes: string }) => Buffer.from(b.bytes, "base64").toString("utf-8");
  for (const [rel, file] of Object.entries(before)) {
    const ref = rel.replace(/\.md$/, "");
    const next = after[rel];
    if (!next) {
      keys.push(`file ${ref} file delete`);
      continue;
    }
    if (next.bytes === file.bytes) continue;
    const [a, b] = [text(file), text(next)];
    const [blocksA, blocksB] = [frontmatterBlocks(a), frontmatterBlocks(b)];
    const changed = new Set<string>();
    const byKey = (blocks: typeof blocksA) => new Map(blocks.filter((x) => x.key).map((x) => [x.key!, x.text]));
    const [keysA, keysB] = [byKey(blocksA), byKey(blocksB)];
    for (const key of new Set([...keysA.keys(), ...keysB.keys()])) if (keysA.get(key) !== keysB.get(key)) changed.add(key);
    const untouched = (blocks: typeof blocksA) => blocks.filter((x) => !x.key || !changed.has(x.key)).map((x) => x.text);
    expect(untouched(blocksB)).toEqual(untouched(blocksA));
    for (const key of changed) keys.push(`file ${ref} ${key} change`);
    if (frontmatterBody(a) !== frontmatterBody(b)) {
      keys.push(`file ${ref} body change`);
      bodies.set(ref, { before: frontmatterBody(a), after: frontmatterBody(b) });
    }
  }
  for (const rel of Object.keys(after)) if (!before[rel]) keys.push(`file ${rel.replace(/\.md$/, "")} file insert`);
  return { keys, bodies };
}

/** A planned file `set` compared on its key alone: the file diff sees that the key's line changed, not the values. */
const plannedFileKey = (c: Change) => `file ${c.ref} ${c.field} ${c.action === "delete" ? "delete" : "change"}`;

describe("kb migrations", () => {
  test("a dry run reports every change by ref and field, never a secret value, and writes nothing", async () => {
    (await seed()).close();
    const dbBefore = dumpDb(dbPath);
    const before = await dumpFiles(knowledgeDir);
    const db = new Database(dbPath);
    const options: MigrationOptions = { apply: false, knowledgeDir, hostUser: "alice" };
    const [schema, personal, relabel, demote] = await runMigrations(db, MIGRATIONS, options);
    db.close();
    expect(schema.id).toBe(SCHEMA_STEP_ID);
    expect(schema.changes).toEqual([]);
    expect(personal.counts).toMatchObject({ rescoped: 1, staleDeleted: 1, filesDeleted: 1, filesRescoped: 1 });
    expect(relabel.counts).toMatchObject({ toSpec: 1, toUnclassified: 1 });
    expect(demote.counts).toMatchObject({ demoted: 1, filesPatched: 1 });
    expect(personal.backupDir).toBeUndefined();

    const text = [personal, relabel, demote].map((r) => formatReport(r, true)).join("\n");
    expect(text).not.toContain("hunter2very");
    expect(text).not.toContain("123456789012");
    expect(text).toContain("db   global/native-mem-home-claude-md scope: global → user");
    expect(text).toContain("db   global/native-mem-home-claude-md#home-c vec.owner_user:  → alice");
    expect(text).toContain("file proj/native-mem-home-claude-md file: delete");
    // A delete lists every row it cascades to.
    for (const line of ["#stale-c chunk: delete", "#stale-c2 chunk: delete", "#stale-c vec: delete", "native-mem-home-claude-md fts: delete", "native-mem-home-claude-md row: delete"]) {
      expect(text).toContain(line);
    }
    expect(text).toContain("db   proj/runbook body: redact [");
    expect(text).toContain("db   proj/runbook fts.body: redact [");
    expect(text).toContain("db   proj/runbook#shared-c chunk.text: redact [");
    expect(text).toContain("connection-string-password");
    expect(text).toContain("db   proj/notes source_kind: code → unclassified");
    expect(text).not.toContain("proj/fact");
    // The team runbook loses only its account ids; the curated home-rules copy is never in the plan.
    const teamLines = text.split("\n").filter((l) => l.includes("team-runbook"));
    expect(teamLines.length).toBeGreaterThan(0);
    for (const line of teamLines) expect(line.replace(/account-id-[a-z]+/g, "")).not.toMatch(/\[\d+,\d+\) [a-z]/);
    expect(text).not.toContain("444455556666");
    expect(text).not.toContain("native-mem-home-rules-x");
    expect(personal.notes.join("\n")).toContain("curated");

    expect(dumpDb(dbPath)).toEqual(dbBefore);
    expect(await dumpFiles(knowledgeDir)).toEqual(before);
    expect(existsSync(backupDir)).toBe(false);
  });

  test("an apply changes exactly what the dry run planned, in the DB and the files, and nothing else", async () => {
    const seeded = await seed();
    ageSchema(seeded);
    seeded.close();
    const migrations = MIGRATIONS;
    const options: MigrationOptions = { apply: false, knowledgeDir, hostUser: "alice", backupDir };

    const db = new Database(dbPath);
    const planned = await runMigrations(db, migrations, options);
    const stateBefore = snapshotKnowledge(db);
    const beforeCopy = join(root, "before.db");
    await writeFile(beforeCopy, db.serialize());
    const filesBefore = await dumpFiles(knowledgeDir);
    const otherBefore = dumpDb(dbPath).sessions_like;

    const applied = await runMigrations(db, migrations, { ...options, apply: true });
    const stateAfter = snapshotKnowledge(db);
    db.close();

    // The schema upgrade is its own reported step: the FTS rebuild, the
    // re-added chunk column, and the orphan chunk it heals.
    const schema = planned[0];
    expect(schema.id).toBe(SCHEMA_STEP_ID);
    expect(schema.changes.map(changeKey)).toEqual(
      expect.arrayContaining([
        "db schema:knowledge_fts columns set id,title,body,tags -> id,slug,title,body,tags",
        "db schema:knowledge_chunks columns set id,knowledge_id,chunk_index,text,embedding_json,embedding_blob -> id,knowledge_id,chunk_index,text,embedding_json,embedding_blob,chunker_version",
        "db ?gone#orphan-c chunk delete",
      ])
    );
    expect(applied.map((r) => r.changes)).toEqual(planned.map((r) => r.changes));

    const plannedDb = uniqueSorted(planned.flatMap((r) => r.changes.filter((c) => c.target === "db").map(changeKey)));
    const actualDb = uniqueSorted(diffKnowledge(stateBefore, stateAfter).map(changeKey));
    expect(actualDb).toEqual(plannedDb);

    // Each redaction left exactly the planned spans replaced.
    const beforeDb = new Database(beforeCopy, { readonly: true });
    const afterDb = new Database(dbPath, { readonly: true });
    const textOf = (d: Database, c: Change): string | undefined => {
      const [docRef, chunkId] = c.ref.split("#");
      const [projectId, slug] = docRef.split("/");
      const id = (d.query("SELECT id FROM knowledge WHERE project_id = ? AND slug = ?").get(projectId, slug) as { id: string } | null)?.id;
      if (c.field === "title" || c.field === "body") return (d.query(`SELECT ${c.field} AS v FROM knowledge WHERE id = ?`).get(id ?? "") as { v: string }).v;
      if (c.field.startsWith("fts.")) return (d.query(`SELECT ${c.field.slice(4)} AS v FROM knowledge_fts WHERE id = ?`).get(id ?? "") as { v: string }).v;
      if (c.field === "chunk.text") return (d.query("SELECT text AS v FROM knowledge_chunks WHERE id = ?").get(chunkId) as { v: string }).v;
      return undefined;
    };
    const redactions = planned.flatMap((r) => r.changes.filter((c) => c.target === "db" && c.action === "redact"));
    expect(redactions.length).toBeGreaterThan(0);
    for (const c of redactions) {
      expect(textOf(afterDb, c)).toBe(applyRedactions(textOf(beforeDb, c)!, c.spans as RedactionSpan[]));
    }
    beforeDb.close();
    afterDb.close();

    // Files: only the planned keys' lines and bodies changed; comments, the
    // date format, flow lists and the folded scalar are byte-identical.
    const filesAfter = await dumpFiles(knowledgeDir);
    const { keys, bodies } = fileChanges(filesBefore, filesAfter);
    const plannedFiles = planned.flatMap((r) => r.changes.filter((c) => c.target === "file"));
    expect(uniqueSorted(keys)).toEqual(uniqueSorted(plannedFiles.map(plannedFileKey)));
    for (const c of plannedFiles.filter((c) => c.field === "body")) {
      const body = bodies.get(c.ref)!;
      expect(body.after).toBe(applyRedactions(body.before, c.spans as RedactionSpan[]));
    }
    const home = Buffer.from(filesAfter["global/native-mem-home-claude-md.md"].bytes, "base64").toString("utf-8");
    expect(home).toContain("# mirrored from the home config\n");
    expect(home).toContain("last_verified_at: 2026-08-16\ntags: [home, config]\n");
    const runbook = Buffer.from(filesAfter["proj/runbook.md"].bytes, "base64").toString("utf-8");
    // Redacted, its body matches the global `wide` doc's, so 004 retires it and splices its confidence.
    expect(runbook).toStartWith(
      `---\ntitle: Doc # inline note\nsource_kind: code\nrelated:\n  - fact\nsummary: >\n  folded\n  text\nlast_verified_at: 2026-08-16\nconfidence: ${DISPUTED_CONFIDENCE}\n---\n`
    );

    // Collector data outside the knowledge tables is untouched.
    expect(dumpDb(dbPath).sessions_like).toEqual(otherBefore);
  });

  test("apply updates the DB and the markdown consistently, and a second apply is a no-op", async () => {
    const db = await seed();
    const options: MigrationOptions = { apply: true, knowledgeDir, hostUser: "alice", backupDir };
    const reports = await runMigrations(db, DEFAULT_MIGRATIONS, options);
    expect(reports[1].backupDir).toBe(backupDir);
    expect((await backupTargets(backupDir)).status).toBe("complete");
    expect(existsSync(pendingMarker(dbPath))).toBe(false);

    // 001: the home mirror is personal, the stale copy is gone, secrets are
    // gone everywhere, and so are account ids; a team doc keeps its other
    // credential-shaped data.
    expect(row(db, "home")).toMatchObject({ scope: "user", owner_user: "alice" });
    expect((await readRawDocFile(knowledgeDir, "global", "native-mem-home-claude-md"))?.data).toMatchObject({
      scope: "user",
      owner_user: "alice",
      native_memory_from: "/h/.claude/CLAUDE.md",
    });
    expect(row(db, "stale")).toBeNull();
    expect(db.query("SELECT COUNT(*) AS n FROM knowledge_chunks WHERE knowledge_id = 'stale'").get()).toEqual({ n: 0 });
    expect(existsSync(join(knowledgeDir, "proj", "native-mem-home-claude-md.md"))).toBe(false);
    expect(row(db, "curated")?.body).toBe("curated");
    for (const id of ["home", "shared", "wide", "mine"]) expect(row(db, id)?.body).not.toContain("hunter2very");
    for (const id of ["home", "shared", "wide", "mine"]) expect(row(db, id)?.body).not.toContain("123456789012");
    expect(row(db, "shared")?.body).toContain("account [REDACTED]");
    const teamRedacted = TEAM_BODY.replaceAll("444455556666", "[REDACTED]");
    expect(row(db, "team")?.body).toBe(teamRedacted);
    expect((await readRawDocFile(knowledgeDir, "proj", "team-runbook"))?.content.trim()).toBe(teamRedacted);
    const fts = db.query("SELECT body FROM knowledge_fts WHERE id = 'shared'").get() as { body: string };
    expect(fts.body).not.toContain("hunter2very");
    const chunk = db.query("SELECT text FROM knowledge_chunks WHERE id = 'shared-c'").get() as { text: string };
    expect(chunk.text).not.toContain("hunter2very");
    const runbook = await readRawDocFile(knowledgeDir, "proj", "runbook");
    expect(runbook?.content).not.toContain("hunter2very");
    expect(runbook?.data.related).toEqual(["fact"]);

    // 002: the ingested plan doc is a spec in both places; the unlabeled doc is
    // unclassified; an explicitly labeled code doc is untouched.
    expect(row(db, "plan")?.source_kind).toBe("spec");
    expect((await readRawDocFile(knowledgeDir, "proj", "design"))?.data).toMatchObject({
      source_kind: "spec",
      origin_class: "owner",
    });
    expect(row(db, "plain")?.source_kind).toBe("unclassified");
    expect(row(db, "labeled")?.source_kind).toBe("code");
    // 003 is opt-in and not part of a default run.
    expect(row(db, "scratchy")?.scope).toBe("global");

    const again = await runMigrations(db, DEFAULT_MIGRATIONS, { ...options, backupDir: join(root, "backup2") });
    for (const report of again) {
      expect(report.changes).toEqual([]);
      expect(report.applied).toBe(false);
    }
    expect(existsSync(join(root, "backup2"))).toBe(false);
    db.close();
  });

  test("a migration that rewrites a stamped doc leaves it with no trusted writer", async () => {
    const db = await seed();
    const store = new KnowledgeStore(db);
    expect(store.stampWriter("proj", "my-note", "persona")).toBe(true);
    expect(store.stampWriter("proj", "fact", "persona")).toBe(true);
    await runMigrations(db, DEFAULT_MIGRATIONS, { apply: true, knowledgeDir, hostUser: "alice", backupDir });
    // The redaction rewrote my-note's body, so the stamp no longer verifies; fact was left alone.
    expect(store.writerOf("proj", "my-note")).toBeNull();
    expect(store.writerOf("proj", "fact")).toBe("persona");
  });

  test("apply → rollback restores every table row-for-row and every knowledge file byte-for-byte", async () => {
    const seeded = await seed();
    ageSchema(seeded);
    seeded.close();
    const dbBefore = dumpDb(dbPath);
    const filesBefore = await dumpFiles(knowledgeDir);

    const db = new Database(dbPath);
    await runMigrations(db, MIGRATIONS, { apply: true, knowledgeDir, hostUser: "alice", backupDir });
    // Collector data written after the apply survives the rollback.
    db.run("INSERT INTO sessions_like VALUES ('s2', 'written after the apply')");
    db.close();
    expect(dumpDb(dbPath).knowledge).not.toEqual(dbBefore.knowledge);
    expect(await dumpFiles(knowledgeDir)).not.toEqual(filesBefore);

    const result = await rollbackMigrations(backupDir);
    expect(result.dbPath).toBe(dbPath);
    const dbAfter = dumpDb(dbPath);
    expect(dbAfter.sessions_like).toHaveLength(2);
    expect({ ...dbAfter, sessions_like: [] }).toEqual({ ...dbBefore, sessions_like: [] });
    expect(await dumpFiles(knowledgeDir)).toEqual(filesBefore);
    expect((await backupTargets(backupDir)).status).toBe("rolled-back");
  });

  test("the evidence pass's freshness findings are snapshotted, and a rollback restores them row-for-row", async () => {
    const seeded = await seed();
    seeded.run(
      "CREATE TABLE knowledge_freshness (project_id TEXT NOT NULL, slug TEXT NOT NULL, anchor_at TEXT, cap REAL, " +
        "findings_json TEXT NOT NULL DEFAULT '[]', about_repo INTEGER NOT NULL DEFAULT 0, checked_at TEXT NOT NULL, " +
        "PRIMARY KEY (project_id, slug))"
    );
    seeded.run(
      "INSERT INTO knowledge_freshness VALUES ('proj', 'fact', '2026-01-01T00:00:00.000Z', 0.5, '[]', 1, '2026-02-01T00:00:00.000Z')"
    );
    expect(snapshotKnowledge(seeded).tables.get("knowledge_freshness")?.rows.size).toBe(1);
    seeded.close();
    const dbBefore = dumpDb(dbPath);

    const db = new Database(dbPath);
    await runMigrations(db, MIGRATIONS, { apply: true, knowledgeDir, hostUser: "alice", backupDir });
    db.run("UPDATE knowledge_freshness SET cap = 0.1, about_repo = 0");
    db.close();
    expect(dumpDb(dbPath).knowledge_freshness).not.toEqual(dbBefore.knowledge_freshness);

    await rollbackMigrations(backupDir);
    const dbAfter = dumpDb(dbPath);
    expect(dbAfter.knowledge_freshness).toEqual(dbBefore.knowledge_freshness);
    expect(dbAfter["knowledge_freshness:ddl"]).toEqual(dbBefore["knowledge_freshness:ddl"]);
  });

  test("the fact-check and re-verify attempt state is snapshotted, and a rollback restores it row-for-row", async () => {
    const seeded = await seed();
    seeded.run(
      "CREATE TABLE IF NOT EXISTS knowledge_reverify_attempts (project_id TEXT NOT NULL, slug TEXT NOT NULL, " +
        "body_hash TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_outcome TEXT, last_attempt_at TEXT NOT NULL, " +
        "PRIMARY KEY (project_id, slug))"
    );
    seeded.run("INSERT INTO knowledge_reverify_attempts VALUES ('proj', 'fact', 'h1', 2, 'error', '2026-02-01T00:00:00.000Z')");
    seeded.run(
      "INSERT INTO knowledge_verifications (id, project_id, slug, body_hash, attempts, repo_path, last_outcome, updated_at) " +
        "VALUES ('proj/fact', 'proj', 'fact', 'h1', 1, '/repo', 'unverified', '2026-02-01 00:00:00')"
    );
    const state = snapshotKnowledge(seeded);
    expect(state.tables.get("knowledge_reverify_attempts")?.rows.size).toBe(1);
    expect(state.tables.get("knowledge_verifications")?.rows.size).toBe(1);
    seeded.close();
    const dbBefore = dumpDb(dbPath);

    const db = new Database(dbPath);
    await runMigrations(db, MIGRATIONS, { apply: true, knowledgeDir, hostUser: "alice", backupDir });
    db.run("UPDATE knowledge_reverify_attempts SET attempts = 3, last_outcome = 'unverified'");
    db.run("DELETE FROM knowledge_verifications");
    db.close();
    expect(dumpDb(dbPath).knowledge_reverify_attempts).not.toEqual(dbBefore.knowledge_reverify_attempts);

    await rollbackMigrations(backupDir);
    const dbAfter = dumpDb(dbPath);
    for (const table of ["knowledge_reverify_attempts", "knowledge_verifications"]) {
      expect(dbAfter[table]).toEqual(dbBefore[table]);
      expect(dbAfter[`${table}:ddl`]).toEqual(dbBefore[`${table}:ddl`]);
    }
  });

  test("a failed apply restores its backup itself, records it, and a re-run starts from the original state", async () => {
    if (process.getuid?.() === 0) return;
    (await seed()).close();
    // 002 must patch a file in a read-only dir; 001 writes elsewhere first.
    await mkdir(join(knowledgeDir, "ro"), { recursive: true });
    await writeFile(join(knowledgeDir, "ro", "spec.md"), '---\ntitle: Spec\ningested_from: "/repo/plan/spec.md"\n---\n\nspec\n');
    await chmod(join(knowledgeDir, "ro", "spec.md"), 0o444);
    await chmod(join(knowledgeDir, "ro"), 0o555);
    const dbBefore = dumpDb(dbPath);
    const filesBefore = await dumpFiles(knowledgeDir);

    const db = new Database(dbPath);
    const options: MigrationOptions = { apply: true, knowledgeDir, hostUser: "alice", backupDir };
    const failure = await runMigrations(db, DEFAULT_MIGRATIONS, options).catch((err) => err);
    expect(failure).toBeInstanceOf(MigrationFailure);
    expect((failure as MigrationFailure).rolledBack).toBe(true);
    expect((failure as MigrationFailure).backupDir).toBe(backupDir);
    expect((failure as Error).message).toContain("EACCES");
    db.close();

    expect(dumpDb(dbPath)).toEqual(dbBefore);
    expect(await dumpFiles(knowledgeDir)).toEqual(filesBefore);
    const manifest = JSON.parse(await readFile(join(backupDir, "manifest.json"), "utf-8"));
    expect(manifest.status).toBe("rolled-back");
    expect(manifest.error).toContain("EACCES");
    expect(existsSync(pendingMarker(dbPath))).toBe(false);

    // With the dir writable again, a re-run applies from the original state.
    await chmod(join(knowledgeDir, "ro"), 0o755);
    await chmod(join(knowledgeDir, "ro", "spec.md"), 0o644);
    const again = new Database(dbPath);
    await runMigrations(again, DEFAULT_MIGRATIONS, { ...options, backupDir: join(root, "backup2") });
    expect(row(again, "shared")?.body).not.toContain("hunter2very");
    again.close();
    expect((await readRawDocFile(knowledgeDir, "ro", "spec"))?.data.source_kind).toBe("spec");
  });

  test("an apply over an incomplete backup is refused until that backup is rolled back", async () => {
    const db = await seed();
    await runMigrations(db, DEFAULT_MIGRATIONS, { apply: true, knowledgeDir, hostUser: "alice", backupDir });
    // A process killed mid-apply leaves its marker and an in-progress manifest.
    const manifestPath = join(backupDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
    await writeFile(manifestPath, JSON.stringify({ ...manifest, status: "in-progress" }));
    await writeFile(pendingMarker(dbPath), `${backupDir}\n`);

    const options: MigrationOptions = { apply: true, knowledgeDir, hostUser: "alice", backupDir: join(root, "backup2") };
    await expect(runMigrations(db, DEFAULT_MIGRATIONS, options)).rejects.toThrow(/did not complete.*--rollback/);
    expect(existsSync(join(root, "backup2"))).toBe(false);
    // A dry run is still allowed.
    await runMigrations(db, DEFAULT_MIGRATIONS, { ...options, apply: false });
    db.close();

    await rollbackMigrations(backupDir);
    expect(existsSync(pendingMarker(dbPath))).toBe(false);
    const after = new Database(dbPath);
    const reports = await runMigrations(after, DEFAULT_MIGRATIONS, options);
    expect(reports.some((r) => r.applied)).toBe(true);
    after.close();
  });

  test("a rollback is refused while another process holds the DB", async () => {
    const db = await seed();
    await runMigrations(db, DEFAULT_MIGRATIONS, { apply: true, knowledgeDir, hostUser: "alice", backupDir });
    db.close();
    if (!existsSync("/proc/self/fd")) return;
    const holder = Bun.spawn(["bun", "-e", `const { Database } = require("bun:sqlite"); globalThis.held = new Database(${JSON.stringify(dbPath)}); globalThis.held.query("SELECT 1").get(); setInterval(() => {}, 1000);`]);
    try {
      for (let i = 0; i < 100 && processesHolding(dbPath).length === 0; i++) await Bun.sleep(50);
      expect(processesHolding(dbPath)).toContain(holder.pid);
      await expect(rollbackMigrations(backupDir)).rejects.toThrow(/open in process/);
    } finally {
      holder.kill();
      await holder.exited;
    }
    await rollbackMigrations(backupDir);
  });

  test("a DB-only apply leaves stale home-mirror rows and the file work for a run with the knowledge dir", async () => {
    const db = await seed();
    const [, personal] = await runMigrations(db, DEFAULT_MIGRATIONS, { apply: true, hostUser: "alice", backupDir });
    expect(personal.counts).toMatchObject({ rescoped: 1, staleDeleted: 0 });
    expect(personal.notes.join("\n")).toContain("ingest marker");
    expect(row(db, "home")?.scope).toBe("user");
    expect(row(db, "stale")).not.toBeNull();
    const [, withFiles] = await runMigrations(db, DEFAULT_MIGRATIONS, {
      apply: true,
      knowledgeDir,
      hostUser: "alice",
      backupDir: join(root, "backup2"),
    });
    expect(withFiles.counts).toMatchObject({ rescoped: 0, staleDeleted: 1, filesRescoped: 1, filesDeleted: 1 });
    expect(row(db, "stale")).toBeNull();
    expect(row(db, "curated")).not.toBeNull();
    expect((await readRawDocFile(knowledgeDir, "global", "native-mem-home-claude-md"))?.data.scope).toBe("user");
    expect((await readRawDocFile(knowledgeDir, "proj", "runbook"))?.content).not.toContain("hunter2very");
    db.close();
  });

  test("DB-only mode relabels a plan mirror only when its body matches the plan file", async () => {
    const db = await seed();
    await writeFile(join(planDir, "design.md"), "# Design\n\na plan\n");
    // Same basename and stamps as a plan file, different content: hand-written.
    await writeFile(join(planDir, "roadmap.md"), "# Roadmap\n\nthe repo version\n");
    const [, , relabel] = await runMigrations(db, DEFAULT_MIGRATIONS, {
      apply: true,
      hostUser: "alice",
      planDirs: new Map([["proj", planDir]]),
      backupDir,
    });
    expect(relabel.counts).toMatchObject({ toSpec: 1, toUnclassified: 0 });
    expect(row(db, "plan")?.source_kind).toBe("spec");
    expect(row(db, "lookalike")?.source_kind).toBe("code");
    expect(row(db, "plain")?.source_kind).toBe("code");
    // The markdown is not touched without a knowledge dir.
    expect((await readRawDocFile(knowledgeDir, "proj", "design"))?.data.source_kind).toBeUndefined();
    db.close();
  });

  test("003 demotes scratch-homed agent globals when named, in the DB, its vec rows and the file", async () => {
    const db = await seed();
    const demote = MIGRATIONS.filter((m) => m.id === "003-demote-scratch-globals");
    const [, report] = await runMigrations(db, demote, { apply: true, knowledgeDir, hostUser: "alice", backupDir });
    expect(report.counts).toMatchObject({ demoted: 1, filesPatched: 1 });
    expect(report.changes.map(changeKey)).toContain("db scratch/broad#scratchy-c vec.scope set global -> project");
    expect(row(db, "scratchy")?.scope).toBe("project");
    expect(row(db, "wide")?.scope).toBe("global");
    expect((await readRawDocFile(knowledgeDir, "scratch", "broad"))?.data.scope).toBe("project");
    db.close();
  });

  test("004 stamps the host user's Persona-shaped memories when named, and the rollback removes the stamps", async () => {
    const db = await seed();
    const store = new KnowledgeStore(db);
    const memory = (overrides: Partial<KnowledgeDoc>) =>
      store.upsertDoc(
        doc({
          projectId: "global",
          slug: "persona-alice-tests",
          tags: ["persona", "preference"],
          scope: "user",
          ownerUser: "alice",
          originClass: "agent",
          sourceKind: "decision",
          body: "run tests before committing",
          ...overrides,
        })
      );
    memory({});
    memory({ slug: "persona-bob-tests", ownerUser: "bob" });
    memory({ slug: "persona-alice-worker", sourceSessionId: "worker-1" });
    memory({ slug: "persona-alice-untagged", tags: ["preference"] });
    memory({ slug: "persona-alice-owner", originClass: "owner" });
    db.close();
    const before = dumpDb(dbPath);

    const again = new Database(dbPath);
    const stamp = MIGRATIONS.filter((m) => m.id === "009-stamp-persona-memories");
    expect(DEFAULT_MIGRATIONS.map((m) => m.id)).not.toContain("009-stamp-persona-memories");
    const [, dry] = await runMigrations(again, stamp, { apply: false, hostUser: "alice", backupDir });
    expect(dry.changes.map((c) => `${c.ref} ${c.field}`)).toEqual(["global/persona-alice-tests writer_stamp"]);
    expect(dry.counts).toMatchObject({ stamped: 1, refused: 3 });
    expect(dry.notes).toEqual([
      "global/persona-alice-owner origin_class=owner source_session_id=none: refused (origin_class is owner, not agent)",
      "global/persona-alice-tests origin_class=agent source_session_id=none: stamp",
      "global/persona-alice-untagged origin_class=agent source_session_id=none: refused (no persona tag)",
      "global/persona-alice-worker origin_class=agent source_session_id=worker-1: refused (written from a session)",
    ]);
    expect(new KnowledgeStore(again).writerOf("global", "persona-alice-tests")).toBeNull();
    const [, applied] = await runMigrations(again, stamp, { apply: true, hostUser: "alice", backupDir });
    expect(applied.counts).toMatchObject({ stamped: 1 });
    expect(new KnowledgeStore(again).writerOf("global", "persona-alice-tests")).toBe("persona");
    expect(new KnowledgeStore(again).writerOf("global", "persona-bob-tests")).toBeNull();
    again.close();

    await rollbackMigrations(backupDir);
    expect(dumpDb(dbPath)).toEqual(before);
  });
});

describe("live-target guard", () => {
  /** A fake HOME holding a fake "live" DB and knowledge dir, plus DB_PATH/KNOWLEDGE_DIR targets. */
  async function fakeEnv() {
    const home = join(root, "home");
    const liveDb = join(home, ".local", "share", "standup", "standup.db");
    const liveKnowledge = join(home, ".config", "standup", "knowledge");
    await mkdir(join(home, ".local", "share", "standup"), { recursive: true });
    await mkdir(liveKnowledge, { recursive: true });
    await writeFile(liveDb, "");
    const envDb = join(root, "env.db");
    const envKnowledge = join(root, "env-knowledge");
    await writeFile(envDb, "");
    await mkdir(envKnowledge);
    return { env: { HOME: home, DB_PATH: envDb, KNOWLEDGE_DIR: envKnowledge }, liveDb, liveKnowledge, envDb, envKnowledge };
  }

  test("refuses the default DB, its -wal/-shm, DB_PATH, and symlinks or hardlinks to them", async () => {
    const { env, liveDb, envDb } = await fakeEnv();
    await writeFile(`${liveDb}-wal`, "");
    const sym = join(root, "sym.db");
    const hard = join(root, "hard.db");
    const hardEnv = join(root, "hard-env.db");
    await symlink(liveDb, sym);
    await link(liveDb, hard);
    await link(envDb, hardEnv);
    for (const path of [liveDb, `${liveDb}-wal`, envDb, sym, hard, hardEnv]) {
      expect(() => assertMigratableDbPath(path, false, env)).toThrow(/refusing/);
    }
    expect(assertMigratableDbPath(hard, true, env)).toBe(hard);
    const copy = join(root, "copy.db");
    await writeFile(copy, "");
    expect(assertMigratableDbPath(copy, false, env)).toBe(copy);
  });

  test("refuses the default knowledge dir, KNOWLEDGE_DIR, and symlinks to them", async () => {
    const { env, liveKnowledge, envKnowledge } = await fakeEnv();
    const sym = join(root, "sym-knowledge");
    await symlink(liveKnowledge, sym);
    for (const dir of [liveKnowledge, envKnowledge, sym]) {
      expect(() => assertMigratableKnowledgeDir(dir, false, env)).toThrow(/refusing/);
    }
    await mkdir(knowledgeDir, { recursive: true });
    expect(assertMigratableKnowledgeDir(knowledgeDir, false, env)).toBe(knowledgeDir);
  });
});

/** A corpus for the write-quality migrations (004–007), in the DB and on disk. */
async function seedQuality(): Promise<Database> {
  const db = new Database(dbPath);
  const store = new KnowledgeStore(db);
  const t0 = "2026-08-01T00:00:00.000Z";
  const t1 = "2026-08-02T00:00:00.000Z";
  const rows: KnowledgeDoc[] = [
    // 004: an owner doc and its agent copy in one project.
    doc({ id: "dup-a", slug: "dup-a", body: "the same body", originClass: "owner", generatedAt: t1 }),
    doc({ id: "dup-b", slug: "dup-b", body: "the  same\nbody", originClass: "agent", generatedAt: t0 }),
    // 004: a global doc and a copy in another project (whitespace aside).
    doc({ id: "wide-g", projectId: "global", slug: "wide", body: "shared text", originClass: "agent", generatedAt: t0 }),
    doc({ id: "wide-p", projectId: "other", slug: "wide-copy", body: "shared  text", originClass: "agent", generatedAt: t1 }),
    // 004: personal docs of different owners, and copies in unrelated projects, stay.
    doc({ id: "u-alice", slug: "u-alice", body: "mine", scope: "user", ownerUser: "alice" }),
    doc({ id: "u-bob", slug: "u-bob", body: "mine", scope: "user", ownerUser: "bob" }),
    doc({ id: "lone-1", projectId: "one", slug: "x", body: "lonely copy" }),
    doc({ id: "lone-2", projectId: "two", slug: "x", body: "lonely copy" }),
    // 004: a contradicted copy keeps its findings under the tombstone.
    doc({ id: "c-agent", slug: "c-agent", body: "conflicted body", originClass: "agent", generatedAt: t1 }),
    doc({ id: "c-owner", slug: "c-owner", body: "conflicted body", originClass: "owner", generatedAt: t1 }),
    // 005: an identical copy, a near copy, and a copy with no counterpart.
    doc({ id: "self-1", projectId: "standup-self", slug: "s1", title: "S1", body: "identical standup doc body text" }),
    doc({ id: "live-1", projectId: "standup", slug: "s1", title: "S1", body: "identical standup doc body text" }),
    doc({
      id: "self-2",
      projectId: "standup-self",
      slug: "s2",
      title: "Retry policy",
      body: "retry the slack mirror three times with exponential backoff before giving up on delivery",
    }),
    doc({
      id: "live-2",
      projectId: "standup",
      slug: "s2",
      title: "Retry policy",
      body: "retry the slack mirror three times with exponential backoff before giving up on delivery entirely",
    }),
    doc({ id: "self-3", projectId: "standup-self", slug: "s3", body: "only in the copy" }),
    // 006: unchecked, re-verified, clean, and owner docs at full confidence.
    doc({ id: "v-unchecked", slug: "v1", body: "v1", originClass: "agent", confidence: 1, generatedAt: t0, lastVerifiedAt: t0 }),
    doc({ id: "v-reverified", slug: "v2", body: "v2", originClass: "agent", confidence: 1, generatedAt: t0, lastVerifiedAt: t1 }),
    doc({ id: "v-clean", slug: "v3", body: "v3", originClass: "agent", confidence: 1, generatedAt: t0, lastVerifiedAt: t0 }),
    doc({ id: "v-owner", slug: "v4", body: "v4", originClass: "owner", confidence: 1, generatedAt: t0, lastVerifiedAt: t0 }),
    // 007: a both-sides pair with no judgment (owner k1 over agent k2, which also
    // carries a fact dispute), and a pair with a recorded judgment.
    doc({ id: "k-1", slug: "k1", body: "k1", originClass: "owner" }),
    doc({ id: "k-2", slug: "k2", body: "k2", originClass: "agent" }),
    doc({ id: "k-3", slug: "k3", body: "k3" }),
  ];
  for (const r of rows) {
    store.upsertDoc(r);
    store.upsertChunk({ id: `${r.id}-c`, knowledgeId: r.id, chunkIndex: 0, text: r.body, embedding: [1, 0] });
  }
  const contradicts = (other: string) => ({ claim: `Contradicts ${other}`, finding: "opposing", evidence: "e" });
  const verdict = (id: string, v: string, disputes: unknown[]) =>
    db.run("UPDATE knowledge SET verdict = ?, disputes_json = ? WHERE id = ?", [v, JSON.stringify(disputes), id]);
  verdict("c-agent", "contradicted", [contradicts("k3")]);
  verdict("v-clean", "clean", []);
  verdict("k-1", "contradicted", [contradicts("k2")]);
  verdict("k-2", "disputed", [contradicts("k1"), { claim: "uses 3 retries", finding: "uses 5", evidence: "rg" }]);
  db.run("UPDATE knowledge SET verdict = 'contradicted' WHERE id = 'k-2'");
  verdict("k-3", "contradicted", [contradicts("c-agent")]);
  db.run(
    "INSERT INTO knowledge_judgments (id, project_id, subject_slug, candidate_project_id, candidate_slug, outcome, method, reason, attempts, judged_at) " +
      "VALUES ('j1', 'proj', 'k3', 'proj', 'c-agent', 'contradicts', 'llm', 'r', 1, '2026-08-03T00:00:00.000Z')"
  );
  await writeDocFile("proj", "dup-b", "title: Doc\norigin_class: agent\nconfidence: 1", "the  same\nbody");
  await writeDocFile("other", "wide-copy", "title: Doc\norigin_class: agent", "shared  text");
  await writeDocFile("standup-self", "s1", "title: S1", "identical standup doc body text");
  await writeDocFile(
    "proj",
    "v1",
    `# agent proposal\ntitle: Doc\norigin_class: agent\nconfidence: 1\ngenerated_at: ${t0}\nlast_verified_at: ${t0}\nhalf_life_days: 90`,
    "v1"
  );
  await writeDocFile("proj", "v2", `title: Doc\norigin_class: agent\nconfidence: 1\ngenerated_at: ${t0}\nlast_verified_at: ${t1}`, "v2");
  return db;
}

const verdictRow = (db: Database, id: string) =>
  db.query("SELECT verdict, disputes_json, confidence, last_verified_at FROM knowledge WHERE id = ?").get(id) as {
    verdict: string | null;
    disputes_json: string | null;
    confidence: number | null;
    last_verified_at: string | null;
  };

describe("write-quality migrations (004–007)", () => {
  const quality = () => MIGRATIONS.filter((m) => m.id >= "004" && m.id <= "007~");

  test("plan, then an apply that matches it in the DB and the files, then a no-op re-run", async () => {
    const seeded = await seedQuality();
    seeded.close();
    const db = new Database(dbPath);
    const options: MigrationOptions = { apply: false, knowledgeDir, hostUser: "alice", backupDir };
    const planned = await runMigrations(db, quality(), options);
    const counts = Object.fromEntries(planned.map((r) => [r.id, r.counts]));
    expect(counts["004-collapse-identical-duplicates"]).toEqual({ groups: 3, superseded: 3, filesPatched: 2 });
    expect(counts["005-retire-standup-self"]).toEqual({ superseded: 2, kept: 1, filesPatched: 1 });
    expect(counts["006-unverified-confidence"]).toEqual({ downgraded: 1, rows: 1 });
    expect(counts["007-rejudge-contradicted"]).toEqual({ queued: 2, winnersCleared: 1 });

    const stateBefore = snapshotKnowledge(db);
    const filesBefore = await dumpFiles(knowledgeDir);
    const applied = await runMigrations(db, quality(), { ...options, apply: true });
    expect(applied.map((r) => r.changes)).toEqual(planned.map((r) => r.changes));
    const plannedDb = uniqueSorted(planned.flatMap((r) => r.changes.filter((c) => c.target === "db").map(changeKey)));
    expect(uniqueSorted(diffKnowledge(stateBefore, snapshotKnowledge(db)).map(changeKey))).toEqual(plannedDb);
    const { keys } = fileChanges(filesBefore, await dumpFiles(knowledgeDir));
    const plannedFiles = planned.flatMap((r) => r.changes.filter((c) => c.target === "file"));
    expect(uniqueSorted(keys)).toEqual(uniqueSorted(plannedFiles.map(plannedFileKey)));

    // 004: the agent copy is retired in favor of the owner doc; the global doc wins
    // over its other-project copy; the contradicted copy keeps its finding.
    const b = verdictRow(db, "dup-b");
    expect(b.verdict).toBe("superseded");
    expect(b.confidence).toBe(0.1);
    expect(JSON.parse(b.disputes_json!).map((d: { claim: string }) => d.claim)).toEqual(["Superseded by dup-a"]);
    expect(JSON.parse(verdictRow(db, "wide-p").disputes_json!)[0].claim).toBe("Superseded by global/wide");
    expect(verdictRow(db, "wide-g").verdict).toBeNull();
    expect(JSON.parse(verdictRow(db, "c-agent").disputes_json!).map((d: { claim: string }) => d.claim)).toEqual([
      "Contradicts k3",
      "Superseded by c-owner",
    ]);
    for (const id of ["dup-a", "u-alice", "u-bob", "lone-1", "lone-2", "c-owner"]) {
      expect(verdictRow(db, id).verdict).toBeNull();
    }
    expect((await readRawDocFile(knowledgeDir, "proj", "dup-b"))?.data.confidence).toBe(0.1);
    // 005
    expect(JSON.parse(verdictRow(db, "self-1").disputes_json!)[0].claim).toBe("Superseded by standup/s1");
    expect(verdictRow(db, "self-2").verdict).toBe("superseded");
    expect(verdictRow(db, "self-3").verdict).toBeNull();
    // 006: only the unchecked agent doc, and its file loses the stamp.
    expect(verdictRow(db, "v-unchecked")).toMatchObject({ confidence: 0.6, last_verified_at: null });
    for (const id of ["v-reverified", "v-clean", "v-owner"]) expect(verdictRow(db, id).confidence).toBe(1);
    const v1 = await readRawDocFile(knowledgeDir, "proj", "v1");
    expect(v1?.data.confidence).toBe(0.6);
    expect(v1?.data.last_verified_at).toBeUndefined();
    const loaded = (await new KnowledgeLoader(knowledgeDir).loadProject("proj")).find((d) => d.slug === "v1");
    expect(loaded).toMatchObject({ confidence: 0.6, halfLifeDays: 90 });
    expect(loaded?.lastVerifiedAt).toBeUndefined();
    // 007: the owner side of the both-sides pair is un-hidden; the agent side keeps
    // its real verdict and findings; the judged pair is untouched; both unjudged
    // docs are queued for re-judging.
    expect(verdictRow(db, "k-1")).toMatchObject({ verdict: null, disputes_json: null });
    expect(verdictRow(db, "k-2").verdict).toBe("contradicted");
    expect(JSON.parse(verdictRow(db, "k-2").disputes_json!).map((d: { claim: string }) => d.claim)).toEqual([
      "Contradicts k1",
      "uses 3 retries",
    ]);
    expect(verdictRow(db, "k-3").verdict).toBe("contradicted");
    expect(db.query("SELECT id FROM knowledge_judgments WHERE outcome = 'queued' ORDER BY id").all()).toEqual([
      { id: "queued:proj/k1" },
      { id: "queued:proj/k2" },
    ]);

    const again = await runMigrations(db, quality(), { ...options, apply: true, backupDir: join(root, "backup2") });
    for (const report of again) expect(report.changes).toEqual([]);
    db.close();
  });

  test("a DB-only apply leaves the file work for a later run with the knowledge dir", async () => {
    const db = await seedQuality();
    const dbOnly = await runMigrations(db, quality(), { apply: true, hostUser: "alice", backupDir });
    // 006 changes nothing without the files it is about.
    const r006 = dbOnly.find((r) => r.id === "006-unverified-confidence")!;
    expect(r006.changes).toEqual([]);
    expect(r006.notes.join(" ")).toContain("--knowledge-dir");
    const later = await runMigrations(db, quality(), { apply: false, knowledgeDir, hostUser: "alice" });
    const fileRefs = later.flatMap((r) => r.changes.filter((c) => c.target === "file").map((c) => `${c.ref} ${c.field}`));
    expect(fileRefs.sort()).toEqual([
      "other/wide-copy confidence",
      "proj/dup-b confidence",
      "proj/v1 confidence",
      "proj/v1 last_verified_at",
      "standup-self/s1 confidence",
    ]);
    expect(
      uniqueSorted(later.flatMap((r) => r.changes.filter((c) => c.target === "db").map((c) => `${c.ref} ${c.field}`)))
    ).toEqual(["proj/v1 confidence", "proj/v1 last_verified_at"]);
    db.close();
  });

  test("005 is opt-in: a default run leaves standup-self alone", async () => {
    const db = await seedQuality();
    await runMigrations(db, DEFAULT_MIGRATIONS, { apply: true, hostUser: "alice", backupDir });
    expect(verdictRow(db, "self-1").verdict).toBeNull();
    expect(verdictRow(db, "dup-b").verdict).toBe("superseded");
    db.close();
  });

  test("apply → rollback restores every table row-for-row, the judgment ledger included, and every file byte-for-byte", async () => {
    const seeded = await seedQuality();
    seeded.close();
    const dbBefore = dumpDb(dbPath);
    const filesBefore = await dumpFiles(knowledgeDir);
    const db = new Database(dbPath);
    await runMigrations(db, quality(), { apply: true, knowledgeDir, hostUser: "alice", backupDir });
    db.close();
    expect(dumpDb(dbPath).knowledge_judgments).not.toEqual(dbBefore.knowledge_judgments);
    await rollbackMigrations(backupDir);
    expect(dumpDb(dbPath)).toEqual(dbBefore);
    expect(await dumpFiles(knowledgeDir)).toEqual(filesBefore);
  });
});

describe("001 redaction tiers", () => {
  /** An account id and a heuristic credential shape: full-tier spans only. */
  const WIDE_BODY = "deploy to account 123456789012 with password: hunter2heur";

  test("a doc is redacted under the stricter of its file's and its row's placements, on both", async () => {
    const db = new Database(dbPath);
    const store = new KnowledgeStore(db);
    store.upsertDoc(doc({ id: "row-wide", slug: "row-wide", scope: "global", body: WIDE_BODY }));
    store.upsertDoc(doc({ id: "file-wide", slug: "file-wide", scope: "project", body: WIDE_BODY }));
    store.upsertDoc(doc({ id: "team", slug: "team", scope: "project", body: WIDE_BODY }));
    await writeDocFile("proj", "row-wide", "title: Doc\nsource_kind: code", WIDE_BODY);
    await writeDocFile("proj", "file-wide", "title: Doc\nsource_kind: code\nscope: global", WIDE_BODY);
    await writeDocFile("proj", "team", "title: Doc\nsource_kind: code", WIDE_BODY);

    await runMigrations(db, [MIGRATIONS[0]], { apply: true, knowledgeDir, hostUser: "alice", backupDir });
    for (const id of ["row-wide", "file-wide"]) {
      const file = (await readRawDocFile(knowledgeDir, "proj", id))?.content ?? "";
      for (const text of [row(db, id)?.body ?? "", file]) {
        expect(text).not.toContain("123456789012");
        expect(text).not.toContain("hunter2heur");
      }
    }
    // A project doc in both places keeps its heuristic shapes: only signature-tier secrets and account ids go.
    const teamBody = WIDE_BODY.replace("123456789012", "[REDACTED]");
    expect(row(db, "team")?.body).toBe(teamBody);
    expect((await readRawDocFile(knowledgeDir, "proj", "team"))?.content.trim()).toBe(teamBody);
    db.close();
  });
});

describe("dry-run planning across steps", () => {
  /** A step that stamps `stamped: yes` into every file without it. */
  const stamp: KbMigration = {
    id: "t-stamp",
    description: "stamp files",
    async plan(_db, options) {
      const changes: Change[] = [];
      const files: string[] = [];
      const writes: Array<() => Promise<void>> = [];
      for (const ref of await listDocFiles(options.knowledgeDir!)) {
        const file = await readDocText(options.knowledgeDir!, ref);
        if (!file || file.data.stamped === "yes") continue;
        changes.push({ ref: `${ref.projectId}/${ref.slug}`, target: "file", field: "stamped", action: "set", before: null, after: "yes" });
        files.push(ref.rel);
        const raw = spliceFrontmatter(file.raw, { stamped: "yes" });
        writes.push(() => writeDocText(options.knowledgeDir!, ref, raw));
      }
      return {
        counts: { stamped: writes.length },
        changes,
        files,
        notes: [],
        async applyFiles() {
          for (const write of writes) await write();
        },
        applyDb() {},
      };
    },
  };
  /** A step that plans a change only for a file the previous step stamped. */
  const followUp: KbMigration = {
    id: "t-follow",
    description: "act on stamped files",
    async plan(_db, options) {
      const changes: Change[] = [];
      for (const ref of await listDocFiles(options.knowledgeDir!)) {
        const file = await readDocText(options.knowledgeDir!, ref);
        if (file?.data.stamped === "yes") {
          changes.push({ ref: `${ref.projectId}/${ref.slug}`, target: "file", field: "followed", action: "set", before: null, after: "yes" });
        }
      }
      return { counts: { followed: changes.length }, changes, files: [], notes: [], async applyFiles() {}, applyDb() {} };
    },
  };

  test("a later step plans against the files an earlier step writes, and the real files stay untouched", async () => {
    await writeDocFile("proj", "a", "title: A", "body");
    const before = await dumpFiles(knowledgeDir);
    const db = new Database(dbPath);
    const dry = await runMigrations(db, [stamp, followUp], { apply: false, knowledgeDir, hostUser: "alice" });
    expect(dry.find((r) => r.id === "t-follow")?.counts).toEqual({ followed: 1 });
    expect(await dumpFiles(knowledgeDir)).toEqual(before);

    const applied = await runMigrations(db, [stamp, followUp], { apply: true, knowledgeDir, hostUser: "alice", backupDir });
    expect(applied.find((r) => r.id === "t-follow")?.counts).toEqual({ followed: 1 });
    expect((await readRawDocFile(knowledgeDir, "proj", "a"))?.data.stamped).toBe("yes");
    db.close();
  });
});

describe("010-classify-knowledge-changes", () => {
  /** A DB with docs and a knowledge_changes table in its pre-053 shape (no personal/owner_user). */
  async function seedChanges(): Promise<Database> {
    const db = new Database(dbPath);
    const store = new KnowledgeStore(db);
    store.upsertDoc(doc({ id: "mine", projectId: "proj", slug: "my-note", scope: "user", ownerUser: "alice" }));
    store.upsertDoc(doc({ id: "home", projectId: "global", slug: "native-mem-home-claude-md", sourceKind: "native-memory", scope: "user" }));
    store.upsertDoc(doc({ id: "team", projectId: "proj", slug: "team-runbook", scope: "project" }));
    db.run(
      `CREATE TABLE knowledge_changes (
         id TEXT PRIMARY KEY, project_id TEXT NOT NULL, slug TEXT NOT NULL,
         kind TEXT NOT NULL CHECK (kind IN ('accepted', 'removed', 'reconciled', 'contradiction', 'distilled')),
         title TEXT NOT NULL, session_id TEXT, contradicted TEXT, created_at TEXT DEFAULT (datetime('now')))`
    );
    const change = (id: string, projectId: string, slug: string, title: string) =>
      db.run("INSERT INTO knowledge_changes (id, project_id, slug, kind, title, created_at) VALUES (?, ?, ?, 'accepted', ?, ?)", [
        id,
        projectId,
        slug,
        title,
        `2026-09-0${id.length % 9}T00:00:00Z`,
      ]);
    change("c-mine", "proj", "my-note", "Alice private note");
    change("c-home", "global", "native-mem-home-claude-md", "private CLAUDE.md");
    change("c-team", "proj", "team-runbook", "Team runbook");
    change("c-gone", "proj", "deleted-doc", "A doc already deleted");
    db.run("CREATE TABLE sessions_like (id TEXT PRIMARY KEY, note TEXT)");
    return db;
  }
  const only = MIGRATIONS.filter((m) => m.id === "010-classify-knowledge-changes");

  test("is a default migration", () => {
    expect(DEFAULT_MIGRATIONS.map((m) => m.id)).toContain("010-classify-knowledge-changes");
  });

  test("the schema step adds the columns, the dry run lists exactly the personal rows, and an apply matches it", async () => {
    const seeded = await seedChanges();
    seeded.close();
    const db = new Database(dbPath);
    const [schema, dry] = await runMigrations(db, only, { apply: false, hostUser: "carol", backupDir });
    expect(schema.changes.map(changeKey)).toContain(
      "db schema:knowledge_changes columns set id,project_id,slug,kind,title,session_id,contradicted,created_at -> " +
        "id,project_id,slug,kind,title,session_id,contradicted,created_at,personal,owner_user"
    );
    expect(dry.changes.map(changeKey).sort()).toEqual([
      "db global/native-mem-home-claude-md#change:c-home change.owner_user set null -> carol",
      "db global/native-mem-home-claude-md#change:c-home change.personal set null -> 1",
      "db proj/my-note#change:c-mine change.owner_user set null -> alice",
      "db proj/my-note#change:c-mine change.personal set null -> 1",
    ]);
    expect(dry.counts).toEqual({ classified: 2, unowned: 0 });
    // A dry run writes nothing.
    expect(snapshotKnowledge(db).tables.get("knowledge_changes")?.columns).not.toContain("personal");

    // A diff reports a column only one side has as the schema change alone, so
    // the row changes are compared from the shape the collector's boot (053)
    // gives the table — the shape a live DB has when this runs.
    ensureKnowledgeChangeColumns(db);
    const stateBefore = snapshotKnowledge(db);
    const [, replanned] = await runMigrations(db, only, { apply: false, hostUser: "carol", backupDir });
    expect(replanned.changes).toEqual(dry.changes);
    const applied = await runMigrations(db, only, { apply: true, hostUser: "carol", backupDir });
    expect(applied.map((r) => r.changes)).toEqual([[], dry.changes]);
    expect(uniqueSorted(diffKnowledge(stateBefore, snapshotKnowledge(db)).map(changeKey))).toEqual(
      uniqueSorted(dry.changes.map(changeKey))
    );

    // The classification outlives the doc: bob never sees alice's change once her doc is gone.
    new KnowledgeStore(db).deleteDoc("proj", "my-note");
    const idsFor = (viewer: string | null) =>
      getRecentKnowledgeChanges(db, 50, viewer)
        .map((c) => c.id)
        .sort();
    expect(idsFor("bob")).toEqual(["c-gone", "c-team"]);
    expect(idsFor("alice")).toEqual(["c-gone", "c-mine", "c-team"]);

    const [, again] = await runMigrations(db, only, { apply: false, hostUser: "carol", backupDir: join(root, "b2") });
    expect(again.changes).toEqual([]);
    db.close();
  });

  test("apply → rollback restores knowledge_changes row-for-row, its shape included", async () => {
    const seeded = await seedChanges();
    seeded.close();
    const before = dumpDb(dbPath);
    const db = new Database(dbPath);
    await runMigrations(db, only, { apply: true, hostUser: "carol", backupDir });
    db.run("INSERT INTO sessions_like VALUES ('s2', 'written after the apply')");
    db.close();
    expect(dumpDb(dbPath).knowledge_changes).not.toEqual(before.knowledge_changes);

    await rollbackMigrations(backupDir);
    const after = dumpDb(dbPath);
    expect(after.sessions_like).toHaveLength(1);
    expect({ ...after, sessions_like: [] }).toEqual({ ...before, sessions_like: [] });
  });
});
