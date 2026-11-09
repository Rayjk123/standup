import { describe, expect, test } from "bun:test";
import { highlightParts, isSearchShortcut, searchShortcutLabel, searchTerms } from "./searchText";

const key = (init: Partial<KeyboardEvent>) => ({ key: "k", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...init });

describe("docs search helpers", () => {
  test("a query's terms are its distinct lowercased words", () => {
    expect(searchTerms("  Auth  limits auth ")).toEqual(["auth", "limits"]);
    expect(searchTerms("   ")).toEqual([]);
  });

  test("highlighting marks every case-insensitive occurrence of each term, merging overlaps", () => {
    expect(highlightParts("notes/Auth/auth-limits.md", ["auth"])).toEqual([
      { text: "notes/", hit: false },
      { text: "Auth", hit: true },
      { text: "/", hit: false },
      { text: "auth", hit: true },
      { text: "-limits.md", hit: false },
    ]);
    expect(highlightParts("abcd", ["abc", "bcd"])).toEqual([{ text: "abcd", hit: true }]);
    expect(highlightParts("plain", [])).toEqual([{ text: "plain", hit: false }]);
  });

  test("the shortcut is Cmd+K or Ctrl+K, without Alt or Shift", () => {
    expect(isSearchShortcut(key({ metaKey: true }))).toBe(true);
    expect(isSearchShortcut(key({ ctrlKey: true, key: "K" }))).toBe(true);
    expect(isSearchShortcut(key({}))).toBe(false);
    expect(isSearchShortcut(key({ ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isSearchShortcut(key({ metaKey: true, altKey: true }))).toBe(false);
    expect(isSearchShortcut(key({ ctrlKey: true, key: "/" }))).toBe(false);
  });

  test("the tooltip names the shortcut the way the platform writes it", () => {
    expect(searchShortcutLabel("MacIntel")).toBe("⌘K");
    expect(searchShortcutLabel("Linux x86_64")).toBe("Ctrl+K");
    expect(searchShortcutLabel("Win32")).toBe("Ctrl+K");
  });
});
