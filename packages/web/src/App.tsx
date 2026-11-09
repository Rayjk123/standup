import { useState, useEffect, useCallback, useRef, useMemo, useReducer } from "react";
import { useLocation } from "react-router-dom";
import { Console } from "./components/Console";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { BuildUpdateBanner } from "./components/BuildUpdateBanner";
import { useWebSocket, resolveWsUrl } from "./hooks/useWebSocket";
import { createCatchUp, REFUSED_RESYNC_INTERVAL_MS, type CatchUp } from "./hooks/catchUp";
import { PresenceProvider, type PresenceApi } from "./hooks/presence";
import { ALL_TARGETS } from "./lib/signal";
import {
  CATCH_UP_READ_TIMEOUT_MS,
  catchUpFromSeq,
  catchUpPersonaThread,
  fetchPersonaSnapshot,
  maxSeq,
  initialPersonaViewState,
  loadLastViewed,
  personaReducer,
  personaViewFromCache,
  saveLastViewed,
  savePersonaCache,
  syncPersonaSnapshot,
  withBootReads,
} from "./lib/persona";
import { publishPipelineConfigUpdate, publishPipelineResync, publishPipelineUpdate, setPipelineViewer } from "./lib/pipelineUpdates";
import { publishReviewResync, publishReviewUpdate } from "./lib/reviewUpdates";
import { publishDocsChanged, publishDocsResync } from "./lib/docsUpdates";
import { getPendingCount } from "./components/review/api";
import { applyList, coalesce, fetchJson, isList } from "./lib/liveFetch";
import {
  appendClosedPage,
  applyFrameToOlder,
  boardFilterKey,
  boardListOf,
  boardReadRetryDelay,
  boardRefreshDueAt,
  boardVersionOf,
  BOARD_READ_DEADLINE_MS,
  BOARD_READ_TIMEOUT_MS,
  BOARD_ROUTE,
  BOARD_WAITING_PATH,
  closedPagePath,
  mergeBoardList,
  oldestClosedCursor,
  olderCursor,
  readClosedPage,
  settleBoardRead,
  upsertBoardTask,
  withOlderClosed,
  type BoardFilter,
  type BoardListState,
  type ClosedCursor,
  type HeldBoard,
} from "./lib/board";
import { isOpenBoardStatus } from "@standup/shared";
import type {
  BoardTaskFrame,
  BoardTaskWithConflicts,
  DocsChangedPayload,
  PipelineConfigUpdatedPayload,
  PipelineRun,
  ReviewUpdatedPayload,
  ReviewsPendingPayload,
  Session,
  Checkpoint,
  Ask,
  Launch,
  ProjectWithCounts,
  Ticket,
  ReviewFinding,
  TaskRun,
  Actor,
  PresenceEntry,
  HelloOkPayload,
  WsMessage,
} from "@standup/shared";

/** How long the view must hold still before it is kept for the next open. */
const PERSONA_CACHE_SAVE_MS = 1000;
/**
 * How long the live socket waits for Persona's first read before opening
 * anyway. Its hello-ok snapshot is the console's largest payload, and the
 * collector building it would hold the thread's read up; the socket's own
 * resync (on hello-ok) reads back anything sent in between.
 */
const SOCKET_HOLD_MS = 1500;
/** A Persona resync this recent (or still running) already serves the view that opened. */
const PERSONA_FRESH_MS = 5000;

