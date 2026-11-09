import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { collectorRetry, handleToolCall, restartInProgress, restartRecordPath, restartWorstCaseMs, tools } from "./tools.js";
import { timingsFromEnv, worstCaseMs } from "../../collector/src/restart/supervisor.js";

/**
 * A waiting call (ask_human, submit_plan, propose_standup_improvement) rides
 * out a collector restart: a dropped connection or a 5xx is retried with the
 * same request id, so the collector re-attaches it to what the first attempt
 * raised instead of raising it again. The knowledge tools retry the same
 * failures within a fixed budget: a short one for reads, a longer one for
 * propose_knowledge.
 */

const realFetch = globalThis.fetch;
const realRetry = { ...collectorRetry };

beforeEach(() => {
  collectorRetry.baseDelayMs = 1;
  collectorRetry.maxDelayMs = 2;
  collectorRetry.sleep = async () => {};
  collectorRetry.restartInProgress = () => false;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  Object.assign(collectorRetry, realRetry);
});

type Step = "refused" | number | Record<string, unknown>;

/** Answers each fetch with the next step: a connection error, an error status, or a JSON body. */
function script(steps: Step[]) {
  const bodies: Array<Record<string, unknown>> = [];
  const urls: string[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    urls.push(url);
    bodies.push(JSON.parse(String(init?.body)));
    const step = steps.length > 1 ? steps.shift()! : steps[0]!;
    if (step === "refused") throw new TypeError("Unable to connect. Is the computer able to access the url?");
    if (typeof step === "number") {
      return new Response(JSON.stringify({ error: "collector restarting" }), { status: step, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify(step), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { bodies, urls };
}

describe("ask_human across a collector restart", () => {
  test("re-sends the same request id until the collector answers, and returns its answer", async () => {
    const { bodies } = script(["refused", "refused", 503, { answer: "Use approach B." }]);
    const result = await handleToolCall("ask_human", { question: "A or B?", timeout_s: 600 }, "http://collector.test");
    expect(result.content[0].text).toBe("Use approach B.");
    expect(bodies).toHaveLength(4);
    const ids = new Set(bodies.map((b) => b.request_id));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toEqual(expect.any(String));
    expect(bodies[0]!.timeout_s).toBe(600);
    for (const b of bodies) expect(b.timeout_s as number).toBeLessThanOrEqual(600);
  });

  test("each tool call gets its own request id", async () => {
    const { bodies } = script([{ answer: "yes" }]);
    await handleToolCall("ask_human", { question: "one?" }, "http://collector.test");
    await handleToolCall("ask_human", { question: "two?" }, "http://collector.test");
    expect(bodies[0]!.request_id).not.toBe(bodies[1]!.request_id);
  });

  test("gives up once the collector has been unreachable for the whole window", async () => {
    collectorRetry.windowMs = 30;
    collectorRetry.sleep = (ms) => new Promise((r) => setTimeout(r, ms + 5));
    const { bodies } = script(["refused"]);
    const result = await handleToolCall("ask_human", { question: "A or B?" }, "http://collector.test");
    expect(result.content[0].text).toContain("stayed unreachable");
    expect(bodies.length).toBeGreaterThan(1);
  });

  test("a 4xx is the collector's answer and is not retried", async () => {
    const { bodies } = script([409]);
    const result = await handleToolCall("ask_human", { question: "A or B?" }, "http://collector.test");
    expect(result.content[0].text).toContain("(409)");
    expect(bodies).toHaveLength(1);
  });
});

describe("submit_plan and propose_standup_improvement across a restart", () => {
  test("submit_plan re-sends the same plan after a dropped connection and gets the decision with its note", async () => {
    const { bodies } = script(["refused", 502, { status: "approved", plan: "Edit a.ts", note: "Keep the old API." }]);
    const result = await handleToolCall("submit_plan", { plan: "Edit a.ts" }, "http://collector.test");
    expect(result.content[0].text).toContain("Plan APPROVED");
    expect(result.content[0].text).toContain("Keep the old API.");
    expect(bodies).toHaveLength(3);
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
  });

  test("propose_standup_improvement re-attaches by request id", async () => {
    const { bodies, urls } = script(["refused", { launched: true, status: "launched", askId: "a1", projectId: "standup", launch: { id: "l1" } }]);
    const result = await handleToolCall(
      "propose_standup_improvement",
      { title: "Fix it", description: "It is broken", kind: "bug" },
      "http://collector.test"
    );
    expect(result.content[0].text).toContain("launch l1");
    expect(urls.every((u) => u.endsWith("/api/standup/improve"))).toBe(true);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.request_id).toEqual(expect.any(String));
    expect(bodies[1]!.request_id).toBe(bodies[0]!.request_id);
  });
});

describe("mark_ready_for_review and report_ticket_status across a restart", () => {
  test("mark_ready_for_review re-sends the same body after a released 503 and a dropped connection", async () => {
    const { bodies, urls } = script([503, "refused", { ticket: { id: "t1", status: "needs_review" } }]);
    const result = await handleToolCall("mark_ready_for_review", { readyReason: "done" }, "http://collector.test");
    expect(result.content[0].text).toContain('Ticket "t1" marked ready for review');
    expect(bodies).toHaveLength(3);
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(urls.every((u) => u.endsWith("/api/tickets/_/ready"))).toBe(true);
  });

  test("mark_ready_for_review does not retry the collector's 409", async () => {
    const { bodies } = script([409]);
    const result = await handleToolCall("mark_ready_for_review", {}, "http://collector.test");
    expect(result.content[0].text).toContain("(409)");
    expect(bodies).toHaveLength(1);
  });

  test("report_ticket_status retries the needs_review edge only", async () => {
    const review = script([503, { ticket: { id: "t1", status: "needs_review" } }]);
    const ok = await handleToolCall("report_ticket_status", { ticketId: "t1", status: "needs_review" }, "http://collector.test");
    expect(ok.content[0].text).toContain("moved to needs_review");
    expect(review.bodies).toHaveLength(2);

    const other = script([503]);
    const failed = await handleToolCall("report_ticket_status", { ticketId: "t1", status: "developing" }, "http://collector.test");
    expect(failed.content[0].text).toContain("(503)");
    expect(other.bodies).toHaveLength(1);
  });
});

describe("waiting through a restart", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  test("keeps retrying past the usual window while a restart is under way, then gets the answer", async () => {
    collectorRetry.windowMs = 20;
    collectorRetry.restartWindowMs = 60_000;
    collectorRetry.sleep = (ms) => new Promise((r) => setTimeout(r, ms + 5));
    let restarting = true;
    collectorRetry.restartInProgress = () => restarting;
    const steps: Step[] = Array.from({ length: 15 }, () => "refused" as Step);
    steps.push({ answer: "Use approach B." });
    const { bodies } = script(steps);
    const result = await handleToolCall("ask_human", { question: "A or B?" }, "http://collector.test");
    expect(result.content[0].text).toBe("Use approach B.");
    expect(bodies.length).toBe(16);
    restarting = false;
  });

  test("gives up once even the restart window has run out", async () => {
    collectorRetry.windowMs = 10;
    collectorRetry.restartWindowMs = 40;
    collectorRetry.sleep = (ms) => new Promise((r) => setTimeout(r, ms + 5));
    collectorRetry.restartInProgress = () => true;
    script(["refused"]);
    const result = await handleToolCall("submit_plan", { plan: "Edit a.ts" }, "http://collector.test");
    expect(result.content[0].text).toContain("stayed unreachable");
  });

  test("a restart is under way while the collector's record has not reached done", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mcp-restart-"));
    dirs.push(dataDir);
    const path = restartRecordPath({ DB_PATH: join(dataDir, "standup.db") });
    expect(path).toBe(join(dataDir, "restart", "current.json"));
    expect(restartInProgress(path)).toBe(false);
    mkdirSync(join(dataDir, "restart"));
    writeFileSync(path, JSON.stringify({ id: "r1", phase: "rolling_back" }));
    expect(restartInProgress(path)).toBe(true);
    writeFileSync(path, JSON.stringify({ id: "r1", phase: "done", outcome: "failed" }));
    expect(restartInProgress(path)).toBe(false);
    writeFileSync(path, "{not json");
    expect(restartInProgress(path)).toBe(false);
  });
});

describe("the restart window", () => {
  test("is the supervisor's worst case for the boot timeout it runs with, plus a margin", () => {
    for (const env of [
      {},
      { STANDUP_RESTART_BOOT_TIMEOUT_S: "600" },
      { STANDUP_RESTART_BOOT_TIMEOUT_S: "30" },
      { STANDUP_RESTART_BOOT_TIMEOUT_S: "junk" },
      { STANDUP_RESTART_PREFLIGHT_TIMEOUT_S: "3600" },
      { STANDUP_RESTART_BOOT_TIMEOUT_S: "30", STANDUP_RESTART_PREFLIGHT_TIMEOUT_S: "900" },
    ]) {
      expect(restartWorstCaseMs(env)).toBe(worstCaseMs(timingsFromEnv(env)));
    }
    expect(realRetry.restartWindowMs).toBeGreaterThan(restartWorstCaseMs());
    // Where the classic timeline is the longer one, each extra second of boot timeout counts four times.
    expect(restartWorstCaseMs({ STANDUP_RESTART_BOOT_TIMEOUT_S: "900" }) - restartWorstCaseMs({ STANDUP_RESTART_BOOT_TIMEOUT_S: "600" })).toBe(4 * 300_000);
  });
});

describe("knowledge tools across a dropped connection", () => {
  const searchResult = { results: [], project: "standup" };
  const proposeResult = { ok: true, slug: "gotchas", published: true, mode: "accept" };

  test("search_knowledge and get_knowledge_doc retry a refused connection and a 5xx, then answer", async () => {
    const search = script(["refused", 503, searchResult]);
    const searched = await handleToolCall("search_knowledge", { query: "retry" }, "http://collector.test");
    expect(searched.content[0].text).not.toContain("failed");
    expect(search.bodies).toHaveLength(3);
    expect(new Set(search.bodies.map((b) => JSON.stringify(b))).size).toBe(1);

    const doc = script([
      "refused",
      { id: "d1", slug: "gotchas", title: "Gotchas", projectId: "standup", body: "watch out", totalLength: 9, offset: 0, returnedLength: 9, hasMore: false },
    ]);
    const read = await handleToolCall("get_knowledge_doc", { slug: "gotchas" }, "http://collector.test");
    expect(read.content[0].text).toContain("watch out");
    expect(doc.bodies).toHaveLength(2);
  });

  test("propose_knowledge re-sends the same proposal after a refused connection and reports it published", async () => {
    const { bodies, urls } = script(["refused", "refused", proposeResult]);
    const result = await handleToolCall("propose_knowledge", { slug: "gotchas", title: "Gotchas", body: "watch out" }, "http://collector.test");
    expect(result.content[0].text).toMatch(/published/i);
    expect(urls.every((u) => u.endsWith("/api/knowledge/propose"))).toBe(true);
    expect(bodies).toHaveLength(3);
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
  });

  test("a 400 is the collector's answer and is not retried", async () => {
    const propose = script([400]);
    const refused = await handleToolCall("propose_knowledge", { slug: "persona-x", title: "X", body: "y" }, "http://collector.test");
    expect(refused.content[0].text).toContain("(400)");
    expect(propose.bodies).toHaveLength(1);

    const search = script([400]);
    const searched = await handleToolCall("search_knowledge", { query: "retry" }, "http://collector.test");
    expect(searched.content[0].text).toContain("(400)");
    expect(search.bodies).toHaveLength(1);
  });

  test("the read budget is shorter than propose_knowledge's", async () => {
    expect(realRetry.readBudgetMs).toBeGreaterThanOrEqual(20_000);
    expect(realRetry.readBudgetMs).toBeLessThanOrEqual(30_000);
    expect(realRetry.readBudgetMs).toBeLessThan(realRetry.windowMs);

    collectorRetry.readBudgetMs = 30;
    collectorRetry.windowMs = 60_000;
    collectorRetry.sleep = (ms) => new Promise((r) => setTimeout(r, ms + 5));
    const steps = (): Step[] => [...Array.from({ length: 12 }, () => "refused" as Step), proposeResult];

    script(steps());
    const searched = await handleToolCall("search_knowledge", { query: "retry" }, "http://collector.test");
    expect(searched.content[0].text).toContain("did not answer within");

    const propose = script(steps());
    const proposed = await handleToolCall("propose_knowledge", { slug: "gotchas", title: "Gotchas", body: "watch out" }, "http://collector.test");
    expect(proposed.content[0].text).toMatch(/published/i);
    expect(propose.bodies).toHaveLength(13);
  });

  test("a read whose collector never answers gives up within its budget; waiting calls are not bounded", async () => {
    collectorRetry.readBudgetMs = 60;
    collectorRetry.minReadAttemptMs = 20;
    const signals: Array<AbortSignal | undefined> = [];
    // Accepts every request and never answers, until the request is aborted.
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    }) as typeof fetch;

    for (const [name, args] of [
      ["search_knowledge", { query: "retry" }],
      ["get_knowledge_doc", { slug: "gotchas" }],
    ] as const) {
      const startedAt = Date.now();
      const result = await handleToolCall(name, args, "http://collector.test");
      expect(result.content[0].text).toContain("did not answer within");
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    }
    expect(signals.every((s) => s !== undefined)).toBe(true);

    signals.length = 0;
    script([{ answer: "yes" }]);
    const realScripted = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      return realScripted(url, init);
    }) as typeof fetch;
    await handleToolCall("ask_human", { question: "one?" }, "http://collector.test");
    script([proposeResult]);
    const scriptedPropose = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      return scriptedPropose(url, init);
    }) as typeof fetch;
    await handleToolCall("propose_knowledge", { slug: "gotchas", title: "Gotchas", body: "watch out" }, "http://collector.test");
    expect(signals).toEqual([undefined, undefined]);
  });

  test("a read is not extended through a restart; propose_knowledge is", async () => {
    collectorRetry.readBudgetMs = 10;
    collectorRetry.windowMs = 10;
    collectorRetry.restartWindowMs = 60_000;
    collectorRetry.restartInProgress = () => true;
    collectorRetry.sleep = (ms) => new Promise((r) => setTimeout(r, ms + 5));
    const steps = (): Step[] => [...Array.from({ length: 8 }, () => "refused" as Step), proposeResult];

    script(steps());
    const searched = await handleToolCall("search_knowledge", { query: "retry" }, "http://collector.test");
    expect(searched.content[0].text).toContain("did not answer within");

    script(steps());
    const proposed = await handleToolCall("propose_knowledge", { slug: "gotchas", title: "Gotchas", body: "watch out" }, "http://collector.test");
    expect(proposed.content[0].text).toMatch(/published/i);
  });

  test("propose_knowledge's description names the reserved persona slug prefix and tag", () => {
    const description = String(tools.find((t) => t.name === "propose_knowledge")!.description);
    expect(description).toContain('Slugs starting "persona-" and the tag "persona" are reserved for Persona');
    expect(description).toMatch(/titles must not carry code review ids, commit SHAs, dates or deploy\/validation status/);
    expect(description).toContain(
      "Propose facts about the code as it is on the default branch; if a fact only holds on your unmerged branch, " +
        "say so in the body (e.g. 'on branch X, not yet merged') or propose it after merge."
    );
  });
});
