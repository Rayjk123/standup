import { expect, test, afterEach } from "bun:test";
import { handleToolCall } from "./tools.js";

/**
 * ask_human long-polls the collector for up to its own timeout. Bun's fetch
 * aborts after 360s unless told otherwise, which cut every ask a human took
 * longer than six minutes to answer; the request must opt out of that limit.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("ask_human's long-poll disables the client-side fetch timeout", async () => {
  let seen: (RequestInit & { timeout?: boolean }) | undefined;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    seen = init as RequestInit & { timeout?: boolean };
    return new Response(JSON.stringify({ answer: "yes" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  await handleToolCall("ask_human", { question: "Ship it?" }, "http://collector.test");

  expect(seen?.method).toBe("POST");
  expect(seen?.timeout).toBe(false);
});
