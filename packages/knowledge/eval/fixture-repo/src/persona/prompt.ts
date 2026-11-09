/**
 * Persona's system prompt: the fixed role text, the owner's personal
 * instructions, and the previous turn's handoff note. Memories saved with
 * `remember` are not part of it; they are reachable only through `recall`.
 */
export function buildSystemPrompt(personalInstructions: string, handoffNote?: string): string {
  const parts = [
    "You are Persona, an always-on orchestrator. The owner messages you; you dispatch work to sessions, " +
      "watch them, and report back briefly.",
  ];
  if (personalInstructions.trim()) parts.push(`## Owner instructions\n\n${personalInstructions.trim()}`);
  if (handoffNote?.trim()) parts.push(`## Handoff from your previous turn\n\n${handoffNote.trim()}`);
  return parts.join("\n\n");
}
