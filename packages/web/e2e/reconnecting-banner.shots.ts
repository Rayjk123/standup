#!/usr/bin/env bun
/*
 * Screenshots of the console's "Reconnecting…" banner against a mocked API:
 * the dev server serves the app, the browser's /api requests are answered
 * from canned JSON, and its /ws socket is served by Playwright — first a
 * healthy hello-ok, then dropped and refused, then accepted again. No
 * collector runs; requests off the page's origin are aborted.
 *
 *   bun packages/web/e2e/reconnecting-banner.shots.ts --playwright /path/to/node_modules/playwright \
 *     --out /tmp/shots [--port 5371]
 */
import { randomBytes } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : fallback;
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

const PLAYWRIGHT = arg("playwright");
const OUT = resolve(arg("out"));
const PORT = arg("port", "5371");
const WEB_DIR = resolve(import.meta.dir, "..");
const ORIGIN_HOST = `localhost:${PORT}`;
mkdirSync(OUT, { recursive: true });

// The scratch config's proxies point at ports nothing listens on: every /api
// and /ws request is answered by the browser-side mocks below first.
// The proxy's owner token is a throwaway file, never the install's.
const TOKEN_FILE = join(OUT, "mock-owner.token");
writeFileSync(TOKEN_FILE, randomBytes(32).toString("hex"), { mode: 0o600 });
Object.assign(process.env, {
  SCRATCH_API_PORT: "1",
  SCRATCH_WS_PORT: "1",
  SCRATCH_WEB_PORT: PORT,
  STANDUP_OWNER_TOKEN_FILE: TOKEN_FILE,
});
const { createServer } = await import(join(WEB_DIR, "node_modules/vite/dist/node/index.js"));
const vite = await createServer({ configFile: join(import.meta.dir, "vite.scratch.config.ts"), logLevel: "warn" });
await vite.listen();

const now = new Date().toISOString();
const owner = "owner";
const thread = "thread-console";
const personaState = {
  owner,
  runState: "idle",
  threadId: thread,
  epoch: 1,
  pendingInbox: 0,
  activeLaunches: 0,
  maxActiveLaunches: 6,
  canWrite: true,
  isHost: true,
  hostAlias: owner,
};
const messages = [
  { id: "m1", threadId: thread, seq: 1, role: "user", actor: owner, text: "Did the review job finish?", createdAt: now },
  {
    id: "m2",
    threadId: thread,
    seq: 2,
    role: "persona",
    text: "Not yet: the worker is on its second review round. I'll tell you when it lands.",
    createdAt: now,
  },
];
const api: Record<string, unknown> = {
  "/api/persona/state": personaState,
  "/api/persona/messages": { threadId: thread, messages },
  "/api/persona/jobs": { jobs: [] },
  "/api/persona/approvals": { approvals: [] },
  "/api/persona/threads": { threads: [] },
};
const hello = JSON.stringify({
  type: "hello-ok",
  payload: {
    protocolVersion: 1,
    serverSeq: 0,
    user: owner,
    snapshot: {
      projects: [],
      sessions: [],
      checkpoints: [],
      asks: [],
      launches: [],
      tickets: [],
      actors: [],
    },
  },
  timestamp: now,
});

const { chromium } = (await import(PLAYWRIGHT)) as typeof import("playwright");
const browser = await chromium.launch();
const shots: string[] = [];
try {
  // Headless Chromium reports a light OS; the shots are of the dark console.
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, colorScheme: "dark" });
  page.on("pageerror", (err) => console.log(`  PAGE ERROR: ${err.message}`));
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.host !== ORIGIN_HOST) return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const body = api[url.pathname] ?? [];
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });

  let collectorUp = true;
  await page.routeWebSocket(/\/ws$/, (ws) => {
    if (!collectorUp) {
      ws.close({ code: 1011, reason: "collector restarting" });
      return;
    }
    ws.onMessage((m) => {
      if (m === "ping") ws.send("pong");
    });
    ws.send(hello);
    downNow = () => ws.close({ code: 1011, reason: "collector restarting" });
  });
  let downNow: () => void = () => {};

  await page.goto(`http://${ORIGIN_HOST}/`);
  await page.getByText("I'll tell you when it lands").waitFor({ timeout: 20000 });
  const shoot = async (name: string) => {
    const path = join(OUT, name);
    await page.screenshot({ path });
    shots.push(path);
  };
  await shoot("connected.png");

  collectorUp = false;
  downNow();
  await page.getByTestId("connection-banner").waitFor({ timeout: 10000 });
  await page.waitForTimeout(2500);
  await shoot("reconnecting.png");
  await page.getByTestId("connection-banner").screenshot({ path: join(OUT, "reconnecting-banner-closeup.png") });
  shots.push(join(OUT, "reconnecting-banner-closeup.png"));

  collectorUp = true;
  await page.getByRole("button", { name: "Retry now" }).click();
  await page.getByTestId("connection-banner").waitFor({ state: "detached", timeout: 10000 });
  await shoot("reconnected.png");
} finally {
  await browser.close();
  await vite.close();
}
for (const s of shots) console.log(s);
