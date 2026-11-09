import {
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
  lazy,
  Suspense,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useSearchParams } from "react-router-dom";
import type {
  KnowledgeRetrievalBreakdown,
  KnowledgeRetrievalUsage,
  KnowledgeUsageHealth,
  ProjectWithCounts,
} from "@standup/shared";
import {
  alpha,
  categoricalColors,
  hexAlpha,
  palettes,
  theme,
  type Palette,
  type ThemeName,
  type ThemeToken,
} from "./theme";
import { useThemeName } from "../hooks/useTheme";
import { Markdown } from "./Markdown";
import { KnowledgePanel } from "./KnowledgePanel";
import {
  nodeMatchesSearch,
  buildNeighbors,
  buildDegree,
  buildNeighborRelations,
  filterGraph,
  rankSearchMatches,
  radialEgoLayout,
  communitySummaries,
  deemphasisReason,
  nodeSize,
  RELATION_RANK,
  LAYER_ORDER,
  UNCLUSTERED,
  type GraphNode,
  type GraphData,
  type GraphEdge,
  type GraphFilters,
  type KnowledgeLayer,
  type NeighborRelation,
  type SizeMode,
} from "./knowledgeGraph";
import type { LayoutResult, Positions } from "./knowledgeGraphLayout";
import type { GraphCanvasHandle } from "./KnowledgeGraphCanvas";
import {
  OPEN_DOC_PARAM,
  withOpenDoc,
  withoutOpenDoc,
  isSelectableProject,
  scopeSelectValue,
  docDetailUrl,
  knowledgeTabFor,
  KNOWLEDGE_TABS,
  type KnowledgeTab,
} from "../lib/knowledgeInspect";

// The Knowledge surface: the cross-project Graph visualization (the landing
// view), corpus Browse/search, the Health panel (coverage + live retrieval eval
// scores) and the Needs-review queue. Rendered for /knowledge. Knowledge is
// cross-project, so a scope selector sits above every sub-tab — "All projects"
// or a single one — and is mirrored in the URL (?project=) so a link from the
// Projects tab lands here pre-scoped and the choice survives a refresh.

const TABS = KNOWLEDGE_TABS;
type Tab = KnowledgeTab;

// Display labels for the sub-tabs. Only overrides where the raw capitalized key
// isn't the wanted label ("review" → the two-word "Needs review" queue name).
const TAB_LABELS: Partial<Record<Tab, string>> = {
  review: "Needs review",
};

// Categorical palette for coloring graph nodes / legend by project. Stable per
// project: indexed by the project's position in the list so a given project
// keeps its color across the graph, legend, and per-project health rows. The
// colors are literal, since the graph canvas draws with them. Slot 8 is emerald
// in both palettes (a deeper shade on white) so a project keeps its hue across
// a theme switch.
const PROJECT_COLORS: Record<ThemeName, readonly string[]> = {
  dark: [...categoricalColors.dark.slice(0, 8), "#34d399", categoricalColors.dark[9]],
  light: [...categoricalColors.light.slice(0, 8), "#047857", categoricalColors.light[9]],
};

// Edge color by relation kind — the kinds compileGraph emits. `contradicts` is
// the coherence pass's flagged conflict between two accepted docs; it reads in
// the same alarm red as a contradicted node's trust badge. `semantic-similarity`
// is the inferred de-float link (an otherwise-disconnected doc attached to its
// nearest neighbor); it reads in a muted tone so it never competes visually with
// the authored/derived relations. EDGE_COLOR is for the DOM; the canvas reads
// the same tokens from the active palette (edgeColorIn).
const EDGE_TOKEN: Record<string, ThemeToken> = {
  contradicts: "waiting",
  related: "running",
  "co-citation": "expert",
  provenance: "checkpoint",
  "semantic-similarity": "faint",
};
const EDGE_COLOR: Record<string, string> = Object.fromEntries(
  Object.entries(EDGE_TOKEN).map(([kind, token]) => [kind, theme[token]])
);

function edgeColorIn(palette: Palette, kind: string): string {
  const token = EDGE_TOKEN[kind];
  return token ? palette[token] : palette.dim;
}

interface PerProjectStat {
  projectId: string;
  docs: number;
  chunks: number;
  coveragePct: number;
  edges: number;
}

interface StatsData {
  docs: number;
  chunks: number;
  embeddedDocs: number;
  coveragePct: number;
  edges: number;
  edgesPerDoc: number;
  dimensions: number | null;
  originClassBreakdown: Record<string, number>;
  perProject: PerProjectStat[];
  retrievalUsage: KnowledgeRetrievalUsage[];
  retrievalBreakdown?: KnowledgeRetrievalBreakdown;
  usageHealth?: KnowledgeUsageHealth;
  provider: string | null;
  model: string | null;
}

interface EvalFixtureResult {
  query: string;
  kind: "keyword" | "paraphrase";
  expected: string[];
  hitAtK: boolean;
  hitTop1: boolean;
  topResults: string[];
  rank: number | null;
}

interface EvalData {
  k: number;
  total: number;
  recallAtK: number;
  top1: number;
  perFixture: EvalFixtureResult[];
}

interface SearchResult {
  id: string;
  projectId: string;
  slug: string;
  title: string;
  excerpt: string;
  score: number;
  source: "text" | "embedding";
}

const field: React.CSSProperties = {
  width: "100%",
  fontSize: 13,
  color: theme.text,
  background: theme.ground,
  border: `1px solid ${theme.edge}`,
  borderRadius: 6,
  padding: "8px 10px",
  outline: "none",
};

const label: React.CSSProperties = {
  fontFamily: theme.mono,
  fontSize: 9.5,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  color: theme.faint,
  display: "block",
  marginBottom: 5,
};

function projectColor(projectId: string, projects: ProjectWithCounts[], themeName: ThemeName): string {
  const colors = PROJECT_COLORS[themeName];
  const idx = projects.findIndex((p) => p.id === projectId);
  if (idx >= 0) return colors[idx % colors.length];
  // A doc whose project isn't in the list (e.g. "scratch") still needs a
  // stable color — hash the id into the same palette.
  let h = 0;
  for (const ch of projectId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return colors[h % colors.length];
}

function projectName(projectId: string, projects: ProjectWithCounts[]): string {
  return projects.find((p) => p.id === projectId)?.name ?? projectId;
}

export function KnowledgeView({
  projects,
  draftSignal,
}: {
  projects: ProjectWithCounts[];
  draftSignal?: { projectId: string; n: number };
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  // "" scope = all projects. Seeded from ?project= so a deep link from the
  // Projects tab lands pre-scoped.
  const scope = searchParams.get("project") ?? "";
  const tab = knowledgeTabFor(searchParams);

  const setScope = (id: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (id) next.set("project", id);
      else next.delete("project");
      return next;
    });
  };

  const setTab = (t: Tab) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("tab", t);
      return next;
    });
  };

  // A cross-project browse result opens by re-scoping to its OWN project and
  // naming its slug; the project panel then opens that doc's detail. The doc's
  // own project is used (not the current scope) so a same-slug doc elsewhere
  // isn't opened. Cleared once consumed so closing the detail returns to the
  // list rather than reopening it. Both are stable (setSearchParams is), so
  // they don't re-trigger the panel's open effect on every render.
  const openDocSlug = searchParams.get(OPEN_DOC_PARAM) ?? undefined;
  const openDoc = useCallback(
    (projectId: string, slug: string) => {
      setSearchParams((prev) => withOpenDoc(prev, projectId, slug));
    },
    [setSearchParams],
  );
  const clearOpenDoc = useCallback(() => {
    setSearchParams((prev) => withoutOpenDoc(prev));
  }, [setSearchParams]);

  // Jump to the Needs-review queue, optionally re-scoping to a project — the
  // target when a red `contradicts` edge is clicked in the Graph, so a visible
  // conflict links straight to the held resolution a human can act on.
  const openReview = useCallback(
    (projectId?: string) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set("tab", "review");
        if (projectId) next.set("project", projectId);
        return next;
      });
    },
    [setSearchParams],
  );

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Scope + sub-tabs — shared across all three surfaces. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "10px 20px",
          borderBottom: `1px solid ${theme.edge}`,
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", gap: 4 }}>
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                fontSize: 12.5,
                fontWeight: 600,
                padding: "5px 12px",
                borderRadius: 5,
                border: "none",
                cursor: "pointer",
                textTransform: "capitalize",
                background: tab === t ? theme.raised : "transparent",
                color: tab === t ? theme.text : theme.faint,
              }}
            >
              {TAB_LABELS[t] ?? t}
            </button>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        <span
          style={{
            fontFamily: theme.mono,
            fontSize: 9.5,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: theme.faint,
          }}
        >
          Scope
        </span>
        <select
          // Guard against a scope that isn't a listed project (a stale
          // ?project= from a since-deleted project, or a hand-edited URL): a
          // controlled select with a value that has no <option> renders blank.
          // Fall back to "All projects" — the surface BrowseTab renders anyway
          // when the scope can't be resolved — so the control stays coherent.
          value={scopeSelectValue(projects, scope)}
          onChange={(e) => setScope(e.target.value)}
          style={{
            fontSize: 12.5,
            color: theme.text,
            background: theme.ground,
            border: `1px solid ${theme.edge}`,
            borderRadius: 6,
            padding: "6px 10px",
            outline: "none",
          }}
        >
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
        {tab === "browse" && (
          <BrowseTab
            scope={scope}
            projects={projects}
            draftSignal={draftSignal}
            openSlug={openDocSlug}
            onOpenConsumed={clearOpenDoc}
            onOpenDoc={openDoc}
          />
        )}
        {tab === "graph" && (
          <GraphTab scope={scope} projects={projects} onOpenReview={openReview} />
        )}
        {tab === "health" && <HealthTab scope={scope} projects={projects} />}
        {tab === "review" && (
          <ReviewTab scope={scope} projects={projects} draftSignal={draftSignal} />
        )}
      </div>
    </div>
  );
}

