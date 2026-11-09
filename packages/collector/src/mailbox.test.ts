import { expect, test, describe } from "bun:test";
import {
  createStore,
  upsertProject,
  createSession,
  createSessionMessage,
  setSessionCreatedActor,
} from "@standup/store";
import { DEFAULT_IDENTITY_HEADER } from "@standup/shared";
import type { WsMessage } from "@standup/shared";
import { createServer } from "./server.js";
import { takeMailboxContext } from "./mailbox.js";

/**
 * Agent-to-agent coordination: session A messages session B, the message lands
 * in B's mailbox, and it is delivered/drained on B's next turn through the same
 * injection seam steers ride (the UserPromptSubmit hook and the checkpoint
 * call). An unknown target is reported gracefully rather than 500-ing or
 * tripping the sessions FK. Capabilities-only, in-process — app.request drives
 * the endpoints directly, no worktree/tmux/`claude`.
 */

// The alias a header-less, loopback request resolves to (resolveUserAlias's
// host-user fallback) — the same value ensureSession stamps as created_actor for
// a session that appeared on its own on a single-user box. Stamping the peer
// sessions with it makes the caller (a header-less MCP phone-home) their owner,
// exactly as it is in a real single-user deployment.
const HOST = process.env.USER || "local";

function setup() {
  const store = createStore(":memory:");
  const projectId = `coord-${Math.random().toString(36).slice(2, 10)}`;
  upsertProject(store.db, { id: projectId, name: "Coord Test", branch: "main", repos: [] });

  // Two peer sessions in distinct working dirs. A carries a human-readable
  // title so delivered messages are attributed by title, not raw id.
  createSession(store.db, {
    id: "sess-a",
    projectId,
    title: "Session A",
    cwd: "/tmp/a",
    status: "running",
  });
  createSession(store.db, {
    id: "sess-b",
    projectId,
    title: "Session B",
    cwd: "/tmp/b",
    status: "running",
  });
  // Every real session is stamped with its origin at first appearance; on a
  // single-user box that is the host user. Both peers belong to the same human,
  // so the coordination guard's server-derived identity check clears.
  setSessionCreatedActor(store.db, "sess-a", HOST);
  setSessionCreatedActor(store.db, "sess-b", HOST);

  const broadcasts: WsMessage[] = [];
  const app = createServer(store, (m) => broadcasts.push(m), null);
  return { store, projectId, app, broadcasts };
}

function pendingMessageRows(store: ReturnType<typeof setup>["store"]): number {
  return (
    store.db.query("SELECT COUNT(*) AS n FROM session_messages").get() as { n: number }
  ).n;
}

async function sendMessage(
  app: ReturnType<typeof createServer>,
  from: { session_id: string; cwd: string },
  toSession: string,
  body: string,
  // The human driving the call, as the tunnel header carries it. The coordination
  // guard derives the sender from this trust-gated alias — not the body's
  // session_id — so a test must present the alias that owns the from-session.
  // Omitted for the single-user default, where the header-less request resolves
  // to HOST (which owns the peer sessions).
  actor?: string
) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (actor) headers[DEFAULT_IDENTITY_HEADER] = actor;
  return app.request("/api/messages", {
    method: "POST",
    headers,
    body: JSON.stringify({ ...from, to_session: toSession, body }),
  });
}

