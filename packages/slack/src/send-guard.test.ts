import { describe, expect, test } from "bun:test";
import { guardedWeb, isBlankMessage, isBlankAppend } from "./send-guard.js";
import type { WebClient } from "@slack/web-api";

describe("blank detection", () => {
  test("isBlankMessage: empty when no visible payload", () => {
    expect(isBlankMessage({})).toBe(true);
    expect(isBlankMessage({ text: "" })).toBe(true);
    expect(isBlankMessage({ text: "   \n\t" })).toBe(true);
    expect(isBlankMessage({ text: "  ", blocks: [] })).toBe(true);
    expect(isBlankMessage({ text: "", attachments: [] })).toBe(true);
  });

  test("isBlankMessage: not empty with text, blocks, or attachments", () => {
    expect(isBlankMessage({ text: "hi" })).toBe(false);
    expect(isBlankMessage({ blocks: [{ type: "section" }] })).toBe(false);
    expect(isBlankMessage({ attachments: [{ text: "a" }] })).toBe(false);
  });

  test("isBlankAppend: empty for no/blank markdown_text chunks", () => {
    expect(isBlankAppend({})).toBe(true);
    expect(isBlankAppend({ chunks: [] })).toBe(true);
    expect(isBlankAppend({ chunks: [{ type: "markdown_text", text: "  " }] })).toBe(true);
  });

  test("isBlankAppend: not empty for content or a card", () => {
    expect(isBlankAppend({ chunks: [{ type: "markdown_text", text: "hi" }] })).toBe(false);
    expect(isBlankAppend({ chunks: [{ type: "task_update", id: "c", status: "in_progress" }] })).toBe(false);
  });
});

describe("guardedWeb", () => {
  function fakeWeb() {
    const calls: Array<{ via: string; method?: string; args: unknown }> = [];
    const web = {
      chat: {
        postMessage: (args: unknown) => {
          calls.push({ via: "chat.postMessage", args });
          return Promise.resolve({ ok: true, ts: "1" });
        },
        update: (args: unknown) => {
          calls.push({ via: "chat.update", args });
          return Promise.resolve({ ok: true });
        },
        postEphemeral: (args: unknown) => {
          calls.push({ via: "chat.postEphemeral", args });
          return Promise.resolve({ ok: true, message_ts: "1" });
        },
      },
      apiCall: (method: string, args: unknown) => {
        calls.push({ via: "apiCall", method, args });
        return Promise.resolve({ ok: true, ts: "1" });
      },
      auth: { test: () => Promise.resolve({ ok: true, user_id: "U1" }) },
    } as unknown as WebClient;
    return { web, calls };
  }

  test("drops a blank chat.postMessage but returns ok", async () => {
    const { web, calls } = fakeWeb();
    const g = guardedWeb(web);
    const res = (await g.chat.postMessage({ channel: "C", text: "  " } as never)) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("passes a real chat.postMessage through", async () => {
    const { web, calls } = fakeWeb();
    const g = guardedWeb(web);
    await g.chat.postMessage({ channel: "C", text: "hello" } as never);
    expect(calls).toEqual([{ via: "chat.postMessage", args: { channel: "C", text: "hello" } }]);
  });

  test("drops a blank chat.postEphemeral but returns ok (the activity snapshot's channel surface)", async () => {
    const { web, calls } = fakeWeb();
    const g = guardedWeb(web);
    const res = (await g.chat.postEphemeral({ channel: "C", user: "U", text: "  " } as never)) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("passes a real chat.postEphemeral through", async () => {
    const { web, calls } = fakeWeb();
    const g = guardedWeb(web);
    await g.chat.postEphemeral({ channel: "C", user: "U", text: "active now" } as never);
    expect(calls).toEqual([{ via: "chat.postEphemeral", args: { channel: "C", user: "U", text: "active now" } }]);
  });

  test("drops a blank apiCall chat.postMessage / chat.update / chat.postEphemeral / appendStream", async () => {
    const { web, calls } = fakeWeb();
    const g = guardedWeb(web);
    await g.apiCall("chat.postMessage", { channel: "C", text: "" });
    await g.apiCall("chat.update", { channel: "C", ts: "1", blocks: [] });
    await g.apiCall("chat.postEphemeral", { channel: "C", user: "U", text: "  " });
    await g.apiCall("chat.appendStream", { channel: "C", ts: "1", chunks: [{ type: "markdown_text", text: " " }] });
    expect(calls).toHaveLength(0);
  });

  test("passes non-message apiCalls (startStream) through untouched", async () => {
    const { web, calls } = fakeWeb();
    const g = guardedWeb(web);
    await g.apiCall("chat.startStream", { channel: "C", thread_ts: "1", chunks: [{ type: "plan_update" }] });
    await g.auth.test();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("chat.startStream");
  });
});
