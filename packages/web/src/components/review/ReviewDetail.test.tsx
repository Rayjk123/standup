import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import type { ReviewComment, ReviewPacketDetail } from "@standup/shared";
import type { Root } from "react-dom/client";
import { GlobalWindow } from "happy-dom";
import {
  FIXTURE_NOW,
  fixtureDetail,
  fixtureDetailOtherSession,
  fixtureDetailPipelineOff,
  fixtureDetailWaived,
  fixtureDetailWontfixAccepted,
  fixtureQuestions,
} from "./review-fixtures";

// react-dom decides whether a DOM exists when it is first imported, so the
// window is installed before the view modules load.
const window = new GlobalWindow({ url: "http://localhost/" });
const GLOBALS = [
  "window",
  "document",
  "navigator",
  "Node",
  "HTMLElement",
  "Element",
  "Text",
  "Event",
  "KeyboardEvent",
  "MutationObserver",
  "requestAnimationFrame",
  "cancelAnimationFrame",
] as const;
const saved = new Map<string, unknown>();

let act: (fn: () => void | Promise<void>) => Promise<void>;
let createRoot: (el: Element) => Root;
let ReviewDetail: typeof import("./ReviewDetail").ReviewDetail;

beforeAll(async () => {
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] = (window as unknown as Record<string, unknown>)[name];
  }
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = (await import("react")) as unknown as { act: typeof act });
  ({ createRoot } = await import("react-dom/client"));
  ({ ReviewDetail } = await import("./ReviewDetail"));
});

afterAll(async () => {
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
  await window.happyDOM.close();
});

let host: HTMLElement;
let root: Root;

afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});

async function renderDetail(review: ReviewPacketDetail = fixtureDetail, withDecide = true) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(() =>
    root.render(
      createElement(ReviewDetail, {
        review,
        now: FIXTURE_NOW,
        ...(withDecide ? { onDecide: async () => ({}) } : {}),
      })
    )
  );
}

function section(id: string): HTMLElement {
  return host.querySelector(`[data-testid=${id}]`) as HTMLElement;
}

