import { describe, expect, test } from "bun:test";
import { parseRows } from "./rich-transcript.js";

const j = (o: unknown) => JSON.stringify(o);

function assistant(uuid: string, content: unknown, usage?: Record<string, number>) {
  return j({ type: "assistant", uuid, timestamp: "2026-01-01T00:00:00Z", message: { role: "assistant", model: "claude-opus-4-8", content, usage } });
}
function userToolResult(toolUseId: string, text: string, toolUseResult: unknown, isError = false) {
  return j({
    type: "user",
    uuid: `res-${toolUseId}`,
    timestamp: "2026-01-01T00:00:01Z",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: text, is_error: isError }] },
    toolUseResult,
  });
}

describe("rich-transcript parseRows", () => {
  test("preserves intra-turn block order: thinking → text → tool", () => {
    const lines = [
      assistant("a1", [{ type: "thinking", thinking: "reasoning" }]),
      assistant("a2", [{ type: "text", text: "Doing it." }]),
      assistant("a3", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }]),
      userToolResult("t1", "ok", { stdout: "file.txt", stderr: "", interrupted: false }),
    ];
    const kinds = parseRows(lines).rows.map((r) => r.kind);
    expect(kinds).toEqual(["thinking", "text", "tool"]);
  });

  test("drops empty (redacted) thinking", () => {
    const rows = parseRows([assistant("a1", [{ type: "thinking", thinking: "" }]), assistant("a2", [{ type: "text", text: "hi" }])]).rows;
    expect(rows.map((r) => r.kind)).toEqual(["text"]);
  });

  test("Bash result splits stdout/stderr and interrupted", () => {
    const rows = parseRows([
      assistant("a1", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "x" } }]),
      userToolResult("t1", "", { stdout: "out", stderr: "err", interrupted: true }),
    ]).rows;
    const tool = rows.find((r) => r.kind === "tool")!;
    expect(tool.kind).toBe("tool");
    if (tool.kind === "tool" && tool.result.kind === "bash") {
      expect(tool.result.stdout).toBe("out");
      expect(tool.result.stderr).toBe("err");
      expect(tool.result.interrupted).toBe(true);
    } else throw new Error("expected bash result");
  });

  test("Edit result becomes a diff with structuredPatch hunks", () => {
    const patch = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [" ctx", "+added"] }];
    const rows = parseRows([
      assistant("a1", [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/a.ts" } }]),
      userToolResult("t1", "updated", { filePath: "/a.ts", structuredPatch: patch }),
    ]).rows;
    const tool = rows.find((r) => r.kind === "tool")!;
    if (tool.kind === "tool" && tool.result.kind === "diff") {
      expect(tool.result.hunks).toHaveLength(1);
      expect(tool.result.hunks[0].lines).toEqual([" ctx", "+added"]);
    } else throw new Error("expected diff result");
  });

  test("Read result carries line counts", () => {
    const rows = parseRows([
      assistant("a1", [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a.ts" } }]),
      userToolResult("t1", "content", { type: "text", file: { filePath: "/a.ts", numLines: 10, totalLines: 200 } }),
    ]).rows;
    const tool = rows.find((r) => r.kind === "tool")!;
    if (tool.kind === "tool" && tool.result.kind === "read") {
      expect(tool.result.numLines).toBe(10);
      expect(tool.result.totalLines).toBe(200);
    } else throw new Error("expected read result");
  });

  test("TodoWrite reads todos from input, not the sidecar", () => {
    const rows = parseRows([
      assistant("a1", [{ type: "tool_use", id: "t1", name: "TodoWrite", input: { todos: [{ content: "do it", status: "in_progress" }] } }]),
      userToolResult("t1", "ok", { oldTodos: [], newTodos: [] }),
    ]).rows;
    const tool = rows.find((r) => r.kind === "tool")!;
    if (tool.kind === "tool" && tool.result.kind === "todo") {
      expect(tool.result.todos[0].content).toBe("do it");
    } else throw new Error("expected todo result");
  });

  test("AskUserQuestion renders the question + options even while pending (no result)", () => {
    const input = {
      questions: [
        {
          question: "Which direction?",
          header: "Direction",
          multiSelect: false,
          options: [
            { label: "Port the fix", description: "keep the batch method" },
            { label: "Unify", description: "one shared query" },
          ],
        },
      ],
    };
    const rows = parseRows([assistant("a1", [{ type: "tool_use", id: "t1", name: "AskUserQuestion", input }])]).rows;
    const tool = rows.find((r) => r.kind === "tool")!;
    if (tool.kind === "tool" && tool.result.kind === "question") {
      expect(tool.result.questions[0].question).toBe("Which direction?");
      expect(tool.result.questions[0].header).toBe("Direction");
      expect(tool.result.questions[0].options).toHaveLength(2);
      expect(tool.result.questions[0].options[0].description).toBe("keep the batch method");
      expect(tool.result.questions[0].answer).toBeUndefined();
    } else throw new Error(`expected question result, got ${tool.kind === "tool" ? tool.result.kind : tool.kind}`);
  });

  test("AskUserQuestion surfaces the chosen answer from the sidecar", () => {
    const input = { questions: [{ question: "Which table's TTL?", options: [{ label: "Both" }, { label: "One" }] }] };
    const rows = parseRows([
      assistant("a1", [{ type: "tool_use", id: "t1", name: "AskUserQuestion", input }]),
      userToolResult("t1", "answered", { answers: { "Which table's TTL?": "Both" } }),
    ]).rows;
    const tool = rows.find((r) => r.kind === "tool")!;
    if (tool.kind === "tool" && tool.result.kind === "question") {
      expect(tool.result.questions[0].answer).toBe("Both");
    } else throw new Error("expected question result");
  });

  test("a tool with no result yet is pending", () => {
    const rows = parseRows([assistant("a1", [{ type: "tool_use", id: "t1", name: "Grep", input: { pattern: "x" } }])]).rows;
    const tool = rows.find((r) => r.kind === "tool")!;
    expect(tool.kind === "tool" && tool.result.kind).toBe("pending");
  });

  test("compact_boundary becomes a compaction row", () => {
    const rows = parseRows([
      j({ type: "system", subtype: "compact_boundary", uuid: "c1", compactMetadata: { trigger: "manual", preTokens: 900000, postTokens: 20000 } }),
    ]).rows;
    expect(rows).toHaveLength(1);
    if (rows[0].kind === "compaction") {
      expect(rows[0].trigger).toBe("manual");
      expect(rows[0].preTokens).toBe(900000);
      expect(rows[0].postTokens).toBe(20000);
    } else throw new Error("expected compaction row");
  });

  test("mode banners only emit on change, baseline is silent", () => {
    const rows = parseRows([
      j({ type: "mode", uuid: "m1", mode: "normal" }),
      j({ type: "mode", uuid: "m2", mode: "normal" }),
      j({ type: "mode", uuid: "m3", mode: "plan" }),
      j({ type: "permission-mode", uuid: "p1", permissionMode: "default" }),
      j({ type: "permission-mode", uuid: "p2", permissionMode: "acceptEdits" }),
    ]).rows;
    const labels = rows.filter((r) => r.kind === "mode").map((r) => (r.kind === "mode" ? r.label : ""));
    expect(labels).toEqual(["mode: plan", "permissions: acceptEdits"]);
  });

  test("task-notification collapses to summary + status", () => {
    const notif = "<task-notification>\n<status>completed</status>\n<summary>Dynamic workflow \"X\" completed</summary>\n<result>huge blob…</result>\n</task-notification>";
    const rows = parseRows([j({ type: "user", uuid: "u1", message: { role: "user", content: notif } })]).rows;
    expect(rows).toHaveLength(1);
    if (rows[0].kind === "taskNotification") {
      expect(rows[0].status).toBe("completed");
      expect(rows[0].summary).toContain("Dynamic workflow");
    } else throw new Error("expected taskNotification row");
  });

  test("tool_result-only user records are not shown as user turns", () => {
    const rows = parseRows([userToolResult("t1", "some result", { stdout: "x", stderr: "" })]).rows;
    expect(rows).toHaveLength(0);
  });

  test("counts a message's output tokens once even when split across records", () => {
    // One logical message (same message.id) split into thinking + text + tool
    // records, each stamped with identical message-level usage.
    const usage = { output_tokens: 1103, input_tokens: 2, cache_read_input_tokens: 15069 };
    const split = (uuid: string, block: unknown) =>
      j({ type: "assistant", uuid, timestamp: "t", message: { id: "msg_1", model: "claude-opus-4-8", content: [block], usage } });
    const out = parseRows([
      split("u1", { type: "thinking", thinking: "reasoning" }),
      split("u2", { type: "text", text: "answer" }),
      split("u3", { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }),
    ]);
    // 1103 once, not 3309.
    expect(out.outputTokens).toBe(1103);
  });

  test("Write that creates a new file (empty patch) surfaces a line count, not a blank diff", () => {
    const rows = parseRows([
      assistant("a1", [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "/new.ts" } }]),
      userToolResult("t1", "created", { type: "create", filePath: "/new.ts", content: "a\nb\nc", structuredPatch: [] }),
    ]).rows;
    const tool = rows.find((r) => r.kind === "tool")!;
    if (tool.kind === "tool" && tool.result.kind === "write") {
      expect(tool.result.lineCount).toBe(3);
    } else throw new Error(`expected write result, got ${tool.kind === "tool" ? tool.result.kind : tool.kind}`);
  });

  test("sums output tokens and tracks last context/model", () => {
    const out = parseRows([
      assistant("a1", [{ type: "text", text: "one" }], { output_tokens: 100, input_tokens: 5, cache_read_input_tokens: 50 }),
      assistant("a2", [{ type: "text", text: "two" }], { output_tokens: 40, input_tokens: 5, cache_read_input_tokens: 90 }),
    ]);
    expect(out.outputTokens).toBe(140);
    expect(out.contextTokens).toBe(95);
    expect(out.model).toBe("claude-opus-4-8");
  });
});

