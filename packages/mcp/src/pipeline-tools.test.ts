import { expect, test, describe, afterEach } from "bun:test";
import { tools, handleToolCall } from "./tools.js";

/**
 * pipeline_status and pipeline_advance let a launched worker read its delivery
 * stage and report evidence for it. This verifies both tools are registered,
 * that calls POST the calling session's correlation fields (plus stage,
 * evidence and skip) to the collector's pipeline routes, and that a refused
 * advance reads as an error naming every missing evidence field.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("pipeline_status MCP tool", () => {
  test("is registered and takes no arguments", () => {
    const tool = tools.find((t) => t.name === "pipeline_status");
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.required ?? []).toEqual([]);
  });

  test("a session without a run reads as a plain answer, not an error", async () => {
    globalThis.fetch = (async (_url: string) =>
      jsonResponse({ error: "This session's launch has no delivery pipeline run" }, 404)) as unknown as typeof fetch;
    const result = await handleToolCall("pipeline_status", {}, "http://collector.test");
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("No delivery pipeline for this session (disabled or not a coding launch).");
  });

  test("names the review tunnel and its local port when one is open", async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        run: { currentStage: "screenshot", status: "active" },
        stage: { id: "screenshot", title: "Screenshots", kind: "screenshot" },
        reviewTunnel: { url: "https://alice-ui.tunnels.example.com", port: 5201, status: "open" },
      })) as unknown as typeof fetch;
    const text = (await handleToolCall("pipeline_status", {}, "http://collector.test")).content[0].text;
    expect(text).toContain(
      "Review tunnel (open): https://alice-ui.tunnels.example.com serves your branch build, also on http://127.0.0.1:5201 — shoot screenshots against the local port."
    );
  });

  test("posts to /api/pipeline/status and renders the stage, criteria, transitions and budget", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return jsonResponse({
        run: { id: "run-1", currentStage: "validation", status: "waiting_user", waitingReason: "loop exhausted", waitingKind: "exhausted" },
        stage: { id: "validation", title: "Build and tests", kind: "validation", required: true },
        exitCriteria: "Every command exits 0.",
        next: [
          { to: "review", when: { outcome: "passed" } },
          { to: "coding", when: { outcome: "failed" }, loop: { maxTraversals: 4 } },
        ],
        loopBudget: [{ edge: { to: "coding", when: { outcome: "failed" }, loop: { maxTraversals: 4 } }, used: 2, max: 4 }],
        incomplete: ["validation", "review", "code_review"],
      });
    }) as typeof fetch;

    const result = await handleToolCall("pipeline_status", {}, "http://collector.test");

    expect(capturedUrl).toBe("http://collector.test/api/pipeline/status");
    expect(capturedBody).toHaveProperty("cwd");
    expect(capturedBody).toHaveProperty("session_id");
    const text = result.content[0].text;
    expect(text).toContain("validation — Build and tests (validation)");
    expect(text).toContain("waiting_user");
    expect(text).toContain("Waiting (exhausted — Persona (or the owner) decides how the run moves on): loop exhausted");
    expect(text).toContain("Every command exits 0.");
    expect(text).toContain("→ review when passed");
    expect(text).toContain("→ coding when failed (loop, at most 4×)");
    expect(text).toContain("2/4 used");
    expect(text).toContain("validation, review, code_review");
    expect(result.isError).toBeUndefined();
  });
});

describe("pipeline_advance MCP tool", () => {
  test("is registered with a stage + evidence + skip contract", () => {
    const tool = tools.find((t) => t.name === "pipeline_advance");
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.required).toEqual(["stage"]);
    const props = tool!.inputSchema.properties as Record<string, { type?: string }>;
    expect(props.stage.type).toBe("string");
    expect(props.evidence.type).toBe("object");
    expect(props.skip.type).toBe("object");
    for (const kind of ["coding", "validation", "review", "live_check", "deploy", "screenshot", "code_review"]) {
      expect(tool!.description).toContain(kind);
    }
  });

  test("says Persona decides a blocked stage, names the live_check evidence and scopes code_review to projects that have it", () => {
    const description = tools.find((t) => t.name === "pipeline_advance")!.description;
    expect(description).toContain("advances are refused until Persona (or the owner) decides the stage");
    expect(description).not.toContain("only the owner can waive it");
    expect(description).toContain("live_check {environment, isolation?: {ports, tmuxSocket}, liveSamples:[{request, response, ok}]}");
    expect(description).toContain("only on a project whose pipeline has a code_review stage");
  });

  test("posts the stage and evidence to /api/pipeline/advance and reports the move", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return jsonResponse({
        run: { currentStage: "code_review", status: "active" },
        from: "review",
        to: "code_review",
        outcome: "passed",
        skipped: [{ stageId: "deploy", reason: "skipped by config" }],
        message: "Open the code review next.",
      });
    }) as typeof fetch;

    const evidence = { reviewers: [{ name: "r1", findings: [] }, { name: "r2", findings: [] }] };
    const result = await handleToolCall("pipeline_advance", { stage: "review", evidence }, "http://collector.test");

    expect(capturedUrl).toBe("http://collector.test/api/pipeline/advance");
    expect(capturedBody.stage).toBe("review");
    expect(capturedBody.evidence).toEqual(evidence);
    expect(capturedBody).toHaveProperty("cwd");
    const text = result.content[0].text;
    expect(text).toContain("review passed");
    expect(text).toContain("now at code_review");
    expect(text).toContain("deploy (skipped by config)");
    expect(text).toContain("Open the code review next.");
    expect(result.isError).toBeUndefined();
  });

  test("forwards a skip request", async () => {
    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return jsonResponse({ run: { currentStage: "code_review", status: "active" }, from: "screenshot", to: "code_review", outcome: "passed", skipped: [], message: "" });
    }) as typeof fetch;

    await handleToolCall("pipeline_advance", { stage: "screenshot", skip: { reason: "no UI change" } }, "http://collector.test");
    expect(capturedBody.skip).toEqual({ reason: "no UI change" });
  });

  test("a 422 refusal is an error naming every missing field", async () => {
    globalThis.fetch = (async (_url: string) =>
      jsonResponse(
        {
          error: "evidence for validation is incomplete",
          missing: ["evidence.commands (non-empty array of {command, exitCode, summary})", "evidence.commands[0].exitCode"],
        },
        422
      )) as typeof fetch;

    const result = await handleToolCall("pipeline_advance", { stage: "validation", evidence: {} }, "http://collector.test");

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toStartWith("Pipeline refused the advance: evidence for validation is incomplete");
    expect(text).toContain("evidence.commands (non-empty array of {command, exitCode, summary})");
    expect(text).toContain("evidence.commands[0].exitCode");
  });

  test("a 409 without a missing list still surfaces the error", async () => {
    globalThis.fetch = (async (_url: string) => jsonResponse({ error: "current stage is coding, not review" }, 409)) as typeof fetch;

    const result = await handleToolCall("pipeline_advance", { stage: "review", evidence: {} }, "http://collector.test");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Pipeline refused the advance: current stage is coding, not review");
  });

  test("a 5xx reads as a collector failure, not a refusal", async () => {
    globalThis.fetch = (async (_url: string) => jsonResponse({ error: "boom" }, 500)) as typeof fetch;

    const result = await handleToolCall("pipeline_advance", { stage: "review" }, "http://collector.test");
    expect(result.content[0].text).toContain('standup tool "pipeline_advance" failed');
    expect(result.content[0].text).toContain("boom");
  });
});
