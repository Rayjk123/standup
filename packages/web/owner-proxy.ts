import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { resolveIdentityHeader } from "@standup/shared/constants";
import { consoleBaseUrlFromEnv, DEFAULT_CONSOLE_ORIGIN, isLoopbackHost, tunnelIdentityFromEnv } from "@standup/shared/console-url";
import {
  OWNER_TOKEN_HEADER,
  PERSONA_USER_HEADER,
  USER_CHANNEL_HEADER,
  ownerTokenPath,
  readOwnerToken,
  userChannelToken,
} from "@standup/shared/owner-token";

/*
 * The web console as an owner channel, for the owner's signed-in browser only.
 * The dev server's /api proxy adds the owner secret to a forwarded request only
 * when that request carries a valid `standup_owner` session cookie (and, if it
 * can change state, comes from the console's own origin); every other
 * request (a tunnel teammate, a page in another browser profile) is forwarded
 * without it, and any token header the client sent is stripped. The secret is
 * read server-side from the file the collector writes (<dataDir>/secrets/owner.token,
 * or STANDUP_OWNER_TOKEN_FILE) and the browser never sees it. The file is
 * re-read per request: the collector may create it after the dev server starts,
 * and a missing file just means no header — the collector then refuses
 * owner-only decisions. The /ws proxy applies the same rules to the WebSocket
 * upgrade (same-origin only), so the collector knows whose Persona frames a
 * socket may receive.
 *
 * Sign-in is stateless. `bun run scripts/console-login.ts` (which reads the
 * same file) prints a URL carrying a 10-minute login code,
 * `<expiryEpochSeconds>.<hmac-sha256(ownerToken, "login:" + expiry)>`. Opening
 * it makes the proxy verify the code and set a session cookie,
 * `<sessionId>.<hmac-sha256(ownerToken, "session:" + sessionId)>`, which is
 * valid for as long as the owner secret is unchanged. Only someone who can read
 * the owner secret file can mint either value.
 *
 * Other users sign in the same way, to direct their own Persona. The host runs
 * `bun run scripts/console-login.ts --user <alias>` (or the Slack bridge answers
 * a mapped user's `login` DM) for a URL whose 10-minute code is
 * `<expiryEpochSeconds>.<alias>.<hmac-sha256(ownerToken, "user-login:" + alias + ":" + expiry)>`.
 * Opening it sets a `standup_user` cookie,
 * `<alias>.<sessionId>.<hmac-sha256(ownerToken, "user-session:" + alias + ":" + sessionId)>`.
 * A forwarded /api request from that browser whose tunnel identity header names
 * the same alias then carries that user's channel token (`x-standup-user-token`,
 * see userChannelToken), never the owner secret. The cookie is honored only
 * alongside a matching tunnel identity, so a link opened by someone else signs
 * nobody in.
 */

/** Path the dev server answers the sign-in redirect on. */
export const LOGIN_PATH = "/__standup/login";

/** Name of the session cookie that marks the owner's signed-in browser. */
export const SESSION_COOKIE = "standup_owner";

/** Name of the session cookie that marks a user's signed-in browser. */
export const USER_SESSION_COOKIE = "standup_user";

/** How long a login code stays valid. */
export const LOGIN_CODE_TTL_SECONDS = 10 * 60;

/** How long the session cookie lives. */
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/** The default address of the dev server, for the printed sign-in URL. */
export { DEFAULT_CONSOLE_ORIGIN };

/** The aliases a user login code or session may name. */
const ALIAS_PATTERN = /^[a-z0-9._-]+$/i;

/** True when `alias` is a non-empty alias a user login may name. */
export function isValidAlias(alias: string | null | undefined): alias is string {
  return typeof alias === "string" && ALIAS_PATTERN.test(alias);
}

