import type { ScopeAudience } from "./types.js";

export const GLOBAL_PROJECT_ID = "global";

/**
 * SQL predicate for the retrieval audience global ∪ project ∪ user, over a
 * `knowledge` row aliased `alias`. Pushed into the FTS arm, the vec0 KNN
 * hydration, and graph hydration so out-of-scope docs never enter ranking.
 * Without a resolved user the user disjunct is dropped.
 */
export function scopeAudienceSql(audience: ScopeAudience, alias: string): { sql: string; params: string[] } {
  const disjuncts = [
    `${alias}.scope = 'global'`,
    `(${alias}.project_id = ? AND ${alias}.scope != 'user')`,
    `(${alias}.scope = 'project' AND ${alias}.project_id = ?)`,
  ];
  const params = [GLOBAL_PROJECT_ID, audience.projectId];
  const user = audience.user?.trim();
  if (user) {
    disjuncts.push(`(${alias}.scope = 'user' AND ${alias}.owner_user = ?)`);
    params.push(user);
  }
  return { sql: `(${disjuncts.join(" OR ")})`, params };
}
