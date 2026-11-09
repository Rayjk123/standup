import { describe, expect, test } from "bun:test";
import {
  parseActivityCommand,
  collectActiveWork,
  handleActivityCommand,
  activityDelivery,
  ACTIVITY_UNRESOLVED_NOTICE,
  ACTIVITY_DENIED_NOTICE,
  MAX_PROJECTS_FANOUT,
  type ActivityCollector,
} from "./activity.js";
import { parseChannelCommand } from "./channel-features.js";
import { parseLaunchCommand } from "./launch-command.js";
import type { ActiveWorkItem } from "./collector-client.js";

/**
 * The `active` / `what's happening` command surfaces the ephemeral activity layer
 * into Slack. These tests pin (1) the parser — it matches the whole message and
 * nothing that collides with the channel-config or launch grammars — (2) the
 * command-layer AUTHORITY gate — an unauthorized caller is refused, never handed
 * session data — and (3) the scope resolver — bound to a thread's project, else a
 * cross-project fan-out the collector's per-CALLER gating narrows, with every read
 * carrying the invoking caller's identity so it can never fall back to the host
 * operator's scope.
 */

describe("parseActivityCommand", () => {
  test("matches the activity phrasings, with an optional leading mention / punctuation", () => {
    for (const raw of [
      "active",
      "Active",
      "activity",
      "what's happening",
      "whats happening",
      "what is happening",
      "whats active",
      "what's up",
      "whats up",
      "<@U0BOT> active",
      "<@U0BOT|standup> what's happening",
      "  active  ",
      "what's happening?",
      "active.",
    ]) {
      expect(parseActivityCommand(raw)).toBe(true);
    }
  });

  test("does not match unrelated messages or the word buried in a sentence", () => {
    for (const raw of [
      "",
      "   ",
      undefined,
      null,
      "make it active",
      "launch the active branch in web",
      "is anything active in prod",
      "activation",
      "happening",
    ]) {
      expect(parseActivityCommand(raw)).toBe(false);
    }
  });

  test("does not collide with the channel-config commands (each is a channel command, none is activity)", () => {
    for (const raw of [
      "feed here",
      "feed on",
      "feed off",
      "feed stop",
      "feed status",
      "feed ask on",
      "mirror off",
      "asks on",
      "standup off",
      "off",
    ]) {
      expect(parseChannelCommand(raw)).not.toBeNull();
      expect(parseActivityCommand(raw)).toBe(false);
    }
  });

  test("the activity phrasings are NOT parsed as channel commands (so order-independent, no clash)", () => {
    for (const raw of ["active", "activity", "what's happening", "whats happening"]) {
      expect(parseChannelCommand(raw)).toBeNull();
    }
  });

  test("a launch command is not activity, and an activity command is not a launch", () => {
    expect(parseLaunchCommand("launch fix the bug in web")).not.toBeNull();
    expect(parseActivityCommand("launch fix the bug in web")).toBe(false);
    expect(parseLaunchCommand("active")).toBeNull();
  });
});

describe("handleActivityCommand — the command-layer authority gate", () => {
  test("an unauthorized caller is REFUSED — the denial fires and the snapshot is never fetched", async () => {
    let denied = false;
    let shown = false;
    await handleActivityCommand({
      authorized: false,
      deny: async () => {
        denied = true;
      },
      show: async () => {
        shown = true;
      },
    });
    expect(denied).toBe(true);
    expect(shown).toBe(false); // no session data ever reaches an untrusted caller
  });

  test("an authorized caller proceeds to the (caller-scoped) snapshot and is not denied", async () => {
    let denied = false;
    let shown = false;
    await handleActivityCommand({
      authorized: true,
      deny: async () => {
        denied = true;
      },
      show: async () => {
        shown = true;
      },
    });
    expect(shown).toBe(true);
    expect(denied).toBe(false);
  });

  test("the denial notice is a clear, non-empty sentence (never a blank the send-guard drops)", () => {
    expect(ACTIVITY_DENIED_NOTICE.trim().length).toBeGreaterThan(0);
    expect(ACTIVITY_DENIED_NOTICE.toLowerCase()).toContain("authorized");
  });
});