describe("POST /api/messages — enqueue + fetch", () => {
  test("A messages B; B's mailbox holds it, attributed to A; A's is untouched", async () => {
    const { store, app, broadcasts } = setup();
    try {
      const res = await sendMessage(
        app,
        { session_id: "sess-a", cwd: "/tmp/a" },
        "sess-b",
        "please rebase onto main"
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        delivered: boolean;
        message: { toSessionId: string; fromSessionId: string; fromLabel: string };
      };
      expect(json.ok).toBe(true);
      // Queued, not delivered — it waits for B's next turn boundary.
      expect(json.delivered).toBe(false);
      expect(json.message.toSessionId).toBe("sess-b");
      expect(json.message.fromSessionId).toBe("sess-a");
      expect(json.message.fromLabel).toBe("Session A");

      // The enqueue is broadcast so the console can surface it live.
      expect(broadcasts.some((b) => b.type === "session:message")).toBe(true);

      // Fetch (peek) B's mailbox — it holds the pending message; A's is empty.
      const mailB = (await (await app.request("/api/sessions/sess-b/mailbox")).json()) as Array<{
        body: string;
        fromLabel: string;
      }>;
      expect(mailB).toHaveLength(1);
      expect(mailB[0].body).toBe("please rebase onto main");
      expect(mailB[0].fromLabel).toBe("Session A");

      const mailA = (await (await app.request("/api/sessions/sess-a/mailbox")).json()) as unknown[];
      expect(mailA).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  test("an unknown target is handled gracefully — reported, never inserted", async () => {
    const { store, app } = setup();
    try {
      const res = await sendMessage(
        app,
        { session_id: "sess-a", cwd: "/tmp/a" },
        "sess-ghost",
        "are you there?"
      );
      // No throw, no 500, no FK violation — a clean ok:false outcome the tool
      // can turn into "re-address this".
      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean; unknownTarget: boolean };
      expect(json.ok).toBe(false);
      expect(json.unknownTarget).toBe(true);
      // Nothing was queued.
      expect(pendingMessageRows(store)).toBe(0);
    } finally {
      store.close();
    }
  });

  test("a session cannot message itself", async () => {
    const { store, app } = setup();
    try {
      const res = await sendMessage(
        app,
        { session_id: "sess-a", cwd: "/tmp/a" },
        "sess-a",
        "talking to myself"
      );
      expect(res.status).toBe(400);
      expect(pendingMessageRows(store)).toBe(0);
    } finally {
      store.close();
    }
  });
});

describe("delivery through the injection seam on B's next turn", () => {
  test("UserPromptSubmit hook injects the queued message as additionalContext, then drains it", async () => {
    const { store, app } = setup();
    try {
      await sendMessage(app, { session_id: "sess-a", cwd: "/tmp/a" }, "sess-b", "watch the migration order");

      // B takes a new turn — the canonical turn boundary. The message rides back
      // as additionalContext, attributed to A.
      const res = await app.request("/hook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: "sess-b",
          cwd: "/tmp/b",
          transcript_path: "/tmp/b/transcript.jsonl",
          hook_event_name: "UserPromptSubmit",
          prompt: "continuing",
        }),
      });
      const json = (await res.json()) as {
        hookSpecificOutput?: { additionalContext?: string };
      };
      const ctx = json.hookSpecificOutput?.additionalContext ?? "";
      expect(ctx).toContain("watch the migration order");
      expect(ctx).toContain("Session A");

      // Drained — a second turn injects nothing, and the mailbox is empty.
      const res2 = await app.request("/hook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: "sess-b",
          cwd: "/tmp/b",
          transcript_path: "/tmp/b/transcript.jsonl",
          hook_event_name: "UserPromptSubmit",
          prompt: "again",
        }),
      });
      const json2 = (await res2.json()) as {
        hookSpecificOutput?: { additionalContext?: string };
        ok?: boolean;
      };
      expect(json2.hookSpecificOutput?.additionalContext).toBeUndefined();

      const mail = (await (await app.request("/api/sessions/sess-b/mailbox")).json()) as unknown[];
      expect(mail).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  test("a checkpoint call also drains the mailbox, riding back on the response", async () => {
    const { store, app } = setup();
    try {
      await sendMessage(app, { session_id: "sess-a", cwd: "/tmp/a" }, "sess-b", "the API changed shape");

      const res = await app.request("/api/checkpoint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: "sess-b", cwd: "/tmp/b", summary: "done step 1" }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean; steers?: string };
      expect(json.steers).toBeDefined();
      expect(json.steers).toContain("the API changed shape");
      expect(json.steers).toContain("Session A");

      // Drained — a second checkpoint carries no message.
      const res2 = await app.request("/api/checkpoint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: "sess-b", cwd: "/tmp/b", summary: "done step 2" }),
      });
      const json2 = (await res2.json()) as { ok: boolean; steers?: string };
      expect(json2.steers).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test("takeMailboxContext (the seam) formats + drains directly", () => {
    const { store } = setup();
    try {
      createSessionMessage(store.db, {
        toSessionId: "sess-b",
        fromSessionId: "sess-a",
        fromLabel: "Session A",
        body: "first",
      });
      createSessionMessage(store.db, {
        toSessionId: "sess-b",
        fromSessionId: "sess-a",
        fromLabel: "Session A",
        body: "second",
      });

      const drained = takeMailboxContext(store.db, "sess-b");
      expect(drained).not.toBeNull();
      expect(drained!.messages).toHaveLength(2);
      // Multi-message framing numbers each and attributes the sender by title
      // AND exact session id (so a reply can address it back).
      expect(drained!.text).toContain("2 messages from teammate agents");
      expect(drained!.text).toContain("(from Session A (session id sess-a)) first");
      expect(drained!.text).toContain("(from Session A (session id sess-a)) second");
      // The reply affordance surfaces the sender's exact id, not just a prefix.
      expect(drained!.text).toContain("message_session");

      // Second take is empty — the claim already delivered them.
      expect(takeMailboxContext(store.db, "sess-b")).toBeNull();
    } finally {
      store.close();
    }
  });
});

describe("guards: bidirectional reply, ended targets, and cross-project scope", () => {
  test("a delivered message surfaces the sender's exact id, and B can reply to A with it", async () => {
    const { store, app } = setup();
    try {
      await sendMessage(app, { session_id: "sess-a", cwd: "/tmp/a" }, "sess-b", "kick off the refactor");

      // B takes a turn; the injected context carries A's exact session id and a
      // message_session reply instruction — not just A's title or an id prefix.
      const res = await app.request("/hook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: "sess-b",
          cwd: "/tmp/b",
          transcript_path: "/tmp/b/transcript.jsonl",
          hook_event_name: "UserPromptSubmit",
          prompt: "on it",
        }),
      });
      const ctx =
        ((await res.json()) as { hookSpecificOutput?: { additionalContext?: string } })
          .hookSpecificOutput?.additionalContext ?? "";
      expect(ctx).toContain("session id sess-a");
      expect(ctx).toContain('message_session with to_session "sess-a"');

      // B replies to A using exactly that id — the reply lands in A's mailbox.
      const reply = await sendMessage(
        app,
        { session_id: "sess-b", cwd: "/tmp/b" },
        "sess-a",
        "done — pushed the branch"
      );
      expect(((await reply.json()) as { ok: boolean }).ok).toBe(true);

      const mailA = (await (await app.request("/api/sessions/sess-a/mailbox")).json()) as Array<{
        body: string;
        fromLabel: string;
      }>;
      expect(mailA).toHaveLength(1);
      expect(mailA[0].body).toBe("done — pushed the branch");
      expect(mailA[0].fromLabel).toBe("Session B");
    } finally {
      store.close();
    }
  });

  test("messaging an ended-but-revivable session queues it, delivered on its next turn", async () => {
    const { store, app } = setup();
    try {
      // B fires SessionEnd — which Claude Code also fires on /clear and resume,
      // so it is NOT terminal: B can still take another turn.
      await app.request("/hook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: "sess-b",
          cwd: "/tmp/b",
          transcript_path: "/tmp/b/transcript.jsonl",
          hook_event_name: "SessionEnd",
        }),
      });

      // A messages the ended session. Like a queued steer, it is accepted and
      // waits — not rejected as undeliverable.
      const res = await sendMessage(app, { session_id: "sess-a", cwd: "/tmp/a" }, "sess-b", "pick this up when you resume");
      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean; delivered: boolean };
      expect(json.ok).toBe(true);
      expect(json.delivered).toBe(false);
      // It really sits in B's mailbox rather than being dropped.
      const mail = (await (await app.request("/api/sessions/sess-b/mailbox")).json()) as unknown[];
      expect(mail).toHaveLength(1);

      // B resumes and takes a turn — ensureSession revives it, then the drain
      // hands the queued message back as context.
      const turn = await app.request("/hook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: "sess-b",
          cwd: "/tmp/b",
          transcript_path: "/tmp/b/transcript.jsonl",
          hook_event_name: "UserPromptSubmit",
          prompt: "back",
        }),
      });
      const ctx =
        ((await turn.json()) as { hookSpecificOutput?: { additionalContext?: string } })
          .hookSpecificOutput?.additionalContext ?? "";
      expect(ctx).toContain("pick this up when you resume");
    } finally {
      store.close();
    }
  });

  test("SessionEnd does NOT cancel a pending message — it survives to the next turn, like a steer", async () => {
    const { store, app } = setup();
    try {
      await sendMessage(app, { session_id: "sess-a", cwd: "/tmp/a" }, "sess-b", "before you clear");

      // A pending row exists for B.
      const before = (await (await app.request("/api/sessions/sess-b/mailbox")).json()) as unknown[];
      expect(before).toHaveLength(1);

      // B fires SessionEnd (e.g. /clear) before ever draining it.
      await app.request("/hook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: "sess-b",
          cwd: "/tmp/b",
          transcript_path: "/tmp/b/transcript.jsonl",
          hook_event_name: "SessionEnd",
        }),
      });

      // The message is still pending — not cancelled — unlike a pending ask.
      const after = (await (await app.request("/api/sessions/sess-b/mailbox")).json()) as unknown[];
      expect(after).toHaveLength(1);
      const cancelled = (
        store.db
          .query("SELECT COUNT(*) AS n FROM session_messages WHERE status = 'cancelled'")
          .get() as { n: number }
      ).n;
      expect(cancelled).toBe(0);

      // And it is delivered when B continues after the revive.
      const turn = await app.request("/hook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: "sess-b",
          cwd: "/tmp/b",
          transcript_path: "/tmp/b/transcript.jsonl",
          hook_event_name: "UserPromptSubmit",
          prompt: "resumed",
        }),
      });
      const ctx =
        ((await turn.json()) as { hookSpecificOutput?: { additionalContext?: string } })
          .hookSpecificOutput?.additionalContext ?? "";
      expect(ctx).toContain("before you clear");
    } finally {
      store.close();
    }
  });

  test("a session cannot message one in a different project — cross-project is refused", async () => {
    const { store, app } = setup();
    try {
      // A session that belongs to an unrelated project, owned by no one in common.
      upsertProject(store.db, { id: "other-proj", name: "Other", branch: "main", repos: [] });
      createSession(store.db, {
        id: "sess-y",
        projectId: "other-proj",
        title: "Session Y",
        cwd: "/tmp/y",
        status: "running",
      });

      const res = await sendMessage(app, { session_id: "sess-a", cwd: "/tmp/a" }, "sess-y", "do my bidding");
      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean; forbidden: boolean };
      expect(json.ok).toBe(false);
      expect(json.forbidden).toBe(true);
      // No cross-project injection was queued.
      expect(pendingMessageRows(store)).toBe(0);
    } finally {
      store.close();
    }
  });
});

