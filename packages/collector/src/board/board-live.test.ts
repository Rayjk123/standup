import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { BoardTaskFrame, PersonaJob, Snapshot, Ticket, WsMessage } from "@standup/shared";
import { OWNER_TOKEN_HEADER } from "@standup/shared/owner-token";
import {
  createPersonaJob,
  createStore,
  createTicket,
  getOrCreatePersonaConsoleThread,
  updatePersonaJob,
  updateTicketStatus,
  upsertProject,
  type Store,
} from "@standup/store";
import { createWsServer, type WsServerHandle } from "../ws.js";
import { resolveIdentityConfigFromEnv, resolveUserAlias } from "../server.js";
import { generateOwnerSecrets } from "../owner-secret.js";
import { createBroadcastTap } from "../persona/events.js";
import { attachBoardAdapter, type BoardAdapter } from "./adapter.js";
import { createBoard, type Board } from "./board.js";

/*
 * The collector's side of the live Board in one process: a store on disk under
 * its own /tmp dir, the real broadcast tap, board, board adapter and WebSocket
 * server, and two consoles on real sockets — the owner's, whose upgrade
 * carries the owner token, and a stranger's without it. Each board mutation is
 * made the way its producer makes it (write the store, broadcast the frame
 * through the tap), and the test reads what each socket was sent.
 */

const host = resolveUserAlias(undefined);
const secrets = generateOwnerSecrets();

let root: string;
let store: Store;
let server: WsServerHandle;
let adapter: BoardAdapter;
let tap: ReturnType<typeof createBroadcastTap>;

let board: Board;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "standup-board-live-"));
  store = createStore(join(root, "standup.db"));
  upsertProject(store.db, { id: "proj", name: "P", branch: "main", repos: [] });
  server = createWsServer(0, async () => ({}) as Snapshot, () => {}, resolveIdentityConfigFromEnv(), {
    ownerSecrets: () => secrets,
    hostname: "127.0.0.1",
  });
  tap = createBroadcastTap(server.broadcast);
  board = createBoard({ db: store.db, publish: tap.broadcast });
  adapter = attachBoardAdapter({ tap, board, db: store.db, delayMs: 0 });
});

