import { Routes, Route, Navigate, NavLink, useLocation, useParams } from "react-router-dom";
import { resolveShortSessionId } from "@standup/shared";
import { Suspense, useEffect, useRef, type Dispatch, type ReactNode } from "react";
import type {
  LaunchPipelineMode,
  Session,
  Project,
  Checkpoint,
  Ask,
  Launch,
  ProjectWithCounts,
  ClaudeEffort,
  ClaudeModel,
  CodexEffort,
  HarnessId,
  Ticket,
  TicketStatus,
  TicketAttempt,
  TicketPublishPreview,
  ReviewCommentsPayload,
  ReviewFinding,
  TaskRun,
  Actor,
  BoardTaskWithConflicts,
} from "@standup/shared";
import {
  BoardView,
  BurrowView,
  DocsView,
  KnowledgeView,
  prefetchViews,
  ProjectsView,
  ReviewView,
  SchedulesView,
  YouView,
} from "./lazyViews";
import { LiveWorkersDrawer } from "./LiveWorkersDrawer";
import { waitingCount, type BoardFilter, type BoardListState } from "../lib/board";
import { liveWorkersPath, type WorkerSelection } from "../lib/liveWorkers";
import { LuSettings } from "react-icons/lu";
import { LEGACY_COST_PATH, LEGACY_SETTINGS_PATH } from "../lib/youSections";
import { useUnsavedDocs } from "../lib/unsavedDocs";
import { liveAgentCounts } from "../lib/sessionTree";
import { AlertStrip } from "./AlertStrip";
import { Facepile, UserAvatar } from "./Facepile";
import { ThemeToggle } from "./ThemeControl";
import { PersonaView } from "./PersonaView";
import { ViewBoundary, ViewLoading } from "./ViewBoundary";
import { ViewSkeleton } from "./Skeleton";
import { theme } from "./theme";
import {
  approvalsNeedingViewer,
  isPersonaOwner,
  personaLanding,
  viewerIsHost,
  type PersonaAction,
  type PersonaViewState,
} from "../lib/persona";
import { setOwnerSignInViewer } from "../lib/ownerSignIn";
import { usePresence } from "../hooks/presence";
import { useNarrow } from "../hooks/useNarrow";

// Persona leads: opening or refreshing Standup lands Persona's owner on the
// conversation with the always-on orchestrator, the way ChatGPT/Claude open on
// a chat (every other viewer lands on the Board's Live workers drawer).
// Schedules, the recurring jobs Persona runs, sits beside it. The Board (every
// job, ticket and backlog item as a card in its lifecycle column, with the
// Live workers drawer under it: the session list, each worker's transcript and
// a fresh "new chat" with a single agent) follows, then Review
// (packets awaiting human sign-off), then Projects and Knowledge, then Docs
// (the owner's own working documents), then the Burrow (every
// worker as a pixel-art bunny doing its pipeline stage). You (the viewer's own
// profile and cost, and every setting) is not a tab: it is the avatar-and-gear
// button at the bar's far end, an identity affordance rather than a work view.
// Tickets are the Board's ticket-sourced cards (/tickets opens the Board
// filtered to them), and cost and settings are sections of You; /tickets,
// /cost, /settings, /activity, /work, /feed and /blocked still resolve as deep
// links.
const VIEWS = ["persona", "schedules", "board", "review", "projects", "knowledge", "docs", "burrow"] as const;

// /tickets opens the Board filtered to ticket cards, keeping any other query
// it carries; ?view=dismissed opens it on the failed column, where a dismissed
// ticket sits.
function TicketsRedirect() {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  params.set("source", "ticket");
  if (params.get("view") === "dismissed") {
    params.delete("view");
    params.set("status", "failed");
  }
  return <Navigate to={`/board?${params.toString()}`} replace />;
}

