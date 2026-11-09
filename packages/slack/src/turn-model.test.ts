import { describe, expect, test } from "bun:test";
import type { RichRow } from "./collector-client.js";
import { parseRichTurns, turnHasPrompt, turnPromptText, turnSignature, type OutputEvent } from "./turn-model.js";

const ts = "2026-01-01T00:00:00Z";

/** A representative rich-feed turn: prompt → think → text → bash → text → diff → todo. */
function scriptedTurn(): RichRow[] {
  return [
    { id: "u1", timestamp: ts, kind: "user", text: "fix the parser", sentBy: "alice" },
    { id: "a1:0", timestamp: ts, kind: "thinking", text: "I should read the file first." },
    { id: "a1:1", timestamp: ts, kind: "text", text: "Looking into it." },
    {
      id: "a1:2",
      timestamp: ts,
      kind: "tool",
      name: "Bash",
      input: { command: "ls" },
      result: { kind: "bash", stdout: "a.ts\nb.ts", stderr: "warn: deprecated", interrupted: false },
    },
    { id: "a2:0", timestamp: ts, kind: "text", text: "Now editing." },
    {
      id: "a2:1",
      timestamp: ts,
      kind: "tool",
      name: "Edit",
      input: { file_path: "/repo/src/a.ts" },
      result: {
        kind: "diff",
        filePath: "/repo/src/a.ts",
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [" ctx", "-old", "+new"] }],
      },
    },
    {
      id: "a2:2",
      timestamp: ts,
      kind: "tool",
      name: "TodoWrite",
      input: {},
      result: {
        kind: "todo",
        todos: [
          { content: "read", status: "completed" },
          { content: "edit", status: "in_progress" },
        ],
      },
    },
  ];
}

describe("parseRichTurns — ordered channel-neutral event model", () => {
  test("a turn preserves think→text→tool interleaving in emission order", () => {
    const turns = parseRichTurns(scriptedTurn());
    expect(turns).toHaveLength(1);
    const turn = turns[0]!;
    expect(turn.key).toBe("u1");
    expect(turn.startedAt).toBe(ts);

    // Each RichRow `tool` splits into an ordered tool_call + tool_result pair,
    // and thinking sits between the prompt and the answer text — not dropped.
    const kinds = turn.events.map((e) => e.kind);
    expect(kinds).toEqual([
      "user",
      "thinking",
      "text",
      "tool_call",
      "tool_result",
      "text",
      "tool_call",
      "tool_result",
      "tool_call",
      "tool_result",
    ]);
  });

  test("thinking survives with its full text (the distilled feed dropped it)", () => {
    const turn = parseRichTurns(scriptedTurn())[0]!;
    const thinking = turn.events.find((e) => e.kind === "thinking");
    expect(thinking).toBeDefined();
    expect((thinking as Extract<OutputEvent, { kind: "thinking" }>).text).toBe(
      "I should read the file first.",
    );
  });

  test("tool results carry STRUCTURED payloads, not a flattened string", () => {
    const turn = parseRichTurns(scriptedTurn())[0]!;
    const results = turn.events.filter(
      (e): e is Extract<OutputEvent, { kind: "tool_result" }> => e.kind === "tool_result",
    );
    expect(results.map((r) => r.result.kind)).toEqual(["bash", "diff", "todo"]);

    const bash = results[0]!.result;
    if (bash.kind !== "bash") throw new Error("expected bash");
    expect(bash.stdout).toBe("a.ts\nb.ts");
    expect(bash.stderr).toBe("warn: deprecated");

    const diff = results[1]!.result;
    if (diff.kind !== "diff") throw new Error("expected diff");
    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunks[0]!.lines).toEqual([" ctx", "-old", "+new"]);

    const todo = results[2]!.result;
    if (todo.kind !== "todo") throw new Error("expected todo");
    expect(todo.todos.map((t) => t.status)).toEqual(["completed", "in_progress"]);
  });

  test("tool_call carries the invocation name + input alongside its result", () => {
    const turn = parseRichTurns(scriptedTurn())[0]!;
    const call = turn.events.find(
      (e): e is Extract<OutputEvent, { kind: "tool_call" }> => e.kind === "tool_call",
    )!;
    expect(call.name).toBe("Bash");
    expect(call.input).toEqual({ command: "ls" });
    expect(call.id).toBe("a1:2#call");
  });

  test("turnHasPrompt / turnPromptText read the leading prompt event", () => {
    const turn = parseRichTurns(scriptedTurn())[0]!;
    expect(turnHasPrompt(turn)).toBe(true);
    expect(turnPromptText(turn)).toBe("fix the parser");
  });
});

describe("parseRichTurns — turn boundaries", () => {
  test("a new user row starts a new turn", () => {
    const rows: RichRow[] = [
      { id: "u1", timestamp: ts, kind: "user", text: "one" },
      { id: "a1:0", timestamp: ts, kind: "text", text: "ok" },
      { id: "u2", timestamp: ts, kind: "user", text: "two" },
      { id: "a2:0", timestamp: ts, kind: "text", text: "done" },
    ];
    const turns = parseRichTurns(rows);
    expect(turns).toHaveLength(2);
    expect(turnPromptText(turns[0]!)).toBe("one");
    expect(turnPromptText(turns[1]!)).toBe("two");
  });

  test("a localCommand row opens a turn", () => {
    const rows: RichRow[] = [
      { id: "c1", timestamp: ts, kind: "localCommand", name: "clear", args: "", stdout: "" },
      { id: "a1:0", timestamp: ts, kind: "text", text: "hi" },
    ];
    const turns = parseRichTurns(rows);
    expect(turns).toHaveLength(1);
    expect(turnHasPrompt(turns[0]!)).toBe(true);
    expect(turnPromptText(turns[0]!)).toBeUndefined(); // a slash command, not user prose
  });

  test("an assistant-led tail (opener aged out) opens a turn without a prompt event", () => {
    const rows: RichRow[] = [
      { id: "a1:0", timestamp: ts, kind: "text", text: "mid-turn tail" },
      {
        id: "a1:1",
        timestamp: ts,
        kind: "tool",
        name: "Read",
        input: { file_path: "x" },
        result: { kind: "pending" },
      },
    ];
    const turns = parseRichTurns(rows);
    expect(turns).toHaveLength(1);
    expect(turnHasPrompt(turns[0]!)).toBe(false);
    expect(turns[0]!.events[0]!.kind).toBe("text");
  });
});

describe("turnSignature — live-turn change detection", () => {
  test("a pending tool result resolving changes the signature", () => {
    const pending: RichRow[] = [
      { id: "u1", timestamp: ts, kind: "user", text: "go" },
      {
        id: "a1:0",
        timestamp: ts,
        kind: "tool",
        name: "Bash",
        input: { command: "sleep" },
        result: { kind: "pending" },
      },
    ];
    const resolved: RichRow[] = [
      pending[0]!,
      {
        id: "a1:0",
        timestamp: ts,
        kind: "tool",
        name: "Bash",
        input: { command: "sleep" },
        result: { kind: "bash", stdout: "done", stderr: "", interrupted: false },
      },
    ];
    const sigPending = turnSignature(parseRichTurns(pending)[0]!);
    const sigResolved = turnSignature(parseRichTurns(resolved)[0]!);
    expect(sigPending).not.toBe(sigResolved);
  });

  test("identical turns produce identical signatures (no spurious re-render)", () => {
    const a = turnSignature(parseRichTurns(scriptedTurn())[0]!);
    const b = turnSignature(parseRichTurns(scriptedTurn())[0]!);
    expect(a).toBe(b);
  });
});
