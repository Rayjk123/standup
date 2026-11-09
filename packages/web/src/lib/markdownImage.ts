/**
 * How a Markdown image renders. Agent-written text (transcripts, knowledge
 * docs, Persona replies) can be steered by anything an agent read, and an
 * `<img>` with a remote src fetches on render, so a crafted image could carry
 * data out in its URL with no click. By default an http(s) image therefore
 * becomes a plain link the reader can choose to open; a view that trusts its
 * content may opt in to loading remote images. Any other source (data:,
 * javascript:, relative) is shown as text only and never becomes an element
 * attribute.
 */
export type MarkdownImage =
  | { kind: "img"; src: string; alt: string }
  | { kind: "link"; href: string; label: string }
  | { kind: "text"; label: string };

export function markdownImage(
  src: string | undefined,
  alt: string | undefined,
  allowRemoteImages = false
): MarkdownImage {
  const trimmedAlt = alt?.trim() ?? "";
  const label = trimmedAlt ? `image: ${trimmedAlt}` : "image";
  if (src && /^https?:\/\//i.test(src)) {
    return allowRemoteImages
      ? { kind: "img", src, alt: trimmedAlt }
      : { kind: "link", href: src, label };
  }
  return { kind: "text", label: src ? `${label} (${src})` : label };
}
