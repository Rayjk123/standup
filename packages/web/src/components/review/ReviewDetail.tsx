import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  PipelineDisabledReason,
  PipelineWaiver,
  ReviewChangeArea,
  ReviewComment,
  ReviewDecision,
  ReviewLink,
  ReviewPacketDetail,
  ReviewPipelineSummary,
  ReviewValidation,
} from "@standup/shared";
import { reviewPacketCodeReview, waiverLabel } from "@standup/shared";
import { alpha, theme } from "../theme";
import { useNarrow } from "../../hooks/useNarrow";
import { Badge, StatusBadge } from "./StatusBadge";
import { DiffHunk } from "./DiffHunk";
import { MediaGallery } from "./MediaGallery";
import { DecisionBar, type FollowUpTarget } from "./DecisionBar";
import { QuestionThreads, questionThreads } from "./QuestionThreads";
import { ShareToggle } from "../share/ShareToggle";
import { ReviewTunnelList, useReviewTunnels } from "../ReviewTunnelPanel";
import { STATUS_COLORS, STATUS_LABELS, isSafeHref, refLabel, relativeAge, shortSessionId, shortSha } from "./format";

export interface ReviewDetailProps {
  review: ReviewPacketDetail;
  /** Records a decision; the decision bar shows only while the packet is pending and this is given. */
  onDecide?: (decision: ReviewDecision, comment: string) => Promise<{ error?: string }>;
  /** Asks the packet's worker a question; offered beside the decisions while the packet is pending. */
  onAsk?: (question: string, replyTo?: string) => Promise<{ error?: string }>;
  narrow?: boolean;
  now?: Date;
}

const LINK_KIND_LABELS: Record<ReviewLink["kind"], string> = {
  code_review: "Code review",
  deploy: "Deploy",
  stack: "Stack",
  other: "Link",
};

export function Section({ title, children, testId, narrow }: { title: string; children: ReactNode; testId?: string; narrow: boolean }) {
  return (
    <section data-testid={testId} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <h3
        style={{
          margin: 0,
          fontSize: narrow ? 14 : 12,
          fontWeight: 700,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: theme.dim,
        }}
      >
        {title}
      </h3>
      {children}
    </section>
  );
}

function MonoBlock({ label, text, narrow }: { label: string; text: string; narrow: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
      <span style={{ fontSize: narrow ? 13 : 11.5, color: theme.faint, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>
        {label}
      </span>
      <pre
        style={{
          margin: 0,
          padding: "8px 10px",
          borderRadius: 6,
          border: `1px solid ${theme.edge}`,
          background: theme.ground,
          fontFamily: theme.mono,
          fontSize: narrow ? 13.5 : 12.5,
          lineHeight: 1.5,
          overflowX: "auto",
          whiteSpace: "pre",
          color: theme.text,
        }}
      >
        {text}
      </pre>
    </div>
  );
}

export function ValidationSection({ validation, narrow }: { validation: ReviewValidation; narrow: boolean }) {
  const { samples, tests } = validation;
  return (
    <>
      {samples.map((s, i) => (
        <div key={i} data-testid="validation-sample" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: narrow ? 15 : 14, fontWeight: 600 }}>{s.label}</div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: narrow ? "minmax(0, 1fr)" : "minmax(0, 1fr) auto minmax(0, 1fr)",
              alignItems: "center",
              gap: 8,
            }}
          >
            <MonoBlock label="Input" text={s.input} narrow={narrow} />
            <span aria-hidden="true" style={{ color: theme.accent, fontSize: 18, textAlign: "center", paddingTop: narrow ? 0 : 18 }}>
              {narrow ? "↓" : "→"}
            </span>
            <MonoBlock label="Output" text={s.output} narrow={narrow} />
          </div>
        </div>
      ))}
      {tests && (
        <div
          data-testid="validation-tests"
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 10,
            padding: "9px 12px",
            borderRadius: 6,
            background: theme.surface,
            border: `1px solid ${theme.edge}`,
            fontSize: narrow ? 14 : 13.5,
          }}
        >
          <span style={{ flex: "1 1 200px", minWidth: 0 }}>{tests.summary}</span>
          {tests.passed !== undefined && <Badge text={`${tests.passed} passed`} color={theme.done} />}
          {tests.failed !== undefined && (
            <Badge text={`${tests.failed} failed`} color={tests.failed > 0 ? theme.waiting : theme.dim} />
          )}
        </div>
      )}
      {samples.length === 0 && !tests && <div style={{ color: theme.dim }}>No validation recorded.</div>}
    </>
  );
}

