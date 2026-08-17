import { expect, test, describe } from "bun:test";
import { cleanTitle } from "./auto-checkpoint.js";

/**
 * cleanTitle normalizes what Haiku returns for a session title — models tend
 * to wrap it in quotes or end it with a period despite being told not to, and
 * an over-long one has to be capped.
 */
describe("cleanTitle", () => {
  test("passes a clean title through unchanged", () => {
    expect(cleanTitle("Fix the retry backoff")).toBe("Fix the retry backoff");
  });

  test("strips surrounding double, single, and backtick quotes", () => {
    expect(cleanTitle('"Add auth middleware"')).toBe("Add auth middleware");
    expect(cleanTitle("'Add auth middleware'")).toBe("Add auth middleware");
    expect(cleanTitle("`Add auth middleware`")).toBe("Add auth middleware");
  });

  test("strips a trailing period", () => {
    expect(cleanTitle("Refactor the launcher.")).toBe("Refactor the launcher");
  });

  test("caps an over-long title with an ellipsis", () => {
    const long = "a".repeat(200);
    const out = cleanTitle(long)!;
    expect(out.length).toBe(70);
    expect(out.endsWith("…")).toBe(true);
  });

  test("returns null when nothing usable is left", () => {
    expect(cleanTitle('""')).toBeNull();
    expect(cleanTitle("   ")).toBeNull();
  });
});
