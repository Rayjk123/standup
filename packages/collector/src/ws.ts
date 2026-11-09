import { randomBytes } from "node:crypto";
import type {
  HelloOkPayload,
  IdentityProviderConfig,
  PresenceEntry,
  PresenceSet,
  Snapshot,
  WsMessage,
} from "@standup/shared";
import { SERVICE_CLIENT_HEADER, WS_PROTOCOL_VERSION } from "@standup/shared";
import {
  OWNER_TOKEN_HEADER,
  PERSONA_USER_HEADER,
  USER_CHANNEL_HEADER,
  userChannelTokenMatches,
} from "@standup/shared/owner-token";
import { DRAINING_HEADER, DRAINING_REFUSED, WS_CLOSE_SERVICE_RESTART } from "@standup/shared/topology";
import { resolveIdentity, resolveUserAlias, ANONYMOUS_ALIAS } from "./identity.js";
import { isAllowedHost } from "./persona/routes.js";
import { CALLER_GUARD_ERRORS, callerGuardRefusal } from "./caller-guard.js";
import { isPersonaAlias } from "./persona/fleet.js";
import { activeOwnerSecrets, ownerTokenMatches, type OwnerSecrets } from "./owner-secret.js";

/** What a socket's upgrade proved about whose Persona frames it may receive. */
type SocketData = {
  user?: string;
  hostAllowed?: boolean;
  service?: boolean;
  personaAudience?: string;
  personaRelay?: boolean;
  personalViewer?: string;
  resume?: ResumeCursor;
};

/** A reconnecting client's cursor: the epoch and last seq it saw. */
export interface ResumeCursor {
  epoch: string;
  since: number;
}

export type WsClient = {
  /** Bun reports a frame it dropped instead of sending or queueing as 0. */
  send: (data: string) => number | void;
  readyState: number;
  close?: (code?: number, reason?: string) => void;
  /**
   * `hostAllowed`: the upgrade's `Host` named this collector (see
   * isAllowedHost), recorded once at upgrade. `service`: the upgrade carried
   * SERVICE_CLIENT_HEADER — a relay to shared places (the Slack adapter).
   * `personaAudience`: the user whose `persona:*` frames the upgrade proved
   * it may receive (see personaProof). `personaRelay`: a service relay that
   * presented the owner secret, which receives every user's `persona:*` frames.
   * `personalViewer`: the user whose personal-layer changes the socket may see
   * (see personalViewerOf). `resume`: the upgrade's `?epoch=&since=` cursor,
   * when it carried one.
   */
  data?: SocketData;
};

/**
 * Whose Persona frames an upgrade proved it may receive: the owner secret
 * proves the host (or, with PERSONA_USER_HEADER, the user it names), and a
 * service relay holding it relays every user's; a user channel token proves
 * the alias the upgrade's identity resolved to. A forged identity header
 * proves nothing.
 */
export function personaProof(
  header: (name: string) => string | null,
  user: string,
  host: string,
  service: boolean,
  secrets: OwnerSecrets
): { personaAudience?: string; personaRelay?: boolean } {
  if (ownerTokenMatches(header(OWNER_TOKEN_HEADER), secrets)) {
    if (service) return { personaRelay: true };
    const named = header(PERSONA_USER_HEADER)?.trim();
    if (named) return named === host || isPersonaAlias(named) ? { personaAudience: named } : {};
    // The owner secret alone proves the host only on an upgrade that resolves
    // to the host, as on the HTTP routes.
    if (user === host) return { personaAudience: host };
  }
  if (isPersonaAlias(user) && userChannelTokenMatches(secrets.ownerToken, user, header(USER_CHANNEL_HEADER))) {
    return { personaAudience: user };
  }
  return {};
}

