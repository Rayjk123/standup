#!/usr/bin/env bun
/*
 * Checks that the production console server (serve.ts, vite preview) keeps
 * the dev server's owner channel: the /api and /ws proxies forward the owner
 * secret only for a signed-in, same-origin browser, /__standup/login signs a
 * browser in, and the build's cache headers, missing-chunk 404 and deep-link
 * fallback hold. The "collector" is a fake that records what reaches it; the
 * owner token is a throwaway one under /tmp. Everything binds 127.0.0.1 on
 * 186xx ports.
 *
 *   bun packages/web/e2e/serve-auth.probe.ts [--dir /tmp/standup-loadtime/probe]
 */
import { randomBytes } from "crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { mintLoginCode, SESSION_COOKIE } from "../owner-proxy";
import { IMMUTABLE, REVALIDATE } from "../static-assets";

const HOST = "127.0.0.1";
const API_PORT = 18611;
const WS_PORT = 18612;
const WEB_PORT = 18613;
const ORIGIN = `http://${HOST}:${WEB_PORT}`;
const OWNER_HEADER = "x-standup-owner-token";

const i = process.argv.indexOf("--dir");
const DIR = resolve(i >= 0 ? process.argv[i + 1]! : "/tmp/standup-loadtime/probe");
if (!DIR.startsWith("/tmp/")) throw new Error("the probe dir must live under /tmp");
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true, mode: 0o700 });
const TOKEN_FILE = join(DIR, "owner.token");
const token = randomBytes(32).toString("hex");
writeFileSync(TOKEN_FILE, token, { mode: 0o600 });

// Nothing in this process may reach a real install's Slack, ntfy or Persona.
for (const k of Object.keys(process.env)) {
  if (k.startsWith("SLACK_") || k.startsWith("NTFY_") || k === "STANDUP_PERSONA" || k === "STANDUP_WORKER_TOKEN_FILE") delete process.env[k];
}
Object.assign(process.env, {
  STANDUP_OWNER_TOKEN_FILE: TOKEN_FILE,
  SCRATCH_API_PORT: String(API_PORT),
  SCRATCH_WS_PORT: String(WS_PORT),
  SCRATCH_WEB_PORT: String(WEB_PORT),
});

// The fake collector: records the owner header each request and upgrade carried.
const seen: { path: string; owner: string | null }[] = [];
const api = Bun.serve({
  hostname: HOST,
  port: API_PORT,
  fetch(req) {
    seen.push({ path: new URL(req.url).pathname, owner: req.headers.get(OWNER_HEADER) });
    return Response.json({ ok: true });
  },
});
const upgrades: (string | null)[] = [];
const wsServer = Bun.serve({
  hostname: HOST,
  port: WS_PORT,
  fetch(req, server) {
    upgrades.push(req.headers.get(OWNER_HEADER));
    return server.upgrade(req) ? undefined : new Response("upgrade required", { status: 426 });
  },
  websocket: {
    message(ws, message) {
      ws.send(`echo ${message}`);
    },
  },
});

const results: { label: string; ok: boolean; detail?: string }[] = [];
const check = (label: string, ok: boolean, detail?: string) => {
  results.push({ label, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
};
const lastOwner = () => seen.at(-1)?.owner ?? null;

const { serveConsole } = await import("../serve");
const served = await serveConsole({
  configFile: join(import.meta.dir, "vite.loadtime.config.ts"),
  outDir: join(DIR, "dist"),
  watch: false,
  logLevel: "warn",
});

/** Opens /ws through the console with `headers`; resolves with the echo of one message, or an error. */
function wsRoundTrip(headers: Record<string, string>): Promise<string> {
  return new Promise((done) => {
    const ws = new WebSocket(`ws://${HOST}:${WEB_PORT}/ws`, { headers } as unknown as string[]);
    const timer = setTimeout(() => done("timeout"), 5000);
    ws.onopen = () => ws.send("ping");
    ws.onmessage = (e) => {
      clearTimeout(timer);
      done(String(e.data));
      ws.close();
    };
    ws.onerror = () => {
      clearTimeout(timer);
      done("error");
    };
  });
}

try {
  // /api without a session: no owner secret, and a forged one is stripped.
  await fetch(`${ORIGIN}/api/echo`);
  check("api: no session, no owner token", lastOwner() === null);
  await fetch(`${ORIGIN}/api/echo`, { headers: { [OWNER_HEADER]: "forged" } });
  check("api: a forged owner header is stripped", lastOwner() === null, `upstream saw ${lastOwner()}`);

  // Sign-in: a bad code is refused, a minted one sets the session cookie.
  const bad = await fetch(`${ORIGIN}/__standup/login?code=1.bad`, { redirect: "manual" });
  check("login: a bad code sets no cookie", !bad.headers.get("set-cookie"), `status ${bad.status}`);
  const login = await fetch(`${ORIGIN}/__standup/login?code=${mintLoginCode(token)}`, { redirect: "manual" });
  const setCookie = login.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0] ?? "";
  check("login: a minted code sets the owner session cookie", cookie.startsWith(`${SESSION_COOKIE}=`), `status ${login.status}`);

  // /api with the session: the owner secret goes upstream, only same-origin for writes.
  await fetch(`${ORIGIN}/api/echo`, { headers: { cookie } });
  check("api: signed-in GET carries the owner token", lastOwner() === token);
  await fetch(`${ORIGIN}/api/echo`, { method: "POST", headers: { cookie, origin: "https://evil.example" } });
  check("api: cross-site POST goes without it", lastOwner() === null);
  await fetch(`${ORIGIN}/api/echo`, { method: "POST", headers: { cookie, origin: ORIGIN } });
  check("api: same-origin POST carries it", lastOwner() === token);

  // /ws: the upgrade carries the token only for a signed-in, same-origin socket, and frames flow.
  const echo = await wsRoundTrip({ cookie, origin: ORIGIN });
  check("ws: signed-in same-origin socket proxies frames", echo === "echo ping", echo);
  check("ws: its upgrade carried the owner token", upgrades.at(-1) === token);
  await wsRoundTrip({ cookie, origin: "https://evil.example" });
  check("ws: a cross-site upgrade goes without it", upgrades.at(-1) === null);
  await wsRoundTrip({ origin: ORIGIN });
  check("ws: no session, no owner token", upgrades.at(-1) === null);

  // The build itself: caching, missing chunks, deep links.
  const index = await fetch(`${ORIGIN}/`);
  check("static: index.html revalidates", index.headers.get("cache-control") === REVALIDATE);
  const entry = readdirSync(join(DIR, "dist", "assets")).find((f) => f.startsWith("index-") && f.endsWith(".js"))!;
  const asset = await fetch(`${ORIGIN}/assets/${entry}`, { headers: { "accept-encoding": "gzip" } });
  check(
    "static: hashed asset is immutable and compressed",
    asset.headers.get("cache-control") === IMMUTABLE && asset.headers.get("content-encoding") === "gzip",
    `${asset.headers.get("cache-control")}; ${asset.headers.get("content-encoding")}`
  );
  const missing = await fetch(`${ORIGIN}/assets/gone-Zz9.js`);
  check("static: a missing chunk is a 404", missing.status === 404 && missing.headers.get("cache-control") === REVALIDATE, `status ${missing.status}`);
  const deep = await fetch(`${ORIGIN}/work/s/abc.def`, { headers: { accept: "text/html" } });
  check("static: a deep link gets the app", deep.status === 200 && (await deep.text()).includes(`/assets/${entry}`), `status ${deep.status}`);
} finally {
  await served.close();
  api.stop(true);
  wsServer.stop(true);
  rmSync(DIR, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
