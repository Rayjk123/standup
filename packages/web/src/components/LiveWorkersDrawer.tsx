import {
  Suspense, useEffect, useMemo, useRef, useState,
  type CSSProperties, type KeyboardEvent, type PointerEvent, type RefObject,
} from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { BoardTask, Checkpoint, Launch, PersonaJob, Session } from "@standup/shared";
import { LuArrowUpRight, LuChevronDown, LuChevronUp, LuPlus } from "react-icons/lu";
import { alpha, theme } from "./theme";
import { WorkView } from "./lazyViews";
import type { ListSections, WorkViewProps } from "./WorkView";
import { ViewBoundary, ViewLoading } from "./ViewBoundary";
import { useOpenCommitments } from "../hooks/useOpenCommitments";
import { useNarrow } from "../hooks/useNarrow";
import {
  isTiedLaunch,
  isTiedWorker,
  parseLiveWorkers,
  personaTies,
  writeLiveWorkers,
  type LiveWorkersState,
  type WorkerSelection,
  type WorkerTie,
} from "../lib/liveWorkers";

type WorkProps = Omit<
  WorkViewProps,
  | "selection" | "onSelect" | "newChatSignal" | "showSession" | "showLaunch" | "emptyText"
  | "sections" | "rowDetail" | "sessionAction" | "narrow"
>;

interface LiveWorkersDrawerProps extends WorkProps {
  /** The viewer's Persona jobs; their open ones' workers are what the drawer lists by default. */
  jobs: PersonaJob[];
  /** The Board's tasks; an open job card's linked sessions and launches count as that job's. */
  boardTasks: BoardTask[];
  /** The viewer's own work is what the drawer filters to; false for a viewer with none (every session shows). */
  ownWork: boolean;
  /** The viewer owns a running Persona, so its commitments are theirs to read. */
  readCommitments: boolean;
}

const PANEL_ID = "live-workers-panel";
/** The drawer's open height until the viewer drags it: most of a laptop screen's lower half. */
const DEFAULT_HEIGHT = "clamp(360px, 58vh, 720px)";
const MIN_HEIGHT = 240;
/** Board space the drawer always leaves above itself, so the columns' headers stay in view. */
const BOARD_RESERVE = 140;
const HEIGHT_KEY = "standup:liveWorkersHeight";
const KEY_STEP = 40;

const ellipsis: CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 };

/**
 * The Board's Live workers drawer: the Work view (session list, transcript,
 * terminal, checkpoints, info and the new-chat composer) folded under the
 * Board's columns. Collapsed, it is a header bar only: nothing is read,
 * polled or rendered for it until the viewer opens it, and collapsing it
 * unmounts the Work view, which stops its polling. Open, it lists by default
 * only the live workers of Persona's open jobs and open commitments, plus any
 * chat started from it; "Show all sessions" lists every session, Persona's
 * first. Open, show-all and selection live in the Board's query (see
 * lib/liveWorkers); picking a worker adds a history entry, so Back returns to
 * the previous one. On a phone it opens as a full-height sheet over the Board.
 */
