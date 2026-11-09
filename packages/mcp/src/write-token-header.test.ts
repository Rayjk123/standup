import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureLocalWriteToken } from "@standup/shared/write-token";
import { handleToolCall, writeTokenHeaderValue } from "./tools.js";

/**
 * The MCP server forwards x-standup-write-token on collector writes: the
 * STANDUP_WRITE_TOKEN env var when set, else the per-user token file the
 * collector persists, so a same-user local agent needs no env configuration.
 */
describe("x-standup-write-token forwarding", () => {
  const realFetch = globalThis.fetch;
  let dir: string;
  let saved: { token?: string; file?: string };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "standup-mcp-wt-"));
    saved = {
      token: process.env.STANDUP_WRITE_TOKEN,
      file: process.env.STANDUP_WRITE_TOKEN_FILE,
    };
    delete process.env.STANDUP_WRITE_TOKEN;
    process.env.STANDUP_WRITE_TOKEN_FILE = join(dir, "write-token");
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of [
      ["STANDUP_WRITE_TOKEN", saved.token],
      ["STANDUP_WRITE_TOKEN_FILE", saved.file],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("sends the file token when STANDUP_WRITE_TOKEN is unset", async () => {
    const token = ensureLocalWriteToken(process.env.STANDUP_WRITE_TOKEN_FILE!);
    let sent = null as string | null;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      sent = new Headers(init?.headers).get("x-standup-write-token");
      return new Response(JSON.stringify({ status: "declined", launched: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await handleToolCall(
      "propose_standup_improvement",
      { title: "t", description: "d", kind: "bug" },
      "http://localhost:7777"
    );
    expect(sent).toBe(token);
  });

  test("never sends the file token to a non-loopback collector", () => {
    ensureLocalWriteToken(process.env.STANDUP_WRITE_TOKEN_FILE!);
    expect(writeTokenHeaderValue("https://teammate.example.com")).toBeUndefined();
    expect(writeTokenHeaderValue("http://127.0.0.1:7777")).toBeDefined();
  });

  test("prefers STANDUP_WRITE_TOKEN over the file", () => {
    ensureLocalWriteToken(process.env.STANDUP_WRITE_TOKEN_FILE!);
    process.env.STANDUP_WRITE_TOKEN = "from-env";
    expect(writeTokenHeaderValue("http://localhost:7777")).toBe("from-env");
  });

  test("sends nothing when neither is available", () => {
    expect(writeTokenHeaderValue("http://localhost:7777")).toBeUndefined();
  });
});
