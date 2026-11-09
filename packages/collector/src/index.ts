import { homedir } from "os";
import { join, dirname } from "path";
import { mkdir } from "fs/promises";
import { randomBytes } from "crypto";
import {
  createStore,
  touchUser,
  createCheckpoint,
  getActiveSessions,
  getProjects,
  getSession,
  getSetting,
  personaJobForSession,
  recentProvisionedWorkingDirs,
  reconcileLostOrchestrationRuns,
  timeoutOrphanedAsks,
} from "@standup/store";
import { DEFAULT_COLLECTOR_PORT, DEFAULT_WS_PORT, consoleBaseUrlFromEnv, formatGb } from "@standup/shared";
import { standupDataDir } from "@standup/shared/owner-token";
import type { EmbeddingProvider, EmbeddingConfig } from "@standup/knowledge";
import { KnowledgeStore, tryEnableSqliteVecExtension } from "@standup/knowledge";
import {
  buildSnapshot,
  createServer,
  resolveIdentityConfigFromEnv,
  resolveUserAlias,
  setLocalWriteToken,
  type CollectorHealth,
} from "./server.js";
import { ensureLocalWriteToken, localWriteTokenPath } from "@standup/shared/write-token";
import { TranscriptTailer } from "./transcript-tailer.js";
import { createWsServer } from "./ws.js";
import {
  publicKnowledgeEnabled,
  publicKnowledgeSocketPath,
  startPublicKnowledgeListener,
  type PublicKnowledgeListenerStatus,
} from "./public-knowledge/listener.js";
import { PUBLIC_KB_IDENTITY_HEADER_ENV, publicIdentityHeader } from "./public-knowledge/identity.js";
import { KnowledgeSync } from "./knowledge-sync.js";
import { ingestProjectDocs } from "./project-docs-ingest.js";
import { ingestNativeMemory } from "./native-memory-ingest.js";
import { ProjectsRegistry, defaultProjectsPath } from "./projects-registry.js";
import { reconcileBlockedSessions } from "./reconcile.js";
import { reaperTick, failStrandedStartingLaunches } from "./reaper.js";
import { resyncStaleRunningSessions, tmuxPaneDriver } from "./session-recovery.js";
import { createIdleReaper, formatIdle, idleReapThresholds } from "./idle-reaper.js";
import { adoptLiveReapedPanes, wakeForQueued } from "./launch-resume.js";
import { stopSession } from "./session-stop.js";
import { CodexObserver } from "./codex-observer.js";
import { sweepLostTaskRuns } from "./task-run-sweep.js";
import { failStrandedQueuedLaunches, tmuxSessionExists } from "./launcher.js";
import { hostMonitor } from "./host-headroom.js";
import { startReviewCron } from "./review-cron.js";
import { startKnowledgeReverifyCron } from "./knowledge-reverify.js";
import { runBootKnowledgeMaintenance, syncCorpusThenMaintain } from "./knowledge-maintenance.js";
import {
  startKnowledgeGraphAuditCron,
  isNightlySweepEnabled,
  NIGHTLY_SWEEP_ENV,
  NIGHTLY_SWEEP_SETTING_KEY,
} from "./knowledge-graph-audit.js";
import { startDistillCron } from "./distill-cron.js";
import {
  startDigestCron,
  isDigestEnabled,
  DIGEST_ENV,
  DIGEST_SETTING_KEY,
} from "./digest-cron.js";
import { verifyDraft } from "./draft-verify.js";
import { ensurePrivateDir, paneDeliveryDir, PERSONA_CWD } from "./internal-cwd.js";
import { createBroadcastTap, withPersonaHandled } from "./persona/events.js";
import { createBoard } from "./board/board.js";
import { attachBoardAdapter } from "./board/adapter.js";
import { resolvePersonaConfig } from "./persona/config.js";
import { PersonaRuntime } from "./persona/runtime.js";
import { PersonaFleet, delegateTurnCwd, personaTurnCwd } from "./persona/fleet.js";
import { claudeAllowChecker } from "./persona/allow-check.js";
import { createClaudeTurnRunner } from "./persona/turn.js";
import { createStubTurnRunner, PERSONA_STUB_TURNS_ENV, stubTurnsEnabled } from "./persona/stub-turn.js";
import { makeKnowledgeChangeEmitter } from "./knowledge-change-emit.js";
import { CodeSymbolIndexer } from "./code-symbols.js";
import { refreshProjectsCodeMentions } from "./knowledge-code-mentions.js";
import { RestartService } from "./restart/service.js";
import { createSystemExec } from "./restart/exec.js";
import { resolveInstallDir } from "./restart/state.js";
import { timingsFromEnv } from "./restart/supervisor.js";
import { defaultDbPath } from "./db-path.js";
import { ensureOwnerSecrets, installOwnerSecrets } from "./owner-secret.js";
import { sweepExpiredFloorHolds } from "./floor/routes.js";
import { gitChangedFiles, gitHeadState, routeLegacyBlocksToPersona, settleNotApplicableRuns } from "./pipeline/engine.js";
import { pipelineScreenshotsDir, screenshotStore, validateScreenshotPath } from "./pipeline/screenshots.js";
import { reviewScratchDirFor } from "./review/media.js";
import { acquireLeadership, LeadershipUnavailableError, readInstallHead } from "./leader.js";
import { activeOrgProfile, OrgProfileError } from "./org-profile/load.js";
import { applyOrgReviewTerms } from "./knowledge-query-rewrite.js";
import { processDrain, shutdownSignalGate, waitForIdle } from "./drain.js";
import { createReviewTunnels, createReviewTunnelSystem, startReviewTunnelMaintenance } from "./review-tunnel/index.js";
import { closedJobHygieneStep, startWorkerHygieneMaintenance } from "./job-hygiene.js";
import { createProcessSystem } from "./process-registry.js";
import { COLLECTOR_SLOTS, WS_CLOSE_SERVICE_RESTART, type CollectorSlot } from "@standup/shared/topology";
import { scratchRoot } from "@standup/shared/scratch";
import { dropScratchTempEnv } from "./floor/launch.js";
import { activeProjectLayout, unreadWorkingDirs, unreadWorkingDirsWarning } from "./project-layout/layout.js";

// A temp dir inherited from a worker's scratch dir (a collector restarted from
// a worker's pane) would root every temp path this process derives inside the
// protected scratch root, so the OS default takes its place.
const droppedTempEnv = dropScratchTempEnv(process.env, scratchRoot());
if (droppedTempEnv.length > 0) console.log(`[scratch] Ignoring inherited ${droppedTempEnv.join(", ")} under the scratch root ${scratchRoot()}`);

// The install this process runs from, and the commit its code was loaded from,
// read now, at process start: a standby may wait for the leader lock long
// after the checkout has moved on, and /health, the leader file and the
// known-good record must name the code actually running.
const INSTALL_DIR = resolveInstallDir();
const LOADED_HEAD = readInstallHead(INSTALL_DIR);

