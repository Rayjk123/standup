import type { Database } from "bun:sqlite";
import type { Actor, SessionParticipant } from "@standup/shared";

/**
 * Actors (collaboration model). An actor is the durable
 * collaborator a session's created/owner/participant edges point at, seeded
 * from the tunnel alias. See migration 022.
 */

/**
 * Most distinct participants recorded per session. A best-effort activity
 * signal, not an access-control list — a cap keeps a long-lived session from
 * accumulating an unbounded row per drive-by visitor. The (session, actor) PK
 * dedups repeat actors, so this only bites for genuinely distinct ones.
 */
export const MAX_SESSION_PARTICIPANTS = 32;

interface ActorRow {
  id: string;
  display: string | null;
  github_login: string | null;
  merged_into: string | null;
  first_seen: string;
  last_seen: string;
}

function toActor(row: ActorRow): Actor {
  return {
    id: row.id,
    display: row.display ?? undefined,
    githubLogin: row.github_login ?? undefined,
    mergedInto: row.merged_into ?? undefined,
    firstSeen: new Date(row.first_seen),
    lastSeen: new Date(row.last_seen),
  };
}

interface ParticipantRow {
  session_id: string;
  actor_id: string;
  first_seen: string;
  contribution_count: number;
}

function toParticipant(row: ParticipantRow): SessionParticipant {
  return {
    sessionId: row.session_id,
    actorId: row.actor_id,
    firstSeen: new Date(row.first_seen),
    contributionCount: row.contribution_count,
  };
}

/**
 * Upserts the actor for `id`, bumping `last_seen` on every call. `first_seen`
 * is set only on the first sighting. `display`/`githubLogin` are stored only
 * when given; COALESCE keeps a previously set value rather than blanking it on
 * a later call that omits one. Returns the stored row.
 */
export function upsertActor(
  db: Database,
  id: string,
  opts?: { display?: string; githubLogin?: string }
): Actor {
  db.run(
    `INSERT INTO actors (id, display, github_login) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         last_seen = datetime('now'),
         display = COALESCE(excluded.display, actors.display),
         github_login = COALESCE(excluded.github_login, actors.github_login)`,
    [id, opts?.display ?? null, opts?.githubLogin ?? null]
  );
  return getActor(db, id)!;
}

/**
 * Resolves `id` to its canonical actor, following any `merged_into` tombstones
 * (see mergeActors) so a folded duplicate reads as the human it was merged
 * into. mergeActors keeps the chain one hop deep, but this walks it defensively
 * with a visited-set so a stray cycle can never loop. Returns null if the id
 * (or a tombstone's dangling target) has no row.
 */
export function getActor(db: Database, id: string): Actor | null {
  const stmt = db.query("SELECT * FROM actors WHERE id = ?");
  let row = stmt.get(id) as ActorRow | null;
  const seen = new Set<string>();
  while (row?.merged_into && !seen.has(row.id)) {
    seen.add(row.id);
    row = stmt.get(row.merged_into) as ActorRow | null;
  }
  return row ? toActor(row) : null;
}

/**
 * getActor over a snapshot of the whole actors table, loaded in one query: the
 * returned function resolves an id through `merged_into` tombstones exactly as
 * getActor does. For decorating many sessions at once, where a lookup per
 * attribution id would cost a query each. The actors table holds one row per
 * collaborator, so loading it whole stays small.
 */
export function actorResolver(db: Database): (id: string) => Actor | null {
  const rows = new Map(
    (db.query("SELECT * FROM actors").all() as ActorRow[]).map((r) => [r.id, r])
  );
  return (id) => {
    let row = rows.get(id) ?? null;
    const seen = new Set<string>();
    while (row?.merged_into && !seen.has(row.id)) {
      seen.add(row.id);
      row = rows.get(row.merged_into) ?? null;
    }
    return row ? toActor(row) : null;
  };
}

/**
 * Lists canonical actors only — rows folded into another via `merged_into` are
 * omitted so a reconciled duplicate never shows up as a second collaborator.
 */
export function getActors(db: Database): Actor[] {
  const rows = db
    .query("SELECT * FROM actors WHERE merged_into IS NULL ORDER BY last_seen DESC")
    .all() as ActorRow[];
  return rows.map(toActor);
}

