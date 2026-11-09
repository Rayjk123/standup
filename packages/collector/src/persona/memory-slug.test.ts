import { describe, expect, test } from "bun:test";
import { isValidSlug } from "@standup/knowledge";
import { isMemorySlug, memorySlug, ownerMemoryPrefix, topicOfMemorySlug } from "./memory-slug.js";

describe("memory slugs", () => {
  test("carry the owner, so two owners' topics never share a file", () => {
    expect(memorySlug("alice", "tests")).toEqual({ slug: "persona-alice-tests", topic: "tests" });
    expect(memorySlug("bob", "tests")!.slug).toBe("persona-bob-tests");
    expect(memorySlug("Bob.Smith", "Brief length")!.slug).toBe("persona-bob-smith-brief-length");
  });

  test("the same topic always maps to the same slug, however it is written", () => {
    expect(memorySlug("alice", "Brief length")).toEqual(memorySlug("alice", "brief-length"));
    expect(memorySlug("alice", "tests!")).toEqual(memorySlug("alice", "tests"));
    expect(memorySlug("alice", "テスト")).toEqual(memorySlug("alice", "テスト"));
  });

  test("non-ASCII topics keep apart instead of collapsing to one slug", () => {
    const a = memorySlug("alice", "テスト")!;
    const b = memorySlug("alice", "レビュー")!;
    const c = memorySlug("alice", "🚀 deploys")!;
    expect(new Set([a.slug, b.slug, c.slug]).size).toBe(3);
    // A topic of symbols alone names nothing.
    expect(memorySlug("alice", "🚀")).toBeNull();
    expect(a.topic).toMatch(/^[0-9a-f]{8}$/);
    expect(memorySlug("alice", "café rules")!.slug).toMatch(/^persona-alice-caf-rules-[0-9a-f]{8}$/);
  });

  test("long topics that share a prefix keep apart, and every slug is a valid file name", () => {
    const base = "a very long topic about how the owner wants worker briefs written and reviewed";
    const one = memorySlug("alice", `${base} on mondays`)!;
    const two = memorySlug("alice", `${base} on fridays`)!;
    expect(one.slug).not.toBe(two.slug);
    for (const { slug } of [one, two, memorySlug("a-very-long-owner-alias-indeed-yes", base)!]) {
      expect(slug.length).toBeLessThanOrEqual(64);
      expect(isValidSlug(slug)).toBe(true);
    }
  });

  test("a topic with no letters or digits is refused", () => {
    expect(memorySlug("alice", "")).toBeNull();
    expect(memorySlug("alice", "  -- !! ")).toBeNull();
  });

  test("topics are read back from either slug shape", () => {
    expect(topicOfMemorySlug("persona-alice-brief-length", "alice")).toBe("brief-length");
    expect(topicOfMemorySlug("persona-feedback-reply-length", "alice")).toBe("feedback-reply-length");
    expect(ownerMemoryPrefix("alice")).toBe("persona-alice-");
  });

  test("only a single-segment persona slug is a memory slug", () => {
    expect(isMemorySlug("persona-alice-tests")).toBe(true);
    for (const slug of ["persona-", "native-mem-home-claude-md", "persona-../p/doc", "persona-a/b", "persona-..%2Fp"]) {
      expect(isMemorySlug(slug)).toBe(false);
    }
  });
});
