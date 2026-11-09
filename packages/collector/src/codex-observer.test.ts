import { expect, test, describe, afterAll } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import {
  createStore,
  upsertProject,
  createLaunch,
  getLaunch,
  getSession,
  getEventsSince,
  getCodexLaunches,
  createSession,
  attachSessionToLaunch,
  type Store,
} from "@standup/store";
import type { WsMessage } from "@standup/shared";
import { capTitle, MAX_TITLE_CHARS } from "@standup/shared";
import { CodexObserver, CodexTranscriptMapper } from "./codex-observer.js";
import { reapDeadCodexLaunches } from "./reaper.js";
import { buildCodexArgv, buildCodexResumeFlags, buildCodexRunLoop } from "./harness/codex.js";
import type { NormalizedEvent } from "./harness/types.js";

/**
 * The Codex observation half of the HarnessAdapter seam, exercised end-to-end
 * with a real sidecar file and the real CodexEventParser — no `codex` is spawned.
 * A JSONL sidecar (the file `codex exec --json` stdout is tee'd to) is written by
 * hand, the observer's poll pass is driven with `tick()`, and tmux liveness is a
 * stub so a pane "dies" deterministically.
 */

const dirs: string[] = [];
const stores: Store[] = [];
afterAll(() => {
  for (const s of stores) s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "codex-observer-"));
  dirs.push(dir);
  const store = createStore(":memory:");
  stores.push(store);
  upsertProject(store.db, { id: "p", name: "P", branch: "main", repos: [] });
  return { dir, store };
}

/** A codex launch with a sidecar file path and a tmux pane. */
function codexLaunch(
  store: Store,
  dir: string,
  id = `L-${randomUUID().slice(0, 6)}`,
  task = "make it work",
) {
  const sidecar = join(dir, `${id}.jsonl`);
  createLaunch(store.db, {
    id,
    projectId: "p",
    task,
    worktreePath: join(dir, id),
    branch: "feat",
    status: "running",
    tmuxSession: `tmux-${id}`,
    harness: "codex",
    codexEventLog: sidecar,
  });
  return { id, sidecar };
}