const DISABLED_LABELS: Record<PipelineDisabledReason, string> = {
  opt_out: "the launch asked for no pipeline",
  not_coding: "a provisioned launch, which runs without one unless asked",
  no_mcp: "its worker couldn't reach Standup's pipeline tools",
  attempt: "a Best-of-N attempt that wasn't picked",
  other: "your pipeline configuration turns it off",
};

const WAIVER_BY_LABELS: Record<PipelineWaiver["by"], string> = {
  owner: "you",
  worker: "the worker",
  persona: "Persona",
};

/**
 * Whether the packet's pipeline needs the reviewer's eye: it was off for the
 * launch, or stages were waived instead of passed.
 */
export function pipelineNeedsNotice(pipeline: ReviewPipelineSummary | null | undefined): pipeline is ReviewPipelineSummary {
  return !!pipeline && (pipeline.status === "disabled" || pipeline.waivers.length > 0);
}

/** The launch's pipeline as the reviewer must weigh it: off, or the stages waived rather than passed. */
function PipelineNotice({ pipeline, narrow, now }: { pipeline: ReviewPipelineSummary; narrow: boolean; now?: Date }) {
  const reason = pipeline.disabledReason ? DISABLED_LABELS[pipeline.disabledReason] : undefined;
  return (
    <>
      {pipeline.status === "disabled" && (
        <div data-testid="review-pipeline-off" style={{ color: theme.stalled, lineHeight: 1.45 }}>
          The delivery pipeline was off for this launch{reason ? ` — ${reason}` : ""}: no stage was checked.
        </div>
      )}
      {pipeline.waivers.length > 0 && (
        <ul style={{ margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          {pipeline.waivers.map((w, i) => (
            <li
              key={i}
              data-testid="review-pipeline-waiver"
              style={{
                listStyle: "none",
                padding: "9px 12px",
                borderRadius: 6,
                background: alpha(theme.stalled, 0x14),
                border: `1px solid ${alpha(theme.stalled, 0x55)}`,
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                <span style={{ fontWeight: 600 }}>{w.title}</span>
                <Badge text={waiverLabel(w)} color={theme.stalled} />
                <span style={{ fontSize: narrow ? 13.5 : 12.5, color: theme.dim }}>
                  by {WAIVER_BY_LABELS[w.by]}
                  {w.by === "persona" && w.actor ? ` (${w.actor})` : ""} <span title={w.at}>{relativeAge(w.at, now)}</span>
                </span>
              </div>
              <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.45, overflowWrap: "anywhere" }}>{w.reason}</div>
              {w.wontfixFindings && w.wontfixFindings.length > 0 && (
                <div data-testid="review-pipeline-wontfix" style={{ fontSize: narrow ? 13.5 : 12.5, color: theme.dim }}>
                  Wontfix findings accepted:
                  <BulletList
                    items={w.wontfixFindings.map(
                      (f) => `[${f.severity}] ${f.title}${f.reviewer ? ` — ${f.reviewer}` : ""}${f.note ? ` (worker's note: ${f.note})` : ""}`
                    )}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function BulletList({ items, color }: { items: string[]; color?: string }) {
  return (
    <ul style={{ margin: 0, paddingLeft: 20, display: "flex", flexDirection: "column", gap: 4, color }}>
      {items.map((item, i) => (
        <li key={i} style={{ lineHeight: 1.45, overflowWrap: "anywhere" }}>
          {item}
        </li>
      ))}
    </ul>
  );
}

/** The packet's change areas: bullets, file chips and diff hunks (the first one open). */
export function ChangeAreas({ changes, narrow }: { changes: ReviewChangeArea[]; narrow: boolean }) {
  const firstHunkArea = changes.findIndex((c) => (c.hunks?.length ?? 0) > 0);
  return (
    <>
      {changes.map((change, i) => (
        <div key={i} data-testid="change-area" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <h4 style={{ margin: 0, fontSize: narrow ? 16 : 15 }}>{change.area}</h4>
          <BulletList items={change.bullets} />
          {change.files && change.files.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {change.files.map((f) => (
                <span
                  key={f}
                  data-testid="file-chip"
                  style={{
                    fontFamily: theme.mono,
                    fontSize: narrow ? 13 : 12,
                    padding: "2px 8px",
                    borderRadius: 10,
                    background: theme.raised,
                    color: theme.dim,
                    overflowWrap: "anywhere",
                    maxWidth: "100%",
                  }}
                >
                  {f}
                </span>
              ))}
            </div>
          )}
          {change.hunks?.map((hunk, j) => (
            <DiffHunk key={j} hunk={hunk} narrow={narrow} defaultOpen={i === firstHunkArea && j === 0} />
          ))}
        </div>
      ))}
    </>
  );
}

function LinkRow({ link, narrow }: { link: ReviewLink; narrow: boolean }) {
  const kind = <Badge text={LINK_KIND_LABELS[link.kind] ?? "Link"} color={theme.running} />;
  const label = link.label || link.url;
  const row = {
    display: "flex",
    alignItems: "center",
    gap: 10,
    minHeight: narrow ? 44 : 32,
    padding: "4px 0",
    overflowWrap: "anywhere" as const,
  };
  if (!isSafeHref(link.url)) {
    return (
      <li data-testid="review-link-blocked" style={row}>
        {kind}
        <span style={{ color: theme.dim }} title="Only http(s) links open from a review">
          {label} <span style={{ color: theme.faint }}>(link not opened: {link.url})</span>
        </span>
      </li>
    );
  }
  return (
    <li style={row}>
      {kind}
      <a href={link.url} target="_blank" rel="noopener noreferrer" style={{ color: theme.running, minWidth: 0 }}>
        {label}
      </a>
    </li>
  );
}

function CommentItem({ comment, now, narrow }: { comment: ReviewComment; now?: Date; narrow: boolean }) {
  return (
    <li
      data-testid="review-comment"
      style={{
        listStyle: "none",
        padding: "10px 12px",
        borderRadius: 6,
        background: theme.surface,
        border: `1px solid ${theme.edge}`,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, fontSize: narrow ? 14 : 12.5, color: theme.dim }}>
        <span style={{ color: theme.text, fontWeight: 600 }}>{comment.author}</span>
        {comment.decision && <Badge text={STATUS_LABELS[comment.decision]} color={STATUS_COLORS[comment.decision]} />}
        <span title={comment.createdAt}>{relativeAge(comment.createdAt, now)}</span>
      </div>
      <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.45, overflowWrap: "anywhere" }}>{comment.body}</div>
    </li>
  );
}

/**
 * Everything a reviewer needs to sign off on one packet: what it is for, what
 * changed (with the diff hunks the writer picked), how it was validated, open
 * risks, media and links, the comment history and — while it is pending — the
 * decision bar.
 */
export function ReviewDetail({ review, onDecide, onAsk, narrow: narrowProp, now }: ReviewDetailProps) {
  const narrowQuery = useNarrow();
  const narrow = narrowProp ?? narrowQuery;
  const [followUp, setFollowUp] = useState<FollowUpTarget | null>(null);
  const remarks = review.comments.filter((c) => c.kind === "comment");
  const threads = questionThreads(review.comments);
  const pending = review.status === "pending";
  const rootRef = useRef<HTMLDivElement>(null);
  // The thread an Ask just landed in: its opening question's id, or "" for a new thread.
  const [landed, setLanded] = useState<string | null>(null);

  // Brings the asked thread into view, centred so the sticky decision bar doesn't cover it.
  useEffect(() => {
    if (landed === null) return;
    setLanded(null);
    const cards = [...(rootRef.current?.querySelectorAll<HTMLElement>("[data-testid=review-thread]") ?? [])];
    const card = landed ? cards.find((c) => c.dataset.thread === landed) : cards[cards.length - 1];
    const still = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    card?.scrollIntoView?.({ block: "center", behavior: still ? "auto" : "smooth" });
  }, [landed]);

  const ask =
    onAsk &&
    (async (question: string, replyTo?: string) => {
      const result = await onAsk(question, replyTo);
      if (!result.error) setLanded(replyTo ?? "");
      return result;
    });
  const ref = refLabel(review.branch, review.commitSha);
  const ids: Array<[string, string | null]> = [
    ["job", review.jobId],
    ["session", review.sessionId],
    ["launch", review.launchId],
  ];
  const hasRisks = review.risks.risks.length > 0 || review.risks.questions.length > 0;
  // The collector reads the review under the project's code-review adapter;
  // a detail without that read falls back to the default link format.
  const codeReview = review.codeReview !== undefined ? review.codeReview : reviewPacketCodeReview(review.links);
  const tunnels = useReviewTunnels(review.launchId ? [review.launchId] : []);

  return (
    <div ref={rootRef} style={{ display: "flex", flexDirection: "column", minHeight: "100%" }}>
      <article
        data-testid="review-detail"
        style={{
          flex: 1,
          width: "100%",
          maxWidth: 880,
          margin: "0 auto",
          boxSizing: "border-box",
          padding: narrow ? "14px 14px 24px" : "20px 24px 32px",
          display: "flex",
          flexDirection: "column",
          gap: 22,
          fontSize: narrow ? 15 : 14,
          color: theme.text,
        }}
      >
        <header style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
            <StatusBadge status={review.status} />
            {review.revision > 0 && <span style={{ fontSize: narrow ? 14 : 12.5, color: theme.dim }}>Revision {review.revision}</span>}
          </div>
          <h2 style={{ margin: 0, fontSize: narrow ? 20 : 21, lineHeight: 1.3, overflowWrap: "anywhere" }}>{review.title}</h2>
          {codeReview && (
            <a
              data-testid="review-code-review"
              href={codeReview.url}
              aria-label={`Code review ${codeReview.id} (opens in a new tab)`}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                alignSelf: "flex-start",
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                minHeight: narrow ? 44 : 30,
                padding: "4px 12px",
                borderRadius: 6,
                background: alpha(theme.running, 0x1f),
                border: `1px solid ${alpha(theme.running, 0x66)}`,
                color: theme.running,
                fontSize: narrow ? 15 : 14,
                fontWeight: 600,
                textDecoration: "none",
                overflowWrap: "anywhere",
              }}
            >
              <span style={{ fontSize: narrow ? 13 : 12, color: theme.dim, fontWeight: 500 }}>Code review</span>
              <span style={{ fontFamily: theme.mono }}>{codeReview.id}</span>
              <span aria-hidden="true">↗</span>
            </a>
          )}
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              columnGap: 14,
              rowGap: 4,
              fontSize: narrow ? 14 : 12.5,
              color: theme.dim,
            }}
          >
            {review.projectId && <span style={{ color: theme.text }}>{review.projectId}</span>}
            {ref && (
              <span style={{ fontFamily: theme.mono, overflowWrap: "anywhere" }} title={review.commitSha ?? undefined}>
                {ref}
              </span>
            )}
            {review.baseSha && <span style={{ fontFamily: theme.mono }}>base {shortSha(review.baseSha)}</span>}
            {review.submittedBySession && (
              <span data-testid="review-submitter" title={review.submittedBySession}>
                Submitted by session <span style={{ fontFamily: theme.mono }}>{shortSessionId(review.submittedBySession)}</span>
                {!review.submittedByRootSession && (
                  <span style={{ color: theme.stalled }}> (not the launch's root worker session)</span>
                )}
              </span>
            )}
            <span>by {review.owner}</span>
            <span title={review.updatedAt}>{relativeAge(review.updatedAt, now)}</span>
          </div>
          {ids.some(([, v]) => v) && (
            <div style={{ display: "flex", flexWrap: "wrap", columnGap: 14, rowGap: 4, fontSize: narrow ? 13 : 12, color: theme.faint, fontFamily: theme.mono }}>
              {ids
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <span key={k} style={{ overflowWrap: "anywhere" }}>
                    {k} {v}
                  </span>
                ))}
            </div>
          )}
          {review.resubmittedFromOtherSession && (
            <div
              role="alert"
              data-testid="review-other-session-warning"
              style={{
                padding: "9px 12px",
                borderRadius: 6,
                background: alpha(theme.stalled, 0x1f),
                border: `1px solid ${alpha(theme.stalled, 0x66)}`,
                color: theme.stalled,
                fontSize: narrow ? 14 : 13,
                fontWeight: 600,
                lineHeight: 1.45,
              }}
            >
              Resubmitted from a different session than revision {Math.max(1, review.revision - 1)} — check the change is what your
              worker made.
            </div>
          )}
          {review.decidedBy && review.decidedAt && (
            <div style={{ fontSize: narrow ? 14 : 12.5, color: STATUS_COLORS[review.status] }}>
              {STATUS_LABELS[review.status]} by {review.decidedBy} {relativeAge(review.decidedAt, now)}
            </div>
          )}
          {review.share && review.status !== "draft" && review.status !== "superseded" && <ShareToggle resourceType="review" resourceId={review.id} share={review.share} narrow={narrow} />}
        </header>

        <Section title="Intent" testId="review-intent" narrow={narrow}>
          <p style={{ margin: 0, lineHeight: 1.55, fontSize: narrow ? 16 : 15 }}>{review.intent}</p>
        </Section>

        {tunnels.tunnels.length > 0 && (
          <Section title="Try it" testId="review-tunnel" narrow={narrow}>
            <ReviewTunnelList tunnels={tunnels.tunnels} onChanged={tunnels.reload} />
          </Section>
        )}

        <Section title="What changed" testId="review-changes" narrow={narrow}>
          <ChangeAreas changes={review.changes} narrow={narrow} />
        </Section>

        <Section title="Validation" testId="review-validation" narrow={narrow}>
          <ValidationSection validation={review.validation} narrow={narrow} />
        </Section>

        {pipelineNeedsNotice(review.pipeline) && (
          <Section title="Delivery pipeline" testId="review-pipeline" narrow={narrow}>
            <PipelineNotice pipeline={review.pipeline} narrow={narrow} now={now} />
          </Section>
        )}

        <Section title="Risks & open questions" testId="review-risks" narrow={narrow}>
          {!hasRisks && <div style={{ color: theme.dim }}>None noted.</div>}
          {review.risks.risks.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontWeight: 600, color: theme.stalled }}>Risks</span>
              <BulletList items={review.risks.risks} />
            </div>
          )}
          {review.risks.questions.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontWeight: 600, color: theme.expert }}>Open questions</span>
              <BulletList items={review.risks.questions} />
            </div>
          )}
        </Section>

        {review.media.length > 0 && (
          <Section title={`Media (${review.media.length})`} testId="review-media" narrow={narrow}>
            <MediaGallery media={review.media} narrow={narrow} />
          </Section>
        )}

        {review.links.length > 0 && (
          <Section title="Links" testId="review-links" narrow={narrow}>
            <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
              {review.links.map((link, i) => (
                <LinkRow key={i} link={link} narrow={narrow} />
              ))}
            </ul>
          </Section>
        )}

        {remarks.length > 0 && (
          <Section title={`Comments (${remarks.length})`} testId="review-comments" narrow={narrow}>
            <ul style={{ margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
              {remarks.map((c) => (
                <CommentItem key={c.id} comment={c} now={now} narrow={narrow} />
              ))}
            </ul>
          </Section>
        )}

        {threads.length > 0 && (
          <Section title={`Questions (${threads.length})`} testId="review-questions" narrow={narrow}>
            <QuestionThreads
              threads={threads}
              pending={pending}
              now={now}
              narrow={narrow}
              onFollowUp={pending && onAsk ? setFollowUp : undefined}
            />
          </Section>
        )}
      </article>
      {pending && onDecide && (
        <div style={{ position: "sticky", bottom: 0, zIndex: 5 }}>
          <div style={{ maxWidth: 880, margin: "0 auto" }}>
            <DecisionBar onDecide={onDecide} onAsk={ask} followUp={followUp} onClearFollowUp={() => setFollowUp(null)} narrow={narrow} />
          </div>
        </div>
      )}
    </div>
  );
}
