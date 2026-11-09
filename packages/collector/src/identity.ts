import type { Context } from "hono";
import { getConnInfo } from "hono/bun";
import { defaultIdentityConfig, resolveIdentityHeader } from "@standup/shared";
import type { AuthMode, IdentityProviderConfig } from "@standup/shared";
import { hostUserAlias } from "./host-user.js";
import { activeTunnelProvider, resolveTunnelProvider, tunnelVouchesForHeader, type TunnelProvider } from "./tunnels/provider.js";

/**
 * The neutral identity for a request whose acting user can't be trusted. A
 * network-exposed collector must not silently attribute a header-less (or
 * untrusted-source) request to the host operator whose `~/.claude` credentials
 * every session runs under, so it resolves to this instead of `$USER`.
 */
export const ANONYMOUS_ALIAS = "anonymous";

/**
 * The acting alias for a request. An authenticating tunnel provider (one with an
 * `identityHeader`, see tunnels/provider.ts) AUTHENTICATES the connecting teammate
 * and stamps their alias in the identity header (see resolveIdentityHeader:
 * `STANDUP_IDENTITY_HEADER`, else the provider's own, else
 * `DEFAULT_IDENTITY_HEADER`); the tunnel guarantees that header and
 * strips any client-set copy, so on the tunnel (or a configured trusted proxy) it
 * is a verified, unforgeable identity. The
 * collector itself can't re-verify a header, so it honors it ONLY when the
 * request's source is trusted (`headerTrusted` — loopback, which the tunnel
 * forwards to while the tunnel provider vouches for the header, or a configured
 * trusted proxy). A header from an untrusted source resolves to the neutral
 * `anonymous`, on loopback too: a caller naming someone the collector can't
 * verify is not the host user. A header-less loopback request
 * (`sourceLoopback`) keeps the single-user default of the host user
 * (hostUserAlias: `$STANDUP_HOST_USER`, else `$USER`, else "local"), but a
 * header-less non-loopback request (a raw non-tunnel client) resolves to
 * `anonymous` rather than impersonating the host. Trimmed
 * so a stray-whitespace header can't fork a distinct identity. Pure so every trust
 * path is unit-testable without a live socket; the flags default to the loopback +
 * trusted case, leaving the default single-user tunnel deployment unchanged.
 * This is the identity trust model the scoped and write-gated paths stand on.
 */
export function resolveUserAlias(
  tunnelHeader: string | null | undefined,
  envUser: string | undefined = process.env.USER,
  headerTrusted = true,
  sourceLoopback = true
): string {
  const header = tunnelHeader?.trim();
  if (header) return headerTrusted ? header : ANONYMOUS_ALIAS;
  if (sourceLoopback) return hostUserAlias({ STANDUP_HOST_USER: process.env.STANDUP_HOST_USER, USER: envUser });
  return ANONYMOUS_ALIAS;
}

/** True when the collector is bound to a loopback address (the default). */
export function isLoopbackBind(bindHost: string | undefined): boolean {
  const h = bindHost?.trim();
  return !h || h === "127.0.0.1" || h === "::1" || h === "localhost";
}

/**
 * True for a loopback / same-host source address — and for an unknown one, so
 * an in-process request with no socket is treated as local. IPv4-mapped IPv6
 * loopback and the 127.0.0.0/8 block both count.
 */
export function isLoopbackAddress(addr: string | null | undefined): boolean {
  const a = addr?.trim();
  if (!a) return true;
  return (
    a === "::1" ||
    a === "localhost" ||
    a === "127.0.0.1" ||
    a === "::ffff:127.0.0.1" ||
    a.startsWith("127.")
  );
}

/**
 * The configured trusted-proxy source addresses — `STANDUP_TRUSTED_PROXIES`, a
 * comma-separated list. A request arriving from one of these is trusted to have
 * injected a genuine identity header (a real gateway in front that strips
 * client copies), the same as a loopback source; any other network source is
 * not, so its header is ignored.
 */
export function trustedProxyAddresses(
  raw: string | undefined = process.env.STANDUP_TRUSTED_PROXIES
): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The request's source address, or undefined when it can't be determined (an
 * in-process request has no socket). Never throws — a missing binding reads as
 * no address, which the trust checks treat as loopback/local.
 */
export function requestRemoteAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
}

