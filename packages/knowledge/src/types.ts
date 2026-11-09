import { GLOBAL_PROJECT_ID } from "@standup/shared";

/**
 * The kind of SOURCE a knowledge doc was distilled from — orthogonal to
 * `origin_class`, which encodes TRUST (who authored it), not source TYPE.
 * 'code' is a fact about how the code works, 'product'/'spec' carry product
 * intent and design, 'decision'/'runbook' the operational rationale around the
 * code. 'native-memory' tags a doc mirrored from Claude Code's own memory
 * surfaces (a CLAUDE.md, a `.claude/rules` file, an auto-memory note) rather
 * than curated into this KB — the discriminator that keeps auto-mirrored native
 * memory distinguishable from a hand-authored corpus doc even when both are
 * owner-trusted. 'unclassified' is a doc that asserts no kind: it is searchable
 * and citable, but never injected as code knowledge, because an unlabeled doc
 * (a plan, a brainstorm, a status note) is not evidence of how the code works.
 * 'playbook' is a method Persona distilled from a finished job for its owner:
 * it reaches a worker only through Persona's filtered brief block, never
 * through an agent's search or launch injection (PLAYBOOK_SOURCE_KIND).
 */
export type SourceKind =
  | "code"
  | "product"
  | "spec"
  | "decision"
  | "runbook"
  | "native-memory"
  | "playbook"
  | "unclassified";

/** Every SourceKind, in schema order — the closed set a UI or validator enumerates. */
export const SOURCE_KINDS = [
  "code",
  "product",
  "spec",
  "decision",
  "runbook",
  "native-memory",
  "playbook",
  "unclassified",
] as const;

/** The source kind of a Persona playbook, which no agent audience retrieves. */
export const PLAYBOOK_SOURCE_KIND = "playbook" as const;

/** A doc that asserts no source kind is unclassified, never presumed code. */
export const DEFAULT_SOURCE_KIND = "unclassified" as const;

/**
 * The knowledge LAYER a doc belongs to — how it goes stale and which surfaces
 * may deliver it, derived from (scope, source_kind, native-memory slug stem)
 * rather than stored:
 *  - `personal`: the owner's own profile — any scope='user' doc, and the
 *    mirrors of the home `~/.claude` CLAUDE.md / rules. Delivered to its owner
 *    (Persona, Claude Code's native CLAUDE.md load), never through shared
 *    retrieval.
 *  - `intent`: product intent and specs (`product`, `spec`).
 *  - `docs`: team knowledge — decisions, runbooks, code-fact prose,
 *    unclassified docs, repo CLAUDE.md / rules mirrors, typed auto-memory
 *    project/reference notes.
 *  - `activity`: ephemeral auto-memory session notes and diaries.
 *  - `code`: the live code itself; no stored prose doc is ever in this layer.
 */
export type Layer = "personal" | "intent" | "docs" | "activity" | "code";

/** Every Layer — the closed set a validator enumerates. */
export const LAYERS = ["personal", "intent", "docs", "activity", "code"] as const;

/** Slug stem of a mirror of the home `~/.claude` CLAUDE.md / rules (personal layer). */
export const NATIVE_MEMORY_HOME_SLUG_PREFIX = "native-mem-home-";
/** Slug stem of an untyped or dated auto-memory note (activity layer). */
export const NATIVE_MEMORY_ACTIVITY_SLUG_PREFIX = "native-mem-memory-";

/**
 * The layer a doc belongs to (see Layer). Scope decides first — a scope='user'
 * doc is personal whatever its kind — then a native-memory mirror is placed by
 * its slug stem, then the source kind. An absent kind reads as unclassified.
 */
export function layerOf(doc: { scope?: string; sourceKind?: string; slug?: string }): Layer {
  if (doc.scope === "user") return "personal";
  const kind = doc.sourceKind ?? DEFAULT_SOURCE_KIND;
  const slug = doc.slug ?? "";
  if (kind === "native-memory") {
    if (slug.startsWith(NATIVE_MEMORY_HOME_SLUG_PREFIX)) return "personal";
    if (slug.startsWith(NATIVE_MEMORY_ACTIVITY_SLUG_PREFIX)) return "activity";
    return "docs";
  }
  if (kind === "product" || kind === "spec") return "intent";
  return "docs";
}

/**
 * The SQL twin of layerOf: a predicate over a `knowledge` row aliased `alias`
 * that is true when the row is in `layer`. Reads only `scope`, `source_kind` and
 * `slug`, so it can ride any candidate WHERE that joins `knowledge`. The `code`
 * layer holds no stored doc, so its predicate is always false.
 */
