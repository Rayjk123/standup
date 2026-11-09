import { afterEach, describe, expect, test } from "bun:test";
import { connect, createServer, type AddressInfo, type Server as NetServer, type Socket } from "node:net";
import { gzipSync } from "node:zlib";
import type { Server, ServerWebSocket } from "bun";
import {
  GATEWAY_HOST,
  GATEWAY_HOST_IPV6,
  GATEWAY_REASON,
  GATEWAY_REASON_HEADER,
  GATEWAY_STATS_PATH,
  type GatewayStats,
  type LeaderInfo,
} from "@standup/shared/topology";
import { PERSONA_UPLOAD_BODY_MAX_BYTES, PERSONA_UPLOADS_PATH, PERSONA_VIDEO_MAX_BYTES } from "@standup/shared/persona";
import {
  MAX_BODY_BYTES,
  MAX_TOTAL_BUFFERED_BYTES,
  bodyCapFor,
  createGateway,
  isAddrUnavailable,
  isConnectionRefused,
  relayToClient,
  stripHeaders,
  type ClientLeg,
  type Gateway,
  type GatewayOptions,
} from "./gateway.js";
import { bindWithRetry, isAddrInUse } from "./startup.js";

const HOST = GATEWAY_HOST;
const cleanups: Array<() => unknown> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function leaderFor(pid: number, httpPort: number, wsPort: number): LeaderInfo {
  return { pid, httpPort, wsPort, epoch: `e${pid}`, acquiredAt: new Date().toISOString(), installDir: "/tmp" };
}

interface FakeCollector {
  pid: number;
  info: LeaderInfo;
  hits: Request[];
  http: Server<undefined>;
  ws: Server<{ pid: number }>;
  stop(): void;
}

/** A collector slot: /health reporting `healthPid`, an HTTP handler, and an echoing WebSocket port. */
function startCollector(
  pid: number,
  handle?: (req: Request) => Response | Promise<Response>,
  healthPid: number = pid
): FakeCollector {
  const hits: Request[] = [];
  const http = Bun.serve({
    hostname: HOST,
    port: 0,
    idleTimeout: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/health") return Response.json({ status: "ok", pid: healthPid });
      hits.push(req);
      return handle ? handle(req) : new Response(`hello from ${pid}`);
    },
  });
  const ws = Bun.serve<{ pid: number }>({
    hostname: HOST,
    port: 0,
    fetch(req, server) {
      const protocol = req.headers.get("sec-websocket-protocol")?.split(",")[0]?.trim();
      const ok = server.upgrade(req, {
        data: { pid },
        headers: protocol ? { "sec-websocket-protocol": protocol } : undefined,
      });
      return ok ? undefined : new Response("upgrade required", { status: 426 });
    },
    websocket: {
      open(socket) {
        socket.send(`hello ${socket.data.pid}`);
      },
      message(socket, message) {
        if (typeof message === "string") {
          if (message === "close-1012") socket.close(1012, "service restart");
          else socket.send(`echo:${message}`);
        } else {
          socket.send(message);
        }
      },
    },
  });
  const collector: FakeCollector = {
    pid,
    info: leaderFor(pid, http.port ?? 0, ws.port ?? 0),
    hits,
    http,
    ws,
    stop() {
      http.stop(true);
      ws.stop(true);
    },
  };
  cleanups.push(() => collector.stop());
  return collector;
}

function startGateway(overrides: Partial<GatewayOptions> & { vitePort?: number } = {}): Gateway {
  const gateway = createGateway({
    ports: { web: 0, collector: 0, ws: 0 },
    vitePort: 1,
    holdMs: 1500,
    retryIntervalMs: 20,
    healthTimeoutMs: 300,
    drainMs: 500,
    ...overrides,
  });
  cleanups.push(() => gateway.stop({ drainMs: 50 }));
  return gateway;
}

async function stats(port: number): Promise<GatewayStats> {
  return (await (await fetch(`http://${HOST}:${port}${GATEWAY_STATS_PATH}`)).json()) as GatewayStats;
}

/** Whether this host can bind [::1]; the IPv6 halves of the bind tests are skipped without it. */
const HAS_IPV6_LOOPBACK = (() => {
  try {
    Bun.serve({ hostname: GATEWAY_HOST_IPV6, port: 0, fetch: () => new Response("") }).stop(true);
    return true;
  } catch {
    return false;
  }
})();
const ipv6Test = HAS_IPV6_LOOPBACK ? test : test.skip;

/** A port that was free on 127.0.0.1 (and [::1], where the host has it) a moment ago. */
function freePort(): number {
  for (let i = 0; i < 20; i++) {
    const probe = Bun.serve({ hostname: HOST, port: 0, fetch: () => new Response("") });
    const port = probe.port ?? 0;
    probe.stop(true);
    if (!HAS_IPV6_LOOPBACK) return port;
    try {
      Bun.serve({ hostname: GATEWAY_HOST_IPV6, port, fetch: () => new Response("") }).stop(true);
      return port;
    } catch {
      // Taken on [::1]: try another.
    }
  }
  throw new Error("no port free on both loopbacks");
}

/** Asserts `host:port` can be bound right now (nothing, the gateway included, holds it). */
function expectBindable(host: string, port: number): void {
  const server = Bun.serve({ hostname: host, port, reusePort: false, fetch: () => new Response("") });
  server.stop(true);
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await Bun.sleep(5);
  }
}

/** A raw TCP "collector" for failure modes Bun.serve can't produce. */
async function startRawCollector(pid: number, onRequest: (socket: Socket) => void): Promise<{ port: number; hits: () => number }> {
  let hits = 0;
  const server: NetServer = createServer((socket) => {
    let seen = false;
    socket.on("data", (chunk) => {
      if (seen) return;
      seen = true;
      if (chunk.toString("latin1").startsWith("GET /health ")) {
        const body = JSON.stringify({ pid });
        socket.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
        return;
      }
      hits++;
      onRequest(socket);
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, HOST, () => resolve()));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { port: (server.address() as AddressInfo).port, hits: () => hits };
}

/** A client WebSocket with a message queue. */
function openClient(url: string, protocols?: string[]) {
  const socket = new WebSocket(url, protocols);
  socket.binaryType = "arraybuffer";
  const messages: Array<string | ArrayBuffer> = [];
  let closed: { code: number; reason: string } | undefined;
  socket.addEventListener("message", (event) => messages.push(event.data as string | ArrayBuffer));
  socket.addEventListener("close", (event) => {
    closed = { code: event.code, reason: event.reason };
  });
  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("close", () => reject(new Error("closed before open")));
  });
  cleanups.push(() => socket.close());
  return {
    socket,
    messages,
    opened,
    closed: () => closed,
    async next(): Promise<string | ArrayBuffer> {
      await waitFor(() => messages.length > 0);
      return messages.shift() as string | ArrayBuffer;
    },
  };
}

