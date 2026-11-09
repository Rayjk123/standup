import { GLOBAL_PROJECT_ID } from "@standup/shared";

/**
 * Knowledge federation: external retrievers searched alongside the local
 * knowledge base and merged with its hits by reciprocal rank (RRF).
 *
 * - An external hit is never ingested: it lives only in the search response,
 *   carries its source label, and cannot be opened with get_knowledge_doc.
 * - Each retriever runs under its own budget (EXTERNAL_RETRIEVER_TIMEOUT_MS
 *   unless it sets one). A slow source is aborted at its budget and a throwing
 *   one is dropped, so neither fails nor delays the search past that budget.
 *   Failures are logged at most once per FEDERATION_ERROR_LOG_INTERVAL_MS per
 *   source, never once per call.
 * - Off by default: a project federates only when it is listed in
 *   STANDUP_FEDERATION_PROJECTS, and never when it is a Standup-internal
 *   project (standup, standup-self, the global corpus, any reserved project) or
 *   the search is the restricted one a shared thread reads.
 * - Access control stays at the source. Standup stores no credentials for a
 *   retriever; a command retriever runs with the collector's environment, so
 *   it authenticates however its own CLI and config do.
 *
 * Command retrievers come from STANDUP_FEDERATION_COMMANDS, a JSON array of
 * `{ "id", "label", "command": [argv...], "timeoutMs"? }`. The command gets the
 * query on stdin and prints one JSON object per line:
 * `{ "title", "ref" | "url", "excerpt", "score"? }`.
 */

/** The default per-retriever budget, in ms. */
export const EXTERNAL_RETRIEVER_TIMEOUT_MS = 1500;

/** How many hits one retriever may contribute to a search. */
export const EXTERNAL_RESULT_LIMIT = 5;

/** The reciprocal-rank (RRF) constant: a hit at 1-based rank r scores 1 / (RRF_K + r). */
export const RRF_K = 60;

/** The minimum gap between two failure logs for the same retriever. */
export const FEDERATION_ERROR_LOG_INTERVAL_MS = 10 * 60_000;

/** The longest excerpt kept from an external hit. */
export const EXTERNAL_EXCERPT_MAX_CHARS = 600;

/** The most command output read before parsing; the rest is ignored. */
export const COMMAND_OUTPUT_MAX_CHARS = 256 * 1024;

/** Projects whose searches are about Standup itself and never leave the host. */
export const STANDUP_INTERNAL_PROJECT_IDS: ReadonlySet<string> = new Set(["standup", "standup-self", GLOBAL_PROJECT_ID]);

/** One hit as a retriever returns it; `url` or `ref` locates it at the source. */
export interface ExternalHit {
  title: string;
  url?: string;
  ref?: string;
  excerpt: string;
  score?: number;
}

export interface ExternalSearchOptions {
  limit: number;
  /** Aborted when the retriever's budget runs out; a retriever should stop its work on it. */
  signal: AbortSignal;
}

/** A source searched alongside the local knowledge base. `search` may throw. */
export interface ExternalRetriever {
  id: string;
  /** The name an agent sees on each hit: `[external: <label>]`. */
  label: string;
  /** This retriever's budget, in ms; EXTERNAL_RETRIEVER_TIMEOUT_MS when unset. */
  timeoutMs?: number;
  search(query: string, options: ExternalSearchOptions): Promise<ExternalHit[]>;
}

/** An external hit as it rides in a search response. */
export interface LabeledExternalHit {
  retriever: string;
  label: string;
  title: string;
  ref: string;
  excerpt: string;
  score?: number;
}

/** One entry of the fused ranking: a local doc by id, or an external hit. */
export type FusedEntry =
  | { kind: "local"; id: string; rrf: number }
  | ({ kind: "external"; rrf: number } & LabeledExternalHit);

export interface ExternalSourceStatus {
  id: string;
  label: string;
  status: "ok" | "timeout" | "error";
  hits: number;
}

/** What a federated search adds to the response. `federated` is set only when a source returned hits. */
export interface FederationReply {
  federated?: FusedEntry[];
  externalSources: ExternalSourceStatus[];
}

export interface FederationHooks {
  log?: (message: string) => void;
  now?: () => number;
}

type Env = Record<string, string | undefined>;

const REGISTERED = new Map<string, ExternalRetriever>();

/** Adds (or replaces) an external retriever, keyed by its id. */
export function registerExternalRetriever(retriever: ExternalRetriever): void {
  REGISTERED.set(retriever.id, retriever);
}

/** Removes an external retriever. */
export function unregisterExternalRetriever(id: string): void {
  REGISTERED.delete(id);
}

const lastLoggedAt = new Map<string, number>();

/** Forgets when each source last logged a failure. */
export function resetFederationLogState(): void {
  lastLoggedAt.clear();
}

function logThrottled(key: string, message: string, hooks: FederationHooks): void {
  const now = (hooks.now ?? Date.now)();
  const last = lastLoggedAt.get(key);
  if (last !== undefined && now - last < FEDERATION_ERROR_LOG_INTERVAL_MS) return;
  lastLoggedAt.set(key, now);
  (hooks.log ?? console.warn)(`[knowledge-federation] ${message}`);
}

