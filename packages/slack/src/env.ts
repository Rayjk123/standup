// Env loading + validation for the Slack adapter.
//
// Bun auto-loads `.env` (see packages/slack/.env.example), so these are read
// straight off process.env. The probe (probe.ts) uses the token/probe fields;
// the running adapter (index.ts) additionally uses collectorUrl/wsUrl and the
// feed/ask targets.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { consoleBaseUrlFromEnv } from "@standup/shared";

/** The two tokens a Socket Mode Slack app needs, plus probe/runtime targets. */
export interface SlackEnv {
  /** Bot token, `xoxb-…`. Authorizes every Web API call (auth.test, chat.*). */
  botToken?: string;
  /** App-level token, `xapp-…` with `connections:write`. Authorizes the Socket Mode websocket. */
  appToken?: string;
  /** Channel id (`C…`) or DM (`D…`) the probe posts its test messages into. */
  probeChannel?: string;
  /** Optional parent thread ts — some streaming setups want the stream inside a thread. */
  probeThreadTs?: string;
  /** Optional recipient user id (`U…`) for chat.startStream — the person the stream is for. */
  probeUser?: string;

  // --- running adapter ---
  /** Collector HTTP base, e.g. http://127.0.0.1:7777. Source of settings + the resolve API. */
  collectorUrl: string;
  /** Collector WebSocket URL, e.g. ws://127.0.0.1:7778. The live event feed. */
  wsUrl: string;
  /**
   * Public base URL of the Standup web console, e.g. http://localhost:5173.
   * Used to build the shareable "Open in Standup" link on a session's mirror
   * thread. Defaults to the Vite dev origin the collector already allows via CORS.
   */
  webUrl: string;
  /**
   * The console base URL a teammate's browser actually reaches (for example
   * through an authenticating proxy or tunnel): STANDUP_WEB_URL, else STANDUP_CONSOLE_ORIGIN (the variable
   * scripts/console-login.ts reads), and only while it is one `consoleBaseUrl`
   * accepts. Undefined when neither is usable — login links are then refused
   * rather than pointed at a localhost default, and Persona's console links
   * stay relative.
   */
  consoleOrigin?: string;
  /** One of those variables is set to something `consoleBaseUrl` refuses, so `consoleOrigin` is unset despite the configuration. */
  consoleOriginUnusable: boolean;
  /**
   * Default/override channel id to write the feed into. Normally the feed
   * channel is a collector setting (`slackFeedChannel`) so it can be changed
   * live from Slack; this env var seeds it when the setting is unset.
   */
  feedChannel?: string;
  /**
   * OPTIONAL override for the ask recipient (`U…`). Normally the adapter learns
   * this from whoever DMs the bot and persists it (collector setting
   * slackAskUser); set this only to pre-seed a recipient before the first DM.
   */
  askUser?: string;
  /**
   * OPTIONAL extra Slack user ids (`U…`, comma-separated) permitted to steer a
   * session from its mirror thread, beyond the learned owner. Leave unset in a
   * single-user setup — the owner alone can steer.
   */
  steerAllowlist: string[];
  /**
   * OPTIONAL owner→Slack-id map — `alias:U…` pairs, comma/space-separated
   * (SLACK_OWNER_MAP) — so a session's owner actor routes attention to that one
   * human's DM / @-mention. Configuring it OPTS IN to owner-routed attention:
   * an ask for an owned session goes to its owner, and an owner-less session's
   * ask is never posted channel-wide — it falls back to the single learned
   * recipient's DM (a blocking ask is never dropped), or is suppressed entirely
   * when no recipient has been learned yet. Empty (the default) keeps owner
   * routing OFF — delivery falls back to the learned recipient as before.
   */
  ownerMap: Map<string, string>;
  /**
   * OPTIONAL aliases (SLACK_PERSONA_USERS, comma/space-separated) that get a
   * Persona in Slack besides the host. A listed alias needs its SLACK_OWNER_MAP
   * entry; a mapped alias that isn't listed keeps owner-routed asks only.
   * Empty (the default) keeps Persona-in-Slack to the host alone.
   */
  personaUsers: string[];
  /**
   * OPTIONAL mail domain whose addresses are `<alias>@<domain>`, with the alias
   * the identity header carries. A Slack user whose email is at exactly this
   * domain has their `slack:U…` actor merged into that alias's actor. It is the
   * same fact as the org profile's `identity.emailDomain` (the co-author email
   * domain), so it defaults to that; SLACK_IDENTITY_EMAIL_DOMAIN overrides it,
   * and setting it to a value that is not a domain (`none`) turns merging off
   * even when the profile names a domain. See identityEmailDomainFrom.
   * Undefined merges no one.
   */
  identityEmailDomain?: string;
}

