import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { computeCasesLock, diffCasesLock, loadCases, lockHash, sha256Hex, splitFor } from "./cases.js";
import { FIXTURE_HOST_USER } from "./env.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("holdout split", () => {
  test("holdout iff the first 8 hex digits of sha256(id) are divisible by 5", () => {
    for (const id of ["a", "docs-rrf-why", "leak-1", "x-42", "offtopic-sourdough"]) {
      const n = parseInt(sha256Hex(id).slice(0, 8), 16);
      expect(splitFor(id)).toBe(n % 5 === 0 ? "holdout" : "dev");
    }
  });

  test("roughly a fifth of ids land in holdout", () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `case-${i}`);
    const holdout = ids.filter((id) => splitFor(id) === "holdout").length;
    expect(holdout / ids.length).toBeGreaterThan(0.17);
    expect(holdout / ids.length).toBeLessThan(0.23);
  });
});

describe("cases and cases.lock", () => {
  const sample = [
    {
      id: "one",
      category: "docs",
      surface: ["search"],
      audience: { projectId: "p", user: "u" },
      query: "q",
      relevant: [{ doc: "p/a" }],
    },
  ];

  test("loads, defaults grades to 1, and rejects duplicates and bad categories", () => {
    const dir = mkdtempSync(join(tmpdir(), "kbeval-cases-"));
    dirs.push(dir);
    writeFileSync(join(dir, "a.json"), JSON.stringify(sample));
    const cases = loadCases(dir);
    expect(cases).toHaveLength(1);
    expect(cases[0].relevant[0].grade).toBe(1);
    expect(cases[0].silver).toBe(false);
    writeFileSync(join(dir, "b.json"), JSON.stringify(sample));
    expect(() => loadCases(dir)).toThrow("duplicate case id");
    writeFileSync(join(dir, "b.json"), JSON.stringify([{ ...sample[0], id: "two", category: "nope" }]));
    expect(() => loadCases(dir)).toThrow("unknown category");
  });

  test("the lock records each file's sha256 and diffs report changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "kbeval-cases-"));
    dirs.push(dir);
    writeFileSync(join(dir, "a.json"), JSON.stringify(sample));
    const lock = computeCasesLock(dir);
    expect(lock.files["a.json"]).toBe(sha256Hex(JSON.stringify(sample)));
    expect(diffCasesLock(lock, lock)).toEqual([]);
    expect(diffCasesLock(lock, null)[0]).toContain("missing");

    writeFileSync(join(dir, "a.json"), JSON.stringify([{ ...sample[0], query: "changed" }]));
    writeFileSync(join(dir, "c.json"), "[]");
    const changed = computeCasesLock(dir);
    expect(diffCasesLock(changed, lock)).toEqual([
      "case file a.json changed since cases.lock was written",
      "case file c.json is not in cases.lock",
    ]);
    expect(lockHash(changed)).not.toBe(lockHash(lock));
  });
});

describe("the committed fixture cases", () => {
  test("every persona case asks as the host user the fixture tier runs as", () => {
    const committed = loadCases(join(import.meta.dir, "..", "..", "..", "knowledge", "eval", "cases"));
    const persona = committed.filter((c) => c.surface.includes("persona"));
    expect(persona.length).toBeGreaterThan(0);
    expect(persona.filter((c) => c.audience.user !== FIXTURE_HOST_USER).map((c) => c.id)).toEqual([]);
  });
});
