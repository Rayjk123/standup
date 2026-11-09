import { describe, expect, test } from "bun:test";
import {
  createStore,
  getTicket,
  getTicketByIssueId,
  setReviewUrl,
  setTicketSession,
  updateTicketStatus,
  upsertProject,
  type Store,
} from "@standup/store";
import type { ReviewProcess, Ticket } from "@standup/shared";
import {
  agentTracker,
  genericTrackerStatus,
  noneTracker,
  type TrackerAdapter,
  type TrackerStatusUpdate,
  type TrackerTask,
} from "./adapter.js";
import {
  TRACKER_LENS,
  composeTaskWriteback,
  fetchTaskAndIngest,
  firesTrackerWriteback,
  ingestTaskAsWorkItem,
  isTrackerTicket,
  taskToTicketInput,
  trackerWritebackFor,
  writeBackTaskStatus,
} from "./sync.js";
import { reviewAgentNudge } from "../server.js";

function setUp(): Store {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
  return store;
}

/** A collector-driven test adapter that records every outward call. */
function recordingTracker(tasks: TrackerTask[]): {
  tracker: TrackerAdapter;
  updates: Array<{ taskId: string; update: TrackerStatusUpdate }>;
} {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const updates: Array<{ taskId: string; update: TrackerStatusUpdate }> = [];
  const tracker: TrackerAdapter = {
    id: "recording",
    name: "Recorder",
    enabled: true,
    writeback: "collector",
    async getTask(taskId) {
      const t = byId.get(taskId);
      if (!t) throw new Error(`no task ${taskId}`);
      return t;
    },
    async listTasks() {
      return [...byId.values()];
    },
    async updateTask(taskId, update) {
      updates.push({ taskId, update });
    },
    statusFor: genericTrackerStatus,
    writebackInstruction: () => null,
  };
  return { tracker, updates };
}

const TASK: TrackerTask = {
  id: "T-42",
  title: "Add retry to the widget fetch",
  description: "Retry on 5xx with backoff.",
  url: "https://tracker.example/T-42",
};

function ticketOf(partial: Partial<Ticket>): Ticket {
  return {
    id: "t1",
    projectId: "p",
    lens: TRACKER_LENS,
    title: "x",
    body: "",
    severity: "medium",
    status: "needs_review",
    issueId: "T-1",
    createdAt: "",
    updatedAt: "",
    ...partial,
  } as Ticket;
}

describe("taskToTicketInput", () => {
  test("maps the task id to issueId, the link to taskUrl, and stamps the tracker lens", () => {
    const input = taskToTicketInput(TASK, { projectId: "p", severity: "high" });
    expect(input).toEqual({
      projectId: "p",
      lens: TRACKER_LENS,
      title: TASK.title,
      body: TASK.description!,
      severity: "high",
      issueId: "T-42",
      taskUrl: TASK.url,
    });
  });

  test("tolerates a task with no description or url and ignores its status", () => {
    const input = taskToTicketInput({ id: "T-1", title: "t", status: "Done" }, { projectId: "p" });
    expect(input.body).toBe("");
    expect(input.taskUrl).toBeUndefined();
    expect(input).not.toHaveProperty("status");
  });
});

describe("ingestTaskAsWorkItem", () => {
  test("creates a proposed work item and is idempotent per project", () => {
    const store = setUp();
    try {
      upsertProject(store.db, { id: "q", name: "q", branch: "main", repos: [] });
      const first = ingestTaskAsWorkItem(store.db, TASK, { projectId: "p" });
      expect(first.created).toBe(true);
      expect(first.ticket.status).toBe("proposed");
      expect(first.ticket.lens).toBe(TRACKER_LENS);
      const again = ingestTaskAsWorkItem(store.db, TASK, { projectId: "p" });
      expect(again.created).toBe(false);
      expect(again.ticket.id).toBe(first.ticket.id);
      const other = ingestTaskAsWorkItem(store.db, TASK, { projectId: "q" });
      expect(other.created).toBe(true);
      expect(other.ticket.id).not.toBe(first.ticket.id);
    } finally {
      store.close();
    }
  });
});

describe("isTrackerTicket", () => {
  const cases: Array<[string, Partial<Ticket>, boolean]> = [
    ["tracker lens with an id", {}, true],
    ["tracker lens without an id", { issueId: undefined }, false],
    ["tracker lens with a blank id", { issueId: "  " }, false],
    ["review lens with an id", { lens: "bugs" }, false],
  ];
  for (const [name, partial, expected] of cases) {
    test(name, () => expect(isTrackerTicket(ticketOf(partial))).toBe(expected));
  }
});

