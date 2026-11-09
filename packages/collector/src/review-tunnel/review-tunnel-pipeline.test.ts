import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "fs";
import type { ReviewTunnel } from "@standup/shared";
import { getReviewTunnel, listLiveReviewTunnels, listReviewTunnelsByLaunches, upsertProject } from "@standup/store";
import { EVIDENCE, OWNER, WORKTREE, advance, decideHumanReview, human, makeWorld, post, submitPacket, writeTinyPng, type World } from "../pipeline/test-world.js";
import { FakeTunnelSystem } from "./fake-system.js";
import { createReviewTunnels } from "./index.js";
import type { ReviewTunnels } from "./manager.js";

const SERVE = "python3 -m http.server {port} --bind 127.0.0.1";
const UI_PROJECT = "ui-project";

beforeAll(() => {
  // The world's launch worktree: the serve command runs from it.
  mkdirSync(WORKTREE, { recursive: true });
});

interface TunnelWorld extends World {
  sys: FakeTunnelSystem;
  tunnels: ReviewTunnels;
}

function tunnelWorld(opts: { serve?: string | null; persona?: boolean } = {}): TunnelWorld {
  const sys = new FakeTunnelSystem();
  sys.hostUser = OWNER;
  let tunnels!: ReviewTunnels;
  const serve = opts.serve === undefined ? SERVE : opts.serve;
  const w = makeWorld({
    persona: opts.persona,
    projectOverride: serve ? { reviewTunnel: { serve } } : undefined,
    reviewTunnels: (store, broadcast) => (tunnels = createReviewTunnels(store.db, sys, broadcast)),
  });
  // A UI change, so the screenshot stage is entered rather than auto-skipped.
  w.changed.files = ["packages/web/src/components/Thing.tsx"];
  return { ...w, sys, tunnels };
}

/**
 * Advances the world's run from start to the screenshot stage and waits for
 * the tunnel opening. A review packet is submitted first, since the run moves
 * on into code_review only with one in the Review tab.
 */
async function toScreenshot(w: TunnelWorld): Promise<void> {
  submitPacket(w);
  for (const [stage, evidence] of [
    ["start", {}],
    ["coding", EVIDENCE.coding],
    ["validation", EVIDENCE.validationPass],
    ["review", EVIDENCE.reviewClean],
    ["deploy", EVIDENCE.deploy],
  ] as const) {
    const res = await advance(w, stage, evidence);
    expect(res.status).toBe(200);
  }
  await w.tunnels.idle();
}

async function status(w: World) {
  const res = await post(w, "/api/pipeline/status", { session_id: w.sessionId });
  return (await res.json()) as { run: { currentStage: string }; reviewTunnel?: { url: string; port: number; status: string } };
}

function liveFor(w: World): ReviewTunnel | undefined {
  return listLiveReviewTunnels(w.store.db).find((t) => t.launchId === w.launch.id);
}