export function layerSql(layer: Layer, alias: string): string {
  const nativeMemory = `${alias}.source_kind = 'native-memory'`;
  // GLOB, not LIKE: GLOB is case-sensitive, matching layerOf's startsWith.
  const homeMirror = `${alias}.slug GLOB '${NATIVE_MEMORY_HOME_SLUG_PREFIX}*'`;
  const activityNote = `${alias}.slug GLOB '${NATIVE_MEMORY_ACTIVITY_SLUG_PREFIX}*'`;
  const notUser = `${alias}.scope != 'user'`;
  switch (layer) {
    case "personal":
      return `(${alias}.scope = 'user' OR (${nativeMemory} AND ${homeMirror}))`;
    case "activity":
      return `(${notUser} AND ${nativeMemory} AND ${activityNote})`;
    case "intent":
      return `(${notUser} AND ${alias}.source_kind IN ('product', 'spec'))`;
    case "docs":
      return (
        `(${notUser} AND ${alias}.source_kind NOT IN ('product', 'spec') AND NOT ` +
        `(${nativeMemory} AND (${homeMirror} OR ${activityNote})))`
      );
    case "code":
      return "0";
  }
}

/**
 * The scope of a knowledge doc — WHO its owning agents retrieve it for.
 * Orthogonal to both `origin_class` (trust: who authored it) and `source_kind`
 * (source type): scope is audience, not provenance. 'project' is the default
 * and the exact behavior every doc predating this dimension already had — a doc
 * belongs to its project. 'global' is a doc promoted to the whole corpus — a
 * deliberate widening, never a default. 'user' is a doc owned by a single user (see
 * `owner_user`), retrieved for that user's own agents while still visible to
 * others. Retrieval scoping (global ∪ project ∪ user) consumes this in a later
 * pass; here the dimension is the additive, reversible data-model foundation.
 */
export type Scope = "global" | "project" | "user";

/** Every Scope, in schema order — the closed set a UI or validator enumerates. */
export const SCOPES = ["global", "project", "user"] as const;

/**
 * Fail-safe default: a doc that asserts no scope belongs to its project. A
 * backfilled or unasserted row reads 'project', so nothing changes for it.
 */
export const DEFAULT_SCOPE = "project" as const;

/**
 * Resolves the scope and owning user a newly authored doc should carry.
 * Authoring defaults to 'project' unless the author explicitly promotes to
 * 'global' or scopes to 'user'. A 'user'-scoped doc is owned by the authoring
 * identity (the acting alias / host user, the same key user preferences key
 * off), recorded in `owner_user`; a 'global' or 'project' doc has no single
 * owner, so `ownerUser` is left undefined. A 'user' scope with no resolvable
 * owner (a blank or absent alias) falls back to the visible 'project' scope
 * rather than an owner-less user doc: a 'user'-scoped doc with a NULL owner
 * lands in no retrieval window — not global, not project, not any owner's — so
 * it would be invisible to everyone including its author. `owner_user` is the
 * only new owner field — authorship provenance otherwise stays on the existing
 * `source_session_id` / `origin_class`, never a parallel author column.
 */
export function resolveAuthoredScope(
  requestedScope: Scope | undefined,
  actorAlias: string | undefined
): { scope: Scope; ownerUser?: string } {
  const requested = requestedScope ?? DEFAULT_SCOPE;
  const ownerUser = requested === "user" ? actorAlias?.trim() || undefined : undefined;
  // An owner-less user doc is in no retrieval window, so demote it to a visible
  // scope rather than persisting a black hole only its author's absence created.
  const scope =
    requested === "user" && ownerUser === undefined ? DEFAULT_SCOPE : requested;
  return { scope, ownerUser };
}

/**
 * The audience a STRICT scope-gated retrieval resolves candidates against — the
 * injection gate an agent sees. A doc is in-audience IFF it is scope='global',
 * OR homed in the reserved GLOBAL corpus (project_id = GLOBAL_PROJECT_ID)
 * regardless of its scope column, OR scope='project' homed in `projectId`, OR
 * scope='user' owned by `user`. This is the SOFT team routing boundary that
 * decides what an agent for (project, user) retrieves/injects — distinct from the
 * permissive browse/list path, which sees every scope and every owner.
 *
 * `user` is the requesting user's resolved identity (server-side, from the
 * tunnel-authenticated header), or undefined when it could not be resolved (a
 * missing/untrusted alias, an anonymous source). An undefined `user` drops the
 * user disjunct, so retrieval falls back SAFELY to global ∪ project and never
 * routes another user's user-scoped docs to an unidentified caller.
 */
export interface ScopeAudience {
  projectId: string;
  user?: string;
  /**
   * Projects that share this audience's product (siblings of one split
   * product, e.g. a data plane and its control plane). Their project-scoped
   * docs are in-audience like `projectId`'s own, and excludeForeignIntent does
   * not treat their intent layer as foreign. Their user-scoped docs still reach
   * only their owner. The audience's own project and the reserved global
   * corpus are ignored here (see relatedProjectIdsOf).
   */
  relatedProjectIds?: readonly string[];
  /**
   * Layers this audience never receives (see Layer / layerSql), ANDed onto the
   * gate on every arm. Shared surfaces exclude `personal`; launch injection
   * also excludes `activity`.
   */
  excludeLayers?: readonly Layer[];
  /**
   * Also exclude another project's intent layer (product/spec): an intent doc
   * homed neither in `projectId` nor in the reserved global corpus describes
   * that project's product, so it never steers this audience even when
   * scope='global'. Docs homed in the global corpus are everyone's.
   */
  excludeForeignIntent?: boolean;
  /**
   * The alias the collector runs as. A home CLAUDE.md / rules mirror still
   * carrying a pre-personal-layer stamp (scope other than 'user', usually no
   * owner) is the host user's, so it reaches this audience only when `user` is
   * the host user. Unset, such a mirror reaches nobody.
   */
  hostUser?: string;
  /**
   * A browse audience — the human Knowledge tab, unscoped search, the graph:
   * every doc of every project and scope except the personal layer, which is
   * private by layer. A personal doc passes only through the owner disjuncts,
   * exactly as on the strict gate (its `user`, or the host user for an unowned
   * legacy home mirror in the global corpus). `projectId` does not narrow it.
   */
  browse?: boolean;
}

