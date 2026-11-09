/**
 * End-to-end check for tryEnableSqliteVecExtension's default auto-enable.
 *
 * Runs in its OWN process (spawned by vec.test.ts) because tryEnableSqliteVec-
 * Extension may call Database.setCustomSQLite — the one-shot process global that
 * cannot be exercised inside the shared `bun test` process. A fresh child lets it
 * attempt the real swap.
 *
 * Prints one of:
 *   AUTOENABLE ENABLED  — it reported the extension on AND sqlite-vec genuinely
 *                         loads on a fresh connection (the capable-host case).
 *   AUTOENABLE FALLBACK — it reported off; the process still opens databases and
 *                         search stays on the brute-force scan (the host without
 *                         an extension-capable SQLite — the clean no-op).
 *   AUTOENABLE BROKEN   — it reported on but the extension does not actually load,
 *                         a contradiction the test fails on.
 * Exit 0 for ENABLED/FALLBACK, 1 for BROKEN or any throw. Either healthy outcome
 * must open a database without throwing — that is the safety the guard buys.
 */
import { Database } from "bun:sqlite";
import { tryEnableSqliteVecExtension, isVecAvailable } from "./vec.js";

const enabled = tryEnableSqliteVecExtension();

// Enabled or not, the process must still be able to open a database — a bad swap
// would strand this open, so reaching the query proves the SQLite is intact.
const db = new Database(":memory:");
db.query("SELECT 1").get();

if (enabled) {
  if (!isVecAvailable(db)) {
    console.log("AUTOENABLE BROKEN");
    process.exit(1);
  }
  console.log("AUTOENABLE ENABLED");
} else {
  console.log("AUTOENABLE FALLBACK");
}
db.close();
process.exit(0);
