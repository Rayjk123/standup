import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "../store/schema.js";
import { loadProjects } from "./projects-registry.js";
import { searchKnowledge } from "../knowledge/search.js";
import { askExpert } from "../expert/expert.js";

/** Port the collector's HTTP API and console listen on. */
export const COLLECTOR_PORT = Number(process.env.STANDUP_PORT ?? 7781);

export function startCollector(dbPath: string): ReturnType<typeof Bun.serve> {
  const db = new Database(dbPath);
  db.exec(SCHEMA_SQL);

  return Bun.serve({
    port: COLLECTOR_PORT,
    async fetch(req) {
      const url = new URL(req.url);
      const user = req.headers.get("x-standup-user") ?? undefined;
      if (url.pathname === "/api/projects" && req.method === "GET") {
        return Response.json(loadProjects(db));
      }
      if (url.pathname === "/api/knowledge/search" && req.method === "POST") {
        const body = (await req.json()) as { query: string; projectId: string; corpus?: "project" | "all" };
        const hits = await searchKnowledge(db, body.query, {
          audience: { projectId: body.projectId, user },
          corpus: body.corpus,
        });
        return Response.json(hits.map((h) => ({ slug: h.doc.slug, project: h.doc.projectId, relevance: h.rawScore })));
      }
      if (url.pathname === "/api/expert" && req.method === "POST") {
        const body = (await req.json()) as { question: string; projectId: string; cwd: string };
        return Response.json(await askExpert(db, body.question, { projectId: body.projectId, user }, body.cwd));
      }
      return new Response("not found", { status: 404 });
    },
  });
}
