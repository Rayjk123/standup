import { describe, expect, test } from "bun:test";
import { appendStream, type SlackApi, type SlackCallResult, type StreamChunk } from "./stream-client.js";

/** Records every (method, args) pair so a test can assert what hit the wire. */
function recordingApi(): { api: SlackApi; calls: Array<{ method: string; args: Record<string, unknown> }> } {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const api: SlackApi = {
    async call(method, args): Promise<SlackCallResult> {
      calls.push({ method, args });
      return { ok: true, ts: "1.1", data: {} };
    },
  };
  return { api, calls };
}

const md = (text: string): StreamChunk => ({ type: "markdown_text", text });
const card = (): StreamChunk => ({ type: "task_update", id: "c1", title: "Read", status: "in_progress" });

describe("appendStream blank-chunk guard", () => {
  test("does not transmit when every chunk is a blank markdown_text", async () => {
    const { api, calls } = recordingApi();
    const ok = await appendStream(api, "C1", "1.1", [md(""), md("   "), md("\n\n")]);
    expect(ok).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("drops blank markdown_text but keeps chunks with content", async () => {
    const { api, calls } = recordingApi();
    const ok = await appendStream(api, "C1", "1.1", [md("  "), md("hello"), card()]);
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.chunks).toEqual([md("hello"), card()]);
  });

  test("no-ops on an empty chunk list", async () => {
    const { api, calls } = recordingApi();
    expect(await appendStream(api, "C1", "1.1", [])).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("passes card-only chunks through untouched", async () => {
    const { api, calls } = recordingApi();
    await appendStream(api, "C1", "1.1", [card()]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.chunks).toEqual([card()]);
  });
});
