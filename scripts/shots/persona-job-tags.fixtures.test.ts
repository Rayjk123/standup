import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type {
  Ask,
  Checkpoint,
  PersonaApproval,
  PersonaJob,
  PersonaMessage,
  PersonaMessagesResponse,
  PersonaState,
  PersonaThreadSummary,
  PlanApproval,
} from "../../packages/shared/src/index";
import { messageJobPath, messagesPath, taggedMessagesPath } from "../../packages/web/src/lib/persona";
import { JOB, MSG, THREAD_ID, fixtureResponse, helloOk, jobs, messages } from "./persona-job-tags.fixtures";
import { pickPort, reachedServer, serveBuild } from "./persona-job-tags";

/** GETs the console makes on /persona: App boot (hello-ok and the REST fallback), the Persona snapshot, the filter backfill and the job drawer. */
const LOAD_PATHS = [
  // App: after hello-ok, and the REST fallback when the socket is late.
  "/api/task-runs",
  "/api/review-findings",
  "/api/projects",
  "/api/sessions?all=1",
  "/api/checkpoints",
  "/api/asks/pending",
  "/api/launches",
  "/api/tickets",
  // fetchPersonaSnapshot, before and after the thread is known.
  "/api/persona/state",
  `/api/persona${messagesPath(null)}`,
  `/api/persona${messagesPath(THREAD_ID)}`,
  "/api/persona/jobs",
  "/api/persona/approvals?status=pending",
  "/api/persona/approvals",
  "/api/persona/threads",
  // The ?tags= filter's backfill.
  `/api/persona${taggedMessagesPath(THREAD_ID, [JOB.jobTags])}`,
  // PersonaJobDrawer's activity poll.
  "/api/checkpoints?limit=200",
  "/api/plans/pending",
];

function get<T>(path: string): T {
  const res = fixtureResponse("GET", path);
  expect(res).toBeDefined();
  expect(res!.status).toBe(200);
  return res!.json as T;
}

const idsOf = (rows: PersonaMessage[]) => rows.map((m) => m.id);

describe("fixtureResponse", () => {
  test.each(LOAD_PATHS)("answers %s from a fixture", (path) => {
    const res = fixtureResponse("GET", path);
    expect(res).toBeDefined();
    expect(res!.unmocked).toBeUndefined();
    expect(res!.status).toBe(200);
  });

  test("reads absolute URLs and URL objects the same as relative paths", () => {
    expect(fixtureResponse("GET", "http://127.0.0.1:5300/api/persona/jobs")).toEqual(fixtureResponse("GET", "/api/persona/jobs"));
    expect(fixtureResponse("get", new URL("http://127.0.0.1:5300/api/persona/jobs"))).toEqual(
      fixtureResponse("GET", "/api/persona/jobs")
    );
  });

  test("leaves non-/api paths alone", () => {
    expect(fixtureResponse("GET", "/persona")).toBeUndefined();
    expect(fixtureResponse("GET", "/assets/index.js")).toBeUndefined();
  });

  test("state names the owner as host and writer", () => {
    const state = get<PersonaState & { isHost?: boolean; canWrite?: boolean }>("/api/persona/state");
    expect(state.threadId).toBe(THREAD_ID);
    expect(state.runState).toBe("idle");
    expect(state.isHost).toBe(true);
    expect(state.canWrite).toBe(true);
  });

  test("collections have the shapes the console reads", () => {
    expect(get<{ jobs: PersonaJob[] }>("/api/persona/jobs").jobs).toHaveLength(4);
    expect(get<{ approvals: PersonaApproval[] }>("/api/persona/approvals?status=pending").approvals).toEqual([]);
    expect(get<{ threads: PersonaThreadSummary[] }>("/api/persona/threads").threads.map((t) => t.id)).toEqual([THREAD_ID]);
    expect(get<{ plans: PlanApproval[] }>("/api/plans/pending").plans).toEqual([]);
    expect(get<Checkpoint[]>("/api/checkpoints?limit=200")).toEqual([]);
    expect(get<Ask[]>("/api/asks/pending")).toEqual([]);
    for (const path of ["/api/projects", "/api/sessions?all=1", "/api/task-runs", "/api/review-findings", "/api/tickets"]) {
      expect(Array.isArray(get<unknown[]>(path))).toBe(true);
    }
  });

  test("messages without a filter are the whole thread", () => {
    const res = get<PersonaMessagesResponse>(`/api/persona${messagesPath(THREAD_ID)}`);
    expect(res.threadId).toBe(THREAD_ID);
    expect(res.messages).toHaveLength(8);
    expect(get<PersonaMessagesResponse>("/api/persona/messages").messages).toHaveLength(8);
  });

  test("the jobId filter returns only messages tagged with the job", () => {
    const path = `/api/persona${taggedMessagesPath(THREAD_ID, [JOB.jobTags])}`;
    const res = get<PersonaMessagesResponse>(path);
    expect(idsOf(res.messages)).toEqual([MSG.ownerExplicit, MSG.personaAck, MSG.personaMulti]);
  });

  test("the jobId filter splits comma-encoded (%2C) ids", () => {
    const path = `/api/persona${taggedMessagesPath(THREAD_ID, [JOB.slackRetries, JOB.policySeverity])}`;
    expect(path).toContain("%2C");
    const res = get<PersonaMessagesResponse>(path);
    expect(idsOf(res.messages)).toEqual([MSG.slackDone, MSG.ownerInferred, MSG.personaMulti]);
  });

  test("another thread has no messages", () => {
    const res = get<PersonaMessagesResponse>(`/api/persona${messagesPath("other-thread")}`);
    expect(res.threadId).toBe("other-thread");
    expect(res.messages).toEqual([]);
  });

  test("DELETE of a tag returns the message without it", () => {
    const res = fixtureResponse("DELETE", `/api/persona${messageJobPath(MSG.ownerInferred, JOB.knowledgeAudit)}`);
    expect(res?.status).toBe(200);
    const { message } = res!.json as { message: PersonaMessage };
    expect(message.id).toBe(MSG.ownerInferred);
    expect(message.jobTags).toEqual([{ jobId: JOB.policySeverity, source: "inferred" }]);
    expect(message.jobIds).toEqual([JOB.policySeverity]);
    // The fixture thread itself is unchanged.
    expect(messages.find((m) => m.id === MSG.ownerInferred)?.jobIds).toHaveLength(2);
  });

  test("DELETE of a message's last tag drops jobTags and jobIds", () => {
    const res = fixtureResponse("DELETE", `/api/persona${messageJobPath(MSG.ownerExplicit, JOB.jobTags)}`);
    const { message } = res!.json as { message: PersonaMessage };
    expect(message.jobTags).toBeUndefined();
    expect(message.jobIds).toBeUndefined();
  });

  test("DELETE of an unknown message is a 404", () => {
    expect(fixtureResponse("DELETE", `/api/persona${messageJobPath("nope", JOB.jobTags)}`)?.status).toBe(404);
  });

  test("an unknown /api path gets an empty default marked unmocked", () => {
    expect(fixtureResponse("GET", "/api/persona/hold-report")).toEqual({ status: 200, json: {}, unmocked: true });
    expect(fixtureResponse("POST", "/api/persona/messages")).toEqual({ status: 200, json: {}, unmocked: true });
  });
});

