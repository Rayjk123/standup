import { afterEach, expect, test, describe } from "bun:test";
import type { HelloOkPayload, PresenceEntry, Snapshot, WsMessage } from "@standup/shared";
import { OWNER_TOKEN_HEADER, PERSONA_USER_HEADER, USER_CHANNEL_HEADER, userChannelToken } from "@standup/shared/owner-token";
import { WS_CLOSE_SERVICE_RESTART } from "@standup/shared/topology";
import {
  createBroadcaster,
  createSocketHandlers,
  createWsServer,
  DEFAULT_CLIENT_SILENT_MS,
  HEARTBEAT_ACK_FRAME,
  HEARTBEAT_FRAME,
  parseResumeCursor,
  personaProof,
  personalViewerOf,
  ReplayBuffer,
  REPLAY_BUFFER_CAP,
  WS_CLOSE_CLIENT_SILENT,
  WS_CLOSE_INTERNAL_ERROR,
} from "./ws.js";
import type { WsServerHandle } from "./ws.js";
import { isAllowedHost } from "./persona/routes.js";
import { generateOwnerSecrets } from "./owner-secret.js";
import { resolveIdentityConfigFromEnv } from "./server.js";
import type { WsClient } from "./ws.js";

type TestClient = WsClient & { frames: Array<Record<string, unknown>> };

/** A socket of `user`; `proof` is what its upgrade proved about Persona frames (see personaProof). */
function client(
  user: string | undefined,
  hostAllowed = true,
  proof: { personaAudience?: string; personaRelay?: boolean; service?: boolean; personalViewer?: string } = {}
): TestClient {
  const frames: Array<Record<string, unknown>> = [];
  return {
    frames,
    readyState: 1,
    data: user === undefined ? undefined : { user, hostAllowed, ...proof },
    send: (data: string) => frames.push(JSON.parse(data)),
  };
}

/** A socket of `user` whose upgrade proved `user`'s own Persona. */
const signedIn = (user: string, hostAllowed = true) => client(user, hostAllowed, { personaAudience: user });

describe("ws broadcaster audience", () => {
  test("an addressed frame reaches only its audience, unsequenced; others reach everyone, sequenced", () => {
    const owner = signedIn("alice");
    const teammate = client("bob");
    const anonymous = client("anonymous");
    const bare = client(undefined);
    let seq = 0;
    const broadcast = createBroadcaster(new Set([owner, teammate, anonymous, bare]), () => ++seq);

    broadcast({ type: "persona:message", payload: { text: "secret" }, timestamp: "t", audience: "alice" } as WsMessage);
    broadcast({ type: "session:status", payload: { sessionId: "s" }, timestamp: "t" });

    expect(owner.frames.map((f) => f.type)).toEqual(["persona:message", "session:status"]);
    for (const other of [teammate, anonymous, bare]) {
      expect(other.frames.map((f) => f.type)).toEqual(["session:status"]);
    }
    // The addressed frame consumes no seq, so other clients see no gap.
    expect(owner.frames[0].seq).toBeUndefined();
    expect(teammate.frames[0].seq).toBe(1);
    expect(owner.frames[1].seq).toBe(1);
  });

  test("an addressed frame skips its audience's socket opened under a foreign Host", () => {
    const local = signedIn("alice");
    const rebound = signedIn("alice", false);
    const broadcast = createBroadcaster(new Set([local, rebound]), () => 1);
    broadcast({ type: "persona:message", payload: { text: "secret" }, timestamp: "t", audience: "alice" } as WsMessage);
    broadcast({ type: "session:status", payload: { sessionId: "s" }, timestamp: "t" });
    expect(local.frames.map((f) => f.type)).toEqual(["persona:message", "session:status"]);
    expect(rebound.frames.map((f) => f.type)).toEqual(["session:status"]);
  });

  test("a service relay resolving to the owner's alias never receives the owner's frame", () => {
    // The Slack adapter connects over loopback with no identity header, so it
    // resolves to the host user — the owner of the host's personal docs.
    const owner = client("carol", true, { personalViewer: "carol" });
    const slack: ReturnType<typeof client> = { ...client("carol"), data: { user: "carol", hostAllowed: true, service: true, personalViewer: "carol" } };
    const broadcast = createBroadcaster(new Set([owner, slack]), () => 1);
    broadcast({
      type: "knowledge:change",
      payload: { slug: "native-mem-home-claude-md", personal: true, ownerUser: "carol" },
      timestamp: "t",
      audience: "carol",
    } as WsMessage);
    broadcast({ type: "session:status", payload: { sessionId: "s" }, timestamp: "t" });
    expect(owner.frames.map((f) => f.type)).toEqual(["knowledge:change", "session:status"]);
    expect(slack.frames.map((f) => f.type)).toEqual(["session:status"]);
  });
});

describe("ws broadcaster — a frame the socket didn't take", () => {
  /** A socket whose sends Bun reports as `status` (0: dropped, -1: queued under backpressure). */
  const reporting = (status: number) => {
    const c = signedIn("alice");
    const closes: Array<number | undefined> = [];
    return Object.assign(c, {
      closes,
      send: (data: string) => {
        c.frames.push(JSON.parse(data));
        return status;
      },
      close: (code?: number) => {
        closes.push(code);
      },
    });
  };

  test("a dropped Persona frame closes the socket, so it reconnects and resyncs instead of staying stale", () => {
    const dropped = reporting(0);
    const healthy = signedIn("alice");
    const targets = new Set<WsClient>([dropped, healthy]);
    let seq = 0;
    const broadcast = createBroadcaster(targets, () => ++seq);
    broadcast({ type: "persona:message", payload: { id: "m1" }, timestamp: "t", audience: "alice" } as WsMessage);
    expect(dropped.closes).toEqual([1011]);
    expect(targets.has(dropped)).toBe(false);
    broadcast({ type: "persona:message", payload: { id: "m2" }, timestamp: "t", audience: "alice" } as WsMessage);
    expect(dropped.frames.map((f) => (f.payload as { id: string }).id)).toEqual(["m1"]);
    expect(healthy.frames.map((f) => (f.payload as { id: string }).id)).toEqual(["m1", "m2"]);
  });

  test("a frame queued under backpressure keeps the socket", () => {
    const queued = reporting(-1);
    const targets = new Set<WsClient>([queued]);
    createBroadcaster(targets, () => 1)({ type: "persona:message", payload: {}, timestamp: "t", audience: "alice" } as WsMessage);
    expect(queued.closes).toEqual([]);
    expect(targets.has(queued)).toBe(true);
  });

  test("a send that throws closes the socket too", () => {
    const broken = Object.assign(signedIn("alice"), {
      closes: [] as Array<number | undefined>,
      send: () => {
        throw new Error("gone");
      },
    });
    broken.close = (code?: number) => void broken.closes.push(code);
    const targets = new Set<WsClient>([broken]);
    createBroadcaster(targets, () => 1)({ type: "session:status", payload: {}, timestamp: "t" });
    expect(targets.has(broken)).toBe(false);
    expect(broken.closes).toEqual([1011]);
  });
});

