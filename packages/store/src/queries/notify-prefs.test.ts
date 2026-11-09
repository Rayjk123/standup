import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createStore } from "../store.js";
import { ensureNotifyShape } from "../migrations.js";
import {
  appendPersonaMessage,
  claimPersonaBriefSlot,
  deleteNotifyPrefs,
  getNotifyPrefs,
  getOrCreatePersonaConsoleThread,
  getPersonaMessage,
  lastSentPersonaBrief,
  listNotifyPrefProjects,
  listPersonaBriefRuns,
  listPersonaMessages,
  setNotifyPrefs,
  settlePersonaBriefSlot,
} from "../index.js";

describe("notify_prefs layers", () => {
  test("the global layer and each project layer are stored apart, per user", () => {
    const { db } = createStore(":memory:");
    expect(getNotifyPrefs(db, "alice")).toBeNull();
    expect(getNotifyPrefs(db, "alice", "p")).toBeNull();

    setNotifyPrefs(db, "alice", null, { brief: { time: "07:00" }, timezone: "Europe/Berlin" });
    setNotifyPrefs(db, "alice", "p", { routes: { done: { channels: ["push"] } } });
    setNotifyPrefs(db, "bob", null, { brief: { enabled: false } });

    expect(getNotifyPrefs(db, "alice")).toEqual({ brief: { time: "07:00" }, timezone: "Europe/Berlin" });
    expect(getNotifyPrefs(db, "alice", null)).toEqual({ brief: { time: "07:00" }, timezone: "Europe/Berlin" });
    expect(getNotifyPrefs(db, "alice", "p")).toEqual({ routes: { done: { channels: ["push"] } } });
    expect(getNotifyPrefs(db, "alice", "q")).toBeNull();
    expect(getNotifyPrefs(db, "bob")).toEqual({ brief: { enabled: false } });
    expect(getNotifyPrefs(db, "bob", "p")).toBeNull();
    expect(listNotifyPrefProjects(db, "alice")).toEqual(["p"]);
    expect(listNotifyPrefProjects(db, "bob")).toEqual([]);
  });

  test("set replaces a layer whole; delete removes only that layer", () => {
    const { db } = createStore(":memory:");
    setNotifyPrefs(db, "alice", null, { brief: { time: "07:00" }, timezone: "UTC" });
    setNotifyPrefs(db, "alice", null, { brief: { enabled: true } });
    expect(getNotifyPrefs(db, "alice")).toEqual({ brief: { enabled: true } });

    setNotifyPrefs(db, "alice", "p", { routes: { progress: { when: "never" } } });
    expect(deleteNotifyPrefs(db, "alice", "p")).toBe(true);
    expect(deleteNotifyPrefs(db, "alice", "p")).toBe(false);
    expect(getNotifyPrefs(db, "alice", "p")).toBeNull();
    expect(getNotifyPrefs(db, "alice")).toEqual({ brief: { enabled: true } });
    expect(deleteNotifyPrefs(db, "bob", null)).toBe(false);
    expect(deleteNotifyPrefs(db, "alice", null)).toBe(true);
    expect(getNotifyPrefs(db, "alice")).toBeNull();
  });

  test("a malformed stored blob reads as an empty layer", () => {
    const { db } = createStore(":memory:");
    db.run("INSERT INTO notify_prefs (owner, project_id, override_json, updated_at) VALUES ('alice', '', '{nope', 'x')");
    db.run("INSERT INTO notify_prefs (owner, project_id, override_json, updated_at) VALUES ('alice', 'p', '[1,2]', 'x')");
    expect(getNotifyPrefs(db, "alice")).toEqual({});
    expect(getNotifyPrefs(db, "alice", "p")).toEqual({});
  });
});