function hmacHex(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function requireAlias(alias: string): void {
  if (!isValidAlias(alias)) throw new Error(`invalid alias: ${JSON.stringify(alias)}`);
}

/** A login code valid until `ttlSeconds` after `nowMs`. */
export function mintLoginCode(ownerToken: string, nowMs: number = Date.now(), ttlSeconds: number = LOGIN_CODE_TTL_SECONDS): string {
  const expiry = String(Math.floor(nowMs / 1000) + ttlSeconds);
  return `${expiry}.${hmacHex(ownerToken, `login:${expiry}`)}`;
}

/** True when `code` was minted from `ownerToken` and has not expired. */
export function verifyLoginCode(ownerToken: string, code: string | null | undefined, nowMs: number = Date.now()): boolean {
  if (!code) return false;
  const dot = code.indexOf(".");
  if (dot <= 0) return false;
  const expiry = code.slice(0, dot);
  if (!/^\d+$/.test(expiry) || Number(expiry) * 1000 < nowMs) return false;
  return safeEqual(code.slice(dot + 1), hmacHex(ownerToken, `login:${expiry}`));
}

/** The sign-in URL `scripts/console-login.ts` prints and the dev server announces. */
export function loginUrl(ownerToken: string, origin: string = DEFAULT_CONSOLE_ORIGIN, nowMs: number = Date.now()): string {
  return `${origin}${LOGIN_PATH}?code=${mintLoginCode(ownerToken, nowMs)}`;
}

/** A login code for `alias`, valid until `ttlSeconds` after `nowMs`. Throws on an invalid alias. */
export function mintUserLoginCode(
  ownerToken: string,
  alias: string,
  nowMs: number = Date.now(),
  ttlSeconds: number = LOGIN_CODE_TTL_SECONDS,
): string {
  requireAlias(alias);
  const expiry = String(Math.floor(nowMs / 1000) + ttlSeconds);
  return `${expiry}.${alias}.${hmacHex(ownerToken, `user-login:${alias}:${expiry}`)}`;
}

/**
 * The alias a user login code signs in, or undefined when the code was not
 * minted from `ownerToken`, has expired or is malformed. The first segment is
 * the expiry, the last the MAC, and everything between is the alias (which may
 * itself contain dots).
 */
export function verifyUserLoginCode(ownerToken: string, code: string | null | undefined, nowMs: number = Date.now()): string | undefined {
  if (!code) return undefined;
  const first = code.indexOf(".");
  const last = code.lastIndexOf(".");
  if (first <= 0 || last <= first + 1) return undefined;
  const expiry = code.slice(0, first);
  const alias = code.slice(first + 1, last);
  if (!/^\d+$/.test(expiry) || Number(expiry) * 1000 < nowMs || !isValidAlias(alias)) return undefined;
  return safeEqual(code.slice(last + 1), hmacHex(ownerToken, `user-login:${alias}:${expiry}`)) ? alias : undefined;
}

/** The sign-in URL the host sends a user (`scripts/console-login.ts --user <alias>`). Throws on an invalid alias. */
export function userLoginUrl(ownerToken: string, alias: string, origin: string = DEFAULT_CONSOLE_ORIGIN, nowMs: number = Date.now()): string {
  return `${origin}${LOGIN_PATH}?code=${mintUserLoginCode(ownerToken, alias, nowMs)}`;
}

/** A fresh session cookie value, signed with `ownerToken`. */
export function mintSessionValue(ownerToken: string, sessionId: string = randomBytes(16).toString("hex")): string {
  return `${sessionId}.${hmacHex(ownerToken, `session:${sessionId}`)}`;
}

/** True when `value` is a session cookie value signed with `ownerToken`. */
export function verifySessionValue(ownerToken: string, value: string | null | undefined): boolean {
  if (!value) return false;
  const dot = value.indexOf(".");
  if (dot <= 0) return false;
  return safeEqual(value.slice(dot + 1), hmacHex(ownerToken, `session:${value.slice(0, dot)}`));
}

/** A fresh user session cookie value for `alias`, signed with `ownerToken`. Throws on an invalid alias. */
export function mintUserSessionValue(ownerToken: string, alias: string, sessionId: string = randomBytes(16).toString("hex")): string {
  requireAlias(alias);
  return `${alias}.${sessionId}.${hmacHex(ownerToken, `user-session:${alias}:${sessionId}`)}`;
}

/**
 * The alias a user session cookie value signs in, or undefined when it was not
 * signed with `ownerToken`. The last segment is the MAC, the one before it the
 * session id, and everything before that the alias.
 */
export function verifyUserSessionValue(ownerToken: string, value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const last = value.lastIndexOf(".");
  if (last <= 0) return undefined;
  const middle = value.lastIndexOf(".", last - 1);
  if (middle <= 0 || middle === last - 1) return undefined;
  const alias = value.slice(0, middle);
  if (!isValidAlias(alias)) return undefined;
  const mac = hmacHex(ownerToken, `user-session:${alias}:${value.slice(middle + 1, last)}`);
  return safeEqual(value.slice(last + 1), mac) ? alias : undefined;
}

/**
 * `scripts/console-login.ts`'s arguments: none signs the owner in; `--user
 * <alias>` or `--user=<alias>` mints a link for that user. A missing value
 * (end of argv, or another flag in its place) or an invalid alias is an error.
 */
export function parseConsoleLoginArgs(argv: readonly string[]): { user?: string } | { error: string } {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    let value: string | undefined;
    if (arg === "--user") {
      const next = argv[i + 1];
      value = next === undefined || next.startsWith("-") ? "" : next;
    } else if (arg.startsWith("--user=")) {
      value = arg.slice("--user=".length);
    } else continue;
    const user = value.trim();
    if (!user) return { error: "--user needs an alias" };
    if (!isValidAlias(user)) {
      return { error: `--user needs an alias of letters, digits, '.', '_' or '-' (got ${JSON.stringify(user)})` };
    }
    return { user };
  }
  return {};
}

