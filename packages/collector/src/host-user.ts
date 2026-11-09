/**
 * The alias of the user the collector runs as: `$STANDUP_HOST_USER`, else
 * `$USER`, else "local". The one resolver for the host identity — a loopback
 * request with no trusted tunnel header resolves to it (resolveUserAlias), the
 * boot-time ingest owns the personal-layer docs it writes on the host user's
 * behalf by it, and the knowledge migrations default to it — so docs owned "by
 * the host user" always land in the window the host user's own requests
 * retrieve. Under a service manager that leaves `$USER` unset, setting
 * `STANDUP_HOST_USER` for the collector and the migrations keeps them on the
 * same alias.
 */
export function hostUserAlias(env: NodeJS.ProcessEnv = process.env): string {
  return env.STANDUP_HOST_USER?.trim() || env.USER?.trim() || "local";
}

/** Which setting hostUserAlias resolved from, for a report that names the owner it used. */
export function hostUserSource(env: NodeJS.ProcessEnv = process.env): string {
  if (env.STANDUP_HOST_USER?.trim()) return "$STANDUP_HOST_USER";
  if (env.USER?.trim()) return "$USER";
  return "default";
}
