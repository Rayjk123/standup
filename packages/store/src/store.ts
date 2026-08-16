import { Database } from "bun:sqlite";
import { runMigrations } from "./migrations.js";

export interface Store {
  db: Database;
  close(): void;
}

export function createStore(dbPath: string = ":memory:"): Store {
  const db = new Database(dbPath, { create: true });

  // Enable WAL mode for better concurrent read performance
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  runMigrations(db);

  return {
    db,
    close() {
      db.close();
    },
  };
}
