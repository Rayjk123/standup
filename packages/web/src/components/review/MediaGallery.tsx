import { useEffect, useState } from "react";
import type { ReviewMediaInfo } from "@standup/shared";
import { palettes, theme } from "../theme";

/**
 * The lightbox is near-black in both themes, as photo viewers are, so media
 * is judged against a neutral dark surround; its controls and caption take
 * the dark palette to match.
 */
const LIGHTBOX = palettes.dark;

/**
 * A packet's captioned media in position order: images as a responsive grid
 * of thumbnails that open full-size in a lightbox, videos full-width with
 * native controls (inline on phones rather than forced fullscreen).
 */
export function MediaGallery({
  media,
  narrow = false,
}: {
  media: Array<Pick<ReviewMediaInfo, "id" | "kind" | "caption" | "position" | "url">>;
  narrow?: boolean;
}) {
  const ordered = [...media].sort((a, b) => a.position - b.position);
  const images = ordered.filter((m) => m.kind === "image");
  const videos = ordered.filter((m) => m.kind === "video");
  const [openId, setOpenId] = useState<string | null>(null);
  const open = images.find((m) => m.id === openId) ?? null;
  const captionSize = narrow ? 14 : 13;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {images.length > 0 && (
        <div
          data-testid="media-images"
          style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 10 }}
        >
          {images.map((m) => (
            <figure key={m.id} style={{ margin: 0, display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
              <button
                type="button"
                aria-label={`Open image: ${m.caption}`}
                onClick={() => setOpenId(m.id)}
                style={{
                  padding: 0,
                  border: `1px solid ${theme.edge}`,
                  borderRadius: 6,
                  overflow: "hidden",
                  background: theme.ground,
                  cursor: "zoom-in",
                  display: "block",
                  width: "100%",
                  aspectRatio: "16 / 10",
                }}
              >
                <img
                  src={m.url}
                  alt={m.caption}
                  loading="lazy"
                  style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                />
              </button>
              <figcaption style={{ fontSize: captionSize, color: theme.dim, lineHeight: 1.35, overflowWrap: "anywhere" }}>
                {m.caption}
              </figcaption>
            </figure>
          ))}
        </div>
      )}

      {videos.map((m) => (
        <figure key={m.id} style={{ margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
          <video
            controls
            playsInline
            preload="metadata"
            src={m.url}
            // Black letterboxing, as any video player shows, in both themes.
            style={{ width: "100%", maxHeight: "70vh", borderRadius: 6, background: "#000", display: "block" }}
          />
          <figcaption style={{ fontSize: captionSize, color: theme.dim, lineHeight: 1.35, overflowWrap: "anywhere" }}>
            {m.caption}
          </figcaption>
        </figure>
      ))}

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={open.caption}
          data-testid="media-lightbox"
          onClick={() => setOpenId(null)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            background: "rgba(5, 6, 9, 0.92)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            padding: 16,
          }}
        >
          <button
            type="button"
            aria-label="Close"
            onClick={(e) => {
              e.stopPropagation();
              setOpenId(null);
            }}
            style={{
              position: "absolute",
              top: 10,
              right: 10,
              width: 44,
              height: 44,
              borderRadius: 22,
              border: `1px solid ${LIGHTBOX.edge}`,
              background: LIGHTBOX.raised,
              color: LIGHTBOX.text,
              fontSize: 20,
              cursor: "pointer",
            }}
          >
            ✕
          </button>
          <img
            src={open.url}
            alt={open.caption}
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: "100%", maxHeight: "82vh", objectFit: "contain", borderRadius: 4 }}
          />
          <div style={{ color: LIGHTBOX.text, fontSize: captionSize, textAlign: "center", maxWidth: 720 }}>{open.caption}</div>
        </div>
      )}
    </div>
  );
}
