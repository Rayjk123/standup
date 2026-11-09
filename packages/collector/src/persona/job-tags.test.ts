import { describe, expect, test } from "bun:test";
import { composeReplyTags, isMentionableTitle, jobMentions } from "./job-tags.js";

const FLAKY = { id: "3f2a9c1b-0d4e-4c6a-9b1f-2e7d8a5c4b3a", title: "Fix the flaky login test" };
const DOCS = { id: "a1b2c3d4-1111-4222-8333-444455556666", title: "Docs" };
const TICKET = { id: "0badf00d-1111-4222-8333-444455556666", title: "PERSONA-123" };
const NON_HEX = { id: "job-zzzzzzzz-1", title: "Plain job title" };

describe("jobMentions", () => {
  test("matches a job by its full id, case-insensitively", () => {
    expect(jobMentions(`job ${FLAKY.id.toUpperCase()} is done`, [FLAKY])).toEqual([FLAKY.id]);
    expect(jobMentions(`see (${NON_HEX.id}).`, [NON_HEX])).toEqual([NON_HEX.id]);
  });

  test("matches an 8-character hex short id standing alone", () => {
    expect(jobMentions("3f2a9c1b is green", [FLAKY])).toEqual([FLAKY.id]);
    expect(jobMentions("`3F2A9C1B`, then", [FLAKY])).toEqual([FLAKY.id]);
  });

  test("a short id inside a longer token, or a different uuid, does not match", () => {
    expect(jobMentions("x3f2a9c1b", [FLAKY])).toEqual([]);
    expect(jobMentions("3f2a9c1bc", [FLAKY])).toEqual([]);
    expect(jobMentions("session 3f2a9c1b-ffff-4fff-8fff-ffffffffffff", [FLAKY])).toEqual([]);
    expect(jobMentions("3f2a9c1", [FLAKY])).toEqual([]);
  });

  test("an 8-character word that isn't hex never matches a job id that isn't hex", () => {
    expect(jobMentions("zzzzzzzz happened", [NON_HEX])).toEqual([]);
    expect(jobMentions("job-zzzz", [NON_HEX])).toEqual([]);
  });

  test("a short id two jobs share names neither", () => {
    const twin = { id: `${FLAKY.id.slice(0, 8)}-ffff-4fff-8fff-ffffffffffff`, title: "Other twin" };
    expect(jobMentions("3f2a9c1b", [FLAKY, twin])).toEqual([]);
    expect(jobMentions(FLAKY.id, [FLAKY, twin])).toEqual([FLAKY.id]);
  });

  test("matches an exact title as a whole phrase, case- and spacing-insensitively", () => {
    expect(jobMentions("**fix the  flaky login\ntest** is green", [FLAKY])).toEqual([FLAKY.id]);
    expect(jobMentions('"Fix the flaky login test": done', [FLAKY])).toEqual([FLAKY.id]);
    expect(jobMentions("PERSONA-123 shipped", [TICKET])).toEqual([TICKET.id]);
  });

  test("a partial word, a fragment or a common word does not match a title", () => {
    expect(jobMentions("Fix the flaky login tests", [FLAKY])).toEqual([]);
    expect(jobMentions("prefix the flaky login test", [FLAKY])).toEqual([]);
    expect(jobMentions("the flaky login test", [FLAKY])).toEqual([]);
    expect(jobMentions("Updated the docs", [DOCS])).toEqual([]);
    expect(jobMentions("PERSONA-1234", [TICKET])).toEqual([]);
    const generic = [
      { id: "11111111-1111-4111-8111-111111111111", title: "Run tests" },
      { id: "22222222-2222-4222-8222-222222222222", title: "Fix bug" },
      { id: "33333333-3333-4333-8333-333333333333", title: "Code review" },
    ];
    expect(jobMentions("I'll run tests, fix bug reports, and do a code review.", generic)).toEqual([]);
    const audit = { id: "44444444-4444-4444-8444-4444444444aa", title: "Knowledge audit" };
    expect(jobMentions("The knowledge audit is done.", [audit])).toEqual([audit.id]);
  });

  test("returns jobs in the given order, each once", () => {
    const text = `Fix the flaky login test (${FLAKY.id}) and PERSONA-123`;
    expect(jobMentions(text, [TICKET, FLAKY])).toEqual([TICKET.id, FLAKY.id]);
    expect(jobMentions("", [FLAKY])).toEqual([]);
  });
});

describe("isMentionableTitle", () => {
  test("needs three distinctive words, a distinctive pair, or one identifier-like word", () => {
    expect(isMentionableTitle("Fix the flaky login test")).toBe(true);
    expect(isMentionableTitle("Persona job tags")).toBe(true);
    expect(isMentionableTitle("Slack DM retries")).toBe(true);
    expect(isMentionableTitle("Write the release notes")).toBe(true);
    expect(isMentionableTitle("Knowledge audit")).toBe(true);
    expect(isMentionableTitle("Fix the knowledge audit")).toBe(true);
    expect(isMentionableTitle("Policy severity")).toBe(true);
    expect(isMentionableTitle("v2.1")).toBe(true);
    expect(isMentionableTitle("Run tests")).toBe(false);
    expect(isMentionableTitle("Fix bug")).toBe(false);
    expect(isMentionableTitle("Fix a bug")).toBe(false);
    expect(isMentionableTitle("Fix the bug")).toBe(false);
    expect(isMentionableTitle("Add unit tests")).toBe(false);
    expect(isMentionableTitle("Fix the flaky test")).toBe(false);
    expect(isMentionableTitle("Update the docs")).toBe(false);
    expect(isMentionableTitle("Code review")).toBe(false);
    expect(isMentionableTitle("Docs fix")).toBe(false);
    expect(isMentionableTitle("Refactor the")).toBe(false);
    expect(isMentionableTitle("Docs")).toBe(false);
    expect(isMentionableTitle("Refactoring")).toBe(false);
    expect(isMentionableTitle("a b")).toBe(false);
    expect(isMentionableTitle("v2")).toBe(false);
  });
});

describe("composeReplyTags", () => {
  test("declared tags come first, inferred ones dedupe, removals win", () => {
    expect(
      composeReplyTags({
        acted: ["a", "b"],
        events: ["c", "a"],
        mentioned: ["d", "e"],
        declaredAdd: ["b", "f"],
        declaredRemove: ["e", "f"],
      })
    ).toEqual([
      { jobId: "b", source: "declared" },
      { jobId: "a", source: "inferred" },
      { jobId: "c", source: "inferred" },
      { jobId: "d", source: "inferred" },
    ]);
    expect(composeReplyTags({})).toEqual([]);
  });
});
