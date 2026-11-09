import { useEffect, useRef, useState } from "react";
import { LuCheck, LuEye, LuPencil, LuUser } from "react-icons/lu";
import type { UserPrefs, WhoAmI } from "@standup/shared";
import { theme } from "./theme";
import { Markdown } from "./Markdown";
import { PipelineSettings } from "./PipelineSettings";

const label: React.CSSProperties = {
  fontFamily: theme.mono, fontSize: 9.5, letterSpacing: "0.14em",
  textTransform: "uppercase", color: theme.faint, display: "block", marginBottom: 5,
};
const field: React.CSSProperties = {
  width: "100%", fontSize: 13, color: theme.text, background: theme.ground,
  border: `1px solid ${theme.edge}`, borderRadius: 6, padding: "8px 10px", outline: "none",
};
const help: React.CSSProperties = {
  fontSize: 11.5, color: theme.faint, marginTop: 5, lineHeight: 1.5,
};

/**
 * A GET that treats a non-2xx as failure. This form Saves with a FULL-REPLACE
 * PUT, so a swallowed load failure (empty form → Save) would blank the stored
 * overlay; the caller uses this to prove the initial load succeeded before
 * allowing a Save. Mirrors PersonalizationSettings.
 */
async function loadJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return (await res.json()) as T;
}

/**
 * The per-USER, per-PROJECT instructions overlay (§H) — "your CLAUDE.md for
 * THIS project", distinct from the shared project `setup` / review config next
 * to it in Configure. It edits the same three fields as the global profile
 * (PersonalizationSettings / the "You" panel), scoped to one project, through
 * `/api/users/me/prefs?project=<id>`.
 *
 * At launch the collector MERGES this on top of the global profile: your global
 * personal instructions AND these both apply (these come after), while the
 * structured review rigor / deploy target here OVERRIDE the global ones — so a
 * per-project deploy target is the motivating case. Save is a FULL REPLACE, like
 * the global editor: clearing a box and saving clears the stored value.
 */