describe("ReviewDetail", () => {
  test("renders the header: title, status, revision, ref and ids", async () => {
    await renderDetail();
    const header = host.querySelector("header")!;
    expect(header.querySelector("h2")?.textContent).toBe(fixtureDetail.title);
    expect(header.querySelector("[data-status=pending]")).not.toBeNull();
    expect(header.textContent).toContain("Revision 2");
    expect(header.textContent).toContain("standup/review-tab@9c41f2e");
    expect(header.textContent).toContain("job job-review-tab");
    expect(header.textContent).toContain("session sess-4c1d9e20");
  });

  test("the header shows the packet's code review right under the title, linked to its page", async () => {
    await renderDetail();
    const header = host.querySelector("header")!;
    const review = header.querySelector("[data-testid=review-code-review]") as HTMLAnchorElement;
    expect(review.previousElementSibling?.tagName).toBe("H2");
    expect(review.getAttribute("href")).toBe("https://github.com/example/standup/pull/4106");
    expect(review.getAttribute("target")).toBe("_blank");
    expect(review.getAttribute("rel")).toBe("noopener noreferrer");
    expect(review.textContent).toContain("Code review");
    expect(review.textContent).toContain("4106");
  });

  test("the header shows the code review the collector read under the project's adapter, not the links' default read", async () => {
    const url = "https://review.example.corp/R-77/diff";
    await renderDetail({ ...fixtureDetail, links: [{ kind: "code_review", label: "R-77", url }], codeReview: { id: "R-77", url } });
    const review = host.querySelector("header [data-testid=review-code-review]") as HTMLAnchorElement;
    expect(review.getAttribute("href")).toBe("https://review.example.corp/R-77/diff");
    expect(review.textContent).toContain("R-77");
    expect(review.textContent).not.toContain("diff");
  });

  test("the collector's read of no code review shows none, whatever the links hold", async () => {
    await renderDetail({ ...fixtureDetail, codeReview: null });
    expect(host.querySelector("[data-testid=review-code-review]")).toBeNull();
  });

  test("a code review the collector read from a bare id links to the page it built", async () => {
    await renderDetail({ ...fixtureDetail, links: [{ kind: "code_review", label: "R-88", url: "R-88" }], codeReview: { id: "R-88", url: "https://review.example.corp/R-88" } });
    const review = host.querySelector("header [data-testid=review-code-review]") as HTMLAnchorElement;
    expect(review.getAttribute("href")).toBe("https://review.example.corp/R-88");
  });

  test("a packet with no code review link shows none in the header", async () => {
    await renderDetail({ ...fixtureDetail, links: [{ kind: "deploy", label: "Deploy", url: "https://example.com/d" }] });
    expect(host.querySelector("[data-testid=review-code-review]")).toBeNull();
  });

  test("the header names the submitting session, with no warning when it is the launch's root worker", async () => {
    await renderDetail();
    const submitter = host.querySelector("header [data-testid=review-submitter]")!;
    expect(submitter.textContent).toBe("Submitted by session 4c1d9e20");
    expect(submitter.getAttribute("title")).toBe(fixtureDetail.submittedBySession);
    expect(host.querySelector("[data-testid=review-other-session-warning]")).toBeNull();
  });

  test("a revision resubmitted from a different session shows a warning callout", async () => {
    await renderDetail(fixtureDetailOtherSession);
    const header = host.querySelector("header")!;
    expect(header.querySelector("[data-testid=review-submitter]")?.textContent).toBe(
      "Submitted by session e81f03aa (not the launch's root worker session)"
    );
    const warning = header.querySelector("[data-testid=review-other-session-warning]")!;
    expect(warning.getAttribute("role")).toBe("alert");
    expect(warning.textContent).toContain("Resubmitted from a different session than revision 1");
    expect(warning.textContent).toContain("check the change is what your worker made");
  });

  test("no pipeline section when every stage ran", async () => {
    await renderDetail({ ...fixtureDetail, pipeline: { status: "complete", currentStage: "complete", waivers: [] } });
    expect(section("review-pipeline")).toBeNull();
  });

  test("waived stages are listed for the reviewer: stage, who waived it and why", async () => {
    await renderDetail(fixtureDetailWaived);
    const rows = [...host.querySelectorAll("[data-testid=review-pipeline-waiver]")];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Validation");
    expect(rows[0]!.textContent).toContain("waived · not applicable");
    expect(rows[0]!.textContent).toContain("by the worker");
    expect(rows[0]!.textContent).toContain("Only submits a review packet; no code changed.");
    expect(rows[1]!.textContent).toContain("by Persona (owner's Persona)");
  });

  test("a review Persona waived by accepting its wontfix findings shows as such, with the findings it covered", async () => {
    await renderDetail(fixtureDetailWontfixAccepted);
    const rows = [...host.querySelectorAll("[data-testid=review-pipeline-waiver]")];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("waived by Persona (wontfix accepted)");
    expect(rows[0]!.textContent).not.toContain("not applicable");
    expect(rows[0]!.textContent).toContain("Schema drift is tracked in job 5e6f7a8b");
    expect(rows[0]!.querySelector("[data-testid=review-pipeline-wontfix]")!.textContent).toContain("[high] schema drift — r1");
  });

  test("a launch that ran with its pipeline off says so", async () => {
    await renderDetail(fixtureDetailPipelineOff);
    expect(section("review-pipeline-off").textContent).toContain("The delivery pipeline was off for this launch");
    expect(section("review-pipeline-off").textContent).toContain("no stage was checked");
  });

  test("renders the intent and each change area's bullets and file chips", async () => {
    await renderDetail();
    expect(section("review-intent").textContent).toContain("Gives the human_review pipeline stage a place to be decided");
    const areas = [...host.querySelectorAll("[data-testid=change-area]")];
    expect(areas.map((a) => a.querySelector("h4")?.textContent)).toEqual(["Review tab UI", "Live updates", "Shared hook"]);
    expect([...areas[0].querySelectorAll("li")].map((li) => li.textContent)).toContain(
      "Sticky decision bar: approve with an optional comment, request changes with a required one"
    );
    const chips = [...host.querySelectorAll("[data-testid=file-chip]")].map((c) => c.textContent);
    expect(chips).toContain("packages/web/src/hooks/useNarrow.ts");
  });

  test("diff hunks are collapsible details with +/− and @@ lines classified", async () => {
    await renderDetail();
    const hunks = [...host.querySelectorAll("details[data-testid=diff-hunk]")] as HTMLDetailsElement[];
    expect(hunks).toHaveLength(3);
    expect(hunks[0].open).toBe(true);
    expect(hunks[1].open).toBe(false);
    expect(hunks[0].querySelector("summary")?.textContent).toContain("packages/web/src/components/Console.tsx");
    expect(hunks[0].querySelector("summary")?.textContent).toContain("@@ -61,7 +61,7 @@ const VIEWS");
    const kinds = (el: Element, kind: string) =>
      [...el.querySelectorAll(`[data-line=${kind}]`)].map((l) => l.textContent ?? "");
    expect(kinds(hunks[0], "add")).toEqual([
      '+const VIEWS = ["persona", "schedules", "work", "review", "activity", "projects"] as const;',
    ]);
    expect(kinds(hunks[0], "del")).toHaveLength(1);
    expect(kinds(hunks[0], "meta")).toEqual(["@@ -61,7 +61,7 @@"]);
  });

  test("validation samples render as Input → Output blocks with the test counts", async () => {
    await renderDetail();
    const samples = [...host.querySelectorAll("[data-testid=validation-sample]")];
    expect(samples).toHaveLength(2);
    const pres = [...samples[1].querySelectorAll("pre")].map((p) => p.textContent);
    expect(pres).toEqual([
      "POST /api/reviews/rp-7f3a2c/request-changes\n{}",
      '400 Bad Request\n{ "error": "comment is required to request changes" }',
    ]);
    const tests = section("validation-tests").textContent ?? "";
    expect(tests).toContain("412 passed");
    expect(tests).toContain("0 failed");
  });

  test("renders risks and open questions", async () => {
    await renderDetail();
    const risks = section("review-risks").textContent ?? "";
    expect(risks).toContain("Recordings up to 100 MB are kept in the data dir");
    expect(risks).toContain("Should approving also post the comment to the linked pull request?");
  });

  test("images are lazy <img>s on the media URL; the video plays inline with controls", async () => {
    await renderDetail();
    const imgs = [...section("review-media").querySelectorAll("img")];
    expect(imgs.map((i) => i.getAttribute("src"))).toEqual([
      "/api/reviews/rp-7f3a2c/media/m-list",
      "/api/reviews/rp-7f3a2c/media/m-detail",
      "/api/reviews/rp-7f3a2c/media/m-decision",
    ]);
    expect(imgs[0].getAttribute("alt")).toBe(fixtureDetail.media[0].caption);
    expect(imgs[0].getAttribute("loading")).toBe("lazy");
    const video = section("review-media").querySelector("video")!;
    expect(video.getAttribute("src")).toBe("/api/reviews/rp-7f3a2c/media/m-walkthrough");
    expect(video.hasAttribute("controls")).toBe(true);
    expect(video.hasAttribute("playsinline")).toBe(true);
    expect(video.getAttribute("preload")).toBe("metadata");
    expect(section("review-media").textContent).toContain(fixtureDetail.media[3].caption);
  });

  test("a recording-only packet shows one player per recording, in position order, and no image grid", async () => {
    const walkthrough = fixtureDetail.media.find((m) => m.kind === "video")!;
    const media = [
      { ...walkthrough, id: "m-flow", caption: "Interaction flow", position: 1, mime: "video/mp4" as const, url: "/api/reviews/rp-7f3a2c/media/m-flow" },
      { ...walkthrough, id: "m-cold", caption: "Cold load: composer interactive at 212 ms", position: 0, url: "/api/reviews/rp-7f3a2c/media/m-cold" },
    ];
    await renderDetail({ ...fixtureDetail, media });
    const gallery = section("review-media");
    expect(gallery.querySelector("[data-testid=media-images]")).toBeNull();
    const videos = [...gallery.querySelectorAll("video")];
    expect(videos.map((v) => v.getAttribute("src"))).toEqual(["/api/reviews/rp-7f3a2c/media/m-cold", "/api/reviews/rp-7f3a2c/media/m-flow"]);
    expect(videos.every((v) => v.hasAttribute("controls"))).toBe(true);
    expect([...gallery.querySelectorAll("figcaption")].map((f) => f.textContent)).toEqual([
      "Cold load: composer interactive at 212 ms",
      "Interaction flow",
    ]);
  });

  test("tapping an image opens a lightbox that the close button dismisses", async () => {
    await renderDetail();
    const thumb = section("review-media").querySelector("button") as HTMLButtonElement;
    await act(() => thumb.click());
    const box = host.querySelector("[data-testid=media-lightbox]")!;
    expect(box.querySelector("img")?.getAttribute("src")).toBe("/api/reviews/rp-7f3a2c/media/m-list");
    await act(() => (box.querySelector("button[aria-label=Close]") as HTMLButtonElement).click());
    expect(host.querySelector("[data-testid=media-lightbox]")).toBeNull();
  });

  test("only http(s) links render as anchors, opening in a new tab without an opener", async () => {
    await renderDetail({
      ...fixtureDetail,
      links: [
        ...fixtureDetail.links,
        { kind: "other", label: "Sneaky", url: "javascript:alert(1)" },
        { kind: "other", label: "Data", url: "data:text/html,<b>x</b>" },
      ],
    });
    const anchors = [...section("review-links").querySelectorAll("a")];
    expect(anchors.map((a) => a.getAttribute("href"))).toEqual([
      "https://github.com/example/standup/pull/4106",
      "https://ci.example.com/pipelines/standup-dev",
    ]);
    for (const a of anchors) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    }
    expect(host.querySelector('[href^="javascript:"]')).toBeNull();
    expect(host.querySelectorAll("[data-testid=review-link-blocked]")).toHaveLength(2);
    expect(section("review-links").textContent).toContain("Sneaky");
  });

  test("renders the comment history with its decision", async () => {
    await renderDetail();
    const comment = host.querySelector("[data-testid=review-comment]")!;
    expect(comment.textContent).toContain("Revision 1 hid the decision bar");
    expect(comment.textContent).toContain("Changes requested");
    expect(comment.textContent).toContain("30m ago");
  });

  test("the decision bar shows only while the packet is pending", async () => {
    await renderDetail();
    expect(host.querySelector("[data-testid=decision-bar]")).not.toBeNull();
    await act(() => root.unmount());
    host.remove();
    await renderDetail({ ...fixtureDetail, status: "approved", decidedBy: "sam", decidedAt: "2026-10-08T11:58:00.000Z" });
    expect(host.querySelector("[data-testid=decision-bar]")).toBeNull();
    expect(host.querySelector("header")?.textContent).toContain("Approved by sam 2m ago");
  });

  test("questions thread their answers apart from the comments, and a waiting one says who it went to", async () => {
    await renderDetail({ ...fixtureDetail, comments: [...fixtureDetail.comments, ...fixtureQuestions] });
    expect(section("review-comments").querySelectorAll("[data-testid=review-comment]")).toHaveLength(1);
    const threads = [...section("review-questions").querySelectorAll("[data-testid=review-thread]")];
    expect(section("review-questions").querySelector("h3")?.textContent).toBe("Questions (2)");
    expect(threads).toHaveLength(2);
    const [answered, waiting] = threads as [HTMLElement, HTMLElement];
    expect(answered.querySelector("[data-testid=review-question]")?.textContent).toContain("Why does the decision bar stay pinned");
    const reply = answered.querySelector("[data-testid=review-answer]")!;
    expect(reply.textContent).toContain("Worker");
    expect(reply.textContent).toContain("4f2a91c0");
    expect(reply.textContent).toContain("one click away");
    expect(answered.querySelector("[data-testid=review-thread-waiting]")).toBeNull();
    expect(waiting.querySelector("[data-testid=review-thread-waiting]")?.textContent).toContain("Persona is answering");
    // Asking isn't offered without onAsk; following up is offered only on an answered thread.
    expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Follow up")).toBe(false);
  });

  test("once the packet is decided, an unanswered question no longer reads as waiting", async () => {
    await renderDetail({ ...fixtureDetail, status: "approved", decidedBy: "sam", decidedAt: "2026-10-09T09:10:00.000Z", comments: fixtureQuestions });
    expect(section("review-questions").querySelector("[data-testid=review-thread-waiting]")?.textContent).toBe(
      "Not answered before the review was decided."
    );
  });

  test("with asking offered, Follow up on an answered thread targets it in the decision bar", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(() =>
      root.render(
        createElement(ReviewDetail, {
          review: { ...fixtureDetail, comments: fixtureQuestions },
          now: FIXTURE_NOW,
          onDecide: async () => ({}),
          onAsk: async () => ({}),
        })
      )
    );
    const follow = [...host.querySelectorAll("button")].filter((b) => b.textContent === "Follow up");
    expect(follow).toHaveLength(1);
    await act(async () => follow[0]!.click());
    expect(host.querySelector("[data-testid=follow-up-target]")?.textContent).toContain("Why does the decision bar stay pinned");
  });

  test("the thread a question lands in is scrolled into view, centred clear of the decision bar", async () => {
    const scrolled: Array<{ thread: string | undefined; options: unknown }> = [];
    const proto = window.HTMLElement.prototype as unknown as { scrollIntoView: (options?: unknown) => void };
    const original = proto.scrollIntoView;
    proto.scrollIntoView = function (this: HTMLElement, options?: unknown) {
      scrolled.push({ thread: this.dataset.thread, options });
    };
    try {
      host = document.createElement("div");
      document.body.appendChild(host);
      root = createRoot(host);
      const asked: ReviewComment = { ...fixtureQuestions[0]!, id: "q-3", body: "Does the prompt clip long deny reasons?" };
      const followUp: ReviewComment = { ...fixtureQuestions[0]!, id: "q-4", body: "And the refusal?", replyTo: "q-1" };
      let comments = fixtureQuestions;
      const view = () =>
        createElement(ReviewDetail, { review: { ...fixtureDetail, comments }, now: FIXTURE_NOW, onDecide: async () => ({}), onAsk });
      // The server's answer to an Ask replaces the packet shown, as ReviewView does.
      const onAsk = async (_question: string, replyTo?: string) => {
        comments = [...comments, replyTo ? followUp : asked];
        root.render(view());
        return {};
      };
      await act(() => root.render(view()));
      const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement;
      const type = async (value: string) => {
        const el = host.querySelector("textarea") as HTMLTextAreaElement;
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!;
        await act(() => {
          setter.call(el, value);
          el.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
        });
      };

      await type("Does the prompt clip long deny reasons?");
      await act(async () => button("Ask").click());
      expect(scrolled).toEqual([{ thread: "q-3", options: { block: "center", behavior: "smooth" } }]);

      await act(async () => button("Follow up").click());
      await type("And the refusal?");
      await act(async () => button("Ask").click());
      expect(scrolled.map((s) => s.thread)).toEqual(["q-3", "q-1"]);
    } finally {
      proto.scrollIntoView = original;
    }
  });
});
