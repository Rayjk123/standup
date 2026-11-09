import type { Database } from "bun:sqlite";
import { GLOBAL_PROJECT_ID } from "@standup/shared";
import type { EvalCase, Hit, RunSurface } from "./types.js";

/**
 * Leakage judged from doc metadata alone, for every hit on every case, with no
 * per-case `forbidden` labels involved:
 *
 *  - `ownerMirror`: a mirror of the owner's home or project CLAUDE.md / rules
 *    (native-memory, slug native-mem-{home,project}-{claude-md,rule-*}) on a
 *    shared surface (search, inject). Auto-memory notes
 *    (native-mem-memory-*) are project activity notes, never leakage.
 *  - `otherUser`: a scope=user doc owned by someone other than the audience user.
 *  - `otherProject`: a scope=project doc homed in another project (a doc homed in
 *    the reserved global corpus reaches everyone, as the production gate treats it).
 *  - `injectForeignProduct`: on inject, a product/spec doc from another project.
 */
export const POLICY_RULES = ["ownerMirror", "otherUser", "otherProject", "injectForeignProduct"] as const;
export type PolicyRule = (typeof POLICY_RULES)[number];

/** Doc-returning surfaces other people's sessions share; `code` returns code passages, never docs. */
const SHARED_SURFACES: readonly RunSurface[] = ["search", "inject"];
const OWNER_MIRROR_SLUG = /^native-mem-(home|project)-(claude-md|rule-)/;

export interface DocMeta {
  projectId: string;
  slug: string;
  scope: string;
  ownerUser: string | null;
  sourceKind: string;
}

/** Scope/owner/kind of every doc in the DB, keyed by `project/slug`. */
export function loadDocMeta(db: Database): Map<string, DocMeta> {
  const rows = db
    .query("SELECT project_id, slug, scope, owner_user, source_kind FROM knowledge")
    .all() as Array<{ project_id: string; slug: string; scope: string; owner_user: string | null; source_kind: string }>;
  return new Map(
    rows.map((r) => [
      `${r.project_id}/${r.slug}`,
      { projectId: r.project_id, slug: r.slug, scope: r.scope, ownerUser: r.owner_user, sourceKind: r.source_kind },
    ])
  );
}

export function policyRulesFor(meta: DocMeta, surface: RunSurface, c: EvalCase): PolicyRule[] {
  const rules: PolicyRule[] = [];
  if (SHARED_SURFACES.includes(surface) && meta.sourceKind === "native-memory" && OWNER_MIRROR_SLUG.test(meta.slug)) {
    rules.push("ownerMirror");
  }
  if (meta.scope === "user" && meta.ownerUser !== (c.audience.user ?? null)) rules.push("otherUser");
  if (meta.scope === "project" && meta.projectId !== GLOBAL_PROJECT_ID && meta.projectId !== c.audience.projectId) {
    rules.push("otherProject");
  }
  if (
    surface === "inject" &&
    (meta.sourceKind === "product" || meta.sourceKind === "spec") &&
    meta.projectId !== c.audience.projectId
  ) {
    rules.push("injectForeignProduct");
  }
  return rules;
}

export interface PolicyPair {
  /** Violating hits (a hit breaking several rules counts once here). */
  hits: number;
  byRule: Record<PolicyRule, number>;
  refs: string[];
}

/** Policy violations over a pair's hits plus the extra docs it fed the consumer. */
export function policyViolations(
  c: EvalCase,
  surface: RunSurface,
  hits: Hit[],
  extraRefs: string[],
  docs: Map<string, DocMeta>
): PolicyPair {
  const byRule = Object.fromEntries(POLICY_RULES.map((r) => [r, 0])) as Record<PolicyRule, number>;
  const refs = new Set<string>();
  let count = 0;
  const refsSeen = [...hits.filter((h) => h.kind === "doc").map((h) => h.ref), ...extraRefs];
  for (const ref of refsSeen) {
    const meta = docs.get(ref);
    if (!meta) continue;
    const rules = policyRulesFor(meta, surface, c);
    if (rules.length === 0) continue;
    count++;
    refs.add(ref);
    for (const r of rules) byRule[r]++;
  }
  return { hits: count, byRule, refs: [...refs].sort() };
}
