import { describe, expect, test } from "bun:test";
import { isLabeledDup, parseDupLabels } from "./kb-dedup-pairs.ts";

const LABELS = parseDupLabels(
  [
    "# frozen copy of a project",
    "app-copy/* app/*",
    "",
    "app/auth-fix app/auth-fix-default-profile   # two fixes of one bug",
    "lonely",
    "mixed/* app/slug",
  ].join("\n"),
);

describe("dedup pair labels", () => {
  const cases: Array<[string, string, string, boolean]> = [
    ["listed pair", "app/auth-fix", "app/auth-fix-default-profile", true],
    ["listed pair, reversed", "app/auth-fix-default-profile", "app/auth-fix", true],
    ["same slug across a fork", "app-copy/overview", "app/overview", true],
    ["same slug across a fork, reversed", "app/overview", "app-copy/overview", true],
    ["different slugs across a fork", "app-copy/overview", "app/roadmap", false],
    ["same slug, projects not forked", "other/overview", "app/overview", false],
    ["a fork side mixed with a doc ref is ignored", "mixed/slug", "app/slug", false],
    ["unlisted pair", "app/a", "app/b", false],
  ];
  for (const [name, a, b, want] of cases) {
    test(name, () => {
      expect(isLabeledDup(LABELS, a, b)).toBe(want);
    });
  }

  test("a line with one ref and comments add nothing", () => {
    expect(LABELS.pairs.size).toBe(1);
    expect(LABELS.forks.size).toBe(1);
  });

  test("parsing into an existing set adds to it", () => {
    const merged = parseDupLabels("x/a x/b", parseDupLabels("y/* z/*"));
    expect(isLabeledDup(merged, "x/b", "x/a")).toBe(true);
    expect(isLabeledDup(merged, "z/s", "y/s")).toBe(true);
  });
});