describe("activityDelivery — the snapshot must not leak to channel bystanders", () => {
  test("a shared surface (ephemeral) posts with chat.postEphemeral addressed to the invoking user", () => {
    const d = activityDelivery({ channel: "C-web", threadTs: "root-1", userId: "U-alice", ephemeral: true });
    // Ephemeral => visible ONLY to U-alice; channel bystanders never read it.
    expect(d).toEqual({
      method: "chat.postEphemeral",
      base: { channel: "C-web", user: "U-alice", thread_ts: "root-1" },
    });
  });

  test("a top-level @-mention (no thread) still posts ephemerally, addressed to the user", () => {
    const d = activityDelivery({ channel: "C-general", userId: "U-alice", ephemeral: true });
    expect(d).toEqual({ method: "chat.postEphemeral", base: { channel: "C-general", user: "U-alice" } });
  });

  test("the DM surface posts normally with chat.postMessage (its audience is the invoker alone)", () => {
    const d = activityDelivery({ channel: "D-alice", userId: "U-alice", ephemeral: false });
    // No `user` field — a plain post into the private DM channel.
    expect(d).toEqual({ method: "chat.postMessage", base: { channel: "D-alice" } });
  });

  test("an ephemeral surface with NO addressable user is DROPPED (never downgraded to a public post)", () => {
    // A public fallback here would re-leak the caller-scoped snapshot to bystanders,
    // so the caller must post nothing at all.
    expect(activityDelivery({ channel: "C-web", threadTs: "root-1", ephemeral: true })).toBeNull();
  });
});

function item(over: Partial<ActiveWorkItem> & { sessionId: string }): ActiveWorkItem {
  return {
    title: over.sessionId,
    status: "running",
    lastActivityAt: "2026-09-07 12:00:00",
    ...over,
  };
}