function jsonl(lines: unknown[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

function recordingBroadcast() {
  const messages: WsMessage[] = [];
  return { messages, broadcast: (m: WsMessage) => messages.push(m) };
}

describe("CodexTranscriptMapper", () => {
  test("maps the renderable events onto Claude-JSONL records", () => {
    const m = new CodexTranscriptMapper("L1");
    expect(m.map({ kind: "session-started", sessionId: "t" })).toEqual([]);
    expect(m.map({ kind: "turn-started" })).toEqual([]);

    const [assistant] = m.map({ kind: "assistant-message", text: "hello" });
    expect((assistant.record as any).type).toBe("assistant");
    expect((assistant.record as any).message.content).toEqual([{ type: "text", text: "hello" }]);

    const [reasoning] = m.map({ kind: "reasoning", text: "thinking" });
    expect((reasoning.record as any).message.content[0]).toEqual({
      type: "thinking",
      thinking: "thinking",
    });

    const user = m.map({ kind: "user-message", text: "go" });
    expect((user[0].record as any).message.content).toBe("go");

    // Empty prose contributes no record.
    expect(m.map({ kind: "assistant-message", text: "   " })).toEqual([]);
  });

  test("a command tool becomes a paired tool_use + tool_result with a bash sidecar", () => {
    const m = new CodexTranscriptMapper("L1");
    const recs = m.map({
      kind: "tool",
      tool: { kind: "command", command: "ls", aggregatedOutput: "a\nb", exitCode: 0 },
    });
    expect(recs).toHaveLength(2);
    const use = (recs[0].record as any).message.content[0];
    const result = (recs[1].record as any).message.content[0];
    expect(use.type).toBe("tool_use");
    expect(use.name).toBe("Bash");
    expect(use.input).toEqual({ command: "ls" });
    // The tool_use id and the tool_result's tool_use_id pair up.
    expect(result.tool_use_id).toBe(use.id);
    expect((recs[1].record as any).toolUseResult).toEqual({
      stdout: "a\nb",
      stderr: "",
      interrupted: false,
    });
  });

  test("turn usage decomposes Codex's inclusive input into the Claude cache legs", () => {
    const m = new CodexTranscriptMapper("L1");
    const [rec] = m.map({
      kind: "turn-completed",
      usage: {
        inputTokens: 100,
        cachedInputTokens: 30,
        cacheWriteInputTokens: 10,
        outputTokens: 20,
        reasoningOutputTokens: 5,
      },
    });
    const usage = (rec.record as any).message.usage;
    // input is what remains after removing the (inclusive) cache legs, so
    // input + cache_read + cache_creation == Codex's inclusive input_tokens (100).
    expect(usage.input_tokens).toBe(60);
    expect(usage.cache_read_input_tokens).toBe(30);
    expect(usage.cache_creation_input_tokens).toBe(10);
    expect(usage.output_tokens).toBe(20);
  });

  test("every record carries a distinct, stable event id", () => {
    const m = new CodexTranscriptMapper("L1");
    const events: NormalizedEvent[] = [
      { kind: "assistant-message", text: "a" },
      { kind: "tool", tool: { kind: "command", command: "ls", aggregatedOutput: "", exitCode: 0 } },
      { kind: "reasoning", text: "r" },
    ];
    const ids = events.flatMap((e) => m.map(e)).map((r) => r.eventId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("a seeded counter mints ids past the persisted ones so a resumed run never collides", () => {
    // A mapper that produced two records before a restart.
    const first = new CodexTranscriptMapper("L1");
    const persisted = [
      ...first.map({ kind: "assistant-message", text: "one" }),
      ...first.map({ kind: "assistant-message", text: "two" }),
    ].map((r) => r.eventId);
    expect(persisted).toEqual(["codex:L1:0", "codex:L1:1"]);

    // Rebuilt after the restart, seeded past those two persisted records.
    const resumed = new CodexTranscriptMapper("L1", persisted.length);
    const next = resumed.map({ kind: "assistant-message", text: "three" });
    expect(next[0]!.eventId).toBe("codex:L1:2");
    expect(persisted).not.toContain(next[0]!.eventId);
  });
});

describe("CodexObserver", () => {
  test("creates + attaches a session from the stream and appends its activity", () => {
    const { dir, store } = scratch();
    const { id, sidecar } = codexLaunch(store, dir);
    const { messages, broadcast } = recordingBroadcast();
    const observer = new CodexObserver(store.db, broadcast, { sessionExists: () => true });

    writeFileSync(
      sidecar,
      jsonl([
        { type: "thread.started", thread_id: "thread-1" },
        { type: "turn.started" },
        { type: "item.completed", item: { type: "reasoning", id: "r1", text: "planning" } },
        { type: "item.completed", item: { type: "agent_message", id: "a1", text: "done" } },
        {
          type: "item.completed",
          item: {
            type: "command_execution",
            id: "c1",
            command: "npm test",
            aggregated_output: "ok",
            exit_code: 0,
          },
        },
        { type: "turn.completed", usage: { input_tokens: 50, output_tokens: 8 } },
      ])
    );

    observer.tick();

    // The thread became a session, attached to the launch and marked running.
    const session = getSession(store.db, "thread-1");
    expect(session).not.toBeNull();
    expect(session?.projectId).toBe("p");
    expect(session?.title).toBe("make it work");
    expect(getLaunch(store.db, id)?.sessionId).toBe("thread-1");

    // The run's activity landed in the transcript log the web/mirror project from.
    const { events } = getEventsSince(store.db, "thread-1");
    const kinds = events.map((e) => {
      const r = e.event as any;
      if (r.type === "assistant") {
        const block = r.message.content?.[0];
        return block?.type ?? "usage";
      }
      return r.message.content?.[0]?.type ?? r.type;
    });
    expect(kinds).toContain("thinking");
    expect(kinds).toContain("text");
    expect(kinds).toContain("tool_use");
    expect(kinds).toContain("tool_result");

    // Live broadcasts fired: a session-list refresh and a transcript nudge.
    expect(messages.some((m) => m.type === "session:status")).toBe(true);
    expect(messages.some((m) => m.type === "session:event")).toBe(true);

    observer.stop();
  });

  test("caps the launch task into the stored session title (no wall-of-text from an unlabeled prompt)", () => {
    const { dir, store } = scratch();
    // An unlabeled console/Slack Codex launch: launch.task is the full raw prompt.
    // Codex sessions never fire Claude's title hooks, so the write here is the only
    // chance to bound it — it must cap, matching the Claude ensureSession path.
    const rawPrompt = "Bootstrap the widget service: " + "do the thing ".repeat(40);
    const { sidecar } = codexLaunch(store, dir, `L-${randomUUID().slice(0, 6)}`, rawPrompt);
    const observer = new CodexObserver(store.db, () => {}, { sessionExists: () => true });

    writeFileSync(sidecar, jsonl([{ type: "thread.started", thread_id: "thread-cap" }]));
    observer.tick();

    const title = getSession(store.db, "thread-cap")?.title ?? "";
    expect(title.length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
    expect(title).toBe(capTitle(rawPrompt));
    expect(title).not.toBe(rawPrompt); // the raw prompt was actually shortened
    expect(title.endsWith("…")).toBe(true);

    observer.stop();
  });

  test("re-ticking the same growing sidecar never double-appends", () => {
    const { dir, store } = scratch();
    const { sidecar } = codexLaunch(store, dir);
    const observer = new CodexObserver(store.db, () => {}, { sessionExists: () => true });

    writeFileSync(
      sidecar,
      jsonl([
        { type: "thread.started", thread_id: "thread-2" },
        { type: "item.completed", item: { type: "agent_message", id: "a1", text: "first" } },
      ])
    );
    observer.tick();
    const afterFirst = getEventsSince(store.db, "thread-2").events.length;

    // A second tick with no new bytes adds nothing.
    observer.tick();
    expect(getEventsSince(store.db, "thread-2").events.length).toBe(afterFirst);

    // New bytes append only the new record.
    appendFileSync(
      sidecar,
      jsonl([{ type: "item.completed", item: { type: "agent_message", id: "a2", text: "second" } }])
    );
    observer.tick();
    expect(getEventsSince(store.db, "thread-2").events.length).toBe(afterFirst + 1);

    observer.stop();
  });

  test("ends the session and drops it from the active fleet when the pane dies", () => {
    const { dir, store } = scratch();
    const { id, sidecar } = codexLaunch(store, dir);
    const { messages, broadcast } = recordingBroadcast();
    let alive = true;
    const observer = new CodexObserver(store.db, broadcast, { sessionExists: () => alive });

    writeFileSync(
      sidecar,
      jsonl([
        { type: "thread.started", thread_id: "thread-3" },
        { type: "item.completed", item: { type: "agent_message", id: "a1", text: "hi" } },
      ])
    );
    observer.tick();
    expect(getSession(store.db, "thread-3")?.endedAt).toBeUndefined();
    // While live, the launch is in the active fleet view.
    expect(getCodexLaunches(store.db, { activeOnly: true }).map((l) => l.id)).toContain(id);

    // The pane dies out-of-band; the next pass finalizes the session.
    alive = false;
    observer.tick();
    expect(getSession(store.db, "thread-3")?.endedAt).toBeInstanceOf(Date);
    expect(messages.some((m) => m.type === "session:end")).toBe(true);
    // A finished run leaves the active fleet even though the launch row stays
    // `running` — its session's ended_at is the signal, mirroring Claude.
    expect(getCodexLaunches(store.db, { activeOnly: true }).map((l) => l.id)).not.toContain(id);

    observer.stop();
  });

  test("fails a launch whose last turn the provider refused, with the provider's error", () => {
    const { dir, store } = scratch();
    const { id, sidecar } = codexLaunch(store, dir);
    let alive = true;
    const observer = new CodexObserver(store.db, () => {}, { sessionExists: () => alive });
    const refusal =
      "unexpected status 404 Not Found: The model 'example-model' does not exist, url: https://inference.example.com/openai/v1/responses";

    writeFileSync(
      sidecar,
      jsonl([
        { type: "thread.started", thread_id: "thread-refused" },
        { type: "turn.started" },
        { type: "error", message: `Reconnecting... 1/5 (${refusal})` },
        { type: "error", message: refusal },
        { type: "turn.failed", error: { message: refusal } },
      ])
    );
    observer.tick();
    expect(getLaunch(store.db, id)?.status).toBe("running");

    alive = false;
    observer.tick();
    const launch = getLaunch(store.db, id);
    expect(launch?.status).toBe("failed");
    expect(launch?.error).toBe(`codex turn failed: ${refusal}`);
    expect(getSession(store.db, "thread-refused")?.endedAt).toBeInstanceOf(Date);

    observer.stop();
  });

  /**
   * The real run loop drives a fake `codex` that replays what a provider-backed
   * CLI prints for a model the provider refuses (the shape of `codex exec
   * --json`, with placeholder hosts and ids) and exits 1, as it does.
   */
  test.each([
    ["provider.example-model-6.1", "codex-refused-model-404.jsonl", "404 Not Found: The model"],
    ["provider.example-model-6", "codex-refused-model-403.jsonl", "403 Forbidden"],
  ])("a launch on %s, which the provider refuses, runs one turn and fails with the provider's error", (model, fixture, expected) => {
    const { dir, store } = scratch();
    const { id, sidecar } = codexLaunch(store, dir);
    const bin = join(dir, `bin-${id}`);
    mkdirSync(bin);
    writeFileSync(
      join(bin, "codex"),
      `#!/bin/sh\necho "$*" >> "${bin}/calls"\ncat "${join(import.meta.dir, "harness", "fixtures", fixture)}"\nexit 1\n`
    );
    chmodSync(join(bin, "codex"), 0o755);
    const loop = buildCodexRunLoop('"$P"', buildCodexArgv({ cwd: dir, model }), buildCodexResumeFlags(), sidecar);
    Bun.spawnSync(["sh", "-c", loop], { env: { PATH: `${bin}:/usr/bin:/bin`, P: "do it" } });

    const calls = readFileSync(join(bin, "calls"), "utf8").trim().split("\n");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(`-m ${model}`);

    let alive = true;
    const observer = new CodexObserver(store.db, () => {}, { sessionExists: () => alive });
    observer.tick();
    alive = false;
    observer.tick();
    const launch = getLaunch(store.db, id);
    expect(launch?.status).toBe("failed");
    expect(launch?.error).toStartWith("codex turn failed: unexpected status ");
    expect(launch?.error).toContain(expected);

    observer.stop();
  });

  test("a run whose last turn failed after doing work stays running, and a refusal's error is capped", () => {
    const { dir, store } = scratch();
    const worked = codexLaunch(store, dir);
    const refused = codexLaunch(store, dir);
    let alive = true;
    const observer = new CodexObserver(store.db, () => {}, { sessionExists: () => alive });

    writeFileSync(
      worked.sidecar,
      jsonl([
        { type: "thread.started", thread_id: "thread-worked" },
        { type: "turn.started" },
        { type: "item.completed", item: { type: "agent_message", id: "a1", text: "half done" } },
        { type: "turn.failed", error: { message: "stream disconnected before completion" } },
      ])
    );
    const longRefusal = `unexpected status 403 Forbidden: ${"x".repeat(1000)}`;
    writeFileSync(
      refused.sidecar,
      jsonl([
        { type: "thread.started", thread_id: "thread-long" },
        { type: "turn.started" },
        { type: "turn.failed", error: { message: longRefusal } },
      ])
    );
    observer.tick();
    alive = false;
    observer.tick();

    expect(getLaunch(store.db, worked.id)?.status).toBe("running");
    const error = getLaunch(store.db, refused.id)?.error ?? "";
    expect(getLaunch(store.db, refused.id)?.status).toBe("failed");
    expect(error).toStartWith("codex turn failed: unexpected status 403 Forbidden: xxx");
    expect(error.length).toBeLessThan(400);

    observer.stop();
  });

  test("a failed turn followed by a turn that completes leaves the launch running", () => {
    const { dir, store } = scratch();
    const { id, sidecar } = codexLaunch(store, dir);
    let alive = true;
    const observer = new CodexObserver(store.db, () => {}, { sessionExists: () => alive });

    writeFileSync(
      sidecar,
      jsonl([
        { type: "thread.started", thread_id: "thread-recovered" },
        { type: "turn.started" },
        { type: "turn.failed", error: { message: "stream disconnected" } },
        { type: "turn.started" },
        { type: "item.completed", item: { type: "agent_message", id: "a1", text: "done" } },
        { type: "turn.completed", usage: { input_tokens: 5, output_tokens: 1 } },
      ])
    );
    observer.tick();
    alive = false;
    observer.tick();
    expect(getLaunch(store.db, id)?.status).toBe("running");

    observer.stop();
  });

  test("fails a launch whose pane died before it ever started a session", () => {
    const { dir, store } = scratch();
    const { id, sidecar } = codexLaunch(store, dir);
    let alive = true;
    const observer = new CodexObserver(store.db, () => {}, { sessionExists: () => alive });

    // Sidecar exists but Codex crashed before emitting thread.started.
    writeFileSync(sidecar, "");
    observer.tick();
    alive = false;
    observer.tick();

    const launch = getLaunch(store.db, id);
    expect(launch?.status).toBe("failed");
    expect(launch?.sessionId).toBeUndefined();
    // No session was ever created for it.
    expect(getCodexLaunches(store.db, { activeOnly: true }).map((l) => l.id)).not.toContain(id);

    observer.stop();
  });

  test("does not fail a still-provisioning launch whose pane hasn't spawned yet", () => {
    const { dir, store } = scratch();
    // The row exactly as createLaunch leaves it during provisioning: status
    // `starting` (setLaunchPhase never flips it; only the post-spawn
    // updateLaunchStatus does), its tmux session name reserved but the pane not
    // yet spawned, and no sidecar on disk. A poll landing in this window must not
    // mistake "not launched yet" for "pane died".
    const id = "codex-provisioning";
    const sidecar = join(dir, `${id}.jsonl`);
    createLaunch(store.db, {
      id,
      projectId: "p",
      task: "make it work",
      worktreePath: join(dir, id),
      branch: "feat",
      status: "starting",
      tmuxSession: `tmux-${id}`,
      harness: "codex",
      codexEventLog: sidecar,
    });
    // Pane not up (still provisioning); the launch IS in the active fleet, so the
    // observer picks it up.
    expect(getCodexLaunches(store.db, { activeOnly: true }).map((l) => l.id)).toContain(id);
    const observer = new CodexObserver(store.db, () => {}, { sessionExists: () => false });
    observer.tick();
    observer.tick();
    // It must still be `starting` — provisioning, not dead.
    expect(getLaunch(store.db, id)?.status).toBe("starting");
    expect(getSession(store.db, id)).toBeNull();
    observer.stop();
  });

  test("resumes losslessly: dedups ingested history and captures the un-ingested tail", () => {
    const { dir, store } = scratch();
    const { sidecar } = codexLaunch(store, dir);

    // A first observer ingests the run's opening history — creating + attaching the
    // session and persisting its records (event ids codex:<id>:0..). This is the
    // on-disk state a restart resumes from.
    const first = new CodexObserver(store.db, () => {}, { sessionExists: () => true });
    writeFileSync(
      sidecar,
      jsonl([
        { type: "thread.started", thread_id: "thread-loss" },
        { type: "item.completed", item: { type: "agent_message", id: "a1", text: "old" } },
      ])
    );
    first.tick();
    expect(getEventsSince(store.db, "thread-loss").events.length).toBe(1);

    // More activity streams to the sidecar, but the process goes down before the
    // observer ticks again: these bytes are on disk yet were never ingested. A
    // baseline-to-EOF resume would skip past them and drop them forever.
    appendFileSync(
      sidecar,
      jsonl([
        { type: "item.completed", item: { type: "agent_message", id: "a2", text: "mid" } },
        { type: "turn.completed", usage: { input_tokens: 12, output_tokens: 3 } },
      ])
    );
    first.stop();

    // The restart: a fresh observer resumes the still-live, already-attached launch.
    // Re-reading the sidecar from the start dedups the already-persisted "old"
    // record (no duplicate) AND ingests the un-ingested tail ("mid" + the usage
    // record), so nothing written before the restart is lost. old(1) + mid(1) +
    // usage(1) = 3 records.
    const resumed = new CodexObserver(store.db, () => {}, { sessionExists: () => true });
    resumed.tick();
    expect(getEventsSince(store.db, "thread-loss").events.length).toBe(3);

    resumed.stop();
  });

  test("a run resumed across a restart appends new records instead of dropping them as id collisions", () => {
    const { dir, store } = scratch();
    const { id, sidecar } = codexLaunch(store, dir);

    // First observer: ingests the pre-restart history, creating + attaching the
    // session and persisting its records (event ids codex:<id>:0..N-1) — exactly
    // the on-disk state a restart resumes from.
    const first = new CodexObserver(store.db, () => {}, { sessionExists: () => true });
    writeFileSync(
      sidecar,
      jsonl([
        { type: "thread.started", thread_id: "thread-restart" },
        { type: "turn.started" },
        { type: "item.completed", item: { type: "reasoning", id: "r1", text: "planning" } },
        { type: "item.completed", item: { type: "agent_message", id: "a1", text: "old" } },
        {
          type: "item.completed",
          item: {
            type: "command_execution",
            id: "c1",
            command: "ls",
            aggregated_output: "a",
            exit_code: 0,
          },
        },
        { type: "turn.completed", usage: { input_tokens: 20, output_tokens: 4 } },
      ])
    );
    first.tick();
    const beforeRestart = getEventsSince(store.db, "thread-restart").events.length;
    expect(beforeRestart).toBeGreaterThan(0);
    expect(getLaunch(store.db, id)?.sessionId).toBe("thread-restart");
    first.stop();

    // Restart: a brand-new observer with a fresh mapper picks the still-live launch
    // back up. Re-reading the sidecar from the start re-mints the pre-restart ids,
    // so its history re-ingests as dedup hits and the event count is unchanged.
    const resumed = new CodexObserver(store.db, () => {}, { sessionExists: () => true });
    resumed.tick();
    expect(getEventsSince(store.db, "thread-restart").events.length).toBe(beforeRestart);

    // Post-restart activity, appended after the resume: its records take fresh ids
    // past the re-minted pre-restart ones, so they append rather than colliding.
    // agent_message (1) + command_execution (tool_use + tool_result = 2) +
    // usage (1) = 4 new records.
    appendFileSync(
      sidecar,
      jsonl([
        { type: "item.completed", item: { type: "agent_message", id: "a2", text: "new" } },
        {
          type: "item.completed",
          item: {
            type: "command_execution",
            id: "c2",
            command: "pwd",
            aggregated_output: "/tmp",
            exit_code: 0,
          },
        },
        { type: "turn.completed", usage: { input_tokens: 30, output_tokens: 6 } },
      ])
    );
    resumed.tick();
    expect(getEventsSince(store.db, "thread-restart").events.length).toBe(beforeRestart + 4);

    resumed.stop();
  });
});

describe("reapDeadCodexLaunches", () => {
  test("fails a sessionless dead codex launch and leaves an observed one alone", () => {
    const { dir, store } = scratch();
    codexLaunch(store, dir, "codex-dead");
    const observed = codexLaunch(store, dir, "codex-observed");
    // The observed launch attached a session (a real session row for the JOIN).
    createSessionRow(store, "sess-observed", observed.id);

    const failed = reapDeadCodexLaunches(store.db, () => false);
    expect(failed.map((l) => l.id)).toEqual(["codex-dead"]);
    expect(getLaunch(store.db, "codex-dead")?.status).toBe("failed");
    // The observed launch keeps its session; reapDeadSessions owns ending it.
    expect(getLaunch(store.db, observed.id)?.status).toBe("running");
  });

  test("leaves live panes untouched", () => {
    const { dir, store } = scratch();
    codexLaunch(store, dir, "codex-live");
    expect(reapDeadCodexLaunches(store.db, () => true)).toEqual([]);
    expect(getLaunch(store.db, "codex-live")?.status).toBe("running");
  });

  test("leaves a still-provisioning launch (starting, no pane yet) untouched", () => {
    const { dir, store } = scratch();
    // A `starting` launch reserves its tmux session name but hasn't spawned the
    // pane yet, so a probe naturally reports it absent. That is "not launched
    // yet", not "died" — failing it would abort a launch mid-provision.
    const id = "codex-starting";
    const sidecar = join(dir, `${id}.jsonl`);
    createLaunch(store.db, {
      id,
      projectId: "p",
      task: "make it work",
      worktreePath: join(dir, id),
      branch: "feat",
      status: "starting",
      tmuxSession: `tmux-${id}`,
      harness: "codex",
      codexEventLog: sidecar,
    });
    expect(reapDeadCodexLaunches(store.db, () => false)).toEqual([]);
    expect(getLaunch(store.db, id)?.status).toBe("starting");
  });
});

/** Creates a session row and attaches it to a launch (for the JOIN in queries). */
function createSessionRow(store: Store, sessionId: string, launchId: string) {
  const launch = getLaunch(store.db, launchId)!;
  createSession(store.db, {
    id: sessionId,
    projectId: launch.projectId,
    title: launch.task,
    cwd: launch.worktreePath,
    status: "running",
  });
  attachSessionToLaunch(store.db, launchId, sessionId);
}