/**
 * A WebSocket upstream that sends a heartbeat every 20ms on each open socket,
 * as the collector does every 10s, and records how many are open and how each closed.
 */
function startChattyUpstream(pid: number) {
  const sockets = new Set<ServerWebSocket<undefined>>();
  const closes: Array<{ code: number; reason: string }> = [];
  let opened = 0;
  const server = Bun.serve({
    hostname: HOST,
    port: 0,
    fetch(req, srv) {
      if (new URL(req.url).pathname === "/health") return Response.json({ pid });
      return srv.upgrade(req) ? undefined : new Response("no", { status: 426 });
    },
    websocket: {
      open(ws) {
        opened++;
        sockets.add(ws);
      },
      message() {},
      close(ws, code, reason) {
        sockets.delete(ws);
        closes.push({ code, reason });
      },
    },
  });
  const beat = setInterval(() => {
    for (const ws of sockets) ws.send("hb");
  }, 20);
  cleanups.push(() => {
    clearInterval(beat);
    server.stop(true);
  });
  const port = server.port ?? 0;
  return {
    info: leaderFor(pid, port, port),
    closes,
    open: () => sockets.size,
    get opened() {
      return opened;
    },
  };
}

/**
 * A raw client leg that completes the WebSocket handshake, then reads every
 * byte and never writes one: no pong, no frame, no close.
 */
async function openSilentLeg(port: number) {
  const socket = connect({ host: HOST, port });
  cleanups.push(() => socket.destroy());
  let response = "";
  let received = 0;
  let ended = false;
  socket.on("data", (chunk) => {
    if (!response.includes("\r\n\r\n")) response += chunk.toString("latin1");
    else received += chunk.length;
  });
  socket.on("close", () => {
    ended = true;
  });
  socket.on("error", () => {});
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  socket.write(
    "GET /ws HTTP/1.1\r\n" +
      `Host: ${HOST}:${port}\r\n` +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
      "Sec-WebSocket-Version: 13\r\n\r\n"
  );
  await waitFor(() => response.includes("\r\n\r\n"));
  expect(response.startsWith("HTTP/1.1 101")).toBe(true);
  return { socket, received: () => received, ended: () => ended };
}