describe("persona_brief_runs", () => {
  const slot = (day: number) => `2026-10-0${day}T12:30:00.000Z`;

  test("claiming a slot is idempotent: the first claim wins, later ones are refused and change nothing", () => {
    const { db } = createStore(":memory:");
    expect(claimPersonaBriefSlot(db, "alice", slot(5), "skipped", "2026-10-05T12:31:00.000Z", "assembling")).toBe(true);
    expect(claimPersonaBriefSlot(db, "alice", slot(5), "skipped", "2026-10-05T12:32:00.000Z", "again")).toBe(false);
    expect(claimPersonaBriefSlot(db, "alice", slot(5), "sent", "2026-10-05T12:33:00.000Z")).toBe(false);
    expect(listPersonaBriefRuns(db, "alice")).toEqual([
      { owner: "alice", slot: slot(5), status: "skipped", detail: "assembling", createdAt: "2026-10-05T12:31:00.000Z" },
    ]);
    // The same slot is a separate claim for another user.
    expect(claimPersonaBriefSlot(db, "bob", slot(5), "skipped", "2026-10-05T12:31:00.000Z")).toBe(true);
  });

  test("settle records the outcome; lastSent is the newest sent slot of that user", () => {
    const { db } = createStore(":memory:");
    expect(lastSentPersonaBrief(db, "alice")).toBeNull();
    for (const day of [4, 5, 6]) claimPersonaBriefSlot(db, "alice", slot(day), "skipped", slot(day), "assembling");
    settlePersonaBriefSlot(db, "alice", slot(4), { status: "sent", inboxId: "inbox-4" });
    settlePersonaBriefSlot(db, "alice", slot(5), { status: "sent", inboxId: "inbox-5" });
    settlePersonaBriefSlot(db, "alice", slot(6), { status: "silent", detail: "nothing changed" });
    claimPersonaBriefSlot(db, "bob", slot(7), "sent", slot(7));

    expect(lastSentPersonaBrief(db, "alice")).toMatchObject({ slot: slot(5), status: "sent", inboxId: "inbox-5" });
    expect(lastSentPersonaBrief(db, "alice")!.detail).toBeUndefined();
    expect(listPersonaBriefRuns(db, "alice").map((r) => [r.slot, r.status])).toEqual([
      [slot(6), "silent"],
      [slot(5), "sent"],
      [slot(4), "sent"],
    ]);
    expect(listPersonaBriefRuns(db, "alice", 1)).toHaveLength(1);
    expect(listPersonaBriefRuns(db, "alice")[0]).toMatchObject({ detail: "nothing changed" });
    expect(listPersonaBriefRuns(db, "alice")[0]!.inboxId).toBeUndefined();
  });

  test("the status is constrained to sent, silent and skipped", () => {
    const { db } = createStore(":memory:");
    // INSERT OR IGNORE also ignores a CHECK violation: the row is not written.
    expect(claimPersonaBriefSlot(db, "alice", slot(5), "late" as "sent", slot(5))).toBe(false);
    expect(listPersonaBriefRuns(db, "alice")).toEqual([]);
    expect(() =>
      db.run("INSERT INTO persona_brief_runs (owner, slot, status, created_at) VALUES ('alice', 'x', 'late', 'x')")
    ).toThrow();
  });
});

describe("persona_messages.notify_json", () => {
  test("a message's routing round-trips; a message without one has none", () => {
    const { db } = createStore(":memory:");
    const thread = getOrCreatePersonaConsoleThread(db, "alice");
    const routed = appendPersonaMessage(db, {
      threadId: thread.id,
      role: "persona",
      text: "Your brief",
      notify: { kind: "brief", channels: ["slack"] },
    }).message;
    expect(routed.notify).toEqual({ kind: "brief", channels: ["slack"] });
    const quiet = appendPersonaMessage(db, {
      threadId: thread.id,
      role: "persona",
      text: "done, stays in the console",
      notify: { kind: "done", channels: [] },
    }).message;
    const plain = appendPersonaMessage(db, { threadId: thread.id, role: "persona", text: "a reply" }).message;

    expect(getPersonaMessage(db, routed.id)!.notify).toEqual({ kind: "brief", channels: ["slack"] });
    expect(getPersonaMessage(db, quiet.id)!.notify).toEqual({ kind: "done", channels: [] });
    expect(plain.notify).toBeUndefined();
    expect("notify" in getPersonaMessage(db, plain.id)!).toBe(false);
    expect(listPersonaMessages(db, thread.id).map((m) => m.notify)).toEqual([
      { kind: "brief", channels: ["slack"] },
      { kind: "done", channels: [] },
      undefined,
    ]);
  });

  test("a malformed stored routing reads as none", () => {
    const { db } = createStore(":memory:");
    const thread = getOrCreatePersonaConsoleThread(db, "alice");
    const a = appendPersonaMessage(db, { threadId: thread.id, role: "persona", text: "a" }).message;
    const b = appendPersonaMessage(db, { threadId: thread.id, role: "persona", text: "b" }).message;
    db.run("UPDATE persona_messages SET notify_json = '{bad' WHERE id = ?", [a.id]);
    db.run(`UPDATE persona_messages SET notify_json = '{"kind":"done"}' WHERE id = ?`, [b.id]);
    expect(getPersonaMessage(db, a.id)!.notify).toBeUndefined();
    expect(getPersonaMessage(db, b.id)!.notify).toBeUndefined();
  });
});

describe("ensureNotifyShape", () => {
  test("is idempotent and adds notify_json to an existing persona_messages", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE persona_messages (id TEXT PRIMARY KEY, text TEXT)");
    ensureNotifyShape(db);
    ensureNotifyShape(db);
    const columns = (db.query("PRAGMA table_info(persona_messages)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toContain("notify_json");
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(["notify_prefs", "persona_brief_runs"]));
  });
});
