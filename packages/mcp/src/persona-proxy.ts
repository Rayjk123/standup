import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * Persona proxy mode: when the MCP server runs under the Persona runtime
 * (STANDUP_PERSONA_TOKEN set), its tool catalog and tool calls are served by
 * the collector's /api/persona routes instead of the worker tools, so Persona
 * sees exactly the catalog the collector defines.
 */

export const PERSONA_TOKEN_HEADER = "x-standup-persona-token";

/** The trimmed persona token, or undefined when the server runs in worker mode. */
export function personaToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const token = env.STANDUP_PERSONA_TOKEN?.trim();
  return token ? token : undefined;
}

export interface PersonaProxyOptions {
  collectorUrl: string;
  token: string;
  fetch?: typeof fetch;
}

export interface PersonaProxy {
  listTools(): Promise<Tool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
}

function errorResult(reason: string): CallToolResult {
  // One line keeps the error readable in Persona's transcript.
  const line = reason.replace(/\s+/g, " ").trim();
  return { content: [{ type: "text", text: `error: ${line}` }], isError: true };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readJson(response: Response, route: string): Promise<unknown> {
  const raw = await response.text();
  if (!response.ok) {
    let detail = response.statusText || "request failed";
    try {
      const body = JSON.parse(raw) as { error?: unknown };
      if (typeof body?.error === "string" && body.error) detail = body.error;
    } catch {
      // Non-JSON error body: statusText is the best available detail.
    }
    throw new Error(`persona collector ${route} failed (${response.status}): ${detail}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`persona collector ${route} returned malformed JSON`);
  }
}

function isCallToolResult(value: unknown): value is CallToolResult {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

export function createPersonaProxy(options: PersonaProxyOptions): PersonaProxy {
  const base = options.collectorUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const authHeaders = { [PERSONA_TOKEN_HEADER]: options.token };

  return {
    /**
     * Throws on any collector failure so the MCP client sees a list error
     * rather than a silently empty catalog.
     */
    async listTools() {
      let response: Response;
      try {
        response = await doFetch(`${base}/api/persona/tools`, {
          method: "GET",
          headers: authHeaders,
        });
      } catch (err) {
        throw new Error(`persona collector GET /tools unreachable: ${errorMessage(err)}`);
      }
      const body = (await readJson(response, "GET /tools")) as { tools?: unknown };
      if (!Array.isArray(body?.tools)) {
        throw new Error("persona collector GET /tools returned no tools array");
      }
      return body.tools as Tool[];
    },

    /** Never throws: every collector failure becomes an isError result. */
    async callTool(name, args) {
      try {
        let response: Response;
        try {
          response = await doFetch(`${base}/api/persona/tool`, {
            method: "POST",
            headers: { ...authHeaders, "Content-Type": "application/json" },
            body: JSON.stringify({ name, arguments: args }),
          });
        } catch (err) {
          throw new Error(`persona collector POST /tool unreachable: ${errorMessage(err)}`);
        }
        const body = await readJson(response, "POST /tool");
        if (!isCallToolResult(body)) {
          throw new Error("persona collector POST /tool returned a malformed tool result");
        }
        return body;
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  };
}
