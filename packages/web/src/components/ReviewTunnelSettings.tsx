import type { CSSProperties, ReactNode } from "react";
import {
  DEFAULT_REVIEW_TUNNEL_NAME_PATTERN,
  DEFAULT_REVIEW_TUNNEL_PORT_RANGE,
  DEFAULT_REVIEW_TUNNEL_TTL_HOURS,
  mergeReviewTunnelConfig,
  reviewTunnelActive,
  validateReviewTunnelConfig,
} from "@standup/shared";
import type { ReviewTunnelConfig, ReviewTunnelLayer } from "@standup/shared";
import { theme } from "./theme";

type TextKey = "dir" | "setup" | "setupSkipIf" | "serve" | "namePattern" | "allow" | "region";

const TEXT_FIELDS: Array<{ key: TextKey; label: string; hint: string }> = [
  { key: "dir", label: "Serve from", hint: "Directory inside the worktree, e.g. packages/ui" },
  { key: "serve", label: "Serve command", hint: "{port} is replaced with the allocated port; run without a shell" },
  { key: "setup", label: "Setup command", hint: "Runs first, unless the skip path exists" },
  { key: "setupSkipIf", label: "Skip setup if", hint: "e.g. node_modules" },
  { key: "namePattern", label: "Tunnel name", hint: "<owner>-… with <job-slug>, <user>, <launch>" },
  { key: "allow", label: "Allow", hint: "Users or groups, in the form the tunnel provider's {allow} option takes; just you when blank" },
  { key: "region", label: "Region", hint: "The tunnel provider's region; its default when blank" },
];

/** Fields that name paths or identifiers, stored trimmed (commands keep their spacing). */
const PATH_FIELDS: ReadonlySet<TextKey> = new Set(["dir", "setupSkipIf", "namePattern", "allow", "region"]);

/**
 * The review-tunnel part of a pipeline layer: how the project's UI is served
 * for review when a run reaches its screenshot stage. `own` is this layer's
 * fields, `inherited` what the layers beneath it (your global layer and the
 * project's built-in seed) already set, shown as placeholders. A blank field
 * inherits.
 */
