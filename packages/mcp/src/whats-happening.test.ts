import { expect, test, describe, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKER_TOKEN_FILE_ENV, WORKER_TOKEN_HEADER } from "@standup/shared";
import { handleToolCall } from "./tools.js";

/**
 * whats_happening is the read-only, pull-first activity tool: it POSTs the
 * caller's correlation to /api/active-work and renders the returned rows as a
 * compact "active work" block. The collector does the scoping and self-exclusion;
 * this test pins the wiring (the endpoint + the empty/non-empty rendering).
 */
describe("whats_happening MCP tool", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("posts to /api/active-work and renders the returned work as bullets", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        JSON.stringify({
          work: [
            { sessionId: "s1", title: "Refactor the store", status: "running", actor: "bob", lastActivityAt: "x" },
            { sessionId: "s2", title: "", status: "done", lastActivityAt: "x" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    const out = await handleToolCall("whats_happening", {}, "http://collector.test");

    expect(capturedUrl).toContain("/api/active-work");
    expect(capturedBody.scoped).toBe(true);
    const text = out.content[0].text;
    expect(text).toContain("Active work in this project (active, paused, or seen in the last 24h):");
    expect(text).toContain("- Refactor the store — running — bob");
    expect(text).toContain("- Untitled — done");
  });

  test("renders a launched worker's Persona job and a paused worker's status", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          work: [
            {
              sessionId: "w1",
              title: "Fix the reaper",
              status: "running",
              actor: "owner",
              job: { id: "j1", title: "Nightly improvements" },
              lastActivityAt: "x",
            },
            { sessionId: "w2", title: "Speed up search", status: "paused", actor: "owner", lastActivityAt: "x" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )) as unknown as typeof fetch;

    const text = (await handleToolCall("whats_happening", {}, "http://collector.test")).content[0].text;
    expect(text).toContain("- Fix the reaper — running — owner — job: Nightly improvements");
    expect(text).toContain("- Speed up search — paused — owner");
  });

  test("renders a graceful message when nothing is active", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ work: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

    const out = await handleToolCall("whats_happening", {}, "http://collector.test");
    expect(out.content[0].text).toContain("No other agents are active");
  });

  test("sends the launch's worker token, so a worker resolves to its own session and job owner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wh-token-"));
    const tokenFile = join(dir, "worker-token");
    writeFileSync(tokenFile, "the-worker-token", { mode: 0o600 });
    const saved = process.env[WORKER_TOKEN_FILE_ENV];
    process.env[WORKER_TOKEN_FILE_ENV] = tokenFile;
    const seen: { token?: string | null } = {};
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      seen.token = new Headers(init?.headers).get(WORKER_TOKEN_HEADER);
      return new Response(JSON.stringify({ work: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      await handleToolCall("whats_happening", {}, "http://collector.test");
      expect(seen.token).toBe("the-worker-token");
    } finally {
      if (saved === undefined) delete process.env[WORKER_TOKEN_FILE_ENV];
      else process.env[WORKER_TOKEN_FILE_ENV] = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("says so when the collector could not resolve the caller's project, rather than reporting nothing active", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ work: [], unresolved: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

    const text = (await handleToolCall("whats_happening", {}, "http://collector.test")).content[0].text;
    expect(text).toContain("Could not tell which project you are in");
    expect(text).not.toContain("No other agents are active");
  });
});
