import { afterEach, describe, expect, test } from "bun:test";
import type { PersonaApproval, PersonaMessage, PersonaState, Snapshot, WsMessage } from "@standup/shared";
import { OWNER_TOKEN_HEADER } from "@standup/shared/owner-token";
import { createWsServer, HEARTBEAT_FRAME, WS_CLOSE_CLIENT_SILENT, type WsServerHandle } from "./ws.js";
import { resolveIdentityConfigFromEnv, resolveUserAlias } from "./server.js";
import { generateOwnerSecrets } from "./owner-secret.js";
import { createLiveSocket, SERVICE_RESTART_RECONNECT_MAX_MS, type LiveSocket, type SocketLike } from "../../web/src/hooks/liveSocket.js";
import {
  catchUpPersonaThread,
  fetchPersonaSnapshot,
  initialPersonaViewState,
  personaReducer,
  syncPersonaSnapshot,
  type PersonaSnapshot,
  type PersonaViewState,
} from "../../web/src/lib/persona.js";
import { drainRefusedResponse } from "./drain.js";
import type { Socket, TCPSocketListener } from "bun";

/*
 * The console's live path end to end in one process: the collector's real
 * WebSocket server and broadcaster, the console's real socket controller and
 * Persona reducer, and a stand-in for the Persona REST routes that can be "not
 * up yet" the way a restarting collector's are.
 */

const host = resolveUserAlias(undefined);
const secrets = generateOwnerSecrets();
const THREAD = "thread-console";
const RETRIES = Array.from({ length: 40 }, () => 50);

const state: PersonaState = {
  owner: host,
  runState: "idle",
  threadId: THREAD,
  epoch: 1,
  pendingInbox: 0,
  activeLaunches: 0,
  maxActiveLaunches: 6,
};

let seq = 0;
const message = (text: string): PersonaMessage => ({
  id: `m-${text}`,
  threadId: THREAD,
  seq: ++seq,
  role: "persona",
  text,
  createdAt: new Date().toISOString(),
});
const approval = (id: string): PersonaApproval => ({
  id,
  owner: host,
  action: "answer_ask",
  summary: `card ${id}`,
  args: {},
  status: "pending",
  threadId: THREAD,
  createdAt: new Date().toISOString(),
});

/** What the Persona REST routes would return; `up` false answers like a collector whose HTTP isn't listening. */
class PersonaRoutes {
  up = true;
  /** Answers every read the way a collector draining for a restart does (drain.ts), read by the console's own client code. */
  draining = false;
  messages: PersonaMessage[] = [];
  approvals: PersonaApproval[] = [];
  reads = 0;
  async snapshot(): Promise<PersonaSnapshot> {
    this.reads++;
    if (this.draining) return fetchPersonaSnapshot(async () => drainRefusedResponse(), THREAD);
    if (!this.up) return { loadError: "Request failed (500)" };
    return {
      state,
      messages: { threadId: THREAD, messages: [...this.messages] },
      jobs: [],
      pendingApprovals: this.approvals.filter((a) => a.status === "pending"),
      recentApprovals: [...this.approvals],
    };
  }
  /** `GET /api/persona/messages`, as the catch-up reads it: rows after `afterSeq` oldest first, else the newest page. */
  fetch = async (input: string): Promise<Response> => {
    this.reads++;
    if (this.draining) return drainRefusedResponse();
    if (!this.up) return new Response("down", { status: 502 });
    const url = new URL(input, "http://console");
    const after = url.searchParams.get("afterSeq");
    const limit = Number(url.searchParams.get("limit") ?? 200);
    const rows = after === null ? this.messages.slice(-limit) : this.messages.filter((m) => m.seq > Number(after)).slice(0, limit);
    return Response.json({ threadId: THREAD, messages: rows });
  };
}

/*
 * A TCP relay in front of the socket server. `silence()` stops it forwarding
 * on the connections it holds, both ways, without closing them: the socket a
 * console holds through a tunnel or proxy after a laptop sleeps. Connections
 * opened later forward normally.
 */
