import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { seedKnowledge } from "./kb-seed";

const root = mkdtempSync(join(tmpdir(), "kb-seed-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function write(path: string, body: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
}

describe("seedKnowledge", () => {
  test("copies new docs, keeps existing ones, ignores non-markdown", () => {
    const seed = join(root, "seed");
    const kb = join(root, "kb");
    write(join(seed, "standup", "a.md"), "seed a");
    write(join(seed, "standup", "nested", "b.md"), "seed b");
    write(join(seed, "global", "c.md"), "seed c");
    write(join(seed, "global", "notes.txt"), "not a doc");
    write(join(kb, "standup", "a.md"), "local a");

    expect(seedKnowledge(seed, kb)).toEqual({ copied: 2, skipped: 1 });
    expect(readFileSync(join(kb, "standup", "a.md"), "utf8")).toBe("local a");
    expect(readFileSync(join(kb, "standup", "nested", "b.md"), "utf8")).toBe("seed b");
    expect(readFileSync(join(kb, "global", "c.md"), "utf8")).toBe("seed c");
    expect(existsSync(join(kb, "global", "notes.txt"))).toBe(false);

    expect(seedKnowledge(seed, kb)).toEqual({ copied: 0, skipped: 3 });
  });
});

describe("shipped seed", () => {
  const seedRoot = join(import.meta.dir, "..", "seed");

  test("seed/projects.toml registers every project seed/knowledge files docs under", () => {
    const registry = Bun.TOML.parse(readFileSync(join(seedRoot, "projects.toml"), "utf8")) as {
      project: { id: string }[];
    };
    const ids = new Set(registry.project.map((p) => p.id));
    const unregistered = readdirSync(join(seedRoot, "knowledge")).filter((d) => !ids.has(d));
    expect(unregistered).toEqual([]);
  });

  test("seed docs carry no personal-scope docs or auto-memory notes", () => {
    const offenders: string[] = [];
    const dir = join(seedRoot, "knowledge");
    for (const file of readdirSync(dir, { recursive: true }) as string[]) {
      if (!file.endsWith(".md")) continue;
      const text = readFileSync(join(dir, file), "utf8");
      if (/^scope:\s*user\b/m.test(text) || /^source_kind:\s*native-memory\b/m.test(text)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