// ── Browse ──────────────────────────────────────────────────────────────────

function BrowseTab({
  scope,
  projects,
  draftSignal,
  openSlug,
  onOpenConsumed,
  onOpenDoc,
}: {
  scope: string;
  projects: ProjectWithCounts[];
  draftSignal?: { projectId: string; n: number };
  // A doc to open on arrival (from a cross-project result), and the callbacks
  // that route into / clear that intent. Threaded to the project panel (which
  // opens the doc) and the cross-project search (which requests the open).
  openSlug?: string;
  onOpenConsumed?: () => void;
  onOpenDoc?: (projectId: string, slug: string) => void;
}) {
  const scoped = projects.find((p) => p.id === scope);

  return (
    <div style={{ height: "100%", overflowY: "auto" }}>
      {scope && scoped ? (
        // A single project reuses the full corpus panel — search, the bootstrap
        // trigger, and drafts/accept/discard/revise all keep working unchanged.
        <KnowledgePanel
          projectId={scope}
          repos={scoped.repos}
          knowledgeScope={scoped.knowledgeScope}
          draftSignal={draftSignal}
          openSlug={openSlug}
          onOpenConsumed={onOpenConsumed}
        />
      ) : (
        <CrossProjectSearch projects={projects} onOpenDoc={onOpenDoc} />
      )}
    </div>
  );
}

// The all-projects corpus search — the same POST /api/knowledge/search the
// project panel uses, but with corpus "all" and each result labeled by the
// project it came from, since results now span every project.
function CrossProjectSearch({
  projects,
  onOpenDoc,
}: {
  projects: ProjectWithCounts[];
  // Opens a clicked result's doc detail by routing to its own project's browse.
  onOpenDoc?: (projectId: string, slug: string) => void;
}) {
  const themeName = useThemeName();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  // A result whose project isn't a listed one — a since-deleted project, or the
  // reserved 'global'/'scratch' corpus — can't re-scope Browse (no <option> for
  // it), so it opens here in a standalone read-only detail fetched by
  // project+slug, independent of the projects list (like the graph's NodeDetail).
  const [inspect, setInspect] = useState<{ projectId: string; slug: string; title: string } | null>(
    null
  );

  // Open a clicked result. A result homed in a LISTED project re-scopes Browse
  // to that project, whose panel then opens the doc's full (editable) detail. A
  // result homed in an unlisted project (deleted / global / scratch) has no such
  // panel, so it opens inline in a read-only detail instead of silently doing
  // nothing.
  function open(r: SearchResult) {
    if (isSelectableProject(projects, r.projectId)) {
      onOpenDoc?.(r.projectId, r.slug);
    } else {
      setInspect({ projectId: r.projectId, slug: r.slug, title: r.title });
    }
  }

  if (inspect) {
    return (
      <DocInspect
        projectId={inspect.projectId}
        slug={inspect.slug}
        fallbackTitle={inspect.title}
        projects={projects}
        onClose={() => setInspect(null)}
      />
    );
  }

  async function search() {
    if (!query.trim()) {
      setResults(null);
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/knowledge/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: "", query, corpus: "all" }),
      });
      const data = await res.json().catch(() => ({}));
      setResults(data.results ?? []);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: "0 20px 24px" }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void search();
            if (e.key === "Escape") {
              setQuery("");
              setResults(null);
            }
          }}
          placeholder="Search all projects' knowledge as an agent would…"
          style={field}
        />
        <button
          onClick={() => void search()}
          disabled={busy}
          style={{
            fontSize: 12.5,
            fontWeight: 600,
            color: theme.ground,
            background: theme.checkpoint,
            border: "none",
            borderRadius: 6,
            padding: "8px 14px",
            cursor: "pointer",
            whiteSpace: "nowrap",
            opacity: busy ? 0.6 : 1,
          }}
        >
          Search
        </button>
      </div>

      {results !== null &&
        (results.length === 0 ? (
          <div style={{ fontSize: 12.5, color: theme.faint, lineHeight: 1.5 }}>
            Nothing matched across any project. An agent asking this would get
            nothing back.
          </div>
        ) : (
          <>
            <div style={{ ...label, marginBottom: 8 }}>
              {results.length} result{results.length === 1 ? "" : "s"} for “{query}”
            </div>
            {results.map((r) => (
              // Whole-card open into the result's own project browse, which then
              // opens that doc's detail — the same detail a single-project card
              // opens. Keyboard-openable, mirroring the project doc-list card.
              <div
                key={r.id}
                role="button"
                tabIndex={0}
                onClick={() => open(r)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") open(r);
                }}
                style={{
                  background: theme.surface,
                  border: `1px solid ${theme.edgeSoft}`,
                  borderRadius: 6,
                  padding: "9px 11px",
                  marginBottom: 7,
                  cursor: "pointer",
                }}
              >
                <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                  <span
                    style={{
                      fontFamily: theme.mono,
                      fontSize: 9,
                      color: projectColor(r.projectId, projects, themeName),
                      border: `1px solid ${hexAlpha(projectColor(r.projectId, projects, themeName), 0x66)}`,
                      borderRadius: 3,
                      padding: "1px 5px",
                    }}
                  >
                    {projectName(r.projectId, projects)}
                  </span>
                  <span style={{ fontSize: 12.5, fontWeight: 600 }}>{r.title}</span>
                  <span style={{ fontFamily: theme.mono, fontSize: 10, color: theme.faint }}>
                    {r.slug} · {r.source} · {r.score.toFixed(2)}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: theme.dim, marginTop: 4, lineHeight: 1.5 }}>
                  {r.excerpt}
                </div>
              </div>
            ))}
          </>
        ))}
    </div>
  );
}

