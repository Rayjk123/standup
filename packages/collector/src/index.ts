import { homedir } from "os";
import { join, dirname } from "path";
import { mkdir } from "fs/promises";
import { createStore } from "@standup/store";
import { DEFAULT_COLLECTOR_PORT, DEFAULT_WS_PORT } from "@standup/shared";
import type { EmbeddingProvider } from "@standup/knowledge";
import { createServer } from "./server.js";
import { createWsServer } from "./ws.js";
import { KnowledgeSync } from "./knowledge-sync.js";
import { ProjectsRegistry, defaultProjectsPath } from "./projects-registry.js";

const COLLECTOR_PORT = parseInt(process.env.COLLECTOR_PORT ?? String(DEFAULT_COLLECTOR_PORT));
const WS_PORT = parseInt(process.env.WS_PORT ?? String(DEFAULT_WS_PORT));
// Must live outside the source tree: `bun run --watch` restarts on any file
// change under its cwd, and SQLite's WAL mode rewrites -wal/-shm files on
// every insert. A DB path inside packages/collector/ causes a restart loop
// driven by the collector's own writes.
const DB_PATH =
  process.env.DB_PATH ?? join(homedir(), ".local", "share", "standup", "standup.db");
const PROJECTS_PATH = defaultProjectsPath();
const KNOWLEDGE_DIR =
  process.env.KNOWLEDGE_DIR ?? join(homedir(), ".config", "standup", "knowledge");
const EMBEDDING_PROVIDER = (process.env.EMBEDDING_PROVIDER as EmbeddingProvider | undefined) ?? null;

// Initialize store
await mkdir(dirname(DB_PATH), { recursive: true });
const store = createStore(DB_PATH);
console.log(`[store] Initialized SQLite at ${DB_PATH}`);

// Create WebSocket server for UI connections
const wsBroadcast = createWsServer(WS_PORT);
console.log(`[ws] Listening on ws://localhost:${WS_PORT}`);

// Load the project registry (Phase 1) — must happen before the server starts
// accepting hooks, since SessionStart needs the projects table populated to
// route sessions by cwd. Ensures "scratch" always exists as a fallback.
const registry = new ProjectsRegistry(store.db, PROJECTS_PATH);
const projects = await registry.load();
console.log(`[registry] Loaded ${projects.length} project(s) from ${PROJECTS_PATH}`);
registry
  .startWatching((updated) => {
    console.log(`[registry] Reloaded ${updated.length} project(s)`);
    wsBroadcast({
      type: "projects:updated",
      payload: updated,
      timestamp: new Date().toISOString(),
    });
  })
  .catch((err) => console.error("[registry] Watcher stopped unexpectedly:", err));

// Load and watch project knowledge (Phase 2.5)
const knowledgeSync = new KnowledgeSync(store.db, KNOWLEDGE_DIR, EMBEDDING_PROVIDER);
await knowledgeSync.syncAll();
knowledgeSync.startWatching((projectId) => {
  console.log(`[knowledge] Reloaded docs for ${projectId}`);
});
console.log(`[knowledge] Watching ${KNOWLEDGE_DIR}`);
if (!EMBEDDING_PROVIDER) {
  console.log(`[knowledge] EMBEDDING_PROVIDER not set — text search only`);
}

// Create HTTP server for Claude Code hooks
const server = createServer(store, wsBroadcast, EMBEDDING_PROVIDER, knowledgeSync);

export default {
  port: COLLECTOR_PORT,
  fetch: server.fetch,
};

console.log(`[collector] Listening on http://localhost:${COLLECTOR_PORT}`);
console.log(`[collector] Ready to receive Claude Code hooks`);

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n[collector] Shutting down...");
  knowledgeSync.stopWatching();
  store.close();
  process.exit(0);
});
