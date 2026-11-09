/**
 * Textual edits of a doc file's front matter and body. A patch rewrites only
 * the lines of the keys it names and leaves every other byte as it was — YAML
 * comments, key order, quoting, date formats (`last_verified_at: 2026-08-16`),
 * flow lists and block scalars — which a parse-and-reserialise round trip
 * through gray-matter would restyle or drop.
 *
 * The front matter is the block between a leading `---` line and the next
 * `---` line, the same block gray-matter reads; the body is everything after
 * the closing line's line break (gray-matter's `content`). A leading byte-order
 * mark is not part of the opening delimiter: it is kept in front of the file.
 */

/** A single front-matter value a splice can write. */
export type FrontmatterScalar = string | number | boolean;

/** Key → value to set, or null/undefined to remove the key. */
export type FrontmatterPatch = Record<string, FrontmatterScalar | readonly FrontmatterScalar[] | null | undefined>;

const DELIMITER = /^---[ \t]*$/;
const PATCHABLE_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;

interface SplitFile {
  /** The byte-order mark the file starts with, or "". */
  bom: string;
  /** Line break the file uses. */
  eol: string;
  /** Front-matter lines between the delimiters, without line breaks; null when the file has none. */
  lines: string[] | null;
  /** The opening delimiter line, as written. */
  open: string;
  /** The closing delimiter line, as written. */
  close: string;
  /** Everything after the closing delimiter line's line break (after the BOM when there is no front matter). */
  body: string;
  /** Whether the closing delimiter line ended in a line break. */
  closeHasEol: boolean;
}

const BOM = "\uFEFF";

function split(raw: string): SplitFile {
  const bom = raw.startsWith(BOM) ? BOM : "";
  const text = raw.slice(bom.length);
  const eol = /\r\n/.test(text.slice(0, text.indexOf("\n") + 1)) ? "\r\n" : "\n";
  const none: SplitFile = { bom, eol, lines: null, open: "---", close: "---", body: text, closeHasEol: true };
  const rows = text.split("\n");
  const strip = (line: string) => (line.endsWith("\r") ? line.slice(0, -1) : line);
  if (rows.length < 2 || !DELIMITER.test(strip(rows[0]))) return none;
  for (let i = 1; i < rows.length; i++) {
    if (!DELIMITER.test(strip(rows[i]))) continue;
    const closeHasEol = i < rows.length - 1;
    return {
      bom,
      eol,
      lines: rows.slice(1, i).map(strip),
      open: strip(rows[0]),
      close: strip(rows[i]),
      body: closeHasEol ? rows.slice(i + 1).join("\n") : "",
      closeHasEol,
    };
  }
  return none;
}

function join(file: SplitFile, lines: readonly string[], body: string): string {
  const head = file.bom + [file.open, ...lines, file.close].join(file.eol);
  return file.closeHasEol || body.length > 0 ? `${head}${file.eol}${body}` : head;
}

/** The top-level key a front-matter line opens, or null for a comment, continuation or blank line. */
function keyOf(line: string): string | null {
  const m = /^([A-Za-z_][A-Za-z0-9_-]*|"[^"]*"|'[^']*')[ \t]*:(?:[ \t]|$)/.exec(line);
  if (!m) return null;
  const key = m[1];
  return key.startsWith('"') || key.startsWith("'") ? key.slice(1, -1) : key;
}

/** Whether a line continues the value of the key above it: indented, or a block-sequence item. */
function continues(line: string): boolean {
  return /^[ \t]/.test(line) || /^-(?:[ \t]|$)/.test(line);
}

/**
 * The [start, end) line range each top-level key occupies: its key line plus
 * the continuation lines under it. Blank lines belong to a key only when more
 * of its continuation follows them.
 */
