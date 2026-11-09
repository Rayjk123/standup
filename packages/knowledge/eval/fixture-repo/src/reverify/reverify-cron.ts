import type { Database } from "bun:sqlite";

export interface ProjectRow {
  id: string;
  dailyReviewActive: boolean;
}

/**
 * Nightly re-verification of docs that carry a generated_from_sha. Runs only
 * for projects that opted into daily code review.
 */
export async function runReverifyCron(
  db: Database,
  projects: ProjectRow[],
  reverifyDoc: (docId: string) => Promise<void>
): Promise<number> {
  let checked = 0;
  for (const p of projects) {
    if (!p.dailyReviewActive) continue;
    const docs = db
      .query(`SELECT id FROM knowledge WHERE project_id = ? AND generated_from_sha IS NOT NULL`)
      .all(p.id) as { id: string }[];
    for (const d of docs) {
      await reverifyDoc(d.id);
      checked++;
    }
  }
  return checked;
}
