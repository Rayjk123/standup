import type { Database } from "bun:sqlite";
import { countDistinctUsers, getSetting } from "@standup/store";

/**
 * Global-setting key for the manual multiplayer override, mirrored by
 * GET/PUT /api/settings. Tri-state:
 *   "on"  — force multiplayer on (e.g. before a second teammate has connected)
 *   "off" — force it off, restoring the single-user in-place launch default
 *   ""    — auto-detect (the default): multiplayer once ≥2 aliases have connected
 */
export const MULTIPLAYER_OVERRIDE_SETTING = "multiplayer_override";

/**
 * Whether the collector is serving more than one person, which flips the launch
 * default to a fresh worktree per project so users don't collide on one working
 * tree (see launchSession). Auto-detected from the count of distinct PEOPLE who
 * have connected through the gateway — countDistinctUsers counts only rows whose
 * via_tunnel is set (the identity header was seen), so an agent/MCP
 * phone-home under the host `$USER` can't masquerade as a second person and trip
 * the count. A manual override covers the cases the count can't see: forcing it
 * on before a teammate has connected (or for a purely-local LAN share with no
 * tunnel header), or back off for a solo user whose collector once saw a second
 * tunnel alias (the users table never forgets a past connection).
 */
export function isMultiplayerMode(db: Database): boolean {
  const override = getSetting(db, MULTIPLAYER_OVERRIDE_SETTING);
  if (override === "on") return true;
  if (override === "off") return false;
  return countDistinctUsers(db) >= 2;
}
