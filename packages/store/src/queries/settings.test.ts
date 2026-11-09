import { expect, test, describe, afterAll } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { createStore } from "../store.js";
import { getSetting, setSetting, getSettingsVersion } from "../index.js";

/**
 * The monotonic settings version underpins the Slack adapter's poll-safe settings
 * sync: a poller records the version its own write was assigned and only adopts a
 * later snapshot whose version has reached it. These pin the contract that version
 * — starts at 0, increments by one on every write, is durable across restarts, and
 * never leaks into a real setting read.
 */

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe("settings version counter", () => {
  test("starts at 0 and increments by one on every write", () => {
    const store = createStore(":memory:");
    expect(getSettingsVersion(store.db)).toBe(0);

    setSetting(store.db, "a", "1");
    expect(getSettingsVersion(store.db)).toBe(1);
    setSetting(store.db, "b", "2");
    expect(getSettingsVersion(store.db)).toBe(2);
    // A rewrite of the same key still counts as a change.
    setSetting(store.db, "a", "3");
    expect(getSettingsVersion(store.db)).toBe(3);
  });

  test("the reserved version key never leaks into a real setting read", () => {
    const store = createStore(":memory:");
    setSetting(store.db, "slackFeedChannel", "C123");
    expect(getSetting(store.db, "slackFeedChannel")).toBe("C123");
    // Reading the reserved key name back as a normal setting is not a real setting.
    expect(getSetting(store.db, "slackFeedChannel")).not.toBe(String(getSettingsVersion(store.db)));
  });

  test("the version is durable across a restart (never rewinds)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "standup-settings-"));
    dirs.push(dir);
    const path = join(dir, "settings.db");

    const first = createStore(path);
    setSetting(first.db, "a", "1");
    setSetting(first.db, "b", "2");
    const before = getSettingsVersion(first.db);
    expect(before).toBe(2);
    first.db.close();

    // Reopen the same file: the counter persists, so a further write continues up.
    const second = createStore(path);
    expect(getSettingsVersion(second.db)).toBe(before);
    setSetting(second.db, "c", "3");
    expect(getSettingsVersion(second.db)).toBe(before + 1);
    second.db.close();
  });
});
