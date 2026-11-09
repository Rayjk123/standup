import { splitCommand } from "@standup/shared";
import { scrubSecretEnv } from "../owner-secret.js";

/**
 * The tunnel seam: how a loopback port is shared over HTTPS with the people
 * who review a change (a review tunnel to a branch build) and how a worker's
 * hand-opened tunnels are found again to clean them up.
 *
 * A provider composes the command that opens a tunnel; the collector spawns
 * it itself, in its own process group, never through a worker's shell. The
 * built-in default is `disabledTunnelProvider`: no tunnel opens, and review
 * sharing falls back to the review packet alone. `commandTunnelProvider`
 * drives any tunnel CLI from templates (see resolveTunnelProvider).
 */

/** One tunnel the service reports for this host user. */
export interface ListedTunnel {
  /** The full tunnel name (`<host user>-<suffix>`). */
  name: string;
  pid?: number;
  localPort?: number;
  hostname?: string;
}

/** What a tunnel is opened for: the loopback port and the name suffix (the provider's CLI prefixes the host user). */
export interface TunnelOpenRequest {
  port: number;
  suffix: string;
  /** Where the tunnel is served from, when the service has regions. */
  region?: string;
  /**
   * Who may reach the tunnel, in the service's own syntax. Unset or blank
   * means its owner alone: a command provider fills `{allow}` with its
   * owner-only audience (CommandTunnelConfig.ownerAllow), which
   * resolveTunnelProvider requires whenever the create template has `{allow}`.
   * A create template without `{allow}` can pass no audience: its tunnels
   * take the one the template itself sets, which must be its owner alone,
   * and a request naming an audience opens nothing rather than a tunnel
   * that audience can't reach or that others can.
   */
  allow?: string;
}

export interface TunnelProvider {
  /** `disabled`, `command`, or a custom provider's id. */
  readonly id: string;
  /** False when no tunnel can open (the built-in default). */
  readonly enabled: boolean;
  /** Why tunnels can't open, shown where one was wanted. */
  readonly disabledReason?: string;
  /**
   * DNS domain the provider's tunnel hosts are served under, when it has one:
   * the console answers hosts under it, and Standup's own tunnel there counts
   * as Standup's API to the safety floor.
   */
  readonly domain?: string;
  /**
   * The request header the tunnel service sets, on every request it
   * forwards, to the user it authenticated — after removing any copy the
   * client sent. Only then is that header, arriving on loopback (where the
   * tunnel forwards to), a verified identity (see tunnelVouchesForHeader).
   * Unset on an enabled provider: the service authenticates no one, so a
   * request it forwards may come from anyone and carry any header.
   */
  readonly identityHeader?: string;
  /**
   * The argv that serves 127.0.0.1:`port` as tunnel `<host user>-<suffix>`;
   * null when this provider opens none, or can't give the tunnel the
   * audience the request names.
   */
  createArgv(req: TunnelOpenRequest): string[] | null;
  /**
   * Why this provider can't give a tunnel the audience `allow` names (see
   * TunnelOpenRequest.allow); undefined when it can, or when `allow` is unset
   * or blank. Lets a caller refuse before it starts any work for a tunnel
   * that createArgv would refuse. Absent: every audience can be passed.
   */
  audienceProblem?(allow: string | undefined): string | undefined;
  /** The public URL of the tunnel named `name` (`<host user>-<suffix>`); empty when this provider opens none. */
  url(name: string): string;
  /** The tunnels the service runs for this host user; null when it can't be asked. */
  list(): Promise<ListedTunnel[] | null>;
}

/** The built-in default: no tunnels. Nothing opens and nothing is listed. */
export const disabledTunnelProvider: TunnelProvider = {
  id: "disabled",
  enabled: false,
  disabledReason: "no tunnel provider is configured (STANDUP_TUNNEL_PROVIDER)",
  createArgv: () => null,
  url: () => "",
  list: async () => [],
};