export function ReviewTunnelSettings({
  own,
  inherited,
  scope,
  onChange,
}: {
  own: ReviewTunnelLayer | undefined;
  inherited: ReviewTunnelConfig | undefined;
  scope: "global" | "project";
  onChange: (next: ReviewTunnelLayer | undefined) => void;
}) {
  const layer = own ?? {};
  const effective = mergeReviewTunnelConfig([inherited, own]);
  const active = reviewTunnelActive(effective);
  const problems = own ? validateReviewTunnelConfig(own) : [];

  const set = <K extends keyof ReviewTunnelConfig>(key: K, value: ReviewTunnelConfig[K] | undefined) => {
    const next: ReviewTunnelLayer = { ...layer };
    if (value === undefined || value === "") delete next[key];
    else next[key] = value;
    onChange(Object.keys(next).length > 0 ? next : undefined);
  };
  // What a field falls back to beneath this layer: nothing when this layer clears it (null), so the default applies.
  const below = <K extends keyof ReviewTunnelConfig>(key: K): ReviewTunnelConfig[K] | undefined =>
    layer[key] === null ? undefined : inherited?.[key];
  const range = layer.portRange ?? undefined;
  const inheritedRange = below("portRange") ?? DEFAULT_REVIEW_TUNNEL_PORT_RANGE;
  // Clearing one end falls back to the inherited value for it; clearing both drops the layer's range.
  const setRange = (i: 0 | 1, text: string) => {
    const n = Number.parseInt(text, 10);
    const cur: [number, number] = range ? [range[0], range[1]] : [inheritedRange[0], inheritedRange[1]];
    cur[i] = Number.isFinite(n) ? n : inheritedRange[i];
    const same = cur[0] === inheritedRange[0] && cur[1] === inheritedRange[1];
    set("portRange", same ? undefined : cur);
  };
  const enabled = layer.enabled ?? below("enabled") ?? true;

  return (
    <div data-testid="review-tunnel-settings" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 700, color: theme.text }}>Review tunnel</div>
        <div style={help}>
          When a run reaches Screenshots, Standup serves the branch build and opens an HTTPS tunnel to it for review. It is torn
          down when the job closes, the review is decided or the tunnel goes stale.{" "}
          {scope === "global" ? "Settings here apply to every project; a project's own settings win." : "Blank fields use your default and the project's built-in settings."}
        </div>
      </div>

      <div
        data-testid="review-tunnel-effective"
        style={{
          ...mono,
          padding: "8px 10px",
          borderRadius: 6,
          border: `1px solid ${active ? theme.checkpoint : theme.edgeSoft}`,
          color: active ? theme.text : theme.faint,
          lineHeight: 1.6,
        }}
      >
        {active ? (
          <>
            <div>
              On — serves <code>{effective!.serve}</code>
              {effective!.dir ? (
                <>
                  {" "}
                  from <code>{effective!.dir}</code>
                </>
              ) : null}
            </div>
            <div>
              ports {(effective!.portRange ?? DEFAULT_REVIEW_TUNNEL_PORT_RANGE).join("–")} · name{" "}
              {effective!.namePattern ?? DEFAULT_REVIEW_TUNNEL_NAME_PATTERN} · allow {effective!.allow ?? "you only"} · closes after{" "}
              {effective!.ttlHours ?? DEFAULT_REVIEW_TUNNEL_TTL_HOURS}h
            </div>
          </>
        ) : effective?.enabled === false ? (
          "Off for this scope — no tunnel opens."
        ) : (
          "No tunnel — no serve command is configured, so this project has no UI to serve."
        )}
      </div>

      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: theme.text }}>
        <input
          type="checkbox"
          aria-label="Review tunnel enabled"
          checked={enabled}
          onChange={(e) => set("enabled", e.target.checked ? (below("enabled") === false ? true : undefined) : false)}
        />
        Open review tunnels{scope === "project" ? " for this project" : ""}
      </label>

      <div style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "6px 10px", alignItems: "center" }}>
        {TEXT_FIELDS.map((f) => (
          <FieldRow key={f.key} label={f.label}>
            <input
              aria-label={`Review tunnel ${f.label}`}
              value={layer[f.key] ?? ""}
              placeholder={layer[f.key] === null ? "cleared by this layer — not used" : (inherited?.[f.key] ?? f.hint)}
              onChange={(e) => set(f.key, e.target.value.trim() ? (PATH_FIELDS.has(f.key) ? e.target.value.trim() : e.target.value) : undefined)}
              style={{ ...input, width: "100%", boxSizing: "border-box", fontFamily: theme.mono }}
            />
          </FieldRow>
        ))}
        <FieldRow label="Port range">
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              type="number"
              aria-label="Review tunnel port range low"
              value={range?.[0] ?? ""}
              placeholder={String(inheritedRange[0])}
              onChange={(e) => setRange(0, e.target.value)}
              style={{ ...input, width: 80 }}
            />
            <span style={{ color: theme.faint }}>–</span>
            <input
              type="number"
              aria-label="Review tunnel port range high"
              value={range?.[1] ?? ""}
              placeholder={String(inheritedRange[1])}
              onChange={(e) => setRange(1, e.target.value)}
              style={{ ...input, width: 80 }}
            />
            <span style={{ ...help, marginTop: 0 }}>
              Never used: Standup's own ports (5173, 7777, 7778) and any the collector reserves, such as those listed
              in STANDUP_REVIEW_TUNNEL_RESERVED_PORTS
            </span>
          </div>
        </FieldRow>
        <FieldRow label="Stale after">
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              type="number"
              min={1}
              aria-label="Review tunnel TTL hours"
              value={layer.ttlHours ?? ""}
              placeholder={String(below("ttlHours") ?? DEFAULT_REVIEW_TUNNEL_TTL_HOURS)}
              onChange={(e) => {
                const n = Number.parseFloat(e.target.value);
                set("ttlHours", Number.isFinite(n) ? n : undefined);
              }}
              style={{ ...input, width: 80 }}
            />
            <span style={{ ...help, marginTop: 0 }}>hours</span>
          </div>
        </FieldRow>
      </div>

      {active && effective!.allow && (
        <div data-testid="review-tunnel-allow-warning" style={{ ...help, color: theme.waiting, marginTop: 0 }}>
          Everyone in {effective!.allow} can reach the branch build, including any proxy routes its dev server defines (a
          route that forwards to a backend with your credentials acts as you for them). Leave Allow blank to keep tunnels
          to yourself.
        </div>
      )}

      {problems.length > 0 && (
        <ul data-testid="review-tunnel-errors" style={{ ...mono, color: theme.waiting, margin: 0, paddingLeft: 16 }}>
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <span style={{ ...labelStyle, whiteSpace: "nowrap" }}>{label}</span>
      <div>{children}</div>
    </>
  );
}

const mono: CSSProperties = { fontFamily: theme.mono, fontSize: 11.5 };

const labelStyle: CSSProperties = {
  fontFamily: theme.mono,
  fontSize: 9.5,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  color: theme.faint,
};

const help: CSSProperties = { fontSize: 11.5, color: theme.faint, marginTop: 5, lineHeight: 1.5 };

const input: CSSProperties = {
  fontSize: 12,
  color: theme.text,
  background: theme.ground,
  border: `1px solid ${theme.edge}`,
  borderRadius: 5,
  padding: "4px 6px",
  outline: "none",
};