function keyRanges(lines: readonly string[]): Array<{ key: string; start: number; end: number }> {
  const out: Array<{ key: string; start: number; end: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const key = keyOf(lines[i]);
    if (key === null) continue;
    let end = i + 1;
    for (let j = i + 1; j < lines.length; j++) {
      if (continues(lines[j])) end = j + 1;
      else if (lines[j].trim() !== "") break;
    }
    out.push({ key, start: i, end });
    i = end - 1;
  }
  return out;
}

/** YAML words a plain scalar would read as something other than a string. */
const RESERVED_PLAIN = /^(?:true|false|yes|no|on|off|y|n|null|nan|inf)$/i;

/** A string as a YAML scalar: plain when it can only read back as that string, else double-quoted. */
function yamlString(value: string): string {
  const plain = /^[A-Za-z_][A-Za-z0-9_./@+-]*(?: [A-Za-z0-9_./@+-]+)*$/.test(value) && !RESERVED_PLAIN.test(value);
  return plain ? value : JSON.stringify(value);
}

function yamlScalar(value: FrontmatterScalar): string {
  if (typeof value === "string") return yamlString(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`front-matter number must be finite: ${value}`);
    return String(value);
  }
  return value ? "true" : "false";
}

function yamlValue(value: FrontmatterScalar | readonly FrontmatterScalar[]): string {
  if (Array.isArray(value)) return `[${value.map((v) => (typeof v === "string" ? JSON.stringify(v) : yamlScalar(v))).join(", ")}]`;
  return yamlScalar(value as FrontmatterScalar);
}

/**
 * `raw` with each key in `patch` set to its value (a single-line scalar, or a
 * flow list for an array) or, for null/undefined, removed. A key already
 * present is rewritten in place — its line and any continuation lines under
 * it (a block list or block scalar) become the one new line, and a duplicate
 * later occurrence is removed; a new key is appended before the closing
 * delimiter. Every other line and the body are kept byte for byte. A file
 * with no front matter gains one when the patch sets anything.
 */
export function spliceFrontmatter(raw: string, patch: FrontmatterPatch): string {
  for (const key of Object.keys(patch)) {
    if (!PATCHABLE_KEY.test(key)) throw new Error(`not a patchable front-matter key: ${key}`);
  }
  const file = split(raw);
  const sets = Object.entries(patch).filter(
    (e): e is [string, FrontmatterScalar | readonly FrontmatterScalar[]] => e[1] !== null && e[1] !== undefined
  );
  if (file.lines === null) {
    if (sets.length === 0) return raw;
    const lines = sets.map(([key, value]) => `${key}: ${yamlValue(value)}`);
    return join({ ...file, closeHasEol: true }, lines, file.body);
  }

  const lines = file.lines;
  const replaced = new Map<number, string | null>();
  const skip = new Set<number>();
  const seen = new Set<string>();
  for (const range of keyRanges(lines)) {
    if (!Object.prototype.hasOwnProperty.call(patch, range.key)) continue;
    const value = patch[range.key];
    const line = seen.has(range.key) || value === null || value === undefined ? null : `${range.key}: ${yamlValue(value)}`;
    seen.add(range.key);
    replaced.set(range.start, line);
    for (let i = range.start + 1; i < range.end; i++) skip.add(i);
  }

  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (skip.has(i)) continue;
    if (replaced.has(i)) {
      const line = replaced.get(i);
      if (line !== null && line !== undefined) out.push(line);
      continue;
    }
    out.push(lines[i]);
  }
  for (const [key, value] of sets) {
    if (!seen.has(key)) out.push(`${key}: ${yamlValue(value)}`);
  }
  return join(file, out, file.body);
}

/** `raw` with its body (everything after the front matter) replaced by `body`; the front matter is kept byte for byte. */
export function spliceBody(raw: string, body: string): string {
  const file = split(raw);
  if (file.lines === null) return file.bom + body;
  return join({ ...file, closeHasEol: true }, file.lines, body);
}

/** The body of `raw`: everything after its front matter, or all of it when it has none. */
export function frontmatterBody(raw: string): string {
  return split(raw).body;
}
