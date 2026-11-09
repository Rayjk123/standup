import { expect, test, describe } from "bun:test";
import { DEFAULT_IDENTITY_HEADER } from "@standup/shared";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStore,
  createSession,
  getProject,
  getPendingAsks,
  setSetting,
  upsertProject,
} from "@standup/store";
import type { Store } from "@standup/store";
import { OWNER_TOKEN_HEADER } from "@standup/shared/owner-token";
import { generateOwnerSecrets } from "./owner-secret.js";
import { ensureLocalWriteToken, readLocalWriteToken } from "@standup/shared/write-token";
import {
  createServer,
  isProposalApproval,
  buildStandupImprovementTask,
  setLocalWriteToken,
} from "./server.js";
import type { LaunchFn } from "./server.js";
import { MULTIPLAYER_OVERRIDE_SETTING } from "./multiplayer.js";

/**
 * propose_standup_improvement (the self-improvement loop) — POST /api/standup/improve.
 *
 * The launch is MOCKED via createServer's injectable `launchFn` seam, so these
 * assert the confirmation gate and the self-project targeting WITHOUT ever
 * provisioning a worktree or spawning a real `claude` (the capabilities-only
 * constraint on this loop). We assert it (a) requires confirmation, (b) targets
 * the "standup" self project, and (c) never launches without approval.
 */

const CALLER_CWD = "/tmp/standup-improve-caller";

interface CapturedLaunch {
  project: { id: string; reserved?: boolean };
  task: string;
  label?: string;
  inPlace?: boolean;
}

function setUp(): { store: Store; launchCalls: CapturedLaunch[]; launchFn: LaunchFn } {
  const store = createStore(":memory:");
  // The session's project_id is a FK — the scratch project must exist first.
  upsertProject(store.db, { id: "scratch", name: "scratch", branch: "main", repos: [] });
  // A calling session the confirmation ask attaches to.
  createSession(store.db, {
    id: "caller-session",
    projectId: "scratch",
    title: "caller",
    cwd: CALLER_CWD,
    status: "running",
  });

  const launchCalls: CapturedLaunch[] = [];
  const launchFn = (async (_db: unknown, request: CapturedLaunch) => {
    launchCalls.push(request);
    return {
      launch: {
        id: "mock-launch-1",
        projectId: request.project.id,
        status: "starting",
      },
      log: [],
    };
  }) as unknown as LaunchFn;

  return { store, launchCalls, launchFn };
}

/** The owner secret the server checks allowing a self-fix against. */
const secrets = generateOwnerSecrets();

/** Build the server with every default preserved but the launch seam mocked. */
function serverWith(store: Store, launchFn: LaunchFn) {
  return createServer(
    store,
    () => {}, // broadcast
    null, // embeddingProvider
    undefined, // knowledgeSync
    undefined, // registry
    "", // knowledgeDir
    "", // iconsDir
    {}, // embeddingConfig
    undefined, // autoReviewDeps -> default
    undefined, // tailer
    launchFn,
    undefined, // identityConfig
    { ownerSecrets: secrets }
  );
}

async function firstPendingAskId(store: Store, timeoutMs = 3000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const asks = getPendingAsks(store.db);
    if (asks.length > 0) return asks[0].id;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("no pending ask appeared");
}

function propose(
  app: ReturnType<typeof serverWith>,
  body: Record<string, unknown> = {},
  extraHeaders: Record<string, string> = {}
) {
  return app.request("/api/standup/improve", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify({
      session_id: "caller-session",
      cwd: CALLER_CWD,
      title: "search_knowledge crashes on empty corpus",
      description: "It throws instead of returning no results. Fix the empty-corpus path.",
      kind: "bug",
      ...body,
    }),
  });
}

