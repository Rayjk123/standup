import type { Database } from "bun:sqlite";
import { randomBytes } from "crypto";
import type {
  BoardConflict,
  BoardConflictProbe,
  BoardQuery,
  BoardTask,
  BoardTaskFrame,
  BoardTaskInput,
  BoardTaskSource,
  WsMessage,
} from "@standup/shared";
import { findConflicts, mirrorJobOnBacklog } from "@standup/shared";
import {
  boardJobLinkedByBacklog,
  boardVersion,
  deleteBoardTask,
  getBoardTaskBySource,
  listBoardTaskPage,
  listBoardTasks,
  upsertBoardTask,
} from "@standup/store";

type Publish = (message: WsMessage) => void;

/** A board read: whose tasks, filtered how, and which page of closed ones. */
export interface BoardListQuery extends BoardQuery {
  /** The reader: their tasks and the team-wide ones (owner ""); "" reads only the team-wide ones. */
  owner: string;
  /** Only the cards of these jobs (their job cards and the backlog cards linking them). */
  jobIds?: readonly string[];
  /** The most closed tasks returned (default 200). */
  closedLimit?: number;
  /**
   * Only the closed tasks past this cursor, newest first: the next page of
   * closed tasks. The cursor is the previous page's last task: its updatedAt
   * here (ISO) and its id in `closedBeforeId` (see ListBoardTasksQuery).
   */
  closedBefore?: string;
  closedBeforeId?: string;
}

/** What a board read returns: the tasks, and whether more closed tasks exist past the page. */
export interface BoardListResult {
  tasks: BoardTask[];
  closedMore: boolean;
}

/**
 * The Board: the one writer of board_tasks and of `board:task` frames, and
 * the one reader every consumer (the routes, Persona's tools) goes through.
 *
 * This interface is the plug-in contract for every source of tasks. The board
 * adapter (adapter.ts) feeds it Persona jobs and review tickets; a program
 * backlog producer plugs in the same way — `upsert` a task with
 * `source: "backlog"`, `sourceId` its item id, `links.backlogItemId` (and
 * `links.jobId` once a job works it), and `remove` it when the item is gone.
 * A task is identified by `(source, sourceId)`; upserting the pair again
 * replaces it. A backlog card linking a job of its own owner follows that
 * job's card and hides it (see BoardTaskInput); one of another owner — a
 * team-wide card — keeps only its backlog item and job links and leaves the
 * job's card shown.
 */
export interface Board {
  /**
   * Writes the task and, when anything stored changed, publishes a
   * `board:task` frame with it to its owner (to everyone for a team-wide
   * task, owner ""). A backlog card linking a job takes the job card's
   * column, stage, waiting-on, areas and links, and the job card is
   * published as removed; a job card a backlog card links is written but
   * published as removed. Returns the task as stored.
   */
  upsert(input: BoardTaskInput): BoardTask;
  /** Removes a source's task, publishing its removal; false when it had none. */
  remove(source: BoardTaskSource, sourceId: string): boolean;
  /**
   * The owner's tasks and the team-wide ones that match `query`, most
   * recently updated first: every open one and the `closedLimit` most recent
   * closed ones — or, with `closedBefore`, only that page of older closed
   * ones. Job cards a backlog card links are left out.
   */
  list(query: BoardListQuery): BoardListResult;
  /** The owner's open tasks (and the team-wide ones) a probe may collide with, strongest first. */
  conflicts(owner: string, probe: BoardConflictProbe, scope?: { jobIds?: readonly string[] }): BoardConflict[];
  /** A counter that moves whenever a task changes, so a reader can cache what it derived. */
  version(): number;
  /**
   * What `owner`'s board looks like to a console, as a token that changes
   * whenever a `board:task` frame goes out that the owner's console would be
   * sent: one addressed to the owner, or a team-wide one. "" reads only the
   * team-wide frames. It is prefixed with this board's boot id, so a restart
   * never lands on a token a console already holds. A change to another
   * owner's task leaves it alone.
   */
  viewerVersion(owner: string): string;
}

export interface BoardOptions {
  db: Database;
  /** The broadcast every `board:task` frame goes out through. */
  publish: Publish;
}

/** A frame for `task`: addressed to its owner, who must have proved who they are, or to everyone when team-wide. */
function frameFor(owner: string, payload: BoardTaskFrame): WsMessage<BoardTaskFrame> {
  return {
    type: "board:task",
    payload,
    timestamp: new Date().toISOString(),
    ...(owner ? { audience: owner, requireProof: true } : {}),
  };
}

