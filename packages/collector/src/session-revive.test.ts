import { expect, test } from "bun:test";
import {
  createLaunch,
  createSession,
  createStore,
  endSession,
  endStaleSession,
  getSession,
  reviveSession,
  setLaunchHookTokenHash,
  updateLaunchStatus,
  upsertProject,
} from "@standup/store";
import { randomBytes } from "crypto";
import type { WsMessage } from "@standup/shared";
import { HOOK_TOKEN_HEADER, WORKER_HOOK_PATH, workerTokenHash } from "./floor/gate.js";
import { createServer } from "./server.js";
import { workerCopies } from "./worker-copies.js";

/**
 * A hook from a session whose record was ended revives it, and the revive is
 * announced as a status-less `session:status` so the console and the Slack
 * mirror pick the session back up without reading a status transition.
 */
test("a hook from a stale-ended session revives it, clears the mark and announces it", async () => {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: ["/tmp/owner-repo"] });
  createSession(store.db, { id: "s", projectId: "p", title: "t", cwd: "/tmp/owner-repo", status: "idle" });
  endStaleSession(store.db, "s");
  const sent: WsMessage[] = [];
  const app = createServer(store, (m) => sent.push(m), null);

  const res = await app.request("/hook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: "s",
      cwd: "/tmp/owner-repo",
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/tmp/owner-repo/a" },
      transcript_path: "/none.jsonl",
    }),
  });

  expect(res.status).toBe(200);
  expect(getSession(store.db, "s")).toMatchObject({ endedAt: undefined, endReason: undefined });
  const revived = sent.filter((m) => m.type === "session:status" && (m.payload as { revived?: boolean }).revived);
  expect(revived.map((m) => m.payload)).toEqual([{ sessionId: "s", revived: true }]);

  // A hook from a live session announces no revive.
  sent.length = 0;
  await app.request("/hook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: "s", cwd: "/tmp/owner-repo", hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {}, transcript_path: "/none.jsonl" }),
  });
  expect(sent.some((m) => (m.payload as { revived?: boolean } | null)?.revived)).toBe(false);
  store.close();
});

test("a hook reviving a session whose launch isn't live marks it resumed outside the launch", async () => {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: ["/tmp/owner-repo"] });
  createSession(store.db, { id: "s", projectId: "p", title: "t", cwd: "/tmp/owner-repo", status: "idle" });
  createLaunch(store.db, { id: "l", projectId: "p", task: "t", worktreePath: "/tmp/owner-repo", branch: "main", sessionId: "s", status: "running" });
  updateLaunchStatus(store.db, "l", "failed", "adopt failed");
  endSession(store.db, "s");
  const app = createServer(store, () => {}, null);

  const res = await app.request("/hook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: "s", cwd: "/tmp/owner-repo", hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {}, transcript_path: "/none.jsonl" }),
  });

  expect(res.status).toBe(200);
  expect(getSession(store.db, "s")).toMatchObject({ endedAt: undefined, revivedOutsideLaunch: true });
  // An end clears it.
  endSession(store.db, "s");
  expect(getSession(store.db, "s")?.revivedOutsideLaunch).toBeUndefined();
  store.close();
});

test("a token event from the session's own launch clears the outside mark; a lone tokenless copy is noted", async () => {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
  const cwd = "/tmp/revive-wt";
  const token = randomBytes(32).toString("hex");
  createSession(store.db, { id: "s", projectId: "p", title: "t", cwd, status: "running" });
  createLaunch(store.db, { id: "l", projectId: "p", task: "t", worktreePath: cwd, branch: "b", sessionId: "s", status: "running" });
  setLaunchHookTokenHash(store.db, "l", workerTokenHash(token));
  endSession(store.db, "s");
  reviveSession(store.db, "s", { outsideLaunch: true });
  const app = createServer(store, () => {}, null);
  const body = JSON.stringify({ session_id: "s", cwd, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {}, transcript_path: "/none.jsonl" });

  const own = await app.request(WORKER_HOOK_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json", [HOOK_TOKEN_HEADER]: token },
    body,
  });
  expect(own.status).toBe(200);
  expect(getSession(store.db, "s")?.revivedOutsideLaunch).toBeUndefined();

  // The proof now holds, so a tokenless copy is dropped — and noted.
  const t0 = Date.now();
  const copy = await app.request("/hook", { method: "POST", headers: { "Content-Type": "application/json" }, body });
  expect(copy.status).toBe(202);
  // Paired with the token copy just before it, it is the worker's.
  expect(workerCopies.handCopySeen("s", t0 + 60_000)).toBe(false);
  // With the worker's last token copy a minute older, the same tokenless copy is a copy outside the launch.
  workerCopies.noteToken("s", t0 - 60_000);
  expect(workerCopies.handCopySeen("s", t0 + 60_000)).toBe(true);
  workerCopies.forget("s");
  store.close();
});

test("a SessionEnd hook after a stale end keeps the session ended and clears the mark", async () => {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: ["/tmp/owner-repo"] });
  createSession(store.db, { id: "s", projectId: "p", title: "t", cwd: "/tmp/owner-repo", status: "idle" });
  endStaleSession(store.db, "s");
  const sent: WsMessage[] = [];
  const app = createServer(store, (m) => sent.push(m), null);

  const res = await app.request("/hook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: "s", cwd: "/tmp/owner-repo", hook_event_name: "SessionEnd", reason: "other", transcript_path: "/none.jsonl" }),
  });

  expect(res.status).toBe(200);
  expect(getSession(store.db, "s")).toMatchObject({ endedAt: expect.any(Date), endReason: undefined });
  expect(sent.some((m) => (m.payload as { revived?: boolean } | null)?.revived)).toBe(false);
  store.close();
});
