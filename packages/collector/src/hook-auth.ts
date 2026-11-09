import type { Database } from "bun:sqlite";
import type { Launch } from "@standup/shared";
import {
  canonicalPath,
  findLaunchByCwd,
  getLaunchByHookTokenHash,
  getLaunchBySession,
  getLaunchHookAuth,
  getRecentEventsBySession,
  getSession,
  eventsSinceLastSessionEnd,
  getSessionHookLaunch,
  isWithin,
  sessionAgeSeconds,
} from "@standup/store";
import { workerTokenHash } from "./floor/gate.js";
import { MAX_SESSION_DEPTH } from "./pipeline/runners.js";

/*
 * Who may report a hook event for a session on the collector's `/hook` route.
 *
 * Every Claude Code session posts its events through the global HTTP hooks
 * setup-hooks installs, which carry no credential. A launched worker also gets
 * hooks of its own in its `--settings` (buildFloorHookSettings) that post the
 * same events with the launch's hook token (HOOK_TOKEN_HEADER, read from the
 * session's HOOK_TOKEN_ENV). The launch row keeps the token's sha256
 * (hook_token_hash); the token itself is never stored.
 *
 * A launch's token is enforced once it is proven: the first event carrying it
 * marks the launch (hook_auth). From then on, while the launch is live
 * (starting or running) and its own session runs, that session's events count
 * only from its own hooks:
 *   - an event with no token is the global hook's copy, or a forgery, and is
 *     ignored: nothing is recorded or decided from it. It is answered 202
 *     rather than with an error status because Claude Code shows a non-2xx
 *     reply as a "hook error" in the worker's transcript, and the global copy
 *     arrives for every event the worker has;
 *   - an event with a token that isn't that launch's is refused (403).
 * The session an event is for is resolved through its own launch, else its
 * nearest parent session's (a subagent child's events reach its worker's run).
 *
 * A token is resolved to its launch by its hash. A session that no launch
 * owns yet is claimed by the launch whose token it presents: always before
 * that launch's token is proven (the first token event wins even over a
 * tokenless session that reported in first), and afterwards only when the
 * launch's own session has ended (a new session id after `/clear`). A new
 * session must report from the launch's worktree. A session the collector has
 * already seen is claimed only if this launch's token reported for it before
 * (sessions.hook_launch_id) and the worker has just `/resume`d back to it (its
 * one event since it last ended is the global copy of this one), or
 * if it is the global hook's copy of the worker's own first event: begun under
 * the launch, in its worktree, first seen within CLAIM_WINDOW_S, with that one
 * event recorded. So it is never an owner session. A subagent child is never
 * claimed.
 *
 * A token that resolves to no live launch is refused (403) for a session
 * whose launch enforces its token, and otherwise ignored (202): a hook whose
 * env var didn't resolve duplicates the global hook's copy.
 *
 * What stays open, and why:
 *   - A session with no launch (the owner's own Claude Code sessions) has no
 *     token to present: its global hooks are all it has, so its events are
 *     taken as before. A token presented for a session it can't claim is
 *     refused (403).
 *   - Until its token is proven, a launch's session reports as it did before:
 *     a launch started before these hooks existed (no hook_token_hash), one
 *     whose hooks can't reach the collector, or one the safety floor can't
 *     guard (no reporting hooks) never goes dark, but is not protected either.
 *   - A launch enforces nothing once its own session has ended (its worker
 *     exited) or it is no longer live (failed or cleaned), so a worker session
 *     resumed by hand afterwards doesn't go dark. The first tokenless event of
 *     an ended session retires the proof (hook_auth back to 0), since
 *     processing it revives the session; a later token event proves it again.
 *     Only the worker's own token-carrying SessionEnd can end the session
 *     while enforcement holds. Adopt issues a resumed session's new launch a
 *     token of its own.
 *   - A new tokenless session in a live, proven launch's worktree (a
 *     `claude -p` the worker runs, the owner opening one in a Persona
 *     worker's in-place checkout) is taken as a session of its own, but never
 *     joins that launch.
 *   - The token is in the worker's environment, which only processes of the
 *     same Unix user can read (/proc/<pid>/environ), so it proves an event
 *     came through the launch's hooks or a process of that user, not which
 *     process sent it. It is in the argv of the `tmux new-session` client
 *     only for the moment that client runs.
 *   - A session attached to another launch before this one's token was
 *     proven answers its token copies 403, which Claude Code shows as a hook
 *     error on each event.
 */

