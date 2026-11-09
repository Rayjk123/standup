import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { LuArrowLeft } from "react-icons/lu";
import { alpha, theme } from "./theme";
import { Markdown } from "./Markdown";
import { lineDiff } from "@standup/shared";
import {
  type DocScope,
  type ProjectScope,
  DOC_SCOPES,
  DOC_SCOPE_LABELS,
  PROJECT_SCOPES,
  PROJECT_SCOPE_LABELS,
  docScopeValue,
  projectScopeValue,
  buildDocSavePayload,
} from "../lib/knowledgeScope";
import {
  findDocBySlug,
  cardOpensOnEnter,
  stopCardOpenPropagation,
} from "../lib/knowledgeInspect";
import { signalTargets } from "../lib/signal";

/** Mirrors Staleness in packages/collector/src/knowledge-staleness.ts. Null
 *  means the doc has no generated_from_sha — human-authored, no opinion. */
interface Staleness {
  sha: string;
  reachable: boolean;
  commitsSince: number | null;
  filesChanged: number | null;
  stale: boolean;
}

interface KnowledgeDoc {
  slug: string;
  title: string;
  body: string;
  tags: string[];
  updatedAt: string;
  generatedFromSha?: string;
  generatedAt?: string;
  // Optional, not just nullable: DocEditor constructs a KnowledgeDoc-shaped
  // object for an in-review draft without ever fetching staleness for it.
  staleness?: Staleness | null;
  // Re-verification state (roadmap r5), surfaced from the DB index by GET
  // /api/projects/:id/knowledge. currentConfidence is the derived (decayed)
  // value; verdict/disputes are the last automatic pass's result. A doc the
  // cron REFUTED (verdict "disputed", confidence written below the floor) is
  // gated out of agent auto-injection, so a human needs to see why here — the
  // one recovery action (edit to re-assert) is a click into this same card.
  currentConfidence?: number;
  verdict?: DraftVerdict;
  disputes?: DraftDispute[];
  // Source kind (roadmap r2/r8). Surfaced from GET /api/projects/:id/knowledge
  // (which spreads the doc) so the editor can show and reclassify it. Absent
  // reads as 'unclassified'.
  sourceKind?: SourceKind;
  // Scope + owning user (per-user knowledge). Surfaced from the same list route
  // so the editor can show the doc's current provenance and let the user
  // promote/rescope it. Absent scope reads as 'project'; ownerUser names the
  // owner of a 'user'-scoped doc (read-only in the UI — the server owns it).
  scope?: DocScope;
  ownerUser?: string;
}

interface SearchResult {
  // Stable doc id — the React key. Two projects can hold docs with the same
  // slug, so slug is not unique across a cross-project result set; id is.
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  score: number;
  source: "text" | "embedding";
}

/**
 * A cross-project graph neighbor of a doc (Phase 6/7 — Concept 2). Mirrors
 * KnowledgeNeighbor in @standup/knowledge; kept local since web depends only on
 * @standup/shared. `projectId` is carried so a neighbor in ANOTHER project can
 * be labeled as such — the whole point of the cross-project graph.
 */
interface KnowledgeNeighbor {
  docId: string;
  projectId: string;
  slug: string;
  title: string;
  kind: "related" | "co-citation" | "provenance" | "contradicts";
  weight: number;
  // Trust signals carried so a pivot into a neighbor is labeled, not silent:
  // originClass gates auto-injection eligibility, verdict is the coherence /
  // fact-check outcome.
  originClass?: OriginClass;
  verdict?: DraftVerdict;
  sourceKind?: SourceKind;
}

interface DraftDispute {
  claim: string;
  finding: string;
  evidence: string;
}

type DraftVerdict = "unverified" | "unverifiable" | "clean" | "disputed" | "error" | "contradicted";

/**
 * Trust class of a doc's origin, mirrored from @standup/knowledge's OriginClass.
 * owner/agent are auto-injection eligible; untrusted/system are not.
 */
type OriginClass = "owner" | "agent" | "untrusted" | "system";

/**
 * Source-kind dimension (roadmap r2/r8), mirrored from @standup/knowledge's
 * SourceKind — web depends only on @standup/shared, so it is redeclared here.
 * product/spec docs are the ones injected as product context at launch time, so
 * this selector is how a reviewer classifies a doc into that set.
 */
type SourceKind =
  | "code"
  | "product"
  | "spec"
  | "decision"
  | "runbook"
  | "native-memory"
  | "playbook"
  | "unclassified";
/**
 * The kinds a reviewer may pick; `native-memory` is stamped only by the mirror
 * ingest and `playbook` only by Persona.
 */
const SOURCE_KINDS: SourceKind[] = ["unclassified", "code", "product", "spec", "decision", "runbook"];

