// The "what's active right now" command — surfacing Standup's ephemeral activity
// layer INTO Slack. A read-only, pull-on-demand snapshot answerable via @mention
// and DM: it fetches the collector's active-work view and renders a compact
// Block-Kit summary (see format.ts activityMessage). It writes NOTHING durable —
// no feed event, no knowledge-graph node, no transcript.
//
// Two independent gates guard it. FIRST, at the command layer (handleActivityCommand,
// wired in index.ts), invoking it is AUTHORITY-GATED to the operator's trusted Slack
// users — the SAME owner/allowlist authority (steer.allowed / SlackAuthority.authorized)
// that guards steering, launching, and config mutation. An unauthorized workspace
// member is refused, so the snapshot never reaches an untrusted caller. SECOND, at the
// collector layer, every read carries the invoking caller's resolved collector identity
// (`actor`), so the collector scopes the snapshot to exactly the projects/sessions that
// caller has standing in — the same per-caller standing gate the MCP whats_happening read
// relies on. It NEVER resolves to the collector-host operator: without a resolvable caller
// identity there is nothing we may safely show, so the snapshot is empty rather than a
// host-scoped cross-project dump.

import type { ActiveWorkItem } from "./collector-client.js";

/** The subset of CollectorClient the activity command drives (so it is testable with a fake). */
export interface ActivityCollector {
  getActiveWork(opts: { project?: string; sessionId?: string; actor?: string }): Promise<ActiveWorkItem[] | null>;
  sessionProjectId(sessionId: string): Promise<string | undefined>;
  listProjects(): Promise<{ id: string }[] | null>;
}

/** How many projects an UNBOUND (cross-project) snapshot fans out over — a sane ceiling for one command. */
export const MAX_PROJECTS_FANOUT = 40;

const LEADING_MENTION = /^<@[^>|]+(?:\|[^>]*)?>\s*/;

/**
 * Whether a bot-directed message is the activity command — `active`, `activity`,
 * `what's happening`, `whats happening`, `what is happening`, or `whats up`. A
 * leading `<@bot>` mention is tolerated (so `@Standup active` matches). Matches
 * ONLY the whole (normalized) message so it never swallows a launch task or a
 * steer that merely contains the word "active", and it deliberately shares no
 * verb with the channel-config grammar (`feed …`, `mirror/asks on|off`,
 * `standup off`, `off`) — parseChannelCommand returns null for every phrase here,
 * so the two grammars can be tried in either order without colliding.
 */
export function parseActivityCommand(raw: string | undefined | null): boolean {
  if (!raw) return false;
  const text = raw
    .trim()
    .replace(LEADING_MENTION, "")
    .trim()
    .toLowerCase()
    .replace(/[?!.]+$/, "")
    .replace(/\s+/g, " ");
  return ACTIVITY_PHRASES.has(text);
}

const ACTIVITY_PHRASES: ReadonlySet<string> = new Set([
  "active",
  "activity",
  "whats happening",
  "what's happening",
  "what is happening",
  "whats active",
  "what's active",
  "whats up",
  "what's up",
]);

/** A resolved activity snapshot: the (already-gated) items and a human label for the scope. */
export interface ActivitySnapshot {
  items: ActiveWorkItem[];
  /** The scope label for the summary/empty-state, e.g. a project id or "your projects". */
  label: string;
  /**
   * Set when a BOUND (mirror-thread) request named a session whose project could
   * NOT be resolved — an unknown/ended session or a transient collector blip. The
   * caller shows a "couldn't resolve this session" notice instead of an empty
   * activity sentence, and — critically — never widens to the cross-project view.
   */
  unresolved?: boolean;
  /**
   * How many registered projects the UNBOUND fan-out did NOT read because it hit
   * the MAX_PROJECTS_FANOUT ceiling. Surfaced as an "N projects not shown" note so
   * a partial cross-project view never SILENTLY omits a project's newest activity.
   * Unset/0 when every project was covered (or the request was bound to one).
   */
  omittedProjectCount?: number;
}

/** Shown when a bound-thread activity request can't resolve its session's project. */
export const ACTIVITY_UNRESOLVED_NOTICE =
  "🤔 Couldn't resolve this session right now — try again in a moment.";

/** Shown when an unauthorized Slack user tries to view the activity snapshot. */
export const ACTIVITY_DENIED_NOTICE =
  "🔒 Only an authorized user can view Standup activity. Ask the operator to add you to SLACK_STEER_ALLOWLIST (or SLACK_ASK_USER / SLACK_OWNER_MAP).";

/** The impure steps an authority-gated activity command drives once its fate is decided. */
export interface ActivityDispatch {
  /**
   * Whether the invoking Slack user is authorized — the SAME owner/allowlist gate
   * (steer.allowed / SlackAuthority.authorized) that guards steering, launching,
   * and config mutation. The activity snapshot exposes other sessions' metadata,
   * so an unauthorized member must never receive it.
   */
  authorized: boolean;
  /** Refuse an unauthorized caller with a brief notice — never the snapshot. */
  deny: () => Promise<void>;
  /** Fetch the (caller-scoped) snapshot and post it. */
  show: () => Promise<void>;
}