type RelayPair = { client: Socket<RelayPair>; upstream?: Socket<{ pair: RelayPair }>; silent: boolean; queued: Uint8Array[] };
function startRelay(target: () => number): { port: number; silence: () => void; stop: () => void } {
  const pairs = new Set<RelayPair>();
  const listener: TCPSocketListener<RelayPair> = Bun.listen<RelayPair>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      async open(client) {
        const pair: RelayPair = { client, silent: false, queued: [] };
        client.data = pair;
        pairs.add(pair);
        try {
          pair.upstream = await Bun.connect<{ pair: RelayPair }>({
            hostname: "127.0.0.1",
            port: target(),
            data: { pair },
            socket: {
              data: (up, chunk) => void (up.data.pair.silent || up.data.pair.client.write(chunk)),
              close: (up) => void (up.data.pair.silent || up.data.pair.client.end()),
              error: () => {},
            },
          });
          for (const chunk of pair.queued) pair.upstream.write(chunk);
          pair.queued = [];
        } catch {
          client.end();
        }
      },
      data(client, chunk) {
        const pair = client.data;
        if (pair.silent) return;
        if (pair.upstream) pair.upstream.write(chunk);
        else pair.queued.push(new Uint8Array(chunk));
      },
      close(client) {
        pairs.delete(client.data);
        if (!client.data.silent) client.data.upstream?.end();
      },
      error: () => {},
    },
  });
  return {
    port: listener.port,
    silence: () => {
      for (const pair of pairs) pair.silent = true;
    },
    stop: () => {
      for (const pair of pairs) {
        pair.client.end();
        pair.upstream?.end();
      }
      listener.stop(true);
    },
  };
}

/*
 * The socket server's port: 0 until a test's first server binds one, then the
 * port it bound, so a restarted server comes back where the console dials.
 */
let port = 0;
let server: WsServerHandle | undefined;
let accepting = true;
let hellos = 0;
function startServer(): WsServerHandle {
  server = createWsServer(
    port,
    async () => {
      hellos++;
      return {} as Snapshot;
    },
    () => {},
    resolveIdentityConfigFromEnv(),
    { ownerSecrets: () => secrets, accepting: () => accepting }
  );
  port = server.port;
  return server;
}

/** A server whose heartbeat is `heartbeatMs`, bound to a fresh port; `clientSilentMs` as createWsServer takes it. */
function startHeartbeatServer(heartbeatMs: number, clientSilentMs?: number): WsServerHandle {
  server = createWsServer(0, async () => ({}) as Snapshot, () => {}, resolveIdentityConfigFromEnv(), {
    ownerSecrets: () => secrets,
    heartbeatMs,
    clientSilentMs,
  });
  port = server.port;
  return server;
}

/** Publishes as a Persona runtime does: addressed to its owner. */
const publish = (type: string, payload: unknown) =>
  server!.broadcast({ type, payload, timestamp: new Date().toISOString(), audience: host } as WsMessage);

const sockets: LiveSocket[] = [];

