import type { Database } from "bun:sqlite";
import { createCheckpoint } from "@standup/store";
import type { Checkpoint } from "@standup/shared";

// TodoWrite is called with the full todo list on every invocation, so we
// track which items we've already turned into a checkpoint per session to
// avoid re-announcing the same completion. In-memory is fine here — this is
// a live signal, not history; a collector restart just means one replay of
// already-completed items, not a wrong one.
// Verify the exact TodoWrite tool_input shape against the hooks reference:
// https://code.claude.com/docs/en/hooks
const checkpointedTodos = new Map<string, Set<string>>();

interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed" | string;
}

export function checkpointCompletedTodos(
  db: Database,
  sessionId: string,
  toolInput: Record<string, unknown>
): Checkpoint[] {
  const todos = toolInput.todos as TodoItem[] | undefined;
  if (!Array.isArray(todos)) return [];

  let seen = checkpointedTodos.get(sessionId);
  if (!seen) {
    seen = new Set();
    checkpointedTodos.set(sessionId, seen);
  }

  const newCheckpoints: Checkpoint[] = [];

  for (const todo of todos) {
    if (todo.status !== "completed" || seen.has(todo.content)) continue;

    seen.add(todo.content);
    newCheckpoints.push(
      createCheckpoint(db, sessionId, "structural", `Completed: ${todo.content}`)
    );
  }

  return newCheckpoints;
}

export function clearTodoCheckpointState(sessionId: string): void {
  checkpointedTodos.delete(sessionId);
}
