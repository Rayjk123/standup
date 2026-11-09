import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { computeCasesLock, writeCasesLock } from "./cases.js";
import {
  codeSearchHostViolations,
  compareResults,
  parseException,
  type CodeSearchHost,
  type Comparable,
  type GateException,
} from "./compare.js";
import { harvestCandidates } from "./harvest.js";
import { formatMarkdown } from "./report.js";
import { probeCodeSearchHost, runEval, tierPaths, type EvalResults, type Tier } from "./runner.js";
import { SURFACES, type Surface } from "./types.js";

export const USAGE = `usage: bun run eval:kb [flags]

  --label <name>          results file name (results/<name>.json; default "run")
  --gate                  compare against accepted.json (else baseline.json); exit 1 on any regression
  --write-baseline        write baseline.json from this run (refuses to overwrite without --force)
  --rebaseline            same as --write-baseline --force
  --accept                write accepted.json (the gate's ratchet) from this run, keeping its exceptions
  --exception <surface:metric:caseId:reason>
                          with --accept: record an approved regression of one case (repeatable)
  --approved-by <who>     with --exception: who approved it (required)
  --force                 allow --write-baseline to overwrite
  --save-history <name>   also copy this run to history/<name>.json (local/history/ for the snapshot tier)
  --lock                  regenerate cases.lock from the case files and exit
  --refresh-embeddings    fill embedding-cache misses from local Ollama (nomic-embed-text)
  --prune                 with --refresh-embeddings: drop cache entries this run did not use
  --no-embeddings         run FTS-only (no embedding provider)
  --vec                   enable sqlite-vec KNN (default: brute-force cosine, STANDUP_DISABLE_VEC=1)
  --surface <s,...>       only these surfaces (${SURFACES.join(", ")})
  --case <id,...>         only these cases (debugging; not comparable to a full run)
  --now <iso>             evaluation clock (default 2026-10-01T00:00:00Z)
  --snapshot [db]         snapshot tier against a copy of a real DB (default local/snapshot.db)
  --harvest <db>          write unlabeled candidate cases from a DB copy's logs to local/harvest-candidates.json
  --migrate               apply every scripts/kb-migrations migration (DB-only, --apply) to the run's temp DB first
`;

interface Flags {
  label?: string;
  saveHistory?: string;
  gate: boolean;
  writeBaseline: boolean;
  accept: boolean;
  exceptions: string[];
  approvedBy?: string;
  force: boolean;
  lock: boolean;
  refresh: boolean;
  prune: boolean;
  noEmbeddings: boolean;
  vec: boolean;
  surfaces?: Surface[];
  caseIds?: string[];
  now?: string;
  snapshot?: string;
  harvest?: string;
  migrate: boolean;
  help: boolean;
}

export function parseFlags(argv: string[], evalDir: string): Flags {
  const flags: Flags = {
    gate: false,
    writeBaseline: false,
    accept: false,
    exceptions: [],
    force: false,
    lock: false,
    refresh: false,
    prune: false,
    noEmbeddings: false,
    vec: false,
    migrate: false,
    help: false,
  };
  const value = (i: number, name: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${name} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--label":
        flags.label = value(i++, a);
        break;
      case "--save-history":
        flags.saveHistory = value(i++, a);
        break;
      case "--gate":
        flags.gate = true;
        break;
      case "--write-baseline":
        flags.writeBaseline = true;
        break;
      case "--rebaseline":
        flags.writeBaseline = true;
        flags.force = true;
        break;
      case "--accept":
        flags.accept = true;
        break;
      case "--exception":
        flags.exceptions.push(value(i++, a));
        break;
      case "--approved-by":
        flags.approvedBy = value(i++, a);
        break;
      case "--force":
        flags.force = true;
        break;
      case "--lock":
        flags.lock = true;
        break;
      case "--refresh-embeddings":
        flags.refresh = true;
        break;
      case "--prune":
        flags.prune = true;
        break;
      case "--no-embeddings":
        flags.noEmbeddings = true;
        break;
      case "--vec":
        flags.vec = true;
        break;
      case "--surface": {
        const list = value(i++, a).split(",").map((s) => s.trim()) as Surface[];
        for (const s of list) if (!SURFACES.includes(s)) throw new Error(`unknown surface ${s}`);
        flags.surfaces = list;
        break;
      }
      case "--case":
        flags.caseIds = value(i++, a).split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--now":
        flags.now = new Date(value(i++, a)).toISOString();
        break;
      case "--snapshot": {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags.snapshot = resolve(next);
          i++;
        } else {
          flags.snapshot = join(evalDir, "local", "snapshot.db");
        }
        break;
      }
      case "--harvest":
        flags.harvest = resolve(value(i++, a));
        break;
      case "--migrate":
        flags.migrate = true;
        break;
      case "--help":
      case "-h":
        flags.help = true;
        break;
      default:
        throw new Error(`unknown flag ${a}`);
    }
  }
  if (flags.prune && !flags.refresh) throw new Error("--prune requires --refresh-embeddings");
  if (flags.exceptions.length > 0 && !flags.accept) throw new Error("--exception requires --accept");
  if (flags.exceptions.length > 0 && !flags.approvedBy) throw new Error("--exception requires --approved-by");
  return flags;
}