/** The console's side: the live socket feeding the Persona reducer, resyncing over "REST" on each hello. */
function openConsole(
  routes: PersonaRoutes,
  retryMs: number[] = RETRIES,
  opts: { port?: number; pingIntervalMs?: number; pongTimeoutMs?: number; staleAfterMs?: number } = {}
) {
  let view: PersonaViewState = initialPersonaViewState;
  let generation = 0;
  const resync = () => {
    const mine = ++generation;
    return syncPersonaSnapshot({
      fetchSnapshot: () => routes.snapshot(),
      apply: (snapshot, frameMark) => {
        view = personaReducer(view, { type: "snapshot", snapshot, frameMark });
      },
      frameMark: () => view.frames,
      current: () => generation === mine,
      retryMs,
    });
  };
  let missed = 0;
  let stales = 0;
  let dials = 0;
  const socket: LiveSocket = createLiveSocket({
    url: `ws://127.0.0.1:${opts.port ?? port}`,
    pingIntervalMs: opts.pingIntervalMs,
    staleAfterMs: opts.staleAfterMs,
    onStale: () => stales++,
    pongTimeoutMs: opts.pongTimeoutMs,
    // A browser can't set headers; the console's dev-server proxy adds the
    // owner token on its behalf (owner-proxy.ts). Bun's WebSocket takes them.
    createSocket: (url) => {
      dials++;
      return new WebSocket(url, { headers: { [OWNER_TOKEN_HEADER]: secrets.ownerToken } } as unknown as string[]) as unknown as SocketLike;
    },
    handlers: () => ({
      onMessage: (m) => {
        view = personaReducer(view, { type: "frame", message: m });
      },
      onHello: () => void resync(),
      // A reconnect within one epoch resumes; Persona frames are never
      // replayed, so it resyncs Persona as App's handleResume does.
      onResume: () => void resync(),
      onGap: () => {},
    }),
    backoff: { baseMs: 50, maxMs: 200, factor: 2 },
    log: () => {},
  });
  sockets.push(socket);
  return {
    socket,
    view: () => view,
    texts: () => view.messages.map((m) => m.text),
    pending: () => view.approvals.filter((a) => a.status === "pending").map((a) => a.id),
    /** One run of the console's visible-tab catch-up (App's createCatchUp tick). */
    catchUp: () =>
      catchUpPersonaThread({
        view: () => view,
        apply: (messages) => {
          view = personaReducer(view, { type: "catchUp", messages });
        },
        resync,
        fetchFn: routes.fetch,
        onMissed: () => {
          missed++;
          socket.wake();
        },
      }),
    missed: () => missed,
    stales: () => stales,
    /** Sockets the controller has opened, one per connection attempt. */
    dials: () => dials,
  };
}

/** Waits until `c` dials twice more: the first of those attempts has been answered (else it wouldn't re-dial). */
async function untilRedialed(c: ReturnType<typeof openConsole>): Promise<void> {
  const from = c.dials();
  await until(() => c.dials() >= from + 2);
}

/** Posts a message as the runtime does: stored (what the REST routes read) and published live. */
function post(routes: PersonaRoutes, text: string): PersonaMessage {
  const m = message(text);
  routes.messages.push(m);
  publish("persona:message", m);
  return m;
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

/** Opens a console on a fresh server and waits for its first resync. */
async function booted(routes: PersonaRoutes) {
  port = 0;
  startServer();
  const c = openConsole(routes);
  await until(() => c.view().loaded && c.view().threadId === THREAD);
  return c;
}

/** Publishes a message and a card live and checks they land without any REST read. */
async function expectLive(c: ReturnType<typeof openConsole>, routes: PersonaRoutes, text: string, cardId: string) {
  const reads = routes.reads;
  publish("persona:message", message(text));
  publish("persona:approval", approval(cardId));
  await until(() => c.texts().includes(text) && c.pending().includes(cardId));
  expect(routes.reads).toBe(reads);
}

const relays: Array<{ stop: () => void }> = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.dispose();
  for (const r of relays.splice(0)) r.stop();
  await server?.close();
  server = undefined;
  accepting = true;
});