function resolveAsk(app: ReturnType<typeof serverWith>, askId: string, answer: string) {
  return app.request(`/api/asks/${askId}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", [OWNER_TOKEN_HEADER]: secrets.ownerToken },
    body: JSON.stringify({ answer }),
  });
}

describe("POST /api/standup/improve — confirmation gate", () => {
  test("requires confirmation, then on approval launches against the 'standup' self project", async () => {
    const { store, launchCalls, launchFn } = setUp();
    const app = serverWith(store, launchFn);

    // Fire the proposal — it blocks on the confirmation ask.
    const pending = propose(app);

    // (a) A confirmation ask is created and NOTHING is launched yet.
    const askId = await firstPendingAskId(store);
    expect(launchCalls).toHaveLength(0);

    // Approve via the same resolve path the console uses.
    await resolveAsk(app, askId, "Fire the fix");

    const res = await pending;
    const json = (await res.json()) as {
      launched: boolean;
      status: string;
      projectId: string;
      launch?: { id: string };
    };

    expect(res.status).toBe(200);
    expect(json.launched).toBe(true);
    expect(json.status).toBe("launched");
    // (b) The launch targets the RESERVED self-fix project (its own id namespace,
    // never a user's plain "standup" project) in a fresh worktree, not in place.
    expect(json.projectId).toBe("standup-self");
    expect(launchCalls).toHaveLength(1);
    expect(launchCalls[0].project.id).toBe("standup-self");
    expect(launchCalls[0].project.reserved).toBe(true);
    expect(launchCalls[0].inPlace).toBe(false);
    expect(launchCalls[0].task).toContain("STANDUP ITSELF");

    // The self project exists, is reserved (hidden from the launch picker), and
    // is anchored to a repo — it is launched only via this endpoint, never by hand.
    const selfProject = getProject(store.db, "standup-self");
    expect(selfProject).toBeTruthy();
    expect(selfProject!.reserved).toBe(true);
    expect(selfProject!.repos.length).toBeGreaterThan(0);
    // A user's own plain "standup" project (if any) is never touched by this path.
  });

  test("(c) declining launches NOTHING", async () => {
    const { store, launchCalls, launchFn } = setUp();
    const app = serverWith(store, launchFn);

    const pending = propose(app);
    const askId = await firstPendingAskId(store);
    expect(launchCalls).toHaveLength(0);

    await resolveAsk(app, askId, "Not now");

    const res = await pending;
    const json = (await res.json()) as { launched: boolean; status: string };
    expect(json.launched).toBe(false);
    expect(json.status).toBe("declined");
    // Never launched.
    expect(launchCalls).toHaveLength(0);
    // No self project was created for a declined proposal.
    expect(getProject(store.db, "standup-self")).toBeFalsy();
  });

  test("dismissing the ask (empty answer) launches NOTHING", async () => {
    const { store, launchCalls, launchFn } = setUp();
    const app = serverWith(store, launchFn);

    const pending = propose(app);
    const askId = await firstPendingAskId(store);

    // A dismiss deletes/cancels the ask — the waiter resolves as if timed out.
    await app.request(`/api/asks/${askId}`, { method: "DELETE" });

    const res = await pending;
    const json = (await res.json()) as { launched: boolean };
    expect(json.launched).toBe(false);
    expect(launchCalls).toHaveLength(0);
  });

  test("validates title / description / kind before creating any ask", async () => {
    const { store, launchFn } = setUp();
    const app = serverWith(store, launchFn);

    const badKind = await propose(app, { kind: "typo" });
    expect(badKind.status).toBe(400);

    const noTitle = await propose(app, { title: "" });
    expect(noTitle.status).toBe(400);

    // No pending ask was created by the rejected requests.
    expect(getPendingAsks(store.db)).toHaveLength(0);
  });

  test("(M3) requires the write token when STANDUP_WRITE_TOKEN is configured", async () => {
    const prev = process.env.STANDUP_WRITE_TOKEN;
    process.env.STANDUP_WRITE_TOKEN = "sekret";
    try {
      const { store, launchCalls, launchFn } = setUp();
      const app = serverWith(store, launchFn);
      // No x-standup-write-token header → gated before any ask or launch.
      const res = await propose(app);
      expect(res.status).toBe(403);
      expect(getPendingAsks(store.db)).toHaveLength(0);
      expect(launchCalls).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.STANDUP_WRITE_TOKEN;
      else process.env.STANDUP_WRITE_TOKEN = prev;
    }
  });
});

describe("POST /api/standup/improve — per-user local write token", () => {
  // Multiplayer (forced on) with no STANDUP_WRITE_TOKEN is the configuration that
  // used to fail closed for every caller, including the operator's own agents.
  let dir: string;
  let savedEnvToken: string | undefined;
  let savedBind: string | undefined;

  function setUpMultiplayer() {
    const ctx = setUp();
    setSetting(ctx.store.db, MULTIPLAYER_OVERRIDE_SETTING, "on");
    return ctx;
  }

  function withLocalToken(fn: (token: string) => Promise<void>) {
    return async () => {
      dir = mkdtempSync(join(tmpdir(), "standup-write-token-"));
      savedEnvToken = process.env.STANDUP_WRITE_TOKEN;
      savedBind = process.env.STANDUP_BIND_HOST;
      delete process.env.STANDUP_WRITE_TOKEN;
      delete process.env.STANDUP_BIND_HOST;
      // What the collector entrypoint does at startup.
      const path = join(dir, "write-token");
      setLocalWriteToken(ensureLocalWriteToken(path));
      try {
        // What a same-user MCP client does: read the file, no env var.
        await fn(readLocalWriteToken(path)!);
      } finally {
        setLocalWriteToken(undefined);
        rmSync(dir, { recursive: true, force: true });
        if (savedEnvToken === undefined) delete process.env.STANDUP_WRITE_TOKEN;
        else process.env.STANDUP_WRITE_TOKEN = savedEnvToken;
        if (savedBind === undefined) delete process.env.STANDUP_BIND_HOST;
        else process.env.STANDUP_BIND_HOST = savedBind;
      }
    };
  }

  test(
    "a local client presenting the file token (no STANDUP_WRITE_TOKEN anywhere) clears the gate in multiplayer",
    withLocalToken(async (token) => {
      const { store, launchCalls, launchFn } = setUpMultiplayer();
      const app = serverWith(store, launchFn);
      const pending = propose(app, {}, { "x-standup-write-token": token });
      // Reaching the confirmation ask proves the write gate passed.
      const askId = await firstPendingAskId(store);
      await resolveAsk(app, askId, "Not now");
      const res = await pending;
      expect(res.status).toBe(200);
      expect(launchCalls).toHaveLength(0);
    })
  );

  test(
    "the file token also clears the gate on a network-exposed bind and alongside a configured STANDUP_WRITE_TOKEN",
    withLocalToken(async (token) => {
      process.env.STANDUP_BIND_HOST = "0.0.0.0";
      process.env.STANDUP_WRITE_TOKEN = "operator-secret";
      const { store, launchFn } = setUpMultiplayer();
      const app = serverWith(store, launchFn);
      const pending = propose(app, {}, { "x-standup-write-token": token });
      const askId = await firstPendingAskId(store);
      await resolveAsk(app, askId, "Not now");
      expect((await pending).status).toBe(200);
    })
  );

  test(
    "a remote tunnel caller without the token is still rejected in multiplayer",
    withLocalToken(async () => {
      const { store, launchCalls, launchFn } = setUpMultiplayer();
      const app = serverWith(store, launchFn);
      const res = await propose(app, {}, { [DEFAULT_IDENTITY_HEADER]: "mallory" });
      expect(res.status).toBe(403);
      expect(getPendingAsks(store.db)).toHaveLength(0);
      expect(launchCalls).toHaveLength(0);
    })
  );

  test(
    "a non-local caller on a network bind with a wrong token is rejected",
    withLocalToken(async (token) => {
      process.env.STANDUP_BIND_HOST = "0.0.0.0";
      const { store, launchCalls, launchFn } = setUp(); // single-user
      const app = serverWith(store, launchFn);
      const res = await propose(app, {}, { "x-standup-write-token": token + "x" });
      expect(res.status).toBe(403);
      const none = await propose(app);
      expect(none.status).toBe(403);
      expect(getPendingAsks(store.db)).toHaveLength(0);
      expect(launchCalls).toHaveLength(0);
    })
  );
});

describe("pure helpers", () => {
  test("isProposalApproval: clean affirmatives + option match approve; everything else declines", () => {
    for (const yes of ["Fire the fix", "fire the fix", "yes", "yep", "approve", "approved", "do it", "go ahead", "proceed", "sure"]) {
      expect(isProposalApproval(yes, "Fire the fix")).toBe(true);
    }
    for (const no of ["Not now", "no", "nope", ""]) {
      expect(isProposalApproval(no, "Fire the fix")).toBe(false);
    }
    // FAIL-CLOSED: a hedge/deferral/negation that OPENS with an affirmative token
    // must NOT launch repo-modifying work (the reviewed High). These all decline:
    for (const hedge of [
      "yeah no dont",
      "go away",
      "ok no wait",
      "okay stop",
      "do it later actually never mind",
      "approved but hold",
      "yes but hold on",
      "maybe",
      "sure, but not yet",
    ]) {
      expect(isProposalApproval(hedge, "Fire the fix")).toBe(false);
    }
  });

  test("buildStandupImprovementTask frames the agent as fixing Standup itself", () => {
    const task = buildStandupImprovementTask({
      title: "T",
      description: "D",
      kind: "kb-gap",
      requester: "alice",
    });
    expect(task).toContain("STANDUP ITSELF");
    expect(task).toContain("KNOWLEDGE-BASE GAP");
    expect(task).toContain("alice");
    expect(task).toContain("search_knowledge");
  });
});