/** An assistant text record stamped with an explicit sessionId. */
function textWithSession(uuid: string, text: string, sessionId: string) {
  return j({
    type: "assistant",
    uuid,
    sessionId,
    timestamp: "2026-01-01T00:00:00Z",
    message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "text", text }] },
  });
}

describe("rich-transcript parseRows — session isolation", () => {
  test("drops records belonging to another session when a sessionId is given", () => {
    // A resumed/compacted transcript can hold the parent conversation's turns,
    // each keeping its ORIGINAL sessionId. Reading under the owning session must
    // never surface another session's turns.
    const lines = [
      textWithSession("m1", "mine one", "own"),
      textWithSession("f1", "SECRET from another session", "other"),
      textWithSession("m2", "mine two", "own"),
    ];
    const texts = parseRows(lines, "own").rows.flatMap((r) => (r.kind === "text" ? [r.text] : []));
    expect(texts).toEqual(["mine one", "mine two"]);
    expect(texts.join(" ")).not.toContain("SECRET");
  });

  test("keeps un-attributable (sessionId-less) records so UI-state banners survive", () => {
    const lines = [
      j({ type: "mode", mode: "plan", timestamp: "2026-01-01T00:00:00Z" }), // no sessionId
      j({ type: "mode", mode: "acceptEdits", timestamp: "2026-01-01T00:00:01Z" }), // change → banner
      textWithSession("m1", "hello", "own"),
    ];
    const kinds = parseRows(lines, "own").rows.map((r) => r.kind);
    expect(kinds).toContain("mode");
    expect(kinds).toContain("text");
  });

  test("with no sessionId requested, the filter is a no-op (back-compat)", () => {
    const lines = [
      textWithSession("m1", "a", "own"),
      textWithSession("f1", "b", "other"),
    ];
    expect(parseRows(lines).rows).toHaveLength(2);
  });
});
