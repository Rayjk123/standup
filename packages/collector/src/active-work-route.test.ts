import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { DEFAULT_IDENTITY_HEADER } from "@standup/shared";
import {
  createStore,
  upsertProject,
  createSession,
  setSessionCreatedActor,
  touchUser,
} from "@standup/store";
import type { Store } from "@standup/store";
import { createServer } from "./server.js";

/**
 * The ephemeral cross-agent activity route GET/POST /api/active-work. It is a
 * READ-ONLY, pull-first view: what OTHER agents are working on in the caller's
 * project right now. It must (1) scope to the caller's project — a client-supplied
 * project is honored only with standing there, else the caller's correlated
 * session's project — (2) exclude the caller's OWN work (its own session when
 * it has one, else its work by actor), and (3) skip the coordination write-token
 * gate (a read is never gated). Sibling workers sharing the caller's owner are
 * covered in active-work-launched-workers.test.ts.
 * All in-process via app.request — no subprocess.
 */

interface WorkItem {
  sessionId: string;
  title: string;
  status: string;
  actor?: string;
}

function setUp(): { store: Store; app: ReturnType<typeof createServer> } {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p1", name: "p1", branch: "main", repos: [] });
  upsertProject(store.db, { id: "p2", name: "p2", branch: "main", repos: [] });
  for (const [id, project, actor] of [
    ["sessA", "p1", "alice"],
    ["sessCarol", "p1", "carol"],
    ["sessB", "p2", "bob"],
  ] as const) {
    createSession(store.db, { id, projectId: project, title: id, cwd: `/tmp/${id}`, status: "running" });
    setSessionCreatedActor(store.db, id, actor);
  }
  return { store, app: createServer(store, () => {}, null) };
}