function readResults(path: string): EvalResults | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as EvalResults) : null;
}

/**
 * The exceptions an accepted run carries: the previous accepted run's, then
 * each `--exception`, which replaces an earlier one for the same surface,
 * metric and case and takes the case's value in this run as its floor.
 */
export function acceptedExceptions(
  previous: readonly GateException[],
  flags: Pick<Flags, "exceptions" | "approvedBy">,
  results: Pick<Comparable, "cases">
): GateException[] {
  const added = flags.exceptions.map((spec) => parseException(spec, flags.approvedBy ?? "", results));
  const key = (e: GateException) => `${e.surface}\u0000${e.metric}\u0000${e.caseId}`;
  const replaced = new Set(added.map(key));
  return [...previous.filter((e) => !replaced.has(key(e))), ...added];
}

/**
 * Run options that make a gated run comparable to its reference's code-search
 * environment. A reference recorded without ripgrep (git-grep or js) is
 * compared against a run with ripgrep hidden, so a host that happens to have
 * `rg` installed measures the same engine instead of failing on the backend
 * check. Nothing is pinned for an `rg` reference, or one that records no
 * backend: ripgrep cannot be conjured on a host without it, and the backend
 * and per-case mix checks in compareResults still fail any run whose engine
 * differs from the reference's.
 */
export function gateRunOptions(reference: Pick<Comparable, "config"> | null): { ripgrep?: false } {
  const backend = reference?.config.codeSearchBackend;
  return backend !== undefined && backend !== "rg" ? { ripgrep: false } : {};
}

/**
 * The gate's verdict for a finished run: every reason it fails, or [] to pass.
 * `host`, when given, is the fixture repo's code-search conditions; any it
 * cannot reproduce from the reference fail the gate with their cause.
 */
export function gateViolations(
  results: EvalResults,
  reference: EvalResults | null,
  referenceName: string,
  host?: CodeSearchHost
): string[] {
  const out: string[] = [];
  for (const p of results.provenance.casesLockProblems) out.push(p);
  if (results.embeddings.misses > 0) {
    out.push(
      `${results.embeddings.misses} embedding cache miss(es) — run \`bun run eval:kb --refresh-embeddings\`` +
        (results.tier === "snapshot" ? " --snapshot" : "") +
        " with a local Ollama to fill the cache"
    );
  }
  for (const e of results.errors) out.push(`surface error: ${e}`);
  if (results.config.caseFilter) out.push("a --case-filtered run is not comparable to a reference run");
  if (!reference) {
    out.push(`no ${referenceName} to compare against — write one with --write-baseline or --accept`);
    return out;
  }
  if (host) out.push(...codeSearchHostViolations(reference.config.codeSearchBackend, host));
  return [...out, ...compareResults(results, reference)];
}

/** Entry point for `bun run eval:kb`; returns the process exit code. */
/**
 * Applies the knowledge-data migrations to a run's temp DB (the `--migrate`
 * flag). Supplied by the entry script, which owns scripts/kb-migrations.
 */
export type MigrateHook = (db: Database, tier: Tier, evalDir: string) => Promise<string[]>;