/** A home CLAUDE.md / rules mirror whose row does not read scope='user' (a pre-personal-layer stamp). */
function legacyHomeMirrorSql(alias: string): string {
  return (
    `(${alias}.source_kind = 'native-memory' AND ${alias}.slug GLOB '${NATIVE_MEMORY_HOME_SLUG_PREFIX}*' ` +
    `AND ${alias}.scope != 'user')`
  );
}

function isLegacyHomeMirror(doc: { scope?: string; sourceKind?: string; slug?: string }): boolean {
  return (
    doc.sourceKind === "native-memory" &&
    (doc.slug ?? "").startsWith(NATIVE_MEMORY_HOME_SLUG_PREFIX) &&
    (doc.scope ?? DEFAULT_SCOPE) !== "user"
  );
}

/**
 * The audience's related projects, deduplicated, with blanks, the audience's own
 * project and the reserved global corpus removed.
 */
export function relatedProjectIdsOf(audience: ScopeAudience | undefined): string[] {
  if (!audience?.relatedProjectIds) return [];
  const ids = new Set<string>();
  for (const raw of audience.relatedProjectIds) {
    const id = raw.trim();
    if (id && id !== audience.projectId && id !== GLOBAL_PROJECT_ID) ids.add(id);
  }
  return [...ids];
}

/**
 * Whether a doc homed in `projectId` is homed outside the audience's project,
 * its related projects and the reserved global corpus.
 */
function isForeignHome(projectId: string, audience: ScopeAudience): boolean {
  return (
    projectId !== audience.projectId &&
    projectId !== GLOBAL_PROJECT_ID &&
    !relatedProjectIdsOf(audience).includes(projectId)
  );
}

/**
 * Whether one resolved doc falls inside `audience` — the in-memory twin of
 * scopeAudienceSql (same disjuncts, same personal-layer rule, same layer
 * exclusion), for a doc already fetched by id or slug.
 */
export function docInAudience(
  doc: { projectId: string; scope?: string; ownerUser?: string; sourceKind?: string; slug?: string },
  audience: ScopeAudience
): boolean {
  const scope = doc.scope ?? DEFAULT_SCOPE;
  const layer = layerOf({ ...doc, scope });
  if (audience.excludeLayers?.includes(layer)) return false;
  if (audience.excludeForeignIntent && layer === "intent" && isForeignHome(doc.projectId, audience)) return false;
  if (!audience.browse && doc.sourceKind === PLAYBOOK_SOURCE_KIND) return false;
  const user = audience.user?.trim();
  if (isLegacyHomeMirror({ ...doc, scope })) {
    if (!user || doc.projectId !== GLOBAL_PROJECT_ID) return false;
    return doc.ownerUser ? doc.ownerUser === user : user === audience.hostUser?.trim();
  }
  if (audience.browse && layer !== "personal") return true;
  if (scope === "global") return true;
  if (doc.projectId === GLOBAL_PROJECT_ID && scope !== "user") return true;
  if (scope === "project" && doc.projectId === audience.projectId) return true;
  if (scope === "project" && relatedProjectIdsOf(audience).includes(doc.projectId)) return true;
  return Boolean(user && scope === "user" && doc.ownerUser === user);
}