export function ProjectPersonalization({
  projectId, projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const [whoami, setWhoami] = useState<WhoAmI | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Distinct from `loaded`: did the initial load actually SUCCEED? A failed load
  // still finishes (loaded=true) but leaves the form empty, so Save is blocked
  // until a good load seeds it — otherwise a full-replace PUT wipes the overlay.
  const [loadOk, setLoadOk] = useState(false);

  const [personalInstructions, setPersonalInstructions] = useState("");
  const [reviewRigor, setReviewRigor] = useState("");
  const [account, setAccount] = useState("");
  const [role, setRole] = useState("");
  const [command, setCommand] = useState("");
  const [preview, setPreview] = useState(false);

  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Same out-of-band write-token handling as the global editor: a
  // shared/multiplayer collector gates profile WRITES with STANDUP_WRITE_TOKEN,
  // which the tunnel's identity header alone can't satisfy. Kept in this browser
  // only and sent as x-standup-write-token on Save.
  const [writeToken, setWriteToken] = useState<string>(() => {
    try {
      return localStorage.getItem("standup.writeToken") ?? "";
    } catch {
      return "";
    }
  });
  const [forbidden, setForbidden] = useState(false);

  function seed(prefs: UserPrefs) {
    setPersonalInstructions(prefs.personalInstructions ?? "");
    setReviewRigor(prefs.reviewRigor ?? "");
    setAccount(prefs.deployTarget?.account ?? "");
    setRole(prefs.deployTarget?.role ?? "");
    setCommand(prefs.deployTarget?.command ?? "");
  }

  // Re-load when switching projects while this panel stays mounted (projectId
  // changes) — the overlay is per-project, so the form must follow it.
  useEffect(() => {
    let live = true;
    setLoaded(false);
    setLoadOk(false);
    setSaved(false);
    setError(null);
    Promise.all([
      loadJson<WhoAmI>("/api/whoami"),
      loadJson<UserPrefs>(`/api/users/me/prefs?project=${encodeURIComponent(projectId)}`),
    ])
      .then(([who, prefs]) => {
        if (!live) return;
        setWhoami(who);
        seed(prefs);
        setLoadOk(true);
      })
      .catch(() => {
        if (live)
          setError(
            "Couldn't load your saved instructions — reload before editing. Saving now would overwrite them with blanks."
          );
      })
      .finally(() => {
        if (live) setLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [projectId]);

  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current); }, []);

  async function save() {
    if (busy) return;
    // Block a Save when the initial load never succeeded: the form is empty not
    // because the overlay is empty but because we couldn't read it, and a
    // full-replace PUT would persist those blanks over the real overlay.
    if (!loadOk) {
      setError(
        "Can't save — your instructions didn't load, so saving would overwrite them. Reload the page and try again."
      );
      return;
    }
    setBusy(true); setError(null); setSaved(false);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const tok = writeToken.trim();
      if (tok) headers["x-standup-write-token"] = tok;
      const res = await fetch(`/api/users/me/prefs?project=${encodeURIComponent(projectId)}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          personalInstructions,
          reviewRigor,
          // The store normalizes an all-blank target to null, so blank fields
          // clear the stored deploy context without a special case here.
          deployTarget: { account, role, command },
        }),
      });
      if (!res.ok) {
        if (res.status === 403) setForbidden(true);
        const data = await res.json().catch(() => ({}));
        setError(
          res.status === 403
            ? "This collector requires the shared write token to save. Paste it below (ask whoever runs the collector) and Save again."
            : (data.error ?? `Save failed (${res.status})`)
        );
        return;
      }
      // Re-seed from the stored row so the form reflects exactly what persisted
      // (trimmed strings, dropped empty deploy target).
      seed((await res.json()) as UserPrefs);
      setSaved(true);
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaved(false), 2500);
    } catch {
      setError("Save failed — the collector may be unreachable.");
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return null;

  const alias = whoami?.user ?? "local";

  return (
    <div style={{ padding: "16px 20px 8px", maxWidth: 620, borderTop: `1px solid ${theme.edgeSoft}` }}>
      {/* Header — unmistakably per-USER, not shared team config. */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <LuUser size={15} color={theme.accent} />
        <span style={{ fontSize: 13.5, fontWeight: 700 }}>
          Your instructions for {projectName}
        </span>
        <span
          style={{
            fontFamily: theme.mono, fontSize: 9, letterSpacing: "0.1em",
            textTransform: "uppercase", color: theme.accent,
            background: theme.accentSoft, border: `1px solid ${theme.accent}`,
            borderRadius: 4, padding: "1px 6px",
          }}
        >
          {alias} only
        </span>
      </div>

      <div style={{ fontSize: 12, color: theme.dim, lineHeight: 1.6, marginBottom: 18 }}>
        A personal overlay layered on top of your global profile for THIS project only — not
        shared team config. At launch your global instructions and these both apply (these
        come after), and the review rigor / deploy target here OVERRIDE your global ones.
        A per-project deploy target lives here naturally.
      </div>

      <div style={{ display: "grid", gap: 20 }}>
        {/* Personal instructions — the freeform markdown catch-all. */}
        <div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 5 }}>
            <span style={{ ...label, marginBottom: 0 }}>Personal instructions · markdown</span>
            <button
              onClick={() => setPreview((p) => !p)}
              title={preview ? "Edit" : "Preview rendered markdown"}
              style={{
                display: "flex", alignItems: "center", gap: 4,
                fontFamily: theme.mono, fontSize: 10, color: theme.faint,
                background: "none", border: `1px solid ${theme.edge}`, borderRadius: 5,
                padding: "2px 8px", cursor: "pointer",
              }}
            >
              {preview ? <LuPencil size={11} /> : <LuEye size={11} />}
              {preview ? "Edit" : "Preview"}
            </button>
          </div>
          {preview ? (
            <div
              style={{
                ...field, minHeight: 120, fontSize: 13, lineHeight: 1.55,
                color: personalInstructions.trim() ? theme.text : theme.faint,
              }}
            >
              {personalInstructions.trim()
                ? <Markdown>{personalInstructions}</Markdown>
                : "Nothing to preview yet."}
            </div>
          ) : (
            <textarea
              value={personalInstructions}
              onChange={(e) => { setPersonalInstructions(e.target.value); setSaved(false); }}
              rows={6}
              placeholder={`e.g. things true only in ${projectName}:\n- Build with \`npm run build\` before you commit.\n- The beta account is 444455556666 (us-west-2).`}
              style={{ ...field, fontFamily: theme.mono, fontSize: 12, lineHeight: 1.5, resize: "vertical" }}
            />
          )}
          <div style={help}>Appended AFTER your global instructions in the opening prompt — both apply.</div>
        </div>

        {/* Review rigor — project value overrides the global when set. */}
        <div>
          <span style={label}>Review rigor · overrides your global</span>
          <textarea
            value={reviewRigor}
            onChange={(e) => { setReviewRigor(e.target.value); setSaved(false); }}
            rows={2}
            placeholder="Leave blank to use your global review rigor for this project."
            style={{ ...field, fontSize: 12.5, resize: "vertical" }}
          />
          <div style={help}>When set, replaces your global review rigor for launches in this project. Blank = use the global one.</div>
        </div>

        {/* Deploy target — context only, never credentials; overrides the global. */}
        <div>
          <span style={label}>Deploy target · this project · context, not credentials</span>
          <div style={{ display: "grid", gap: 8 }}>
            <input
              value={account}
              onChange={(e) => { setAccount(e.target.value); setSaved(false); }}
              placeholder="Account — e.g. 444455556666"
              style={{ ...field, fontFamily: theme.mono, fontSize: 12 }}
            />
            <input
              value={role}
              onChange={(e) => { setRole(e.target.value); setSaved(false); }}
              placeholder="Role — e.g. Admin"
              style={{ ...field, fontFamily: theme.mono, fontSize: 12 }}
            />
            <textarea
              value={command}
              onChange={(e) => { setCommand(e.target.value); setSaved(false); }}
              rows={2}
              placeholder="Deploy command — e.g. npx cdk deploy MyStack-beta --exclusively"
              style={{ ...field, fontFamily: theme.mono, fontSize: 12, resize: "vertical" }}
            />
          </div>
          <div style={help}>
            When set, overrides your global deploy target for this project. Standup stores no
            secrets — the agent authenticates with your own ambient credentials.
          </div>
        </div>

        {/* Write token — only a shared/network collector needs it. */}
        {(whoami?.tunnel || forbidden) && (
          <div>
            <span style={label}>Write token · shared / network collector</span>
            <input
              type="password"
              value={writeToken}
              onChange={(e) => {
                setWriteToken(e.target.value);
                try { localStorage.setItem("standup.writeToken", e.target.value); } catch { /* private mode — token just won't persist */ }
                setSaved(false);
              }}
              placeholder="x-standup-write-token — only if the collector requires one"
              style={{ ...field, fontFamily: theme.mono, fontSize: 12 }}
            />
            <div style={help}>
              A shared collector gates profile writes with an out-of-band secret
              (STANDUP_WRITE_TOKEN). Paste it once — it stays in this browser only and is
              sent as the x-standup-write-token header when you Save.
            </div>
          </div>
        )}
      </div>

      {error && (
        <div style={{ fontFamily: theme.mono, fontSize: 11.5, color: theme.waiting, marginTop: 16 }}>{error}</div>
      )}
      {saved && !error && (
        <div style={{ fontFamily: theme.mono, fontSize: 11.5, color: theme.checkpoint, marginTop: 16, display: "flex", alignItems: "center", gap: 5 }}>
          <LuCheck /> Saved — applies to your next launch in {projectName}.
        </div>
      )}

      <div style={{ marginTop: 18, borderBottom: `1px solid ${theme.edgeSoft}`, paddingBottom: 20 }}>
        <button onClick={() => void save()} disabled={busy || !loadOk} style={{
          fontSize: 13, fontWeight: 600, color: theme.ground, background: theme.checkpoint,
          border: "none", borderRadius: 6, padding: "9px 18px",
          cursor: busy || !loadOk ? "not-allowed" : "pointer", opacity: busy || !loadOk ? 0.5 : 1,
        }}>{busy ? "Saving…" : "Save your instructions"}</button>
      </div>

      {/* Your pipeline override for this project — self-fetching, self-saving. */}
      <div style={{ paddingTop: 18, paddingBottom: 20, borderBottom: `1px solid ${theme.edgeSoft}` }}>
        <PipelineSettings projectId={projectId} />
      </div>
    </div>
  );
}