const LIVE_STATUSES: ReadonlySet<Launch["status"]> = new Set(["starting", "running"]);

/**
 * How long after a session is first seen its worker's token may still claim
 * it: the gap between the global hook's copy of an event and the launch's own
 * copy, which Claude Code sends in parallel, with room for a slow collector.
 */
export const CLAIM_WINDOW_S = 60;

export type HookAuthDecision =
  | {
      ok: true;
      /**
       * Whether the session may join the launch whose worktree holds its cwd
       * (a session first seen on this event, or a SessionStart's ticket
       * relink). False when that launch is live and proven and the event had
       * no token.
       */
      attachToLaunch: boolean;
      /** The launch the session joins on this event, by the token it presented. */
      claim?: string;
      /** The launch whose token this event proved for the first time. */
      prove?: string;
      /**
       * The launch whose proof this event retires: its session ended and now
       * reports without the token, so the launch enforces nothing until a
       * token event proves it again.
       */
      retire?: string;
      /** The launch whose hook token reported this event (recorded on the session). */
      reportedBy?: string;
    }
  /**
   * 202: a tokenless event ignored unprocessed. 403: a token that isn't the
   * session's launch's. `tokenlessCopy`: the 202 dropped a tokenless event for
   * a session its launch's token enforces — normally the global hook's copy
   * of an event the worker also sends with its token.
   */
  | { ok: false; status: 202 | 403; reason: string; tokenlessCopy?: boolean };

/** The launch a known session reports for: its own, else its nearest parent session's. */
function launchOfSession(db: Database, sessionId: string): Launch | null {
  let current: string | null = sessionId;
  for (let depth = 0; current && depth < MAX_SESSION_DEPTH; depth++) {
    const launch = getLaunchBySession(db, current);
    if (launch) return launch;
    current = getSession(db, current)?.parentSessionId ?? null;
  }
  return null;
}

/**
 * Whether `launch` takes its session's events only with its token: while it
 * is live, proven, and its own session hasn't ended (a launch stays `running`
 * after its worker exits, until it is cleaned).
 */
function enforcing(db: Database, launch: Launch): boolean {
  return LIVE_STATUSES.has(launch.status) && getLaunchHookAuth(db, launch.id) && hasLiveSession(db, launch);
}

/** Whether `launch`'s own session is still running. */
function hasLiveSession(db: Database, launch: Launch): boolean {
  if (!launch.sessionId) return false;
  const session = getSession(db, launch.sessionId);
  return !!session && !session.endedAt;
}

/** The starting or running launch whose hook token `token` is, or null. */
export function liveLaunchForHookToken(db: Database, token: string | undefined): Launch | null {
  const presented = token?.trim();
  if (!presented) return null;
  const launch = getLaunchByHookTokenHash(db, workerTokenHash(presented));
  return launch && LIVE_STATUSES.has(launch.status) ? launch : null;
}

/**
 * Decides whether a hook event `eventName` for `sessionId` in `cwd`, carrying
 * `token` (the hook-token header, if any), may be processed. It reads the
 * store, never writes it: the route applies `claim` and `prove`.
 */