describe("firesTrackerWriteback", () => {
  const recording = recordingTracker([]).tracker;
  const cases: Array<[string, TrackerAdapter, ReviewProcess | undefined, boolean]> = [
    ["none never fires", noneTracker, "review-agent", false],
    ["agent fires from review-agent", agentTracker("Jira"), "review-agent", true],
    ["agent fires from command", agentTracker("Jira"), "command", true],
    ["agent does not fire from pause", agentTracker("Jira"), "pause", false],
    ["agent does not fire when unset", agentTracker("Jira"), undefined, false],
    ["collector fires from command", recording, "command", true],
  ];
  for (const [name, tracker, process, expected] of cases) {
    test(name, () => expect(firesTrackerWriteback(tracker, process)).toBe(expected));
  }
});

describe("composeTaskWriteback", () => {
  const { tracker } = recordingTracker([]);

  test("links the ticket's recorded review URL with the mapped status", () => {
    const update = composeTaskWriteback(tracker, ticketOf({ reviewUrl: "https://review.example/7" }));
    expect(update.status).toBe("In Review");
    expect(update.comment).toContain("https://review.example/7");
  });

  test("falls back to the artifact url, then to a being-prepared note", () => {
    expect(composeTaskWriteback(tracker, ticketOf({}), "https://review.example/8").comment).toContain(
      "https://review.example/8"
    );
    expect(composeTaskWriteback(tracker, ticketOf({})).comment).toContain("being prepared");
  });

  test("never carries a priority", () => {
    expect(composeTaskWriteback(tracker, ticketOf({}))).not.toHaveProperty("priority");
  });
});

describe("writeBackTaskStatus", () => {
  test("sends only status and comment", async () => {
    const { tracker, updates } = recordingTracker([]);
    const widened = { status: "In Review", comment: "c", priority: "P0" } as TrackerStatusUpdate;
    const sent = await writeBackTaskStatus(tracker, "T-1", widened);
    expect(sent).toEqual({ status: "In Review", comment: "c" });
    expect(updates).toEqual([{ taskId: "T-1", update: { status: "In Review", comment: "c" } }]);
  });

  test("the none tracker refuses", async () => {
    await expect(writeBackTaskStatus(noneTracker, "T-1", {})).rejects.toThrow();
  });
});

describe("trackerWritebackFor — the directive the review nudge carries", () => {
  test("an agent tracker's ticket gets the directive, folded into the nudge", () => {
    const directive = trackerWritebackFor(agentTracker("Jira"), ticketOf({}), "https://review.example/1");
    expect(directive).toContain("Jira task T-1");
    expect(reviewAgentNudge(undefined, null, directive)).toContain("Jira task T-1");
  });

  test("no directive for a non-tracker ticket, the none tracker, or a collector-driven tracker", () => {
    expect(trackerWritebackFor(agentTracker("Jira"), ticketOf({ lens: "bugs" }))).toBeUndefined();
    expect(trackerWritebackFor(noneTracker, ticketOf({}))).toBeUndefined();
    expect(trackerWritebackFor(recordingTracker([]).tracker, ticketOf({}))).toBeUndefined();
  });
});

describe("end to end: ingest → session → review → writeback", () => {
  test("a fetched task becomes a work item, then its status and review link are written back", async () => {
    const store = setUp();
    try {
      const { tracker, updates } = recordingTracker([TASK]);
      const { ticket, task } = await fetchTaskAndIngest(store.db, tracker, { projectId: "p", taskId: "T-42" });
      expect(getTicketByIssueId(store.db, "p", task.id)!.id).toBe(ticket.id);

      updateTicketStatus(store.db, ticket.id, "approved");
      updateTicketStatus(store.db, ticket.id, "developing");
      setTicketSession(store.db, ticket.id, "S1");
      updateTicketStatus(store.db, ticket.id, "needs_review");
      setReviewUrl(store.db, ticket.id, "https://review.example/7");
      const reviewed = getTicket(store.db, ticket.id)!;

      const sent = await writeBackTaskStatus(tracker, reviewed.issueId!, composeTaskWriteback(tracker, reviewed));
      expect(updates).toHaveLength(1);
      expect(updates[0]!.taskId).toBe("T-42");
      expect(sent.status).toBe("In Review");
      expect(sent.comment).toContain("https://review.example/7");
    } finally {
      store.close();
    }
  });
});
