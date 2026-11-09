import { expect, test, describe } from "bun:test";
import { createStore } from "../store.js";
import { getUserPrefs, putUserPrefs } from "../index.js";

describe("user_prefs CRUD", () => {
  test("getUserPrefs returns null for a user who never saved a profile", () => {
    const store = createStore(":memory:");
    expect(getUserPrefs(store.db, "alice")).toBeNull();
    store.close();
  });

  test("putUserPrefs stores and getUserPrefs reads back all fields", () => {
    const store = createStore(":memory:");
    const saved = putUserPrefs(store.db, "alice", {
      personalInstructions: "Always write tests first.",
      reviewRigor: "Adversarial review, fix all High + Medium.",
      deployTarget: { account: "111122223333", role: "Admin", command: "npx cdk deploy" },
    });
    expect(saved.alias).toBe("alice");
    expect(saved.personalInstructions).toBe("Always write tests first.");
    expect(saved.reviewRigor).toBe("Adversarial review, fix all High + Medium.");
    expect(saved.deployTarget).toEqual({
      account: "111122223333",
      role: "Admin",
      command: "npx cdk deploy",
    });
    expect(saved.updatedAt).toBeInstanceOf(Date);

    const read = getUserPrefs(store.db, "alice")!;
    expect(read.personalInstructions).toBe("Always write tests first.");
    expect(read.deployTarget?.account).toBe("111122223333");
    store.close();
  });

  test("putUserPrefs is a full replace — an omitted field clears it", () => {
    const store = createStore(":memory:");
    putUserPrefs(store.db, "bob", {
      personalInstructions: "Be terse.",
      reviewRigor: "High only.",
      deployTarget: { account: "111" },
    });
    // A later save that omits reviewRigor and the deploy target clears them.
    const updated = putUserPrefs(store.db, "bob", {
      personalInstructions: "Be verbose.",
    });
    expect(updated.personalInstructions).toBe("Be verbose.");
    expect(updated.reviewRigor).toBeUndefined();
    expect(updated.deployTarget).toBeUndefined();

    // One row per alias — upsert, not insert.
    const rows = store.db.query("SELECT alias FROM user_prefs").all();
    expect(rows).toHaveLength(1);
    store.close();
  });

  test("blank strings and an all-empty deploy target normalize to unset", () => {
    const store = createStore(":memory:");
    const saved = putUserPrefs(store.db, "carol", {
      personalInstructions: "   ",
      reviewRigor: "",
      deployTarget: { account: "", role: "  ", command: "" },
    });
    expect(saved.personalInstructions).toBeUndefined();
    expect(saved.reviewRigor).toBeUndefined();
    expect(saved.deployTarget).toBeUndefined();
    store.close();
  });

  test("profiles are per-alias — one user's save doesn't touch another's", () => {
    const store = createStore(":memory:");
    putUserPrefs(store.db, "alice", { personalInstructions: "A" });
    putUserPrefs(store.db, "bob", { personalInstructions: "B" });
    expect(getUserPrefs(store.db, "alice")?.personalInstructions).toBe("A");
    expect(getUserPrefs(store.db, "bob")?.personalInstructions).toBe("B");
    store.close();
  });
});