export function authorizeHookEvent(
  db: Database,
  event: { sessionId?: string; cwd?: string; eventName?: string },
  token: string | undefined
): HookAuthDecision {
  const { sessionId, cwd, eventName } = event;
  const presented = token?.trim() || undefined;
  const known = sessionId ? getSession(db, sessionId) : null;
  const sessionLaunch = sessionId && known ? launchOfSession(db, sessionId) : null;

  if (presented) {
    const target = liveLaunchForHookToken(db, presented);
    if (!target) {
      // Refused for a session whose launch enforces its token. Otherwise
      // ignored: a hook whose token didn't resolve (an env var it couldn't
      // read, a launch since cleaned) duplicates the global hook's copy, and
      // an error status would show on every event in its transcript.
      if (sessionLaunch && enforcing(db, sessionLaunch)) {
        return { ok: false, status: 403, reason: `session ${sessionId} runs under launch ${sessionLaunch.id}, and the token is not a live launch's hook token` };
      }
      return { ok: false, status: 202, reason: "the token is not a live launch's hook token" };
    }
    const prove = getLaunchHookAuth(db, target.id) ? undefined : target.id;
    if (sessionLaunch) {
      if (sessionLaunch.id !== target.id) {
        return { ok: false, status: 403, reason: `session ${sessionId} runs under launch ${sessionLaunch.id}, not ${target.id}` };
      }
      return { ok: true, attachToLaunch: true, prove, reportedBy: target.id };
    }
    if (known?.kind === "subagent") {
      return { ok: false, status: 403, reason: `session ${sessionId} is a subagent session no launch owns` };
    }
    // A session this launch's token reported for before is its own again when
    // the worker `/resume`s back to it: since that session last ended, the
    // only event it recorded is the global hook's copy of this one, a moment
    // ago. One the owner has since resumed by hand has recorded more.
    if (known && getSessionHookLaunch(db, known.id) === target.id) {
      const since = eventsSinceLastSessionEnd(db, known.id);
      if (since.count <= 1 && (since.newestAgeS ?? 0) <= CLAIM_WINDOW_S) {
        return { ok: true, attachToLaunch: true, claim: target.id, prove, reportedBy: target.id };
      }
    }
    // Any other session must be in the launch's worktree. One already seen is
    // claimed only as the global hook's copy of this very event, which lands
    // a moment before the launch's own copy: begun under the launch, first
    // seen within CLAIM_WINDOW_S, with at most that one event recorded. So a
    // token never claims an owner session, even after ending its own, and
    // even where the worktree is the owner's checkout (in-place, adopted).
    const inWorktree = (path: string | undefined) =>
      !!path && isWithin(canonicalPath(target.worktreePath), canonicalPath(path));
    const eligible = !known
      ? inWorktree(cwd)
      : known.startedAt.getTime() >= target.createdAt.getTime() &&
        inWorktree(known.cwd) &&
        (sessionAgeSeconds(db, known.id) ?? Infinity) <= CLAIM_WINDOW_S &&
        getRecentEventsBySession(db, known.id, 2).length <= 1;
    if (eligible && (!!prove || !hasLiveSession(db, target))) {
      return { ok: true, attachToLaunch: true, claim: target.id, prove, reportedBy: target.id };
    }
    return { ok: false, status: 403, reason: `launch ${target.id}'s token can't claim session ${sessionId ?? "(none)"}` };
  }

  if (sessionLaunch) {
    if (enforcing(db, sessionLaunch)) {
      return {
        ok: false,
        status: 202,
        reason: `session ${sessionId} reports through launch ${sessionLaunch.id}'s own hooks`,
        tokenlessCopy: true,
      };
    }
    if (getLaunchHookAuth(db, sessionLaunch.id)) {
      // The global copy of the SessionEnd the worker's own hook already
      // delivered: nothing left to do.
      if (eventName === "SessionEnd" && known?.endedAt) {
        return { ok: false, status: 202, reason: `session ${sessionId} already ended through launch ${sessionLaunch.id}'s own hooks` };
      }
      // The launch's session ended and is reporting again without its token
      // (resumed by hand): processing this event revives the session, so the
      // proof is retired first or the next event would be ignored.
      return { ok: true, attachToLaunch: true, retire: sessionLaunch.id };
    }
    return { ok: true, attachToLaunch: true };
  }

  // The launch whose worktree holds the cwd acts on a session with no launch
  // of its own: ensureSession attaches a session it hasn't seen to it, and a
  // SessionStart relinks that launch's ticket to the session.
  const cwdLaunch = cwd && (!known || eventName === "SessionStart") ? findLaunchByCwd(db, cwd) : null;
  if (cwdLaunch && enforcing(db, cwdLaunch)) return { ok: true, attachToLaunch: false };
  return { ok: true, attachToLaunch: true };
}
