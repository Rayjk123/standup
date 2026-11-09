import type { Database } from "bun:sqlite";
import { createKnowledgeChange } from "@standup/store";
import { layerOf, NATIVE_MEMORY_HOME_SLUG_PREFIX } from "@standup/knowledge";
import type {
  KnowledgeChange,
  KnowledgeChangeKind,
  WsMessage,
} from "@standup/shared";
import { hostUserAlias } from "./host-user.js";

/** The placement fields that decide whether a change concerns a personal doc. */
export interface KnowledgeChangeDoc {
  scope?: string;
  sourceKind?: string;
  ownerUser?: string;
}

/** The stored placement of (projectId, slug), or null when the doc is not indexed. */
function storedPlacement(db: Database, projectId: string, slug: string): KnowledgeChangeDoc | null {
  try {
    const row = db
      .query("SELECT scope, source_kind, owner_user FROM knowledge WHERE project_id = ? AND slug = ?")
      .get(projectId, slug) as { scope: string | null; source_kind: string | null; owner_user: string | null } | null;
    if (!row) return null;
    return {
      ...(row.scope ? { scope: row.scope } : {}),
      ...(row.source_kind ? { sourceKind: row.source_kind } : {}),
      ...(row.owner_user ? { ownerUser: row.owner_user } : {}),
    };
  } catch {
    return null;
  }
}

/** The owner a personal doc's change is shown to: its owner stamp, else the host user for a home mirror. */
function personalOwner(slug: string, placement: KnowledgeChangeDoc | null): string | undefined {
  return placement?.ownerUser ?? (slug.startsWith(NATIVE_MEMORY_HOME_SLUG_PREFIX) ? hostUserAlias() : undefined);
}

/**
 * Emits a knowledge-graph mutation (accept / remove / reconcile / flag a
 * contradiction / distill) as a substantive feed item — persisting it FIRST,
 * then broadcasting. Persist-before-broadcast is the whole point: buildSnapshot
 * ships getRecentKnowledgeChanges and the /api/knowledge-changes ledger re-reads
 * it, so the feed row survives a reload/reconnect instead of living only on the
 * wire. A cron that fires unattended (a reverify contradiction with no client
 * connected) is exactly the case that would otherwise be dropped.
 *
 * The change is project-scoped, not session-scoped, so one with no authoring
 * session (an ingested doc, a human removal, a cron-flagged contradiction) still
 * surfaces. This is the single choke point every emit path routes through — the
 * request-handling server and the crons wired in the entrypoint both use it, so
 * there is no second, non-persisting twin.
 *
 * A change to a personal-layer doc is private to the doc's owner: it is stored
 * flagged with the owner, and its frame is addressed to that owner alone (or
 * not broadcast at all when the owner is unknown). The doc's placement is read
 * from the index, or taken from `extra.doc` when the caller has it — a removal
 * emits after the doc has left the index.
 */
export function makeKnowledgeChangeEmitter(
  db: Database,
  broadcast: (message: WsMessage) => void
) {
  return function emitKnowledgeChange(
    kind: KnowledgeChangeKind,
    projectId: string,
    slug: string,
    title: string,
    extra?: { sessionId?: string; contradicted?: string[]; doc?: KnowledgeChangeDoc | null }
  ): void {
    const createdAt = new Date().toISOString();
    const placement = extra?.doc ?? storedPlacement(db, projectId, slug);
    // An unindexed home CLAUDE.md / rules mirror reads as personal by its slug alone.
    const personal =
      layerOf({ ...placement, slug }) === "personal" ||
      (placement === null && slug.startsWith(NATIVE_MEMORY_HOME_SLUG_PREFIX));
    const ownerUser = personal ? personalOwner(slug, placement) : undefined;
    const payload: KnowledgeChange = {
      id: `kc:${projectId}:${slug}:${kind}:${createdAt}`,
      projectId,
      slug,
      kind,
      title,
      createdAt,
      ...(extra?.sessionId ? { sessionId: extra.sessionId } : {}),
      ...(extra?.contradicted ? { contradicted: extra.contradicted } : {}),
      ...(personal ? { personal: true } : {}),
      ...(ownerUser ? { ownerUser } : {}),
    };
    createKnowledgeChange(db, payload);
    if (personal && !ownerUser) return;
    broadcast({
      type: "knowledge:change",
      payload,
      timestamp: createdAt,
      ...(ownerUser ? { audience: ownerUser } : {}),
    });
  };
}