export function LiveWorkersDrawer(props: LiveWorkersDrawerProps) {
  const [params, setParams] = useSearchParams();
  const state = parseLiveWorkers(params);
  const setState = (next: LiveWorkersState, push = false) =>
    setParams((prev) => writeLiveWorkers(prev, next), { replace: !push });
  const narrow = useNarrow();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Focus follows the toggle: into the panel on open, back to the header on
  // collapse (the header remounts, so this runs after the commit).
  const toggled = useRef(false);
  useEffect(() => {
    if (!toggled.current) return;
    toggled.current = false;
    (state.open ? panelRef.current : toggleRef.current)?.focus({ preventScroll: true });
  }, [state.open]);
  const close = () => {
    toggled.current = true;
    setState({ open: false, selection: null });
  };
  // Opening from the header picks the most recently active worker of an open
  // job, so the detail pane shows one at work rather than an empty composer.
  // Commitments aren't read until the drawer is open, so only jobs count here.
  const open = () => {
    toggled.current = true;
    setState({ open: true, selection: narrow ? null : firstTiedWorker(props) });
  };

  const [height, setHeight] = useState<number | null>(() => {
    const stored = typeof window === "undefined" ? NaN : Number(window.localStorage.getItem(HEIGHT_KEY));
    return Number.isFinite(stored) && stored >= MIN_HEIGHT ? stored : null;
  });
  const rootRef = useRef<HTMLDivElement>(null);
  const resizeTo = (px: number) => {
    const max = Math.max(MIN_HEIGHT, (rootRef.current?.parentElement?.clientHeight ?? window.innerHeight) - BOARD_RESERVE);
    setHeight(Math.round(Math.min(max, Math.max(MIN_HEIGHT, px))));
  };
  const saveHeight = () => {
    try {
      if (height != null) window.localStorage.setItem(HEIGHT_KEY, String(height));
    } catch {
      // Storage blocked or full: the height still holds for this visit.
    }
  };

  return (
    <div
      ref={rootRef}
      data-testid="live-workers"
      data-open={state.open ? "true" : "false"}
      // Esc collapses from the header or the panel itself, never from inside
      // the Work view, where it closes menus and collapsing would drop a draft.
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key !== "Escape" || !state.open || e.defaultPrevented) return;
        const target = e.target as Node;
        if (target === panelRef.current || headerRef.current?.contains(target)) close();
      }}
      style={{
        flexShrink: 0,
        position: "relative",
        display: "flex",
        flexDirection: "column",
        height: !state.open ? undefined : narrow ? "100%" : height != null ? `min(${height}px, calc(100% - ${BOARD_RESERVE}px))` : DEFAULT_HEIGHT,
        borderTop: `1px solid ${theme.edge}`,
        background: theme.ground,
      }}
    >
      {state.open && !narrow && <ResizeGrip rootRef={rootRef} onResize={resizeTo} onDone={saveHeight} />}
      {state.open ? (
        <OpenDrawer
          {...props}
          narrow={narrow}
          headerRef={headerRef}
          panelRef={panelRef}
          toggleRef={toggleRef}
          // A viewer with no Persona of their own has no workers to filter to: they see every session.
          showAll={!!state.showAll || !props.ownWork}
          onShowAll={props.ownWork ? (showAll) => setState({ ...state, showAll }) : undefined}
          selection={state.selection}
          // Picking a worker is a history step; clearing the pick, or re-picking it, replaces.
          onSelect={(selection) => setState({ ...state, open: true, selection }, !!selection && !sameSelection(selection, state.selection))}
          onClose={close}
        />
      ) : (
        <DrawerHeader open={false} narrow={narrow} headerRef={headerRef} toggleRef={toggleRef} onToggle={open} />
      )}
    </div>
  );
}

function sameSelection(a: WorkerSelection, b: WorkerSelection): boolean {
  return a?.kind === b?.kind && a?.id === b?.id;
}

/** The tied root session the viewer most likely wants first: the most recently active one. */
function firstTiedWorker({
  jobs, boardTasks, launches, sessions,
}: Pick<LiveWorkersDrawerProps, "jobs" | "boardTasks" | "launches" | "sessions">): WorkerSelection {
  const ties = personaTies(jobs, null, launches, boardTasks);
  const at = (s: Session) => new Date(s.lastActivityAt ?? s.startedAt).getTime();
  const best = sessions.filter((s) => isTiedWorker(s, ties)).sort((a, b) => at(b) - at(a))[0];
  return best ? { kind: "s", id: best.id } : null;
}

/** Each session's newest checkpoint summary. */
function latestCheckpoints(checkpoints: readonly Checkpoint[]): Map<string, string> {
  const newest = new Map<string, Checkpoint>();
  for (const c of checkpoints) {
    const prev = newest.get(c.sessionId);
    if (!prev || new Date(c.createdAt).getTime() > new Date(prev.createdAt).getTime()) newest.set(c.sessionId, c);
  }
  return new Map([...newest].map(([id, c]) => [id, c.summary]));
}

/**
 * Drags the drawer's top edge to resize it; arrow keys step it while the grip
 * has focus. The height sticks across visits.
 */
