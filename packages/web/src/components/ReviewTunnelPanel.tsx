import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { LuExternalLink } from "react-icons/lu";
import { reviewTunnelLive } from "@standup/shared";
import type { ReviewTunnel } from "@standup/shared";
import { theme } from "./theme";

/** How often a job's review tunnels are re-read while shown. */
const POLL_MS = 5000;

const CLOSE_REASON: Record<string, string> = {
  job_closed: "the job closed",
  launch_ended: "the worktree was cleaned up",
  review_decided: "the review was decided",
  expired: "it went stale",
  manual: "it was torn down by hand",
  lost: "its processes stopped",
  reconciled: "the collector reconciled it",
  run_disabled: "its pipeline run was turned off",
};

/**
 * The review tunnels of `launchIds` (newest first), re-read every `pollMs`.
 * `reload` re-reads at once, after an action.
 */
export function useReviewTunnels(
  launchIds: string[],
  pollMs: number = POLL_MS,
  fetchImpl: typeof fetch = fetch
): { tunnels: ReviewTunnel[]; reload: () => void } {
  // The tunnels are kept with the key they were read for, so another job's or
  // packet's never show — not even for a frame — while the new ones load.
  const [read, setRead] = useState<{ key: string; tunnels: ReviewTunnel[] }>({ key: "", tunnels: [] });
  const [tick, setTick] = useState(0);
  const key = launchIds.join(",");
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const setTunnels = useCallback((tunnels: ReviewTunnel[]) => setRead({ key, tunnels }), [key]);

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetchImpl(`/api/review-tunnels?launchIds=${encodeURIComponent(key)}`);
        if (!res.ok) return;
        const data = (await res.json()) as { tunnels?: ReviewTunnel[] };
        if (!cancelled && Array.isArray(data.tunnels)) setTunnels(data.tunnels);
      } catch {
        // Keep the last tunnels on screen; the next read retries.
      }
    };
    void load();
    const timer = setInterval(() => void load(), pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [key, pollMs, tick, fetchImpl, setTunnels]);

  return { tunnels: read.key === key ? read.tunnels : [], reload };
}

/**
 * A job's review tunnels: each live one with its URL, local port and when it
 * goes stale, and a "Tear down" button; the newest closed one says why it
 * closed. Renders nothing when the job never had a tunnel.
 */
export function ReviewTunnelList({
  tunnels,
  onChanged,
  readOnly = false,
  fetchImpl = fetch,
}: {
  tunnels: ReviewTunnel[];
  onChanged?: () => void;
  readOnly?: boolean;
  fetchImpl?: typeof fetch;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = tunnels.filter(reviewTunnelLive);
  const lastEnded = tunnels.find((t) => !reviewTunnelLive(t));
  if (live.length === 0 && !lastEnded) return null;

  const tearDown = async (id: string) => {
    if (busy) return;
    setBusy(id);
    setError(null);
    try {
      const res = await fetchImpl(`/api/review-tunnels/${encodeURIComponent(id)}/close`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Tear down failed (${res.status})`);
      }
      onChanged?.();
    } catch {
      setError("The collector may be unreachable.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div data-testid="review-tunnels" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {live.map((t) => (
        <div key={t.id} data-testid="review-tunnel-live" style={card}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ ...dot, background: t.status === "open" ? theme.checkpoint : theme.waiting }} />
            {t.status === "open" ? (
              <a href={t.url} target="_blank" rel="noreferrer" style={link} data-testid="review-tunnel-url">
                {t.url} <LuExternalLink size={12} />
              </a>
            ) : (
              <span style={{ ...mono, color: theme.dim }}>{t.url} — opening…</span>
            )}
            {!readOnly && (
              <button
                type="button"
                onClick={() => void tearDown(t.id)}
                disabled={busy !== null}
                style={{ ...button, marginLeft: "auto", opacity: busy ? 0.5 : 1 }}
              >
                {busy === t.id ? "Tearing down…" : "Tear down"}
              </button>
            )}
          </div>
          <div style={{ ...mono, color: theme.faint, marginTop: 4 }}>
            serves the branch build on 127.0.0.1:{t.port}
            {t.expiresAt ? ` · goes stale ${when(t.expiresAt)}` : ""} · closes when the job closes or the review is decided
          </div>
        </div>
      ))}
      {live.length === 0 && lastEnded && (
        <div data-testid="review-tunnel-ended" style={{ ...mono, color: theme.faint }}>
          {lastEnded.status === "failed"
            ? `The review tunnel failed to open: ${lastEnded.error ?? "unknown error"}`
            : `The review tunnel ${lastEnded.url} is down — ${CLOSE_REASON[lastEnded.closeReason ?? ""] ?? "closed"}${lastEnded.closedAt ? `, ${when(lastEnded.closedAt)}` : ""}.`}
        </div>
      )}
      {error && <div style={{ ...mono, color: theme.waiting }}>{error}</div>}
    </div>
  );
}

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const mono: CSSProperties = { fontFamily: theme.mono, fontSize: 11.5 };

const card: CSSProperties = {
  border: `1px solid ${theme.edgeSoft}`,
  borderRadius: 6,
  padding: "8px 10px",
  background: theme.ground,
};

const dot: CSSProperties = { width: 7, height: 7, borderRadius: 4, flexShrink: 0 };

const link: CSSProperties = {
  ...mono,
  fontSize: 12,
  color: theme.accent,
  textDecoration: "none",
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  overflowWrap: "anywhere",
};

const button: CSSProperties = {
  fontSize: 11.5,
  fontWeight: 600,
  color: theme.dim,
  background: "transparent",
  border: `1px solid ${theme.edge}`,
  borderRadius: 5,
  padding: "3px 10px",
  cursor: "pointer",
};
