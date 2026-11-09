import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { COLLECTOR_SRC, importSpecifiers, snapshotDir, snapshotSupervisor, supervisorFiles, typeOnlySpecifiers } from "./snapshot.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

describe("supervisor snapshot", () => {
  test("the supervisor loads only collector files and runtime modules", () => {
    expect(supervisorFiles()).toEqual([
      "db-path.ts",
      "restart/authorize.ts",
      "restart/cli.ts",
      "restart/exec.ts",
      "restart/state.ts",
      "restart/supervisor.ts",
      "restart/topology-files.ts",
    ]);
  });

  test("a package named only in type imports is erased, so the snapshot needs no copy of it", () => {
    const source = [
      `import type { T } from "@standup/shared/topology";`,
      `export type { U } from "@pkg/types";`,
      `import type { V } from "@pkg/mixed";`,
      `import { v } from "@pkg/mixed";`,
    ].join("\n");
    expect([...typeOnlySpecifiers(source)].sort()).toEqual(["@pkg/types", "@standup/shared/topology"]);
  });

  test("reads every form of import and re-export", () => {
    const source = [
      `import { a,\n  b } from "./multi.js";`,
      `import type { T } from './types.js';`,
      `import "./side-effect.js";`,
      `export { c } from "../up.js";`,
      `const lazy = await import("./lazy.js");`,
      `import { spawn as spawnChild } from "child_process";`,
    ].join("\n");
    expect(importSpecifiers(source)).toEqual(["./multi.js", "./types.js", "./side-effect.js", "../up.js", "./lazy.js", "child_process"]);
  });

  test("refuses a supervisor that imports a package its copy could not carry", () => {
    const src = tempDir("snapshot-src-");
    mkdirSync(join(src, "restart"));
    writeFileSync(join(src, "restart", "cli.ts"), `import { x } from "./state.js";\n`);
    writeFileSync(join(src, "restart", "state.ts"), `import { createStore } from "@standup/store";\nexport const x = 1;\n`);
    expect(() => supervisorFiles(src)).toThrow("imports @standup/store (from restart/state.ts)");
  });

  test("copies the files byte for byte under bin/<id>, keeping only the newest snapshots", () => {
    const dataDir = tempDir("snapshot-data-");
    const entry = snapshotSupervisor(dataDir, "r1");
    expect(entry).toBe(join(snapshotDir(dataDir, "r1"), "restart", "cli.ts"));
    for (const rel of supervisorFiles()) {
      expect(readFileSync(join(snapshotDir(dataDir, "r1"), rel), "utf8")).toBe(readFileSync(join(COLLECTOR_SRC, rel), "utf8"));
    }
    const ids = ["r2", "r3", "r4"];
    ids.forEach((id, i) => {
      snapshotSupervisor(dataDir, id);
      const at = new Date(Date.now() + (i + 1) * 1_000);
      utimesSync(snapshotDir(dataDir, id), at, at);
    });
    const r5 = snapshotSupervisor(dataDir, "r5");
    expect(existsSync(r5)).toBe(true);
    expect(["r1", "r2", "r3", "r4", "r5"].filter((id) => existsSync(snapshotDir(dataDir, id)))).toEqual(["r3", "r4", "r5"]);
  });
});
