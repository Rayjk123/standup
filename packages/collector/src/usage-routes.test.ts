import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import {
  createStore,
  upsertProject,
  createSession,
  createLaunch,
  insertEvent,
  endSession,
  updateLaunchStatus,
  attachSessionToLaunch,
  setSessionCreatedActor,
  assignSessionOwner,
} from "@standup/store";
import type { Store } from "@standup/store";
import type { FleetUsage, FleetUsageTotals } from "@standup/shared";
import { OWNER_TOKEN_HEADER } from "@standup/shared/owner-token";
import { createServer } from "./server.js";
import { activeOwnerSecrets } from "./owner-secret.js";

/** Every user's cost is the owner's to read: requests carry the owner token. */
const AS_OWNER = { headers: { [OWNER_TOKEN_HEADER]: activeOwnerSecrets().ownerToken } };

/**
 * GET /api/usage/fleet wired into the running app. The pure aggregator is
 * covered in usage.test.ts; this exercises the route's own per-session row
 * assembly, its heaviest-first sort, and — the regression-prone part — the
 * FleetUsageTotals reduce, where a dropped token leg or an unguarded
 * `r.costUsd` (null-poisons the fleet cost to NaN) would otherwise ship green.
 */

const cleanupDirs: string[] = [];
afterAll(async () => {
  for (const d of cleanupDirs) await rm(d, { recursive: true, force: true });
});

const j = (o: unknown) => JSON.stringify(o);

/** One assistant turn's JSONL line carrying message-level usage. */
function assistant(model: string, usage: Record<string, number>): string {
  return j({
    type: "assistant",
    uuid: randomUUID(),
    timestamp: "2026-01-01T00:00:00Z",
    message: { role: "assistant", id: randomUUID(), model, content: [], usage },
  });
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "standup-usage-routes-"));
  cleanupDirs.push(dir);
  return dir;
}

/**
 * Creates a session whose most recent event points at a transcript file
 * written from `lines`, so transcriptPathForSession resolves it. Returns the
 * session id.
 */
async function seedSession(
  store: Store,
  projectId: string,
  title: string,
  lines: string[]
): Promise<string> {
  const dir = await tempDir();
  const path = join(dir, "transcript.jsonl");
  await writeFile(path, lines.join("\n") + "\n", "utf8");
  const id = randomUUID();
  createSession(store.db, { id, projectId, title, cwd: dir, status: "running" });
  insertEvent(store.db, id, "PostToolUse", { transcript_path: path });
  return id;
}

function setUp(): { store: Store; projectId: string } {
  const store = createStore(":memory:");
  const projectId = `usage-routes-${randomUUID().slice(0, 8)}`;
  upsertProject(store.db, { id: projectId, name: "Usage Routes", branch: "main", repos: [] });
  return { store, projectId };
}

// opus 4.8: total 17000, cost 0.085 (see usage.test.ts).
const OPUS_TURN = assistant("claude-opus-4-8", {
  input_tokens: 1000,
  output_tokens: 2000,
  cache_read_input_tokens: 10000,
  cache_creation_input_tokens: 4000,
});
// sonnet 5: total 600, cost 0.002.
const SONNET_TURN = assistant("claude-sonnet-5", { input_tokens: 500, output_tokens: 100 });
// unpriced model: total 350, cost null — tokens counted, no cost.
const UNKNOWN_TURN = assistant("claude-experimental-9", { input_tokens: 300, output_tokens: 50 });

