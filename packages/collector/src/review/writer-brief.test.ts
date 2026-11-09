import { describe, expect, test } from "bun:test";
import { REVIEW_WRITER_TEMPLATE, buildReviewWriterBrief } from "./writer-brief.js";

describe("buildReviewWriterBrief", () => {
  test("names the refs, every changed file and the evidence, then the template", () => {
    const brief = buildReviewWriterBrief({
      packetId: "pk-1",
      branch: "feat/x",
      baseSha: "base1",
      headSha: "head1",
      changedFiles: ["a.ts", "b.ts"],
      checkpoints: ["Built it", "  "],
      screenshotPaths: ["/tmp/shot.png"],
      diffStat: "2 files changed",
    });
    expect(brief).toContain("Review packet: pk-1");
    expect(brief).toContain("git diff base1..head1");
    expect(brief).toContain("Changed files (2)");
    expect(brief).toContain("- a.ts\n- b.ts");
    expect(brief).toContain("- Built it");
    expect(brief).toContain("- /tmp/shot.png");
    expect(brief.endsWith(REVIEW_WRITER_TEMPLATE)).toBe(true);
  });

  test("the template asks for a lossless packet submitted with submit_review_packet", () => {
    for (const phrase of ["review-writer subagent", "every changed file", "REAL input → output", "submit_review_packet", "fix every one", '"changes"', ".webm", "carries a recording by default", "static UI stays on screenshots", "--record <local url> --cold"]) {
      expect(REVIEW_WRITER_TEMPLATE).toContain(phrase);
    }
    expect(REVIEW_WRITER_TEMPLATE.split("\n").length).toBeLessThanOrEqual(60);
  });

  test("the template points the worker at the Code review line for a project that requires one", () => {
    expect(REVIEW_WRITER_TEMPLATE).toContain("refused without its code review");
    expect(REVIEW_WRITER_TEMPLATE).toContain('"kind": "code_review|deploy|stack|other"');
  });

  test("a linked-review project's brief names the recorded review, or says to cut one first; others say nothing of it", () => {
    const url = "https://review.example/reviews/R-77";
    const link = { kind: "code_review" as const, label: "R-77", url };
    const recorded = buildReviewWriterBrief({
      changedFiles: [],
      codeReview: { recorded: { id: "R-77", url }, howToCut: "Cut it.", noun: "code review", link },
    });
    expect(recorded).toContain(`Code review: ${url} — this project's packets must link their code review`);
    expect(recorded).toContain(JSON.stringify(link));
    const none = buildReviewWriterBrief({
      changedFiles: [],
      codeReview: { howToCut: "Open the code review first.", noun: "code review", link: { kind: "code_review", label: "<review id>", url: "https://<the review's page>" } },
    });
    expect(none).toContain("so the packet is refused unless its links include it");
    expect(none).toContain("Open the code review first.");
    expect(buildReviewWriterBrief({ changedFiles: [] })).not.toContain("Code review:");
  });

  test("names exactly the media roots it is given: the scratch dir, the worktree, both or neither", () => {
    const line = (ctx: { scratchDir?: string; mediaWorktree?: string; launchScratchDir?: string }) =>
      buildReviewWriterBrief({ changedFiles: [], ...ctx })
        .split("\n")
        .find((l) => l.startsWith("Review scratch dir:"));
    expect(line({ scratchDir: "/d/review-scratch/l1", mediaWorktree: "/wt/l1" })).toBe(
      "Review scratch dir: /d/review-scratch/l1 — save screenshots and recordings here, or inside the worktree, /wt/l1; media anywhere else is refused."
    );
    expect(line({ scratchDir: "/d/review-scratch/l1", mediaWorktree: "/wt/l1", launchScratchDir: "/c/standup-scratch/l1" })).toBe(
      "Review scratch dir: /d/review-scratch/l1 — save screenshots and recordings in your launch scratch dir ($TMPDIR), /c/standup-scratch/l1, or here, or inside the worktree, /wt/l1; media anywhere else is refused."
    );
    expect(line({ launchScratchDir: "/c/standup-scratch/l1" })).toBe(
      "Review scratch dir: none for this launch — save screenshots and recordings in your launch scratch dir ($TMPDIR), /c/standup-scratch/l1; media anywhere else, this launch's working directory included, is refused."
    );
    const scratchOnly = line({ scratchDir: "/d/review-scratch/l1" })!;
    expect(scratchOnly).toBe(
      "Review scratch dir: /d/review-scratch/l1 — save screenshots and recordings here; media anywhere else, this launch's working directory included, is refused."
    );
    expect(scratchOnly).not.toContain("inside the worktree");
    expect(line({ mediaWorktree: "/wt/l1" })).toBe(
      "Review scratch dir: none for this launch — save screenshots and recordings inside the worktree, /wt/l1; media anywhere else is refused."
    );
    const neither = line({})!;
    expect(neither).toContain("submit the packet without media");
    expect(neither).not.toContain("inside the worktree");
    expect(REVIEW_WRITER_TEMPLATE).not.toContain("inside the worktree");
  });

  test("a long file list is summarized", () => {
    const files = Array.from({ length: 205 }, (_, i) => `f${i}.ts`);
    const brief = buildReviewWriterBrief({ changedFiles: files });
    expect(brief).toContain("- f199.ts");
    expect(brief).not.toContain("- f200.ts");
    expect(brief).toContain("and 5 more");
  });
});
