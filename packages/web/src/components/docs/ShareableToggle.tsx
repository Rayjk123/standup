import { useState, type ReactNode } from "react";
import { theme } from "../theme";
import { ShareToggle, type ShareWording } from "../share/ShareToggle";
import { setShareable } from "./sharingApi";

const WORDING: Record<"doc" | "folder", ShareWording> = {
  doc: {
    title: "Shareable",
    label: "Let everyone signed in read and comment on this doc",
    on: "Everyone signed in can read and comment.",
    off: "Only you can see this doc.",
    offVia: "Not shareable on its own.",
    via: (folder) => `Shareable through the folder “${folder}”.`,
  },
  folder: {
    title: "Shareable",
    label: "Let everyone signed in read and comment on every doc in this folder",
    on: "Everyone signed in can read and comment on every doc in it, including docs added later.",
    off: "Only you can see this folder.",
    offVia: "Not shareable on its own.",
    via: (folder) => `Shareable through the folder “${folder}”.`,
  },
};

/**
 * The owner's Shareable switch on a doc or a folder: on, every signed-in user
 * reads it (read-only, at its latest revision) and can comment on it. `via`
 * names the shareable folder above it, which shares it whatever the switch
 * says.
 */
export function ShareableToggle({
  kind,
  id,
  shareable,
  via,
  onChanged,
}: {
  kind: "doc" | "folder";
  id: string;
  shareable: boolean;
  via?: string;
  onChanged?: (shareable: boolean) => void;
}) {
  return (
    <div data-testid="shareable">
      <ShareToggle
        bare
        resourceType={kind}
        resourceId={id}
        share={{ enabled: shareable, path: null, ...(via ? { viaFolder: via } : {}) }}
        wording={WORDING[kind]}
        onToggle={async (enabled) => {
          try {
            await setShareable(kind, id, enabled);
            onChanged?.(enabled);
            return { share: { enabled, path: null, ...(via ? { viaFolder: via } : {}) } };
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) };
          }
        }}
      />
    </div>
  );
}

/**
 * A read-only share link's switch, behind a "Share link" disclosure until
 * one is live: a link that is on (or a folder's that reaches this) always
 * shows, so it can be copied or turned off.
 */
export function ShareLinkDisclosure({ live, testId, children }: { live: boolean; testId: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  if (live || open) return <div data-testid={testId}>{children}</div>;
  return (
    <div>
      <button
        type="button"
        data-testid={`${testId}-open`}
        onClick={() => setOpen(true)}
        style={{ border: "none", background: "none", padding: 0, color: theme.running, fontSize: 12, cursor: "pointer" }}
      >
        Share a read-only link…
      </button>
    </div>
  );
}
