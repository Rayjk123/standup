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
import { reconcileBlockedSessions } from "./reconcile.js";
import { reapDeadSessions } from "./reaper.js";

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

// Bootstrap projects before the server accepts hooks — SessionStart needs
// the projects table populated to route sessions by cwd.
//
// SQLite is authoritative; TOML only seeds an empty database (and can be
// re-imported explicitly via POST /api/projects/import). The file is
// deliberately not watched: watching would imply an authority it no longer
// has, and would clobber edits made through the UI.
const registry = new ProjectsRegistry(store.db, PROJECTS_PATH);
const projects = await registry.bootstrap();
console.log(
  `[registry] ${projects.length} project(s) available (SQLite is authoritative; ` +
    `seed file: ${PROJECTS_PATH})`
);

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

// Re-derive blocked state from stored events. Blocking is otherwise only
// noticed as a Notification arrives, so an agent that was already waiting
// when the collector restarted would stay invisible indefinitely.
const reblocked = reconcileBlockedSessions(store.db);
if (reblocked.length > 0) {
  console.log(
    `[reconcile] ${reblocked.length} launched session(s) still waiting on you`
  );
  for (const ask of reblocked) {
    wsBroadcast({
      type: "ask:new",
      payload: ask,
      timestamp: new Date().toISOString(),
    });
  }
}

// Reap launched sessions whose tmux pane died out-of-band. SessionEnd only
// fires on a clean Claude Code exit; a killed pane sends no hook, so without
// this its row stays active and any pending ask lingers in "Needs you"
// forever. Poll on an interval — there is no event to hang this off of.
const REAPER_INTERVAL_MS = parseInt(
  process.env.STANDUP_REAPER_INTERVAL_MS ?? "30000"
);
const reaperTimer = setInterval(() => {
  const reaped = reapDeadSessions(store.db);
  for (const { sessionId, cancelledAsks } of reaped) {
    for (const ask of cancelledAsks) {
      wsBroadcast({
        type: "ask:resolved",
        payload: { askId: ask.id, answer: "" },
        timestamp: new Date().toISOString(),
      });
    }
    wsBroadcast({
      type: "session:end",
      payload: { sessionId },
      timestamp: new Date().toISOString(),
    });
  }
  if (reaped.length > 0) {
    console.log(`[reaper] Reaped ${reaped.length} dead launched session(s)`);
  }
}, REAPER_INTERVAL_MS);

// Create HTTP server for Claude Code hooks
const server = createServer(
  store,
  wsBroadcast,
  EMBEDDING_PROVIDER,
  knowledgeSync,
  registry,
  KNOWLEDGE_DIR
);

export default {
  port: COLLECTOR_PORT,
  fetch: server.fetch,
};

console.log(`[collector] Listening on http://localhost:${COLLECTOR_PORT}`);
console.log(`[collector] Ready to receive Claude Code hooks`);

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n[collector] Shutting down...");
  clearInterval(reaperTimer);
  knowledgeSync.stopWatching();
  store.close();
  process.exit(0);
});
