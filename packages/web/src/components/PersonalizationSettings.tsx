import { useEffect, useRef, useState } from "react";
import { LuCheck, LuEye, LuPencil } from "react-icons/lu";
import type { UserPrefs, WhoAmI } from "@standup/shared";
import { theme } from "./theme";
import { Markdown } from "./Markdown";
import { OrchestrationProfiles } from "./OrchestrationProfiles";
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
 * A GET that treats a non-2xx as failure. The prefs form Saves with a
 * FULL-REPLACE PUT, so a swallowed load failure (empty form → Save) would blank
 * out the stored profile; the caller uses this to prove the initial load
 * actually succeeded before allowing a Save.
 */
async function loadJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return (await res.json()) as T;
}

/**
 * The per-user profile editor — "a CLAUDE.md for each user". A sibling to
 * ReviewSettings / WorkspaceRootSetting, but keyed by the acting alias rather
 * than a project: it edits `personalInstructions` (markdown), `reviewRigor`,
 * and the `deployTarget` context, all of which the launcher appends to the
 * opening prompt of every session THIS user launches (see
 * formatUserPrefsInstruction in the collector).
 *
 * Self-fetches identity from /api/whoami and the stored profile from
 * /api/users/me/prefs, exactly the way WorkspaceRootSetting reads /api/settings.
 * Save is a FULL REPLACE (PUT) — every field is sent every time, so clearing a
 * box and saving clears the stored value; the form is the single source.
 *
 * Renders as the You tab's profile section; the tab supplies the scroll
 * container and page width.
 */
