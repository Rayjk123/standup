import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { allMigrations, ensurePersonaMessagesFts, runMigrations } from "./migrations.js";
import {
  appendPersonaMessage,
  getOrCreatePersonaConsoleThread,
  getOrCreatePersonaThreadByRef,
  searchPersonaMessages,
} from "./queries/persona.js";

const OWNER = "me";

/** A database at the schema before migration 091, holding `n` messages in the owner's console thread. */
function beforeFts(n: number): { db: Database; threadId: string } {
  const db = new Database(":memory:");
  runMigrations(db, allMigrations().filter((m) => m.version !== 91));
  // The boot repairs mirror 091; an older build had neither.
  db.exec("DROP TRIGGER persona_messages_fts_insert; DROP TABLE persona_messages_fts;");
  expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 'persona_messages_fts'").get()).toBeNull();
  const threadId = getOrCreatePersonaConsoleThread(db, OWNER).id;
  const insert = db.query(
    "INSERT INTO persona_messages (id, thread_id, seq, role, text, created_at) VALUES (?, ?, ?, 'user', ?, '2026-10-01T00:00:00.000Z')"
  );
  db.transaction(() => {
    for (let i = 1; i <= n; i++) insert.run(`m${i}`, threadId, i, i === n ? "the last zebra" : `message number ${i}`);
  })();
  return { db, threadId };
}

const ftsRows = (db: Database) => (db.query("SELECT COUNT(*) AS n FROM persona_messages_fts").get() as { n: number }).n;

describe("migration 091: persona_messages_fts", () => {
  test("backfills every existing message across chunks, and running again indexes nothing twice", () => {
    const { db } = beforeFts(4_500);
    runMigrations(db);
    expect(ftsRows(db)).toBe(4_500);
    expect(searchPersonaMessages(db, '"zebra"', { owner: OWNER }).map((h) => h.id)).toEqual(["m4500"]);
    expect(searchPersonaMessages(db, '"number"', { owner: OWNER }, 100)).toHaveLength(100);

    ensurePersonaMessagesFts(db);
    runMigrations(db);
    expect(ftsRows(db)).toBe(4_500);
  });

  test("an empty table migrates, and messages appended after it are indexed by the trigger", () => {
    const { db, threadId } = beforeFts(0);
    runMigrations(db);
    expect(ftsRows(db)).toBe(0);
    const { message } = appendPersonaMessage(db, { threadId, role: "user", text: "Deploy the stacks on Fridays only" });
    expect(searchPersonaMessages(db, '"friday"', { owner: OWNER })).toMatchObject([
      { id: message.id, threadId, channel: "console", role: "user", text: "Deploy the stacks on Fridays only" },
    ]);
  });

  test("a trigger dropped by a table rebuild comes back on boot, with the messages it missed indexed once", () => {
    const { db, threadId } = beforeFts(3);
    runMigrations(db);
    db.exec("DROP TRIGGER persona_messages_fts_insert");
    appendPersonaMessage(db, { threadId, role: "user", text: "missed narwhal" });
    expect(searchPersonaMessages(db, '"narwhal"', { owner: OWNER })).toHaveLength(0);
    runMigrations(db);
    expect(searchPersonaMessages(db, '"narwhal"', { owner: OWNER })).toHaveLength(1);
    expect(ftsRows(db)).toBe(4);
    appendPersonaMessage(db, { threadId, role: "user", text: "later narwhal" });
    expect(searchPersonaMessages(db, '"narwhal"', { owner: OWNER })).toHaveLength(2);
  });

  test("a lost index table is rebuilt on boot rather than left failing every message insert", () => {
    const { db, threadId } = beforeFts(3);
    runMigrations(db);
    db.exec("DROP TABLE persona_messages_fts");
    runMigrations(db);
    expect(ftsRows(db)).toBe(3);
    appendPersonaMessage(db, { threadId, role: "user", text: "back again" });
    expect(searchPersonaMessages(db, '"again"', { owner: OWNER })[0]?.matched).toEqual(["again"]);
  });

  test("a thread scope searches only that thread; an owner scope only the owner's private threads", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const console = getOrCreatePersonaConsoleThread(db, OWNER).id;
    const dm = getOrCreatePersonaThreadByRef(db, OWNER, "slack", "dm:D1", "dm", "private").id;
    const shared = getOrCreatePersonaThreadByRef(db, OWNER, "slack", "C1:1.0", "team", "shared").id;
    const other = getOrCreatePersonaConsoleThread(db, "someone-else").id;
    for (const threadId of [console, dm, shared, other]) appendPersonaMessage(db, { threadId, role: "user", text: `walrus in ${threadId}` });
    const threads = (scope: { threadId: string } | { owner: string }) =>
      searchPersonaMessages(db, '"walrus"', scope).map((h) => h.threadId).sort();
    expect(threads({ owner: OWNER })).toEqual([console, dm].sort());
    expect(threads({ threadId: shared })).toEqual([shared]);
  });
});
