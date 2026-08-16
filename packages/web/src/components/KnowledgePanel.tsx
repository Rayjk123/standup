import { useState, useEffect, useCallback } from "react";
import { theme } from "./theme";

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

/**
 * View, edit, add and search a project's knowledge.
 *
 * Knowledge was previously only editable as files on disk, which made the
 * one part of the system that depends on a human writing it the least
 * convenient thing to write. The search box matters as much as the editor:
 * it's how you check what an agent will actually retrieve before trusting
 * that it will.
 */
export function KnowledgePanel({ projectId }: { projectId: string }) {
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [editing, setEditing] = useState<KnowledgeDoc | null>(null);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/knowledge`);
      if (res.ok) setDocs(await res.json());
    } catch {
      /* leave the previous list rather than blanking it */
    }
  }, [projectId]);

  useEffect(() => {
    setEditing(null);
    setCreating(false);
    setResults(null);
    setQuery("");
    void load();
  }, [load]);

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

  return (
    <div style={{ padding: "16px 20px 24px", overflowY: "auto" }}>
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