/**
 * The user whose personal-layer knowledge changes a socket may receive (its
 * hello-ok snapshot and addressed non-persona frames): the user the upgrade
 * proved (personaProof), else the host for an upgrade resolving to the host.
 * An identity header naming anyone else proves nothing, since a worker on
 * loopback can set it.
 */
export function personalViewerOf(user: string, host: string, proof: { personaAudience?: string }): string | undefined {
  if (proof.personaAudience) return proof.personaAudience;
  return user === host && user !== ANONYMOUS_ALIAS ? user : undefined;
}

/** WebSocket close code for a server-side failure (RFC 6455 "internal error"). */
export const WS_CLOSE_INTERNAL_ERROR = 1011;

/** WebSocket close code for a client closed for sending nothing for DEFAULT_CLIENT_SILENT_MS. */
export const WS_CLOSE_CLIENT_SILENT = 4000;

/** How many sequenced frames the replay buffer keeps for reconnecting clients. */
export const REPLAY_BUFFER_CAP = 2000;

/**
 * The last `cap` sequenced frames, as sent. Every sequenced broadcast goes in,
 * so the buffered seqs are contiguous and a cursor is covered exactly when no
 * frame after it has been evicted.
 */
export class ReplayBuffer {
  private readonly frames: Array<{ seq: number; data: string } | undefined>;
  private start = 0;
  private size = 0;

  constructor(private readonly cap = REPLAY_BUFFER_CAP) {
    this.frames = new Array(cap);
  }

  push(seq: number, data: string): void {
    if (this.size < this.cap) {
      this.frames[(this.start + this.size) % this.cap] = { seq, data };
      this.size++;
    } else {
      this.frames[this.start] = { seq, data };
      this.start = (this.start + 1) % this.cap;
    }
  }

  /** The oldest buffered seq, or undefined when empty. */
  oldest(): number | undefined {
    return this.size > 0 ? this.frames[this.start]!.seq : undefined;
  }

  /** Whether every frame after `since` up to `current` is buffered. */
  covers(since: number, current: number): boolean {
    if (!Number.isInteger(since) || since < 0 || since > current) return false;
    const oldest = this.oldest() ?? current + 1;
    return since >= oldest - 1;
  }

  /** The buffered frames with seq > `since`, oldest first. */
  after(since: number): string[] {
    const out: string[] = [];
    for (let i = 0; i < this.size; i++) {
      const frame = this.frames[(this.start + i) % this.cap]!;
      if (frame.seq > since) out.push(frame.data);
    }
    return out;
  }
}

/** The `?epoch=&since=` cursor of an upgrade URL, or undefined when absent or malformed. */
export function parseResumeCursor(url: string): ResumeCursor | undefined {
  let params: URLSearchParams;
  try {
    params = new URL(url, "http://localhost").searchParams;
  } catch {
    return undefined;
  }
  const epoch = params.get("epoch");
  const since = params.get("since");
  if (!epoch || !since || !/^\d{1,15}$/.test(since)) return undefined;
  return { epoch, since: Number(since) };
}

export interface WsServerOptions {
  /** The leadership epoch reported in hello-ok; a resume cursor must carry it. Random by default. */
  epoch?: string;
  /** Defaults to STANDUP_BIND_HOST, else loopback. */
  hostname?: string;
  /**
   * The owner secrets an upgrade's Persona proof is checked against, read at
   * each upgrade (the collector installs them on start).
   */
  ownerSecrets?: () => OwnerSecrets;
  /**
   * Whether to take connections yet. The socket starts long before the HTTP
   * routes answer, and a console that reconnected in that window would resync
   * over REST into refused requests; turned away with a 503, it retries with
   * backoff. Always accepting by default.
   */
  accepting?: () => boolean;
  /**
   * How often every registered client is sent a HEARTBEAT_FRAME; 0 sends
   * none. The console judges a socket stale by how long it has heard nothing,
   * so the stream never goes quiet on a healthy connection, even while the
   * console's own ping timers are throttled in a background tab.
   */
  heartbeatMs?: number;
  /**
   * A registered client that has sent nothing for this long is closed, at the
   * next heartbeat; 0 keeps every client. See DEFAULT_CLIENT_SILENT_MS.
   */
  clientSilentMs?: number;
}