describe("HTTP proxying", () => {
  test("holds a request until a leader validates, then serves it", async () => {
    let leader: LeaderInfo | undefined;
    const gateway = startGateway({ leaderSource: () => leader });
    const pending = fetch(`http://${HOST}:${gateway.ports.collector}/api/x`);
    await Bun.sleep(250);
    expect((await stats(gateway.ports.collector)).heldNow).toBe(1);
    const collector = startCollector(4242);
    leader = collector.info;
    const res = await pending;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello from 4242");
    const s = await stats(gateway.ports.collector);
    expect(s.held).toBe(1);
    expect(s.heldNow).toBe(0);
    expect(s.maxHoldMs).toBeGreaterThanOrEqual(200);
    expect(s.failed).toBe(0);
    expect(s.upstream.collector).toBe(collector.info.httpPort);
  });

  test("follows a leader change and never routes to an upstream whose /health pid mismatches", async () => {
    const a = startCollector(1001);
    let leader: LeaderInfo | undefined = a.info;
    const gateway = startGateway({ leaderSource: () => leader, holdMs: 400 });
    const url = `http://${HOST}:${gateway.ports.collector}/api/x`;
    expect(await (await fetch(url)).text()).toBe("hello from 1001");

    const b = startCollector(1002);
    a.stop();
    leader = b.info;
    expect(await (await fetch(url)).text()).toBe("hello from 1002");

    // The file names pid 1003, but whatever listens on that port is someone else.
    const impostor = startCollector(1003, undefined, 999);
    leader = impostor.info;
    const res = await fetch(url);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("2");
    expect(impostor.hits).toHaveLength(0);
    expect(a.hits).toHaveLength(1);
    expect(b.hits).toHaveLength(1);
  });

  test("a connection reset before any response is failed, not retried", async () => {
    const raw = await startRawCollector(5001, (socket) => socket.destroy());
    const gateway = startGateway({ leaderSource: () => leaderFor(5001, raw.port, 1) });
    const res = await fetch(`http://${HOST}:${gateway.ports.collector}/api/hook`, { method: "POST", body: "{}" });
    expect(res.status).toBe(502);
    // On the collector listener even an idempotent GET is not resent.
    const get = await fetch(`http://${HOST}:${gateway.ports.collector}/api/x`);
    expect(get.status).toBe(502);
    await Bun.sleep(100);
    expect(raw.hits()).toBe(2);
    const s = await stats(gateway.ports.collector);
    expect(s.failed).toBe(2);
    expect(s.retried).toBe(0);
  });

  test("an upstream that dies mid-response is not retried and the client sees the failure", async () => {
    const raw = await startRawCollector(5002, (socket) => {
      socket.write("HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\npartial");
      setTimeout(() => socket.destroy(), 30);
    });
    const gateway = startGateway({ leaderSource: () => leaderFor(5002, raw.port, 1) });
    let error: unknown;
    try {
      const res = await fetch(`http://${HOST}:${gateway.ports.collector}/api/x`);
      await res.text();
    } catch (err) {
      error = err;
    }
    expect(error).toBeDefined();
    await Bun.sleep(100);
    expect(raw.hits()).toBe(1);
    const s = await stats(gateway.ports.collector);
    expect(s.failed).toBe(1);
    expect(s.retried).toBe(0);
  });

  test("retries a draining collector's refused 503 but passes a released 503 through", async () => {
    let refusals = 2;
    let processedBody = "";
    const collector = startCollector(2001, async (req) => {
      if (new URL(req.url).pathname === "/api/ask") {
        return new Response("released", { status: 503, headers: { "x-standup-draining": "released" } });
      }
      if (refusals-- > 0) return new Response("draining", { status: 503, headers: { "x-standup-draining": "refused" } });
      processedBody = await req.text();
      return new Response("processed");
    });
    const gateway = startGateway({ leaderSource: () => collector.info });
    const base = `http://${HOST}:${gateway.ports.collector}`;
    const ok = await fetch(`${base}/api/hook`, { method: "POST", body: "payload" });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("processed");
    expect(collector.hits).toHaveLength(3);
    expect(processedBody).toBe("payload");

    const released = await fetch(`${base}/api/ask`);
    expect(released.status).toBe(503);
    expect(released.headers.get("x-standup-draining")).toBe("released");
    expect(collector.hits).toHaveLength(4);
    const s = await stats(gateway.ports.collector);
    expect(s.retried).toBe(2);
    expect(s.held).toBe(1);
    expect(s.failed).toBe(0);
  });

  test("preserves Host, adds no forwarding headers, and passes gzip bodies through byte-identical", async () => {
    const gz = gzipSync(Buffer.from("compressed ".repeat(100)));
    let seen: Headers | undefined;
    const collector = startCollector(3001, (req) => {
      seen = req.headers;
      return new Response(gz, { headers: { "content-encoding": "gzip", "content-type": "text/plain", "x-custom": "kept" } });
    });
    const gateway = startGateway({ leaderSource: () => collector.info });
    const res = await fetch(`http://${HOST}:${gateway.ports.collector}/api/gz?q=1`, {
      headers: { host: "standup.example.test:5173", "accept-encoding": "gzip", cookie: "a=b", "x-standup-user": "alice" },
      decompress: false,
    });
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("x-custom")).toBe("kept");
    const body = Buffer.from(await res.arrayBuffer());
    expect(Buffer.compare(body, gz)).toBe(0);
    expect(seen?.get("host")).toBe("standup.example.test:5173");
    expect(seen?.get("cookie")).toBe("a=b");
    expect(seen?.get("x-standup-user")).toBe("alice");
    const names = [...(seen?.keys() ?? [])];
    expect(names.filter((n) => n.startsWith("x-forwarded") || n === "forwarded" || n === "via")).toEqual([]);
    expect(new URL(collector.hits[0]!.url).search).toBe("?q=1");
  });

  test("does not ask the upstream for an encoding the client never accepted", async () => {
    let encoding: string | null = null;
    const collector = startCollector(3002, (req) => {
      encoding = req.headers.get("accept-encoding");
      return new Response("plain");
    });
    const gateway = startGateway({ leaderSource: () => collector.info });
    const res = await fetch(`http://${HOST}:${gateway.ports.collector}/x`, { headers: { "accept-encoding": "" } });
    expect(await res.text()).toBe("plain");
    expect(encoding === null || encoding === "identity" || encoding === "").toBe(true);
  });

  test("streams a response instead of buffering it", async () => {
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const collector = startCollector(3003, () => {
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(encoder.encode("first;"));
            await released;
            controller.enqueue(encoder.encode("second"));
            controller.close();
          },
        })
      );
    });
    const gateway = startGateway({ leaderSource: () => collector.info });
    const res = await fetch(`http://${HOST}:${gateway.ports.collector}/api/stream`);
    const reader = res.body!.getReader();
    const first = await Promise.race([reader.read(), Bun.sleep(1000).then(() => undefined)]);
    expect(first).toBeDefined();
    expect(new TextDecoder().decode(first!.value)).toBe("first;");
    release();
    let rest = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toBe("second");
  });

  test("past the held cap a request is answered 503 Retry-After at once", async () => {
    let leader: LeaderInfo | undefined;
    const gateway = startGateway({ leaderSource: () => leader, maxHeld: 2, holdMs: 3000 });
    const url = `http://${HOST}:${gateway.ports.collector}/api/x`;
    const held = [fetch(url), fetch(url)];
    const deadline = Date.now() + 2000;
    while ((await stats(gateway.ports.collector)).heldNow < 2 && Date.now() < deadline) await Bun.sleep(10);
    const started = Date.now();
    const over = await fetch(url);
    // Well under the 3s a held request would wait.
    expect(Date.now() - started).toBeLessThan(1000);
    expect(over.status).toBe(503);
    expect(over.headers.get("retry-after")).toBe("2");
    expect(over.headers.get(GATEWAY_REASON_HEADER)).toBe(GATEWAY_REASON.heldCap);
    const collector = startCollector(6001);
    leader = collector.info;
    const results = await Promise.all(held);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const s = await stats(gateway.ports.collector);
    expect(s.failed).toBe(1);
    expect(s.held).toBe(2);
    expect(s.heldNow).toBe(0);
  });

  test("a body over the per-request cap is refused without reaching the upstream", async () => {
    const collector = startCollector(3004);
    const gateway = startGateway({ leaderSource: () => collector.info, maxBodyBytes: 1024 });
    const res = await fetch(`http://${HOST}:${gateway.ports.collector}/api/x`, { method: "POST", body: "x".repeat(4096) });
    expect(res.status).toBe(413);
    expect(collector.hits).toHaveLength(0);
  });

  test("the owner media upload alone gets the upload route's larger body cap", async () => {
    const collector = startCollector(3014);
    const gateway = startGateway({ leaderSource: () => collector.info, maxBodyBytes: 1024 });
    const body = "x".repeat(4096);
    const upload = await fetch(`http://${HOST}:${gateway.ports.collector}${PERSONA_UPLOADS_PATH}`, { method: "POST", body });
    expect(upload.status).toBe(200);
    const other = await fetch(`http://${HOST}:${gateway.ports.collector}/api/persona/messages`, { method: "POST", body });
    expect(other.status).toBe(413);
  });

  test.each([
    ["POST", PERSONA_UPLOADS_PATH, PERSONA_UPLOAD_BODY_MAX_BYTES],
    ["POST", `${PERSONA_UPLOADS_PATH}?x=1`, PERSONA_UPLOAD_BODY_MAX_BYTES],
    ["PUT", PERSONA_UPLOADS_PATH, MAX_BODY_BYTES],
    ["POST", `${PERSONA_UPLOADS_PATH}/extra`, MAX_BODY_BYTES],
    ["POST", "/api/persona/messages", MAX_BODY_BYTES],
  ])("bodyCapFor %s %s", (method, path, cap) => {
    expect(bodyCapFor(new Request(`http://${HOST}${path}`, { method }), MAX_BODY_BYTES)).toBe(cap);
  });

  test("the upload cap fits the largest video as base64", () => {
    expect(PERSONA_UPLOAD_BODY_MAX_BYTES).toBeGreaterThan((PERSONA_VIDEO_MAX_BYTES * 4) / 3);
    expect(PERSONA_UPLOAD_BODY_MAX_BYTES).toBeGreaterThan(MAX_BODY_BYTES);
    expect(PERSONA_UPLOAD_BODY_MAX_BYTES).toBeLessThan(MAX_TOTAL_BUFFERED_BYTES);
  });

  test("the web listener proxies everything to vite, the stats path included", async () => {
    const viteHits: string[] = [];
    const vite = Bun.serve({
      hostname: HOST,
      port: 0,
      fetch(req) {
        viteHits.push(new URL(req.url).pathname);
        return new Response("<html>vite</html>", { headers: { "content-type": "text/html" } });
      },
    });
    cleanups.push(() => vite.stop(true));
    const collector = startCollector(3005);
    const gateway = startGateway({ leaderSource: () => collector.info, vitePort: vite.port, version: "v-test", dataDir: "/data/one" });
    expect(await (await fetch(`http://${HOST}:${gateway.ports.web}/`)).text()).toBe("<html>vite</html>");
    for (const port of [gateway.ports.collector, gateway.ports.ws]) {
      const s = await stats(port);
      expect(s.pid).toBe(process.pid);
      expect(s.version).toBe("v-test");
      expect(s.dataDir).toBe("/data/one");
    }
    expect(await (await fetch(`http://${HOST}:${gateway.ports.web}${GATEWAY_STATS_PATH}`)).text()).toBe("<html>vite</html>");
    // Whatever the request carries, the web listener never answers for itself.
    const withProbeHeader = await fetch(`http://${HOST}:${gateway.ports.web}${GATEWAY_STATS_PATH}`, { headers: { "x-standup-gateway-probe": "1" } });
    expect(await withProbeHeader.text()).toBe("<html>vite</html>");
    expect(viteHits).toEqual(["/", GATEWAY_STATS_PATH, GATEWAY_STATS_PATH]);
    expect(collector.hits).toHaveLength(0);
  });

  test("on the web listener a GET whose upstream resets before responding is retried", async () => {
    let resets = 1;
    const vite = await startRawCollector(0, (socket) => {
      if (resets-- > 0) {
        socket.destroy();
        return;
      }
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nvite");
    });
    const gateway = startGateway({ leaderSource: () => undefined, vitePort: vite.port });
    const res = await fetch(`http://${HOST}:${gateway.ports.web}/src/main.tsx`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("vite");
    expect(vite.hits()).toBe(2);
    const s = await stats(gateway.ports.collector);
    expect(s.failed).toBe(0);
    expect(s.retried).toBe(1);
  });

  test("on the web listener a POST whose upstream resets is failed, not retried", async () => {
    const vite = await startRawCollector(0, (socket) => socket.destroy());
    const gateway = startGateway({ leaderSource: () => undefined, vitePort: vite.port });
    const res = await fetch(`http://${HOST}:${gateway.ports.web}/api/x`, { method: "POST", body: "{}" });
    expect(res.status).toBe(502);
    await Bun.sleep(100);
    expect(vite.hits()).toBe(1);
    const s = await stats(gateway.ports.collector);
    expect(s.failed).toBe(1);
    expect(s.retried).toBe(0);
  });

  test("on the web listener a GET whose upstream resets mid-response is not retried", async () => {
    const vite = await startRawCollector(0, (socket) => {
      socket.write("HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\npartial");
      setTimeout(() => socket.destroy(), 30);
    });
    const gateway = startGateway({ leaderSource: () => undefined, vitePort: vite.port });
    let error: unknown;
    try {
      const res = await fetch(`http://${HOST}:${gateway.ports.web}/src/main.tsx`);
      await res.text();
    } catch (err) {
      error = err;
    }
    expect(error).toBeDefined();
    await Bun.sleep(100);
    expect(vite.hits()).toBe(1);
    const s = await stats(gateway.ports.collector);
    expect(s.failed).toBe(1);
    expect(s.retried).toBe(0);
  });

  test("a client that hangs up mid-body is not counted as failed", async () => {
    const collector = startCollector(3006);
    const gateway = startGateway({ leaderSource: () => collector.info });
    const socket = connect(gateway.ports.collector, HOST);
    socket.on("error", () => {});
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    socket.write(`POST /api/x HTTP/1.1\r\nHost: ${HOST}\r\nContent-Length: 1000\r\n\r\npartial`);
    await Bun.sleep(100);
    socket.destroy();
    await Bun.sleep(150);
    const s = await stats(gateway.ports.collector);
    expect(s.failed).toBe(0);
    expect(collector.hits).toHaveLength(0);
  });

  test("a client that hangs up mid-hold frees its held slot and is not counted as failed", async () => {
    const gateway = startGateway({ leaderSource: () => undefined, holdMs: 3000 });
    const controller = new AbortController();
    const pending = fetch(`http://${HOST}:${gateway.ports.collector}/api/x`, { signal: controller.signal }).catch(() => undefined);
    const deadline = Date.now() + 2000;
    while ((await stats(gateway.ports.collector)).heldNow < 1 && Date.now() < deadline) await Bun.sleep(10);
    controller.abort();
    await pending;
    const release = Date.now() + 2000;
    while ((await stats(gateway.ports.collector)).heldNow > 0 && Date.now() < release) await Bun.sleep(10);
    const s = await stats(gateway.ports.collector);
    expect(s.heldNow).toBe(0);
    expect(s.held).toBe(1);
    expect(s.failed).toBe(0);
  });

  test("a hold times out with 503 when no upstream ever appears", async () => {
    const gateway = startGateway({ leaderSource: () => undefined, holdMs: 200 });
    const res = await fetch(`http://${HOST}:${gateway.ports.collector}/api/x`);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("2");
    const s = await stats(gateway.ports.collector);
    expect(s.failed).toBe(1);
    expect(s.heldNow).toBe(0);
    expect(s.maxHoldMs).toBeGreaterThanOrEqual(150);
  });
});

