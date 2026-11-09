import { homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { writeFileSync, mkdirSync } from "fs";
import type { Database } from "bun:sqlite";
import {
  getProjects,
  getSetting,
  setSetting,
  getOpenTicketsByProjectLens,
} from "@standup/store";
import { REVIEW_LENSES, DEFAULT_COLLECTOR_PORT } from "@standup/shared";
import type { Project } from "@standup/shared";
import { ensureInternalCwd, internalRoot } from "./internal-cwd.js";
import { headlessSettingsArgs } from "./claude-cli.js";
import { withoutSlotEnv } from "./worker-env.js";
import { deferForHostPressure } from "./host-headroom.js";

/**
 * Daily-review fan-out + scheduler.
 *
 * Once a day, for every project with `dailyReviewActive`, a set of read-only
 * "lens" agents each do one adversarial pass over the code and — if and only
 * if they find something worth a human's time — call `propose_ticket`, which
 * lands a ticket in the kanban's proposed column. Nobody's change is edited;
 * these are pure reviewers.
 *
 * The scheduler is a plain interval, wired in index.ts exactly like the
 * reaper's setInterval. It is deliberately coarse (30 min poll, once-per-day
 * gate keyed on a settings row) rather than a real cron: the collector is a
 * local-first process that may not run continuously, so "has today's run
 * happened yet?" is the honest question, not "fire at 09:00".
 */

const REVIEW_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_INTERVAL_MS = 1_800_000; // 30 min
const REVIEW_TIMEOUT_MS = 8 * 60 * 1000; // per-lens agent cap
/** Max review agents in flight across all projects/lenses at once. */
const MAX_CONCURRENT = 4;

/**
 * The reserved cwd every review agent runs from — never a real checkout.
 * Standup's hooks are global (see internal-cwd.ts), so a subprocess running
 * inside the repo would register as an ordinary session and feed its own
 * events back to the collector. It is handed the repo via --add-dir and works
 * with absolute paths from here instead. Lives under the reserved internal
 * root so isInternalCwd() covers it.
 */
const REVIEW_CRON_CWD = join(internalRoot(), "review");

/** Today as a local ISO date (YYYY-MM-DD), matching the settings-key value. */
function todayLocalIso(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function lastRunKey(projectId: string): string {
  return `daily_review_last_run:${projectId}`;
}

/** `project.repos[0]` with `~` expanded, or null when the project has no repo. */
function primaryRepoPath(project: Project): string | null {
  const repo = project.repos[0];
  return repo ? repo.replace(/^~/, homedir()) : null;
}

/** Absolute path to packages/mcp/src/index.ts, resolved from this module. */
function mcpEntrypoint(): string {
  // this file: packages/collector/src/review-cron.ts
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "mcp", "src", "index.ts");
}

function lensPrompt(project: Project, lens: string, openTitles: string[]): string {
  const openList =
    openTitles.length > 0
      ? openTitles.map((t) => `- ${t}`).join("\n")
      : "(none)";
  return `You are a senior reviewer doing a \`${lens}\` pass over the code in the added directory (project \`${project.id}\`). Find the single highest-value \`${lens}\` issue.

If and only if you find one worth a human's time, call \`propose_ticket\` with projectId=\`${project.id}\`, lens=\`${lens}\`, a specific title, a concise markdown body (what / where / why / suggested fix), and a severity (low, medium, high, or critical). File at most ONE ticket. If nothing is worth reporting, file nothing and just exit. Do not edit anything — you are read-only.

Already-open ${lens} issues for this project (do NOT duplicate these):
${openList}`;
}

interface ReviewCronOptions {
  /** Poll interval; env STANDUP_REVIEW_INTERVAL_MS overrides. */
  intervalMs?: number;
  /** Port the collector (and thus the MCP server) talks to. */
  collectorPort?: number;
}

/**
 * A dead-simple in-flight counter so a machine with many active projects can't
 * spawn dozens of `claude` processes at once. Lenses that can't get a slot are
 * skipped this tick and returned as deferred; the project's once-per-day gate
 * stays open until none are, so they run on the next poll.
 */
let inFlight = 0;

/** Runs one project×lens review; the real one spawns a headless agent. */
export type LensRunner = (
  project: Project,
  lens: string,
  repoPath: string,
  mcpConfigPath: string,
  openTitles: string[]
) => Promise<void>;

/**
 * Lenses that already ran today, per project. In memory only: it exists so a
 * project whose day stays open (deferred lenses) re-runs just the deferred
 * ones, not the whole set. A restart while a day is still open loses it, so
 * the lenses that already ran that day run again (the open-ticket dedup still
 * applies).
 */
export type RanTodayState = Map<string, { day: string; lenses: Set<string> }>;

const ranToday: RanTodayState = new Map();

export interface TickDeps {
  runLens?: LensRunner;
  /** Clock; the day gate is its local ISO date. */
  now?: () => Date;
  /** The candidate project list; filtered to dailyReviewActive by tick. */
  projects?: (db: Database) => Project[];
  state?: RanTodayState;
}

/**
 * Spawn ONE headless review agent for a project×lens. Read-only tools plus the
 * standup MCP server (re-added explicitly — see the gotcha below). Resolves
 * when the agent exits or is killed by the timeout; never throws.
 */
async function runLensAgent(
  project: Project,
  lens: string,
  repoPath: string,
  mcpConfigPath: string,
  openTitles: string[]
): Promise<void> {
  const proc = Bun.spawn(
    [
      "claude",
      "-p",
      lensPrompt(project, lens, openTitles),
      "--model",
      REVIEW_MODEL,
      "--add-dir",
      repoPath,
      // Non-interactive: nobody is here to answer a prompt. Same trust level
      // as draft-verify — the user's own tooling on the user's own machine,
      // narrowed by the read-only tool list below.
      "--permission-mode",
      "bypassPermissions",
      // Drop the `user` setting source so global hooks never fire — otherwise
      // this subprocess registers as a phantom session in Standup's own feed.
      "--setting-sources",
      "project",
      ...headlessSettingsArgs(),
      // THE CRITICAL GOTCHA: --setting-sources project (and --strict-mcp-config)
      // DROPS the MCP server registration that normally comes from the user
      // source. Without re-adding it here, propose_ticket does not exist and
      // the agent can find an issue but has no way to file it. So we re-inject
      // ONLY the standup server via an explicit mcp-config, and allow just its
      // one write tool.
      "--mcp-config",
      mcpConfigPath,
      "--strict-mcp-config",
      "--allowedTools",
      "Read,Grep,Glob,mcp__standup__propose_ticket",
      "--output-format",
      "json",
    ],
    { cwd: REVIEW_CRON_CWD, stdout: "pipe", stderr: "pipe", env: withoutSlotEnv() }
  );

  const timer = setTimeout(() => proc.kill(), REVIEW_TIMEOUT_MS);
  try {
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    if (proc.exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      console.error(
        `[review-cron] ${project.id}/${lens} exited ${proc.exitCode}: ${stderr.slice(-500)}`
      );
      return;
    }
    console.log(
      `[review-cron] ${project.id}/${lens} completed: ${stdout.slice(0, 200)}`
    );
  } catch (err) {
    console.error(`[review-cron] ${project.id}/${lens} failed:`, err);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run the fan-out for a single project: one read-only agent per lens, deduped
 * against already-open tickets for that project+lens, bounded by MAX_CONCURRENT.
 * Lenses in `skip` (already run today) are left out. Returns the lenses that
 * could not get a slot and were deferred to the next tick.
 */
export async function runProjectFanOut(
  db: Database,
  project: Project,
  mcpConfigPath: string,
  runLens: LensRunner = runLensAgent,
  skip: ReadonlySet<string> = new Set(),
  onRan: (lens: string) => void = () => {}
): Promise<string[]> {
  const repoPath = primaryRepoPath(project);
  if (!repoPath) {
    console.log(`[review-cron] ${project.id}: no repo configured, skipping`);
    return [];
  }

  const lenses = project.reviewLenses ?? [...REVIEW_LENSES];

  const deferred: string[] = [];
  const pending: Promise<void>[] = [];
  for (const lens of lenses) {
    if (skip.has(lens)) continue;
    // Dedup: don't re-propose while an issue for this project+lens is still
    // open (proposed/approved/developing/needs_review). Pass the open titles
    // into the prompt so the agent doesn't re-file a near-duplicate either.
    const openTickets = getOpenTicketsByProjectLens(db, project.id, lens);
    if (openTickets.length > 0) {
      console.log(
        `[review-cron] ${project.id}/${lens}: open ticket exists, skipping`
      );
      continue;
    }
    if (inFlight >= MAX_CONCURRENT) {
      console.log(
        `[review-cron] concurrency cap (${MAX_CONCURRENT}) reached; ${project.id}/${lens} deferred to next tick`
      );
      deferred.push(lens);
      continue;
    }
    inFlight++;
    onRan(lens);
    const openTitles = openTickets.map((t) => t.title);
    // Promise.resolve().then turns a synchronous throw into a rejection, so
    // the slot is always released.
    const p = Promise.resolve()
      .then(() => runLens(project, lens, repoPath, mcpConfigPath, openTitles))
      .finally(() => {
        inFlight--;
      });
    pending.push(p);
  }

  await Promise.allSettled(pending);
  return deferred;
}

/**
 * One scheduler tick: for every dailyReviewActive project whose last run is
 * not today, run the fan-out and record today's date once no lens is left
 * deferred.
 */
export async function tick(
  db: Database,
  mcpConfigPath: string,
  deps: TickDeps = {}
): Promise<void> {
  const runLens = deps.runLens ?? runLensAgent;
  const state = deps.state ?? ranToday;
  const today = todayLocalIso((deps.now ?? (() => new Date()))());
  const projects = (deps.projects ?? getProjects)(db).filter((p) => p.dailyReviewActive);

  for (const project of projects) {
    const key = lastRunKey(project.id);
    if (getSetting(db, key) === today) continue;
    let entry = state.get(project.id);
    if (!entry || entry.day !== today) {
      entry = { day: today, lenses: new Set() };
      state.set(project.id, entry);
    }
    const ran = entry.lenses;
    let deferred: string[] = [];
    try {
      deferred = await runProjectFanOut(db, project, mcpConfigPath, runLens, ran, (lens) =>
        ran.add(lens)
      );
    } catch (err) {
      console.error(`[review-cron] ${project.id} fan-out failed:`, err);
    }
    // Leave the day open while lenses are waiting for a slot. Otherwise
    // record it — a lens or fan-out failure is not fatal, and we don't want a
    // single bad project re-firing every poll for the rest of the day.
    if (deferred.length > 0) continue;
    setSetting(db, key, today);
    // An overlapping tick that started after midnight may have replaced the
    // entry with the new day's; that one is not ours to clear.
    if (state.get(project.id) === entry) state.delete(project.id);
  }
}

/**
 * Write the temp mcp-config exposing ONLY the standup server, pointed at this
 * collector. Returns its absolute path.
 */
function writeMcpConfig(collectorPort: number): string {
  const dir = ensureInternalCwd(REVIEW_CRON_CWD);
  const mcpConfig = {
    mcpServers: {
      standup: {
        command: "bun",
        args: ["run", mcpEntrypoint()],
        env: { COLLECTOR_URL: `http://localhost:${collectorPort}` },
      },
    },
  };
  const path = join(dir, "mcp-config.json");
  writeFileSync(path, JSON.stringify(mcpConfig, null, 2));
  return path;
}

/**
 * Start the daily-review scheduler. Returns the interval timer so the caller
 * can clearInterval it on shutdown, mirroring the reaper.
 */
export function startReviewCron(
  db: Database,
  opts: ReviewCronOptions = {}
): ReturnType<typeof setInterval> {
  const intervalMs =
    opts.intervalMs ??
    parseInt(process.env.STANDUP_REVIEW_INTERVAL_MS ?? String(DEFAULT_INTERVAL_MS));
  const collectorPort =
    opts.collectorPort ??
    parseInt(process.env.COLLECTOR_PORT ?? String(DEFAULT_COLLECTOR_PORT));

  mkdirSync(REVIEW_CRON_CWD, { recursive: true });
  const mcpConfigPath = writeMcpConfig(collectorPort);

  // Fire soon after startup (not synchronously — let the server bind first),
  // then on the interval.
  const kick = () => {
    // Lens agents are worker-sized processes; a host short on headroom skips
    // this poll, and the once-a-day gate runs the review on a later one.
    if (deferForHostPressure("review-cron")) return;
    tick(db, mcpConfigPath).catch((e) => console.error("[review-cron]", e));
  };
  setTimeout(kick, 5_000);
  return setInterval(kick, intervalMs);
}