/** The unsequenced, non-JSON keepalive the server sends; clients that don't know it ignore it like a pong. */
export const HEARTBEAT_FRAME = "hb";
export const DEFAULT_HEARTBEAT_MS = 10_000;
/** What the console answers each HEARTBEAT_FRAME with; the server takes it only as a sign of life. */
export const HEARTBEAT_ACK_FRAME = "hb-ack";

/**
 * How long a registered client may send nothing before it is closed. A page
 * that went away without its close reaching the collector (a tunnel can
 * keep the local leg of a socket the browser dropped open, and keeps
 * reading it) would otherwise stay registered for good, taking every
 * broadcast and heartbeat into a tunnel nobody listens on; each one the
 * console replaces adds another. A live console answers every heartbeat
 * (HEARTBEAT_ACK_FRAME) and pings every 15s, an older build pings at least
 * once a minute even in a throttled background tab, and the Slack relay
 * pings every 30s, so only a dead socket goes this long without a frame.
 */
export const DEFAULT_CLIENT_SILENT_MS = 90_000;

export interface WsServerHandle {
  broadcast: (message: WsMessage) => void;
  epoch: string;
  /** The port actually bound (useful with port 0). */
  port: number;
  /**
   * Refuses new upgrades, closes every client with `code` (a service restart
   * by default) and stops the listener. Resolves once the clients are gone or
   * after `timeoutMs`.
   */
  close(code?: number, timeoutMs?: number): Promise<void>;
}

/**
 * Sends `data` to a socket on its own, outside a broadcast. A frame Bun dropped
 * (send reports 0) or a send that throws closes the socket with `code` (1011 by
 * default), since the client could not tell the frame was missed; the reconnect
 * resyncs it. `what` names the frame in the log. Returns whether the frame was
 * sent or queued.
 */
function sendOrClose(client: WsClient, data: string, what: string, code = WS_CLOSE_INTERNAL_ERROR): boolean {
  let reason = "frame dropped";
  try {
    if (client.send(data) !== 0) return true;
  } catch {
    reason = "send failed";
  }
  console.warn(`[ws] ${what} not sent (${reason}); closing the socket with ${code}`);
  try {
    client.close?.(code, reason);
  } catch {
    // Already closed.
  }
  return false;
}

/** What the socket handlers share with the server that owns them. */
export interface SocketHandlerState {
  /** The registered clients every broadcast fans out to. */
  clients: Set<WsClient>;
  replay: ReplayBuffer;
  epoch: string;
  // Builds the hello-ok snapshot.
  getSnapshot: () => Promise<Snapshot>;
  /** The seq of the last sequenced broadcast. */
  seq: () => number;
  /** Whether the server is shutting down. */
  closing: () => boolean;
  /** See WsServerOptions.clientSilentMs; DEFAULT_CLIENT_SILENT_MS when absent. */
  clientSilentMs?: number;
  now?: () => number;
}

export interface SocketHandlers {
  open(client: WsClient): Promise<void>;
  close(client: WsClient): void;
  message(client: WsClient, message: string | Buffer): void;
  /** Closes the registered clients silent past clientSilentMs, then sends the rest a HEARTBEAT_FRAME. */
  heartbeat(): void;
}

