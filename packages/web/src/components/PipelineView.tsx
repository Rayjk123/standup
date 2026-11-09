import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  currentEpochAttempts,
  describeStage,
  loopBudget,
  passedEdge,
  runIsLive,
  stageStates,
  wontfixAcceptedFindings,
} from "@standup/shared";
import type {
  PipelineDefinition,
  PipelinePark,
  PipelineRun,
  PipelineStageAttempt,
  PipelineStageDef,
  PipelineStageState,
} from "@standup/shared";
import { alpha, theme } from "./theme";
import { StageEvidence, Tag } from "./pipelineRenderers";

export { screenshotUrl } from "./pipelineRenderers";

// ============================================================================
// The delivery pipeline of one launch: a left-to-right row of stage chips with
// loop arcs underneath, a status banner, and the selected stage's attempts with
// their evidence. PipelineGraph is the row alone, shared with the settings
// preview; PipelineStrip is the banner and row without the stage detail.
// ============================================================================

/** Chip width before the row has been measured (and in layouts that never measure). */
const DEFAULT_CHIP_W = 118;
const MIN_CHIP_W = 96;
const MAX_CHIP_W = 140;
const CHIP_GAP = 18;
const CHIP_H = 52;
/** Depth of the shallowest loop arc, and the extra depth of each arc below it. */
const ARC_BASE_DEPTH = 18;
const ARC_STEP = 16;

/**
 * Stage ids in display order: start, then each stage's passed edge in turn,
 * then any stage that walk didn't reach (in definition order).
 */
export function stageOrder(def: PipelineDefinition): string[] {
  const byId = new Map(def.stages.map((s) => [s.id, s]));
  const order: string[] = [];
  const seen = new Set<string>();
  let cur: PipelineStageDef | undefined = byId.get("start") ?? def.stages[0];
  while (cur && !seen.has(cur.id)) {
    order.push(cur.id);
    seen.add(cur.id);
    const edge = passedEdge(cur);
    cur = edge ? byId.get(edge.to) : undefined;
  }
  for (const s of def.stages) if (!seen.has(s.id)) order.push(s.id);
  return order;
}

/**
 * Chip width for `count` chips in `available` pixels: the row shares the width
 * evenly, clamped to [MIN_CHIP_W, MAX_CHIP_W]; the default before measuring.
 */
export function chipWidth(available: number, count: number): number {
  if (available <= 0 || count <= 0) return DEFAULT_CHIP_W;
  const even = Math.floor((available - CHIP_GAP * (count - 1)) / count);
  return Math.max(MIN_CHIP_W, Math.min(MAX_CHIP_W, even));
}

const STATE_COLOR: Record<PipelineStageState, string> = {
  current: theme.running,
  passed: theme.checkpoint,
  failed: theme.waiting,
  skipped: theme.faint,
  waived: theme.expert,
  pending: theme.dim,
};

const STATE_LABEL: Record<PipelineStageState, string> = {
  current: "current",
  passed: "passed",
  failed: "failed",
  skipped: "skipped",
  waived: "waived",
  pending: "pending",
};

/** A loop arc's label: "used/max" for a run, or just the bound for a preview. */
export interface LoopArc {
  from: string;
  to: string;
  label: string;
  /** How close the loop is to its bound, 0..1, for its color. */
  pressure: number;
}

/**
 * Each arc's depth below the row: arcs are ranked by span (shortest
 * shallowest, ties by source position) and each rank sits one step deeper, so
 * arcs that share an end never overlap and every label has its own apex.
 */
export function arcDepths(arcs: LoopArc[], index: Map<string, number>): Map<LoopArc, number> {
  const span = (l: LoopArc) => Math.abs((index.get(l.from) ?? 0) - (index.get(l.to) ?? 0));
  const ranked = [...arcs].sort((a, b) => span(a) - span(b) || (index.get(a.from) ?? 0) - (index.get(b.from) ?? 0));
  return new Map(ranked.map((l, k) => [l, ARC_BASE_DEPTH + k * ARC_STEP]));
}

