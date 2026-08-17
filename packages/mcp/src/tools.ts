import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ASK_HUMAN_DEFAULT_TIMEOUT_S } from "@standup/shared";
import { resolveSessionId } from "./session-id.js";

// The MCP subprocess inherits its cwd from the Claude Code session that
// spawned it. Combined with resolveSessionId (which reads the transcript
// filename Claude Code writes under ~/.claude/projects/), this gets us the
// real session id — cwd alone is sent too, as a fallback the collector uses
// only if session_id resolution fails.
const SESSION_CWD = process.cwd();

async function correlationFields(): Promise<{ session_id: string | null; cwd: string }> {
  return { session_id: await resolveSessionId(SESSION_CWD), cwd: SESSION_CWD };
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    let detail = response.statusText;
    try {
      const errBody = (await response.json()) as { error?: string };
      if (errBody.error) detail = errBody.error;
    } catch {
      // Body wasn't JSON — fall back to statusText.
    }
    throw new Error(`standup collector request failed (${response.status}): ${detail}`);
  }

  return response.json() as Promise<T>;
}

export const tools: Tool[] = [
  {
    name: "checkpoint",
    description:
      "Report a milestone or progress checkpoint. Call this when you've completed a discrete unit of work. " +
      "The summary will appear in the session manager feed, helping the human track progress across multiple agents.",
    inputSchema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description:
            "A brief summary of what was just completed (1-2 sentences). " +
            "Write it as a status update: 'Added retry logic with exponential backoff' not 'I added...'",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "ask_human",
    description:
      "Ask the human a question and wait for their response. Use this when you need clarification, " +
      "a decision, or approval before proceeding. The question will be shown in the session manager " +
      "and the human can respond from there. This call blocks until answered or timeout.",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question to ask the human. Be specific and provide context.",
        },
        options: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional list of predefined answer options. If provided, the human can select one " +
            "or type a custom response.",
        },
        timeout_s: {
          type: "integer",
          description: `Timeout in seconds. Default: ${ASK_HUMAN_DEFAULT_TIMEOUT_S} (1 hour). ` +
            "If no response within timeout, returns a 'proceed with best judgment' message.",
        },
      },
      required: ["question"],
    },
  },
  {
    name: "ask_expert",
    description:
      "Query the project's knowledge base for relevant information. Use this when you're stuck " +
      "or need context about how something works in this codebase. Returns an answer with sources.",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description:
            "The question to ask. Be specific: 'How does the retry policy handle rate limits?' " +
            "rather than 'How does retry work?'",
        },
      },
      required: ["question"],
    },
  },
  {
    name: "search_knowledge",
    description:
      "Search this project's human-authored knowledge base — business intent, cross-project " +
      "connections, coding practices, and other institutional context that can't be derived from " +
      "the code itself. Use this before ask_expert when your question is about intent, conventions, " +
      "or context rather than code structure. Combines text and semantic search.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "What you want to know, e.g. 'what is the business goal of this project' or " +
            "'coding conventions for error handling'.",
        },
        project: {
          type: "string",
          description:
            "Project id to search. Defaults to the current session's project if omitted.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "ripgrep",
    description:
      "Search the codebase with ripgrep (rg). Use this for exact pattern matching — finding " +
      "symbol definitions, usages, or literal strings — where semantic search would be overkill. " +
      "Runs in the current session's working directory.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Regex or literal pattern to search for.",
        },
        path: {
          type: "string",
          description: "Path to search within, relative to the session cwd. Defaults to cwd root.",
        },
        flags: {
          type: "array",
          items: { type: "string" },
          description:
            "Additional rg flags, e.g. ['-i', '--type', 'ts']. Do not pass flags that change output " +
            "format (-json, -l alone) — results are parsed as standard match lines.",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "propose_knowledge",
    description:
      "Write a DRAFT knowledge doc for a human to review — this does NOT publish anything. " +
      "The draft is saved separately from the project's real knowledge base and is invisible to " +
      "search_knowledge and ask_expert until a human explicitly accepts it. Only usable inside a " +
      "knowledge-bootstrap run; calling it from an ordinary session will fail.",
    inputSchema: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          description:
            "Filename-safe id for the doc: letters, numbers and hyphens only, e.g. 'architecture'.",
        },
        title: {
          type: "string",
          description: "Doc title.",
        },
        body: {
          type: "string",
          description: "Doc body, in markdown.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tags.",
        },
      },
      required: ["slug", "title", "body"],
    },
  },
];

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  collectorUrl: string
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  try {
    return await dispatch(name, args, collectorUrl);
  } catch (err) {
    // A collector-side failure (not running, bad session correlation, etc.)
    // should read as a tool error to the agent, not crash the MCP process.
    return {
      content: [{ type: "text", text: `standup tool "${name}" failed: ${(err as Error).message}` }],
    };
  }
}

