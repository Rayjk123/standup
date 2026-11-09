#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { tools, handleToolCall } from "./tools.js";
import { createPersonaProxy, personaToken } from "./persona-proxy.js";
import { STANDUP_SERVER_INSTRUCTIONS } from "./instructions.js";

const COLLECTOR_URL = process.env.COLLECTOR_URL ?? "http://localhost:7777";

// Under the Persona runtime the catalog and every call are proxied to the
// collector's /api/persona routes; the worker tools are never exposed.
const PERSONA_TOKEN = personaToken();
const personaProxy = PERSONA_TOKEN
  ? createPersonaProxy({ collectorUrl: COLLECTOR_URL, token: PERSONA_TOKEN })
  : null;

const server = new Server(
  {
    name: "standup",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
    // The Persona runtime serves its own catalog, which the worker guidance
    // doesn't describe, so only the worker server carries instructions.
    ...(personaProxy ? {} : { instructions: STANDUP_SERVER_INSTRUCTIONS }),
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (personaProxy) return { tools: await personaProxy.listTools() };
  return { tools };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (personaProxy) return personaProxy.callTool(name, args ?? {});
  return handleToolCall(name, args ?? {}, COLLECTOR_URL);
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    personaProxy
      ? "[mcp] Standup MCP server started (persona proxy mode)"
      : "[mcp] Standup MCP server started"
  );
}

main().catch((err) => {
  console.error("[mcp] Fatal error:", err);
  process.exit(1);
});
