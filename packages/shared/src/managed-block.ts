/**
 * Splices a delimited "managed block" into a larger body of text without
 * duplicating it and without disturbing a single byte outside its delimiters.
 *
 * Extracted from the steering installer so every managed region of a CLAUDE.md
 * — the always-on Standup steering, the optional knowledge write-back — shares
 * one splice implementation rather than each hand-rolling the same regex. Pure
 * and delimiter-agnostic: the begin/end markers are passed in, so a caller owns
 * its own block namespace and two callers' blocks never collide.
 */

const RE_ESCAPE = /[.*+?^${}()|[\]\\]/g;

/**
 * Matches a managed block ONLY when each delimiter is alone on its own line —
 * so a marker quoted inline in the surrounding prose (a README that documents
 * these strings, a real copy-paste vector) is never mistaken for a block
 * boundary. Captures the leading + trailing line separators so a splice
 * preserves surrounding content byte-for-byte.
 */
export function managedBlockRe(begin: string, end: string): RegExp {
  const b = begin.replace(RE_ESCAPE, "\\$&");
  const e = end.replace(RE_ESCAPE, "\\$&");
  return new RegExp(`(^|\\n)${b}\\n[\\s\\S]*?\\n${e}(\\n|$)`);
}

/**
 * Returns `existing` with `block` added or updated in place. A pre-existing
 * OWN-LINE block (delimited by `begin`/`end`) is replaced, never duplicated;
 * content before and after it is preserved byte-for-byte. `block` is expected
 * to already carry its own delimiters. Pure.
 */
export function upsertManagedBlock(
  existing: string,
  block: string,
  begin: string,
  end: string
): string {
  const m = managedBlockRe(begin, end).exec(existing);
  if (m) {
    const before = existing.slice(0, m.index + m[1].length); // keep leading sep
    const after = existing.slice(m.index + m[0].length - m[2].length); // keep trailing sep
    return before + block + after;
  }
  // No own-line block — append it, separated from any prior content by a blank
  // line, and leave the text ending in a single trailing newline.
  const trimmed = existing.replace(/\s+$/, "");
  const prefix = trimmed.length > 0 ? `${trimmed}\n\n` : "";
  return `${prefix}${block}\n`;
}

/**
 * Returns `existing` with the managed OWN-LINE block removed, preserving
 * surrounding content and collapsing the blank line that separated it so an
 * add-then-remove round trip leaves no growing gap. Pure.
 */
export function stripManagedBlock(existing: string, begin: string, end: string): string {
  const m = managedBlockRe(begin, end).exec(existing);
  if (!m) return existing;
  const before = existing.slice(0, m.index + m[1].length).replace(/\n+$/, "");
  const after = existing.slice(m.index + m[0].length - m[2].length).replace(/^\n+/, "");
  if (!before) return after.length ? `${after.replace(/\n+$/, "")}\n` : "";
  if (!after) return `${before}\n`;
  return `${before}\n\n${after.replace(/\n+$/, "")}\n`;
}
