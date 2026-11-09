import { describe, expect, test } from "bun:test";
import type { DocFolder, DocTree } from "@standup/shared";
import { OPEN_FOLDERS_CAP, OPEN_FOLDERS_KEY, loadOpenFolders, pruneOpenFolders, saveOpenFolders } from "./openFolders";

const AT = "2026-10-01T00:00:00.000Z";
const folder = (id: string, parentId: string | null = null): DocFolder => ({ id, parentId, name: id, createdAt: AT, updatedAt: AT });

/** A Storage over a Map; `broken` makes every call throw, like a storage the browser refuses. */
function memoryStorage(initial: Record<string, string> = {}, broken = false): Storage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  const guard = () => {
    if (broken) throw new Error("SecurityError");
  };
  return {
    data,
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => (guard(), data.get(k) ?? null),
    setItem: (k: string, v: string) => (guard(), void data.set(k, v)),
    removeItem: (k: string) => (guard(), void data.delete(k)),
  };
}

describe("open folders persistence", () => {
  test("saves the open folders as a compact JSON array and restores them", () => {
    const storage = memoryStorage();
    saveOpenFolders(storage, new Set(["f1", "f2"]));
    expect(storage.data.get(OPEN_FOLDERS_KEY)).toBe('["f1","f2"]');
    expect([...loadOpenFolders(storage)]).toEqual(["f1", "f2"]);
  });

  test("an empty set removes the key", () => {
    const storage = memoryStorage({ [OPEN_FOLDERS_KEY]: '["f1"]' });
    saveOpenFolders(storage, new Set());
    expect(storage.data.has(OPEN_FOLDERS_KEY)).toBe(false);
  });

  test("a missing, malformed or wrongly shaped value restores nothing", () => {
    expect(loadOpenFolders(memoryStorage()).size).toBe(0);
    expect(loadOpenFolders(undefined).size).toBe(0);
    for (const bad of ["{not json", '{"f1":true}', '"f1"', "42", "null"]) {
      expect(loadOpenFolders(memoryStorage({ [OPEN_FOLDERS_KEY]: bad })).size).toBe(0);
    }
    expect([...loadOpenFolders(memoryStorage({ [OPEN_FOLDERS_KEY]: '["f1", 7, null, "", "f2"]' }))]).toEqual(["f1", "f2"]);
  });

  test("a storage that throws neither breaks a load nor a save", () => {
    const storage = memoryStorage({}, true);
    expect(loadOpenFolders(storage).size).toBe(0);
    expect(() => saveOpenFolders(storage, new Set(["f1"]))).not.toThrow();
  });

  test("keeps only the newest entries past the cap", () => {
    const storage = memoryStorage();
    const ids = Array.from({ length: OPEN_FOLDERS_CAP + 20 }, (_, i) => `f${i}`);
    saveOpenFolders(storage, new Set(ids));
    const stored = JSON.parse(storage.data.get(OPEN_FOLDERS_KEY)!) as string[];
    expect(stored.length).toBe(OPEN_FOLDERS_CAP);
    expect(stored[0]).toBe("f20");
    expect(loadOpenFolders(memoryStorage({ [OPEN_FOLDERS_KEY]: JSON.stringify(ids) })).size).toBe(OPEN_FOLDERS_CAP);
  });

  test("pruning drops folders the tree no longer has, and keeps the same set when none are gone", () => {
    const tree: DocTree = { folders: [folder("f1"), folder("f2", "f1")], docs: [], assets: [] };
    const open = new Set(["f1", "f2"]);
    expect(pruneOpenFolders(open, tree)).toBe(open);
    expect([...pruneOpenFolders(new Set(["f1", "gone", "f2"]), tree)]).toEqual(["f1", "f2"]);
  });

  test("a folder opened after the tree was asked for is kept, even when that tree doesn't list it yet", () => {
    const tree: DocTree = { folders: [folder("f1")], docs: [], assets: [] };
    const openAtRead = new Set(["f1", "gone"]);
    expect([...pruneOpenFolders(new Set(["f1", "gone", "new"]), tree, openAtRead)]).toEqual(["f1", "new"]);
  });
});