// `/work`, `/work/s/:id` (a session) and `/work/l/:id` (a still-provisioning
// launch) open the Board's Live workers drawer on that selection; Slack, MCP
// and the alert strip link to them.
function WorkRedirect() {
  const { kind, selectedId } = useParams();
  const selection: WorkerSelection =
    selectedId && kind === "s" ? { kind, id: selectedId } : selectedId && kind === "l" ? { kind, id: selectedId } : null;
  return <Navigate to={liveWorkersPath(selection)} replace />;
}

// Resolves the short, shareable session address `/s/:shortId` (emitted from
// Slack and MCP tool responses) to that session in the Live workers drawer. An
// unresolved or ambiguous short id falls back to the open drawer rather than
// 404ing. On a cold load the sessions list is briefly empty while it streams
// in, so we hold on a "resolving" placeholder until sessions arrive rather than
// bouncing before the target session is even known.
function SessionShortLink({ sessions }: { sessions: Session[] }) {
  const { shortId } = useParams();
  const fullId = shortId
    ? resolveShortSessionId(shortId, sessions.map((s) => s.id))
    : undefined;
  if (fullId) return <Navigate to={liveWorkersPath({ kind: "s", id: fullId })} replace />;
  if (sessions.length === 0) {
    return (
      <div style={{ padding: 24, color: theme.dim, fontSize: 13 }}>Opening session…</div>
    );
  }
  return <Navigate to={liveWorkersPath()} replace />;
}

interface ConsoleProps {
  projects: ProjectWithCounts[];
  sessions: Session[];
  checkpoints: Checkpoint[];
  asks: Ask[];
  launches: Launch[];
  tickets: Ticket[];
  findings: ReviewFinding[];
  taskRuns: TaskRun[];
  /** The viewer's Board tasks, as the list route and board:task frames left them. */
  boardTasks: BoardTaskWithConflicts[];
  /** How the last board list read went. */
  boardListState?: BoardListState;
  /** Whether the route holds closed tasks older than the ones loaded. */
  boardClosedMore?: boolean;
  /** Reads the next page of older closed tasks matching the board's filter onto the board; undefined when no read is sent. */
  onLoadOlderBoard?: (filter: BoardFilter) => Promise<void> | undefined;
  /** Told the Board view's filter on mount and whenever it changes. */
  onBoardFilterChange?: (filter: BoardFilter) => void;
  actors: Actor[];
  onApproveTicket: (id: string) => Promise<{ error?: string }>;
  onDismissTicket: (id: string) => Promise<{ error?: string }>;
  onShipTicket: (id: string) => Promise<{ error?: string }>;
  onDispatchTicket: (id: string, attempts?: number) => Promise<{ error?: string }>;
  onFetchAttempts: (id: string) => Promise<{ error?: string; attempts?: TicketAttempt[] }>;
  onPickAttempt: (id: string, taskRunId: string) => Promise<{ error?: string }>;
  onStatusTicket: (id: string, status: TicketStatus) => Promise<{ error?: string }>;
  onPublishTicket: (id: string) => Promise<{ error?: string; preview?: TicketPublishPreview }>;
  onReviewCommentsTicket: (id: string) => Promise<{ error?: string; payload?: ReviewCommentsPayload }>;
  onFixFinding: (id: string) => Promise<{ error?: string }>;
  onDismissFinding: (id: string) => Promise<{ error?: string }>;
  onLaunch: (
    projectId: string,
    task: string,
    model?: ClaudeModel,
    effort?: ClaudeEffort,
    inPlace?: boolean,
    planGate?: boolean,
    harness?: HarnessId,
    codexModel?: string,
    codexEffort?: CodexEffort,
    bypassPermissions?: boolean,
    pipeline?: LaunchPipelineMode | boolean
  ) => Promise<{ error?: string; launchId?: string }>;
  onSaveProject: (
    id: string | null,
    patch: Partial<Project>
  ) => Promise<{ error?: string }>;
  onDeleteProject: (id: string) => Promise<{ error?: string }>;
  onSessionChanged: () => void;
  lastEvent: { sessionId: string; n: number };
  draftSignal: { projectId: string; n: number };
  /** Bumped on every plan:updated frame — refreshes the Live workers plan-approval panel. */
  planSignal: number;
  /** Bumped on every persona:schedule frame — refreshes the Schedules page. */
  scheduleSignal: number;
  /** Review packets awaiting a decision — the Review tab's badge. */
  reviewsPending?: number;
  persona: PersonaViewState;
  onPersonaAction: Dispatch<PersonaAction>;
  onPersonaRefresh: () => Promise<void>;
  /** Run when the Persona view opens (see PersonaView's `onOpen`). */
  onPersonaOpen?: () => Promise<void>;
  /**
   * The console's snapshot (sessions, projects, asks, …) has landed. Until
   * then the tabs that read it show skeletons; Persona doesn't wait on it.
   */
  booted?: boolean;
}