describe("console live updates over the collector socket", () => {
  test("(a) a Persona message and (b) an approval card arrive on an open connection, and later frames still land", async () => {
    const routes = new PersonaRoutes();
    const c = await booted(routes);
    await expectLive(c, routes, "hello from persona", "card-1");
    await expectLive(c, routes, "after the card", "card-2");
  });

  test("(c) after a restart the console reconnects, backfills what it missed, and takes live frames again", async () => {
    const routes = new PersonaRoutes();
    const c = await booted(routes);

    // The collector goes down; while it's down Persona posts a question and a card.
    await server!.close();
    await until(() => c.socket.status().connected === false);
    expect(c.socket.status().downSince).not.toBeNull();
    routes.messages.push({ ...message("question asked while you were away?"), options: ["yes", "no"] });
    routes.approvals.push(approval("card-missed"));

    // It comes back: first refusing sockets while it starts, then with the
    // socket up before the REST routes answer.
    routes.up = false;
    accepting = false;
    startServer();
    await untilRedialed(c);
    expect(c.socket.status().connected).toBe(false);
    accepting = true;
    const readsBefore = routes.reads;
    await until(() => c.socket.status().connected);
    await until(() => routes.reads > readsBefore + 1);
    expect(c.view().loadError).toBeDefined();
    routes.up = true;
    await until(() => c.texts().includes("question asked while you were away?"));
    expect(c.pending()).toContain("card-missed");
    expect(c.view().loadError).toBeUndefined();

    await expectLive(c, routes, "live after restart", "card-live");
  });

  test("without retries, a resync that lands before the REST routes answer leaves the missed items off screen", async () => {
    const routes = new PersonaRoutes();
    port = 0;
    startServer();
    const c = openConsole(routes, []);
    await until(() => c.view().loaded && c.view().threadId === THREAD);
    await server!.close();
    await until(() => c.socket.status().connected === false);
    routes.messages.push(message("missed for good"));
    routes.up = false;
    startServer();
    await until(() => c.socket.status().connected && c.view().loadError !== undefined);
    routes.up = true;
    // No retry is scheduled; this is many frame round trips.
    await Bun.sleep(150);
    expect(c.texts()).not.toContain("missed for good");
  });

  test("a socket turned away while the collector is starting connects once it accepts", async () => {
    const routes = new PersonaRoutes();
    port = 0;
    accepting = false;
    startServer();
    hellos = 0;
    const c = openConsole(routes);
    await untilRedialed(c);
    expect(c.socket.status().connected).toBe(false);
    expect(hellos).toBe(0);
    accepting = true;
    await until(() => c.view().loaded && c.socket.status().connected);
    expect(hellos).toBe(1);
  });

  test("a disposed controller's socket doesn't reconnect behind the replacement", async () => {
    const routes = new PersonaRoutes();
    port = 0;
    startServer();
    hellos = 0;
    const first = openConsole(routes);
    await until(() => first.socket.status().connected);
    // What a React effect cleanup (StrictMode, an HMR update) does: dispose, then mount anew.
    first.socket.dispose();
    const second = openConsole(routes);
    await until(() => second.socket.status().connected);
    // Several times the first re-dial delay (25–50ms) a disposed socket would take.
    await Bun.sleep(200);
    // One hello per connection: the disposed one never came back.
    expect(hellos).toBe(2);
    expect(first.dials()).toBe(1);
    await server!.close();
    await until(() => second.socket.status().connected === false);
    startServer();
    await until(() => hellos === 3);
    // A restart close re-dials at a random point up to SERVICE_RESTART_RECONNECT_MAX_MS after it.
    await Bun.sleep(SERVICE_RESTART_RECONNECT_MAX_MS);
    expect(hellos).toBe(3);
    expect(first.dials()).toBe(1);
  });
});

