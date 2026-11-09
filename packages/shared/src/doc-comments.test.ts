import { describe, expect, test } from "bun:test";
import { DOC_COMMENT_CONTEXT, anchorAt, docCommentRefusal, locateAnchor } from "./doc-comments.js";

const DOC = "Option 2 re-renders the whole site, about 4 hours today. Option 1 keeps one source of truth.";

/** The anchor for the first occurrence of `quote` in `text` (or the nth). */
function anchorOf(text: string, quote: string, nth = 0) {
  let at = -1;
  for (let i = 0; i <= nth; i++) at = text.indexOf(quote, at + 1);
  return anchorAt(text, at, at + quote.length);
}

describe("anchorAt", () => {
  test("keeps the quote trimmed and up to DOC_COMMENT_CONTEXT characters on each side", () => {
    const text = `${"a".repeat(50)} the quote ${"b".repeat(50)}`;
    const start = text.indexOf(" the quote ");
    const anchor = anchorAt(text, start, start + " the quote ".length);
    expect(anchor.quote).toBe("the quote");
    expect(anchor.prefix).toBe(`${"a".repeat(DOC_COMMENT_CONTEXT - 1)} `);
    expect(anchor.suffix).toBe(` ${"b".repeat(DOC_COMMENT_CONTEXT - 1)}`);
  });
});

describe("locateAnchor re-anchors after edits", () => {
  const anchor = anchorOf(DOC, "one source of truth");
  const cases: Array<{ name: string; text: string; found: string | null }> = [
    { name: "unchanged doc", text: DOC, found: "one source of truth" },
    { name: "text added before the passage", text: `# Title\n\nA new intro paragraph.\n\n${DOC}`, found: "one source of truth" },
    { name: "text added after the passage", text: `${DOC}\n\nMore later.`, found: "one source of truth" },
    { name: "whitespace inside the passage changed", text: DOC.replace("one source of truth", "one\nsource  of truth"), found: "one\nsource  of truth" },
    { name: "block boundaries rendered without whitespace", text: DOC.replace(". Option 1", ".Option 1"), found: "one source of truth" },
    { name: "the passage reworded (orphan)", text: DOC.replace("one source of truth", "a single source"), found: null },
    { name: "the passage deleted (orphan)", text: "Option 2 re-renders the whole site.", found: null },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const at = locateAnchor(c.text, anchor);
      expect(at ? c.text.slice(at.start, at.end) : null).toBe(c.found);
    });
  }

  test("a repeated quote resolves to the occurrence whose context matches", () => {
    const text = "Cache for ten minutes in region A. Later: cache for ten minutes in region B.";
    const second = anchorOf(text, "ten minutes", 1);
    const at = locateAnchor(`Intro. ${text}`, second)!;
    expect(`Intro. ${text}`.slice(at.end, at.end + 12)).toBe(" in region B");
  });

  test("an empty quote is never located", () => {
    expect(locateAnchor(DOC, { quote: "  ", prefix: "", suffix: "" })).toBeNull();
  });
});

describe("docCommentRefusal", () => {
  const anchor = { quote: "q", prefix: "", suffix: "" };
  const cases: Array<[string, Record<string, unknown>, boolean]> = [
    ["a full comment", { body: "Why?", anchor }, true],
    ["no body", { body: "  ", anchor }, false],
    ["a long body", { body: "b".repeat(2001), anchor }, false],
    ["no anchor", { body: "Why?", anchor: null }, false],
    ["an empty quote", { body: "Why?", anchor: { ...anchor, quote: " " } }, false],
    ["a long quote", { body: "Why?", anchor: { ...anchor, quote: "q".repeat(501) } }, false],
    ["a long prefix", { body: "Why?", anchor: { ...anchor, prefix: "p".repeat(65) } }, false],
    ["a non-string suffix", { body: "Why?", anchor: { ...anchor, suffix: 3 } }, false],
  ];
  for (const [name, input, ok] of cases) {
    test(name, () => {
      expect(docCommentRefusal(input as Parameters<typeof docCommentRefusal>[0]) === null).toBe(ok);
    });
  }
});
