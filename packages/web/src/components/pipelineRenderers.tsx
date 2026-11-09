import type { ComponentType, CSSProperties, ReactNode } from "react";
import type {
  FloorAskRecord,
  PipelineReviewFinding,
  PipelineRun,
  PipelineStageAttempt,
  PipelineStageDef,
} from "@standup/shared";
import { CODE_REVIEW_STAGE_KIND } from "@standup/shared";
import { alpha, theme } from "./theme";
import { safeHref } from "../lib/safeHref";

// ============================================================================
// Evidence renderers for pipeline stage attempts, keyed by stage kind.
//
// A stage kind plugs into the pipeline in three places: the shared kind spec
// (registerPipelineStageKind in @standup/shared — evidence shape, outcome,
// description), the collector's stage runner (registerPipelineStageRunner —
// server-side evidence preparation), and a renderer here
// (registerStageEvidenceRenderer) that draws an attempt's evidence in the
// console. A kind with no renderer shows its evidence as formatted JSON.
// ============================================================================

export interface StageEvidenceRendererProps {
  /** The attempt's evidence; always a plain object (anything else renders as JSON). */
  evidence: Record<string, unknown>;
  run: PipelineRun;
  stage: PipelineStageDef;
  attempt: PipelineStageAttempt;
}

export type StageEvidenceRenderer = ComponentType<StageEvidenceRendererProps>;

const renderers = new Map<string, StageEvidenceRenderer>();

/** Draw evidence of stages of `kind` with `Component`, replacing any earlier renderer for it. */
export function registerStageEvidenceRenderer(kind: string, Component: StageEvidenceRenderer): void {
  renderers.set(kind, Component);
}

/** The renderer registered for `kind`, or undefined. */
export function getStageEvidenceRenderer(kind: string): StageEvidenceRenderer | undefined {
  return renderers.get(kind);
}

/** One attempt's evidence, drawn by its stage kind's renderer (JSON when the kind has none). */
export function StageEvidence({ run, stage, attempt }: { run: PipelineRun; stage: PipelineStageDef; attempt: PipelineStageAttempt }) {
  const ev = attempt.evidence;
  const Renderer = getStageEvidenceRenderer(String(stage.kind));
  if (!isRecord(ev) || !Renderer) return <RawEvidence value={ev} />;
  return <Renderer evidence={ev} run={run} stage={stage} attempt={attempt} />;
}