describe("no-leader window", () => {
  test("once no leader has validated for holdMs, requests and upgrades fail fast", async () => {
    const gateway = startGateway({ leaderSource: () => undefined, holdMs: 200 });
    await Bun.sleep(250);
    // Failing fast is asserted by the hold count below (nothing held); the
    // elapsed bounds only catch a stall.
    const started = Date.now();
    const res = await fetch(`http://${HOST}:${gateway.ports.collector}/api/hook`, { method: "POST", body: "{}" });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("2");
    expect(res.headers.get(GATEWAY_REASON_HEADER)).toBe(GATEWAY_REASON.noLeader);

    const wsStarted = Date.now();
    const client = openClient(`ws://${HOST}:${gateway.ports.ws}/ws`);
    await expect(client.opened).rejects.toThrow();
    expect(Date.now() - wsStarted).toBeLessThan(1000);
    const s = await stats(gateway.ports.collector);
    expect(s.held).toBe(0);
    expect(s.failed).toBe(2);
  });

  test("within holdMs of the last valid leader a request is held, then served by the next leader", async () => {
    const a = startCollector(9101);
    let leader: LeaderInfo | undefined = a.info;
    const gateway = startGateway({ leaderSource: () => leader, holdMs: 800 });
    const url = `http://${HOST}:${gateway.ports.collector}/api/x`;
    expect(await (await fetch(url)).text()).toBe("hello from 9101");
    // Past holdMs since gateway start: the window runs from the leader's last use, not from start.
    await Bun.sleep(850);
    expect(await (await fetch(url)).text()).toBe("hello from 9101");
    a.stop();
    const pending = fetch(url);
    const deadline = Date.now() + 2000;
    while ((await stats(gateway.ports.collector)).heldNow < 1 && Date.now() < deadline) await Bun.sleep(10);
    expect((await stats(gateway.ports.collector)).heldNow).toBe(1);
    const b = startCollector(9102);
    leader = b.info;
    const res = await pending;
    expect(await res.text()).toBe("hello from 9102");
    expect((await stats(gateway.ports.collector)).failed).toBe(0);
  });

  test("a leader whose port went dead stops counting as valid even while its file stays", async () => {
    const a = startCollector(9201);
    const gateway = startGateway({ leaderSource: () => a.info, holdMs: 300 });
    const url = `http://${HOST}:${gateway.ports.collector}/api/x`;
    expect((await fetch(url)).status).toBe(200);
    a.stop();
    const held = await fetch(url);
    expect(held.status).toBe(503);
    const heldBefore = (await stats(gateway.ports.collector)).held;
    const started = Date.now();
    const fast = await fetch(url);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(fast.headers.get(GATEWAY_REASON_HEADER)).toBe(GATEWAY_REASON.noLeader);
    // Answered without being held at all.
    expect((await stats(gateway.ports.collector)).held).toBe(heldBefore);
  });

  test("serves again at once when a leader returns after failing fast", async () => {
    let leader: LeaderInfo | undefined;
    const gateway = startGateway({ leaderSource: () => leader, holdMs: 150 });
    const url = `http://${HOST}:${gateway.ports.collector}/api/x`;
    await Bun.sleep(200);
    expect((await fetch(url)).status).toBe(503);
    const collector = startCollector(9301);
    leader = collector.info;
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello from 9301");
    const client = openClient(`ws://${HOST}:${gateway.ports.ws}/ws`);
    await client.opened;
    expect(await client.next()).toBe("hello 9301");
  });

  test("the web listener keeps holding for vite regardless of the collector leader", async () => {
    const probe = Bun.serve({ hostname: HOST, port: 0, fetch: () => new Response("") });
    const vitePort = probe.port ?? 0;
    probe.stop(true);
    const gateway = startGateway({ leaderSource: () => undefined, holdMs: 400, vitePort });
    await Bun.sleep(450);
    const pending = fetch(`http://${HOST}:${gateway.ports.web}/`);
    await Bun.sleep(100);
    const vite = Bun.serve({ hostname: HOST, port: vitePort, fetch: () => new Response("vite") });
    cleanups.push(() => vite.stop(true));
    expect(await (await pending).text()).toBe("vite");
  });
});