function ResizeGrip({ rootRef, onResize, onDone }: {
  rootRef: RefObject<HTMLDivElement>;
  onResize: (px: number) => void;
  onDone: () => void;
}) {
  const dragging = useRef(false);
  const heightFor = (clientY: number) => (rootRef.current?.getBoundingClientRect().bottom ?? 0) - clientY;
  const stop = () => {
    if (!dragging.current) return;
    dragging.current = false;
    onDone();
  };
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize Live workers"
      aria-controls={PANEL_ID}
      tabIndex={0}
      data-testid="live-workers-grip"
      onPointerDown={(e: PointerEvent<HTMLDivElement>) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e: PointerEvent<HTMLDivElement>) => {
        if (dragging.current) onResize(heightFor(e.clientY));
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
        const current = rootRef.current?.getBoundingClientRect().height ?? 0;
        if (e.key === "ArrowUp") onResize(current + KEY_STEP);
        else if (e.key === "ArrowDown") onResize(current - KEY_STEP);
        else return;
        e.preventDefault();
        onDone();
      }}
      title="Drag to resize"
      style={{
        position: "absolute", top: -5, left: 0, right: 0, height: 11, zIndex: 2,
        cursor: "ns-resize", touchAction: "none", display: "flex", justifyContent: "center", alignItems: "center",
      }}
    >
      <span style={{ width: 40, height: 3, borderRadius: 3, background: theme.dim, opacity: 0.6 }} />
    </div>
  );
}

function OpenDrawer({
  jobs,
  boardTasks,
  ownWork,
  readCommitments,
  narrow,
  headerRef,
  panelRef,
  toggleRef,
  showAll,
  onShowAll,
  selection,
  onSelect,
  onClose,
  ...work
}: LiveWorkersDrawerProps & {
  narrow: boolean;
  headerRef: RefObject<HTMLDivElement>;
  panelRef: RefObject<HTMLDivElement>;
  toggleRef: RefObject<HTMLButtonElement>;
  showAll: boolean;
  /** Absent when the viewer has no Persona of their own: the list is always every session. */
  onShowAll?: (on: boolean) => void;
  selection: WorkerSelection;
  onSelect: (selection: WorkerSelection) => void;
  onClose: () => void;
}) {
  const [newChatSignal, setNewChatSignal] = useState(0);
  const { list: commitments } = useOpenCommitments({ enabled: readCommitments });
  const ties = useMemo(
    () => personaTies(jobs, commitments, work.launches, boardTasks),
    [jobs, commitments, work.launches, boardTasks]
  );
  const lastCheckpoint = useMemo(() => latestCheckpoints(work.checkpoints), [work.checkpoints]);
  const tied = work.sessions.filter((s) => isTiedWorker(s, ties));
  const waiting = tied.filter((s) => s.status === "waiting").length;
  const selectedSessionId = selection?.kind === "s" ? selection.id : undefined;
  const selectedLaunchId = selection?.kind === "l" ? selection.id : undefined;

  // A chat started here stays listed, and opens, even with no job behind it.
  const [pinned, setPinned] = useState<ReadonlySet<string>>(new Set());
  const onLaunch: WorkProps["onLaunch"] = async (...args) => {
    const result = await work.onLaunch(...args);
    const id = result.launchId;
    if (!result.error && id) {
      setPinned((cur) => new Set([...cur, id]));
      onSelect({ kind: "l", id });
    }
    return result;
  };
  const pinnedSessions = new Set(work.launches.filter((l) => pinned.has(l.id) && l.sessionId).map((l) => l.sessionId!));
  const tiedOrPinned = (s: Session) => isTiedWorker(s, ties) || pinnedSessions.has(s.id);

  const sections: ListSections = {
    first: "Persona's workers",
    rest: "Other sessions",
    hasSession: tiedOrPinned,
    hasLaunch: (l) => isTiedLaunch(l, ties) || pinned.has(l.id),
  };

  return (
    <>
      <DrawerHeader
        open
        narrow={narrow}
        headerRef={headerRef}
        toggleRef={toggleRef}
        onToggle={onClose}
        summary={
          showAll
            ? `${work.sessions.filter((s) => !s.parentSessionId).length} sessions` + (ownWork ? ` · ${tied.length} Persona's workers` : "")
            : `${tied.length} tied to jobs & commitments` + (waiting > 0 ? ` · ${waiting} waiting` : "")
        }
        showAll={showAll}
        onShowAll={onShowAll}
        onNewChat={() => setNewChatSignal((n) => n + 1)}
      />
      <div id={PANEL_ID} ref={panelRef} tabIndex={-1} role="region" aria-label="Live workers" style={{ flex: 1, minHeight: 0, outline: "none" }}>
        <ViewBoundary>
          <Suspense fallback={<ViewLoading />}>
            <WorkView
              {...work}
              onLaunch={onLaunch}
              selection={selection}
              onSelect={onSelect}
              newChatSignal={newChatSignal}
              narrow={narrow}
              sections={showAll && ownWork ? sections : undefined}
              // The selected session or launch stays listed, so a link to an untied one still shows where it is.
              showSession={showAll ? undefined : (s: Session) => tiedOrPinned(s) || s.id === selectedSessionId}
              showLaunch={showAll ? undefined : (l: Launch) => sections.hasLaunch(l) || l.id === selectedLaunchId}
              emptyText={showAll || !onShowAll ? undefined : <QuietRoom narrow={narrow} onShowAll={() => onShowAll(true)} />}
              rowDetail={(s: Session) => (
                <WorkerRowDetail session={s} tie={ties.bySession.get(s.id)} checkpoint={lastCheckpoint.get(s.id)} />
              )}
              sessionAction={(s: Session) => <OpenJobLink tie={ties.bySession.get(s.id)} narrow={narrow} />}
            />
          </Suspense>
        </ViewBoundary>
      </div>
    </>
  );
}