/**
 * The SQL predicate + bound params for a ScopeAudience over a `knowledge` row
 * aliased `alias`, reading its `scope` / `project_id` / `owner_user` columns.
 * Pushed into the CANDIDATE query's WHERE — the FTS arm, the brute-force
 * embedding scan, and the vec KNN hydration — so an out-of-scope doc is filtered
 * BEFORE ranking rather than after, and an in-scope doc can't be starved below
 * the recall top-K by out-of-scope candidates. Mirrors the `source_kind` /
 * project filter convention the store and search already push into SQL. When
 * `user` is absent the user disjunct is omitted (the safe global ∪ project
 * fallback).
 *
 * The `project_id = GLOBAL_PROJECT_ID AND scope != 'user'` disjunct is
 * defense-in-depth for the reserved GLOBAL corpus: a NON-user doc physically
 * homed there exists to reach every session (that is the whole point of the
 * reserved project), so it stays in-audience even for a row whose `scope` column
 * reads 'project' — the value a legacy backfill or a write that bypassed the
 * loader's global inference could leave. Without it such a row falls out of
 * every asking project's gate (its project_id is 'global', not the asking
 * project, and its scope isn't 'global'), silently dropping the global KB from
 * launch injection and scoped search. The loader's scope='global' inference is
 * the primary guarantee; this disjunct makes the gate hold regardless of how the
 * row was written.
 *
 * The `scope != 'user'` guard is load-bearing, not cosmetic: the reserved-home
 * shortcut must NOT swallow a doc explicitly marked scope='user'. The loader
 * deliberately honors an explicit `scope: user` on a file homed under
 * knowledge/global/ (a user-scoped doc placed there stays that way), so a row
 * with (scope='user', owner_user='alice', project_id='global') is reachable
 * state. Without the guard that row would satisfy the bare `project_id='global'`
 * disjunct for EVERY audience — leaking Alice's private doc to every user and
 * project through the exact isolation boundary this gate exists to enforce. With
 * the guard it matches only via the owner disjunct below, so it reaches Alice
 * alone. `scope` is NOT NULL DEFAULT 'project' in the schema, so this comparison
 * never sees NULL and the legacy scope='project'-in-global case still passes.
 *
 * Personal-layer rows pass only through an owner disjunct. A home CLAUDE.md /
 * rules mirror whose row still reads scope='global' or 'project' (stamped
 * before the personal layer existed) is excluded from the shared disjuncts and
 * admitted only to its owner: the named `owner_user`, or — for an unowned
 * mirror homed in the reserved global corpus — the host user
 * (ScopeAudience.hostUser). Stale copies homed in other projects reach nobody.
 *
 * A related project (ScopeAudience.relatedProjectIds) adds one shared
 * disjunct: its scope='project' docs pass as the audience project's own do. Its
 * user-scoped docs gain nothing — they still pass only the owner disjunct.
 *
 * A browse audience (ScopeAudience.browse) replaces the shared disjuncts with
 * "not personal-layer": every other doc passes whatever its scope or project,
 * and the personal layer keeps the same owner disjuncts.
 */
export function scopeAudienceSql(
  audience: ScopeAudience,
  alias: string
): { sql: string; params: string[] } {
  const legacyHomeMirror = legacyHomeMirrorSql(alias);
  const related = relatedProjectIdsOf(audience);
  const shared = [
    `${alias}.scope = 'global'`,
    `(${alias}.project_id = ? AND ${alias}.scope != 'user')`,
    `(${alias}.scope = 'project' AND ${alias}.project_id = ?)`,
  ];
  if (related.length > 0) {
    shared.push(`(${alias}.scope = 'project' AND ${alias}.project_id IN (${related.map(() => "?").join(", ")}))`);
  }
  const disjuncts = audience.browse
    ? [`NOT ${layerSql("personal", alias)}`]
    : [`((${shared.join(" OR ")}) AND NOT ${legacyHomeMirror})`];
  const params = audience.browse ? [] : [GLOBAL_PROJECT_ID, audience.projectId, ...related];
  const user = audience.user?.trim();
  if (user) {
    disjuncts.push(`(${alias}.scope = 'user' AND ${alias}.owner_user = ?)`);
    params.push(user);
    const ownsLegacy = user === audience.hostUser?.trim()
      ? `(${alias}.owner_user = ? OR ${alias}.owner_user IS NULL)`
      : `${alias}.owner_user = ?`;
    disjuncts.push(`(${legacyHomeMirror} AND ${alias}.project_id = ? AND ${ownsLegacy})`);
    params.push(GLOBAL_PROJECT_ID, user);
  }
  const excluded = (audience.excludeLayers ?? []).map((layer) => `NOT ${layerSql(layer, alias)}`);
  // A playbook reaches a worker only through Persona's filtered brief block,
  // so no agent search or launch injection retrieves one.
  if (!audience.browse) excluded.push(`${alias}.source_kind != '${PLAYBOOK_SOURCE_KIND}'`);
  if (audience.excludeForeignIntent) {
    const homes = [audience.projectId, GLOBAL_PROJECT_ID, ...related];
    excluded.push(
      `NOT (${layerSql("intent", alias)} AND ${alias}.project_id NOT IN (${homes.map(() => "?").join(", ")}))`
    );
    params.push(...homes);
  }
  const gate = `(${disjuncts.join(" OR ")})`;
  return { sql: excluded.length > 0 ? `(${gate} AND ${excluded.join(" AND ")})` : gate, params };
}

/**
 * The SQL predicate + bound params for the PERMISSIVE owner filter over a
 * `knowledge` row aliased `alias` — restricts candidates to docs whose
 * `owner_user` is one of `owners` ("my knowledge"). This is the browse/list
 * knob (deliberately NOT the injection gate): a browsing human may see any
 * user's user-scoped docs and any project's docs, so it is applied
 * independently of `scopeAudienceSql`. Returns null when `owners` is
 * empty/blank (no filter). Blank entries are dropped so a stray "" can't widen
 * the filter to match every NULL owner.
 */
