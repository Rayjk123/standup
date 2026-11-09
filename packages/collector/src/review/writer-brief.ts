/**
 * The brief a worker gets when its change enters human review: it spawns a
 * review-writer subagent that reads the change and its evidence, writes a
 * review packet, and submits it with the `submit_review_packet` MCP tool.
 */

import type { ReviewLink } from "@standup/shared";

/** How many changed files the brief lists before summarizing the rest. */
const MAX_LISTED_FILES = 200;
const MAX_LISTED_CHECKPOINTS = 10;
const MAX_CHECKPOINT_CHARS = 300;

export const REVIEW_WRITER_TEMPLATE = `Your change is ready for human review. Spawn a review-writer subagent (the Agent tool) with this brief, wait for it, and make sure its packet was accepted.

Review-writer brief:
1. Read the change: \`git diff <base>..<head>\` (refs above), the checkpoints above, the validation you ran (test and build output, live requests and their responses), and every screenshot or recording you made.
2. Write a review packet a reviewer can approve from without opening the diff. Concise but lossless:
   - Cover every changed area; list every changed file in some area's "files" (the server rejects a packet that leaves one out).
   - Quote only the hunks that carry the key logic (at most 40, each under 4000 chars); never the whole diff.
   - Scale with the change: a one-line fix gets one area and a sentence; a large change gets one area per concern.
   - intent: 1–3 sentences on what the change is for and why.
   - validation.samples: REAL input → output from a live run (the request sent and the response or behavior observed), copied, not invented; validation.tests: the test summary with pass/fail counts.
   - risks and questions: honest; what could break, what you are unsure of. Empty arrays only when there truly are none.
   - media: screenshots and Playwright recordings (.png/.jpg/.gif/.webp, .webm/.mp4/.m4v up to 100 MB) saved only where the "Review scratch dir" line above says (no other location is accepted, the system temp dir included), each with a caption saying what it shows. A perf, load-time or interaction-flow change carries a recording by default (the screenshot helper's \`--record <local url> --cold --out <that dir>/<name>.webm\` mode, named in the pipeline brief, burns the measured ms into the video); static UI stays on screenshots.
   - links: the code review (pull request), the deploy, the stack, when there are any. The "Code review" line above, when present, says this project's packet is refused without its code review, and names the one it must link.
3. Submit it with the standup MCP tool \`submit_review_packet\`, arguments {"packet": <packet>, "media": [{"path": "/abs/path.png", "caption": "…"}]}.
4. If the tool returns problems, fix every one and call it again until it is accepted.

Packet shape (JSON):
{
  "title": "Short imperative title (≤120 chars)",
  "intent": "1–3 sentences.",
  "changes": [
    {
      "area": "Area name",
      "bullets": ["What changed and why"],
      "files": ["path/changed.ts"],
      "hunks": [{"file": "path/changed.ts", "header": "@@ -10,6 +10,9 @@", "diff": "-old\\n+new"}]
    }
  ],
  "validation": {
    "samples": [{"label": "What was exercised", "input": "The request or action", "output": "What came back"}],
    "tests": {"summary": "bun test: 120 pass, 0 fail", "passed": 120, "failed": 0}
  },
  "risks": {"risks": ["…"], "questions": ["…"]},
  "links": [{"kind": "code_review|deploy|stack|other", "label": "#123", "url": "https://…"}]
}

After it is accepted, stop and wait: the owner approves it or requests changes in the Review tab. Requested changes arrive as a message; address them, then return to coding and resubmit the packet the same way.`;

