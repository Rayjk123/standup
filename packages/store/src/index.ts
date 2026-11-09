export { createStore, type Store, type StoreOptions } from "./store.js";
export { assertNotLiveDbInTest, isLiveDbPath, isTestRun, scratchDataDirBase } from "./live-db-guard.js";
export { runMigrations, ensureKnowledgeChangeColumns, ensurePipelineShape } from "./migrations.js";
export * from "./queries/index.js";
