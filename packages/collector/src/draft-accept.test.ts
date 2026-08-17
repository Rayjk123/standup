import { expect, test, describe } from "bun:test";
import { resolveAcceptMode, isAcceptAllEligible } from "./draft-accept.js";

describe("resolveAcceptMode", () => {
  test("a first-bootstrap draft (no replaces_slug) has nothing to decide", () => {
    expect(resolveAcceptMode(undefined, undefined)).toBeNull();
    expect(resolveAcceptMode(undefined, "replace")).toBeNull();
  });

  test("a regenerated draft defaults to merge when no mode is requested", () => {
    expect(resolveAcceptMode("gotchas", undefined)).toBe("merge");
  });

  test("an unrecognised mode falls back to the safe default (merge), not replace", () => {
    expect(resolveAcceptMode("gotchas", "overwrite-everything")).toBe("merge");
  });

  test("replace is only chosen when explicitly requested", () => {
    expect(resolveAcceptMode("gotchas", "replace")).toBe("replace");
  });
});

describe("isAcceptAllEligible", () => {
  test("a plain first-bootstrap draft is eligible", () => {
    expect(isAcceptAllEligible({ verdict: "clean" })).toBe(true);
    expect(isAcceptAllEligible({ verdict: "unverified" })).toBe(true);
  });

  test("a draft with replaces_slug is never eligible, regardless of verdict", () => {
    expect(isAcceptAllEligible({ replacesSlug: "gotchas", verdict: "clean" })).toBe(false);
  });

  test("a disputed draft is never eligible, even with no replaces_slug", () => {
    expect(isAcceptAllEligible({ verdict: "disputed" })).toBe(false);
  });

  test("a verifier error does not block accept-all — only a positive dispute does", () => {
    expect(isAcceptAllEligible({ verdict: "error" })).toBe(true);
  });
});
