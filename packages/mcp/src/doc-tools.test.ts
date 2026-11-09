import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { WORKER_TOKEN_FILE_ENV, WORKER_TOKEN_HEADER } from "@standup/shared";
import { handleToolCall, tools } from "./tools.js";

/**
 * write_doc, read_doc and list_docs: a worker reads and writes its owner's
 * docs through the collector's doc routes, with its launch's worker token
 * from the file WORKER_TOKEN_FILE_ENV names.
 */

const dir = mkdtempSync(join(tmpdir(), "mcp-doc-token-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const tokenFile = join(dir, "launch-1");
writeFileSync(tokenFile, "launch-token-doc\n", { mode: 0o600 });

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

describe("doc MCP tools", () => {
  test("are registered with their required inputs", () => {
    expect(tools.find((t) => t.name === "write_doc")?.inputSchema.required).toEqual(["path", "content", "last_line"]);
    expect(tools.find((t) => t.name === "read_doc")?.inputSchema.required).toEqual(["path"]);
    expect(tools.find((t) => t.name === "list_docs")?.inputSchema.required).toEqual([]);
  });

  test("write_doc POSTs the path, content and revision guard with the worker token", async () => {
    process.env[WORKER_TOKEN_FILE_ENV] = tokenFile;
    const calls = capture(200, { doc: { id: "d1", path: "research/plan.md", revision: 3 } });
    const result = await handleToolCall("write_doc", { path: "research/plan.md", content: "# Plan", if_revision: 2, last_line: "# Plan" }, "http://collector.test");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(new URL(calls[0]!.url).pathname).toBe("/api/docs/write");
    expect(calls[0]!.body).toEqual({ path: "research/plan.md", content: "# Plan", ifRevision: 2 });
    expect(calls[0]!.headers.get(WORKER_TOKEN_HEADER)).toBe("launch-token-doc");
    expect(result.isError).toBeUndefined();
    // The console URL isn't configured in a test run, so the link is relative.
    expect(result.content[0]!.text).toBe('Wrote it to your owner\'s Docs tab: /docs/d1 · id d1 · revision 3 · "research/plan.md"');
  });

  test("write_doc sends its images to the collector, which stores them, and names each stored src", async () => {
    process.env[WORKER_TOKEN_FILE_ENV] = tokenFile;
    const images = [{ file: "/tmp/run/screens/home.png", src: "screens/home.png" }, { file: "/tmp/run/b.png" }];
    const calls = capture(200, {
      doc: { id: "d1", path: "r/plan.md", revision: 1 },
      images: [
        { path: "r/screens/home.png", src: "screens/home.png" },
        { path: "r/b.png", src: "b.png" },
      ],
    });
    const content = "![Home](screens/home.png)\n![B](b.png)";
    const result = await handleToolCall("write_doc", { path: "r/plan.md", content, images, last_line: "![B](b.png)" }, "http://collector.test");
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).pathname).toBe("/api/docs/write");
    expect(calls[0]!.body).toEqual({ path: "r/plan.md", content, images });
    expect(calls[0]!.headers.get(WORKER_TOKEN_HEADER)).toBe("launch-token-doc");
    expect(result.content[0]!.text).toBe(
      'Wrote it to your owner\'s Docs tab: /docs/d1 · id d1 · revision 1 · "r/plan.md" with 2 images beside it (embedded as ![…](screens/home.png), ![…](b.png))'
    );
    const schema = tools.find((t) => t.name === "write_doc")!.inputSchema.properties as Record<string, { type: string }>;
    expect(schema.images!.type).toBe("array");
  });

  test("a refused image is a tool error carrying the collector's reason", async () => {
    capture(400, { error: "image 1 of 1 (a.png): /tmp/a.png is not a PNG, JPEG, GIF or WebP image (checked by content). The doc was not written." });
    const result = await handleToolCall("write_doc", { path: "a.md", content: "x", images: [{ file: "/tmp/a.png" }], last_line: "x" }, "http://collector.test");
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe(
      "Doc not written: image 1 of 1 (a.png): /tmp/a.png is not a PNG, JPEG, GIF or WebP image (checked by content). The doc was not written."
    );
  });

  test("a refused write is a tool error carrying the collector's reason", async () => {
    capture(409, { error: "the doc is at revision 4, not 2: read it again and reapply your change" });
    const result = await handleToolCall("write_doc", { path: "a.md", content: "x", if_revision: 2, last_line: "x" }, "http://collector.test");
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("revision 4");
  });

  test("a body cut off in transit — last_line missing or not its end — is refused before any request", async () => {
    const calls = capture(200, { doc: { id: "d1", path: "a.md", revision: 9 } });
    const full = Array.from({ length: 889 }, (_, i) => `line ${i + 1} of the report`).join("\n");
    const truncated = full.slice(0, full.indexOf("line 301") + 6);
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ content: truncated, last_line: "line 889 of the report" }, "does not end with last_line"],
      [{ content: truncated }, "last_line is required"],
      [{ content: 42, last_line: "42" }, "content must be a string"],
      // last_line sent first is refused, since a cut after it would leave it matching an earlier copy of the last line.
      [{ last_line: "line 889 of the report", content: full }, "last_line must be the last argument"],
    ];
    for (const [args, why] of cases) {
      const result = await handleToolCall("write_doc", { path: "a.md", if_revision: 8, ...args }, "http://collector.test");
      expect([why, result.isError]).toEqual([why, true]);
      expect(result.content[0]!.text).toContain(why);
    }
    expect(calls).toHaveLength(0);
    const whole = await handleToolCall("write_doc", { path: "a.md", content: full, if_revision: 8, last_line: "line 889 of the report" }, "http://collector.test");
    expect(whole.isError).toBeUndefined();
    expect(calls.map((c) => c.body?.content)).toEqual([full]);
  });

  test("read_doc and write_doc without a path are refused before any request", async () => {
    const calls = capture(200, {});
    for (const args of [{}, { path: "" }, { path: "  " }, { path: 3 }]) {
      const read = await handleToolCall("read_doc", args, "http://collector.test");
      expect(read.isError).toBe(true);
      expect(read.content[0]!.text).toContain("path is required");
      const write = await handleToolCall("write_doc", { ...args, content: "x" }, "http://collector.test");
      expect(write.isError).toBe(true);
      expect(write.content[0]!.text).toContain("path is required");
    }
    expect(calls).toHaveLength(0);
  });

  test("read_doc GETs by path and returns the body with its revision", async () => {
    process.env[WORKER_TOKEN_FILE_ENV] = tokenFile;
    const calls = capture(200, { doc: { id: "d1", path: "a b/c.md", revision: 2, body: "hello" } });
    const result = await handleToolCall("read_doc", { path: "a b/c.md" }, "http://collector.test");
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/api/docs/read");
    expect(url.searchParams.get("path")).toBe("a b/c.md");
    expect(calls[0]!.headers.get(WORKER_TOKEN_HEADER)).toBe("launch-token-doc");
    expect(result.content[0]!.text).toBe('/docs/d1 · id d1 · revision 2 · "a b/c.md"\n```\nhello\n```');
  });

  test("read_doc fences a body around its own fences, and quotes a path that carries link syntax", async () => {
    capture(200, {
      doc: { id: "d2", path: "Open [here](mailto:a@evil.test) x.md", revision: 1, body: "a\n```\nb\n`````\nc" },
    });
    const result = await handleToolCall("read_doc", { path: "x" }, "http://collector.test");
    expect(result.content[0]!.text).toBe(
      '/docs/d2 · id d2 · revision 1 · "Open [here](mailto:a@evil.test) x.md"\n``````\na\n```\nb\n`````\nc\n``````'
    );
  });

  test("list_docs lists below a folder, or the whole tree", async () => {
    const calls = capture(200, { folder: "a", folders: ["a/b"], docs: [{ id: "d1", path: "a/b/c.md", revision: 1 }] });
    const below = await handleToolCall("list_docs", { folder: "a" }, "http://collector.test");
    expect(new URL(calls[0]!.url).searchParams.get("folder")).toBe("a");
    expect(below.content[0]!.text).toBe('"a/b/"\n/docs/d1 · revision 1 · "a/b/c.md"');
    const empty = capture(200, { folder: "", folders: [], docs: [] });
    const all = await handleToolCall("list_docs", {}, "http://collector.test");
    expect(new URL(empty[0]!.url).search).toBe("");
    expect(all.content[0]!.text).toBe("No docs yet.");
  });
});
