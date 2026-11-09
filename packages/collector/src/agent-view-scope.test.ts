import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { createStore, upsertProject, touchUser } from "@standup/store";
import type { Store } from "@standup/store";
import { DEFAULT_IDENTITY_HEADER, GLOBAL_PROJECT_ID } from "@standup/shared";
import { KnowledgeStore, type KnowledgeDoc } from "@standup/knowledge";
import { USER_CHANNEL_HEADER, userChannelToken } from "@standup/shared/owner-token";
import { createServer } from "./server.js";
import { activeOwnerSecrets } from "./owner-secret.js";

/** `alias`'s signed-in headers: its tunnel identity and its user channel token. */
const signedIn = (alias: string): Record<string, string> => ({
  [DEFAULT_IDENTITY_HEADER]: alias,
  [USER_CHANNEL_HEADER]: userChannelToken(activeOwnerSecrets().ownerToken, alias),
});

/**
 * GET /api/knowledge/agent-view resolves the requesting user SERVER-SIDE, exactly
 * like the search/expert agent paths. The caller's identity is tunnel-authenticated
 * (the identity header is unforgeable — see resolveUserAlias in
 * identity.ts), so previewing YOUR OWN
 * view resolves to your real alias and returns your own docs; naming ANOTHER user
 * in the `user` query param is gated by isTrustedCoordinationWrite, which an
 * authenticated tunnel identity satisfies with no token (the STANDUP_WRITE_TOKEN is
 * only a fallback for a caller with no trusted identity) — a soft team convenience,
 * since the permissive browse paths already expose any doc to a teammate. These
 * drive the real handler in-process via app.request.
 */

const PROJECT = "alpha";

function codeDoc(overrides: Partial<KnowledgeDoc>): KnowledgeDoc {
  return {
    id: crypto.randomUUID(),
    projectId: PROJECT,
    slug: "doc",
    title: "Doc",
    body: "body",
    updatedAt: new Date("2026-08-16T00:00:00Z"),
    filePath: "/x/doc.md",
    sourceKind: "code",
    originClass: "owner",
    ...overrides,
  };
}

const QUERY = "sharedterm authwidget config";

function setUp(): { store: Store; app: ReturnType<typeof createServer> } {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: PROJECT, name: "Alpha", branch: "main", repos: [] });

  const k = new KnowledgeStore(store.db);
  k.upsertDoc(codeDoc({ slug: "global-code", title: "GlobalMarker", body: `${QUERY} shared`, scope: "global" }));
  // Alice's private user-scoped doc, homed in the project.
  k.upsertDoc(
    codeDoc({ slug: "alice-code", title: "AliceOnlyMarker", body: `${QUERY} alice`, scope: "user", ownerUser: "alice" })
  );
  // The user-scoped-in-global doc — the exact gu case the gate must close on
  // every path (scope='user', owner='alice', project_id='global').
  k.upsertDoc(
    codeDoc({
      projectId: GLOBAL_PROJECT_ID,
      slug: "alice-global-secret",
      title: "AliceGlobalMarker",
      body: `${QUERY} aliceglobal`,
      scope: "user",
      ownerUser: "alice",
    })
  );

  return { store, app: createServer(store, () => {}, null) };
}

/** Force the collector into multiplayer so the trusted-operator gate engages
 * exactly as it does on a shared deployment. */
function makeMultiplayer(store: Store): void {
  touchUser(store.db, "alice", { viaTunnel: true });
  touchUser(store.db, "bob", { viaTunnel: true });
}

function agentView(
  app: ReturnType<typeof createServer>,
  qs: string,
  headers: Record<string, string> = {}
) {
  return app.request(`/api/knowledge/agent-view?${qs}`, { headers });
}

// The gate reads STANDUP_WRITE_TOKEN / STANDUP_BIND_HOST live per request, so
// force the single-user loopback default unless a test opts into another shape.
let savedToken: string | undefined;
let savedBind: string | undefined;
beforeEach(() => {
  savedToken = process.env.STANDUP_WRITE_TOKEN;
  savedBind = process.env.STANDUP_BIND_HOST;
  delete process.env.STANDUP_WRITE_TOKEN;
  delete process.env.STANDUP_BIND_HOST;
});
afterEach(() => {
  if (savedToken === undefined) delete process.env.STANDUP_WRITE_TOKEN;
  else process.env.STANDUP_WRITE_TOKEN = savedToken;
  if (savedBind === undefined) delete process.env.STANDUP_BIND_HOST;
  else process.env.STANDUP_BIND_HOST = savedBind;
});

type AgentViewResponse = {
  project: string;
  user: string | null;
  query: string;
  code: Array<{ title: string; slug: string }>;
  product: Array<{ title: string; slug: string }>;
};