// A standalone read-only doc detail, fetched by project + slug straight from
// GET /api/projects/:id/knowledge/:slug — independent of the projects list, the
// same way the graph's NodeDetail loads a node's body. This is how a
// cross-project result homed in an unlisted project (a since-deleted project, or
// the reserved 'global'/'scratch' corpus) is opened: it can't re-scope Browse to
// a project the scope selector doesn't list, so it renders here instead of
// silently failing to open.
function DocInspect({
  projectId,
  slug,
  fallbackTitle,
  projects,
  onClose,
}: {
  projectId: string;
  slug: string;
  // The title from the search result, shown until (or if) the body loads — a
  // deleted-project doc may since have been removed from disk, in which case the
  // fetch 404s and we still name what was clicked.
  fallbackTitle: string;
  projects: ProjectWithCounts[];
  onClose: () => void;
}) {
  const themeName = useThemeName();
  const [doc, setDoc] = useState<{ title?: string; body?: string; tags?: string[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    setLoading(true);
    setNotFound(false);
    setDoc(null);
    fetch(docDetailUrl(projectId, slug))
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => (d ? setDoc(d) : setNotFound(true)))
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [projectId, slug]);

  // Escape returns to the results, mirroring the DocEditor's above-the-fold exit.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const title = doc?.title ?? fallbackTitle;
  const tags = doc?.tags ?? [];

  return (
    <div style={{ padding: "0 20px 24px" }}>
      <button
        onClick={onClose}
        style={{
          background: "none",
          border: "none",
          padding: 0,
          marginBottom: 12,
          cursor: "pointer",
          fontSize: 12.5,
          color: theme.faint,
        }}
      >
        ← All results
      </button>

      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span
          style={{
            fontFamily: theme.mono,
            fontSize: 9,
            color: projectColor(projectId, projects, themeName),
            border: `1px solid ${hexAlpha(projectColor(projectId, projects, themeName), 0x66)}`,
            borderRadius: 3,
            padding: "1px 5px",
          }}
        >
          {projectName(projectId, projects)}
        </span>
        <span style={{ fontFamily: theme.mono, fontSize: 10.5, color: theme.faint }}>
          {slug}.md
        </span>
      </div>
      <div
        style={{ fontSize: 16.5, fontWeight: 700, color: theme.text, marginTop: 8, lineHeight: 1.35 }}
      >
        {title}
      </div>
      {tags.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
          {tags.map((t) => (
            <span
              key={t}
              style={{
                fontFamily: theme.mono,
                fontSize: 9,
                color: theme.expert,
                border: `1px solid ${alpha(theme.expert, 0x44)}`,
                borderRadius: 3,
                padding: "1px 5px",
              }}
            >
              {t}
            </span>
          ))}
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        {loading ? (
          <div style={{ fontSize: 12, color: theme.faint }}>Loading…</div>
        ) : notFound || doc?.body == null ? (
          <div style={{ fontSize: 12, color: theme.faint, lineHeight: 1.5 }}>
            Couldn't load this doc — its project may have been removed. It still
            surfaces in cross-project search while its file remains in the corpus.
          </div>
        ) : (
          <div style={{ fontSize: 13.5, color: theme.dim, lineHeight: 1.65 }}>
            <Markdown>{doc.body}</Markdown>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Needs review ────────────────────────────────────────────────────────────

// A held contradiction resolution as returned by GET /api/knowledge/needs-review:
// the ledger row plus the winner/loser doc titles the collector joins on.
interface NeedsReviewResolution {
  id: string;
  projectId: string;
  winnerSlug: string;
  loserSlug: string;
  winnerTitle: string;
  loserTitle: string;
  type: "rescope" | "merge" | "supersede" | "delete";
  status: "needs_review" | "applied";
  autoApplied: boolean;
  rationale: string;
  detail?: string;
  createdAt: string;
}

// The write-token header the gated confirm/reject/swap routes accept on a
// shared/multiplayer or network-exposed collector. Mirrors the personalization
// forms: sent only when the user has saved a token; a single-user loopback
// collector needs none.
function knowledgeWriteHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  let tok = "";
  try {
    tok = (localStorage.getItem("standup.writeToken") ?? "").trim();
  } catch {
    /* private mode — no token available */
  }
  if (tok) headers["x-standup-write-token"] = tok;
  return headers;
}

const RESOLUTION_TYPE_COLOR: Record<NeedsReviewResolution["type"], string> = {
  supersede: theme.stalled,
  merge: theme.expert,
  rescope: theme.running,
  delete: theme.waiting,
};

// The classifier reason recorded on the row's `detail` JSON, if any — the "why it
// was withheld" a reviewer wants to see alongside the resolver's rationale.
function resolutionReason(detail?: string): string | null {
  if (!detail) return null;
  try {
    const parsed = JSON.parse(detail) as { reason?: unknown };
    return typeof parsed.reason === "string" ? parsed.reason : null;
  } catch {
    return null;
  }
}

/**
 * The human-review queue for held contradiction resolutions: each row is a pair
 * the auto-resolver deliberately WITHHELD (a merge, or superseding an owner /
 * high-confidence claim), left as a red `contradicts` edge until a human decides.
 * Confirm applies the proposal, Reject dismisses it (clearing both edges without
 * superseding), Swap applies it with the winner/loser reversed. Cross-project when
 * scope is "All projects", narrowed to one project otherwise.
 */
function ReviewTab({
  scope,
  projects,
  draftSignal,
}: {
  scope: string;
  projects: ProjectWithCounts[];
  draftSignal?: { projectId: string; n: number };
}) {
  const [rows, setRows] = useState<NeedsReviewResolution[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    const qs = scope ? `?project=${encodeURIComponent(scope)}` : "";
    fetch(`/api/knowledge/needs-review${qs}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setRows(Array.isArray(d) ? (d as NeedsReviewResolution[]) : []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [scope]);

  useEffect(() => {
    load();
  }, [load]);

  // A confirm/reject/swap on any surface broadcasts knowledge:draft; refetch so
  // the queue drops the resolved row without a manual reload.
  useEffect(() => {
    if (draftSignal && draftSignal.n > 0) load();
  }, [draftSignal, load]);

  const act = useCallback(
    async (id: string, action: "confirm" | "reject" | "swap") => {
      setBusyId(id);
      setError(null);
      try {
        const res = await fetch(
          `/api/knowledge/resolutions/${encodeURIComponent(id)}/${action}`,
          { method: "POST", headers: knowledgeWriteHeaders() },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          setError(body?.error ?? `Could not ${action} (HTTP ${res.status}).`);
          return;
        }
        // Optimistically drop the resolved row; the broadcast-driven refetch reconciles.
        setRows((prev) => prev.filter((r) => r.id !== id));
        load();
      } catch {
        setError(`Could not ${action} — the collector did not respond.`);
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  return (
    <div style={{ height: "100%", overflow: "auto", padding: "16px 20px" }}>
      <div style={{ maxWidth: 820, margin: "0 auto" }}>
        <p style={{ fontSize: 12.5, color: theme.faint, margin: "0 0 14px", lineHeight: 1.5 }}>
          Contradiction resolutions the auto-resolver held for a human — a merge, or
          superseding an owner / high-confidence claim. Both docs stay flagged
          <span style={{ color: theme.waiting }}> contradicted</span> until you act.
          <strong style={{ color: theme.text }}> Confirm</strong> applies the proposal,
          <strong style={{ color: theme.text }}> Swap winner</strong> applies it with the
          winner/loser reversed, <strong style={{ color: theme.text }}>Reject</strong>{" "}
          dismisses it (clearing both edges without superseding).
        </p>

        {error && (
          <div
            style={{
              fontSize: 12.5,
              color: theme.waiting,
              background: theme.raised,
              border: `1px solid ${theme.waiting}`,
              borderRadius: 6,
              padding: "8px 12px",
              marginBottom: 12,
            }}
          >
            {error}
          </div>
        )}

        {loading ? (
          <p style={{ fontSize: 13, color: theme.faint }}>Loading…</p>
        ) : rows.length === 0 ? (
          <p style={{ fontSize: 13, color: theme.faint }}>
            No held resolutions to review{scope ? " in this project" : ""}.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {rows.map((r) => {
              const reason = resolutionReason(r.detail);
              const busy = busyId === r.id;
              return (
                <div
                  key={r.id}
                  style={{
                    background: theme.raised,
                    border: `1px solid ${theme.edge}`,
                    borderRadius: 8,
                    padding: "12px 14px",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <span
                      style={{
                        fontFamily: theme.mono,
                        fontSize: 9.5,
                        letterSpacing: "0.1em",
                        textTransform: "uppercase",
                        color: RESOLUTION_TYPE_COLOR[r.type] ?? theme.faint,
                        border: `1px solid ${RESOLUTION_TYPE_COLOR[r.type] ?? theme.edge}`,
                        borderRadius: 4,
                        padding: "2px 6px",
                      }}
                    >
                      {r.type}
                    </span>
                    <span style={{ fontSize: 11.5, color: theme.faint }}>
                      {projectName(r.projectId, projects)}
                    </span>
                  </div>

                  <div style={{ fontSize: 13.5, color: theme.text, marginBottom: 6, lineHeight: 1.5 }}>
                    <strong style={{ color: theme.checkpoint }}>{r.winnerTitle}</strong>
                    <span style={{ color: theme.faint }}> keeps · supersedes </span>
                    <strong style={{ color: theme.waiting }}>{r.loserTitle}</strong>
                  </div>

                  {r.rationale && (
                    <div style={{ fontSize: 12.5, color: theme.text, marginBottom: reason ? 4 : 10, lineHeight: 1.5 }}>
                      {r.rationale}
                    </div>
                  )}
                  {reason && (
                    <div style={{ fontSize: 11.5, color: theme.faint, marginBottom: 10, lineHeight: 1.5 }}>
                      Withheld: {reason}
                    </div>
                  )}

                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      disabled={busy}
                      onClick={() => act(r.id, "confirm")}
                      style={reviewButtonStyle(theme.checkpoint, busy)}
                    >
                      Confirm
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => act(r.id, "swap")}
                      style={reviewButtonStyle(theme.running, busy)}
                    >
                      Swap winner
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => act(r.id, "reject")}
                      style={reviewButtonStyle(theme.waiting, busy)}
                    >
                      Reject
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function reviewButtonStyle(color: string, busy: boolean): CSSProperties {
  return {
    fontSize: 12.5,
    fontWeight: 600,
    padding: "6px 14px",
    borderRadius: 6,
    border: `1px solid ${color}`,
    background: "transparent",
    color,
    cursor: busy ? "default" : "pointer",
    opacity: busy ? 0.5 : 1,
  };
}

// ── Graph ─────────────────────────────────────────────────────────────────

// Lazy so sigma and graphology load only once the graph is on screen.
const KnowledgeGraphCanvas = lazy(() => import("./KnowledgeGraphCanvas"));

// Categorical palette for communities. Community ids run largest first, so the
// biggest topics get the most distinct hues; past the end the palette cycles.
// Unclustered docs get the palette's graph gray, which still reads on the ground.
function communityColor(c: number, themeName: ThemeName): string {
  const colors = categoricalColors[themeName];
  return c === UNCLUSTERED ? palettes[themeName].graphMuted : colors[c % colors.length];
}

const LAYER_LABELS: Record<KnowledgeLayer, string> = {
  docs: "Docs",
  intent: "Product & spec",
  activity: "Activity",
  personal: "Personal",
};

// Communities in the legend before it collapses the rest into "+N more".
const LEGEND_COMMUNITIES = 12;
// Community hubs labeled on the resting map, so it reads at a glance.
const RESTING_HUB_LABELS = 12;
// Width of the controls panel plus its margins; camera framing centers in the
// canvas area to its right while the panel is open.
const CONTROLS_WIDTH = 248;
const CONTROLS_INSET = CONTROLS_WIDTH + 24;

const EMPTY_COMMUNITIES: ReadonlyMap<string, number> = new Map();

interface GraphLayout {
  graph: GraphData;
  communities: Map<string, number>;
  positions: Positions;
}

// Communities + positions for `graph`, computed in a worker so a few hundred
// milliseconds of ForceAtlas2 never block the page; falls back to the main
// thread where a worker can't start. Null until the graph in hand is laid out.
function useGraphLayout(graph: GraphData | null): GraphLayout | null {
  const [layout, setLayout] = useState<GraphLayout | null>(null);
  useEffect(() => {
    if (!graph || graph.nodes.length === 0) return;
    let cancelled = false;
    let worker: Worker | null = null;
    const done = (r: LayoutResult) => {
      if (!cancelled) setLayout({ graph, communities: new Map(r.communities), positions: r.positions });
    };
    const onMainThread = () => {
      import("./knowledgeGraphLayout").then((m) => done(m.layoutGraph(graph)));
    };
    try {
      worker = new Worker(new URL("./knowledgeGraphLayout.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (e: MessageEvent<LayoutResult>) => done(e.data);
      worker.onerror = () => onMainThread();
      worker.postMessage(graph);
    } catch {
      onMainThread();
    }
    return () => {
      cancelled = true;
      worker?.terminate();
    };
  }, [graph]);
  return layout && layout.graph === graph ? layout : null;
}

function toggled<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function GraphTab({
  scope,
  projects,
  onOpenReview,
}: {
  scope: string;
  projects: ProjectWithCounts[];
  onOpenReview: (projectId?: string) => void;
}) {
  const themeName = useThemeName();
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  const [edgeHover, setEdgeHover] = useState<{ kind: GraphEdge["kind"]; evidence?: string; x: number; y: number } | null>(
    null
  );
  const [search, setSearch] = useState("");
  const [activeMatch, setActiveMatch] = useState(0);
  const [colorBy, setColorBy] = useState<"community" | "project">("community");
  const [sizeBy, setSizeBy] = useState<SizeMode>("degree");
  const [focusCommunity, setFocusCommunity] = useState<number | null>(null);
  // Neighborhood mode around the selected doc: 0 = off, else the hop count.
  const [hops, setHops] = useState(0);
  const [hiddenKinds, setHiddenKinds] = useState<ReadonlySet<string>>(() => new Set());
  const [hiddenProjects, setHiddenProjects] = useState<ReadonlySet<string>>(() => new Set());
  const [hiddenLayers, setHiddenLayers] = useState<ReadonlySet<string>>(() => new Set());
  const [minConfidence, setMinConfidence] = useState(0);
  const [hideOrphans, setHideOrphans] = useState(false);
  const [hideDeemphasized, setHideDeemphasized] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);

  const canvasRef = useRef<GraphCanvasHandle | null>(null);
  const paneRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setLoading(true);
    setSelected(null);
    setSearch("");
    setHops(0);
    setFocusCommunity(null);
    const qs = scope ? `?projectId=${encodeURIComponent(scope)}` : "";
    fetch(`/api/knowledge/graph${qs}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setGraph(d))
      .catch(() => setGraph(null))
      .finally(() => setLoading(false));
  }, [scope]);

  const layout = useGraphLayout(graph);
  const communities = layout?.communities ?? EMPTY_COMMUNITIES;

  const filters = useMemo<GraphFilters>(
    () => ({
      hiddenKinds,
      hiddenProjects,
      hiddenLayers,
      minConfidence,
      hideOrphans,
      hideDeemphasized,
      ego: selected && hops > 0 ? { center: selected, hops } : null,
    }),
    [hiddenKinds, hiddenProjects, hiddenLayers, minConfidence, hideOrphans, hideDeemphasized, selected, hops]
  );
  // Everything drawn or traversed reads the visible graph, so a filtered-out doc
  // or relation drops out of the canvas, the neighbor rail and search alike.
  const visible = useMemo<GraphData>(() => (graph ? filterGraph(graph, filters) : { nodes: [], edges: [] }), [graph, filters]);

  // Sizing and hubs read the whole corpus, so a filter never resizes the map.
  const degree = useMemo(() => buildDegree(graph?.edges ?? []), [graph]);
  const neighbors = useMemo(() => buildNeighbors(visible.edges), [visible]);
  const neighborRel = useMemo(() => buildNeighborRelations(visible.edges), [visible]);

  const nodeById = useMemo(() => {
    const m = new Map<string, GraphNode>();
    if (graph) for (const n of graph.nodes) m.set(n.id, n);
    return m;
  }, [graph]);

  const summaries = useMemo(
    () => (graph && layout ? communitySummaries(graph, communities, degree) : []),
    [graph, layout, communities, degree]
  );
  const communityName = useMemo(() => new Map(summaries.map((s) => [s.id, s.label])), [summaries]);

  const deemphasized = useMemo(() => {
    const s = new Set<string>();
    for (const n of graph?.nodes ?? []) if (deemphasisReason(n)) s.add(n.id);
    return s;
  }, [graph]);

  // Fixed per fetched graph so recency sizing doesn't drift between renders.
  const now = useMemo(() => Date.now(), [graph]);
  const sizes = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of graph?.nodes ?? []) m.set(n.id, nodeSize(sizeBy, degree.get(n.id) ?? 0, n.updatedAt, now));
    return m;
  }, [graph, sizeBy, degree, now]);

  // Counts over the fetched graph, for the filter toggles.
  const counts = useMemo(() => {
    const kinds = new Map<string, number>();
    const projectsC = new Map<string, number>();
    const layers = new Map<string, number>();
    for (const e of graph?.edges ?? []) kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1);
    for (const n of graph?.nodes ?? []) {
      projectsC.set(n.projectId, (projectsC.get(n.projectId) ?? 0) + 1);
      if (n.layer) layers.set(n.layer, (layers.get(n.layer) ?? 0) + 1);
    }
    return { kinds, projects: projectsC, layers };
  }, [graph]);

  // Search: every visible match is highlighted; the typeahead lists the best few.
  const query = search.trim();
  const matches = useMemo(() => (query ? rankSearchMatches(visible.nodes, query, 8) : []), [visible, query]);
  const matchIds = useMemo(() => {
    if (!query) return null;
    const s = new Set<string>();
    for (const n of visible.nodes) if (nodeMatchesSearch(n, query)) s.add(n.id);
    return s;
  }, [visible, query]);

  const communityMembers = useCallback(
    (c: number) => visible.nodes.filter((n) => (communities.get(n.id) ?? UNCLUSTERED) === c).map((n) => n.id),
    [visible, communities]
  );

  // The highlighted set, most specific first: a search, the hovered doc and its
  // neighbors, a focused community, the selection and its neighbors. Null
  // highlights everything — including in neighborhood mode, where everything
  // still on screen is the neighborhood.
  const egoActive = filters.ego !== null;
  const focus = useMemo<Set<string> | null>(() => {
    if (matchIds) return matchIds;
    const around = (id: string) => new Set([id, ...(neighbors.get(id) ?? [])]);
    if (hover) return around(hover.id);
    if (focusCommunity !== null) return new Set(communityMembers(focusCommunity));
    if (selected && !egoActive) return around(selected);
    return null;
  }, [matchIds, hover, focusCommunity, selected, egoActive, neighbors, communityMembers]);

  // Labels drawn regardless of the label grid: whatever is in play, or on the
  // resting map the hub of each of the largest communities.
  const forcedLabels = useMemo(() => {
    const s = new Set<string>();
    const withNeighbors = (id: string) => {
      s.add(id);
      const nbrs = [...(neighbors.get(id) ?? [])];
      if (nbrs.length <= 14) for (const nb of nbrs) s.add(nb);
    };
    if (hover) withNeighbors(hover.id);
    else if (matchIds) for (const m of matches) s.add(m.id);
    else if (focusCommunity !== null) {
      const members = communityMembers(focusCommunity).sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0));
      for (const id of members.slice(0, 8)) s.add(id);
    } else if (egoActive && selected) {
      // The center and its first ring; the outer ring is left to the label grid.
      s.add(selected);
      const ring = [...(neighbors.get(selected) ?? [])].sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0));
      for (const id of ring.slice(0, 24)) s.add(id);
    } else if (selected) withNeighbors(selected);
    else for (const c of summaries.filter((c) => c.id !== UNCLUSTERED).slice(0, RESTING_HUB_LABELS)) s.add(c.hubId);
    return s;
  }, [hover, matchIds, matches, focusCommunity, egoActive, selected, neighbors, communityMembers, degree, summaries]);

  // Neighborhood mode lays the hops out as rings around the center, spaced
  // relative to the whole layout so the zoom level stays familiar.
  const egoPositions = useMemo(() => {
    if (!filters.ego || !layout) return null;
    const origin = layout.positions[filters.ego.center];
    if (!origin) return null;
    const pts = Object.values(layout.positions);
    const span = Math.max(
      Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x)),
      Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y)),
      1
    );
    return radialEgoLayout(visible.edges, filters.ego.center, filters.ego.hops, origin, span * 0.08);
  }, [filters.ego, layout, visible]);

  const nodeColor = useCallback(
    (n: GraphNode) =>
      colorBy === "community"
        ? communityColor(communities.get(n.id) ?? UNCLUSTERED, themeName)
        : projectColor(n.projectId, projects, themeName),
    [colorBy, communities, projects, themeName]
  );
  const sizeOf = useCallback((id: string) => sizes.get(id) ?? 3, [sizes]);
  const edgeColor = useCallback((kind: GraphEdge["kind"]) => edgeColorIn(palettes[themeName], kind), [themeName]);

  // Select a doc and frame it with its neighbors, so clicking a node — or a
  // neighbor in the detail rail — traverses the graph.
  const selectNode = useCallback(
    (id: string) => {
      setSelected(id);
      setFocusCommunity(null);
      setHover(null);
      canvasRef.current?.frameNodes([id, ...(neighbors.get(id) ?? [])]);
    },
    [neighbors]
  );

  const pickMatch = useCallback(
    (n: GraphNode) => {
      setSearch("");
      setActiveMatch(0);
      selectNode(n.id);
    },
    [selectNode]
  );

  const clearSelection = useCallback(() => {
    setSelected(null);
    setHops(0);
    setFocusCommunity(null);
  }, []);

  // Frame what the reader just narrowed to: the search hits as they type, a
  // focused community, or a neighborhood as it opens.
  useEffect(() => {
    if (matchIds && matchIds.size > 0) canvasRef.current?.frameNodes([...matchIds]);
  }, [matchIds]);
  // Both run on a change of target only, not on every filter change after it.
  useEffect(() => {
    if (focusCommunity !== null) canvasRef.current?.frameNodes(communityMembers(focusCommunity));
  }, [focusCommunity]);
  const egoKey = filters.ego ? `${filters.ego.center}|${filters.ego.hops}` : null;
  useEffect(() => {
    if (egoKey) canvasRef.current?.frameNodes(visible.nodes.map((n) => n.id));
  }, [egoKey]);

  // Esc steps back out: neighborhood mode, then the selection, then a focused community.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || (e.target as HTMLElement | null)?.tagName === "INPUT") return;
      if (hops > 0) setHops(0);
      else if (selected) setSelected(null);
      else if (focusCommunity !== null) setFocusCommunity(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hops, selected, focusCommunity]);

  if (loading) {
    return <Centered>Loading graph…</Centered>;
  }
  if (!graph || graph.nodes.length === 0) {
    return (
      <Centered>
        No knowledge docs {scope ? "in this project " : ""}to graph yet.
      </Centered>
    );
  }

  const paneWidth = paneRef.current?.clientWidth ?? 0;
  const hoverNode = hover ? nodeById.get(hover.id) : undefined;
  const selectedNode = selected ? nodeById.get(selected) : undefined;
  const filtersActive =
    hiddenKinds.size + hiddenProjects.size + hiddenLayers.size > 0 || minConfidence > 0 || hideOrphans || hideDeemphasized;
  const resetFilters = () => {
    setHiddenKinds(new Set());
    setHiddenProjects(new Set());
    setHiddenLayers(new Set());
    setMinConfidence(0);
    setHideOrphans(false);
    setHideDeemphasized(false);
  };

  return (
    <div style={{ height: "100%", display: "flex" }}>
      <div ref={paneRef} style={{ flex: 1, position: "relative", overflow: "hidden" }}>
        {!layout ? (
          <Centered>Laying out {graph.nodes.length} docs…</Centered>
        ) : (
          <Suspense fallback={<Centered>Loading graph…</Centered>}>
            <KnowledgeGraphCanvas
              ref={canvasRef}
              graph={layout.graph}
              positions={layout.positions}
              visible={visible}
              nodeColor={nodeColor}
              nodeSize={sizeOf}
              edgeColor={edgeColor}
              deemphasized={deemphasized}
              focus={focus}
              selected={selected}
              forcedLabels={forcedLabels}
              insetLeft={panelOpen ? CONTROLS_INSET : 0}
              positionOverrides={egoPositions}
              onHoverNode={(id, pos) => setHover(id && pos ? { id, ...pos } : null)}
              onHoverEdge={(e, pos) => setEdgeHover(e && pos ? { ...e, ...pos } : null)}
              onClickNode={selectNode}
              onClickStage={clearSelection}
              // A red `contradicts` edge marks a flagged conflict; clicking it
              // jumps to the Needs-review queue (re-scoped to that doc's
              // project) where the held resolution can be confirmed/rejected/swapped.
              onClickEdge={(e) => {
                if (e.kind !== "contradicts") return;
                onOpenReview(nodeById.get(e.source)?.projectId);
              }}
            />
          </Suspense>
        )}

        {/* Controls: color/size encodings, the community legend, and filters. */}
        <div
          style={{
            position: "absolute",
            top: 12,
            left: 12,
            width: CONTROLS_WIDTH,
            boxSizing: "border-box",
            maxHeight: "calc(100% - 24px)",
            overflowY: "auto",
            background: alpha(theme.surface, 0xf0),
            border: `1px solid ${theme.edgeSoft}`,
            borderRadius: 8,
            padding: panelOpen ? "10px 12px" : "6px 12px",
            fontSize: 11.5,
            boxShadow: `0 6px 24px ${alpha(theme.shadow, 0x66)}`,
          }}
        >
          <div style={{ display: "flex", alignItems: "center" }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: theme.text }}>
              {visible.nodes.length === graph.nodes.length
                ? `${graph.nodes.length} docs`
                : `${visible.nodes.length} of ${graph.nodes.length} docs`}
              <span style={{ color: theme.faint, fontWeight: 400 }}> · {visible.edges.length} links</span>
            </span>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              onClick={() => setPanelOpen((o) => !o)}
              style={{ ...linkButton, fontSize: 11 }}
              aria-expanded={panelOpen}
            >
              {panelOpen ? "Hide" : "Controls"}
            </button>
          </div>

          {panelOpen && (
            <>
              <ControlSection title="Color by">
                <Segmented
                  value={colorBy}
                  options={[
                    ["community", "Topic cluster"],
                    ["project", "Project"],
                  ]}
                  onChange={(v) => {
                    setColorBy(v);
                    setFocusCommunity(null);
                  }}
                />
              </ControlSection>
              <ControlSection title="Size by">
                <Segmented
                  value={sizeBy}
                  options={[
                    ["degree", "Connections"],
                    ["recency", "Recency"],
                  ]}
                  onChange={setSizeBy}
                />
              </ControlSection>

              {colorBy === "community" ? (
                <ControlSection title="Topic clusters">
                  {summaries.slice(0, LEGEND_COMMUNITIES).map((c) => (
                    <LegendRow
                      key={c.id}
                      swatch={<Dot color={communityColor(c.id, themeName)} />}
                      label={c.label}
                      count={c.size}
                      active={focusCommunity === c.id}
                      dim={focusCommunity !== null && focusCommunity !== c.id}
                      title={`Focus the cluster around “${c.label}”`}
                      onClick={() => {
                        setSelected(null);
                        setHops(0);
                        setFocusCommunity((cur) => (cur === c.id ? null : c.id));
                      }}
                    />
                  ))}
                  {summaries.length > LEGEND_COMMUNITIES && (
                    <div style={{ color: theme.faint, fontSize: 10.5, marginTop: 2 }}>
                      +{summaries.length - LEGEND_COMMUNITIES} smaller clusters
                    </div>
                  )}
                </ControlSection>
              ) : null}

              <ControlSection title={colorBy === "project" ? "Projects" : "Projects (filter)"}>
                {[...counts.projects.entries()].map(([pid, count]) => (
                  <LegendRow
                    key={pid}
                    swatch={<Dot color={projectColor(pid, projects, themeName)} />}
                    label={projectName(pid, projects)}
                    count={count}
                    hidden={hiddenProjects.has(pid)}
                    onClick={() => setHiddenProjects((s) => toggled(s, pid))}
                  />
                ))}
              </ControlSection>

              <ControlSection title="Relations">
                {[...counts.kinds.entries()]
                  .sort((a, b) => RELATION_RANK[b[0] as GraphEdge["kind"]] - RELATION_RANK[a[0] as GraphEdge["kind"]])
                  .map(([kind, count]) => (
                    <LegendRow
                      key={kind}
                      swatch={<span style={{ width: 14, height: 2, background: EDGE_COLOR[kind] ?? theme.dim }} />}
                      label={kind}
                      count={count}
                      hidden={hiddenKinds.has(kind)}
                      onClick={() => setHiddenKinds((s) => toggled(s, kind))}
                    />
                  ))}
              </ControlSection>

              {counts.layers.size > 0 && (
                <ControlSection title="Layers">
                  {LAYER_ORDER.filter((l) => counts.layers.has(l)).map((l) => (
                    <LegendRow
                      key={l}
                      label={LAYER_LABELS[l]}
                      count={counts.layers.get(l) ?? 0}
                      hidden={hiddenLayers.has(l)}
                      onClick={() => setHiddenLayers((s) => toggled(s, l))}
                    />
                  ))}
                </ControlSection>
              )}

              <ControlSection title={`Min confidence · ${Math.round(minConfidence * 100)}%`}>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={minConfidence}
                  onChange={(e) => setMinConfidence(Number(e.target.value))}
                  style={{ width: "100%", accentColor: theme.accent }}
                  aria-label="Minimum confidence"
                />
              </ControlSection>

              <ControlSection title="Show">
                <CheckRow checked={!hideOrphans} onChange={(v) => setHideOrphans(!v)}>
                  Unlinked docs
                </CheckRow>
                <CheckRow checked={!hideDeemphasized} onChange={(v) => setHideDeemphasized(!v)}>
                  Stale or distrusted docs <span style={{ color: theme.faint }}>({deemphasized.size}, faded)</span>
                </CheckRow>
              </ControlSection>

              {filtersActive && (
                <button type="button" onClick={resetFilters} style={{ ...linkButton, marginTop: 8 }}>
                  Reset filters
                </button>
              )}
            </>
          )}
        </div>

        {/* Search: highlights every match; the typeahead jumps to one. */}
        <div style={{ position: "absolute", top: 12, right: 12, width: 280 }}>
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setActiveMatch(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") setSearch("");
              else if (e.key === "ArrowDown") {
                e.preventDefault();
                setActiveMatch((i) => Math.min(i + 1, Math.max(0, matches.length - 1)));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActiveMatch((i) => Math.max(0, i - 1));
              } else if (e.key === "Enter" && matches.length > 0) {
                pickMatch(matches[Math.min(activeMatch, matches.length - 1)]);
              }
            }}
            placeholder="Find a doc…"
            aria-label="Find a doc"
            style={{ ...field, boxSizing: "border-box", boxShadow: `0 6px 24px ${alpha(theme.shadow, 0x66)}` }}
          />
          {query && (
            <div
              style={{
                marginTop: 4,
                background: theme.surface,
                border: `1px solid ${theme.edge}`,
                borderRadius: 6,
                boxShadow: `0 6px 24px ${alpha(theme.shadow, 0x88)}`,
                overflow: "hidden",
              }}
            >
              {matches.length === 0 ? (
                <div style={{ padding: "8px 10px", fontSize: 12, color: theme.faint }}>No visible doc matches.</div>
              ) : (
                <>
                  {matches.map((m, i) => (
                    <button
                      key={m.id}
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pickMatch(m)}
                      onMouseEnter={() => setActiveMatch(i)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        width: "100%",
                        textAlign: "left",
                        padding: "6px 10px",
                        border: "none",
                        cursor: "pointer",
                        background: i === activeMatch ? theme.raised : "transparent",
                      }}
                    >
                      <Dot color={nodeColor(m)} />
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          fontSize: 12.5,
                          color: theme.text,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {m.title}
                      </span>
                      <span style={{ fontSize: 10.5, color: theme.faint, flexShrink: 0 }}>
                        {projectName(m.projectId, projects)}
                      </span>
                    </button>
                  ))}
                  <div
                    style={{
                      padding: "5px 10px",
                      fontSize: 10.5,
                      color: theme.faint,
                      borderTop: `1px solid ${theme.edgeSoft}`,
                    }}
                  >
                    {matchIds?.size ?? 0} highlighted · ↑↓ to choose, Enter to open
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* Camera controls. */}
        <div style={{ position: "absolute", right: 12, bottom: 12, display: "flex", gap: 4 }}>
          {(
            [
              ["+", "Zoom in", () => canvasRef.current?.zoom(1.5)],
              ["−", "Zoom out", () => canvasRef.current?.zoom(1 / 1.5)],
              ["Fit", "Fit the whole graph", () => canvasRef.current?.fitAll()],
            ] as const
          ).map(([text, title, onClick]) => (
            <button key={text} type="button" title={title} onClick={onClick} style={cameraButton}>
              {text}
            </button>
          ))}
        </div>
        <div style={{ position: "absolute", left: 12, bottom: 12, fontSize: 10.5, color: theme.faint, pointerEvents: "none" }}>
          Scroll to zoom · drag to pan · click a doc to open it · Esc to step back
        </div>

        {/* Hover preview. Flips to the cursor's left near the right edge. */}
        {hover && hoverNode && (
          <HoverCard
            node={hoverNode}
            x={hover.x}
            y={hover.y}
            flip={paneWidth > 0 && hover.x > paneWidth - 320}
            projectLabel={projectName(hoverNode.projectId, projects)}
            projectTint={projectColor(hoverNode.projectId, projects, themeName)}
            community={colorBy === "community" ? communityName.get(communities.get(hoverNode.id) ?? UNCLUSTERED) : undefined}
            degree={degree.get(hoverNode.id) ?? 0}
            neighborRel={neighborRel.get(hoverNode.id)}
            nodeById={nodeById}
          />
        )}
        {edgeHover && !hover && (
          <div
            style={{
              position: "absolute",
              left: edgeHover.x + 12,
              top: edgeHover.y + 12,
              maxWidth: 320,
              pointerEvents: "none",
              background: theme.surface,
              border: `1px solid ${theme.edge}`,
              borderRadius: 6,
              padding: "6px 9px",
              fontSize: 11.5,
              color: theme.dim,
              boxShadow: `0 6px 24px ${alpha(theme.shadow, 0x88)}`,
            }}
          >
            <span style={{ color: EDGE_COLOR[edgeHover.kind] ?? theme.text, fontWeight: 600 }}>{edgeHover.kind}</span>
            {edgeHover.evidence ? ` · ${edgeHover.evidence}` : ""}
            {edgeHover.kind === "contradicts" && <div style={{ color: theme.faint, marginTop: 2 }}>Click to review</div>}
          </div>
        )}
      </div>

      {/* Detail rail: the selected doc + its neighbors. */}
      {selectedNode && (
        <NodeDetail
          node={selectedNode}
          neighborIds={[...(neighbors.get(selectedNode.id) ?? [])]}
          neighborRel={neighborRel.get(selectedNode.id) ?? new Map()}
          nodeById={nodeById}
          projects={projects}
          hops={hops}
          onHops={setHops}
          onPick={selectNode}
          onClose={clearSelection}
        />
      )}
    </div>
  );
}

