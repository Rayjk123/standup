/**
 * Provenance/scope of a knowledge doc, mirrored from @standup/knowledge's
 * `Scope` — the web package depends only on @standup/shared, so the closed set
 * is redeclared here (same pattern the doc panel uses for SourceKind/OriginClass).
 * 'project' (the default) keeps a doc project-local; 'global' promotes it to the
 * whole corpus (a deliberate widening); 'user' scopes it to a single owner ("my
 * knowledge"), kept out of shared retrieval while others can still view it. The owner
 * of a 'user' doc is resolved SERVER-SIDE from the acting identity, never chosen
 * in the client, so this module carries scope only — never an owner field.
 */
export type DocScope = "global" | "project" | "user";

/** Every per-doc scope, in the order the control offers them. */
export const DOC_SCOPES: DocScope[] = ["project", "global", "user"];

/** Human labels for the per-doc scope control. */
export const DOC_SCOPE_LABELS: Record<DocScope, string> = {
  project: "Project — this project only",
  global: "Global — the whole corpus",
  user: "My knowledge — owned by me",
};

/**
 * The two scopes a PROJECT-level default may take. 'user' is deliberately absent
 * — a per-user doc is scoped on the document itself, never as a project default.
 */
export type ProjectScope = "global" | "project";

/** Project-default scopes, in the order the control offers them. */
export const PROJECT_SCOPES: ProjectScope[] = ["project", "global"];

/** Human labels for the project-default scope control. */
export const PROJECT_SCOPE_LABELS: Record<ProjectScope, string> = {
  project: "Project (default) — new docs stay project-local",
  global: "Global — new docs promote to the whole corpus",
};

/**
 * The scope the per-doc control shows for a doc: its own scope when it carries
 * one, else 'project' — the scope an unscoped doc already has by default. Keeps
 * the control's displayed value honest for a legacy/unpromoted doc rather than
 * blanking it.
 */
export function docScopeValue(scope: DocScope | undefined): DocScope {
  return scope ?? "project";
}

/** The stored project default a control shows: the override, else 'project'. */
export function projectScopeValue(scope: ProjectScope | undefined): ProjectScope {
  return scope ?? "project";
}

/**
 * Builds the JSON body the doc create/edit PUT submits. Tags arrive as the raw
 * comma-separated string the editor holds and are split/trimmed here. Owner is
 * deliberately omitted: the server resolves it from the acting identity for a
 * 'user' doc, so the client never sends one (and can't forge another user's).
 *
 * `scope` is included ONLY when the caller passes one — i.e. only when the user
 * actually changed the scope control. A plain body edit passes no scope, so the
 * PUT carries none and the server PRESERVES the doc's existing scope/owner rather
 * than re-deriving them from the editing caller (which would let a teammate's
 * typo fix silently take over or widen a `scope: user` doc). A doc create still
 * sends the chosen scope so a new doc lands with the author's selection.
 */
export function buildDocSavePayload(input: {
  title: string;
  body: string;
  tags: string;
  sourceKind: string;
  scope?: DocScope;
}): {
  title: string;
  body: string;
  tags: string[];
  source_kind: string;
  scope?: DocScope;
} {
  return {
    title: input.title,
    body: input.body,
    tags: input.tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
    source_kind: input.sourceKind,
    // Omit the key entirely when unchanged so the server takes its preserve
    // branch; a present key (even 'project') reads as a deliberate scope choice.
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
  };
}
