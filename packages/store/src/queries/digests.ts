import type { Database } from "bun:sqlite";
import type { Digest, DigestCounts } from "@standup/shared";

interface DigestRow {
  id: string;
  created_at: string;
  period_start: string;
  period_end: string;
  body: string;
  projects_json: string;
  counts_json: string;
}

/** Per-dimension tallies default to zero, so a malformed/absent blob never reads as NaN. */
const EMPTY_COUNTS: DigestCounts = {
  projects: 0,
  activeWork: 0,
  taskRuns: 0,
  checkpoints: 0,
  knowledgeChanges: 0,
  asks: 0,
  launches: 0,
};

function parseProjects(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

function parseCounts(json: string): DigestCounts {
  try {
    const parsed = JSON.parse(json) as Partial<DigestCounts>;
    return { ...EMPTY_COUNTS, ...(parsed && typeof parsed === "object" ? parsed : {}) };
  } catch {
    return { ...EMPTY_COUNTS };
  }
}

function rowToDigest(row: DigestRow): Digest {
  return {
    id: row.id,
    createdAt: row.created_at,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    body: row.body,
    projects: parseProjects(row.projects_json),
    counts: parseCounts(row.counts_json),
  };
}

/**
 * Persist a daily digest, the durable record of each posted digest
 * (getRecentDigests reads it back). INSERT OR IGNORE on the stable id
 * makes a redelivered digest a no-op.
 */
export function createDigest(db: Database, digest: Digest): Digest {
  db.run(
    `INSERT OR IGNORE INTO digests
       (id, created_at, period_start, period_end, body, projects_json, counts_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      digest.id,
      digest.createdAt,
      digest.periodStart,
      digest.periodEnd,
      digest.body,
      JSON.stringify(digest.projects ?? []),
      JSON.stringify(digest.counts ?? EMPTY_COUNTS),
    ]
  );
  return digest;
}

export function getRecentDigests(db: Database, limit = 30): Digest[] {
  const rows = db
    .query("SELECT * FROM digests ORDER BY created_at DESC LIMIT ?")
    .all(limit) as DigestRow[];
  return rows.map(rowToDigest);
}
