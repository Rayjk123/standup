import type { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { GLOBAL_PROJECT_ID } from "@standup/shared";
import { WRITER_STAMP_COLUMNS, stampedWriter, type WriterStampRow } from "@standup/knowledge";
import { recordKnowledgeRetrievals } from "../retrieval-telemetry.js";
import { PERSONA_WRITER } from "./memory-trust.js";
import {
  PLAYBOOK_SOURCE_KIND,
  isOwnersPlaybookSlug,
  parsePlaybook,
  playbookRelaxations,
  playbookSourceJob,
  type PlaybookFields,
} from "./playbook.js";

/**
 * An owner's playbooks as the knowledge index holds them: accepted docs and
 * pending drafts of source kind `playbook` in their personal layer of the
 * global corpus, with how often launches reused each one. Every read is keyed
 * on the owner and one of their own `playbook-<owner>--…` slugs, so one user's
 * playbooks never reach another's list or brief. An accepted playbook counts
 * only while it carries Persona's writer stamp over its content: a file
 * dropped or edited on disk is never offered.
 */

/** One playbook of an owner's library. */
export interface PlaybookEntry {
  slug: string;
  title: string;
  status: "accepted" | "pending";
  body: string;
  fields: PlaybookFields;
  updatedAt: string | null;
  fromJobId: string | null;
  usage: PlaybookUsage;
}

/** How launches reused a playbook, and how the last closed job that used it ended. */
export interface PlaybookUsage {
  count: number;
  lastUsedAt: string | null;
  lastOutcome: { jobId: string; status: string; outcome: string | null } | null;
}

const NO_USAGE: PlaybookUsage = { count: 0, lastUsedAt: null, lastOutcome: null };

/** A `datetime('now')` column (UTC, no `T` or zone) as an ISO time. */
const isoOf = (column: string) => `strftime('%Y-%m-%dT%H:%M:%SZ', ${column})`;

type AcceptedRow = WriterStampRow & { writer_stamp: string | null; updated_at_iso: string | null };
type DraftRow = { slug: string; title: string; body: string; updated_at_iso: string | null };

function query<T>(db: Database, sql: string, ...params: string[]): T[] {
  try {
    return db.query(sql).all(...params) as T[];
  } catch {
    // The knowledge index tables are created by the knowledge sync; a store
    // without them holds no playbooks.
    return [];
  }
}

function acceptedRows(db: Database, owner: string, slug?: string): AcceptedRow[] {
  return query<AcceptedRow>(
    db,
    `SELECT ${WRITER_STAMP_COLUMNS}, ${isoOf("updated_at")} AS updated_at_iso FROM knowledge
      WHERE project_id = ? AND scope = 'user' AND owner_user = ? AND source_kind = ?${slug ? " AND slug = ?" : ""}
      ORDER BY updated_at DESC, slug`,
    GLOBAL_PROJECT_ID,
    owner,
    PLAYBOOK_SOURCE_KIND,
    ...(slug ? [slug] : [])
  ).filter((row) => isOwnersPlaybookSlug(owner, row.slug) && stampedWriter(row) === PERSONA_WRITER);
}

function draftRows(db: Database, owner: string, slug?: string): DraftRow[] {
  return query<DraftRow>(
    db,
    `SELECT slug, title, body, ${isoOf("updated_at")} AS updated_at_iso FROM knowledge_drafts
      WHERE project_id = ? AND status = 'pending' AND scope = 'user' AND owner_user = ? AND source_kind = ?${slug ? " AND slug = ?" : ""}
      ORDER BY updated_at DESC, slug`,
    GLOBAL_PROJECT_ID,
    owner,
    PLAYBOOK_SOURCE_KIND,
    ...(slug ? [slug] : [])
  ).filter((row) => isOwnersPlaybookSlug(owner, row.slug));
}

/** `owner`'s accepted playbook at `slug`, or null. */
export function acceptedPlaybook(db: Database, owner: string, slug: string): PlaybookEntry | null {
  const row = acceptedRows(db, owner, slug)[0];
  return row ? entry(db, owner, row.slug, row.title, row.body, row.updated_at_iso, "accepted") : null;
}

/** `owner`'s pending playbook draft at `slug`, or null. */
export function pendingPlaybook(db: Database, owner: string, slug: string): PlaybookEntry | null {
  const row = draftRows(db, owner, slug)[0];
  return row ? entry(db, owner, row.slug, row.title, row.body, row.updated_at_iso, "pending") : null;
}

/** How many playbook drafts of `owner`'s are pending. */
export function pendingPlaybookCount(db: Database, owner: string): number {
  return draftRows(db, owner).length;
}

/** Every playbook of `owner`'s: pending drafts first, then accepted ones, newest first. */
export function listPlaybooks(db: Database, owner: string): PlaybookEntry[] {
  return [
    ...draftRows(db, owner).map((r) => entry(db, owner, r.slug, r.title, r.body, r.updated_at_iso, "pending")),
    ...acceptedRows(db, owner).map((r) => entry(db, owner, r.slug, r.title, r.body, r.updated_at_iso, "accepted")),
  ];
}

function entry(
  db: Database,
  owner: string,
  slug: string,
  title: string,
  body: string,
  updatedAt: string | null,
  status: PlaybookEntry["status"]
): PlaybookEntry {
  return {
    slug,
    title,
    status,
    body,
    fields: parsePlaybook(body),
    updatedAt,
    fromJobId: playbookSourceJob(body),
    usage: status === "accepted" ? playbookUsage(db, owner, slug) : NO_USAGE,
  };
}

/** The hash a keep decision is pinned to: the draft's title and body together. */
export function playbookHash(playbook: Pick<PlaybookEntry, "title" | "body">): string {
  return createHash("sha256").update(JSON.stringify([playbook.title, playbook.body])).digest("hex");
}

/** How launches of `owner`'s reused the playbook at `slug` (the `inject` rows recordPlaybookUse writes). */
export function playbookUsage(db: Database, owner: string, slug: string): PlaybookUsage {
  try {
    const totals = db
      .query(
        `SELECT COUNT(*) AS n, ${isoOf("MAX(created_at)")} AS last FROM knowledge_retrievals
          WHERE doc_project = ? AND doc_slug = ? AND surface = 'inject' AND injected = 1 AND doc_owner = ? AND source_kind = ?`
      )
      .get(GLOBAL_PROJECT_ID, slug, owner, PLAYBOOK_SOURCE_KIND) as { n: number; last: string | null } | null;
    const last = db
      .query(
        `SELECT j.id AS jobId, j.status AS status, j.outcome AS outcome FROM knowledge_retrievals r
           JOIN persona_job_launches pjl ON pjl.launch_id = r.launch_id
           JOIN persona_jobs j ON j.id = pjl.job_id
          WHERE r.doc_project = ? AND r.doc_slug = ? AND r.surface = 'inject' AND r.injected = 1 AND r.doc_owner = ?
            AND r.source_kind = ? AND j.owner = ? AND j.status IN ('done', 'failed', 'cancelled')
          ORDER BY j.updated_at DESC, r.created_at DESC
          LIMIT 1`
      )
      .get(GLOBAL_PROJECT_ID, slug, owner, PLAYBOOK_SOURCE_KIND, owner) as PlaybookUsage["lastOutcome"];
    return { count: totals?.n ?? 0, lastUsedAt: totals?.last ?? null, lastOutcome: last ?? null };
  } catch {
    return NO_USAGE;
  }
}

/** Records that `launchId`'s brief carried `owner`'s playbook `slug`. Best-effort: a logging failure never fails the launch. */
export function recordPlaybookUse(db: Database, owner: string, slug: string, launchId: string, queryText: string): void {
  try {
    recordKnowledgeRetrievals(
      db,
      [
        {
          docProject: GLOBAL_PROJECT_ID,
          docSlug: slug,
          query: queryText.slice(0, 500),
          rank: 0,
          surface: "inject",
          injected: true,
          launchId,
          layer: "personal",
          sourceKind: PLAYBOOK_SOURCE_KIND,
          scope: "user",
          docOwner: owner,
        },
      ],
      owner
    );
  } catch {
    // Telemetry only.
  }
}

/** A collector request as Persona's runtime makes it: in-process, as Persona's own write. */
export type PersonaRequest = (
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: Record<string, unknown>
) => Promise<{ status: number; body: Record<string, unknown> }>;

/** Why the request failed, as its route said. */
function failure(res: { status: number; body: Record<string, unknown> }): string {
  return typeof res.body.error === "string" ? res.body.error : `HTTP ${res.status}`;
}

/**
 * Keeps, drops or retires one of `owner`'s playbooks through the draft and
 * doc routes, as Persona's own write: `accept` publishes a pending draft
 * (checked again first, since the file is editable on disk; `pinnedHash`,
 * when given, must still match it), `reject` discards one, and `retire`
 * deletes an accepted playbook. Returns the title it acted on, or an error.
 */
export async function decidePlaybook(
  db: Database,
  request: PersonaRequest,
  owner: string,
  slug: string,
  decision: "accept" | "reject" | "retire",
  pinnedHash?: string
): Promise<{ ok: true; title: string } | { ok: false; error: string }> {
  const path = `/api/projects/${GLOBAL_PROJECT_ID}/knowledge`;
  if (decision === "retire") {
    const doc = acceptedPlaybook(db, owner, slug);
    if (!doc) return { ok: false, error: `no accepted playbook ${slug}` };
    const res = await request("DELETE", `${path}/${encodeURIComponent(slug)}`);
    return res.status === 200 ? { ok: true, title: doc.title } : { ok: false, error: failure(res) };
  }
  const draft = pendingPlaybook(db, owner, slug);
  if (!draft) return { ok: false, error: `no playbook draft ${slug}` };
  if (pinnedHash !== undefined && pinnedHash !== playbookHash(draft)) {
    return { ok: false, error: `the playbook draft ${slug} changed since it was checked; decide it again` };
  }
  const base = `${path}/drafts/${encodeURIComponent(slug)}`;
  if (decision === "reject") {
    const res = await request("POST", `${base}/discard`, {});
    return res.status === 200 ? { ok: true, title: draft.title } : { ok: false, error: failure(res) };
  }
  const relaxations = playbookRelaxations(draft.fields, draft.title);
  if (relaxations.length > 0) {
    const r = relaxations[0]!;
    return {
      ok: false,
      error: `not kept: the draft relaxes a pipeline stage, the safety floor or an outward-step rule (${r.field} "${r.line.slice(0, 120)}": ${r.why}); reject it or save a corrected one`,
    };
  }
  const res = await request("POST", `${base}/accept`, { mode: "replace", force: true, expectedHash: playbookHash(draft) });
  return res.status === 200 ? { ok: true, title: draft.title } : { ok: false, error: failure(res) };
}