/** The project ids listed in STANDUP_FEDERATION_PROJECTS. */
export function federationProjects(env: Env = process.env): Set<string> {
  return new Set(
    (env.STANDUP_FEDERATION_PROJECTS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
  );
}

/**
 * Whether a search of `projectId` may consult external retrievers: the project
 * opted in, is not Standup-internal or reserved, and the search is not the
 * restricted one a shared thread reads.
 */
export function federationAllowedFor(
  projectId: string,
  options: { reserved?: boolean; restricted?: boolean; env?: Env } = {}
): boolean {
  if (options.reserved || options.restricted) return false;
  if (STANDUP_INTERNAL_PROJECT_IDS.has(projectId)) return false;
  return federationProjects(options.env).has(projectId);
}

export interface CommandRetrieverConfig {
  id: string;
  label: string;
  /** argv; the first element is the executable. */
  command: string[];
  timeoutMs?: number;
}

function isCommandRetrieverConfig(value: unknown): value is CommandRetrieverConfig {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    v.id.trim() !== "" &&
    typeof v.label === "string" &&
    v.label.trim() !== "" &&
    Array.isArray(v.command) &&
    v.command.length > 0 &&
    v.command.every((part) => typeof part === "string") &&
    (v.timeoutMs === undefined || (typeof v.timeoutMs === "number" && Number.isFinite(v.timeoutMs) && v.timeoutMs > 0))
  );
}

/** The command retrievers configured in `raw` (STANDUP_FEDERATION_COMMANDS); invalid entries are skipped and logged. */
export function parseCommandRetrievers(raw: string | undefined, hooks: FederationHooks = {}): CommandRetrieverConfig[] {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logThrottled("config", "STANDUP_FEDERATION_COMMANDS is not valid JSON; no command retrievers configured", hooks);
    return [];
  }
  if (!Array.isArray(parsed)) {
    logThrottled("config", "STANDUP_FEDERATION_COMMANDS must be a JSON array; no command retrievers configured", hooks);
    return [];
  }
  const valid = parsed.filter(isCommandRetrieverConfig);
  if (valid.length < parsed.length) {
    logThrottled(
      "config",
      `STANDUP_FEDERATION_COMMANDS: skipped ${parsed.length - valid.length} entr${parsed.length - valid.length === 1 ? "y" : "ies"} without id, label and a non-empty string command`,
      hooks
    );
  }
  return valid;
}

/** The hits in a command's output: one JSON object per line, malformed lines skipped. */
export function parseJsonLines(output: string): ExternalHit[] {
  const hits: ExternalHit[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const hit = toExternalHit(value);
    if (hit) hits.push(hit);
  }
  return hits;
}

function toExternalHit(value: unknown): ExternalHit | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  const title = typeof v.title === "string" ? v.title.trim() : "";
  const url = typeof v.url === "string" && v.url.trim() ? v.url.trim() : undefined;
  const ref = typeof v.ref === "string" && v.ref.trim() ? v.ref.trim() : undefined;
  if (!title || (!url && !ref)) return undefined;
  return {
    title,
    ...(url ? { url } : {}),
    ...(ref ? { ref } : {}),
    excerpt: typeof v.excerpt === "string" ? v.excerpt : "",
    ...(typeof v.score === "number" && Number.isFinite(v.score) ? { score: v.score } : {}),
  };
}

/**
 * A retriever that runs `config.command` with the query on stdin and reads JSON
 * lines from stdout. A non-zero exit, or output with no parseable hit, throws;
 * an abort kills the process.
 */
export function commandRetriever(config: CommandRetrieverConfig): ExternalRetriever {
  return {
    id: config.id,
    label: config.label,
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    async search(query, { limit, signal }) {
      const proc = Bun.spawn(config.command, {
        stdin: new Blob([query]),
        stdout: "pipe",
        stderr: "pipe",
      });
      const kill = () => proc.kill();
      signal.addEventListener("abort", kill, { once: true });
      try {
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        if (signal.aborted) throw new Error("aborted");
        if (code !== 0) {
          const detail = stderr.trim().split("\n")[0]?.slice(0, 200);
          throw new Error(`exited with code ${code}${detail ? `: ${detail}` : ""}`);
        }
        const output = stdout.slice(0, COMMAND_OUTPUT_MAX_CHARS);
        const hits = parseJsonLines(output);
        if (hits.length === 0 && output.trim()) {
          throw new Error("printed no parseable {title, ref|url, excerpt} JSON line");
        }
        return hits.slice(0, limit);
      } finally {
        signal.removeEventListener("abort", kill);
      }
    },
  };
}

let envRetrievers: { raw: string | undefined; retrievers: ExternalRetriever[] } | undefined;