export function ownerFilterSql(
  owners: readonly string[],
  alias: string
): { sql: string; params: string[] } | null {
  const clean = owners.map((o) => o.trim()).filter(Boolean);
  if (clean.length === 0) return null;
  return {
    sql: `${alias}.owner_user IN (${clean.map(() => "?").join(", ")})`,
    params: clean,
  };
}

/**
 * A set of EQUALITY constraints over the vec0 mirror's partition-key columns
 * (`project_id`, `scope`, `owner_user`). An undefined field is an unconstrained
 * partition key — the KNN searches across every value of it. The unit the
 * vec0-backed gated search runs one KNN per: because a vec0 partition key admits
 * only equality (never `!=`, `IN`, or a cross-column OR), a disjunctive gate is
 * expressed as the UNION over a list of these specs, each an all-equality
 * conjunction, exactly as SQL would OR the disjuncts.
 */
export interface VecPartitionSpec {
  projectId?: string;
  scope?: Scope;
  ownerUser?: string;
}

/**
 * The vec0 partition-key analog of `scopeAudienceSql`: the SAME strict audience
 * gate expressed as a UNION of equality specs so a scope-gated KNN pre-filters
 * DURING the scan (in-partition) rather than post-filtering a fixed top-K (which
 * could starve an in-scope doc). Each spec is one disjunct of the SQL gate:
 *   - `scope='global'` — every global-scoped doc, any project, any owner. This
 *     also subsumes the `scope='global'` half of the reserved-GLOBAL-home
 *     disjunct, so only its `scope='project'` half needs its own spec below.
 *   - `scope='project', project_id=GLOBAL` — the reserved GLOBAL corpus's
 *     project-scoped docs (the defense-in-depth home disjunct, minus scope='user'
 *     which the guard excludes — a user-scoped doc homed there reaches only its
 *     owner, via the owner spec).
 *   - `scope='project', project_id=<audience>` — this project's own docs.
 *   - `scope='project', project_id=<related>` — one per related project.
 *   - `scope='user', owner_user=<user>` — the resolved user's own docs (omitted
 *     when the identity is unresolved, the safe global ∪ project fallback).
 * The union of these specs enumerates the doc set scopeAudienceSql admits (a layer exclusion the specs
 * cannot express is enforced at hydration), so a KNN over them and the
 * brute-force scan see the same candidates.
 */
export function scopeAudiencePartitionSpecs(
  audience: ScopeAudience
): VecPartitionSpec[] {
  // A browse audience spans every project's global and project docs; the
  // hydration WHERE drops the legacy home mirrors among them.
  const specs: VecPartitionSpec[] = audience.browse
    ? [{ scope: "global" }, { scope: "project" }]
    : [
        { scope: "global" },
        { scope: "project", projectId: GLOBAL_PROJECT_ID },
        { scope: "project", projectId: audience.projectId },
        ...relatedProjectIdsOf(audience).map((projectId) => ({ scope: "project" as const, projectId })),
      ];
  const user = audience.user?.trim();
  // Every scope='user' doc is personal-layer, so excluding that layer drops the
  // owner partition outright. The home-mirror half of the personal layer is
  // keyed on the slug, which the vec mirror does not carry; the hydration
  // WHERE (scopeAudienceSql) drops those rows.
  if (user && !audience.excludeLayers?.includes("personal")) {
    specs.push({ scope: "user", ownerUser: user });
  }
  return specs;
}

/**
 * The full partition-spec list a vec0-backed candidate query runs, composing the
 * three filters the brute-force scan ANDs in SQL — the optional project pin
 * (`project_id=?`), the strict scope gate (`scopeAudienceSql`), and the
 * permissive owner filter (`ownerFilterSql`) — into equality specs:
 *   - Base specs come from the audience gate (`scopeAudiencePartitionSpecs`), or
 *     a single unconstrained spec when there is no audience (the ungated path).
 *   - A `projectId` pin is ANDed onto every spec; a spec that already fixes a
 *     DIFFERENT project is dropped (its conjunction is empty — e.g. the
 *     GLOBAL-home spec under a non-global project pin).
 *   - A non-empty `owners` filter fans each spec out to one spec per owner
 *     (owner_user is a single-value partition key, so the SQL `IN` becomes a
 *     union); a spec that already fixes a different owner is dropped.
 * The union of the returned specs matches the brute-force WHERE exactly, so the
 * KNN candidate pool equals the scan's candidate pool.
 */
export function partitionSpecsForGate(
  projectId: string | undefined,
  audience: ScopeAudience | undefined,
  owners: readonly string[] | undefined
): VecPartitionSpec[] {
  let specs: VecPartitionSpec[] = audience
    ? scopeAudiencePartitionSpecs(audience)
    : [{}];
  if (projectId !== undefined) {
    specs = specs
      .filter((s) => s.projectId === undefined || s.projectId === projectId)
      .map((s) => ({ ...s, projectId }));
  }
  const cleanOwners = owners?.map((o) => o.trim()).filter(Boolean) ?? [];
  if (cleanOwners.length > 0) {
    specs = specs.flatMap((s) =>
      cleanOwners
        .filter((o) => s.ownerUser === undefined || s.ownerUser === o)
        .map((o) => ({ ...s, ownerUser: o }))
    );
  }
  return specs;
}

