/**
 * Detects a worker's turn-end report that hands the next step to the owner
 * ("the owner opens the review", "ready for you to merge", "needs your
 * approval"), so the job can be marked `waiting_user` without Persona having
 * to notice it.
 *
 * Conservative by design: it matches only forward-looking hand-off phrasing
 * that names the owner (or "you"), never past-tense reports of finished work
 * ("pushed the branch", "the owner approved it", "I didn't push"), and skips a
 * match whose clause is negated or conditional ("no need for you to review",
 * "if you run it").
 */

import { escapeRegExp, orNoun, perReviewNoun } from "./review-noun.js";

/** Actions the owner is asked to take, base form. */
const ACTIONS = "open|cut|create|review|merge|run|approve|decide|push|deploy|publish|submit|sign\\s+off|confirm|pick|choose";
/** The same actions, third-person present ("the owner opens"). */
const ACTIONS_3P =
  "opens|cuts|creates|reviews|merges|runs|approves|decides|pushes|deploys|publishes|submits|signs\\s+off|confirms|picks|chooses";
/** Modals that leave the step to the owner. "you can run X" is advice, so "can" counts only for a named owner. */
const MODALS = "should|will\\s+need\\s+to|needs?\\s+to|has\\s+to|have\\s+to|must";
const NAMED_MODALS = `can|${MODALS}`;
const WANTS = "approval|decision|review|input|sign-?off|go-?ahead|confirmation|call|ok|okay";

/** Words that, just before a match in the same clause, mean it is not a hand-off. */
const GUARD =
  /\b(?:no|not|never|without|nothing|no\s+longer|was|were|had\s+been|previously|earlier|where|whenever|when|if|unless)\b|n['’]t\b/i;
const GUARD_WINDOW = 40;

function patterns(ownerAlias?: string): RegExp[] {
  const alias = ownerAlias?.trim() ? `|${escapeRegExp(ownerAlias.trim())}` : "";
  const named = `(?:(?:the\\s+)?owner${alias})`;
  const third = `(?:${named}|the\\s+user)`;
  const anyone = `(?:${third}|you)`;
  const possessive = `(?:your|(?:the\\s+)?owner['’]?s?${alias ? `|${escapeRegExp(ownerAlias!.trim())}['’]s` : ""}|the\\s+user['’]s)`;
  return [
    // "the owner opens the review", "alice cuts the PR"
    new RegExp(`\\b${named}\\s+(?:${ACTIONS_3P})\\b`, "i"),
    // "the owner can merge", "you need to approve"
    new RegExp(`\\b${third}\\s+(?:${NAMED_MODALS})\\s+(?:${ACTIONS})\\b`, "i"),
    new RegExp(`\\byou\\s+(?:${MODALS})\\s+(?:${ACTIONS})\\b`, "i"),
    // "for the owner to run", "left for you to merge"
    new RegExp(`\\bfor\\s+${anyone}\\s+to\\s+(?:${ACTIONS})\\b`, "i"),
    // "ready for you to merge", "ready for your review"
    new RegExp(`\\bready\\s+for\\s+(?:${anyone}|${possessive})\\b`, "i"),
    // "needs your approval", "awaiting the owner's decision"
    new RegExp(`\\b(?:needs?|requires?|awaiting|awaits|waiting\\s+(?:on|for)|pending)\\s+${possessive}\\s+(?:${WANTS})\\b`, "i"),
    // "waiting on the owner", "waiting for you"
    new RegExp(`\\b(?:waiting|wait)\\s+(?:on|for)\\s+${anyone}\\b`, "i"),
    // "handing it over to you", "passing this back to the owner"
    new RegExp(`\\b(?:hand(?:ing)?|pass(?:ing)?)\\s+(?:it|this|that|the\\s+\\w+\\s+)?\\s*(?:off|over|back)\\s+to\\s+${anyone}\\b`, "i"),
    // A report that opens with "Over to you."
    /^\s*over\s+to\s+you\b/i,
  ];
}

/** Splits a report into sentences; a `;` or line break ends one too. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function guarded(sentence: string, index: number): boolean {
  const before = sentence.slice(Math.max(0, index - GUARD_WINDOW), index);
  // Only the clause the match sits in: "No push, the owner opens it" keeps the hand-off.
  const clause = before.split(/[,:—–(]/).pop() ?? "";
  return GUARD.test(clause);
}

/** What a review of the change is a review of: the change, its diff, PR (or the org's noun for one), code, branch or patch. */
const changeOf = (noun: string | null): string =>
  String.raw`(?:(?:the|this|my|these)\s+)?(?:change|changes|diff|pr|code|branch|patch|commits?${orNoun(noun)})\b`;
/** Where a phrase ends: punctuation (dashes too), the end, or "before"/"when"/"so" going on to something else. */
const END = String.raw`(?=\s*(?:[.!?,;:)—–-]|$|\s+(?:before|when|so|once|and\s+merge)\b))`;
/** What a bare "please review" points at when it points at the worker's own work. */
const IT = String.raw`(?:\s+(?:it|this|my\s+work))?`;

/**
 * A hand-off that asks the owner to review the change itself: "ready for
 * (code) review", "ready to review", "please review the diff", "can you
 * review the change", "awaiting / needs your review", "over to you for
 * review", "for you to review", "the owner opens the review", "the review
 * packet". A review of anything else ("please review the deploy plan", "the
 * logs, for your review of the incident", "your sign-off to push to prod"),
 * work the worker reviewed itself ("I've reviewed the plan") or another step
 * ("approve the deploy") is not — those still reach the owner as hand-offs.
 * Built per org profile (changeOf).
 */
const reviewHandoff = perReviewNoun((noun) => {
  const CHANGE = changeOf(noun);
  return new RegExp(
    [
      String.raw`\bready\s+(?:for|to)\s+(?:(?:your|the\s+owner['’]?s?|a|code)\s+)?review${END}`,
      String.raw`\b(?:please|can\s+you|could\s+you|would\s+you|you\s+(?:can|should|need\s+to))\s+review\s+${CHANGE}`,
      String.raw`\b(?:please|can\s+you|could\s+you|would\s+you)\s+review${IT}${END}`,
      String.raw`\b(?:up\s+for|for\s+your)\s+review${END}`,
      String.raw`\b(?:awaiting|awaits|needs?|requires?|waiting\s+(?:on|for)|pending)\s+(?:your|the\s+owner['’]?s?|a|code)\s+(?:code\s+)?review${END}`,
      String.raw`\bover\s+to\s+you\s+for\s+(?:a\s+)?review${END}`,
      String.raw`\b(?:opens?|does|do|starts?)\s+the\s+review${END}`,
      String.raw`\bfor\s+(?:you|the\s+owner)\s+to\s+review(?:\s+${CHANGE}|${END})`,
      String.raw`\breview\s+packet\b`,
    ].join("|"),
    "i"
  );
});

/** Whether `sentence` hands the owner the change to review (rather than some other step). */
export function isReviewHandoff(sentence: string): boolean {
  return reviewHandoff().test(sentence);
}

/**
 * The sentence of `text` that hands the next step to the owner, or null.
 * `ownerAlias` also counts the owner's alias as naming them.
 */
export function ownerHandoff(text: string | undefined | null, ownerAlias?: string): string | null {
  if (!text) return null;
  const rules = patterns(ownerAlias);
  for (const sentence of sentences(text)) {
    for (const rule of rules) {
      const match = rule.exec(sentence);
      if (match && !guarded(sentence, match.index)) return sentence;
    }
  }
  return null;
}