/** A command tunnel provider's templates (see commandTunnelProvider). */
export interface CommandTunnelConfig {
  /**
   * The command that opens a tunnel, split into argv like a shell's plain
   * words and never run through a shell. `{port}` and `{name}` (the suffix)
   * are required; `{region}` and `{allow}` are optional — when one has no
   * value its word is dropped, and so is the option word just before it
   * when the token's word is that option's value (`--region {region}`); in
   * the joined form (`--region={region}`) only that word goes. A bare token
   * right after a literal flag that takes no value (`--private {region}`)
   * reads as that flag's value, so the flag is dropped with it: put optional
   * bare tokens before such flags, or use the joined form. A request with no
   * audience fills `{allow}` with `ownerAllow`. A template without `{allow}`
   * passes no audience: the template itself must open owner-only tunnels,
   * and a request naming an audience opens nothing.
   */
  create: string;
  /**
   * The `{allow}` value, in the service's syntax, that admits the tunnel's
   * owner alone; it fills `{allow}` when a request names no audience.
   * commandTunnelConfigProblems requires it when `create` has `{allow}`, so
   * a blank audience never falls through to the CLI's default, and refuses
   * it when `create` has none, where it would never be passed.
   */
  ownerAllow?: string;
  /** The tunnel's public URL, `{name}` being the full tunnel name: `https://{name}.tunnels.example.com`. */
  url: string;
  /**
   * The command that lists the host user's tunnels as JSON: an array (or a
   * `tunnels` array) of `{name|tunnelName, pid?, localPort?, hostname?}`,
   * the numbers optionally under `meta`. Absent: tunnels can't be listed, so
   * leaked ones are left alone.
   */
  list?: string;
  /** The DNS domain the tunnel hosts are under (see TunnelProvider.domain). */
  domain?: string;
  /** The header the tunnel service stamps with the user it authenticated (see TunnelProvider.identityHeader). */
  identityHeader?: string;
  /**
   * The owner's acknowledgment that the tunnel service authenticates no one
   * (no identityHeader): a command provider needs one or the other.
   */
  unauthenticated?: boolean;
}

/**
 * Whether `provider` leaves `header` (the identity header the collector
 * reads) as trustworthy on loopback as it is with no tunnel: true when no
 * tunnel opens, or when the provider's service authenticates every request
 * and stamps exactly that header. A provider that forwards unauthenticated
 * requests to loopback would otherwise let anyone who reaches a tunnel name
 * themselves as any user.
 */
export function tunnelVouchesForHeader(provider: TunnelProvider, header: string): boolean {
  if (!provider.enabled) return true;
  return !!provider.identityHeader && provider.identityHeader.toLowerCase() === header.trim().toLowerCase();
}

const OPTIONAL_TOKENS = ["region", "allow"] as const;

/** A template word that is an option name awaiting its value as the next word: `-r`, `--region`, never `--region=x` or `--`. */
const SEPARATE_OPTION = /^--?[A-Za-z][\w-]*$/;

/**
 * `template`'s argv with its tokens filled. An optional token without a
 * value drops its word. When that word is an option's value (`{region}`, or
 * `region:{region}`) rather than an option itself (`--region={region}`), the
 * option word just before it (a literal template word like `--region`) goes
 * with it, so neither a dangling option nor an unrelated one is left behind.
 */
export function fillTunnelCommand(template: string, values: Record<string, string | undefined>): string[] | null {
  const argv = splitCommand(template);
  if (!argv || argv.length === 0) return null;
  const out: string[] = [];
  let previousIsOption = false;
  for (const word of argv) {
    const optional = OPTIONAL_TOKENS.find((t) => word.includes(`{${t}}`));
    if (optional && !values[optional]) {
      if (!word.startsWith("-") && previousIsOption) out.pop();
      previousIsOption = false;
      continue;
    }
    out.push(word.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole));
    previousIsOption = !/\{\w+\}/.test(word) && SEPARATE_OPTION.test(word);
  }
  return out;
}

/** The tunnels a listing's JSON names, or null when it isn't one. */
export function parseTunnelList(json: string): ListedTunnel[] | null {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  const rows = Array.isArray(data) ? data : (data as { tunnels?: unknown } | null)?.tunnels;
  if (!Array.isArray(rows)) return null;
  const out: ListedTunnel[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const t = raw as Record<string, unknown> & { meta?: Record<string, unknown> };
    const name = typeof t.name === "string" ? t.name : typeof t.tunnelName === "string" ? t.tunnelName : undefined;
    if (!name) continue;
    const field = (key: string) => t[key] ?? t.meta?.[key];
    const pid = field("pid");
    const localPort = field("localPort");
    const host = field("hostname");
    out.push({
      name,
      ...(typeof pid === "number" ? { pid } : {}),
      ...(typeof localPort === "number" ? { localPort } : {}),
      ...(typeof host === "string" ? { hostname: host } : {}),
    });
  }
  return out;
}