export interface ReviewWriterContext {
  packetId?: string;
  branch?: string;
  baseSha?: string;
  headSha?: string;
  changedFiles: string[];
  checkpoints?: string[];
  screenshotPaths?: string[];
  diffStat?: string;
  /** The launch's review scratch dir, where screenshots and recordings may be saved. */
  scratchDir?: string;
  /**
   * Set when the packet must link its code review (see codeReviewRequirement):
   * the review the launch's code_review stage recorded, when it has one, how
   * one is cut otherwise, what the project calls a review, and the link entry
   * the packet adds.
   */
  codeReview?: { recorded?: { id: string; url: string }; howToCut: string; noun: string; link: ReviewLink };
  /** The launch's worktree when media may be saved in it (reviewMediaWorktree); unset when it may not. */
  mediaWorktree?: string;
  /** The launch's own scratch dir, its TMPDIR, when media may be saved in it (reviewMediaLaunchScratch). */
  launchScratchDir?: string;
}

/**
 * Where the brief tells the worker to save media: exactly the roots
 * submit_review_packet reads media from. The launch's own TMPDIR scratch dir
 * comes first, as a worker writes there without a safety-floor hold.
 */
function mediaLocationLine(scratchDir: string | undefined, worktree: string | undefined, launchScratch?: string): string {
  const head = `Review scratch dir: ${scratchDir ?? "none for this launch"}`;
  const places = [
    ...(launchScratch ? [`in your launch scratch dir ($TMPDIR), ${launchScratch}`] : []),
    ...(scratchDir ? ["here"] : []),
    ...(worktree ? [`inside the worktree, ${worktree}`] : []),
  ];
  if (places.length === 0) {
    return `${head}, and its working directory can't hold review media — submit the packet without media.`;
  }
  const elsewhere = worktree ? "media anywhere else is refused" : "media anywhere else, this launch's working directory included, is refused";
  return `${head} — save screenshots and recordings ${places.join(", or ")}; ${elsewhere}.`;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The review-writer brief for a change: its refs, changed files and evidence, then the template. */
export function buildReviewWriterBrief(ctx: ReviewWriterContext): string {
  const lines: string[] = ["## Human review"];
  if (ctx.packetId) lines.push(`Review packet: ${ctx.packetId}`);
  if (ctx.branch) lines.push(`Branch: ${ctx.branch}`);
  const base = ctx.baseSha ?? "<base>";
  const head = ctx.headSha ?? "HEAD";
  lines.push(`Diff: git diff ${base}..${head}`);
  if (ctx.diffStat?.trim()) lines.push(`Diff stat: ${clip(ctx.diffStat, 300)}`);
  if (ctx.codeReview) {
    const { recorded, noun, howToCut, link } = ctx.codeReview;
    lines.push(
      "",
      recorded
        ? `Code review: ${recorded.url} — this project's packets must link their ${noun}, so the packet must link this one in its links (${JSON.stringify(link)}); it is refused without it.`
        : `Code review: this project's packets must link their ${noun}, so the packet is refused unless its links include it (${JSON.stringify(link)}). ${howToCut}`
    );
  }

  const files = ctx.changedFiles;
  if (files.length > 0) {
    lines.push("", `Changed files (${files.length}) — each must appear in some change area's files:`);
    for (const f of files.slice(0, MAX_LISTED_FILES)) lines.push(`- ${f}`);
    if (files.length > MAX_LISTED_FILES) lines.push(`- … and ${files.length - MAX_LISTED_FILES} more (see git diff --name-only)`);
  } else {
    lines.push("", "Changed files: none found between the refs; list what `git diff --name-only` shows.");
  }

  const checkpoints = (ctx.checkpoints ?? []).filter((c) => c.trim());
  if (checkpoints.length > 0) {
    lines.push("", "Checkpoints:");
    for (const c of checkpoints.slice(-MAX_LISTED_CHECKPOINTS)) lines.push(`- ${clip(c, MAX_CHECKPOINT_CHARS)}`);
  }

  lines.push("", mediaLocationLine(ctx.scratchDir, ctx.mediaWorktree, ctx.launchScratchDir));

  const shots = (ctx.screenshotPaths ?? []).filter((p) => p.trim());
  if (shots.length > 0) {
    lines.push("", "Screenshots and recordings already made:");
    for (const p of shots) lines.push(`- ${p}`);
  }

  return `${lines.join("\n")}\n\n${REVIEW_WRITER_TEMPLATE}`;
}
