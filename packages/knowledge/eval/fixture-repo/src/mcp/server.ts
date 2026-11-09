import type { ToolDefinition } from "./tools.js";
import { registerTools } from "./tools.js";
import { fetchWithTimeout } from "../net/fetch.js";

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

export class Server {
  private handlers = new Map<string, { def: ToolDefinition; handler: Handler }>();

  constructor(private collectorUrl: string, private sessionId: string) {}

  tool(def: ToolDefinition, handler: Handler): void {
    this.handlers.set(def.name, { def, handler });
  }

  list(): ToolDefinition[] {
    return [...this.handlers.values()].map((h) => h.def);
  }

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const entry = this.handlers.get(name);
    if (!entry) throw new Error(`unknown tool ${name}`);
    return entry.handler(args);
  }

  forward(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.post(`/api/mcp/${name}`, args);
  }

  async post(path: string, body: unknown): Promise<unknown> {
    const res = await fetchWithTimeout(`${this.collectorUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-standup-session": this.sessionId },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }
}

export function startMcpServer(collectorUrl: string, sessionId: string): Server {
  const server = new Server(collectorUrl, sessionId);
  registerTools(server);
  return server;
}