/** Runs a listing command and parses its output; null when it fails or doesn't parse. */
export type TunnelListRunner = (argv: string[]) => Promise<string | null>;

const runListing: TunnelListRunner = async (argv) => {
  try {
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore", stdin: "ignore", env: scrubSecretEnv() });
    const timer = setTimeout(() => proc.kill("SIGKILL"), 30_000);
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    clearTimeout(timer);
    return proc.exitCode === 0 ? out : null;
  } catch {
    return null;
  }
};

/** A provider that drives a tunnel CLI from `config`'s templates. */
export function commandTunnelProvider(config: CommandTunnelConfig, run: TunnelListRunner = runListing): TunnelProvider {
  const takesAudience = config.create.includes("{allow}");
  const audienceProblem = (allow: string | undefined): string | undefined =>
    allow?.trim() && !takesAudience
      ? `the tunnel provider's create command (STANDUP_TUNNEL_CREATE) has no {allow}, so it can't give the tunnel the audience "${allow.trim()}": add {allow} to the template, or remove the audience from the project's review tunnel`
      : undefined;
  return {
    id: "command",
    enabled: true,
    ...(config.domain ? { domain: config.domain } : {}),
    ...(config.identityHeader ? { identityHeader: config.identityHeader.toLowerCase() } : {}),
    audienceProblem,
    createArgv: (req) => {
      const allow = req.allow?.trim();
      // A template without {allow} can't pass the named audience: open nothing rather than a tunnel with the template's own.
      if (audienceProblem(allow)) return null;
      return fillTunnelCommand(config.create, {
        port: String(req.port),
        name: req.suffix,
        region: req.region,
        allow: allow || config.ownerAllow?.trim(),
      });
    },
    url: (name) => config.url.split("{name}").join(name),
    async list() {
      if (!config.list) return null;
      const argv = splitCommand(config.list);
      if (!argv || argv.length === 0) return null;
      const out = await run(argv);
      return out === null ? null : parseTunnelList(out);
    },
  };
}

/** Problems with a command provider's templates; empty when it can open tunnels. */
export function commandTunnelConfigProblems(config: Partial<CommandTunnelConfig>): string[] {
  const problems: string[] = [];
  const create = config.create?.trim();
  if (!create) problems.push("STANDUP_TUNNEL_CREATE is not set");
  else if (!splitCommand(create)) problems.push("STANDUP_TUNNEL_CREATE has an unterminated quote");
  else if (!create.includes("{port}") || !create.includes("{name}")) problems.push("STANDUP_TUNNEL_CREATE must contain {port} and {name}");
  const url = config.url?.trim();
  if (!url) problems.push("STANDUP_TUNNEL_URL is not set");
  else if (!/^https?:\/\/\S*\{name\}/.test(url)) problems.push("STANDUP_TUNNEL_URL must be an http(s) URL containing {name}");
  if (config.list !== undefined && config.list.trim() && !splitCommand(config.list)) problems.push("STANDUP_TUNNEL_LIST has an unterminated quote");
  const ownerAllow = config.ownerAllow?.trim();
  if (ownerAllow && !/^[A-Za-z0-9:._,-]+$/.test(ownerAllow)) {
    problems.push("STANDUP_TUNNEL_OWNER_ALLOW must be a comma-separated list of users or <kind>:<group> entries");
  }
  if (create?.includes("{allow}") && !ownerAllow) {
    problems.push(
      "STANDUP_TUNNEL_CREATE takes {allow}, so set STANDUP_TUNNEL_OWNER_ALLOW to the {allow} value that admits only you; a tunnel opened with no audience uses it"
    );
  }
  if (create && !create.includes("{allow}") && ownerAllow) {
    problems.push(
      "STANDUP_TUNNEL_OWNER_ALLOW is set but STANDUP_TUNNEL_CREATE has no {allow}, so it is never passed: add {allow} to the template, or remove STANDUP_TUNNEL_OWNER_ALLOW and make the template itself admit only you"
    );
  }
  if (config.domain !== undefined && config.domain.trim() && !/^(?:[a-z0-9-]+\.)+[a-z0-9-]+$/i.test(config.domain.trim())) {
    problems.push("STANDUP_TUNNEL_DOMAIN is not a DNS domain");
  }
  const header = config.identityHeader?.trim();
  if (header && !/^[A-Za-z0-9-]+$/.test(header)) problems.push("STANDUP_TUNNEL_IDENTITY_HEADER is not a header name");
  if (header && config.unauthenticated) problems.push("set STANDUP_TUNNEL_IDENTITY_HEADER or STANDUP_TUNNEL_UNAUTHENTICATED, not both");
  if (!header && !config.unauthenticated) {
    problems.push(
      "say how the tunnel service authenticates the requests it forwards: STANDUP_TUNNEL_IDENTITY_HEADER names the header it stamps with the authenticated user, or STANDUP_TUNNEL_UNAUTHENTICATED=1 acknowledges that anyone who reaches a tunnel gets through"
    );
  }
  return problems;
}