afterAll(async () => {
  try {
    adapter?.stop();
    await server?.close();
    store?.db.close();
  } finally {
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

/** A console on a real socket, recording every board:task frame it is sent. */
async function connect(owner: boolean): Promise<{ frames: BoardTaskFrame[]; close: () => void }> {
  const headers = owner ? { [OWNER_TOKEN_HEADER]: secrets.ownerToken } : {};
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}`, { headers } as unknown as string[]);
  const frames: BoardTaskFrame[] = [];
  const hello = new Promise<void>((resolve, reject) => {
    ws.onerror = () => reject(new Error("socket failed"));
    ws.onmessage = (ev) => {
      let m: WsMessage;
      try {
        m = JSON.parse(String(ev.data)) as WsMessage;
      } catch {
        return;
      }
      if (m.type === "hello-ok") resolve();
      if (m.type === "board:task") frames.push(m.payload as BoardTaskFrame);
    };
  });
  ws.onopen = () => ws.send(JSON.stringify({ kind: "hello", protocolVersion: 1 }));
  await hello;
  return { frames, close: () => ws.close() };
}

const now = () => new Date().toISOString();

/** Waits until `frames` holds more than `count` frames, then returns the new ones. */
async function next(frames: BoardTaskFrame[], count: number, timeoutMs = 2000): Promise<BoardTaskFrame[]> {
  const deadline = Date.now() + timeoutMs;
  while (frames.length <= count && Date.now() < deadline) await Bun.sleep(10);
  // Anything else in flight lands too, so an extra frame shows up in the count.
  await Bun.sleep(50);
  return frames.slice(count);
}

describe("live board frames over the collector socket", () => {
  test("a ticket's card is sent to every console when it is created, updated, moved and closed", async () => {
    const owner = await connect(true);
    const stranger = await connect(false);
    try {
      const ticket = createTicket(store.db, { projectId: "proj", lens: "bugs", title: "Flaky retry", body: "retries twice" });
      tap.broadcast({ type: "ticket:new", payload: ticket, timestamp: now() });
      const created = await next(owner.frames, 0);
      expect(created).toHaveLength(1);
      expect(created[0]!.task).toMatchObject({ id: `ticket:${ticket.id}`, status: "queued", owner: "" });

      // Approval keeps the column but drops the wait on the owner: an update in place.
      const approved = updateTicketStatus(store.db, ticket.id, "approved");
      tap.broadcast({ type: "ticket:updated", payload: approved, timestamp: now() });
      const updated = await next(owner.frames, 1);
      expect(updated).toHaveLength(1);
      expect(updated[0]!.task?.status).toBe("queued");
      expect(updated[0]!.task?.waitingOn).toBeUndefined();

      const developing = updateTicketStatus(store.db, ticket.id, "developing");
      tap.broadcast({ type: "ticket:updated", payload: developing, timestamp: now() });
      const moved = await next(owner.frames, 2);
      expect(moved).toHaveLength(1);
      expect(moved[0]!.task?.status).toBe("coding");

      const review = updateTicketStatus(store.db, ticket.id, "needs_review");
      tap.broadcast({ type: "ticket:updated", payload: review, timestamp: now() });
      expect((await next(owner.frames, 3))[0]!.task?.status).toBe("in_review");

      const shipped: Ticket = updateTicketStatus(store.db, ticket.id, "shipped");
      tap.broadcast({ type: "ticket:updated", payload: shipped, timestamp: now() });
      const closed = await next(owner.frames, 4);
      expect(closed).toHaveLength(1);
      expect(closed[0]!.task?.status).toBe("done");

      // A team-wide card reaches a console that proved no one, frame for frame.
      await next(stranger.frames, 4);
      expect(stranger.frames.map((f) => f.task?.status)).toEqual(["queued", "queued", "coding", "in_review", "done"]);
    } finally {
      owner.close();
      stranger.close();
    }
  });

  test("a Persona job's card reaches only its owner's console as it is created, renamed and closed", async () => {
    const owner = await connect(true);
    const stranger = await connect(false);
    try {
      const thread = getOrCreatePersonaConsoleThread(store.db, host);
      const job: PersonaJob = createPersonaJob(store.db, { owner: host, threadId: thread.id, title: "Board live", goal: "live board" });
      tap.broadcast({ type: "persona:job", payload: job, timestamp: now(), audience: host });
      const created = await next(owner.frames, 0);
      expect(created).toHaveLength(1);
      expect(created[0]!.task).toMatchObject({ id: `job:${job.id}`, owner: host, title: "Board live" });
      const openStatus = created[0]!.task!.status;

      // Each frame the owner is sent moves the owner's board version; the stranger's stays put.
      const strangerVersion = board.viewerVersion("");
      let ownerVersion = board.viewerVersion(host);

      const renamed = updatePersonaJob(store.db, job.id, { title: "Board live updates" })!;
      tap.broadcast({ type: "persona:job", payload: renamed, timestamp: now(), audience: host });
      const updated = await next(owner.frames, 1);
      expect(updated).toHaveLength(1);
      expect(updated[0]!.task).toMatchObject({ title: "Board live updates", status: openStatus });
      expect(board.viewerVersion(host)).not.toBe(ownerVersion);
      ownerVersion = board.viewerVersion(host);

      // Waiting on the owner moves the card to another column.
      const waiting = updatePersonaJob(store.db, job.id, { status: "waiting_user" })!;
      tap.broadcast({ type: "persona:job", payload: waiting, timestamp: now(), audience: host });
      const moved = await next(owner.frames, 2);
      expect(moved).toHaveLength(1);
      expect(moved[0]!.task?.status).toBe("waiting");
      expect(moved[0]!.task?.status).not.toBe(openStatus);
      expect(board.viewerVersion(host)).not.toBe(ownerVersion);
      ownerVersion = board.viewerVersion(host);

      const done = updatePersonaJob(store.db, job.id, { status: "done", outcome: "landed" })!;
      tap.broadcast({ type: "persona:job", payload: done, timestamp: now(), audience: host });
      const closed = await next(owner.frames, 3);
      expect(closed).toHaveLength(1);
      expect(closed[0]!.task?.status).toBe("done");
      expect(board.viewerVersion(host)).not.toBe(ownerVersion);
      ownerVersion = board.viewerVersion(host);

      // An unchanged rewrite sends nothing and moves nothing.
      tap.broadcast({ type: "persona:job", payload: done, timestamp: now(), audience: host });
      expect(await next(owner.frames, 4, 200)).toHaveLength(0);
      expect(board.viewerVersion(host)).toBe(ownerVersion);
      expect(board.viewerVersion("")).toBe(strangerVersion);

      // The owner's job card never reaches a console that didn't prove the owner.
      expect(stranger.frames.filter((f) => f.task?.id === `job:${job.id}`)).toHaveLength(0);
    } finally {
      owner.close();
      stranger.close();
    }
  });
});
