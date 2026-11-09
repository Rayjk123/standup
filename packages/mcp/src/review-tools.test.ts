import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { WORKER_TOKEN_FILE_ENV, WORKER_TOKEN_HEADER } from "@standup/shared";
import { handleToolCall, tools, workerTokenHeaders } from "./tools.js";

/**
 * review_brief and submit_review_packet: a worker fetches its review-writer
 * brief and submits its packet through the collector's review routes, with
 * its session correlation (session_id/cwd) like every other worker tool, and
 * its launch's review token read from the file WORKER_TOKEN_FILE_ENV names.
 */

const dir = mkdtempSync(join(tmpdir(), "mcp-review-token-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const tokenFile = join(dir, "launch-1");
writeFileSync(tokenFile, "launch-token-abc\n", { mode: 0o600 });

const realFetch = globalThis.fetch;
const realFile = process.env[WORKER_TOKEN_FILE_ENV];
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realFile === undefined) delete process.env[WORKER_TOKEN_FILE_ENV];
  else process.env[WORKER_TOKEN_FILE_ENV] = realFile;
});

function capture(status: number, body: unknown) {
  const calls: Array<{ url: string; method: string; body: Record<string, unknown> | null; headers: Headers }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null, headers: new Headers(init?.headers) });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

describe("review MCP tools", () => {
  test("are registered", () => {
    expect(tools.find((t) => t.name === "review_brief")?.inputSchema.required).toEqual([]);
    expect(tools.find((t) => t.name === "submit_review_packet")?.inputSchema.required).toEqual(["packet"]);
  });

  test("the review token is read from the file the env names, trimmed; the env carries only the path", () => {
    expect(workerTokenHeaders({ [WORKER_TOKEN_FILE_ENV]: tokenFile })).toEqual({ [WORKER_TOKEN_HEADER]: "launch-token-abc" });
    expect(workerTokenHeaders({ [WORKER_TOKEN_FILE_ENV]: `  ${tokenFile}  ` })).toEqual({ [WORKER_TOKEN_HEADER]: "launch-token-abc" });
    expect(workerTokenHeaders({})).toEqual({});
  });

  test("a missing, relative, symlinked, empty or oversized token file yields no header", () => {
    const empty = join(dir, "empty");
    writeFileSync(empty, "");
    const big = join(dir, "big");
    writeFileSync(big, "x".repeat(1000));
    const link = join(dir, "link");
    symlinkSync(tokenFile, link);
    for (const path of [join(dir, "missing"), "launch-1", empty, big, link, dir]) {
      expect(workerTokenHeaders({ [WORKER_TOKEN_FILE_ENV]: path })).toEqual({});
    }
  });

  test("the file is read at call time, so a token written after start is picked up", () => {
    const later = join(dir, "later");
    const env = { [WORKER_TOKEN_FILE_ENV]: later };
    expect(workerTokenHeaders(env)).toEqual({});
    writeFileSync(later, "tok-later", { mode: 0o600 });
    expect(workerTokenHeaders(env)).toEqual({ [WORKER_TOKEN_HEADER]: "tok-later" });
  });

  test("review_brief GETs the brief with the session's cwd and the launch's review token from its file", async () => {
    process.env[WORKER_TOKEN_FILE_ENV] = tokenFile;
    const calls = capture(200, { packetId: "p1", brief: "## Human review\nDo the thing" });
    const result = await handleToolCall("review_brief", {}, "http://collector.test");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/api/reviews/brief");
    expect(url.searchParams.get("cwd")).toBe(process.cwd());
    expect(calls[0]!.headers.get(WORKER_TOKEN_HEADER)).toBe("launch-token-abc");
    expect(result.content[0]!.text).toBe("## Human review\nDo the thing");
  });

  test("submit_review_packet POSTs the packet and media with the review token and returns the review link", async () => {
    process.env[WORKER_TOKEN_FILE_ENV] = tokenFile;
    const calls = capture(200, { packetId: "p1", status: "pending", revision: 2, url: "/review/p1" });
    const packet = { title: "T" };
    const media = [{ path: "/tmp/a.png", caption: "A" }];
    const result = await handleToolCall("submit_review_packet", { packet, media }, "http://collector.test");
    expect(calls[0]!.url).toBe("http://collector.test/api/reviews/submit");
    expect(calls[0]!.headers.get(WORKER_TOKEN_HEADER)).toBe("launch-token-abc");
    expect(calls[0]!.headers.get("content-type")).toBe("application/json");
    expect(calls[0]!.body).toMatchObject({ packet, media, cwd: process.cwd() });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain("revision 2");
    expect(result.content[0]!.text).toContain("/review/p1");
  });

  test("outside a launch no worker token is sent, and the collector's refusal is the tool's answer", async () => {
    delete process.env[WORKER_TOKEN_FILE_ENV];
    const calls = capture(403, { error: "Review requests come from a Standup-launched worker and must carry its launch's worker token" });
    const result = await handleToolCall("submit_review_packet", { packet: {} }, "http://collector.test");
    expect(calls[0]!.headers.has(WORKER_TOKEN_HEADER)).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("worker token");
  });

  test("a refused submission lists every problem as a tool error", async () => {
    capture(400, { error: "The review packet has problems", problems: ["intent must be a non-empty string", "changed files not covered: a.ts"] });
    const result = await handleToolCall("submit_review_packet", { packet: {} }, "http://collector.test");
    expect(result.isError).toBe(true);
    const text = result.content[0]!.text;
    expect(text).toContain("The review packet has problems");
    expect(text).toContain("- intent must be a non-empty string");
    expect(text).toContain("- changed files not covered: a.ts");
    expect(text).toContain("call submit_review_packet again");
  });
});