/**
 * The configured tunnel provider: STANDUP_TUNNEL_PROVIDER — `disabled` (the
 * default) or `command`, which takes STANDUP_TUNNEL_CREATE, STANDUP_TUNNEL_URL,
 * one of STANDUP_TUNNEL_IDENTITY_HEADER (the service authenticates every
 * request and stamps that header) or STANDUP_TUNNEL_UNAUTHENTICATED=1 (it
 * doesn't), STANDUP_TUNNEL_OWNER_ALLOW when (and only when) the create
 * template has `{allow}`,
 * and optionally STANDUP_TUNNEL_LIST and STANDUP_TUNNEL_DOMAIN (see
 * CommandTunnelConfig). An unknown provider, or a command provider whose
 * settings don't validate, resolves to disabled with a warning.
 */
export function resolveTunnelProvider(
  env: Record<string, string | undefined> = process.env,
  warn: (message: string) => void = (m) => console.warn(m),
  run?: TunnelListRunner
): TunnelProvider {
  const kind = env.STANDUP_TUNNEL_PROVIDER?.trim().toLowerCase() || "disabled";
  if (kind === "disabled" || kind === "none" || kind === "off") return disabledTunnelProvider;
  if (kind !== "command") {
    warn(`[tunnels] unknown STANDUP_TUNNEL_PROVIDER "${kind}"; tunnels are disabled`);
    return disabledTunnelProvider;
  }
  const config: CommandTunnelConfig = {
    create: env.STANDUP_TUNNEL_CREATE?.trim() ?? "",
    url: env.STANDUP_TUNNEL_URL?.trim() ?? "",
    ...(env.STANDUP_TUNNEL_LIST?.trim() ? { list: env.STANDUP_TUNNEL_LIST.trim() } : {}),
    ...(env.STANDUP_TUNNEL_OWNER_ALLOW?.trim() ? { ownerAllow: env.STANDUP_TUNNEL_OWNER_ALLOW.trim() } : {}),
    ...(env.STANDUP_TUNNEL_DOMAIN?.trim() ? { domain: env.STANDUP_TUNNEL_DOMAIN.trim().toLowerCase() } : {}),
    ...(env.STANDUP_TUNNEL_IDENTITY_HEADER?.trim() ? { identityHeader: env.STANDUP_TUNNEL_IDENTITY_HEADER.trim() } : {}),
    ...(/^(?:1|true|yes)$/i.test(env.STANDUP_TUNNEL_UNAUTHENTICATED?.trim() ?? "") ? { unauthenticated: true } : {}),
  };
  const problems = commandTunnelConfigProblems(config);
  if (problems.length > 0) {
    warn(`[tunnels] command provider not usable (${problems.join("; ")}); tunnels are disabled`);
    return disabledTunnelProvider;
  }
  return commandTunnelProvider(config, run);
}

let active: TunnelProvider | undefined;

/** The collector's tunnel provider, resolved once from the environment. */
export function activeTunnelProvider(): TunnelProvider {
  active ??= resolveTunnelProvider();
  return active;
}

/** Replaces the collector's tunnel provider (a test's), or with no argument drops it so the next read resolves again. */
export function setActiveTunnelProvider(provider?: TunnelProvider): void {
  active = provider;
}