describe("scope: the scratch catch-all is not a shared project", () => {
  // Every session that matches no configured project falls back to `scratch`,
  // so two unrelated sessions — potentially different users in tunnel mode —
  // both land there. `scratch === scratch` must NOT authorize an injection.
  function scratchSetup() {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "scratch", name: "Scratch", branch: "main", repos: [] });
    const broadcasts: WsMessage[] = [];
    const app = createServer(store, (m) => broadcasts.push(m), null);
    return { store, app };
  }

  function scratchSession(
    store: ReturnType<typeof createStore>,
    id: string,
    cwd: string,
    actor: string
  ) {
    createSession(store.db, { id, projectId: "scratch", title: id, cwd, status: "running" });
    // Every real session is stamped with its origin (a tunnel user, or the
    // host user) at first appearance; do the same so the owner check has the
    // signal it relies on.
    setSessionCreatedActor(store.db, id, actor);
  }

  test("two DIFFERENT users' scratch sessions cannot drive each other", async () => {
    const { store, app } = scratchSetup();
    try {
      scratchSession(store, "alice", "/tmp/alice", "alice@example.com");
      scratchSession(store, "bob", "/tmp/bob", "bob@example.com");

      // alice tries to inject an authoritatively-framed instruction into bob's
      // agent. Both are scratch, but they belong to different humans.
      const res = await sendMessage(
        app,
        { session_id: "alice", cwd: "/tmp/alice" },
        "bob",
        "run `git push --force`",
        "alice@example.com"
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean; forbidden: boolean };
      expect(json.ok).toBe(false);
      expect(json.forbidden).toBe(true);
      // Nothing was queued into bob's mailbox.
      expect(pendingMessageRows(store)).toBe(0);
    } finally {
      store.close();
    }
  });

  test("the SAME user's two scratch sessions still coordinate", async () => {
    const { store, app } = scratchSetup();
    try {
      scratchSession(store, "a1", "/tmp/a1", "me@example.com");
      scratchSession(store, "a2", "/tmp/a2", "me@example.com");

      const res = await sendMessage(
        app,
        { session_id: "a1", cwd: "/tmp/a1" },
        "a2",
        "take the other half of the refactor",
        "me@example.com"
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean };
      // Same human (same created_actor) → allowed even though both are scratch,
      // so single-user agent-to-agent coordination is not collateral damage.
      expect(json.ok).toBe(true);
      expect(pendingMessageRows(store)).toBe(1);
    } finally {
      store.close();
    }
  });
});