const linkButton: CSSProperties = {
  background: "none",
  border: "none",
  padding: 0,
  color: theme.running,
  cursor: "pointer",
  font: "inherit",
  fontSize: 11.5,
};

const cameraButton: CSSProperties = {
  minWidth: 30,
  height: 28,
  padding: "0 8px",
  fontSize: 12.5,
  color: theme.dim,
  background: theme.surface,
  border: `1px solid ${theme.edge}`,
  borderRadius: 6,
  cursor: "pointer",
};

function Dot({ color }: { color: string }) {
  return <span style={{ width: 9, height: 9, borderRadius: "50%", background: color, flexShrink: 0 }} />;
}

function ControlSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ marginTop: 11 }}>
      <div style={{ ...label, marginBottom: 5 }}>{title}</div>
      {children}
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: ReadonlyArray<readonly [T, string]>;
  onChange: (v: T) => void;
}) {
  return (
    <div style={{ display: "flex", background: theme.ground, borderRadius: 6, padding: 2, gap: 2 }}>
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          aria-pressed={value === v}
          style={{
            flex: 1,
            fontSize: 11.5,
            padding: "4px 6px",
            borderRadius: 4,
            border: "none",
            cursor: "pointer",
            background: value === v ? theme.raised : "transparent",
            color: value === v ? theme.text : theme.faint,
          }}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

// A legend entry that is also a toggle: `hidden` strikes it through (a filter
// that is off), `active`/`dim` mark a focused entry among its siblings.
function LegendRow({
  swatch,
  label: text,
  count,
  hidden,
  active,
  dim,
  title,
  onClick,
}: {
  swatch?: ReactNode;
  label: string;
  count: number;
  hidden?: boolean;
  active?: boolean;
  dim?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title ?? (hidden ? `Show ${text}` : `Hide ${text}`)}
      aria-pressed={hidden === undefined ? active : !hidden}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        width: "100%",
        padding: "2px 4px",
        marginLeft: -4,
        background: active ? theme.raised : "none",
        border: "none",
        borderRadius: 4,
        cursor: "pointer",
        font: "inherit",
        textAlign: "left",
        opacity: hidden || dim ? 0.4 : 1,
      }}
    >
      {swatch}
      <span
        style={{
          flex: 1,
          minWidth: 0,
          color: theme.dim,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          textDecoration: hidden ? "line-through" : "none",
        }}
      >
        {text}
      </span>
      <span style={{ color: theme.faint, fontFamily: theme.mono, fontSize: 10 }}>{count}</span>
    </button>
  );
}