/** The URL the collector serves an attempt's `index`th screenshot from. */
export function screenshotUrl(runId: string, attemptId: string, index: number): string {
  return `/api/pipeline/runs/${encodeURIComponent(runId)}/screenshots/${encodeURIComponent(attemptId)}/${index}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function list<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function CodingEvidenceView({ evidence: ev }: StageEvidenceRendererProps) {
  const commits = list<string>(ev.commits);
  const files = list<string>(ev.changedFiles);
  return (
    <div style={evidenceBox}>
      {str(ev.summary) && <div style={{ fontSize: 12, color: theme.text }}>{str(ev.summary)}</div>}
      {commits.length > 0 && (
        <KeyValue label="Commits">
          <span style={mono}>{commits.join(", ")}</span>
        </KeyValue>
      )}
      {files.length > 0 && (
        <KeyValue label={`Changed files · ${files.length}`}>
          <ul style={plainList}>
            {files.map((f) => (
              <li key={f} style={mono}>
                {f}
              </li>
            ))}
          </ul>
        </KeyValue>
      )}
    </div>
  );
}

function ValidationEvidenceView({ evidence: ev }: StageEvidenceRendererProps) {
  const commands = list<{ command?: unknown; exitCode?: unknown; summary?: unknown }>(ev.commands);
  const criterion = isRecord(ev.criterion) ? ev.criterion : undefined;
  return (
    <div style={evidenceBox}>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <tbody>
          {commands.map((c, i) => {
            const ok = c.exitCode === 0;
            return (
              <tr key={i} data-command-exit={String(c.exitCode)}>
                <td style={{ padding: "2px 8px 2px 0", verticalAlign: "top", whiteSpace: "nowrap" }}>
                  <span style={{ ...mono, fontWeight: 700, color: ok ? theme.checkpoint : theme.waiting }}>exit {String(c.exitCode)}</span>
                </td>
                <td style={{ padding: "2px 0", verticalAlign: "top" }}>
                  <div style={{ ...mono, color: theme.text }}>{String(c.command ?? "")}</div>
                  {str(c.summary) && <div style={{ fontSize: 11.5, color: theme.dim }}>{str(c.summary)}</div>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {criterion && (
        <KeyValue label="Acceptance criterion">
          <span style={{ ...mono, color: criterion.met ? theme.checkpoint : theme.waiting }}>
            {criterion.met ? "met" : "not met"}
          </span>{" "}
          <span style={mono}>{String(criterion.command ?? "")}</span>
          {str(criterion.output) && <div style={{ fontSize: 11.5, color: theme.dim }}>{str(criterion.output)}</div>}
        </KeyValue>
      )}
    </div>
  );
}

const SEVERITY_COLOR: Record<PipelineReviewFinding["severity"], string> = {
  high: theme.waiting,
  medium: theme.stalled,
  low: theme.dim,
};
const SEVERITIES: Array<PipelineReviewFinding["severity"]> = ["high", "medium", "low"];
const SEVERITY_LABEL: Record<PipelineReviewFinding["severity"], string> = { high: "High", medium: "Medium", low: "Low" };

function ReviewEvidenceView({ evidence: ev }: StageEvidenceRendererProps) {
  const reviewers = list<{ name?: unknown; findings?: unknown }>(ev.reviewers);
  const findings = reviewers.flatMap((r) => list<PipelineReviewFinding>(r.findings));
  return (
    <div style={evidenceBox}>
      <div data-testid="review-counts" style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 11.5 }}>
        {SEVERITIES.map((sev) => {
          const all = findings.filter((f) => f.severity === sev);
          const open = all.filter((f) => f.status === "open").length;
          return (
            <span key={sev} style={{ color: SEVERITY_COLOR[sev] }}>
              <b>{SEVERITY_LABEL[sev]}</b> {all.length}
              {open > 0 ? ` (${open} open)` : ""}
            </span>
          );
        })}
        <span style={{ color: theme.faint }}>
          {reviewers.length} reviewer{reviewers.length === 1 ? "" : "s"}
        </span>
      </div>
      {reviewers.map((r, i) => {
        const fs = list<PipelineReviewFinding>(r.findings);
        return (
          <div key={i}>
            <div style={{ fontSize: 11.5, fontWeight: 600, color: theme.text }}>{String(r.name ?? `reviewer ${i + 1}`)}</div>
            {fs.length === 0 ? (
              <div style={{ fontSize: 11.5, color: theme.faint }}>No findings</div>
            ) : (
              <ul style={plainList}>
                {fs.map((f, j) => (
                  <li key={j} style={{ fontSize: 12, color: theme.text, display: "flex", gap: 6, alignItems: "baseline" }}>
                    <Tag color={SEVERITY_COLOR[f.severity] ?? theme.dim}>{SEVERITY_LABEL[f.severity] ?? String(f.severity)}</Tag>
                    <span
                      style={{
                        flex: 1,
                        textDecoration: f.status === "fixed" ? "line-through" : undefined,
                        color: f.status === "open" ? theme.text : theme.dim,
                      }}
                    >
                      {f.title}
                    </span>
                    <span style={{ ...mono, color: f.status === "fixed" ? theme.faint : f.status === "open" ? theme.waiting : theme.stalled }}>
                      {f.status}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

function DeployEvidenceView({ evidence: ev }: StageEvidenceRendererProps) {
  const stacks = list<string>(ev.stacks);
  const samples = list<LiveSample>(ev.liveSamples);
  return (
    <div style={evidenceBox}>
      <KeyValue label="Account">
        <span style={mono}>
          {String(ev.account ?? "")}
          {str(ev.region) ? ` · ${str(ev.region)}` : ""}
        </span>
      </KeyValue>
      {stacks.length > 0 && (
        <KeyValue label={`Stacks · ${stacks.length}`}>
          <ul style={plainList}>
            {stacks.map((s) => (
              <li key={s} style={mono}>
                {s}
              </li>
            ))}
          </ul>
        </KeyValue>
      )}
      <LiveSamples samples={samples} />
      <FloorAsks asks={list<FloorAskRecord>(ev.floorAsks)} />
    </div>
  );
}

type LiveSample = { request?: unknown; response?: unknown; ok?: unknown };

/** Each live request and its response, marked ok or fail. */
function LiveSamples({ samples }: { samples: LiveSample[] }) {
  if (samples.length === 0) return null;
  return (
    <KeyValue label="Live samples">
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {samples.map((s, i) => (
          <div key={i} data-live-sample={s.ok === true ? "ok" : "fail"} style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
            <span style={{ ...mono, fontWeight: 700, color: s.ok === true ? theme.checkpoint : theme.waiting }}>
              {s.ok === true ? "ok" : "fail"}
            </span>
            <div style={{ minWidth: 0 }}>
              <div style={{ ...mono, color: theme.text, overflowWrap: "anywhere" }}>{String(s.request ?? "")}</div>
              <div style={{ ...mono, color: theme.dim, overflowWrap: "anywhere" }}>{String(s.response ?? "")}</div>
            </div>
          </div>
        ))}
      </div>
    </KeyValue>
  );
}

/** The isolated instance the change ran on, how it was kept apart from the shared one, and its live samples. */
function LiveCheckEvidenceView({ evidence: ev }: StageEvidenceRendererProps) {
  const isolation = isRecord(ev.isolation) ? ev.isolation : undefined;
  const ports = list<unknown>(isolation?.ports).filter((p): p is number => typeof p === "number");
  const socket = str(isolation?.tmuxSocket);
  return (
    <div style={evidenceBox}>
      <KeyValue label="Environment">
        <span style={mono}>{String(ev.environment ?? "")}</span>
      </KeyValue>
      {(ports.length > 0 || socket) && (
        <KeyValue label="Isolation">
          <div data-testid="live-check-isolation" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {ports.length > 0 && <span style={mono}>ports {ports.map((p) => `:${p}`).join(", ")}</span>}
            {socket && <span style={mono}>tmux -S {socket}</span>}
          </div>
        </KeyValue>
      )}
      <LiveSamples samples={list<LiveSample>(ev.liveSamples)} />
    </div>
  );
}

/** Inline screenshots are capped at this height; clicking one opens it full size in a new tab. */
export const SCREENSHOT_MAX_HEIGHT = 320;

function ScreenshotEvidenceView({ evidence: ev, run, attempt }: StageEvidenceRendererProps) {
  const shots = list<{ path?: unknown; caption?: unknown }>(ev.screenshots);
  return (
    <div style={{ ...evidenceBox, gap: 10 }}>
      {shots.map((s, i) => {
        const src = screenshotUrl(run.id, attempt.id, i);
        const caption = str(s.caption) ?? `Screenshot ${i + 1}`;
        return (
          <figure key={i} style={{ margin: 0, display: "flex", flexDirection: "column", gap: 4 }}>
            <a href={src} target="_blank" rel="noreferrer" title="Open full size in a new tab" style={{ alignSelf: "flex-start", maxWidth: "100%" }}>
              <img
                src={src}
                alt={caption}
                loading="lazy"
                style={{
                  maxWidth: "100%",
                  maxHeight: SCREENSHOT_MAX_HEIGHT,
                  objectFit: "contain",
                  borderRadius: 5,
                  border: `1px solid ${theme.edge}`,
                  display: "block",
                  cursor: "zoom-in",
                }}
              />
            </a>
            <figcaption style={{ fontSize: 11.5, color: theme.dim }}>
              {caption}
              {str(s.path) && <span style={{ ...mono, color: theme.faint, marginLeft: 6 }}>{str(s.path)}</span>}
            </figcaption>
          </figure>
        );
      })}
    </div>
  );
}

function CodeReviewEvidenceView({ evidence: ev }: StageEvidenceRendererProps) {
  const href = safeHref(str(ev.url));
  const label = str(ev.reviewId) ?? str(ev.url) ?? "";
  return (
    <div style={evidenceBox}>
      <KeyValue label="Code review">
        {href ? (
          <a href={href} target="_blank" rel="noreferrer" style={{ ...mono, color: theme.running }}>
            {label}
          </a>
        ) : (
          <span style={mono}>{label}</span>
        )}
      </KeyValue>
      <KeyValue label="Issue">
        <span style={mono}>{String(ev.issueId ?? "")}</span>
      </KeyValue>
      <FloorAsks asks={list<FloorAskRecord>(ev.floorAsks)} />
    </div>
  );
}

function FloorAsks({ asks }: { asks: FloorAskRecord[] }) {
  if (asks.length === 0) return null;
  return (
    <KeyValue label={`Floor asks · ${asks.length}`}>
      <ul style={plainList}>
        {asks.map((a) => (
          <li key={a.askId} style={{ fontSize: 12, color: theme.text }}>
            <span style={{ ...mono, color: theme.faint }}>{a.gate}</span> {a.question}
            <span style={{ ...mono, color: a.answer ? theme.checkpoint : theme.stalled, marginLeft: 6 }}>
              {a.answer ?? a.status}
            </span>
          </li>
        ))}
      </ul>
    </KeyValue>
  );
}

/** Evidence as formatted JSON: the view for kinds with no renderer and for non-object evidence. */
export function RawEvidence({ value }: { value: unknown }) {
  return (
    <pre data-testid="pipeline-raw-evidence" style={{ ...mono, margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: theme.dim }}>
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function Tag({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span
      style={{
        fontFamily: theme.mono,
        fontSize: 9.5,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        padding: "0 5px",
        borderRadius: 3,
        color,
        background: alpha(color, 0x1f),
        flexShrink: 0,
      }}
    >
      {children}
    </span>
  );
}

export function KeyValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div style={kvLabel}>{label}</div>
      <div style={{ fontSize: 12, color: theme.text }}>{children}</div>
    </div>
  );
}

const mono: CSSProperties = { fontFamily: theme.mono, fontSize: 11.5 };

const plainList: CSSProperties = { margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 2 };

const evidenceBox: CSSProperties = { display: "flex", flexDirection: "column", gap: 6 };

const kvLabel: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  color: theme.faint,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  marginBottom: 2,
};

registerStageEvidenceRenderer("coding", CodingEvidenceView);
registerStageEvidenceRenderer("validation", ValidationEvidenceView);
registerStageEvidenceRenderer("review", ReviewEvidenceView);
registerStageEvidenceRenderer("deploy", DeployEvidenceView);
registerStageEvidenceRenderer("live_check", LiveCheckEvidenceView);
registerStageEvidenceRenderer("screenshot", ScreenshotEvidenceView);
registerStageEvidenceRenderer(CODE_REVIEW_STAGE_KIND, CodeReviewEvidenceView);
