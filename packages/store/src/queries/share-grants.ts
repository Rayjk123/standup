import type { Database } from "bun:sqlite";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import type { ShareResourceType } from "@standup/shared";

/**
 * Read-only share links (migration 080). A grant is one minted token for one
 * resource (a review packet or a doc) of one owner, live until revoked; at
 * most one grant per resource is live. The token is kept so the owner can
 * copy the link again, and looked up by its digest.
 */

/** A live grant: the resource it shares and the token it shares it under. */
export interface ShareGrant {
  id: string;
  resourceType: ShareResourceType;
  resourceId: string;
  owner: string;
  token: string;
  createdAt: string;
}

interface GrantRow {
  id: string;
  resource_type: string;
  resource_id: string;
  owner: string;
  token: string;
  token_sha256: string;
  created_at: string;
  revoked_at: string | null;
}

function toGrant(r: GrantRow): ShareGrant {
  return {
    id: r.id,
    resourceType: r.resource_type as ShareResourceType,
    resourceId: r.resource_id,
    owner: r.owner,
    token: r.token,
    createdAt: r.created_at,
  };
}

/** The digest a share token is looked up by. */
export function shareTokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A fresh share token: 32 random bytes, base64url (SHARE_TOKEN). */
export function mintShareToken(): string {
  return randomBytes(32).toString("base64url");
}

/** The owner's resource's live grant, or null when it isn't shared. */
export function getLiveGrant(db: Database, type: ShareResourceType, resourceId: string, owner: string): ShareGrant | null {
  const row = db
    .query(
      `SELECT * FROM share_grants
        WHERE resource_type = ? AND resource_id = ? AND owner = ? AND revoked_at IS NULL`
    )
    .get(type, resourceId, owner) as GrantRow | null;
  return row ? toGrant(row) : null;
}

/** The ids of the owner's resources of `type` that are shared now (a live grant each). */
export function listSharedResourceIds(db: Database, type: ShareResourceType, owner: string): string[] {
  const rows = db
    .query("SELECT resource_id FROM share_grants WHERE resource_type = ? AND owner = ? AND revoked_at IS NULL ORDER BY created_at")
    .all(type, owner) as Array<{ resource_id: string }>;
  return rows.map((r) => r.resource_id);
}

/**
 * Turns sharing of the owner's resource on or off: on revokes any live grant
 * and mints a new one, so a link from an earlier share never works again;
 * off revokes. Returns the live grant, or null once it is off. The caller
 * checks the resource is the owner's and may be shared.
 */
export function setShare(
  db: Database,
  type: ShareResourceType,
  resourceId: string,
  owner: string,
  enabled: boolean,
  now: Date = new Date()
): ShareGrant | null {
  const at = now.toISOString();
  const set = db.transaction((): ShareGrant | null => {
    db.run(
      `UPDATE share_grants SET revoked_at = ?
        WHERE resource_type = ? AND resource_id = ? AND revoked_at IS NULL`,
      [at, type, resourceId]
    );
    if (!enabled) return null;
    const token = mintShareToken();
    const id = randomUUID();
    db.run(
      `INSERT INTO share_grants (id, resource_type, resource_id, owner, token, token_sha256, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, type, resourceId, owner, token, shareTokenDigest(token), at]
    );
    return { id, resourceType: type, resourceId, owner, token, createdAt: at };
  });
  return set();
}

/** The live grant of `type` a presented token names: its digest matches and the stored token equals it. */
export function findLiveGrantByToken(db: Database, type: ShareResourceType, token: string): ShareGrant | null {
  const row = db
    .query("SELECT * FROM share_grants WHERE token_sha256 = ? AND resource_type = ? AND revoked_at IS NULL")
    .get(shareTokenDigest(token), type) as GrantRow | null;
  // The digest matched; the stored token must also equal the one presented.
  if (!row || !timingSafeEqualText(row.token, token)) return null;
  return toGrant(row);
}

/** Revokes every live grant of the given resources; returns how many were revoked. */
export function revokeGrantsFor(db: Database, type: ShareResourceType, resourceIds: readonly string[], now: Date = new Date()): number {
  if (resourceIds.length === 0) return 0;
  const at = now.toISOString();
  let revoked = 0;
  // Chunked to stay under SQLite's bound-parameter limit.
  for (let i = 0; i < resourceIds.length; i += 500) {
    const chunk = resourceIds.slice(i, i + 500);
    const result = db.run(
      `UPDATE share_grants SET revoked_at = ?
        WHERE resource_type = ? AND revoked_at IS NULL AND resource_id IN (${chunk.map(() => "?").join(", ")})`,
      [at, type, ...chunk]
    );
    revoked += result.changes;
  }
  return revoked;
}

function timingSafeEqualText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
