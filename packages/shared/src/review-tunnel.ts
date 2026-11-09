// ============================================================================
// Review tunnels — a per-job HTTPS tunnel to a branch build of a project's UI,
// opened when a pipeline run enters its screenshot stage and torn down when
// the job closes, its review is decided or the tunnel goes stale. This file is
// the pure part: the per-project configuration, its validation and layering,
// tunnel naming and the record's shape. The collector opens and closes the
// tunnels through its TunnelProvider, which also gives a tunnel its URL. No
// node imports: the web bundles this file.
// ============================================================================

/**
 * How a project's UI is served for review. Lives on a pipeline configuration
 * layer (`reviewTunnel`), merged field by field: the owner's global layer,
 * then the project's built-in seed (REVIEW_TUNNEL_PROJECT_SEEDS), then the
 * owner's project layer. A project whose merged config has no `serve`, or
 * `enabled: false`, gets no tunnel.
 */
export interface ReviewTunnelConfig {
  /** false turns review tunnels off for the layer's scope. */
  enabled?: boolean;
  /** The directory to serve from, relative to the launch's worktree (default: the worktree itself). */
  dir?: string;
  /** Runs in `dir` before serving, unless `setupSkipIf` exists there; split into argv, never run through a shell. */
  setup?: string;
  /** A path relative to `dir` whose presence skips `setup` (e.g. node_modules). */
  setupSkipIf?: string;
  /** The serve command, with `{port}` where the allocated port goes; split into argv, never run through a shell. */
  serve?: string;
  /** Inclusive [low, high] range the serve port is allocated from. */
  portRange?: [number, number];
  /** The tunnel's name: `<owner>-` followed by any of `<job-slug>`, `<user>`, `<launch>` and literal text. */
  namePattern?: string;
  /** Who may reach the tunnel, in the tunnel provider's syntax (e.g. users and groups, comma-separated); the tunnel owner alone when unset. */
  allow?: string;
  /** The region the tunnel provider serves the tunnel from, when it has regions; the provider's own default when unset. */
  region?: string;
  /** Hours an open tunnel lives before it is torn down as stale (default 24). */
  ttlHours?: number;
}

/**
 * One configuration layer's review-tunnel fields: any ReviewTunnelConfig
 * field, or null to clear what a lower layer set (e.g. a seed's setup a
 * project doesn't need).
 */
export type ReviewTunnelLayer = { [K in keyof ReviewTunnelConfig]?: ReviewTunnelConfig[K] | null };

export type ReviewTunnelStatus = "opening" | "open" | "closed" | "failed";

/**
 * Why a tunnel was torn down: its job closed, its launch ended, its review was
 * decided, it outlived its TTL, a person or Persona closed it, its processes
 * died (`lost`), the collector reconciled a leak, or its pipeline run was
 * turned off (a Best-of-N attempt that wasn't picked).
 */
export type ReviewTunnelCloseReason =
  | "job_closed"
  | "launch_ended"
  | "review_decided"
  | "expired"
  | "manual"
  | "lost"
  | "reconciled"
  | "run_disabled";

