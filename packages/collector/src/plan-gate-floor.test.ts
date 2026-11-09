import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, relative, resolve } from "path";
import { randomUUID } from "crypto";
import {
  approvePlan,
  attachSessionToLaunch,
  createLaunch,
  createPlanApproval,
  createSession,
  createStore,
  createTicket,
  getPendingAsksBySession,
  resolveAsk,
  submitPlan,
  updateTicketStatus,
  upsertProject,
} from "@standup/store";
import type { Launch } from "@standup/shared";
import { ownerSecretsDir } from "@standup/shared/owner-token";
import { createServer } from "./server.js";
import { generateOwnerSecrets, scrubCredentialEnv } from "./owner-secret.js";
import { checkAcceptanceCriterion } from "./plan-gate.js";
import { classifyCriterion, criterionFloorGate } from "./floor/criterion.js";
import { classifyToolCall, defaultProbes } from "./floor/classify.js";
import { serverFloorConfig } from "./floor/routes.js";
import {
  CRITERION_OWNER_HOLD_REASON,
  FLOOR_GATE,
  FLOOR_OWNER_GATE,
  OWNER_ONLY_CATEGORIES,
  floorCategoryOf,
  isHighRiskFloorHold,
} from "./floor/gate.js";
import { decide } from "./persona/policy.js";
import heldApprovals from "./persona/fixtures/held-approvals.json";
import { setActiveOrgProfile } from "./org-profile/load.js";
import { exampleCorpProfile } from "./org-profile/fixtures/example-corp.js";

// The example.corp fixture profile: its review CLI (`corp-review`) is a
// Persona-decidable `review` hold.
beforeAll(() => setActiveOrgProfile(exampleCorpProfile()));
afterAll(() => setActiveOrgProfile());

/*
 * A plan's acceptance criterion runs as the owner, outside the worker's
 * safety floor, so the floor classifies it first (floor/criterion.ts): a
 * criterion the floor would hold for the worker doesn't run, and the hold is
 * the same safety-floor ask a worker's own call raises.
 */

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** This checkout's root: a real worktree layout for the fixture criterion's `cd` steps. */
const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

function setUp() {
  const store = createStore(":memory:");
  const projectId = `p-${randomUUID().slice(0, 8)}`;
  upsertProject(store.db, { id: projectId, name: "P", branch: "main", repos: [] });
  const worktree = mkdtempSync(join(tmpdir(), "standup-criterion-floor-"));
  dirs.push(worktree);
  const launch = createLaunch(store.db, { id: randomUUID(), projectId, task: "t", worktreePath: worktree, branch: "standup/t", status: "running" });
  const sessionId = randomUUID();
  createSession(store.db, { id: sessionId, projectId, title: "worker", cwd: worktree, status: "running" });
  attachSessionToLaunch(store.db, launch.id, sessionId);
  const gate = createPlanApproval(store.db, { launchId: launch.id, projectId, worktreePath: worktree });
  const app = createServer(store, () => {}, null, undefined, undefined, "", "", {}, undefined, undefined, undefined, undefined, {
    ownerSecrets: generateOwnerSecrets(),
  });
  const ticket = createTicket(store.db, { projectId, lens: "bugs", title: "Fix it", body: "…" });
  store.db.run("UPDATE tickets SET launch_id = ? WHERE id = ?", [launch.id, ticket.id]);
  updateTicketStatus(store.db, ticket.id, "approved");
  updateTicketStatus(store.db, ticket.id, "developing");
  const approve = (criterion: string) => {
    submitPlan(store.db, gate.id, { relevantFiles: [], plan: "the plan", acceptanceCriterion: criterion });
    approvePlan(store.db, gate.id, { acceptanceCriterion: criterion });
  };
  const ready = () =>
    app.request(`/api/tickets/${ticket.id}/ready`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: worktree, readyReason: "done" }),
    });
  return { store, worktree, launch: launch as Launch, sessionId, gate, approve, ready };
}

