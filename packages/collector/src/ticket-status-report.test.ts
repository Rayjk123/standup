import { expect, test, describe } from "bun:test";
import { DEFAULT_IDENTITY_HEADER } from "@standup/shared";
import { createStore, upsertProject, createTicket } from "@standup/store";
import type { Store } from "@standup/store";
import { createServer } from "./server.js";

/**
 * The decoupled ticket lifecycle (wave 2): a ticket advances through its state
 * machine via POST /api/tickets/:id/status WITHOUT a Standup-owned launch — an
 * external agent or user reports progress, attributed to the reporting alias.
 * approve no longer auto-launches by default, and the rework edges
 * (needs_review -> developing, dismissed -> proposed/approved) are legal.
 *
 * These exercise app.request directly (no worktree/tmux), so no launch is ever
 * fired — which is exactly the point: none of the lifecycle here requires one.
 */

function setup() {
  const store = createStore(":memory:");
  const projectId = `ticket-status-${Math.random().toString(36).slice(2, 10)}`;
  upsertProject(store.db, {
    id: projectId,
    name: "Status Report Test",
    branch: "main",
    repos: [],
  });
  const app = createServer(store, () => {}, null);
  return { store, projectId, app };
}

function launchCount(store: Store): number {
  return (store.db.query("SELECT COUNT(*) AS n FROM launches").get() as { n: number }).n;
}

async function status(
  app: ReturnType<typeof createServer>,
  id: string,
  body: Record<string, unknown>,
  actor = "alice"
) {
  return app.request(`/api/tickets/${id}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json", [DEFAULT_IDENTITY_HEADER]: actor },
    body: JSON.stringify(body),
  });
}

describe("POST /api/tickets/:id/status — decoupled status reporting", () => {
  test("advances a ticket through its lifecycle with attribution and NO launch", async () => {
    const { store, projectId, app } = setup();
    try {
      const ticket = createTicket(store.db, {
        projectId,
        lens: "bugs",
        title: "External work",
        body: "Fixed elsewhere.",
      });

      // proposed -> approved, attributed to the reporting alias, no launch fired.
      let res = await status(app, ticket.id, { status: "approved" }, "bob");
      expect(res.status).toBe(200);
      let json = (await res.json()) as { ticket: { status: string; reportedByActor?: string } };
      expect(json.ticket.status).toBe("approved");
      expect(json.ticket.reportedByActor).toBe("bob");
      expect(launchCount(store)).toBe(0);

      // approved -> developing (an external agent claims the work).
      res = await status(app, ticket.id, { status: "developing", session_id: "sess-ext-1" }, "bob");
      expect(res.status).toBe(200);
      json = (await res.json()) as { ticket: { status: string; reportedByActor?: string } };
      expect(json.ticket.status).toBe("developing");
      // The reporting session is linked so the ticket resolves by session with no launch.
      const linked = store.db
        .query("SELECT session_id FROM tickets WHERE id = ?")
        .get(ticket.id) as { session_id: string | null };
      expect(linked.session_id).toBe("sess-ext-1");

      // developing -> needs_review, with a note + review URL, still launch-free.
      res = await status(app, ticket.id, {
        status: "needs_review",
        note: "Ready — see PR.",
        reviewUrl: "https://example.com/pr/1",
      }, "bob");
      expect(res.status).toBe(200);
      const reviewJson = (await res.json()) as {
        ticket: { status: string; readyReason?: string; reviewUrl?: string };
      };
      expect(reviewJson.ticket.status).toBe("needs_review");
      expect(reviewJson.ticket.readyReason).toBe("Ready — see PR.");
      expect(reviewJson.ticket.reviewUrl).toBe("https://example.com/pr/1");

      // needs_review -> shipped closes it out — no launch was ever created.
      res = await status(app, ticket.id, { status: "shipped" });
      expect(res.status).toBe(200);
      json = (await res.json()) as { ticket: { status: string } };
      expect(json.ticket.status).toBe("shipped");
      expect(launchCount(store)).toBe(0);
    } finally {
      store.close();
    }
  });

  test("rework edges: needs_review -> developing (send back) and un-dismiss", async () => {
    const { store, projectId, app } = setup();
    try {
      const t = createTicket(store.db, { projectId, lens: "bugs", title: "Rework", body: "" });

      // Drive it to needs_review the decoupled way.
      for (const s of ["approved", "developing", "needs_review"]) {
        const r = await status(app, t.id, { status: s });
        expect(r.status).toBe(200);
      }

      // Send it back for more work — the note is recorded on the ticket, not
      // dropped on this non-needs_review edge.
      let res = await status(app, t.id, { status: "developing", note: "Review found more." });
      expect(res.status).toBe(200);
      const sentBack = (await res.json()) as { ticket: { status: string; note?: string } };
      expect(sentBack.ticket.status).toBe("developing");
      expect(sentBack.ticket.note).toBe("Review found more.");

      // Dismiss with a note, then un-dismiss back to proposed (revive). The
      // dismiss rationale lands on the ticket too.
      res = await status(app, t.id, { status: "dismissed", note: "duplicate of TICK-12" });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { ticket: { note?: string } }).ticket.note).toBe(
        "duplicate of TICK-12"
      );
      res = await status(app, t.id, { status: "proposed" });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { ticket: { status: string } }).ticket.status).toBe("proposed");

      // Un-dismiss can also revive straight to approved.
      await status(app, t.id, { status: "dismissed" });
      res = await status(app, t.id, { status: "approved" });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { ticket: { status: string } }).ticket.status).toBe("approved");
    } finally {
      store.close();
    }
  });

  test("rejects an illegal transition with 409", async () => {
    const { store, projectId, app } = setup();
    try {
      const t = createTicket(store.db, { projectId, lens: "bugs", title: "Illegal", body: "" });
      // proposed -> shipped is not a legal edge.
      const res = await status(app, t.id, { status: "shipped" });
      expect(res.status).toBe(409);
    } finally {
      store.close();
    }
  });

  test("rejects an unknown status with 400", async () => {
    const { store, projectId, app } = setup();
    try {
      const t = createTicket(store.db, { projectId, lens: "bugs", title: "Bad", body: "" });
      const res = await status(app, t.id, { status: "bogus" });
      expect(res.status).toBe(400);
    } finally {
      store.close();
    }
  });
});

describe("POST /api/tickets/:id/approve — decoupled from dispatch", () => {
  test("does not auto-launch by default; only advances proposed -> approved", async () => {
    const { store, projectId, app } = setup();
    try {
      const t = createTicket(store.db, { projectId, lens: "bugs", title: "Approve only", body: "" });

      const res = await app.request(`/api/tickets/${t.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", [DEFAULT_IDENTITY_HEADER]: "carol" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ticket: { status: string; reportedByActor?: string };
        launch?: unknown;
      };
      expect(json.ticket.status).toBe("approved");
      expect(json.ticket.reportedByActor).toBe("carol");
      // No launch object in the response and no launch row in the store.
      expect(json.launch).toBeUndefined();
      expect(launchCount(store)).toBe(0);
      // The ticket carries no launch id either.
      const row = store.db
        .query("SELECT launch_id FROM tickets WHERE id = ?")
        .get(t.id) as { launch_id: string | null };
      expect(row.launch_id).toBeNull();
    } finally {
      store.close();
    }
  });
});