function postActiveWork(
  app: ReturnType<typeof createServer>,
  headers: Record<string, string>,
  body: Record<string, unknown>
) {
  return app.request("/api/active-work", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

let savedToken: string | undefined;
let savedBind: string | undefined;
let savedUser: string | undefined;
beforeEach(() => {
  savedToken = process.env.STANDUP_WRITE_TOKEN;
  savedBind = process.env.STANDUP_BIND_HOST;
  savedUser = process.env.USER;
  delete process.env.STANDUP_WRITE_TOKEN;
  delete process.env.STANDUP_BIND_HOST;
});
afterEach(() => {
  if (savedToken === undefined) delete process.env.STANDUP_WRITE_TOKEN;
  else process.env.STANDUP_WRITE_TOKEN = savedToken;
  if (savedBind === undefined) delete process.env.STANDUP_BIND_HOST;
  else process.env.STANDUP_BIND_HOST = savedBind;
  if (savedUser === undefined) delete process.env.USER;
  else process.env.USER = savedUser;
});

describe("POST /api/active-work — scoping and self-exclusion", () => {
  test("returns teammates' work in the caller's project, excluding the caller's own session", async () => {
    const { store, app } = setUp();
    const res = await postActiveWork(
      app,
      { [DEFAULT_IDENTITY_HEADER]: "alice" },
      { session_id: "sessA", cwd: "/tmp/sessA" }
    );
    expect(res.status).toBe(200);
    const { work } = (await res.json()) as { work: WorkItem[] };
    const ids = work.map((w) => w.sessionId);
    // carol's p1 session is visible; alice's own session is excluded.
    expect(ids).toContain("sessCarol");
    expect(ids).not.toContain("sessA");
    // A different project's work never leaks in.
    expect(ids).not.toContain("sessB");
    store.close();
  });

  test("a client-supplied project with no standing falls back to the caller's own project", async () => {
    const { store, app } = setUp();
    // alice has no session in p2, so naming it is ignored — she still sees p1.
    const res = await postActiveWork(
      app,
      { [DEFAULT_IDENTITY_HEADER]: "alice" },
      { session_id: "sessA", cwd: "/tmp/sessA", project: "p2" }
    );
    const { work } = (await res.json()) as { work: WorkItem[] };
    const ids = work.map((w) => w.sessionId);
    expect(ids).toContain("sessCarol");
    expect(ids).not.toContain("sessB");
    store.close();
  });

  test("an uncorrelated caller with no project resolves to an empty list, never every project's work", async () => {
    const { store, app } = setUp();
    const res = await postActiveWork(app, { [DEFAULT_IDENTITY_HEADER]: "nobody" }, {});
    expect(res.status).toBe(200);
    const { work } = (await res.json()) as { work: WorkItem[] };
    expect(work).toEqual([]);
    store.close();
  });
});

describe("POST /api/active-work — a client session_id/cwd is ownership-gated", () => {
  test("a named-but-unowned session_id confers no project scope — cannot read a project the caller has no standing in", async () => {
    const { store, app } = setUp();
    // A second p2 session owned by dave; alice owns nothing in p2. Without dave's
    // row the leak is masked by self-exclusion of the named session itself.
    createSession(store.db, {
      id: "sessB2",
      projectId: "p2",
      title: "sessB2",
      cwd: "/tmp/sessB2",
      status: "running",
    });
    setSessionCreatedActor(store.db, "sessB2", "dave");
    // alice names bob's p2 session (an id she could learn from a /s/<id> share
    // link or an "Open in Standup" line). It must NOT scope her to p2.
    const res = await postActiveWork(
      app,
      { [DEFAULT_IDENTITY_HEADER]: "alice" },
      { session_id: "sessB" }
    );
    expect(res.status).toBe(200);
    const { work } = (await res.json()) as { work: WorkItem[] };
    expect(work).toEqual([]);
    store.close();
  });

  test("a known cwd for another project's session is equally ungating — no scope leak via cwd", async () => {
    const { store, app } = setUp();
    createSession(store.db, {
      id: "sessB2",
      projectId: "p2",
      title: "sessB2",
      cwd: "/tmp/sessB2",
      status: "running",
    });
    setSessionCreatedActor(store.db, "sessB2", "dave");
    // alice passes a cwd whose most-recent active session (bob's sessB) she does
    // not own; resolving it must not grant p2 scope.
    const res = await postActiveWork(
      app,
      { [DEFAULT_IDENTITY_HEADER]: "alice" },
      { cwd: "/tmp/sessB" }
    );
    const { work } = (await res.json()) as { work: WorkItem[] };
    expect(work).toEqual([]);
    store.close();
  });

  test("the legitimate cwd-only path still works when the caller owns the resolved session", async () => {
    const { store, app } = setUp();
    // alice passes only her own session's cwd (no session_id). She owns the
    // session resolved by cwd, so it still scopes her to p1 and shows teammates.
    const res = await postActiveWork(
      app,
      { [DEFAULT_IDENTITY_HEADER]: "alice" },
      { cwd: "/tmp/sessA" }
    );
    const { work } = (await res.json()) as { work: WorkItem[] };
    const ids = work.map((w) => w.sessionId);
    expect(ids).toContain("sessCarol");
    expect(ids).not.toContain("sessA");
    expect(ids).not.toContain("sessB");
    store.close();
  });
});

describe("POST /api/active-work — a trusted caller-identity override scopes per-caller (off-tunnel Slack adapter)", () => {
  // The co-located Slack adapter carries no tunnel header of its own; it presents
  // the collector identity it resolved for the INVOKING Slack user via `actor`.
  // An in-process request has no socket, so it reads as loopback → the override is
  // trusted and the read scopes to THAT caller's standing. Here the host operator
  // ($USER) has standing in BOTH projects — the pre-fix identity every un-headered
  // adapter call resolved to — so these tests prove the snapshot follows the named
  // caller, not the operator.
  function setUpWithOperator(): { store: Store; app: ReturnType<typeof createServer> } {
    process.env.USER = "operator";
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "p1", name: "p1", branch: "main", repos: [] });
    upsertProject(store.db, { id: "p2", name: "p2", branch: "main", repos: [] });
    for (const [id, project, actor] of [
      ["opP1", "p1", "operator"], // operator has standing in p1 …
      ["opP2", "p2", "operator"], // … and in p2 (the cross-project leak surface)
      ["sessCarol", "p1", "carol"],
      ["sessB", "p2", "bob"],
      ["sessDave", "p2", "dave"],
    ] as const) {
      createSession(store.db, { id, projectId: project, title: id, cwd: `/tmp/${id}`, status: "running" });
      setSessionCreatedActor(store.db, id, actor);
    }
    return { store, app: createServer(store, () => {}, null) };
  }

  test("PRE-FIX baseline: an un-headered request with NO override resolves to the host operator and sees the operator's project", async () => {
    const { store, app } = setUpWithOperator();
    // No header, no override → resolves to host $USER (operator), who has standing
    // in p1 — the exact host-scoped path the override now closes for Slack callers.
    const res = await postActiveWork(app, {}, { project: "p1" });
    const { work } = (await res.json()) as { work: WorkItem[] };
    expect(work.map((w) => w.sessionId)).toContain("sessCarol");
    store.close();
  });

  test("the override scopes to the NAMED caller's standing — a caller with no standing in the named project sees nothing", async () => {
    const { store, app } = setUpWithOperator();
    // bob has standing only in p2. Presenting bob and naming p1 must NOT surface p1
    // work, even though the un-overridden host operator DOES have p1 standing.
    const res = await postActiveWork(app, {}, { project: "p1", actor: "bob" });
    const { work } = (await res.json()) as { work: WorkItem[] };
    expect(work).toEqual([]);
    store.close();
  });

  test("the override scopes to the caller's OWN project and excludes the caller's own work", async () => {
    const { store, app } = setUpWithOperator();
    // bob presenting p2 (where he has standing): sees his p2 teammates, not himself.
    const res = await postActiveWork(app, {}, { project: "p2", actor: "bob" });
    const { work } = (await res.json()) as { work: WorkItem[] };
    const ids = work.map((w) => w.sessionId);
    expect(ids).toContain("sessDave");
    expect(ids).toContain("opP2"); // the operator's p2 work is a teammate to bob
    expect(ids).not.toContain("sessB"); // bob's own is excluded
    store.close();
  });

  test("an unmappable caller (a slack:U… actor with no standing) sees nothing, never the operator's cross-project view", async () => {
    const { store, app } = setUpWithOperator();
    const res = await postActiveWork(app, {}, { project: "p1", actor: "slack:Ustranger" });
    const { work } = (await res.json()) as { work: WorkItem[] };
    expect(work).toEqual([]);
    store.close();
  });

  test("a TUNNEL client (header present) can NOT escalate scope via a body actor — the header identity wins", async () => {
    const { store, app } = setUpWithOperator();
    // carol is a real tunnel user with standing only in p1. She POSTs a body actor
    // naming the operator (who has p2 standing) and asks for p2. Because her request
    // carries the tunnel-stamped header, the override is ignored and she scopes to
    // carol — no p2 standing — so she sees nothing, not the operator's p2 work.
    const res = await postActiveWork(
      app,
      { [DEFAULT_IDENTITY_HEADER]: "carol" },
      { project: "p2", actor: "operator" }
    );
    const { work } = (await res.json()) as { work: WorkItem[] };
    expect(work).toEqual([]);
    // Sanity: carol's own p1 scope still works and excludes her own session.
    const res2 = await postActiveWork(
      app,
      { [DEFAULT_IDENTITY_HEADER]: "carol" },
      { project: "p1", actor: "operator" }
    );
    const ids = ((await res2.json()) as { work: WorkItem[] }).work.map((w) => w.sessionId);
    expect(ids).toContain("opP1"); // scoped to carol (has p1 standing), not to the named operator only
    expect(ids).not.toContain("sessCarol"); // carol's own work excluded
    store.close();
  });
});

describe("GET /api/active-work — read-only, no write-token gate", () => {
  test("in multiplayer with no token, the read still succeeds (unlike the gated coordination writes)", async () => {
    const { store, app } = setUp();
    touchUser(store.db, "alice", { viaTunnel: true });
    touchUser(store.db, "carol", { viaTunnel: true });
    const res = await app.request(
      "/api/active-work?session_id=sessA&cwd=/tmp/sessA",
      { headers: { [DEFAULT_IDENTITY_HEADER]: "alice" } }
    );
    expect(res.status).toBe(200);
    const { work } = (await res.json()) as { work: WorkItem[] };
    expect(work.map((w) => w.sessionId)).toContain("sessCarol");
    store.close();
  });
});