describe("GET /api/knowledge/agent-view — identity is server-resolved", () => {
  test("an authenticated teammate may preview another user's view tokenlessly on a multiplayer collector", async () => {
    const { store, app } = setUp();
    makeMultiplayer(store);

    // Naming another user in `user` is a soft team convenience — an authenticated
    // tunnel identity is trusted for it with no token, since the permissive browse
    // paths already expose any doc to a teammate.
    const res = await agentView(app, `project=${PROJECT}&user=alice&query=${encodeURIComponent(QUERY)}`, {
      [DEFAULT_IDENTITY_HEADER]: "bob",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as AgentViewResponse;
    expect(json.user).toBe("alice");
    const titles = json.code.map((d) => d.title);
    expect(titles).toContain("GlobalMarker");
    // Alice's user-scoped docs are personal-layer, which launch injection never
    // carries — not even into Alice's own launches.
    expect(titles).not.toContain("AliceOnlyMarker");
    expect(titles).not.toContain("AliceGlobalMarker");
    store.close();
  });

  test("a self-view (no `user`) returns the caller's OWN set — never another user's docs", async () => {
    const { store, app } = setUp();
    makeMultiplayer(store);

    const res = await agentView(app, `project=${PROJECT}&query=${encodeURIComponent(QUERY)}`, signedIn("bob"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as AgentViewResponse;
    expect(json.user).toBe("bob");
    const titles = json.code.map((d) => d.title);
    expect(titles).toContain("GlobalMarker");
    expect(titles).not.toContain("AliceOnlyMarker");
    expect(titles).not.toContain("AliceGlobalMarker");
    store.close();
  });

  test("previewing your OWN alias resolves to you and carries no personal-layer doc", async () => {
    const { store, app } = setUp();
    makeMultiplayer(store);

    const res = await agentView(app, `project=${PROJECT}&user=alice&query=${encodeURIComponent(QUERY)}`, {
      [DEFAULT_IDENTITY_HEADER]: "alice",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as AgentViewResponse;
    expect(json.user).toBe("alice");
    const titles = json.code.map((d) => d.title);
    expect(titles).toContain("GlobalMarker");
    // Alice's user-scoped docs are personal-layer, which launch injection never
    // carries — not even into Alice's own launches.
    expect(titles).not.toContain("AliceOnlyMarker");
    expect(titles).not.toContain("AliceGlobalMarker");
    store.close();
  });

  // The identity is the tunnel-authenticated header, so presenting Alice's alias
  // IS Alice — a teammate cannot forge a peer's identity. Alice's own self-view
  // resolves to Alice; this is her authenticated view, not a cross-user leak. Per-user scope is a SOFT routing boundary — the permissive
  // class-(b) browse paths already let teammates read each other's docs under the
  // one-trusted-team model. Pinned here so a future change keeps the self-view
  // exact. (The in-process test harness has no socket, so isLoopbackAddress treats
  // it as loopback — the tunnel case, where the header is authenticated.)
  test("an authenticated caller's self-view (no `user` param) resolves to THEIR OWN identity", async () => {
    const { store, app } = setUp();
    makeMultiplayer(store);

    // Alice's signed-in identity, naming no `user` and no write token.
    const res = await agentView(app, `project=${PROJECT}&query=${encodeURIComponent(QUERY)}`, signedIn("alice"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as AgentViewResponse;
    expect(json.user).toBe("alice");
    // The identity header alone reads as nobody's user-scoped view.
    const headerOnly = await agentView(app, `project=${PROJECT}&query=${encodeURIComponent(QUERY)}`, {
      [DEFAULT_IDENTITY_HEADER]: "alice",
    });
    expect(((await headerOnly.json()) as AgentViewResponse).user).toBeNull();
    const titles = json.code.map((d) => d.title);
    // Her self-view resolves to her, and still carries no personal-layer doc.
    expect(titles).toContain("GlobalMarker");
    expect(titles).not.toContain("AliceOnlyMarker");
    expect(titles).not.toContain("AliceGlobalMarker");
    store.close();
  });

  test("naming another user's view also works with a token present (a harmless no-op)", async () => {
    const { store, app } = setUp();
    makeMultiplayer(store);
    process.env.STANDUP_WRITE_TOKEN = "s3cret";

    // The authenticated identity already authorizes previewing another user's view;
    // presenting the matching token changes nothing, and it resolves to Alice.
    const res = await agentView(app, `project=${PROJECT}&user=alice&query=${encodeURIComponent(QUERY)}`, {
      [DEFAULT_IDENTITY_HEADER]: "bob",
      "x-standup-write-token": "s3cret",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as AgentViewResponse;
    expect(json.user).toBe("alice");
    const titles = json.code.map((d) => d.title);
    expect(titles).toContain("GlobalMarker");
    expect(titles).not.toContain("AliceOnlyMarker");
    expect(titles).not.toContain("AliceGlobalMarker");
    store.close();
  });
});
