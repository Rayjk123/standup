import type { Server } from "./server.js";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const str = (description: string) => ({ type: "string", description });

/** Every tool the Standup MCP server exposes to agents. */
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "search_knowledge",
    description: "Search the knowledge base (text + semantic) within your retrieval scope.",
    inputSchema: { type: "object", properties: { query: str("What you want to know"), corpus: str("project | all") }, required: ["query"] },
  },
  {
    name: "ask_expert",
    description: "Ask a question; answered from knowledge docs and code passages with sources.",
    inputSchema: { type: "object", properties: { question: str("The question") }, required: ["question"] },
  },
  {
    name: "get_knowledge_doc",
    description: "Fetch the full body of a knowledge doc by id or project/slug.",
    inputSchema: { type: "object", properties: { id: str("Doc id"), slug: str("project/slug") } },
  },
  {
    name: "propose_knowledge",
    description: "Propose a new or updated knowledge doc. Published immediately unless request_human_review is set.",
    inputSchema: { type: "object", properties: { slug: str("Slug"), title: str("Title"), body: str("Markdown body"), scope: str("global | project | user") }, required: ["slug", "title", "body"] },
  },
  {
    name: "graph_neighbors",
    description: "List docs linked to a doc in the knowledge graph.",
    inputSchema: { type: "object", properties: { id: str("Doc id") }, required: ["id"] },
  },
  {
    name: "ripgrep",
    description: "Search the project's source tree with ripgrep.",
    inputSchema: { type: "object", properties: { pattern: str("Regex"), path: str("Subdirectory") }, required: ["pattern"] },
  },
  {
    name: "whats_happening",
    description: "Summarize what other sessions in this project are doing right now.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "checkpoint",
    description: "Record a progress checkpoint for this session.",
    inputSchema: { type: "object", properties: { summary: str("What was done") }, required: ["summary"] },
  },
  {
    name: "heartbeat",
    description: "Tell the collector this session is alive.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "report_task",
    description: "Report the status of the task this session was launched for.",
    inputSchema: { type: "object", properties: { status: str("in_progress | done | blocked"), note: str("Detail") }, required: ["status"] },
  },
  {
    name: "message_session",
    description: "Send a message to another running session.",
    inputSchema: { type: "object", properties: { sessionId: str("Target session"), text: str("Message") }, required: ["sessionId", "text"] },
  },
];

export function registerTools(server: Server): void {
  for (const def of TOOL_DEFINITIONS) {
    server.tool(def, (args) => dispatch(server, def.name, args));
  }
}

async function dispatch(server: Server, name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "search_knowledge":
      return handleSearchKnowledge(server, args);
    default:
      return server.forward(name, args);
  }
}

/** Forwards to the collector's scoped search route; identity comes from the tunnel header, never from args. */
export async function handleSearchKnowledge(server: Server, args: Record<string, unknown>): Promise<unknown> {
  return server.post("/api/knowledge/search", { query: args.query, corpus: args.corpus ?? "all", scoped: true });
}
