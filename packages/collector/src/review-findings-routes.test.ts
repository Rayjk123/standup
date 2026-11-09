import { expect, test, describe } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  createStore,
  upsertProject,
  createTicket,
  createReviewFinding,
  getReviewFinding,
  createLaunch,
  setTicketLaunch,
  type Store,
} from "@standup/store";
import { createServer } from "./server.js";

/**
 * The review-findings HTTP surface (reviewer/fixer split). Exercises the routes
 * against the running app: the High-only queue, the dismiss edge, and — the
 * safety invariant — that a fixer is dispatched ONLY on the explicit POST .../fix
 * click, never as a side effect of a finding existing, and that a launch failure
 * leaves the finding `open` rather than falsely `dispatched`.
 */

function setup(): { store: Store } {
  const store = createStore(":memory:");
  // No repo: launchSession's precondition fails synchronously, so the fixer
  // dispatch returns an error WITHOUT starting a real session — exactly the
  // seam we want to exercise the ordering guard against.
  upsertProject(store.db, { id: "p1", name: "Proj", branch: "main", repos: [] });
  return { store };
}

function ticketId(store: Store): string {
  return createTicket(store.db, {
    projectId: "p1",
    lens: "correctness",
    title: "T",
    body: "b",
  }).id;
}

describe("GET /api/review-findings", () => {
  test("lists only High/critical, still-open findings", async () => {
    const { store } = setup();
    const t = ticketId(store);
    createReviewFinding(store.db, { ticketId: t, severity: "high", title: "H" });
    createReviewFinding(store.db, { ticketId: t, severity: "medium", title: "M" });
    createReviewFinding(store.db, { ticketId: t, severity: "critical", title: "C" });

    const app = createServer(store, () => {});
    const res = await app.request("/api/review-findings");
    expect(res.status).toBe(200);
    const findings = (await res.json()) as { title: string }[];
    expect(findings.map((f) => f.title).sort()).toEqual(["C", "H"]);
  });

  test("GET /api/tickets/:id/findings returns the full set (all severities)", async () => {
    const { store } = setup();
    const t = ticketId(store);
    createReviewFinding(store.db, { ticketId: t, severity: "high", title: "H" });
    createReviewFinding(store.db, { ticketId: t, severity: "low", title: "L" });

    const app = createServer(store, () => {});
    const res = await app.request(`/api/tickets/${t}/findings`);
    const findings = (await res.json()) as unknown[];
    expect(findings).toHaveLength(2);
  });
});

