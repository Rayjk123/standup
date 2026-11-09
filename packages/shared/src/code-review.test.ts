import { describe, expect, test } from "bun:test";
import {
  CODE_REVIEW_LINK_KIND,
  codeReviewOfEvidence,
  codeReviewOfId,
  codeReviewOfUrl,
  reviewIdFromUrl,
  reviewPacketCodeReview,
  reviewPacketCodeReviews,
  type CodeReviewLinkFormat,
} from "./code-review.js";
import type { ReviewLink } from "./review.js";

const link = (kind: ReviewLink["kind"], label: string, url: string): ReviewLink => ({ kind, label, url });

/** An org's review tool whose reviews are `R-<n>` at the top of review.example.corp. */
const CORP: CodeReviewLinkFormat = {
  urlPattern: String.raw`^https://review\.example\.corp/(R-\d+)(?:[/?#]|$)`,
  idPattern: String.raw`\bR-\d+\b`,
  urlTemplate: "https://review.example.corp/{id}",
};

describe("reviewIdFromUrl", () => {
  const cases: Array<[string, string | null]> = [
    ["https://github.com/o/r/pull/12", "12"],
    ["https://github.com/o/r/pull/12/files", "12"],
    ["https://gitlab.example/g/p/-/merge_requests/7", "7"],
    ["https://review.example/reviews/42/diff/2", "42"],
    ["https://gerrit.example/c/project/+/4401", "4401"],
    ["https://review.example/D123", "D123"],
    ["https://review.example/", "review.example"],
    ["javascript:alert(1)", null],
    ["not a url", null],
  ];
  for (const [url, id] of cases) test(url, () => expect(reviewIdFromUrl(url)).toBe(id));
});

describe("the default format: any http(s) code_review link", () => {
  test("a code_review link names its review by URL", () => {
    expect(reviewPacketCodeReview([link(CODE_REVIEW_LINK_KIND, "#12", "https://github.com/o/r/pull/12")])).toEqual({
      id: "12",
      url: "https://github.com/o/r/pull/12",
    });
  });

  test("other kinds never name the review, and a non-http(s) URL names none", () => {
    expect(reviewPacketCodeReview([link("other", "pr", "https://github.com/o/r/pull/12")])).toBeNull();
    expect(reviewPacketCodeReview([link(CODE_REVIEW_LINK_KIND, "x", "ftp://x/1")])).toBeNull();
    expect(reviewPacketCodeReview([])).toBeNull();
  });

  test("bare ids are not read without an idPattern and urlTemplate", () => {
    expect(codeReviewOfId("R-7")).toBeNull();
  });

  test("every review is listed once", () => {
    const links = [
      link(CODE_REVIEW_LINK_KIND, "#1", "https://github.com/o/r/pull/1"),
      link(CODE_REVIEW_LINK_KIND, "#1 files", "https://github.com/o/r/pull/1/files"),
      link(CODE_REVIEW_LINK_KIND, "#2", "https://github.com/o/r/pull/2"),
    ];
    expect(reviewPacketCodeReviews(links).map((r) => r.id)).toEqual(["1", "2"]);
  });
});

describe("an org's format", () => {
  test("a matching URL names the review, whatever the link's kind", () => {
    expect(reviewPacketCodeReview([link("other", "the review", "https://review.example.corp/R-42")], CORP)).toEqual({
      id: "R-42",
      url: "https://review.example.corp/R-42",
    });
    expect(reviewPacketCodeReview([link(CODE_REVIEW_LINK_KIND, "x", "https://review.example.corp/R-42/diff/3")], CORP)?.id).toBe("R-42");
  });

  test("a code_review link's bare id counts, pointed at its page", () => {
    expect(reviewPacketCodeReview([link(CODE_REVIEW_LINK_KIND, "R-7 — fix", "https://example.com/elsewhere")], CORP)).toEqual({
      id: "R-7",
      url: "https://review.example.corp/R-7",
    });
  });

  test("a matching URL wins over an earlier id-only link; each is listed once", () => {
    const links = [
      link("other", "upstream", "https://review.example.corp/R-9"),
      link(CODE_REVIEW_LINK_KIND, "R-1", "https://review.example.corp/R-1"),
      link(CODE_REVIEW_LINK_KIND, "again", "https://review.example.corp/R-1/diff/2"),
      link(CODE_REVIEW_LINK_KIND, "R-5 by id", "https://example.com"),
    ];
    expect(reviewPacketCodeReviews(links, CORP).map((r) => r.id)).toEqual(["R-1", "R-9", "R-5"]);
  });

  test("no review: a lookalike host, an id on another kind, a non-review path", () => {
    expect(reviewPacketCodeReview([link("deploy", "R-3", "https://review.example.corp.evil.example/R-3")], CORP)).toBeNull();
    expect(reviewPacketCodeReview([link("other", "R-3", "https://example.com")], CORP)).toBeNull();
    expect(reviewPacketCodeReview([link(CODE_REVIEW_LINK_KIND, "PR 12", "https://github.com/o/r/pull/12")], CORP)).toBeNull();
    expect(reviewPacketCodeReview([link("other", "x", "https://review.example.corp/R-3x")], CORP)).toBeNull();
  });

  test("an invalid pattern matches nothing rather than throwing", () => {
    expect(codeReviewOfUrl("https://x/reviews/1", { urlPattern: "(" })).toBeNull();
  });
});

describe("codeReviewOfEvidence", () => {
  test("the url names the review (its id read from it), else a bare id under the format", () => {
    expect(codeReviewOfEvidence({ url: "https://github.com/o/r/pull/5", reviewId: "PR 5" })).toEqual({
      id: "5",
      url: "https://github.com/o/r/pull/5",
    });
    expect(codeReviewOfEvidence({ reviewId: "R-8" }, CORP)).toEqual({ id: "R-8", url: "https://review.example.corp/R-8" });
    expect(codeReviewOfEvidence({ reviewId: "R-8" })).toBeNull();
    expect(codeReviewOfEvidence(undefined)).toBeNull();
  });
});