describe("ws broadcaster — persona frames go only to a proven audience", () => {
  const personaFrame = (audience: string) =>
    ({ type: "persona:message", payload: { text: `for ${audience}` }, timestamp: "t", audience }) as WsMessage;

  test("a relay with the owner token gets every user's persona frames; one without gets none", () => {
    const relay = client("carol", true, { service: true, personaRelay: true });
    const bareRelay = client("carol", true, { service: true });
    const broadcast = createBroadcaster(new Set([relay, bareRelay]), () => 1);
    broadcast(personaFrame("carol"));
    broadcast(personaFrame("dave"));
    expect(relay.frames.map((f) => f.audience)).toEqual(["carol", "dave"]);
    expect(bareRelay.frames).toEqual([]);
  });

  test("a relay with the owner token under a foreign Host gets none", () => {
    const rebound = client("carol", false, { service: true, personaRelay: true });
    createBroadcaster(new Set([rebound]), () => 1)(personaFrame("dave"));
    expect(rebound.frames).toEqual([]);
  });

  test("a browser socket resolving to an alias by a forged header, with no token, gets no persona frame", () => {
    const forged = client("dave");
    const broadcast = createBroadcaster(new Set([forged]), () => 1);
    broadcast(personaFrame("dave"));
    broadcast({ type: "persona:state", payload: {}, timestamp: "t", audience: "dave" } as WsMessage);
    expect(forged.frames).toEqual([]);
  });

  test("a socket with dave's user token gets only dave's persona frames", () => {
    const guest = signedIn("dave");
    const host = signedIn("carol");
    const broadcast = createBroadcaster(new Set([guest, host]), () => 1);
    broadcast(personaFrame("dave"));
    broadcast(personaFrame("carol"));
    broadcast(personaFrame("someone"));
    expect(guest.frames.map((f) => f.audience)).toEqual(["dave"]);
    expect(host.frames.map((f) => f.audience)).toEqual(["carol"]);
  });

  test("a non-persona addressed frame goes to its proven personal viewer, never a forged header's socket", () => {
    const owner = client("alice", true, { personalViewer: "alice" });
    const forged = client("alice");
    createBroadcaster(new Set([owner, forged]), () => 1)({
      type: "knowledge:change",
      payload: { personal: true, ownerUser: "alice" },
      timestamp: "t",
      audience: "alice",
    } as WsMessage);
    expect(owner.frames.map((f) => f.type)).toEqual(["knowledge:change"]);
    expect(forged.frames).toEqual([]);
  });
});

describe("frames that need a proven socket", () => {
  const host = "carol";
  /** A loopback socket that resolves to the host but proved nothing at upgrade. */
  const unproven = () => client(host, true, { personalViewer: personalViewerOf(host, host, {}) });
  const proven = () => client(host, true, { personaAudience: host, personalViewer: host });

  test("review:* frames and requireProof frames skip a socket that only resolves to their audience", () => {
    const loose = unproven();
    const owner = proven();
    const slack: TestClient = { ...proven(), frames: [], data: { user: host, hostAllowed: true, service: true, personaAudience: host, personalViewer: host } };
    slack.send = (data: string) => slack.frames.push(JSON.parse(data));
    const broadcast = createBroadcaster(new Set([loose, owner, slack]), () => 1);
    broadcast({ type: "review:updated", payload: { packetId: "p", owner: host, status: "pending" }, timestamp: "t", audience: host } as WsMessage);
    broadcast({ type: "steer:queued", payload: { body: "secret comment" }, timestamp: "t", audience: host, requireProof: true } as WsMessage);
    expect(loose.frames).toEqual([]);
    expect(slack.frames).toEqual([]);
    expect(owner.frames.map((f) => f.type)).toEqual(["review:updated", "steer:queued"]);
    // The routing flag is not part of what the client receives.
    expect(owner.frames[1]!.requireProof).toBeUndefined();
  });

  test("other addressed frames still reach the socket that resolves to their audience", () => {
    const loose = unproven();
    const broadcast = createBroadcaster(new Set([loose]), () => 1);
    broadcast({ type: "steer:queued", payload: { body: "plain" }, timestamp: "t", audience: host } as WsMessage);
    broadcast({ type: "knowledge:change", payload: {}, timestamp: "t", audience: host } as WsMessage);
    expect(loose.frames.map((f) => f.type)).toEqual(["steer:queued", "knowledge:change"]);
  });

  test("reviews:pending reaches the owner's unproven socket that review:updated skips, and no one else", () => {
    const loose = unproven();
    const guest = client("dave", true, { personalViewer: "dave" });
    const broadcast = createBroadcaster(new Set([loose, guest]), () => 1);
    broadcast({ type: "review:updated", payload: { packetId: "p", owner: host, status: "pending" }, timestamp: "t", audience: host } as WsMessage);
    broadcast({ type: "reviews:pending", payload: { count: 1 }, timestamp: "t", audience: host } as WsMessage);
    expect(loose.frames.map((f) => f.type)).toEqual(["reviews:pending"]);
    expect(loose.frames[0]!.seq).toBeUndefined();
    expect(guest.frames).toEqual([]);
  });
});

