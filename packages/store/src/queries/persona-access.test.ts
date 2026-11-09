import { describe, expect, test } from "bun:test";
import { createStore } from "../store.js";
import { getPersonaUserAccess, listPersonaUserAccess, putPersonaUserAccess } from "../index.js";

describe("persona user access", () => {
  test("no row reads as null", () => {
    const { db } = createStore();
    expect(getPersonaUserAccess(db, "bob")).toBeNull();
    expect(listPersonaUserAccess(db)).toEqual([]);
  });

  test("put creates an enabled row with trimmed, deduplicated projects", () => {
    const { db } = createStore();
    const access = putPersonaUserAccess(db, {
      alias: "bob",
      launchProjects: [" standup ", "docs", "standup", "", "  "],
      updatedBy: "alice",
    });
    expect(access).toMatchObject({
      alias: "bob",
      enabled: true,
      launchProjects: ["standup", "docs"],
      updatedBy: "alice",
    });
    expect(access.updatedAt).toBeTruthy();
    expect(getPersonaUserAccess(db, "bob")).toEqual(access);
  });

  test("put replaces the project list and keeps enabled when omitted", () => {
    const { db } = createStore();
    putPersonaUserAccess(db, { alias: "bob", launchProjects: ["a"], enabled: false });
    const updated = putPersonaUserAccess(db, { alias: "bob", launchProjects: ["b"] });
    expect(updated.enabled).toBe(false);
    expect(updated.launchProjects).toEqual(["b"]);
    expect(updated).not.toHaveProperty("updatedBy");
    const enabled = putPersonaUserAccess(db, { alias: "bob", launchProjects: [], enabled: true, updatedBy: "alice" });
    expect(enabled).toMatchObject({ enabled: true, launchProjects: [], updatedBy: "alice" });
  });

  test("a corrupt project list reads as none", () => {
    const { db } = createStore();
    putPersonaUserAccess(db, { alias: "bob", launchProjects: ["a"] });
    db.run("UPDATE persona_user_access SET launch_projects_json = 'not json' WHERE alias = 'bob'");
    expect(getPersonaUserAccess(db, "bob")?.launchProjects).toEqual([]);
  });

  test("list returns every row by alias", () => {
    const { db } = createStore();
    putPersonaUserAccess(db, { alias: "zed", launchProjects: ["a"] });
    putPersonaUserAccess(db, { alias: "amy", launchProjects: [] });
    expect(listPersonaUserAccess(db).map((a) => a.alias)).toEqual(["amy", "zed"]);
  });
});