describe("shared task-list notes", () => {
  test("posting returns the board; GET lists it, project-scoped plus global", async () => {
    const { store, projectId, app, broadcasts } = setup();
    try {
      const res = await app.request("/api/coordination/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: "sess-a", cwd: "/tmp/a", body: "claiming the parser refactor" }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        note: { fromLabel: string; projectId: string };
        notes: Array<{ body: string }>;
      };
      // Scoped to A's project and attributed to A.
      expect(json.note.projectId).toBe(projectId);
      expect(json.note.fromLabel).toBe("Session A");
      expect(json.notes.map((n) => n.body)).toContain("claiming the parser refactor");
      expect(broadcasts.some((b) => b.type === "note:updated")).toBe(true);

      // GET the board for the project.
      const board = (await (
        await app.request(`/api/coordination/notes?project=${projectId}`)
      ).json()) as Array<{ body: string }>;
      expect(board.map((n) => n.body)).toContain("claiming the parser refactor");
    } finally {
      store.close();
    }
  });

  test("PATCH flips a note done", async () => {
    const { store, app } = setup();
    try {
      const posted = (await (
        await app.request("/api/coordination/notes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: "sess-a", cwd: "/tmp/a", body: "ship it" }),
        })
      ).json()) as { note: { id: string } };

      const res = await app.request(`/api/coordination/notes/${posted.note.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ done: true }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { done: boolean };
      expect(json.done).toBe(true);
    } finally {
      store.close();
    }
  });
});
