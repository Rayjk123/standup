import { useState, useEffect, useCallback } from "react";

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

const fieldClass =
  "w-full text-[13px] text-text bg-ground border border-edge rounded-md px-2.5 py-2 outline-none";

const labelClass =
  "font-mono text-[9.5px] tracking-[0.14em] uppercase text-faint block mb-[5px]";

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
    <div className="px-5 pt-4 pb-6 overflow-y-auto">
      {/* Search first: checking what agents will retrieve is the more
          frequent task, and it's the only way to verify knowledge is
          reachable rather than merely present. */}
      <div className="flex gap-2 mb-4">
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
          className={fieldClass}
        />
        <button
          onClick={() => setCreating(true)}
          className="text-[12.5px] font-semibold text-ground bg-checkpoint border-none rounded-md px-3.5 py-2 cursor-pointer whitespace-nowrap"
        >
          + New doc
        </button>
      </div>

      {results !== null && (
        <div className="mb-[18px]">
          <div className={`${labelClass} mb-2`}>
            {results.length} result{results.length === 1 ? "" : "s"} for “{query}”
          </div>
          {results.length === 0 ? (
            <div className="text-[12.5px] text-faint leading-relaxed">
              Nothing matched. An agent asking this would get nothing back —
              worth adding a doc, or rewording the one that should have
              answered it.
            </div>
          ) : (
            results.map((r) => (
              <div
                key={r.slug}
                className="bg-surface border border-edge-soft rounded-md px-[11px] py-[9px] mb-[7px]"
              >
                <div className="flex gap-2 items-baseline">
                  <span className="text-[12.5px] font-semibold">{r.title}</span>
                  <span className="font-mono text-[10px] text-faint">
                    {r.slug} · {r.source} · {r.score.toFixed(2)}
                  </span>
                </div>
                <div className="text-xs text-dim mt-1 leading-relaxed">{r.excerpt}</div>
              </div>
            ))
          )}
        </div>
      )}

      <div className={`${labelClass} mb-2`}>
        {docs.length} doc{docs.length === 1 ? "" : "s"}
      </div>

      {docs.length === 0 ? (
        <div className="text-[12.5px] text-faint leading-relaxed">
          No knowledge yet. This is for what agents can't infer from the code —
          why the project exists, how it relates to others, conventions that
          aren't obvious from any single file.
        </div>
      ) : (
        docs.map((doc) => (
          <button
            key={doc.slug}
            onClick={() => setEditing(doc)}
            className="block w-full text-left bg-surface border border-edge-soft rounded-md px-3 py-2.5 mb-[7px] cursor-pointer"
          >
            <div className="flex gap-2 items-baseline flex-wrap">
              <span className="text-[13px] font-semibold text-text">{doc.title}</span>
              <span className="font-mono text-[10px] text-faint">{doc.slug}.md</span>
              {doc.tags.map((t) => (
                <span
                  key={t}
                  className="font-mono text-[9px] text-expert border border-expert/25 rounded-[3px] px-[5px] py-px"
                >
                  {t}
                </span>
              ))}
            </div>
            <div className="text-xs text-dim mt-[5px] leading-relaxed overflow-hidden [display:-webkit-box] [-webkit-line-clamp:2] [-webkit-box-orient:vertical]">
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
    <div className="px-5 pt-4 pb-6 overflow-y-auto">
      {/* The way out belongs above the fold. The Cancel button at the bottom
          sits below a tall textarea, so it is both out of view and reads as
          "discard" rather than "go back". */}
      <button
        onClick={onCancel}
        className="bg-transparent border-none p-0 mb-3 cursor-pointer text-[12.5px] text-faint"
      >
        ← All knowledge
      </button>

      <div className="text-[15px] font-bold mb-4">
        {doc ? `Edit ${doc.slug}.md` : "New knowledge doc"}
      </div>

      <div className="grid gap-3.5">
        {!doc && (
          <div>
            <span className={labelClass}>Slug</span>
            <input
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="conventions"
              className={`${fieldClass} font-mono`}
            />
            <div className="text-[11.5px] text-faint mt-[5px]">
              Becomes the filename. Letters, numbers, hyphens.
            </div>
          </div>
        )}

        <div>
          <span className={labelClass}>Title</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Coding conventions"
            className={fieldClass}
          />
        </div>

        <div>
          <span className={labelClass}>Tags — comma separated</span>
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="conventions, gotchas"
            className={fieldClass}
          />
        </div>

        <div>
          <span className={labelClass}>Body — markdown</span>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={18}
            placeholder={
              "What would have saved the last agent an hour?\n\n" +
              "Favour what can't be grepped: why things are the way they are,\n" +
              "conventions spanning many files, cross-project dependencies."
            }
            className={`${fieldClass} font-mono text-xs leading-relaxed resize-y`}
          />
        </div>
      </div>

      {error && <div className="font-mono text-[11.5px] text-waiting mt-3.5">{error}</div>}

      <div className="flex gap-2 mt-[18px] items-center">
        <button
          onClick={() => onSave({ slug, title, body, tags })}
          disabled={busy || !slug.trim() || !body.trim()}
          className="text-sm font-semibold text-ground bg-checkpoint border-none rounded-md px-[18px] py-[9px] cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        <button
          onClick={onCancel}
          className="text-sm text-dim bg-transparent border border-edge rounded-md px-4 py-[9px] cursor-pointer"
        >
          Cancel
        </button>
        <span className="flex-1" />
        {onDelete && (
          <button
            onClick={onDelete}
            className="text-[12.5px] text-waiting bg-transparent border-none cursor-pointer"
          >
            Delete doc
          </button>
        )}
      </div>
    </div>
  );
}
