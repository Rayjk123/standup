import { useEffect, useRef, useState } from "react";
import type { ShareResourceType, ShareState } from "@standup/shared";
import { alpha, theme } from "../theme";
import { setShare as setShareRemote } from "./api";

export interface ShareToggleProps {
  resourceType: ShareResourceType;
  resourceId: string;
  share: ShareState;
  narrow?: boolean;
  /** The origin the share link is copied with (default: the configured console URL, else the page's own). */
  origin?: string;
  /** Records a share change (default: the collector's share route). */
  onToggle?: (enabled: boolean) => Promise<{ share?: ShareState; error?: string }>;
  /** The switch's own wording, for a switch that isn't a share link (default: the link's, by type). */
  wording?: ShareWording;
  /** Drawn as one plain line, without the boxed panel. */
  bare?: boolean;
}

/** What a share switch says: its title and label, its status lines, and the line naming the folder that shares it. */
export interface ShareWording {
  title: string;
  label: string;
  on: string;
  off: string;
  offVia: string;
  via: (folder: string) => string;
}

/** STANDUP_WEB_URL (else STANDUP_CONSOLE_ORIGIN) as vite.config.ts baked it in; "" when unset. */
declare const __STANDUP_WEB_URL__: string | undefined;

/**
 * The console's configured public URL, which share links are built on so
 * they open for others even when the owner browses on localhost; undefined
 * when none is configured (or the page was built without the define).
 */
export function configuredConsoleUrl(): string | undefined {
  const url = typeof __STANDUP_WEB_URL__ === "string" ? __STANDUP_WEB_URL__ : "";
  return url || undefined;
}

/**
 * How each resource type is named in the switch's label and status line;
 * `offVia` is the status line while off but reachable through a shared
 * folder holding it.
 */
const NOUNS: Record<ShareResourceType, { label: string; on: string; off: string; offVia: string }> = {
  review: {
    label: "Share a read-only link to this review",
    on: "Anyone with the link can view this packet, read-only.",
    off: "Off — only you can see this review.",
    offVia: "Off — only you can see this review.",
  },
  doc: {
    label: "Share a read-only link to this doc",
    on: "Anyone with the link can read this doc.",
    off: "Off — only you can see this doc.",
    offVia: "No link of its own.",
  },
  folder: {
    label: "Share a read-only link to this folder",
    on: "Anyone with the link can read every doc in this folder and its subfolders, including docs added later.",
    off: "Off — only you can see this folder.",
    offVia: "No link of its own.",
  },
};

/** Whether `origin` names only this machine, so a link built on it can't be opened elsewhere. */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      /^127\./.test(host) ||
      host === "0.0.0.0" ||
      ["[::1]", "[::]", "[::ffff:7f00:1]"].includes(host) ||
      /^\[::ffff:127\./.test(host)
    );
  } catch {
    return false;
  }
}

/**
 * The owner's switch for a resource's read-only share link, and while it is
 * on the link with a Copy button. Turning it off revokes the link at once;
 * turning it back on makes a new one.
 */