describe("GET /api/usage/fleet", () => {
  test("active sessions: heaviest-first rows and correct fleet totals", async () => {
    const { store, projectId } = setUp();
    await seedSession(store, projectId, "heavy", [OPUS_TURN]);
    await seedSession(store, projectId, "light", [SONNET_TURN]);
    const app = createServer(store, () => {}, null);

    const res = await app.request("/api/usage/fleet", AS_OWNER);
    expect(res.status).toBe(200);
    const body = (await res.json()) as FleetUsage;

    // Heaviest first — opus (17000) before sonnet (600).
    expect(body.sessions.map((s) => s.title)).toEqual(["heavy", "light"]);
    const heavy = body.sessions[0]!;
    expect(heavy.totalTokens).toBe(17000);
    expect(heavy.costUsd).toBeCloseTo(0.085, 10);
    expect(heavy.model).toBe("claude-opus-4-8");

    // Totals sum every leg across both sessions.
    expect(body.totals.sessionCount).toBe(2);
    expect(body.totals.inputTokens).toBe(1500);
    expect(body.totals.outputTokens).toBe(2100);
    expect(body.totals.cacheReadTokens).toBe(10000);
    expect(body.totals.cacheCreationTokens).toBe(4000);
    expect(body.totals.totalTokens).toBe(17600);
    // input+output+cacheRead+cacheCreation across the two rows.
    expect(body.totals.totalTokens).toBe(
      body.totals.inputTokens +
        body.totals.outputTokens +
        body.totals.cacheReadTokens +
        body.totals.cacheCreationTokens
    );
    expect(body.totals.costUsd).toBeCloseTo(0.087, 10);
    // Both sessions are priceable, so the total is complete — nothing unpriced.
    expect(body.totals.unpricedSessionCount).toBe(0);

    store.close();
  });

  test("?all=1 includes an ended, unknown-model session — its tokens count, its null cost does not poison the fleet total", async () => {
    const { store, projectId } = setUp();
    await seedSession(store, projectId, "heavy", [OPUS_TURN]);
    await seedSession(store, projectId, "light", [SONNET_TURN]);
    const endedId = await seedSession(store, projectId, "ended-unknown", [UNKNOWN_TURN]);
    endSession(store.db, endedId);
    const app = createServer(store, () => {}, null);

    // Default (active only) hides the ended session.
    const activeBody = (await (await app.request("/api/usage/fleet", AS_OWNER)).json()) as FleetUsage;
    expect(activeBody.sessions.map((s) => s.title).sort()).toEqual(["heavy", "light"]);
    expect(activeBody.totals.sessionCount).toBe(2);

    // ?all=1 folds the ended session in.
    const allBody = (await (await app.request("/api/usage/fleet?all=1", AS_OWNER)).json()) as FleetUsage;
    expect(allBody.sessions.map((s) => s.title)).toEqual(["heavy", "light", "ended-unknown"]);

    const unknown = allBody.sessions.find((s) => s.title === "ended-unknown")!;
    expect(unknown.costUsd).toBeNull();
    expect(unknown.totalTokens).toBe(350);
    expect(unknown.status).toBe("idle");

    // The unknown session adds its 350 tokens but nothing to cost — and the cost
    // stays a real number, never NaN (the `costUsd ?? 0` guard). It is still
    // priced (the two known sessions), so the mixed total is a number, and the
    // one unpriced session is counted so the UI can flag it as partial.
    expect(allBody.totals.sessionCount).toBe(3);
    expect(allBody.totals.totalTokens).toBe(17950);
    expect(allBody.totals.costUsd).toBeCloseTo(0.087, 10);
    expect(Number.isNaN(allBody.totals.costUsd)).toBe(false);
    expect(allBody.totals.unpricedSessionCount).toBe(1);

    store.close();
  });

  test("a fleet entirely on an unpriced model reports unknown cost (null), not $0 — with a count of the unpriced sessions", async () => {
    const { store, projectId } = setUp();
    await seedSession(store, projectId, "unknown-a", [UNKNOWN_TURN]);
    await seedSession(store, projectId, "unknown-b", [UNKNOWN_TURN]);
    const app = createServer(store, () => {}, null);

    const body = (await (await app.request("/api/usage/fleet", AS_OWNER)).json()) as FleetUsage;
    // Tokens still sum across both sessions (350 each).
    expect(body.totals.totalTokens).toBe(700);
    expect(body.sessions.every((s) => s.costUsd === null)).toBe(true);
    // The headline must not report $0 for a fleet burning real money on a model
    // the pricing map can't price — it's unknown (null), with both sessions
    // flagged as unpriced spend.
    expect(body.totals.costUsd).toBeNull();
    expect(body.totals.unpricedSessionCount).toBe(2);

    store.close();
  });

  test("a codex launch surfaces in the fleet from its JSONL sidecar, reconciled alongside claude sessions", async () => {
    const { store, projectId } = setUp();
    await seedSession(store, projectId, "claude-heavy", [OPUS_TURN]);

    // A codex launch's usage lives in the sidecar the launcher tees `codex exec
    // --json` stdout to — not a Claude transcript. Seed one completed turn.
    const dir = await tempDir();
    const sidecar = join(dir, "codex-events.jsonl");
    await writeFile(
      sidecar,
      [
        j({ type: "thread.started", thread_id: "t-1" }),
        j({ type: "turn.started" }),
        j({
          type: "turn.completed",
          usage: {
            input_tokens: 500,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            output_tokens: 100,
            reasoning_output_tokens: 0,
          },
        }),
      ].join("\n") + "\n",
      "utf8"
    );
    createLaunch(store.db, {
      id: "codex-L1",
      projectId,
      task: "codex work",
      worktreePath: join(dir, "wt"),
      branch: "main",
      status: "running",
      harness: "codex",
      codexEventLog: sidecar,
    });

    const app = createServer(store, () => {}, null);
    const body = (await (await app.request("/api/usage/fleet", AS_OWNER)).json()) as FleetUsage;

    const codexRow = body.sessions.find((s) => s.title === "codex work")!;
    expect(codexRow).toBeTruthy();
    expect(codexRow.inputTokens).toBe(500);
    expect(codexRow.outputTokens).toBe(100);
    expect(codexRow.totalTokens).toBe(600);
    expect(codexRow.status).toBe("running");
    // The codex model isn't known to Standup → unpriced, tokens still counted.
    expect(codexRow.model).toBeUndefined();
    expect(codexRow.costUsd).toBeNull();

    // Both the claude session and the codex launch are folded into the fleet.
    expect(body.totals.sessionCount).toBe(2);
    expect(body.totals.totalTokens).toBe(17600); // opus 17000 + codex 600
    expect(body.totals.costUsd).toBeCloseTo(0.085, 10); // opus priced, codex null
    expect(body.totals.unpricedSessionCount).toBe(1); // the codex run

    store.close();
  });

  test("an observed codex launch (with an attached session row) is listed once, not double-counted", async () => {
    const { store, projectId } = setUp();

    // The observer creates + attaches a real session row (the Codex thread id) to
    // a running codex launch — so that session is also an active session — but it
    // carries no hook transcript. Its usage is only in the sidecar.
    const dir = await tempDir();
    const sidecar = join(dir, "codex-events.jsonl");
    await writeFile(
      sidecar,
      [
        j({ type: "thread.started", thread_id: "codex-thread" }),
        j({ type: "turn.completed", usage: { input_tokens: 500, output_tokens: 100 } }),
      ].join("\n") + "\n",
      "utf8"
    );
    createLaunch(store.db, {
      id: "codex-observed",
      projectId,
      task: "observed codex",
      worktreePath: join(dir, "wt"),
      branch: "main",
      status: "running",
      harness: "codex",
      codexEventLog: sidecar,
    });
    createSession(store.db, {
      id: "codex-thread",
      projectId,
      title: "observed codex",
      cwd: join(dir, "wt"),
      status: "running",
    });
    attachSessionToLaunch(store.db, "codex-observed", "codex-thread");

    const app = createServer(store, () => {}, null);
    const body = (await (await app.request("/api/usage/fleet", AS_OWNER)).json()) as FleetUsage;

    // Exactly one row for the observed run, keyed by its session id, carrying the
    // sidecar usage — not a phantom zero-usage duplicate from the Claude path.
    const forThread = body.sessions.filter((s) => s.sessionId === "codex-thread");
    expect(forThread).toHaveLength(1);
    expect(forThread[0]!.totalTokens).toBe(600);
    expect(body.totals.sessionCount).toBe(1);
    expect(body.totals.totalTokens).toBe(600);

    store.close();
  });

  test("a finished codex launch is active-hidden and only appears with ?all=1", async () => {
    const { store, projectId } = setUp();
    const dir = await tempDir();
    const sidecar = join(dir, "codex-events.jsonl");
    await writeFile(
      sidecar,
      j({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }) + "\n",
      "utf8"
    );
    createLaunch(store.db, {
      id: "codex-done",
      projectId,
      task: "finished codex",
      worktreePath: join(dir, "wt"),
      branch: "main",
      harness: "codex",
      codexEventLog: sidecar,
    });
    updateLaunchStatus(store.db, "codex-done", "cleaned");
    const app = createServer(store, () => {}, null);

    // Default (active only) hides the finished launch, mirroring ended sessions.
    const active = (await (await app.request("/api/usage/fleet", AS_OWNER)).json()) as FleetUsage;
    expect(active.sessions.find((s) => s.title === "finished codex")).toBeUndefined();

    // ?all=1 folds it in, projecting its terminal status to 'done'.
    const all = (await (await app.request("/api/usage/fleet?all=1", AS_OWNER)).json()) as FleetUsage;
    const row = all.sessions.find((s) => s.title === "finished codex")!;
    expect(row).toBeTruthy();
    expect(row.totalTokens).toBe(12);
    expect(row.status).toBe("done");

    store.close();
  });

  test("an empty fleet returns no rows and zeroed totals", async () => {
    const { store } = setUp();
    const app = createServer(store, () => {}, null);
    const body = (await (await app.request("/api/usage/fleet", AS_OWNER)).json()) as FleetUsage;
    expect(body.sessions).toEqual([]);
    // No priceable session (there are none at all) → cost is unknown, not $0.
    expect(body.totals).toEqual({
      sessionCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      costUsd: null,
      unpricedSessionCount: 0,
    });
    store.close();
  });

  test("a session with no transcript event contributes a zeroed row, not a crash", async () => {
    const { store, projectId } = setUp();
    // A session with an event but no transcript_path resolves to a null path.
    const id = randomUUID();
    createSession(store.db, { id, projectId, title: "no-transcript", cwd: "/tmp/nt", status: "running" });
    insertEvent(store.db, id, "SessionStart", { note: "no transcript_path here" });
    const app = createServer(store, () => {}, null);

    const body = (await (await app.request("/api/usage/fleet", AS_OWNER)).json()) as FleetUsage;
    expect(body.sessions).toHaveLength(1);
    const row = body.sessions[0]!;
    expect(row.title).toBe("no-transcript");
    expect(row.totalTokens).toBe(0);
    expect(row.costUsd).toBeNull();
    // Nothing priceable in the fleet → unknown cost. A zero-token session is not
    // spend, so it is not counted as an unpriced session.
    expect(body.totals.costUsd).toBeNull();
    expect(body.totals.unpricedSessionCount).toBe(0);
    store.close();
  });
});

