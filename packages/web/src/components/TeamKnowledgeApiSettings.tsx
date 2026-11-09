import { useCallback, useEffect, useState } from "react";
import { LuCheck, LuCopy, LuRefreshCw, LuX } from "react-icons/lu";
import { GLOBAL_PROJECT_ID } from "@standup/shared";
import { theme } from "./theme";
import { absoluteTime, relativeTime } from "../lib/schedules";

/** GET/PUT /api/public-knowledge/access (both reply with this shape): who may call the read-only team API. */
interface PublicKnowledgeAccess {
  aliases: string[];
  posixGroups: string[];
  /** Whether the public listener is actually bound and serving. */
  enabled: boolean;
  /** The unix socket the API listens on, when serving or when a start was attempted. */
  socketPath?: string;
  /** Why the listener failed to start, when it did. */
  error?: string;
  /** Whether the model call answering public asks is working. */
  synthesis?: { degraded: boolean; lastFailureAt?: string };
}

/** One call a teammate made against the team API. */
interface PublicKnowledgeCall {
  at: string | number;
  alias: string;
  endpoint: string;
  query: string;
  status: number;
}

/** The slice of a /api/projects entry this section reads; `shareable` missing means shared. */
interface ShareableProject {
  id: string;
  name: string;
  emoji?: string;
  shareable?: boolean;
  reserved?: boolean;
}

type AccessState =
  | { kind: "loading" }
  | { kind: "forbidden" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: PublicKnowledgeAccess };

/** An alias the collector's allowlist accepts. */
export const ALIAS_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
/** A POSIX group name the collector's allowlist accepts; unlike an alias it may start with '_'. */
export const GROUP_NAME = /^[a-z0-9_][a-z0-9._-]{0,63}$/i;

const ACCESS_URL = "/api/public-knowledge/access";
const USAGE_URL = "/api/public-knowledge/usage?limit=50";

const label: React.CSSProperties = {
  fontFamily: theme.mono,
  fontSize: 9.5,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  color: theme.faint,
  display: "block",
  marginBottom: 6,
};
const help: React.CSSProperties = { fontSize: 11.5, color: theme.faint, marginTop: 5, lineHeight: 1.5 };
const field: React.CSSProperties = {
  fontSize: 12.5,
  fontFamily: theme.mono,
  color: theme.text,
  background: theme.ground,
  border: `1px solid ${theme.edge}`,
  borderRadius: 6,
  padding: "6px 9px",
  outline: "none",
  minWidth: 0,
};
const button: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  background: "none",
  border: `1px solid ${theme.edge}`,
  borderRadius: 6,
  padding: "6px 11px",
  fontSize: 12,
  color: theme.dim,
  cursor: "pointer",
};
const errorText: React.CSSProperties = { fontSize: 12, color: theme.waiting, marginTop: 8, lineHeight: 1.5 };
const block: React.CSSProperties = { borderTop: `1px solid ${theme.edgeSoft}`, paddingTop: 16, marginTop: 16 };
const th: React.CSSProperties = {
  textAlign: "left",
  padding: "7px 10px",
  fontSize: 11,
  fontWeight: 600,
  color: theme.faint,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  borderBottom: `1px solid ${theme.edge}`,
  whiteSpace: "nowrap",
};
const td: React.CSSProperties = {
  textAlign: "left",
  padding: "7px 10px",
  fontSize: 12.5,
  fontFamily: theme.mono,
  color: theme.dim,
  borderBottom: `1px solid ${theme.edgeSoft}`,
  whiteSpace: "nowrap",
};

/** A placeholder bar shown while a fetch is in flight. */
function Skeleton({ width = "100%", height = 14 }: { width?: number | string; height?: number }) {
  return <div aria-hidden style={{ width, height, borderRadius: 4, background: theme.raised, opacity: 0.6 }} />;
}

/** The error text of a non-2xx reply: its `{error}` body when there is one, else the status. */
async function replyError(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" && body.error ? body.error : `${fallback} (${res.status})`;
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** A call's timestamp (ISO string or epoch ms) as ISO; an unparseable one passes through as given. */
function callTime(at: string | number): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? String(at) : date.toISOString();
}