/** The `Set-Cookie` header that signs the browser in. */
export function sessionCookieHeader(value: string): string {
  return `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
}

/**
 * The `Set-Cookie` header that signs a user's browser in. SameSite=Lax so the
 * login link, opened from Slack or mail, lands signed in; state-changing calls
 * are still held to the same-origin check.
 */
export function userSessionCookieHeader(value: string): string {
  return `${USER_SESSION_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
}

/** The value of cookie `name` in a `Cookie` request header, if present. */
export function readCookie(header: string | string[] | undefined, name: string): string | undefined {
  const raw = Array.isArray(header) ? header.join(";") : header;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** The slice of an outgoing proxy request the header is set on. */
export interface ProxiedRequest {
  setHeader(name: string, value: string): void;
  removeHeader(name: string): void;
}

/** The slice of the incoming browser request the session cookie is read from. */
export interface IncomingRequest {
  method?: string;
  headers: {
    cookie?: string | string[] | undefined;
    host?: string | undefined;
    origin?: string | string[] | undefined;
    "sec-fetch-site"?: string | string[] | undefined;
    [name: string]: string | string[] | undefined;
  };
}

/** Methods that only read, so a cross-site caller can't change state through them. */
const SAFE_METHODS = new Set(["GET", "HEAD"]);

/**
 * True when a state-changing request came from the console's own page: the
 * browser marked it `Sec-Fetch-Site: same-origin`, or its `Origin` is the host
 * the request was addressed to. A cross-site page can ride the session cookie
 * only on requests that fail this check.
 *
 * On a WebSocket upgrade the `Origin` may also match `X-Forwarded-Host`. A
 * tunnel that rewrites `Host` to `localhost:<port>` names the public host
 * there, and Chromium sends no `Sec-Fetch-Site` on an upgrade, so the
 * console's own socket through the tunnel is same-origin only by that match.
 * A page can set no header on a WebSocket, and a fetch can't claim to be an
 * upgrade (`Upgrade` is a forbidden header), so only a proxy sets it there. A
 * forwarded host with several values (a proxy appended to one a client sent)
 * is not trusted.
 */
export function isSameOrigin(headers: IncomingRequest["headers"]): boolean {
  if (headers["sec-fetch-site"] === "same-origin") return true;
  const origin = headers.origin;
  if (typeof origin !== "string" || !headers.host) return false;
  const upgrade = headers.upgrade;
  const forwarded = typeof upgrade === "string" && upgrade.toLowerCase() === "websocket" ? headers["x-forwarded-host"] : undefined;
  const hosts = [headers.host, ...(typeof forwarded === "string" && !forwarded.includes(",") ? [forwarded.trim().toLowerCase()] : [])];
  try {
    return hosts.includes(new URL(origin).host);
  } catch {
    return false;
  }
}

/** True when `req` only reads, or comes from the console's own origin. */
function mayChangeState(req: IncomingRequest): boolean {
  return SAFE_METHODS.has((req.method ?? "GET").toUpperCase()) || isSameOrigin(req.headers);
}

/**
 * The owner token to forward with `req`, or undefined when it must go without:
 * the browser needs a session cookie signed with `token`, and a request that
 * can change state must also be same-origin.
 */
export function ownerTokenFor(token: string | undefined, req: IncomingRequest): string | undefined {
  if (!token) return undefined;
  if (!verifySessionValue(token, readCookie(req.headers.cookie, SESSION_COOKIE))) return undefined;
  if (!mayChangeState(req)) return undefined;
  return token;
}

/**
 * Whether `host` (the `Host` the browser sent) names the console: a name
 * Vite's default host check admits (a loopback name, `*.localhost`, an IP
 * literal) or the host of the console's public URL. Vite checks `Host` on
 * HTTP requests but not on proxied WebSocket upgrades, so a page whose DNS
 * name rebinds to this machine reaches the /ws proxy under its own name.
 * A name added to Vite's `server.allowedHosts` must also be the console's
 * public URL (STANDUP_WEB_URL), or its browser writes and sockets are refused.
 */
export function isConsoleHost(host: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!host) return false;
  const name = host.trim().toLowerCase();
  const hostname = name.replace(/:\d+$/, "");
  if (isLoopbackHost(name) || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || /^\[[0-9a-f:.]+\]$/.test(hostname)) return true;
  const base = consoleBaseUrlFromEnv(env);
  return !!base && new URL(base).host === name;
}

/**
 * Adjusts the headers the collector's caller guard judges a browser request
 * by, once the proxy has rewritten `Host` to the collector's address:
 *  - under a name the console doesn't serve (isConsoleHost: a page whose DNS
 *    name rebinds here), `Sec-Fetch-Site` is dropped, since `same-origin`
 *    there means the page's own origin, so the guard judges the `Origin`
 *    the page sent and refuses it;
 *  - from the console's own page (isSameOrigin), `Origin` is dropped, since
 *    the collector can no longer match it to `Host` and some browsers send
 *    no `Sec-Fetch-Site` on a WebSocket upgrade.
 * Any other request keeps both, and the guard refuses a foreign `Origin`.
 */
export function dropSameOriginOrigin(proxyReq: ProxiedRequest, req: IncomingRequest): void {
  if (!isConsoleHost(req.headers.host)) proxyReq.removeHeader("sec-fetch-site");
  else if (isSameOrigin(req.headers)) proxyReq.removeHeader("origin");
}

/** Sets the owner-token header to `token`, or strips any the client sent when there is none. */
export function applyOwnerToken(proxyReq: ProxiedRequest, token: string | undefined): void {
  if (token) proxyReq.setHeader(OWNER_TOKEN_HEADER, token);
  else proxyReq.removeHeader(OWNER_TOKEN_HEADER);
}

/**
 * The header the tunnel names the connecting user in, resolved as the collector
 * resolves it (resolveIdentityHeader, with the provider tunnelIdentityFromEnv
 * reads): `STANDUP_IDENTITY_HEADER` when set, else the header an
 * authenticating command tunnel stamps (`STANDUP_TUNNEL_IDENTITY_HEADER`),
 * else `DEFAULT_IDENTITY_HEADER`. Lower-cased, as node keys incoming headers.
 */
export function identityHeaderName(env: NodeJS.ProcessEnv = process.env): string {
  return resolveIdentityHeader(env.STANDUP_IDENTITY_HEADER, tunnelIdentityFromEnv(env));
}

/**
 * The user channel token to forward with `req`, or undefined when it must go
 * without: the browser needs a user session cookie signed with `token` whose
 * alias equals the request's tunnel identity, and a request that can change
 * state must also be same-origin.
 */
export function userChannelTokenFor(
  token: string | undefined,
  req: IncomingRequest,
  identityHeader: string = identityHeaderName(),
): string | undefined {
  if (!token) return undefined;
  const alias = verifyUserSessionValue(token, readCookie(req.headers.cookie, USER_SESSION_COOKIE));
  if (!alias) return undefined;
  const identity = req.headers[identityHeader.toLowerCase()];
  if (typeof identity !== "string" || identity.trim() !== alias) return undefined;
  if (!mayChangeState(req)) return undefined;
  return userChannelToken(token, alias);
}

/**
 * Sets the user channel header to `userToken`, or strips any the client sent
 * when there is none. A client-sent "speaking for this user" header is always
 * stripped: the browser is never an owner channel speaking for someone else.
 */
export function applyUserChannel(proxyReq: ProxiedRequest, userToken: string | undefined): void {
  proxyReq.removeHeader(PERSONA_USER_HEADER);
  if (userToken) proxyReq.setHeader(USER_CHANNEL_HEADER, userToken);
  else proxyReq.removeHeader(USER_CHANNEL_HEADER);
}

/** The emitter vite hands a proxy's `configure` hook. */
export interface ProxyEmitter {
  on(event: "proxyReq", listener: (proxyReq: ProxiedRequest, req: IncomingRequest) => void): unknown;
}

/**
 * A vite proxy `configure` hook that adds the owner token to a forwarded
 * request only when `ownerTokenFor` allows it, and a user channel token only
 * when `userChannelTokenFor` does.
 */
export function ownerTokenProxyConfigure(
  read: () => string | undefined = () => readOwnerToken(ownerTokenPath()),
  identityHeader: string = identityHeaderName(),
) {
  return (proxy: ProxyEmitter): void => {
    proxy.on("proxyReq", (proxyReq, req) => {
      const token = read();
      applyOwnerToken(proxyReq, ownerTokenFor(token, req));
      applyUserChannel(proxyReq, userChannelTokenFor(token, req, identityHeader));
      dropSameOriginOrigin(proxyReq, req);
    });
  };
}

/** The channel tokens a WebSocket upgrade is forwarded with; either may be absent. */
export interface UpgradeTokens {
  owner?: string;
  user?: string;
}

/**
 * The channel tokens to forward with a WebSocket upgrade: the owner token for
 * a valid owner session cookie, the user's channel token for a valid user
 * session cookie whose alias is the tunnel identity. The upgrade is a GET, but
 * it opens a socket that streams Persona frames, so it is held to the
 * same-origin check a write is: a page on another origin gets neither token.
 */
export function upgradeTokensFor(
  token: string | undefined,
  req: IncomingRequest,
  identityHeader: string = identityHeaderName(),
): UpgradeTokens {
  if (!token || !isSameOrigin(req.headers)) return {};
  const owner = ownerTokenFor(token, req);
  const user = userChannelTokenFor(token, req, identityHeader);
  return { ...(owner ? { owner } : {}), ...(user ? { user } : {}) };
}

/** The emitter vite hands a WebSocket proxy's `configure` hook. */
export interface WsProxyEmitter {
  on(event: "proxyReqWs", listener: (proxyReq: ProxiedRequest, req: IncomingRequest) => void): unknown;
}

/**
 * A vite proxy `configure` hook for the collector's WebSocket: each upgrade
 * carries the tokens `upgradeTokensFor` allows, and any owner, user-channel or
 * persona-user header the client sent is stripped.
 */
export function ownerTokenWsProxyConfigure(
  read: () => string | undefined = () => readOwnerToken(ownerTokenPath()),
  identityHeader: string = identityHeaderName(),
) {
  return (proxy: WsProxyEmitter): void => {
    proxy.on("proxyReqWs", (proxyReq, req) => {
      const tokens = upgradeTokensFor(read(), req, identityHeader);
      applyOwnerToken(proxyReq, tokens.owner);
      applyUserChannel(proxyReq, tokens.user);
      dropSameOriginOrigin(proxyReq, req);
    });
  };
}

/** The slice of a node HTTP request/response the login middleware uses. */
export interface LoginRequest {
  url?: string;
}
export interface LoginResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(body?: string): unknown;
}

