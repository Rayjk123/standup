import { expect, test, describe, afterEach } from "bun:test";
import { tools, handleToolCall } from "./tools.js";

/**
 * The report_ticket_status MCP tool lets any Claude Code agent, anywhere, report
 * or advance a review ticket by id through the collector — the decoupled,
 * launch-free path (wave 2). This verifies the tool is registered and that a
 * call POSTs the ticket id, status, and optional note/reviewUrl to the
 * collector's /api/tickets/:id/status endpoint.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("report_ticket_status MCP tool", () => {
  test("is registered with a ticketId + status contract", () => {
    const tool = tools.find((t) => t.name === "report_ticket_status");
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.required).toEqual(["ticketId", "status"]);
    const props = tool!.inputSchema.properties as Record<string, unknown>;
    expect(props.ticketId).toBeDefined();
    expect(props.status).toBeDefined();
    expect(props.note).toBeDefined();
    expect(props.reviewUrl).toBeDefined();
  });

  test("posts the status to /api/tickets/:id/status", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        JSON.stringify({ ticket: { id: "tkt-1", status: "needs_review" } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    const result = await handleToolCall(
      "report_ticket_status",
      {
        ticketId: "tkt-1",
        status: "needs_review",
        note: "PR is up",
        reviewUrl: "https://example.com/pr/9",
      },
      "http://collector.test"
    );

    expect(capturedUrl).toBe("http://collector.test/api/tickets/tkt-1/status");
    expect(capturedBody.status).toBe("needs_review");
    expect(capturedBody.note).toBe("PR is up");
    expect(capturedBody.reviewUrl).toBe("https://example.com/pr/9");
    // The reply names the ticket and its new status.
    expect(result.content[0].text).toContain("needs_review");
  });

  test("url-encodes the ticket id in the path", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ ticket: { id: "a/b", status: "approved" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await handleToolCall(
      "report_ticket_status",
      { ticketId: "a/b", status: "approved" },
      "http://collector.test"
    );
    expect(capturedUrl).toBe("http://collector.test/api/tickets/a%2Fb/status");
  });
});
