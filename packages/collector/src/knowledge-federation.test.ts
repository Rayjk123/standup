import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_IDENTITY_HEADER } from "@standup/shared";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createStore, upsertProject } from "@standup/store";
import { KnowledgeStore } from "@standup/knowledge";
import { USER_CHANNEL_HEADER, userChannelToken } from "@standup/shared/owner-token";
import {
  EXTERNAL_RETRIEVER_TIMEOUT_MS,
  FEDERATION_ERROR_LOG_INTERVAL_MS,
  RRF_K,
  commandRetriever,
  federateSearch,
  federationAllowedFor,
  fuseRrf,
  parseCommandRetrievers,
  parseJsonLines,
  registerExternalRetriever,
  resetFederationLogState,
  unregisterExternalRetriever,
  type ExternalHit,
  type ExternalRetriever,
  type FusedEntry,
  type LabeledExternalHit,
} from "./knowledge-federation.js";
import { createServer } from "./server.js";
import { activeOwnerSecrets } from "./owner-secret.js";
import { resetSessionProjectCaches } from "./session-project.js";

/**
 * External retrievers merged into knowledge search: reciprocal-rank merging with source
 * labels, per-source budgets and failure isolation, the opt-in project gate,
 * and the command adapter's JSON-lines contract.
 */

const OPTED_IN = { STANDUP_FEDERATION_PROJECTS: "alpha" };

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  resetFederationLogState();
  resetSessionProjectCaches();
});

function register(retriever: ExternalRetriever): void {
  registerExternalRetriever(retriever);
  cleanups.push(() => unregisterExternalRetriever(retriever.id));
}

function stub(id: string, hits: ExternalHit[], behaviour: { delayMs?: number; throws?: boolean } = {}): ExternalRetriever {
  return {
    id,
    label: id.toUpperCase(),
    async search(_query, { limit, signal }) {
      if (behaviour.throws) throw new Error(`${id} is down`);
      if (behaviour.delayMs) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, behaviour.delayMs);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      return hits.slice(0, limit);
    },
  };
}

const ext = (n: number): ExternalHit => ({ title: `Ext ${n}`, ref: `ref-${n}`, excerpt: `excerpt ${n}` });

const describeEntry = (e: FusedEntry): string => (e.kind === "local" ? `local:${e.id}` : `${e.retriever}:${e.ref}`);

describe("fuseRrf", () => {
  const labeled = (retriever: string, refs: string[]): LabeledExternalHit[] =>
    refs.map((ref) => ({ retriever, label: retriever, title: ref, ref, excerpt: "" }));

  test.each<{ name: string; local: string[]; lists: LabeledExternalHit[][]; order: string[] }>([
    {
      name: "equal ranks interleave, local first",
      local: ["a", "b"],
      lists: [labeled("mc", ["x", "y"])],
      order: ["local:a", "mc:x", "local:b", "mc:y"],
    },
    {
      name: "two external lists keep their configured order on ties",
      local: ["a"],
      lists: [labeled("mc", ["x"]), labeled("wiki", ["w"])],
      order: ["local:a", "mc:x", "wiki:w"],
    },
    {
      name: "a longer external list runs past a short local one",
      local: ["a"],
      lists: [labeled("mc", ["x", "y", "z"])],
      order: ["local:a", "mc:x", "mc:y", "mc:z"],
    },
    { name: "no local results", local: [], lists: [labeled("mc", ["x"])], order: ["mc:x"] },
  ])("$name", ({ local, lists, order }) => {
    expect(fuseRrf(local, lists).map(describeEntry)).toEqual(order);
  });

  test("scores are 1 / (k + rank) with k = 60", () => {
    const fused = fuseRrf(["a", "b"], []);
    expect(fused.map((e) => e.rrf)).toEqual([1 / (RRF_K + 1), 1 / (RRF_K + 2)]);
    expect(RRF_K).toBe(60);
  });
});

describe("federationAllowedFor", () => {
  test.each<{ name: string; project: string; options: Parameters<typeof federationAllowedFor>[1]; allowed: boolean }>([
    { name: "no project opts in by default", project: "alpha", options: { env: {} }, allowed: false },
    { name: "an opted-in project", project: "alpha", options: { env: OPTED_IN }, allowed: true },
    { name: "a project not on the list", project: "beta", options: { env: OPTED_IN }, allowed: false },
    {
      name: "standup is internal even when listed",
      project: "standup",
      options: { env: { STANDUP_FEDERATION_PROJECTS: "standup,alpha" } },
      allowed: false,
    },
    {
      name: "standup-self is internal even when listed",
      project: "standup-self",
      options: { env: { STANDUP_FEDERATION_PROJECTS: "standup-self" } },
      allowed: false,
    },
    {
      name: "the global corpus is internal",
      project: "global",
      options: { env: { STANDUP_FEDERATION_PROJECTS: "global" } },
      allowed: false,
    },
    { name: "a reserved project", project: "alpha", options: { env: OPTED_IN, reserved: true }, allowed: false },
    { name: "a restricted search", project: "alpha", options: { env: OPTED_IN, restricted: true }, allowed: false },
    {
      name: "the list tolerates spaces and empty entries",
      project: "alpha",
      options: { env: { STANDUP_FEDERATION_PROJECTS: " beta , ,alpha " } },
      allowed: true,
    },
  ])("$name", ({ project, options, allowed }) => {
    expect(federationAllowedFor(project, options)).toBe(allowed);
  });
});

