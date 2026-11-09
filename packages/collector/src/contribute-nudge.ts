import type { Database } from "bun:sqlite";
import {
  getContributeNudgeFacts,
  getLaunchBySession,
  getPendingAsksBySession,
  getPlanApprovalByLaunch,
  getProject,
  recordContributeNudge,
} from "@standup/store";
import { launchCarriesKnowledgeSteering } from "./launcher.js";

/**
 * Stop-hook contribution nudge. When a launched worker that edited files tries
 * to end its turn without ever calling propose_knowledge, the Stop hook blocks
 * the stop once with a short reminder to contribute; the agent then either
 * proposes or simply stops again. On by default; STANDUP_CONTRIBUTE_NUDGE=0
 * turns it off.
 *
 * Fires at most once per session: the nudge is recorded as an `events` row,
 * so the once-only guard survives a collector restart and the knowledge-usage
 * metric can tell nudged sessions apart.
 */

export const CONTRIBUTE_NUDGE_REASON =
  "Before you finish: if this work taught you something durable and non-obvious (a gotcha, a decision and its " +
  "reason, a convention), call propose_knowledge — update an existing doc's slug if one covers it; no status " +
  "reports. If nothing qualifies, just stop.";

/** Edits below this count read as exploration, which rarely yields a durable finding. */
export const CONTRIBUTE_NUDGE_MIN_EDITS = 3;

export function isContributeNudgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.STANDUP_CONTRIBUTE_NUDGE !== "0";
}

/**
 * The Stop hook output that blocks the stop with the contribute reminder, or
 * null when the session doesn't qualify. Records the nudge when it returns one.
 *
 * Qualifies only a session started by a Standup launch that carries the
 * knowledge-first steering (launchCarriesKnowledgeSteering) and has made at least
 * {@link CONTRIBUTE_NUDGE_MIN_EDITS} edits and no propose_knowledge call
 * (subagents included), is not already continuing from a Stop hook, is not
 * waiting on a pending ask or plan approval, and has not been nudged before.
 *
 * Never throws: an optional nudge must not break Stop handling.
 */
export function maybeContributeNudge(
  db: Database,
  sessionId: string,
  stopHookActive: boolean,
  env: NodeJS.ProcessEnv = process.env
): { decision: "block"; reason: string } | null {
  if (!isContributeNudgeEnabled(env) || stopHookActive) return null;
  try {
    const launch = getLaunchBySession(db, sessionId);
    if (!launch || !launchCarriesKnowledgeSteering(launch, getProject(db, launch.projectId))) return null;
    if (getPendingAsksBySession(db, sessionId).length > 0) return null;
    if (getPlanApprovalByLaunch(db, launch.id)?.status === "awaiting_approval") return null;

    const facts = getContributeNudgeFacts(db, sessionId);
    if (facts.nudged || facts.proposals > 0 || facts.edits < CONTRIBUTE_NUDGE_MIN_EDITS) return null;

    recordContributeNudge(db, sessionId, { reason: "contribute", edits: facts.edits });
    return { decision: "block", reason: CONTRIBUTE_NUDGE_REASON };
  } catch (err) {
    console.error("[contribute-nudge] check failed:", err);
    return null;
  }
}