/** The measured content width of `ref`'s element (0 until measured), tracking resizes. */
function useElementWidth(ref: { current: HTMLElement | null }): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setWidth(el.clientWidth);
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/**
 * The stage row: one chip per stage in `stageOrder`, colored by `states`
 * (every stage pending when absent), with an SVG arc under the row for each
 * loop edge. Chips share the available width (wrapping long titles to two
 * lines); when even the narrowest chips overflow, the row scrolls and shows a
 * "more" control at its edge. `onSelect` makes chips clickable. `surface` is
 * the background the row sits on, used to halo the arc labels.
 */
export function PipelineGraph({
  definition,
  states,
  loops,
  selected,
  onSelect,
  needsOwner = false,
  surface = theme.ground,
}: {
  definition: PipelineDefinition;
  states?: Record<string, { state: PipelineStageState; attempts: number }>;
  loops: LoopArc[];
  selected?: string;
  onSelect?: (stageId: string) => void;
  /** The owner has something to do at the current stage; its chip says so. */
  needsOwner?: boolean;
  surface?: string;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const available = useElementWidth(scrollRef);
  const order = stageOrder(definition);
  const chipW = chipWidth(available, order.length);
  const byId = new Map(definition.stages.map((s) => [s.id, s]));
  const index = new Map(order.map((id, i) => [id, i]));
  const center = (id: string) => (index.get(id) ?? 0) * (chipW + CHIP_GAP) + chipW / 2;
  const width = order.length * (chipW + CHIP_GAP) - CHIP_GAP;
  const arcs = loops.filter((l) => index.has(l.from) && index.has(l.to));
  const depths = arcDepths(arcs, index);
  const svgHeight = arcs.length > 0 ? Math.max(...depths.values()) + 12 : 0;
  const currentId = order.find((id) => states?.[id]?.state === "current");

  const [more, setMore] = useState({ left: false, right: false });
  const measureOverflow = () => {
    const el = scrollRef.current;
    if (!el) return;
    const overflows = el.scrollWidth > el.clientWidth + 1;
    const left = overflows && el.scrollLeft > 1;
    const right = overflows && el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setMore((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  };
  const scrollStep = (dir: 1 | -1) => {
    const el = scrollRef.current;
    if (el) el.scrollBy({ left: dir * Math.max(120, el.clientWidth * 0.7), behavior: "smooth" });
  };
  const moreButton = (dir: 1 | -1): CSSProperties => ({
    position: "absolute",
    [dir === 1 ? "right" : "left"]: 0,
    top: 0,
    height: CHIP_H,
    width: 34,
    border: "none",
    borderRadius: dir === 1 ? "0 7px 7px 0" : "7px 0 0 7px",
    background: `linear-gradient(to ${dir === 1 ? "right" : "left"}, ${alpha(surface, 0)}, ${surface} 55%)`,
    color: theme.text,
    fontSize: 16,
    fontWeight: 700,
    cursor: "pointer",
    textAlign: dir === 1 ? "right" : "left",
    padding: dir === 1 ? "0 6px 0 0" : "0 0 0 6px",
  });

  // Keep the current stage in view when the row scrolls.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && currentId !== undefined && el.scrollWidth > el.clientWidth) {
      const target = (index.get(currentId) ?? 0) * (chipW + CHIP_GAP) - (el.clientWidth - chipW) / 2;
      el.scrollLeft = Math.max(0, target);
    }
    measureOverflow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, chipW, available]);

  return (
    <div style={{ position: "relative" }}>
      <div ref={scrollRef} onScroll={measureOverflow} style={{ overflowX: "auto", paddingBottom: 2 }}>
        <div style={{ width, position: "relative" }}>
          <div style={{ display: "flex", gap: CHIP_GAP, position: "relative" }}>
            {order.map((id, i) => {
              const stage = byId.get(id)!;
              const state = states?.[id]?.state ?? "pending";
              const count = states?.[id]?.attempts ?? 0;
              const color = state === "current" && needsOwner ? theme.stalled : STATE_COLOR[state];
              const isCurrent = state === "current";
              const isSelected = selected === id;
              const body = (
                <>
                  <span
                    data-chip-title
                    style={{
                      fontSize: 12,
                      lineHeight: 1.2,
                      fontWeight: isCurrent ? 700 : 600,
                      color: state === "skipped" || state === "pending" ? theme.dim : theme.text,
                      textDecoration: state === "skipped" ? "line-through" : undefined,
                      textAlign: "center",
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                      overflowWrap: "anywhere",
                      maxWidth: "100%",
                    }}
                  >
                    {stage.title}
                  </span>
                  <span style={{ fontFamily: theme.mono, fontSize: 9.5, letterSpacing: "0.06em", textTransform: "uppercase", color, whiteSpace: "nowrap" }}>
                    {isCurrent && needsOwner ? "needs you" : STATE_LABEL[state]}
                    {count > 1 ? ` ×${count}` : ""}
                  </span>
                </>
              );
              const chipStyle: CSSProperties = {
                width: chipW,
                height: CHIP_H,
                flexShrink: 0,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 2,
                padding: "0 6px",
                borderRadius: 7,
                border: `${isCurrent ? 2 : 1}px solid ${isCurrent ? color : isSelected ? theme.text : alpha(color, 0x66)}`,
                background: isCurrent ? alpha(color, 0x2e) : state === "pending" ? "transparent" : alpha(color, 0x14),
                boxShadow: isCurrent ? `0 0 0 3px ${alpha(color, 0x33)}` : undefined,
                opacity: state === "skipped" ? 0.55 : 1,
                cursor: onSelect ? "pointer" : "default",
                position: "relative",
                boxSizing: "border-box",
                font: "inherit",
              };
              const connector =
                i < order.length - 1 ? (
                  <span
                    aria-hidden
                    style={{
                      position: "absolute",
                      left: chipW + 3,
                      top: CHIP_H / 2 - 1,
                      width: CHIP_GAP - 6,
                      height: 1,
                      background: theme.edge,
                    }}
                  />
                ) : null;
              return onSelect ? (
                <button
                  key={id}
                  type="button"
                  data-stage={id}
                  data-state={state}
                  aria-pressed={isSelected}
                  aria-current={isCurrent ? "step" : undefined}
                  title={`${stage.title} — ${describeStage(stage)}`}
                  onClick={() => onSelect(id)}
                  style={chipStyle}
                >
                  {body}
                  {connector}
                </button>
              ) : (
                <div
                  key={id}
                  data-stage={id}
                  data-state={state}
                  aria-current={isCurrent ? "step" : undefined}
                  title={`${stage.title} — ${describeStage(stage)}`}
                  style={chipStyle}
                >
                  {body}
                  {connector}
                </div>
              );
            })}
          </div>
          {arcs.length > 0 && (
            <svg width={width} height={svgHeight} style={{ display: "block", overflow: "visible" }} aria-label="Loop edges">
              {arcs.map((l) => {
                const x1 = center(l.from);
                const x2 = center(l.to);
                const depth = depths.get(l)!;
                // A cubic with both control points at y=c peaks at 2 + 0.75·(c−2); solve for the apex at `depth`.
                const c = 2 + (depth - 2) / 0.75;
                const stroke = l.pressure >= 1 ? theme.waiting : l.pressure > 0 ? theme.stalled : theme.faint;
                const labelColor = l.pressure >= 1 ? theme.waiting : l.pressure > 0 ? theme.stalled : theme.dim;
                const mid = (x1 + x2) / 2;
                return (
                  <g key={`${l.from}->${l.to}`} data-loop={`${l.from}->${l.to}`} data-depth={depth}>
                    <path
                      d={`M ${x1} 2 C ${x1} ${c}, ${x2} ${c}, ${x2} 2`}
                      fill="none"
                      stroke={stroke}
                      strokeWidth={1.25}
                      strokeDasharray={l.pressure > 0 ? undefined : "3 3"}
                    />
                    <path d={`M ${x2 - 4} 8 L ${x2} 2 L ${x2 + 4} 8`} fill="none" stroke={stroke} strokeWidth={1.25} />
                    <text
                      x={mid}
                      y={depth}
                      textAnchor="middle"
                      dominantBaseline="central"
                      fontSize={10}
                      fontWeight={600}
                      fontFamily={theme.mono}
                      fill={labelColor}
                      stroke={surface}
                      strokeWidth={4}
                      strokeLinejoin="round"
                      paintOrder="stroke"
                    >
                      {l.label}
                    </text>
                  </g>
                );
              })}
            </svg>
          )}
        </div>
      </div>
      {more.left && (
        <button type="button" data-testid="pipeline-scroll-less" aria-label="Scroll to earlier stages" onClick={() => scrollStep(-1)} style={moreButton(-1)}>
          ‹
        </button>
      )}
      {more.right && (
        <button type="button" data-testid="pipeline-scroll-more" aria-label="Scroll to later stages" onClick={() => scrollStep(1)} style={moreButton(1)}>
          ›
        </button>
      )}
    </div>
  );
}