interface Draft {
  slug: string;
  title: string;
  body: string;
  tags?: string[];
  updatedAt: string;
  generatedFromSha?: string;
  generatedAt?: string;
  generatedByLaunchId?: string;
  replacesSlug?: string;
  verdict: DraftVerdict;
  disputes: DraftDispute[];
  launchSessionId?: string | null;
  // Source kind (roadmap r2/r8), surfaced from the drafts route so a reviewer
  // can classify a draft as product/spec before accepting it.
  sourceKind?: SourceKind;
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

const smallButton: React.CSSProperties = {
  fontSize: 11.5,
  fontWeight: 600,
  border: `1px solid ${theme.edge}`,
  borderRadius: 5,
  padding: "5px 10px",
  cursor: "pointer",
  background: "none",
  color: theme.text,
};

const VERDICT_STYLE: Record<DraftVerdict, { color: string; label: string }> = {
  unverified: { color: theme.faint, label: "not yet fact-checked" },
  unverifiable: { color: theme.faint, label: "unverifiable · no repo to check against" },
  clean: { color: theme.checkpoint, label: "fact-checked · clean" },
  disputed: { color: theme.waiting, label: "fact-checked · disputed" },
  error: { color: theme.stalled, label: "fact-check failed to run" },
  contradicted: { color: theme.waiting, label: "contradicts another doc" },
};

/** "3h ago", "2d ago" — coarse on purpose, this is provenance context, not a clock. */
function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * View, edit, add and search a project's knowledge — and review the drafts a
 * bootstrap run proposes before any of it becomes searchable.
 *
 * Knowledge was previously only editable as files on disk, which made the
 * one part of the system that depends on a human writing it the least
 * convenient thing to write. The search box matters as much as the editor:
 * it's how you check what an agent will actually retrieve before trusting
 * that it will.
 */
export function KnowledgePanel({
  projectId,
  repos = [],
  knowledgeScope,
  draftSignal,
  openSlug,
  onOpenConsumed,
}: {
  projectId: string;
  repos?: string[];
  // The project's stored default knowledge scope (undefined = no override).
  // Editable here via the small project-default control; a change PATCHes the
  // project and updates the local copy.
  knowledgeScope?: ProjectScope;
  draftSignal?: { projectId: string; n: number };
  // A doc to open on arrival — set when a cross-project browse result routes
  // here to inspect one specific doc. Opens the same detail (DocEditor) a card
  // click opens, once the list has loaded; onOpenConsumed then clears the
  // intent so closing the detail returns to the list rather than reopening it.
  openSlug?: string;
  onOpenConsumed?: () => void;
}) {
  const navigate = useNavigate();
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [editing, setEditing] = useState<KnowledgeDoc | null>(null);
  const [editingDraftSlug, setEditingDraftSlug] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  // Cross-project graph neighbors per doc id, loaded on demand from the "related"
  // affordance; the set tracks which are open (undefined = not yet loaded).
  const [neighbors, setNeighbors] = useState<Record<string, KnowledgeNeighbor[]>>({});
  const [neighborsOpen, setNeighborsOpen] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Which draft (if any) is mid-merge, and the editable combined text for it.
  const [mergeSlug, setMergeSlug] = useState<string | null>(null);
  const [mergeText, setMergeText] = useState("");
  const [draftBusy, setDraftBusy] = useState<Set<string>>(new Set());
  const [draftErrors, setDraftErrors] = useState<Record<string, string>>({});
  const [acceptAllNote, setAcceptAllNote] = useState<string | null>(null);

  // Which draft (if any) has its feedback box open, and the feedback text.
  const [reviseSlug, setReviseSlug] = useState<string | null>(null);
  const [feedbackText, setFeedbackText] = useState("");
  // slug → the revise launch id we're waiting on. While a slug is here, the
  // draft shows "revising…"; it clears when the reloaded draft carries that
  // launch id (the revision landed) or the draft is gone.
  const [revisePending, setRevisePending] = useState<Record<string, string>>({});

  const [bootstrapBusy, setBootstrapBusy] = useState(false);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [bootstrapNote, setBootstrapNote] = useState<string | null>(null);

  // The project's default knowledge scope, seeded from the prop and kept in
  // sync so the control reflects an in-place change without a full projects
  // refetch. Re-seeded when the panel switches projects (the prop changes).
  const [projectScope, setProjectScope] = useState<ProjectScope>(
    projectScopeValue(knowledgeScope)
  );
  const [projectScopeBusy, setProjectScopeBusy] = useState(false);
  useEffect(() => {
    setProjectScope(projectScopeValue(knowledgeScope));
  }, [knowledgeScope, projectId]);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/knowledge`);
      if (res.ok) setDocs(await res.json());
    } catch {
      /* leave the previous list rather than blanking it */
    }
  }, [projectId]);

  const loadDrafts = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/knowledge/drafts`);
      if (res.ok) setDrafts(await res.json());
    } catch {
      /* leave the previous list rather than blanking it */
    }
  }, [projectId]);

  useEffect(() => {
    setEditing(null);
    setEditingDraftSlug(null);
    setCreating(false);
    setResults(null);
    setQuery("");
    setMergeSlug(null);
    void load();
    void loadDrafts();
  }, [load, loadDrafts]);

  // A bootstrap run proposes drafts one at a time as it works — this is what
  // makes the list fill in live instead of only appearing once the whole run
  // finishes and the tab happens to be reopened.
  useEffect(() => {
    if (draftSignal && signalTargets(draftSignal.projectId, projectId) && draftSignal.n > 0) {
      void loadDrafts();
      void load();
    }
  }, [draftSignal, projectId, load, loadDrafts]);

  // Covers a draft disappearing out from under an open editor — accepted or
  // discarded from another tab, or by a live bootstrap resync — so the panel
  // falls back to the list instead of showing a stale editor for a draft
  // that no longer exists.
  useEffect(() => {
    if (editingDraftSlug && !drafts.some((d) => d.slug === editingDraftSlug)) {
      setEditingDraftSlug(null);
    }
  }, [drafts, editingDraftSlug]);

  // Stop showing "revising…" once the revision lands (a reloaded draft now
  // carries the revise launch's id) or the draft is gone (accepted/discarded).
  // Driven off the draft list rather than a timer, same as the live-fill above.
  useEffect(() => {
    setRevisePending((prev) => {
      if (Object.keys(prev).length === 0) return prev;
      let changed = false;
      const next = { ...prev };
      for (const slug of Object.keys(prev)) {
        const d = drafts.find((x) => x.slug === slug);
        if (!d || d.generatedByLaunchId === prev[slug]) {
          delete next[slug];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [drafts]);

  // Open a specific doc's detail when a cross-project browse result routed here
  // to inspect it. Waits for the doc list to load, opens the same editor a card
  // click opens over the resolved doc, then clears the intent so closing the
  // detail returns to the list instead of reopening it.
  useEffect(() => {
    if (!openSlug) return;
    const doc = findDocBySlug(docs, openSlug);
    if (!doc) return;
    setEditing(doc);
    onOpenConsumed?.();
  }, [openSlug, docs, onOpenConsumed]);

  async function save(doc: {
    slug: string;
    title: string;
    body: string;
    tags: string;
    sourceKind: SourceKind;
    scope?: DocScope;
  }) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/projects/${projectId}/knowledge/${encodeURIComponent(doc.slug)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            buildDocSavePayload({
              title: doc.title,
              body: doc.body,
              tags: doc.tags,
              sourceKind: doc.sourceKind,
              scope: doc.scope,
            })
          ),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Save failed");
        return;
      }
      setEditing(null);
      setCreating(false);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function remove(slug: string) {
    setBusy(true);
    try {
      await fetch(`/api/projects/${projectId}/knowledge/${encodeURIComponent(slug)}`, {
        method: "DELETE",
      });
      setEditing(null);
      await load();
    } finally {
      setBusy(false);
    }
  }

  // Persist the project's default knowledge scope via the projects PATCH — the
  // scope new docs take when their author asserts none. Optimistically reflect
  // the choice, then reconcile from the server's echoed value; revert on failure
  // so the control never shows a default that didn't stick.
  async function saveProjectScope(next: ProjectScope) {
    const prev = projectScope;
    setProjectScope(next);
    setProjectScopeBusy(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ knowledgeScope: next }),
      });
      if (!res.ok) {
        setProjectScope(prev);
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { knowledgeScope?: ProjectScope };
      setProjectScope(projectScopeValue(data.knowledgeScope));
    } catch {
      setProjectScope(prev);
    } finally {
      setProjectScopeBusy(false);
    }
  }

  async function search() {
    if (!query.trim()) {
      setResults(null);
      return;
    }
    const res = await fetch("/api/knowledge/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // This panel is scoped to one project — it presents itself as "this
      // project's knowledge". The server's default corpus is "all" (the
      // cross-project agent recall), so the scope must be requested
      // explicitly here, or a sibling project's docs would surface unlabeled
      // inside what reads as the project's own search.
      body: JSON.stringify({ cwd: "", project: projectId, query, corpus: "project" }),
    });
    const data = await res.json();
    setResults(data.results ?? []);
  }

  // Toggle a result's cross-project graph neighbors, fetching them lazily the
  // first time. The endpoint recompiles edges on read, so this reflects current
  // markdown + provenance without a restart.
  async function toggleNeighbors(docId: string) {
    setNeighborsOpen((prev) => {
      const next = new Set(prev);
      if (next.has(docId)) next.delete(docId);
      else next.add(docId);
      return next;
    });
    if (neighbors[docId] !== undefined) return;
    try {
      const res = await fetch("/api/knowledge/neighbors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ docId }),
      });
      const data = await res.json();
      setNeighbors((prev) => ({ ...prev, [docId]: data.neighbors ?? [] }));
    } catch {
      setNeighbors((prev) => ({ ...prev, [docId]: [] }));
    }
  }

  function setDraftBusyFlag(slug: string, on: boolean) {
    setDraftBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(slug);
      else next.delete(slug);
      return next;
    });
  }

  async function saveDraftEdit(doc: {
    slug: string;
    title: string;
    body: string;
    tags: string;
    sourceKind: SourceKind;
  }) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/projects/${projectId}/knowledge/drafts/${encodeURIComponent(doc.slug)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: doc.title,
            body: doc.body,
            tags: doc.tags
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean),
            source_kind: doc.sourceKind,
          }),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Save failed");
        return;
      }
      setEditingDraftSlug(null);
      await loadDrafts();
    } finally {
      setBusy(false);
    }
  }

  async function acceptDraft(
    slug: string,
    opts?: { mode?: "merge" | "replace"; body?: string; force?: boolean }
  ) {
    setDraftBusyFlag(slug, true);
    setDraftErrors((prev) => ({ ...prev, [slug]: "" }));
    try {
      const res = await fetch(
        `/api/projects/${projectId}/knowledge/drafts/${encodeURIComponent(slug)}/accept`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(opts ?? {}),
        }
      );
      const data = await res.json().catch(() => ({}));
      // A near-duplicate of an existing doc is kept as a draft and the choice
      // handed back: publish it anyway, or leave it for discarding.
      if (res.status === 409 && data.duplicateOf && !opts?.force) {
        if (window.confirm(`${data.error}\n\nPublish it anyway?`)) {
          setDraftBusyFlag(slug, false);
          await acceptDraft(slug, { ...opts, force: true });
          return;
        }
      }
      if (!res.ok) {
        setDraftErrors((prev) => ({ ...prev, [slug]: data.error ?? "Accept failed" }));
        return;
      }
      setMergeSlug(null);
      await Promise.all([loadDrafts(), load()]);
    } finally {
      setDraftBusyFlag(slug, false);
    }
  }

  async function discardDraft(slug: string) {
    setDraftBusyFlag(slug, true);
    try {
      await fetch(`/api/projects/${projectId}/knowledge/drafts/${encodeURIComponent(slug)}/discard`, {
        method: "POST",
      });
      await loadDrafts();
    } finally {
      setDraftBusyFlag(slug, false);
    }
  }

  async function reviseDraft(slug: string, feedback: string) {
    setDraftBusyFlag(slug, true);
    setDraftErrors((prev) => ({ ...prev, [slug]: "" }));
    try {
      const res = await fetch(
        `/api/projects/${projectId}/knowledge/drafts/${encodeURIComponent(slug)}/revise`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ feedback }),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.launch?.status === "failed") {
        setDraftErrors((prev) => ({
          ...prev,
          [slug]: data.error ?? data.launch?.error ?? "Revise failed to start",
        }));
        return;
      }
      // Remember the launch so we can tell when its revision lands.
      setRevisePending((prev) => ({ ...prev, [slug]: data.launch.id }));
      setReviseSlug(null);
      setFeedbackText("");
    } finally {
      setDraftBusyFlag(slug, false);
    }
  }

  function openMerge(draft: Draft) {
    const original = docs.find((d) => d.slug === draft.replacesSlug)?.body ?? "";
    setMergeSlug(draft.slug);
    setMergeText(
      `${original}\n\n<!-- --- combine with the generated version below, then delete this line and everything after it --- -->\n\n${draft.body}`
    );
  }

  async function acceptAll() {
    setBusy(true);
    setAcceptAllNote(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/knowledge/drafts/accept-all`, {
        method: "POST",
      });
      const data = (await res.json().catch(() => ({}))) as {
        accepted?: string[];
        skipped?: Array<{ slug: string; reason: "replaces" | "disputed" | "duplicate" | "personal" }>;
      };
      const accepted = data.accepted ?? [];
      const skipped = data.skipped ?? [];
      const replaces = skipped.filter((s) => s.reason === "replaces").length;
      const disputed = skipped.filter((s) => s.reason === "disputed").length;
      const duplicate = skipped.filter((s) => s.reason === "duplicate").length;
      const personal = skipped.filter((s) => s.reason === "personal").length;
      const parts: string[] = [`Accepted ${accepted.length}.`];
      if (replaces > 0) {
        parts.push(
          `${replaces} left pending — would replace existing work and needs merge or replace, one at a time.`
        );
      }
      if (disputed > 0) {
        parts.push(`${disputed} left pending — the fact-check disputed something in it.`);
      }
      if (duplicate > 0) {
        parts.push(`${duplicate} left pending — already covered by an existing doc; accept one at a time to publish anyway.`);
      }
      if (personal > 0) {
        parts.push(`${personal} left pending — in the personal layer, which only Persona writes.`);
      }
      setAcceptAllNote(parts.join(" "));
      await Promise.all([loadDrafts(), load()]);
    } finally {
      setBusy(false);
    }
  }

  async function triggerBootstrap() {
    setBootstrapBusy(true);
    setBootstrapError(null);
    setBootstrapNote(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/bootstrap-knowledge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.launch?.status === "failed") {
        setBootstrapError(data.error ?? data.launch?.error ?? "Bootstrap failed to start");
        return;
      }
      setBootstrapNote(
        "Started — drafts will appear below as the agent proposes them. Watch it in Work, or stop it from the launch's session."
      );
    } catch (err) {
      setBootstrapError((err as Error).message);
    } finally {
      setBootstrapBusy(false);
    }
  }

  // Regenerate (phase-7 Step 6) reuses the same bootstrap launch as a fresh
  // run — there's no separate route or in-place update. Because accepted
  // docs already exist, every proposed draft will get replaces_slug set, so
  // review renders as a diff this time. The confirm exists because "possibly
  // outdated" reads as an invitation to click without knowing what happens.
  async function regenerate() {
    if (
      !confirm(
        "This starts a new bootstrap run over the whole project — the same agent run as the Bootstrap button above. " +
          "Nothing changes in place: you'll get new drafts to review, and where one would replace an existing doc, review shows it as a diff."
      )
    ) {
      return;
    }
    await triggerBootstrap();
  }

  if (editing || creating) {
    return (
      <DocEditor
        doc={editing}
        busy={busy}
        error={error}
        defaultScope={projectScope}
        onSave={save}
        onDelete={editing ? () => remove(editing.slug) : undefined}
        onCancel={() => {
          setEditing(null);
          setCreating(false);
          setError(null);
        }}
      />
    );
  }

  const editingDraft = editingDraftSlug
    ? drafts.find((d) => d.slug === editingDraftSlug)
    : undefined;
  if (editingDraft) {
    return (
      <DocEditor
        doc={{
          slug: editingDraft.slug,
          title: editingDraft.title,
          body: editingDraft.body,
          tags: editingDraft.tags ?? [],
          updatedAt: editingDraft.updatedAt,
          sourceKind: editingDraft.sourceKind,
        }}
        busy={busy}
        error={error}
        showScope={false}
        onSave={saveDraftEdit}
        onCancel={() => {
          setEditingDraftSlug(null);
          setError(null);
        }}
      />
    );
  }

  return (
    <div style={{ padding: "16px 20px 24px", overflowY: "auto" }}>
      {/* Bootstrap trigger — explicitly clicked, never automatic. Honest
          about cost since this runs a real agent across the whole repo. */}
      <div
        style={{
          background: theme.surface,
          border: `1px solid ${theme.edgeSoft}`,
          borderRadius: 8,
          padding: "11px 13px",
          marginBottom: 16,
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: theme.text, marginBottom: 3 }}>
            Bootstrap knowledge from the repo
          </div>
          <div style={{ fontSize: 11.5, color: theme.faint, lineHeight: 1.5 }}>
            Reads the repo and drafts ~6 knowledge docs for review. Runs as a
            normal launch, so you can watch and stop it.
            {repos.length > 1 && (
              <>
                {" "}
                Only reads the first of this project's {repos.length} repos (
                <span style={{ fontFamily: theme.mono }}>{repos[0]}</span>).
              </>
            )}
          </div>
          {bootstrapError && (
            <div style={{ fontSize: 11.5, color: theme.waiting, marginTop: 6 }}>
              {bootstrapError}
            </div>
          )}
          {bootstrapNote && (
            <div style={{ fontSize: 11.5, color: theme.checkpoint, marginTop: 6 }}>
              {bootstrapNote}
            </div>
          )}
        </div>
        <button
          onClick={() => void triggerBootstrap()}
          disabled={bootstrapBusy}
          style={{
            fontSize: 12.5,
            fontWeight: 600,
            color: theme.ground,
            background: theme.expert,
            border: "none",
            borderRadius: 6,
            padding: "8px 14px",
            cursor: bootstrapBusy ? "not-allowed" : "pointer",
            opacity: bootstrapBusy ? 0.6 : 1,
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
        >
          {bootstrapBusy ? "Starting…" : "Bootstrap"}
        </button>
      </div>

      {/* Default knowledge scope for THIS project — the scope a new doc takes
          when its author (a human here, or an agent via propose_knowledge)
          asserts none. Per-doc scope always overrides it. */}
      <div
        style={{
          background: theme.surface,
          border: `1px solid ${theme.edgeSoft}`,
          borderRadius: 8,
          padding: "11px 13px",
          marginBottom: 16,
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: theme.text, marginBottom: 3 }}>
            Default scope for new knowledge
          </div>
          <div style={{ fontSize: 11.5, color: theme.faint, lineHeight: 1.5 }}>
            The scope a new doc takes when none is chosen. A per-doc scope always
            wins over this default.
          </div>
        </div>
        <select
          value={projectScope}
          onChange={(e) => void saveProjectScope(e.target.value as ProjectScope)}
          disabled={projectScopeBusy}
          style={{
            ...field,
            width: "auto",
            fontFamily: theme.mono,
            flexShrink: 0,
            cursor: projectScopeBusy ? "not-allowed" : "pointer",
            opacity: projectScopeBusy ? 0.6 : 1,
          }}
        >
          {PROJECT_SCOPES.map((s) => (
            <option key={s} value={s}>
              {PROJECT_SCOPE_LABELS[s]}
            </option>
          ))}
        </select>
      </div>

      {/* Drafts — shown only when there's something to review. Never
          searchable (knowledge_drafts has no path into search), so this is
          the only place they're visible at all. */}
      {drafts.length > 0 && (
        <div style={{ marginBottom: 22 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 8,
            }}
          >
            <div style={label}>
              {drafts.length} draft{drafts.length === 1 ? "" : "s"} awaiting review
            </div>
            <span style={{ flex: 1 }} />
            <button onClick={() => void acceptAll()} disabled={busy} style={smallButton}>
              Accept all
            </button>
          </div>
          {acceptAllNote && (
            <div style={{ fontSize: 11.5, color: theme.dim, marginBottom: 8, lineHeight: 1.5 }}>
              {acceptAllNote}
            </div>
          )}

          {drafts.map((draft) => {
            const busyThis = draftBusy.has(draft.slug);
            const verdict = VERDICT_STYLE[draft.verdict];
            const original = draft.replacesSlug
              ? docs.find((d) => d.slug === draft.replacesSlug)?.body ?? ""
              : null;

            return (
              <div
                key={draft.slug}
                style={{
                  background: theme.surface,
                  border: `1px solid ${draft.verdict === "disputed" ? theme.waiting : theme.edgeSoft}`,
                  borderRadius: 8,
                  padding: "12px 14px",
                  marginBottom: 10,
                }}
              >
                <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                  <span style={{ fontSize: 13.5, fontWeight: 700, color: theme.text }}>
                    {draft.title}
                  </span>
                  <span style={{ fontFamily: theme.mono, fontSize: 10, color: theme.faint }}>
                    {draft.slug}.md
                  </span>
                  {draft.replacesSlug && (
                    <span
                      title="An accepted doc with this slug already exists — accepting needs a merge or replace decision"
                      style={{
                        fontFamily: theme.mono,
                        fontSize: 9,
                        color: theme.stalled,
                        border: `1px solid ${alpha(theme.stalled, 0x44)}`,
                        borderRadius: 3,
                        padding: "1px 5px",
                      }}
                    >
                      would replace {draft.replacesSlug}.md
                    </span>
                  )}
                  <span style={{ flex: 1 }} />
                  <span style={{ fontSize: 10.5, fontWeight: 600, color: verdict.color }}>
                    {verdict.label}
                  </span>
                </div>

                <div style={{ fontSize: 11, color: theme.faint, marginTop: 4 }}>
                  generated{draft.generatedFromSha ? ` from ${draft.generatedFromSha.slice(0, 7)}` : ""}
                  {draft.generatedAt ? `, ${timeAgo(draft.generatedAt)}` : ""}
                  {draft.launchSessionId && (
                    <>
                      {" · "}
                      <button
                        onClick={() => navigate(`/work/s/${draft.launchSessionId}`)}
                        style={{
                          background: "none",
                          border: "none",
                          padding: 0,
                          font: "inherit",
                          color: theme.running,
                          cursor: "pointer",
                        }}
                      >
                        view launch
                      </button>
                    </>
                  )}
                </div>

                {draft.disputes.length > 0 && (
                  <div
                    style={{
                      marginTop: 9,
                      background: theme.ground,
                      border: `1px solid ${alpha(theme.waiting, 0x44)}`,
                      borderRadius: 6,
                      padding: "8px 10px",
                    }}
                  >
                    <div style={{ fontSize: 10.5, fontWeight: 700, color: theme.waiting, marginBottom: 6 }}>
                      Disputed by fact-check — re-run the command yourself before trusting either side
                    </div>
                    {draft.disputes.map((d, i) => (
                      <div key={i} style={{ marginBottom: i === draft.disputes.length - 1 ? 0 : 8 }}>
                        <div style={{ fontSize: 12, color: theme.text, lineHeight: 1.45 }}>
                          <span style={{ color: theme.faint }}>claims: </span>
                          {d.claim}
                        </div>
                        <div style={{ fontSize: 12, color: theme.text, lineHeight: 1.45 }}>
                          <span style={{ color: theme.faint }}>found: </span>
                          {d.finding}
                        </div>
                        {d.evidence && (
                          <code
                            style={{
                              display: "inline-block",
                              fontFamily: theme.mono,
                              fontSize: 11,
                              color: theme.dim,
                              background: theme.raised,
                              border: `1px solid ${theme.edgeSoft}`,
                              borderRadius: 3,
                              padding: "1px 6px",
                              marginTop: 3,
                            }}
                          >
                            {d.evidence}
                          </code>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                <div style={{ marginTop: 10 }}>
                  {original !== null ? (
                    <LineDiffView oldText={original} newText={draft.body} />
                  ) : (
                    <Markdown>{draft.body}</Markdown>
                  )}
                </div>

                {draftErrors[draft.slug] && (
                  <div style={{ fontSize: 11.5, color: theme.waiting, marginTop: 8 }}>
                    {draftErrors[draft.slug]}
                  </div>
                )}

                {revisePending[draft.slug] ? (
                  <div
                    style={{
                      marginTop: 10,
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      background: theme.ground,
                      border: `1px solid ${alpha(theme.running, 0x44)}`,
                      borderRadius: 6,
                      padding: "8px 10px",
                    }}
                  >
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: theme.running,
                        flexShrink: 0,
                      }}
                    />
                    <span style={{ fontSize: 11.5, color: theme.dim, lineHeight: 1.5, flex: 1 }}>
                      Revising from your feedback — a new agent is rewriting this
                      draft and it'll update here when it lands. Watch it in Work.
                    </span>
                    <button
                      onClick={() =>
                        setRevisePending((prev) => {
                          const next = { ...prev };
                          delete next[draft.slug];
                          return next;
                        })
                      }
                      title="Stop showing this. The revision keeps running; the draft still updates when it lands."
                      style={smallButton}
                    >
                      Dismiss
                    </button>
                  </div>
                ) : mergeSlug === draft.slug ? (
                  <div style={{ marginTop: 10 }}>
                    <span style={label}>
                      Merge into {draft.replacesSlug}.md — edit the two versions into one
                    </span>
                    <textarea
                      value={mergeText}
                      onChange={(e) => setMergeText(e.target.value)}
                      rows={14}
                      style={{
                        ...field,
                        fontFamily: theme.mono,
                        fontSize: 12,
                        lineHeight: 1.55,
                        resize: "vertical",
                      }}
                    />
                    <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                      <button
                        onClick={() => void acceptDraft(draft.slug, { mode: "merge", body: mergeText })}
                        disabled={busyThis || !mergeText.trim()}
                        style={{
                          fontSize: 12.5,
                          fontWeight: 600,
                          color: theme.ground,
                          background: theme.checkpoint,
                          border: "none",
                          borderRadius: 6,
                          padding: "7px 14px",
                          cursor: "pointer",
                          opacity: busyThis ? 0.6 : 1,
                        }}
                      >
                        Save merged doc
                      </button>
                      <button onClick={() => setMergeSlug(null)} style={smallButton}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : reviseSlug === draft.slug ? (
                  <div style={{ marginTop: 10 }}>
                    <span style={label}>Tell the agent what to change</span>
                    <textarea
                      value={feedbackText}
                      onChange={(e) => setFeedbackText(e.target.value)}
                      rows={5}
                      autoFocus
                      placeholder={
                        "e.g. The build command is wrong — verify it against the repo and fix it.\n" +
                        "Drop the section on X; it just restates a single file."
                      }
                      style={{
                        ...field,
                        fontFamily: theme.mono,
                        fontSize: 12,
                        lineHeight: 1.55,
                        resize: "vertical",
                      }}
                    />
                    <div style={{ fontSize: 11, color: theme.faint, marginTop: 5, lineHeight: 1.5 }}>
                      Spins up a fresh agent that rewrites this one draft and
                      re-proposes it. It verifies against the repo, so it can take
                      a few minutes.
                    </div>
                    <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                      <button
                        onClick={() => void reviseDraft(draft.slug, feedbackText)}
                        disabled={busyThis || !feedbackText.trim()}
                        style={{
                          fontSize: 12.5,
                          fontWeight: 600,
                          color: theme.ground,
                          background: theme.expert,
                          border: "none",
                          borderRadius: 6,
                          padding: "7px 14px",
                          cursor: busyThis || !feedbackText.trim() ? "not-allowed" : "pointer",
                          opacity: busyThis || !feedbackText.trim() ? 0.6 : 1,
                        }}
                      >
                        {busyThis ? "Starting…" : "Send to agent"}
                      </button>
                      <button
                        onClick={() => {
                          setReviseSlug(null);
                          setFeedbackText("");
                        }}
                        style={smallButton}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                    {draft.replacesSlug ? (
                      <>
                        <button
                          onClick={() => openMerge(draft)}
                          disabled={busyThis}
                          style={{
                            fontSize: 12.5,
                            fontWeight: 600,
                            color: theme.ground,
                            background: theme.checkpoint,
                            border: "none",
                            borderRadius: 6,
                            padding: "7px 14px",
                            cursor: "pointer",
                            opacity: busyThis ? 0.6 : 1,
                          }}
                        >
                          Accept (merge)
                        </button>
                        <button
                          onClick={() => {
                            if (confirm(`Replace ${draft.replacesSlug}.md entirely with this draft? The current text will be gone.`)) {
                              void acceptDraft(draft.slug, { mode: "replace" });
                            }
                          }}
                          disabled={busyThis}
                          style={smallButton}
                        >
                          Replace instead
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => void acceptDraft(draft.slug)}
                        disabled={busyThis}
                        style={{
                          fontSize: 12.5,
                          fontWeight: 600,
                          color: theme.ground,
                          background: theme.checkpoint,
                          border: "none",
                          borderRadius: 6,
                          padding: "7px 14px",
                          cursor: "pointer",
                          opacity: busyThis ? 0.6 : 1,
                        }}
                      >
                        Accept
                      </button>
                    )}
                    <button
                      onClick={() => setEditingDraftSlug(draft.slug)}
                      disabled={busyThis}
                      style={smallButton}
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => {
                        setReviseSlug(draft.slug);
                        setFeedbackText("");
                        setMergeSlug(null);
                      }}
                      disabled={busyThis}
                      title="Send feedback to a fresh agent that rewrites this draft and re-proposes it"
                      style={smallButton}
                    >
                      Revise
                    </button>
                    <button
                      onClick={() => void discardDraft(draft.slug)}
                      disabled={busyThis}
                      style={{ ...smallButton, color: theme.waiting, borderColor: alpha(theme.waiting, 0x55) }}
                    >
                      Discard
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Search first: checking what agents will retrieve is the more
          frequent task, and it's the only way to verify knowledge is
          reachable rather than merely present. */}
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
          placeholder="Search this project's knowledge as an agent would…"
          style={field}
        />
        <button
          onClick={() => setCreating(true)}
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
          }}
        >
          + New doc
        </button>
      </div>

      {results !== null && (
        <div style={{ marginBottom: 18 }}>
          <div style={{ ...label, marginBottom: 8 }}>
            {results.length} result{results.length === 1 ? "" : "s"} for “{query}”
          </div>
          {results.length === 0 ? (
            <div style={{ fontSize: 12.5, color: theme.faint, lineHeight: 1.5 }}>
              Nothing matched. An agent asking this would get nothing back —
              worth adding a doc, or rewording the one that should have
              answered it.
            </div>
          ) : (
            results.map((r) => (
              // A whole-card open into the same detail the doc-list card opens
              // (the DocEditor), resolving the result's slug to the loaded doc.
              // A div (not a button) so the nested "related ↔" button is valid
              // HTML; keyboard-openable to match the doc-list card.
              <div
                key={r.id}
                role="button"
                tabIndex={0}
                onClick={() => {
                  const doc = findDocBySlug(docs, r.slug);
                  if (doc) setEditing(doc);
                }}
                onKeyDown={(e) => {
                  // Only Enter on the card ITSELF opens the editor. An Enter
                  // forwarded from the nested "related ↔" toggle bubbles up to
                  // here too (click-level stopPropagation doesn't stop the
                  // keydown), and must not also yank the reader into the editor.
                  if (!cardOpensOnEnter(e.key, e.target === e.currentTarget)) return;
                  const doc = findDocBySlug(docs, r.slug);
                  if (doc) setEditing(doc);
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
                <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600 }}>{r.title}</span>
                  <span style={{ fontFamily: theme.mono, fontSize: 10, color: theme.faint }}>
                    {r.slug} · {r.source} · {r.score.toFixed(2)}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: theme.dim, marginTop: 4, lineHeight: 1.5 }}>
                  {r.excerpt}
                </div>
                {/* Cross-project graph surface (Concept 2): the doc's edges,
                    fetched on demand. A neighbor in another project is labeled
                    with its project id — the point of the cross-project graph. */}
                <button
                  onClick={(e) => {
                    // Toggling related-docs is not a doc-open — keep it from
                    // bubbling to the card's open handler.
                    e.stopPropagation();
                    void toggleNeighbors(r.id);
                  }}
                  style={{
                    background: "none", border: "none", padding: 0, marginTop: 6,
                    cursor: "pointer", font: "inherit", fontFamily: theme.mono,
                    fontSize: 10, color: theme.running,
                  }}
                >
                  {neighborsOpen.has(r.id) ? "hide related" : "related ↔"}
                </button>
                {neighborsOpen.has(r.id) && (
                  // Exploring related docs is not a doc-open: keep a click (or a
                  // keydown) inside this panel from bubbling to the card's open
                  // handler, which opens on a click anywhere on the card.
                  <div
                    onClick={stopCardOpenPropagation}
                    onKeyDown={stopCardOpenPropagation}
                    style={{ marginTop: 6, paddingLeft: 8, borderLeft: `2px solid ${theme.edgeSoft}` }}
                  >
                    {neighbors[r.id] === undefined ? (
                      <div style={{ fontSize: 11, color: theme.faint }}>loading…</div>
                    ) : neighbors[r.id].length === 0 ? (
                      <div style={{ fontSize: 11, color: theme.faint }}>
                        No graph edges yet — add a <code>related:</code> frontmatter link, or let
                        co-citation edges form as docs reference each other.
                      </div>
                    ) : (
                      neighbors[r.id].map((n) => {
                        // Flag a neighbor a pivot should distrust: the coherence
                        // pass marked it contradicted, re-verification disputed it,
                        // or its origin is not auto-injection eligible. The search
                        // hit is trusted, but its neighbors are not — a reader must
                        // not silently treat a poisoned neighbor as authoritative.
                        const trust =
                          n.verdict === "contradicted"
                            ? { label: "contradicted", color: theme.waiting }
                            : n.verdict === "disputed"
                              ? { label: "disputed", color: theme.stalled }
                              : n.originClass === "untrusted" || n.originClass === "system"
                                ? { label: "untrusted", color: theme.waiting }
                                : null;
                        return (
                        <div key={n.docId} style={{ display: "flex", gap: 7, alignItems: "baseline", marginBottom: 3 }}>
                          <span style={{
                            fontFamily: theme.mono, fontSize: 9, textTransform: "uppercase",
                            letterSpacing: "0.06em", color: theme.expert,
                            border: `1px solid ${alpha(theme.expert, 0x44)}`, borderRadius: 3, padding: "0px 4px",
                          }}>{n.kind}</span>
                          <span style={{ fontSize: 12, color: theme.text }}>{n.title}</span>
                          {trust && (
                            <span
                              title="Distrust this neighbor when pivoting — it is contradicted, disputed, or of untrusted origin"
                              style={{
                                fontFamily: theme.mono, fontSize: 9, textTransform: "uppercase",
                                letterSpacing: "0.06em", color: trust.color,
                                border: `1px solid ${alpha(trust.color, 0x66)}`, borderRadius: 3, padding: "0px 4px",
                              }}
                            >{trust.label}</span>
                          )}
                          {n.projectId !== projectId && (
                            <span style={{ fontFamily: theme.mono, fontSize: 9.5, color: theme.accent }}>
                              ↗ {n.projectId}
                            </span>
                          )}
                          <span style={{ fontFamily: theme.mono, fontSize: 9.5, color: theme.faint }}>
                            {n.slug}
                          </span>
                        </div>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}

      <div style={{ ...label, marginBottom: 8 }}>
        {docs.length} doc{docs.length === 1 ? "" : "s"}
      </div>

      {docs.length === 0 ? (
        <div style={{ fontSize: 12.5, color: theme.faint, lineHeight: 1.6 }}>
          No knowledge yet. This is for what agents can't infer from the code —
          why the project exists, how it relates to others, conventions that
          aren't obvious from any single file.
        </div>
      ) : (
        docs.map((doc) => (
          // A div, not a button — the Regenerate button below needs to sit
          // inside this without nesting a <button> inside a <button>, which
          // is invalid HTML and breaks click handling in some browsers.
          <div
            key={doc.slug}
            role="button"
            tabIndex={0}
            onClick={() => setEditing(doc)}
            onKeyDown={(e) => {
              // Only Enter on the card ITSELF opens the editor — an Enter
              // forwarded from the nested Regenerate button (shown for a stale
              // doc) bubbles here too, and must not also open the editor.
              if (!cardOpensOnEnter(e.key, e.target === e.currentTarget)) return;
              setEditing(doc);
            }}
            style={{
              display: "block",
              width: "100%",
              textAlign: "left",
              background: theme.surface,
              border: `1px solid ${theme.edgeSoft}`,
              borderRadius: 6,
              padding: "10px 12px",
              marginBottom: 7,
              cursor: "pointer",
            }}
          >
            <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: theme.text }}>
                {doc.title}
              </span>
              <span style={{ fontFamily: theme.mono, fontSize: 10, color: theme.faint }}>
                {doc.slug}.md
              </span>
              {doc.tags.map((t) => (
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
              {/* Re-verification verdict (roadmap r5) — a doc the automatic
                  pass refuted or affirmed against current code. Shown right-
                  aligned like the draft cards; "unverified" is left silent
                  (a doc simply never re-checked isn't worth a badge). */}
              {doc.verdict && doc.verdict !== "unverified" && (
                <>
                  <span style={{ flex: 1 }} />
                  <span
                    style={{
                      fontSize: 10.5,
                      fontWeight: 600,
                      color: VERDICT_STYLE[doc.verdict].color,
                    }}
                  >
                    {VERDICT_STYLE[doc.verdict].label}
                  </span>
                </>
              )}
            </div>
            <div
              style={{
                fontSize: 12,
                color: theme.dim,
                marginTop: 5,
                lineHeight: 1.5,
                overflow: "hidden",
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
              }}
            >
              {doc.body}
            </div>

            {/* A refuted doc is gated out of agent auto-injection until a human
                re-asserts it. Surface the disputes the pass recorded so that
                recovery is actionable — clicking the card opens the editor, and
                saving any edit clears the verdict and lifts the doc back. */}
            {doc.disputes && doc.disputes.length > 0 && (
              <div
                style={{
                  marginTop: 9,
                  background: theme.ground,
                  border: `1px solid ${alpha(theme.waiting, 0x44)}`,
                  borderRadius: 6,
                  padding: "8px 10px",
                }}
              >
                <div style={{ fontSize: 10.5, fontWeight: 700, color: theme.waiting, marginBottom: 6 }}>
                  {doc.verdict === "contradicted"
                    ? "This doc contradicts another accepted doc — resolve the conflict by editing or discarding one of the two"
                    : "Re-verification disputed this against current code — withheld from agent injection until you edit it to re-assert it"}
                </div>
                {doc.disputes.map((d, i) => (
                  <div key={i} style={{ marginBottom: i === doc.disputes!.length - 1 ? 0 : 8 }}>
                    <div style={{ fontSize: 12, color: theme.text, lineHeight: 1.45 }}>
                      <span style={{ color: theme.faint }}>claims: </span>
                      {d.claim}
                    </div>
                    <div style={{ fontSize: 12, color: theme.text, lineHeight: 1.45 }}>
                      <span style={{ color: theme.faint }}>found: </span>
                      {d.finding}
                    </div>
                    {d.evidence && (
                      <code
                        style={{
                          display: "inline-block",
                          fontFamily: theme.mono,
                          fontSize: 11,
                          color: theme.dim,
                          background: theme.raised,
                          border: `1px solid ${theme.edgeSoft}`,
                          borderRadius: 3,
                          padding: "1px 6px",
                          marginTop: 3,
                        }}
                      >
                        {d.evidence}
                      </code>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Staleness (phase-7 Step 6) — only ever shown for a doc with
                real provenance; the raw commit count is surfaced even below
                the threshold because it's more useful than the verdict. */}
            {doc.staleness && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginTop: 6,
                  fontSize: 11,
                  color: doc.staleness.stale ? theme.stalled : theme.faint,
                }}
              >
                <span>
                  {doc.staleness.reachable
                    ? `generated ${doc.staleness.commitsSince} commit${doc.staleness.commitsSince === 1 ? "" : "s"} ago` +
                      (doc.staleness.filesChanged
                        ? ` (${doc.staleness.filesChanged} file${doc.staleness.filesChanged === 1 ? "" : "s"} touched since)`
                        : "") +
                      (doc.staleness.stale ? " — possibly outdated" : "")
                    : "generated from an unknown commit"}
                </span>
                {doc.staleness.stale && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void regenerate();
                    }}
                    disabled={bootstrapBusy}
                    style={{
                      fontSize: 10.5,
                      fontWeight: 600,
                      color: theme.stalled,
                      background: "none",
                      border: `1px solid ${alpha(theme.stalled, 0x55)}`,
                      borderRadius: 4,
                      padding: "2px 7px",
                      cursor: bootstrapBusy ? "not-allowed" : "pointer",
                      opacity: bootstrapBusy ? 0.6 : 1,
                    }}
                  >
                    Regenerate
                  </button>
                )}
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}

/** Line-level diff, shown only when a draft would replace an existing doc —
 * a new doc has nothing to diff against, so it renders as a plain preview
 * instead (see the caller). */
function LineDiffView({ oldText, newText }: { oldText: string; newText: string }) {
  const lines = lineDiff(oldText, newText);
  return (
    <div
      style={{
        fontFamily: theme.mono,
        fontSize: 11.5,
        lineHeight: 1.55,
        background: theme.ground,
        border: `1px solid ${theme.edgeSoft}`,
        borderRadius: 6,
        padding: "8px 0",
        overflowX: "auto",
      }}
    >
      {lines.map((l, i) => (
        <div
          key={i}
          style={{
            padding: "0 10px",
            whiteSpace: "pre-wrap",
            background:
              l.type === "add" ? alpha(theme.checkpoint, 0x1a) : l.type === "remove" ? alpha(theme.waiting, 0x1a) : "transparent",
            color: l.type === "add" ? theme.checkpoint : l.type === "remove" ? theme.waiting : theme.dim,
          }}
        >
          {l.type === "add" ? "+ " : l.type === "remove" ? "- " : "  "}
          {l.text || " "}
        </div>
      ))}
    </div>
  );
}

function DocEditor({
  doc,
  busy,
  error,
  onSave,
  onDelete,
  onCancel,
  // Whether to show the provenance/scope control. On for an accepted doc (whose
  // PUT round-trips scope); off for a draft, whose scope is set at propose time
  // and carried through accept — a control the draft PUT would ignore is worse
  // than no control.
  showScope = true,
  // The scope a NEW doc starts at — the project's default, so authoring in a
  // global-default project pre-selects global. An existing doc uses its own
  // scope instead.
  defaultScope = "project",
}: {
  doc: KnowledgeDoc | null;
  busy: boolean;
  error: string | null;
  onSave: (d: {
    slug: string;
    title: string;
    body: string;
    tags: string;
    sourceKind: SourceKind;
    scope?: DocScope;
  }) => void;
  onDelete?: () => void;
  onCancel: () => void;
  showScope?: boolean;
  defaultScope?: DocScope;
}) {
  const [slug, setSlug] = useState(doc?.slug ?? "");
  const [title, setTitle] = useState(doc?.title ?? "");
  const [body, setBody] = useState(doc?.body ?? "");
  const [tags, setTags] = useState((doc?.tags ?? []).join(", "));
  // Absent reads as 'unclassified' — the corpus default.
  const [sourceKind, setSourceKind] = useState<SourceKind>(doc?.sourceKind ?? "unclassified");
  // The scope the control is seeded with: an existing doc shows its own scope; a
  // new doc starts at the project's default. Either is promotable (project ->
  // global) or scopeable to the user; the owner of a 'user' doc is stamped
  // server-side from the acting identity.
  const initialScope: DocScope = doc ? docScopeValue(doc.scope) : defaultScope;
  const [scope, setScope] = useState<DocScope>(initialScope);

  // Escape exits, except from the textarea where it would be a trap for
  // anyone using it to leave an autocomplete or IME.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "TEXTAREA") return;
      onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div style={{ padding: "16px 20px 24px", overflowY: "auto" }}>
      {/* The way out belongs above the fold. The Cancel button at the bottom
          sits below a tall textarea, so it is both out of view and reads as
          "discard" rather than "go back". */}
      <button
        onClick={onCancel}
        style={{
          background: "none",
          border: "none",
          padding: 0,
          marginBottom: 12,
          cursor: "pointer",
          fontSize: 12.5,
          color: theme.faint,
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
        }}
      >
        <LuArrowLeft /> All knowledge
      </button>

      <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>
        {doc ? `Edit ${doc.slug}.md` : "New knowledge doc"}
      </div>

      <div style={{ display: "grid", gap: 14 }}>
        {!doc && (
          <div>
            <span style={label}>Slug</span>
            <input
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="conventions"
              style={{ ...field, fontFamily: theme.mono }}
            />
            <div style={{ fontSize: 11.5, color: theme.faint, marginTop: 5 }}>
              Becomes the filename. Letters, numbers, hyphens.
            </div>
          </div>
        )}

        <div>
          <span style={label}>Title</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Coding conventions"
            style={field}
          />
        </div>

        <div>
          <span style={label}>Tags — comma separated</span>
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="conventions, gotchas"
            style={field}
          />
        </div>

        <div>
          <span style={label}>Source kind</span>
          <select
            value={sourceKind}
            onChange={(e) => setSourceKind(e.target.value as SourceKind)}
            style={{ ...field, fontFamily: theme.mono }}
          >
            {(SOURCE_KINDS.includes(sourceKind) ? SOURCE_KINDS : [sourceKind, ...SOURCE_KINDS]).map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <div style={{ fontSize: 11.5, color: theme.faint, marginTop: 5 }}>
            code / decision / runbook are injected as code knowledge and product / spec
            as product context when a task is launched; unclassified (the default) is
            searchable but never injected.
          </div>
        </div>

        {showScope && (
          <div>
            <span style={label}>Scope</span>
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as DocScope)}
              style={{ ...field, fontFamily: theme.mono }}
            >
              {DOC_SCOPES.map((s) => (
                <option key={s} value={s}>
                  {DOC_SCOPE_LABELS[s]}
                </option>
              ))}
            </select>
            <div style={{ fontSize: 11.5, color: theme.faint, marginTop: 5 }}>
              project = this project only (the default). global promotes the doc to
              the whole corpus. my knowledge scopes it to you — your agents retrieve
              it while others can still view it.
              {scope === "user" && (
                <>
                  {" "}
                  Owner:{" "}
                  <span style={{ fontFamily: theme.mono, color: theme.dim }}>
                    {doc?.ownerUser ?? "you (set on save)"}
                  </span>
                  .
                </>
              )}
            </div>
          </div>
        )}

        <div>
          <span style={label}>Body — markdown</span>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={18}
            placeholder={
              "What would have saved the last agent an hour?\n\n" +
              "Favour what can't be grepped: why things are the way they are,\n" +
              "conventions spanning many files, cross-project dependencies."
            }
            style={{
              ...field,
              fontFamily: theme.mono,
              fontSize: 12,
              lineHeight: 1.6,
              resize: "vertical",
            }}
          />
        </div>
      </div>

      {error && (
        <div
          style={{
            fontFamily: theme.mono,
            fontSize: 11.5,
            color: theme.waiting,
            marginTop: 14,
          }}
        >
          {error}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 18, alignItems: "center" }}>
        <button
          onClick={() =>
            // Send scope only when the user actually moved the control off the
            // value it was seeded with. An unchanged scope is omitted so a plain
            // body edit falls through to the server's preserve branch (no silent
            // owner/scope re-derivation from the editing caller).
            onSave({
              slug,
              title,
              body,
              tags,
              sourceKind,
              scope: scope !== initialScope ? scope : undefined,
            })
          }
          disabled={busy || !slug.trim() || !body.trim()}
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: theme.ground,
            background: theme.checkpoint,
            border: "none",
            borderRadius: 6,
            padding: "9px 18px",
            cursor: busy ? "not-allowed" : "pointer",
            opacity: busy || !slug.trim() || !body.trim() ? 0.5 : 1,
          }}
        >
          {busy ? "Saving…" : "Save"}
        </button>
        <button
          onClick={onCancel}
          style={{
            fontSize: 13,
            color: theme.dim,
            background: "none",
            border: `1px solid ${theme.edge}`,
            borderRadius: 6,
            padding: "9px 16px",
            cursor: "pointer",
          }}
        >
          Cancel
        </button>
        <span style={{ flex: 1 }} />
        {onDelete && (
          <button
            onClick={onDelete}
            style={{
              fontSize: 12.5,
              color: theme.waiting,
              background: "none",
              border: "none",
              cursor: "pointer",
            }}
          >
            Delete doc
          </button>
        )}
      </div>
    </div>
  );
}
