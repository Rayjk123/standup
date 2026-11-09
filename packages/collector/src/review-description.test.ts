import { expect, test, describe } from "bun:test";
import {
  REVIEW_DESCRIPTION_BRIEF,
  REVIEW_DESCRIPTION_GUIDANCE,
  REVIEW_DESCRIPTION_REVISION,
  REVIEW_DESCRIPTION_SECTIONS,
  composeReviewDescription,
} from "./review-description.js";

/** The `## ` headings of a markdown body, in order. */
function headings(md: string): string[] {
  return md.split("\n").filter((l) => l.startsWith("## ")).map((l) => l.slice(3));
}

describe("review description template", () => {
  test("its sections are the review packet's, in the Review tab's order", () => {
    expect([...REVIEW_DESCRIPTION_SECTIONS]).toEqual(["Intent", "What changed", "Validation", "Risks & open questions", "Links"]);
  });

  test("the composed skeleton carries exactly those sections, seeded from the ticket", () => {
    const md = composeReviewDescription({ title: "Fix the widget", body: "  The widget double-counted on retry.\n", issueId: " ISSUE-9 " });
    expect(headings(md)).toEqual([...REVIEW_DESCRIPTION_SECTIONS]);
    expect(md).toContain("## Intent\n\n> The widget double-counted on retry.\n\n");
    expect(md).toContain("- Fix the widget");
    expect(md).toContain("Request:");
    expect(md).toContain("Result:");
    expect(md).toContain("**Out of scope:**");
    expect(md).toContain("- Issue: ISSUE-9");
    expect(md).not.toMatch(/^## (What|Why|Testing)$/m);
  });

  test("an empty ticket body falls back to the title for the intent, and no issue leaves Links to fill", () => {
    const md = composeReviewDescription({ title: "Fix\nthe   widget", body: "   " });
    expect(md).toContain("## Intent\n\n> Fix the widget\n");
    // The title stays one bullet even when it carries a newline.
    expect(md).toContain("\n- Fix the widget\n");
    expect(md).not.toContain("- Issue:");
    expect(md).toContain("## Links\n\n- (fill in");
  });

  test("a title's leading block marker is escaped, so its bullet stays plain text", () => {
    const bullet = (title: string) => composeReviewDescription({ title, body: "b" }).split("\n").find((l) => l.startsWith("- ") && l !== "- Files: (fill in)")!;
    expect(bullet("## Injected title")).toBe("- \\## Injected title");
    expect(bullet("# t")).toBe("- \\# t");
    expect(bullet("> quoted")).toBe("- \\> quoted");
    expect(bullet("- nested")).toBe("- \\- nested");
    expect(bullet("```js")).toBe("- \\```js");
    expect(bullet("<!-- x")).toBe("- \\<!-- x");
    expect(bullet("1. step")).toBe("- 1\\. step");
    expect(bullet("Fix the widget")).toBe("- Fix the widget");
  });

  test("the guidance numbers every section in order and asks Validation for evidence from a real run", () => {
    const positions = REVIEW_DESCRIPTION_SECTIONS.map((section, i) => REVIEW_DESCRIPTION_GUIDANCE.indexOf(`${i + 1}. **${section}**`));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(REVIEW_DESCRIPTION_GUIDANCE).toContain("the path driven end to end");
    expect(REVIEW_DESCRIPTION_GUIDANCE).toContain("one request that\n   was sent and the result that came back");
    expect(REVIEW_DESCRIPTION_GUIDANCE).toContain("**Out of scope**");
    expect(REVIEW_DESCRIPTION_GUIDANCE).not.toMatch(/\*\*(What|Why|Testing)\*\*/);
  });

  test("a revision changes the existing description rather than writing another", () => {
    expect(REVIEW_DESCRIPTION_REVISION).toContain("its description file is the one to change");
    expect(REVIEW_DESCRIPTION_REVISION).toContain("keep its headings");
    expect(REVIEW_DESCRIPTION_REVISION).toContain("never written");
  });

  /** The Intent section's lines between its heading and the next blank-line-separated block. */
  function quotedIntent(md: string): string[] {
    const lines = md.split("\n");
    const start = lines.indexOf("## Intent") + 2;
    const end = lines.indexOf("", start);
    return lines.slice(start, end);
  }

  // Bodies that, unquoted, open a block that runs past the Intent section:
  // an unclosed fence, a fence in a list item, raw HTML, a setext heading.
  const HOSTILE = [
    "Intro.\n## Repro\n# Top\n```\nstack trace",
    "- item\n  ```\n## Injected\nmore",
    "- item\n  ```js\n  code",
    "<!-- template note\n## x",
    "<pre>\nhello",
    "Heading\n---",
    "```bun test``` fails on CI\n\n## Repro",
    "<script>\nalert(1)",
    "````\n```\n## x",
    "1. step\n   <!--\n## x",
    "a\r## x\r```",
    "a\r\n## x\r\n```",
  ];

  test("ticket text is quoted whole, so nothing it opens outlives the Intent section", () => {
    for (const body of HOSTILE) {
      const md = composeReviewDescription({ title: "T", body });
      const quote = quotedIntent(md);
      // Every body line, blank ones included, sits in the quote, and the quote is
      // closed by a blank line before the template's own text resumes.
      expect(quote).toHaveLength(body.split(/\r\n?|\n/).length);
      expect(md).not.toContain("\r");
      expect(quote.every((l) => l === ">" || l.startsWith("> "))).toBe(true);
      expect(md).toContain(`${quote.at(-1)}\n\n(replace the quoted ticket text`);
      expect(headings(md)).toEqual([...REVIEW_DESCRIPTION_SECTIONS]);
      // The template's own fences are untouched.
      expect(md).toContain("Request:\n\n```\n(fill in: what was sent)\n```");
    }
  });

  test("top-level ticket headings are demoted, fenced content is left as written", () => {
    const md = composeReviewDescription({ title: "T", body: "  ## Indented\n# Top\n```sh\n# install deps\n```\n~~~~\n## inside tilde" });
    expect(md).toContain("> #### Indented\n> #### Top\n");
    expect(md).toContain("> ```sh\n> # install deps\n> ```\n");
    expect(md).toContain("> ~~~~\n> ## inside tilde\n");
    // An inline triple-backtick span opens no fence, so a later heading is still demoted.
    expect(composeReviewDescription({ title: "T", body: "```x``` fails\n## Repro" })).toContain("> ```x``` fails\n> #### Repro\n");
    // `#hashtag` and `#123` are not headings.
    expect(composeReviewDescription({ title: "T", body: "#hashtag\n#123" })).toContain("> #hashtag\n> #123\n");
  });

  test("the one-line brief names every section and the revision rule", () => {
    for (const section of REVIEW_DESCRIPTION_SECTIONS) expect(REVIEW_DESCRIPTION_BRIEF).toContain(`## ${section}`);
    expect(REVIEW_DESCRIPTION_BRIEF).toContain("change its current description rather than starting another");
    expect(REVIEW_DESCRIPTION_BRIEF).toContain("one actual request and its result");
  });
});