/**
 * Trust class of a knowledge doc/chunk, mirrored from OpenClaw's
 * `memory_index_chunk_provenance.origin_class`. It gates whether content may
 * be auto-injected. Fail-closed: anything of unknown provenance is
 * `untrusted`, never silently promoted — see KnowledgeStore's default.
 */
export type OriginClass = "owner" | "agent" | "untrusted" | "system";

/**
 * Whether a doc of this origin may be fed into an agent's context
 * automatically. Mirrors OpenClaw's `isMemoryOriginEligibleForAutomaticInjection`
 * (memory-host-sdk/src/host/types.ts): only owner- and agent-authored content
 * is eligible. Anything `untrusted` or `system` — including the fail-closed
 * default a doc of unknown provenance carries — is still recalled by search
 * (a human inspecting knowledge sees it) but is never silently injected. This
 * is the poisoning defense the `origin_class` column exists to enable.
 */
export function isOriginEligibleForInjection(
  originClass: OriginClass | undefined
): boolean {
  return originClass === "owner" || originClass === "agent";
}

/**
 * Whether a doc's re-verification verdict permits auto-injection. This is the
 * COHERENCE half of the injection gate, alongside origin (trust) and confidence
 * (freshness) — all three must pass.
 *
 * A doc the verification layer has marked "disputed" (refuted against current
 * code), "contradicted" (found to state a claim opposing another accepted doc,
 * roadmap r7), or "superseded" (the losing side of a resolved contradiction,
 * tombstoned in favor of a newer/stronger claim) is held out of confident
 * retrieval until a human resolves/revives it: it is still recalled by search
 * for a human to inspect, but never fed to an agent as authoritative context. A
 * "disputed"/"superseded" doc is also gated by its written-down low confidence,
 * but "contradicted" carries no such confidence penalty (the flag is DB-only
 * verdict state), so without this gate a full-confidence doc flagged as
 * contradicting another would keep being injected on both sides of the conflict
 * — the corpus-poisoning this check exists to stop.
 *
 * Any other verdict — NULL/undefined (never re-verified), "clean" (affirmed),
 * or the transient "unverified"/"error" — is eligible, so resolving a conflict
 * (a human edit/accept clears the verdict, or a clean re-verification overwrites
 * it) re-admits the doc with no extra step.
 */
export function isVerdictEligibleForInjection(
  verdict: DraftVerdict | undefined
): boolean {
  return (
    verdict !== "disputed" &&
    verdict !== "contradicted" &&
    verdict !== "superseded"
  );
}

export interface KnowledgeDoc {
  id: string;
  projectId: string;
  slug: string;
  title: string;
  body: string;
  tags?: string[];
  embedding?: number[];
  updatedAt: Date;
  filePath: string;
  // Provenance, carried in frontmatter when a draft is accepted (see
  // acceptDraftFile). NULL for a human-authored doc — Step 6's staleness
  // check keys "is this generated" off exactly that distinction, so this
  // must stay undefined rather than "" when absent.
  generatedFromSha?: string;
  generatedAt?: string;
  // When the index first saw this exact body (the content clock decay runs
  // from for a doc that asserts no verification date). Index-only: set by the
  // store, never read from or written to the file.
  contentFirstSeen?: string;
  // Explicit graph edges authored in the doc's YAML frontmatter
  // (`related:`/`edges:`), each a `slug` or `projectId/slug` target. The
  // graph compile pass turns these into `knowledge_edges` rows; markdown
  // stays authoritative, edges are a rebuildable projection of it.
  related?: string[];
  // Provenance columns (see OriginClass). undefined here means the writer
  // did not assert a class, so the store falls back to fail-closed
  // `untrusted` rather than trusting by omission.
  originClass?: OriginClass;
  // The session that authored this doc (a proposing bootstrap run). Powers
  // session→doc provenance and the doc→doc "provenance" edges the graph
  // derives between docs a single session produced.
  sourceSessionId?: string;
  // Source-kind dimension (roadmap r2), orthogonal to originClass's trust.
  // Reads 'unclassified' when the file asserts none.
  sourceKind?: SourceKind;
  // Scope + owning user (see Scope). `scope` reads 'project' when the row/file
  // asserts none — a doc belongs to its project unless promoted to 'global' or
  // scoped to a single 'user'. `ownerUser` names the owning user of a
  // 'user'-scoped doc (undefined otherwise), keyed to the acting alias. Both
  // are additive and backward-compatible: retrieval scoping consumes them in a
  // later pass, and the store/loader/writer round-trip them here.
  scope?: Scope;
  ownerUser?: string;
  // Confidence bookkeeping (roadmap r2). `confidence` is the base value as of
  // `lastVerifiedAt`; `halfLifeDays` sets the decay rate. The CURRENT
  // confidence is always derived from these three (see confidence.ts), never
  // stored, so it stays honest without a write as time passes. All undefined
  // for a legacy doc that never asserted an opinion.
  confidence?: number;
  lastVerifiedAt?: string;
  halfLifeDays?: number;
  // Re-verification result (roadmap r5), written by the re-verification cron
  // via setDocVerdict — NOT by the file/upsert path. upsertDoc deliberately
  // omits these columns so a resync of an unchanged file preserves the verdict
  // rather than resetting it, exactly as upsertDraft preserves a draft's
  // verdict. Undefined for a doc that has never been re-verified.
  verdict?: DraftVerdict;
  disputes?: DraftDispute[];
  // Validity interval (see temporal.ts). Read raw off the file's `valid_from` /
  // `valid_to` / `superseded_by`; the store resolves an absent valid_from to
  // generated_at or the first index time, and sets valid_to + superseded_by
  // when the doc is superseded. valid_to undefined = the doc is current.
  validFrom?: string;
  validTo?: string;
  supersededBy?: string;
}

