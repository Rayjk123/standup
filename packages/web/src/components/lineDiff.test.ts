import { expect, test, describe } from "bun:test";
import { lineDiff } from "./lineDiff.js";

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