describe("the review tunnel in the delivery pipeline", () => {
  test("entering screenshot opens a tunnel to the branch build; the worker's status shows it", async () => {
    const w = tunnelWorld();
    await toScreenshot(w);
    const t = liveFor(w)!;
    expect(t).toMatchObject({ status: "open", port: 5200, runId: w.run.id, owner: OWNER });
    expect(w.sys.live("python3")[0]!.cwd).toBe(WORKTREE);
    const s = await status(w);
    expect(s.run.currentStage).toBe("screenshot");
    expect(s.reviewTunnel).toMatchObject({ url: t.url, port: 5200, status: "open" });
    expect(w.checkpoints.some((c) => c.startsWith(`Review tunnel open: ${t.url}`))).toBe(true);
  });

  test("no UI change: screenshot auto-skips and no tunnel opens", async () => {
    const w = tunnelWorld();
    w.changed.files = ["packages/collector/src/x.ts"];
    await toScreenshot(w);
    expect((await status(w)).run.currentStage).toBe("code_review");
    expect(liveFor(w)).toBeUndefined();
    expect(w.sys.processes).toEqual([]);
  });

  test("a project without UI config gets no tunnel", async () => {
    const w = tunnelWorld({ serve: null });
    await toScreenshot(w);
    expect((await status(w)).run.currentStage).toBe("screenshot");
    expect(liveFor(w)).toBeUndefined();
    expect((await status(w)).reviewTunnel).toBeUndefined();
  });

  test("approving the review tears the tunnel down", async () => {
    const w = tunnelWorld();
    await toScreenshot(w);
    expect((await advance(w, "screenshot", { screenshots: [{ path: writeTinyPng() }] })).status).toBe(200);
    expect((await advance(w, "code_review", { url: "https://git.example.com/acme/app/pull/1", issueId: "ISSUE-1" })).status).toBe(200);
    const t = liveFor(w)!;
    const decided = await decideHumanReview(w, "approved");
    expect(decided.status).toBe(200);
    expect(getReviewTunnel(w.store.db, t.id)).toMatchObject({ status: "closed", closeReason: "review_decided" });
    expect(w.sys.live()).toEqual([]);
    expect(w.sys.live("python3")).toEqual([]);
  });

  test("requesting changes tears it down, and the next screenshot round opens a fresh one", async () => {
    const w = tunnelWorld();
    await toScreenshot(w);
    await advance(w, "screenshot", { screenshots: [{ path: writeTinyPng() }] });
    await advance(w, "code_review", { url: "https://git.example.com/acme/app/pull/1", issueId: "ISSUE-1" });
    const first = liveFor(w)!;
    expect((await decideHumanReview(w, "changes_requested")).status).toBe(200);
    expect(getReviewTunnel(w.store.db, first.id)!.closeReason).toBe("review_decided");
    expect((await status(w)).run.currentStage).toBe("coding");
    for (const [stage, evidence] of [
      ["coding", EVIDENCE.coding],
      ["validation", EVIDENCE.validationPass],
      ["review", EVIDENCE.reviewClean],
      ["deploy", EVIDENCE.deploy],
    ] as const) {
      expect((await advance(w, stage, evidence)).status).toBe(200);
    }
    await w.tunnels.idle();
    const second = liveFor(w)!;
    expect(second.id).not.toBe(first.id);
    expect(listReviewTunnelsByLaunches(w.store.db, [w.launch.id]).map((t) => t.status)).toEqual(["open", "closed"]);
  });

  test("the owner tears it down from the console; another user can't see or close it", async () => {
    const w = tunnelWorld();
    await toScreenshot(w);
    const t = liveFor(w)!;
    const theirs = await w.app.request(`/api/review-tunnels?launchIds=${w.launch.id}`, { headers: human(w, "mallory") });
    expect(((await theirs.json()) as { tunnels: unknown[] }).tunnels).toEqual([]);
    expect((await post(w, `/api/review-tunnels/${t.id}/close`, {}, human(w, "mallory"))).status).toBe(404);
    expect(getReviewTunnel(w.store.db, t.id)!.status).toBe("open");

    const mine = await w.app.request(`/api/review-tunnels?launchIds=${w.launch.id}`, { headers: human(w) });
    expect(((await mine.json()) as { tunnels: Array<{ id: string; url: string }> }).tunnels.map((x) => x.url)).toEqual([t.url]);
    const res = await post(w, `/api/review-tunnels/${t.id}/close`, {}, human(w));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { closed: boolean }).closed).toBe(true);
    expect(getReviewTunnel(w.store.db, t.id)!.closeReason).toBe("manual");
  });

  test("a worker can neither read nor close tunnels", async () => {
    const w = tunnelWorld();
    await toScreenshot(w);
    const t = liveFor(w)!;
    expect((await w.app.request(`/api/review-tunnels?launchIds=${w.launch.id}`)).status).toBe(403);
    expect((await post(w, `/api/review-tunnels/${t.id}/close`, {})).status).toBe(403);
    expect((await post(w, "/api/review-tunnels/close", { jobId: "x" })).status).toBe(403);
  });

  test("cleaning the launch up tears the tunnel down before the worktree goes", async () => {
    const w = tunnelWorld();
    await toScreenshot(w);
    const t = liveFor(w)!;
    await post(w, `/api/launches/${w.launch.id}/cleanup`, {}, human(w));
    expect(getReviewTunnel(w.store.db, t.id)).toMatchObject({ status: "closed", closeReason: "launch_ended" });
  });

  test("the job closing is caught by the sweep even without close_job", async () => {
    const w = tunnelWorld({ persona: true });
    await toScreenshot(w);
    const t = liveFor(w)!;
    expect(t.jobId).toBeDefined();
    w.store.db.run("UPDATE persona_jobs SET status = 'done' WHERE id = ?", [t.jobId!]);
    expect(w.tunnels.sweep().closed).toEqual([{ id: t.id, reason: "job_closed" }]);
  });
});

