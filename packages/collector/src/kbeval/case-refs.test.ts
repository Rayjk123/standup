import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { loadCases } from "./cases.js";

const EVAL_DIR = join(import.meta.dir, "..", "..", "..", "knowledge", "eval");
const CORPUS_DIR = join(EVAL_DIR, "corpus");

interface ProjectEntry {
  id: string;
}

interface RealCase {
  id: string;
  project: string;
  relevant?: { doc?: string }[];
  stale?: { fresh?: string[]; stale?: string[] };
}

interface TaskQuery {
  id: string;
  helpful?: string[];
}

interface Task {
  id: string;
  project: string;
  queries: TaskQuery[];
}

const projectIds = new Set(
  (JSON.parse(readFileSync(join(CORPUS_DIR, "projects.json"), "utf-8")) as ProjectEntry[]).map((p) => p.id),
);

/** A `project/slug` ref resolves when the corpus has `corpus/<project>/<slug>.md`. */
function resolves(ref: string): boolean {
  const slash = ref.indexOf("/");
  if (slash <= 0) return false;
  return existsSync(join(CORPUS_DIR, ref.slice(0, slash), `${ref.slice(slash + 1)}.md`));
}

describe("fixture case references", () => {
  test("every case audience names a fixture project", () => {
    const cases = loadCases(join(EVAL_DIR, "cases"));
    expect(cases.filter((c) => !projectIds.has(c.audience.projectId)).map((c) => c.id)).toEqual([]);
  });

  test("every relevant, staleOver and staleDocs doc exists in the corpus", () => {
    const missing: string[] = [];
    for (const c of loadCases(join(EVAL_DIR, "cases"))) {
      const refs = [
        ...c.relevant.flatMap((r) => (r.doc ? [r.doc] : [])),
        ...(c.staleOver ?? []).flat(),
        ...(c.staleDocs ?? []),
      ];
      for (const ref of refs) if (!resolves(ref)) missing.push(`${c.id}: ${ref}`);
    }
    expect(missing).toEqual([]);
  });

  test("every retrieval case and task resolves its project and docs", () => {
    const real = JSON.parse(readFileSync(join(EVAL_DIR, "retrieval", "cases-real.json"), "utf-8")) as RealCase[];
    const tasks = JSON.parse(readFileSync(join(EVAL_DIR, "retrieval", "tasks.json"), "utf-8")) as Task[];
    const missing: string[] = [];
    for (const c of real) {
      if (!projectIds.has(c.project)) missing.push(`${c.id}: project ${c.project}`);
      const refs = [
        ...(c.relevant ?? []).flatMap((r) => (r.doc ? [r.doc] : [])),
        ...(c.stale?.fresh ?? []),
        ...(c.stale?.stale ?? []),
      ];
      for (const ref of refs) if (!resolves(ref)) missing.push(`${c.id}: ${ref}`);
    }
    for (const t of tasks) {
      if (!projectIds.has(t.project)) missing.push(`${t.id}: project ${t.project}`);
      for (const q of t.queries) {
        for (const ref of q.helpful ?? []) if (!resolves(ref)) missing.push(`${t.id}/${q.id}: ${ref}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
