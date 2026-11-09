import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { CATEGORIES, SURFACES, type EvalCase, type Split } from "./types.js";

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * The deterministic dev/holdout split: a case is holdout when the first 8 hex
 * digits of sha256(id), read as an integer, are divisible by 5 (about 20%).
 */
export function splitFor(id: string): Split {
  return parseInt(sha256Hex(id).slice(0, 8), 16) % 5 === 0 ? "holdout" : "dev";
}

/** The case files in a cases directory, sorted by name so load order is stable. */
export function caseFiles(casesDir: string): string[] {
  if (!existsSync(casesDir)) return [];
  return readdirSync(casesDir)
    .filter((f) => f.endsWith(".json"))
    .sort();
}

function validateCase(raw: unknown, file: string): EvalCase {
  const c = raw as Partial<EvalCase>;
  const where = `${file}: case ${JSON.stringify(c?.id ?? "?")}`;
  if (!c || typeof c !== "object") throw new Error(`${file}: a case is not an object`);
  if (typeof c.id !== "string" || !c.id) throw new Error(`${where}: missing id`);
  if (!CATEGORIES.includes(c.category as (typeof CATEGORIES)[number])) {
    throw new Error(`${where}: unknown category ${JSON.stringify(c.category)}`);
  }
  if (!Array.isArray(c.surface) || c.surface.length === 0) {
    throw new Error(`${where}: surface must be a non-empty array`);
  }
  for (const s of c.surface) {
    if (!SURFACES.includes(s)) throw new Error(`${where}: unknown surface ${JSON.stringify(s)}`);
  }
  if (!c.audience || typeof c.audience.projectId !== "string") {
    throw new Error(`${where}: audience.projectId is required`);
  }
  if (typeof c.query !== "string" || !c.query.trim()) throw new Error(`${where}: missing query`);
  const relevant = Array.isArray(c.relevant) ? c.relevant : [];
  for (const r of relevant) {
    if (!r || (typeof r.doc !== "string" && typeof r.code !== "string")) {
      throw new Error(`${where}: a relevant entry needs "doc" or "code"`);
    }
  }
  return {
    id: c.id,
    category: c.category!,
    surface: c.surface,
    audience: { projectId: c.audience.projectId, user: c.audience.user },
    query: c.query,
    relevant: relevant.map((r) => ({ ...r, grade: typeof r.grade === "number" ? r.grade : 1 })),
    forbidden: c.forbidden ?? [],
    expectEmpty: c.expectEmpty ?? false,
    staleOver: c.staleOver ?? [],
    staleDocs: c.staleDocs ?? [],
    silver: c.silver === true,
    source: c.source,
    note: c.note,
  };
}

/** Loads and validates every case in `casesDir`; ids must be unique across files. */
export function loadCases(casesDir: string): EvalCase[] {
  const out: EvalCase[] = [];
  const seen = new Set<string>();
  for (const file of caseFiles(casesDir)) {
    const parsed = JSON.parse(readFileSync(join(casesDir, file), "utf-8")) as unknown;
    if (!Array.isArray(parsed)) throw new Error(`${file}: expected a JSON array of cases`);
    for (const raw of parsed) {
      const c = validateCase(raw, file);
      if (seen.has(c.id)) throw new Error(`${file}: duplicate case id ${c.id}`);
      seen.add(c.id);
      out.push(c);
    }
  }
  return out;
}

export interface CasesLock {
  version: 1;
  files: Record<string, string>;
}

/** sha256 of every case file, keyed by file name. */
export function computeCasesLock(casesDir: string): CasesLock {
  const files: Record<string, string> = {};
  for (const file of caseFiles(casesDir)) {
    files[file] = sha256Hex(readFileSync(join(casesDir, file)));
  }
  return { version: 1, files };
}

/** One hash over the whole lock, recorded in results so a baseline pins its labels. */
export function lockHash(lock: CasesLock): string {
  const lines = Object.keys(lock.files)
    .sort()
    .map((f) => `${f}\t${lock.files[f]}`);
  return sha256Hex(lines.join("\n"));
}

export function readCasesLock(lockPath: string): CasesLock | null {
  if (!existsSync(lockPath)) return null;
  return JSON.parse(readFileSync(lockPath, "utf-8")) as CasesLock;
}

export function writeCasesLock(lockPath: string, lock: CasesLock): void {
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
}

/** Differences between the case files on disk and their lock, as human-readable lines. */
export function diffCasesLock(current: CasesLock, locked: CasesLock | null): string[] {
  if (!locked) return ["cases.lock is missing — run `bun run eval:kb --lock`"];
  const problems: string[] = [];
  const names = new Set([...Object.keys(current.files), ...Object.keys(locked.files)]);
  for (const name of [...names].sort()) {
    const a = current.files[name];
    const b = locked.files[name];
    if (a && !b) problems.push(`case file ${name} is not in cases.lock`);
    else if (!a && b) problems.push(`case file ${name} is in cases.lock but missing on disk`);
    else if (a !== b) problems.push(`case file ${name} changed since cases.lock was written`);
  }
  return problems;
}