/**
 * Reconciles one human's two actor rows: folds `fromId` into `intoId` so every
 * created/owner/participant edge that points at `fromId` resolves to `intoId`
 * (via getActor) and `fromId` drops out of getActors. This is concrete for the
 * Slack adapter — a teammate who answers an ask in Slack mints a `slack:U…`
 * actor while driving sessions through the tunnel mints an SSO-alias actor;
 * merging links the two rather than double-counting one person.
 *
 * Mirrors OpenClaw's user_profiles merge: the target's canonical row adopts any
 * identity (`display`, `github_login`) the folded row carries and it lacks
 * (COALESCE — never clobbering one it already has), and any tombstone already
 * aimed at `fromId` is repointed at the canonical id in the same write, so
 * every `merged_into` pointer stays exactly one hop from the head. Merging into
 * an already-folded actor collapses onto its head; self-merge is a no-op.
 * Returns the canonical actor.
 */
export function mergeActors(db: Database, fromId: string, intoId: string): Actor {
  upsertActor(db, fromId);
  upsertActor(db, intoId);

  const canonicalId = getActor(db, intoId)!.id;
  if (fromId === canonicalId) return getActor(db, canonicalId)!;

  db.run(
    `UPDATE actors SET
       display = COALESCE(display, (SELECT display FROM actors WHERE id = ?)),
       github_login = COALESCE(github_login, (SELECT github_login FROM actors WHERE id = ?)),
       last_seen = datetime('now')
     WHERE id = ?`,
    [fromId, fromId, canonicalId]
  );

  db.run(
    "UPDATE actors SET merged_into = ? WHERE id = ? OR merged_into = ?",
    [canonicalId, fromId, fromId]
  );

  return getActor(db, canonicalId)!;
}

/**
 * Records `actorId` as a participant of `sessionId`, best-effort. Idempotent on
 * the (session, actor) pair — a repeat sighting bumps `contribution_count`
 * rather than adding a second row, so the participant SET is stable while the
 * count tracks how often they acted. A first sighting inserts a row unless the
 * session is already at MAX_SESSION_PARTICIPANTS distinct actors, in which case
 * it's dropped (the cap). Upserts the actor first so the FK always resolves.
 */
export function recordParticipant(
  db: Database,
  sessionId: string,
  actorId: string
): void {
  upsertActor(db, actorId);

  const existing = db
    .query("SELECT 1 FROM session_participants WHERE session_id = ? AND actor_id = ?")
    .get(sessionId, actorId);
  if (existing) {
    db.run(
      `UPDATE session_participants SET contribution_count = contribution_count + 1
         WHERE session_id = ? AND actor_id = ?`,
      [sessionId, actorId]
    );
    return;
  }

  const { n } = db
    .query("SELECT COUNT(*) AS n FROM session_participants WHERE session_id = ?")
    .get(sessionId) as { n: number };
  if (n >= MAX_SESSION_PARTICIPANTS) return;

  db.run(
    `INSERT INTO session_participants (session_id, actor_id, contribution_count)
       VALUES (?, ?, 1)`,
    [sessionId, actorId]
  );
}

export function getParticipants(db: Database, sessionId: string): SessionParticipant[] {
  const rows = db
    .query(
      "SELECT * FROM session_participants WHERE session_id = ? ORDER BY first_seen"
    )
    .all(sessionId) as ParticipantRow[];
  return rows.map(toParticipant);
}

/**
 * getParticipants for many sessions in one query, keyed by session id. Each
 * list is in the same order getParticipants returns; a session with no
 * participants has no entry.
 */
export function getParticipantsBySession(
  db: Database,
  sessionIds: readonly string[]
): Map<string, SessionParticipant[]> {
  const rows = db
    .query(
      `SELECT * FROM session_participants
        WHERE session_id IN (SELECT value FROM json_each(?))
        ORDER BY session_id, first_seen`
    )
    .all(JSON.stringify(sessionIds)) as ParticipantRow[];
  const bySession = new Map<string, SessionParticipant[]>();
  for (const row of rows) {
    const list = bySession.get(row.session_id);
    if (list) list.push(toParticipant(row));
    else bySession.set(row.session_id, [toParticipant(row)]);
  }
  return bySession;
}