describe("pipeline config: the review-tunnel layer", () => {
  async function getConfig(w: World, project?: string) {
    const res = await w.app.request(`/api/pipeline-config${project ? `?project=${project}` : ""}`, { headers: human(w) });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  }
  async function putConfig(w: World, override: unknown, project?: string) {
    const res = await w.app.request(`/api/pipeline-config${project ? `?project=${project}` : ""}`, {
      method: "PUT",
      headers: { ...human(w), "Content-Type": "application/json" },
      body: JSON.stringify({ override }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  }

  function worldWithUi(): World {
    const w = makeWorld();
    upsertProject(w.store.db, { id: UI_PROJECT, name: "UI", branch: "main", repos: [] });
    return w;
  }

  test("no project has a built-in seed, so a project's tunnel is what its layers set", async () => {
    const w = worldWithUi();
    const ui = await getConfig(w, UI_PROJECT);
    expect(ui.status).toBe(200);
    expect(ui.body.seed).toBeNull();
    expect(ui.body.resolved.definition.reviewTunnel).toBeUndefined();
  });

  test("the user's project layer overrides the user's global layer, for that user only", async () => {
    const w = worldWithUi();
    expect((await putConfig(w, { reviewTunnel: { ttlHours: 3, allow: "bob" } })).status).toBe(200);
    expect((await putConfig(w, { reviewTunnel: { serve: SERVE, allow: "group:reviewers" } }, UI_PROJECT)).status).toBe(200);
    const ui = await getConfig(w, UI_PROJECT);
    // The project layer's allow wins; the global TTL applies, since the project layer leaves it.
    expect(ui.body.resolved.definition.reviewTunnel).toMatchObject({ allow: "group:reviewers", ttlHours: 3, serve: SERVE });
    // Another user's layers are their own: none set, so no tunnel.
    const res = await w.app.request(`/api/pipeline-config?project=${UI_PROJECT}`, { headers: human(w, "bob") });
    const bob = (await res.json()) as Record<string, any>;
    expect(bob.resolved.definition.reviewTunnel).toBeUndefined();
  });

  test("an invalid layer is refused naming the field", async () => {
    const w = makeWorld();
    const bad = await putConfig(w, { reviewTunnel: { serve: "vite", portRange: [5300, 5200] } }, "proj");
    expect(bad.status).toBe(400);
    // The layer's index counts the preset resolvePipelineLayers puts beneath the stored layers.
    expect(bad.body.errors).toEqual([
      expect.stringMatching(/^layer\[\d+\]\.reviewTunnel\.serve: must contain \{port\}, where the allocated port goes$/),
      expect.stringMatching(/^layer\[\d+\]\.reviewTunnel\.portRange: must be \[low, high\], ports from 1024 to 65535 with low <= high$/),
    ]);
  });

  test("a run freezes the config it launched with", async () => {
    const w = makeWorld({ projectOverride: { reviewTunnel: { serve: SERVE } } });
    expect(w.run.definition.reviewTunnel).toEqual({ serve: SERVE });
    await putConfig(w, { reviewTunnel: { enabled: false } }, "proj");
    const res = await w.app.request(`/api/pipeline/runs?launchIds=${w.launch.id}`, { headers: human(w) });
    const runs = ((await res.json()) as { runs: Array<{ definition: { reviewTunnel?: unknown } }> }).runs;
    expect(runs[0]!.definition.reviewTunnel).toEqual({ serve: SERVE });
  });
});