describe("the server heartbeat", () => {
  test("every registered client hears a heartbeat on an otherwise quiet socket, and the console stays connected on it alone", async () => {
    startHeartbeatServer(40);
    const heard: string[] = [];
    const raw = new WebSocket(`ws://127.0.0.1:${port}`);
    raw.addEventListener("message", (e) => heard.push(String(e.data)));
    await until(() => heard.some((d) => d === HEARTBEAT_FRAME));
    raw.close();

    // A console that never pings (interval past the test) and turns stale after 300ms stays up on heartbeats.
    const c = openConsole(new PersonaRoutes(), RETRIES, { pingIntervalMs: 600_000, pongTimeoutMs: 600_000, staleAfterMs: 300 });
    await until(() => c.socket.status().connected && c.view().loaded);
    await Bun.sleep(500);
    expect(c.socket.status().connected).toBe(true);
    expect(c.stales()).toBe(0);
  });

  test("a socket whose page went away (it reads but never sends) is closed with 4000, while a console that never pings stays up on its heartbeat acks", async () => {
    startHeartbeatServer(40, 300);
    // What a tunnel leaves behind for a socket the browser replaced:
    // still reading every frame, never sending one.
    let leakedClose: number | undefined;
    const leaked = new WebSocket(`ws://127.0.0.1:${port}`);
    leaked.addEventListener("close", (e) => (leakedClose = e.code));
    const c = openConsole(new PersonaRoutes(), RETRIES, { pingIntervalMs: 600_000, pongTimeoutMs: 600_000, staleAfterMs: 300 });
    await until(() => c.socket.status().connected && c.view().loaded);
    await until(() => leakedClose !== undefined, 3000);
    expect(leakedClose).toBe(WS_CLOSE_CLIENT_SILENT);
    await Bun.sleep(600);
    expect(c.socket.status().connected).toBe(true);
    expect(c.dials()).toBe(1);
    expect(c.stales()).toBe(0);
  });

  test("with the heartbeat off and no pings, a quiet socket turns stale and is replaced", async () => {
    startHeartbeatServer(0);
    const c = openConsole(new PersonaRoutes(), RETRIES, { pingIntervalMs: 600_000, pongTimeoutMs: 600_000, staleAfterMs: 200 });
    await until(() => c.socket.status().connected && c.view().loaded);
    await until(() => c.stales() > 0, 3000);
  });
});

