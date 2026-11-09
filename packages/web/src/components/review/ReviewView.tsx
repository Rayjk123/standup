import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { ReviewDecision, ReviewPacketDetail } from "@standup/shared";
import { theme } from "../theme";
import { useNarrow } from "../../hooks/useNarrow";
import { subscribeReviewUpdates } from "../../lib/reviewUpdates";
import { askReview, decideReview, getReview } from "./api";
import { ReviewList } from "./ReviewList";
import { ReviewDetail } from "./ReviewDetail";

const LIST_WIDTH = 360;

/**
 * The Review tab: the packet queue beside the selected packet on a wide
 * screen; on a phone, the queue at /review and one packet per page at
 * /review/:id with a Back button. The selection lives in the path so it
 * survives a refresh and deep-links from Slack or Persona. Both panes refetch
 * on every review:updated or reviews:pending frame and on each resync.
 */
export function ReviewView() {
  const { id } = useParams();
  const selectedId = id ?? null;
  const navigate = useNavigate();
  const narrow = useNarrow();
  const [listSignal, setListSignal] = useState(0);
  const [detail, setDetail] = useState<ReviewPacketDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

  // `keepOnError`: a resync's failed read (the collector still coming back)
  // leaves the packet on screen, and any half-typed decision with it.
  const loadDetail = useCallback((reviewId: string, keepOnError = false) => {
    getReview(reviewId)
      .then((review) => {
        if (selectedRef.current !== reviewId) return;
        setDetail(review);
        setDetailError(null);
      })
      .catch((err: unknown) => {
        if (selectedRef.current !== reviewId || keepOnError) return;
        setDetail(null);
        setDetailError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  useEffect(() => {
    setDetail(null);
    setDetailError(null);
    if (selectedId) loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  useEffect(
    () =>
      subscribeReviewUpdates((update) => {
        setListSignal((n) => n + 1);
        const selected = selectedRef.current;
        if (selected && (update === null || update.packetId === selected)) loadDetail(selected, update === null);
      }),
    [loadDetail]
  );

  // An owner action on the selected packet: its answer replaces the packet shown.
  const act = useCallback(
    async (run: (reviewId: string) => Promise<{ review?: ReviewPacketDetail; error?: string }>) => {
      if (!selectedId) return { error: "No review selected" };
      const result = await run(selectedId);
      if (result.error) return { error: result.error };
      if (result.review && selectedRef.current === selectedId) setDetail(result.review);
      setListSignal((n) => n + 1);
      return {};
    },
    [selectedId]
  );
  const onDecide = useCallback(
    (decision: ReviewDecision, comment: string) => act((reviewId) => decideReview(reviewId, decision, comment)),
    [act]
  );
  const onAsk = useCallback((question: string, replyTo?: string) => act((reviewId) => askReview(reviewId, question, replyTo)), [act]);

  const select = (reviewId: string) => navigate(`/review/${encodeURIComponent(reviewId)}`);

  const detailPane = (
    <div
      data-testid="review-detail-scroll"
      style={{ flex: 1, minWidth: 0, height: "100%", overflowY: "auto", overflowX: "hidden", position: "relative" }}
    >
      {narrow && (
        <div
          style={{
            position: "sticky",
            top: 0,
            zIndex: 6,
            background: theme.ground,
            borderBottom: `1px solid ${theme.edgeSoft}`,
            padding: "4px 8px",
          }}
        >
          <button
            type="button"
            onClick={() => navigate("/review")}
            style={{
              minHeight: 44,
              padding: "0 12px",
              border: "none",
              background: "transparent",
              color: theme.running,
              fontSize: 15,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            ← Back
          </button>
        </div>
      )}
      {selectedId === null && (
        <div style={{ padding: 32, color: theme.dim, fontSize: 14, textAlign: "center" }}>
          Select a review to see what changed and decide on it.
        </div>
      )}
      {selectedId !== null && detailError && (
        <div role="alert" style={{ padding: 24, color: theme.waiting, fontSize: narrow ? 15 : 14 }}>
          Couldn't load this review: {detailError}
        </div>
      )}
      {selectedId !== null && !detail && !detailError && (
        <div style={{ padding: 24, color: theme.dim, fontSize: 14 }}>Loading review…</div>
      )}
      {detail && <ReviewDetail key={detail.id} review={detail} onDecide={onDecide} onAsk={onAsk} narrow={narrow} />}
    </div>
  );

  const listPane = (
    <ReviewList selectedId={selectedId} onSelect={select} signal={listSignal} narrow={narrow} />
  );

  if (narrow) {
    return (
      <div style={{ height: "100%", display: "flex", background: theme.ground }}>
        {selectedId ? detailPane : <div style={{ flex: 1, minWidth: 0, height: "100%", overflowY: "auto" }}>{listPane}</div>}
      </div>
    );
  }

  return (
    <div style={{ height: "100%", display: "flex", background: theme.ground }}>
      <div
        style={{
          width: LIST_WIDTH,
          flexShrink: 0,
          height: "100%",
          overflowY: "auto",
          borderRight: `1px solid ${theme.edge}`,
          background: theme.ground,
        }}
      >
        {listPane}
      </div>
      {detailPane}
    </div>
  );
}