/**
 * The owner's controls for the read-only team knowledge API: teammates query
 * this collector's knowledge base over HTTP through an authenticating proxy
 * in front of its unix socket, gated by a user/group allowlist. Holds the
 * serving status and an example call, the allowlist editor, which projects'
 * docs are shared, and the recent calls. Each part fetches on mount and shows
 * a placeholder until its own reply lands; a non-owner (403 on the access
 * read) sees only a notice.
 */
export function TeamKnowledgeApiSettings() {
  const [access, setAccess] = useState<AccessState>({ kind: "loading" });

  useEffect(() => {
    let live = true;
    fetch(ACCESS_URL)
      .then(async (res) => {
        if (!live) return;
        if (res.status === 403) return setAccess({ kind: "forbidden" });
        if (!res.ok) return setAccess({ kind: "error", message: await replyError(res, "Couldn't load access") });
        setAccess({ kind: "ready", data: (await res.json()) as PublicKnowledgeAccess });
      })
      .catch(() => live && setAccess({ kind: "error", message: "Couldn't reach the collector." }));
    return () => {
      live = false;
    };
  }, []);

  if (access.kind === "forbidden") {
    return (
      <div style={{ padding: "18px 14px", textAlign: "center", color: theme.dim, fontSize: 13 }}>
        Only the owner can manage this.
      </div>
    );
  }

  return (
    <div>
      <ServingStatus access={access} />
      <div style={block}>
        {access.kind === "ready" ? (
          <AllowlistEditor initial={access.data} onSaved={(data) => setAccess({ kind: "ready", data })} />
        ) : access.kind === "error" ? (
          <div style={errorText}>{access.message}</div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            <Skeleton width={120} height={10} />
            <Skeleton height={30} />
            <Skeleton width={120} height={10} />
            <Skeleton height={30} />
          </div>
        )}
      </div>
      <div style={block}>
        <ShareableProjects />
      </div>
      <div style={block}>
        <RecentUsage />
      </div>
    </div>
  );
}

/** Stands in for the proxy's public URL in the example call; the collector doesn't know it. */
const PROXY_URL_PLACEHOLDER = "https://<proxy-url>";

/** The example search call, against {@link PROXY_URL_PLACEHOLDER}. */
const EXAMPLE_CALL = `curl -s '${PROXY_URL_PLACEHOLDER}/api/public/knowledge/v1/search?q=...'`;

/** The collector setting naming the header the proxy stamps with the caller's user name. */
const IDENTITY_HEADER_ENV = "STANDUP_PUBLIC_KB_IDENTITY_HEADER";

/**
 * What the API is, whether it is serving, a copyable example call, and how
 * the owner puts an authenticating proxy in front of the socket.
 */
