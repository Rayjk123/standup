import { expect, test, describe } from "bun:test";
import { DEFAULT_IDENTITY_HEADER } from "@standup/shared";
import { randomUUID } from "crypto";
import {
  createStore,
  upsertProject,
  createTicket,
  updateTicketStatus,
  getTicket,
  createLaunch,
  createTaskRun,
  updateTaskRunStatus,
  getTaskRunsByAttemptGroup,
  countActiveTaskRuns,
} from "@standup/store";
import type { Store } from "@standup/store";
import { OWNER_TOKEN_HEADER } from "@standup/shared/owner-token";
import { createServer } from "./server.js";
import type { LaunchFn } from "./server.js";
import { generateOwnerSecrets } from "./owner-secret.js";
import { PERSONA_TOKEN_HEADER } from "./persona/routes.js";

/**
 * POST /api/tickets/:id/dispatch — the interaction between a best-of-N dispatch
 * and a later SINGLE re-dispatch. A ticket first dispatched as N attempts carries
 * an attempt_group; re-dispatching it as one launch must CLEAR that group, or the
 * stale compare/pick panel stays live over dead attempts and a pick would repoint
 * the ticket back at a superseded launch — feeding the Publisher the wrong branch.
 *
 * The launch is MOCKED through createServer's injectable `launchFn` seam, so these
 * exercise the route wiring WITHOUT provisioning a worktree or spawning `claude`.
 */

/**
 * A launch seam that records the rows the real launcher would — a launch plus its
 * ledger run sharing a worktree, stamped with the attempt group — without any git
 * or tmux. Returns the captured requests so a test can assert what it was asked.
 */
function mockLaunchFn(): { fn: LaunchFn; calls: Array<{ attemptGroup?: string; inPlace?: boolean }> } {
  let n = 0;
  const calls: Array<{ attemptGroup?: string; inPlace?: boolean }> = [];
  const fn = (async (db: Store["db"], req: { project: { id: string; branch: string }; task: string; label?: string; requester?: string; attemptGroup?: string; inPlace?: boolean }) => {
    calls.push({ attemptGroup: req.attemptGroup, inPlace: req.inPlace });
    n += 1;
    const worktreePath = `/wt/${req.attemptGroup ?? "solo"}/${n}`;
    const launch = createLaunch(db, {
      id: `L-${n}-${randomUUID().slice(0, 4)}`,
      projectId: req.project.id,
      task: req.label ?? req.task,
      worktreePath,
      branch: `standup/${n}`,
      baseBranch: req.project.branch,
      tmuxSession: `tm-${n}`,
      status: "running",
      requester: req.requester,
    });
    createTaskRun(db, {
      id: `R-${n}-${randomUUID().slice(0, 4)}`,
      projectId: req.project.id,
      worktreePath,
      requester: req.requester,
      attemptGroup: req.attemptGroup,
    });
    return { launch, log: [] };
  }) as unknown as LaunchFn;
  return { fn, calls };
}

function setUp(): { store: Store; app: ReturnType<typeof createServer>; ticketId: string; person: Record<string, string> } {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: ["/repo"] });
  const ticket = createTicket(store.db, { projectId: "p", lens: "bugs", title: "Fix it", body: "the bug" });
  updateTicketStatus(store.db, ticket.id, "approved");
  const { fn } = mockLaunchFn();
  const ownerSecrets = generateOwnerSecrets();
  const app = createServer(store, () => {}, null, undefined, undefined, "", "", {}, undefined, undefined, fn, undefined, { ownerSecrets });
  // A signed-in person in the console: the owner token the console's proxy adds, and their identity.
  const person = { [OWNER_TOKEN_HEADER]: ownerSecrets.ownerToken, [DEFAULT_IDENTITY_HEADER]: "alice" };
  return { store, app, ticketId: ticket.id, person };
}

