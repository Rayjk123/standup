import type { Context, MiddlewareHandler } from "hono";
import { SHARE_API_ROOT, consoleBaseUrlFromEnv } from "@standup/shared";
import { isLoopbackAddress, requestRemoteAddress } from "./identity.js";
import { isAllowedHost, requestHost } from "./persona/routes.js";

/*
 * The checks every collector route runs before its handler (callerGuard),
 * against a page in the owner's browser and a caller off this machine:
 *  1. Host. The request's `Host` must name this collector (isAllowedHost:
 *     a loopback name, the bind address, or a STANDUP_ALLOWED_HOSTS entry).
 *     A foreign site that rebinds its DNS name to 127.0.0.1 still sends its
 *     own name, so it is refused.
 *  2. Site. A browser request must come from the collector's own origin or the
 *     console: `Sec-Fetch-Site` same-origin or none (typed or bookmarked), or,
 *     for a cross-origin request, an `Origin` the collector serves the console
 *     to (TRUSTED_ORIGINS, the console's public URL). A browser that sends no
 *     `Sec-Fetch-Site` is judged by `Origin` alone. A cross-site top-level
 *     navigation to a GET passes: the page that started it can't read the
 *     answer, and links to the console's routes open from Slack and code reviews.
 *     A request with neither header is not a browser's and passes.
 *  3. Credential. A request that doesn't come from this machine must carry a
 *     proof the route's callers already send (hasCredential): the owner or a
 *     user's token from the console's proxy, Persona's token, the write or
 *     worker token from a worker's MCP server, a trusted proxy's identity, or
 *     on /hook a live launch's hook token. A local request needs none here; each
 *     route still applies its own checks.
 * The console's dev server proxies /api and /ws from this machine and sets
 * `Host` to the loopback address it dials, so a request through it passes the
 * first and last checks. The site check reads the browser's own headers,
 * which it forwards, except that it drops `Origin` from the console's own
 * same-origin requests, which the rewritten `Host` would otherwise fail, and
 * `Sec-Fetch-Site` under a Host the console doesn't serve, so a rebinding
 * page's /ws upgrade (which Vite doesn't host-check) is judged by its
 * `Origin` (dropSameOriginOrigin in packages/web/owner-proxy.ts). The gateway keeps the client's `Host`, so a name that reaches the
 * collector's port through it must be loopback or in STANDUP_ALLOWED_HOSTS.
 */

/** A route callerGuard lets through without some of its checks, and why. */
export interface OpenRoute {
  method: string;
  /** The route's pattern exactly as it is registered. */
  path: string;
  /** `all`: no check runs. `credential`: the Host and site checks still run. */
  skips: "all" | "credential";
  why: string;
}

/** The routes callerGuard opens. Every other registered route runs all three checks. */
export const OPEN_ROUTES: readonly OpenRoute[] = [
  {
    method: "GET",
    path: "/health",
    skips: "all",
    why: "the gateway and the restart supervisor probe it under whatever name they dial, with no credential; it answers only the pid and leadership term",
  },
  {
    method: "GET",
    path: `${SHARE_API_ROOT}:segment/:token`,
    skips: "credential",
    why: "a share link is read by anyone it was sent to; the share token in the path is its credential (share/routes.ts)",
  },
  {
    method: "GET",
    path: `${SHARE_API_ROOT}:segment/:token/docs/:docId`,
    skips: "credential",
    why: "a doc inside a shared folder, read through the folder's share link; the share token in the path is its credential",
  },
  {
    method: "GET",
    path: `${SHARE_API_ROOT}:segment/:token/media/:mediaId`,
    skips: "credential",
    why: "an image or video a share link shows; the share token in the path is its credential",
  },
];

/** The error a refusal of each check answers, so a caller and a test can tell them apart. */
export const CALLER_GUARD_ERRORS = {
  host: "refused: this Host does not name this collector; add it to STANDUP_ALLOWED_HOSTS (comma-separated host[:port]) to reach the collector through it",
  site: "refused: a cross-site browser request; use the Standup console",
  credential:
    "refused: a request from another machine needs a Standup credential (the console's sign-in, a worker's or Persona's token)",
} as const;

/** What the checks read of a request, from an HTTP route's Context or a WebSocket upgrade. */
export interface GuardedRequest {
  method: string;
  path: string;
  /** The `Host` it names. */
  host: string;
  header: (name: string) => string | undefined;
  /** Its source address; undefined for an in-process request. */
  remote: string | undefined;
}

/** Cross-origin browser origins the collector admits (the Vite dev server). */
export const CORS_ORIGINS: readonly string[] = ["http://localhost:5173"];

