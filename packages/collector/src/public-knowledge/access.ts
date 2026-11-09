import type { Database } from "bun:sqlite";
import { getSetting, setSetting } from "@standup/store";
import { hostUserAlias } from "../host-user.js";
import { ALIAS_PATTERN, GROUP_PATTERN, type PublicKnowledgeAccess } from "./identity.js";

/** The settings key holding the public knowledge API's allowlist (JSON). */
export const PUBLIC_KNOWLEDGE_ACCESS_SETTING = "publicKnowledgeAccess";

/** Most entries each allowlist half may hold. */
export const MAX_ACCESS_ENTRIES = 200;

/** The allowlist before the owner sets one: the host user alone. */
export function defaultAccess(): PublicKnowledgeAccess {
  return { aliases: [hostUserAlias().toLowerCase()], posixGroups: [] };
}

/**
 * The stored allowlist, or the default when none is stored. A stored value
 * that does not parse, or whose entries fail validation, reads as an empty
 * allowlist rather than the default, so a corrupted setting admits no one.
 */
export function readAccess(db: Database): PublicKnowledgeAccess {
  const raw = getSetting(db, PUBLIC_KNOWLEDGE_ACCESS_SETTING);
  if (raw === null) return defaultAccess();
  try {
    const parsed = validateAccess(JSON.parse(raw));
    return "access" in parsed ? parsed.access : { aliases: [], posixGroups: [] };
  } catch {
    return { aliases: [], posixGroups: [] };
  }
}

export function writeAccess(db: Database, access: PublicKnowledgeAccess): void {
  setSetting(db, PUBLIC_KNOWLEDGE_ACCESS_SETTING, JSON.stringify(access));
}

/**
 * Validates an allowlist body: `aliases` and `posixGroups` are string arrays
 * (an absent one is empty), each entry trimmed, alias- or group-shaped, and
 * deduplicated, with at most MAX_ACCESS_ENTRIES per list. Aliases are
 * lowercased; group names keep their case, as `id -Gn` reports them.
 */
export function validateAccess(body: unknown): { access: PublicKnowledgeAccess } | { error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { error: "expected an object {aliases, posixGroups}" };
  const record = body as Record<string, unknown>;
  const list = (field: string, pattern: RegExp, what: string, canonical: (s: string) => string = (s) => s): string[] | string => {
    const value = record[field] ?? [];
    if (!Array.isArray(value)) return `${field} must be an array of strings`;
    const out: string[] = [];
    for (const entry of value) {
      if (typeof entry !== "string") return `${field} must be an array of strings`;
      const trimmed = canonical(entry.trim());
      if (!pattern.test(trimmed)) return `${JSON.stringify(entry).slice(0, 80)} is not a valid ${what}`;
      if (!out.includes(trimmed)) out.push(trimmed);
    }
    if (out.length > MAX_ACCESS_ENTRIES) return `${field} may hold at most ${MAX_ACCESS_ENTRIES} entries`;
    return out;
  };
  // Aliases are stored lowercased, the spelling publicCallerAlias reads a caller as.
  const aliases = list("aliases", ALIAS_PATTERN, "alias", (s) => s.toLowerCase());
  if (typeof aliases === "string") return { error: aliases };
  const posixGroups = list("posixGroups", GROUP_PATTERN, "POSIX group name");
  if (typeof posixGroups === "string") return { error: posixGroups };
  return { access: { aliases, posixGroups } };
}