describe("POST /api/review-findings/:id/fix", () => {
  test("404 for an unknown finding", async () => {
    const { store } = setup();
    const app = createServer(store, () => {});
    const res = await app.request("/api/review-findings/nope/fix", { method: "POST" });
    expect(res.status).toBe(404);
  });

  test("409 for a finding that is not open (already dispatched/dismissed) — never re-dispatches", async () => {
    const { store } = setup();
    const t = ticketId(store);
    const f = createReviewFinding(store.db, { ticketId: t, severity: "high", title: "H" });
    // Take it out of `open`.
    const app = createServer(store, () => {});
    await app.request(`/api/review-findings/${f.id}/dismiss`, { method: "POST" });

    const res = await app.request(`/api/review-findings/${f.id}/fix`, { method: "POST" });
    expect(res.status).toBe(409);
    // A non-open finding is never re-dispatched: it stays exactly as it was.
    expect(getReviewFinding(store.db, f.id)!.status).toBe("dismissed");
  });

  test("the fixer runs IN the ticket's implementation worktree, where the reviewed change lives", async () => {
    // The change under review is in the ticket's implementation worktree, not on
    // the base branch — so the fixer must launch there, else it opens pristine
    // baseline files. A missing launchSubdir makes the detached launch work fail
    // fast (before spawning any agent) while still proving the synchronous launch
    // row was pointed at the reused worktree.
    const implWorktree = await mkdtemp(join(tmpdir(), "standup-impl-worktree-"));
    try {
      const store = createStore(":memory:");
      upsertProject(store.db, {
        id: "p1",
        name: "Proj",
        branch: "main",
        repos: [],
        launchSubdir: "does-not-exist",
      });
      const t = createTicket(store.db, {
        projectId: "p1",
        lens: "correctness",
        title: "T",
        body: "b",
      }).id;
      // The ticket's implementation launch — its worktree holds the reviewed change.
      const impl = createLaunch(store.db, {
        id: "impl-1",
        projectId: "p1",
        task: "impl",
        worktreePath: implWorktree,
        branch: "standup/impl",
      });
      setTicketLaunch(store.db, t, impl.id);
      const f = createReviewFinding(store.db, { ticketId: t, severity: "high", title: "H" });

      const app = createServer(store, () => {});
      const res = await app.request(`/api/review-findings/${f.id}/fix`, { method: "POST" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { launch: { worktreePath: string; inPlace?: boolean } };
      // The fixer launch reuses the ticket's implementation worktree verbatim —
      // NOT a fresh base-branch worktree under the project's worktree root.
      expect(body.launch.worktreePath).toBe(implWorktree);
    } finally {
      await rm(implWorktree, { recursive: true, force: true });
    }
  });

  test("an ASYNC launch failure reverts the finding to open — not stranded as dispatched", async () => {
    // Preconditions pass (repo path exists, tmux is present), so launchSession
    // returns 200 and the finding is marked `dispatched`; the detached spawn
    // then fails because the repo dir is not a git repository, marking the
    // launch `failed` in the background. The endpoint must react to that and
    // reopen the finding so it re-surfaces on the queue and is re-dispatchable.
    const worktreeRoot = await mkdtemp(join(tmpdir(), "standup-fixfail-root-"));
    const notAGitRepo = await mkdtemp(join(tmpdir(), "standup-fixfail-repo-"));
    const priorRoot = process.env.STANDUP_WORKTREE_ROOT;
    process.env.STANDUP_WORKTREE_ROOT = worktreeRoot;
    try {
      const store = createStore(":memory:");
      upsertProject(store.db, {
        id: "p1",
        name: "Proj",
        branch: "main",
        repos: [notAGitRepo],
      });
      const t = createTicket(store.db, {
        projectId: "p1",
        lens: "correctness",
        title: "T",
        body: "b",
      }).id;
      const f = createReviewFinding(store.db, { ticketId: t, severity: "high", title: "H" });

      const app = createServer(store, () => {});
      const res = await app.request(`/api/review-findings/${f.id}/fix`, { method: "POST" });
      // The dispatch itself succeeds — the launch row is created and the finding
      // is optimistically marked dispatched before the spawn work runs.
      expect(res.status).toBe(200);

      // Once the detached launch fails, the finding flips back to open.
      const start = Date.now();
      let status = getReviewFinding(store.db, f.id)!.status;
      while (status !== "open" && Date.now() - start < 20_000) {
        await new Promise((r) => setTimeout(r, 50));
        status = getReviewFinding(store.db, f.id)!.status;
      }
      expect(status).toBe("open");
      // Re-dispatchable: the queue lists it again.
      const queued = (await (await app.request("/api/review-findings")).json()) as {
        id: string;
      }[];
      expect(queued.some((q) => q.id === f.id)).toBe(true);
    } finally {
      if (priorRoot === undefined) delete process.env.STANDUP_WORKTREE_ROOT;
      else process.env.STANDUP_WORKTREE_ROOT = priorRoot;
      await rm(worktreeRoot, { recursive: true, force: true });
      await rm(notAGitRepo, { recursive: true, force: true });
    }
  });
});

describe("POST /api/review-findings/:id/dismiss", () => {
  test("drops the finding off the High-open queue", async () => {
    const { store } = setup();
    const t = ticketId(store);
    const f = createReviewFinding(store.db, { ticketId: t, severity: "high", title: "H" });

    const app = createServer(store, () => {});
    let res = await app.request("/api/review-findings");
    expect((await res.json()) as unknown[]).toHaveLength(1);

    res = await app.request(`/api/review-findings/${f.id}/dismiss`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(getReviewFinding(store.db, f.id)!.status).toBe("dismissed");

    res = await app.request("/api/review-findings");
    expect((await res.json()) as unknown[]).toHaveLength(0);
  });
});

describe("SAFETY: a finding is never auto-dispatched", () => {
  test("creating findings (the reviewer's job) never marks any dispatched", async () => {
    const { store } = setup();
    const t = ticketId(store);
    const a = createReviewFinding(store.db, { ticketId: t, severity: "high", title: "A" });
    const b = createReviewFinding(store.db, { ticketId: t, severity: "critical", title: "B" });

    // Build the app + list the queue: no dispatch side effect from any of that.
    const app = createServer(store, () => {});
    await app.request("/api/review-findings");

    expect(getReviewFinding(store.db, a.id)!.status).toBe("open");
    expect(getReviewFinding(store.db, b.id)!.status).toBe("open");
    expect(getReviewFinding(store.db, a.id)!.fixLaunchId).toBeUndefined();
  });
});
