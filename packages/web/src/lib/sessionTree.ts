import type { Session } from "@standup/shared";

// Non-terminal statuses that count as "live". A `done` session has finished its
// work. An `idle` row stamped with ended_at by a SessionEnd reads as ended until
// a later hook revives it and clears the stamp.
const LIVE_STATUSES = new Set(["running", "waiting", "idle", "stalled"]);

/**
 * The instant a row is anchored to: when it ended, else when it started. Ended
 * rows sort by this; a still-running one is instead treated as maximally recent
 * (see isLiveActive).
 */
export function recencyOf(session: Session): number {
  return new Date(session.endedAt ?? session.startedAt).getTime();
}

/**
 * Whether a session is a still-running agent: no end stamp and a live status.
 * Such a session sorts ahead of every ended one, however long ago it started,
 * so the longest-lived active agent is never buried.
 */
export function isLiveActive(session: Session): boolean {
  return session.endedAt == null && LIVE_STATUSES.has(session.status);
}

/** Open top-level agents, broken down by what each is doing right now. */
export interface LiveAgentCounts {
  running: number;
  waiting: number;
  idle: number;
  stalled: number;
  /** Turn-complete roots (`done`) whose session is still open — no end stamp. */
  done: number;
}

/**
 * The top-bar agent tally. The console's session collection is the `?all=1`
 * list, so it carries every ended row ever stored; only roots with no end stamp
 * count — the same set the Sessions API lists by default (getActiveSessions).
 * A turn-complete `done` root is still in that set, so it gets its own bucket
 * rather than being dropped or passed off as idle. Subagent children are nested
 * under their root, not agents.
 */
export function liveAgentCounts(sessions: Session[]): LiveAgentCounts {
  const counts: LiveAgentCounts = { running: 0, waiting: 0, idle: 0, stalled: 0, done: 0 };
  for (const s of sessions) {
    if (s.parentSessionId || s.endedAt != null || !Object.hasOwn(counts, s.status)) continue;
    counts[s.status]++;
  }
  return counts;
}

/**
 * The console receives one flat session collection that mixes top-level (root)
 * sessions with the subagent children nested under them. Every child carries a
 * `parentSessionId`; a root has none. This partitions that flat list into the
 * roots to lay out at the top level and, per root, the children to render
 * indented beneath it — the shape both the flat and grouped sidebar views need,
 * kept as a pure function so it can be tested without rendering.
 */
export interface SessionTree {
  /** Sessions with no parent — the rows shown at the top level. */
  roots: Session[];
  /** parentSessionId -> its direct children, in the input order. */
  childrenByParent: Map<string, Session[]>;
}

export function buildSessionTree(sessions: Session[]): SessionTree {
  const roots: Session[] = [];
  const childrenByParent = new Map<string, Session[]>();

  for (const session of sessions) {
    if (session.parentSessionId) {
      const siblings = childrenByParent.get(session.parentSessionId) ?? [];
      siblings.push(session);
      childrenByParent.set(session.parentSessionId, siblings);
    } else {
      roots.push(session);
    }
  }

  return { roots, childrenByParent };
}

/**
 * The direct subagent children of a session, in the order they appear in the
 * flat list. Empty when the session has spawned no subagents (the common case).
 * Used both to nest rows in the sidebar and to list a root's subsessions in its
 * detail pane.
 */
export function childSessions(
  sessions: Session[],
  parentId: string
): Session[] {
  return sessions.filter((s) => s.parentSessionId === parentId);
}

/**
 * How many children a consolidated child list shows when none are running —
 * the most recent this many. A parent that has spawned dozens of subagents
 * would otherwise dump every one into the sidebar and detail views.
 */
export const DEFAULT_VISIBLE_CHILDREN = 5;

/** Options for {@link visibleChildren}. */
export interface VisibleChildrenOptions {
  /** Keep at most this many (after sorting); unset means no cap. */
  limit?: number;
  /** Keep only still-running children (see isLiveActive). */
  runningOnly?: boolean;
}

/**
 * A parent's direct children sorted the way every child list renders them:
 * still-running agents first (they are the relevant work), then by recency so
 * the freshest sit atop the rest. Returns a fresh array; the input is never
 * mutated.
 */
export function sortedChildren(
  sessions: Session[],
  parentId: string
): Session[] {
  return childSessions(sessions, parentId).sort((a, b) => {
    const liveA = isLiveActive(a);
    const liveB = isLiveActive(b);
    if (liveA !== liveB) return liveA ? -1 : 1;
    return recencyOf(b) - recencyOf(a) || a.id.localeCompare(b.id);
  });
}

/**
 * The children a render site should show, sorted running-first then by recency
 * and optionally narrowed/capped. With no options this is the full sorted set
 * (the "show all" expansion); `runningOnly` keeps just the live ones; `limit`
 * caps the count. The raw {@link childSessions} stays the source of truth for
 * counts and drill-down.
 */
export function visibleChildren(
  sessions: Session[],
  parentId: string,
  options: VisibleChildrenOptions = {}
): Session[] {
  const { limit, runningOnly } = options;
  let children = sortedChildren(sessions, parentId);
  if (runningOnly) children = children.filter(isLiveActive);
  if (limit != null) children = children.slice(0, limit);
  return children;
}

/**
 * The consolidated default a child list shows before "show all": every running
 * subagent when any are running, else the most recent `limit`. Running-first,
 * recency within — so a parent with fifty finished subagents collapses to a
 * handful while an actively-fanning-out parent still shows all its live work.
 */
export function consolidatedChildren(
  sessions: Session[],
  parentId: string,
  limit: number = DEFAULT_VISIBLE_CHILDREN
): Session[] {
  const running = visibleChildren(sessions, parentId, { runningOnly: true });
  if (running.length > 0) return running;
  return visibleChildren(sessions, parentId, { limit });
}
