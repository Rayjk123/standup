import type { TicketStatus } from "@standup/shared";

/**
 * The issue-tracker seam: how Standup pulls a task from an external tracker
 * into a work item (a ticket) and pushes the ticket's status back to it.
 *
 * A tracker writes back one of two ways:
 *  - `collector` — the adapter's own `updateTask` performs the call;
 *  - `agent` — the dispatched session holds the tracker's tools, so the
 *    collector hands it `writebackInstruction` and the session makes the call.
 *
 * The built-in default is `noneTracker`: no external tracker, nothing is
 * pulled or pushed, and the ingest route refuses. `agentTracker` is the
 * neutral agent-driven adapter, configured by name (STANDUP_TRACKER=agent).
 */

/** A task in the shape the sync needs — fetched to ingest, echoed back. */
export interface TrackerTask {
  id: string;
  title: string;
  /** The task body — seeds the work item's body. */
  description?: string;
  /** The task's current status in the tracker, if known. */
  status?: string;
  /** A link to the task in the tracker, surfaced for the human. */
  url?: string;
}

/**
 * A status writeback to a task. Carries no `priority`: priority is triaged in
 * the tracker, never set by Standup, so the type makes it unrepresentable.
 */
export interface TrackerStatusUpdate {
  /** The new task status (e.g. "In Progress", "In Review", "Resolved"). */
  status?: string;
  /** A free-text comment — carries the review link back to the task. */
  comment?: string;
}

/** Who performs a tracker's status writeback (see TrackerAdapter). */
export type TrackerWritebackMode = "none" | "collector" | "agent";

export interface TrackerAdapter {
  /** Stable id, as configured (`none`, `agent`, or a custom adapter's). */
  readonly id: string;
  /** The tracker's display name, used in instructions and warnings ("Jira", "the issue tracker"). */
  readonly name: string;
  /** False only for the built-in `none`: no external tracker is configured. */
  readonly enabled: boolean;
  readonly writeback: TrackerWritebackMode;
  /** Fetch one task. Adapters that can't reach the tracker from the collector throw. */
  getTask(taskId: string): Promise<TrackerTask>;
  listTasks(query?: { assignee?: string; container?: string }): Promise<TrackerTask[]>;
  /** Push a status to a task (writeback mode `collector`). */
  updateTask(taskId: string, update: TrackerStatusUpdate): Promise<void>;
  /** The tracker status a Standup ticket status maps to. */
  statusFor(status: TicketStatus): string;
  /**
   * The directive handed to the dispatched session so it writes the status and
   * review link back itself (writeback mode `agent`), or null when the
   * session has nothing to do.
   */
  writebackInstruction(taskId: string, opts?: { reviewUrl?: string }): string | null;
}

/**
 * The status most trackers' workflows carry for each ticket state. Standup's
 * lifecycle is finer than a tracker's, so several states fold onto one.
 */
export function genericTrackerStatus(status: TicketStatus): string {
  switch (status) {
    case "proposed":
    case "approved":
      return "Backlog";
    case "developing":
      return "In Progress";
    case "needs_review":
      return "In Review";
    case "shipped":
      return "Resolved";
    case "dismissed":
      return "Cancelled";
  }
}

/** Thrown by an adapter that can't perform a call. */
export class TrackerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrackerUnavailableError";
  }
}

/** The built-in default: no external tracker. Every outward call refuses. */
export const noneTracker: TrackerAdapter = {
  id: "none",
  name: "the issue tracker",
  enabled: false,
  writeback: "none",
  async getTask(): Promise<TrackerTask> {
    throw new TrackerUnavailableError("No issue tracker is configured (STANDUP_TRACKER).");
  },
  async listTasks(): Promise<TrackerTask[]> {
    throw new TrackerUnavailableError("No issue tracker is configured (STANDUP_TRACKER).");
  },
  async updateTask(): Promise<void> {
    throw new TrackerUnavailableError("No issue tracker is configured (STANDUP_TRACKER).");
  },
  statusFor: genericTrackerStatus,
  writebackInstruction: () => null,
};

/**
 * An agent-driven tracker: the collector holds no client, the caller hands a
 * task's fields to the ingest route, and the dispatched session — which holds
 * the tracker's own tools — writes the status and review link back.
 */
export function agentTracker(name: string): TrackerAdapter {
  const label = name.trim() || "the issue tracker";
  const refuse = (what: string) =>
    new TrackerUnavailableError(
      `${label} is agent-driven: the collector does not ${what}; the dispatched session uses its own ${label} tools.`
    );
  return {
    id: "agent",
    name: label,
    enabled: true,
    writeback: "agent",
    async getTask(): Promise<TrackerTask> {
      throw refuse("fetch tasks");
    },
    async listTasks(): Promise<TrackerTask[]> {
      throw refuse("list tasks");
    },
    async updateTask(): Promise<void> {
      throw refuse("update tasks");
    },
    statusFor: genericTrackerStatus,
    writebackInstruction(taskId, opts) {
      const link = opts?.reviewUrl?.trim();
      const linkClause = link ? `the review URL (${link})` : "the URL of the review you just created";
      return [
        "",
        "",
        `This work tracks ${label} task ${taskId}. When the review is created, close the loop on the task:`,
        `use your ${label} tools to set task ${taskId}'s status to "${genericTrackerStatus("needs_review")}" and add a comment linking ${linkClause}.`,
        "Do NOT set a priority on the task (priority is triaged in the tracker, never by Standup).",
      ].join("\n");
    },
  };
}

/** The tracker kinds resolveTrackerAdapter knows. */
export const TRACKER_KINDS = ["none", "agent"] as const;

/**
 * The configured tracker: STANDUP_TRACKER (`none`, the default, or `agent`)
 * with STANDUP_TRACKER_NAME naming the tracker for an agent-driven one. An
 * unknown kind resolves to `none` with a warning, so a typo never turns on an
 * outward writeback.
 */
export function resolveTrackerAdapter(
  env: Record<string, string | undefined> = process.env,
  warn: (message: string) => void = (m) => console.warn(m)
): TrackerAdapter {
  const kind = env.STANDUP_TRACKER?.trim().toLowerCase() || "none";
  if (kind === "none") return noneTracker;
  if (kind === "agent") return agentTracker(env.STANDUP_TRACKER_NAME ?? "");
  warn(`[tracker] unknown STANDUP_TRACKER "${kind}"; using none (known: ${TRACKER_KINDS.join(", ")})`);
  return noneTracker;
}
