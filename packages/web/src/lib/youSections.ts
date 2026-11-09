/**
 * The You tab's section ids, in page order — the path segments `/you/<id>`
 * resolves. YouView pairs each with its title and content. The viewer's own
 * sections come first, then the host-wide Workspace ones.
 */
export const YOU_SECTION_IDS = [
  "profile",
  "appearance",
  "decider",
  "usage",
  "budgets",
  "team-api",
  "decisions",
  "notifications",
  "playbooks",
  "workspace",
  "orchestration",
] as const;

export type YouSectionId = (typeof YOU_SECTION_IDS)[number];

/** True when `id` names a You tab section. */
export function isYouSectionId(id: string | undefined): id is YouSectionId {
  return (YOU_SECTION_IDS as readonly string[]).includes(id ?? "");
}

/** The path that opens the You tab on section `id`. */
export function youSectionPath(id: string): string {
  return `/you/${id}`;
}

/** Where a /cost deep link resolves. */
export const LEGACY_COST_PATH = youSectionPath("usage");

/** Where a /settings deep link resolves: the host-wide settings. */
export const LEGACY_SETTINGS_PATH = youSectionPath("workspace");
