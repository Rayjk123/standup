import { expect, test, describe, afterAll } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { createStore, upsertProject, getLaunch } from "@standup/store";
import type { HarnessId, Project } from "@standup/shared";
import {
  LaunchRefusedError,
  launchSession,
  personaHarnessRefusal,
  type SpawnArgvSpec,
} from "./launcher.js";
import type { InferMainProjectInput } from "./project-inference.js";

/**
 * Launch-time project inference for a project-less (scratch) launch. A scratch
 * launch runs the matcher BEFORE provisioning: on a confident single match it
 * launches AS that project — provisioning its workspace and starting the agent
 * in its launchSubdir — while an ambiguous / NONE result stays in scratch. An
 * explicit-project launch never consults the matcher. Exercised entirely
 * through the injectable seams (deps.inferProject / deps.buildSpawnArgv /
 * deps.deliverPrompt) so no model is spawned, no workspace tool runs, and no agent
 * starts — the "provision" is a harmless mkdir and the spawn is a no-op.
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

const SCRATCH: Project = { id: "scratch", name: "scratch", branch: "main", repos: [] };
// A real candidate with a provision command that just makes the working dir +
// its launchSubdir (so the launch provisions and starts cleanly without a workspace tool),
// and a launchSubdir the spawn spec must reflect when this project is chosen.
const BILLING: Project = {
  id: "billing",
  name: "Billing Platform",
  branch: "main",
  repos: [],
  provision: 'mkdir -p "$STANDUP_WORKDIR/src/billing-proto"',
  launchSubdir: "src/billing-proto",
};

async function freshStore() {
  const root = await mkdtemp(join(tmpdir(), "standup-infer-root-"));
  dirs.push(root);
  process.env.STANDUP_WORKTREE_ROOT = root;
  const home = await mkdtemp(join(tmpdir(), "standup-infer-home-"));
  dirs.push(home);
  process.env.HOME = home;

  const store = createStore(":memory:");
  upsertProject(store.db, SCRATCH);
  upsertProject(store.db, BILLING);
  // Reserved projects must be excluded from the candidate set.
  upsertProject(store.db, { id: "global", name: "Global", branch: "main", repos: [], reserved: true });
  return { store, root };
}

/**
 * Records the spawn spec, the prompt deliveries, and every inference input, and
 * returns a fixed inference verdict. No agent, no tmux pane driving, no model.
 */
function seam(verdict: string | null) {
  const calls: { harness: HarnessId; spec: SpawnArgvSpec }[] = [];
  const inferInputs: InferMainProjectInput[] = [];
  const deps = {
    buildSpawnArgv: (harness: HarnessId, spec: SpawnArgvSpec): string[] => {
      calls.push({ harness, spec });
      return ["true"];
    },
    deliverPrompt: async () => {},
    inferProject: async (input: InferMainProjectInput): Promise<string | null> => {
      inferInputs.push(input);
      return verdict;
    },
  };
  return { calls, inferInputs, deps };
}

