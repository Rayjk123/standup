import { describe, expect, test } from "bun:test";
import { ALL_TARGETS, signalTargets } from "./signal";

describe("signalTargets", () => {
  test("a signal aimed at an id applies to that id only", () => {
    expect(signalTargets("s1", "s1")).toBe(true);
    expect(signalTargets("s1", "s2")).toBe(false);
  });

  test("the wildcard applies to every id", () => {
    expect(signalTargets(ALL_TARGETS, "s1")).toBe(true);
    expect(signalTargets(ALL_TARGETS, "p9")).toBe(true);
  });

  test("the empty initial id applies to nothing", () => {
    expect(signalTargets("", "s1")).toBe(false);
  });
});