// The public ports: every collector URL this process advertises (Persona's MCP
// config, the restart service's self-probe, the review cron's agents) names
// these. In gateway mode the gateway owns them and forwards to the leader.
const COLLECTOR_PORT = parseInt(process.env.COLLECTOR_PORT ?? String(DEFAULT_COLLECTOR_PORT));
const WS_PORT = parseInt(process.env.WS_PORT ?? String(DEFAULT_WS_PORT));
// The ports this process binds: its slot's ports in gateway mode (dev.ts sets
// them), else the public ones.
function listenPort(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const LISTEN_PORT = listenPort(process.env.STANDUP_LISTEN_PORT, COLLECTOR_PORT);
const LISTEN_WS_PORT = listenPort(process.env.STANDUP_LISTEN_WS_PORT, WS_PORT);
const COLLECTOR_SLOT: CollectorSlot | undefined = COLLECTOR_SLOTS.find(
  (s) => s === process.env.STANDUP_COLLECTOR_SLOT?.trim()
);
// Loopback by default; set STANDUP_BIND_HOST=0.0.0.0 to expose the collector to
// the network (e.g. to share the port through a tunnel). Ports are
// unchanged. Bun's own default is 0.0.0.0, so binding this explicitly tightens
// the out-of-the-box default to localhost-only.
//
// On an authenticating tunnel (STANDUP_TUNNEL_IDENTITY_HEADER) the identity header
// is authenticated and unforgeable, so knowledge authoring trusts the caller's tunnel
// identity directly (no token). Per-user profile WRITES are a CROSS-USER write not
// yet migrated to that per-owner authorization, so they conservatively retain the
// out-of-band shared secret STANDUP_WRITE_TOKEN — presented as the
// x-standup-write-token header — as their operator gate. When it is set it is
// required for every profile write regardless of bind; when it is unset a loopback
// bind trusts local writes ONLY while single-user — once multiplayer (≥2 people)
// or on a raw network bind they fail closed. STANDUP_WRITE_TOKEN is thus an
// OPTIONAL lockdown for a shared/multiplayer or non-tunnel deployment, not a
// requirement for normal team use. Independently of it, the collector's own OS
// user's local agents present the per-user local write token (~/.standup/
// write-token, created below), which clears the gate on any bind or in
// multiplayer. See isTrustedProfileWrite in server.ts and resolveUserAlias in
// identity.ts.
const BIND_HOST = process.env.STANDUP_BIND_HOST?.trim() || "127.0.0.1";
// Outside the source tree — see defaultDbPath for the watch-restart loop a DB
// under packages/collector/ would cause.
const DB_PATH = defaultDbPath();
const PROJECTS_PATH = defaultProjectsPath();
const KNOWLEDGE_DIR =
  process.env.KNOWLEDGE_DIR ?? join(homedir(), ".config", "standup", "knowledge");
// Uploaded project icons live alongside the SQLite data dir (not under the
// source tree — see DB_PATH's note on the watch-restart loop, which any file
// written under the collector's cwd would trigger).
const ICONS_DIR =
  process.env.ICONS_DIR ?? join(homedir(), ".local", "share", "standup", "icons");
// EMBEDDING_PROVIDER is the explicit override. When it's unset we probe for a
// local ollama and use it if reachable — so embeddings "just work" with zero
// config for anyone already running ollama. Any probe failure (ollama absent,
// slow, or erroring) falls back to text-only search rather than blocking or
// crashing startup.
async function detectOllama(): Promise<EmbeddingProvider | null> {
  try {
    const res = await fetch("http://localhost:11434/api/tags", {
      signal: AbortSignal.timeout(1000),
    });
    if (res.ok) {
      console.log(
        `[knowledge] auto-detected local ollama — embeddings on (nomic-embed-text)`
      );
      return "ollama";
    }
  } catch {
    // Not reachable — stay text-only (the "not set" log below covers this).
  }
  return null;
}

const EMBEDDING_PROVIDER: EmbeddingProvider | null =
  (process.env.EMBEDDING_PROVIDER as EmbeddingProvider | undefined) ??
  (await detectOllama());

// Provider configuration, threaded to the embedding seam. Each field is
// optional; an unset field lets the selected plugin apply its own default
// (model, base URL) or its env-var fallback (API keys). `region` is for the
// AWS-creds providers. `dimensions` requests a narrower output width from
// models that support one (Titan v2's 256/512); it is part of the corpus
// fingerprint, so changing it re-embeds. Empty strings are dropped so an unset
// env var never shadows a plugin default; a non-numeric EMBEDDING_DIMENSIONS is
// dropped the same way rather than sent as NaN.
const EMBEDDING_DIMENSIONS = parseInt(process.env.EMBEDDING_DIMENSIONS ?? "");
const EMBEDDING_CONFIG: EmbeddingConfig = {
  model: process.env.EMBEDDING_MODEL || undefined,
  apiKey: process.env.EMBEDDING_API_KEY || undefined,
  baseUrl: process.env.EMBEDDING_BASE_URL || undefined,
  region: process.env.AWS_REGION || undefined,
  dimensions: Number.isNaN(EMBEDDING_DIMENSIONS) ? undefined : EMBEDDING_DIMENSIONS,
};

// Point bun:sqlite at an extension-capable SQLite BEFORE the first Database is
// opened, so the knowledge index can load sqlite-vec and serve KNN search.
// Auto-on when available: this attempts the swap by default, so a host with an
// extension-capable SQLite turns the KNN path on with zero configuration, while a
// host without one is a clean no-op and search stays on the brute-force cosine
// scan. STANDUP_DISABLE_VEC opts out. The attempt is fully guarded — each
// candidate is validated in a throwaway child process before the parent applies
// it — so a host lacking the extension is never left with a broken SQLite. Must
// precede createStore: setCustomSQLite is a one-shot process global that only
// takes before any connection exists.
//
// On a DB whose vec0 mirror is missing or was built by an older, project-only
// partitioned build, enabling vec triggers a ONE-TIME reindex at
// ensureVecIndex() below: the mirror is dropped and repopulated onto the
// scope/owner-partitioned schema from the stored embeddings (no re-embedding,
// no network). Later boots find it current and keep it. The `knowledge` table is
// untouched, so the step is reversible — STANDUP_DISABLE_VEC returns search to
// the brute-force scan.
if (tryEnableSqliteVecExtension()) {
  console.log(`[knowledge] sqlite-vec enabled — KNN search on when the corpus is indexed`);
}

// The org profile: a profile file with any error stops the boot here, since
// the floor would otherwise run without the holds its bad entries add. Its
// code-review noun joins the built-in review words that knowledge injection
// reads a forbidden "don't open a review" action and a review task from.
try {
  applyOrgReviewTerms(activeOrgProfile());
} catch (err) {
  if (err instanceof OrgProfileError) {
    console.error(`[collector] ERROR: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

// Leadership gate: one collector per data dir serves. A second one (the warm
// standby) waits here, its code loaded, without opening the DB or binding a
// port, and takes over within a poll interval of the leader's exit. Everything
// above is process-local, so a standby has it done before it takes over.
const leadership = await acquireLeadership({
  dataDir: dirname(DB_PATH),
  slot: COLLECTOR_SLOT,
  httpPort: LISTEN_PORT,
  wsPort: LISTEN_WS_PORT,
  installDir: INSTALL_DIR,
  head: LOADED_HEAD,
}).catch((err: unknown) => {
  if (err instanceof LeadershipUnavailableError) {
    console.error(`[collector] ERROR: ${err.message}`);
    process.exit(1);
  }
  throw err;
});

// Until the drain handler below is installed (once serving), a SIGTERM or
// SIGINT mid-boot exits cleanly instead of by the signal's default action:
// the store is closed if it was opened, and the exit releases the lock.
let bootStore: { close(): void } | undefined;
const onBootSignal = (signal: NodeJS.Signals) => {
  console.log(`[collector] ${signal} during boot; exiting`);
  try {
    bootStore?.close();
  } catch {
    // Exiting regardless.
  }
  process.exit(0);
};
process.on("SIGINT", onBootSignal);
process.on("SIGTERM", onBootSignal);

// Initialize store
await mkdir(dirname(DB_PATH), { recursive: true });
// The leader file tells a restart waiting on this boot that a long copy or
// migration, not a hang, keeps the collector from listening yet.
const store = createStore(DB_PATH, { backupBeforeMigrate: true, onBootPhase: (phase) => leadership.setBootPhase(phase) });
bootStore = store;

// The project layout is one setting for the install: provisioned working dirs
// it reads no checkout in (a multi-checkout workspace under the default git
// layout) are named here, since their pipeline stages can't read a change.
{
  const layout = activeProjectLayout();
  const warning = unreadWorkingDirsWarning(layout, unreadWorkingDirs(layout, recentProvisionedWorkingDirs(store.db)));
  if (warning) console.warn(warning);
}
console.log(`[store] Initialized SQLite at ${DB_PATH}`);

// The owner secret and the safety floor's reply key, under <dataDir>/secrets/
// (see owner-secret.ts). Read from disk by the owner's channels only; never put
// in an env var or argv a worker sees. When they can't be persisted, the
// process runs on ephemeral ones: the floor still signs its replies, but no
// owner channel can present the secret, so owner-only decisions are refused.
try {
  installOwnerSecrets(ensureOwnerSecrets(dirname(DB_PATH)));
  console.log(`[collector] Owner secret and floor reply key in ${join(dirname(DB_PATH), "secrets")}`);
} catch (err) {
  console.warn(`[collector] Could not persist the owner secret (${(err as Error).message}); owner-only decisions will be refused until it can be`);
}

// Safety-floor holds whose hooks gave up while the collector was down.
const sweptFloorHolds = sweepExpiredFloorHolds(store.db);
if (sweptFloorHolds.length > 0) console.log(`[floor] Timed out ${sweptFloorHolds.length} stale safety-floor hold(s)`);

// Worker asks raised without a request id whose waiter was a call into the
// previous collector process: nothing can re-attach to them. Cut at the moment
// this process became leader, not its start: a standby starts long before, and
// asks raised meanwhile were the previous leader's.
const orphanedAsks = timeoutOrphanedAsks(store.db, leadership.acquiredAt);
if (orphanedAsks.length > 0) console.log(`[asks] Timed out ${orphanedAsks.length} ask(s) whose waiter left with the previous collector`);

// The identity provider for request-identity resolution, resolved ONCE from env
// (STANDUP_IDENTITY_HEADER / STANDUP_IDENTITY_AUTH / STANDUP_TRUSTED_PROXIES,
// defaulting to defaultIdentityConfig()). The SAME object is threaded into
// both the WS server and the REST server below so the two identity channels
// cannot drift.
const identityConfig = resolveIdentityConfigFromEnv();

// Create WebSocket server for UI connections. The snapshot builder lets a
// connecting client boot from a single hello-ok frame instead of a fan-out of
// REST calls. It turns connections away until the HTTP server below is
// listening, so a reconnecting console's REST resync doesn't hit a closed port.
let httpListening = false;
// How many hello-ok snapshots are being built right now; the Board's startup
// reconcile waits for none (see below).
let snapshotsBuilding = 0;
const wsServer = createWsServer(
  LISTEN_WS_PORT,
  async () => {
    snapshotsBuilding++;
    try {
      return await buildSnapshot(store);
    } finally {
      snapshotsBuilding--;
    }
  },
  // A WS connect upserts the visitor's users row (first_seen/last_seen), same
  // cheap upsert the /api/* middleware runs — so a client that boots purely
  // from the hello-ok snapshot is still recorded in the identity foundation.
  // viaTunnel carries whether the connection arrived through the gateway as a
  // real person, so agent traffic doesn't inflate the multiplayer count.
  (alias, viaTunnel) => {
    touchUser(store.db, alias, { viaTunnel });
  },
  identityConfig,
  // A reconnect's `?epoch=&since=` cursor resumes only within this leadership term.
  { epoch: leadership.epoch, accepting: () => httpListening }
);
// Every producer below broadcasts through the tap, so in-process listeners
// (Persona's event router) see each frame the WS clients do.
const wsBroadcastTap = createBroadcastTap(wsServer.broadcast);
const wsBroadcast = wsBroadcastTap.broadcast;
console.log(`[ws] Listening on ws://${BIND_HOST}:${LISTEN_WS_PORT}`);

// The Board: a card per Persona job and review ticket, kept current from the
// frames every producer broadcasts through the tap, whether or not Persona
// runs. Reconciled once for whatever changed while the collector was down,
// after the HTTP server binds (below).
const board = createBoard({ db: store.db, publish: wsBroadcast });
const boardAdapter = attachBoardAdapter({ tap: wsBroadcastTap, board, db: store.db, changedFiles: gitChangedFiles });

// Surface a cron-driven knowledge-graph change (a distilled draft, a reverify
// contradiction) as a substantive feed item on both surfaces. The same shared
// emitter the request-handling server uses — it persists before broadcasting,
// so a change these unattended crons fire (a contradiction flagged with no
// client connected) is durable and survives a reload/reconnect, not dropped on
// the wire.
const emitKnowledgeChange = makeKnowledgeChangeEmitter(store.db, wsBroadcast);

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

// Load and watch project knowledge
const knowledgeSync = new KnowledgeSync(
  store.db,
  KNOWLEDGE_DIR,
  EMBEDDING_PROVIDER,
  EMBEDDING_CONFIG
);
// Embedding waits for the background indexer's embedding-space check (started
// once the server listens), so the corpus sync and any request-path sync before
// the check only reconcile docs and text search and never block on the
// embedding provider.
knowledgeSync.deferEmbeddingUntilChecked();
// The background re-embed is the collector's heaviest batch job; it yields
// while the host is short on memory or CPU and resumes on its retry backoff.
knowledgeSync.setHostPressure(() => hostMonitor.pressure());

/**
 * Brings the knowledge corpus up to date with disk: the project-docs and
 * native-memory mirrors, the full sync and the sqlite-vec
 * index, then the corpus watcher. Runs in the background once the servers
 * listen, outside the restart gap: the DB already holds the corpus the
 * previous leader indexed, and a request that searches knowledge syncs its own
 * project first (KnowledgeSync.syncProject), so nothing serving a request
 * waits on this. Stops between steps once the collector is draining.
 */
async function syncKnowledgeCorpus(): Promise<void> {
  const stopped = () => processDrain.draining;
  // Mirror each project's committed design docs (its repo `plan/*.md`) into the
  // corpus BEFORE the sync, so a doc becomes retrievable through
  // search_knowledge on the boot after it is committed instead of
  // waiting for a hand-copy into the corpus dir. Non-destructive: a curated
  // corpus doc (no `ingested_from` marker) is never overwritten; only a
  // previously-ingested copy is rewritten when its redacted body differs from
  // the source's (its curated front matter kept), or removed when the source is
  // deleted.
  // Best-effort — a bad repo path must not stop the rest.
  try {
    const ingestResults = await ingestProjectDocs(KNOWLEDGE_DIR, projects);
    for (const r of ingestResults) {
      if (r.ingested.length || r.refreshed.length || r.removed.length) {
        console.log(
          `[knowledge] project docs for ${r.projectId}: +${r.ingested.length} new, ` +
            `~${r.refreshed.length} refreshed, -${r.removed.length} removed`
        );
      }
    }
  } catch (err) {
    console.error(`[knowledge] project-docs ingest failed:`, err);
  }
  if (stopped()) return;

  // Mirror Claude Code's native memory into the corpus on the same boot, right
  // beside the project-docs ingest and before the sync so the mirrored files are
  // embedded now: each project's `.claude/CLAUDE.md`, `.claude/rules/*.md`, and
  // the auto-memory notes of every repo under its own corpus, plus the HOME
  // `~/.claude` hierarchy homed in the global corpus as the host user's
  // scope=user personal layer, all stamped source_kind=native-memory. Auto-memory
  // is mirrored `agent`-trust (Claude Code authored it) and classified by each
  // note's own type. Every mirrored body is redacted, and a copy whose redacted
  // body differs from the source's is rewritten with its curated front matter
  // kept; an operator can drop the HOME tier with
  // STANDUP_NATIVE_MEMORY_EXCLUDE_HOME. Same non-destructive interlock as project
  // docs — a curated corpus doc is never overwritten; only a previously-mirrored
  // copy is refreshed or removed. Write-back stays OFF (never passed): writing KB
  // facts back into CLAUDE.md is a deliberate, human-gated step. Best-effort — a
  // bad path must not stop the rest.
  try {
    const { results } = await ingestNativeMemory(KNOWLEDGE_DIR, { projects });
    for (const r of results) {
      if (r.ingested.length || r.refreshed.length || r.removed.length) {
        console.log(
          `[knowledge] native memory for ${r.projectId}: +${r.ingested.length} new, ` +
            `~${r.refreshed.length} refreshed, -${r.removed.length} removed`
        );
      }
    }
  } catch (err) {
    console.error(`[knowledge] native-memory ingest failed:`, err);
  }
  if (stopped()) return;

  // Reconcile docs and FTS with disk. Embedding is deferred (see above): a changed
  // doc drops its stale chunks here and the background indexer embeds it.
  await knowledgeSync.syncAll();
  if (stopped()) return;

  // Make sure the sqlite-vec KNN index covers the fully-synced corpus. A no-op
  // unless the extension loaded (see tryEnableSqliteVecExtension); when it did,
  // the persisted mirror is checked against the chunks (a count and rowid sum)
  // and rebuilt, in one blocking transaction, only when it is missing, on an
  // older schema or out of step.
  knowledgeSync.ensureVecIndex();

  await knowledgeSync.startWatching((projectId) => {
    console.log(`[knowledge] Reloaded docs for ${projectId}`);
  });
  console.log(`[knowledge] Watching ${KNOWLEDGE_DIR}`);
}

if (!EMBEDDING_PROVIDER) {
  console.log(`[knowledge] EMBEDDING_PROVIDER not set — text search only`);
}

// Multi-line text typed into a launched pane (every opening prompt, long
// replies) is staged in this private directory first; if it is unusable, those
// deliveries fail, so say so loudly at boot rather than at the first launch.
const paneDirProblem = ensurePrivateDir(paneDeliveryDir());
if (paneDirProblem) {
  console.error(
    `[launch] ERROR: the pane-delivery directory is unusable (${paneDirProblem}); launches with a multi-line opening prompt will fail until it is fixed`
  );
}

// Whether Persona will run this boot. Resolved before reconciliation so the
// idle notices of its own workers aren't re-raised as asks. Its cwd holds the
// 0600 MCP config carrying the per-boot token, so Persona refuses to start in a
// directory another user could read, write, or swap.
const personaConfig = resolvePersonaConfig();
const personaDirProblem = personaConfig.enabled ? ensurePrivateDir(PERSONA_CWD) : null;
const personaWillRun = personaConfig.enabled && !personaDirProblem;
if (personaConfig.unknownHolds.length > 0) {
  console.warn(`[persona] STANDUP_PERSONA_HOLD: ignoring ${personaConfig.unknownHolds.join(", ")} (not a holdable action)`);
}

// Reap launched sessions whose tmux pane died out-of-band. SessionEnd only
// fires on a clean Claude Code exit; a killed pane sends no hook, so without
// this its row stays active and any pending ask lingers in "Needs you"
// forever. Poll on an interval — there is no event to hang this off of.
const REAPER_INTERVAL_MS = parseInt(
  process.env.STANDUP_REAPER_INTERVAL_MS ?? "30000"
);
let resyncInFlight = false;
const reaperTimer = setInterval(() => {
  reaperTick({
    db: store.db,
    broadcast: wsBroadcast,
    unwatch: (sessionId) => tailer.unwatch(sessionId),
    // Settles silent sessions the pane shows idle, starting their next turn
    // when steers are queued; one resync at a time.
    resync: () => {
      if (resyncInFlight) return;
      resyncInFlight = true;
      void resyncStaleRunningSessions({ db: store.db, broadcast: wsBroadcast, pane: tmuxPaneDriver })
        .then((settled) => {
          if (settled.length > 0) {
            console.log(`[reaper] Resynced ${settled.length} stale running session(s) to idle: ${settled.map((id) => id.slice(0, 8)).join(", ")}`);
          }
        })
        .catch((err) => console.error(`[reaper] stale-session resync failed: ${(err as Error).message}`))
        .finally(() => {
          resyncInFlight = false;
        });
    },
  });
}, REAPER_INTERVAL_MS);

// The launch queue and the detached provisioning work both lived in the
// previous process, so launches it left `starting` would never finish: fail
// them with a reason so they can be relaunched.
for (const launch of failStrandedQueuedLaunches(store.db)) {
  wsBroadcast({ type: "launch:started", payload: launch, timestamp: new Date().toISOString() });
  console.log(`[launch-queue] Failed launch ${launch.id}: queued when the collector last stopped`);
}
for (const launch of failStrandedStartingLaunches(store.db)) {
  wsBroadcast({ type: "launch:started", payload: launch, timestamp: new Date().toISOString() });
  console.log(`[reaper] Failed launch ${launch.id}: starting when the collector last stopped`);
}
{
  const t = hostMonitor.thresholds;
  const reading = hostMonitor.metrics();
  console.log(
    reading
      ? `[host] headroom enforced: ${formatGb(t.minFreeBytes)} reserve, ` +
          `${formatGb(t.perWorkerBytes)} per worker, load ≤ ${t.maxLoadPerCore}×${reading.cores} cores`
      : "[host] headroom not enforced (no host reading on this platform, or STANDUP_HOST_HEADROOM=0)"
  );
}

// Task-run reconciliation sweep. The ledger analog of the reaper: a launched
// agent whose tmux pane dies out-of-band never self-reports, so its task-run
// row would sit `running` forever. This marks such a run `lost` once its pane
// is gone and it has been silent past the grace window. Separate from the
// reaper (which ends the session) so the dispatcher lifecycle is tracked on its
// own clock; a plain interval, same as the reaper, since there's no event to
// hang it off.
const TASK_RUN_SWEEP_INTERVAL_MS = parseInt(
  process.env.STANDUP_TASK_RUN_SWEEP_INTERVAL_MS ?? "60000"
);
const taskRunSweepTimer = setInterval(() => {
  const lost = sweepLostTaskRuns(store.db, {
    sessionExists: tmuxSessionExists,
    broadcast: wsBroadcast,
  });
  if (lost.length > 0) {
    console.log(`[task-runs] Marked ${lost.length} dead task run(s) lost`);
  }
}, TASK_RUN_SWEEP_INTERVAL_MS);

// Startup orchestration-run reconcile (one-shot). After a collector restart no
// in-process controller can have survived, so EVERY queued/running orchestration
// run is definitionally orphaned — mark them all `lost` (graceMs 0, isAlive
// false) so a run stranded by a crash cannot lock its ticket's completion choke
// forever. A `lost` run correctly keeps the choke blocked; the agent re-POSTs to
// /api/orchestration/runs to start a fresh run.
//
// Known limit: `isAlive: () => false` reaps EVERY active run unconditionally, so
// if two collectors ever shared one database this startup pass would reap a peer
// collector's live runs. Single-collector-per-DB is the assumed norm, so this is
// accepted rather than guarded.
//
// No PERIODIC orchestration-run sweep is wired: a blind interval with
// `isAlive: () => false` would false-reap two healthy states — a run legitimately
// parked at a human_pause step (the loop exits, leaving it `running` with no
// further heartbeats) and any step that genuinely runs longer than the grace —
// and the detached controller has no cheap in-process liveness probe (it is not a
// tmux session). The two proven failure modes (process restart, kick-off promise
// rejection) are covered by this startup reconcile and the POST handler's
// `.catch` -> failed. The residual (a same-process step that hangs forever
// without throwing, in a still-running collector) is a known limit, accepted
// rather than risk false reaps.
const lostOrchRuns = reconcileLostOrchestrationRuns(store.db, {
  graceMs: 0,
  isAlive: () => false,
});
if (lostOrchRuns.length > 0) {
  console.log(
    `[orchestration] Marked ${lostOrchRuns.length} orphaned orchestration run(s) lost at startup`
  );
}

// Daily-review fan-out scheduler. Like the reaper, a plain interval: once a
// day per dailyReviewActive project, spawn read-only lens agents that propose
// review tickets. Coarse-grained (poll + a per-project last-run settings key)
// because the collector isn't guaranteed to run continuously.
const reviewCronTimer = startReviewCron(store.db, { collectorPort: COLLECTOR_PORT });

// Knowledge re-verification scheduler (roadmap r5). Same seam as the review
// cron: once a day per project whose repo resolves here (and that has not opted
// out via knowledge.reverify settings or STANDUP_KNOWLEDGE_REVERIFY), record
// deterministic evidence for every doc; then, only for projects that opted into
// the model pass (knowledge.reverify_model or dailyReviewActive), re-run the
// adversarial fact-check over the most-retrieved, most-at-risk docs about the
// repo. It kicks in the background shortly after the server listens.
// Auto-injection gates on the confidence this maintains (knowledge-freshness.ts).
const knowledgeReverifyCronTimer = startKnowledgeReverifyCron(
  store.db,
  knowledgeSync,
  KNOWLEDGE_DIR,
  {
    embeddingProvider: EMBEDDING_PROVIDER,
    embeddingConfig: EMBEDDING_CONFIG,
    onContradiction: (projectId, slug, title, contradicted) =>
      emitKnowledgeChange("contradiction", projectId, slug, title, { contradicted }),
  }
);

// Nightly graph-wide contradiction sweep + backfill. Unlike the accept/reverify
// triggers, this revisits ALREADY-flagged pairs (resolving the stranded ones with
// no ledger row) and runs detection over docs those triggers never revisited.
// DEFAULT ON: it starts unless disabled by a falsy env flag
// (STANDUP_KB_NIGHTLY_SWEEP=0) or settings key (knowledge.nightly_sweep=false). The
// first full sweep spawns judge/resolver models and can spike needs-review, so it is
// internally bounded by a per-run spawn budget and a per-day gate.
let knowledgeGraphAuditCronTimer: ReturnType<typeof setInterval> | undefined;
if (
  isNightlySweepEnabled(
    process.env[NIGHTLY_SWEEP_ENV],
    getSetting(store.db, NIGHTLY_SWEEP_SETTING_KEY)
  )
) {
  knowledgeGraphAuditCronTimer = startKnowledgeGraphAuditCron(
    store.db,
    knowledgeSync,
    KNOWLEDGE_DIR,
    {
      embeddingProvider: EMBEDDING_PROVIDER,
      embeddingConfig: EMBEDDING_CONFIG,
      onContradiction: (projectId, slug, title, contradicted) =>
        emitKnowledgeChange("contradiction", projectId, slug, title, { contradicted }),
    }
  );
  console.log("[knowledge-graph-audit] nightly sweep enabled");
}

// Daily morning digest. Once a day at the configured local hour (default 9am
// EST), summarize the last ~24h of work across every project with Sonnet and
// post it to the feed (Slack + web) via the same persist-then-broadcast path the
// knowledge changes use, so it survives a reload/reconnect. DEFAULT ON — the
// env flag (STANDUP_DIGEST=0) or the settings key (digest.enabled=false)
// disables it. A per-day gate + 9am floor keep a restart from re-posting.
let digestCronTimer: ReturnType<typeof setInterval> | undefined;
if (
  isDigestEnabled(
    process.env[DIGEST_ENV],
    getSetting(store.db, DIGEST_SETTING_KEY)
  )
) {
  digestCronTimer = startDigestCron(store.db, { broadcast: wsBroadcast });
  console.log("[digest-cron] daily morning digest enabled");
}

// Self-growing knowledge distiller (roadmap r6). Same seam as the other two
// crons: once a succeeded task_run's session is detectable, a Haiku distiller
// reads its transcript and proposes an origin_class='agent' knowledge DRAFT
// through the KnowledgeBackend seam — provenance stamped, edges derived from
// touched files/projects, near-duplicates suppressed. Human accept + the
// background draft-verify pass gate quality, exactly as the interactive
// propose_knowledge path does. Gated on the same dailyReviewActive opt-in.
const distillCronTimer = startDistillCron(store.db, {
  embeddingProvider: EMBEDDING_PROVIDER,
  embeddingConfig: EMBEDDING_CONFIG,
  knowledgeDir: KNOWLEDGE_DIR,
  syncDrafts: (projectId) => knowledgeSync.syncDrafts(projectId),
  broadcast: (projectId, slug, title) => {
    wsBroadcast({
      type: "knowledge:draft",
      payload: { projectId, slug, title },
      timestamp: new Date().toISOString(),
    });
    // A newly distilled draft is the self-growing corpus learning something —
    // a substantive feed line on both surfaces alongside the sidebar nudge.
    emitKnowledgeChange("distilled", projectId, slug, title);
  },
  // Fire-and-forget adversarial fact-check, mirroring the propose handler: the
  // verdict lands on the draft the human reviews.
  verify: (projectId, slug, body, repoPath) => {
    void (async () => {
      try {
        const result = await verifyDraft(slug, body, repoPath);
        knowledgeSync.recordDraftVerdict(projectId, slug, result.verdict, result.disputes);
        wsBroadcast({
          type: "knowledge:draft",
          payload: { projectId, slug, verdict: result.verdict, disputes: result.disputes },
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        console.error(`[distill-cron] verify ${projectId}/${slug} failed:`, err);
      }
    })();
  },
});

// Live transcript-file tailer: for each active session, watch its transcript
// JSONL for growth and push a debounced session:event so a mid-turn thinking/
// prose stretch (which fires no hook) still surfaces near-live on the mirror and
// web. Hook activation/end (SessionStart/SessionEnd inside handleHookEvent)
// drives the watch set; seed it here with sessions still active across a
// restart, which never get a fresh SessionStart.
const tailer = new TranscriptTailer(store.db, wsBroadcast);
for (const session of getActiveSessions(store.db)) {
  tailer.watch(session.id);
}

// Live Codex observer: a Codex run posts no hooks, so this tails the JSONL
// sidecar its `codex exec --json` stdout is tee'd to, routes it through the
// harness adapter's parser, and creates + populates + ends its session — the
// Codex analogue of the hook + transcript path that observes a Claude session.
// Discovery is by polling the store, so a run still live across a restart is
// picked back up.
const codexObserver = new CodexObserver(store.db, wsBroadcast);
codexObserver.start();

// The per-user local write token: persisted 0600 under the collector user's home
// so this user's own agents (the MCP servers their Claude sessions spawn) read it
// and clear the gated writes tokenlessly from the user's point of view, while
// remote tunnel/network callers and other OS users still need STANDUP_WRITE_TOKEN.
// A failure to persist it leaves the gate exactly as strict as without it.
let localWriteToken: string | undefined;
try {
  const tokenPath = localWriteTokenPath();
  localWriteToken = ensureLocalWriteToken(tokenPath);
  setLocalWriteToken(localWriteToken);
  console.log(`[collector] Local write token at ${tokenPath}`);
} catch (err) {
  console.warn(`[collector] Could not persist the local write token: ${(err as Error).message}`);
}

// Persona, the always-on orchestrator: one per user (PersonaFleet), the host's
// built now and a guest's on their first Persona request. Each runtime's turns
// are headless `claude -p` runs in a reserved internal cwd of its own whose
// persona-mode MCP proxy calls back into this collector with that runtime's
// per-boot token; one listener on the tap fans frames out to every runtime.
let personaFleet: PersonaFleet | undefined;
let persona: PersonaRuntime | undefined;
if (personaWillRun) {
  const loopbackHost =
    !BIND_HOST || BIND_HOST === "0.0.0.0" || BIND_HOST === "::" ? "127.0.0.1" : BIND_HOST;
  const stubTurns = stubTurnsEnabled(process.env, join(homedir(), ".local", "share", "standup", "standup.db"));
  if (stubTurns) console.warn(`[persona] ${PERSONA_STUB_TURNS_ENV}=1: every turn answers with a scripted reply; no claude runs`);
  else if (process.env[PERSONA_STUB_TURNS_ENV] === "1") {
    console.warn(`[persona] Ignoring ${PERSONA_STUB_TURNS_ENV}=1: scripted turns run only on a collector with its own DB_PATH`);
  }
  personaFleet = new PersonaFleet({
    db: store.db,
    host: resolveUserAlias(undefined),
    maxUsers: personaConfig.maxUsers,
    maxConcurrentTurns: personaConfig.maxConcurrentTurns,
    create: (alias, shared) => {
      const personaToken = randomBytes(32).toString("hex");
      const cwd = personaTurnCwd(PERSONA_CWD, alias, shared.host);
      const cwdProblem = alias === shared.host ? null : ensurePrivateDir(cwd);
      if (cwdProblem) console.warn(`[persona] ${alias}'s turns will fail: ${cwdProblem}`);
      return new PersonaRuntime({
        db: store.db,
        owner: alias,
        host: shared.host,
        turnSlots: shared.turnSlots,
        turnCwd: cwd,
        config: personaConfig,
        dataDir: dirname(DB_PATH),
        broadcast: wsBroadcast,
        board,
        consoleUrl: consoleBaseUrlFromEnv(process.env),
        token: personaToken,
        writeToken: localWriteToken,
        ...(personaConfig.allowCheckModelEnabled
          ? {
              allowChecker: claudeAllowChecker({
                model: personaConfig.allowCheckModel,
                timeoutMs: personaConfig.allowCheckTimeoutMs,
              }),
            }
          : {}),
        turnRunner: stubTurns
          ? createStubTurnRunner()
          : createClaudeTurnRunner({
              cwd,
              collectorUrl: `http://${loopbackHost}:${COLLECTOR_PORT}`,
              token: personaToken,
            }),
        // Each delegate lane runs in a directory of its own, so its MCP
        // config (carrying the lane's token) never meets the main turn's.
        delegateRunner: (agent, token) =>
          stubTurns
            ? createStubTurnRunner()
            : createClaudeTurnRunner({
                cwd: delegateTurnCwd(cwd, agent.id),
                collectorUrl: `http://${loopbackHost}:${COLLECTOR_PORT}`,
                token,
              }),
      });
    },
  });
  persona = personaFleet.hostRuntime();
  wsBroadcastTap.subscribe(personaFleet.eventListener());
} else if (personaDirProblem) {
  console.warn(`[persona] Not started: ${personaDirProblem}`);
} else {
  console.log("[persona] Disabled (STANDUP_PERSONA=0)");
}

const codeSymbolStore = new KnowledgeStore(store.db);
const codeSymbolIndexer = new CodeSymbolIndexer({
  db: store.db,
  store: codeSymbolStore,
  // Read per pass rather than captured, so a project registered through the UI
  // after boot gets indexed without a restart.
  projects: () => getProjects(store.db),
  // Re-resolve each indexed project's doc→code mentions against the new HEAD
  // index in the background, so the search path rarely has any to redo.
  onPass: (outcomes) =>
    refreshProjectsCodeMentions(
      codeSymbolStore,
      outcomes.filter((o) => o.mode !== "skipped").map((o) => o.projectId)
    ),
});

// Restarts of this collector (Persona's restart_standup): the service hands a
// restart to a detached supervisor, and on boot reports a finished one to
// Persona and records this commit as known-good (the rollback target).
const restartLoopbackHost =
  !BIND_HOST || BIND_HOST === "0.0.0.0" || BIND_HOST === "::" ? "127.0.0.1" : BIND_HOST;
const restart = new RestartService({
  db: store.db,
  owner: resolveUserAlias(undefined),
  dataDir: dirname(DB_PATH),
  installDir: INSTALL_DIR,
  // The known-good record names the commit this process loaded, not the checkout's HEAD now.
  loadedHead: LOADED_HEAD,
  collectorUrl: `http://${restartLoopbackHost}:${COLLECTOR_PORT}`,
  uiUrl: process.env.STANDUP_WEB_URL?.trim() || undefined,
  exec: createSystemExec(),
  // A restart holds every user's Persona; its report goes to the host's, which asked for it.
  persona:
    personaFleet && persona
      ? {
          quiesce: (timeoutMs) => personaFleet!.quiesce(timeoutMs),
          release: () => personaFleet!.release(),
          enqueue: (kind, payload, opts) => persona!.enqueue(kind, payload, opts),
          noteInstallAdvanced: (head) => persona!.noteInstallAdvanced(head),
        }
      : undefined,
  // A turn in flight runs to its own timeout before the collector stops, so
  // its `claude -p` is never orphaned mid-turn.
  quiesceTimeoutMs: personaConfig.turnTimeoutMs + 30_000,
  orphanedAsks,
  // Authorizes the redeploy hook's restart requests (scripts/standup-redeploy.ts).
  writeToken: localWriteToken,
});

// What /health reports beside the pid; bootMs is filled in once listening.
const health: CollectorHealth = {
  slot: COLLECTOR_SLOT,
  epoch: leadership.epoch,
  head: LOADED_HEAD,
  startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
};

// Whether the public knowledge listener is serving, as the owner's console
// reports it; set once its start resolves below.
let publicKbStatus: PublicKnowledgeListenerStatus = { enabled: false };
// Review tunnels to branch builds: opened by the pipeline's screenshot stage,
// swept every minute and reconciled now and nightly (stale and leaked ones).
const reviewTunnels = createReviewTunnels(
  store.db,
  createReviewTunnelSystem(join(standupDataDir(), "review-tunnels")),
  wsBroadcast
);
const stopReviewTunnelMaintenance = startReviewTunnelMaintenance(reviewTunnels);
// Worker hygiene: the scratch-root tmpfs check, the 6-hourly scratch sweep and,
// now and every 10 minutes, the hygiene backstop, the orphan sweep and the reap
// of hand-opened tunnels of finished launches' leftover processes.
const processSystem = createProcessSystem();
const stopWorkerHygieneMaintenance =
  process.env.NODE_ENV === "test"
    ? () => {}
    : startWorkerHygieneMaintenance(store.db, processSystem, { installDir: INSTALL_DIR, broadcast: wsBroadcast });
// A paused worker whose job is already closed gets that job's hygiene.
const hygieneAfterPause = closedJobHygieneStep(store.db, processSystem, { installDir: INSTALL_DIR, broadcast: wsBroadcast });
// Startup reconcile (one-shot): a worker still marked paused whose pane is up
// (a restart landed mid-pause or mid-respawn) is adopted as resumed.
try {
  const adopted = adoptLiveReapedPanes(store.db, { broadcast: wsBroadcast, watch: (id) => tailer.watch(id) });
  if (adopted.length > 0) console.log(`[launch-resume] adopted ${adopted.length} paused worker(s) whose pane is still up`);
} catch (err) {
  console.error("[launch-resume] startup reconcile of paused workers failed:", err);
}

// Create HTTP server for Claude Code hooks
const server = createServer(
  store,
  wsBroadcast,
  EMBEDDING_PROVIDER,
  knowledgeSync,
  registry,
  KNOWLEDGE_DIR,
  ICONS_DIR,
  EMBEDDING_CONFIG,
  undefined,
  tailer,
  undefined, // launchFn -> default (launchSession)
  identityConfig,
  { fleet: personaFleet, restart },
  undefined, // knowledgeQuality -> defaults
  { health, drain: processDrain },
  undefined, // pipelineOverrides -> defaults
  undefined, // review -> defaults
  { listenerStatus: () => publicKbStatus },
  reviewTunnels,
  board
);
personaFleet?.start();

// Pause launched workers that sit idle at their prompt past the threshold, to
// free the host (idle-reaper.ts); the next message to one resumes it. On the
// reaper's interval; a tick still running skips the next.
const idleReaper = createIdleReaper(store.db, {
  pane: tmuxPaneDriver,
  broadcast: wsBroadcast,
  stop: async (session, launch, reason) => {
    const stopped = await stopSession(store.db, { broadcast: wsBroadcast, unwatch: (id) => tailer.unwatch(id) }, session, launch, { reapReason: reason });
    if (!stopped.ok) throw new Error(stopped.log.join("; "));
    hygieneAfterPause(launch);
  },
  post: (job, text) => {
    personaFleet?.get(job.owner)?.postMessage({ threadId: job.threadId, role: "system", text, jobIds: [job.id] });
  },
  wake: (sessionId) => wakeForQueued(store.db, sessionId, { broadcast: wsBroadcast, watch: (id) => tailer.watch(id), afterNotLive: hygieneAfterPause }),
});
{
  const t = idleReapThresholds();
  console.log(
    t.enabled
      ? `[idle-reaper] pausing idle workers after ${formatIdle(t.idleMs)} (${formatIdle(t.closedJobMs)} once their job is closed)`
      : "[idle-reaper] disabled (STANDUP_IDLE_REAP=0)"
  );
}
const idleReaperTimer = setInterval(() => {
  void idleReaper
    .tick()
    .then((paused) => {
      if (paused.length > 0) {
        console.log(`[idle-reaper] Paused ${paused.length} idle worker(s): ${paused.map((p) => p.session.id.slice(0, 8)).join(", ")}`);
      }
    })
    .catch((err) => console.error(`[idle-reaper] tick failed: ${(err as Error).message}`));
}, REAPER_INTERVAL_MS);
// Deferred so the server is listening when the service probes its own /health.
const restartPickup = new Promise<void>((resolve) => {
  setTimeout(() => void restart.onCollectorReady().finally(resolve), 2_000);
});
if (personaFleet) {
  const guests = personaFleet.all().filter((r) => !r.isHost).map((r) => r.owner);
  console.log(
    `[persona] Running for ${personaFleet.host}${guests.length > 0 ? ` and ${guests.join(", ")}` : ""} (model ${personaConfig.model})`
  );
}

// Settle runs sitting at a stage that can't apply to their launch — a
// code_review stage on a project with no code review to cut. Entering such a stage skips
// it, but a run already at one when the collector starts (or whose project
// changed since) is swept here rather than left waiting on the owner. The
// sweep only skips stages and enters the next one, so it never runs an
// acceptance criterion or takes a screenshot.
void settleNotApplicableRuns(store.db, {
  broadcast: wsBroadcast,
  checkpoint: (sessionId, text) => {
    if (!getSession(store.db, sessionId)) return;
    const checkpoint = createCheckpoint(store.db, sessionId, "structural", text);
    wsBroadcast({ type: "checkpoint:new", payload: checkpoint, timestamp: new Date().toISOString() });
  },
  changedFiles: gitChangedFiles,
  headState: gitHeadState,
  validateScreenshot: (path) => validateScreenshotPath(path),
  screenshots: screenshotStore(pipelineScreenshotsDir(standupDataDir())),
  runCriterion: async () => null,
  runCheck: async () => ({ met: false, output: "checks don't run during the startup sweep" }),
  // The same data dir createServer resolves for review media, so a brief the sweep writes names the scratch dir the server accepts.
  reviewScratchDir: (launchId) =>
    reviewScratchDirFor(personaFleet?.hostRuntime()?.dataDir ?? standupDataDir(), launchId),
})
  .then((moved) => {
    if (moved > 0) console.log(`[pipeline] settled ${moved} run(s) at a stage that doesn't apply to their launch`);
  })
  .catch((err) => console.error("[pipeline] settling not-applicable stages failed:", err))
  // Then runs blocked before blocks went to Persona — their jobs left
  // waiting on the owner — are handed to their owner's Persona to decide.
  // Nothing is waived or advanced.
  .then(() => {
    // Only an owner whose Persona runs here and can act now (started, not
    // paused, its last turn not failed) can decide; anyone else's job keeps
    // waiting on them.
    const handed = routeLegacyBlocksToPersona(store.db, { broadcast: wsBroadcast }, (owner) => !!personaFleet?.get(owner)?.canAct());
    if (handed > 0) console.log(`[pipeline] handed ${handed} blocked run(s) to Persona`);
  })
  .catch((err) => console.error("[pipeline] handing blocked runs to Persona failed:", err));

// Re-derive blocked state from stored events. Blocking is otherwise only
// noticed as a Notification arrives, so an agent that was already waiting
// when the collector restarted would stay invisible indefinitely.
// A Persona takes its workers' idle notices only if that worker's Persona
// (its job owner's) runs on this collector and can act; otherwise they surface
// to the human as usual. Decided once the fleet has started, so a stored
// owner left without a runtime (an invalid alias, past maxUsers) is skipped.
const personaSkippedOwners = new Set<string>();
const personaWillAct = (sessionId: string): boolean => {
  const owner = personaJobForSession(store.db, sessionId)?.job.owner;
  if (!owner || !personaFleet) return false;
  const runtime = personaFleet.get(owner);
  if (!runtime && !personaSkippedOwners.has(owner)) {
    personaSkippedOwners.add(owner);
    console.warn(
      `[reconcile] ${JSON.stringify(owner)}'s workers surface to the human: no Persona runs for them (${personaFleet.unavailableReason(owner) ?? "not started"})`
    );
  }
  return !!runtime?.canAct();
};
const reblocked = reconcileBlockedSessions(store.db, {
  personaOwned: personaFleet ? personaWillAct : undefined,
});
if (reblocked.length > 0) {
  console.log(
    `[reconcile] ${reblocked.length} launched session(s) still waiting on you`
  );
}

// The asks reconciliation re-raised go out only now that Persona is running
// and its event router listens on the tap: an ask on one of its workers'
// sessions reaches its inbox and is marked as Persona's, the rest surface to
// the owner as usual.
for (const ask of reblocked) {
  wsBroadcast(
    withPersonaHandled(
      { type: "ask:new", payload: ask, timestamp: new Date().toISOString() },
      (sessionId) => {
        const owner = personaJobForSession(store.db, sessionId)?.job.owner;
        return !!owner && !!personaFleet?.get(owner)?.canAct();
      },
      () => undefined
    )
  );
}

const httpServer = Bun.serve({
  port: LISTEN_PORT,
  hostname: BIND_HOST,
  fetch: server.fetch,
  // Disable Bun's 10s default request idle-timeout. /api/ask holds the response
  // open for the whole ask_human wait (waitForAskResolution, up to 3600s) while
  // polling SQLite and writing nothing until it resolves — the 10s default was
  // silently killing that long-poll, severing the blocked agent's connection and leaving the ask row pending.
  idleTimeout: 0,
});

console.log(
  `[collector] Listening on http://${BIND_HOST}:${LISTEN_PORT}` +
    (LISTEN_PORT !== COLLECTOR_PORT ? ` (public port ${COLLECTOR_PORT})` : "")
);
// The public knowledge API, for teammates over a tunnel: on only with
// STANDUP_PUBLIC_KB=1, and only on a Unix socket in a directory private to this
// user — never on a TCP port.
const publicKbServer = await (async () => {
  if (!publicKnowledgeEnabled()) return null;
  const socketPath = publicKnowledgeSocketPath(dirname(DB_PATH));
  try {
    const { server: listener, status } = await startPublicKnowledgeListener({
      socketPath,
      managedDir: !process.env.STANDUP_PUBLIC_KB_SOCKET?.trim(),
      fetch: server.publicKnowledgeApp.fetch,
    });
    publicKbStatus = status;
    if (listener) {
      console.log(`[public-kb] Listening on unix:${socketPath}`);
      console.log(
        `[public-kb] Put an authenticating tunnel or reverse proxy in front of unix:${socketPath} that strips any client copy of the ${publicIdentityHeader()} header (${PUBLIC_KB_IDENTITY_HEADER_ENV}) and stamps the caller's alias in it`
      );
    }
    return listener;
  } catch (err) {
    console.error(`[public-kb] Not listening on ${socketPath}:`, err);
    publicKbStatus = { enabled: false, socketPath, error: String(err) };
    return null;
  }
})();

// Bun.serve has bound the HTTP port by the time it returns, so the socket can
// take the connections it has been turning away.
httpListening = true;
console.log("[ws] Accepting connections");
// The part of a restart's gap this process accounts for: from taking the
// leader lock to both servers listening. Reported in /health for the restart
// supervisor's report.
health.bootMs = Date.now() - leadership.acquiredAt.getTime();
console.log(`[collector] Boot after the leader lock took ${health.bootMs}ms`);

// The Board's startup reconcile is a synchronous pass over every job, ticket
// and backlog item. It runs once the servers listen and no hello-ok snapshot
// is being built, so the consoles reconnecting after a restart get theirs
// first: a snapshot build awaits file reads, and a reconcile that ran in one
// of those gaps would hold its hello-ok until the pass ended. A steady stream
// of connections delays it by at most BOARD_RECONCILE_MAX_WAIT_MS. The
// board:task frames it publishes reach whoever connected meanwhile.
const BOARD_RECONCILE_MAX_WAIT_MS = 5_000;
const boardReconcileDue = Date.now() + BOARD_RECONCILE_MAX_WAIT_MS;
const reconcileBoardWhenIdle = (): void => {
  if (snapshotsBuilding > 0 && Date.now() < boardReconcileDue) {
    setTimeout(reconcileBoardWhenIdle, 25);
    return;
  }
  try {
    boardAdapter.reconcile();
  } catch (err) {
    console.error("[board] reconcile failed:", err);
  }
};
setTimeout(reconcileBoardWhenIdle, 0);

// Sync the knowledge corpus with disk, then check the embedding space against
// the stored index (a provider, model, digest or chunker change, or canary
// drift) and embed whatever the index lacks, all in the background so serving
// never waits on them or on the embedding provider. Started only once the
// restart pickup has settled — after a restart that is when its supervisor
// finished health-checking this collector — or, at the latest, once the
// supervisor's Persona, UI and gateway check budget has passed, so the sync's
// synchronous stretches don't starve the boot's health checks.
const restartTimings = timingsFromEnv();
const KNOWLEDGE_SYNC_MAX_DELAY_MS = 2_000 + restartTimings.personaTimeoutMs + restartTimings.uiTimeoutMs + restartTimings.gatewayTimeoutMs;
void Promise.race([restartPickup, Bun.sleep(KNOWLEDGE_SYNC_MAX_DELAY_MS)])
  // Once-per-version corpus clean-up (knowledge-maintenance.ts) runs only over a
  // corpus the sync completed; never throws.
  .then(() =>
    syncCorpusThenMaintain({
      sync: syncKnowledgeCorpus,
      maintain: () => runBootKnowledgeMaintenance(store.db, knowledgeSync, KNOWLEDGE_DIR),
      draining: () => processDrain.draining,
    })
  )
  .then(() => {
    if (!processDrain.draining) void knowledgeSync.startBackgroundIndexing();
  });
// Index each project's repo symbols and file paths at its current HEAD, in the
// background for the same reason: it shells out to git per project, and nothing
// serving a request waits on it.
void codeSymbolIndexer.start();
console.log(`[collector] Ready to receive Claude Code hooks`);

// How long in-flight requests get to finish once the listener has stopped.
const DRAIN_TIMEOUT_MS = 5_000;

// Graceful shutdown, on Ctrl+C and on the SIGTERM a restart (or dev.ts) sends.
// Drain first: new requests are refused and long waits released (both 503s the
// gateway and the MCP client know to retry), WS clients are told the service is
// restarting, and in-flight requests get DRAIN_TIMEOUT_MS before the teardown.
// A repeat signal within a second of the first is the same request (Ctrl+C
// reaches the whole process group, then dev.ts relays a SIGTERM); a later one
// while draining exits at once.
const classifySignal = shutdownSignalGate();
const inFlight = () => httpServer.pendingRequests + (publicKbServer?.pendingRequests ?? 0) + processDrain.pendingTasks;
const shutdown = async () => {
  console.log("\n[collector] Draining...");
  processDrain.begin();
  // No deferred redeploy or restart watcher fires mid-drain.
  restart.stop();
  // Persona's running turns die with the drain's start rather than its end:
  // every tool call they make from here is refused, so running on gains
  // nothing. The fleet is held first so no wake timer, follow-up drain or
  // scheduled run starts a new turn in their place. Killed with their
  // process groups, so none reaches the next leader; their items go back to
  // pending, no attempt counted, and replay there.
  personaFleet?.hold();
  personaFleet?.killTurns();
  httpServer.stop(false);
  publicKbServer?.stop(false);
  const wsClosed = wsServer.close(WS_CLOSE_SERVICE_RESTART);
  const idle = await waitForIdle(inFlight, DRAIN_TIMEOUT_MS);
  await wsClosed;
  if (!idle) console.log(`[collector] ${inFlight()} request(s) or task(s) still in flight after ${DRAIN_TIMEOUT_MS}ms; stopping anyway`);
  console.log("[collector] Shutting down...");
  clearInterval(reaperTimer);
  clearInterval(idleReaperTimer);
  clearInterval(taskRunSweepTimer);
  clearInterval(reviewCronTimer);
  clearInterval(knowledgeReverifyCronTimer);
  if (knowledgeGraphAuditCronTimer) clearInterval(knowledgeGraphAuditCronTimer);
  if (digestCronTimer) clearInterval(digestCronTimer);
  clearInterval(distillCronTimer);
  stopReviewTunnelMaintenance();
  stopWorkerHygieneMaintenance();
  boardAdapter.stop();
  personaFleet?.stop();
  tailer.stop();
  codexObserver.stop();
  knowledgeSync.stopWatching();
  knowledgeSync.stopBackgroundIndexing();
  codeSymbolIndexer.stop();
  store.close();
  process.exit(0);
};
const onSignal = (signal: NodeJS.Signals) => {
  const action = classifySignal();
  if (action === "ignore") {
    console.log(`[collector] ${signal} while draining; already shutting down`);
    return;
  }
  if (action === "force") {
    console.log(`[collector] Repeated shutdown signal (${signal}); exiting now`);
    personaFleet?.killTurns();
    process.exit(1);
  }
  void shutdown().catch((err) => {
    console.error("[collector] Shutdown failed:", err);
    personaFleet?.killTurns();
    process.exit(1);
  });
};
process.off("SIGINT", onBootSignal);
process.off("SIGTERM", onBootSignal);
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);
