/**
 * Keeps personal-layer text out of docs an automatic path publishes into a
 * shared scope. A distilled draft is written from a session transcript, and a
 * transcript can quote the owner's personal layer — an injected brief, a
 * search result for the owner's own memories, a home CLAUDE.md rule the agent
 * restated. The redactor removes credential shapes; this removes the owner's
 * own words, by fingerprint: every sentence of every personal-layer doc
 * (layerSql "personal": scope=user docs and the home `~/.claude` mirrors) that
 * no shared doc also states, so a draft line that reproduces one is withheld
 * from the shared doc.
 *
 * Matching is verbatim after normalisation (case, whitespace, list and heading
 * markers, emphasis), on each line and on each pair of adjacent lines (a
 * sentence re-wrapped across a line break), so a paraphrase is not caught; it
 * is a gate on the automatic paths, which reproduce what they read, not a
 * classifier. Only sentences long enough to be specific count, so a heading or
 * a common phrase the owner also wrote ("## Code style", "Run the tests") never
 * withholds a line, and a sentence a team doc already states is team knowledge.
 */

import type { Database } from "bun:sqlite";
import { layerSql } from "./types.js";

/** A personal sentence shorter than this (normalised) is too generic to attribute. */
const MIN_SENTENCE = 32;

/** The title a draft gets when its own title is a personal sentence. */
export const WITHHELD_TITLE = "Untitled draft";

/** Personal-layer sentences, normalised, a published line is checked against. */
export interface PersonalFingerprint {
  readonly sentences: readonly string[];
}

/** A line as compared: lowercased, markdown list/heading/quote markers and emphasis dropped, whitespace collapsed. */
function normalise(text: string): string {
  return text
    .replace(/^\s*(?:[-*+>]|\d+[.)]|#{1,6})\s+/, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** The sentences of `text`: split at line breaks and at sentence ends followed by a space. */
function sentences(text: string): string[] {
  return text
    .split(/\n|(?<=[.!?])\s+/)
    .map(normalise)
    .filter((s) => s.length >= MIN_SENTENCE);
}

/** The fingerprint of personal-layer texts (titles and bodies), less any sentence in `sharedTexts`. */
export function personalFingerprint(texts: Iterable<string>, sharedTexts: Iterable<string> = []): PersonalFingerprint {
  const out = new Set<string>();
  for (const text of texts) for (const s of sentences(text)) out.add(s);
  for (const text of sharedTexts) for (const s of sentences(text)) out.delete(s);
  return { sentences: [...out] };
}

/**
 * The fingerprint of every personal-layer doc indexed in `db` (any owner's),
 * less the sentences a shared doc also states; empty when `db` holds no
 * knowledge index, which then holds no personal doc.
 */
export function loadPersonalFingerprint(db: Database): PersonalFingerprint {
  const indexed = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'knowledge'").get();
  if (!indexed) return { sentences: [] };
  type Row = { title: string; body: string };
  const personal = db.query(`SELECT k.title, k.body FROM knowledge k WHERE ${layerSql("personal", "k")}`).all() as Row[];
  if (personal.length === 0) return { sentences: [] };
  const shared = db.query(`SELECT k.title, k.body FROM knowledge k WHERE NOT ${layerSql("personal", "k")}`).all() as Row[];
  return personalFingerprint(
    personal.flatMap((r) => [r.title, r.body]),
    shared.flatMap((r) => [r.title, r.body])
  );
}

const reproduces = (fingerprint: PersonalFingerprint, normalised: string) =>
  normalised.length >= MIN_SENTENCE && fingerprint.sentences.some((s) => normalised.includes(s));

/**
 * `text` without every line that reproduces a personal-layer sentence — alone,
 * or together with the next line when the sentence is wrapped across both —
 * and how many lines were withheld. A run of blank lines a withheld line leaves
 * behind collapses to one. Text with nothing withheld comes back unchanged.
 */
export function withholdPersonalContent(text: string, fingerprint: PersonalFingerprint): { text: string; withheld: number } {
  if (fingerprint.sentences.length === 0) return { text, withheld: 0 };
  const lines = text.split("\n");
  const normalised = lines.map(normalise);
  const drop = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (reproduces(fingerprint, normalised[i])) drop.add(i);
    else if (i + 1 < lines.length && normalised[i] && normalised[i + 1] && reproduces(fingerprint, `${normalised[i]} ${normalised[i + 1]}`)) {
      if (!reproduces(fingerprint, normalised[i + 1])) {
        drop.add(i);
        drop.add(i + 1);
      }
    }
  }
  if (drop.size === 0) return { text, withheld: 0 };
  const kept = lines.filter((_, i) => !drop.has(i));
  return { text: kept.join("\n").replace(/\n{3,}/g, "\n\n"), withheld: drop.size };
}

/**
 * A draft bound for a shared scope with its title and body passed through
 * withholdPersonalContent. A title that is itself a personal sentence becomes
 * WITHHELD_TITLE. A draft owned by a user (scope=user) is the personal layer
 * already and comes back as it is.
 */
export function withholdPersonalDraft<T extends { slug: string; title: string; body: string; scope?: string }>(
  draft: T,
  fingerprint: PersonalFingerprint
): T {
  if (draft.scope === "user") return draft;
  const title = withholdPersonalContent(draft.title, fingerprint);
  const body = withholdPersonalContent(draft.body, fingerprint);
  if (title.withheld === 0 && body.withheld === 0) return draft;
  return { ...draft, title: title.withheld > 0 ? WITHHELD_TITLE : draft.title, body: body.text };
}
