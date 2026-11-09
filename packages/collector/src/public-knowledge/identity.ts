/** The setting that names the header the public knowledge API reads the caller from. */
export const PUBLIC_KB_IDENTITY_HEADER_ENV = "STANDUP_PUBLIC_KB_IDENTITY_HEADER";

/** An HTTP header name the setting may hold. */
const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/**
 * The header the public knowledge API reads the caller from, lowercased:
 * STANDUP_PUBLIC_KB_IDENTITY_HEADER. There is no default. The API's trust
 * rests on the authenticating relay in front of its socket removing any
 * client-supplied copy of this header and stamping the alias it
 * authenticated; a header the relay does not stamp is one a caller can set.
 * So the owner names the relay's header, and neither STANDUP_IDENTITY_HEADER
 * nor the tunnel provider's header stands in for it.
 */
export function publicIdentityHeader(env: NodeJS.ProcessEnv = process.env): string | null {
  const header = env[PUBLIC_KB_IDENTITY_HEADER_ENV]?.trim();
  return header && HEADER_NAME_PATTERN.test(header) ? header.toLowerCase() : null;
}

/** Why the public knowledge API has no caller header to read, or null when it has one. */
export function publicIdentityHeaderProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  if (publicIdentityHeader(env)) return null;
  const raw = env[PUBLIC_KB_IDENTITY_HEADER_ENV]?.trim();
  return raw
    ? `${PUBLIC_KB_IDENTITY_HEADER_ENV} is not a header name`
    : `${PUBLIC_KB_IDENTITY_HEADER_ENV} is not set: name the header the authenticating relay in front of the socket stamps with the caller's alias (after removing any copy the caller sent)`;
}

/** A user alias as the relay stamps it. */
export const ALIAS_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/** A POSIX group name an allowlist may name. */
export const GROUP_PATTERN = /^[a-z0-9_][a-z0-9._-]{0,63}$/i;

/**
 * The caller's alias from the relay's header, trimmed and lowercased — the one
 * spelling the allowlist check and the call log both key
 * on — or null when the header is missing, empty, or not alias-shaped.
 */
export function publicCallerAlias(header: string | null | undefined): string | null {
  const alias = header?.trim();
  if (!alias || !ALIAS_PATTERN.test(alias)) return null;
  return alias.toLowerCase();
}

/** Who may call the public knowledge API: named aliases, or members of named POSIX groups. */
export interface PublicKnowledgeAccess {
  aliases: string[];
  posixGroups: string[];
}

/** The POSIX groups an alias belongs to; an empty list when they can't be resolved. */
export type GroupResolver = (alias: string) => Promise<string[]>;

/** Whether `alias` is allowed by `access`: listed by name, or a member of a listed group. */
export async function isAllowed(
  alias: string,
  access: PublicKnowledgeAccess,
  groupsOf: GroupResolver
): Promise<boolean> {
  const lower = alias.toLowerCase();
  if (access.aliases.some((a) => a.toLowerCase() === lower)) return true;
  if (access.posixGroups.length === 0) return false;
  const groups = await groupsOf(alias);
  return access.posixGroups.some((g) => groups.includes(g));
}

const GROUP_LOOKUP_TIMEOUT_MS = 2_000;
/** How long an answered lookup (groups found, or the alias unknown) is reused. */
export const GROUP_CACHE_MS = 5 * 60_000;
/** How long a lookup that failed (timed out, couldn't spawn) is reused before it is retried. */
export const GROUP_FAILURE_CACHE_MS = 10_000;
/** Most aliases the group cache holds; the least recently used is evicted past it. */
export const GROUP_CACHE_ENTRIES = 1_000;

/**
 * The groups `id -Gn <alias>` reports, run without a shell; the alias's
 * primary group is among them. A non-zero exit (an unknown alias) is no
 * groups; a timeout or a spawn failure throws, so the cache retries it soon.
 */
async function idGroups(alias: string): Promise<string[]> {
  if (!ALIAS_PATTERN.test(alias)) return [];
  const proc = Bun.spawn(["id", "-Gn", "--", alias], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, GROUP_LOOKUP_TIMEOUT_MS);
  try {
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (timedOut) throw new Error(`id -Gn ${alias} timed out`);
    if (code !== 0) return [];
    return out.split(/\s+/).filter(Boolean);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A GroupResolver that caches each alias's groups: an answered lookup (groups
 * found, or none) for GROUP_CACHE_MS, a failed one — `lookup` threw — as no
 * groups for GROUP_FAILURE_CACHE_MS only. It holds at most
 * GROUP_CACHE_ENTRIES aliases, evicting the least recently used. `lookup`
 * defaults to `id -Gn`; `now` is the clock the cache reads.
 */
export function cachedGroupResolver(
  lookup: GroupResolver = idGroups,
  now: () => number = Date.now,
  maxEntries: number = GROUP_CACHE_ENTRIES
): GroupResolver {
  // A Map iterates in insertion order, so re-inserting on use keeps the least recently used first.
  const cache = new Map<string, { groups: string[]; at: number; ttl: number }>();
  return async (alias) => {
    const hit = cache.get(alias);
    if (hit && now() - hit.at < hit.ttl) {
      cache.delete(alias);
      cache.set(alias, hit);
      return hit.groups;
    }
    let entry: { groups: string[]; at: number; ttl: number };
    try {
      entry = { groups: await lookup(alias), at: now(), ttl: GROUP_CACHE_MS };
    } catch {
      entry = { groups: [], at: now(), ttl: GROUP_FAILURE_CACHE_MS };
    }
    cache.delete(alias);
    cache.set(alias, entry);
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value!);
    return entry.groups;
  };
}
