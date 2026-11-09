import { useEffect, useState } from "react";
import type { SharedReviewPacket } from "@standup/shared";
import { theme } from "../theme";
import { useNarrow } from "../../hooks/useNarrow";
import { useShareHead } from "../share/useShareHead";
import { getSharedReview } from "./api";
import { MediaGallery } from "./MediaGallery";
import { ChangeAreas, Section, ValidationSection } from "./ReviewDetail";

type Loaded = { state: "loading" } | { state: "missing" } | { state: "error"; message: string } | { state: "ready"; review: SharedReviewPacket };

/** The read-only body of a shared packet: its title, intent, what changed, validation and media. */
export function SharedReviewBody({ review, narrow }: { review: SharedReviewPacket; narrow: boolean }) {
  return (
    <article
      data-testid="shared-review"
      style={{
        width: "100%",
        maxWidth: 880,
        margin: "0 auto",
        boxSizing: "border-box",
        padding: narrow ? "14px 14px 32px" : "20px 24px 40px",
        display: "flex",
        flexDirection: "column",
        gap: 22,
        fontSize: narrow ? 15 : 14,
        color: theme.text,
      }}
    >
      <h1 style={{ margin: 0, fontSize: narrow ? 20 : 22, lineHeight: 1.3, overflowWrap: "anywhere" }}>{review.title}</h1>
      <Section title="Intent" testId="review-intent" narrow={narrow}>
        <p style={{ margin: 0, lineHeight: 1.55, fontSize: narrow ? 16 : 15 }}>{review.intent}</p>
      </Section>
      <Section title="What changed" testId="review-changes" narrow={narrow}>
        <ChangeAreas changes={review.changes} narrow={narrow} />
      </Section>
      <Section title="Validation" testId="review-validation" narrow={narrow}>
        <ValidationSection validation={review.validation} narrow={narrow} />
      </Section>
      {review.media.length > 0 && (
        <Section title={`Media (${review.media.length})`} testId="review-media" narrow={narrow}>
          <MediaGallery media={review.media} narrow={narrow} />
        </Section>
      )}
    </article>
  );
}

/**
 * The page a share link opens (`/share/review/<token>`), outside the console:
 * no navigation, no sign-in, no live socket and no actions — only the packet,
 * read through its token. An unknown or revoked link shows a plain "not
 * found" that says nothing of any review.
 */
export function SharedReviewPage({ token }: { token: string | null }) {
  const narrow = useNarrow();
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  useShareHead();

  useEffect(() => {
    if (!token) {
      setLoaded({ state: "missing" });
      return;
    }
    let live = true;
    getSharedReview(token)
      .then((review) => live && setLoaded(review ? { state: "ready", review } : { state: "missing" }))
      .catch((err: unknown) => live && setLoaded({ state: "error", message: err instanceof Error ? err.message : String(err) }));
    return () => {
      live = false;
    };
  }, [token]);

  useEffect(() => {
    document.title = loaded.state === "ready" ? `${loaded.review.title} — shared review` : "Shared review";
  }, [loaded]);

  return (
    <div style={{ minHeight: "100vh", background: theme.ground, color: theme.text, fontFamily: theme.sans }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: narrow ? "10px 14px" : "12px 24px",
          borderBottom: `1px solid ${theme.edgeSoft}`,
          fontSize: 13,
          color: theme.dim,
        }}
      >
        <span style={{ color: theme.accent, fontWeight: 700, letterSpacing: "0.02em" }}>Standup</span>
        <span aria-hidden="true">·</span>
        <span>Shared review (read-only)</span>
      </header>
      {loaded.state === "loading" && <div style={{ padding: 24, color: theme.dim }}>Loading…</div>}
      {loaded.state === "missing" && (
        <div data-testid="shared-review-missing" style={{ padding: "64px 24px", textAlign: "center", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 20, fontWeight: 700 }}>404 — Not found</div>
          <div style={{ color: theme.dim }}>This link doesn't lead anywhere. It may have been mistyped or turned off.</div>
        </div>
      )}
      {loaded.state === "error" && (
        <div role="alert" style={{ padding: 24, color: theme.waiting }}>
          Couldn't load this page: {loaded.message}
        </div>
      )}
      {loaded.state === "ready" && <SharedReviewBody review={loaded.review} narrow={narrow} />}
    </div>
  );
}
