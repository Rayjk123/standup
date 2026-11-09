import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { HelloOkPayload, WsMessage } from "@standup/shared";
import { defaultIdentityConfig, WS_PROTOCOL_VERSION } from "@standup/shared";
import { DEFAULT_IDENTITY_HEADER } from "@standup/shared/constants";
import { OWNER_TOKEN_HEADER } from "@standup/shared/owner-token";
import { attachBoardAdapter } from "../../collector/src/board/adapter.ts";
import { createBoard } from "../../collector/src/board/board.ts";
import { generateOwnerSecrets } from "../../collector/src/owner-secret.ts";
import { buildSnapshot, createServer } from "../../collector/src/server.ts";
import { createStore, type Store } from "../../store/src/index.ts";
import {
  BOARD_FIRST_PAGE_BUDGET_BYTES,
  BOARD_FIRST_PAGE_PATH,
  budgetLine,
  HELLO_OK_BUDGET_BYTES,
  LAUNCHES_BUDGET_BYTES,
  overBudget,
  type BudgetCheck,
} from "./load-budgets";
import { DEFAULT_VOLUMES, seedRealistic } from "./seed-realistic";

/**
 * The console's boot payloads, at a heavy owner's volume (seed-realistic.ts
 * DEFAULT_VOLUMES), each held to its budget in load-budgets.ts: the hello-ok
 * frame, the launch list and the Board's first read, as the collector's own
 * snapshot builder and route handlers serialize them.
 */

const OWNER = "budget-owner";
// The seeder writes only under the real /tmp.
const base = realpathSync(tmpdir()).startsWith(`${realpathSync("/tmp")}/`) ? tmpdir() : "/tmp";
const root = mkdtempSync(join(base, "standup-load-budgets-"));
let store: Store;
let app: ReturnType<typeof createServer>;
const secrets = generateOwnerSecrets();
const asOwner = { [OWNER_TOKEN_HEADER]: secrets.ownerToken, [DEFAULT_IDENTITY_HEADER]: OWNER };

const checks: BudgetCheck[] = [];
const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const expectWithin = (check: BudgetCheck) => {
  checks.push(check);
  if (overBudget(check)) throw new Error(`${budgetLine(check)} (budgets in packages/web/e2e/load-budgets.ts)`);
};

beforeAll(() => {
  const home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  const dbPath = join(root, "standup.db");
  const seeded = seedRealistic(dbPath, OWNER, DEFAULT_VOLUMES, { home });
  console.log(`seeded DEFAULT_VOLUMES in ${seeded.ms} ms`);
  store = createStore(dbPath);
  // The Board's cards are projected from the jobs and tickets, as the collector's startup reconcile does.
  const board = createBoard({ db: store.db, publish: () => {} });
  const adapter = attachBoardAdapter({ tap: { subscribe: () => () => {} }, board, db: store.db, changedFiles: async () => [] });
  adapter.reconcile();
  adapter.stop();
  app = createServer(
    store,
    () => {},
    null,
    undefined,
    undefined,
    "",
    "",
    {},
    undefined,
    undefined,
    undefined,
    // The default identity rules, whatever the caller's environment sets.
    defaultIdentityConfig(),
    { ownerSecrets: secrets },
    {},
    {},
    {},
    { dataDir: join(root, "data") },
    {},
    undefined,
    board
  );
}, 120_000);

afterAll(() => {
  if (checks.length) console.log(checks.map(budgetLine).join("\n"));
  store?.close();
  rmSync(root, { recursive: true, force: true });
});

describe("the console's boot payloads stay within their byte budgets", () => {
  test("the hello-ok frame", async () => {
    const snapshot = await buildSnapshot(store);
    expect(snapshot.sessions.length).toBeGreaterThan(0);
    // The frame ws.ts sends a connecting console, around the snapshot.
    const frame: WsMessage<HelloOkPayload> = {
      type: "hello-ok",
      payload: { protocolVersion: WS_PROTOCOL_VERSION, serverSeq: 0, user: OWNER, snapshot, epoch: "0".repeat(16) },
      timestamp: new Date().toISOString(),
    };
    expectWithin({ metric: "helloOkBytes", value: bytes(JSON.stringify(frame)), budget: HELLO_OK_BUDGET_BYTES, unit: "bytes" });
  });

  test("GET /api/launches", async () => {
    const res = await app.request("/api/launches", { headers: asOwner });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect((JSON.parse(body) as unknown[]).length).toBeGreaterThan(0);
    expectWithin({ metric: "launchesBytes", value: bytes(body), budget: LAUNCHES_BUDGET_BYTES, unit: "bytes" });
  });

  test("the Board's first read", async () => {
    const res = await app.request(BOARD_FIRST_PAGE_PATH, { headers: asOwner });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect((JSON.parse(body) as { scope: string }).scope).toBe("user");
    expectWithin({ metric: "boardFirstPageBytes", value: bytes(body), budget: BOARD_FIRST_PAGE_BUDGET_BYTES, unit: "bytes" });
  });
});