function ServingStatus({ access }: { access: AccessState }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    void navigator.clipboard?.writeText(EXAMPLE_CALL).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {}
    );
  }

  return (
    <div>
      <div style={{ fontSize: 12.5, color: theme.dim, lineHeight: 1.6 }}>
        A read-only API that lets allowlisted teammates search and read this knowledge base over HTTP. It listens on a
        unix socket you share through an authenticating tunnel or reverse proxy. It never writes, and never serves your
        personal layer.
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, fontSize: 12, minHeight: 18 }}>
        {access.kind === "ready" ? (
          <>
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: access.data.enabled ? theme.done : theme.faint,
              }}
            />
            <span style={{ color: access.data.enabled ? theme.done : access.data.error ? theme.waiting : theme.dim }}>
              {access.data.enabled ? "Serving" : access.data.error ? `Not serving: ${access.data.error}` : "Not serving"}
            </span>
            {!access.data.enabled && !access.data.error && (
              <span style={{ color: theme.faint }}>
                — set STANDUP_PUBLIC_KB=1 and {IDENTITY_HEADER_ENV}, then restart the collector to turn it on
              </span>
            )}
            {access.data.enabled && access.data.socketPath && (
              <code style={{ fontFamily: theme.mono, fontSize: 11.5, color: theme.faint }}>
                {access.data.socketPath}
              </code>
            )}
          </>
        ) : access.kind === "loading" ? (
          <Skeleton width={220} height={12} />
        ) : null}
      </div>
      {access.kind === "ready" && access.data.synthesis?.degraded && (
        <div role="status" style={{ ...errorText, marginTop: 6 }}>
          Answers are falling back to raw passages: synthesis failed
          {access.data.synthesis.lastFailureAt ? ` (last ${absoluteTime(access.data.synthesis.lastFailureAt)})` : ""}. Public
          asks run <code style={{ fontFamily: theme.mono }}>claude --bare</code>, which signs in only with
          ANTHROPIC_API_KEY, an apiKeyHelper, or Bedrock/Vertex credentials — not an OAuth or keychain login.
        </div>
      )}
      <span style={{ ...label, marginTop: 12 }}>Example call</span>
      <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
        <code
          style={{
            ...field,
            flex: 1,
            display: "block",
            overflowX: "auto",
            whiteSpace: "nowrap",
            color: theme.dim,
          }}
        >
          {EXAMPLE_CALL}
        </code>
        <button type="button" onClick={copy} title="Copy the example call" style={button}>
          {copied ? <LuCheck size={13} /> : <LuCopy size={13} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div style={help}>
        Put an authenticating tunnel or reverse proxy in front of the socket. It must strip any client-sent copy of the
        identity header and stamp the caller's user name in it; <code style={{ fontFamily: theme.mono }}>{IDENTITY_HEADER_ENV}</code>{" "}
        names that header, and the API serves nothing until it is set. Then put the proxy's URL in place of{" "}
        <code style={{ fontFamily: theme.mono }}>{PROXY_URL_PLACEHOLDER}</code>. Callers add whatever credentials the
        proxy asks for.
      </div>
    </div>
  );
}

/** A removable chip list with an add box, validated against `pattern`. */
function NameList({
  title,
  noun,
  pattern,
  rule,
  names,
  caseInsensitive,
  disabled,
  onChange,
}: {
  title: string;
  noun: string;
  pattern: RegExp;
  /** The character rule shown when a name fails `pattern`. */
  rule: string;
  names: string[];
  /** Whether two names differing only in case are one name (aliases are; POSIX groups are not). */
  caseInsensitive: boolean;
  disabled: boolean;
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const [invalid, setInvalid] = useState<string | null>(null);

  function add() {
    const name = draft.trim();
    if (!name) return;
    if (!pattern.test(name)) {
      setInvalid(`"${name}" isn't a valid ${noun}: ${rule}`);
      return;
    }
    setInvalid(null);
    setDraft("");
    const same = (n: string) => (caseInsensitive ? n.toLowerCase() === name.toLowerCase() : n === name);
    if (!names.some(same)) onChange([...names, name]);
  }

  return (
    <div>
      <span style={label}>{title}</span>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
        {names.length === 0 && <span style={{ fontSize: 12, color: theme.faint }}>None</span>}
        {names.map((name) => (
          <span
            key={name}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontFamily: theme.mono,
              fontSize: 12,
              color: theme.text,
              background: theme.raised,
              border: `1px solid ${theme.edge}`,
              borderRadius: 999,
              padding: "3px 6px 3px 10px",
            }}
          >
            {name}
            <button
              type="button"
              aria-label={`Remove ${name}`}
              title={`Remove ${name}`}
              disabled={disabled}
              onClick={() => onChange(names.filter((n) => n !== name))}
              style={{
                display: "inline-flex",
                background: "none",
                border: "none",
                padding: 1,
                color: theme.faint,
                cursor: disabled ? "default" : "pointer",
              }}
            >
              <LuX size={12} />
            </button>
          </span>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
        style={{ display: "flex", gap: 6 }}
      >
        <input
          aria-label={`Add ${noun}`}
          placeholder={`Add ${noun}`}
          value={draft}
          disabled={disabled}
          onChange={(e) => {
            setDraft(e.target.value);
            setInvalid(null);
          }}
          style={{ ...field, width: 240 }}
        />
        <button type="submit" disabled={disabled || !draft.trim()} style={{ ...button, opacity: draft.trim() ? 1 : 0.5 }}>
          Add
        </button>
      </form>
      {invalid && <div style={errorText}>{invalid}</div>}
    </div>
  );
}

/** Edits the alias and POSIX-group allowlists; Save is a full replace of both. */
function AllowlistEditor({
  initial,
  onSaved,
}: {
  initial: PublicKnowledgeAccess;
  onSaved: (data: PublicKnowledgeAccess) => void;
}) {
  const [aliases, setAliases] = useState(initial.aliases);
  const [groups, setGroups] = useState(initial.posixGroups);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const dirty = !sameList(aliases, initial.aliases) || !sameList(groups, initial.posixGroups);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(ACCESS_URL, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aliases, posixGroups: groups }),
      });
      if (!res.ok) {
        setError(await replyError(res, "Save failed"));
        return;
      }
      const data = (await res.json()) as PublicKnowledgeAccess;
      setAliases(data.aliases);
      setGroups(data.posixGroups);
      setSaved(true);
      onSaved(data);
    } catch {
      setError("Couldn't reach the collector.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
        <NameList
          title="Allowed users"
          noun="user name"
          pattern={ALIAS_NAME}
          rule="letters, digits, '.', '_' or '-', starting with a letter or digit, at most 64 characters."
          names={aliases}
          caseInsensitive
          disabled={saving}
          onChange={(next) => {
            setAliases(next);
            setSaved(false);
          }}
        />
        <NameList
          title="Allowed groups"
          noun="group"
          pattern={GROUP_NAME}
          rule="letters, digits, '.', '_' or '-', starting with a letter, digit or '_', at most 64 characters."
          names={groups}
          caseInsensitive={false}
          disabled={saving}
          onChange={(next) => {
            setGroups(next);
            setSaved(false);
          }}
        />
      </div>
      <div style={help}>
        A caller is let in when their user name is listed or they belong to a listed group. Groups are the caller's
        Unix groups on this host, read with <code style={{ fontFamily: theme.mono }}>id -Gn</code>, which includes each
        user's primary group — allowing a broad group lets in everyone in it.
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}>
        <button
          type="button"
          onClick={save}
          disabled={!dirty || saving}
          style={{
            ...button,
            border: `1px solid ${dirty ? theme.accent : theme.edge}`,
            color: dirty ? theme.accent : theme.faint,
            cursor: !dirty || saving ? "default" : "pointer",
            opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? "Saving…" : "Save allowlist"}
        </button>
        {saved && !dirty && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, color: theme.done }}>
            <LuCheck size={13} /> Saved
          </span>
        )}
      </div>
      {error && (
        <div role="alert" style={errorText}>
          {error}
        </div>
      )}
    </div>
  );
}