export function Console({
  projects,
  sessions,
  checkpoints,
  asks,
  launches,
  tickets,
  findings,
  taskRuns,
  boardTasks,
  boardListState,
  boardClosedMore,
  onLoadOlderBoard,
  onBoardFilterChange,
  actors,
  onApproveTicket,
  onDismissTicket,
  onShipTicket,
  onDispatchTicket,
  onFetchAttempts,
  onPickAttempt,
  onStatusTicket,
  onPublishTicket,
  onReviewCommentsTicket,
  onFixFinding,
  onDismissFinding,
  onLaunch,
  onSaveProject,
  onDeleteProject,
  onSessionChanged,
  lastEvent,
  draftSignal,
  planSignal,
  scheduleSignal,
  reviewsPending = 0,
  persona,
  onPersonaAction,
  onPersonaRefresh,
  onPersonaOpen,
  booted = true,
}: ConsoleProps) {
  // A tab that reads the console's snapshot, or its skeleton until it lands.
  const whenBooted = (view: ReactNode) => (booted ? view : <ViewSkeleton />);
  const pendingAsks = asks.filter((a) => a.status === "pending");
  const agentCounts = liveAgentCounts(sessions);
  const boardWaiting = waitingCount(boardTasks);
  const { currentUser } = usePresence();
  // The badge counts the pending cards the viewer must decide themselves (their
  // own, and any they decide for another's), not ones waiting on someone else;
  // a viewer with no Persona sees none.
  const personaNeedsYou = isPersonaOwner(persona, currentUser)
    ? approvalsNeedingViewer(persona.approvals, persona.state?.owner).length
    : 0;
  const landing = personaLanding(persona, currentUser);
  // Text a closed doc couldn't save waits in the Docs tab until it is dismissed.
  const unsavedDocCount = useUnsavedDocs().length;
  // Lets the owner sign-in notice tell a host's refusal from a guest's.
  const hostViewer = viewerIsHost(persona, currentUser);
  useEffect(() => {
    setOwnerSignInViewer(hostViewer);
  }, [hostViewer]);
  const narrow = useNarrow();
  const tabsRef = useRef<HTMLDivElement>(null);
  const { pathname, search } = useLocation();
  useEffect(() => {
    tabsRef.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [pathname, narrow]);
  // The snapshot has landed; warm the other tabs' chunks in the background,
  // after the boot's own reads rather than alongside them.
  useEffect(() => (booted ? prefetchViews() : undefined), [booted]);

  return (
    <div
      data-testid="console-shell"
      style={{
        background: theme.ground,
        color: theme.text,
        // A hard height (not minHeight) plus overflow hidden is what makes
        // the top bar and alert strip genuinely stay put — anything taller
        // than the viewport has to scroll inside "Main content" below,
        // never the document itself. minHeight let the whole page grow
        // instead, so the header scrolled away with everything else.
        height: "100vh",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Top bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: narrow ? "wrap" : undefined,
          gap: narrow ? "8px 12px" : 16,
          padding: narrow ? "9px 12px" : "11px 16px",
          borderBottom: `1px solid ${theme.edge}`,
          background: theme.surface,
        }}
      >
        <div
          style={{
            fontFamily: theme.mono,
            fontSize: 12,
            letterSpacing: "0.2em",
            textTransform: "uppercase",
            fontWeight: 700,
            color: theme.accent,
          }}
        >
          Standup
        </div>
        <div
          style={{
            display: "flex",
            gap: 13,
            fontSize: 12.5,
            color: theme.dim,
            whiteSpace: "nowrap",
          }}
          title="Open top-level sessions across every project and owner, by status — ended sessions are not counted"
        >
          <span>
            <span data-testid="agent-count" style={{ color: theme.text, fontWeight: 600 }}>
              {booted ? agentCounts.running : "–"}
            </span>{" "}
            running
          </span>
          {agentCounts.waiting > 0 && (
            <span>
              <span style={{ color: theme.text, fontWeight: 600 }}>
                {agentCounts.waiting}
              </span>{" "}
              waiting
            </span>
          )}
          <span>
            <span style={{ color: theme.text, fontWeight: 600 }}>
              {booted ? agentCounts.idle : "–"}
            </span>{" "}
            idle
          </span>
          {agentCounts.done > 0 && (
            <span>
              <span style={{ color: theme.text, fontWeight: 600 }}>
                {agentCounts.done}
              </span>{" "}
              done
            </span>
          )}
          {agentCounts.stalled > 0 && (
            <span style={{ color: theme.stalled }}>
              {agentCounts.stalled} stalled
            </span>
          )}
        </div>
        <div style={{ flex: 1 }} />
        <Facepile />
        {/* Scrolls sideways rather than wrapping when a phone is too narrow
            for every tab; on a phone it takes its own full-width row under
            the brand, with the current tab scrolled into view. */}
        <div
          ref={tabsRef}
          style={{
            display: "flex",
            gap: 2,
            minWidth: 0,
            overflowX: "auto",
            ...(narrow ? { order: 10, flexBasis: "100%" } : {}),
          }}
        >
          {VIEWS.map((v) => (
            <NavLink
              key={v}
              to={`/${v}`}
              style={({ isActive }) => ({
                fontSize: 12.5,
                fontWeight: 600,
                padding: "5px 12px",
                borderRadius: 5,
                textDecoration: "none",
                background: isActive ? theme.raised : "transparent",
                color: isActive ? theme.text : theme.faint,
                display: "flex",
                alignItems: "center",
                gap: 6,
                textTransform: "capitalize",
                whiteSpace: "nowrap",
                flexShrink: 0,
              })}
            >
              {v}
              {v === "persona" && personaNeedsYou > 0 && (
                <span
                  title={`${personaNeedsYou} awaiting your approval`}
                  style={{
                    fontSize: 10.5,
                    fontWeight: 700,
                    minWidth: 16,
                    padding: "0 5px",
                    borderRadius: 8,
                    background: theme.waiting,
                    color: theme.ground,
                    textAlign: "center",
                  }}
                >
                  {personaNeedsYou}
                </span>
              )}
              {v === "review" && reviewsPending > 0 && (
                <span
                  data-testid="review-tab-badge"
                  title={`${reviewsPending} review${reviewsPending === 1 ? "" : "s"} awaiting a decision`}
                  style={{
                    fontSize: 10.5,
                    fontWeight: 700,
                    minWidth: 16,
                    padding: "0 5px",
                    borderRadius: 8,
                    background: theme.waiting,
                    color: theme.ground,
                    textAlign: "center",
                  }}
                >
                  {reviewsPending}
                </span>
              )}
              {v === "board" && boardWaiting > 0 && (
                <span
                  data-testid="board-tab-badge"
                  title={`${boardWaiting} task${boardWaiting === 1 ? "" : "s"} waiting on you`}
                  style={{
                    fontSize: 10.5,
                    fontWeight: 700,
                    minWidth: 16,
                    padding: "0 5px",
                    borderRadius: 8,
                    background: theme.waiting,
                    color: theme.ground,
                    textAlign: "center",
                  }}
                >
                  {boardWaiting}
                </span>
              )}
              {v === "docs" && unsavedDocCount > 0 && (
                <span
                  data-testid="docs-tab-badge"
                  title={`Unsaved text from ${unsavedDocCount} doc${unsavedDocCount === 1 ? "" : "s"} is waiting in Docs`}
                  style={{
                    fontSize: 10.5,
                    fontWeight: 700,
                    minWidth: 16,
                    padding: "0 5px",
                    borderRadius: 8,
                    background: theme.waiting,
                    color: theme.ground,
                    textAlign: "center",
                  }}
                >
                  {unsavedDocCount}
                </span>
              )}
            </NavLink>
          ))}
        </div>
        <ThemeToggle />
        <NavLink
          to="/you"
          title="You — your profile, usage and every setting"
          aria-label="You and settings"
          style={({ isActive }) => ({
            marginLeft: 10,
            display: "flex",
            alignItems: "center",
            gap: 7,
            flexShrink: 0,
            padding: currentUser ? "3px 9px 3px 4px" : "5px 9px",
            borderRadius: 5,
            border: `1px solid ${isActive ? theme.accent : theme.edge}`,
            background: isActive ? theme.accentSoft : "transparent",
            color: isActive ? theme.text : theme.dim,
            fontSize: 12.5,
            fontWeight: 600,
            textDecoration: "none",
            whiteSpace: "nowrap",
          })}
        >
          {currentUser && (
            <span aria-hidden style={{ display: "inline-flex" }}>
              <UserAvatar user={currentUser} size={20} />
            </span>
          )}
          {/* On a phone it shrinks to the avatar and gear, so it fits the brand row. */}
          {!narrow && "You"}
          <LuSettings size={13} aria-hidden />
        </NavLink>
      </div>

      {/* It says what's blocked, so it waits for the snapshot that knows. */}
      {booted && (
        <AlertStrip
          pendingAsks={pendingAsks}
          sessions={sessions}
          projects={projects}
        />
      )}

      {/* Main content */}
      <div style={{ flex: 1, overflow: "hidden" }}>
        {/* Every tab but Persona is its own chunk (see lazyViews.ts): a
            first visit shows ViewLoading while it downloads, and a chunk that
            fails to load takes down only its own tab. */}
        {/* Any navigation (another tab, another session, a filter in the
            query) clears a failed view. */}
        <ViewBoundary resetKey={pathname + search}>
        <Suspense fallback={<ViewLoading />}>
        <Routes>
          {/* Persona's owner lands on its conversation; everyone else on
              the Board's Live workers drawer, open on every session (they
              have no Persona work of their own to filter to). Nothing renders
              until the first Persona snapshot settles which. */}
          <Route
            path="/"
            element={landing ? <Navigate to={landing === "/work" ? liveWorkersPath(null, true) : landing} replace /> : null}
          />
          {/* The conversation with Persona, the always-on orchestrator: its
              thread, held approvals, and the jobs it is running. */}
          <Route
            path="/persona"
            element={
              <PersonaView
                persona={persona}
                sessions={sessions}
                onAction={onPersonaAction}
                onRefresh={onPersonaRefresh}
                onOpen={onPersonaOpen}
              />
            }
          />
          {/* Persona's recurring schedules and pending one-time wakeups. */}
          <Route
            path="/schedules"
            element={whenBooted(
              <SchedulesView
                persona={persona}
                projects={projects}
                threads={persona.threads}
                consoleThreadId={persona.consoleThreadId}
                signal={scheduleSignal}
              />
            )}
          />
          {/* Short, shareable session address — a Slack link or MCP tool
              response points here; it resolves the short id to the full
              session and opens it in the Live workers drawer. */}
          <Route path="/s/:shortId" element={whenBooted(<SessionShortLink sessions={sessions} />)} />
          <Route path="/work/:kind?/:selectedId?" element={<WorkRedirect />} />
          {/* Review packets awaiting human sign-off; the selected packet
              (/review/:id) lives in the path so it survives a refresh. */}
          <Route path="/review/:id?" element={<ReviewView />} />
          {/* The owner's docs; the open doc (/docs/:id) lives in the path. */}
          <Route path="/docs/:id?" element={<DocsView />} />
          {/* /activity deep links resolve to the viewer's default view. */}
          <Route path="/activity" element={<Navigate to="/" replace />} />
          <Route
            path="/knowledge"
            element={whenBooted(<KnowledgeView projects={projects} draftSignal={draftSignal} />)}
          />
          {/* Old Feed links (/feed, /feed?filter=blocked, /blocked) resolve to
              the viewer's default view. */}
          <Route path="/feed" element={<Navigate to="/" replace />} />
          <Route path="/blocked" element={<Navigate to="/" replace />} />
          {/* The Burrow: each worker as a bunny doing its current stage. */}
          <Route
            path="/burrow"
            element={whenBooted(
              <BurrowView sessions={sessions} launches={launches} asks={asks} jobs={persona.jobs}
                personaLoaded={Boolean(persona.jobsLoaded || persona.disabledReason || persona.loadError || persona.forbidden)}
              />
            )}
          />
          {/* The Board: every job, ticket and backlog item in its lifecycle
              column. Its filters live in the query so a link (e.g. /tickets'
              ?source=ticket) opens it pre-filtered. The Live workers drawer
              sits under the columns. */}
          <Route
            path="/board"
            element={whenBooted(
              <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
              <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
              <BoardView
                tasks={boardTasks}
                listState={boardListState}
                closedMore={boardClosedMore}
                onLoadOlder={onLoadOlderBoard}
                onFilterChange={onBoardFilterChange}
                tickets={tickets}
                findings={findings}
                sessions={sessions}
                projects={projects}
                launches={launches}
                taskRuns={taskRuns}
                ticketActions={{
                  onApprove: onApproveTicket,
                  onDismiss: onDismissTicket,
                  onShip: onShipTicket,
                  onDispatch: onDispatchTicket,
                  onFetchAttempts,
                  onPickAttempt,
                  onStatus: onStatusTicket,
                  onPublish: onPublishTicket,
                  onReviewComments: onReviewCommentsTicket,
                  onFixFinding,
                  onDismissFinding,
                }}
              />
              </div>
              <LiveWorkersDrawer
                jobs={persona.jobs}
                boardTasks={boardTasks}
                // Their own work: Persona's owner, or a viewer the Board serves their own tasks; assumed
                // while the Persona snapshot loads, so the owner's filtered list doesn't flash.
                ownWork={!persona.loaded || isPersonaOwner(persona, currentUser) || boardListState === "ok"}
                readCommitments={isPersonaOwner(persona, currentUser) && !persona.disabledReason}
                projects={projects}
                sessions={sessions}
                checkpoints={checkpoints}
                launches={launches}
                actors={actors}
                onSessionChanged={onSessionChanged}
                onLaunch={onLaunch}
                lastEvent={lastEvent}
                planSignal={planSignal}
              />
              </div>
            )}
          />
          <Route path="/tickets" element={<TicketsRedirect />} />
          {/* Project selection lives in the path (prefix "p") so it survives a
              refresh. */}
          <Route
            path="/projects/:kind?/:selectedId?"
            element={whenBooted(
              <ProjectsView
                projects={projects}
                onSaveProject={onSaveProject}
                onDeleteProject={onDeleteProject}
              />
            )}
          />
          {/* Cost is the You tab's usage section; old /cost links land there. */}
          <Route path="/cost" element={<Navigate to={LEGACY_COST_PATH} replace />} />
          {/* Settings are the You tab's Workspace sections; /settings lands there. */}
          <Route path="/settings/*" element={<Navigate to={LEGACY_SETTINGS_PATH} replace />} />
          {/* The viewer's own page — profile, cost and usage, and every
              setting — with the section in the path. Each section
              self-fetches, so it takes no props from the console shell. */}
          <Route path="/you/:section?" element={<YouView />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </Suspense>
        </ViewBoundary>
      </div>
    </div>
  );
}