export default function App() {
  const [projects, setProjects] = useState<ProjectWithCounts[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [asks, setAsks] = useState<Ask[]>([]);
  const [launches, setLaunches] = useState<Launch[]>([]);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  // The open High/critical auto-review findings — the review-queue's de-noised
  // set. Not part of the hello-ok snapshot; fetched alongside the ledger.
  const [findings, setFindings] = useState<ReviewFinding[]>([]);
  const [taskRuns, setTaskRuns] = useState<TaskRun[]>([]);
  // The viewer's Board: every job, ticket and backlog item as one task card.
  // Not in the hello-ok snapshot; read from the list route on (re)connect (only
  // the waiting tasks until the Board view first opens) and kept live by
  // owner-addressed board:task frames.
  // Beside the list, the closed tasks older than the list route's cap, paged
  // in on demand. Whether the route holds more is the list's closedMore until
  // a page is read, then that page's more.
  const [board, setBoard] = useState<HeldBoard>({ held: [], older: [] });
  const [boardListState, setBoardListState] = useState<BoardListState>("pending");
  const [boardListClosedMore, setBoardListClosedMore] = useState(false);
  const [boardPageMore, setBoardPageMore] = useState<boolean | null>(null);
  // The team's actor directory, delivered in the hello-ok snapshot.
  // Lets attribution tags resolve a session's created/owner alias to a display
  // name; falls back to the raw alias when a name isn't set.
  const [actors, setActors] = useState<Actor[]>([]);
  // Ephemeral team presence: the live roster the collector pushes,
  // plus the current viewer's identity. Never persisted.
  const [presence, setPresence] = useState<PresenceEntry[]>([]);
  const [currentUser, setCurrentUser] = useState("");
  // Which session last produced a hook event, and a counter so repeated
  // events for the same session still trigger a refresh. Lets a transcript
  // update as events arrive instead of on a timer.
  const [lastEvent, setLastEvent] = useState<{ sessionId: string; n: number }>({
    sessionId: "",
    n: 0,
  });
  // Same shape as lastEvent, but for knowledge:draft — lets the Knowledge
  // tab's draft list fill in live while a bootstrap run is in progress
  // instead of only on next mount.
  // Bumped on every plan:updated frame so the Work plan-approval panel refetches
  // the pending set live — a plan appears the instant the agent submits it and
  // clears when a human resolves it, without a manual reload.
  const [planSignal, setPlanSignal] = useState(0);
  // Bumped on every persona:schedule frame so the Schedules page refetches
  // when a schedule is created, edited, removed or runs.
  const [scheduleSignal, setScheduleSignal] = useState(0);
  // Review packets awaiting a decision, for the Review tab's badge.
  const [reviewsPending, setReviewsPending] = useState(0);
  const [draftSignal, setDraftSignal] = useState<{ projectId: string; n: number }>({
    projectId: "",
    n: 0,
  });
  // Persona's thread, jobs, approvals and run state. Held here rather than in
  // the view so live persona:* frames keep applying while another tab is open.
  // Which messages each thread last showed the owner survives reloads, so
  // unread dots mean "new since you looked" rather than "new since boot". The
  // last view this browser saw paints the thread before any request returns;
  // the first snapshot replaces it with the server's.
  const [persona, dispatchPersona] = useReducer(personaReducer, initialPersonaViewState, () => {
    const storage = typeof window !== "undefined" ? window.localStorage : undefined;
    return personaViewFromCache(storage, loadLastViewed(storage));
  });
  // Mirror persona.frames and the selected thread for refreshPersona, which
  // must not re-subscribe.
  const personaFramesRef = useRef(0);
  personaFramesRef.current = persona.frames;
  const personaThreadRef = useRef<string | null>(null);
  personaThreadRef.current = persona.threadId;
  const personaRef = useRef(persona);
  personaRef.current = persona;
  // The visible-tab catch-up, for the socket's onStale to run at once.
  const catchUpRef = useRef<CatchUp | null>(null);
  useEffect(() => {
    saveLastViewed(window.localStorage, persona.lastViewed);
  }, [persona.lastViewed]);
  // Kept a beat after the view settles, not on every frame.
  useEffect(() => {
    const t = setTimeout(() => savePersonaCache(window.localStorage, personaRef.current), PERSONA_CACHE_SAVE_MS);
    return () => clearTimeout(t);
  }, [persona.messages, persona.approvals, persona.state, persona.forbidden, persona.disabledReason, persona.signInNeeded, persona.cached]);
  const [loading, setLoading] = useState(true);
  // Set once the first hello-ok snapshot (or the REST fallback) has populated
  // state, so the fallback timer knows whether the socket beat it to the boot.
  const bootstrappedRef = useRef(false);

  // `all=1` includes ended sessions. They're needed in the Projects tab so
  // their stored rows can be reviewed and cleaned up — an ended session that
  // never appears can never be deleted.
  // Lifecycle frames arrive in bursts, so these three refetches are coalesced:
  // one read in flight plus one trailing read for whatever landed meanwhile.
  // An error body (a collector draining or restarting) keeps the held list.
  const refreshSessions = useMemo(
    () =>
      coalesce(() =>
        fetchJson("/api/sessions?all=1", isList<Session>)
          .then((list) => list && setSessions(list))
          .catch(() => {})
      ),
    []
  );

  const refreshLaunches = useMemo(
    () =>
      coalesce(() =>
        fetchJson("/api/launches", isList<Launch>)
          .then((list) => list && setLaunches(list))
          .catch(() => {})
      ),
    []
  );

  // The dispatcher's task-run lifecycle ledger behind the dispatchable board.
  const refreshTaskRuns = useMemo(
    () =>
      coalesce(() =>
        fetchJson("/api/task-runs", isList<TaskRun>)
          .then((list) => list && setTaskRuns(list))
          .catch(() => {})
      ),
    []
  );

  // The de-noised review-queue: open High/critical auto-review findings.
  const refreshFindings = () =>
    fetchJson("/api/review-findings", isList<ReviewFinding>)
      .then((list) => list && setFindings(list))
      .catch(() => {});

  // A collector without the review routes leaves the badge at zero.
  const refreshReviewsPending = () =>
    getPendingCount()
      .then(setReviewsPending)
      .catch(() => {});
  const reviewsPendingRef = useRef(reviewsPending);
  reviewsPendingRef.current = reviewsPending;

  // Reads are numbered so a slow response never lands over a newer one, and
  // each board:task frame records the event count it was applied at, so a
  // response keeps the framed version of any task that changed after its
  // read was issued.
  const boardReadSeqRef = useRef(0);
  const boardAppliedSeqRef = useRef(0);
  const boardEventRef = useRef(0);
  const boardFramedAtRef = useRef(new Map<string, number>());
  // The state of the last applied read, and how many times the paged-in closed
  // tasks were cleared (by a read that isn't the viewer's own list, or by the
  // view switching filter): a closed page answered after either moved on
  // belongs to a board no longer shown.
  const boardAppliedStateRef = useRef<BoardListState>("pending");
  const boardOlderResetsRef = useRef(0);
  // The Board view's filter, and the one the paged-in closed tasks were loaded
  // under (null while none are).
  const boardViewFilterKeyRef = useRef<string | null>(null);
  const boardPageFilterKeyRef = useRef<string | null>(null);
  // Where the last page under that filter said the next one starts: past the
  // oldest row the route scanned, so a page that matched nothing still moves on.
  const boardPageNextRef = useRef<ClosedCursor | null>(null);
  // The oldest closed task the last viewer-scoped list read served: the edge
  // of the route's closed window, where the first page starts. Never taken
  // from the held tasks, which frames add to — a refined closed card keeps its
  // old updatedAt, so a frame can bring in one from well past the window.
  const boardListEdgeRef = useRef<ClosedCursor | null>(null);
  const clearBoardOlder = () => {
    boardOlderResetsRef.current++;
    boardPageFilterKeyRef.current = null;
    boardPageNextRef.current = null;
    setBoardPageMore(null);
    setBoard((b) => (b.older.length === 0 ? b : { ...b, older: [] }));
  };
  // The event count each in-flight closed page was requested at, so a frame
  // applied after the request stays recorded until that page lands.
  const boardPageTokenRef = useRef(0);
  const boardPagesIssuedAtRef = useRef(new Map<number, number>());
  // The board shows only what the route served and board:task frames since.
  // A team-scoped answer (the route couldn't tell who the viewer is) is the
  // team-wide ticket queue; a refused read (401/403) shows nothing past the
  // late frames; any other failure (a collector without the board routes, or
  // mid-restart) keeps the tasks already held and is retried with backoff
  // until a read lands, so a board whose first read failed or hung fills in
  // on its own rather than at the next reconnect. A read that takes longer
  // than BOARD_READ_TIMEOUT_MS counts as failed.
  const boardRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const boardRetryAttemptRef = useRef(0);
  const boardReadsInFlightRef = useRef(0);
  const boardMountedRef = useRef(true);
  // The board's change counter as of the last applied list read; the
  // catch-up re-reads the list when the collector's has moved past it.
  const boardVersionRef = useRef<string | undefined>(undefined);
  // The whole list (hundreds of cards) is read only once the Board view has
  // opened; until then a read asks for just the open tasks waiting on someone,
  // which is all the tab's badge counts. boardFull is whether the read last
  // applied was the whole list, so the view shows "loading" until it lands.
  const boardOpenedRef = useRef(false);
  const [boardFull, setBoardFull] = useState(false);
  const boardAppliedFullRef = useRef(false);
  const { pathname } = useLocation();
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  const refreshBoard = () => {
    // A console loaded on the Board reads the whole list from its first read.
    if (BOARD_ROUTE.test(pathnameRef.current)) boardOpenedRef.current = true;
    const full = boardOpenedRef.current;
    if (boardRetryTimerRef.current !== null) {
      clearTimeout(boardRetryTimerRef.current);
      boardRetryTimerRef.current = null;
    }
    const seq = ++boardReadSeqRef.current;
    const issuedAt = boardEventRef.current;
    // Only the newest read retries; a newer one issued since carries on in its place.
    const retryIn = (delayMs: number) => {
      if (!boardMountedRef.current || seq !== boardReadSeqRef.current || boardRetryTimerRef.current !== null) return;
      boardRetryTimerRef.current = setTimeout(() => {
        boardRetryTimerRef.current = null;
        void refreshBoard();
      }, delayMs);
    };
    const settle = (state: BoardListState, listed?: BoardTaskWithConflicts[], closedMore = false, version?: string) => {
      if (seq <= boardAppliedSeqRef.current) return;
      // A failed read applies nothing, so it never holds off an older read still in flight.
      if (state === "failed" || state === "unavailable") {
        // A held waiting-only list is not the board, so a whole-list failure over it shows.
        const applied = boardAppliedStateRef.current;
        const overWaiting = full && !boardAppliedFullRef.current && (applied === "ok" || applied === "team");
        setBoardListState((cur) => (cur === "pending" || cur === "failed" || overWaiting ? state : cur));
        // A collector without the board routes (or a passing 404 mid-upgrade) is asked again only now and then.
        retryIn(state === "failed" ? boardReadRetryDelay(boardRetryAttemptRef.current++) : REFUSED_RESYNC_INTERVAL_MS);
        return;
      }
      boardRetryAttemptRef.current = 0;
      boardVersionRef.current = version;
      // A refusal a restarting collector caused passes; read again now and then to see.
      if (state === "refused") retryIn(REFUSED_RESYNC_INTERVAL_MS);
      boardAppliedSeqRef.current = seq;
      boardAppliedStateRef.current = state;
      boardAppliedFullRef.current = full;
      setBoardFull(full);
      setBoardListState(state);
      setBoardListClosedMore(closedMore);
      const late = new Set<string>();
      const keepAfter = Math.min(issuedAt, ...boardPagesIssuedAtRef.current.values());
      for (const [id, at] of boardFramedAtRef.current) {
        if (at > issuedAt) late.add(id);
        if (at <= keepAfter) boardFramedAtRef.current.delete(id);
      }
      // Paged-in closed tasks belong to the viewer's own list.
      boardListEdgeRef.current = state === "ok" ? (oldestClosedCursor(listed ?? []) ?? null) : null;
      if (state !== "ok") {
        clearBoardOlder();
        if (state === "refused") setBoard((b) => ({ held: b.held.filter((t) => late.has(t.id)), older: [] }));
        else setBoard((b) => ({ held: mergeBoardList(listed ?? [], b.held, late), older: [] }));
        return;
      }
      setBoard((b) => settleBoardRead(b, listed ?? [], late));
    };
    boardReadsInFlightRef.current++;
    // The short timeout covers the wait for the response to start, so a large
    // board on a slow link still lands once the collector answers; the long
    // one bounds the whole read, so a body stalled on a dead connection fails
    // (and retries) rather than leaving the read in flight forever.
    const abort = new AbortController();
    const timedOut = () => abort.abort(new DOMException("board read timed out", "TimeoutError"));
    const timeout = setTimeout(timedOut, BOARD_READ_TIMEOUT_MS);
    const deadline = setTimeout(timedOut, BOARD_READ_DEADLINE_MS);
    return fetch(full ? "/api/board/tasks" : BOARD_WAITING_PATH, { signal: abort.signal })
      .then((r) => {
        clearTimeout(timeout);
        if (r.status === 401 || r.status === 403) return settle("refused");
        if (r.status === 404) return settle("unavailable");
        if (!r.ok) return settle("failed");
        return r.json().then((body) => {
          const list = boardListOf(body);
          return settle(list.scope === "team" ? "team" : "ok", list.tasks, list.more, boardVersionOf(body));
        });
      })
      .catch(() => settle("failed"))
      .finally(() => {
        clearTimeout(timeout);
        clearTimeout(deadline);
        boardReadsInFlightRef.current--;
      });
  };
  // The Board's part of the catch-up: one constant-time read of the board's
  // change counter, and a list re-read when it moved past the last read's.
  // board:task frames are addressed and unsequenced, so one the socket lost is
  // never replayed; this shows it within one catch-up interval. Skipped while
  // a read is in flight or already due, and until a read has landed (the
  // hello-ok's read and its retries fill the board first).
  const catchUpBoard = async () => {
    const busy = () => boardReadsInFlightRef.current > 0 || boardRetryTimerRef.current !== null || boardRefreshTimerRef.current !== null;
    if (boardVersionRef.current === undefined || busy()) return;
    // A list read issued while the version was being read settles the question itself.
    const issued = boardReadSeqRef.current;
    const res = await fetch("/api/board/version", { signal: AbortSignal.timeout(CATCH_UP_READ_TIMEOUT_MS) });
    if (!res.ok) return;
    const version = boardVersionOf(await res.json());
    if (version === undefined || version === boardVersionRef.current) return;
    if (busy() || boardReadSeqRef.current !== issued) return;
    void refreshBoard();
  };
  // Conflicts are computed only by the list route, so a board:task frame
  // re-reads the list shortly after — one read per burst of frames, and at
  // least one per max-wait window while frames keep coming — and the
  // conflict badges catch up.
  const boardRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const boardBurstStartRef = useRef<number | null>(null);
  const scheduleBoardRefresh = () => {
    const now = Date.now();
    if (boardBurstStartRef.current === null) boardBurstStartRef.current = now;
    if (boardRefreshTimerRef.current !== null) clearTimeout(boardRefreshTimerRef.current);
    boardRefreshTimerRef.current = setTimeout(() => {
      boardRefreshTimerRef.current = null;
      boardBurstStartRef.current = null;
      void refreshBoard();
    }, Math.max(0, boardRefreshDueAt(boardBurstStartRef.current, now) - now));
  };
  const visibleBoard = useMemo(() => withOlderClosed(board.held, board.older), [board]);
  const boardClosedMore = boardFull && boardListState === "ok" && (boardPageMore ?? boardListClosedMore);
  // A read of only the waiting tasks is not the board yet.
  const shownBoardListState: BoardListState =
    boardFull || (boardListState !== "ok" && boardListState !== "team") ? boardListState : "pending";
  // Paged-in closed tasks extend the list only under the filter they were
  // loaded with, so a switch to another filter clears them; the next page then
  // starts from the list's own oldest closed task under the new filter.
  const boardFilterChanged = useCallback((filter: BoardFilter) => {
    // The Board view tells its filter on mount: it has opened, so read the whole list.
    if (!boardOpenedRef.current) {
      boardOpenedRef.current = true;
      void refreshBoard();
    }
    const key = boardFilterKey(filter);
    boardViewFilterKeyRef.current = key;
    if (boardPageFilterKeyRef.current !== null && boardPageFilterKeyRef.current !== key) clearBoardOlder();
  }, []);
  // Reads the page of closed tasks matching the view's filter past the list
  // read's own closed edge, unfiltered (or past where the last page under this
  // filter said to go on), so matching cards older than everything loaded stay
  // reachable even when none loaded matches. The page is kept beside the list,
  // so a later list re-read leaves it in place. It is dropped when the board it
  // extends is gone by the time it lands — the read state changed, or the
  // paged-in tasks were cleared — or when it isn't the viewer's own; a task a
  // frame touched after the request is left to the frame, so a removed task
  // never comes back. Returns undefined when no read is sent: the list isn't
  // the viewer's own, the filter is on an open status (pages hold only closed
  // tasks), or the list served no closed task to page past.
  const loadOlderBoard = (filter: BoardFilter): Promise<void> | undefined => {
    const state = boardAppliedStateRef.current;
    if (state !== "ok") return undefined;
    if (filter.status && isOpenBoardStatus(filter.status)) return undefined;
    const key = boardFilterKey(filter);
    if (boardPageFilterKeyRef.current !== null && boardPageFilterKeyRef.current !== key) clearBoardOlder();
    const pagedIn = boardPageFilterKeyRef.current !== null;
    const cursor = (pagedIn ? boardPageNextRef.current : null) ?? boardListEdgeRef.current;
    if (!cursor) return undefined;
    const resets = boardOlderResetsRef.current;
    const issuedAt = boardEventRef.current;
    const token = ++boardPageTokenRef.current;
    boardPagesIssuedAtRef.current.set(token, issuedAt);
    return (async () => {
      try {
        const page = await readClosedPage(closedPagePath(cursor, filter));
        if (!page || page.scope !== "user") return;
        if (boardAppliedStateRef.current !== state || boardOlderResetsRef.current !== resets) return;
        if (boardViewFilterKeyRef.current !== null && boardViewFilterKeyRef.current !== key) return;
        const framedAt = boardFramedAtRef.current;
        const untouched = page.tasks.filter((t) => (framedAt.get(t.id) ?? 0) <= issuedAt);
        boardPageFilterKeyRef.current = key;
        boardPageNextRef.current = olderCursor(page.next, oldestClosedCursor(page.tasks)) ?? cursor;
        setBoard((b) => ({ ...b, older: appendClosedPage(b.older, untouched) }));
        setBoardPageMore(page.more);
      } catch {
        // A failed or timed-out page read leaves the button in place to try again.
      } finally {
        boardPagesIssuedAtRef.current.delete(token);
      }
    })();
  };
  useEffect(() => {
    boardMountedRef.current = true;
    return () => {
      // A read still in flight lands after unmount; it must not start a retry.
      boardMountedRef.current = false;
      if (boardRefreshTimerRef.current !== null) clearTimeout(boardRefreshTimerRef.current);
      if (boardRetryTimerRef.current !== null) clearTimeout(boardRetryTimerRef.current);
    };
  }, []);

  // The current socket sender and this client's presence, held in refs so the
  // stable setViewing/setTyping callbacks can send without re-subscribing.
  const sendRef = useRef<(data: string) => void>(() => {});
  const myPresenceRef = useRef<{ viewingSessionId: string | null; typing: boolean }>({
    viewingSessionId: null,
    typing: false,
  });

  const sendPresence = useCallback(() => {
    const { viewingSessionId, typing } = myPresenceRef.current;
    sendRef.current(JSON.stringify({ kind: "presence:set", viewingSessionId, typing }));
  }, []);

  const setViewing = useCallback(
    (sessionId: string | null) => {
      if (myPresenceRef.current.viewingSessionId === sessionId) return;
      myPresenceRef.current = { ...myPresenceRef.current, viewingSessionId: sessionId };
      sendPresence();
    },
    [sendPresence]
  );

  const setTyping = useCallback(
    (typing: boolean) => {
      if (myPresenceRef.current.typing === typing) return;
      myPresenceRef.current = { ...myPresenceRef.current, typing };
      sendPresence();
    },
    [sendPresence]
  );

  // Projects carry computed counts (knowledgeDocs, pendingDrafts). A
  // projects:updated frame carries them too, but not every change to a count
  // sends one, so those changes refetch here.
  const refreshProjects = () =>
    fetchJson("/api/projects", isList<ProjectWithCounts>)
      .then((list) => list && setProjects(list))
      .catch(() => {});

  // Persona isn't in the hello-ok snapshot; it boots and resyncs over its own
  // REST routes. The frame mark lets the reducer tell whether live frames
  // landed while the requests were in flight (then the response may be older
  // than what's held, and is merged rather than trusted). A resync whose reads
  // fail (the collector mid-restart) retries until it loads; a newer resync
  // supersedes an older one still retrying.
  const personaSyncRef = useRef(0);
  // Unmounting supersedes any resync still retrying.
  useEffect(
    () => () => {
      personaSyncRef.current++;
    },
    []
  );
  // When the latest resync (or the first-paint read) started. The first-paint
  // read starts with the first render: the Persona view's mount effect runs
  // before App's, and must see it as already under way.
  const personaSyncAtRef = useRef(Date.now());
  // Resolves whether a snapshot loaded.
  const syncPersona = useCallback((retryMs?: readonly number[]) => {
    const generation = ++personaSyncRef.current;
    personaSyncAtRef.current = Date.now();
    return syncPersonaSnapshot({
      fetchSnapshot: () => fetchPersonaSnapshot(fetch, personaThreadRef.current),
      apply: (snapshot, frameMark) => dispatchPersona({ type: "snapshot", snapshot, frameMark }),
      frameMark: () => personaFramesRef.current,
      current: () => personaSyncRef.current === generation,
      retryMs,
    });
  }, []);
  const refreshPersona = useCallback(async () => {
    await syncPersona();
  }, [syncPersona]);
  // The Persona view opening: resynced unless a read started moments ago
  // already answers it (the boot's), which a second one would only repeat.
  const openPersona = useCallback(async () => {
    if (Date.now() - personaSyncAtRef.current < PERSONA_FRESH_MS) return;
    await syncPersona();
  }, [syncPersona]);

  // Persona's first read, at once and apart from the resyncs: the thread's
  // newest page, its state and the cards to decide, so the view paints before
  // the socket's snapshot or the jobs list. A resync that starts meanwhile
  // (the hello-ok's) doesn't discard it; both merge. The live socket opens
  // when it lands, or after SOCKET_HOLD_MS.
  const [socketReady, setSocketReady] = useState(false);
  useEffect(() => {
    let done = false;
    const open = () => {
      if (done) return;
      done = true;
      setSocketReady(true);
    };
    const hold = setTimeout(open, SOCKET_HOLD_MS);
    const frameMark = personaFramesRef.current;
    const generation = personaSyncRef.current;
    // The console thread, by the bare route, like the reads index.html started.
    void fetchPersonaSnapshot(withBootReads(fetch), null, null, { firstPaint: true })
      .then((snapshot) => {
        // A resync started after this read may already hold newer word: then
        // this one only adds (a mark no view has), and a failure or refusal
        // says nothing over the newer read's own word.
        if (personaSyncRef.current === generation) dispatchPersona({ type: "snapshot", snapshot, frameMark });
        else if (!snapshot.loadError && !snapshot.forbidden && !snapshot.disabledReason) {
          dispatchPersona({ type: "snapshot", snapshot, frameMark: -1, superseded: true });
        }
      })
      .catch(() => {})
      .finally(open);
    return () => {
      clearTimeout(hold);
      done = true;
    };
  }, []);
  // The catch-up's resync is one attempt; its next tick is the retry.
  const resyncPersonaOnce = useCallback(() => syncPersona([]), [syncPersona]);

  // Refetch every collection at once — the REST equivalent of a hello-ok
  // snapshot. Used as the boot fallback when the socket doesn't deliver a
  // snapshot, and to close a mid-stream seq gap where an unknown broadcast was
  // dropped (we can't know which collection it touched, so refetch all).
  const resyncAll = useCallback(async () => {
    // Pipeline, review and docs views hold their own data; have them re-read too.
    publishPipelineResync();
    publishReviewResync();
    publishDocsResync();
    try {
      const [
        projectsRes,
        sessionsRes,
        checkpointsRes,
        asksRes,
        launchesRes,
        ticketsRes,
      ] = await Promise.all([
        fetch("/api/projects"),
        fetch("/api/sessions?all=1"),
        fetch("/api/checkpoints"),
        fetch("/api/asks/pending"),
        fetch("/api/launches"),
        fetch("/api/tickets"),
      ]);
      await applyList(projectsRes, setProjects);
      await applyList(sessionsRes, setSessions);
      await applyList(checkpointsRes, setCheckpoints);
      await applyList(asksRes, setAsks);
      await applyList(launchesRes, setLaunches);
      await applyList(ticketsRes, setTickets);
      // Task runs aren't part of the hello-ok snapshot (they're a separate
      // ledger); fetch them alongside so the board is populated on boot/resync.
      void refreshTaskRuns();
      // Review findings are likewise fetched separately from the snapshot.
      void refreshFindings();
      void refreshReviewsPending();
      void refreshPersona();
      void refreshBoard();
      bootstrappedRef.current = true;
    } catch (err) {
      console.error("Failed to resync:", err);
    }
  }, [refreshPersona]);

  // Runs synchronously per message — unlike storing just the latest message
  // in state, this can't coalesce two broadcasts that land in the same task
  // (e.g. a hook firing ask:resolved immediately followed by checkpoint:new)
  // into only the last one being handled.
  const handleWsMessage = useCallback((message: WsMessage) => {
    switch (message.type) {
      case "session:start":
      case "session:end":
        refreshSessions();
        // A session lifecycle change (a launch reaching running, a reap) also
        // moves its task run — pull the ledger so the board tracks it.
        refreshTaskRuns();
        break;

      case "session:status": {
        refreshSessions();
        refreshTaskRuns();
        // A status broadcast also fires when a teammate joins a shared session
        // (POST /join records them as a participant). Bump the per-session
        // event signal so an open participant timeline refetches and the
        // teammate appears without a manual reload.
        const { sessionId } = message.payload as { sessionId?: string };
        if (sessionId) setLastEvent((prev) => ({ sessionId, n: prev.n + 1 }));
        break;
      }

      case "presence:state":
        setPresence(message.payload as PresenceEntry[]);
        break;

      case "persona:message":
      case "persona:state":
      case "persona:job":
      case "persona:approval":
      case "persona:activity":
        dispatchPersona({ type: "frame", message });
        break;

      case "persona:schedule":
        setScheduleSignal((n) => n + 1);
        break;

      case "review:updated":
        publishReviewUpdate(message.payload as ReviewUpdatedPayload);
        break;

      case "docs:changed":
        publishDocsChanged(message.payload as DocsChangedPayload);
        break;

      // Follows every review:updated, and also reaches a socket without the
      // Persona proof review:updated needs, so the badge and an open Review
      // list never wait on a reload.
      case "reviews:pending": {
        const { count } = message.payload as ReviewsPendingPayload;
        if (typeof count === "number") setReviewsPending(count);
        publishReviewResync();
        break;
      }

      case "task:updated": {
        const run = message.payload as TaskRun;
        setTaskRuns((prev) => {
          const i = prev.findIndex((x) => x.id === run.id);
          if (i === -1) return [run, ...prev];
          const next = prev.slice();
          next[i] = run;
          return next;
        });
        break;
      }

      // event:new is the coarse hook signal; session:event is the durable-log
      // nudge the collector pushes to every viewer when the transcript head
      // advances. Both mean "this session has new state" — bump
      // the per-session signal so the open transcript pulls just its delta and
      // appends it via the projection path, instead of waiting on the backstop.
      case "event:new":
      case "session:event": {
        const { sessionId } = message.payload as { sessionId: string };
        setLastEvent((prev) => ({ sessionId, n: prev.n + 1 }));
        break;
      }

      case "plan:updated":
        setPlanSignal((n) => n + 1);
        break;

      case "pipeline:updated":
        publishPipelineUpdate(message.payload as PipelineRun);
        break;

      case "board:task": {
        const boardFrame = message.payload as BoardTaskFrame;
        const framedId = boardFrame.removed?.id ?? boardFrame.task?.id;
        if (framedId) boardFramedAtRef.current.set(framedId, ++boardEventRef.current);
        setBoard((b) => {
          const held = upsertBoardTask(b.held, boardFrame);
          const older = applyFrameToOlder(b.older, boardFrame);
          return held === b.held && older === b.older ? b : { held, older };
        });
        scheduleBoardRefresh();
        break;
      }

      case "pipeline_config:updated":
        publishPipelineConfigUpdate(message.payload as PipelineConfigUpdatedPayload);
        break;

      case "checkpoint:new":
        setCheckpoints((prev) => {
          const c = message.payload as Checkpoint;
          return prev.some((x) => x.id === c.id) ? prev : [c, ...prev];
        });
        break;

      case "ask:new":
        // Dedup by id: the same broadcast can reach us more than once — a
        // socket that reconnects, or two live sockets left by StrictMode/HMR
        // in dev — and appending blindly stacked the same ask dozens of times,
        // which read as a flood of duplicate "blocked" events. The server is
        // the source of truth for how many asks exist; this just refuses to
        // show one twice.
        setAsks((prev) => {
          const ask = message.payload as Ask;
          return prev.some((a) => a.id === ask.id) ? prev : [ask, ...prev];
        });
        break;

      case "ask:resolved": {
        const { askId } = message.payload as { askId: string };
        setAsks((prev) => prev.filter((a) => a.id !== askId));
        break;
      }

      case "projects:updated":
        setProjects(message.payload as ProjectWithCounts[]);
        break;

      case "session:deleted":
        refreshSessions();
        break;

      case "launch:started":
      case "launch:stopped":
      case "launch:cleaned":
        refreshLaunches();
        // A launch creates/ends a task run; keep the board's ledger current.
        refreshTaskRuns();
        break;

      // A worker paused for idleness: its launch row changed and its session ended.
      case "launch:reaped":
        refreshLaunches();
        refreshSessions();
        break;

      case "ticket:new":
      case "ticket:updated": {
        const t = message.payload as Ticket;
        setTickets((prev) => {
          const i = prev.findIndex((x) => x.id === t.id);
          if (i === -1) return [t, ...prev];
          const next = prev.slice();
          next[i] = t;
          return next;
        });
        break;
      }

      case "finding:new":
      case "finding:updated": {
        const f = message.payload as ReviewFinding;
        setFindings((prev) => {
          const rest = prev.filter((x) => x.id !== f.id);
          // The queue holds only open High/critical findings: a dispatched or
          // dismissed one drops off, and low/medium never join.
          const surfaces =
            f.status === "open" && (f.severity === "high" || f.severity === "critical");
          return surfaces ? [f, ...rest] : rest;
        });
        break;
      }

      case "knowledge:draft": {
        const { projectId } = message.payload as { projectId: string };
        setDraftSignal((prev) => ({ projectId, n: prev.n + 1 }));
        // Covers both directions: a draft landing bumps pendingDrafts, an
        // accept bumps knowledgeDocs back down. Either way the sidebar
        // badge is stale until this runs.
        refreshProjects();
        break;
      }
    }
  }, []);

  // The server pushes a full snapshot on connect and on every reconnect. Boot
  // (and re-sync after a disconnect: tab backgrounded, laptop slept, server
  // restarted) straight from it — the snapshot is authoritative, so it also
  // closes whatever gap opened while the socket was down, replacing the old
  // per-collection reconnect refetch.
  const handleHello = useCallback(
    (payload: HelloOkPayload) => {
      const { snapshot } = payload;
      // Only a resumed hello-ok omits it, and that one goes to handleResume.
      if (!snapshot) return;
      setProjects(snapshot.projects);
      setSessions(snapshot.sessions);
      setCheckpoints(snapshot.checkpoints);
      setAsks(snapshot.asks);
      setLaunches(snapshot.launches);
      setTickets(snapshot.tickets);
      setActors(snapshot.actors);
      // Not in the snapshot — fetch the ledger the board reads.
      void refreshTaskRuns();
      // Nor the review-queue's findings.
      void refreshFindings();
      // Nor the Review tab's pending count.
      void refreshReviewsPending();
      // Nor Persona; refetching on every (re)connect closes whatever thread
      // and job updates were missed while the socket was down.
      void refreshPersona();
      // Nor the Board; its frames are owner-addressed and never replayed.
      void refreshBoard();
      // Nor pipeline runs: their frames are addressed to the run owner, so
      // the viewer's identity decides which unseen runs a frame may add.
      setPipelineViewer(payload.user);
      publishPipelineResync();
      // Nor the Review tab's packets: review:updated frames sent while the
      // socket was down are gone too. So are the Docs tab's docs:changed frames.
      publishReviewResync();
      publishDocsResync();
      // Identity for the facepile, and re-announce this client's presence so
      // the server (which lost per-connection state on the drop) re-learns what
      // we're viewing after a reconnect.
      setCurrentUser(payload.user);
      sendPresence();
      // On a reconnect, the panels driven by "changed" signals refetch too —
      // plan approvals, schedules, every open transcript and draft list — since
      // any signal frames sent while the socket was down are gone.
      if (bootstrappedRef.current) {
        setPlanSignal((n) => n + 1);
        setScheduleSignal((n) => n + 1);
        setLastEvent((prev) => ({ sessionId: ALL_TARGETS, n: prev.n + 1 }));
        setDraftSignal((prev) => ({ projectId: ALL_TARGETS, n: prev.n + 1 }));
      }
      bootstrappedRef.current = true;
      setLoading(false);
    },
    [sendPresence, refreshPersona]
  );

  // A resumed reconnect: the server replays the missed frames through
  // handleWsMessage, so the held collections stay; only what the replay never
  // carries is refetched, and presence is re-announced to the new connection.
  // persona:schedule frames are never replayed, so the schedules panel
  // refetches too.
  const handleResume = useCallback(
    (payload: HelloOkPayload) => {
      void refreshTaskRuns();
      void refreshFindings();
      void refreshPersona();
      // Review, pipeline, board and docs frames are addressed to one viewer
      // too, so the replay never carries them.
      void refreshBoard();
      void refreshReviewsPending();
      publishReviewResync();
      publishPipelineResync();
      publishDocsResync();
      setScheduleSignal((n) => n + 1);
      setCurrentUser(payload.user);
      sendPresence();
    },
    [sendPresence, refreshPersona]
  );

  // A mid-stream seq gap means a broadcast was dropped; refetch everything.
  const handleGap = useCallback(() => {
    resyncAll();
  }, [resyncAll]);

  // WebSocket for real-time updates. The endpoint follows the page origin (see
  // resolveWsUrl) so it works both locally and for a teammate reaching the host
  // through the tunnel, rather than a hardcoded localhost the tunnel can't reach.
  const { send, downSince, cause: downCause, retryNow, check } = useWebSocket(resolveWsUrl(), {
    onMessage: handleWsMessage,
    onHello: handleHello,
    onResume: handleResume,
    onGap: handleGap,
    // A socket replaced for going quiet: read back what it may have missed
    // now, without waiting for the new socket's handshake.
    onStale: () => catchUpRef.current?.now(),
  }, socketReady);
  // Keep the presence sender pointed at the live socket without re-subscribing.
  sendRef.current = send;

  // The safety net under the socket: Persona frames are addressed to one
  // viewer, so they carry no seq and are never replayed, and one lost on a
  // socket that still looks connected (or between reconnects) is otherwise
  // gone until a reload. While the page is visible — when it comes back, and
  // every 2s on screen, and at once when the socket drops — read the selected
  // thread's messages after the newest held. A resync that ran out of retries
  // is run again instead, and so (at most every 30s) is one that met a
  // refusal, which a restarting collector can cause. A read that finds a
  // message the socket never delivered pings the socket, so a dead one is
  // replaced now rather than at its next ping; that never dials a socket
  // that is down, so messages arriving during an outage don't each restart
  // the dial. The first read that succeeds while the socket is down re-dials
  // it now, once per outage, since the collector is answering again. Review frames are addressed the same way, so the Review
  // tab's pending count is read back too, and a count that moved re-reads the
  // open Review list. So are board:task frames: the Board's change counter is
  // read back, and one that moved re-reads the board (catchUpBoard).
  const retryNowRef = useRef(retryNow);
  retryNowRef.current = retryNow;
  const checkRef = useRef(check);
  checkRef.current = check;
  const catchUpBoardRef = useRef(catchUpBoard);
  catchUpBoardRef.current = catchUpBoard;
  const downSinceRef = useRef(downSince);
  downSinceRef.current = downSince;
  // Started once the console has booted (the hello-ok, or the REST fallback),
  // so its reads don't queue behind the collector building the snapshot.
  useEffect(() => {
    if (loading) return;
    let refusedResyncAt = Number.NEGATIVE_INFINITY;
    // The outage (its downSince) a catch-up answer already re-dialed for: once
    // per outage, so a socket the collector keeps refusing still backs off.
    // That one redial goes out at once (retryNow), past the wake gap a plain
    // wake keeps after a failure: the collector has just answered.
    let redialedFor: number | null = null;
    const catchUpReviews = async () => {
      const count = await getPendingCount(AbortSignal.timeout(CATCH_UP_READ_TIMEOUT_MS));
      if (count === reviewsPendingRef.current) return;
      setReviewsPending(count);
      publishReviewResync();
    };
    const catchUp = createCatchUp({
      run: async () => {
        // An open Docs tab re-reads its tree (one small read; nothing else listens).
        publishDocsResync();
        await Promise.allSettled([
          catchUpPersonaThread({
            view: () => personaRef.current,
            apply: (messages) => dispatchPersona({ type: "catchUp", messages }),
            resync: resyncPersonaOnce,
            refusedResyncDue: () => {
              if (Date.now() - refusedResyncAt < REFUSED_RESYNC_INTERVAL_MS) return false;
              refusedResyncAt = Date.now();
              return true;
            },
            onMissed: () => checkRef.current(),
            onAnswered: () => {
              const outage = downSinceRef.current;
              if (outage === null || outage === redialedFor) return;
              redialedFor = outage;
              retryNowRef.current();
            },
          }),
          catchUpReviews(),
          catchUpBoardRef.current(),
        ]);
      },
      wakeOn: [
        { source: document, events: ["visibilitychange"] },
        { source: window, events: ["online", "focus"] },
      ],
      isVisible: () => document.visibilityState !== "hidden",
    });
    catchUpRef.current = catchUp;
    return () => {
      catchUp.dispose();
      if (catchUpRef.current === catchUp) catchUpRef.current = null;
    };
  }, [resyncPersonaOnce, loading]);
  // A socket that just went down catches up at once rather than at the next tick.
  const socketDown = downSince !== null;
  useEffect(() => {
    if (socketDown) catchUpRef.current?.now();
  }, [socketDown, loading]);

  // A resync's page that doesn't reach what's held (more than a page missed
  // while the socket was down) leaves a hole mid-thread: fill it now rather
  // than at the next tick.
  const threadHasHole = persona.messages.length > 0 && catchUpFromSeq(persona.messages) !== maxSeq(persona.messages);
  useEffect(() => {
    if (threadHasHole && !persona.cached) catchUpRef.current?.now();
  }, [threadHasHole, persona.cached, persona.messages]);

  const presenceApi = useMemo<PresenceApi>(
    () => ({ roster: presence, currentUser, setViewing, setTyping }),
    [presence, currentUser, setViewing, setTyping]
  );

  // REST fallback: the snapshot normally boots the app within a beat of the
  // socket opening, but if hello-ok never lands (WS unreachable) fetch the
  // collections over REST so the tabs still fill in instead of staying on
  // their skeletons.
  useEffect(() => {
    if (!socketReady) return;
    const fallback = setTimeout(() => {
      if (!bootstrappedRef.current) {
        resyncAll().finally(() => setLoading(false));
      }
    }, 2500);
    return () => clearTimeout(fallback);
  }, [resyncAll, socketReady]);

  // The shell and Persona render at once; the other tabs show skeletons
  // until `booted` (the snapshot, or its REST fallback, has landed).
  return (
    <PresenceProvider value={presenceApi}>
    <ConnectionBanner downSince={downSince} cause={downCause} onRetry={retryNow} />
    <BuildUpdateBanner />
    <Console
      projects={projects}
      sessions={sessions}
      checkpoints={checkpoints}
      asks={asks}
      launches={launches}
      tickets={tickets}
      findings={findings}
      taskRuns={taskRuns}
      boardTasks={visibleBoard}
      boardListState={shownBoardListState}
      boardClosedMore={boardClosedMore}
      onLoadOlderBoard={loadOlderBoard}
      onBoardFilterChange={boardFilterChanged}
      actors={actors}
      lastEvent={lastEvent}
      draftSignal={draftSignal}
      planSignal={planSignal}
      scheduleSignal={scheduleSignal}
      reviewsPending={reviewsPending}
      persona={persona}
      onPersonaAction={dispatchPersona}
      onPersonaRefresh={refreshPersona}
      onPersonaOpen={openPersona}
      booted={!loading}
      onApproveTicket={async (id) => {
        // The board keeps its one-click "approve = start work" — approve now
        // decouples from dispatch server-side (default no launch), so opt into
        // the implementation launch explicitly with ?dispatch=true.
        const res = await fetch(`/api/tickets/${id}/approve?dispatch=true`, { method: "POST" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return { error: data.error ?? `Approve failed (${res.status})` };
        if (data.launch?.status === "failed") return { error: data.launch.error ?? "Launch failed" };
        return {};
      }}
      onDismissTicket={async (id) => {
        const res = await fetch(`/api/tickets/${id}/dismiss`, { method: "POST" });
        if (!res.ok) { const d = await res.json().catch(() => ({})); return { error: d.error ?? `Dismiss failed (${res.status})` }; }
        return {};
      }}
      onShipTicket={async (id) => {
        const res = await fetch(`/api/tickets/${id}/ship`, { method: "POST" });
        if (!res.ok) { const d = await res.json().catch(() => ({})); return { error: d.error ?? `Ship failed (${res.status})` }; }
        return {};
      }}
      onDispatchTicket={async (id, attempts) => {
        // attempts > 1 fans the dispatch out to N parallel best-of-N attempts
        // (each its own worktree + run, grouped for compare + pick); omitted/1 is
        // the single-launch path the server keeps unchanged.
        const res = await fetch(`/api/tickets/${id}/dispatch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(attempts && attempts > 1 ? { attempts } : {}),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return { error: data.error ?? `Dispatch failed (${res.status})` };
        if (data.launch?.status === "failed") return { error: data.launch.error ?? "Launch failed" };
        return {};
      }}
      onFetchAttempts={async (id) => {
        // The best-of-N compare view: each attempt's run + launch + worktree diff.
        const res = await fetch(`/api/tickets/${id}/attempts`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return { error: data.error ?? `Fetch attempts failed (${res.status})` };
        return { attempts: data.attempts };
      }}
      onPickAttempt={async (id, taskRunId) => {
        // Pick a winner: its branch becomes the ticket output; the others are
        // superseded (and their live panes stopped server-side).
        const res = await fetch(`/api/tickets/${id}/pick-attempt`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ taskRunId }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return { error: data.error ?? `Pick failed (${res.status})` };
        return {};
      }}
      onStatusTicket={async (id, status) => {
        // The decoupled status setter backs the board's rework edges (send a
        // needs_review ticket back to developing, restore a dismissed one).
        const res = await fetch(`/api/tickets/${id}/status`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        });
        if (!res.ok) { const d = await res.json().catch(() => ({})); return { error: d.error ?? `Status change failed (${res.status})` }; }
        return {};
      }}
      onPublishTicket={async (id) => {
        // The PR is the unit of output: fetch the DRY-RUN draft-PR preview
        // (branch, commit message + co-author trailers, PR title/body). The
        // server never pushes or calls gh — a live publish is a human step.
        const res = await fetch(`/api/tickets/${id}/publish`, { method: "POST" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return { error: data.error ?? `Publish preview failed (${res.status})` };
        return { preview: data.preview };
      }}
      onReviewCommentsTicket={async (id) => {
        // The review-comment counterpart to Publish: fetch the DRY-RUN reviews-
        // API payload — the ticket's High/critical findings mapped to inline
        // comments on the minted PR. The server never posts or calls gh — a live
        // post is a human step run from the returned command.
        const res = await fetch(`/api/tickets/${id}/review-comments`, { method: "POST" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return { error: data.error ?? `Review comments failed (${res.status})` };
        return { payload: data.payload };
      }}
      onFixFinding={async (id) => {
        // The ONE explicit, human-triggered path that fires a fixer: a fresh
        // session seeded with the finding + the reviewed diff. Never automatic.
        const res = await fetch(`/api/review-findings/${id}/fix`, { method: "POST" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return { error: data.error ?? `Fix dispatch failed (${res.status})` };
        if (data.launch?.status === "failed") return { error: data.launch.error ?? "Launch failed" };
        return {};
      }}
      onDismissFinding={async (id) => {
        const res = await fetch(`/api/review-findings/${id}/dismiss`, { method: "POST" });
        if (!res.ok) { const d = await res.json().catch(() => ({})); return { error: d.error ?? `Dismiss failed (${res.status})` }; }
        return {};
      }}
      onSessionChanged={refreshSessions}
      onSaveProject={async (id, patch) => {
        // Projects are broadcast back over the WebSocket on every mutation,
        // so there's no local state update here — the server is the source
        // of truth and pushes the new list to every connected client.
        const res = await fetch(id ? `/api/projects/${id}` : "/api/projects", {
          method: id ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          return { error: data.error ?? `Save failed (${res.status})` };
        }
        return {};
      }}
      onDeleteProject={async (id) => {
        const res = await fetch(`/api/projects/${id}`, { method: "DELETE" });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          return { error: data.error ?? `Delete failed (${res.status})` };
        }
        refreshSessions();
        return {};
      }}
      onLaunch={async (projectId, task, model, effort, inPlace, planGate, harness, codexModel, codexEffort, bypassPermissions, pipeline) => {
        // An empty projectId means "no project chosen": the project-less route
        // defaults to scratch and lets Haiku infer the real project.
        const url = projectId
          ? `/api/projects/${projectId}/launch`
          : "/api/launch";
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ task, model, effort, inPlace, planGate, harness, codexModel, codexEffort, bypassPermissions, pipeline }),
        });
        const data = await res.json();

        if (!res.ok) return { error: data.error ?? "Launch failed" };
        // A launch can also fail mid-flight after its row exists — the
        // response is 200 but the launch itself is marked failed.
        if (data.launch?.status === "failed") {
          return { error: data.launch.error ?? "Launch failed" };
        }

        refreshSessions();
        return { launchId: data.launch?.id };
      }}
    />
    </PresenceProvider>
  );
}