describe("relayToClient", () => {
  /** A client leg whose sends Bun answers with `status` (0: dropped or empty, -1: queued, n: bytes sent). */
  const leg = (status: number) => {
    const closes: Array<{ code?: number; reason?: string }> = [];
    const client: ClientLeg = { send: () => status, close: (code, reason) => void closes.push({ code, reason }) };
    return { client, closes };
  };

  test("a frame Bun dropped closes the client with 1011, so the console reconnects and resyncs", () => {
    const { client, closes } = leg(0);
    expect(relayToClient(client, '{"type":"persona:message"}')).toBe(false);
    expect(closes).toEqual([{ code: 1011, reason: "frame dropped" }]);
  });

  test("the 1011 the close handler forwards upstream is one Bun's WebSocket client can send", async () => {
    let seen: number | undefined;
    const upstream = Bun.serve({
      hostname: HOST,
      port: 0,
      fetch: (req, server) => (server.upgrade(req) ? undefined : new Response("no", { status: 426 })),
      websocket: {
        message() {},
        close(_ws, code) {
          seen = code;
        },
      },
    });
    cleanups.push(() => upstream.stop(true));
    const socket = new WebSocket(`ws://${HOST}:${upstream.port}/`);
    await new Promise((r) => socket.addEventListener("open", r));
    socket.close(1011, "frame dropped");
    await waitFor(() => seen !== undefined);
    expect(seen).toBe(1011);
  });

  test("passes the compress flag through to the leg's send", () => {
    const flags: Array<boolean | undefined> = [];
    const client: ClientLeg = { send: (_d, compress) => (flags.push(compress), 1), close: () => {} };
    relayToClient(client, "a", true);
    relayToClient(client, "b");
    expect(flags).toEqual([true, false]);
  });

  test("a queued frame, a sent one, and an empty one keep the client", () => {
    for (const [status, data] of [
      [-1, "x"],
      [5, "hello"],
      [0, ""],
      [0, new ArrayBuffer(0)],
    ] as const) {
      const { client, closes } = leg(status);
      expect(relayToClient(client, data)).toBe(true);
      expect(closes).toEqual([]);
    }
  });
});

