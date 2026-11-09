import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { PERSONA_TOKEN_HEADER, createPersonaProxy, personaToken } from "./persona-proxy.js";

const TOKEN = "persona-test-token";

const CATALOG: Tool[] = [
  {
    name: "list_projects",
    description: "List registered projects",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "launch_session",
    description: "Launch a worker",
    inputSchema: {
      type: "object",
      properties: { brief: { type: "string" } },
      required: ["brief"],
    },
  },
];

interface Received {
  method: string;
  path: string;
  token: string | null;
  contentType: string | null;
  body: unknown;
}

/**
 * Stub collector serving the persona routes. `mode` switches the response so
 * one server covers the success and failure shapes.
 */
let mode: "ok" | "401" | "500" | "malformed" | "bad-shape" = "ok";
const received: Received[] = [];
let stub: ReturnType<typeof Bun.serve>;
let baseUrl: string;

beforeAll(() => {
  stub = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const raw = req.method === "POST" ? await req.text() : "";
      received.push({
        method: req.method,
        path: url.pathname,
        token: req.headers.get(PERSONA_TOKEN_HEADER),
        contentType: req.headers.get("content-type"),
        body: raw ? JSON.parse(raw) : null,
      });
      if (mode === "401") return Response.json({ error: "invalid persona token" }, { status: 401 });
      if (mode === "500") return new Response("boom", { status: 500, statusText: "Internal Server Error" });
      if (mode === "malformed") return new Response("{not json", { status: 200 });
      if (mode === "bad-shape") return Response.json({ nope: true });
      if (req.headers.get(PERSONA_TOKEN_HEADER) !== TOKEN) {
        return Response.json({ error: "invalid persona token" }, { status: 401 });
      }
      if (req.method === "GET" && url.pathname === "/api/persona/tools") {
        return Response.json({ tools: CATALOG });
      }
      if (req.method === "POST" && url.pathname === "/api/persona/tool") {
        const { name, arguments: args } = JSON.parse(raw) as { name: string; arguments: unknown };
        const result: CallToolResult = {
          content: [{ type: "text", text: `ran ${name} with ${JSON.stringify(args)}` }],
        };
        return Response.json(result);
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  baseUrl = `http://127.0.0.1:${stub.port}`;
});

afterAll(() => {
  stub.stop(true);
});

function proxy() {
  return createPersonaProxy({ collectorUrl: `${baseUrl}/`, token: TOKEN });
}

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

describe("personaToken", () => {
  test("is undefined when unset or blank, trimmed otherwise", () => {
    expect(personaToken({})).toBeUndefined();
    expect(personaToken({ STANDUP_PERSONA_TOKEN: "   " })).toBeUndefined();
    expect(personaToken({ STANDUP_PERSONA_TOKEN: " abc \n" })).toBe("abc");
  });
});

describe("persona proxy", () => {
  test("tools/list passes the collector catalog through verbatim", async () => {
    mode = "ok";
    received.length = 0;
    expect(await proxy().listTools()).toEqual(CATALOG);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ method: "GET", path: "/api/persona/tools", token: TOKEN });
  });

  test("tools/call posts {name, arguments} with the token and returns the result", async () => {
    mode = "ok";
    received.length = 0;
    const result = await proxy().callTool("launch_session", { brief: "fix it" });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toBe('ran launch_session with {"brief":"fix it"}');
    expect(received[0]).toMatchObject({
      method: "POST",
      path: "/api/persona/tool",
      token: TOKEN,
      body: { name: "launch_session", arguments: { brief: "fix it" } },
    });
    expect(received[0]!.contentType).toContain("application/json");
  });

  test("401 becomes an isError result carrying the collector's error", async () => {
    mode = "401";
    const result = await proxy().callTool("list_projects", {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "error: persona collector POST /tool failed (401): invalid persona token"
    );
  });

  test("500 with a non-JSON body becomes an isError result", async () => {
    mode = "500";
    const result = await proxy().callTool("list_projects", {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "error: persona collector POST /tool failed (500): Internal Server Error"
    );
  });

  test("malformed JSON becomes an isError result", async () => {
    mode = "malformed";
    const result = await proxy().callTool("list_projects", {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("error: persona collector POST /tool returned malformed JSON");
  });

  test("a body that is not a tool result becomes an isError result", async () => {
    mode = "bad-shape";
    const result = await proxy().callTool("list_projects", {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("malformed tool result");
  });

  test("a network error becomes a one-line isError result", async () => {
    const failing = (async () => {
      throw new Error("connect ECONNREFUSED\n127.0.0.1:1");
    }) as unknown as typeof fetch;
    const result = await createPersonaProxy({
      collectorUrl: "http://127.0.0.1:1",
      token: TOKEN,
      fetch: failing,
    }).callTool("list_projects", {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "error: persona collector POST /tool unreachable: connect ECONNREFUSED 127.0.0.1:1"
    );
  });

  test("tools/list failures throw so the client sees a list error", async () => {
    mode = "401";
    await expect(proxy().listTools()).rejects.toThrow("failed (401): invalid persona token");
    mode = "malformed";
    await expect(proxy().listTools()).rejects.toThrow("malformed JSON");
    mode = "bad-shape";
    await expect(proxy().listTools()).rejects.toThrow("no tools array");
  });
});

describe("persona proxy over stdio", () => {
  test("index.ts serves the persona catalog and proxies calls", async () => {
    mode = "ok";
    received.length = 0;
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    env.STANDUP_PERSONA_TOKEN = TOKEN;
    env.COLLECTOR_URL = baseUrl;

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["run", join(import.meta.dir, "index.ts")],
      env,
      stderr: "ignore",
    });
    const client = new Client({ name: "persona-proxy-test", version: "0.0.0" });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name)).toEqual(["list_projects", "launch_session"]);

      const result = (await client.callTool({
        name: "launch_session",
        arguments: { brief: "over stdio" },
      })) as CallToolResult;
      expect(textOf(result)).toBe('ran launch_session with {"brief":"over stdio"}');

      expect(received.map((r) => `${r.method} ${r.path}`)).toEqual([
        "GET /api/persona/tools",
        "POST /api/persona/tool",
      ]);
      expect(received.every((r) => r.token === TOKEN)).toBe(true);
    } finally {
      await client.close();
    }
  }, 20000);
});
