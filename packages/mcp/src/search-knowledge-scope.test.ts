import { expect, test, describe, afterEach } from "bun:test";
import { formatSearchResults, handleToolCall, tools, type SearchToolHit, type SearchToolResult } from "./tools.js";

/**
 * search_knowledge is the primary agent retrieval tool, so it must be gated the
 * same way its graph_neighbors pivot is: the tool sets `scoped: true` so the
 * collector resolves the requesting user SERVER-SIDE (the calling session's
 * identity) and applies the strict scope gate, and it forwards the caller's
 * `owner`/`corpus` only as the permissive browse knobs — never as an identity
 * claim. A missing `scoped` flag would default the endpoint to the permissive
 * browse path and leak another user's private user-scoped docs, so this locks it
 * to true. The collector-side identity resolution (scopingUser →
 * resolveAgentAudience) is covered by the server tests; here we assert the tool
 * sends the flag that engages it and never smuggles a user/actor field.
 */
describe("search_knowledge MCP tool forwards scoped:true", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("posts scoped:true and the query, and never a caller-supplied user/actor", async () => {
    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({ results: [], project: "alpha" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await handleToolCall(
      "search_knowledge",
      { query: "auth widget retry", owner: "alice", corpus: "all" },
      "http://collector.test"
    );

    expect(capturedBody.scoped).toBe(true);
    expect(capturedBody.query).toBe("auth widget retry");
    // The permissive browse knob is forwarded verbatim...
    expect(capturedBody.owner).toBe("alice");
    // ...but the tool never sends a user/actor field the collector could mistake
    // for an identity claim — identity is resolved server-side from the session.
    expect(capturedBody.user).toBeUndefined();
    expect(capturedBody.actor).toBeUndefined();
  });
});

/**
 * The search_knowledge output prints the number results are ordered by
 * (`score`), next to the absolute `relevance` the confidence floor read, so the
 * order and the printed numbers always agree. Each hit names its project, scope
 * and layer, and a contradicted doc says which side of the conflict it is.
 */
describe("search_knowledge MCP tool output", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function respond(body: Record<string, unknown>, bodies: Array<Record<string, unknown>> = []) {
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
  }

  test("prints the ordering score and the relevance, in order, with scope and layer", async () => {
    respond({
      project: "alpha",
      results: [
        {
          id: "id-relevant",
          projectId: "alpha",
          slug: "retry-policy",
          title: "Retry policy",
          excerpt: "how retries back off…",
          score: 0.74,
          relevance: 0.81,
          scope: "project",
          layer: "docs",
          source: "embedding",
        },
        {
          id: "id-other",
          projectId: "beta",
          slug: "backoff-notes",
          title: "Backoff notes",
          excerpt: "jitter…",
          score: 0.58,
          relevance: 0.62,
          scope: "global",
          layer: "docs",
          source: "text",
        },
      ],
    });
    const res = await handleToolCall("search_knowledge", { query: "retry backoff" }, "http://collector.test");
    const text = res.content[0].type === "text" ? res.content[0].text : "";
    const scores = [...text.matchAll(/score (\d+\.\d+)/g)].map((m) => Number(m[1]));
    expect(scores).toEqual([0.74, 0.58]);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(text).toContain("(alpha, project, docs; score 0.74, relevance 0.81; id id-relevant)");
    expect(text).toContain("(beta, global, docs; score 0.58, relevance 0.62; id id-other)");
    expect(text).toContain('get_knowledge_doc(id="id-relevant")');
  });

  test("marks a contradicted doc with its counterpart and side", async () => {
    respond({
      project: "alpha",
      results: [
        {
          id: "id-old",
          projectId: "alpha",
          slug: "always-on-orchestrator",
          title: "Orchestrator plan",
          excerpt: "uncommitted…",
          score: 0.5,
          relevance: 0.6,
          source: "text",
          verdict: "contradicted",
          injectionEligible: false,
          contradiction: { side: "losing", counterparts: ["alpha/persona-architecture"] },
        },
      ],
    });
    const res = await handleToolCall("search_knowledge", { query: "orchestrator" }, "http://collector.test");
    const text = res.content[0].type === "text" ? res.content[0].text : "";
    expect(text).toContain(
      "⚠ CONTRADICTS alpha/persona-architecture (this side is older or less verified — prefer the other)"
    );
    // One warning per hit: the contradiction marker replaces the generic not-injected one.
    expect(text).not.toContain("not auto-injected");
  });

  test.each<{ name: string; hit: Partial<SearchToolHit>; has: string[]; lacks: string[] }>([
    {
      name: "a landed doc carries the landed marker",
      hit: { landed: "✓ LANDED — the work of branch feat/x is on main; the doc's merge-status wording is out of date" },
      has: ["✓ LANDED — the work of branch feat/x is on main"],
      lacks: ["stale since"],
    },
    {
      name: "a landed doc is never also dated stale",
      hit: { landed: "✓ LANDED — the work it describes is on main; the doc's merge-status wording is out of date", staleSince: "2026-09-01" },
      has: ["✓ LANDED — the work it describes is on main"],
      lacks: ["stale since"],
    },
    {
      name: "a stale doc without a landed record is dated",
      hit: { staleSince: "2026-09-01" },
      has: ["⚠ stale since 2026-09-01"],
      lacks: ["LANDED"],
    },
  ])("$name", ({ hit, has, lacks }) => {
    const text = formatSearchResults("q", {
      project: "alpha",
      results: [
        { id: "id-1", projectId: "alpha", slug: "plan", title: "Plan", excerpt: "…", score: 0.5, source: "text", ...hit },
      ],
    });
    for (const s of has) expect(text).toContain(s);
    for (const s of lacks) expect(text).not.toContain(s);
  });

  test("says 'no confident match' and shows weak matches only below a divider when asked", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    respond({ project: "alpha", results: [], noConfidentMatch: true }, bodies);
    let res = await handleToolCall("search_knowledge", { query: "sourdough rye" }, "http://collector.test");
    let text = res.content[0].type === "text" ? res.content[0].text : "";
    expect(text).toContain(
      `No confident match for "sourdough rye" across all projects you can see — nothing cleared the confidence bar.`
    );
    expect(text).toContain("low_confidence: <n> shows the closest weak matches");
    expect(bodies[0].lowConfidence).toBeUndefined();

    respond(
      {
        project: "alpha",
        results: [],
        noConfidentMatch: true,
        lowConfidence: [
          {
            id: "id-weak",
            projectId: "alpha",
            slug: "retry-policy",
            title: "Retry policy",
            excerpt: "…",
            score: 0.1,
            relevance: 0.08,
            source: "text",
          },
        ],
      },
      bodies
    );
    res = await handleToolCall("search_knowledge", { query: "sourdough rye", low_confidence: 2 }, "http://collector.test");
    text = res.content[0].type === "text" ? res.content[0].text : "";
    expect(bodies[1].lowConfidence).toBe(2);
    const divider = text.indexOf("below the confidence floor");
    expect(divider).toBeGreaterThan(text.indexOf("No confident match"));
    expect(text.indexOf("[retry-policy]")).toBeGreaterThan(divider);
  });
});

