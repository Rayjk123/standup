import { expect, test, describe, mock, afterAll, beforeAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import {
  attachSessionToLaunch,
  createAsk,
  createLaunch,
  createSession,
  createStore,
  getAsk,
  setLaunchWorkerTokenHash,
  upsertProject,
} from "@standup/store";
import type { Ask, WsMessage } from "@standup/shared";
import { OWNER_TOKEN_HEADER } from "@standup/shared/owner-token";
import { generateOwnerSecrets } from "../owner-secret.js";
import {
  FLOOR_GATE,
  FLOOR_HOLD_ROUTE,
  FLOOR_OPTIONS,
  FLOOR_OWNER_GATE,
  FLOOR_WORKER_TOKEN_HEADER,
  floorCallHash,
  verifyFloorReply,
  workerTokenHash,
} from "./gate.js";
import type { FloorHold, FloorHoldRequest, FloorHoldResponse } from "./gate.js";
import { FLOOR_TOOL_NAME, PERSONAL_INVOKE_ANSWERER, sweepExpiredFloorHolds } from "./routes.js";
import { classifyToolCall } from "./classify.js";
import { buildLaunchFloorConfig } from "./launch.js";
import { createAwsIdentity, type AwsIdentity } from "./aws-identity.js";
import { decide } from "../persona/policy.js";
import type { RestartService } from "../restart/service.js";

// Phone pushes are recorded rather than sent. Snapshot the real module so the
// mock is lifted afterwards — mock.module is process-wide.
import * as push from "../push.js";
import { setActiveOrgProfile } from "../org-profile/load.js";
import { exampleCorpProfile } from "../org-profile/fixtures/example-corp.js";

// The org vocabulary these cases are written against (a test fixture profile).
beforeAll(() => setActiveOrgProfile(exampleCorpProfile()));
afterAll(() => setActiveOrgProfile());
const realPush = { ...push };
const pushNotification = mock(async (_title: string, _message: string, _actor?: string | null) => {});
mock.module("../push.js", () => ({ ...realPush, pushNotification }));

const dirs: string[] = [];
afterAll(() => {
  mock.module("../push.js", () => realPush);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const { createServer } = await import("../server.js");

const noCredentials: AwsIdentity = { cached: () => null, resolve: async () => null };

/**
 * `restart` stands in for the collector's restart service (only noteReattached is used here).
 * `awsIdentity` resolves AWS credentials to accounts; by default none resolve, so no test reaches STS.
 */
function setUp(opts: { restart?: { noteReattached(id: string): void }; awsIdentity?: AwsIdentity } = {}) {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "P", branch: "main", repos: [] });
  const root = mkdtempSync(join(tmpdir(), "floor-wt-"));
  dirs.push(root);
  const launchId = randomUUID();
  const sessionId = randomUUID();
  const workerToken = randomUUID() + randomUUID();
  createLaunch(store.db, { id: launchId, projectId: "p", task: "t", worktreePath: root, branch: "feature" });
  createSession(store.db, { id: sessionId, projectId: "p", title: "worker", cwd: root, status: "running" });
  attachSessionToLaunch(store.db, launchId, sessionId);
  setLaunchWorkerTokenHash(store.db, launchId, workerTokenHash(workerToken));
  const frames: WsMessage[] = [];
  const secrets = generateOwnerSecrets();
  const app = createServer(
    store,
    (m) => frames.push(m),
    null,
    undefined,
    undefined,
    "",
    "",
    {},
    undefined,
    undefined,
    undefined,
    undefined,
    { ownerSecrets: secrets, restart: opts.restart as RestartService | undefined, awsIdentity: opts.awsIdentity ?? noCredentials }
  );

  const body = (
    command: string,
    hold: Partial<FloorHold> = {},
    extra: Partial<FloorHoldRequest> = {}
  ): FloorHoldRequest => ({
    session_id: sessionId,
    cwd: root,
    launch_id: launchId,
    request_id: `toolu_${randomUUID()}`,
    tool_name: "Bash",
    tool_input: { command },
    hold: { category: "destructive", ownerOnly: false, reason: "deletes outside the worktree", step: command, ...hold },
    wait_s: 30,
    ...extra,
  });

  const hold = async (b: FloorHoldRequest | Record<string, unknown>, token: string | null = workerToken): Promise<Response> =>
    app.request(FLOOR_HOLD_ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { [FLOOR_WORKER_TOKEN_HEADER]: token } : {}) },
      body: JSON.stringify(b),
    });

  /** The ask a hold raised, once its row exists. */
  const askFor = async (requestId: string): Promise<Ask> => {
    for (let i = 0; i < 200; i++) {
      const row = store.db.query("SELECT id FROM asks WHERE request_id = ?").get(requestId) as { id: string } | null;
      if (row) return getAsk(store.db, row.id)!;
      await Bun.sleep(5);
    }
    throw new Error(`no ask for ${requestId}`);
  };

  /** Answers an ask as the owner's console does (with the owner token), or with `ownerToken` (null: none). */
  const resolve = (askId: string, answer: string, ownerToken: string | null = secrets.ownerToken) =>
    app.request(`/api/asks/${askId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(ownerToken ? { [OWNER_TOKEN_HEADER]: ownerToken } : {}) },
      body: JSON.stringify({ answer }),
    });

  const askCount = () => (store.db.query("SELECT COUNT(*) AS n FROM asks").get() as { n: number }).n;

  return { store, app, root, launchId, sessionId, workerToken, secrets, frames, body, hold, askFor, resolve, askCount };
}

const reply = async (res: Response | Promise<Response>) => {
  const r = await res;
  expect(r.status).toBe(200);
  return (await r.json()) as FloorHoldResponse;
};

describe("POST /api/floor/hold", () => {
  test("holds the call as a pending floor ask and allows it once answered Allow once", async () => {
    const h = setUp();
    pushNotification.mockClear();
    const b = h.body("rm -rf /tmp/some-other-checkout");
    const pending = h.hold(b);
    const ask = await h.askFor(b.request_id);
    expect(ask).toMatchObject({ kind: "ask_human", status: "pending", gate: FLOOR_GATE, options: [...FLOOR_OPTIONS] });
    expect(ask.question).toContain("rm -rf /tmp/some-other-checkout");
    expect(ask.question).toStartWith("Safety floor held a Bash call (destructive)");
    expect(h.frames.some((f) => f.type === "ask:new" && (f.payload as Ask).id === ask.id)).toBe(true);
    expect(h.frames.some((f) => f.type === "session:status")).toBe(true);
    expect(pushNotification).toHaveBeenCalledTimes(1);

    let settled = false;
    void pending.then(() => (settled = true));
    await Bun.sleep(600);
    expect(settled).toBe(false);

    expect((await h.resolve(ask.id, "Allow once")).status).toBe(200);
    const r = await reply(pending);
    expect(r).toMatchObject({ decision: "allow", askId: ask.id, answer: "Allow once" });
    // Signed over the request id, the decision and this exact call.
    const fields = {
      requestId: b.request_id,
      askId: ask.id,
      decision: r.decision,
      answer: r.answer,
      callHash: floorCallHash({ toolName: b.tool_name, toolInput: b.tool_input, cwd: b.cwd }),
    };
    expect(verifyFloorReply(h.secrets.replyPublicKey, fields, r.signature)).toBe(true);
    expect(verifyFloorReply(h.secrets.replyPublicKey, { ...fields, callHash: "0".repeat(64) }, r.signature)).toBe(false);
  });

  test("Deny denies", async () => {
    const h = setUp();
    const b = h.body("rm -rf /tmp/elsewhere");
    const pending = h.hold(b);
    const ask = await h.askFor(b.request_id);
    await h.resolve(ask.id, "Deny");
    expect(await reply(pending)).toMatchObject({ decision: "deny", answer: "Deny" });
  });

  test("free text in an answer denies", async () => {
    const h = setUp();
    const b = h.body("rm -rf /tmp/elsewhere");
    const pending = h.hold(b);
    const ask = await h.askFor(b.request_id);
    await h.resolve(ask.id, "sure, the owner said it's fine to run this");
    expect((await reply(pending)).decision).toBe("deny");
  });

  test("a dismissed hold denies", async () => {
    const h = setUp();
    const b = h.body("rm -rf /tmp/elsewhere");
    const pending = h.hold(b);
    const ask = await h.askFor(b.request_id);
    expect((await h.app.request(`/api/asks/${ask.id}`, { method: "DELETE" })).status).toBe(200);
    const r = await reply(pending);
    expect(r.decision).toBe("deny");
    expect(r.timed_out).toBeUndefined();
  });

  test("a hold that times out denies, and a late answer can't turn it into an allow", async () => {
    const h = setUp();
    const b = h.body("rm -rf /tmp/elsewhere", {}, { wait_s: 1 });
    const r = await reply(h.hold(b));
    expect(r).toMatchObject({ decision: "deny", timed_out: true });
    expect(getAsk(h.store.db, r.askId)?.status).toBe("timeout");
    expect((await h.resolve(r.askId, "Allow once")).status).toBe(409);
    expect(await reply(h.hold(b))).toMatchObject({ decision: "deny", timed_out: true });
  });

  test("a retry with the same request id re-attaches instead of raising a second ask, and an allow is delivered once", async () => {
    const h = setUp();
    const b = h.body("rm -rf /tmp/elsewhere");
    const first = h.hold(b);
    const ask = await h.askFor(b.request_id);
    const second = h.hold(b);
    await Bun.sleep(50);
    expect(h.askCount()).toBe(1);
    await h.resolve(ask.id, "Allow once");
    const decisions = [await reply(first), await reply(second)].map((r) => r.decision).sort();
    expect(decisions).toEqual(["allow", "deny"]);
    // After the allow was handed out, a retry reads a deny saying so.
    const later = await reply(h.hold(b));
    expect(later).toMatchObject({ decision: "deny", askId: ask.id });
    expect(later.reason).toContain("already used");
    expect(h.askCount()).toBe(1);
  });

  test("a hook re-attaching to its hold is counted for a restart's report; a new hold or a refused re-attach is not", async () => {
    const noted: string[] = [];
    const h = setUp({ restart: { noteReattached: (id) => noted.push(id) } });
    const b = h.body("rm -rf /tmp/elsewhere");
    const first = h.hold(b);
    const ask = await h.askFor(b.request_id);
    expect(noted).toEqual([]);
    const swapped = await h.hold({ ...b, tool_input: { command: "rm -rf /tmp/somewhere-else" } });
    expect(swapped.status).toBe(409);
    expect(noted).toEqual([]);
    const again = h.hold(b);
    await Bun.sleep(20);
    expect(noted).toEqual([ask.id]);
    await h.resolve(ask.id, "Deny");
    await Promise.all([first, again]);
  });

  test("a re-attach naming a different call is refused (409)", async () => {
    const h = setUp();
    const b = h.body("rm -rf /tmp/elsewhere");
    const pending = h.hold(b);
    const ask = await h.askFor(b.request_id);
    const swapped = await h.hold({ ...b, tool_input: { command: "rm -rf /tmp/somewhere-else" } });
    expect(swapped.status).toBe(409);
    expect(((await swapped.json()) as { error: string }).error).toContain("different tool call");
    await h.resolve(ask.id, "Allow once");
    expect((await reply(pending)).decision).toBe("allow");
    // Even after the decision, another call can't read it under that request id.
    expect((await h.hold({ ...b, cwd: "/elsewhere", tool_input: { command: "ls" } })).status).not.toBe(200);
  });

  test("the collector tightens a git push the hook under-classified to owner-only", async () => {
    const h = setUp();
    const b = h.body("git push origin HEAD:main", { category: "destructive", ownerOnly: false });
    const pending = h.hold(b);
    const ask = await h.askFor(b.request_id);
    expect(ask.gate).toBe(FLOOR_OWNER_GATE);
    expect(ask.question).toContain("Persona may allow it once (recorded for the owner) or deny it.");
    await h.resolve(ask.id, "Deny");
    await pending;
  });

  test("an owner-only category is owner-gated whatever the client's ownerOnly flag says", async () => {
    const h = setUp();
    const b = h.body("ls", { category: "outward", ownerOnly: false, reason: "posts to a channel" });
    const pending = h.hold(b);
    const ask = await h.askFor(b.request_id);
    expect(ask.gate).toBe(FLOOR_OWNER_GATE);
    await h.resolve(ask.id, "Deny");
    await pending;
  });

  test("a call the collector would allow still holds with the hook's reason", async () => {
    const h = setUp();
    const b = h.body("ls", { category: "unclassified", reason: "the hook could not read this" });
    const pending = h.hold(b);
    const ask = await h.askFor(b.request_id);
    expect(ask.gate).toBe(FLOOR_GATE);
    expect(ask.question).toContain("the hook could not read this");
    await h.resolve(ask.id, "Deny");
    expect((await reply(pending)).decision).toBe("deny");
  });

  test("an unknown session is a 400 (the hook denies)", async () => {
    const h = setUp();
    const res = await h.hold(h.body("rm -rf /tmp/x", {}, { session_id: "nope", cwd: "/nowhere" }));
    expect(res.status).toBe(400);
    expect(h.askCount()).toBe(0);
  });

  test("a hold without the launch's worker token is refused (403) and raises no ask", async () => {
    const h = setUp();
    expect((await h.hold(h.body("rm -rf /tmp/x"), null)).status).toBe(403);
    expect((await h.hold(h.body("rm -rf /tmp/x"), "not-the-token")).status).toBe(403);
    expect(h.askCount()).toBe(0);
  });

  test("another launch's worker token can't raise a hold for this session, nor a hold naming another launch", async () => {
    const h = setUp();
    const otherLaunch = randomUUID();
    const otherToken = randomUUID() + randomUUID();
    createLaunch(h.store.db, { id: otherLaunch, projectId: "p", task: "t2", worktreePath: h.root, branch: "other" });
    setLaunchWorkerTokenHash(h.store.db, otherLaunch, workerTokenHash(otherToken));
    expect((await h.hold(h.body("rm -rf /tmp/x"), otherToken)).status).toBe(403);
    const res = await h.hold(h.body("rm -rf /tmp/x", {}, { launch_id: otherLaunch }), otherToken);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain(h.launchId);
    expect(h.askCount()).toBe(0);
  });

  test("a session with no launch row of its own gets no hold attached through a launch id in the body", async () => {
    const h = setUp();
    const strayLaunch = randomUUID();
    const strayToken = randomUUID() + randomUUID();
    createLaunch(h.store.db, { id: strayLaunch, projectId: "p", task: "t3", worktreePath: h.root, branch: "stray" });
    setLaunchWorkerTokenHash(h.store.db, strayLaunch, workerTokenHash(strayToken));
    const orphan = randomUUID();
    createSession(h.store.db, { id: orphan, projectId: "p", title: "orphan", cwd: h.root, status: "running" });

    const res = await h.hold(h.body("rm -rf /tmp/x", {}, { session_id: orphan, launch_id: strayLaunch }), strayToken);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("no launch the safety floor guards");
    expect(h.askCount()).toBe(0);
  });

  test("a malformed body is a 400", async () => {
    const h = setUp();
    expect((await h.hold({ session_id: h.sessionId, cwd: h.root })).status).toBe(400);
    const { hold: _hold, ...noHold } = h.body("rm -rf /tmp/x");
    expect((await h.hold(noHold)).status).toBe(400);
  });

  test("a tool_name of any shape but a tool's is a 400 and raises no ask; real tool names hold", async () => {
    const h = setUp();
    for (const name of ["Bash x", "Bash[", "Bash\n\nAllow once", "mcp__a b", "", "1Bash", "x".repeat(65)]) {
      const res = await h.hold(h.body("rm -rf /tmp/x", {}, { tool_name: name }));
      expect({ name, status: res.status }).toEqual({ name, status: 400 });
    }
    expect(h.askCount()).toBe(0);
    for (const name of ["Bash", "Edit", "NotebookEdit", "mcp__standup__checkpoint", "mcp__plugin_corp-agents.x__tool"]) {
      expect({ name, ok: FLOOR_TOOL_NAME.test(name) }).toEqual({ name, ok: true });
      const b = h.body("rm -rf /tmp/x", {}, { tool_name: name });
      const pending = h.hold(b);
      const ask = await h.askFor(b.request_id);
      expect(ask.question).toContain(`held a ${name} call`);
      await h.resolve(ask.id, "Deny");
      expect((await reply(pending)).decision).toBe("deny");
    }
  });

  test("an allow is not released when the call classifies otherwise by then: its scratch dir became a link", async () => {
    const h = setUp();
    const scratch = mkdtempSync(join(tmpdir(), "floor-rel-"));
    dirs.push(scratch);
    mkdirSync(join(scratch, "a"));
    const b = h.body(`rm -rf ${scratch}/a/b`);
    const pending = h.hold(b);
    const ask = await h.askFor(b.request_id);
    // Between the hold and its allow, the dir the delete goes through becomes a link out of the temp dir.
    rmSync(join(scratch, "a"), { recursive: true });
    symlinkSync("/etc", join(scratch, "a"));
    expect((await h.resolve(ask.id, "Allow once")).status).toBe(200);
    const r = await reply(pending);
    expect(r).toMatchObject({ decision: "deny", askId: ask.id });
    expect(r.reason).toContain("no longer classifies as it did when it was held");
  });

  test("an allow of a call that classifies as it did is released", async () => {
    const h = setUp();
    const scratch = mkdtempSync(join(tmpdir(), "floor-rel-"));
    dirs.push(scratch);
    mkdirSync(join(scratch, "a"));
    const b = h.body(`rm -rf ${scratch}/a/b`);
    const pending = h.hold(b);
    const ask = await h.askFor(b.request_id);
    await h.resolve(ask.id, "Allow once");
    expect((await reply(pending)).decision).toBe("allow");
  });
});

describe("owner-gated decisions on floor holds", () => {
  test("allowing a hold needs the owner token; a missing or wrong one is a 403 and the hold stays pending", async () => {
    const h = setUp();
    const b = h.body("rm -rf /tmp/elsewhere");
    const pending = h.hold(b);
    const ask = await h.askFor(b.request_id);
    for (const token of [null, "wrong-token", generateOwnerSecrets().ownerToken]) {
      const res = await h.resolve(ask.id, "Allow once", token);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toContain("owner token");
    }
    expect(getAsk(h.store.db, ask.id)?.status).toBe("pending");
    expect((await h.resolve(ask.id, "Allow once")).status).toBe(200);
    expect((await reply(pending)).decision).toBe("allow");
  });

  test("an owner-only hold is allowed with the owner token alone; a denial needs no token", async () => {
    const h = setUp();
    const b = h.body("git push origin HEAD:main", { category: "outward", ownerOnly: true });
    const pending = h.hold(b);
    const ask = await h.askFor(b.request_id);
    expect(ask.gate).toBe(FLOOR_OWNER_GATE);
    expect((await h.resolve(ask.id, "yes", null)).status).toBe(403);
    expect((await h.resolve(ask.id, "Deny", null)).status).toBe(200);
    expect((await reply(pending)).decision).toBe("deny");
  });

  test("a non-floor ask is answered without any token", async () => {
    const h = setUp();
    const ask = createAsk(h.store.db, h.sessionId, "ask_human", "Which branch?", ["main", "dev"]);
    expect((await h.resolve(ask.id, "yes", null)).status).toBe(200);
  });
});

describe("sweepExpiredFloorHolds", () => {
  test("times out pending floor holds past their deadline or without one, and leaves live and ordinary asks alone", () => {
    const h = setUp();
    const db = h.store.db;
    const now = new Date();
    const past = createAsk(db, h.sessionId, "ask_human", "q", [...FLOOR_OPTIONS], {
      gate: FLOOR_GATE,
      requestId: "r-past",
      floorExpiresAt: new Date(now.getTime() - 1000),
    });
    const none = createAsk(db, h.sessionId, "ask_human", "q", [...FLOOR_OPTIONS], { gate: FLOOR_OWNER_GATE, requestId: "r-none" });
    const live = createAsk(db, h.sessionId, "ask_human", "q", [...FLOOR_OPTIONS], {
      gate: FLOOR_GATE,
      requestId: "r-live",
      floorExpiresAt: new Date(now.getTime() + 60_000),
    });
    const ordinary = createAsk(db, h.sessionId, "ask_human", "q");
    expect(sweepExpiredFloorHolds(db, now).sort()).toEqual([past.id, none.id].sort());
    expect(getAsk(db, past.id)?.status).toBe("timeout");
    expect(getAsk(db, none.id)?.status).toBe("timeout");
    expect(getAsk(db, live.id)?.status).toBe("pending");
    expect(getAsk(db, ordinary.id)?.status).toBe("pending");
  });
});

describe("a hook whose floor config predates the collector's personal AWS accounts", () => {
  const PERSONAL = "444455556666";
  const HELD =
    `corp-creds credentials refresh --account ${PERSONAL} --role Admin && ` +
    `[ "$(aws sts get-caller-identity --query Account --output text)" = "${PERSONAL}" ] || exit 1; ` +
    "aws sagemaker delete-endpoint --region us-east-1 --endpoint-name X";

  /** Runs `fn` with STANDUP_PERSONAL_AWS_ACCOUNTS set as the service's systemd drop-in sets it. */
  const withPersonalAccounts = async (value: string, fn: () => Promise<void>) => {
    const before = process.env.STANDUP_PERSONAL_AWS_ACCOUNTS;
    const beforeNonProd = process.env.STANDUP_FLOOR_NONPROD_AWS_ACCOUNTS;
    process.env.STANDUP_PERSONAL_AWS_ACCOUNTS = value;
    // No account is non-prod here, so an unlisted account stays owner-gated.
    process.env.STANDUP_FLOOR_NONPROD_AWS_ACCOUNTS = "";
    try {
      await fn();
    } finally {
      if (before === undefined) delete process.env.STANDUP_PERSONAL_AWS_ACCOUNTS;
      else process.env.STANDUP_PERSONAL_AWS_ACCOUNTS = before;
      if (beforeNonProd === undefined) delete process.env.STANDUP_FLOOR_NONPROD_AWS_ACCOUNTS;
      else process.env.STANDUP_FLOOR_NONPROD_AWS_ACCOUNTS = beforeNonProd;
    }
  };

  /** The hold the launch's own hook raises: its config was built with no personal accounts (an empty list, not the default). */
  const staleHookHold = (h: ReturnType<typeof setUp>, command: string): FloorHold => {
    const config = buildLaunchFloorConfig({ launchId: h.launchId, root: h.root }, { ...process.env, STANDUP_PERSONAL_AWS_ACCOUNTS: "" });
    const verdict = classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: h.root }, config, { awsAccount: () => null });
    if (verdict.action !== "hold") throw new Error("the stale hook should hold the call");
    return { category: verdict.category, ownerOnly: verdict.ownerOnly, reason: verdict.reason, step: verdict.step };
  };

  test("the held credential + sagemaker command goes to Persona once the collector lists the account", async () => {
    await withPersonalAccounts(PERSONAL, async () => {
      const h = setUp();
      const client = staleHookHold(h, HELD);
      expect(client).toMatchObject({ category: "aws", ownerOnly: true });
      expect(client.reason).toContain(`account ${PERSONAL}, which is not a personal account`);
      const b = h.body(HELD, client);
      const pending = h.hold(b);
      const ask = await h.askFor(b.request_id);
      expect(ask.gate).toBe(FLOOR_GATE);
      expect(ask.question).toStartWith("Safety floor held a Bash call (personal-aws)");
      expect(ask.question).toContain(`personal account ${PERSONAL}`);
      expect(ask.question).not.toContain("which is not a personal account");
      expect(ask.question).toContain("Persona may allow it once or deny it.");
      const ctx = { owned: true, askKind: ask.kind, askGate: ask.gate ?? undefined, floorCategory: "personal-aws", authorizes: [ask.question, ...FLOOR_OPTIONS] };
      expect(decide("answer_ask", { ...ctx, text: "Allow once" }).rule).toBe("act");
      await h.resolve(ask.id, "Deny");
      expect((await reply(pending)).decision).toBe("deny");
    });
  });

  test("an account the collector doesn't list stays owner-gated", async () => {
    await withPersonalAccounts("111122223333", async () => {
      const h = setUp();
      const b = h.body(HELD, staleHookHold(h, HELD));
      const pending = h.hold(b);
      const ask = await h.askFor(b.request_id);
      expect(ask.gate).toBe(FLOOR_OWNER_GATE);
      expect(ask.question).toStartWith("Safety floor held a Bash call (aws)");
      await h.resolve(ask.id, "Deny");
      expect((await reply(pending)).decision).toBe("deny");
    });
  });

  test("a personal-account call that also does something owner-only stays owner-gated", async () => {
    await withPersonalAccounts(PERSONAL, async () => {
      const h = setUp();
      const command = `${HELD}; git push origin HEAD:main`;
      const b = h.body(command, staleHookHold(h, command));
      const pending = h.hold(b);
      const ask = await h.askFor(b.request_id);
      expect(ask.gate).toBe(FLOOR_OWNER_GATE);
      await h.resolve(ask.id, "Deny");
      expect((await reply(pending)).decision).toBe("deny");
    });
  });

  test("a hook hold the collector can't reproduce without the accounts stays owner-gated", async () => {
    await withPersonalAccounts(PERSONAL, async () => {
      const h = setUp();
      const b = h.body(HELD, { ...staleHookHold(h, HELD), reason: "an alias the hook expanded runs aws in an unlisted account" });
      const pending = h.hold(b);
      const ask = await h.askFor(b.request_id);
      expect(ask.gate).toBe(FLOOR_OWNER_GATE);
      await h.resolve(ask.id, "Deny");
      expect((await reply(pending)).decision).toBe("deny");
    });
  });
});

describe("a mutating AWS call whose command doesn't name the account", () => {
  const PERSONAL = "444455556666";
  const INVOKE =
    "aws sagemaker-runtime invoke-endpoint --region us-east-1 --endpoint-name my-endpoint " +
    "--content-type application/json --body '{}' /tmp/out.json";
  const MUTATION = "aws lambda update-function-code --region us-east-1 --function-name fn --zip-file fileb:///tmp/f.zip";

  /** A home whose default profile holds static keys, as `corp-creds credentials refresh` writes them. */
  const homeWithDefaultKeys = () => {
    const home = mkdtempSync(join(tmpdir(), "floor-home-"));
    dirs.push(home);
    mkdirSync(join(home, ".aws"));
    writeFileSync(join(home, ".aws", "credentials"), "[default]\naws_access_key_id = ASIAEXAMPLE\naws_secret_access_key = secret\naws_session_token = token\n");
    return home;
  };

  /** Credentials in a fresh home that STS (`callerAccount`) says belong to its answer. */
  const identity = (callerAccount: () => Promise<string | null>) => {
    const calls: string[] = [];
    const id = createAwsIdentity({
      env: {},
      home: homeWithDefaultKeys(),
      callerAccount: async (keys) => {
        calls.push(keys.accessKeyId);
        return callerAccount();
      },
    });
    return { id, calls };
  };

  /** The hold the launch's hook raises with the collector's current accounts: it never resolves credentials. */
  const hookHold = (h: ReturnType<typeof setUp>, command: string): FloorHold => {
    const config = buildLaunchFloorConfig({ launchId: h.launchId, root: h.root }, { ...process.env, STANDUP_PERSONAL_AWS_ACCOUNTS: PERSONAL });
    const verdict = classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: h.root }, config, { awsAccount: () => null });
    if (verdict.action !== "hold") throw new Error("the hook should hold the call");
    return { category: verdict.category, ownerOnly: verdict.ownerOnly, reason: verdict.reason, step: verdict.step };
  };

  const withPersonalAccounts = async (fn: () => Promise<void>) => {
    const before = process.env.STANDUP_PERSONAL_AWS_ACCOUNTS;
    process.env.STANDUP_PERSONAL_AWS_ACCOUNTS = PERSONAL;
    try {
      await fn();
    } finally {
      if (before === undefined) delete process.env.STANDUP_PERSONAL_AWS_ACCOUNTS;
      else process.env.STANDUP_PERSONAL_AWS_ACCOUNTS = before;
    }
  };

  test("goes to Persona when the default credentials belong to the personal account", async () => {
    await withPersonalAccounts(async () => {
      const { id, calls } = identity(async () => PERSONAL);
      const h = setUp({ awsIdentity: id });
      const client = hookHold(h, MUTATION);
      expect(client).toMatchObject({ category: "aws", ownerOnly: true });
      expect(client.reason).toContain("an account the floor couldn't determine");
      const b = h.body(MUTATION, client);
      const pending = h.hold(b);
      const ask = await h.askFor(b.request_id);
      expect(ask.gate).toBe(FLOOR_GATE);
      expect(ask.question).toStartWith("Safety floor held a Bash call (personal-aws)");
      expect(ask.question).toContain(`personal account ${PERSONAL}`);
      expect(ask.question).toContain("the credentials it runs with belong to it");
      expect(ask.question).not.toContain("couldn't determine");
      expect(calls).toEqual(["ASIAEXAMPLE"]);
      await h.resolve(ask.id, "Allow once");
      expect((await reply(pending)).decision).toBe("allow");

      // The same credentials again: answered from the cache.
      const again = h.body(MUTATION, client);
      const second = h.hold(again);
      const ask2 = await h.askFor(again.request_id);
      expect(ask2.gate).toBe(FLOOR_GATE);
      expect(calls).toEqual(["ASIAEXAMPLE"]);
      await h.resolve(ask2.id, "Deny");
      expect((await reply(second)).decision).toBe("deny");
    });
  });

  test("resolves the credentials when only a non-prod account is listed, and places the call in it", async () => {
    const NONPROD = "777788889999";
    const before = { personal: process.env.STANDUP_PERSONAL_AWS_ACCOUNTS, nonProd: process.env.STANDUP_FLOOR_NONPROD_AWS_ACCOUNTS };
    process.env.STANDUP_PERSONAL_AWS_ACCOUNTS = "";
    process.env.STANDUP_FLOOR_NONPROD_AWS_ACCOUNTS = NONPROD;
    try {
      const { id, calls } = identity(async () => NONPROD);
      const h = setUp({ awsIdentity: id });
      const config = buildLaunchFloorConfig({ launchId: h.launchId, root: h.root }, process.env);
      const verdict = classifyToolCall({ toolName: "Bash", toolInput: { command: MUTATION }, cwd: h.root }, config, { awsAccount: () => null });
      if (verdict.action !== "hold") throw new Error("the hook should hold the call");
      const b = h.body(MUTATION, { category: verdict.category, ownerOnly: verdict.ownerOnly, reason: verdict.reason, step: verdict.step });
      const pending = h.hold(b);
      const ask = await h.askFor(b.request_id);
      expect(calls).toEqual(["ASIAEXAMPLE"]);
      expect(ask.question).toStartWith("Safety floor held a Bash call (nonprod-aws)");
      expect(ask.question).toContain(`account ${NONPROD}, a non-prod account`);
      await h.resolve(ask.id, "Deny");
      expect((await reply(pending)).decision).toBe("deny");
    } finally {
      for (const [key, value] of [["STANDUP_PERSONAL_AWS_ACCOUNTS", before.personal], ["STANDUP_FLOOR_NONPROD_AWS_ACCOUNTS", before.nonProd]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("stays with the owner when the credentials belong to another account", async () => {
    await withPersonalAccounts(async () => {
      const { id } = identity(async () => "111122223333");
      const h = setUp({ awsIdentity: id });
      const b = h.body(INVOKE, hookHold(h, INVOKE));
      const pending = h.hold(b);
      const ask = await h.askFor(b.request_id);
      expect(ask.gate).toBe(FLOOR_OWNER_GATE);
      expect(ask.question).toStartWith("Safety floor held a Bash call (aws)");
      expect(ask.question).toContain("account 111122223333, which is not a personal account");
      await h.resolve(ask.id, "Deny");
      expect((await reply(pending)).decision).toBe("deny");
    });
  });

  test("stays with the owner when STS fails or times out", async () => {
    await withPersonalAccounts(async () => {
      for (const callerAccount of [async () => null, async () => Promise.reject(new Error("timed out"))]) {
        const { id, calls } = identity(callerAccount);
        const h = setUp({ awsIdentity: id });
        const b = h.body(INVOKE, hookHold(h, INVOKE));
        const pending = h.hold(b);
        const ask = await h.askFor(b.request_id);
        expect(calls).toHaveLength(1);
        expect(ask.gate).toBe(FLOOR_OWNER_GATE);
        expect(ask.question).toContain("an account the floor couldn't determine");
        await h.resolve(ask.id, "Deny");
        expect((await reply(pending)).decision).toBe("deny");
      }
    });
  });

  test("stays with the owner when the call picks a profile the personal credentials don't serve", async () => {
    await withPersonalAccounts(async () => {
      const { id, calls } = identity(async () => PERSONAL);
      const h = setUp({ awsIdentity: id });
      const command = `AWS_PROFILE=prod ${INVOKE}`;
      const b = h.body(command, hookHold(h, command));
      const pending = h.hold(b);
      const ask = await h.askFor(b.request_id);
      expect(calls).toEqual([]);
      expect(ask.gate).toBe(FLOOR_OWNER_GATE);
      await h.resolve(ask.id, "Deny");
      expect((await reply(pending)).decision).toBe("deny");
    });
  });

  test("a personal-credentials call that also does something owner-only stays owner-gated", async () => {
    await withPersonalAccounts(async () => {
      const { id } = identity(async () => PERSONAL);
      const h = setUp({ awsIdentity: id });
      const command = `${INVOKE}; git push origin HEAD:main`;
      const b = h.body(command, hookHold(h, command));
      const pending = h.hold(b);
      const ask = await h.askFor(b.request_id);
      expect(ask.gate).toBe(FLOOR_OWNER_GATE);
      await h.resolve(ask.id, "Deny");
      expect((await reply(pending)).decision).toBe("deny");
    });
  });

  test("a model invoke runs with no card when the credentials belong to the personal account", async () => {
    await withPersonalAccounts(async () => {
      for (const command of [
        INVOKE,
        `aws sts get-caller-identity && ${INVOKE}`,
        "aws bedrock-runtime converse --region us-west-2 --model-id m --messages '[]'",
        `aws sts get-caller-identity; ${INVOKE} && aws bedrock-runtime invoke-model --model-id m --body '{}' /tmp/m.json`,
      ]) {
        const { id } = identity(async () => PERSONAL);
        const h = setUp({ awsIdentity: id });
        const client = hookHold(h, command);
        expect(client).toMatchObject({ category: "aws", ownerOnly: true });
        const b = h.body(command, client);
        const r = await reply(h.hold(b));
        expect({ command, decision: r.decision }).toEqual({ command, decision: "allow" });
        const ask = await h.askFor(b.request_id);
        expect(ask.status).toBe("answered");
        const row = h.store.db.query("SELECT answered_by FROM asks WHERE id = ?").get(ask.id) as { answered_by: string };
        expect(row.answered_by).toBe(PERSONAL_INVOKE_ANSWERER);
        expect(h.frames.some((f) => f.type === "ask:new")).toBe(false);
        // The allow is handed out once, as for any answered hold.
        expect((await reply(h.hold(b))).decision).toBe("deny");
      }
    });
  });

  test("an invoke beside a personal-account mutation still goes to Persona", async () => {
    await withPersonalAccounts(async () => {
      const { id } = identity(async () => PERSONAL);
      const h = setUp({ awsIdentity: id });
      const command = `${INVOKE} && ${MUTATION}`;
      const b = h.body(command, hookHold(h, command));
      const pending = h.hold(b);
      const ask = await h.askFor(b.request_id);
      expect(ask.gate).toBe(FLOOR_GATE);
      expect(ask.status).toBe("pending");
      await h.resolve(ask.id, "Deny");
      expect((await reply(pending)).decision).toBe("deny");
    });
  });
});
