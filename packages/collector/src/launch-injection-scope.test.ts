import { expect, test, describe, afterAll } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { createStore, getLaunch, setSetting, upsertProject } from "@standup/store";
import type { HarnessId, Project } from "@standup/shared";
import { KnowledgeStore, type KnowledgeDoc } from "@standup/knowledge";
import { launchSession, type SpawnArgvSpec } from "./launcher.js";

/**
 * The knowledge injected into a launch's opening prompt is scoped by the
 * SERVER-RESOLVED `retrievalUser`, NOT the caller-attributable `requester`. The
 * launch routes derive `retrievalUser` from scopingUser(c) (ignoring the body
 * `actor` override), so a caller cannot name a victim in `actor` to inject that
 * victim's user-scoped docs into a session it observes. These drive the real
 * retrieval + injection path through the buildSpawnArgv seam (which captures the
 * opening prompt) so no agent is spawned.
 */

const dirs: string[] = [];
const savedEnv = {
  HOME: process.env.HOME,
  WORKTREE_ROOT: process.env.STANDUP_WORKTREE_ROOT,
};
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  if (savedEnv.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = savedEnv.HOME;
  if (savedEnv.WORKTREE_ROOT === undefined) delete process.env.STANDUP_WORKTREE_ROOT;
  else process.env.STANDUP_WORKTREE_ROOT = savedEnv.WORKTREE_ROOT;
});

function codeDoc(overrides: Partial<KnowledgeDoc>): KnowledgeDoc {
  return {
    id: randomUUID(),
    projectId: "proj",
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

const TASK = "authwidget handler retry logic";

/**
 * A scratch project (no repos → a fresh mkdir launch, no git) with two docs
 * the TASK query matches: a global doc everyone gets, and
 * Alice's private user-scoped doc. HOME + worktree root are sandboxed so the
 * claude folder-trust pre-accept can't touch the real home.
 */
async function seededStore(): Promise<{ store: ReturnType<typeof createStore>; project: Project }> {
  const root = await mkdtemp(join(tmpdir(), "standup-inj-root-"));
  dirs.push(root);
  process.env.STANDUP_WORKTREE_ROOT = root;
  const home = await mkdtemp(join(tmpdir(), "standup-inj-home-"));
  dirs.push(home);
  process.env.HOME = home;

  const store = createStore(":memory:");
  const id = `inj-${randomUUID().slice(0, 8)}`;
  upsertProject(store.db, { id, name: "Inj", branch: "main", repos: [] });

  const k = new KnowledgeStore(store.db);
  k.upsertDoc(
    codeDoc({
      projectId: id,
      slug: "shared-code",
      title: "SharedMarker",
      body: `${TASK} shared`,
      scope: "global",
    })
  );
  k.upsertDoc(
    codeDoc({
      projectId: id,
      slug: "alice-code",
      title: "AliceOnlyMarker",
      body: `${TASK} private to alice`,
      scope: "user",
      ownerUser: "alice",
    })
  );

  return { store, project: { id, name: "Inj", branch: "main", repos: [] } as Project };
}

/** A seam stub that captures the opening prompt and returns a no-op command. */
function recordingSeam() {
  const calls: { harness: HarnessId; spec: SpawnArgvSpec }[] = [];
  const buildSpawnArgv = (harness: HarnessId, spec: SpawnArgvSpec): string[] => {
    calls.push({ harness, spec });
    return ["true"];
  };
  return { calls, deps: { buildSpawnArgv } };
}

describe("launch injection is scoped by retrievalUser, not requester", () => {
  test("a forged requester naming the victim does NOT inject the victim's user-scoped docs", async () => {
    const { store, project } = await seededStore();
    const { calls, deps } = recordingSeam();

    // As if a caller forged actor=alice: requester is 'alice', but the route
    // resolves retrievalUser server-side to a different (or absent) identity.
    const result = await launchSession(
      store.db,
      { project, task: TASK, requester: "alice", retrievalUser: undefined },
      undefined,
      undefined,
      deps
    );
    await result.done;

    expect(calls).toHaveLength(1);
    const prompt = calls[0].spec.prompt;
    // The global doc is injected (everyone gets it)...
    expect(prompt).toContain("SharedMarker");
    // ...but Alice's private doc is NOT, even though requester === 'alice':
    // the audience follows retrievalUser (undefined → global ∪ project only).
    expect(prompt).not.toContain("AliceOnlyMarker");
    store.close();
  });

  test("a user-scoped doc is never injected, not even when retrievalUser is its owner", async () => {
    const { store, project } = await seededStore();
    const { calls, deps } = recordingSeam();

    const result = await launchSession(
      store.db,
      { project, task: TASK, requester: "bob", retrievalUser: "alice" },
      undefined,
      undefined,
      deps
    );
    await result.done;

    const prompt = calls[0].spec.prompt;
    // retrievalUser is Alice, the doc's owner, yet her user-scoped doc is
    // personal-layer and stays out of the launch block; it reaches her through
    // Persona and Claude Code's own CLAUDE.md load instead.
    expect(prompt).not.toContain("AliceOnlyMarker");
    expect(prompt).toContain("SharedMarker");
    store.close();
  });

  test("a different retrievalUser never sees another user's user-scoped docs", async () => {
    const { store, project } = await seededStore();
    const { calls, deps } = recordingSeam();

    const result = await launchSession(
      store.db,
      { project, task: TASK, requester: "bob", retrievalUser: "bob" },
      undefined,
      undefined,
      deps
    );
    await result.done;

    const prompt = calls[0].spec.prompt;
    expect(prompt).toContain("SharedMarker");
    expect(prompt).not.toContain("AliceOnlyMarker");
    store.close();
  });
});

describe("a stored knowledge_first_enabled=0 is ignored", () => {
  test("the launch still carries the steering and the injected docs", async () => {
    const { store, project } = await seededStore();
    setSetting(store.db, "knowledge_first_enabled", "0");
    const { calls, deps } = recordingSeam();

    const result = await launchSession(store.db, { project, task: TASK }, undefined, undefined, deps);
    await result.done;

    const prompt = calls[0].spec.prompt;
    expect(prompt).toContain("search_knowledge");
    expect(prompt).toContain("SharedMarker");
    expect(getLaunch(store.db, result.launch.id)?.log ?? "").toContain("[info] injected ");
    store.close();
  });
});