/** A review tunnel's record: one per opening, kept after it closes. */
export interface ReviewTunnel {
  id: string;
  launchId: string;
  runId?: string;
  jobId?: string;
  owner: string;
  projectId?: string;
  /** The full tunnel name (`<host user>-<suffix>`), also the URL's first label. */
  name: string;
  url: string;
  /** The loopback port the branch build is served on. */
  port: number;
  servePid?: number;
  tunnelPid?: number;
  status: ReviewTunnelStatus;
  error?: string;
  closeReason?: ReviewTunnelCloseReason;
  openedAt?: string;
  expiresAt?: string;
  closedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export const DEFAULT_REVIEW_TUNNEL_PORT_RANGE: readonly [number, number] = [5200, 5299];
export const DEFAULT_REVIEW_TUNNEL_NAME_PATTERN = "<owner>-<job-slug>";
export const DEFAULT_REVIEW_TUNNEL_TTL_HOURS = 24;
export const MAX_REVIEW_TUNNEL_TTL_HOURS = 24 * 14;

/**
 * Tunnel name suffixes a review tunnel never takes, built in: the Standup
 * console's (`<user>-standup`). A name that would land on one gets `-review`
 * appended. The collector adds the host's own standing tunnels from its
 * settings.
 */
export const REVIEW_TUNNEL_RESERVED_SUFFIXES: ReadonlySet<string> = new Set(["standup"]);

/** The DNS label limit a tunnel name must fit in. */
export const MAX_REVIEW_TUNNEL_NAME = 63;

/**
 * Built-in review-tunnel config per project id — the layer between an owner's
 * global and project layers. A seed sets only what is the project's own (where
 * and how its UI is served), so the owner's global choices (who may reach a
 * tunnel, its TTL, port range and name) still apply. Standup ships none.
 */
export const REVIEW_TUNNEL_PROJECT_SEEDS: Readonly<Record<string, ReviewTunnelConfig>> = {};

/** A copy of the built-in review-tunnel config for `projectId` in `seeds` (default: REVIEW_TUNNEL_PROJECT_SEEDS), or undefined. */
export function reviewTunnelSeed(
  projectId: string | null | undefined,
  seeds: Readonly<Record<string, ReviewTunnelConfig>> = REVIEW_TUNNEL_PROJECT_SEEDS,
): ReviewTunnelConfig | undefined {
  if (!projectId) return undefined;
  const seed = seeds[projectId];
  return seed ? { ...seed, ...(seed.portRange ? { portRange: [...seed.portRange] as [number, number] } : {}) } : undefined;
}

const CONFIG_KEYS: ReadonlySet<string> = new Set([
  "enabled",
  "dir",
  "setup",
  "setupSkipIf",
  "serve",
  "portRange",
  "namePattern",
  "allow",
  "region",
  "ttlHours",
]);

const NAME_TOKENS = ["<owner>", "<job-slug>", "<user>", "<launch>"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isPort(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1024 && v <= 65535;
}

/** A relative path with no `..` segment and no leading `/`. */
function isRelativePath(v: string): boolean {
  if (v.startsWith("/") || v.includes("\0")) return false;
  return !v.split(/[\\/]+/).some((seg) => seg === "..");
}

/**
 * Problems with a review-tunnel config layer, each naming its field under
 * `at` — empty when it is valid. Every field is optional on a layer; whether
 * the merged result can open a tunnel is reviewTunnelActive's call.
 */
export function validateReviewTunnelConfig(raw: unknown, at = "reviewTunnel"): string[] {
  if (!isRecord(raw)) return [`${at}: must be an object`];
  const errors: string[] = [];
  for (const key of Object.keys(raw)) if (!CONFIG_KEYS.has(key)) errors.push(`${at}.${key}: unknown review tunnel field`);
  // null clears a lower layer's field; only the fields actually set are checked.
  const v = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== null)) as Record<string, unknown>;
  if (v.enabled !== undefined && typeof v.enabled !== "boolean") errors.push(`${at}.enabled: must be a boolean`);
  for (const key of ["dir", "setupSkipIf"] as const) {
    const val = v[key];
    if (val === undefined) continue;
    if (typeof val !== "string" || !val.trim() || !isRelativePath(val.trim())) {
      errors.push(`${at}.${key}: must be a relative path without ".."`);
    }
  }
  for (const key of ["setup", "serve"] as const) {
    const val = v[key];
    if (val === undefined) continue;
    if (typeof val !== "string" || !val.trim()) {
      errors.push(`${at}.${key}: must be a non-empty command`);
      continue;
    }
    const argv = splitCommand(val);
    if (!argv) errors.push(`${at}.${key}: has an unterminated quote`);
    else if (key === "serve" && !argv.some((a) => a.includes("{port}"))) {
      errors.push(`${at}.serve: must contain {port}, where the allocated port goes`);
    }
  }
  if (v.portRange !== undefined) {
    const r = v.portRange;
    if (!Array.isArray(r) || r.length !== 2 || !isPort(r[0]) || !isPort(r[1]) || r[0] > r[1]) {
      errors.push(`${at}.portRange: must be [low, high], ports from 1024 to 65535 with low <= high`);
    } else if (r[1] - r[0] > 1000) {
      errors.push(`${at}.portRange: may span at most 1000 ports`);
    }
  }
  if (v.namePattern !== undefined) {
    const p = v.namePattern;
    if (typeof p !== "string" || !p.startsWith("<owner>-")) {
      errors.push(`${at}.namePattern: must start with "<owner>-" (the tunnel CLI prefixes the host user)`);
    } else {
      const literal = NAME_TOKENS.reduce((s, t) => s.split(t).join(""), p);
      if (/[<>]/.test(literal)) errors.push(`${at}.namePattern: unknown token (use ${NAME_TOKENS.join(", ")})`);
      else if (!/^[a-z0-9-]*$/.test(literal)) errors.push(`${at}.namePattern: literal text may use only a-z, 0-9 and "-"`);
      else if (p === "<owner>-") errors.push(`${at}.namePattern: needs something after "<owner>-"`);
    }
  }
  if (v.allow !== undefined && (typeof v.allow !== "string" || !/^[A-Za-z0-9:._,-]+$/.test(v.allow))) {
    errors.push(`${at}.allow: must be a comma-separated list of users or <kind>:<group> entries`);
  }
  if (v.region !== undefined && (typeof v.region !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(v.region))) {
    errors.push(`${at}.region: must be a region name such as eu-west-1 (lower-case letters, digits and "-")`);
  }
  if (v.ttlHours !== undefined) {
    const t = v.ttlHours;
    if (typeof t !== "number" || !Number.isFinite(t) || t <= 0 || t > MAX_REVIEW_TUNNEL_TTL_HOURS) {
      errors.push(`${at}.ttlHours: must be a number of hours above 0 and at most ${MAX_REVIEW_TUNNEL_TTL_HOURS}`);
    }
  }
  return errors;
}