function dispatch(app: ReturnType<typeof createServer>, id: string, body: Record<string, unknown>) {
  return app.request(`/api/tickets/${id}/dispatch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/tickets/:id/dispatch — best-of-N then single re-dispatch", () => {
  test("a single re-dispatch clears the stale attempt group and repoints the ticket", async () => {
    const { store, app, ticketId, person } = setUp();

    // 1. Best-of-N: two grouped attempts.
    const first = await dispatch(app, ticketId, { attempts: 2 });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { attemptGroup: string; launches: Array<{ id: string }> };
    const g1 = firstBody.attemptGroup;
    expect(g1).toBeTruthy();
    const afterBestOfN = getTicket(store.db, ticketId)!;
    expect(afterBestOfN.attemptGroup).toBe(g1);
    expect(firstBody.launches).toHaveLength(2);

    // 2. Both attempts reach a terminal state without a pick, so the double-click
    //    guard lets the ticket be re-dispatched.
    const groupRuns = getTaskRunsByAttemptGroup(store.db, g1);
    expect(groupRuns).toHaveLength(2);
    for (const run of groupRuns) updateTaskRunStatus(store.db, run.id, "lost", { error: "pane gone" });

    // 3. Single re-dispatch (attempts defaults to 1).
    const second = await dispatch(app, ticketId, {});
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { launch: { id: string } };

    // The stale group is gone and the ticket points at the fresh single launch.
    const afterSingle = getTicket(store.db, ticketId)!;
    expect(afterSingle.attemptGroup).toBeUndefined();
    expect(afterSingle.launchId).toBe(secondBody.launch.id);

    // 4. The compare panel is empty — no dead attempts linger.
    const attemptsRes = await app.request(`/api/tickets/${ticketId}/attempts`);
    const attemptsBody = (await attemptsRes.json()) as { attemptGroup: string | null; attempts: unknown[] };
    expect(attemptsBody.attemptGroup).toBeNull();
    expect(attemptsBody.attempts).toHaveLength(0);

    // 5. Picking one of the OLD attempts is now refused — it can no longer clobber
    //    the fresh launch or feed the Publisher a superseded branch.
    const pick = await app.request(`/api/tickets/${ticketId}/pick-attempt`, {
      method: "POST",
      headers: { "content-type": "application/json", ...person },
      body: JSON.stringify({ taskRunId: groupRuns[0]!.id }),
    });
    expect(pick.status).toBe(400);
    // The ticket still points at the fresh launch, not the old attempt's.
    expect(getTicket(store.db, ticketId)!.launchId).toBe(secondBody.launch.id);
  });
});

describe("POST /api/tickets/:id/pick-attempt — only a person picks", () => {
  test("a request without the owner token (a worker, an agent) is refused before anything changes", async () => {
    const { store, app, ticketId, person } = setUp();
    const first = await dispatch(app, ticketId, { attempts: 2 });
    const { attemptGroup } = (await first.json()) as { attemptGroup: string };
    // Both attempts finished, so the pick has no live loser pane to stop.
    for (const run of getTaskRunsByAttemptGroup(store.db, attemptGroup)) {
      updateTaskRunStatus(store.db, run.id, "running");
      updateTaskRunStatus(store.db, run.id, "succeeded");
    }
    const [a] = getTaskRunsByAttemptGroup(store.db, attemptGroup);
    const pick = (headers: Record<string, string>) =>
      app.request(`/api/tickets/${ticketId}/pick-attempt`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ taskRunId: a!.id }),
      });

    const refused = await pick({ [DEFAULT_IDENTITY_HEADER]: "alice" });
    expect(refused.status).toBe(403);
    expect(getTaskRunsByAttemptGroup(store.db, attemptGroup).every((r) => r.attemptStatus !== "selected")).toBe(true);
    expect((await pick({ ...person, [PERSONA_TOKEN_HEADER]: "persona" })).status).toBe(403);

    const picked = await pick(person);
    expect(picked.status).toBe(200);
    expect(getTaskRunsByAttemptGroup(store.db, attemptGroup).find((r) => r.id === a!.id)!.attemptStatus).toBe("selected");
  });
});

describe("POST /api/tickets/:id/dispatch — concurrent double-dispatch", () => {
  test("two concurrent dispatches of one ticket create only ONE active run", async () => {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: ["/repo"] });
    const ticket = createTicket(store.db, { projectId: "p", lens: "bugs", title: "Fix it", body: "the bug" });
    updateTicketStatus(store.db, ticket.id, "approved");

    // A launch seam that reserves the run exactly like the real launcher (a launch
    // plus a queued task_run sharing a worktree) but holds briefly before
    // returning, so BOTH concurrent requests are genuinely in flight at once — the
    // window the double-dispatch guard has to cover. Distinct worktree paths per
    // call, so the ONLY thing that can refuse the second request is the guard
    // itself (not the launcher's per-worktree serialization).
    let n = 0;
    const launchFn = (async (
      db: Store["db"],
      req: { project: { id: string; branch: string }; task: string; label?: string; requester?: string }
    ) => {
      n += 1;
      const worktreePath = `/wt/solo/${n}`;
      const launch = createLaunch(db, {
        id: `L-${n}`,
        projectId: req.project.id,
        task: req.label ?? req.task,
        worktreePath,
        branch: `standup/${n}`,
        baseBranch: req.project.branch,
        tmuxSession: `tm-${n}`,
        status: "running",
        requester: req.requester,
      });
      createTaskRun(db, { id: `R-${n}`, projectId: req.project.id, worktreePath, requester: req.requester });
      await new Promise((r) => setTimeout(r, 20));
      return { launch, log: [] };
    }) as unknown as LaunchFn;

    const app = createServer(store, () => {}, null, undefined, undefined, "", "", {}, undefined, undefined, launchFn);

    const [a, b] = await Promise.all([dispatch(app, ticket.id, {}), dispatch(app, ticket.id, {})]);

    // Exactly one dispatch won; the other was refused as a double-dispatch.
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    // And only ONE active run was reserved — no duplicate agent on the ticket.
    expect(countActiveTaskRuns(store.db)).toBe(1);
  });

  // Pins the in-process in-flight reservation specifically. Neither concurrent
  // request has an active run at guard time (the run is created inside the held
  // launch seam), so the ONLY thing that can refuse the loser is the
  // `ticketsDispatching` set — the loser must carry the guard's own 409 message,
  // not some other conflict. Catches the guard being short-circuited away while
  // the (unreachable) active-run branch still passes.
  test("the loser is refused by the in-flight guard with its own 409 message", async () => {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: ["/repo"] });
    const ticket = createTicket(store.db, { projectId: "p", lens: "bugs", title: "Fix it", body: "the bug" });
    updateTicketStatus(store.db, ticket.id, "approved");

    let n = 0;
    const launchFn = (async (
      db: Store["db"],
      req: { project: { id: string; branch: string }; task: string; label?: string; requester?: string }
    ) => {
      n += 1;
      const worktreePath = `/wt/solo/${n}`;
      const launch = createLaunch(db, {
        id: `L-${n}`,
        projectId: req.project.id,
        task: req.label ?? req.task,
        worktreePath,
        branch: `standup/${n}`,
        baseBranch: req.project.branch,
        tmuxSession: `tm-${n}`,
        status: "running",
        requester: req.requester,
      });
      createTaskRun(db, { id: `R-${n}`, projectId: req.project.id, worktreePath, requester: req.requester });
      await new Promise((r) => setTimeout(r, 20));
      return { launch, log: [] };
    }) as unknown as LaunchFn;

    const app = createServer(store, () => {}, null, undefined, undefined, "", "", {}, undefined, undefined, launchFn);

    const [a, b] = await Promise.all([dispatch(app, ticket.id, {}), dispatch(app, ticket.id, {})]);
    const loser = a.status === 409 ? a : b;
    expect(loser.status).toBe(409);
    const loserBody = (await loser.json()) as { error: string };
    expect(loserBody.error).toBe("A run is already active for this ticket — stop it before re-dispatching.");
    // Only one launch ever ran — the guard refused the loser before it reached the seam.
    expect(n).toBe(1);
    expect(countActiveTaskRuns(store.db)).toBe(1);
  });
});

/**
 * POST /api/tickets/:id/approve?dispatch=true — the board's opt-in "approve =
 * start work". It launches an implementation session and only advances the ticket
 * proposed -> approved at the END of the handler, so two rapid clicks would both
 * read status 'proposed', both launch, and spawn two agents on one ticket — the
 * loser only 409s afterward, once its agent is already live. The same
 * double-dispatch guard the /dispatch route uses must cover this sibling path.
 */
describe("POST /api/tickets/:id/approve?dispatch=true — concurrent double-approve", () => {
  test("two concurrent approve-dispatches of one proposed ticket launch only ONE agent", async () => {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: ["/repo"] });
    // Left 'proposed' — approve advances it only after the launch settles.
    const ticket = createTicket(store.db, { projectId: "p", lens: "bugs", title: "Fix it", body: "the bug" });

    // A launch seam that reserves the run exactly like the real launcher, then
    // holds briefly so BOTH requests are genuinely in flight at once — the window
    // the guard must cover. Distinct worktree paths per call, so the ONLY thing
    // that can refuse the second request is the guard itself.
    let n = 0;
    const launchFn = (async (
      db: Store["db"],
      req: { project: { id: string; branch: string }; task: string; label?: string; requester?: string }
    ) => {
      n += 1;
      const worktreePath = `/wt/approve/${n}`;
      const launch = createLaunch(db, {
        id: `L-${n}`,
        projectId: req.project.id,
        task: req.label ?? req.task,
        worktreePath,
        branch: `standup/${n}`,
        baseBranch: req.project.branch,
        tmuxSession: `tm-${n}`,
        status: "running",
        requester: req.requester,
      });
      createTaskRun(db, { id: `R-${n}`, projectId: req.project.id, worktreePath, requester: req.requester });
      await new Promise((r) => setTimeout(r, 20));
      return { launch, log: [] };
    }) as unknown as LaunchFn;

    const app = createServer(store, () => {}, null, undefined, undefined, "", "", {}, undefined, undefined, launchFn);
    const approve = () =>
      app.request(`/api/tickets/${ticket.id}/approve?dispatch=true`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });

    const [a, b] = await Promise.all([approve(), approve()]);

    // One approve-dispatch won; the other was refused as a double-dispatch.
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    // Only ONE agent (launch + active run) — no orphaned second worktree.
    expect(n).toBe(1);
    expect(countActiveTaskRuns(store.db)).toBe(1);
    // The ticket advanced exactly once and anchors to the single launch.
    expect(getTicket(store.db, ticket.id)!.status).toBe("approved");
  });
});
