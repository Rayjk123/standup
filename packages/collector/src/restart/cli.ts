#!/usr/bin/env bun
/**
 * The restart supervisor: `bun run cli.ts <record.json>`, with a one-time
 * nonce on stdin. The collector spawns it detached (its own session, its own
 * log) right before it is stopped, since the restart has to outlive the
 * process it restarts. It runs from the copy of its code the collector made
 * at hand-off (`<data dir>/restart/bin/<id>/`, see snapshot.ts), so the
 * install it names comes from STANDUP_INSTALL_DIR, which the collector sets. It refuses to act unless authorizeSupervisor accepts
 * the record — the data dir's current record, waiting for a supervisor, for
 * this install, carrying the nonce's hash — then carries it out with the real
 * effects and leaves the outcome in the record, where the next collector
 * picks it up and reports it to Persona. Only an authorized run records
 * known-good commits.
 */
import { dirname } from "path";
import { defaultDbPath } from "../db-path.js";
import { authorizeSupervisor, guardedSave } from "./authorize.js";
import { createSystemExec, readTail } from "./exec.js";
import { RestartPreempted, recordGoodHead, resolveInstallDir } from "./state.js";
import { runRestart, timingsFromEnv } from "./supervisor.js";

/** How long the collector gets to write the nonce and close stdin. */
const NONCE_TIMEOUT_MS = 10_000;

async function readNonce(): Promise<string> {
  const text = new Response(Bun.stdin.stream()).text();
  const timeout = new Promise<string>((resolve) => setTimeout(() => resolve(""), NONCE_TIMEOUT_MS).unref());
  return (await Promise.race([text, timeout])).trim();
}

const log = (line: string) => console.log(`[restart ${new Date().toISOString()}] ${line}`);

const recordPath = process.argv[2];
if (!recordPath) {
  console.error("usage: bun run packages/collector/src/restart/cli.ts <restart-record.json>  (nonce on stdin)");
  process.exit(2);
}
const dataDir = dirname(defaultDbPath());
const auth = authorizeSupervisor({
  recordPath,
  nonce: await readNonce(),
  dataDir,
  installDir: resolveInstallDir(),
  execPath: process.execPath,
  bindHost: process.env.STANDUP_BIND_HOST,
  webUrl: process.env.STANDUP_WEB_URL,
});
if (!auth.ok) {
  console.error(`[restart] refusing to run: ${auth.error}`);
  process.exit(2);
}

try {
  const finished = await runRestart(auth.record, {
    exec: createSystemExec(),
    save: guardedSave(recordPath, process.pid),
    recordGoodHead: (head, opts) => {
      recordGoodHead(dataDir, head, undefined, opts);
    },
    readTail: (path) => readTail(path, 40),
    log,
    pid: process.pid,
    timings: timingsFromEnv(),
  });
  process.exit(finished.outcome === "failed" ? 1 : 0);
} catch (err) {
  if (!(err instanceof RestartPreempted)) throw err;
  log(`stopping: ${err.message}`);
  process.exit(3);
}