function CheckRow({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 7, color: theme.dim, cursor: "pointer", marginBottom: 3 }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ accentColor: theme.accent, margin: 0 }}
      />
      <span>{children}</span>
    </label>
  );
}

// Sorts a node's neighbors strongest relation first, then by edge weight.
function strongestNeighbors(rel: Map<string, NeighborRelation> | undefined, limit: number): Array<[string, NeighborRelation]> {
  return [...(rel ?? new Map<string, NeighborRelation>()).entries()]
    .sort((a, b) => RELATION_RANK[b[1].kind] - RELATION_RANK[a[1].kind] || b[1].weight - a[1].weight)
    .slice(0, limit);
}

function confidenceText(node: GraphNode): string {
  return node.confidence === undefined ? "no confidence opinion" : `${Math.round(node.confidence * 100)}% confidence`;
}

function HoverCard({
  node,
  x,
  y,
  flip,
  projectLabel,
  projectTint,
  community,
  degree,
  neighborRel,
  nodeById,
}: {
  node: GraphNode;
  x: number;
  y: number;
  flip: boolean;
  projectLabel: string;
  projectTint: string;
  community?: string;
  degree: number;
  neighborRel?: Map<string, NeighborRelation>;
  nodeById: Map<string, GraphNode>;
}) {
  const reason = deemphasisReason(node);
  const top = strongestNeighbors(neighborRel, 3);
  return (
    <div
      style={{
        position: "absolute",
        top: y + 14,
        ...(flip ? { right: `calc(100% - ${x - 14}px)` } : { left: x + 14 }),
        width: 290,
        pointerEvents: "none",
        background: theme.surface,
        border: `1px solid ${theme.edge}`,
        borderRadius: 8,
        padding: "10px 12px",
        boxShadow: `0 10px 30px ${alpha(theme.shadow, 0xaa)}`,
        zIndex: 5,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 650, color: theme.text, lineHeight: 1.35 }}>{node.title}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5, alignItems: "center", marginTop: 6, fontSize: 10.5 }}>
        <span
          style={{
            fontFamily: theme.mono,
            fontSize: 9,
            color: projectTint,
            border: `1px solid ${hexAlpha(projectTint, 0x66)}`,
            borderRadius: 3,
            padding: "1px 5px",
          }}
        >
          {projectLabel}
        </span>
        {node.layer && <span style={{ color: theme.dim }}>{LAYER_LABELS[node.layer]}</span>}
        {node.sourceKind && node.sourceKind !== "unclassified" && <span style={{ color: theme.faint }}>· {node.sourceKind}</span>}
      </div>
      <div style={{ marginTop: 6, fontSize: 11, color: theme.dim }}>
        {confidenceText(node)} · {degree} link{degree === 1 ? "" : "s"}
        {community && <span style={{ color: theme.faint }}> · in “{community}”</span>}
      </div>
      {reason && (
        <div style={{ marginTop: 5, fontSize: 10.5, color: reason === "contradicted" ? theme.waiting : theme.stalled }}>
          Faded: {reason}
        </div>
      )}
      {top.length > 0 && (
        <div style={{ marginTop: 8, borderTop: `1px solid ${theme.edgeSoft}`, paddingTop: 6 }}>
          {top.map(([id, rel]) => (
            <div key={id} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 11, marginTop: 2 }}>
              <span style={{ width: 10, height: 2, background: EDGE_COLOR[rel.kind] ?? theme.dim, flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: 0, color: theme.dim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {nodeById.get(id)?.title ?? id}
              </span>
            </div>
          ))}
        </div>
      )}
      <div style={{ marginTop: 7, fontSize: 10, color: theme.faint }}>Click to open</div>
    </div>
  );
}