/**
 * Merges review-tunnel layers lowest first, field by field: a set field
 * replaces the one beneath, null clears it, undefined leaves it. Undefined
 * when nothing is left set.
 */
export function mergeReviewTunnelConfig(layers: Array<ReviewTunnelLayer | null | undefined>): ReviewTunnelConfig | undefined {
  const merged: Record<string, unknown> = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [key, value] of Object.entries(layer)) {
      if (value === undefined) continue;
      if (value === null) delete merged[key];
      else merged[key] = Array.isArray(value) ? [...value] : value;
    }
  }
  return Object.keys(merged).length > 0 ? (merged as ReviewTunnelConfig) : undefined;
}

/** Whether `config` (a merged one) opens a tunnel: not turned off, and it says how to serve. */
export function reviewTunnelActive(config: ReviewTunnelConfig | null | undefined): config is ReviewTunnelConfig & { serve: string } {
  return !!config && config.enabled !== false && typeof config.serve === "string" && config.serve.trim().length > 0;
}

/**
 * Splits a command line into argv the way a shell would split plain words:
 * whitespace separates, single and double quotes group, a backslash escapes
 * the next character outside single quotes. Nothing is expanded — no
 * variables, globs, pipes or redirections. Null on an unterminated quote.
 */
export function splitCommand(command: string): string[] | null {
  const out: string[] = [];
  let cur = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      cur += command[++i];
      inWord = true;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inWord) out.push(cur);
      cur = "";
      inWord = false;
      continue;
    }
    cur += ch;
    inWord = true;
  }
  if (quote) return null;
  if (inWord) out.push(cur);
  return out;
}

/** `text` as a tunnel-name slug: lowercase a-z0-9 runs joined by "-", at most `max` characters. */
export function tunnelSlug(text: string, max = 32): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
}

/**
 * The tunnel name `pattern` gives: `<owner>` is the host user the tunnel CLI
 * prefixes, `<job-slug>` the job's title (the launch's when it has no job),
 * `<user>` the job owner's alias and `<launch>` the launch id's first eight
 * characters. Returns the full name and the suffix passed to `--name`; a
 * suffix that would land on a built-in reserved one (Standup's own,
 * REVIEW_TUNNEL_RESERVED_SUFFIXES) gets `-review` appended, and the whole name
 * is cut to the DNS label limit.
 */
export function reviewTunnelName(
  pattern: string,
  vars: { hostUser: string; jobSlug: string; user: string; launchId: string }
): { name: string; suffix: string } {
  const host = tunnelSlug(vars.hostUser, 24) || "user";
  const body = pattern.startsWith("<owner>-") ? pattern.slice("<owner>-".length) : pattern;
  const filled = body
    .split("<owner>")
    .join(host)
    .split("<job-slug>")
    .join(tunnelSlug(vars.jobSlug) || "review")
    .split("<user>")
    .join(tunnelSlug(vars.user, 24) || "user")
    .split("<launch>")
    .join(tunnelSlug(vars.launchId.slice(0, 8), 8) || "launch");
  let suffix = tunnelSlug(filled, MAX_REVIEW_TUNNEL_NAME - host.length - 1) || "review";
  if (REVIEW_TUNNEL_RESERVED_SUFFIXES.has(suffix)) suffix = `${suffix}-review`;
  return { name: `${host}-${suffix}`, suffix };
}

/** Whether a tunnel record still holds its port and processes. */
export function reviewTunnelLive(t: Pick<ReviewTunnel, "status">): boolean {
  return t.status === "opening" || t.status === "open";
}