/** The filtered list with nothing in it: says the room is quiet, and offers the one move out. */
function QuietRoom({ narrow, onShowAll }: { narrow: boolean; onShowAll: () => void }) {
  return (
    <span data-testid="live-workers-empty" style={{ display: "block", lineHeight: 1.5 }}>
      <span style={{ display: "block", color: theme.dim }}>
        Quiet here: none of Persona's jobs or commitments has a live worker.
      </span>
      <button
        onClick={onShowAll}
        style={{
          marginTop: 6, padding: 0, minHeight: narrow ? 44 : 32, background: "none", border: "none", cursor: "pointer",
          font: "inherit", fontSize: 12.5, fontWeight: 600, color: theme.running,
        }}
      >
        Show all sessions
      </button>
    </span>
  );
}

/** A Board column's signal color on a stage chip: the waiting color when a human is needed, amber in review, else blue. */
function stageColor(tie: WorkerTie): string {
  if (tie.status === "waiting") return theme.waiting;
  if (tie.status === "in_review") return theme.stalled;
  return theme.running;
}

/**
 * What a listed worker is doing: its stage and last checkpoint on one line,
 * and the job (or commitment) it works for when that isn't the row's title.
 */
function WorkerRowDetail({ session, tie, checkpoint }: { session: Session; tie?: WorkerTie; checkpoint?: string }) {
  const showLabel = tie && tie.label.trim() !== (session.title ?? "").trim();
  if (!tie?.stage && !checkpoint && !showLabel) return null;
  const line: CSSProperties = { display: "flex", alignItems: "center", gap: 6, marginTop: 4, paddingLeft: 14, minWidth: 0 };
  return (
    <>
      {showLabel && (
        <div data-testid="live-worker-tie" style={line}>
          <span title={tie.label} style={{ ...ellipsis, fontFamily: theme.mono, fontSize: 10.5, color: theme.dim }}>
            {tie.kind === "job" ? "job" : "commitment"} · {tie.label}
          </span>
        </div>
      )}
      {(tie?.stage || checkpoint) && (
        <div style={line}>
          {tie?.stage && (
            <span
              data-testid="live-worker-stage"
              style={{
                fontFamily: theme.mono, fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", flexShrink: 0,
                color: stageColor(tie), border: `1px solid ${alpha(stageColor(tie), 0x44)}`, borderRadius: 3, padding: "1px 5px",
              }}
            >
              {tie.stage}
            </span>
          )}
          {checkpoint && (
            <span title={checkpoint} style={{ ...ellipsis, fontSize: 11.5, color: theme.dim }}>{checkpoint}</span>
          )}
        </div>
      )}
    </>
  );
}

/** The selected worker's job drawer, when Persona's job is known. */
function OpenJobLink({ tie, narrow }: { tie?: WorkerTie; narrow: boolean }) {
  if (!tie?.jobId) return null;
  return (
    <Link
      to={`/persona?job=${encodeURIComponent(tie.jobId)}`}
      data-testid="live-worker-open-job"
      style={{
        flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11.5, fontWeight: 600,
        minHeight: narrow ? 44 : undefined, boxSizing: "border-box",
        border: `1px solid ${theme.edge}`, borderRadius: 6, padding: "4px 10px", color: theme.dim, textDecoration: "none",
      }}
    >
      Open job <LuArrowUpRight aria-hidden />
    </Link>
  );
}