describe("federateSearch", () => {
  test("is disabled by default: a configured retriever is never called", async () => {
    let calls = 0;
    register({ id: "mc", label: "MC", search: async () => (calls++, [ext(1)]) });
    expect(await federateSearch({ query: "q", projectId: "alpha", localIds: ["a"], env: {} })).toBeUndefined();
    expect(calls).toBe(0);
  });

  test("is skipped for a Standup-internal project", async () => {
    let calls = 0;
    register({ id: "mc", label: "MC", search: async () => (calls++, [ext(1)]) });
    const env = { STANDUP_FEDERATION_PROJECTS: "standup,standup-self" };
    expect(await federateSearch({ query: "q", projectId: "standup", localIds: [], env })).toBeUndefined();
    expect(await federateSearch({ query: "q", projectId: "standup-self", localIds: [], env })).toBeUndefined();
    expect(calls).toBe(0);
  });

  test("is undefined for an opted-in project with no retriever configured", async () => {
    expect(await federateSearch({ query: "q", projectId: "alpha", localIds: ["a"], env: OPTED_IN })).toBeUndefined();
  });

  test("fuses each source's hits with the local results and labels them", async () => {
    register(stub("mc", [ext(1), ext(2)]));
    const reply = await federateSearch({ query: "q", projectId: "alpha", localIds: ["a", "b"], env: OPTED_IN });
    expect(reply?.federated?.map(describeEntry)).toEqual(["local:a", "mc:ref-1", "local:b", "mc:ref-2"]);
    expect(reply?.federated?.[1]).toMatchObject({ kind: "external", label: "MC", title: "Ext 1", excerpt: "excerpt 1" });
    expect(reply?.externalSources).toEqual([{ id: "mc", label: "MC", status: "ok", hits: 2 }]);
  });

  test("normalizes hits: url wins over ref, hits without title or locator and duplicates are dropped", async () => {
    register(
      stub("mc", [
        { title: "Both", url: "https://x/1", ref: "r1", excerpt: "e" },
        { title: "", ref: "r2", excerpt: "no title" },
        { title: "No locator", excerpt: "e" },
        { title: "Dup", url: "https://x/1", excerpt: "e" },
      ])
    );
    const reply = await federateSearch({ query: "q", projectId: "alpha", localIds: [], env: OPTED_IN });
    expect(reply?.federated?.map(describeEntry)).toEqual(["mc:https://x/1"]);
  });

  test("a slow source times out within its budget and the fast one still answers", async () => {
    register({ ...stub("slow", [ext(9)], { delayMs: 5_000 }), timeoutMs: 100 });
    register({ ...stub("fast", [ext(1)]), timeoutMs: 1_000 });
    const logs: string[] = [];
    const started = performance.now();
    const reply = await federateSearch(
      { query: "q", projectId: "alpha", localIds: ["a"], env: OPTED_IN },
      { log: (m) => logs.push(m) }
    );
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(600);
    expect(reply?.federated?.map(describeEntry)).toEqual(["local:a", "fast:ref-1"]);
    expect(reply?.externalSources.find((s) => s.id === "slow")?.status).toBe("timeout");
    expect(logs).toEqual(["[knowledge-federation] slow timed out after 100 ms"]);
  });

  test("the default budget is 1500 ms", () => {
    expect(EXTERNAL_RETRIEVER_TIMEOUT_MS).toBe(1500);
  });

  test("a throwing source is isolated: local results survive and the failure is reported", async () => {
    register(stub("broken", [], { throws: true }));
    register({
      id: "sync-throw",
      label: "SYNC",
      search: () => {
        throw new Error("synchronous failure");
      },
    });
    register(stub("mc", [ext(1)]));
    const logs: string[] = [];
    const reply = await federateSearch(
      { query: "q", projectId: "alpha", localIds: ["a"], env: OPTED_IN },
      { log: (m) => logs.push(m) }
    );
    expect(reply?.federated?.map(describeEntry)).toEqual(["local:a", "mc:ref-1"]);
    expect(reply?.externalSources.map((s) => [s.id, s.status])).toEqual([
      ["broken", "error"],
      ["sync-throw", "error"],
      ["mc", "ok"],
    ]);
    expect(logs).toHaveLength(2);
  });

  test("when every source fails there is no fused ranking, only the source statuses", async () => {
    register(stub("broken", [], { throws: true }));
    const reply = await federateSearch(
      { query: "q", projectId: "alpha", localIds: ["a"], env: OPTED_IN },
      { log: () => {} }
    );
    expect(reply?.federated).toBeUndefined();
    expect(reply?.externalSources).toEqual([{ id: "broken", label: "BROKEN", status: "error", hits: 0 }]);
  });

  test("a failing source logs once per interval, not once per call", async () => {
    register(stub("broken", [], { throws: true }));
    const logs: string[] = [];
    let now = 1_000_000;
    const hooks = { log: (m: string) => logs.push(m), now: () => now };
    const input = { query: "q", projectId: "alpha", localIds: [], env: OPTED_IN };
    await federateSearch(input, hooks);
    await federateSearch(input, hooks);
    now += FEDERATION_ERROR_LOG_INTERVAL_MS - 1;
    await federateSearch(input, hooks);
    expect(logs).toHaveLength(1);
    now += 1;
    await federateSearch(input, hooks);
    expect(logs).toHaveLength(2);
  });

  test("each source contributes at most the limit", async () => {
    register(stub("mc", [ext(1), ext(2), ext(3)]));
    const reply = await federateSearch({ query: "q", projectId: "alpha", localIds: [], env: OPTED_IN, limit: 2 });
    expect(reply?.externalSources[0]?.hits).toBe(2);
  });

  test("command retrievers come from STANDUP_FEDERATION_COMMANDS", async () => {
    const line = JSON.stringify({ title: "From env", ref: "env-1", excerpt: "e" });
    const env = {
      ...OPTED_IN,
      STANDUP_FEDERATION_COMMANDS: JSON.stringify([{ id: "cmd", label: "Command", command: ["printf", `${line}\n`] }]),
    };
    const reply = await federateSearch({ query: "q", projectId: "alpha", localIds: [], env });
    expect(reply?.federated?.map(describeEntry)).toEqual(["cmd:env-1"]);
  });
});

