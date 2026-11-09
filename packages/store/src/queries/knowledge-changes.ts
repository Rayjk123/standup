import type { Database } from "bun:sqlite";
import type { KnowledgeChange, KnowledgeChangeKind } from "@standup/shared";

interface KnowledgeChangeRow {
  id: string;
  project_id: string;
  slug: string;
  kind: KnowledgeChangeKind;
  title: string;
  session_id: string | null;
  contradicted: string | null;
  created_at: string;
  personal: number | null;
  owner_user: string | null;
}

function rowToChange(row: KnowledgeChangeRow): KnowledgeChange {
  const contradicted = row.contradicted
    ? (JSON.parse(row.contradicted) as string[])
    : undefined;
  return {
    id: row.id,
    projectId: row.project_id,
    slug: row.slug,
    kind: row.kind,
    title: row.title,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(contradicted && contradicted.length ? { contradicted } : {}),
    createdAt: row.created_at,
    ...(row.personal === 1 ? { personal: true } : {}),
    ...(row.owner_user ? { ownerUser: row.owner_user } : {}),
  };
}

/**
 * Persist a knowledge-graph change so it survives a reload/reconnect. The row
 * is the durable backing for the curated feed's knowledge leg — the snapshot
 * (getRecentKnowledgeChanges) and the /api/knowledge-changes ledger read it, so
 * a change stays on the feed the same way checkpoints and asks do.
 * INSERT OR IGNORE on the stable id makes a redelivered change a no-op.
 */
export function createKnowledgeChange(
  db: Database,
  change: KnowledgeChange
): KnowledgeChange {
  db.run(
    `INSERT OR IGNORE INTO knowledge_changes
       (id, project_id, slug, kind, title, session_id, contradicted, created_at, personal, owner_user)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      change.id,
      change.projectId,
      change.slug,
      change.kind,
      change.title,
      change.sessionId ?? null,
      change.contradicted && change.contradicted.length
        ? JSON.stringify(change.contradicted)
        : null,
      change.createdAt,
      change.personal ? 1 : 0,
      change.personal ? change.ownerUser ?? null : null,
    ]
  );
  return change;
}

/**
 * The most recent changes `viewer` may see. A change to a personal-layer doc is
 * returned only to its owner; a viewer of null (no identity, or a shared
 * surface such as the digest) sees none.
 *
 * A change is personal when it was recorded so, or when its doc is personal
 * now (scope='user', or a home CLAUDE.md / rules mirror) — read from the
 * `knowledge` index in the same database — which also covers a change recorded
 * before the flag existed or imported without it. A change whose doc is gone
 * counts as personal when its slug is a home mirror's (`native-mem-home-`, the
 * knowledge layer rules' stem), whatever its flag says — a flag of 0 on such a
 * slug can only come from an import that could not see the doc. The owner is the
 * recorded one, else the doc's; a personal change with neither is shown to
 * nobody.
 */
export function getRecentKnowledgeChanges(
  db: Database,
  limit = 50,
  viewer: string | null = null
): KnowledgeChange[] {
  const indexed =
    db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'knowledge'").get() !== null;
  const docPersonal = indexed
    ? "COALESCE(k.scope = 'user' OR (k.source_kind = 'native-memory' AND k.slug GLOB 'native-mem-home-*'), 0)"
    : "0";
  const personal = `(COALESCE(kc.personal, 0) = 1 OR ${docPersonal} OR (${
    indexed ? "k.id IS NULL AND " : ""
  }kc.slug GLOB 'native-mem-home-*'))`;
  const owner = indexed ? "COALESCE(kc.owner_user, k.owner_user)" : "kc.owner_user";
  const rows = db
    .query(
      `SELECT kc.id, kc.project_id, kc.slug, kc.kind, kc.title, kc.session_id, kc.contradicted, kc.created_at,
              CASE WHEN ${personal} THEN 1 ELSE 0 END AS personal,
              CASE WHEN ${personal} THEN ${owner} END AS owner_user
         FROM knowledge_changes kc
         ${indexed ? "LEFT JOIN knowledge k ON k.project_id = kc.project_id AND k.slug = kc.slug" : ""}
        WHERE NOT ${personal} OR (${owner} IS NOT NULL AND ${owner} = ?)
        ORDER BY kc.created_at DESC LIMIT ?`
    )
    .all(viewer, limit) as KnowledgeChangeRow[];
  return rows.map(rowToChange);
}
