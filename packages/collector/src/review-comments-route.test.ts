import { expect, test, describe } from "bun:test";
import {
  createStore,
  upsertProject,
  createTicket,
  createReviewFinding,
  createLaunch,
  setTicketLaunch,
  type Store,
} from "@standup/store";
import type { ReviewCommentsPayload } from "@standup/shared";
import { createServer } from "./server.js";

/**
 * The review-comments HTTP surface — the review-comment counterpart to Publish.
 * Exercises POST /api/tickets/:id/review-comments against the running app, so
 * the composer is proven reachable end-to-end (not orphaned): the dry-run
 * reviews-API payload comes back with only the High/critical findings as inline
 * comments, referencing the minted PR through the ticket's launch branch.
 */

function setup(): { store: Store } {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p1", name: "Proj", branch: "main", repos: [] });
  return { store };
}

function ticketId(store: Store): string {
  return createTicket(store.db, {
    projectId: "p1",
    lens: "correctness",
    title: "T",
    body: "b",
    severity: "high",
  }).id;
}

describe("POST /api/tickets/:id/review-comments", () => {
  test("404 for an unknown ticket", async () => {
    const { store } = setup();
    const app = createServer(store, () => {});
    const res = await app.request("/api/tickets/nope/review-comments", { method: "POST" });
    expect(res.status).toBe(404);
  });

  test("returns the dry-run payload with only High/critical inline comments", async () => {
    const { store } = setup();
    const t = ticketId(store);
    createReviewFinding(store.db, {
      ticketId: t, severity: "critical", title: "Data loss", file: "src/db.ts", line: 10,
    });
    createReviewFinding(store.db, {
      ticketId: t, severity: "high", title: "Unbounded loop", file: "src/w.ts", line: 42,
    });
    createReviewFinding(store.db, {
      ticketId: t, severity: "medium", title: "Nit", file: "src/x.ts", line: 5,
    });

    const app = createServer(store, () => {});
    const res = await app.request(`/api/tickets/${t}/review-comments`, { method: "POST" });
    expect(res.status).toBe(200);
    const { payload } = (await res.json()) as { payload: ReviewCommentsPayload };

    expect(payload.ticketId).toBe(t);
    expect(payload.comments).toHaveLength(2);
    expect(payload.comments.map((c) => c.path).sort()).toEqual(["src/db.ts", "src/w.ts"]);
    // The medium finding is recorded but never posted.
    expect(JSON.stringify(payload.comments)).not.toContain("Nit");
    // This build never posts — the command is returned for a human to run.
    expect(payload.live).toBe(false);
    expect(payload.commands.some((c) => c.startsWith("gh api"))).toBe(true);
  });

  test("references the minted PR via the ticket's launch branch + worktree", async () => {
    const { store } = setup();
    const t = ticketId(store);
    const impl = createLaunch(store.db, {
      id: "impl-1",
      projectId: "p1",
      task: "impl",
      worktreePath: "/tmp/impl-wt",
      branch: "standup/impl",
    });
    setTicketLaunch(store.db, t, impl.id);
    createReviewFinding(store.db, {
      ticketId: t, severity: "high", title: "Unbounded loop", file: "src/w.ts", line: 42,
    });

    const app = createServer(store, () => {});
    const res = await app.request(`/api/tickets/${t}/review-comments`, { method: "POST" });
    const { payload } = (await res.json()) as { payload: ReviewCommentsPayload };

    // The launch's real branch rides through, and the payload file lands beside
    // the change in that launch's worktree.
    expect(payload.branch).toBe("standup/impl");
    expect(payload.payloadFile.path).toBe("/tmp/impl-wt/.standup-pr-review.json");
    // No PR is minted in this build, so the owner/repo + PR number stay as
    // placeholders a human fills once the draft PR is opened.
    expect(payload.placeholders.length).toBeGreaterThan(0);
  });
});