describe("WebSocket proxying", () => {
  test("holds the upgrade until the upstream is up, relays both ways, and propagates 1012", async () => {
    let leader: LeaderInfo | undefined;
    const gateway = startGateway({ leaderSource: () => leader, holdMs: 3000 });
    const client = openClient(`ws://${HOST}:${gateway.ports.ws}/ws?since=5`, ["standup.v1"]);
    await Bun.sleep(200);
    expect(client.socket.readyState).toBe(WebSocket.CONNECTING);
    const collector = startCollector(7001);
    leader = collector.info;
    await client.opened;
    expect(client.socket.protocol).toBe("standup.v1");
    expect(await client.next()).toBe("hello 7001");
    client.socket.send("hi");
    expect(await client.next()).toBe("echo:hi");
    client.socket.send(new Uint8Array([1, 2, 3]));
    const binary = await client.next();
    expect(binary).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(binary as ArrayBuffer)]).toEqual([1, 2, 3]);
    client.socket.send("close-1012");
    await waitFor(() => client.closed() !== undefined);
    expect(client.closed()).toEqual({ code: 1012, reason: "service restart" });
    const s = await stats(gateway.ports.ws);
    expect(s.wsUpstreamCloses).toBe(1);
    expect(s.held).toBe(1);
    expect(s.upstream.ws).toBe(collector.info.wsPort);
  });

  test("a client close reaches the upstream with its code", async () => {
    let upstreamClose: { code: number; reason: string } | undefined;
    const upstream = Bun.serve({
      hostname: HOST,
      port: 0,
      fetch(req, server) {
        if (new URL(req.url).pathname === "/health") return Response.json({ pid: 7002 });
        return server.upgrade(req) ? undefined : new Response("no", { status: 426 });
      },
      websocket: {
        message() {},
        close(_ws, code, reason) {
          upstreamClose = { code, reason };
        },
      },
    });
    cleanups.push(() => upstream.stop(true));
    // An upgrade on the collector HTTP listener is proxied to the leader's HTTP port.
    const gateway = startGateway({ leaderSource: () => leaderFor(7002, upstream.port ?? 0, 1) });
    const client = openClient(`ws://${HOST}:${gateway.ports.collector}/`);
    await client.opened;
    client.socket.close(4001, "bye");
    await waitFor(() => upstreamClose !== undefined);
    expect(upstreamClose).toEqual({ code: 4001, reason: "bye" });
    expect((await stats(gateway.ports.collector)).wsUpstreamCloses).toBe(0);
  });

  test("the web listener deflates what it relays to a browser that offers permessage-deflate; the ws listener doesn't", async () => {
    const big = JSON.stringify({ type: "hello-ok", payload: { rows: Array.from({ length: 4000 }, (_, i) => ({ id: i, state: "idle" })) } });
    const upstream = Bun.serve({
      hostname: HOST,
      port: 0,
      fetch(req, server) {
        if (new URL(req.url).pathname === "/health") return Response.json({ pid: 7010 });
        return server.upgrade(req) ? undefined : new Response("no", { status: 426 });
      },
      websocket: {
        open(ws) {
          ws.send(big);
        },
        message() {},
      },
    });
    cleanups.push(() => upstream.stop(true));
    const gateway = startGateway({ vitePort: upstream.port ?? 0, leaderSource: () => leaderFor(7010, upstream.port ?? 0, upstream.port ?? 0) });

    /** A browser's handshake offering deflate; resolves with the 101's headers and the first frame's header bytes. */
    const firstFrame = (port: number) =>
      new Promise<{ head: string; rsv1: boolean; payloadLength: number }>((resolve, reject) => {
        const socket = connect({ host: HOST, port });
        cleanups.push(() => socket.destroy());
        let buf = Buffer.alloc(0);
        socket.on("error", reject);
        socket.on("data", (chunk) => {
          buf = Buffer.concat([buf, Buffer.from(chunk)]);
          const end = buf.indexOf("\r\n\r\n");
          if (end < 0 || buf.length < end + 4 + 10) return;
          const frame = buf.subarray(end + 4);
          const len7 = frame[1]! & 0x7f;
          const payloadLength = len7 === 126 ? frame.readUInt16BE(2) : len7 === 127 ? Number(frame.readBigUInt64BE(2)) : len7;
          resolve({ head: buf.subarray(0, end).toString("latin1"), rsv1: (frame[0]! & 0x40) !== 0, payloadLength });
        });
        socket.write(
          `GET /ws HTTP/1.1\r\nHost: localhost:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n` +
            `Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits\r\n\r\n`
        );
      });

    const web = await firstFrame(gateway.ports.web);
    expect(web.head).toContain("101");
    expect(web.head.toLowerCase()).toContain("permessage-deflate");
    expect(web.rsv1).toBe(true);
    expect(web.payloadLength).toBeLessThan(big.length / 5);

    const ws = await firstFrame(gateway.ports.ws);
    expect(ws.head.toLowerCase()).not.toContain("permessage-deflate");
    expect(ws.rsv1).toBe(false);
    expect(ws.payloadLength).toBe(big.length);
  });

  test("forwards the client's Host header to the upstream on an upgrade", async () => {
    let upstreamHost: string | null | undefined;
    let upstreamCookie: string | null | undefined;
    const upstream = Bun.serve({
      hostname: HOST,
      port: 0,
      fetch(req, server) {
        if (new URL(req.url).pathname === "/health") return Response.json({ pid: 7004 });
        upstreamHost = req.headers.get("host");
        upstreamCookie = req.headers.get("cookie");
        return server.upgrade(req) ? undefined : new Response("no", { status: 426 });
      },
      websocket: { message() {} },
    });
    cleanups.push(() => upstream.stop(true));
    const gateway = startGateway({ leaderSource: () => leaderFor(7004, upstream.port ?? 0, upstream.port ?? 0) });
    // A raw handshake, so the Host is exactly what a browser behind a tunnel sends.
    const socket = connect({ host: HOST, port: gateway.ports.ws });
    cleanups.push(() => socket.destroy());
    let response = "";
    socket.on("data", (chunk) => {
      response += chunk.toString("latin1");
    });
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    socket.write(
      "GET /ws HTTP/1.1\r\n" +
        "Host: standup.example.test\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        "Cookie: standup_session=s1\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
        "Sec-WebSocket-Version: 13\r\n\r\n"
    );
    await waitFor(() => response.includes("\r\n\r\n"));
    expect(response.startsWith("HTTP/1.1 101")).toBe(true);
    expect(upstreamHost).toBe("standup.example.test");
    expect(upstreamCookie).toBe("standup_session=s1");
  });

  test("a client leg that goes silent while upstream frames keep flowing is torn down with its upstream", async () => {
    const upstream = startChattyUpstream(7005);
    const gateway = startGateway({ leaderSource: () => upstream.info, wsClientPingMs: 40, wsClientIdleMs: 300 });
    // A tunnel whose browser is gone: it read the upgrade answer and keeps
    // reading every frame, but never sends a byte (no pong, no close).
    const leg = await openSilentLeg(gateway.ports.ws);
    await waitFor(() => upstream.open() === 1);
    await Bun.sleep(150);
    expect(upstream.open()).toBe(1);
    await waitFor(() => upstream.closes.length === 1, 3000);
    expect(upstream.closes[0]).toEqual({ code: 1001, reason: "client unresponsive" });
    await waitFor(() => leg.ended(), 3000);
    // It took heartbeats (4 bytes each) all along, so outbound traffic never kept it alive.
    expect(leg.received()).toBeGreaterThan(20);
    expect((await stats(gateway.ports.ws)).wsClientIdleCloses).toBe(1);
  });

  test("a client that only answers pings is kept", async () => {
    const upstream = startChattyUpstream(7006);
    const gateway = startGateway({ leaderSource: () => upstream.info, wsClientPingMs: 40, wsClientIdleMs: 300 });
    const client = openClient(`ws://${HOST}:${gateway.ports.ws}/`);
    await client.opened;
    await Bun.sleep(900);
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
    expect(upstream.open()).toBe(1);
    expect(upstream.closes).toEqual([]);
    expect((await stats(gateway.ports.ws)).wsClientIdleCloses).toBe(0);
  });

  test("a client leg that drops without a close frame closes its upstream", async () => {
    const upstream = startChattyUpstream(7007);
    const gateway = startGateway({ leaderSource: () => upstream.info });
    const leg = await openSilentLeg(gateway.ports.ws);
    await waitFor(() => upstream.open() === 1);
    leg.socket.destroy();
    await waitFor(() => upstream.open() === 0);
    expect(upstream.closes).toHaveLength(1);
  });

  test("a client that keeps redialing past dead legs never accumulates upstream sockets", async () => {
    const upstream = startChattyUpstream(7008);
    const gateway = startGateway({ leaderSource: () => upstream.info, wsClientPingMs: 40, wsClientIdleMs: 250 });
    let peak = 0;
    for (let i = 0; i < 6; i++) {
      await openSilentLeg(gateway.ports.ws);
      await waitFor(() => upstream.opened >= i + 1);
      peak = Math.max(peak, upstream.open());
      await Bun.sleep(100);
    }
    await waitFor(() => upstream.open() === 0, 3000);
    expect(upstream.opened).toBe(6);
    // Each dead leg goes within its idle limit, so at most a few overlap.
    expect(peak).toBeLessThanOrEqual(4);
    expect((await stats(gateway.ports.ws)).wsClientIdleCloses).toBe(6);
  });

  test("stop() closes proxied sockets with 1012", async () => {
    const collector = startCollector(7003);
    const gateway = startGateway({ leaderSource: () => collector.info });
    const client = openClient(`ws://${HOST}:${gateway.ports.ws}/`);
    await client.opened;
    await gateway.stop({ drainMs: 100 });
    await waitFor(() => client.closed() !== undefined);
    expect(client.closed()?.code).toBe(1012);
  });
});

