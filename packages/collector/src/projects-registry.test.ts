import { expect, test, describe } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { createStore } from "@standup/store";
import { upsertProject, getProjects } from "@standup/store";
import { GLOBAL_PROJECT_ID } from "@standup/shared";
import { ProjectsRegistry } from "./projects-registry.js";

// A tomlPath that does not exist makes readToml() a no-op, so these exercise
// the reserved-project ensuring path in isolation from any seed file.
const NO_TOML = "/nonexistent/standup-projects.toml";

describe("ProjectsRegistry reserved GLOBAL corpus", () => {
  test("bootstrap auto-ensures a reserved global project", async () => {
    const store = createStore(":memory:");
    const registry = new ProjectsRegistry(store.db, NO_TOML);

    const projects = await registry.bootstrap();
    const global = projects.find((p) => p.id === GLOBAL_PROJECT_ID);

    expect(global).toBeDefined();
    expect(global!.reserved).toBe(true);
    // No repo — it is a knowledge corpus, not a launch target.
    expect(global!.repos).toEqual([]);
    store.close();
  });

  test("global is re-ensured reserved even when a prior row left it launchable", async () => {
    const store = createStore(":memory:");
    // Simulate a stale row: a `global` id that predates the reserved flag (e.g.
    // seeded from TOML), which would otherwise clutter the launch picker.
    upsertProject(store.db, {
      id: GLOBAL_PROJECT_ID,
      name: "global",
      repos: ["/tmp/some-repo"],
      branch: "main",
      reserved: false,
    });

    const registry = new ProjectsRegistry(store.db, NO_TOML);
    await registry.bootstrap();

    const global = getProjects(store.db).find((p) => p.id === GLOBAL_PROJECT_ID);
    expect(global!.reserved).toBe(true);
    store.close();
  });

  test("a fresh DB holding only reserved rows still seeds nothing but keeps global", async () => {
    const store = createStore(":memory:");
    const registry = new ProjectsRegistry(store.db, NO_TOML);
    await registry.bootstrap();

    // Only the two reserved projects (scratch + global) exist — no user projects.
    const ids = getProjects(store.db)
      .filter((p) => p.reserved || p.id === "scratch")
      .map((p) => p.id)
      .sort();
    expect(ids).toContain(GLOBAL_PROJECT_ID);
    expect(ids).toContain("scratch");
    store.close();
  });

  test("global is excluded from the exported TOML (reserved, not portable config)", async () => {
    const store = createStore(":memory:");
    upsertProject(store.db, {
      id: "real-proj",
      name: "Real",
      repos: ["/tmp/real"],
      branch: "main",
    });
    const registry = new ProjectsRegistry(store.db, NO_TOML);
    await registry.bootstrap();

    const toml = registry.exportToToml();
    expect(toml).toContain("real-proj");
    expect(toml).not.toContain(`"${GLOBAL_PROJECT_ID}"`);
    store.close();
  });

  test("reserved round-trips through upsertProject/getProjects", () => {
    const store = createStore(":memory:");
    upsertProject(store.db, {
      id: "p1",
      name: "P1",
      repos: [],
      branch: "main",
      reserved: true,
    });
    upsertProject(store.db, {
      id: "p2",
      name: "P2",
      repos: [],
      branch: "main",
    });
    const byId = new Map(getProjects(store.db).map((p) => [p.id, p]));
    expect(byId.get("p1")!.reserved).toBe(true);
    expect(byId.get("p2")!.reserved).toBe(false);
    store.close();
  });
});