export function ShareToggle({ resourceType, resourceId, share: initial, narrow = false, origin, onToggle, wording, bare = false }: ShareToggleProps) {
  const [share, setShare] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyHint, setCopyHint] = useState(false);
  const linkRef = useRef<HTMLInputElement>(null);
  /** Numbers each toggle request; a response lands only while its request is still the latest for this resource. */
  const request = useRef(0);

  useEffect(() => {
    request.current++;
    setBusy(false);
    setShare(initial);
    setError(null);
  }, [resourceType, resourceId, initial.enabled, initial.path, initial.viaFolder]);

  useEffect(
    () => () => {
      request.current++;
    },
    []
  );

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  // A loopback configured URL is never better than the page's own origin (the
  // page may be open through the tunnel), so only a reachable one is preferred.
  const configured = configuredConsoleUrl();
  const base = origin ?? (configured && !isLoopbackOrigin(configured) ? configured : window.location.origin);
  const url = share.enabled && share.path ? `${base}${share.path}` : null;
  const loopback = isLoopbackOrigin(base);
  const nouns = wording ?? {
    ...NOUNS[resourceType],
    title: "Share",
    via: (folder: string) => `Anyone with the link to the shared folder “${folder}” can read this ${resourceType === "folder" ? "folder" : "doc"}.`,
  };

  const toggle = async () => {
    if (busy) return;
    const id = ++request.current;
    setBusy(true);
    setError(null);
    setCopied(false);
    const result = await (onToggle ?? ((enabled: boolean) => setShareRemote(resourceType, resourceId, enabled)))(!share.enabled);
    if (id !== request.current) return;
    setBusy(false);
    if (result.error || !result.share) setError(result.error ?? "Sharing couldn't be changed");
    else setShare(result.share);
  };

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // No clipboard access (an insecure origin, a denied permission): select the link to copy by hand.
      linkRef.current?.select();
      setCopyHint(true);
    }
  };

  const size = narrow ? 14 : 13;
  return (
    <div
      data-testid="share"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: bare ? 0 : "10px 12px",
        borderRadius: 6,
        background: bare ? "transparent" : theme.surface,
        border: bare ? "none" : `1px solid ${share.enabled ? alpha(theme.checkpoint, 0x66) : theme.edge}`,
        fontSize: bare ? 12.5 : size,
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
        <button
          type="button"
          role="switch"
          aria-checked={share.enabled}
          aria-label={nouns.label}
          data-testid="share-switch"
          disabled={busy}
          onClick={toggle}
          style={{
            position: "relative",
            width: 40,
            height: 22,
            flexShrink: 0,
            borderRadius: 11,
            border: "none",
            padding: 0,
            background: share.enabled ? theme.checkpoint : theme.raised,
            cursor: busy ? "wait" : "pointer",
            transition: "background 120ms",
          }}
        >
          <span
            aria-hidden="true"
            style={{
              position: "absolute",
              top: 3,
              left: share.enabled ? 21 : 3,
              width: 16,
              height: 16,
              borderRadius: "50%",
              background: theme.text,
              transition: "left 120ms",
            }}
          />
        </button>
        <span style={{ fontWeight: 600, color: theme.text }}>{nouns.title}</span>
        <span aria-live="polite" style={{ color: theme.dim, flex: "1 1 220px", minWidth: 0 }}>
          {share.enabled ? nouns.on : share.viaFolder ? nouns.offVia : nouns.off}
        </span>
      </div>
      {share.viaFolder && (
        <div data-testid="share-via-folder" style={{ color: theme.stalled, overflowWrap: "anywhere" }}>
          {nouns.via(share.viaFolder)}
        </div>
      )}
      {url && (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          <input
            ref={linkRef}
            data-testid="share-link"
            readOnly
            value={url}
            aria-label="Share link"
            onFocus={(e) => e.currentTarget.select()}
            style={{
              flex: "1 1 260px",
              minWidth: 0,
              padding: "5px 8px",
              borderRadius: 5,
              border: `1px solid ${theme.edge}`,
              background: theme.ground,
              color: theme.dim,
              fontFamily: theme.mono,
              fontSize: narrow ? 13 : 12,
            }}
          />
          <button
            type="button"
            data-testid="share-copy"
            onClick={copy}
            style={{
              minHeight: narrow ? 40 : 28,
              padding: "0 12px",
              borderRadius: 5,
              border: `1px solid ${alpha(theme.running, 0x66)}`,
              background: alpha(theme.running, 0x1f),
              color: theme.running,
              fontSize: size,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
      )}
      {url && copyHint && <div style={{ color: theme.dim }}>Couldn't reach the clipboard: the link is selected, press Ctrl/⌘+C.</div>}
      {url && loopback && (
        <div data-testid="share-loopback" style={{ color: theme.stalled }}>
          This link uses {base}, which only works on this machine. Open the console through its tunnel, or set STANDUP_WEB_URL, to copy a link others can open.
        </div>
      )}
      {error && (
        <div role="alert" style={{ color: theme.waiting }}>
          {error}
        </div>
      )}
    </div>
  );
}
