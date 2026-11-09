import { runClaudeHeadless } from "../synth/claude-headless.js";

export interface ContextItem {
  label: string;
  text: string;
}

export async function synthesizeAnswer(
  question: string,
  context: ContextItem[],
  model: string,
  cwd: string
): Promise<string> {
  const blocks = context.map((c) => `[${c.label}]\n${c.text}`).join("\n\n");
  const prompt =
    `Answer the question using only the context below. Cite labels in [brackets]. ` +
    `If the context does not cover it, say so.\n\nQuestion: ${question}\n\n${blocks}`;
  return runClaudeHeadless(prompt, { model, cwd });
}