describe("parseJsonLines", () => {
  test.each<{ name: string; output: string; refs: string[] }>([
    {
      name: "one hit per line, url or ref",
      output: `{"title":"A","ref":"r1","excerpt":"a"}\n{"title":"B","url":"https://b","excerpt":"b","score":0.4}\n`,
      refs: ["r1", "https://b"],
    },
    {
      name: "malformed and incomplete lines are skipped",
      output: `not json\n{"title":"A","ref":"r1"}\n[1,2]\n{"ref":"no-title"}\n{"title":"no locator"}\n\n`,
      refs: ["r1"],
    },
    { name: "empty output", output: "", refs: [] },
  ])("$name", ({ output, refs }) => {
    expect(parseJsonLines(output).map((h) => h.url ?? h.ref)).toEqual(refs);
  });

  test("a missing excerpt reads as empty and a non-numeric score is dropped", () => {
    expect(parseJsonLines(`{"title":"A","ref":"r","score":"high"}`)).toEqual([{ title: "A", ref: "r", excerpt: "" }]);
  });
});

describe("parseCommandRetrievers", () => {
  test.each<{ name: string; raw: string | undefined; ids: string[]; logged: boolean }>([
    { name: "unset", raw: undefined, ids: [], logged: false },
    { name: "not JSON", raw: "{oops", ids: [], logged: true },
    { name: "not an array", raw: `{"id":"x"}`, ids: [], logged: true },
    {
      name: "invalid entries are skipped",
      raw: JSON.stringify([
        { id: "ok", label: "OK", command: ["true"] },
        { id: "no-command", label: "X", command: [] },
        { id: "bad-timeout", label: "X", command: ["true"], timeoutMs: -1 },
        { label: "no id", command: ["true"] },
      ]),
      ids: ["ok"],
      logged: true,
    },
  ])("$name", ({ raw, ids, logged }) => {
    const logs: string[] = [];
    expect(parseCommandRetrievers(raw, { log: (m) => logs.push(m) }).map((c) => c.id)).toEqual(ids);
    expect(logs.length > 0).toBe(logged);
  });
});