function DrawerHeader({
  open,
  narrow,
  headerRef,
  toggleRef,
  onToggle,
  summary,
  showAll,
  onShowAll,
  onNewChat,
}: {
  open: boolean;
  narrow: boolean;
  headerRef: RefObject<HTMLDivElement>;
  toggleRef: RefObject<HTMLButtonElement>;
  onToggle: () => void;
  summary?: string;
  showAll?: boolean;
  onShowAll?: (on: boolean) => void;
  onNewChat?: () => void;
}) {
  return (
    <div
      ref={headerRef}
      style={{
        display: "flex", alignItems: "center", gap: 10, height: narrow ? 44 : 38, padding: "0 12px 0 4px", flexShrink: 0,
        background: theme.surface, borderBottom: open ? `1px solid ${theme.edgeSoft}` : undefined,
      }}
    >
      <button
        ref={toggleRef}
        data-testid="live-workers-toggle"
        aria-expanded={open}
        aria-controls={PANEL_ID}
        aria-label={open ? "Collapse Live workers" : "Open Live workers"}
        onClick={onToggle}
        style={{
          display: "flex", alignItems: "center", gap: 10, minWidth: 0, flex: 1, height: "100%",
          background: "none", border: "none", padding: "0 8px", cursor: "pointer", color: theme.text, font: "inherit",
        }}
      >
        <span style={{ color: theme.dim, display: "inline-flex", flexShrink: 0 }}>{open ? <LuChevronDown /> : <LuChevronUp />}</span>
        <span style={{
          fontFamily: theme.mono, fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase",
          fontWeight: 700, whiteSpace: "nowrap", flexShrink: 0,
        }}>Live workers</span>
        {!narrow && (
          <span style={{
            fontFamily: theme.mono, fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", flexShrink: 0,
            color: theme.dim, border: `1px solid ${theme.edge}`, borderRadius: 3, padding: "1px 5px",
          }}>advanced</span>
        )}
        {!narrow && (
          <span data-testid="live-workers-summary" style={{ ...ellipsis, fontSize: 11.5, color: theme.dim }}>
            {summary ?? "What each job's worker is doing right now"}
          </span>
        )}
      </button>
      {open && onShowAll && (
        <button
          data-testid="live-workers-show-all"
          role="switch"
          aria-checked={!!showAll}
          aria-label="Show all sessions"
          onClick={() => onShowAll(!showAll)}
          style={{
            display: "inline-flex", alignItems: "center", gap: 8, minHeight: narrow ? 44 : 28, padding: "0 4px",
            background: "none", border: "none", cursor: "pointer", font: "inherit",
            fontSize: 11.5, fontWeight: 600, color: showAll ? theme.text : theme.dim, whiteSpace: "nowrap",
          }}
        >
          <span aria-hidden>{narrow ? "All" : "Show all sessions"}</span>
          <span aria-hidden style={{
            position: "relative", width: 26, height: 14, borderRadius: 14, flexShrink: 0, boxSizing: "border-box",
            background: showAll ? alpha(theme.running, 0x55) : "transparent",
            border: `1px solid ${showAll ? theme.running : theme.dim}`, transition: "background-color 120ms ease",
          }}>
            <span style={{
              position: "absolute", top: 2, left: showAll ? 13 : 2, width: 8, height: 8, borderRadius: 8,
              background: showAll ? theme.running : theme.dim, transition: "left 120ms ease",
            }} />
          </span>
        </button>
      )}
      {open && onNewChat && (
        <button
          data-testid="live-workers-new-chat"
          onClick={onNewChat}
          aria-label="New chat"
          style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5, fontSize: 11.5, fontWeight: 600,
            minHeight: narrow ? 44 : undefined, minWidth: narrow ? 44 : undefined,
            border: `1px solid ${theme.edge}`, borderRadius: 6, padding: narrow ? 0 : "4px 10px", background: "none",
            color: theme.text, cursor: "pointer", whiteSpace: "nowrap",
          }}
        >
          <LuPlus aria-hidden />{!narrow && " New chat"}
        </button>
      )}
    </div>
  );
}