describe("acceptance criterion under the safety floor", () => {
  test("a criterion with an owner-only command doesn't run and raises an owner floor card", async () => {
    const h = setUp();
    const marker = join(h.worktree, "ran.marker");
    h.approve(`touch ${marker} && git push origin HEAD`);

    const res = await h.ready();
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain("safety floor holds it");
    expect(existsSync(marker)).toBe(false);

    const asks = getPendingAsksBySession(h.store.db, h.sessionId);
    expect(asks).toHaveLength(1);
    expect(asks[0]!.gate).toBe(FLOOR_OWNER_GATE);
    expect(asks[0]!.question).toContain("git push origin HEAD");

    // Asking again while the card is open raises no second card.
    expect((await h.ready()).status).toBe(409);
    expect(getPendingAsksBySession(h.store.db, h.sessionId)).toHaveLength(1);
    expect(existsSync(marker)).toBe(false);

    // The owner allows it once: the next readiness check runs it.
    resolveAsk(h.store.db, asks[0]!.id, "Allow once");
    await h.ready();
    expect(existsSync(marker)).toBe(true);
  });

  test("a denied criterion stays unrun, with no new card", async () => {
    const h = setUp();
    const marker = join(h.worktree, "ran.marker");
    h.approve(`touch ${marker}; npm publish`);
    await h.ready();
    const [ask] = getPendingAsksBySession(h.store.db, h.sessionId);
    resolveAsk(h.store.db, ask!.id, "Deny: publish from the release pipeline instead");
    const res = await h.ready();
    expect(res.status).toBe(409);
    const body = JSON.stringify(await res.json());
    expect(body).toContain("denied");
    expect(body).toContain("publish from the release pipeline instead");
    expect(getPendingAsksBySession(h.store.db, h.sessionId)).toHaveLength(0);
    expect(existsSync(marker)).toBe(false);
  });

  test("a plain local check runs with no card", async () => {
    const h = setUp();
    h.approve("test ! -e shots-tmp && true");
    expect((await h.ready()).status).toBe(200);
    expect(getPendingAsksBySession(h.store.db, h.sessionId)).toHaveLength(0);
  });

  test("criteria that reach past the worktree are held in the category the floor gives a worker", () => {
    const h = setUp();
    const owner: Array<[string, string]> = [
      ["bun test && git push", "outward"],
      ["bun test; corp-review --all && git push", "outward"],
      ["cdk deploy MyStack", "outward"],
      ["aws s3 cp x s3://b/x", "aws"],
      ["curl -s -X POST http://localhost:7777/api/launch", "collector-api"],
      [`cat ${join(ownerSecretsDir(), "owner.token")}`, "floor-tamper"],
    ];
    for (const [criterion, category] of owner) {
      const { verdict } = classifyCriterion(h.store.db, h.launch, h.worktree, criterion);
      expect(verdict.action).toBe("hold");
      if (verdict.action === "hold") {
        expect(verdict.category).toBe(category as never);
        expect(OWNER_ONLY_CATEGORIES.has(verdict.category)).toBe(true);
      }
    }
    const review = classifyCriterion(h.store.db, h.launch, h.worktree, "bun test; corp-review --all").verdict;
    expect(review.action).toBe("hold");
    if (review.action === "hold") {
      expect(review.category).toBe("review");
      expect(OWNER_ONLY_CATEGORIES.has(review.category)).toBe(false);
    }
    const unreadable = classifyCriterion(h.store.db, h.launch, h.worktree, 'eval "$CMD"').verdict;
    expect(unreadable.action).toBe("hold");
  });

  test("the fixture plan-approval criterion (typecheck, test, build, test !) is allowed by the floor on a feature branch", () => {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "standup", name: "standup", branch: "main", repos: [] });
    const launch = createLaunch(store.db, { id: randomUUID(), projectId: "standup", task: "t", worktreePath: REPO_ROOT, branch: "standup/t" }) as Launch;
    // As classifyCriterion does, with this checkout read as on `branch` whatever branch it is on; other directories read as they are.
    const root = realpathSync(REPO_ROOT);
    const probed = defaultProbes();
    const classify = (command: string, branch: string) =>
      classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: REPO_ROOT }, serverFloorConfig(store.db, launch), {
        awsAccount: () => null,
        gitBranch: (dir) => (relative(root, dir).startsWith("..") ? probed.gitBranch(dir) : branch),
      });
    // The fixture's one held approve_plan call carries the criterion.
    const [criterion] = Object.values(heldApprovals).flatMap(({ args }) =>
      "acceptanceCriterion" in args && typeof args.acceptanceCriterion === "string" ? [args.acceptanceCriterion] : []
    );
    expect(criterion).toBeString();
    expect(classify(criterion!, "standup/t")).toEqual({ action: "allow" });
    const suite = "bun run typecheck && (cd packages/store && bun test) && (cd packages/collector && bun test)";
    expect(classify(suite, "standup/t")).toEqual({ action: "allow" });
    // Every test file's `git commit` runs in a temp repo the floor places, so a checkout on a shared branch reads the same.
    expect(classify(suite, "mainline")).toEqual({ action: "allow" });
    // Three classifications of every test file in the repository and the modules they import, within the floor's own 8s budget each.
  }, 30_000);

  test("a Persona-decidable hold is a safety_floor ask; the owner's criterion hold is a Persona-decided owner-gate ask", () => {
    const h = setUp();
    const decidable = criterionFloorGate({ db: h.store.db, gateId: h.gate.id, launch: h.launch, sessionId: h.sessionId, cwd: h.worktree, criterion: "rm -rf /srv/some-other-checkout" });
    expect(decidable.run).toBe(false);
    if (!decidable.run) {
      expect(decidable.ask?.gate).toBe(FLOOR_GATE);
      expect(decidable.message).toContain("Persona or the owner decides");
    }

    const held = criterionFloorGate({ db: h.store.db, gateId: h.gate.id, launch: h.launch, sessionId: h.sessionId, cwd: h.worktree, criterion: "true", ownerHold: true });
    expect(held.run).toBe(false);
    if (!held.run) {
      expect(held.ask?.gate).toBe(FLOOR_OWNER_GATE);
      expect(held.ask!.question).toContain(CRITERION_OWNER_HOLD_REASON);
      expect(held.ask!.question).not.toContain("Only the owner can allow this");
      expect(held.ask!.question).toContain("Persona may allow it once (recorded for the owner) or deny it.");
      expect(held.message).toContain("Persona or the owner decides");
      const question = held.ask!.question;
      const allow = decide("answer_ask", { owned: true, askKind: "ask_human", askGate: FLOOR_OWNER_GATE, floorCategory: floorCategoryOf(question), text: "Allow once" });
      expect(allow.rule).toBe("act");
    }
    expect(criterionFloorGate({ db: h.store.db, gateId: h.gate.id, launch: h.launch, sessionId: h.sessionId, cwd: h.worktree, criterion: "true" })).toEqual({ run: true });
  });

  test("a criterion hold on a Persona job's worker goes to Persona, never pushed to the owner; without Persona the owner is pushed", () => {
    const h = setUp();
    const pushed: string[] = [];
    const base = { db: h.store.db, gateId: h.gate.id, launch: h.launch, sessionId: h.sessionId, cwd: h.worktree };
    const notifyOwner = (_id: string, question: string) => void pushed.push(question);

    for (const criterion of ["true", "rm -rf /srv/some-other-checkout"]) {
      const held = criterionFloorGate({ ...base, criterion, ownerHold: criterion === "true", notifyOwner, personaHandles: () => true });
      expect(held.run).toBe(false);
    }
    expect(pushed).toHaveLength(0);

    const unhandled = criterionFloorGate({ ...base, gateId: `${h.gate.id}-b`, criterion: "true", ownerHold: true, notifyOwner, personaHandles: () => false });
    expect(unhandled.run).toBe(false);
    expect(pushed).toHaveLength(1);
  });

  test("a high-risk criterion hold on a Persona job's worker goes to Persona like any other: its ask goes out and the owner isn't pushed", () => {
    const h = setUp();
    const order: string[] = [];
    const pushed: string[] = [];
    const base = {
      db: h.store.db,
      launch: h.launch,
      sessionId: h.sessionId,
      cwd: h.worktree,
      broadcast: (m: { type: string }) => void order.push(m.type),
      notifyOwner: (_id: string, question: string) => void pushed.push(question),
      personaHandles: () => true,
    };
    const procRead = ["cat", "/proc/1/environ"].join(" ");
    const risky = criterionFloorGate({ ...base, gateId: `${h.gate.id}-r`, criterion: procRead });
    expect(risky.run).toBe(false);
    expect(!risky.run && isHighRiskFloorHold(risky.ask!.question)).toBe(true);
    expect(order).toEqual(["ask:new"]);
    expect(pushed).toHaveLength(0);
  });

  test("under the owner's criterion hold a criterion the floor also holds keeps the floor's category and high-risk label", () => {
    const h = setUp();
    const criterion = "bun test && git push origin HEAD";
    const plain = criterionFloorGate({ db: h.store.db, gateId: h.gate.id, launch: h.launch, sessionId: h.sessionId, cwd: h.worktree, criterion });
    expect(plain.run).toBe(false);
    if (!plain.run) {
      expect(plain.ask?.gate).toBe(FLOOR_OWNER_GATE);
      expect(decide("answer_ask", { owned: true, askKind: "ask_human", askGate: FLOOR_OWNER_GATE, floorCategory: floorCategoryOf(plain.ask!.question), text: "Allow once" }).rule).toBe("act");
    }

    const held = criterionFloorGate({ db: h.store.db, gateId: h.gate.id, launch: h.launch, sessionId: h.sessionId, cwd: h.worktree, criterion: `${criterion} --tags`, ownerHold: true });
    expect(held.run).toBe(false);
    if (held.run) return;
    const question = held.ask!.question;
    expect(held.ask!.gate).toBe(FLOOR_OWNER_GATE);
    expect(floorCategoryOf(question)).toBe("outward");
    expect(question).toContain(`${CRITERION_OWNER_HOLD_REASON}; the floor also holds it: `);
    expect(question).not.toContain("Only the owner can allow this");
    expect(isHighRiskFloorHold(question)).toBe(false);
    expect(decide("answer_ask", { owned: true, askKind: "ask_human", askGate: FLOOR_OWNER_GATE, floorCategory: floorCategoryOf(question), text: "Allow once" }).rule).toBe("act");

    const secret = criterionFloorGate({ db: h.store.db, gateId: h.gate.id, launch: h.launch, sessionId: h.sessionId, cwd: h.worktree, criterion: "cat /proc/1/environ", ownerHold: true });
    expect(secret.run).toBe(false);
    if (secret.run) return;
    expect(isHighRiskFloorHold(secret.ask!.question)).toBe(true);
    const risky = decide("answer_ask", {
      owned: true,
      askKind: "ask_human",
      askGate: secret.ask!.gate,
      floorCategory: floorCategoryOf(secret.ask!.question),
      floorHighRisk: true,
      text: "Allow once",
    });
    expect(risky.rule).toBe("act");
  });

  test("the criterion runs without the owner's AWS, git-host or SSH credentials", async () => {
    const env = scrubCredentialEnv({
      HOME: "/home/u",
      PATH: process.env.PATH,
      AWS_ACCESS_KEY_ID: "AKIA-secret",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_PROFILE: "admin",
      GH_TOKEN: "gh-secret",
      GITHUB_TOKEN: "gh-secret",
      GIT_ASKPASS: "/bin/askpass",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      NPM_TOKEN: "npm-secret",
      STANDUP_OWNER_TOKEN: "owner-secret",
    });
    const dir = mkdtempSync(join(tmpdir(), "standup-criterion-env-"));
    dirs.push(dir);
    const out = await checkAcceptanceCriterion(dir, "env", undefined, env);
    expect(out.met).toBe(true);
    for (const secret of ["AKIA-secret", "gh-secret", "/bin/askpass", "agent.sock", "npm-secret", "owner-secret", "AWS_PROFILE"]) {
      expect(out.output).not.toContain(secret);
    }
    expect(out.output).toContain("AWS_CONFIG_FILE=/dev/null");
    expect(out.output).toContain("AWS_SHARED_CREDENTIALS_FILE=/dev/null");
    expect(out.output).toContain("GIT_TERMINAL_PROMPT=0");
    expect(out.output).toContain("HOME=/home/u");
  });
});