/**
 * Connect middleware answering `LOGIN_PATH`: a valid, unexpired owner `code`
 * sets the owner session cookie and a valid user code sets that user's session
 * cookie, each redirecting to `/`; anything else is refused. Other paths fall
 * through.
 */
export function loginMiddleware(
  read: () => string | undefined = () => readOwnerToken(ownerTokenPath()),
  now: () => number = Date.now,
) {
  return (req: LoginRequest, res: LoginResponse, next: () => void): void => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== LOGIN_PATH) return next();
    const reply = (status: number, body: string): void => {
      res.statusCode = status;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.end(body);
    };
    const token = read();
    if (!token) return reply(503, "No owner token file yet: start the collector, then run `bun run scripts/console-login.ts`.\n");
    const code = url.searchParams.get("code");
    let cookie: string;
    if (verifyLoginCode(token, code, now())) {
      cookie = sessionCookieHeader(mintSessionValue(token));
    } else {
      const alias = verifyUserLoginCode(token, code, now());
      if (!alias) {
        return reply(
          403,
          "Login code is invalid or expired: run `bun run scripts/console-login.ts` (or ask the host for a fresh `--user` link).\n",
        );
      }
      cookie = userSessionCookieHeader(mintUserSessionValue(token, alias));
    }
    res.statusCode = 302;
    res.setHeader("set-cookie", cookie);
    res.setHeader("cache-control", "no-store");
    res.setHeader("location", "/");
    res.end();
  };
}
