import { createHash } from "crypto";

/**
 * The owner-preferences block Persona appends to a worker brief. The block is
 * the owner's personal layer — their saved memories and feedback — so it is
 * fenced by markers: anything that turns a worker's task or transcript into
 * shared knowledge (the distiller) strips it, and a retried launch is
 * compared with the block left out.
 *
 * Each block's markers carry an id derived from its body
 * (`<!-- standup:owner-preferences 3fa2c1d09b7e -->` …
 * `<!-- /standup:owner-preferences 3fa2c1d09b7e -->`), and every line in it
 * is cleared of comment and fence syntax (preferenceLineText), so nothing a
 * memory says can close the block early and leave the rest of it in the
 * stripped text.
 */

/** Start of a block's opening marker. */
export const OWNER_PREFERENCES_BEGIN = "<!-- standup:owner-preferences";
/** Start of a block's closing marker. */
export const OWNER_PREFERENCES_END = "<!-- /standup:owner-preferences";

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A block with an id, up to the closing marker with the same id. One whose
 * closing marker is missing runs to the end of the text, so a cut-off copy is
 * still dropped.
 */
const BLOCK = new RegExp(
  `[ \\t]*${escape(OWNER_PREFERENCES_BEGIN)} ([0-9a-f]{6,64}) -->[\\s\\S]*?(?:${escape(OWNER_PREFERENCES_END)} \\1 -->[ \\t]*(?:\\r?\\n)?|$)`,
  "g"
);

/**
 * A block with no id, as briefs carried before markers had one: to the LAST
 * closing marker without an id before the next block opens, so a closing
 * marker inside the block can't end it early and the text between two blocks
 * stays.
 */
const BARE_BLOCK = new RegExp(
  `[ \\t]*${escape(OWNER_PREFERENCES_BEGIN)} -->(?:(?!${escape(OWNER_PREFERENCES_BEGIN)})[\\s\\S])*${escape(OWNER_PREFERENCES_END)} -->[ \\t]*(?:\\r?\\n)?`,
  "g"
);

/** What is left of a block whose opening marker is cut off or malformed: everything after it. */
const CUT_BLOCK = new RegExp(`[ \\t]*${escape(OWNER_PREFERENCES_BEGIN)}[\\s\\S]*$`);

/** Comment delimiters and code fences, which could end or hide the block's markers. */
const FENCE_SYNTAX = /<!--|--!?>|`{3,}|~{3,}/g;

/** `text` cleared of comment delimiters and fences, for one line of a preferences block. */
export function preferenceLineText(text: string): string {
  let out = text;
  for (let prev = ""; prev !== out; ) {
    prev = out;
    out = out.replace(FENCE_SYNTAX, " ");
  }
  return out;
}

/** Fences `body` as a preferences block, its markers carrying an id derived from the body. */
export function fenceOwnerPreferences(body: string): string {
  const lines = body.trim().split("\n").map(preferenceLineText);
  const inner = lines.join("\n");
  const id = createHash("sha256").update(inner).digest("hex").slice(0, 12);
  return `${OWNER_PREFERENCES_BEGIN} ${id} -->\n${inner}\n${OWNER_PREFERENCES_END} ${id} -->`;
}

/**
 * `text` without its preferences blocks, and the blank lines they leave
 * collapsed to one paragraph break.
 */
export function stripOwnerPreferences(text: string): string {
  if (!text.includes(OWNER_PREFERENCES_BEGIN)) return text;
  return text
    .replace(BLOCK, "")
    .replace(BARE_BLOCK, "")
    .replace(CUT_BLOCK, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