describe("collectActiveWork", () => {
  test("bound: scopes to the thread session's project, forwards the caller identity, labels the project", async () => {
    let captured: { project?: string; sessionId?: string; actor?: string } | undefined;
    const collector: ActivityCollector = {
      async sessionProjectId(id) {
        expect(id).toBe("sess-1");
        return "web";
      },
      async getActiveWork(opts) {
        captured = opts;
        return [item({ sessionId: "other-1", title: "teammate work" })];
      },
      async listProjects() {
        throw new Error("bound scope must not fan out over projects");
      },
    };

    const { items, label } = await collectActiveWork(collector, { sessionId: "sess-1", actor: "alice" });
    // The invoking caller's identity rides EVERY collector read so the collector
    // gates the snapshot as that caller, not the host operator.
    expect(captured).toEqual({ project: "web", sessionId: "sess-1", actor: "alice" });
    expect(label).toBe("web");
    expect(items.map((w) => w.sessionId)).toEqual(["other-1"]);
  });

  test("unbound: fans out over projects (each read carrying the caller), merging most-recent-first", async () => {
    const byProject: Record<string, ActiveWorkItem[]> = {
      web: [item({ sessionId: "w1", lastActivityAt: "2026-09-07 12:00:00" })],
      api: [item({ sessionId: "a1", lastActivityAt: "2026-09-07 13:00:00" })],
    };
    const seenActors = new Set<string | undefined>();
    const collector: ActivityCollector = {
      async sessionProjectId() {
        return undefined;
      },
      async getActiveWork(opts) {
        seenActors.add(opts.actor);
        return byProject[opts.project ?? ""] ?? [];
      },
      async listProjects() {
        return [{ id: "web" }, { id: "api" }];
      },
    };

    const { items, label } = await collectActiveWork(collector, { actor: "alice" });
    expect(label).toBe("your projects");
    // Sorted by lastActivityAt DESC across projects.
    expect(items.map((w) => w.sessionId)).toEqual(["a1", "w1"]);
    // Every fan-out read scopes to the invoking caller.
    expect([...seenActors]).toEqual(["alice"]);
  });

  test("unbound: items are sorted most-recent-first across projects BEFORE any display cap (newest never pre-dropped)", async () => {
    // Two projects whose newest rows interleave. collectActiveWork returns the
    // full merged list ordered by recency — the row-count cap lives in the
    // formatter and runs AFTER this sort, so the freshest activity always leads.
    const byProject: Record<string, ActiveWorkItem[]> = {
      web: [
        item({ sessionId: "w-old", lastActivityAt: "2026-09-07 09:00:00" }),
        item({ sessionId: "w-new", lastActivityAt: "2026-09-07 14:00:00" }),
      ],
      api: [item({ sessionId: "a-mid", lastActivityAt: "2026-09-07 12:00:00" })],
    };
    const collector: ActivityCollector = {
      async sessionProjectId() {
        return undefined;
      },
      async getActiveWork(opts) {
        return byProject[opts.project ?? ""] ?? [];
      },
      async listProjects() {
        return [{ id: "web" }, { id: "api" }];
      },
    };
    const { items, omittedProjectCount } = await collectActiveWork(collector, { actor: "alice" });
    expect(items.map((w) => w.sessionId)).toEqual(["w-new", "a-mid", "w-old"]);
    expect(omittedProjectCount).toBeUndefined(); // every project was covered
  });

  test("unbound: projects past the fan-out ceiling are SURFACED as omittedProjectCount, never silently dropped", async () => {
    const overflow = 3;
    const projects = Array.from({ length: MAX_PROJECTS_FANOUT + overflow }, (_, i) => ({ id: `p${i}` }));
    const read = new Set<string>();
    const collector: ActivityCollector = {
      async sessionProjectId() {
        return undefined;
      },
      async getActiveWork(opts) {
        read.add(opts.project ?? "");
        // Each project has one row; recency climbs with the index so the freshest
        // rows sit in the LAST (over-ceiling) projects — the case a silent slice
        // would hide. The fix instead reports how many projects went unread.
        const n = Number((opts.project ?? "p0").slice(1));
        return [item({ sessionId: opts.project ?? "", lastActivityAt: `2026-09-07 ${String(n % 24).padStart(2, "0")}:00:00` })];
      },
      async listProjects() {
        return projects;
      },
    };
    const { items, omittedProjectCount } = await collectActiveWork(collector, { actor: "alice" });
    // Only the ceiling's worth of projects were read (bounded fan-out) …
    expect(read.size).toBe(MAX_PROJECTS_FANOUT);
    expect(items).toHaveLength(MAX_PROJECTS_FANOUT);
    // … and the surplus is reported so the partial view is never presented as complete.
    expect(omittedProjectCount).toBe(overflow);
  });

  test("no caller identity: returns empty WITHOUT touching the collector (never a host-scoped dump)", async () => {
    const collector: ActivityCollector = {
      async sessionProjectId() {
        throw new Error("must not resolve a session with no caller identity");
      },
      async getActiveWork() {
        throw new Error("must not read active-work with no caller identity");
      },
      async listProjects() {
        throw new Error("must not fan out with no caller identity");
      },
    };
    for (const scope of [{}, { sessionId: "sess-1" }, { actor: "  " }]) {
      const { items } = await collectActiveWork(collector, scope);
      expect(items).toEqual([]);
    }
  });

  test("visibility gating: a project the caller cannot see contributes nothing (collector returns [])", async () => {
    // The collector gates server-side per-caller: it returns rows only for a
    // project THIS caller has standing in, and [] for one they don't. The adapter
    // renders only what came back — it never widens the scope — so a session in an
    // unseen project never appears.
    const collector: ActivityCollector = {
      async sessionProjectId() {
        return undefined;
      },
      async getActiveWork(opts) {
        if (opts.project === "visible") return [item({ sessionId: "seen", title: "mine" })];
        return []; // "secret" — caller has no standing, gated to empty
      },
      async listProjects() {
        return [{ id: "visible" }, { id: "secret" }];
      },
    };

    const { items } = await collectActiveWork(collector, { actor: "alice" });
    const ids = items.map((w) => w.sessionId);
    expect(ids).toContain("seen");
    expect(ids).not.toContain("hidden-secret-session");
    expect(ids).toHaveLength(1);
  });

  test("bound: an unresolvable thread session is reported unresolved — NEVER widened to cross-project", async () => {
    const collector: ActivityCollector = {
      async sessionProjectId() {
        return undefined; // session/project can't be resolved (unknown/ended, or a blip)
      },
      async getActiveWork() {
        throw new Error("an unresolvable bound session must not fall back to a project read");
      },
      async listProjects() {
        throw new Error("an unresolvable bound session must not fan out over projects");
      },
    };
    const snapshot = await collectActiveWork(collector, { sessionId: "gone", actor: "alice" });
    expect(snapshot.unresolved).toBe(true);
    expect(snapshot.items).toEqual([]);
    expect(ACTIVITY_UNRESOLVED_NOTICE).toContain("Couldn't resolve");
  });

  test("tolerates a failed fetch (null) without throwing — renders an empty snapshot", async () => {
    const collector: ActivityCollector = {
      async sessionProjectId() {
        return "web";
      },
      async getActiveWork() {
        return null; // collector unreachable
      },
      async listProjects() {
        return null;
      },
    };
    const { items, unresolved } = await collectActiveWork(collector, { sessionId: "s", actor: "alice" });
    expect(items).toEqual([]);
    expect(unresolved).toBeUndefined();
  });
});
