/**
 * Fixture data for persona-job-tags.ts: one owner's console thread, four
 * Persona jobs, and messages tagged with them by every tag source, plus
 * `fixtureResponse`, the pure router that answers the console's /api calls
 * from them.
 */

import type {
  Ask,
  Checkpoint,
  HelloOkPayload,
  PersonaApproval,
  PersonaJob,
  PersonaJobTagSource,
  PersonaMessage,
  PersonaMessagesResponse,
  PersonaState,
  PersonaThreadSummary,
  PlanApproval,
  WsMessage,
} from "../../packages/shared/src/index";

export const OWNER = "alice";
export const THREAD_ID = "7d0c2f4e-2b1a-4d3e-9f6a-1c8e5b7a9d01";

export const JOB = {
  knowledgeAudit: "3f9a1c2e-8b4d-4e7a-9c1f-2a6b8d0e4f11",
  policySeverity: "a7c4e2b9-1d3f-4a8e-b6c2-9e0f1a3d5b22",
  jobTags: "c2e8f1a4-6b9d-4c3e-8a7f-0d1b2e4c6a33",
  slackRetries: "e5b7d9f1-3a2c-4e6b-9d8a-7c0f1e2b4d44",
} as const;

const at = (min: number) => new Date(Date.UTC(2026, 9, 8, 14, 0) + min * 60_000).toISOString();

export const jobs: PersonaJob[] = [
  {
    id: JOB.knowledgeAudit,
    owner: OWNER,
    threadId: THREAD_ID,
    title: "Knowledge audit",
    goal: "Audit the knowledge base for stale and contradicting docs and fix them.",
    acceptance: "Every flagged doc is fixed or retired; the fact-check passes on the updated set.",
    status: "active",
    launchIds: ["launch-ka-1"],
    sessionIds: [],
    note: "Fix-up worker started on 14 flagged docs.",
    createdAt: at(0),
    updatedAt: at(42),
  },
  {
    id: JOB.policySeverity,
    owner: OWNER,
    threadId: THREAD_ID,
    title: "Policy severity",
    goal: "Add severity levels to Persona hold rules and show them on approval cards.",
    acceptance: "Live checks pass; the review is opened with an issue attached.",
    status: "waiting_user",
    launchIds: ["launch-ps-1"],
    sessionIds: [],
    note: "Live checks passed; waiting on the issue id for the review.",
    createdAt: at(3),
    updatedAt: at(44),
  },
  {
    id: JOB.jobTags,
    owner: OWNER,
    threadId: THREAD_ID,
    title: "Persona job tags",
    goal: "Tag thread messages with the jobs they are about and let the owner filter by job.",
    status: "active",
    launchIds: ["launch-jt-1"],
    sessionIds: [],
    createdAt: at(10),
    updatedAt: at(46),
  },
  {
    id: JOB.slackRetries,
    owner: OWNER,
    threadId: THREAD_ID,
    title: "Slack DM retries",
    goal: "Retry failed Slack DM deliveries with backoff.",
    status: "done",
    launchIds: ["launch-sr-1"],
    sessionIds: [],
    outcome: "Shipped; retries back off up to 5 minutes.",
    createdAt: at(-120),
    updatedAt: at(-30),
  },
];

export const MSG = {
  slackDone: "m-01-slack-done",
  ownerUntagged: "m-02-owner-untagged",
  ownerExplicit: "m-03-owner-explicit",
  personaAck: "m-04-persona-ack",
  ownerInferred: "m-05-owner-inferred",
  personaMulti: "m-06-persona-multi",
  ownerUntagged2: "m-07-owner-untagged",
  personaUntagged: "m-08-persona-untagged",
} as const;

type Tag = [jobId: string, source: PersonaJobTagSource];

let seq = 0;
function message(id: string, role: PersonaMessage["role"], text: string, min: number, tags: Tag[] = []): PersonaMessage {
  seq += 1;
  return {
    id,
    threadId: THREAD_ID,
    seq,
    role,
    text,
    ...(role === "user" ? { actor: OWNER } : {}),
    ...(tags.length > 0
      ? { jobTags: tags.map(([jobId, source]) => ({ jobId, source })), jobIds: tags.map(([jobId]) => jobId) }
      : {}),
    createdAt: at(min),
  };
}

export const messages: PersonaMessage[] = [
  message(MSG.slackDone, "persona", "Slack DM retries is done — failed DMs now back off up to 5 minutes before giving up.", -30, [
    [JOB.slackRetries, "declared"],
  ]),
  message(MSG.ownerUntagged, "user", "Morning. Anything on fire overnight?", 30),
  message(
    MSG.ownerExplicit,
    "user",
    "For the job tags work: make sure inferred tags can be removed with one tap on mobile.",
    35,
    [[JOB.jobTags, "explicit"]]
  ),
  message(MSG.personaAck, "persona", "Noted — I passed that to the job tags worker as an acceptance check.", 36, [
    [JOB.jobTags, "declared"],
  ]),
  message(MSG.ownerInferred, "user", "how's the knowledge audit and policy severity going?", 40, [
    [JOB.knowledgeAudit, "inferred"],
    [JOB.policySeverity, "inferred"],
  ]),
  message(
    MSG.personaMulti,
    "persona",
    [
      "**Knowledge audit:** fix-up worker started on the 14 flagged docs; the first 5 are through fact-check.",
      "",
      "**Policy severity:** live checks passed — severities show on approval cards.",
      "",
      "**This needs you:** which issue id should the review use?",
    ].join("\n"),
    42,
    [
      [JOB.knowledgeAudit, "inferred"],
      [JOB.policySeverity, "declared"],
      [JOB.jobTags, "inferred"],
    ]
  ),
  message(MSG.ownerUntagged2, "user", "Thanks. Also remind me tomorrow at 9 to read the digest.", 45),
  message(MSG.personaUntagged, "persona", "Done — I'll ping you tomorrow at 9:00.", 46),
];