/** The per-socket lifecycle createWsServer hands Bun: hello-ok and replay on open, presence, heartbeats. */
export function createSocketHandlers(state: SocketHandlerState): SocketHandlers {
  const { clients, replay, epoch, getSnapshot } = state;
  const clientSilentMs = state.clientSilentMs ?? DEFAULT_CLIENT_SILENT_MS;
  // Monotonic, so a wall-clock step (NTP, a VM resuming) can't make every client look silent at once.
  const now = state.now ?? (() => performance.now());
  // When each registered client last sent a frame (from its registration).
  const heardFrom = new Map<WsClient, number>();

  // Ephemeral presence: what each connected client is
  // looking at. Keyed by the connection so a user with two tabs open is two
  // entries that collapse to one roster row; dropped on close. Never persisted,
  // never in the hello-ok snapshot.
  type Presence = { viewingSessionId: string | null; typing: boolean; updatedAt: string };
  const presence = new Map<WsClient, Presence>();

  /**
   * Collapses the per-connection presence map into one roster row per user —
   * the newest update wins when a user has several connections. A freshly
   * connected client with no explicit presence still appears (viewing nothing),
   * so the facepile shows everyone who is online, not only who has clicked in.
   */
  function presenceRoster(): PresenceEntry[] {
    const byUser = new Map<string, PresenceEntry>();
    for (const client of clients) {
      const user = client.data?.user ?? "local";
      const p = presence.get(client) ?? {
        viewingSessionId: null,
        typing: false,
        updatedAt: new Date(0).toISOString(),
      };
      const existing = byUser.get(user);
      if (!existing || p.updatedAt >= existing.updatedAt) {
        byUser.set(user, {
          user,
          viewingSessionId: p.viewingSessionId,
          typing: p.typing,
          updatedAt: p.updatedAt,
        });
      }
    }
    return [...byUser.values()];
  }

  /**
   * Pushes the whole roster to every client as an UNSEQUENCED `presence:state`
   * frame. Deliberately not stamped with `seq`: presence is outside the ordered
   * collection stream, so a dropped frame must not trip the client's gap-resync —
   * the next change simply re-sends the full roster.
   */
  function broadcastPresence(): void {
    if (state.closing()) return;
    const frame: WsMessage<PresenceEntry[]> = {
      type: "presence:state",
      payload: presenceRoster(),
      timestamp: new Date().toISOString(),
    };
    const data = JSON.stringify(frame);
    for (const client of clients) {
      try {
        // A roster Bun dropped closes the socket, as a dropped broadcast does.
        if (client.readyState === 1 && client.send(data) === 0) client.close?.(WS_CLOSE_INTERNAL_ERROR, "frame dropped");
      } catch {
        clients.delete(client);
        presence.delete(client);
        heardFrom.delete(client);
      }
    }
  }

  return {
    async open(client) {
      // Capture the baseline BEFORE building the snapshot. A broadcast that
      // fires during the async build lands in the snapshot's queries but not
      // in this not-yet-registered client's stream; starting `serverSeq` low
      // means the client sees the next live frame as a gap and resyncs —
      // safe (a spurious refetch) rather than a silently missed update.
      const baseline = state.seq();
      let replayed: string[] = [];
      const cursor = client.data?.resume;
      const canResume = (): boolean => !!cursor && cursor.epoch === epoch && replay.covers(cursor.since, state.seq());
      let hello: string;
      try {
        // A cursor the buffer covers resumes with no snapshot at all: the
        // hello-ok and the replay below go out synchronously, before any
        // broadcast can run. Otherwise the snapshot is built, and the cursor
        // checked again afterwards (frames broadcast meanwhile are buffered,
        // so a client resumed then still gets every one of them, in order).
        let snapshot: Snapshot | undefined;
        let resumed = canResume();
        if (!resumed) {
          snapshot = await getSnapshot();
          resumed = canResume();
        }
        if (resumed && cursor) replayed = replay.after(cursor.since);
        const frame: WsMessage<HelloOkPayload> = {
          type: "hello-ok",
          payload: {
            protocolVersion: WS_PROTOCOL_VERSION,
            serverSeq: resumed && cursor ? cursor.since : baseline,
            user: client.data?.user ?? "local",
            ...(snapshot ? { snapshot } : {}),
            epoch,
            ...(resumed ? { resumed: true } : {}),
          },
          timestamp: new Date().toISOString(),
        };
        // Serialized here so a snapshot that can't be (a BigInt, a cycle)
        // takes the failure path below rather than leaving the socket open
        // with no hello-ok.
        hello = JSON.stringify(frame);
      } catch (err) {
        // A client without a hello-ok has no baseline to apply broadcasts
        // to, so it is not registered: the socket closes with 1011 and the
        // client reconnects on its usual backoff.
        console.error("[ws] Failed to build hello-ok snapshot:", err);
        try {
          client.close?.(WS_CLOSE_INTERNAL_ERROR, "snapshot failed");
        } catch {
          // Already closed.
        }
        return;
      }
      if (client.readyState === 1) {
        // Sequenced frames reach every client, service relays included, so
        // replaying them withholds nothing this client wasn't sent live. A
        // hello-ok or replayed frame Bun dropped leaves the client without its
        // baseline or with a hole it can't see, so the socket is closed (1011,
        // or a service restart once the server is shutting down) and never
        // registered.
        const code = state.closing() ? WS_CLOSE_SERVICE_RESTART : WS_CLOSE_INTERNAL_ERROR;
        if (!sendOrClose(client, hello, "hello-ok", code)) return;
        for (const data of replayed) if (!sendOrClose(client, data, "replayed frame", code)) return;
      }
      if (state.closing()) {
        client.close?.(WS_CLOSE_SERVICE_RESTART, "service restart");
        return;
      }
      // A socket that closed while its snapshot was building already ran
      // its close handler; registering it now would leak it.
      if (client.readyState !== 1) return;
      // Registered only after hello-ok and the replay, synchronously, so no
      // live broadcast races ahead of or interleaves with them.
      clients.add(client);
      heardFrom.set(client, now());
      console.log(`[ws] Client connected (${clients.size} total)${replayed.length ? `, resumed with ${replayed.length} frame(s)` : ""}`);
      // Let everyone (including this client) see the refreshed roster now
      // that a new teammate is online.
      broadcastPresence();
    },
    close(client) {
      const registered = clients.delete(client);
      presence.delete(client);
      heardFrom.delete(client);
      if (state.closing() || !registered) return;
      console.log(`[ws] Client disconnected (${clients.size} total)`);
      broadcastPresence();
    },
    message(client, message) {
      // Any frame at all shows the client is still there.
      if (heardFrom.has(client)) heardFrom.set(client, now());
      // Handle ping/pong for keepalive
      if (message === "ping") {
        client.send("pong");
        return;
      }
      if (message === HEARTBEAT_ACK_FRAME) return;
      // A client → server presence update: what this connection is now
      // viewing / whether it is typing. Merged into this client's roster row
      // and re-broadcast. Anything unrecognized is ignored — the socket is
      // otherwise a one-way collector → UI stream.
      if (typeof message === "string") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(message);
        } catch {
          return;
        }
        if (
          parsed &&
          typeof parsed === "object" &&
          (parsed as { kind?: string }).kind === "presence:set"
        ) {
          const set = parsed as PresenceSet;
          presence.set(client, {
            viewingSessionId:
              typeof set.viewingSessionId === "string" ? set.viewingSessionId : null,
            typing: !!set.typing,
            updatedAt: new Date().toISOString(),
          });
          broadcastPresence();
        }
      }
    },
    heartbeat() {
      // A client silent past the limit is gone (see DEFAULT_CLIENT_SILENT_MS).
      // It is forgotten now, so no broadcast goes to it while its close runs.
      const cutoff = now() - clientSilentMs;
      let silent = 0;
      for (const client of [...clients]) {
        const heard = heardFrom.get(client);
        if (clientSilentMs <= 0 || heard === undefined || heard > cutoff) continue;
        clients.delete(client);
        presence.delete(client);
        heardFrom.delete(client);
        silent++;
        try {
          client.close?.(WS_CLOSE_CLIENT_SILENT, "client silent");
        } catch {
          // Already closed.
        }
      }
      if (silent > 0) {
        console.log(`[ws] Closed ${silent} client(s) silent for ${Math.round(clientSilentMs / 1000)}s (${clients.size} total)`);
        broadcastPresence();
      }
      for (const client of clients) {
        // A heartbeat Bun dropped means the stream is no longer reaching the
        // client, so the socket is closed rather than left looking connected.
        // The close handler forgets it and re-sends the roster without it.
        if (client.readyState === 1) sendOrClose(client, HEARTBEAT_FRAME, "heartbeat");
      }
    },
  };
}