describe("personalViewerOf", () => {
  test("the host's socket views the host; a guest only with a proof of that guest", () => {
    expect(personalViewerOf("carol", "carol", {})).toBe("carol");
    expect(personalViewerOf("dave", "carol", {})).toBeUndefined();
    expect(personalViewerOf("dave", "carol", { personaAudience: "dave" })).toBe("dave");
    expect(personalViewerOf("carol", "carol", { personaAudience: "dave" })).toBe("dave");
    expect(personalViewerOf("anonymous", "carol", {})).toBeUndefined();
  });
});

describe("personaProof", () => {
  const secrets = generateOwnerSecrets();
  const headers =
    (h: Record<string, string>) =>
    (name: string): string | null =>
      h[name.toLowerCase()] ?? null;

  test("the owner secret proves the host, or the user an owner channel names; on a service relay, every user", () => {
    expect(personaProof(headers({ [OWNER_TOKEN_HEADER]: secrets.ownerToken }), "carol", "carol", false, secrets)).toEqual({
      personaAudience: "carol",
    });
    expect(
      personaProof(headers({ [OWNER_TOKEN_HEADER]: secrets.ownerToken, [PERSONA_USER_HEADER]: "dave" }), "carol", "carol", false, secrets)
    ).toEqual({ personaAudience: "dave" });
    expect(personaProof(headers({ [OWNER_TOKEN_HEADER]: secrets.ownerToken }), "carol", "carol", true, secrets)).toEqual({
      personaRelay: true,
    });
  });

  test("a user token proves its own alias only; a forged header or a wrong token proves nothing", () => {
    const token = userChannelToken(secrets.ownerToken, "dave");
    expect(personaProof(headers({ [USER_CHANNEL_HEADER]: token }), "dave", "carol", false, secrets)).toEqual({
      personaAudience: "dave",
    });
    expect(personaProof(headers({ [USER_CHANNEL_HEADER]: token }), "someone", "carol", false, secrets)).toEqual({});
    expect(personaProof(headers({}), "dave", "carol", false, secrets)).toEqual({});
    // The owner secret on a browser upgrade under another identity proves nothing about the host.
    expect(personaProof(headers({ [OWNER_TOKEN_HEADER]: secrets.ownerToken }), "dave", "carol", false, secrets)).toEqual({});
    expect(personaProof(headers({ [OWNER_TOKEN_HEADER]: "wrong" }), "carol", "carol", true, secrets)).toEqual({});
  });
});

describe("isAllowedHost", () => {
  test.each([
    ["localhost", true],
    ["localhost:7777", true],
    ["127.0.0.1:5173", true],
    ["[::1]:7777", true],
    ["LOCALHOST:1", true],
    ["rebind.attacker.example:7777", false],
    ["127.0.0.1.attacker.example", false],
    ["localhost.attacker.example", false],
    ["", false],
  ])("%s → %p", (host, allowed) => {
    expect(isAllowedHost(host, "")).toBe(allowed);
  });

  test("STANDUP_ALLOWED_HOSTS adds names, a bare host matching any port", () => {
    const env = "owner-standup.tunnels.example, box.local:7777";
    expect(isAllowedHost("owner-standup.tunnels.example", env)).toBe(true);
    expect(isAllowedHost("owner-standup.tunnels.example:443", env)).toBe(true);
    expect(isAllowedHost("box.local:7777", env)).toBe(true);
    expect(isAllowedHost("box.local:8080", env)).toBe(false);
    expect(isAllowedHost("evil.example", env)).toBe(false);
  });

  test("a specific STANDUP_BIND_HOST is allowed on any port; a wildcard bind adds nothing", () => {
    expect(isAllowedHost("10.0.0.5:7777", "", "10.0.0.5")).toBe(true);
    expect(isAllowedHost("10.0.0.5", "", "10.0.0.5")).toBe(true);
    expect(isAllowedHost("[fd00::5]:7777", "", "fd00::5")).toBe(true);
    expect(isAllowedHost("10.0.0.6:7777", "", "10.0.0.5")).toBe(false);
    for (const wildcard of ["0.0.0.0", "::", "", undefined]) {
      expect(isAllowedHost("0.0.0.0:7777", "", wildcard)).toBe(false);
      expect(isAllowedHost("evil.example:7777", "", wildcard)).toBe(false);
    }
  });
});

describe("ReplayBuffer", () => {
  test("covers a cursor only while every later frame is still buffered", () => {
    const buf = new ReplayBuffer(3);
    expect(buf.covers(0, 0)).toBe(true);
    expect(buf.covers(1, 0)).toBe(false);
    for (let s = 1; s <= 5; s++) buf.push(s, `f${s}`);
    expect(buf.oldest()).toBe(3);
    expect(buf.covers(1, 5)).toBe(false);
    expect(buf.covers(2, 5)).toBe(true);
    expect(buf.covers(5, 5)).toBe(true);
    expect(buf.covers(6, 5)).toBe(false);
    expect(buf.covers(2.5, 5)).toBe(false);
    expect(buf.after(2)).toEqual(["f3", "f4", "f5"]);
    expect(buf.after(4)).toEqual(["f5"]);
    expect(buf.after(5)).toEqual([]);
  });

  test("the broadcaster buffers sequenced frames only", () => {
    const seen: Array<[number, string]> = [];
    let seq = 0;
    const broadcast = createBroadcaster(new Set(), () => ++seq, (s, data) => seen.push([s, data]));
    broadcast({ type: "session:status", payload: {}, timestamp: "t" });
    broadcast({ type: "persona:message", payload: {}, timestamp: "t", audience: "alice" } as WsMessage);
    broadcast({ type: "session:end", payload: {}, timestamp: "t" });
    expect(seen.map(([s, d]) => [s, JSON.parse(d).type])).toEqual([
      [1, "session:status"],
      [2, "session:end"],
    ]);
  });

  test("parseResumeCursor reads ?epoch=&since= and rejects malformed values", () => {
    expect(parseResumeCursor("/?epoch=abc&since=12")).toEqual({ epoch: "abc", since: 12 });
    expect(parseResumeCursor("/?epoch=abc")).toBeUndefined();
    expect(parseResumeCursor("/?since=3")).toBeUndefined();
    expect(parseResumeCursor("/?epoch=abc&since=-1")).toBeUndefined();
    expect(parseResumeCursor("/?epoch=abc&since=1.5")).toBeUndefined();
  });
});

