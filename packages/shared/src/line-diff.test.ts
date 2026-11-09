import { expect, test, describe } from "bun:test";
import { formatLineDiff, lineDiff } from "./line-diff.js";

describe("lineDiff", () => {
  test("identical text is all 'same'", () => {
    const result = lineDiff("a\nb\nc", "a\nb\nc");
    expect(result.every((l) => l.type === "same")).toBe(true);
    expect(result.map((l) => l.text)).toEqual(["a", "b", "c"]);
  });

  test("a single changed line shows as remove+add, not a wholesale rewrite", () => {
    const result = lineDiff("a\nb\nc", "a\nB\nc");
    expect(result).toEqual([
      { type: "same", text: "a" },
      { type: "remove", text: "b" },
      { type: "add", text: "B" },
      { type: "same", text: "c" },
    ]);
  });

  test("an appended line shows only as an addition", () => {
    const result = lineDiff("a\nb", "a\nb\nc");
    expect(result).toEqual([
      { type: "same", text: "a" },
      { type: "same", text: "b" },
      { type: "add", text: "c" },
    ]);
  });

  test("empty old text against real content is all additions", () => {
    const result = lineDiff("", "a\nb");
    expect(result.every((l) => l.type === "add")).toBe(true);
  });
});

describe("formatLineDiff", () => {
  test("changed lines with one line of context, skipped runs marked", () => {
    const old = ["a", "b", "c", "d", "e", "f", "g"].join("\n");
    const next = ["a", "B", "c", "d", "e", "f", "G"].join("\n");
    expect(formatLineDiff(lineDiff(old, next))).toBe(["  a", "- b", "+ B", "  c", "…", "  f", "- g", "+ G"].join("\n"));
  });

  test("identical texts give no diff; a long diff is cut with a count", () => {
    expect(formatLineDiff(lineDiff("a\nb", "a\nb"))).toBe("");
    const out = formatLineDiff(lineDiff("", Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n")), { maxLines: 3 });
    expect(out).toBe(["+ l0", "+ l1", "+ l2", "… (7 more lines)"].join("\n"));
  });
});
