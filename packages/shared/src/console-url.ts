/**
 * The console's public base URL and the links built on it. The collector's
 * Persona doc tools and the Slack bridge both resolve it the same way, so a
 * link that works in the console works in Slack.
 */
import type { TunnelIdentity } from "./constants.js";

/** Console paths an agent's text may name, and so the only ones a surface resolves against the console. */
const CONSOLE_LINK_PREFIXES = ["/docs/", "/review/"] as const;

/** A path segment a URL resolves away, in the forms the URL parser reads as one. */
const DOT_SEGMENT = /^(?:\.|%2e|%2E){1,2}$/;

/**
 * Whether `path` is a console link an agent may hand out (`/docs/<id>`,
 * `/review/<id>`). A `.` or `..` segment makes it false, since resolving the
 * path would land somewhere else on the console.
 */
export function isConsoleLinkPath(path: string): boolean {
  if (!CONSOLE_LINK_PREFIXES.some((p) => path.startsWith(p) && path.length > p.length)) return false;
  return !path.split("/").some((segment) => DOT_SEGMENT.test(segment));
}

/**
 * `raw` as a console base URL — trimmed, without a trailing slash — when it is
 * an http(s) URL with no query, fragment, credentials or whitespace that the
 * URL parser accepts (so a bad port or host is refused too). A base may carry
 * a path (a console mounted under one). Anything else is undefined, so
 * callers fall back to a relative link rather than a broken absolute one.
 */
export function consoleBaseUrl(raw: string | undefined): string | undefined {
  const base = raw?.trim().replace(/\/+$/, "");
  if (!base || !/^https?:\/\/[^/?#\s@]+(?:\/[^?#\s]*)?$/i.test(base)) return undefined;
  try {
    if (!new URL(base).hostname) return undefined;
  } catch {
    return undefined;
  }
  return base;
}

/**
 * The console's public base URL from the environment: STANDUP_WEB_URL, else
 * STANDUP_CONSOLE_ORIGIN — the first that is usable, so a malformed value
 * doesn't mask a good one.
 */
export function consoleBaseUrlFromEnv(env: Record<string, string | undefined>): string | undefined {
  return consoleBaseUrl(env.STANDUP_WEB_URL) ?? consoleBaseUrl(env.STANDUP_CONSOLE_ORIGIN);
}

/** Where the console is served when nothing says otherwise: the web port on this machine. */
export const DEFAULT_CONSOLE_ORIGIN = "http://localhost:5173";

/**
 * The origin console sign-in links (scripts/console-login.ts) are built on:
 * the configured console URL (consoleBaseUrlFromEnv), else
 * DEFAULT_CONSOLE_ORIGIN.
 */
export function consoleOriginFromEnv(env: Record<string, string | undefined>): string {
  return consoleBaseUrlFromEnv(env) ?? DEFAULT_CONSOLE_ORIGIN;
}

/**
 * The DNS domain the configured tunnel provider serves tunnel hosts under
 * (STANDUP_TUNNEL_DOMAIN), lower-cased; undefined when none is configured or
 * it isn't a domain.
 */
export function tunnelDomainFromEnv(env: Record<string, string | undefined>): string | undefined {
  const domain = env.STANDUP_TUNNEL_DOMAIN?.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  return domain && /^(?:[a-z0-9-]+\.)+[a-z0-9-]+$/.test(domain) ? domain : undefined;
}

/**
 * Whether the tunnel service authenticates every request it forwards, as the
 * environment states it: STANDUP_TUNNEL_IDENTITY_HEADER names the header it
 * stamps with the authenticated user, and STANDUP_TUNNEL_UNAUTHENTICATED does
 * not also say it authenticates no one (the collector refuses that pair).
 * This reads the tunnel service, whichever process opened a tunnel through
 * it, so it does not look at STANDUP_TUNNEL_PROVIDER.
 */
export function tunnelAuthenticatesFromEnv(env: Record<string, string | undefined>): boolean {
  if (/^(?:1|true|yes)$/i.test(env.STANDUP_TUNNEL_UNAUTHENTICATED?.trim() ?? "")) return false;
  return /^[A-Za-z0-9-]+$/.test(env.STANDUP_TUNNEL_IDENTITY_HEADER?.trim() ?? "");
}

/**
 * The tunnel provider's identity settings as the environment states them, for
 * a process that can't resolve the collector's TunnelProvider (the console's
 * dev server), to hand to resolveIdentityHeader. Enabled for
 * `STANDUP_TUNNEL_PROVIDER=command`; it carries the
 * STANDUP_TUNNEL_IDENTITY_HEADER it stamps when the service authenticates
 * (tunnelAuthenticatesFromEnv), as the collector's command provider does.
 * The collector also disables a command provider whose open or URL template
 * doesn't validate. There the two read different headers, and a user channel
 * token the console forwards names a user the collector does not resolve from
 * its own header, so it grants nothing.
 */
export function tunnelIdentityFromEnv(env: Record<string, string | undefined>): TunnelIdentity {
  if (env.STANDUP_TUNNEL_PROVIDER?.trim().toLowerCase() !== "command") return { enabled: false };
  if (!tunnelAuthenticatesFromEnv(env)) return { enabled: true };
  return { enabled: true, identityHeader: env.STANDUP_TUNNEL_IDENTITY_HEADER!.trim().toLowerCase() };
}

/**
 * The Host headers the console's vite server (dev and preview) answers
 * besides localhost and IP addresses, which vite always allows: the host of
 * the configured console URL (consoleBaseUrlFromEnv), and any host under the
 * tunnel provider's domain (tunnelDomainFromEnv, in vite's leading-dot
 * subdomain form) when one is configured and its service authenticates every
 * request (tunnelAuthenticatesFromEnv) — then a tunnel name reaches the
 * console only through that service, so accepting its domain doesn't reopen
 * the DNS-rebinding hole vite's host check closes. A tunnel service that
 * authenticates no one gets no such pass; that is also why this is never
 * `true` (any host).
 */
export function consoleAllowedHosts(env: Record<string, string | undefined>): string[] {
  const hosts: string[] = [];
  const domain = tunnelAuthenticatesFromEnv(env) ? tunnelDomainFromEnv(env) : undefined;
  const base = consoleBaseUrlFromEnv(env);
  if (base) {
    const host = new URL(base).hostname.toLowerCase().replace(/\.$/, "");
    const underTunnels = !!domain && (host === domain || host.endsWith(`.${domain}`));
    if (!isLoopbackHost(host) && !underTunnels) hosts.push(host);
  }
  if (domain) hosts.push(`.${domain}`);
  return hosts;
}

/** Hosts only reachable from the machine the console runs on, so a link to one is useless anywhere else. */
export function isLoopbackHost(host: string): boolean {
  const h = host
    .toLowerCase()
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "[::1]" || h === "::1" || h === "0.0.0.0" || h === "[::]") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** `base` + `path` (a console path such as `/docs/<id>`), or `path` alone when `base` is unusable. */
export function consoleLink(base: string | undefined, path: string): string {
  const resolved = consoleBaseUrl(base);
  return resolved ? `${resolved}${path}` : path;
}