export function loadEnv(): SlackEnv {
  const collectorUrl = emptyToUndefined(process.env.COLLECTOR_URL) ?? "http://127.0.0.1:7777";
  // A malformed value is skipped rather than kept, so it can't mask a usable one.
  const consoleOrigin = consoleBaseUrlFromEnv(process.env);
  const rawConsoleUrl =
    emptyToUndefined(process.env.STANDUP_WEB_URL) ?? emptyToUndefined(process.env.STANDUP_CONSOLE_ORIGIN);
  return {
    botToken: emptyToUndefined(process.env.SLACK_BOT_TOKEN),
    appToken: emptyToUndefined(process.env.SLACK_APP_TOKEN),
    probeChannel: emptyToUndefined(process.env.SLACK_PROBE_CHANNEL),
    probeThreadTs: emptyToUndefined(process.env.SLACK_PROBE_THREAD_TS),
    probeUser: emptyToUndefined(process.env.SLACK_PROBE_USER),
    collectorUrl,
    wsUrl: emptyToUndefined(process.env.SLACK_WS_URL) ?? defaultWsUrl(collectorUrl),
    // The mirror's "Open in Standup" link keeps a configured value as it was
    // written, so a shape only the link builders refuse still reaches a reader.
    webUrl: rawConsoleUrl ?? "http://localhost:5173",
    consoleOrigin,
    consoleOriginUnusable: !consoleOrigin && rawConsoleUrl !== undefined,
    feedChannel: emptyToUndefined(process.env.SLACK_FEED_CHANNEL),
    askUser: emptyToUndefined(process.env.SLACK_ASK_USER),
    steerAllowlist: parseList(process.env.SLACK_STEER_ALLOWLIST),
    ownerMap: parseOwnerMap(process.env.SLACK_OWNER_MAP),
    personaUsers: parseList(process.env.SLACK_PERSONA_USERS),
    identityEmailDomain: identityEmailDomainFrom(process.env),
  };
}

/**
 * The env var naming the org profile file. The collector's orgProfilePath
 * (packages/collector/src/org-profile/load.ts) resolves the same variable the
 * same way; org-profile/slack-parity.test.ts in the collector holds the two
 * resolvers to the same answers.
 */
const ORG_PROFILE_ENV = "STANDUP_ORG_PROFILE";

/**
 * The org profile file: STANDUP_ORG_PROFILE (a leading `~/` read as the home
 * dir), else `<home>/.config/standup/org-profile.json`. Undefined for a path
 * that is still relative, which the collector refuses too. Both are resolved
 * against the adapter's own environment and home dir, so an adapter run as a
 * different user or on a different host than the collector reads a different
 * file unless STANDUP_ORG_PROFILE names the collector's.
 */
export function orgProfileFile(env: Record<string, string | undefined>, home: string = homedir()): string | undefined {
  const set = env[ORG_PROFILE_ENV]?.trim();
  if (!set) return join(home, ".config", "standup", "org-profile.json");
  if (set === "~") return normalize(home);
  if (set.startsWith("~/")) return normalize(join(home, set.slice(2)));
  return isAbsolute(set) ? normalize(set) : undefined;
}

/** Reads a file's text, or undefined when it doesn't exist. */
export type TextReader = (path: string) => string | undefined;

const readIfPresent: TextReader = (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);

/** A DNS name: dot-separated labels of letters, digits and inner hyphens, the shape the collector accepts for `identity.emailDomain`. */
const DNS_NAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * An org profile `identity.emailDomain` value as the collector uses it for
 * co-author emails: trimmed and lowercased. Undefined for anything the
 * collector refuses (a non-string, a blank, a leading `@`, a value that is
 * not a DNS name) and for a leading `.`, which the collector keeps but no
 * email address is at.
 */
export function profileEmailDomain(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const d = value.trim();
  return DNS_NAME.test(d) ? d.toLowerCase() : undefined;
}

/**
 * The org profile's `identity.emailDomain` (profileEmailDomain), or undefined
 * when there is no profile file, it can't be read or parsed, or the domain is
 * one the collector refuses. The rest of the file is not checked here: the
 * collector refuses to start on a profile with any error, and a merge lands
 * only through the running collector (CollectorClient.mergeActor).
 */