/** A completed codex sidecar turn keyed by requester, for the byUser tests. */
async function seedCodexLaunch(
  store: Store,
  projectId: string,
  id: string,
  task: string,
  requester: string | undefined,
  usage: Record<string, number>
): Promise<void> {
  const dir = await tempDir();
  const sidecar = join(dir, "codex-events.jsonl");
  await writeFile(
    sidecar,
    [j({ type: "thread.started", thread_id: id }), j({ type: "turn.completed", usage })].join("\n") +
      "\n",
    "utf8"
  );
  createLaunch(store.db, {
    id,
    projectId,
    task,
    worktreePath: join(dir, "wt"),
    branch: "main",
    status: "running",
    harness: "codex",
    codexEventLog: sidecar,
    requester,
  });
}

/** Sums the byUser buckets back into one totals shape, for reconciliation. */
function sumBuckets(buckets: Array<{ user: string | null } & FleetUsageTotals>): FleetUsageTotals {
  return buckets.reduce<FleetUsageTotals>(
    (acc, b) => ({
      sessionCount: acc.sessionCount + b.sessionCount,
      inputTokens: acc.inputTokens + b.inputTokens,
      outputTokens: acc.outputTokens + b.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + b.cacheReadTokens,
      cacheCreationTokens: acc.cacheCreationTokens + b.cacheCreationTokens,
      totalTokens: acc.totalTokens + b.totalTokens,
      costUsd: (acc.costUsd ?? 0) + (b.costUsd ?? 0),
      unpricedSessionCount: acc.unpricedSessionCount + b.unpricedSessionCount,
    }),
    {
      sessionCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      unpricedSessionCount: 0,
    }
  );
}

