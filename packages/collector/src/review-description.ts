/**
 * The code-review description template. It mirrors the review packet the
 * Review tab shows (Intent → What changed → Validation → Risks & open
 * questions → Links), so a code review reads the way its packet does: the
 * change's intent first, then what changed area by area, then how it was
 * proven to work.
 */

/** The description's section headings, in order (the packet's order). */
export const REVIEW_DESCRIPTION_SECTIONS = [
  "Intent",
  "What changed",
  "Validation",
  "Risks & open questions",
  "Links",
] as const;

/** How a worker fills each section: one numbered entry per heading, each naming the reviewer's question it answers. */
export const REVIEW_DESCRIPTION_GUIDANCE = `Hand the review tool a description built from the five headings below, kept
in this order so the review reads like the Standup review packet for the same
change. Each heading answers one question a reviewer brings:

1. **Intent** answers "why does this change exist?" A short paragraph is
   enough. The per-file detail belongs in the next section, and the story of
   how the change was found belongs nowhere.
2. **What changed** answers "where do I look?" Split the change into areas,
   each under its own \`###\` heading, even when there is only one. List the
   edits and the reason for each as short points, and end each area with the
   files it touches.
3. **Validation** answers "how do we know it works?" Lead with evidence from
   running the real thing: the path driven end to end, plus one request that
   was sent and the result that came back. Test counts follow in a single
   line; they back the evidence up and do not stand in for it. UI work gets
   screenshots in the body, uploaded to the review after it is created. Work
   held back on purpose is named on an **Out of scope** line.
4. **Risks & open questions** answers "what might bite us?" List the ways it
   could fail and the doubts that remain, or say that none are known.
5. **Links** answers "where is the rest?" Point at the tracking issue, the
   deployment and stack, and related reviews. Leave the heading out when
   there is nothing to link.`;

/** How a revision treats the description. */
export const REVIEW_DESCRIPTION_REVISION = `When the review already exists, its description file is the one to change.
Open it, keep its headings, bring What changed and Validation up to date with
this revision, and pass the same file to the review tool again. A second,
separate description for the same review is never written.`;

/** The one-line form of the template for the pipeline brief, where the worker cuts or revises the review itself. */
export const REVIEW_DESCRIPTION_BRIEF =
  `Give the code review a description under the review packet's headings (${REVIEW_DESCRIPTION_SECTIONS.map((s) => `## ${s}`).join(", ")}), ` +
  "where Validation shows the real path that was run end to end with one actual request and its result (UI work: " +
  "screenshots in the body, uploaded after the review is created; anything held back on purpose goes on an Out of " +
  "scope line); when the review already exists, change its current description rather than starting another.";

/** What a review description is seeded from: the ticket's title and body, and its issue id when known. */
export interface ReviewDescriptionSeed {
  title: string;
  body: string;
  issueId?: string;
}

/**
 * Ticket text made safe to sit inside one section: it is quoted, so whatever
 * it opens — a code fence, a list, a raw HTML block, a heading — ends with the
 * quote and can't swallow or split the template's sections after it. Top-level
 * ATX headings are also demoted below the template's `##`/`###` levels, and
 * lines inside a top-level code fence are left as written.
 */
function sectionSafe(text: string): string {
  let fence: { char: string; len: number } | null = null;
  // A bare `\r` is a line ending too; left in, it would hide lines from the quote.
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      // A backtick fence's info string can't hold a backtick, so "```x``` …" is an inline span, not a fence.
      const m = line.match(/^ {0,3}(?:(`{3,})[^`]*|(~{3,}).*)$/);
      const marker = m?.[1] ?? m?.[2];
      if (fence) {
        if (marker && marker[0] === fence.char && marker.length >= fence.len && line.trim() === marker) fence = null;
      } else if (marker) {
        fence = { char: marker[0]!, len: marker.length };
      } else if (/^ {0,3}#{1,6}(\s|$)/.test(line)) {
        line = `#### ${line.replace(/^ {0,3}#+\s*/, "")}`;
      }
      return line.trim() === "" ? ">" : `> ${line}`;
    })
    .join("\n");
}

/** A single-line form of the ticket title, so it stays one bullet. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The title as plain bullet text: a leading block marker (`#`, `>`, a list
 * marker, a fence, `<`, `1.`) is backslash-escaped so the bullet can't hold a
 * heading, quote, nested list, code block or HTML block.
 */
function bulletText(title: string): string {
  return oneLine(title)
    .replace(/^(\d+)([.)])/, "$1\\$2")
    .replace(/^([#>+*\-=<|`~])/, "\\$1");
}

/** A review description skeleton in the packet-shaped template, seeded from the ticket; `(fill in: …)` marks what the agent writes. */
export function composeReviewDescription(seed: ReviewDescriptionSeed): string {
  const [intent, changes, validation, risks, links] = REVIEW_DESCRIPTION_SECTIONS;
  const issueId = seed.issueId?.trim();
  return [
    `## ${intent}`,
    "",
    sectionSafe(seed.body.trim() || oneLine(seed.title)),
    "",
    "(replace the quoted ticket text above with a short paragraph on why this change exists)",
    "",
    `## ${changes}`,
    "",
    "### (fill in: area)",
    "",
    `- ${bulletText(seed.title)}`,
    "- Files: (fill in)",
    "",
    `## ${validation}`,
    "",
    "**(fill in: what was run end to end)**",
    "",
    "Request:",
    "",
    "```",
    "(fill in: what was sent)",
    "```",
    "",
    "Result:",
    "",
    "```",
    "(fill in: what came back or what happened)",
    "```",
    "",
    "Tests: (fill in: one line with the passed and failed counts)",
    "",
    "(UI work: screenshots here, uploaded after the review is created)",
    "",
    "**Out of scope:** (fill in what was held back on purpose, or remove this line)",
    "",
    `## ${risks}`,
    "",
    "- (fill in, or say that none are known)",
    "",
    `## ${links}`,
    "",
    issueId ? `- Issue: ${issueId}` : "- (fill in: issue, deployment, stack, related reviews; remove this heading if there is nothing to link)",
  ].join("\n");
}