/**
 * The source-trust decision for the identity header given a request's remote
 * address under `config`. The header is trusted from a loopback source (which
 * the tunnel forwards to) only while `config.loopbackIsTrusted` — false when the
 * tunnel provider doesn't vouch for the header (see
 * resolveIdentityConfigFromEnv) — or from a configured trusted proxy; a raw
 * non-tunnel source is not trusted to have set it. `loopback` also drives the
 * header-less fallback (host `$USER` on loopback, else `anonymous`). With no
 * `config`, the process-wide one from the environment and the active tunnel
 * provider applies. resolveIdentity gates on this, so the `/api/*` path
 * (actingAlias) and the WS upgrade path (ws.ts) gate the same way — the WS boot
 * path must not be a softer door than the REST one.
 */
export function tunnelHeaderTrust(
  remote: string | null | undefined,
  config: Pick<IdentityProviderConfig, "loopbackIsTrusted" | "trustedProxies"> = resolveIdentityConfigFromEnv()
): {
  loopback: boolean;
  headerTrusted: boolean;
} {
  const loopback = isLoopbackAddress(remote);
  const trimmedRemote = remote?.trim();
  const headerTrusted =
    (loopback && config.loopbackIsTrusted) ||
    (!!trimmedRemote && config.trustedProxies.includes(trimmedRemote));
  return { loopback, headerTrusted };
}

/**
 * The single identity-resolution seam an IdentityProviderConfig parameterizes —
 * `tunnelHeaderTrust` (source trust) and `resolveUserAlias` (identifier /
 * fallback) composed and driven by the config's header name + trust knobs, so the
 * `/api` path (actingAlias) and the WS upgrade path (ws.ts) resolve identity the
 * same way and cannot drift. The identifier header is trusted ONLY from a
 * loopback source (when `loopbackIsTrusted`) or a configured `trustedProxies`
 * address; a client-supplied header on a raw network bind is never trusted.
 * `user` is the resolved alias — the trusted identifier; undefined for an
 * identifier from an untrusted source (the anonymous case, which maps to no
 * user); else, with no identifier, the host `envUser` (or "local") on a
 * loopback source and undefined off it.
 * `authenticated` is true whenever a non-anonymous identity resolved. The
 * fallback decision is delegated to `resolveUserAlias` and the source decision to
 * `tunnelHeaderTrust`, so each has one source of truth. Pure (`getHeader`/`remoteAddress`/`envUser` are supplied) so every
 * trust path is unit-testable without a live socket.
 */
export function resolveIdentity(
  getHeader: (name: string) => string | null | undefined,
  remoteAddress: string | null | undefined,
  config: IdentityProviderConfig,
  envUser: string | undefined = process.env.USER
): { user?: string; authenticated: boolean } {
  const { loopback, headerTrusted } = tunnelHeaderTrust(remoteAddress, config);
  const identifier =
    config.userIdentifier.type === "http-header"
      ? getHeader(config.userIdentifier.header)
      : undefined;
  const alias = resolveUserAlias(identifier, envUser, headerTrusted, loopback);
  const authenticated = alias !== ANONYMOUS_ALIAS;
  return { user: authenticated ? alias : undefined, authenticated };
}

/**
 * Builds the process-wide IdentityProviderConfig from env, falling back to
 * `defaultIdentityConfig()` (the authenticating-tunnel instance) for every unset knob —
 * so with no env set the result reproduces today's behavior exactly. Overrides:
 * `STANDUP_IDENTITY_HEADER` renames the identifier header (unset, an enabled
 * tunnel provider's `identityHeader` names it), `STANDUP_IDENTITY_AUTH`
 * selects the auth mode (only `none` today), and the existing
 * `STANDUP_TRUSTED_PROXIES` seeds the trusted-proxy list. Resolved ONCE at
 * startup and threaded into both createServer and createWsServer so REST and WS
 * share one object.
 *
 * The identifier header is trusted on loopback only while the tunnel provider
 * (`tunnel`) vouches for it (tunnelVouchesForHeader): with a provider that
 * forwards unauthenticated requests to loopback, a header there may be anyone's,
 * so only a configured trusted proxy's is read, and a loopback request carrying
 * one resolves to `anonymous` (see resolveUserAlias).
 */