export function createBoard(opts: BoardOptions): Board {
  const { db } = opts;
  const boot = randomBytes(6).toString("hex");
  // Frames sent per audience: an owner's alias, or "" for the team-wide ones.
  const sent = new Map<string, number>();
  const publish: Publish = (message) => {
    const audience = message.audience ?? "";
    sent.set(audience, (sent.get(audience) ?? 0) + 1);
    opts.publish(message);
  };
  const hidden = (task: BoardTask): boolean =>
    task.source === "job" && boardJobLinkedByBacklog(db, task.sourceId, task.owner);
  /**
   * Whether backlog card `card` represents job `jobId`: it links the job and
   * has the job's owner. A backlog card of another owner (a team-wide one)
   * linking the job neither follows nor hides it, so the job's private links
   * never reach its readers.
   */
  const represents = (card: BoardTask | null, jobId: string | undefined): boolean =>
    !!card && !!jobId && card.links.jobId === jobId && getBoardTaskBySource(db, "job", jobId)?.owner === card.owner;
  /** Publishes a job's own card again once no backlog card of its owner links it. */
  const reveal = (jobId: string): void => {
    const card = getBoardTaskBySource(db, "job", jobId);
    if (card && !hidden(card)) publish(frameFor(card.owner, { task: card }));
  };
  /**
   * What a backlog card linking a job of another owner is stored as: the
   * input with its links cut to the backlog item and the job, so a card that
   * once mirrored the job (or was handed its links) keeps none of the job's
   * private ones.
   */
  const foreignLinks = (input: BoardTaskInput): BoardTaskInput => {
    const { backlogItemId, jobId } = input.links;
    return { ...input, links: { ...(backlogItemId ? { backlogItemId } : {}), ...(jobId ? { jobId } : {}) } };
  };
  return {
    upsert(input) {
      const jobId = input.source === "backlog" ? input.links.jobId : undefined;
      const linked = jobId ? getBoardTaskBySource(db, "job", jobId) : null;
      const jobCard = linked && linked.owner === input.owner ? linked : null;
      const prior = getBoardTaskBySource(db, input.source, input.sourceId);
      const before = input.source === "backlog" ? prior : null;
      const stored = jobCard ? mirrorJobOnBacklog(input, jobCard) : linked ? foreignLinks(input) : input;
      const { task, changed } = upsertBoardTask(db, stored);
      // A task handed to another owner leaves the boards of those who saw it
      // until now — sent first, so a reader in both audiences ends with the task.
      if (prior && prior.owner !== task.owner) publish(frameFor(prior.owner, { removed: { id: task.id } }));
      if (changed) publish(frameFor(task.owner, hidden(task) ? { removed: { id: task.id } } : { task }));
      if (input.source === "backlog") {
        const previous = before?.links.jobId;
        // A newly represented job's card leaves the board: the backlog card stands in for it now.
        if (jobCard && !represents(before, jobId)) publish(frameFor(jobCard.owner, { removed: { id: jobCard.id } }));
        if (previous && represents(before, previous) && !represents(task, previous)) reveal(previous);
      }
      return task;
    },
    remove(source, sourceId) {
      const removed = deleteBoardTask(db, source, sourceId);
      if (!removed) return false;
      publish(frameFor(removed.owner, { removed: { id: removed.id } }));
      const jobId = removed.links.jobId;
      if (removed.source === "backlog" && jobId && represents(removed, jobId)) reveal(jobId);
      return true;
    },
    list(query) {
      const { tasks, closedMore } = listBoardTaskPage(db, { ...query, includeShared: true, hideLinkedJobs: true });
      return { tasks, closedMore };
    },
    conflicts(owner, probe, scope = {}) {
      const open = listBoardTasks(db, {
        owner,
        includeShared: true,
        includeClosed: false,
        hideLinkedJobs: true,
        ...(scope.jobIds ? { jobIds: scope.jobIds } : {}),
      });
      return findConflicts(probe, open);
    },
    version() {
      return boardVersion(db);
    },
    viewerVersion(owner) {
      const team = sent.get("") ?? 0;
      return owner ? `${boot}.${sent.get(owner) ?? 0}.${team}` : `${boot}.${team}`;
    },
  };
}
