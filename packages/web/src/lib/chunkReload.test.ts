import { describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { hasUnsavedInput, isChunkLoadError, MIN_RELOAD_INTERVAL_MS, reloadForNewBuild } from "./chunkReload";
import { lazyNamed } from "./lazyNamed";

function memoryStorage() {
  const items = new Map<string, string>();
  return { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v) };
}

describe("isChunkLoadError", () => {
  test("recognises the browsers' failed-chunk messages", () => {
    expect(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: http://x/assets/WorkView-1.js"))).toBe(true);
    expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isChunkLoadError(new TypeError("error loading dynamically imported module: http://x/a.js"))).toBe(true);
    expect(isChunkLoadError(new Error("Unable to preload CSS for /assets/x.css"))).toBe(true);
  });

  test("leaves a module's own errors alone", () => {
    expect(isChunkLoadError(new ReferenceError("foo is not defined"))).toBe(false);
    expect(isChunkLoadError("boom")).toBe(false);
  });
});

describe("reloadForNewBuild", () => {
  test("reloads at most once per interval", () => {
    const storage = memoryStorage();
    let reloads = 0;
    const reload = () => void reloads++;
    const unsaved = () => false;
    expect(reloadForNewBuild({ storage, now: 1_000_000, reload, unsaved })).toBe(true);
    expect(reloadForNewBuild({ storage, now: 1_000_000 + MIN_RELOAD_INTERVAL_MS - 1, reload, unsaved })).toBe(false);
    expect(reloadForNewBuild({ storage, now: 1_000_000 + MIN_RELOAD_INTERVAL_MS, reload, unsaved })).toBe(true);
    expect(reloads).toBe(2);
  });

  test("never reloads over typed text", () => {
    let reloads = 0;
    expect(reloadForNewBuild({ storage: memoryStorage(), reload: () => void reloads++, unsaved: () => true })).toBe(false);
    expect(reloads).toBe(0);
  });
});

describe("hasUnsavedInput", () => {
  test("finds typed text in a field, ignoring empty and non-text inputs", () => {
    const window = new GlobalWindow();
    const doc = window.document as unknown as Document;
    doc.body.innerHTML = `<textarea></textarea><input type="checkbox" value="on"><input type="text" value="  ">`;
    expect(hasUnsavedInput(doc)).toBe(false);
    (doc.querySelector("textarea") as HTMLTextAreaElement).value = "half a draft";
    expect(hasUnsavedInput(doc)).toBe(true);
    doc.body.innerHTML = `<div contenteditable="true">note</div>`;
    expect(hasUnsavedInput(doc)).toBe(true);
    window.close();
  });

  test("never reloads without storage to guard the loop", () => {
    const storage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {},
    };
    let reloads = 0;
    expect(reloadForNewBuild({ storage, reload: () => void reloads++ })).toBe(false);
    expect(reloads).toBe(0);
  });
});

describe("lazyNamed", () => {
  test("preload loads the module once and a failed load is retried", async () => {
    let calls = 0;
    let fail = true;
    const View = () => null;
    const lazyView = lazyNamed(async () => {
      calls++;
      if (fail) throw new Error("offline");
      return { View };
    }, "View");
    await expect(lazyView.preload()).rejects.toThrow("offline");
    fail = false;
    await lazyView.preload();
    await lazyView.preload();
    expect(calls).toBe(2);
  });
});