function NodeDetail({
  node,
  neighborIds,
  neighborRel,
  nodeById,
  projects,
  hops,
  onHops,
  onPick,
  onClose,
}: {
  node: GraphNode;
  neighborIds: string[];
  neighborRel: Map<string, NeighborRelation>;
  nodeById: Map<string, GraphNode>;
  projects: ProjectWithCounts[];
  // Neighborhood mode: 0 shows the whole graph, 1 or 2 only this doc's hops.
  hops: number;
  onHops: (hops: number) => void;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const themeName = useThemeName();
  const reason = deemphasisReason(node);
  const [body, setBody] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setBody(null);
    fetch(docDetailUrl(node.projectId, node.slug))
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setBody(d?.body ?? null))
      .catch(() => setBody(null))
      .finally(() => setLoading(false));
  }, [node.projectId, node.slug]);

  return (
    <div
      style={{
        width: "clamp(400px, 40vw, 640px)",
        flexShrink: 0,
        borderLeft: `1px solid ${theme.edge}`,
        background: theme.surface,
        overflowY: "auto",
        padding: "16px 22px",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span
          style={{
            fontFamily: theme.mono,
            fontSize: 9,
            color: projectColor(node.projectId, projects, themeName),
            border: `1px solid ${hexAlpha(projectColor(node.projectId, projects, themeName), 0x66)}`,
            borderRadius: 3,
            padding: "1px 5px",
          }}
        >
          {projectName(node.projectId, projects)}
        </span>
        <span style={{ flex: 1 }} />
        <button
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            color: theme.faint,
            cursor: "pointer",
            fontSize: 13,
          }}
        >
          ✕
        </button>
      </div>
      <div style={{ fontSize: 16.5, fontWeight: 700, color: theme.text, marginTop: 8, lineHeight: 1.35 }}>
        {node.title}
      </div>
      <div style={{ fontFamily: theme.mono, fontSize: 10.5, color: theme.faint, marginTop: 4 }}>
        {node.slug}.md · {node.originClass}
      </div>
      <div style={{ fontSize: 11.5, color: theme.dim, marginTop: 6 }}>
        {[node.layer ? LAYER_LABELS[node.layer] : null, node.sourceKind !== "unclassified" ? node.sourceKind : null, confidenceText(node)]
          .filter(Boolean)
          .join(" · ")}
        {reason && (
          <span style={{ color: reason === "contradicted" ? theme.waiting : theme.stalled }}> · faded: {reason}</span>
        )}
      </div>

      <div style={{ ...label, marginTop: 14, marginBottom: 6 }}>Neighborhood</div>
      <div style={{ maxWidth: 260 }}>
        <Segmented
          value={String(hops) as "0" | "1" | "2"}
          options={[
            ["0", "Whole graph"],
            ["1", "1 hop"],
            ["2", "2 hops"],
          ]}
          onChange={(v) => onHops(Number(v))}
        />
      </div>

      <div style={{ ...label, marginTop: 16, marginBottom: 6 }}>
        {neighborIds.length} neighbor{neighborIds.length === 1 ? "" : "s"}
      </div>
      {neighborIds.length === 0 ? (
        <div style={{ fontSize: 11.5, color: theme.faint, lineHeight: 1.5 }}>
          No graph edges — no related links or co-citations reach this doc yet.
        </div>
      ) : (
        [...neighborIds]
          .sort((a, b) => {
            // Lower sorts first: the conflict, then authored/derived links, then
            // the inferred semantic de-float link last.
            const rank = { contradicts: 0, related: 1, "co-citation": 2, provenance: 3, "semantic-similarity": 4 } as const;
            const ra = rank[neighborRel.get(a)?.kind ?? "provenance"];
            const rb = rank[neighborRel.get(b)?.kind ?? "provenance"];
            if (ra !== rb) return ra - rb;
            return (nodeById.get(a)?.title ?? "").localeCompare(nodeById.get(b)?.title ?? "");
          })
          .map((id) => {
            const nb = nodeById.get(id);
            if (!nb) return null;
            const rel = neighborRel.get(id);
            const kind = rel?.kind;
            // The relation's substance, shown under the title so the row reads
            // WHY the docs are linked — "shared tags: …", the dispute finding —
            // with the edge weight, not just the colored kind chip.
            const why = rel?.evidence
              ? rel.weight
                ? `${rel.evidence} · w${rel.weight}`
                : rel.evidence
              : null;
            // Flag a neighbor a pivot should distrust: the coherence pass marked
            // it contradicted, re-verification disputed it, or its origin is not
            // auto-injection eligible. Search/graph surface every doc, but the
            // reader must not silently treat a poisoned neighbor as authoritative.
            const trust =
              nb.verdict === "contradicted"
                ? { label: "contradicted", color: theme.waiting }
                : nb.verdict === "disputed"
                  ? { label: "disputed", color: theme.stalled }
                  : nb.originClass === "untrusted" || nb.originClass === "system"
                    ? { label: "untrusted", color: theme.waiting }
                    : null;
            return (
              <button
                key={id}
                onClick={() => onPick(id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  width: "100%",
                  textAlign: "left",
                  background: "none",
                  border: "none",
                  borderRadius: 5,
                  padding: "5px 6px",
                  marginLeft: -6,
                  cursor: "pointer",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = theme.raised)}
                onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
              >
                <span
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: "50%",
                    background: projectColor(nb.projectId, projects, themeName),
                    flexShrink: 0,
                  }}
                />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span
                    style={{
                      display: "block",
                      fontSize: 13,
                      color: theme.text,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {nb.title}
                  </span>
                  {why && (
                    <span
                      style={{
                        display: "block",
                        fontSize: 10.5,
                        color: theme.faint,
                        lineHeight: 1.4,
                        marginTop: 1,
                      }}
                    >
                      {why.length > 160 ? `${why.slice(0, 159)}…` : why}
                    </span>
                  )}
                </span>
                {trust && (
                  <span
                    style={{
                      fontFamily: theme.mono,
                      fontSize: 8.5,
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                      color: trust.color,
                      border: `1px solid ${alpha(trust.color, 0x66)}`,
                      borderRadius: 3,
                      padding: "1px 5px",
                      flexShrink: 0,
                    }}
                    title="Distrust this neighbor when pivoting — it is contradicted, disputed, or of untrusted origin"
                  >
                    {trust.label}
                  </span>
                )}
                {kind && (
                  <span
                    style={{
                      fontFamily: theme.mono,
                      fontSize: 8.5,
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                      color: EDGE_COLOR[kind] ?? theme.faint,
                      border: `1px solid ${alpha(EDGE_COLOR[kind] ?? theme.edge, 0x55)}`,
                      borderRadius: 3,
                      padding: "1px 5px",
                      flexShrink: 0,
                    }}
                  >
                    {kind}
                  </span>
                )}
              </button>
            );
          })
      )}

      <div style={{ ...label, marginTop: 16, marginBottom: 6 }}>Doc</div>
      {loading ? (
        <div style={{ fontSize: 11.5, color: theme.faint }}>Loading…</div>
      ) : body === null ? (
        <div style={{ fontSize: 11.5, color: theme.faint }}>Couldn't load this doc.</div>
      ) : (
        <div style={{ fontSize: 13.5, color: theme.dim, lineHeight: 1.65 }}>
          <Markdown>{body}</Markdown>
        </div>
      )}
    </div>
  );
}