describe("commandRetriever", () => {
  const search = (command: string[], query = "q", timeoutMs?: number) =>
    commandRetriever({ id: "cmd", label: "Command", command, ...(timeoutMs ? { timeoutMs } : {}) }).search(query, {
      limit: 5,
      signal: new AbortController().signal,
    });

  test("passes the query on stdin and parses the JSON lines it prints", async () => {
    const query = JSON.stringify({ title: "Echoed", ref: "stdin-ref", excerpt: "from stdin" });
    expect(await search(["cat"], query)).toEqual([{ title: "Echoed", ref: "stdin-ref", excerpt: "from stdin" }]);
  });

  test("keeps the parseable lines of mixed output", async () => {
    const hits = await search(["printf", `garbage\n{"title":"A","ref":"r1","excerpt":"a"}\n`]);
    expect(hits.map((h) => h.ref)).toEqual(["r1"]);
  });

  test("output with no parseable line throws", async () => {
    await expect(search(["printf", "garbage\n"])).rejects.toThrow("no parseable");
  });

  test("a non-zero exit throws", async () => {
    await expect(search(["false"])).rejects.toThrow("exited with code 1");
  });

  test("a missing executable throws", async () => {
    await expect(search(["/nonexistent/kb-c18-retriever"])).rejects.toThrow();
  });

  test("empty output is no hits", async () => {
    expect(await search(["true"])).toEqual([]);
  });

  test("a slow command is killed at its budget", async () => {
    register(commandRetriever({ id: "sleepy", label: "Sleepy", command: ["sleep", "5"], timeoutMs: 100 }));
    const started = performance.now();
    const reply = await federateSearch(
      { query: "q", projectId: "alpha", localIds: ["a"], env: OPTED_IN },
      { log: () => {} }
    );
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(reply?.externalSources).toEqual([{ id: "sleepy", label: "Sleepy", status: "timeout", hits: 0 }]);
  });
});

describe("POST /api/knowledge/search — federation", () => {
  const QUERY = "federationmarker";

  function setUp() {
    const repo = mkdtempSync(join(tmpdir(), "kb-federation-"));
    const store = createStore(":memory:");
    const prior = process.env.STANDUP_FEDERATION_PROJECTS;
    cleanups.push(() => {
      if (prior === undefined) delete process.env.STANDUP_FEDERATION_PROJECTS;
      else process.env.STANDUP_FEDERATION_PROJECTS = prior;
      store.close();
      rmSync(repo, { recursive: true, force: true });
    });
    upsertProject(store.db, { id: "alpha", name: "Alpha", branch: "main", repos: [repo] });
    upsertProject(store.db, { id: "standup", name: "Standup", branch: "main", repos: [] });
    const knowledge = new KnowledgeStore(store.db);
    for (const projectId of ["alpha", "standup"]) {
      knowledge.upsertDoc({
        id: `${projectId}-doc-id`,
        projectId,
        slug: `${projectId}-doc`,
        title: "Doc",
        body: `${QUERY} body`,
        updatedAt: new Date("2026-08-16T00:00:00Z"),
        filePath: `/x/${projectId}.md`,
        sourceKind: "code",
        originClass: "owner",
        scope: "project",
      });
    }
    return createServer(store, () => {}, null);
  }

  async function search(app: ReturnType<typeof createServer>, project: string) {
    const res = await app.request("/api/knowledge/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [DEFAULT_IDENTITY_HEADER]: "alice",
        [USER_CHANNEL_HEADER]: userChannelToken(activeOwnerSecrets().ownerToken, "alice"),
      },
      body: JSON.stringify({ cwd: "/tmp/kb-federation-none", query: QUERY, project, corpus: "project" }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as {
      results: Array<{ id: string }>;
      federated?: FusedEntry[];
      externalSources?: unknown[];
    };
  }

  test("the reply carries no federation fields when no project opted in", async () => {
    const app = setUp();
    delete process.env.STANDUP_FEDERATION_PROJECTS;
    register(stub("mc", [ext(1)]));
    const reply = await search(app, "alpha");
    expect(reply.results.map((r) => r.id)).toEqual(["alpha-doc-id"]);
    expect(reply.federated).toBeUndefined();
    expect(reply.externalSources).toBeUndefined();
  });

  test("an opted-in project gets external hits fused after its local results", async () => {
    const app = setUp();
    process.env.STANDUP_FEDERATION_PROJECTS = "alpha,standup";
    register(stub("mc", [ext(1)]));
    const reply = await search(app, "alpha");
    expect(reply.results.map((r) => r.id)).toEqual(["alpha-doc-id"]);
    expect(reply.federated?.map(describeEntry)).toEqual(["local:alpha-doc-id", "mc:ref-1"]);
    expect(reply.externalSources).toEqual([{ id: "mc", label: "MC", status: "ok", hits: 1 }]);
  });

  test("a standup search never federates, even when listed", async () => {
    const app = setUp();
    process.env.STANDUP_FEDERATION_PROJECTS = "alpha,standup";
    register(stub("mc", [ext(1)]));
    const reply = await search(app, "standup");
    expect(reply.federated).toBeUndefined();
    expect(reply.externalSources).toBeUndefined();
  });
});
