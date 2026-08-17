import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { theme } from "./theme";
import { Markdown } from "./Markdown";
import { lineDiff } from "./lineDiff";

interface KnowledgeDoc {
  slug: string;
  title: string;
  body: string;
  tags: string[];
  updatedAt: string;
}

interface SearchResult {
  slug: string;
  title: string;
  excerpt: string;
  score: number;
  source: "text" | "embedding";
}

interface DraftDispute {
  claim: string;
  finding: string;
  evidence: string;
}

type DraftVerdict = "unverified" | "clean" | "disputed" | "error";

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
  clean: { color: theme.checkpoint, label: "fact-checked · clean" },
  disputed: { color: theme.waiting, label: "fact-checked · disputed" },
  error: { color: theme.stalled, label: "fact-check failed to run" },
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
  draftSignal,
}: {
  projectId: string;
  repos?: string[];
  draftSignal?: { projectId: string; n: number };
}) {
  const navigate = useNavigate();
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [editing, setEditing] = useState<KnowledgeDoc | null>(null);
  const [editingDraftSlug, setEditingDraftSlug] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Which draft (if any) is mid-merge, and the editable combined text for it.
  const [mergeSlug, setMergeSlug] = useState<string | null>(null);
  const [mergeText, setMergeText] = useState("");
  const [draftBusy, setDraftBusy] = useState<Set<string>>(new Set());
  const [draftErrors, setDraftErrors] = useState<Record<string, string>>({});
  const [acceptAllNote, setAcceptAllNote] = useState<string | null>(null);

  const [bootstrapBusy, setBootstrapBusy] = useState(false);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [bootstrapNote, setBootstrapNote] = useState<string | null>(null);

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
    if (draftSignal && draftSignal.projectId === projectId && draftSignal.n > 0) {
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

  async function save(doc: { slug: string; title: string; body: string; tags: string }) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/projects/${projectId}/knowledge/${encodeURIComponent(doc.slug)}`,
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
          }),
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

  async function search() {
    if (!query.trim()) {
      setResults(null);
      return;
    }
    const res = await fetch("/api/knowledge/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "", project: projectId, query }),
    });
    const data = await res.json();
    setResults(data.results ?? []);
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

  async function acceptDraft(slug: string, opts?: { mode?: "merge" | "replace"; body?: string }) {
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
        skipped?: Array<{ slug: string; reason: "replaces" | "disputed" }>;
      };
      const accepted = data.accepted ?? [];
      const skipped = data.skipped ?? [];
      const replaces = skipped.filter((s) => s.reason === "replaces").length;
      const disputed = skipped.filter((s) => s.reason === "disputed").length;
      const parts: string[] = [`Accepted ${accepted.length}.`];
      if (replaces > 0) {
        parts.push(
          `${replaces} left pending — would replace existing work and needs merge or replace, one at a time.`
        );
      }
      if (disputed > 0) {
        parts.push(`${disputed} left pending — the fact-check disputed something in it.`);
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
        "Started — drafts will appear below as the agent proposes them. Watch it in Feed, or stop it from the launch's session."
      );
    } catch (err) {
      setBootstrapError((err as Error).message);
    } finally {
      setBootstrapBusy(false);
    }
  }

  if (editing || creating) {
    return (
      <DocEditor
        doc={editing}
        busy={busy}
        error={error}
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
        }}
        busy={busy}
        error={error}
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
                        border: `1px solid ${theme.stalled}44`,
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
                        onClick={() => navigate(`/projects/s/${draft.launchSessionId}`)}
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
                      border: `1px solid ${theme.waiting}44`,
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

                {mergeSlug === draft.slug ? (
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
                      onClick={() => void discardDraft(draft.slug)}
                      disabled={busyThis}
                      style={{ ...smallButton, color: theme.waiting, borderColor: `${theme.waiting}55` }}
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
              <div
                key={r.slug}
                style={{
                  background: theme.surface,
                  border: `1px solid ${theme.edgeSoft}`,
                  borderRadius: 6,
                  padding: "9px 11px",
                  marginBottom: 7,
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
          <button
            key={doc.slug}
            onClick={() => setEditing(doc)}
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
                    border: `1px solid ${theme.expert}44`,
                    borderRadius: 3,
                    padding: "1px 5px",
                  }}
                >
                  {t}
                </span>
              ))}
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
          </button>
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
              l.type === "add" ? `${theme.checkpoint}1A` : l.type === "remove" ? `${theme.waiting}1A` : "transparent",
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
}: {
  doc: KnowledgeDoc | null;
  busy: boolean;
  error: string | null;
  onSave: (d: { slug: string; title: string; body: string; tags: string }) => void;
  onDelete?: () => void;
  onCancel: () => void;
}) {
  const [slug, setSlug] = useState(doc?.slug ?? "");
  const [title, setTitle] = useState(doc?.title ?? "");
  const [body, setBody] = useState(doc?.body ?? "");
  const [tags, setTags] = useState((doc?.tags ?? []).join(", "));

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
        }}
      >
        ← All knowledge
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
          onClick={() => onSave({ slug, title, body, tags })}
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
