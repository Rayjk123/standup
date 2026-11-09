/**
 * The Comment action's label and icon, shared by the owner's editor toolbar
 * (a Crepe toolbar item) and the reader's selection chip, which is drawn to
 * match that toolbar. The icon is a 24px SVG in the toolbar's own style:
 * filled with the current toolbar icon colour, no stroke.
 */

import { theme } from "../theme";

export const COMMENT_LABEL = "Comment";

const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
/** The keyboard shortcut that starts a comment on the selection (see isCommentShortcut), as shown in a tooltip. */
export const COMMENT_SHORTCUT = mac ? "⌘⌥M" : "Ctrl+Alt+M";
/** The same, for aria-keyshortcuts. */
export const COMMENT_ARIA_SHORTCUT = mac ? "Meta+Alt+M" : "Control+Alt+M";

/**
 * Whether a keydown is the comment shortcut. On a Mac, Option turns the key
 * into another character (⌥M is "µ"), so the physical key is matched; off a
 * Mac the character is, so it follows the layout (M is elsewhere on AZERTY)
 * and an AltGr character (Ctrl+Alt on Windows, AltGr+M is "µ" in German)
 * never matches.
 */
export function isCommentShortcut(e: Pick<KeyboardEvent, "altKey" | "metaKey" | "ctrlKey" | "key" | "code">, onMac: boolean = mac): boolean {
  if (!e.altKey) return false;
  return onMac ? e.metaKey && e.code === "KeyM" : e.ctrlKey && e.key.toLowerCase() === "m";
}

/**
 * The colour of a toolbar icon at rest, in the editor toolbar and the chip
 * alike. Crepe's own (its outline colour, the console's edge) reads as
 * disabled; dim reads as a quiet control.
 */
export const TOOLBAR_ICON = theme.dim;

/**
 * A speech bubble with a plus in it (Material's outlined chat bubble), drawn
 * at 80% inside its 24px box so it carries the same weight as Crepe's own
 * icons, which leave that margin too.
 */
export const COMMENT_ICON = `
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
    <path transform="translate(2.4 2.4) scale(0.8)" d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12zM11 5h2v4h4v2h-4v4h-2v-4H7V9h4V5z" />
  </svg>
`;
