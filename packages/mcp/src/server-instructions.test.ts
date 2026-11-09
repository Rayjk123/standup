import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { STANDUP_SERVER_INSTRUCTIONS } from "./instructions.js";
import { tools } from "./tools.js";

/** The parent env minus any Persona token, plus the given overrides. */
function childEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "STANDUP_PERSONA_TOKEN") env[key] = value;
  }
  // Nothing in these tests calls a tool, so the collector URL is never dialled.
  env.COLLECTOR_URL = "http://127.0.0.1:9";
  return { ...env, ...overrides };
}

async function initializeInstructions(env: Record<string, string>): Promise<string | undefined> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["run", join(import.meta.dir, "index.ts")],
    env,
    stderr: "ignore",
  });
  const client = new Client({ name: "server-instructions-test", version: "0.0.0" });
  try {
    await client.connect(transport);
    return client.getInstructions();
  } finally {
    await client.close();
  }
}

describe("standup MCP server instructions", () => {
  test("are short and lead with search_knowledge, then get_knowledge_doc, propose_knowledge and project", () => {
    const lines = STANDUP_SERVER_INSTRUCTIONS.split("\n");
    expect(lines.length).toBeLessThanOrEqual(4);
    expect(lines[0]).toContain("mcp__standup__search_knowledge");
    expect(lines[0]).toContain("natural-language question");
    expect(STANDUP_SERVER_INSTRUCTIONS).toContain("mcp__standup__get_knowledge_doc");
    expect(STANDUP_SERVER_INSTRUCTIONS).toContain("mcp__standup__propose_knowledge");
    expect(STANDUP_SERVER_INSTRUCTIONS).toContain("pass `project`");
    expect(STANDUP_SERVER_INSTRUCTIONS).not.toContain("ask_expert");
  });

  test("name only tools the server registers", () => {
    const registered = new Set(tools.map((t) => t.name));
    const named = [...STANDUP_SERVER_INSTRUCTIONS.matchAll(/mcp__standup__(\w+)/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    for (const name of named) expect(registered.has(name)).toBe(true);
  });

  test("the initialize result carries them over stdio", async () => {
    expect(await initializeInstructions(childEnv())).toBe(STANDUP_SERVER_INSTRUCTIONS);
  }, 20000);

  test("the Persona proxy server carries none", async () => {
    expect(
      await initializeInstructions(childEnv({ STANDUP_PERSONA_TOKEN: "persona-test-token" }))
    ).toBeUndefined();
  }, 20000);
});