function time(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const WAITING_KIND_LABEL: Record<string, string> = {
  owner_input: "your input",
  exhausted: "out of attempts",
  stalled: "worker stalled",
};

/**
 * The run's status line. A waiting run names why it waits when the collector
 * recorded a kind, and only claims to need the owner when `canAct` says there
 * is a control for them here (see ownerCanAct). An unfinished run whose
 * launch no longer has a worker (see PipelineRun.worker) reads as ended or
 * superseded at its stage, never in progress.
 */
export function banner(
  run: PipelineRun,
  current: PipelineStageDef | undefined,
  canAct = false
): { color: string; text: string } {
  const title = current?.title ?? run.currentStage;
  if ((run.status === "active" || run.status === "waiting_user") && !runIsLive(run)) {
    return run.worker?.state === "superseded"
      ? { color: theme.faint, text: `Superseded at ${title} — a newer launch took over this job` }
      : { color: theme.faint, text: `Ended at ${title} — the worker's session ended` };
  }
  switch (run.status) {
    case "waiting_user": {
      const kind = run.waitingKind ? WAITING_KIND_LABEL[run.waitingKind] ?? run.waitingKind : undefined;
      const reason = run.waitingReason ?? `the run is waiting at ${title}`;
      return {
        color: theme.stalled,
        text: `${canAct ? "Needs you" : "Waiting"}${kind ? ` (${kind})` : ""}: ${reason}`,
      };
    }
    case "complete":
      return { color: theme.checkpoint, text: "Complete — every stage is done" };
    case "disabled":
      return { color: theme.faint, text: "Pipeline off for this launch" };
    default:
      return { color: theme.running, text: `In progress · ${title}` };
  }
}

function loopsOf(run: PipelineRun): LoopArc[] {
  return loopBudget(run.definition, currentEpochAttempts(run), run.facts).map((b) => ({
    from: b.from,
    to: b.to,
    label: `${b.used}/${b.max}`,
    pressure: b.max > 0 ? b.used / b.max : 0,
  }));
}

/**
 * The stage shown when no chip has been clicked: the current stage, or on a
 * complete run the last stage that was attempted (the complete stage itself
 * carries no evidence).
 */
export function defaultSelectedStage(run: PipelineRun): string {
  if (run.status === "complete" && run.attempts.length > 0) return run.attempts[run.attempts.length - 1]!.stageId;
  return run.currentStage;
}

/** The parked badge's text: "Parked — waiting on job X: reason", or "Parked: reason". */
export function parkedText(park: PipelinePark): string {
  const by = park.by === "persona" ? " by Persona" : "";
  return park.waitingOnJobId ? `Parked${by} — waiting on job ${park.waitingOnJobId}: ${park.reason}` : `Parked${by}: ${park.reason}`;
}

/** A parked run's badge: its worker was told to wait, so its turns end without the pipeline holding them. */
function ParkedBadge({ park }: { park: PipelinePark }) {
  return (
    <div
      data-testid="pipeline-parked"
      title={`Since ${new Date(park.at).toLocaleString()} — the next message to the worker un-parks it`}
      style={{
        fontSize: 12,
        fontWeight: 600,
        color: theme.dim,
        background: alpha(theme.dim, 0x14),
        border: `1px dashed ${alpha(theme.dim, 0x66)}`,
        borderRadius: 6,
        padding: "5px 10px",
        overflowWrap: "anywhere",
      }}
    >
      {parkedText(park)}
    </div>
  );
}

/** The run's status line, with the parked badge under it while the run is parked. */
function Banner({ run, canAct }: { run: PipelineRun; canAct: boolean }) {
  const head = banner(run, run.definition.stages.find((s) => s.id === run.currentStage), canAct);
  const status = (
    <div
      role="status"
      style={{
        fontSize: 12.5,
        fontWeight: 600,
        color: head.color,
        background: alpha(head.color, 0x14),
        border: `1px solid ${alpha(head.color, 0x44)}`,
        borderRadius: 6,
        padding: "6px 10px",
        overflowWrap: "anywhere",
      }}
    >
      {head.text}
    </div>
  );
  return run.parked ? (
    <>
      {status}
      <ParkedBadge park={run.parked} />
    </>
  ) : (
    status
  );
}

/**
 * A compact read-only view of one run: the status banner and the stage row,
 * scrolled to the current stage — for places that show the full PipelineView
 * further down (the Persona job drawer).
 */
export function PipelineStrip({ run, surface }: { run: PipelineRun; surface?: string }) {
  const canAct = ownerCanAct(run);
  return (
    <div data-testid="pipeline-strip" data-run={run.id} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <Banner run={run} canAct={canAct} />
      <PipelineGraph
        definition={run.definition}
        states={stageStates(run.definition, run)}
        loops={loopsOf(run)}
        needsOwner={canAct}
        surface={surface}
      />
    </div>
  );
}

/**
 * One launch's delivery pipeline. The selected stage (see defaultSelectedStage
 * until a chip is clicked) lists its attempts, newest first, with their
 * evidence, and Persona's decisions labelled as its own. Unless `readOnly`,
 * the run's owner can override Persona by waiving the current stage, or a
 * required stage that failed; `fetchImpl` issues that request and
 * `onRunChange` receives the updated run.
 */
export function PipelineView({
  run,
  fetchImpl = fetch,
  readOnly = false,
  onRunChange,
  surface,
}: {
  run: PipelineRun;
  fetchImpl?: typeof fetch;
  readOnly?: boolean;
  onRunChange?: (run: PipelineRun) => void;
  /** The background the view sits on (see PipelineGraph). */
  surface?: string;
}) {
  const def = run.definition;
  const states = stageStates(def, run);
  const canAct = ownerCanAct(run, readOnly);
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const selectedId = picked && def.stages.some((s) => s.id === picked) ? picked : defaultSelectedStage(run);
  const stage = def.stages.find((s) => s.id === selectedId);

  return (
    <div data-testid="pipeline-view" data-run={run.id} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <Banner run={run} canAct={canAct} />
      <PipelineGraph
        definition={def}
        states={states}
        loops={loopsOf(run)}
        selected={selectedId}
        onSelect={setPicked}
        needsOwner={canAct}
        surface={surface}
      />
      {stage && (
        <StageDetail
          key={stage.id}
          run={run}
          stage={stage}
          state={states[stage.id]?.state ?? "pending"}
          fetchImpl={fetchImpl}
          readOnly={readOnly}
          onRunChange={onRunChange}
        />
      )}
    </div>
  );
}

/**
 * Whether a waiting run has something for its owner to do here: it waits on
 * them and this view offers a waive control for one of its stages. A run that
 * waits with no control behind it is only waiting, never "needs you", and
 * neither is one whose worker ended or was superseded. Such a run still
 * offers its waive control (canWaiveStage): its owner may waive a stage that
 * holds up closing the job, but nothing there is waiting on them.
 */
export function ownerCanAct(run: PipelineRun, readOnly = false): boolean {
  if (readOnly || run.status !== "waiting_user" || !runIsLive(run)) return false;
  const states = stageStates(run.definition, run);
  return run.definition.stages.some((s) => canWaiveStage(run, s, states[s.id]?.state ?? "pending"));
}

/**
 * Whether the owner may override `stage` with a waive from the console.
 * Persona normally decides a run's gates (skip, waive, close out) and
 * escalates the ones it can't; this is the owner's override: any stage the
 * run is at (start included) except the complete stage, and any required
 * stage whose latest attempt failed, while the run is neither complete nor
 * disabled.
 */
export function canWaiveStage(run: PipelineRun, stage: PipelineStageDef, state: PipelineStageState): boolean {
  if (run.status === "complete" || run.status === "disabled") return false;
  if (stage.kind === "complete") return false;
  return state === "current" || (state === "failed" && stage.required);
}

function StageDetail({
  run,
  stage,
  state,
  fetchImpl,
  readOnly,
  onRunChange,
}: {
  run: PipelineRun;
  stage: PipelineStageDef;
  state: PipelineStageState;
  fetchImpl: typeof fetch;
  readOnly: boolean;
  onRunChange?: (run: PipelineRun) => void;
}) {
  const attempts = run.attempts.filter((a) => a.stageId === stage.id).slice().reverse();
  const canWaive = !readOnly && canWaiveStage(run, stage, state);
  const finished = stage.kind === "complete" && run.status === "complete";

  return (
    <div
      data-testid="pipeline-stage-detail"
      style={{
        border: `1px solid ${theme.edgeSoft}`,
        borderRadius: 7,
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        background: theme.ground,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: theme.text }}>{stage.title}</span>
        <span style={{ fontFamily: theme.mono, fontSize: 10, color: STATE_COLOR[state], textTransform: "uppercase", letterSpacing: "0.06em" }}>
          {STATE_LABEL[state]}
        </span>
        {stage.outward && <Tag color={theme.accent}>through the floor</Tag>}
        {!stage.required && <Tag color={theme.faint}>optional</Tag>}
      </div>
      <div style={{ fontSize: 11.5, color: theme.dim, lineHeight: 1.5 }}>{describeStage(stage)}</div>
      {attempts.length > 0 ? (
        attempts.map((a) => <AttemptCard key={a.id} run={run} stage={stage} attempt={a} />)
      ) : finished ? (
        <div style={{ fontSize: 12, color: theme.checkpoint, fontWeight: 600 }}>Run complete.</div>
      ) : (
        <div style={{ fontSize: 12, color: theme.faint }}>Not attempted yet.</div>
      )}
      {canWaive && <WaiveControl run={run} stage={stage} fetchImpl={fetchImpl} onRunChange={onRunChange} />}
    </div>
  );
}

const PERSONA_DECISION_LABEL: Record<PersonaDecisionKind, string> = {
  skip: "Persona: skipped",
  waive: "Persona: waived",
  close_out: "Persona: closed out",
  accept_wontfix: "Persona: accepted wontfix",
  not_applicable: "Persona: not applicable",
};

export type PersonaDecisionKind = "skip" | "waive" | "close_out" | "accept_wontfix" | "not_applicable";

function isPersonaDecisionKind(v: unknown): v is PersonaDecisionKind {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(PERSONA_DECISION_LABEL, v);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The decision Persona recorded on `attempt`, if Persona made it: a waived
 * attempt whose waiver is by Persona (its kind as recorded, else read from
 * what the waiver carries), or a skipped attempt whose evidence carries
 * Persona's skip decision.
 */
export function personaDecision(
  attempt: PipelineStageAttempt
): { kind: PersonaDecisionKind; label: string; reason: string; actor?: string } | undefined {
  const ev = isRecord(attempt.evidence) ? attempt.evidence : undefined;
  let record: Record<string, unknown> | undefined;
  let kind: PersonaDecisionKind | undefined;
  if (attempt.status === "waived" && isRecord(ev?.waiver) && ev.waiver.by === "persona") {
    record = ev.waiver;
    const named = isPersonaDecisionKind(record.kind) ? record.kind : undefined;
    kind =
      named ??
      (isRecord(record.wontfixAccepted) ? "accept_wontfix" : record.notApplicable === true ? "not_applicable" : record.landed ? "close_out" : "waive");
  } else if (attempt.status === "skipped" && isRecord(ev?.decision) && ev.decision.by === "persona") {
    record = ev.decision;
    kind = "skip";
  }
  if (!record || !kind) return undefined;
  return {
    kind,
    label: PERSONA_DECISION_LABEL[kind],
    reason: typeof record.reason === "string" ? record.reason : "",
    ...(typeof record.actor === "string" ? { actor: record.actor } : {}),
  };
}

function AttemptCard({ run, stage, attempt }: { run: PipelineRun; stage: PipelineStageDef; attempt: PipelineStageAttempt }) {
  const color = STATE_COLOR[attempt.status];
  const wontfix = attempt.status === "waived" ? wontfixAcceptedFindings(attempt.evidence) : undefined;
  const decision = personaDecision(attempt);
  // Persona's decision line already carries its reason; the attempt's reason is shown only when it adds to it.
  const showReason = attempt.reason && !(decision && decision.reason && attempt.reason.includes(decision.reason));
  return (
    <div data-attempt={attempt.id} style={{ borderLeft: `2px solid ${color}`, paddingLeft: 10, display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ fontSize: 11.5, color: theme.dim, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
        <span style={{ fontWeight: 700, color: theme.text }}>Attempt {attempt.attempt}</span>
        <span style={{ fontFamily: theme.mono, fontSize: 10, color, textTransform: "uppercase" }}>{attempt.status}</span>
        {decision && <Tag color={theme.expert}>Persona</Tag>}
        <span>{time(attempt.createdAt)}</span>
        {attempt.nextStage && <span>→ {run.definition.stages.find((s) => s.id === attempt.nextStage)?.title ?? attempt.nextStage}</span>}
      </div>
      {decision && (
        <div data-testid="pipeline-persona-decision" data-kind={decision.kind} style={{ fontSize: 12, color: theme.text, overflowWrap: "anywhere" }}>
          <b style={{ color: theme.expert }}>{decision.label}</b>
          {decision.reason ? ` — ${decision.reason}` : ""}
        </div>
      )}
      {showReason && <div style={{ fontSize: 12, color: theme.text, overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>{attempt.reason}</div>}
      {wontfix && wontfix.length > 0 && (
        <div data-testid="pipeline-wontfix-accepted" style={{ fontSize: 11.5, color: theme.dim }}>
          Wontfix findings accepted:
          <ul style={{ margin: "4px 0 0", paddingLeft: 18, display: "flex", flexDirection: "column", gap: 2 }}>
            {wontfix.map((f, i) => (
              <li key={i} style={{ overflowWrap: "anywhere" }}>
                <span style={{ fontFamily: theme.mono, fontSize: 10, textTransform: "uppercase" }}>{f.severity}</span> {f.title}
                {f.reviewer ? <span style={{ color: theme.faint }}> — {f.reviewer}</span> : null}
                {f.note ? <div style={{ color: theme.faint }}>{f.note}</div> : null}
              </li>
            ))}
          </ul>
        </div>
      )}
      {/* A waived attempt's evidence is the waiver itself, and a Persona skip's is its decision; the lines above show both. */}
      {attempt.evidence !== undefined && attempt.status !== "waived" && !decision && <StageEvidence run={run} stage={stage} attempt={attempt} />}
    </div>
  );
}

function WaiveControl({
  run,
  stage,
  fetchImpl,
  onRunChange,
}: {
  run: PipelineRun;
  stage: PipelineStageDef;
  fetchImpl: typeof fetch;
  onRunChange?: (run: PipelineRun) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <div data-testid="pipeline-waive-note" style={{ fontSize: 11, color: theme.faint, lineHeight: 1.45 }}>
          Persona decides this gate and escalates when it needs you. You can still override it here.
        </div>
        <button type="button" onClick={() => setOpen(true)} style={{ ...smallButton, alignSelf: "flex-start" }}>
          Waive this stage…
        </button>
      </div>
    );
  }

  async function waive() {
    if (!reason.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetchImpl(`/api/pipeline/runs/${encodeURIComponent(run.id)}/waive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage: stage.id, reason: reason.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as { run?: PipelineRun; error?: string };
      if (!res.ok) {
        setError(data.error ?? `Waive failed (${res.status})`);
        return;
      }
      if (data.run) onRunChange?.(data.run);
      setOpen(false);
      setReason("");
    } catch {
      setError("Waive failed — the collector may be unreachable.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={`Why ${stage.title} doesn't apply to this change`}
          style={{
            flex: 1,
            fontSize: 12,
            color: theme.text,
            background: theme.surface,
            border: `1px solid ${theme.edge}`,
            borderRadius: 5,
            padding: "5px 8px",
            outline: "none",
          }}
        />
        <button type="button" onClick={() => void waive()} disabled={!reason.trim() || busy} style={smallButton}>
          {busy ? "Waiving…" : "Waive"}
        </button>
        <button type="button" onClick={() => setOpen(false)} style={smallButton}>
          Cancel
        </button>
      </div>
      {error && <div style={{ fontFamily: theme.mono, fontSize: 11.5, color: theme.waiting }}>{error}</div>}
    </div>
  );
}

const smallButton: CSSProperties = {
  fontSize: 11.5,
  fontWeight: 600,
  padding: "4px 10px",
  borderRadius: 5,
  border: `1px solid ${theme.edge}`,
  background: "transparent",
  color: theme.dim,
  cursor: "pointer",
};