/** Per-project share toggles; a flip shows at once and reverts if the PATCH fails. */
function ShareableProjects() {
  const [projects, setProjects] = useState<ShareableProject[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    let live = true;
    fetch("/api/projects")
      .then(async (res) => {
        if (!res.ok) throw new Error(await replyError(res, "Couldn't load projects"));
        return (await res.json()) as ShareableProject[];
      })
      .then((list) => live && setProjects(list))
      .catch((err: unknown) => live && setLoadError(err instanceof Error ? err.message : "Couldn't load projects"));
    return () => {
      live = false;
    };
  }, []);

  function setShareable(id: string, shareable: boolean) {
    setProjects((list) => list?.map((p) => (p.id === id ? { ...p, shareable } : p)) ?? list);
  }

  async function toggle(project: ShareableProject) {
    const next = project.shareable === false;
    setError(null);
    setShareable(project.id, next);
    setPending((s) => new Set(s).add(project.id));
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(project.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shareable: next }),
      });
      if (!res.ok) {
        setShareable(project.id, !next);
        setError(`${project.name}: ${await replyError(res, "Update failed")}`);
      }
    } catch {
      setShareable(project.id, !next);
      setError(`${project.name}: couldn't reach the collector.`);
    } finally {
      setPending((s) => {
        const copy = new Set(s);
        copy.delete(project.id);
        return copy;
      });
    }
  }

  return (
    <div>
      <span style={label}>Shared projects</span>
      <div style={{ ...help, marginTop: 0, marginBottom: 10 }}>
        Docs of checked projects are visible to teammates. Global docs are always shared; your personal layer never is.
        New projects are shared by default; untick a project to withhold its knowledge.
      </div>
      {loadError ? (
        <div style={errorText}>{loadError}</div>
      ) : projects === null ? (
        <div style={{ display: "grid", gap: 8 }}>
          <Skeleton width="40%" />
          <Skeleton width="55%" />
          <Skeleton width="35%" />
        </div>
      ) : projects.length === 0 ? (
        <div style={{ fontSize: 12, color: theme.faint }}>No projects.</div>
      ) : (
        <div style={{ display: "grid", gap: 4 }}>
          {projects.map((p) => {
            // Only the global corpus has no switch; the collector lets any other project, reserved or not, be withheld.
            const always = p.id === GLOBAL_PROJECT_ID;
            return (
              <label
                key={p.id}
                title={always ? "Always shared" : undefined}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 13,
                  color: theme.text,
                  cursor: always ? "default" : "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={always || p.shareable !== false}
                  disabled={always || pending.has(p.id)}
                  title={always ? "Always shared" : undefined}
                  onChange={() => {
                    if (!always) void toggle(p);
                  }}
                  style={{ accentColor: theme.accent }}
                />
                {p.emoji && <span>{p.emoji}</span>}
                <span>{p.name}</span>
                <span style={{ fontFamily: theme.mono, fontSize: 11, color: theme.faint }}>{p.id}</span>
              </label>
            );
          })}
        </div>
      )}
      {error && (
        <div role="alert" style={errorText}>
          {error}
        </div>
      )}
    </div>
  );
}