// ── Health ──────────────────────────────────────────────────────────────────

function HealthTab({
  scope,
  projects,
}: {
  scope: string;
  projects: ProjectWithCounts[];
}) {
  const themeName = useThemeName();
  const [stats, setStats] = useState<StatsData | null>(null);
  const [evalData, setEvalData] = useState<EvalData | null>(null);
  const [loading, setLoading] = useState(true);
  // The eval is a fixed cross-project fixture set — it isn't scoped, and it's
  // the slower call (it runs live retrieval), so fetch it once and let a scope
  // change refetch only the cheap stats.
  const evalLoaded = useRef(false);

  const loadStats = useCallback(() => {
    const qs = scope ? `?projectId=${encodeURIComponent(scope)}` : "";
    return fetch(`/api/knowledge/stats${qs}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setStats(d))
      .catch(() => setStats(null));
  }, [scope]);

  useEffect(() => {
    setLoading(true);
    const jobs: Promise<unknown>[] = [loadStats()];
    if (!evalLoaded.current) {
      evalLoaded.current = true;
      jobs.push(
        fetch("/api/knowledge/eval")
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => setEvalData(d))
          .catch(() => setEvalData(null))
      );
    }
    void Promise.all(jobs).finally(() => setLoading(false));
  }, [loadStats]);

  if (loading && !stats) return <Centered>Loading health…</Centered>;
  if (!stats) return <Centered>Couldn't load knowledge stats.</Centered>;

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "18px 20px 28px" }}>
      <div style={{ ...label, marginBottom: 10 }}>Corpus</div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
          gap: 10,
          marginBottom: 22,
        }}
      >
        <Tile label="Docs" value={stats.docs} />
        <Tile label="Chunks" value={stats.chunks} />
        <Tile
          label="Embedded coverage"
          value={`${stats.coveragePct.toFixed(0)}%`}
          sub={`${stats.embeddedDocs}/${stats.docs} docs`}
        />
        <Tile label="Edges" value={stats.edges} sub={`${stats.edgesPerDoc.toFixed(2)}/doc`} />
        <Tile label="Provider" value={stats.provider ?? "none"} sub={stats.model ?? "FTS-only"} />
        <Tile
          label="Dimensions"
          value={stats.dimensions ?? "—"}
          sub={stats.dimensions ? "per embedding" : "nothing embedded"}
        />
      </div>

      <div style={{ ...label, marginBottom: 10 }}>Origin class</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 22 }}>
        {Object.keys(stats.originClassBreakdown).length === 0 ? (
          <div style={{ fontSize: 12, color: theme.faint }}>No docs yet.</div>
        ) : (
          Object.entries(stats.originClassBreakdown).map(([cls, n]) => (
            <div
              key={cls}
              style={{
                background: theme.surface,
                border: `1px solid ${theme.edgeSoft}`,
                borderRadius: 6,
                padding: "6px 11px",
                fontSize: 12,
              }}
            >
              <span style={{ color: theme.text, fontWeight: 700 }}>{n}</span>{" "}
              <span style={{ color: theme.faint }}>{cls}</span>
            </div>
          ))
        )}
      </div>

      {/* Retrieval quality — the "how useful is the knowledge system" answer,
          measured live over the labeled fixtures rather than judged by hand. */}
      <div style={{ ...label, marginBottom: 10 }}>Retrieval quality</div>
      {!evalData ? (
        <div style={{ fontSize: 12, color: theme.faint }}>
          {loading ? "Running the eval fixtures…" : "Eval unavailable."}
        </div>
      ) : (
        <div
          style={{
            background: theme.surface,
            border: `1px solid ${theme.edgeSoft}`,
            borderRadius: 8,
            padding: "14px 16px",
          }}
        >
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
            <MetricBar
              label={`recall@${evalData.k}`}
              value={evalData.recallAtK}
              color={theme.checkpoint}
            />
            <MetricBar label="top-1" value={evalData.top1} color={theme.running} />
            <div style={{ minWidth: 90 }}>
              <div style={{ fontSize: 22, fontWeight: 700, color: theme.text }}>
                {evalData.total}
              </div>
              <div style={{ fontSize: 11, color: theme.faint }}>fixtures</div>
            </div>
          </div>

          {/* Per-fixture strip: one cell per fixture, green = the expected doc
              was recalled in the top-k, red = missed. A quick read on where
              retrieval is weak (paraphrase queries historically lagged). */}
          <div style={{ marginTop: 16 }}>
            <div style={{ ...label, marginBottom: 6 }}>Per-fixture recall</div>
            <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
              {evalData.perFixture.map((f, i) => (
                <span
                  key={i}
                  title={`${f.query}\n${f.kind} · ${
                    f.hitAtK ? `hit @ rank ${f.rank}` : "missed"
                  }`}
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: 3,
                    background: f.hitAtK ? theme.checkpoint : theme.waiting,
                    opacity: f.hitTop1 ? 1 : f.hitAtK ? 0.55 : 0.8,
                    border: f.kind === "paraphrase" ? `1px solid ${alpha(theme.text, 0x55)}` : "none",
                    boxSizing: "border-box",
                  }}
                />
              ))}
            </div>
            <div style={{ fontSize: 10.5, color: theme.faint, marginTop: 8, lineHeight: 1.5 }}>
              Full = top-1 hit · faded = recalled below rank 1 · red = missed ·
              outlined = paraphrase query.
            </div>
          </div>
        </div>
      )}

      {/* Per-project breakdown, only meaningful unscoped or with several. */}
      {stats.perProject.length > 1 && (
        <>
          <div style={{ ...label, marginTop: 22, marginBottom: 10 }}>By project</div>
          <div style={{ display: "grid", gap: 6 }}>
            {stats.perProject.map((p) => (
              <div
                key={p.projectId}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  background: theme.surface,
                  border: `1px solid ${theme.edgeSoft}`,
                  borderRadius: 6,
                  padding: "8px 11px",
                  fontSize: 12,
                }}
              >
                <span
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: "50%",
                    background: projectColor(p.projectId, projects, themeName),
                    flexShrink: 0,
                  }}
                />
                <span style={{ color: theme.text, fontWeight: 600, minWidth: 120 }}>
                  {projectName(p.projectId, projects)}
                </span>
                <span style={{ color: theme.dim }}>{p.docs} docs</span>
                <span style={{ color: theme.dim }}>{p.chunks} chunks</span>
                <span style={{ color: theme.dim }}>{p.coveragePct.toFixed(0)}% embedded</span>
                <span style={{ color: theme.dim }}>{p.edges} edges</span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Retrieval usage — which docs actually get retrieved, and of those how
          many rode into an agent (injected into a launch prompt) vs were
          retrieved but dropped (squeezed out by a launch's char budget). The
          injected-vs-dropped split
          surfaces low-yield docs that keep surfacing yet rarely make the cut.
          A `search`-surface retrieval only ranks, so it counts toward neither
          half — the two need not sum to the retrieval count. */}
      {(stats.retrievalUsage ?? []).length > 0 && (
        <>
          <div style={{ ...label, marginTop: 22, marginBottom: 10 }}>Retrieval usage</div>
          <div style={{ display: "grid", gap: 6 }}>
            {(stats.retrievalUsage ?? []).slice(0, 20).map((u) => (
              <div
                key={`${u.docProject}/${u.docSlug}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  background: theme.surface,
                  border: `1px solid ${theme.edgeSoft}`,
                  borderRadius: 6,
                  padding: "8px 11px",
                  fontSize: 12,
                }}
              >
                <span
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: "50%",
                    background: projectColor(u.docProject, projects, themeName),
                    flexShrink: 0,
                  }}
                />
                <span
                  title={`${projectName(u.docProject, projects)} · ${u.docSlug}`}
                  style={{
                    color: theme.text,
                    fontWeight: 600,
                    minWidth: 160,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {u.docSlug}
                </span>
                <span style={{ color: theme.dim }}>{u.retrievals} retrievals</span>
                <span style={{ color: theme.checkpoint }}>{u.injected} injected</span>
                <span style={{ color: theme.faint }}>{u.dropped} dropped</span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Usage health — docs nothing used in the window or no agent opened
          after retrieving them, the largest retrieval hubs, and returned vs
          gated rows per knowledge layer. */}
      {stats.usageHealth && (
        <>
          <div style={{ ...label, marginTop: 22, marginBottom: 10 }}>Usage health</div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
              gap: 10,
            }}
          >
            <Tile
              label={`Unused ${stats.usageHealth.windowDays}d`}
              value={stats.usageHealth.neverRetrievedCount}
              sub={`of ${stats.usageHealth.docs} docs`}
            />
            <Tile label="Never opened" value={stats.usageHealth.neverCitedCount} sub="after retrieval" />
            <Tile
              label="Top hub"
              value={stats.usageHealth.hubs[0] ? `${(stats.usageHealth.hubs[0].share * 100).toFixed(0)}%` : "—"}
              sub={stats.usageHealth.hubs[0]?.slug ?? "no retrievals"}
            />
          </div>
          {(stats.retrievalBreakdown?.byLayer ?? []).length > 0 && (
            <div style={{ display: "grid", gap: 6, marginTop: 10 }}>
              {stats.retrievalBreakdown!.byLayer.map((r) => (
                <div
                  key={`${r.layer}/${r.surface}`}
                  style={{
                    display: "flex",
                    gap: 10,
                    background: theme.surface,
                    border: `1px solid ${theme.edgeSoft}`,
                    borderRadius: 6,
                    padding: "6px 11px",
                    fontSize: 12,
                  }}
                >
                  <span style={{ color: theme.text, fontWeight: 600, minWidth: 120 }}>
                    {r.layer} · {r.surface}
                  </span>
                  <span style={{ color: theme.dim }}>{r.returned} returned</span>
                  <span style={{ color: theme.faint }}>{r.gated} gated</span>
                  <span style={{ color: theme.dim }}>{r.docs} docs</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Tile({
  label: lbl,
  value,
  sub,
}: {
  label: string;
  value: number | string;
  sub?: string;
}) {
  return (
    <div
      style={{
        background: theme.surface,
        border: `1px solid ${theme.edgeSoft}`,
        borderRadius: 8,
        padding: "11px 13px",
      }}
    >
      <div style={{ fontSize: 22, fontWeight: 700, color: theme.text }}>{value}</div>
      <div style={{ fontSize: 11, color: theme.faint, marginTop: 2 }}>{lbl}</div>
      {sub && <div style={{ fontSize: 10.5, color: theme.dim, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function MetricBar({
  label: lbl,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  const pct = Math.round(value * 100);
  return (
    <div style={{ minWidth: 150 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
        <span style={{ fontSize: 22, fontWeight: 700, color: theme.text }}>{pct}%</span>
        <span style={{ fontSize: 11, color: theme.faint }}>{lbl}</span>
      </div>
      <div
        style={{
          marginTop: 5,
          height: 6,
          borderRadius: 3,
          background: theme.raised,
          overflow: "hidden",
        }}
      >
        <div style={{ width: `${pct}%`, height: "100%", background: color }} />
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: theme.dim,
        fontFamily: theme.sans,
        fontSize: 13,
        padding: 20,
        textAlign: "center",
      }}
    >
      {children}
    </div>
  );
}