describe("lifecycle", () => {
  test("never shares its ports: a second gateway, or a SO_REUSEPORT socket, can't bind beside it", async () => {
    const first = startGateway({ leaderSource: () => undefined });
    for (const ports of [
      first.ports,
      { web: 0, collector: first.ports.collector, ws: 0 },
      { web: 0, collector: 0, ws: first.ports.ws },
    ]) {
      let error: unknown;
      try {
        startGateway({ leaderSource: () => undefined, ports });
      } catch (err) {
        error = err;
      }
      expect(isAddrInUse(error)).toBe(true);
    }
    for (const port of [first.ports.web, first.ports.collector, first.ports.ws]) {
      let error: unknown;
      try {
        const sneaky = Bun.serve({ hostname: HOST, port, reusePort: true, fetch: () => new Response("captured") });
        sneaky.stop(true);
      } catch (err) {
        error = err;
      }
      expect(isAddrInUse(error)).toBe(true);
    }
  });

  test("stop() frees the ports at once: a successor binds while an in-flight request still drains", async () => {
    let release: (() => void) | undefined;
    const collector = startCollector(8001, async (req) => {
      if (new URL(req.url).pathname !== "/api/slow") return new Response("fast");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return new Response("slow");
    });
    const first = createGateway({ ports: { web: 0, collector: 0, ws: 0 }, vitePort: 1, leaderSource: () => collector.info, healthTimeoutMs: 300 });
    const pending = fetch(`http://${HOST}:${first.ports.collector}/api/slow`);
    await waitFor(() => release !== undefined);
    const stopped = first.stop({ drainMs: 5_000 });
    // Bound on the first try, with the old gateway still draining.
    const second = startGateway({ leaderSource: () => collector.info, ports: first.ports });
    expect(second.ports).toEqual(first.ports);
    expect(await (await fetch(`http://${HOST}:${second.ports.collector}/api/next`)).status).toBe(200);
    release?.();
    expect(await (await pending).text()).toBe("slow");
    await stopped;
  });

  test("binding beside a plain socket fails with an error isAddrInUse recognizes", async () => {
    const occupant = Bun.serve({ hostname: HOST, port: 0, reusePort: false, fetch: () => new Response("") });
    cleanups.push(() => occupant.stop(true));
    let error: unknown;
    try {
      startGateway({ leaderSource: () => undefined, ports: { web: 0, collector: occupant.port ?? 0, ws: 0 } });
    } catch (err) {
      error = err;
    }
    expect(error).toBeDefined();
    expect(isAddrInUse(error)).toBe(true);
  });

  test("a bind that fails on its second port releases the first, so a retry succeeds once the port frees", async () => {
    const web = freePort();
    const ws = freePort();
    const occupant = Bun.serve({ hostname: HOST, port: 0, reusePort: false, fetch: () => new Response("") });
    cleanups.push(() => occupant.stop(true));
    const collector = occupant.port ?? 0;
    const ports = { web, collector, ws };
    let error: unknown;
    try {
      startGateway({ leaderSource: () => undefined, ports });
    } catch (err) {
      error = err;
    }
    expect(isAddrInUse(error)).toBe(true);
    // The web port the failed attempt bound first is free again, on both stacks.
    expectBindable(HOST, web);
    if (HAS_IPV6_LOOPBACK) expectBindable(GATEWAY_HOST_IPV6, web);

    let attempts = 0;
    setTimeout(() => occupant.stop(true), 150);
    const gateway = await bindWithRetry(
      () => {
        attempts++;
        return startGateway({ leaderSource: () => undefined, ports });
      },
      { initialDelayMs: 20, timeoutMs: 3_000 }
    );
    expect(attempts).toBeGreaterThan(1);
    expect(gateway.ports).toEqual(ports);
  });

  ipv6Test("a port held on [::1] alone is in use: the bind fails, releases the rest, and retries", async () => {
    const web = freePort();
    const ws = freePort();
    const collector = freePort();
    const occupant = Bun.serve({ hostname: GATEWAY_HOST_IPV6, port: collector, reusePort: false, fetch: () => new Response("captured") });
    cleanups.push(() => occupant.stop(true));
    const ports = { web, collector, ws };
    let error: unknown;
    try {
      startGateway({ leaderSource: () => undefined, ports });
    } catch (err) {
      error = err;
    }
    expect(isAddrInUse(error)).toBe(true);
    expectBindable(HOST, web);
    expectBindable(GATEWAY_HOST_IPV6, web);
    expectBindable(HOST, collector);

    setTimeout(() => occupant.stop(true), 150);
    const gateway = await bindWithRetry(() => startGateway({ leaderSource: () => undefined, ports }), { initialDelayMs: 20, timeoutMs: 3_000 });
    expect(gateway.ports).toEqual(ports);
  });

  ipv6Test("binds [::1] on every public port, so nothing else can take it", async () => {
    const gateway = startGateway({ leaderSource: () => undefined });
    for (const port of [gateway.ports.web, gateway.ports.collector, gateway.ports.ws]) {
      let error: unknown;
      try {
        Bun.serve({ hostname: GATEWAY_HOST_IPV6, port, reusePort: true, fetch: () => new Response("captured") }).stop(true);
      } catch (err) {
        error = err;
      }
      expect(isAddrInUse(error)).toBe(true);
    }
  });

  ipv6Test("[::1] routes exactly like 127.0.0.1: collector, ws, web and the stats path", async () => {
    const collector = startCollector(8004);
    const vite = Bun.serve({ hostname: HOST, port: 0, fetch: (req) => new Response(`vite ${new URL(req.url).pathname}`) });
    cleanups.push(() => vite.stop(true));
    const gateway = startGateway({ leaderSource: () => collector.info, vitePort: vite.port ?? 0 });
    const v6 = `[${GATEWAY_HOST_IPV6}]`;
    for (const host of [HOST, v6]) {
      expect(await (await fetch(`http://${host}:${gateway.ports.collector}/api/x`)).text()).toBe("hello from 8004");
      expect(await (await fetch(`http://${host}:${gateway.ports.web}/page`)).text()).toBe("vite /page");
      const s = (await (await fetch(`http://${host}:${gateway.ports.ws}${GATEWAY_STATS_PATH}`)).json()) as GatewayStats;
      expect(s.pid).toBe(process.pid);
      const client = openClient(`ws://${host}:${gateway.ports.ws}/`);
      await client.opened;
      expect(await client.next()).toBe("hello 8004");
      client.socket.send("ping");
      expect(await client.next()).toBe("echo:ping");
      client.socket.close();
    }
  });

  ipv6Test("ipv6Loopback: false leaves [::1] unbound", async () => {
    const gateway = startGateway({ leaderSource: () => undefined, ipv6Loopback: false });
    expectBindable(GATEWAY_HOST_IPV6, gateway.ports.collector);
  });

  test("stop() lets an in-flight request finish", async () => {
    const collector = startCollector(8002, async () => {
      await Bun.sleep(200);
      return new Response("slow");
    });
    const gateway = startGateway({ leaderSource: () => collector.info });
    const pending = fetch(`http://${HOST}:${gateway.ports.collector}/api/slow`);
    await waitFor(() => collector.hits.length === 1);
    const stopped = gateway.stop({ drainMs: 2000 });
    const res = await pending;
    expect(await res.text()).toBe("slow");
    await stopped;
  });

  test("calls onIdle once no leader has validated for idleExitMs", async () => {
    let idle = 0;
    startGateway({ leaderSource: () => undefined, idleExitMs: 100, idleCheckMs: 20, onIdle: () => idle++ });
    await waitFor(() => idle > 0, 2000);
    await Bun.sleep(100);
    expect(idle).toBe(1);
  });

  test("a validated leader keeps the gateway from going idle", async () => {
    const collector = startCollector(8003);
    let idle = 0;
    startGateway({ leaderSource: () => collector.info, idleExitMs: 150, idleCheckMs: 20, onIdle: () => idle++ });
    await Bun.sleep(400);
    expect(idle).toBe(0);
    collector.stop();
    await waitFor(() => idle > 0, 2000);
  });
});

