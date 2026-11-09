/**
 * The standup MCP server's `instructions`, returned in the initialize result.
 * A client shows them to the model even while the server's tools are deferred
 * behind a tool search, so they name the full `mcp__standup__*` tool ids the
 * model would otherwise have to discover first. Kept to a few short lines:
 * the knowledge-first step, how to open a hit, when to write back, and the
 * `project` argument for sessions outside a repo Standup knows.
 */
export const STANDUP_SERVER_INSTRUCTIONS = [
  "Before any non-trivial task, call mcp__standup__search_knowledge first with a natural-language question about what you are about to build or change.",
  "Open a promising hit with mcp__standup__get_knowledge_doc (its slug and project).",
  "When you learn something durable and non-obvious, contribute it with mcp__standup__propose_knowledge.",
  "Outside a repo Standup knows, pass `project` explicitly.",
].join("\n");
