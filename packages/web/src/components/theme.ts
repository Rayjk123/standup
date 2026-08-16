/**
 * Turns a transcript's raw model id (e.g. `claude-sonnet-5-20250929`) into
 * the name shown in Claude Code's own UI. Falls back to the raw id for
 * anything unrecognized rather than hiding it.
 */
export function friendlyModel(id: string): string {
  const lower = id.toLowerCase();
  if (lower.includes("opus")) return "Opus 5";
  if (lower.includes("sonnet")) return "Sonnet 5";
  if (lower.includes("haiku")) return "Haiku 4.5";
  if (lower.includes("fable")) return "Fable 5";
  return id;
}

/**
 * Tailwind utility classes for each session status, keyed by the CSS
 * property they color. Written as full literal class names (not built from
 * a template) so Tailwind's static scanner can find them.
 */
export const statusColors = {
  running: { text: "text-running", bg: "bg-running", border: "border-running" },
  idle: { text: "text-idle", bg: "bg-idle", border: "border-idle" },
  waiting: { text: "text-waiting", bg: "bg-waiting", border: "border-waiting" },
  stalled: { text: "text-stalled", bg: "bg-stalled", border: "border-stalled" },
} as const;