describe("a thread that can't stay stale", () => {
  /** A console booted through a relay that can go silent; `heartbeat` false stretches its ping past the test. */
  async function throughRelay(routes: PersonaRoutes, heartbeat: boolean) {
    port = 0;
    startServer();
    const relay = startRelay(() => port);
    relays.push(relay);
    const c = openConsole(routes, RETRIES, {
      port: relay.port,
      pingIntervalMs: heartbeat ? 100 : 600_000,
      pongTimeoutMs: heartbeat ? 200 : 600_000,
    });
    await until(() => c.view().loaded && c.view().threadId === THREAD && c.socket.status().connected);
    return { c, relay };
  }

  test("a reply published while the socket is silently dead never arrives on it; the catch-up shows it", async () => {
    const routes = new PersonaRoutes();
    const { c, relay } = await throughRelay(routes, false);
    post(routes, "before");
    await until(() => c.texts().includes("before"));

    relay.silence();
    post(routes, "while dead");
    // Many times a local frame's delivery.
    await Bun.sleep(150);
    // The bug: the socket still reads as connected and the frame is gone.
    expect(c.socket.status().connected).toBe(true);
    expect(c.texts()).not.toContain("while dead");

    expect(await c.catchUp()).toBe(true);
    expect(c.texts()).toEqual(["before", "while dead"]);
    expect(c.missed()).toBe(1);
    // A second run finds nothing new and changes nothing.
    const held = c.view().messages;
    await c.catchUp();
    expect(c.view().messages).toBe(held);
    expect(c.missed()).toBe(1);
  });

  test("the heartbeat replaces a silent socket, and the resync on its hello-ok shows what it missed", async () => {
    const routes = new PersonaRoutes();
    const { c, relay } = await throughRelay(routes, true);
    relay.silence();
    post(routes, "missed while silent");
    // Replaced within a ping interval and a pong timeout (100 + 200ms here;
    // 15 + 10s by default), with no catch-up run.
    await until(() => c.texts().includes("missed while silent"), 3000);
    expect(c.missed()).toBe(0);
    post(routes, "live on the new socket");
    await until(() => c.texts().includes("live on the new socket"));
    expect(c.texts()).toEqual(["missed while silent", "live on the new socket"]);
  });

  test("a reply posted across a restart, before the console reconnects, shows by the catch-up", async () => {
    const routes = new PersonaRoutes();
    const c = await booted(routes);
    post(routes, "before the restart");
    await until(() => c.texts().includes("before the restart"));
    await server!.close();
    await until(() => c.socket.status().connected === false);
    // The collector is back but still turning sockets away; Persona has already posted.
    accepting = false;
    startServer();
    post(routes, "posted while you were reconnecting");
    expect(await c.catchUp()).toBe(true);
    expect(c.texts()).toEqual(["before the restart", "posted while you were reconnecting"]);
    accepting = true;
    await until(() => c.socket.status().connected);
    await expectLive(c, routes, "live after restart", "card-live");
    expect(c.texts()).toEqual(["before the restart", "posted while you were reconnecting", "live after restart"]);
  });

  test("a stream that stalls (heartbeats stop, the socket never closes) is replaced on the heartbeat timeout, and what it missed shows", async () => {
    const routes = new PersonaRoutes();
    startHeartbeatServer(40);
    const relay = startRelay(() => port);
    relays.push(relay);
    // No pings of its own within the test: only the server's heartbeat keeps it fresh.
    const c = openConsole(routes, RETRIES, { port: relay.port, pingIntervalMs: 600_000, pongTimeoutMs: 600_000, staleAfterMs: 300 });
    await until(() => c.view().loaded && c.socket.status().connected);
    await Bun.sleep(500);
    expect(c.stales()).toBe(0);
    relay.silence();
    post(routes, "missed while the stream stalled");
    await until(() => c.stales() > 0, 3000);
    // Shown by the resync on the replacement's hello-ok; no catch-up ran.
    await until(() => c.texts().includes("missed while the stream stalled"), 3000);
  });

  test("a restart whose resync meets the draining collector retries, and the catch-up keeps reading", async () => {
    const routes = new PersonaRoutes();
    const c = await booted(routes);
    post(routes, "before the restart");
    await until(() => c.texts().includes("before the restart"));

    // The old collector is still answering HTTP, with its draining 503, when
    // the console's socket lands on the new one and resyncs.
    routes.draining = true;
    await server!.close();
    await until(() => c.socket.status().connected === false);
    startServer();
    const readsBefore = routes.reads;
    await until(() => c.socket.status().connected && routes.reads > readsBefore);
    // Read as a failed load, never as "Persona is disabled": the composer stays and the catch-up runs.
    expect(c.view().disabledReason).toBeUndefined();
    expect(c.view().loadError).toBe("draining");

    // Persona posts while the console's frames are lost (the new socket isn't
    // getting them yet); the drain ends.
    routes.messages.push(message("posted during the handoff"));
    routes.draining = false;
    await until(() => c.texts().includes("posted during the handoff"));
    expect(c.view().loadError).toBeUndefined();

    routes.messages.push(message("lost on a socket that still looks fine"));
    expect(await c.catchUp()).toBe(true);
    expect(c.texts()).toEqual(["before the restart", "posted during the handoff", "lost on a socket that still looks fine"]);
    await expectLive(c, routes, "live after the handoff", "card-live");
  });

  test("a resync that ran out of retries is run again by the next catch-up", async () => {
    const routes = new PersonaRoutes();
    port = 0;
    startServer();
    const c = openConsole(routes, []);
    await until(() => c.view().loaded && c.view().threadId === THREAD);
    await server!.close();
    await until(() => c.socket.status().connected === false);
    routes.messages.push(message("missed until the next catch-up"));
    routes.up = false;
    startServer();
    await until(() => c.socket.status().connected && c.view().loadError !== undefined);
    routes.up = true;
    // No retry is scheduled; this is many frame round trips.
    await Bun.sleep(150);
    expect(c.texts()).not.toContain("missed until the next catch-up");
    expect(await c.catchUp()).toBe(true);
    expect(c.texts()).toContain("missed until the next catch-up");
    expect(c.view().loadError).toBeUndefined();
  });
});