describe("search_knowledge MCP tool and the activity layer", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("marks an activity note with its date, and forwards an opt-out", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(
        JSON.stringify({
          project: "alpha",
          results: [
            {
              id: "id-diary",
              projectId: "alpha",
              slug: "native-mem-memory-diary",
              title: "Session diary",
              excerpt: "what happened…",
              score: 0.03,
              source: "text",
              layer: "activity",
              activityDate: "2026-09-30",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    const res = await handleToolCall("search_knowledge", { query: "diary" }, "http://collector.test");
    const text = res.content[0].type === "text" ? res.content[0].text : "";
    expect(text).toContain("[native-mem-memory-diary] [activity 2026-09-30] Session diary");
    expect(bodies[0]?.excludeActivity).toBeUndefined();

    await handleToolCall("search_knowledge", { query: "diary", exclude_activity: true }, "http://collector.test");
    await handleToolCall("search_knowledge", { query: "diary", include_activity: false }, "http://collector.test");
    expect(bodies[1]?.excludeActivity).toBe(true);
    expect(bodies[2]?.excludeActivity).toBe(true);
  });
});

describe("search_knowledge output — no-match text", () => {
  const base = { project: "alpha", results: [] as SearchToolHit[] };
  const weak: SearchToolHit = {
    id: "id-weak",
    projectId: "alpha",
    slug: "retry-policy",
    title: "Retry policy",
    excerpt: "…",
    score: 0.1,
    source: "text",
  };

  test.each<{ name: string; result: SearchToolResult; first: string; has: string[]; lacks: string[] }>([
    {
      name: "corpus all, nothing cleared the bar",
      result: { ...base, corpus: "all" as const },
      first: `No confident match for "q" across all projects you can see — nothing cleared the confidence bar.`,
      has: ["rephrase as a natural question", `pass project: "<id>"`, "low_confidence: <n>"],
      lacks: ["alpha's knowledge", "corpus is empty"],
    },
    {
      name: "corpus project, nothing cleared the bar",
      result: { ...base, corpus: "project" as const },
      first: `No confident match for "q" in alpha's knowledge — nothing cleared the confidence bar.`,
      has: ["rephrase as a natural question", "low_confidence: <n>"],
      lacks: ["across all projects", "corpus is empty"],
    },
    {
      name: "an empty corpus",
      result: { ...base, corpus: "all" as const, emptyCorpus: true },
      first: `No match for "q" across all projects you can see — the corpus is empty.`,
      has: [`pass project: "<id>"`],
      lacks: ["confidence bar", "rephrase", "low_confidence"],
    },
    {
      name: "weak matches already shown",
      result: { ...base, corpus: "all" as const, lowConfidence: [weak] },
      first: `No confident match for "q" across all projects you can see — nothing cleared the confidence bar.`,
      has: ["rephrase as a natural question", "below the confidence floor"],
      lacks: ["low_confidence: <n>"],
    },
  ])("$name", ({ result, first, has, lacks }) => {
    const text = formatSearchResults("q", result);
    expect(text.split("\n")[0]).toBe(first);
    for (const s of has) expect(text).toContain(s);
    for (const s of lacks) expect(text).not.toContain(s);
  });

  test("the no-match answer is at most three lines with a warning, which it always carries", () => {
    const text = formatSearchResults("q", {
      ...base,
      corpus: "all",
      projectWarning: `Unknown project "wsb-codex" — searched alpha instead. Known projects: alpha, global.`,
    });
    const lines = text.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe(`Warning: Unknown project "wsb-codex" — searched alpha instead. Known projects: alpha, global.`);
  });

  test("a corpus fallback is reported with and without hits", () => {
    const fallback = "alpha has no knowledge docs; searched all projects instead.";
    const none = formatSearchResults("q", { ...base, corpus: "all", corpusFallback: fallback });
    expect(none).toContain("across all projects you can see");
    expect(none).toContain(`Note: ${fallback}`);
    const hit = formatSearchResults("q", { ...base, results: [weak], corpus: "all", corpusFallback: fallback });
    expect(hit.indexOf(`Note: ${fallback}`)).toBeGreaterThan(hit.indexOf("[retry-policy]"));
  });

  test("an older collector's reply is worded by the corpus the tool asked for", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ project: "alpha", results: [], noConfidentMatch: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    try {
      const res = await handleToolCall("search_knowledge", { query: "q", corpus: "project" }, "http://collector.test");
      const text = res.content[0].type === "text" ? res.content[0].text : "";
      expect(text).toContain(`in alpha's knowledge — nothing cleared the confidence bar.`);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("search_knowledge tool description — personal scope", () => {
  test("says the caller's own user-scoped docs come back only with an owner filter", () => {
    const description = tools.find((t) => t.name === "search_knowledge")?.description ?? "";
    expect(description).toContain("Your own personal (user-scoped) docs are left out unless you pass `owner`");
    expect(description).not.toContain("and your own user-scoped docs");
  });
});

describe("search_knowledge output — calibration", () => {
  test("search output says when relevance was read through an uncalibrated band", () => {
    const base = { project: "alpha", results: [] as SearchToolHit[] };
    expect(formatSearchResults("q", { ...base, calibration: { status: "uncalibrated", low: 0.45, high: 0.75 } })).toContain(
      "relevance uncalibrated"
    );
    expect(formatSearchResults("q", { ...base, calibration: { status: "calibrated", low: 0.47, high: 0.73 } })).not.toContain(
      "uncalibrated"
    );
  });

  test("a stale band is reported as stale, not as never measured", () => {
    const text = formatSearchResults("q", {
      project: "alpha",
      results: [],
      calibration: { status: "stale", low: 0.45, high: 0.75 },
    });
    expect(text).toContain("calibration stale");
    expect(text).not.toContain("not been measured");
  });
});

describe("search_knowledge output — as_of history hits", () => {
  const hit = (overrides: Partial<SearchToolHit>): SearchToolHit => ({
    id: "h1",
    projectId: "alpha",
    slug: "gotchas",
    title: "Gotchas",
    excerpt: "The deploy script needs the legacy flag.",
    score: 0.9,
    relevance: 0.9,
    source: "text",
    ...overrides,
  });

  test("a closed version says when it stopped being current and what replaced it", () => {
    const text = formatSearchResults("deploy", {
      project: "alpha",
      results: [
        hit({ validTo: "2026-03-01T00:00:00.000Z", supersededBy: "alpha/gotchas", injectionEligible: false }),
      ],
    });
    expect(text).toContain("⚠ historical version valid until 2026-03-01T00:00:00.000Z, replaced by alpha/gotchas");
    // Never injected, so it carries no trust warning beside the historical one.
    expect(text).not.toContain("not auto-injected");
  });

  test("a closed version with no successor still carries the marker; a current hit carries none", () => {
    const closed = formatSearchResults("deploy", { project: "alpha", results: [hit({ validTo: "2026-03-01" })] });
    expect(closed).toContain("⚠ historical version valid until 2026-03-01 — not the current doc");
    const current = formatSearchResults("deploy", { project: "alpha", results: [hit({})] });
    expect(current).not.toContain("historical version");
  });
});