export function orgProfileEmailDomain(
  env: Record<string, string | undefined>,
  opts: { home?: string; read?: TextReader } = {}
): string | undefined {
  const path = orgProfileFile(env, opts.home);
  if (!path) return undefined;
  let raw: unknown;
  try {
    const text = (opts.read ?? readIfPresent)(path);
    if (text === undefined) return undefined;
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const identity = isRecord(raw) ? raw.identity : undefined;
  const domain = isRecord(identity) ? identity.emailDomain : undefined;
  return profileEmailDomain(domain);
}

/**
 * The identity email domain: SLACK_IDENTITY_EMAIL_DOMAIN when it is set
 * (normalizeEmailDomain), else the org profile's `identity.emailDomain`
 * (orgProfileEmailDomain). A set value decides on its own, so one that is not
 * a domain name (`none`, say) merges no one even when the org profile names a
 * domain.
 */
export function identityEmailDomainFrom(
  env: Record<string, string | undefined>,
  opts: { home?: string; read?: TextReader } = {}
): string | undefined {
  const own = emptyToUndefined(env.SLACK_IDENTITY_EMAIL_DOMAIN);
  if (own !== undefined) return normalizeEmailDomain(own);
  return orgProfileEmailDomain(env, opts);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The startup warning about the console URL: it is configured as something the
 * link builders refuse, or Persona users are listed without one at all and
 * their `login` DMs can't get a link. Undefined when nothing is wrong.
 */
export function consoleOriginWarning(
  env: Pick<SlackEnv, "personaUsers" | "consoleOrigin"> & Partial<Pick<SlackEnv, "consoleOriginUnusable">>
): string | undefined {
  if (env.consoleOrigin) return undefined;
  if (env.consoleOriginUnusable) {
    return "⚠️  STANDUP_WEB_URL / STANDUP_CONSOLE_ORIGIN is set to something unusable (it needs an http(s) URL with no query, fragment or credentials): `login` DMs get a link built from the raw value, and Persona's doc and review links stay relative.";
  }
  if (env.personaUsers.length === 0) return undefined;
  return "⚠️  SLACK_PERSONA_USERS is set but STANDUP_WEB_URL is not: `login` DMs get no sign-in link until STANDUP_WEB_URL names the console URL teammates reach.";
}

/**
 * A configured identity email domain, normalized (lowercased, no leading `@`),
 * or undefined when the value is empty or not a plain domain name.
 */
export function normalizeEmailDomain(value: string | undefined): string | undefined {
  const d = value?.trim().toLowerCase().replace(/^@/, "");
  if (!d) return undefined;
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(d) ? d : undefined;
}

/** Split a comma/space-separated env list into trimmed, non-empty entries. */
function parseList(v: string | undefined): string[] {
  return (v ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Parse `alias:U…` comma/space-separated pairs into an owner-alias → Slack-id
 * map. A malformed entry (missing side) is dropped rather than failing the load.
 * Exported so the wiring + tests share one definition of the map format.
 */
export function parseOwnerMap(v: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of parseList(v)) {
    const [alias, slackId] = pair.split(":");
    const a = alias?.trim();
    const id = slackId?.trim();
    if (a && id) map.set(a, id);
  }
  return map;
}

/**
 * The Slack user id for a session's owner actor, or undefined when it can't be
 * mapped. A `slack:U…` owner actor (a person already known by their Slack id —
 * e.g. one reconciled from answering in Slack) carries its id directly; any
 * other alias is looked up in the configured owner map. Pure + exported so the
 * wiring and its tests share one resolution.
 */
export function ownerSlackId(ownerActor: string, ownerMap: Map<string, string>): string | undefined {
  if (ownerActor.startsWith("slack:")) return ownerActor.slice("slack:".length).trim() || undefined;
  return ownerMap.get(ownerActor);
}

/** Derive ws://host:WS_PORT from the collector HTTP URL (WS_PORT defaults to 7778). */
function defaultWsUrl(collectorUrl: string): string {
  const wsPort = emptyToUndefined(process.env.WS_PORT) ?? "7778";
  try {
    const u = new URL(collectorUrl);
    return `ws://${u.hostname}:${wsPort}`;
  } catch {
    return `ws://127.0.0.1:${wsPort}`;
  }
}

function emptyToUndefined(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

/** Redact a token to a recognizable-but-safe prefix for log output. */
export function maskToken(token: string | undefined): string {
  if (!token) return "(unset)";
  const prefix = token.slice(0, token.indexOf("-") + 1) || token.slice(0, 5);
  return `${prefix}…${token.slice(-4)} (${token.length} chars)`;
}

/** Cheap shape check so a swapped bot/app token is caught before a confusing API error. */
export function looksLikeToken(token: string | undefined, expectedPrefix: "xoxb-" | "xapp-"): boolean {
  return !!token && token.startsWith(expectedPrefix);
}
