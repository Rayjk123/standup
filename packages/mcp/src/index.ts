#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { tools, handleToolCall } from "./tools.js";

const COLLECTOR_URL = process.env.COLLECTOR_URL ?? "http://localhost:7777";

const server = new Server(
  {
    name: "standup",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  return handleToolCall(name, args ?? {}, COLLECTOR_URL);
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp] Standup MCP server started");
}

main().catch((err) => {
  console.error("[mcp] Fatal error:", err);
  process.exit(1);
});