export async function main(argv: string[], evalDir: string, migrateHook?: MigrateHook): Promise<number> {
  let flags: Flags;
  try {
    flags = parseFlags(argv, evalDir);
  } catch (err) {
    console.error(String((err as Error).message ?? err));
    console.error(USAGE);
    return 2;
  }
  if (flags.help) {
    console.log(USAGE);
    return 0;
  }

  if (flags.harvest) {
    const out = join(evalDir, "local", "harvest-candidates.json");
    const candidates = harvestCandidates(flags.harvest, out);
    console.log(`[kbeval] wrote ${candidates.length} candidate case(s) to ${out}`);
    return 0;
  }

  const tier: Tier = flags.snapshot ? "snapshot" : "fixture";
  const paths = tierPaths(evalDir, tier);

  if (flags.lock) {
    const lock = computeCasesLock(paths.casesDir);
    writeCasesLock(paths.lockPath, lock);
    console.log(`[kbeval] wrote ${paths.lockPath} (${Object.keys(lock.files).length} case file(s))`);
    return 0;
  }

  if (flags.writeBaseline && existsSync(paths.baselinePath) && !flags.force) {
    console.error(`${paths.baselinePath} exists; pass --force (or --rebaseline) to overwrite it`);
    return 1;
  }

  if (flags.migrate && !migrateHook) {
    console.error("--migrate needs the migrations hook the eval:kb entry script supplies");
    return 2;
  }

  // A gated run, and a run recorded as the next reference, use the current
  // reference's code-search engine, so neither depends on whether this host has `rg`.
  const pinTo =
    flags.gate || flags.accept || flags.writeBaseline
      ? (readResults(paths.acceptedPath) ?? readResults(paths.baselinePath))
      : null;
  const results = await runEval({
    tier,
    evalDir,
    label: flags.label,
    snapshotPath: flags.snapshot,
    refreshEmbeddings: flags.refresh,
    prune: flags.prune,
    noEmbeddings: flags.noEmbeddings,
    vec: flags.vec,
    ...gateRunOptions(pinTo),
    now: flags.now,
    surfaces: flags.surfaces,
    caseIds: flags.caseIds,
    ...(flags.migrate && migrateHook ? { migrate: (db: Database, t: Tier) => migrateHook(db, t, evalDir) } : {}),
    log: (line) => process.stderr.write(`${line}\n`),
  });
  console.log(formatMarkdown(results));
  console.log(`\n[kbeval] results: ${join(paths.resultsDir, `${results.label}.json`)}`);

  if (flags.writeBaseline || flags.accept) {
    const blockers = [
      ...results.provenance.casesLockProblems,
      ...(results.config.caseFilter ? ["the run was filtered with --case"] : []),
      ...(results.embeddings.misses > 0 ? [`${results.embeddings.misses} embedding cache miss(es)`] : []),
    ];
    if (blockers.length > 0) {
      console.error(`[kbeval] refusing to record a reference run:\n  - ${blockers.join("\n  - ")}`);
      return 1;
    }
    const body = JSON.stringify(results, null, 2) + "\n";
    if (flags.writeBaseline) {
      writeFileSync(paths.baselinePath, body);
      console.log(`[kbeval] wrote ${paths.baselinePath}`);
    }
    if (flags.accept) {
      let exceptions: GateException[];
      try {
        exceptions = acceptedExceptions(readResults(paths.acceptedPath)?.exceptions ?? [], flags, results);
      } catch (err) {
        console.error(`[kbeval] ${(err as Error).message}`);
        return 1;
      }
      const accepted = exceptions.length > 0 ? { ...results, exceptions } : results;
      writeFileSync(paths.acceptedPath, JSON.stringify(accepted, null, 2) + "\n");
      console.log(`[kbeval] wrote ${paths.acceptedPath}`);
      for (const e of exceptions) {
        console.log(`[kbeval] exception ${e.surface}.${e.metric} for ${e.caseId} (floor ${e.recordedValue}): ${e.reason}`);
      }
    }
  }

  if (flags.saveHistory) {
    const dir = join(tier === "fixture" ? evalDir : join(evalDir, "local"), "history");
    mkdirSync(dir, { recursive: true });
    const out = join(dir, `${flags.saveHistory}.json`);
    writeFileSync(out, JSON.stringify(results, null, 2) + "\n");
    console.log(`[kbeval] wrote ${out}`);
  }

  if (flags.gate) {
    const accepted = readResults(paths.acceptedPath);
    const reference = accepted ?? readResults(paths.baselinePath);
    const name = accepted ? "accepted.json" : "baseline.json";
    const host = tier === "fixture" ? probeCodeSearchHost(join(evalDir, "fixture-repo")) : undefined;
    const violations = gateViolations(results, reference, name, host);
    if (violations.length > 0) {
      console.error(`\n[kbeval] GATE FAILED against ${name}:`);
      for (const v of violations) console.error(`  - ${v}`);
      return 1;
    }
    console.log(`\n[kbeval] gate passed against ${name}`);
  }
  return 0;
}