export interface CallerGuardOptions {
  /** Origins admitted cross-origin besides the console's public URL; CORS_ORIGINS by default. */
  trustedOrigins?: readonly string[];
  /** The console's public URL (STANDUP_WEB_URL, else STANDUP_CONSOLE_ORIGIN); read per request by default. */
  consoleUrl?: () => string | undefined;
  /** The collector's bind address (STANDUP_BIND_HOST); read per request by default. */
  bindHost?: () => string | undefined;
}

const SAFE_METHODS = new Set(["GET", "HEAD"]);

/** The origin of `url` (`scheme://host[:port]`), or null when it isn't a URL. */
function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.origin === "null" ? null : parsed.origin;
  } catch {
    return null;
  }
}

/** Whether `origin` (an `Origin` header) is the request's own host or an origin the collector admits. */
function isTrustedOrigin(req: GuardedRequest, origin: string, opts: CallerGuardOptions): boolean {
  const own = originOf(origin);
  if (!own) return false;
  if (new URL(own).host === req.host.trim().toLowerCase()) return true;
  if ((opts.trustedOrigins ?? CORS_ORIGINS).includes(own)) return true;
  const consoleUrl = (opts.consoleUrl ?? (() => consoleBaseUrlFromEnv(process.env)))();
  return !!consoleUrl && originOf(consoleUrl) === own;
}

/** Whether the request is a browser's from a page on another origin the collector doesn't admit. */
function isCrossSiteRequest(req: GuardedRequest, opts: CallerGuardOptions): boolean {
  const site = req.header("sec-fetch-site")?.trim().toLowerCase();
  const origin = req.header("origin");
  if (site === "same-origin" || site === "none") return false;
  if (site) {
    if (SAFE_METHODS.has(req.method) && req.header("sec-fetch-mode")?.trim().toLowerCase() === "navigate") return false;
    return !(origin !== undefined && isTrustedOrigin(req, origin, opts));
  }
  return origin !== undefined && !isTrustedOrigin(req, origin, opts);
}

/**
 * Whether the request comes from this machine: a loopback source (or none, an
 * in-process request), or the collector's own specific bind address, which
 * its local callers dial when it listens on one.
 */
function isLocalRequest(remote: string | undefined, bindHost: string | undefined): boolean {
  if (isLoopbackAddress(remote)) return true;
  const bound = bindHost?.trim().replace(/^\[|\]$/g, "").toLowerCase();
  const source = remote?.trim().replace(/^::ffff:/, "").toLowerCase();
  return !!bound && bound !== "0.0.0.0" && bound !== "::" && source === bound;
}

/** Each open route's pattern as a regex over the request path (`:name` matches one segment). */
const OPEN_ROUTE_PATTERNS = OPEN_ROUTES.map((route) => ({
  route,
  regex: new RegExp(`^${route.path.split(/(:[A-Za-z]+)/).map((part) => (part.startsWith(":") ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("")}$`),
}));

/** The open route `req` is for, if any. */
function openRouteOf(req: GuardedRequest): OpenRoute | undefined {
  // Hono answers HEAD with a GET route.
  const method = req.method === "HEAD" ? "GET" : req.method;
  return OPEN_ROUTE_PATTERNS.find((p) => p.route.method === method && p.regex.test(req.path))?.route;
}

export type CallerGuardCheck = keyof typeof CALLER_GUARD_ERRORS;

/**
 * Which check refuses the request, or null when it may go on. `hasCredential`
 * says whether it carries a proof one of the collector's callers sends (see
 * the comment above); it is asked only of a request from another machine.
 */
export function callerGuardRefusal(
  req: GuardedRequest,
  hasCredential: () => boolean,
  opts: CallerGuardOptions
): CallerGuardCheck | null {
  const open = openRouteOf(req);
  if (open?.skips === "all") return null;
  const bindHost = (opts.bindHost ?? (() => process.env.STANDUP_BIND_HOST))();
  if (!isAllowedHost(req.host, undefined, bindHost)) return "host";
  if (isCrossSiteRequest(req, opts)) return "site";
  if (open?.skips === "credential") return null;
  if (!isLocalRequest(req.remote, bindHost) && !hasCredential()) return "credential";
  return null;
}

/** The middleware that runs callerGuardRefusal ahead of every route: a refused request gets a 403 naming the check. */
export function callerGuard(opts: CallerGuardOptions & { hasCredential: (c: Context) => boolean }): MiddlewareHandler {
  return async (c, next) => {
    const req: GuardedRequest = {
      method: c.req.method,
      path: c.req.path,
      host: requestHost(c),
      header: (name) => c.req.header(name),
      remote: requestRemoteAddress(c),
    };
    const refused = callerGuardRefusal(req, () => opts.hasCredential(c), opts);
    if (refused) return c.json({ error: CALLER_GUARD_ERRORS[refused] }, 403);
    await next();
  };
}
