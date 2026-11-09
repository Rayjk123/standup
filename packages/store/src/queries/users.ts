import type { Database } from "bun:sqlite";
import type { CurrentUser } from "@standup/shared";

/** Users of the collector, keyed by SSO alias. See migration 021. */

interface UserRow {
  alias: string;
  display: string | null;
  first_seen: string;
  last_seen: string;
}

function toUser(row: UserRow): CurrentUser {
  return {
    alias: row.alias,
    display: row.display ?? undefined,
    firstSeen: new Date(row.first_seen),
    lastSeen: new Date(row.last_seen),
  };
}

/**
 * Upserts the user for `alias`, bumping `last_seen` on every call — invoked once
 * per request so first_seen/last_seen bracket a teammate's activity. first_seen
 * is set only on the first sighting and never overwritten. An optional `display`
 * is stored only when given; COALESCE keeps a previously set name rather than
 * blanking it on a later request that omits one.
 *
 * `viaTunnel` records whether this sighting arrived through the gateway as a
 * remote person (the tunnel identity header was present) rather than as an
 * agent/MCP phone-home under the host `$USER`. It is sticky — MAX() never
 * downgrades a person's row to 0 on a later header-less request under the same
 * alias — and is what countDistinctUsers filters on so agent process identities
 * don't inflate the multiplayer people count. Returns the stored row.
 */
export function touchUser(
  db: Database,
  alias: string,
  opts: { display?: string; viaTunnel?: boolean } = {}
): CurrentUser {
  const { display, viaTunnel = false } = opts;
  db.run(
    `INSERT INTO users (alias, display, via_tunnel) VALUES (?, ?, ?)
       ON CONFLICT(alias) DO UPDATE SET
         last_seen = datetime('now'),
         display = COALESCE(excluded.display, users.display),
         via_tunnel = MAX(users.via_tunnel, excluded.via_tunnel)`,
    [alias, display ?? null, viaTunnel ? 1 : 0]
  );
  return getUser(db, alias)!;
}

export function getUser(db: Database, alias: string): CurrentUser | null {
  const row = db.query("SELECT * FROM users WHERE alias = ?").get(alias) as UserRow | null;
  return row ? toUser(row) : null;
}

export function getUsers(db: Database): CurrentUser[] {
  const rows = db.query("SELECT * FROM users ORDER BY last_seen DESC").all() as UserRow[];
  return rows.map(toUser);
}

/**
 * How many distinct PEOPLE have connected through the gateway — rows whose
 * via_tunnel is set (a tunnel identity header was seen). Agent/MCP
 * phone-home traffic carries no such header and resolves to the host `$USER`
 * (or "local"), so it is deliberately excluded: counting it would let a single
 * solo human — whose browser alias differs from their agents' host identity —
 * trip the ≥2 multiplayer signal. This is the count that flips the launch
 * default to a fresh worktree per project once it reaches two (isMultiplayerMode).
 */
export function countDistinctUsers(db: Database): number {
  const row = db
    .query("SELECT COUNT(*) AS n FROM users WHERE via_tunnel = 1")
    .get() as { n: number };
  return row?.n ?? 0;
}