/**
 * Gate and dispatch an activity-command invocation. Viewing the snapshot is
 * AUTHORITY-GATED: an unauthorized caller is refused (handed the denial, never the
 * snapshot); only an authorized caller proceeds to the caller-scoped read. Pure but
 * for its injected callbacks, so the security-relevant fork — WHO may see the
 * cross-agent activity — is unit-tested without a live Slack/collector.
 */
export async function handleActivityCommand(d: ActivityDispatch): Promise<void> {
  if (!d.authorized) {
    await d.deny();
    return;
  }
  await d.show();
}

/**
 * The Slack call that delivers an activity snapshot on a given surface — which
 * method to invoke and its addressing (channel / user / thread) args. The snapshot
 * is a caller-scoped, cross-project view of OTHER sessions' metadata, so on a
 * SHARED surface (a channel, or a mirror thread inside one) it must be visible only
 * to the invoking user (chat.postEphemeral); the DM surface is already private to
 * the invoker (chat.postMessage). Discriminated so a caller merges the rendered
 * text/blocks into a correctly-typed args object.
 */
export type ActivityDelivery =
  | { method: "chat.postMessage"; base: { channel: string; thread_ts?: string } }
  | { method: "chat.postEphemeral"; base: { channel: string; user: string; thread_ts?: string } };

/**
 * Resolve how an activity snapshot is delivered. An `ephemeral` surface (a channel,
 * @-mention, or mirror thread) yields a chat.postEphemeral addressed to the invoking
 * user so channel bystanders — who may have no standing in the snapshot's projects —
 * never receive session metadata; the DM surface yields a plain chat.postMessage
 * (its audience is the invoker alone). When an ephemeral delivery is requested but
 * there is no user to address it to, it returns null so the caller DROPS the post
 * rather than falling back to a channel-visible one — a public fallback would
 * re-leak the caller-scoped snapshot to bystanders.
 */
export function activityDelivery(surface: {
  channel: string;
  threadTs?: string;
  userId?: string;
  ephemeral: boolean;
}): ActivityDelivery | null {
  const thread = surface.threadTs ? { thread_ts: surface.threadTs } : {};
  if (!surface.ephemeral) {
    return { method: "chat.postMessage", base: { channel: surface.channel, ...thread } };
  }
  if (!surface.userId) return null;
  return { method: "chat.postEphemeral", base: { channel: surface.channel, user: surface.userId, ...thread } };
}

/**
 * Resolve the active-work snapshot for a command invocation, scoped to the
 * INVOKING caller's collector identity (`scope.actor`). When `sessionId` is given
 * (the command ran in a session's mirror thread) the snapshot is BOUND to that
 * session's project; if that project can't be resolved it returns `unresolved`
 * (never the cross-project view). Otherwise it is UNBOUND — fanned out over every
 * registered project, which the collector's per-caller standing gate narrows to
 * just the projects THIS caller may see (a project the caller has no standing in
 * simply contributes nothing). Every collector read carries `scope.actor` so the
 * collector scopes and self-excludes as the caller, not the host operator; this
 * only merges, de-dupes, and sorts most-recent-first — it never widens what each
 * scoped call returned. With no caller identity there is nothing we may show, so
 * it returns empty rather than falling back to a host-scoped dump.
 */
export async function collectActiveWork(
  collector: ActivityCollector,
  scope: { sessionId?: string; actor?: string },
): Promise<ActivitySnapshot> {
  const actor = scope.actor?.trim();
  if (!actor) return { items: [], label: "your projects" };

  if (scope.sessionId) {
    const projectId = await collector.sessionProjectId(scope.sessionId);
    if (!projectId) {
      // The thread's session/project couldn't be resolved. Do NOT widen to the
      // cross-project view (that would leak beyond this thread's scope on a blip);
      // tell the caller we couldn't resolve it.
      return { items: [], label: "this session", unresolved: true };
    }
    const items =
      (await collector.getActiveWork({ project: projectId, sessionId: scope.sessionId, actor })) ?? [];
    return { items, label: projectId };
  }

  const projects = (await collector.listProjects()) ?? [];
  // Fan out over a bounded set of projects (one collector read each), then merge,
  // de-dupe, and sort most-recent-first ACROSS all of them. The display cap lives
  // in the formatter and is applied AFTER this sort, so the newest activity is
  // never dropped before ordering. When there are more projects than the fan-out
  // ceiling, the surplus is reported as omittedProjectCount rather than silently
  // swallowed — an arbitrary project-order slice must not hide a project's newest
  // work without saying so.
  const fanned = projects.slice(0, MAX_PROJECTS_FANOUT);
  const results = await Promise.all(fanned.map((p) => collector.getActiveWork({ project: p.id, actor })));
  const seen = new Set<string>();
  const merged: ActiveWorkItem[] = [];
  for (const list of results) {
    for (const item of list ?? []) {
      if (seen.has(item.sessionId)) continue;
      seen.add(item.sessionId);
      merged.push(item);
    }
  }
  merged.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  const omittedProjectCount = Math.max(0, projects.length - fanned.length);
  return {
    items: merged,
    label: "your projects",
    ...(omittedProjectCount > 0 ? { omittedProjectCount } : {}),
  };
}