describe("GET /api/usage/fleet — cost by user", () => {
  test("attributes Claude rows to owner ?? creator and codex rows to requester; buckets sum to the grand total", async () => {
    const { store, projectId } = setUp();

    // Owner wins over creator: this row is carol's spend, not bob's.
    const owned = await seedSession(store, projectId, "owned", [OPUS_TURN]);
    setSessionCreatedActor(store.db, owned, "bob");
    assignSessionOwner(store.db, owned, "carol");

    // No owner set → attributed to the creator.
    const created = await seedSession(store, projectId, "created", [SONNET_TURN]);
    setSessionCreatedActor(store.db, created, "alice");

    // A codex launch is attributed to its requester (alice again).
    await seedCodexLaunch(store, projectId, "codex-alice", "codex work", "alice", {
      input_tokens: 500,
      output_tokens: 100,
    });

    const app = createServer(store, () => {}, null);
    const body = (await (await app.request("/api/usage/fleet", AS_OWNER)).json()) as FleetUsage;

    const byTitle = (t: string) => body.sessions.find((s) => s.title === t)!;
    expect(byTitle("owned").user).toBe("carol");
    expect(byTitle("created").user).toBe("alice");
    expect(byTitle("codex work").user).toBe("alice");

    // Buckets: alice (sonnet 600 + codex 600), carol (opus 17000). No null bucket
    // here — every row is attributed.
    expect(body.byUser).toBeTruthy();
    const alice = body.byUser!.find((b) => b.user === "alice")!;
    const carol = body.byUser!.find((b) => b.user === "carol")!;
    expect(body.byUser!.some((b) => b.user === null)).toBe(false);

    expect(alice.sessionCount).toBe(2);
    expect(alice.totalTokens).toBe(1200); // sonnet 600 + codex 600
    expect(alice.costUsd).toBeCloseTo(0.002, 10); // sonnet priced; codex unpriced
    expect(alice.unpricedSessionCount).toBe(1); // the codex run

    expect(carol.sessionCount).toBe(1);
    expect(carol.totalTokens).toBe(17000);
    expect(carol.costUsd).toBeCloseTo(0.085, 10);

    // The buckets reconcile to the fleet grand total, leg for leg.
    const summed = sumBuckets(body.byUser!);
    expect(summed.sessionCount).toBe(body.totals.sessionCount);
    expect(summed.totalTokens).toBe(body.totals.totalTokens);
    expect(summed.inputTokens).toBe(body.totals.inputTokens);
    expect(summed.outputTokens).toBe(body.totals.outputTokens);
    expect(summed.cacheReadTokens).toBe(body.totals.cacheReadTokens);
    expect(summed.cacheCreationTokens).toBe(body.totals.cacheCreationTokens);
    expect(summed.unpricedSessionCount).toBe(body.totals.unpricedSessionCount);
    expect(summed.costUsd).toBeCloseTo(body.totals.costUsd ?? 0, 10);

    store.close();
  });

  test("only the anonymous sentinel is unattributed — user null, folded into the null bucket, never the literal 'anonymous'", async () => {
    const { store, projectId } = setUp();

    // A raw non-loopback client with no trusted tunnel header resolves to the
    // anonymous sentinel; it must not be persisted as a named user — it is
    // genuinely unattributed work. (The host `$USER`/`local` fallback is a REAL
    // alias and stays attributed — see the host-attribution test below.)
    const anon = await seedSession(store, projectId, "anon", [OPUS_TURN]);
    setSessionCreatedActor(store.db, anon, "anonymous");

    const attributed = await seedSession(store, projectId, "attributed", [SONNET_TURN]);
    setSessionCreatedActor(store.db, attributed, "dave");

    const app = createServer(store, () => {}, null);
    const body = (await (await app.request("/api/usage/fleet", AS_OWNER)).json()) as FleetUsage;

    const anonRow = body.sessions.find((s) => s.title === "anon")!;
    expect(anonRow.user).toBeNull();

    // No bucket is keyed by the literal sentinel; the anonymous spend lands in the
    // null (unattributed) bucket.
    expect(body.byUser!.some((b) => b.user === "anonymous")).toBe(false);
    const nullBucket = body.byUser!.find((b) => b.user === null)!;
    expect(nullBucket).toBeTruthy();
    expect(nullBucket.totalTokens).toBe(17000); // the opus session
    expect(nullBucket.sessionCount).toBe(1);

    const dave = body.byUser!.find((b) => b.user === "dave")!;
    expect(dave.totalTokens).toBe(600);

    // Buckets still reconcile to the grand total with an unattributed bucket present.
    expect(sumBuckets(body.byUser!).totalTokens).toBe(body.totals.totalTokens);

    store.close();
  });

  test("no-tunnel / host work is unattributed (null); a real tunnel alias stays attributed", async () => {
    const { store, projectId } = setUp();

    // The host fallback identity (resolveUserAlias(undefined) = `$USER` else
    // "local") is the alias a session that appears on its own on a loopback host
    // is stamped with — genuinely no trusted tunnel user. Pin `$USER` so the test
    // doesn't depend on the runner's real environment.
    const savedUser = process.env.USER;
    process.env.USER = "host-operator";
    try {
      // Host / single-player work carries the host fallback identity as its
      // creator, so its spend is unattributed (null) — folded into the null
      // bucket, shown as '—' — NOT pinned to the host operator.
      const hostSession = await seedSession(store, projectId, "host", [OPUS_TURN]);
      setSessionCreatedActor(store.db, hostSession, "host-operator");

      // A request that arrived over the tunnel carries a real, authenticated
      // alias — that stays attributed to the person.
      const tunneled = await seedSession(store, projectId, "tunneled", [SONNET_TURN]);
      setSessionCreatedActor(store.db, tunneled, "erin");

      const app = createServer(store, () => {}, null);
      const body = (await (await app.request("/api/usage/fleet", AS_OWNER)).json()) as FleetUsage;

      expect(body.sessions.find((s) => s.title === "host")!.user).toBeNull();
      expect(body.sessions.find((s) => s.title === "tunneled")!.user).toBe("erin");

      // The host work lands in the null (unattributed) bucket, never a named
      // bucket keyed by the literal host alias.
      expect(body.byUser!.some((b) => b.user === "host-operator")).toBe(false);
      const nullBucket = body.byUser!.find((b) => b.user === null)!;
      expect(nullBucket).toBeTruthy();
      expect(nullBucket.totalTokens).toBe(17000); // the host opus session
      expect(nullBucket.sessionCount).toBe(1);
      expect(body.byUser!.find((b) => b.user === "erin")!.totalTokens).toBe(600);

      // Buckets still reconcile to the grand total with the null bucket present.
      expect(sumBuckets(body.byUser!).totalTokens).toBe(body.totals.totalTokens);
    } finally {
      if (savedUser === undefined) delete process.env.USER;
      else process.env.USER = savedUser;
    }

    store.close();
  });

  test("with no $USER the host fallback is 'local' — a 'local' session is unattributed, not the literal 'anonymous' alone", async () => {
    const { store, projectId } = setUp();

    // With `$USER` unset, resolveUserAlias(undefined) resolves to "local"; a
    // session stamped with it is host/single-player work and must fold to null —
    // the null bucket is not limited to the literal anonymous sentinel.
    const savedUser = process.env.USER;
    delete process.env.USER;
    try {
      const localHost = await seedSession(store, projectId, "local-host", [OPUS_TURN]);
      setSessionCreatedActor(store.db, localHost, "local");

      const app = createServer(store, () => {}, null);
      const body = (await (await app.request("/api/usage/fleet", AS_OWNER)).json()) as FleetUsage;

      expect(body.sessions.find((s) => s.title === "local-host")!.user).toBeNull();
      expect(body.byUser!.find((b) => b.user === null)!.totalTokens).toBe(17000);
    } finally {
      if (savedUser === undefined) delete process.env.USER;
      else process.env.USER = savedUser;
    }

    store.close();
  });

  test("a codex launch owner-reassigned on its observed session attributes to the new owner, not the requester", async () => {
    const { store, projectId } = setUp();

    // The launcher tees `codex exec --json` into the sidecar; the observer then
    // attaches a real session row (the Codex thread id) to the launch.
    const dir = await tempDir();
    const sidecar = join(dir, "codex-events.jsonl");
    await writeFile(
      sidecar,
      [
        j({ type: "thread.started", thread_id: "codex-reassigned" }),
        j({ type: "turn.completed", usage: { input_tokens: 500, output_tokens: 100 } }),
      ].join("\n") + "\n",
      "utf8"
    );
    createLaunch(store.db, {
      id: "codex-reassign",
      projectId,
      task: "codex reassigned",
      worktreePath: join(dir, "wt"),
      branch: "main",
      status: "running",
      harness: "codex",
      codexEventLog: sidecar,
      requester: "alice",
    });
    createSession(store.db, {
      id: "codex-reassigned",
      projectId,
      title: "codex reassigned",
      cwd: join(dir, "wt"),
      status: "running",
    });
    attachSessionToLaunch(store.db, "codex-reassign", "codex-reassigned");
    // Someone reassigns ownership of the observed session to bob.
    assignSessionOwner(store.db, "codex-reassigned", "bob");

    const app = createServer(store, () => {}, null);
    const body = (await (await app.request("/api/usage/fleet", AS_OWNER)).json()) as FleetUsage;

    const row = body.sessions.find((s) => s.title === "codex reassigned")!;
    expect(row).toBeTruthy();
    expect(row.totalTokens).toBe(600);
    // Owner (bob) wins over the launch requester (alice) — matching the Claude
    // owner-wins rule.
    expect(row.user).toBe("bob");
    expect(body.byUser!.find((b) => b.user === "bob")!.totalTokens).toBe(600);
    expect(body.byUser!.some((b) => b.user === "alice")).toBe(false);

    store.close();
  });
});