export function resolveIdentityConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  tunnel: TunnelProvider = env === process.env ? activeTunnelProvider() : resolveTunnelProvider(env, () => {})
): IdentityProviderConfig {
  const base = defaultIdentityConfig();
  // With no header set, the one an enabled authenticating tunnel stamps is the
  // identity: reading the built-in default instead would trust a header that
  // tunnel neither stamps nor strips. The console proxy resolves the same name.
  const identifierHeader = resolveIdentityHeader(env.STANDUP_IDENTITY_HEADER, tunnel);
  // Only `none` is a supported auth mode today; an unrecognized value resolves
  // to it (a future mode is an additive branch here) rather than failing boot.
  const requestedAuth = env.STANDUP_IDENTITY_AUTH?.trim() as AuthMode | undefined;
  const auth: AuthMode =
    requestedAuth && KNOWN_AUTH_MODES.includes(requestedAuth) ? requestedAuth : base.auth;
  return {
    auth,
    userIdentifier: {
      type: "http-header",
      header: identifierHeader,
    },
    trustedProxies: trustedProxyAddresses(env.STANDUP_TRUSTED_PROXIES),
    loopbackIsTrusted: base.loopbackIsTrusted && tunnelVouchesForHeader(tunnel, identifierHeader),
  };
}

/** The auth modes `resolveIdentityConfigFromEnv` accepts (see AuthMode). */
const KNOWN_AUTH_MODES: readonly AuthMode[] = ["none"];

/**
 * The acting alias for an `/api` request under an IdentityProviderConfig, with
 * the identifier header trusted only from a loopback or configured-trusted-proxy
 * source (see resolveIdentity). An explicit `override` (a body-supplied actor,
 * e.g. from Slack) is a separate, caller-chosen channel and honored as-is; the
 * identifier header is trust-gated against the request's network source so a raw
 * non-tunnel client cannot set it. createServer binds `config` and exposes this
 * as `actingAlias`, the name every `/api` call site uses.
 */
export function actingAliasFor(
  c: Context,
  config: IdentityProviderConfig,
  override?: string | null
): string {
  const explicit = override?.trim();
  if (explicit) return explicit;
  return (
    resolveIdentity(
      (name) => c.req.header(name),
      requestRemoteAddress(c),
      config,
      process.env.USER
    ).user ?? ANONYMOUS_ALIAS
  );
}

/**
 * The requesting user for a scope-routed retrieval, or undefined when no identity
 * resolved. Derived server-side from actingAlias (the tunnel-authenticated header
 * / host `$USER`), never from a client-supplied body field. The anonymous sentinel
 * (a raw non-tunnel source with no trusted header) maps to undefined so retrieval
 * falls back to global ∪ project — an unidentifiable caller gets no user-scoped
 * docs rather than someone else's.
 *
 * This drives a SOFT team ROUTING boundary, not a hard privacy wall. On an
 * authenticating tunnel (it authenticates the teammate and stamps the header,
 * which it guarantees), the resolved identity is the REAL caller — a teammate cannot
 * present a peer's alias — so the retrieval routes an agent to ITS OWN user's docs
 * plus project plus global. Per-user scope simply keeps one teammate's personal
 * notes from crowding another's default retrieval; it is not isolation, and the
 * permissive class-(b) browse paths deliberately let teammates read each other's
 * docs under the one-trusted-team model (see resolveAgentAudienceFor's DESIGN NOTE
 * in server.ts). The trust model is resolveUserAlias's.
 */
export function scopingUserFor(
  c: Context,
  config: IdentityProviderConfig,
  override?: string | null
): string | undefined {
  const alias = actingAliasFor(c, config, override);
  return alias === ANONYMOUS_ALIAS ? undefined : alias;
}

/**
 * Whether a request carries an AUTHENTICATED tunnel identity — the trust anchor
 * an audience-changing knowledge write stands on. It reuses the SAME server-side
 * identity decision every scoped path uses (scopingUser → actingAlias →
 * resolveIdentity), never a new trust source: an authenticating tunnel
 * authenticates the connecting teammate and stamps the identity header, and the
 * tunnel guarantees that header — a teammate cannot forge another's — so a
 * resolved (non-anonymous) identity is a real, verified user. On a single-user
 * loopback box the host `$USER` is that identity. Only a caller with NO
 * authenticated identity — a raw non-tunnel network bind where the header is
 * absent or arrives from an untrusted source — resolves to undefined here; that
 * is the sole case the optional STANDUP_WRITE_TOKEN fallback must cover. The
 * trust model is resolveUserAlias's.
 */
export function hasTrustedIdentityFor(c: Context, config: IdentityProviderConfig): boolean {
  return scopingUserFor(c, config) !== undefined;
}
