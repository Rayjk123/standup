import { describe, expect, test } from "bun:test";
import { isCommentShortcut } from "./commentIcon";

const key = (k: string, code: string, mods: { alt?: boolean; ctrl?: boolean; meta?: boolean } = {}) => ({
  key: k,
  code,
  altKey: mods.alt ?? false,
  ctrlKey: mods.ctrl ?? false,
  metaKey: mods.meta ?? false,
});

describe("the comment shortcut", () => {
  const cases: Array<[string, ReturnType<typeof key>, boolean, boolean]> = [
    ["Ctrl+Alt+M off a Mac", key("m", "KeyM", { ctrl: true, alt: true }), false, true],
    ["Ctrl+Alt+Shift+M off a Mac", key("M", "KeyM", { ctrl: true, alt: true }), false, true],
    ["AZERTY: the key labelled M (code Semicolon) off a Mac", key("m", "Semicolon", { ctrl: true, alt: true }), false, true],
    ["AZERTY: the QWERTY M position (labelled ,) off a Mac", key(",", "KeyM", { ctrl: true, alt: true }), false, false],
    ["AltGr+M typing µ (German, Windows)", key("µ", "KeyM", { ctrl: true, alt: true }), false, false],
    ["Ctrl+M without Alt", key("m", "KeyM", { ctrl: true }), false, false],
    ["⌘⌥M on a Mac, where Option makes the key µ", key("µ", "KeyM", { meta: true, alt: true }), true, true],
    ["Ctrl+Alt+M on a Mac", key("µ", "KeyM", { ctrl: true, alt: true }), true, false],
    ["⌥M alone on a Mac", key("µ", "KeyM", { alt: true }), true, false],
  ];
  for (const [name, event, onMac, want] of cases) test(name, () => expect(isCommentShortcut(event, onMac)).toBe(want));
});