describe("serveBuild", () => {
  test("serves files, falls back to index.html, and refuses /api and traversal", async () => {
    const dist = mkdtempSync(join(tmpdir(), "pjt-serve-test-"));
    mkdirSync(join(dist, "assets"));
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>app</title>");
    writeFileSync(join(dist, "assets", "app.js"), "export {};");
    const server = serveBuild(dist, pickPort());
    const base = `http://127.0.0.1:${server.port}`;
    try {
      expect(await (await fetch(`${base}/assets/app.js`)).text()).toBe("export {};");
      const route = await fetch(`${base}/persona?tags=${JOB.jobTags}`);
      expect(route.status).toBe(200);
      expect(await route.text()).toContain("<title>app</title>");
      expect(await (await fetch(`${base}/..%2f..%2fetc%2fpasswd`)).text()).toContain("<title>app</title>");
      const api = await fetch(`${base}/api/persona/state`);
      expect(api.status).toBe(404);
      expect(reachedServer).toContain("GET /api/persona/state");
    } finally {
      server.stop(true);
      rmSync(dist, { recursive: true, force: true });
    }
  });

  test("refuses a port outside the shots range", () => {
    expect(() => serveBuild(tmpdir(), 7777)).toThrow("refusing port 7777");
  });
});

describe("fixtures", () => {
  test("every tag names a fixture job and jobIds mirrors jobTags", () => {
    const known = new Set(jobs.map((j) => j.id));
    for (const m of messages) {
      expect(m.threadId).toBe(THREAD_ID);
      for (const t of m.jobTags ?? []) expect(known.has(t.jobId)).toBe(true);
      expect(m.jobIds ?? []).toEqual((m.jobTags ?? []).map((t) => t.jobId));
    }
  });

  test("seqs are 1-based and increasing", () => {
    expect(messages.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test("hello-ok names the owner", () => {
    expect(helloOk.type).toBe("hello-ok");
    expect(helloOk.payload.user).toBe("alice");
  });

  test("fixture text avoids release vocabulary", () => {
    const text = JSON.stringify({ jobs, messages });
    expect(text).not.toMatch(/\b(merge|merged|PR|pull request|code review|push|pushed|land|landed|deploy|deployed|publish|published)\b/i);
  });
});