export const state: PersonaState & { hostAlias: string; isHost: boolean; canWrite: boolean } = {
  owner: OWNER,
  runState: "idle",
  threadId: THREAD_ID,
  epoch: 3,
  pendingInbox: 0,
  lastTurnAt: at(46),
  activeLaunches: 2,
  maxActiveLaunches: 6,
  hostAlias: OWNER,
  isHost: true,
  canWrite: true,
};

const last = messages[messages.length - 1];
export const threads: PersonaThreadSummary[] = [
  {
    id: THREAD_ID,
    owner: OWNER,
    channel: "console",
    audience: "private",
    createdAt: at(-600),
    updatedAt: at(46),
    messageCount: messages.length,
    lastMessage: { seq: last.seq, role: last.role, text: last.text, createdAt: last.createdAt },
  },
];

/** The socket's hello-ok frame: identifies the viewer as the owner, with an empty snapshot. */
export const helloOk: WsMessage<HelloOkPayload> = {
  type: "hello-ok",
  timestamp: at(46),
  payload: {
    protocolVersion: 1,
    serverSeq: 0,
    user: OWNER,
    snapshot: {
      projects: [],
      sessions: [],
      checkpoints: [],
      asks: [],
      launches: [],
      tickets: [],
      actors: [],
    },
  },
};

/** The thread's messages, narrowed to those tagged with any of `jobIdParam` (comma-separated) when given. */
export function messagesFor(jobIdParam: string | null): PersonaMessage[] {
  const ids = new Set(
    (jobIdParam ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
  );
  if (ids.size === 0) return messages;
  return messages.filter((m) => (m.jobIds ?? []).some((id) => ids.has(id)));
}

/** A fixture answer to one /api request. `unmocked` marks the empty default given to a path no fixture covers. */
export interface FixtureResponse {
  status: number;
  json: unknown;
  unmocked?: true;
}

/** Collections the console reads as bare JSON arrays; the fixture owner has none of them. */
const EMPTY_ARRAY_PATHS = new Set([
  "/api/projects",
  "/api/sessions",
  "/api/launches",
  "/api/tickets",
  "/api/task-runs",
  "/api/review-findings",
]);

const approvals: PersonaApproval[] = [];
const checkpoints: Checkpoint[] = [];
const asks: Ask[] = [];
const plans: PlanApproval[] = [];

/** The body of a GET the fixtures cover, else undefined. */
function getBody(path: string, query: URLSearchParams): unknown {
  switch (path) {
    case "/api/persona/state":
      return state;
    case "/api/persona/jobs":
      return { jobs } satisfies { jobs: PersonaJob[] };
    case "/api/persona/approvals": {
      const status = query.get("status");
      return {
        approvals: status ? approvals.filter((a) => a.status === status) : approvals,
      } satisfies { approvals: PersonaApproval[] };
    }
    case "/api/persona/threads":
      return { threads } satisfies { threads: PersonaThreadSummary[] };
    case "/api/persona/messages": {
      const threadId = query.get("threadId") ?? THREAD_ID;
      return {
        threadId,
        messages: threadId === THREAD_ID ? messagesFor(query.get("jobId")) : [],
      } satisfies PersonaMessagesResponse;
    }
    case "/api/checkpoints":
      return checkpoints;
    case "/api/asks/pending":
      return asks;
    case "/api/plans/pending":
      return { plans } satisfies { plans: PlanApproval[] };
  }
  return EMPTY_ARRAY_PATHS.has(path) ? [] : undefined;
}

const TAG_ROUTE = /^\/api\/persona\/messages\/([^/]+)\/jobs\/([^/]+)$/;

/** `DELETE /api/persona/messages/:id/jobs/:jobId`: the message with that tag dropped. */
function removeTag(messageId: string, jobId: string): FixtureResponse {
  const message = messages.find((m) => m.id === messageId);
  if (!message) return { status: 404, json: { error: `no message ${messageId}` } };
  const jobTags = (message.jobTags ?? []).filter((t) => t.jobId !== jobId);
  const { jobTags: _tags, jobIds: _ids, ...rest } = message;
  const updated: PersonaMessage = jobTags.length > 0 ? { ...rest, jobTags, jobIds: jobTags.map((t) => t.jobId) } : rest;
  return { status: 200, json: { message: updated } satisfies { message: PersonaMessage } };
}

/**
 * The fixture answer to `method url`, or undefined when `url` is not an /api
 * path. A relative `url` is read against a placeholder origin. An /api path no
 * fixture covers gets `200 {}` marked `unmocked`, so the caller can log it.
 */
export function fixtureResponse(method: string, url: string | URL): FixtureResponse | undefined {
  const parsed = typeof url === "string" ? new URL(url, "http://fixtures.invalid") : url;
  const path = parsed.pathname;
  if (!path.startsWith("/api/")) return undefined;
  const verb = method.toUpperCase();
  if (verb === "GET") {
    const body = getBody(path, parsed.searchParams);
    if (body !== undefined) return { status: 200, json: body };
  } else if (verb === "DELETE") {
    const tag = TAG_ROUTE.exec(path);
    if (tag) return removeTag(decodeURIComponent(tag[1]), decodeURIComponent(tag[2]));
  }
  return { status: 200, json: {}, unmocked: true };
}
