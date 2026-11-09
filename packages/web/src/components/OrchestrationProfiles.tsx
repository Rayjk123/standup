import { useCallback, useEffect, useRef, useState } from "react";
import { LuArrowDown, LuArrowUp, LuCheck, LuPlus, LuTrash2, LuWorkflow, LuX } from "react-icons/lu";
import type { OrchestrationProfile, OrchestrationScope, WhoAmI } from "@standup/shared";
import { theme } from "./theme";
import {
  STEP_KINDS,
  STEP_KIND_LABELS,
  blankProfileForm,
  formToDefinition,
  moveStep,
  newStepDraft,
  profileToForm,
  removeStep,
  validateProfileForm,
  type ProfileForm,
  type StepDraft,
  type StepKind,
} from "../lib/orchestration";

const label: React.CSSProperties = {
  fontFamily: theme.mono, fontSize: 9.5, letterSpacing: "0.14em",
  textTransform: "uppercase", color: theme.faint, display: "block", marginBottom: 5,
};
const field: React.CSSProperties = {
  width: "100%", fontSize: 13, color: theme.text, background: theme.ground,
  border: `1px solid ${theme.edge}`, borderRadius: 6, padding: "8px 10px", outline: "none",
  boxSizing: "border-box",
};
const help: React.CSSProperties = {
  fontSize: 11.5, color: theme.faint, marginTop: 5, lineHeight: 1.5,
};
const mono13: React.CSSProperties = { fontFamily: theme.mono, fontSize: 12 };

/** A GET that treats a non-2xx as failure — mirrors the settings editors. */
async function loadJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return (await res.json()) as T;
}

/** Human copy for each scope's heading + helper text. */
const SCOPE_COPY: Record<OrchestrationScope, { title: string; help: string }> = {
  global: {
    title: "Orchestration profiles · account-wide",
    help: "Named develop → deploy → review workflows every launch on this collector can adopt. A profile's steps are injected as steering and enforced at the completion choke (mark-ready is blocked until its gates pass).",
  },
  personal: {
    title: "Orchestration profiles · yours",
    help: "Your own named develop → deploy → review workflows, resolved for launches you start before the global ones. Steps are injected as steering and enforced before an agent may mark work ready.",
  },
  project: {
    title: "Orchestration profiles · this project",
    help: "Named develop → deploy → review workflows for this project, resolved before your personal and the global ones. Steps are injected as steering and enforced before an agent may mark work ready.",
  },
};

/**
 * The reusable orchestration-profile editor, surfaced at all three scopes
 * (global / personal / project). It self-fetches the scope's profiles and its
 * default on mount and after every mutation, lets you create / edit / delete a
 * profile and set the scope default, and edits a profile's ordered steps
 * (add / remove / reorder, a per-step kind selector, and per-kind fields).
 *
 * Fetch / save / loading / error and the shared-collector write-token handling
 * mirror PersonalizationSettings: writes send x-standup-write-token when present
 * and reveal the token field on a 403. Save PUTs the profile; a 400 surfaces the
 * server's validation message inline, and {@link validateProfileForm} mirrors it
 * client-side so an obvious error is caught before the round-trip — but the
 * server stays the source of truth.
 */