/** The most recent calls teammates made, newest first as the collector returns them. */
function RecentUsage() {
  const [calls, setCalls] = useState<PublicKnowledgeCall[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(USAGE_URL);
      if (!res.ok) throw new Error(await replyError(res, "Couldn't load usage"));
      const data = (await res.json()) as { calls?: PublicKnowledgeCall[] };
      setCalls(data.calls ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load usage");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ ...label, marginBottom: 0 }}>Recent calls</span>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          title="Refresh recent calls"
          style={{ ...button, padding: "4px 9px", fontSize: 11.5, opacity: loading ? 0.6 : 1 }}
        >
          <LuRefreshCw size={12} /> Refresh
        </button>
      </div>
      <div style={{ ...help, marginTop: 0, marginBottom: 8 }}>
        The call log is advisory: callers on this host can write to it.
      </div>
      {error && <div style={errorText}>{error}</div>}
      {calls === null ? (
        !error && (
          <div style={{ display: "grid", gap: 8 }}>
            <Skeleton />
            <Skeleton />
            <Skeleton />
          </div>
        )
      ) : calls.length === 0 ? (
        <div style={{ padding: "18px 14px", textAlign: "center", color: theme.faint, fontSize: 12.5 }}>No calls yet</div>
      ) : (
        <div style={{ overflowX: "auto", border: `1px solid ${theme.edge}`, borderRadius: 8 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
            <colgroup>
              <col style={{ width: 90 }} />
              <col style={{ width: 120 }} />
              <col style={{ width: 200 }} />
              <col />
              <col style={{ width: 70 }} />
            </colgroup>
            <thead>
              <tr>
                <th style={th}>Time</th>
                <th style={th}>User</th>
                <th style={th}>Endpoint</th>
                <th style={th}>Query</th>
                <th style={{ ...th, textAlign: "right" }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {calls.map((c, i) => {
                const iso = callTime(c.at);
                const ok = c.status >= 200 && c.status < 300;
                return (
                  <tr key={`${iso}-${i}`}>
                    <td style={td} title={absoluteTime(iso)}>
                      {relativeTime(iso)}
                    </td>
                    <td style={{ ...td, color: theme.text, overflow: "hidden", textOverflow: "ellipsis" }}>{c.alias}</td>
                    <td style={{ ...td, overflow: "hidden", textOverflow: "ellipsis" }} title={c.endpoint}>
                      {c.endpoint}
                    </td>
                    <td style={{ ...td, overflow: "hidden", textOverflow: "ellipsis" }} title={c.query}>
                      {c.query}
                    </td>
                    <td
                      style={{
                        ...td,
                        textAlign: "right",
                        color: ok ? theme.done : c.status >= 500 ? theme.waiting : theme.stalled,
                      }}
                    >
                      {c.status}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