describe("ProjectsRegistry permission bypass in TOML", () => {
  test("only an opt-out is exported, and it survives an export → import round trip", async () => {
    const dir = await mkdtemp(join(tmpdir(), "standup-registry-bypass-"));
    try {
      const source = createStore(":memory:");
      upsertProject(source.db, { id: "opted-out", name: "Out", repos: [], branch: "main", bypassPermissions: false });
      upsertProject(source.db, { id: "default-on", name: "On", repos: [], branch: "main" });
      const toml = new ProjectsRegistry(source.db, NO_TOML).exportToToml();
      source.close();

      const blocks = toml.split("\n\n");
      expect(blocks.find((b) => b.includes('"opted-out"'))).toContain("bypassPermissions = false");
      expect(blocks.find((b) => b.includes('"default-on"'))).not.toContain("bypassPermissions");

      const path = join(dir, "projects.toml");
      await writeFile(path, toml);
      const target = createStore(":memory:");
      await new ProjectsRegistry(target.db, path).bootstrap();
      const byId = new Map(getProjects(target.db).map((p) => [p.id, p]));
      expect(byId.get("opted-out")!.bypassPermissions).toBe(false);
      expect(byId.get("default-on")!.bypassPermissions).toBe(true);
      target.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ProjectsRegistry importFromToml", () => {
  test("overwrites only the fields the TOML sets, keeping stored launch settings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "standup-registry-import-"));
    try {
      const store = createStore(":memory:");
      upsertProject(store.db, {
        id: "svc",
        name: "Old name",
        emoji: "🐻",
        repos: [],
        branch: "trunk",
        setup: "make build",
        launchArgs: "--permission-mode auto",
        worktreeRoot: "~/code/wt",
        provision: 'corp-workspace new --root "$STANDUP_WORKDIR"',
        launchSubdir: "pkgs/svc",
        bypassPermissions: false,
        reviewCommand: "gh pr create --draft --fill",
      });

      const path = join(dir, "projects.toml");
      await writeFile(
        path,
        ['[[project]]', 'id = "svc"', 'name = "New name"', 'repos = ["~/code/svc/pkgs/svc"]'].join("\n")
      );
      await new ProjectsRegistry(store.db, path).importFromToml();

      const svc = getProjects(store.db).find((p) => p.id === "svc")!;
      expect(svc.name).toBe("New name");
      expect(svc.repos).toEqual(["~/code/svc/pkgs/svc"]);
      expect(svc.emoji).toBe("🐻");
      expect(svc.branch).toBe("trunk");
      expect(svc.setup).toBe("make build");
      expect(svc.launchArgs).toBe("--permission-mode auto");
      expect(svc.worktreeRoot).toBe("~/code/wt");
      expect(svc.provision).toBe('corp-workspace new --root "$STANDUP_WORKDIR"');
      expect(svc.launchSubdir).toBe("pkgs/svc");
      expect(svc.bypassPermissions).toBe(false);
      expect(svc.reviewCommand).toBe("gh pr create --draft --fill");
      store.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the code-review adapter is read from codeReviewAdapter, on import and on a first seed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "standup-registry-adapter-key-"));
    try {
      const path = join(dir, "projects.toml");
      await writeFile(
        path,
        [
          "[[project]]", 'id = "pr"', 'name = "PR"', 'branch = "main"', "repos = []", 'codeReviewAdapter = "github-pr"',
          "", "[[project]]", 'id = "none"', 'name = "None"', 'branch = "main"', "repos = []",
        ].join("\n")
      );
      for (const run of ["bootstrap", "importFromToml"] as const) {
        const store = createStore(":memory:");
        await new ProjectsRegistry(store.db, path)[run]();
        const byId = new Map(getProjects(store.db).map((p) => [p.id, p]));
        expect([run, byId.get("pr")?.codeReviewAdapter, byId.get("none")?.codeReviewAdapter ?? null]).toEqual([run, "github-pr", null]);
        expect(new ProjectsRegistry(store.db, NO_TOML).exportToToml()).toContain('codeReviewAdapter = "github-pr"');
        store.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("still creates a project the DB doesn't have yet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "standup-registry-import-new-"));
    try {
      const store = createStore(":memory:");
      const path = join(dir, "projects.toml");
      await writeFile(path, ['[[project]]', 'id = "fresh"', 'name = "Fresh"', 'branch = "main"', 'repos = []'].join("\n"));
      await new ProjectsRegistry(store.db, path).importFromToml();
      expect(getProjects(store.db).find((p) => p.id === "fresh")?.name).toBe("Fresh");
      store.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
