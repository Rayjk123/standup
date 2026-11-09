import { expect, test, describe, afterEach } from "bun:test";
import { tools, handleToolCall } from "./tools.js";

/**
 * propose_knowledge auto-accepts and publishes by default; request_human_review
 * opts into the legacy draft-for-review behavior. This verifies the tool's
 * input contract carries the new flag and that the flag is forwarded to the
 * collector and the reply reflects which path ran (published vs. drafted).
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("propose_knowledge MCP tool", () => {
  test("is registered and exposes request_human_review in its input schema", () => {
    const tool = tools.find((t) => t.name === "propose_knowledge");
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.required).toEqual(["slug", "title", "body"]);
    const props = tool!.inputSchema.properties as Record<string, { type?: string }>;
    expect(props.request_human_review).toBeDefined();
    expect(props.request_human_review.type).toBe("boolean");
    // The description documents the new default (auto-accept / published).
    expect(String(tool!.description)).toMatch(/auto-accepted|published/i);
    expect(String(tool!.description)).toMatch(/request_human_review/);
  });

  test("by default forwards request_human_review: false and reports the doc as published", async () => {
    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        JSON.stringify({ ok: true, slug: "gotchas", published: true, mode: "accept" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    const result = await handleToolCall(
      "propose_knowledge",
      { slug: "gotchas", title: "Gotchas", body: "watch out" },
      "http://collector.test"
    );

    expect(capturedBody.request_human_review).toBe(false);
    expect(result.content[0].text).toMatch(/published/i);
    expect(result.content[0].text).toMatch(/searchable/i);
  });

  test("request_human_review: true forwards the flag and reports a draft awaiting review", async () => {
    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({ ok: true, slug: "gotchas" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const result = await handleToolCall(
      "propose_knowledge",
      { slug: "gotchas", title: "Gotchas", body: "watch out", request_human_review: true },
      "http://collector.test"
    );

    expect(capturedBody.request_human_review).toBe(true);
    expect(result.content[0].text).toMatch(/draft/i);
    expect(result.content[0].text).toMatch(/human review/i);
  });

  /** Answers every collector call with `payload`. */
  function collectorAnswers(payload: unknown) {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
  }

  test("a duplicate refusal says nothing was written and names the doc and the update call", async () => {
    const message =
      'This duplicates standup/retry-policy. Update that doc instead: call propose_knowledge with slug "retry-policy".';
    collectorAnswers({
      ok: false,
      published: false,
      refused: "duplicate",
      duplicateOf: { project: "standup", slug: "retry-policy", id: "abc", title: "Retry policy" },
      message,
      nearest: [{ project: "standup", slug: "retry-policy", title: "Retry policy", similarity: 1, duplicate: true }],
    });
    const result = await handleToolCall(
      "propose_knowledge",
      { slug: "retry-copy", title: "Retry policy", body: "copy" },
      "http://collector.test"
    );
    expect(result.content[0].text).toBe(
      `REFUSED — nothing was written (no doc, no draft). ${message} Existing doc: "Retry policy".`
    );
  });

  test("a published doc carries the update-instead hint and any warnings", async () => {
    collectorAnswers({
      ok: true,
      slug: "mirror-parking",
      published: true,
      mode: "accept",
      hint: 'Close to standup/retry-policy — consider updating it instead: propose_knowledge with slug "retry-policy".',
      warnings: ["the body carries a status marker (\"PR #4521\")"],
    });
    const result = await handleToolCall(
      "propose_knowledge",
      { slug: "mirror-parking", title: "Mirror parking", body: "b" },
      "http://collector.test"
    );
    expect(result.content[0].text).toContain("published");
    expect(result.content[0].text).toContain("Close to standup/retry-policy — consider updating it instead");
    expect(result.content[0].text).toContain('Warnings: the body carries a status marker ("PR #4521")');
  });

  test("a proposal past the daily cap is reported as a review draft with the cap note", async () => {
    collectorAnswers({ ok: true, slug: "note-9", published: false, capped: true, hint: "the daily cap note" });
    const result = await handleToolCall("propose_knowledge", { slug: "note-9", title: "N", body: "b" }, "http://collector.test");
    expect(result.content[0].text).toBe('Draft "note-9" saved for human review. the daily cap note');
  });
});