export function OrchestrationProfiles({
  scope,
  projectId,
}: {
  scope: OrchestrationScope;
  projectId?: string;
}) {
  const [profiles, setProfiles] = useState<OrchestrationProfile[]>([]);
  const [defaultName, setDefaultName] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [editing, setEditing] = useState<ProfileForm | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [whoami, setWhoami] = useState<WhoAmI | null>(null);
  // Same out-of-band write-token handling as the profile editors: a shared /
  // multiplayer collector gates orchestration WRITES with STANDUP_WRITE_TOKEN,
  // which the tunnel's identity header alone can't satisfy. Kept in this browser
  // only and sent as x-standup-write-token on a write.
  const [writeToken, setWriteToken] = useState<string>(() => {
    try {
      return localStorage.getItem("standup.writeToken") ?? "";
    } catch {
      return "";
    }
  });
  const [forbidden, setForbidden] = useState(false);

  const scopeQuery = useCallback(() => {
    const p = new URLSearchParams({ scope });
    if (projectId) p.set("projectId", projectId);
    return p.toString();
  }, [scope, projectId]);

  const reload = useCallback(async () => {
    const qs = scopeQuery();
    const [list, def] = await Promise.all([
      loadJson<{ profiles: OrchestrationProfile[] }>(`/api/orchestration/profiles?${qs}`),
      loadJson<{ name: string | null }>(`/api/orchestration/default?${qs}`),
    ]);
    setProfiles(list.profiles);
    setDefaultName(def.name);
  }, [scopeQuery]);

  // Load on mount and whenever the scope/project changes (the editor is reused
  // across projects and must follow the one it is shown for).
  useEffect(() => {
    let live = true;
    setLoaded(false);
    setLoadError(null);
    setEditing(null);
    setFormError(null);
    setActionError(null);
    setConfirmDelete(null);
    setSaved(false);
    loadJson<WhoAmI>("/api/whoami")
      .then((w) => { if (live) setWhoami(w); })
      .catch(() => { /* identity is only for the token field; non-fatal */ });
    reload()
      .catch(() => { if (live) setLoadError("Couldn't load orchestration profiles for this scope."); })
      .finally(() => { if (live) setLoaded(true); });
    return () => { live = false; };
  }, [reload]);

  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current); }, []);

  function flashSaved() {
    setSaved(true);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSaved(false), 2500);
  }

  /**
   * A PUT/DELETE carrying the write token when present. Returns the parsed JSON
   * on success, or a human message + status on failure (revealing the token
   * field on a 403, as the profile editors do).
   */
  async function writeJson(
    url: string,
    method: "PUT" | "DELETE",
    body?: unknown
  ): Promise<{ ok: true; data: unknown } | { ok: false; status: number; error: string }> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const tok = writeToken.trim();
    if (tok) headers["x-standup-write-token"] = tok;
    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      if (res.status === 403) setForbidden(true);
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      return {
        ok: false,
        status: res.status,
        error:
          res.status === 403
            ? "This collector requires the shared write token to save. Paste it below (ask whoever runs the collector) and try again."
            : (data.error ?? `Request failed (${res.status})`),
      };
    }
    return { ok: true, data: await res.json().catch(() => ({})) };
  }

  async function save() {
    if (!editing || busy) return;
    // Mirror the server's validation so an obvious error is caught before the
    // round-trip; the server still re-validates and is the source of truth.
    const clientErr = validateProfileForm(editing);
    if (clientErr) {
      setFormError(clientErr);
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const result = await writeJson("/api/orchestration/profiles", "PUT", {
        name: editing.name.trim(),
        scope,
        projectId,
        definition: formToDefinition(editing),
      });
      if (!result.ok) {
        setFormError(result.error);
        return;
      }
      await reload();
      setEditing(null);
      flashSaved();
    } catch {
      setFormError("Save failed — the collector may be unreachable.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(name: string) {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const url = `/api/orchestration/profiles/${scope}/${encodeURIComponent(name)}${
        projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""
      }`;
      const result = await writeJson(url, "DELETE");
      if (!result.ok) {
        setActionError(result.error);
        return;
      }
      setConfirmDelete(null);
      if (editing?.originalName === name) setEditing(null);
      await reload();
    } catch {
      setActionError("Delete failed — the collector may be unreachable.");
    } finally {
      setBusy(false);
    }
  }

  async function setDefault(name: string | null) {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const result = await writeJson("/api/orchestration/default", "PUT", { scope, projectId, name });
      if (!result.ok) {
        setActionError(result.error);
        return;
      }
      setDefaultName((result.data as { name?: string | null }).name ?? null);
    } catch {
      setActionError("Couldn't update the default profile.");
    } finally {
      setBusy(false);
    }
  }

  // Immutably replace the whole step at `index` (each input passes a fully-typed
  // draft of the step's own kind, so no field from another variant leaks in).
  function setStep(index: number, next: StepDraft) {
    setEditing((f) => (f ? { ...f, steps: f.steps.map((s, i) => (i === index ? next : s)) } : f));
    setFormError(null);
  }
  function reorder(index: number, dir: -1 | 1) {
    setEditing((f) => (f ? { ...f, steps: moveStep(f.steps, index, dir) } : f));
  }
  function dropStep(index: number) {
    setEditing((f) => (f ? { ...f, steps: removeStep(f.steps, index) } : f));
    setFormError(null);
  }
  function addStep() {
    setEditing((f) => (f ? { ...f, steps: [...f.steps, newStepDraft("gate")] } : f));
  }
  function changeKind(index: number, kind: StepKind) {
    setStep(index, newStepDraft(kind));
  }

  if (!loaded) return null;

  const copy = SCOPE_COPY[scope];
  const showTokenField = whoami?.tunnel || forbidden;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
        <LuWorkflow size={15} color={theme.accent} />
        <span style={label}>{copy.title}</span>
      </div>
      <div style={{ ...help, marginTop: 0, marginBottom: 14 }}>{copy.help}</div>

      {loadError && (
        <div style={{ fontFamily: theme.mono, fontSize: 11.5, color: theme.waiting, marginBottom: 12 }}>
          {loadError}
        </div>
      )}

      {/* Default selector — the profile a launch adopts when none is chosen. */}
      <div style={{ marginBottom: 16 }}>
        <span style={label}>Default for this scope</span>
        <select
          value={defaultName ?? ""}
          onChange={(e) => void setDefault(e.target.value || null)}
          disabled={busy}
          style={{ ...field, ...mono13, cursor: busy ? "wait" : "pointer" }}
        >
          <option value="" style={{ background: theme.raised }}>
            (no default)
          </option>
          {profiles.map((p) => (
            <option key={p.name} value={p.name} style={{ background: theme.raised }}>
              {p.name}
            </option>
          ))}
        </select>
        <div style={help}>
          When set, a launch at this scope adopts this profile unless a more specific scope or a
          per-launch override wins. Clear it to leave the scope with no default.
        </div>
      </div>

      {/* Existing profiles — select to edit, or delete (with a confirm). */}
      <div style={{ display: "grid", gap: 8, marginBottom: 14 }}>
        {profiles.length === 0 && !editing && (
          <div style={{ ...help, marginTop: 0 }}>No profiles yet at this scope.</div>
        )}
        {profiles.map((p) => {
          const isEditing = editing?.originalName === p.name;
          return (
            <div
              key={p.name}
              style={{
                display: "flex", alignItems: "center", gap: 10,
                border: `1px solid ${isEditing ? theme.accent : theme.edge}`,
                borderRadius: 8, padding: "8px 10px", background: theme.ground,
              }}
            >
              <button
                onClick={() => {
                  setEditing(profileToForm(p));
                  setFormError(null);
                  setSaved(false);
                }}
                style={{
                  flex: 1, minWidth: 0, textAlign: "left", background: "none", border: "none",
                  cursor: "pointer", color: theme.text, padding: 0,
                }}
              >
                <span style={{ ...mono13, fontWeight: 600 }}>{p.name}</span>
                <span style={{ fontSize: 11, color: theme.faint, marginLeft: 8 }}>
                  {p.steps.length} step{p.steps.length === 1 ? "" : "s"}
                  {p.name === defaultName ? " · default" : ""}
                </span>
              </button>
              {confirmDelete === p.name ? (
                <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <button
                    onClick={() => void remove(p.name)}
                    disabled={busy}
                    style={{
                      fontSize: 12, fontWeight: 600, color: theme.ground, background: theme.waiting,
                      border: "none", borderRadius: 5, padding: "5px 10px", cursor: "pointer",
                    }}
                  >
                    Delete
                  </button>
                  <button
                    onClick={() => setConfirmDelete(null)}
                    style={{ fontSize: 12, color: theme.dim, background: "none", border: "none", cursor: "pointer" }}
                  >
                    Keep
                  </button>
                </span>
              ) : (
                <button
                  onClick={() => { setConfirmDelete(p.name); setActionError(null); }}
                  title="Delete this profile"
                  aria-label={`Delete ${p.name}`}
                  style={{
                    display: "flex", alignItems: "center", background: "none",
                    border: "none", color: theme.faint, cursor: "pointer", padding: 4,
                  }}
                >
                  <LuTrash2 size={14} />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {actionError && (
        <div style={{ fontFamily: theme.mono, fontSize: 11.5, color: theme.waiting, marginBottom: 12 }}>
          {actionError}
        </div>
      )}

      {!editing ? (
        <button
          onClick={() => { setEditing(blankProfileForm()); setFormError(null); setSaved(false); }}
          style={{
            display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 600,
            color: theme.text, background: theme.raised, border: `1px solid ${theme.edge}`,
            borderRadius: 6, padding: "8px 14px", cursor: "pointer",
          }}
        >
          <LuPlus size={14} /> New profile
        </button>
      ) : (
        <div style={{ border: `1px solid ${theme.edge}`, borderRadius: 10, padding: "16px 16px 18px", background: theme.surface }}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: 14 }}>
            <span style={{ fontSize: 13.5, fontWeight: 700 }}>
              {editing.originalName ? `Edit ${editing.originalName}` : "New profile"}
            </span>
            <span style={{ flex: 1 }} />
            <button
              onClick={() => { setEditing(null); setFormError(null); }}
              aria-label="Close editor"
              style={{ background: "none", border: "none", color: theme.faint, cursor: "pointer", display: "flex", padding: 4 }}
            >
              <LuX size={15} />
            </button>
          </div>

          <div style={{ display: "grid", gap: 16 }}>
            {/* Name — the profile's key. Fixed while editing an existing one: the
                store has no rename, so a changed name would upsert a second. */}
            <div>
              <span style={label}>Name</span>
              <input
                value={editing.name}
                onChange={(e) => { setEditing((f) => (f ? { ...f, name: e.target.value } : f)); setFormError(null); }}
                disabled={editing.originalName !== null}
                placeholder="e.g. ship-safely"
                style={{ ...field, ...mono13, opacity: editing.originalName !== null ? 0.6 : 1 }}
              />
              <div style={help}>
                {editing.originalName !== null
                  ? "A profile can't be renamed — delete and recreate to change the name."
                  : "Letters, numbers, dashes. No slashes; must be under 200 characters."}
              </div>
            </div>

            {/* Steps — ordered; add / remove / reorder; per-kind fields. */}
            <div>
              <span style={label}>Steps · run in order</span>
              <div style={{ display: "grid", gap: 10 }}>
                {editing.steps.length === 0 && (
                  <div style={{ ...help, marginTop: 0 }}>
                    No steps yet — add a gate, deploy, review, or human-pause step below.
                  </div>
                )}
                {editing.steps.map((step, i) => (
                  <div
                    key={i}
                    style={{ border: `1px solid ${theme.edge}`, borderRadius: 8, padding: "10px 12px", background: theme.ground }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                      <span style={{ fontFamily: theme.mono, fontSize: 10.5, color: theme.faint }}>
                        {i + 1}.
                      </span>
                      <select
                        value={step.kind}
                        onChange={(e) => changeKind(i, e.target.value as StepKind)}
                        style={{ ...field, ...mono13, width: "auto", flex: 1, cursor: "pointer" }}
                      >
                        {STEP_KINDS.map((k) => (
                          <option key={k} value={k} style={{ background: theme.raised }}>
                            {STEP_KIND_LABELS[k]}
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() => reorder(i, -1)}
                        disabled={i === 0}
                        title="Move up"
                        aria-label="Move step up"
                        style={stepIconBtn(i === 0)}
                      >
                        <LuArrowUp size={14} />
                      </button>
                      <button
                        onClick={() => reorder(i, 1)}
                        disabled={i === editing.steps.length - 1}
                        title="Move down"
                        aria-label="Move step down"
                        style={stepIconBtn(i === editing.steps.length - 1)}
                      >
                        <LuArrowDown size={14} />
                      </button>
                      <button
                        onClick={() => dropStep(i)}
                        title="Remove step"
                        aria-label="Remove step"
                        style={stepIconBtn(false)}
                      >
                        <LuTrash2 size={14} />
                      </button>
                    </div>
                    {renderStepFields(step, i, setStep)}
                  </div>
                ))}
              </div>
              <button
                onClick={addStep}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 6, marginTop: 10,
                  fontSize: 12, fontWeight: 600, color: theme.text, background: theme.raised,
                  border: `1px solid ${theme.edge}`, borderRadius: 6, padding: "6px 12px", cursor: "pointer",
                }}
              >
                <LuPlus size={13} /> Add step
              </button>
            </div>

            {/* Profile-level review defaults. */}
            <div style={{ display: "flex", gap: 12 }}>
              <div style={{ flex: 1 }}>
                <span style={label}>Max review rounds</span>
                <input
                  type="number"
                  min={1}
                  value={editing.maxReviewRounds}
                  onChange={(e) => { setEditing((f) => (f ? { ...f, maxReviewRounds: e.target.value } : f)); setFormError(null); }}
                  placeholder="e.g. 3"
                  style={{ ...field, ...mono13 }}
                />
                <div style={help}>Caps any review step that omits its own rounds.</div>
              </div>
              <div style={{ flex: 1 }}>
                <span style={label}>Block on severity</span>
                <select
                  value={editing.blockOnSeverity}
                  onChange={(e) => { setEditing((f) => (f ? { ...f, blockOnSeverity: e.target.value as ProfileForm["blockOnSeverity"] } : f)); setFormError(null); }}
                  style={{ ...field, ...mono13, cursor: "pointer" }}
                >
                  <option value="" style={{ background: theme.raised }}>(inherit)</option>
                  <option value="high" style={{ background: theme.raised }}>high</option>
                  <option value="medium" style={{ background: theme.raised }}>medium</option>
                </select>
                <div style={help}>The threshold a review step inherits when it sets none.</div>
              </div>
            </div>
          </div>

          {formError && (
            <div style={{ fontFamily: theme.mono, fontSize: 11.5, color: theme.waiting, marginTop: 14, lineHeight: 1.5 }}>
              {formError}
            </div>
          )}

          <div style={{ display: "flex", gap: 8, marginTop: 18, alignItems: "center" }}>
            <button
              onClick={() => void save()}
              disabled={busy}
              style={{
                fontSize: 13, fontWeight: 600, color: theme.ground, background: theme.checkpoint,
                border: "none", borderRadius: 6, padding: "9px 18px",
                cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.5 : 1,
              }}
            >
              {busy ? "Saving…" : editing.originalName ? "Save changes" : "Create profile"}
            </button>
            <button
              onClick={() => { setEditing(null); setFormError(null); }}
              disabled={busy}
              style={{
                fontSize: 13, color: theme.dim, background: "none",
                border: `1px solid ${theme.edge}`, borderRadius: 6, padding: "9px 16px", cursor: "pointer",
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {saved && (
        <div style={{ fontFamily: theme.mono, fontSize: 11.5, color: theme.checkpoint, marginTop: 14, display: "flex", alignItems: "center", gap: 5 }}>
          <LuCheck /> Saved.
        </div>
      )}

      {/* Write token — only a shared / network collector needs it. */}
      {showTokenField && (
        <div style={{ marginTop: 16 }}>
          <span style={label}>Write token · shared / network collector</span>
          <input
            type="password"
            value={writeToken}
            onChange={(e) => {
              setWriteToken(e.target.value);
              try { localStorage.setItem("standup.writeToken", e.target.value); } catch { /* private mode — token just won't persist */ }
            }}
            placeholder="x-standup-write-token — only if the collector requires one"
            style={{ ...field, ...mono13 }}
          />
          <div style={help}>
            A shared collector gates orchestration writes with an out-of-band secret
            (STANDUP_WRITE_TOKEN). Paste it once — it stays in this browser only and is sent as the
            x-standup-write-token header when you save.
          </div>
        </div>
      )}
    </div>
  );
}

/** Style for a small icon button in a step's control row. */
function stepIconBtn(disabled: boolean): React.CSSProperties {
  return {
    display: "flex", alignItems: "center", justifyContent: "center",
    background: "none", border: `1px solid ${theme.edge}`, borderRadius: 5,
    color: theme.faint, padding: 5, cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.4 : 1,
  };
}

/** The per-kind field block for one step, wired to replace that step on change. */
function renderStepFields(
  step: StepDraft,
  index: number,
  setStep: (index: number, next: StepDraft) => void
): React.ReactNode {
  switch (step.kind) {
    case "gate":
      return (
        <div style={{ display: "grid", gap: 8 }}>
          <input
            value={step.name}
            onChange={(e) => setStep(index, { ...step, name: e.target.value })}
            placeholder="Gate name — e.g. build-green"
            style={{ ...field, ...mono13 }}
          />
          <input
            value={step.command}
            onChange={(e) => setStep(index, { ...step, command: e.target.value })}
            placeholder="Command — must exit 0, e.g. bun run build && bun test"
            style={{ ...field, ...mono13 }}
          />
        </div>
      );
    case "deploy":
      return (
        <div style={{ display: "grid", gap: 8 }}>
          <input
            value={step.account}
            onChange={(e) => setStep(index, { ...step, account: e.target.value })}
            placeholder="Account (optional) — e.g. 111122223333"
            style={{ ...field, ...mono13 }}
          />
          <input
            value={step.role}
            onChange={(e) => setStep(index, { ...step, role: e.target.value })}
            placeholder="Role (optional) — e.g. Admin"
            style={{ ...field, ...mono13 }}
          />
          <input
            value={step.command}
            onChange={(e) => setStep(index, { ...step, command: e.target.value })}
            placeholder="Deploy command — e.g. npx cdk deploy MyStack-beta --exclusively"
            style={{ ...field, ...mono13 }}
          />
          <div style={{ ...help, marginTop: 0 }}>At least one of account, role, or command is required.</div>
        </div>
      );
    case "review":
      return (
        <div style={{ display: "flex", gap: 8 }}>
          <div style={{ flex: "0 0 90px" }}>
            <input
              type="number"
              min={1}
              value={step.rounds}
              onChange={(e) => setStep(index, { ...step, rounds: e.target.value })}
              placeholder="rounds"
              style={{ ...field, ...mono13 }}
            />
          </div>
          <div style={{ flex: "0 0 120px" }}>
            <select
              value={step.blockOnSeverity}
              onChange={(e) => setStep(index, { ...step, blockOnSeverity: e.target.value as "" | "high" | "medium" })}
              style={{ ...field, ...mono13, cursor: "pointer" }}
            >
              <option value="" style={{ background: theme.raised }}>(inherit)</option>
              <option value="high" style={{ background: theme.raised }}>high</option>
              <option value="medium" style={{ background: theme.raised }}>medium</option>
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <input
              value={step.lens}
              onChange={(e) => setStep(index, { ...step, lens: e.target.value })}
              placeholder="lens (optional) — e.g. security"
              style={{ ...field, ...mono13 }}
            />
          </div>
        </div>
      );
  }
}