/**
 * A closed version of an accepted doc, kept under `<project>/.history/` when an
 * accept replaced its body (see archiveDocVersion). Indexed apart from the
 * corpus (knowledge_history), so only an `asOf` search ever returns one.
 */
export interface KnowledgeHistoryVersion {
  id: string;
  projectId: string;
  slug: string;
  title: string;
  body: string;
  tags?: string[];
  filePath: string;
  updatedAt: Date;
  validFrom?: string;
  validTo: string;
  supersededBy?: string;
  originClass: OriginClass;
  sourceKind: SourceKind;
  scope: Scope;
  ownerUser?: string;
  generatedFromSha?: string;
}

/**
 * A doc→doc edge in the cross-project knowledge graph. Deliberately NOT
 * scoped to a projectId — the whole point is that edges span projects. `kind`
 * distinguishes an author's explicit `related` link (a frontmatter target or a
 * body `[[slug]]` wikilink) from a compiler-derived co-citation (shared tags) or
 * provenance (same authoring session) backlink, or a coherence-derived `contradicts` link
 * between two docs the coherence pass found to oppose each other.
 */
export interface KnowledgeEdge {
  id: string;
  srcDocId: string;
  dstDocId: string;
  kind: "related" | "co-citation" | "provenance" | "contradicts" | "semantic-similarity";
  weight?: number;
  confidence?: number;
  evidence?: string;
}

/**
 * A resolved neighbor of a doc: the far end of an edge plus the doc it points
 * at. Carries the neighbor doc's trust (`originClass`) and coherence
 * (`verdict`) alongside the edge, so a pivot from a trusted hit into its
 * neighbors can tell an untrusted or contradicted neighbor apart rather than
 * being handed one with no signal — the same poisoning defense SearchResult
 * exposes. `originClass` fails closed to `untrusted`; `verdict`/`sourceKind`
 * are undefined for a doc that never asserted one.
 */
export interface KnowledgeNeighbor {
  docId: string;
  projectId: string;
  slug: string;
  title: string;
  kind: KnowledgeEdge["kind"];
  weight: number;
  // The edge's own signal, carried so a pivot reads WHY the two docs are linked
  // — the named shared tags of a co-citation, the dispute finding of a
  // contradiction — not merely the colored kind. Undefined for an edge that
  // recorded none. `confidence` rides along where the edge asserted one (a
  // frontmatter `related` link does).
  evidence?: string;
  confidence?: number;
  originClass: OriginClass;
  verdict?: DraftVerdict;
  sourceKind?: SourceKind;
}

export interface KnowledgeChunk {
  id: string;
  knowledgeId: string;
  chunkIndex: number;
  text: string;
  embedding: number[];
  /** The chunker version that produced `text`; upsertChunk defaults it to CHUNKER_VERSION. */
  chunkerVersion?: number | null;
}

export interface KnowledgeFrontmatter {
  title?: string;
  tags?: string[];
  generated_from_sha?: string;
  generated_at?: string;
  // Explicit graph edges — `edges:` is accepted as an alias for `related:`.
  related?: string[];
  edges?: string[];
  // Provenance, read straight off the file so a hand-authored doc can assert
  // its own trust class; absent stays fail-closed (see OriginClass).
  origin_class?: OriginClass;
  source_session_id?: string;
  // Source kind + confidence bookkeeping (roadmap r2), read straight off the
  // file so a hand-authored doc can assert its own; absent source_kind reads
  // as 'unclassified' (see loader), absent confidence fields stay opinion-less.
  source_kind?: SourceKind;
  // Scope + owning user (per-user knowledge), read straight off the file so a
  // doc can assert its own. Absent `scope` reads as 'project' (see loader);
  // `owner_user` names the owning user of a 'user'-scoped doc.
  scope?: Scope;
  owner_user?: string;
  confidence?: number;
  last_verified_at?: string;
  half_life_days?: number;
  // Absolute path of the repo design doc this corpus file was auto-mirrored
  // from (see the collector's project-docs ingest). Its presence marks the file
  // as ingest-owned — safe to refresh or remove when the source changes — and
  // distinguishes it from a human-curated doc, which never carries it. Ignored
  // by the loader's doc mapping; it is a provenance/ownership marker only.
  ingested_from?: string;
  // Absolute path of the Claude Code native-memory file this corpus doc was
  // mirrored from (see the collector's native-memory ingest) — a CLAUDE.md, a
  // `.claude/rules` file, or an auto-memory note. The native-memory sibling of
  // `ingested_from`: a distinct key so the two ingests never reclaim each
  // other's files. Its presence is the same ingest-owned interlock — only a
  // file carrying it is ever refreshed or removed — and it is likewise ignored
  // by the loader's doc mapping, a provenance/ownership marker only.
  native_memory_from?: string;
  // Validity interval (see temporal.ts): when the doc's claim became current,
  // when it stopped being current (absent = still current), and the
  // `project/slug` of the doc that replaced it.
  valid_from?: string;
  valid_to?: string;
  superseded_by?: string;
}