export function PersonalizationSettings() {
  const [whoami, setWhoami] = useState<WhoAmI | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Distinct from `loaded`: did the initial load actually SUCCEED? A failed load
  // still finishes (loaded=true) but leaves the form empty, so Save is blocked
  // until a good load seeds it — otherwise a full-replace PUT wipes the profile.
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

  // A shared/multiplayer collector gates profile WRITES with an out-of-band
  // secret (STANDUP_WRITE_TOKEN): the tunnel's identity header alone can't
  // authorize one. Kept in this browser only and sent as x-standup-write-token
  // on Save so a tunnel user can persist their profile. Surfaced for tunnel
  // users, and for anyone whose Save was refused 403 (a token-gated collector).
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

  useEffect(() => {
    let live = true;
    Promise.all([
      loadJson<WhoAmI>("/api/whoami"),
      loadJson<UserPrefs>("/api/users/me/prefs"),
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
            "Couldn't load your saved profile — reload before editing. Saving now would overwrite it with blanks."
          );
      })
      .finally(() => {
        if (live) setLoaded(true);
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current); }, []);

  async function save() {
    if (busy) return;
    // Block a Save when the initial load never succeeded: the form is empty not
    // because the profile is empty but because we couldn't read it, and a
    // full-replace PUT would persist those blanks over the real profile.
    if (!loadOk) {
      setError(
        "Can't save — your profile didn't load, so saving would overwrite it. Reload the page and try again."
      );
      return;
    }
    setBusy(true); setError(null); setSaved(false);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      // Present the out-of-band write token when one has been entered — required
      // by a token-gated (shared/multiplayer) collector, ignored by a loopback one.
      const tok = writeToken.trim();
      if (tok) headers["x-standup-write-token"] = tok;
      const res = await fetch("/api/users/me/prefs", {
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
        // A 403 means this collector gates writes on the shared secret — reveal
        // the token field so the user can paste it and retry, rather than being
        // stuck with no remedy.
        if (res.status === 403) setForbidden(true);
        const data = await res.json().catch(() => ({}));
        setError(
          res.status === 403
            ? "This collector requires the shared write token to save a profile. Paste it below (ask whoever runs the collector) and Save again."
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
    <div>
        {/* Identity — "you are <alias>". */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
          <div
            style={{
              width: 34, height: 34, borderRadius: 999, flexShrink: 0,
              background: theme.accentSoft, border: `1px solid ${theme.accent}`,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontFamily: theme.mono, fontSize: 14, fontWeight: 700, color: theme.accent,
              textTransform: "uppercase",
            }}
          >
            {alias.slice(0, 2)}
          </div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>
              You are <span style={{ color: theme.accent }}>{alias}</span>
            </div>
            <div style={{ fontFamily: theme.mono, fontSize: 10.5, color: theme.faint, marginTop: 2 }}>
              {whoami?.tunnel
                ? "identified through the tunnel's identity header"
                : "local host user — no tunnel identity on this request"}
            </div>
          </div>
        </div>

        <div style={{ fontSize: 12.5, color: theme.dim, lineHeight: 1.6, margin: "12px 0 22px" }}>
          Your personal profile — a CLAUDE.md that is yours. It is appended to the opening
          prompt of every session you launch, and follows you across the gateway to any
          machine you reach. It is not a security boundary; teammates on this collector may
          see it.
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
                rows={8}
                placeholder={"e.g.\n- Write tests alongside every behavior change.\n- Keep pull requests small and focused on one change.\n- Ask before adding a new dependency."}
                style={{ ...field, fontFamily: theme.mono, fontSize: 12, lineHeight: 1.5, resize: "vertical" }}
              />
            )}
            <div style={help}>Freeform. The whole thing is prepended to the agent's opening prompt as your standing instructions.</div>
          </div>

          {/* Review rigor — structured, but stored/injected as prose. */}
          <div>
            <span style={label}>Review rigor</span>
            <textarea
              value={reviewRigor}
              onChange={(e) => { setReviewRigor(e.target.value); setSaved(false); }}
              rows={2}
              placeholder="e.g. Before you stop, review your own diff for bugs and missing tests, and fix what you find."
              style={{ ...field, fontSize: 12.5, resize: "vertical" }}
            />
            <div style={help}>How thorough a review you want when work wraps — injected as instruction and used as your default when you trigger a review flow.</div>
          </div>

          {/* Deploy target — context only, never credentials. */}
          <div>
            <span style={label}>Deploy target · context, not credentials</span>
            <div style={{ display: "grid", gap: 8 }}>
              <input
                value={account}
                onChange={(e) => { setAccount(e.target.value); setSaved(false); }}
                placeholder="Account — e.g. 111122223333"
                style={{ ...field, fontFamily: theme.mono, fontSize: 12 }}
              />
              <input
                value={role}
                onChange={(e) => { setRole(e.target.value); setSaved(false); }}
                placeholder="Role — e.g. developer"
                style={{ ...field, fontFamily: theme.mono, fontSize: 12 }}
              />
              <textarea
                value={command}
                onChange={(e) => { setCommand(e.target.value); setSaved(false); }}
                rows={2}
                placeholder="Deploy command — e.g. make deploy ENV=staging"
                style={{ ...field, fontFamily: theme.mono, fontSize: 12, resize: "vertical" }}
              />
            </div>
            <div style={help}>
              Injected as reference so the agent knows where you deploy. Standup stores no
              secrets — the agent authenticates with your own ambient credentials.
            </div>
          </div>

          {/* Write token — only a shared/network collector needs it (see the
              trusted-write gate); a loopback collector ignores it. */}
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
            <LuCheck /> Saved — applies to your next launch.
          </div>
        )}

        <div style={{ marginTop: 20 }}>
          <button onClick={() => void save()} disabled={busy || !loadOk} style={{
            fontSize: 13, fontWeight: 600, color: theme.ground, background: theme.checkpoint,
            border: "none", borderRadius: 6, padding: "9px 18px",
            cursor: busy || !loadOk ? "not-allowed" : "pointer", opacity: busy || !loadOk ? 0.5 : 1,
          }}>{busy ? "Saving…" : "Save your profile"}</button>
        </div>

        {/* Your personal orchestration profiles — self-fetching, self-saving,
            distinct from the profile Save above. */}
        <div style={{ marginTop: 34, paddingTop: 26, borderTop: `1px solid ${theme.edgeSoft}` }}>
          <OrchestrationProfiles scope="personal" />
        </div>

        {/* Your default delivery pipeline — self-fetching, self-saving. */}
        <div style={{ marginTop: 34, paddingTop: 26, borderTop: `1px solid ${theme.edgeSoft}` }}>
          <PipelineSettings />
        </div>
    </div>
  );
}
