import { describe, expect, test } from "bun:test";
import { SCRATCH_ID, isOwnScratchDir, scratchDirFor, scratchRoot } from "./scratch.js";

const ID = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b";

describe("scratchRoot", () => {
  test("defaults to ~/.cache/standup-scratch", () => {
    expect(scratchRoot({}, "/home/u")).toBe("/home/u/.cache/standup-scratch");
  });

  test("honours an absolute XDG_CACHE_HOME and ignores a relative or blank one", () => {
    expect(scratchRoot({ XDG_CACHE_HOME: "/var/cache/u/" }, "/home/u")).toBe("/var/cache/u/standup-scratch");
    expect(scratchRoot({ XDG_CACHE_HOME: "rel/cache" }, "/home/u")).toBe("/home/u/.cache/standup-scratch");
    expect(scratchRoot({ XDG_CACHE_HOME: "  " }, "/home/u")).toBe("/home/u/.cache/standup-scratch");
  });

  test("an absolute STANDUP_SCRATCH_ROOT named standup-scratch* wins; a relative one is ignored", () => {
    expect(scratchRoot({ STANDUP_SCRATCH_ROOT: "/t/standup-scratch-test-a1/", XDG_CACHE_HOME: "/c" }, "/home/u")).toBe("/t/standup-scratch-test-a1");
    expect(scratchRoot({ STANDUP_SCRATCH_ROOT: "/t/standup-scratch", XDG_CACHE_HOME: "/c" }, "/home/u")).toBe("/t/standup-scratch");
    expect(scratchRoot({ STANDUP_SCRATCH_ROOT: "t/standup-scratch", XDG_CACHE_HOME: "/c" }, "/home/u")).toBe("/c/standup-scratch");
  });

  test("a STANDUP_SCRATCH_ROOT whose own name isn't standup-scratch* is ignored", () => {
    for (const bad of ["/t/s", "/home/u", "/", "/home/u/.cache", "/t/standup-scratch/..", "/t/my-standup-scratch"]) {
      expect(scratchRoot({ STANDUP_SCRATCH_ROOT: bad, XDG_CACHE_HOME: "/c" }, "/home/u")).toBe("/c/standup-scratch");
    }
  });
});

describe("scratchDirFor", () => {
  test("is <root>/<launchId>", () => {
    expect(scratchDirFor(ID, {}, "/home/u")).toBe(`/home/u/.cache/standup-scratch/${ID}`);
  });

  test("refuses ids that are not one plain path component", () => {
    for (const bad of ["", ".", "..", "../x", "a/b", ".hidden", "a b", "x".repeat(65), "a\nb", "a.b-c", "-x", "_x", ".standup-scratch"]) {
      expect(SCRATCH_ID.test(bad)).toBe(false);
      expect(() => scratchDirFor(bad, {}, "/home/u")).toThrow("not a usable launch id");
    }
    for (const good of [ID, "L1", "launch_2", "launch-1", "x".repeat(64)]) expect(SCRATCH_ID.test(good)).toBe(true);
  });
});

describe("isOwnScratchDir", () => {
  const env = { XDG_CACHE_HOME: "/c" };
  test("matches exactly the launch's dir, with or without a trailing slash", () => {
    expect(isOwnScratchDir(`/c/standup-scratch/${ID}`, ID, env)).toBe(true);
    expect(isOwnScratchDir(`/c/standup-scratch/${ID}/`, ID, env)).toBe(true);
    expect(isOwnScratchDir(`/c/standup-scratch/x/../${ID}`, ID, env)).toBe(true);
  });

  test("refuses another launch's dir, a child, the root, a relative path and a bad id", () => {
    expect(isOwnScratchDir("/c/standup-scratch/other", ID, env)).toBe(false);
    expect(isOwnScratchDir(`/c/standup-scratch/${ID}/sub`, ID, env)).toBe(false);
    expect(isOwnScratchDir("/c/standup-scratch", ID, env)).toBe(false);
    expect(isOwnScratchDir(`standup-scratch/${ID}`, ID, env)).toBe(false);
    expect(isOwnScratchDir("/c/standup-scratch/..", "..", env)).toBe(false);
  });
});