/**
 * Result of an adversarial fact-check pass (see collector's draft-verify.ts,
 * which is the only writer of this state). Mirrored here rather than
 * imported from the collector — this package has no dependency on it, and
 * the shape is a plain data contract, not behavior worth sharing.
 *
 * "contradicted" is the coherence pass's verdict (roadmap r7, collector's
 * knowledge-coherence.ts): an accepted doc found to state a claim opposing
 * another accepted doc, flagged for human resolution. "superseded" is the
 * contradiction resolver's tombstone (collector's knowledge-resolve.ts): the
 * losing side of a resolved contradiction, kept for history and search but held
 * out of injection until a human revives it. Both share this channel with the
 * fact-check verdicts because they render identically in review — a doc held out
 * of confident retrieval until a human intervenes.
 *
 * "unverifiable" (UnverifiableVerdict) records that no repository of the doc's
 * project, or of the projects a global/scratch doc is about, could be resolved
 * to fact-check it against; a `repo`-origin dispute carries the reason. It
 * says nothing against the doc: it is injected and searched, and trusted, like
 * "unverified".
 */
export type DraftVerdict =
  | "unverified"
  | "unverifiable"
  | "clean"
  | "disputed"
  | "error"
  | "contradicted"
  | "superseded";

/** The verdict of a doc no repository could be resolved to fact-check. */
export type UnverifiableVerdict = "unverifiable";
export const UNVERIFIABLE_VERDICT: UnverifiableVerdict = "unverifiable";

/**
 * Whether a verdict says the doc's claims have not been checked: never checked
 * yet ("unverified") or with nothing to check them against ("unverifiable").
 * Both are trusted alike — neither holds a doc out of injection or search.
 */
export function isUncheckedVerdict(verdict: string | undefined | null): boolean {
  return verdict === "unverified" || verdict === UNVERIFIABLE_VERDICT;
}

export interface DraftDispute {
  /** The claim as the draft states it, quoted closely enough to find. */
  claim: string;
  /** What checking actually showed. */
  finding: string;
  /** The command run, so a human can re-check rather than trust this. */
  evidence: string;
  /** `git` for a repository-state finding from a git command rather than the
   *  model fact-check; `repo` for a note that no checkout of the doc's project
   *  was available to check it against. Either is shown to a human, never
   *  weighed against the doc. */
  origin?: "git" | "repo";
}

/**
 * A draft: a proposed doc awaiting human review. Deliberately has no
 * `embedding` field and no chunk relation — see store.ts's ensureTables for
 * why that absence is load-bearing rather than an oversight.
 */
export interface KnowledgeDraft {
  id: string;
  projectId: string;
  slug: string;
  title: string;
  body: string;
  tags?: string[];
  filePath: string;
  updatedAt: Date;
  generatedFromSha?: string;
  generatedAt?: string;
  generatedByLaunchId?: string;
  // Set when this draft would overwrite an existing accepted doc on accept —
  // NULL on a first bootstrap. See phase-7.md Step 5 for how review renders
  // this (preview vs. diff).
  replacesSlug?: string;
  // 'unverified' until draft-verify.ts's background pass reports back —
  // never inferred as 'clean' by default, because the two look identical in
  // review otherwise and the whole point of the pass is knowing which it is.
  verdict: DraftVerdict;
  disputes: DraftDispute[];
  // Source kind + confidence bookkeeping (roadmap r2), stamped at propose time
  // and carried into the accepted doc's frontmatter on accept so the fields
  // survive the propose→accept lifecycle. Undefined until a proposer sets them.
  sourceKind?: SourceKind;
  confidence?: number;
  lastVerifiedAt?: string;
  halfLifeDays?: number;
  // Scope + owning user the propose path stamped on this draft (per-user
  // knowledge). Surfaced RAW off the file — undefined when the draft asserts
  // none, NOT a 'project' default — so a body edit round-trips exactly what was
  // authored and cannot silently re-aim the draft's audience on a fresh accept.
  // `ownerUser` names the owning user of a 'user'-scoped draft. Carried into the
  // accepted doc's frontmatter on accept exactly like `sourceKind`.
  scope?: Scope;
  ownerUser?: string;
}

export interface DraftFrontmatter extends KnowledgeFrontmatter {
  generated_by_launch_id?: string;
  replaces_slug?: string;
}
