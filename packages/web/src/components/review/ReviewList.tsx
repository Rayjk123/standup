import { useEffect, useState } from "react";
import { LuImage, LuVideo } from "react-icons/lu";
import type { ReviewPacketSummary } from "@standup/shared";
import { theme } from "../theme";
import { listReviews, type ReviewFilter } from "./api";
import { Badge, StatusBadge } from "./StatusBadge";
import { refLabel, relativeAge } from "./format";

export interface ReviewListProps {
  selectedId?: string | null;
  onSelect: (id: string) => void;
  /** Bumped to refetch the list (a review:updated frame, a decision). */
  signal?: number;
  narrow?: boolean;
  /** The clock ages are measured against; the current time by default. */
  now?: Date;
}

const FILTERS: Array<{ value: ReviewFilter; label: string }> = [
  { value: "pending", label: "Pending" },
  { value: "all", label: "All" },
];

/**
 * The review queue: one card per packet, newest first as the collector orders
 * them, filtered to the packets awaiting a decision or showing every packet.
 */
export function ReviewList({ selectedId, onSelect, signal = 0, narrow = false, now }: ReviewListProps) {
  const [filter, setFilter] = useState<ReviewFilter>("pending");
  const [reviews, setReviews] = useState<ReviewPacketSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listReviews(filter)
      .then((list) => {
        if (cancelled) return;
        setReviews(list);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [filter, signal]);

  const textSize = narrow ? 15 : 14;
  const metaSize = narrow ? 14 : 12.5;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: narrow ? "14px 12px" : 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <h2 style={{ margin: 0, fontSize: narrow ? 18 : 15, fontWeight: 700, flex: 1 }}>Reviews</h2>
        <div role="group" aria-label="Filter reviews" style={{ display: "flex", gap: 2, background: theme.ground, borderRadius: 6, padding: 2 }}>
          {FILTERS.map((f) => {
            const active = f.value === filter;
            return (
              <button
                key={f.value}
                type="button"
                aria-pressed={active}
                onClick={() => setFilter(f.value)}
                style={{
                  minHeight: narrow ? 44 : 30,
                  minWidth: narrow ? 64 : 0,
                  padding: "0 12px",
                  border: "none",
                  borderRadius: 5,
                  cursor: "pointer",
                  fontSize: narrow ? 14 : 12.5,
                  fontWeight: 600,
                  background: active ? theme.raised : "transparent",
                  color: active ? theme.text : theme.dim,
                }}
              >
                {f.label}
              </button>
            );
          })}
        </div>
      </div>

      {error && (
        <div role="alert" style={{ color: theme.waiting, fontSize: metaSize }}>
          Couldn't load reviews: {error}
        </div>
      )}
      {reviews === null && !error && <div style={{ color: theme.dim, fontSize: metaSize }}>Loading reviews…</div>}
      {reviews !== null && reviews.length === 0 && (
        <div
          data-testid="review-list-empty"
          style={{
            color: theme.dim,
            fontSize: textSize,
            padding: "28px 12px",
            textAlign: "center",
            border: `1px dashed ${theme.edge}`,
            borderRadius: 8,
          }}
        >
          {filter === "pending" ? "No reviews are waiting on you." : "No review packets yet."}
        </div>
      )}

      {reviews?.map((r) => {
        const selected = r.id === selectedId;
        const ref = refLabel(r.branch, r.commitSha);
        return (
          <button
            key={r.id}
            type="button"
            data-testid="review-card"
            aria-current={selected ? "true" : undefined}
            onClick={() => onSelect(r.id)}
            style={{
              textAlign: "left",
              display: "flex",
              flexDirection: "column",
              gap: 6,
              width: "100%",
              minHeight: 44,
              padding: "11px 12px",
              borderRadius: 8,
              cursor: "pointer",
              color: theme.text,
              background: selected ? theme.raised : theme.surface,
              border: `1px solid ${selected ? theme.accent : theme.edge}`,
              font: "inherit",
            }}
          >
            <div style={{ display: "flex", alignItems: "flex-start", gap: 8, width: "100%" }}>
              <span style={{ flex: 1, minWidth: 0, fontSize: textSize, fontWeight: 600, lineHeight: 1.35, overflowWrap: "anywhere" }}>
                {r.title}
              </span>
              <StatusBadge status={r.status} />
            </div>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                columnGap: 10,
                rowGap: 4,
                fontSize: metaSize,
                color: theme.dim,
                width: "100%",
              }}
            >
              {r.projectId && <span style={{ color: theme.text }}>{r.projectId}</span>}
              {ref && (
                <span style={{ fontFamily: theme.mono, overflowWrap: "anywhere", minWidth: 0 }}>{ref}</span>
              )}
              <span title={r.updatedAt}>{relativeAge(r.updatedAt, now)}</span>
              {r.revision > 1 && <span>rev {r.revision}</span>}
              {r.imageCount > 0 && (
                <span
                  data-testid="review-image-count"
                  title={`${r.imageCount} image${r.imageCount === 1 ? "" : "s"}`}
                  style={{ display: "inline-flex", alignItems: "center", gap: 3 }}
                >
                  <LuImage aria-hidden size={13} />
                  {r.imageCount}
                </span>
              )}
              {r.videoCount > 0 && (
                <span
                  data-testid="review-video-count"
                  title={`${r.videoCount} video${r.videoCount === 1 ? "" : "s"}`}
                  style={{ display: "inline-flex", alignItems: "center", gap: 3 }}
                >
                  <LuVideo aria-hidden size={13} />
                  {r.videoCount}
                </span>
              )}
              {r.openQuestions > 0 && (
                <span data-testid="review-open-questions">
                  <Badge text={`${r.openQuestions} question${r.openQuestions === 1 ? "" : "s"} waiting`} color={theme.expert} />
                </span>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}
