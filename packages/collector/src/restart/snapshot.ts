import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "fs";
import { isBuiltin } from "module";
import { dirname, join, relative, resolve } from "path";
import { restartDir } from "./state.js";

/*
 * A restart runs a copy of the supervisor's code, not the install's files: the
 * supervisor outlives the collector, and the install is exactly what changes
 * under it — a rollback checks out another commit, a merge lands meanwhile. A
 * supervisor that imported from the install mid-restart could run half of one
 * commit and half of another. The copy is made from the running collector's
 * own source tree at hand-off, so the supervisor is the code that wrote the
 * record.
 */

/** The collector's source tree (packages/collector/src): this file's parent directory. */
export const COLLECTOR_SRC = resolve(import.meta.dir, "..");

/** The supervisor's entry point, relative to COLLECTOR_SRC. */
export const SUPERVISOR_ENTRY = join("restart", "cli.ts");

/** How many snapshots are kept; older ones are removed when a new one is made. */
const KEEP_SNAPSHOTS = 3;

/** Where restart `id`'s copy of the supervisor goes. */
export function snapshotDir(dataDir: string, id: string): string {
  return join(restartDir(dataDir), "bin", id);
}

const SPECIFIER =
  /(?:\bimport|\bexport)\s[^'"`;]*?\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;

/** The module specifiers a source file imports or re-exports from. */
export function importSpecifiers(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(SPECIFIER)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec) out.push(spec);
  }
  return out;
}

const TYPE_ONLY = /\b(?:import|export)\s+type\s[^'"`;]*?\bfrom\s*["']([^"']+)["']/g;

/**
 * The specifiers a source file names only in `import type` / `export type`
 * declarations, which the runtime erases: the supervisor never loads them.
 */
export function typeOnlySpecifiers(source: string): Set<string> {
  const asType = [...source.matchAll(TYPE_ONLY)].map((m) => m[1]!);
  const all = importSpecifiers(source);
  const count = (list: string[], spec: string) => list.filter((s) => s === spec).length;
  return new Set(asType.filter((spec) => count(all, spec) === count(asType, spec)));
}

function isRuntimeModule(spec: string): boolean {
  return spec === "bun" || spec.startsWith("bun:") || isBuiltin(spec);
}

/** The file a relative specifier names: `./x.js` is `./x.ts` in this TypeScript tree. */
function resolveRelative(fromFile: string, spec: string): string {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [base.replace(/\.js$/, ".ts"), base, `${base}.ts`];
  const found = candidates.find((c) => existsSync(c) && statSync(c).isFile());
  if (!found) throw new Error(`${relative(COLLECTOR_SRC, fromFile)} imports ${spec}, which does not resolve to a file`);
  return found;
}

/**
 * Every file the supervisor's entry point loads, transitively, relative to
 * `srcRoot`. Throws when one imports a package (anything not relative and
 * not a runtime module) or a file outside `srcRoot`: the copy could not carry
 * it, and would run it from the install after all. A package named only in
 * type imports is fine: those are erased before anything runs.
 */
export function supervisorFiles(srcRoot = COLLECTOR_SRC, entry = SUPERVISOR_ENTRY): string[] {
  const root = resolve(srcRoot);
  const seen = new Set<string>();
  const queue = [resolve(root, entry)];
  while (queue.length > 0) {
    const file = queue.shift()!;
    const rel = relative(root, file);
    if (rel.startsWith("..")) throw new Error(`the restart supervisor loads ${file}, outside ${root}`);
    if (seen.has(rel)) continue;
    seen.add(rel);
    const source = readFileSync(file, "utf8");
    const typeOnly = typeOnlySpecifiers(source);
    for (const spec of importSpecifiers(source)) {
      if (spec.startsWith(".")) queue.push(resolveRelative(file, spec));
      else if (!isRuntimeModule(spec) && !typeOnly.has(spec)) {
        throw new Error(`the restart supervisor imports ${spec} (from ${rel}), which its snapshot can't carry`);
      }
    }
  }
  return [...seen].sort();
}

/**
 * Copies the supervisor's code (restart/cli.ts and everything it imports from
 * the collector) into `<dataDir>/restart/bin/<id>/`, keeping its layout
 * under the collector's src, and returns the copy's entry point. Older
 * snapshots beyond the newest few are removed.
 */
export function snapshotSupervisor(dataDir: string, id: string, srcRoot = COLLECTOR_SRC): string {
  const files = supervisorFiles(srcRoot);
  const dest = snapshotDir(dataDir, id);
  rmSync(dest, { recursive: true, force: true });
  for (const rel of files) {
    const target = join(dest, rel);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    copyFileSync(join(srcRoot, rel), target);
    chmodSync(target, 0o600);
  }
  pruneSnapshots(dataDir, id);
  return join(dest, SUPERVISOR_ENTRY);
}

/** Removes all but the KEEP_SNAPSHOTS newest snapshots, never `keep`'s. */
function pruneSnapshots(dataDir: string, keep: string): void {
  const bin = join(restartDir(dataDir), "bin");
  let entries: Array<{ name: string; mtime: number }>;
  try {
    entries = readdirSync(bin, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, mtime: statSync(join(bin, e.name)).mtimeMs }));
  } catch {
    return;
  }
  const stale = entries
    .filter((e) => e.name !== keep)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(KEEP_SNAPSHOTS - 1);
  for (const e of stale) rmSync(join(bin, e.name), { recursive: true, force: true });
}