async function dispatch(
  name: string,
  args: Record<string, unknown>,
  collectorUrl: string
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  switch (name) {
    case "checkpoint": {
      const summary = args.summary as string;
      const result = await postJson<{ ok: boolean; steers?: string }>(
        `${collectorUrl}/api/checkpoint`,
        { ...(await correlationFields()), summary }
      );

      // The human may have queued steering messages while this agent was
      // mid-task; a checkpoint is a turn boundary, so they ride back on the
      // tool response rather than interrupting the run.
      if (result.steers) {
        return {
          content: [{ type: "text", text: `Checkpoint recorded.\n\n${result.steers}` }],
        };
      }

      return {
        content: [{ type: "text", text: "Checkpoint recorded." }],
      };
    }

    case "ask_human": {
      const question = args.question as string;
      const options = args.options as string[] | undefined;
      const timeout_s = (args.timeout_s as number) ?? ASK_HUMAN_DEFAULT_TIMEOUT_S;

      const result = await postJson<{ answer: string; timed_out?: boolean }>(
        `${collectorUrl}/api/ask`,
        { ...(await correlationFields()), question, options, timeout_s }
      );

      if (result.timed_out) {
        return {
          content: [
            {
              type: "text",
              text: "No response received within timeout. Proceed with your best judgment.",
            },
          ],
        };
      }

      return {
        content: [{ type: "text", text: result.answer }],
      };
    }

    case "ask_expert": {
      const question = args.question as string;

      const result = await postJson<{
        answer: string;
        region: string;
        sources: string[];
      }>(`${collectorUrl}/api/expert`, { ...(await correlationFields()), question });

      const sourcesText =
        result.sources.length > 0
          ? `\n\nSources:\n${result.sources.map((s) => `- ${s}`).join("\n")}`
          : "";
      const regionPrefix = result.region ? `[${result.region}]\n\n` : "";

      return {
        content: [
          {
            type: "text",
            text: `${regionPrefix}${result.answer}${sourcesText}`,
          },
        ],
      };
    }

    case "search_knowledge": {
      const query = args.query as string;
      const project = args.project as string | undefined;

      const result = await postJson<{
        results: Array<{
          slug: string;
          title: string;
          excerpt: string;
          score: number;
          source: "text" | "embedding";
        }>;
        project: string;
      }>(`${collectorUrl}/api/knowledge/search`, { ...(await correlationFields()), query, project });

      if (result.results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No knowledge docs found for "${query}" in ${result.project}.`,
            },
          ],
        };
      }

      const formatted = result.results
        .map(
          (r) =>
            `[${r.slug}] ${r.title} (${r.source}, score ${r.score.toFixed(2)})\n${r.excerpt}`
        )
        .join("\n\n");

      return {
        content: [{ type: "text", text: formatted }],
      };
    }

    case "ripgrep": {
      const pattern = args.pattern as string;
      const path = (args.path as string) ?? ".";
      const flags = (args.flags as string[]) ?? [];

      const result = await postJson<{
        matches: Array<{ file: string; line: number; text: string }>;
        truncated: boolean;
      }>(`${collectorUrl}/api/ripgrep`, { cwd: SESSION_CWD, pattern, path, flags });

      if (result.matches.length === 0) {
        return {
          content: [{ type: "text", text: `No matches for pattern: ${pattern}` }],
        };
      }

      const formatted = result.matches
        .map((m) => `${m.file}:${m.line}: ${m.text}`)
        .join("\n");

      const suffix = result.truncated
        ? "\n\n(results truncated — narrow your pattern or path)"
        : "";

      return {
        content: [{ type: "text", text: formatted + suffix }],
      };
    }

    case "propose_knowledge": {
      const slug = args.slug as string;
      const title = args.title as string;
      const body = args.body as string;
      const tags = args.tags as string[] | undefined;

      const result = await postJson<{ ok: boolean; slug: string }>(
        `${collectorUrl}/api/knowledge/propose`,
        { ...(await correlationFields()), slug, title, body, tags }
      );

      return {
        content: [
          {
            type: "text",
            text: `Draft "${result.slug}" saved for human review. It is not searchable and nobody has read it yet.`,
          },
        ],
      };
    }

    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
      };
  }
}
