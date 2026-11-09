import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createStore } from "../store.js";
import { ensurePublicKnowledgeShape } from "../migrations.js";
import {
  PUBLIC_KB_CALLS_KEPT,
  PUBLIC_KB_QUERY_MAX,
  getProject,
  getProjects,
  listPublicKbCalls,
  recordPublicKbCall,
  sanitizeLogField,
  setProjectShareable,
  upsertProject,
} from "../index.js";

describe("projects.shareable", () => {
  test("a new project is shareable; an explicit false on insert withholds it", () => {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "open", name: "Open", branch: "main", repos: [] });
    upsertProject(store.db, { id: "closed", name: "Closed", branch: "main", repos: [], shareable: false });
    expect(getProject(store.db, "open")?.shareable).toBe(true);
    expect(getProject(store.db, "closed")?.shareable).toBe(false);
    store.close();
  });

  test("a later upsert never changes it; only setProjectShareable does", () => {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "p", name: "P", branch: "main", repos: [] });
    setProjectShareable(store.db, "p", false);
    // A registry re-seed or a project edit re-upserts the whole row.
    upsertProject(store.db, { id: "p", name: "P renamed", branch: "main", repos: [], shareable: true });
    const p = getProject(store.db, "p");
    expect(p?.name).toBe("P renamed");
    expect(p?.shareable).toBe(false);
    setProjectShareable(store.db, "p", true);
    expect(getProject(store.db, "p")?.shareable).toBe(true);
    store.close();
  });

  test("the shape repair adds the column to an old projects table and is idempotent", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
    db.exec("INSERT INTO projects (id, name) VALUES ('legacy', 'Legacy')");
    ensurePublicKnowledgeShape(db);
    ensurePublicKnowledgeShape(db);
    const row = db.query("SELECT shareable FROM projects WHERE id = 'legacy'").get() as { shareable: number };
    expect(row.shareable).toBe(1);
    const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'public_kb_calls'").all();
    expect(tables.length).toBe(1);
    db.close();
  });

  test("getProjects reports shareable on every row", () => {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "a", name: "A", branch: "main", repos: [] });
    expect(getProjects(store.db).every((p) => typeof p.shareable === "boolean")).toBe(true);
    store.close();
  });
});

describe("public_kb_calls", () => {
  test("records calls newest first and truncates the query text", () => {
    const store = createStore(":memory:");
    recordPublicKbCall(store.db, { alias: "bob", endpoint: "/search", query: "first", status: 200 });
    recordPublicKbCall(store.db, { alias: null, endpoint: "/ask", query: "q".repeat(500), status: 401 });
    const calls = listPublicKbCalls(store.db, 10);
    expect(calls.length).toBe(2);
    expect(calls[0]).toMatchObject({ alias: null, endpoint: "/ask", status: 401 });
    expect(calls[0]!.query!.length).toBe(PUBLIC_KB_QUERY_MAX);
    expect(calls[1]).toMatchObject({ alias: "bob", endpoint: "/search", query: "first", status: 200 });
    expect(typeof calls[0]!.at).toBe("string");
    store.close();
  });

  test("replaces control and bidi characters before truncating, and drops a lone trailing surrogate", () => {
    const fffd = String.fromCodePoint(0xfffd);
    const unsafe = [0x00, 0x0a, 0x0d, 0x1b, 0x7f, 0x85, 0x9b, 0x202a, 0x202e, 0x2066, 0x2069].map((c) => String.fromCharCode(c));
    expect(sanitizeLogField(`a${unsafe.join("")}b`)).toBe(`a${fffd.repeat(unsafe.length)}b`);
    expect(sanitizeLogField("plain é 字")).toBe("plain é 字");
    // An emoji straddling the cut leaves its high surrogate at the end; it is dropped.
    const straddling = `${"x".repeat(PUBLIC_KB_QUERY_MAX - 1)}${String.fromCodePoint(0x1f600)}`;
    const cut = sanitizeLogField(straddling);
    expect(cut).toBe("x".repeat(PUBLIC_KB_QUERY_MAX - 1));
    // Replacement happens before the cut, so the stored text never exceeds the limit.
    expect(sanitizeLogField("\n".repeat(500)).length).toBe(PUBLIC_KB_QUERY_MAX);

    const store = createStore(":memory:");
    recordPublicKbCall(store.db, { alias: "bob", endpoint: "GET /x\r\nforged", query: `q${String.fromCharCode(0x202e)}txt.exe`, status: 404 });
    const [row] = listPublicKbCalls(store.db, 1);
    expect(row!.endpoint).toBe(`GET /x${fffd}${fffd}forged`);
    expect(row!.query).toBe(`q${fffd}txt.exe`);
    store.close();
  });

  test("replaces zero-width characters, bidi marks and line/paragraph separators", () => {
    const fffd = String.fromCodePoint(0xfffd);
    const invisible = [0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029, 0x061c, 0xfeff, 0x2060].map((c) => String.fromCharCode(c));
    expect(sanitizeLogField(`a${invisible.join("")}b`)).toBe(`a${fffd.repeat(invisible.length)}b`);
    // Neighbouring characters outside the ranges are kept.
    const kept = [0x200a, 0x2010, 0x2027, 0x202f, 0x2061, 0xfefe, 0x061b].map((c) => String.fromCharCode(c)).join("");
    expect(sanitizeLogField(kept)).toBe(kept);
  });

  test("keeps only the newest PUBLIC_KB_CALLS_KEPT rows", () => {
    const store = createStore(":memory:");
    const insert = store.db.prepare("INSERT INTO public_kb_calls (at, alias, endpoint, query, status) VALUES ('t', 'a', '/x', NULL, 200)");
    store.db.transaction(() => {
      for (let i = 0; i < PUBLIC_KB_CALLS_KEPT + 20; i++) insert.run();
    })();
    recordPublicKbCall(store.db, { alias: "last", endpoint: "/whoami", status: 200 });
    const count = store.db.query("SELECT COUNT(*) AS n FROM public_kb_calls").get() as { n: number };
    expect(count.n).toBe(PUBLIC_KB_CALLS_KEPT);
    expect(listPublicKbCalls(store.db, 1)[0]!.alias).toBe("last");
    store.close();
  });
});
