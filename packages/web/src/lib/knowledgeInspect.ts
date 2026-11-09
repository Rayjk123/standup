/**
 * Pure logic behind opening a knowledge doc's detail/inspect view from a Browse
 * surface — a search-result card. The Knowledge tab already renders the full
 * doc (title, body, tags, scope/owner) in the DocEditor detail; these helpers
 * resolve which doc a clicked result opens and carry a cross-project "open"
 * intent through the URL so a single-project panel opens the same detail.
 *
 * Kept here (not inline in the components) so the web package's unit tests can
 * pin the contract without a component harness — the same reason the graph
 * transforms and scope control live in their own modules.
 */

/** The URL search-param key that names the doc to open on the Browse page. */
export const OPEN_DOC_PARAM = "doc";

/** The Knowledge page's sub-tabs, in display order. Graph is the landing view. */
export const KNOWLEDGE_TABS = ["graph", "browse", "health", "review"] as const;
export type KnowledgeTab = (typeof KNOWLEDGE_TABS)[number];

/**
 * The sub-tab a Knowledge URL shows: an explicit ?tab= wins; otherwise a ?doc=
 * deep link opens Browse, where that doc's detail renders, and anything else
 * lands on the Graph.
 */
export function knowledgeTabFor(params: URLSearchParams): KnowledgeTab {
  const tab = params.get("tab");
  if ((KNOWLEDGE_TABS as readonly string[]).includes(tab ?? "")) return tab as KnowledgeTab;
  return params.has(OPEN_DOC_PARAM) ? "browse" : "graph";
}

/**
 * The read-only detail endpoint for one doc, keyed by its OWN project + slug:
 * GET /api/projects/:id/knowledge/:slug. Both the cross-project result inspect
 * view and the graph's node detail fetch through this, so a result homed in ANY
 * project opens by the same by-id read — including a project the scope selector
 * can't list (a since-deleted project, or the reserved 'global'/'scratch'
 * corpus). Both ids are URL-encoded so a slug or project id with reserved
 * characters can't break the path.
 */
export function docDetailUrl(projectId: string, slug: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/knowledge/${encodeURIComponent(slug)}`;
}

/**
 * The doc a clicked search result opens: the one in the loaded list whose slug
 * matches. A search result carries only a slug (not the full doc), so the
 * detail view is opened over the already-loaded doc — same title/body/tags/scope
 * the doc-list card opens. Returns undefined when the list doesn't hold it (a
 * stale result), so the caller can no-op rather than open an empty editor.
 */
export function findDocBySlug<T extends { slug: string }>(
  docs: readonly T[],
  slug: string | null | undefined
): T | undefined {
  if (!slug) return undefined;
  return docs.find((d) => d.slug === slug);
}

/**
 * The search params that open a cross-project result: scope Browse to the
 * result's OWN project and name its slug. A copy is returned (the input is not
 * mutated) so it drops straight into react-router's setSearchParams updater.
 * The project is the result's own — not the current scope — or a same-slug doc
 * in a different project would be opened.
 */
export function withOpenDoc(
  params: URLSearchParams,
  projectId: string,
  slug: string
): URLSearchParams {
  const next = new URLSearchParams(params);
  next.set("project", projectId);
  next.set(OPEN_DOC_PARAM, slug);
  return next;
}

/**
 * The search params with the "open doc" intent cleared — used once the detail
 * has opened so closing it returns to the list instead of reopening, and a
 * refresh doesn't reopen it. Other params (scope, tab) are preserved.
 */
export function withoutOpenDoc(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  next.delete(OPEN_DOC_PARAM);
  return next;
}

/**
 * Whether a projectId names a project the scope selector can actually select —
 * i.e. it's in the loaded projects list. A cross-project ("all" corpus) search
 * returns results whose projectId is NOT necessarily a listed project: a doc
 * left behind by a since-deleted project, a doc homed in the reserved global
 * corpus (project_id 'global'), or a scratch-origin doc (project_id 'scratch').
 * Such a result must NOT re-scope Browse to that id — there is no <option> for
 * it, so the scope select would blank and the target panel would never render;
 * it opens in a standalone read-only detail instead.
 */
export function isSelectableProject(
  projects: readonly { id: string }[],
  projectId: string | null | undefined
): boolean {
  if (!projectId) return false;
  return projects.some((p) => p.id === projectId);
}

/**
 * The value to feed the Scope <select>. A scope pointing at a project not in
 * the list — a stale ?project= from a since-deleted project, the reserved
 * 'global' corpus, or a hand-edited URL — has no matching <option>, which
 * blanks a controlled select and desyncs it from the URL. Fall back to ""
 * ("All projects"), the surface BrowseTab already renders for an unresolvable
 * scope, so the control stays coherent with what is shown.
 */
export function scopeSelectValue(
  projects: readonly { id: string }[],
  scope: string
): string {
  return isSelectableProject(projects, scope) ? scope : "";
}

/**
 * Whether a keydown on a card-as-button should trigger the card's open action.
 * Only Enter on the card ITSELF activates: an Enter that bubbled up from a
 * nested control (e.g. the "related ↔" toggle) must not also open the card,
 * because a click-level stopPropagation on that control does not stop the
 * keydown from reaching the card's handler. Mirrors the DOM guard
 * `e.key === "Enter" && e.target === e.currentTarget`.
 */
export function cardOpensOnEnter(key: string, targetIsCardItself: boolean): boolean {
  return key === "Enter" && targetIsCardItself;
}

/**
 * Stop a bubbling event at a card's nested interactive region — the expanded
 * "related" neighbors panel — so exploring related docs never reaches the
 * card's open handler and opens the parent card's doc. The card opens on a
 * click ANYWHERE on itself (its onClick doesn't inspect the target), so the
 * only way to keep an interaction inside the panel from opening the card is to
 * stop it at the panel boundary. Wired to both the click and keydown paths: a
 * click-level stopPropagation alone would leave a bubbling keydown unstopped.
 */
export function stopCardOpenPropagation(e: { stopPropagation: () => void }): void {
  e.stopPropagation();
}