describe("ws server resume and drain", () => {
  type Frame = Record<string, unknown> & { type: string; seq?: number; payload?: unknown };
  const servers: WsServerHandle[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const s of sockets.splice(0)) s.close();
    for (const s of servers.splice(0)) await s.close(1000, 200);
  });

  function start(epoch = "epoch-1", getSnapshot = async () => ({}) as Snapshot): WsServerHandle {
    const handle = createWsServer(
      0,
      getSnapshot,
      () => {},
      resolveIdentityConfigFromEnv({}),
      { epoch, hostname: "127.0.0.1" }
    );
    servers.push(handle);
    return handle;
  }

  /** Opens a socket and resolves once hello-ok and `extra` further non-presence frames arrived. */
  function connect(handle: WsServerHandle, query = "", extra = 0) {
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/${query}`);
    sockets.push(ws);
    const frames: Frame[] = [];
    let closeCode: number | undefined;
    const closed = new Promise<number>((resolve) => ws.addEventListener("close", (e) => resolve((closeCode = e.code))));
    const ready = new Promise<void>((resolve) => {
      ws.addEventListener("message", (e) => {
        const frame = JSON.parse(String(e.data)) as Frame;
        if (frame.type === "presence:state") return;
        frames.push(frame);
        if (frames.length >= 1 + extra) resolve();
      });
    });
    return { ws, frames, ready, closed, closeCode: () => closeCode };
  }

  const status = (n: number): WsMessage => ({ type: "session:status", payload: { n }, timestamp: "t" });
  const hello = (frames: Frame[]) => frames[0]!.payload as HelloOkPayload;

  test("a fresh connection gets a non-resumed hello-ok carrying the epoch and current seq", async () => {
    const handle = start();
    for (let i = 1; i <= 3; i++) handle.broadcast(status(i));
    const c = connect(handle);
    await c.ready;
    expect(c.frames[0]!.type).toBe("hello-ok");
    expect(hello(c.frames)).toMatchObject({ serverSeq: 3, epoch: "epoch-1" });
    expect(hello(c.frames).resumed).toBeUndefined();
  });

  test("a resume within the epoch replays exactly the missed frames in order, then goes live", async () => {
    let builds = 0;
    const handle = start("epoch-1", async () => {
      builds++;
      return {} as Snapshot;
    });
    for (let i = 1; i <= 5; i++) handle.broadcast(status(i));
    // An audience-scoped frame is unsequenced and must not be replayed. The
    // audience is a fixed alias: an env-derived one ($USER) is unset under
    // `env -i`, which would make this an unaddressed, sequenced frame.
    handle.broadcast({ type: "persona:message", payload: {}, timestamp: "t", audience: "alice" } as WsMessage);
    const c = connect(handle, "?epoch=epoch-1&since=2", 3);
    await c.ready;
    expect(hello(c.frames)).toMatchObject({ resumed: true, serverSeq: 2, epoch: "epoch-1" });
    // A resumed client keeps its state, so no snapshot is built for it.
    expect(hello(c.frames).snapshot).toBeUndefined();
    expect(builds).toBe(0);
    expect(c.frames.slice(1).map((f) => [f.type, f.seq])).toEqual([
      ["session:status", 3],
      ["session:status", 4],
      ["session:status", 5],
    ]);
    handle.broadcast(status(6));
    await Bun.sleep(50);
    expect(c.frames.slice(1).map((f) => f.seq)).toEqual([3, 4, 5, 6]);
  });

  test("a cursor at the current seq resumes with nothing to replay", async () => {
    const handle = start();
    for (let i = 1; i <= 2; i++) handle.broadcast(status(i));
    const c = connect(handle, "?epoch=epoch-1&since=2");
    await c.ready;
    await Bun.sleep(30);
    expect(hello(c.frames)).toMatchObject({ resumed: true, serverSeq: 2 });
    expect(c.frames).toHaveLength(1);
  });

  test("a cursor that becomes resumable while its snapshot builds is resumed, snapshot included", async () => {
    let release!: () => void;
    const built = new Promise<void>((resolve) => (release = resolve));
    const handle = start("epoch-1", async () => {
      await built;
      return { projects: [] } as unknown as Snapshot;
    });
    handle.broadcast(status(1));
    // The cursor is ahead of the server when it connects, so a snapshot is built.
    const c = connect(handle, "?epoch=epoch-1&since=2", 0);
    await Bun.sleep(30);
    handle.broadcast(status(2));
    release();
    await c.ready;
    await Bun.sleep(30);
    expect(hello(c.frames)).toMatchObject({ resumed: true, serverSeq: 2 });
    expect(hello(c.frames).snapshot).toEqual({ projects: [] } as unknown as Snapshot);
    expect(c.frames).toHaveLength(1);
  });

  test("a wrong epoch, a cursor ahead of the server, or one older than the buffer gets a full hello-ok", async () => {
    const handle = start();
    for (let i = 1; i <= REPLAY_BUFFER_CAP + 5; i++) handle.broadcast(status(i));
    const current = REPLAY_BUFFER_CAP + 5;
    for (const query of ["?epoch=other&since=10", `?epoch=epoch-1&since=${current + 1}`, "?epoch=epoch-1&since=4"]) {
      const c = connect(handle, query);
      await c.ready;
      await Bun.sleep(30);
      expect(hello(c.frames).resumed).toBeUndefined();
      expect(hello(c.frames).snapshot).toBeDefined();
      expect(hello(c.frames).serverSeq).toBe(current);
      expect(c.frames).toHaveLength(1);
    }
    // The oldest cursor still covered: seq 5 is evicted only after 6 was buffered.
    const edge = connect(handle, "?epoch=epoch-1&since=5", REPLAY_BUFFER_CAP);
    await edge.ready;
    expect(hello(edge.frames)).toMatchObject({ resumed: true, serverSeq: 5 });
    expect(edge.frames[1]!.seq).toBe(6);
    expect(edge.frames.at(-1)!.seq).toBe(current);
  });

  test("a client whose snapshot fails is closed with 1011, never registered", async () => {
    let fail = true;
    const handle = start("epoch-1", async () => {
      if (fail) throw new Error("db closed");
      return {} as Snapshot;
    });
    const c = connect(handle);
    expect(await c.closed).toBe(WS_CLOSE_INTERNAL_ERROR);
    handle.broadcast(status(1));
    await Bun.sleep(30);
    expect(c.frames).toHaveLength(0);
    // The reconnect, once the snapshot builds again, boots normally.
    fail = false;
    const again = connect(handle);
    await again.ready;
    expect(hello(again.frames)).toMatchObject({ serverSeq: 1, epoch: "epoch-1" });
  });

  test("close sends every client 1012 and refuses new upgrades as draining", async () => {
    const handle = start();
    const a = connect(handle);
    const b = connect(handle);
    await Promise.all([a.ready, b.ready]);
    const port = handle.port;
    const closing = handle.close();
    expect(await a.closed).toBe(WS_CLOSE_SERVICE_RESTART);
    expect(await b.closed).toBe(WS_CLOSE_SERVICE_RESTART);
    await closing;
    servers.splice(servers.indexOf(handle), 1);
    // The listener is gone once close resolves.
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });
});

/**
 * A server-side socket driven straight through createSocketHandlers. `send`
 * answers each frame (by its index) the way Bun would: undefined or a byte
 * count when sent, -1 when queued, 0 when dropped, or by throwing. Closing it
 * records the code and whether the socket was registered at that moment, then
 * runs the close handler, as Bun does.
 */
type FakeSocket = WsClient & { sent: string[]; closes: Array<number | undefined>; registeredAtClose: boolean[] };

function harness(
  epoch = "epoch-1",
  getSnapshot = async () => ({}) as Snapshot,
  silence: { clientSilentMs?: number; now?: () => number } = {}
) {
  const clients = new Set<WsClient>();
  const replay = new ReplayBuffer();
  let seq = 0;
  let closing = false;
  const handlers = createSocketHandlers({
    clients,
    replay,
    epoch,
    getSnapshot,
    seq: () => seq,
    closing: () => closing,
    ...silence,
  });
  const broadcast = createBroadcaster(clients, () => ++seq, (s, data) => replay.push(s, data));

  function socket(
    user: string,
    answer: (index: number, data: string) => number | void = () => undefined,
    data: Partial<NonNullable<WsClient["data"]>> = {}
  ): FakeSocket {
    const s: FakeSocket = {
      sent: [],
      closes: [],
      registeredAtClose: [],
      readyState: 1,
      data: { user, hostAllowed: true, ...data },
      send(frame: string) {
        const result = answer(s.sent.length, frame);
        s.sent.push(frame);
        return result;
      },
      close(code?: number) {
        s.closes.push(code);
        s.registeredAtClose.push(clients.has(s));
        if (s.readyState === 3) return;
        s.readyState = 3;
        handlers.close(s);
      },
    };
    return s;
  }

  const types = (s: FakeSocket) => s.sent.map((f) => (f === HEARTBEAT_FRAME ? f : (JSON.parse(f) as { type: string }).type));
  /** The roster in the last presence:state frame `s` received. */
  const roster = (s: FakeSocket): PresenceEntry[] => {
    const last = s.sent.map((f) => (f === HEARTBEAT_FRAME ? undefined : JSON.parse(f))).filter((f) => f?.type === "presence:state").at(-1);
    return (last?.payload ?? []) as PresenceEntry[];
  };

  const shutDown = () => {
    closing = true;
  };

  return { clients, replay, handlers, broadcast, socket, types, roster, shutDown };
}

const DROPPED = 0;
const throws = () => {
  throw new Error("socket gone");
};

describe("ws socket handlers — a frame Bun drops at connect", () => {
  /** Asserts `s` was closed with `code` before ever being registered, and that no roster went out for it. */
  function expectNeverRegistered(h: ReturnType<typeof harness>, s: FakeSocket, code: number, bystander: FakeSocket) {
    expect(s.closes).toEqual([code]);
    expect(s.registeredAtClose).toEqual([false]);
    expect([...h.clients]).toEqual([bystander]);
    // The only roster the bystander saw is the one from its own connect.
    expect(h.types(bystander).filter((t) => t === "presence:state")).toHaveLength(1);
  }

  /** A healthy socket already connected, and how many frames it had before the next open. */
  async function withBystander(h: ReturnType<typeof harness>) {
    const bystander = h.socket("bob");
    await h.handlers.open(bystander);
    return { bystander, before: bystander.sent.length };
  }

  test("a dropped hello-ok closes the socket with 1011, replays nothing and never registers it", async () => {
    const h = harness();
    const { bystander, before } = await withBystander(h);
    h.broadcast({ type: "session:status", payload: {}, timestamp: "t" });
    const s = h.socket("alice", () => DROPPED, { resume: { epoch: "epoch-1", since: 0 } });
    await h.handlers.open(s);
    expectNeverRegistered(h, s, WS_CLOSE_INTERNAL_ERROR, bystander);
    expect(s.sent.map((f) => JSON.parse(f).type)).toEqual(["hello-ok"]);
    // The bystander got the broadcast and no roster naming alice.
    expect(h.types(bystander).slice(before)).toEqual(["session:status"]);
    // Later broadcasts never reach it.
    h.broadcast({ type: "session:status", payload: {}, timestamp: "t" });
    expect(s.sent).toHaveLength(1);
  });

  test("a socket that closes while its snapshot builds is never registered", async () => {
    let release!: () => void;
    const built = new Promise<void>((resolve) => (release = resolve));
    const h = harness("epoch-1", async () => {
      await built;
      return {} as Snapshot;
    });
    const s = h.socket("alice");
    const opening = h.handlers.open(s);
    s.close?.(1001);
    release();
    await opening;
    expect(s.sent).toEqual([]);
    expect(s.registeredAtClose).toEqual([false]);
    expect(h.clients.size).toBe(0);
  });

  test("an open that completes while the server shuts down closes with a service restart, unregistered", async () => {
    const h = harness();
    h.shutDown();
    const s = h.socket("alice");
    await h.handlers.open(s);
    expect(s.closes).toEqual([WS_CLOSE_SERVICE_RESTART]);
    expect(s.registeredAtClose).toEqual([false]);
    expect(h.clients.size).toBe(0);
  });

  test("a snapshot that can't be serialized closes the socket with 1011 instead of leaving it open without a hello-ok", async () => {
    // Only alice's (the second) snapshot holds a BigInt.
    let builds = 0;
    const h = harness("epoch-1", async () => (++builds === 2 ? { projects: [1n] } : {}) as unknown as Snapshot);
    const { bystander } = await withBystander(h);
    const s = h.socket("alice");
    await h.handlers.open(s);
    expectNeverRegistered(h, s, WS_CLOSE_INTERNAL_ERROR, bystander);
    expect(s.sent).toEqual([]);
  });

  test("a hello-ok or replayed frame dropped while the server shuts down closes with a service restart", async () => {
    const h = harness();
    const { bystander } = await withBystander(h);
    h.broadcast({ type: "session:status", payload: {}, timestamp: "t" });
    h.shutDown();
    const hello = h.socket("alice", () => DROPPED);
    await h.handlers.open(hello);
    expectNeverRegistered(h, hello, WS_CLOSE_SERVICE_RESTART, bystander);
    const replayed = h.socket("carol", (i) => (i === 1 ? DROPPED : undefined), { resume: { epoch: "epoch-1", since: 0 } });
    await h.handlers.open(replayed);
    expectNeverRegistered(h, replayed, WS_CLOSE_SERVICE_RESTART, bystander);
  });

  test("a hello-ok send that throws closes the socket with 1011 and never registers it", async () => {
    const h = harness();
    const { bystander } = await withBystander(h);
    const s = h.socket("alice", throws);
    await h.handlers.open(s);
    expectNeverRegistered(h, s, WS_CLOSE_INTERNAL_ERROR, bystander);
  });

  test("a dropped replay frame closes the socket with 1011, sends nothing after it and never registers it", async () => {
    const h = harness();
    const { bystander, before } = await withBystander(h);
    for (let i = 1; i <= 3; i++) h.broadcast({ type: "session:status", payload: { n: i }, timestamp: "t" });
    // hello-ok is frame 0, the replay of seq 1 frame 1, of seq 2 frame 2.
    const s = h.socket("alice", (i) => (i === 2 ? DROPPED : undefined), { resume: { epoch: "epoch-1", since: 0 } });
    await h.handlers.open(s);
    expect(s.sent.map((f) => [JSON.parse(f).type, JSON.parse(f).seq])).toEqual([
      ["hello-ok", undefined],
      ["session:status", 1],
      ["session:status", 2],
    ]);
    expectNeverRegistered(h, s, WS_CLOSE_INTERNAL_ERROR, bystander);
    expect(h.types(bystander).slice(before)).toEqual(["session:status", "session:status", "session:status"]);
  });

  test("a replay send that throws closes the socket with 1011 too", async () => {
    const h = harness();
    const { bystander } = await withBystander(h);
    h.broadcast({ type: "session:status", payload: {}, timestamp: "t" });
    const s = h.socket("alice", (i) => (i === 1 ? throws() : undefined), { resume: { epoch: "epoch-1", since: 0 } });
    await h.handlers.open(s);
    expectNeverRegistered(h, s, WS_CLOSE_INTERNAL_ERROR, bystander);
  });

  test("a hello-ok and replay sent or queued under backpressure register the socket", async () => {
    const h = harness();
    h.broadcast({ type: "session:status", payload: {}, timestamp: "t" });
    const queued = h.socket("alice", () => -1, { resume: { epoch: "epoch-1", since: 0 } });
    const sent = h.socket("bob", () => 42);
    await h.handlers.open(queued);
    await h.handlers.open(sent);
    expect(queued.closes).toEqual([]);
    expect(sent.closes).toEqual([]);
    expect([...h.clients]).toEqual([queued, sent]);
    expect(h.types(queued).slice(0, 2)).toEqual(["hello-ok", "session:status"]);
  });
});

describe("ws socket handlers — a client that has gone silent", () => {
  /** A harness on a clock the test moves. */
  function clocked(clientSilentMs = DEFAULT_CLIENT_SILENT_MS) {
    let t = 1_000_000;
    const h = harness("epoch-1", async () => ({}) as Snapshot, { clientSilentMs, now: () => t });
    return { h, advance: (ms: number) => (t += ms) };
  }

  test("a socket left open after its page went away is closed with 4000 and forgotten, and stops taking frames", async () => {
    const { h, advance } = clocked();
    // A tunnel keeps the local leg of a socket the browser replaced: it
    // reads every frame and never sends one.
    const leaked = h.socket("alice");
    const live = h.socket("alice");
    await h.handlers.open(leaked);
    await h.handlers.open(live);
    // 80s of heartbeats: under the 90s limit.
    for (let i = 0; i < 8; i++) {
      advance(10_000);
      h.handlers.heartbeat();
      h.handlers.message(live, HEARTBEAT_ACK_FRAME);
    }
    expect(leaked.closes).toEqual([]);
    advance(10_000);
    h.handlers.heartbeat();
    expect(leaked.closes).toEqual([WS_CLOSE_CLIENT_SILENT]);
    expect(live.closes).toEqual([]);
    expect([...h.clients]).toEqual([live]);
    const before = leaked.sent.length;
    h.broadcast({ type: "session:status", payload: {}, timestamp: new Date().toISOString() } as WsMessage);
    h.handlers.heartbeat();
    expect(leaked.sent.length).toBe(before);
    expect(h.types(live).at(-1)).toBe(HEARTBEAT_FRAME);
  });

  test("any frame keeps a client: pings, presence and heartbeat acks all count", async () => {
    const { h, advance } = clocked(30_000);
    const pinger = h.socket("a");
    const present = h.socket("b");
    const acker = h.socket("c");
    for (const s of [pinger, present, acker]) await h.handlers.open(s);
    for (let i = 0; i < 6; i++) {
      advance(20_000);
      h.handlers.message(pinger, "ping");
      h.handlers.message(present, JSON.stringify({ kind: "presence:set", viewingSessionId: null, typing: false }));
      h.handlers.message(acker, HEARTBEAT_ACK_FRAME);
      h.handlers.heartbeat();
    }
    expect(h.clients.size).toBe(3);
    for (const s of [pinger, present, acker]) expect(s.closes).toEqual([]);
  });

  test("the roster drops a closed silent client, and 0 keeps every client", async () => {
    const { h, advance } = clocked();
    const gone = h.socket("ghost");
    const here = h.socket("bob");
    await h.handlers.open(gone);
    await h.handlers.open(here);
    advance(DEFAULT_CLIENT_SILENT_MS - 1);
    h.handlers.message(here, HEARTBEAT_ACK_FRAME);
    advance(1);
    h.handlers.heartbeat();
    expect(h.roster(here).map((e) => e.user)).toEqual(["bob"]);

    const off = clocked(0);
    const quiet = off.h.socket("alice");
    await off.h.handlers.open(quiet);
    off.advance(10 * DEFAULT_CLIENT_SILENT_MS);
    off.h.handlers.heartbeat();
    expect(quiet.closes).toEqual([]);
    expect(off.h.clients.has(quiet)).toBe(true);
  });
});

describe("ws broadcaster — a dropped client goes through the close handler", () => {
  test("it is forgotten as a departure: the others get a roster without it", async () => {
    const h = harness();
    let drop = false;
    const stale = h.socket("alice", () => (drop ? DROPPED : undefined));
    const healthy = h.socket("bob");
    await h.handlers.open(stale);
    await h.handlers.open(healthy);
    const broadcast = createBroadcaster(h.clients, () => 1, undefined, (c) => h.handlers.close(c));
    drop = true;
    broadcast({ type: "session:status", payload: {}, timestamp: "t" });
    expect(stale.closes).toEqual([WS_CLOSE_INTERNAL_ERROR]);
    expect([...h.clients]).toEqual([healthy]);
    expect(h.roster(healthy).map((e) => e.user)).toEqual(["bob"]);
  });
});

describe("ws socket handlers — a heartbeat Bun drops", () => {
  test("closes that socket with 1011; the close handler forgets it and the others keep their heartbeat", async () => {
    const h = harness();
    let drop = false;
    const stale = h.socket("alice", () => (drop ? DROPPED : undefined));
    const healthy = h.socket("bob");
    await h.handlers.open(stale);
    await h.handlers.open(healthy);
    drop = true;
    h.handlers.heartbeat();
    expect(stale.closes).toEqual([WS_CLOSE_INTERNAL_ERROR]);
    expect(healthy.closes).toEqual([]);
    expect(h.clients.has(stale)).toBe(false);
    expect(h.types(healthy).filter((t) => t === HEARTBEAT_FRAME)).toHaveLength(1);
    // The departure re-sent the roster without alice.
    expect(h.roster(healthy).map((e) => e.user)).toEqual(["bob"]);
    h.handlers.heartbeat();
    expect(h.types(healthy).filter((t) => t === HEARTBEAT_FRAME)).toHaveLength(2);
    expect(h.types(stale).filter((t) => t === HEARTBEAT_FRAME)).toHaveLength(1);
  });

  test("a heartbeat send that throws closes the socket with 1011", async () => {
    const h = harness();
    let broken = false;
    const s = h.socket("alice", () => (broken ? throws() : undefined));
    await h.handlers.open(s);
    broken = true;
    h.handlers.heartbeat();
    expect(s.closes).toEqual([WS_CLOSE_INTERNAL_ERROR]);
    expect(h.clients.size).toBe(0);
  });

  test("a heartbeat queued under backpressure keeps the socket", async () => {
    const h = harness();
    const s = h.socket("alice", () => -1);
    await h.handlers.open(s);
    h.handlers.heartbeat();
    expect(s.closes).toEqual([]);
    expect(h.clients.has(s)).toBe(true);
  });
});

describe("ws socket handlers — presence", () => {
  const set = (viewingSessionId: unknown, typing?: unknown) => JSON.stringify({ kind: "presence:set", viewingSessionId, typing });

  test("several tabs of one user collapse to one roster row, the newest update winning", async () => {
    const h = harness();
    const tab1 = h.socket("alice");
    const tab2 = h.socket("alice");
    const bob = h.socket("bob");
    for (const s of [tab1, tab2, bob]) await h.handlers.open(s);
    h.handlers.message(tab2, set("s-2"));
    await Bun.sleep(5);
    h.handlers.message(tab1, set("s-1", true));
    expect(h.roster(bob)).toEqual([
      expect.objectContaining({ user: "alice", viewingSessionId: "s-1", typing: true }),
      expect.objectContaining({ user: "bob", viewingSessionId: null, typing: false }),
    ]);
    // The newest wins, whichever tab connected first.
    await Bun.sleep(5);
    h.handlers.message(tab2, set("s-3"));
    expect(h.roster(bob).filter((e) => e.user === "alice")).toEqual([expect.objectContaining({ viewingSessionId: "s-3", typing: false })]);
  });

  test("a malformed presence:set is ignored or read as viewing nothing", async () => {
    const h = harness();
    const s = h.socket("alice");
    await h.handlers.open(s);
    const before = s.sent.length;
    for (const junk of ["{not json", "null", "42", JSON.stringify({ kind: "presence:other", viewingSessionId: "x" }), JSON.stringify({ viewingSessionId: "x" })]) {
      h.handlers.message(s, junk);
    }
    h.handlers.message(s, Buffer.from(set("x")));
    expect(s.sent).toHaveLength(before);
    // Nor did any of it change alice's row, as the next roster shows.
    const bob = h.socket("bob");
    await h.handlers.open(bob);
    expect(h.roster(bob).filter((e) => e.user === "alice")).toEqual([expect.objectContaining({ viewingSessionId: null, typing: false })]);
    // A presence:set whose fields have the wrong types records "viewing nothing", not the junk.
    h.handlers.message(s, set(42, "yes"));
    expect(h.roster(s).filter((e) => e.user === "alice")).toEqual([expect.objectContaining({ viewingSessionId: null, typing: true })]);
  });

  test("closing a socket drops its presence entry", async () => {
    const h = harness();
    const tab1 = h.socket("alice");
    const tab2 = h.socket("alice");
    const bob = h.socket("bob");
    for (const s of [tab1, tab2, bob]) await h.handlers.open(s);
    h.handlers.message(tab1, set("s-1"));
    await Bun.sleep(5);
    h.handlers.message(tab2, set("s-2"));
    tab2.close?.(1000);
    // alice's row falls back to the tab still open.
    expect(h.roster(bob).filter((e) => e.user === "alice")).toEqual([expect.objectContaining({ viewingSessionId: "s-1" })]);
    // The closed socket's entry is gone, not just hidden: the same socket
    // registered again starts out viewing nothing, so its stale, newer s-2 no
    // longer wins.
    tab2.readyState = 1;
    await h.handlers.open(tab2);
    expect(h.roster(bob).filter((e) => e.user === "alice")).toEqual([expect.objectContaining({ viewingSessionId: "s-1" })]);
    tab2.close?.(1000);
    tab1.close?.(1000);
    expect(h.roster(bob).map((e) => e.user)).toEqual(["bob"]);
    expect(h.clients.size).toBe(1);
  });

  test("ping is answered with pong", async () => {
    const h = harness();
    const s = h.socket("alice");
    h.handlers.message(s, "ping");
    expect(s.sent).toEqual(["pong"]);
  });
});

describe("ws broadcaster — which sockets get which frames", () => {
  const A = "alice";
  const B = "bob";
  const SOCKETS: Record<string, NonNullable<WsClient["data"]>> = {
    "host not allowed": { user: A, hostAllowed: false, personaAudience: A, personalViewer: A },
    service: { user: A, hostAllowed: true, service: true, personalViewer: A },
    "service proving A": { user: A, hostAllowed: true, service: true, personaAudience: A, personalViewer: A },
    "persona relay": { user: A, hostAllowed: true, service: true, personaRelay: true },
    "persona relay, host not allowed": { user: A, hostAllowed: false, service: true, personaRelay: true },
    "personaAudience A": { user: A, hostAllowed: true, personaAudience: A, personalViewer: A },
    "personaAudience B": { user: B, hostAllowed: true, personaAudience: B, personalViewer: B },
    "personalViewer A": { user: A, hostAllowed: true, personalViewer: A },
    anonymous: { user: "anonymous", hostAllowed: true },
  };
  // Every addressed frame is for A.
  const FRAMES: Record<string, WsMessage> = {
    "persona:*": { type: "persona:message", payload: {}, timestamp: "t", audience: A } as WsMessage,
    "review:*": { type: "review:updated", payload: {}, timestamp: "t", audience: A } as WsMessage,
    requireProof: { type: "steer:queued", payload: {}, timestamp: "t", audience: A, requireProof: true } as WsMessage,
    "other addressed": { type: "knowledge:change", payload: {}, timestamp: "t", audience: A } as WsMessage,
    unaddressed: { type: "session:status", payload: {}, timestamp: "t" },
  };
  // Which frame kinds each socket kind receives.
  const RECEIVES: Record<string, string[]> = {
    "host not allowed": ["unaddressed"],
    service: ["unaddressed"],
    "service proving A": ["unaddressed"],
    "persona relay": ["persona:*", "unaddressed"],
    "persona relay, host not allowed": ["unaddressed"],
    "personaAudience A": ["persona:*", "review:*", "requireProof", "other addressed", "unaddressed"],
    "personaAudience B": ["unaddressed"],
    "personalViewer A": ["other addressed", "unaddressed"],
    anonymous: ["unaddressed"],
  };
  const cases = Object.keys(SOCKETS).flatMap((socket) =>
    Object.keys(FRAMES).map((frame) => [socket, frame, RECEIVES[socket]!.includes(frame)] as const)
  );

  test.each(cases)("%s × %s → delivered %p", (socket, frame, delivered) => {
    const received: Array<Record<string, unknown>> = [];
    const target: WsClient = { readyState: 1, data: SOCKETS[socket], send: (data: string) => void received.push(JSON.parse(data)) };
    const buffered: number[] = [];
    let seq = 0;
    const broadcast = createBroadcaster(new Set([target]), () => ++seq, (s) => buffered.push(s));
    broadcast(FRAMES[frame]!);
    expect(received).toHaveLength(delivered ? 1 : 0);
    const addressed = FRAMES[frame]!.audience !== undefined;
    // An addressed frame carries no seq and never enters the replay buffer, delivered or not.
    expect(buffered).toEqual(addressed ? [] : [1]);
    if (delivered) {
      expect(received[0]!.type).toBe(FRAMES[frame]!.type);
      expect(received[0]!.seq).toEqual(addressed ? undefined : 1);
      expect(received[0]!.requireProof).toBeUndefined();
    }
    // Nor does it use up a seq: the next shared frame follows on without a gap.
    broadcast(FRAMES.unaddressed!);
    expect(received.at(-1)!.seq).toBe(addressed ? 1 : 2);
  });
});
