import { describe, expect, test } from "bun:test";
import { createStore, getTicket, getTicketByIssueId, upsertProject } from "@standup/store";
import { createServer } from "../server.js";
import { agentTracker, genericTrackerStatus, noneTracker, type TrackerAdapter } from "./adapter.js";
import { TRACKER_LENS } from "./sync.js";

/** POST /api/tickets/ingest-task: a tracker task becomes a work item, through the configured TrackerAdapter. */

function setup(tracker: TrackerAdapter) {
  const store = createStore(":memory:");
  const projectId = `ingest-${Math.random().toString(36).slice(2, 10)}`;
  upsertProject(store.db, { id: projectId, name: "Ingest Test", branch: "main", repos: [] });
  const app = createServer(
    store, () => {}, null, undefined, undefined, "", "", {}, undefined, undefined, undefined, undefined,
    {}, {}, {}, {}, {}, {}, undefined, undefined, { tracker }
  );
  return { store, projectId, app };
}

function ingest(app: ReturnType<typeof createServer>, body: Record<string, unknown>) {
  return app.request("/api/tickets/ingest-task", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function ticketCount(store: ReturnType<typeof createStore>): number {
  return (store.db.query("SELECT COUNT(*) AS n FROM tickets").get() as { n: number }).n;
}

describe("POST /api/tickets/ingest-task", () => {
  test("refuses with 409 when no tracker is configured (the default)", async () => {
    const { store, projectId, app } = setup(noneTracker);
    try {
      const res = await ingest(app, { projectId, taskId: "T-1", title: "x" });
      expect(res.status).toBe(409);
      expect(ticketCount(store)).toBe(0);
    } finally {
      store.close();
    }
  });

  test("ingests a task as a proposed, tracker-lens work item carrying the task id", async () => {
    const { store, projectId, app } = setup(agentTracker("Jira"));
    try {
      const res = await ingest(app, {
        projectId,
        taskId: "T-42",
        title: "Add retry",
        description: "Retry on 5xx.",
        severity: "high",
        url: "https://tracker.example/T-42",
      });
      expect(res.status).toBe(201);
      const json = (await res.json()) as {
        ticket: { id: string; lens: string; status: string; issueId: string; severity: string; taskUrl?: string };
        created: boolean;
      };
      expect(json.created).toBe(true);
      expect(json.ticket.lens).toBe(TRACKER_LENS);
      expect(json.ticket.status).toBe("proposed");
      expect(json.ticket.issueId).toBe("T-42");
      expect(json.ticket.severity).toBe("high");
      expect(getTicket(store.db, json.ticket.id)!.taskUrl).toBe("https://tracker.example/T-42");
      expect(getTicketByIssueId(store.db, projectId, "T-42")!.id).toBe(json.ticket.id);
    } finally {
      store.close();
    }
  });

  test("is idempotent per project", async () => {
    const { store, projectId, app } = setup(agentTracker("Jira"));
    try {
      const first = (await (await ingest(app, { projectId, taskId: "T-42", title: "x" })).json()) as { ticket: { id: string } };
      const second = await ingest(app, { projectId, taskId: "T-42", title: "x again" });
      expect(second.status).toBe(200);
      const json = (await second.json()) as { ticket: { id: string }; created: boolean };
      expect(json.created).toBe(false);
      expect(json.ticket.id).toBe(first.ticket.id);
      expect(ticketCount(store)).toBe(1);
    } finally {
      store.close();
    }
  });

  test("fetches the task through the adapter when only its id is given", async () => {
    const fetching: TrackerAdapter = {
      ...agentTracker("Fetcher"),
      id: "fetching",
      writeback: "collector",
      async getTask(taskId) {
        return { id: taskId, title: `fetched ${taskId}` };
      },
      async updateTask() {},
      statusFor: genericTrackerStatus,
    };
    const { store, projectId, app } = setup(fetching);
    try {
      const res = await ingest(app, { projectId, taskId: "T-7" });
      expect(res.status).toBe(201);
      const json = (await res.json()) as { ticket: { title: string } };
      expect(json.ticket.title).toBe("fetched T-7");
    } finally {
      store.close();
    }
  });

  test("without a title, an adapter that can't fetch answers 400", async () => {
    const { store, projectId, app } = setup(agentTracker("Jira"));
    try {
      expect((await ingest(app, { projectId, taskId: "T-7" })).status).toBe(400);
      expect(ticketCount(store)).toBe(0);
    } finally {
      store.close();
    }
  });

  test("surfaces the writeback constraint — a pause project warns, a review-agent one does not", async () => {
    const { store, projectId, app } = setup(agentTracker("Jira"));
    try {
      const paused = (await (await ingest(app, { projectId, taskId: "T-1", title: "x" })).json()) as {
        autoWriteback: boolean;
        warning?: string;
      };
      expect(paused.autoWriteback).toBe(false);
      expect(paused.warning).toContain("Jira task status");

      const agentId = `ingest-agent-${Math.random().toString(36).slice(2, 10)}`;
      upsertProject(store.db, { id: agentId, name: "Agent", branch: "main", repos: [], reviewProcess: "review-agent" });
      const agent = (await (await ingest(app, { projectId: agentId, taskId: "T-2", title: "x" })).json()) as {
        autoWriteback: boolean;
        warning?: string;
      };
      expect(agent.autoWriteback).toBe(true);
      expect(agent.warning).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test("rejects an unknown project, a missing taskId and an unknown severity", async () => {
    const { store, projectId, app } = setup(agentTracker("Jira"));
    try {
      expect((await ingest(app, { projectId: "nope", taskId: "T", title: "x" })).status).toBe(404);
      expect((await ingest(app, { projectId, title: "x" })).status).toBe(400);
      expect((await ingest(app, { projectId, taskId: "T", title: "x", severity: "epic" })).status).toBe(400);
      expect(ticketCount(store)).toBe(0);
    } finally {
      store.close();
    }
  });
});
