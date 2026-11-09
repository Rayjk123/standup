import { expect, test, describe, afterEach } from "bun:test";
import { handleToolCall, submitPlanWaitS } from "./tools.js";

/**
 * On a plan-approval timeout, submit_plan must NOT green-light autonomous work:
 * the gate's whole purpose is to steer BEFORE the agent implements. The reply
 * must keep the agent paused (do not implement; resubmit to keep waiting)
 * rather than telling it to "proceed with your best judgment".
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("submit_plan timeout reply", () => {
  test("does not authorize proceeding without approval", async () => {
    globalThis.fetch = (async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ status: "timeout" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;

    const result = await handleToolCall(
      "submit_plan",
      { plan: "Refactor the widget" },
      "http://collector.test"
    );
    const text = result.content[0].text;

    // The old wording green-lit unapproved work — it must be gone.
    expect(text).not.toContain("proceed with your best judgment");
    // The reply keeps the run paused and points at the way to keep waiting.
    expect(text.toLowerCase()).toContain("do not start implementing");
    expect(text).toContain("submit_plan again");
  });
});

describe("submit_plan review notes", () => {
  const replyWith = (body: Record<string, unknown>) => {
    globalThis.fetch = (async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
  };

  test("a rejection carries the reviewer's feedback to the agent", async () => {
    replyWith({ status: "rejected", feedback: "Split the migration into its own step." });
    const result = await handleToolCall("submit_plan", { plan: "Refactor the widget" }, "http://collector.test");
    const text = result.content[0].text;
    expect(text).toContain("REJECTED");
    expect(text).toContain("Split the migration into its own step.");
  });

  test("an approval carries the reviewer's note", async () => {
    replyWith({ status: "approved", plan: "Refactor the widget", note: "Keep the old API exported." });
    const result = await handleToolCall("submit_plan", { plan: "Refactor the widget" }, "http://collector.test");
    expect(result.content[0].text).toContain("Keep the old API exported.");
  });
});

describe("ask_human timeout reply", () => {
  test("keeps the agent off outward-facing and irreversible steps", async () => {
    globalThis.fetch = (async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ answer: "", timed_out: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;

    const result = await handleToolCall("ask_human", { question: "OK to git push origin HEAD?" }, "http://collector.test");
    const text = result.content[0].text;

    expect(text.toLowerCase()).not.toContain("best judgment");
    expect(text).toContain("safe, reversible");
    expect(text).toContain("outward-facing");
    expect(text).toContain("ask_human again");
    expect(text).toMatch(/not an answer or an approval/);
  });
});

describe("submit_plan wait", () => {
  test("asks the collector to answer before the MCP client's tool timeout", async () => {
    let sent: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ status: "timeout" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    await handleToolCall("submit_plan", { plan: "Refactor the widget" }, "http://collector.test");
    expect(sent.timeout_s).toBe(25 * 60);
    expect(submitPlanWaitS({ STANDUP_SUBMIT_PLAN_WAIT_S: "600" })).toBe(600);
    expect(submitPlanWaitS({ STANDUP_SUBMIT_PLAN_WAIT_S: "nope" })).toBe(25 * 60);
  });
});