describe("helpers", () => {
  test("stripHeaders drops hop-by-hop headers and those Connection names", () => {
    const out = stripHeaders(
      new Headers({ connection: "keep-alive, x-hop", "keep-alive": "5", "x-hop": "1", upgrade: "h2c", te: "trailers", host: "h", "x-keep": "1" })
    );
    expect([...out.keys()].sort()).toEqual(["host", "x-keep"]);
  });

  test("isAddrUnavailable recognizes a missing address, never a port in use", () => {
    expect(isAddrUnavailable({ code: "EADDRNOTAVAIL" })).toBe(true);
    expect(isAddrUnavailable({ code: "EAFNOSUPPORT" })).toBe(true);
    expect(isAddrUnavailable(new Error("listen EADDRNOTAVAIL: address not available ::1:5173"))).toBe(true);
    expect(isAddrUnavailable({ code: "EADDRINUSE" })).toBe(false);
    expect(isAddrUnavailable(new Error("Failed to start server. Is port 5173 in use?"))).toBe(false);
    expect(isAddrUnavailable(undefined)).toBe(false);
  });

  test("Bun reports a refused connect as ConnectionRefused", async () => {
    const probe = Bun.serve({ hostname: HOST, port: 0, fetch: () => new Response("") });
    const port = probe.port;
    probe.stop(true);
    let error: unknown;
    try {
      await fetch(`http://${HOST}:${port}/`, { keepalive: false });
    } catch (err) {
      error = err;
    }
    expect(isConnectionRefused(error)).toBe(true);
  });
});