/** The registered retrievers, then the command retrievers configured in the env (a registered id wins). */
export function activeExternalRetrievers(env: Env = process.env, hooks: FederationHooks = {}): ExternalRetriever[] {
  const raw = env.STANDUP_FEDERATION_COMMANDS;
  if (!envRetrievers || envRetrievers.raw !== raw) {
    envRetrievers = { raw, retrievers: parseCommandRetrievers(raw, hooks).map(commandRetriever) };
  }
  return [...REGISTERED.values(), ...envRetrievers.retrievers.filter((r) => !REGISTERED.has(r.id))];
}

interface RetrieverRun {
  status: ExternalSourceStatus;
  hits: LabeledExternalHit[];
}

function label(retriever: ExternalRetriever, hits: readonly ExternalHit[], limit: number): LabeledExternalHit[] {
  const seen = new Set<string>();
  const labeled: LabeledExternalHit[] = [];
  for (const hit of hits) {
    if (labeled.length >= limit) break;
    const title = typeof hit?.title === "string" ? hit.title.trim() : "";
    const ref = hit?.url?.trim() || hit?.ref?.trim();
    if (!title || !ref || seen.has(ref)) continue;
    seen.add(ref);
    labeled.push({
      retriever: retriever.id,
      label: retriever.label,
      title,
      ref,
      excerpt: (typeof hit.excerpt === "string" ? hit.excerpt : "").slice(0, EXTERNAL_EXCERPT_MAX_CHARS),
      ...(typeof hit.score === "number" && Number.isFinite(hit.score) ? { score: hit.score } : {}),
    });
  }
  return labeled;
}

/** Runs one retriever under its budget; a timeout aborts it and any failure yields no hits. */
async function runRetriever(
  retriever: ExternalRetriever,
  query: string,
  limit: number,
  hooks: FederationHooks
): Promise<RetrieverRun> {
  const budget = retriever.timeoutMs ?? EXTERNAL_RETRIEVER_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), budget);
  });
  const searching = Promise.resolve().then(() => retriever.search(query, { limit, signal: controller.signal }));
  // The losing side of the race may still reject after the search has moved on.
  searching.catch(() => {});
  const status = (s: ExternalSourceStatus["status"], hits: number): ExternalSourceStatus => ({
    id: retriever.id,
    label: retriever.label,
    status: s,
    hits,
  });
  try {
    const outcome = await Promise.race([searching, timedOut]);
    if (outcome === "timeout") {
      controller.abort();
      logThrottled(retriever.id, `${retriever.id} timed out after ${budget} ms`, hooks);
      return { status: status("timeout", 0), hits: [] };
    }
    const hits = label(retriever, Array.isArray(outcome) ? outcome : [], limit);
    return { status: status("ok", hits.length), hits };
  } catch (err) {
    controller.abort();
    logThrottled(retriever.id, `${retriever.id} failed: ${err instanceof Error ? err.message : String(err)}`, hooks);
    return { status: status("error", 0), hits: [] };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reciprocal-rank (RRF) merge of the local ranking with each external list: every
 * entry scores 1 / (RRF_K + rank) within its own list, so external hits keep
 * their own source's order and no source's raw scores are compared with
 * another's. Ties go to the local list, then to list order.
 */
export function fuseRrf(localIds: readonly string[], externalLists: readonly LabeledExternalHit[][]): FusedEntry[] {
  const entries: Array<{ entry: FusedEntry; list: number; rank: number }> = [];
  localIds.forEach((id, i) => entries.push({ entry: { kind: "local", id, rrf: 1 / (RRF_K + i + 1) }, list: 0, rank: i }));
  externalLists.forEach((hits, l) =>
    hits.forEach((hit, i) =>
      entries.push({ entry: { kind: "external", rrf: 1 / (RRF_K + i + 1), ...hit }, list: l + 1, rank: i })
    )
  );
  entries.sort((a, b) => b.entry.rrf - a.entry.rrf || a.list - b.list || a.rank - b.rank);
  return entries.map((e) => e.entry);
}

/**
 * Consults the external retrievers for a search of `projectId` and fuses their
 * hits with `localIds` (the local results, in rank order). Undefined when the
 * search does not federate: the project has not opted in, it is
 * Standup-internal, or no retriever is configured. Resolves within the largest
 * retriever budget.
 */
export async function federateSearch(
  input: {
    query: string;
    projectId: string;
    localIds: readonly string[];
    reserved?: boolean;
    restricted?: boolean;
    env?: Env;
    limit?: number;
  },
  hooks: FederationHooks = {}
): Promise<FederationReply | undefined> {
  const env = input.env ?? process.env;
  if (!input.query.trim()) return undefined;
  if (!federationAllowedFor(input.projectId, { reserved: input.reserved, restricted: input.restricted, env })) {
    return undefined;
  }
  const retrievers = activeExternalRetrievers(env, hooks);
  if (retrievers.length === 0) return undefined;
  const limit = input.limit ?? EXTERNAL_RESULT_LIMIT;
  const runs = await Promise.all(retrievers.map((r) => runRetriever(r, input.query, limit, hooks)));
  const lists = runs.map((r) => r.hits);
  return {
    ...(lists.some((l) => l.length > 0) ? { federated: fuseRrf(input.localIds, lists) } : {}),
    externalSources: runs.map((r) => r.status),
  };
}