export function createWsServer(
  port: number,
  // Builds the hello-ok snapshot.
  getSnapshot: () => Promise<Snapshot>,
  recordUser: (alias: string, viaTunnel: boolean) => void,
  // The SAME identity provider createServer resolves, threaded in so the WS
  // upgrade path resolves identity exactly as the `/api` path does — one config,
  // no drift between the two channels.
  config: IdentityProviderConfig,
  options: WsServerOptions = {}
): WsServerHandle {
  const epoch = options.epoch ?? randomBytes(8).toString("hex");
  const ownerSecrets = options.ownerSecrets ?? activeOwnerSecrets;
  const clients = new Set<WsClient>();
  const replay = new ReplayBuffer();
  let closing = false;

  // Monotonic per server run. Every broadcast is stamped with the next value so
  // a client can notice a dropped frame (a seq more than one past the last it
  // saw) and resync. `hello-ok` is not itself sequenced — it reports the
  // client's starting baseline as `serverSeq`.
  let seq = 0;

  const handlers = createSocketHandlers({
    clients,
    replay,
    epoch,
    getSnapshot,
    seq: () => seq,
    closing: () => closing,
    clientSilentMs: options.clientSilentMs,
  });

  const server = Bun.serve<SocketData>({
    port,
    // Loopback by default; STANDUP_BIND_HOST=0.0.0.0 opens the socket to the
    // network (e.g. behind a tunnel provider). Same default the HTTP server
    // uses in index.ts. Bun otherwise binds 0.0.0.0, so this tightens the default.
    hostname: options.hostname ?? (process.env.STANDUP_BIND_HOST?.trim() || "127.0.0.1"),
    fetch(req, server) {
      // A collector shutting down takes no new sockets; the refusal is safe for
      // the gateway to retry against the next leader.
      if (closing) {
        return new Response(JSON.stringify({ error: "draining" }), {
          status: 503,
          headers: { "content-type": "application/json", [DRAINING_HEADER]: DRAINING_REFUSED },
        });
      }
      if (options.accepting && !options.accepting()) return new Response("Collector is starting", { status: 503 });
      // The identity provider injects the visitor's identifier header; fall back
      // to the host user off-tunnel. resolveIdentity is the single source of
      // truth the /api/* path uses too (it trims the header, so a whitespace-
      // padded alias resolves to the same identity here as over HTTP rather than
      // forking presence/attribution). Attaching the resolved alias at upgrade
      // time makes it available on the socket for the hello-ok identity (and
      // future per-connection presence).
      //
      // The identifier header is forgeable, unauthenticated, so resolveIdentity
      // applies the SAME source-trust gate the /api/* path does: it is honored
      // ONLY from a loopback or configured-trusted-proxy source, and a
      // header-less request off-loopback resolves to `anonymous` rather than the
      // host $USER. On a network-exposed collector (STANDUP_BIND_HOST=0.0.0.0) a
      // raw client can neither spoof a teammate's alias nor be silently
      // attributed to the host operator.
      const resolved = resolveIdentity(
        (name) => req.headers.get(name),
        server.requestIP(req)?.address,
        config,
        process.env.USER
      );
      const user = resolved.user ?? ANONYMOUS_ALIAS;
      // The HTTP routes' Host, site and off-machine credential checks
      // (caller-guard.ts). Browsers apply no CORS to a WebSocket, so without
      // them any page could read the shared stream. Off this machine the proof
      // is the owner secret (the console's proxy, the Slack relay) or a trusted
      // proxy's identity (a user's channel token proves only an alias that
      // identity already resolved).
      // The path is fixed: a socket upgrades on any path, and the HTTP
      // routes' OPEN_ROUTES (/health, share links) must not open one.
      const url = new URL(req.url);
      const refused = callerGuardRefusal(
        {
          method: req.method,
          path: "/ws",
          host: req.headers.get("host") ?? url.host,
          header: (name) => req.headers.get(name) ?? undefined,
          remote: server.requestIP(req)?.address,
        },
        () => ownerTokenMatches(req.headers.get(OWNER_TOKEN_HEADER), ownerSecrets()) || resolved.authenticated,
        {}
      );
      if (refused) {
        return new Response(JSON.stringify({ error: CALLER_GUARD_ERRORS[refused] }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }
      // A REAL remote person only when the identity resolved FROM a trusted
      // identifier header — not the host-$USER fallback or the anonymous
      // sentinel — so neither agent traffic nor a forged/untrusted header can
      // inflate the multiplayer people count (see countDistinctUsers).
      const identifier = req.headers.get(config.userIdentifier.header)?.trim();
      const viaTunnel = resolved.authenticated && !!identifier && resolved.user === identifier;
      // Frames addressed to one user also need the Host to name this
      // collector (the check above refuses any other Host already).
      const hostAllowed = isAllowedHost(req.headers.get("host"));
      // A service relay (SERVICE_CLIENT_HEADER) gets only shared frames.
      const service = !!req.headers.get(SERVICE_CLIENT_HEADER);
      const host = resolveUserAlias(undefined);
      const proof = personaProof((name) => req.headers.get(name), user, host, service, ownerSecrets());
      const personalViewer = personalViewerOf(user, host, proof);
      const resume = parseResumeCursor(req.url);
      const data: SocketData = { user, hostAllowed, service, ...proof, ...(personalViewer ? { personalViewer } : {}), resume };
      if (server.upgrade(req, { data })) {
        // Record the visitor. The hello-ok WS snapshot is the primary
        // boot path, so a teammate whose client boots from it may never hit an
        // /api/* route; without this their first_seen/last_seen would never
        // bracket their activity in the users table. viaTunnel marks a real
        // remote person (a TRUSTED identifier header) so neither agent traffic
        // nor a forged header from an untrusted source can inflate the
        // multiplayer people count (see countDistinctUsers).
        recordUser(user, viaTunnel);
        return;
      }
      return new Response("WebSocket upgrade required", { status: 426 });
    },
    websocket: {
      // Bun's defaults, stated: a peer that answers no protocol ping for 120s
      // is closed, and a socket backed up past 16 MB has frames dropped (send
      // reports 0, and the socket is closed with 1011). A peer that does answer
      // pings (the gateway, a tunnel) but sends nothing is closed by the
      // heartbeat's silent-client check instead (DEFAULT_CLIENT_SILENT_MS).
      idleTimeout: 120,
      sendPings: true,
      backpressureLimit: 16 * 1024 * 1024,
      closeOnBackpressureLimit: false,
      open: (ws) => handlers.open(ws as unknown as WsClient),
      close: (ws) => handlers.close(ws as unknown as WsClient),
      message: (ws, message) => handlers.message(ws as unknown as WsClient, message),
    },
  });

  const broadcast = createBroadcaster(
    clients,
    () => ++seq,
    (s, data) => replay.push(s, data),
    (client) => handlers.close(client)
  );

  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const heartbeat = heartbeatMs > 0 ? setInterval(handlers.heartbeat, heartbeatMs) : undefined;
  heartbeat?.unref?.();

  return {
    broadcast,
    epoch,
    port: server.port ?? port,
    async close(code = WS_CLOSE_SERVICE_RESTART, timeoutMs = 1_000) {
      if (heartbeat) clearInterval(heartbeat);
      if (!closing) {
        closing = true;
        // Stop accepting connections first; open sockets stay up to be closed below.
        server.stop(false);
        for (const client of [...clients]) {
          try {
            client.close?.(code, "service restart");
          } catch {
            clients.delete(client);
          }
        }
      }
      const deadline = Date.now() + timeoutMs;
      while (clients.size > 0 && Date.now() < deadline) await Bun.sleep(20);
      server.stop(true);
    },
  };
}

/**
 * The fan-out every broadcast goes through. A frame with an `audience` reaches
 * only clients whose upgrade `Host` named this collector, and goes out
 * UNSEQUENCED: a sequenced frame other clients never receive would read as a
 * dropped frame to them and trip their gap-resync. An addressed `persona:*`
 * frame goes to the clients that proved that user's Persona at upgrade
 * (personaAudience, never a service relay's identity alone) and to every
 * owner-secret relay (personaRelay); an addressed `review:*` frame, or one
 * marked `requireProof`, goes only to the non-relay clients that proved that
 * user (personaAudience); any other addressed frame (`reviews:pending`, which
 * carries only a count, among them) goes to the clients whose personalViewer
 * is that alias and that are not a service relay. Every other frame is stamped with the next `seq`, handed to
 * `onSequenced` (the replay buffer) and sent to all open clients. A client
 * whose send throws is dropped and closed, and so is one whose send Bun dropped:
 * an addressed frame carries no seq, so the client could never tell it was
 * missed, and the socket would go on answering pings with its view stale. The
 * reconnect resyncs it. `onDropped` forgets such a client (createWsServer
 * hands it the close handler, which logs the departure and re-sends the
 * roster); without it the client is only removed from `targets`.
 */
export function createBroadcaster(
  targets: Set<WsClient>,
  nextSeq: () => number,
  onSequenced?: (seq: number, data: string) => void,
  onDropped?: (client: WsClient) => void
): (message: WsMessage) => void {
  const forget = (client: WsClient, reason: string) => {
    console.warn(`[ws] broadcast not sent (${reason}); closing the socket with ${WS_CLOSE_INTERNAL_ERROR}`);
    if (onDropped) onDropped(client);
    else targets.delete(client);
  };
  const reaches = (client: WsClient, audience: string, persona: boolean, proven: boolean): boolean => {
    const data = client.data;
    if (data?.hostAllowed !== true) return false;
    if (persona) return data.personaRelay === true || (data.service !== true && data.personaAudience === audience);
    if (proven) return data.service !== true && data.personaAudience === audience;
    return data.personalViewer === audience && data.service !== true;
  };
  return function broadcast(message: WsMessage): void {
    const audience = message.audience;
    const persona = message.type.startsWith("persona:");
    const proven = message.type.startsWith("review:") || message.requireProof === true;
    const { requireProof: _requireProof, ...frame } = message;
    let data: string;
    if (audience) {
      data = JSON.stringify(frame);
    } else {
      const s = nextSeq();
      data = JSON.stringify({ ...frame, seq: s });
      onSequenced?.(s, data);
    }
    for (const client of targets) {
      if (audience && !reaches(client, audience, persona, proven)) continue;
      try {
        if (client.readyState === 1 && client.send(data) === 0) {
          forget(client, "frame dropped");
          client.close?.(WS_CLOSE_INTERNAL_ERROR, "frame dropped");
        }
      } catch {
        forget(client, "send failed");
        try {
          client.close?.(WS_CLOSE_INTERNAL_ERROR, "send failed");
        } catch {
          // Already closed.
        }
      }
    }
  };
}