describe("launchSession — launch-time project inference (project-less launch)", () => {
  test("a scratch launch that confidently infers a project provisions THAT project", async () => {
    const { store } = await freshStore();
    const { calls, inferInputs, deps } = seam("billing");

    const result = await launchSession(
      store.db,
      { project: SCRATCH, task: "research the Billing Platform proto" },
      undefined,
      undefined,
      deps
    );
    await result.done;

    // The launch was re-homed to the inferred project and its workspace was
    // provisioned (not a bare scratch dir).
    const row = getLaunch(store.db, result.launch.id);
    expect(row?.projectId).toBe("billing");
    expect(row?.provisioned).toBe(true);
    expect(row?.branch).toBe("(provisioned — no worktree)");
    expect(row?.status).toBe("running");

    // The agent starts in the inferred project's launchSubdir under its
    // provisioned workspace root — the concrete proof provisioning used BILLING's
    // config rather than falling back to scratch. (The slug carries a random
    // suffix, so match the stable structure, not the exact path.)
    expect(calls).toHaveLength(1);
    expect(calls[0].spec.workspaceRoot).toContain("/billing/");
    expect(calls[0].spec.launchCwd).toBe(join(calls[0].spec.workspaceRoot, "src/billing-proto"));
    expect(row?.worktreePath).toContain("/billing/");

    // The matcher was consulted with the real candidates — scratch and the
    // reserved corpus excluded, the real project offered.
    expect(inferInputs).toHaveLength(1);
    const ids = inferInputs[0].candidates.map((c) => c.id);
    expect(ids).toContain("billing");
    expect(ids).not.toContain("scratch");
    expect(ids).not.toContain("global");
    expect(inferInputs[0].task).toBe("research the Billing Platform proto");

    store.close();
  });

  test("an ambiguous / NONE inference falls back to scratch, exactly as today", async () => {
    const { store } = await freshStore();
    const { calls, inferInputs, deps } = seam(null);

    const result = await launchSession(
      store.db,
      { project: SCRATCH, task: "poke around a bit" },
      undefined,
      undefined,
      deps
    );
    await result.done;

    const row = getLaunch(store.db, result.launch.id);
    expect(row?.projectId).toBe("scratch");
    expect(row?.provisioned).toBe(false);
    expect(row?.branch).toBe("(scratch — no repo)");
    expect(row?.status).toBe("running");

    // It ran in a bare scratch dir with no launchSubdir applied.
    expect(calls[0].spec.launchCwd).toContain("/scratch/");
    expect(calls[0].spec.workspaceRoot).toBe(calls[0].spec.launchCwd);

    // The matcher WAS consulted (there were candidates to match); it just declined.
    expect(inferInputs).toHaveLength(1);

    store.close();
  });

  test("an explicit-project launch never consults the matcher", async () => {
    const { store } = await freshStore();
    const { inferInputs, deps } = seam("scratch");

    const result = await launchSession(
      store.db,
      { project: BILLING, task: "implement the proto endpoint" },
      undefined,
      undefined,
      deps
    );
    await result.done;

    const row = getLaunch(store.db, result.launch.id);
    expect(row?.projectId).toBe("billing");
    expect(row?.provisioned).toBe(true);
    // The inferrer is never called for an explicitly-chosen project.
    expect(inferInputs).toHaveLength(0);

    store.close();
  });

  test("a scratch launch with inference off stays in scratch even when a project would match", async () => {
    const { store } = await freshStore();
    const { inferInputs, deps } = seam("billing");

    const result = await launchSession(
      store.db,
      { project: SCRATCH, task: "implement the proto endpoint in billing", allowProjectInference: false },
      undefined,
      undefined,
      deps
    );
    await result.done;

    const row = getLaunch(store.db, result.launch.id);
    expect(row?.projectId).toBe("scratch");
    expect(row?.provisioned).toBe(false);
    expect(inferInputs).toHaveLength(0);

    store.close();
  });

  test("Persona's harness check refuses a scratch launch inferred onto a codex project, before anything spawns", async () => {
    const { store } = await freshStore();
    upsertProject(store.db, { ...BILLING, id: "codexproj", name: "Codex project", harness: "codex" });
    const { calls, deps } = seam("codexproj");
    const checkProject = (target: Project) => {
      const refused = personaHarnessRefusal(target);
      if (refused) throw refused;
    };

    const launch = launchSession(
      store.db,
      { project: SCRATCH, task: "work on the codex project", checkProject },
      undefined,
      undefined,
      deps
    );
    await expect(launch).rejects.toThrow("codexproj's codex harness has no safety floor");
    expect(calls).toHaveLength(0);

    store.close();
  });
});

describe("personaHarnessRefusal", () => {
  test.each([
    ["a claude project", undefined, undefined, false],
    ["a codex project", "codex", undefined, true],
    ["a claude project launched as codex", undefined, "codex", true],
    ["a codex project launched as claude", "codex", "claude", false],
  ] as const)("%s", (_label, projectHarness, launchHarness, refused) => {
    const target: Project = { ...BILLING, harness: projectHarness };
    const result = personaHarnessRefusal(target, launchHarness);
    expect(result instanceof LaunchRefusedError).toBe(refused);
    if (result) expect(result.status).toBe(409);
  });
});
