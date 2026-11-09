import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import type {
  LaunchPipelineMode,
  ProjectWithCounts,
  Session,
  Checkpoint,
  Launch,
  ClaudeEffort,
  ClaudeModel,
  CodexEffort,
  HarnessId,
  Actor,
} from "@standup/shared";
import { WORKER_TMUX_SOCKET_HINT } from "@standup/shared";
import { LuCircleX, LuArrowLeftRight, LuChevronDown, LuChevronLeft, LuChevronUp } from "react-icons/lu";
import { alpha, theme, statusColors } from "./theme";
import { usePresence } from "../hooks/presence";
import { ViewingPips, StartedBy } from "./Facepile";
import { JoinThread } from "./JoinThread";
import { ClaimOwnershipButton, ParticipantTimeline } from "./ParticipantTimeline";
import { signalTargets } from "../lib/signal";
import {
  buildSessionTree,
  childSessions,
  consolidatedChildren,
  visibleChildren,
} from "../lib/sessionTree";
import { useExpandedSet } from "../hooks/useExpandedSet";
import { claudeModelLabel, launchModelEffortLabels } from "../lib/launchOptions";
import { ProjectIcon, ProjectAvatar } from "./ProjectIcon";
import { SilenceStrip } from "./SilenceStrip";
import { SessionControls } from "./SessionControls";
import { ClosableSessionRow } from "./CloseSession";
import { TranscriptView } from "./TranscriptView";
import { TerminalView } from "./TerminalView";
import { Composer } from "./Composer";
import { LaunchProgress, launchPhaseLabel } from "./LaunchProgress";
import { PlanApprovalPanel } from "./PlanApprovalPanel";
import { PipelineSection } from "./PipelineSection";
import type { WorkerSelection } from "../lib/liveWorkers";

export interface ListSections {
  first: string;
  rest: string;
  hasSession: (session: Session) => boolean;
  hasLaunch: (launch: Launch) => boolean;
}

export interface WorkViewProps {
  projects: ProjectWithCounts[];
  sessions: Session[];
  checkpoints: Checkpoint[];
  launches: Launch[];
  actors: Actor[];
  /** What the detail pane shows: a session, a sessionless launch, or (null) the new-chat composer. */
  selection: WorkerSelection;
  onSelect: (selection: WorkerSelection) => void;
  /** Bumped to start a fresh chat: clears the selection and focuses the composer. */
  newChatSignal?: number;
  /** Narrows the sidebar's root sessions; the detail pane still opens any session. */
  showSession?: (session: Session) => boolean;
  /** Narrows the sidebar's sessionless launches. */
  showLaunch?: (launch: Launch) => boolean;
  /** What the flat sidebar says when it lists nothing under the All lens. */
  emptyText?: ReactNode;
  /** Splits the sidebar into two labelled groups, the first group's rows on top. */
  sections?: ListSections;
  /** Extra lines under a flat sidebar row (what the session is working on). */
  rowDetail?: (session: Session) => ReactNode;
  /** Extra controls in the selected session's header, beside Details. */
  sessionAction?: (session: Session) => ReactNode;
  /** Phone width: shows the list or the detail pane, not both, with a back control. */
  narrow?: boolean;
  onSessionChanged: () => void;
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
  lastEvent: { sessionId: string; n: number };
  /** Bumped on plan:updated — refreshes the plan-approval panel. */
  planSignal: number;
}

export function WorkView({
  projects,
  sessions,
  checkpoints,
  launches,
  actors,
  selection,
  onSelect,
  newChatSignal = 0,
  showSession,
  showLaunch,
  emptyText,
  sections,
  rowDetail,
  sessionAction,
  narrow = false,
  onSessionChanged,
  onLaunch,
  lastEvent,
  planSignal,
}: WorkViewProps) {
  // The caller keeps the selection where it survives a refresh and can be
  // linked to. `kind` distinguishes a session from a still-provisioning
  // launch, since both open into the same detail pane and their ids would
  // otherwise be ambiguous.
  const kind = selection?.kind;
  const selectedId = selection?.id;

  // Projects you can start a session against — everything but the reserved
  // system corpora (the GLOBAL best-practices corpus has no repo to launch).
  // Drives the launch sidebar and the new-session picker; the full `projects`
  // list is still used to RESOLVE a session/launch's project name, so a reserved
  // project is never named-orphaned even though it can't be launched.
  const launchableProjects = projects.filter((p) => !p.reserved);

  // A sessionless launch (still provisioning, or failed before any session) —
  // selectable into the detail pane so its provision/build progress is
  // watchable while it runs.
  const selectedLaunchId = kind === "l" ? selectedId : undefined;
  // Only an explicit session selection selects a session. No selection opens
  // the detail pane on a focused "new chat" composer — the ChatGPT/Claude
  // landing.
  const selectedSession = kind === "s" ? selectedId ?? null : null;

  const setSelectedSession = (id: string) => onSelect({ kind: "s", id });
  const setSelectedLaunch = (id: string) => onSelect({ kind: "l", id });

  // Report which session this client is viewing so teammates see the pip
  // (Concept 1 presence). Cleared when the detail pane isn't on a session.
  const { setViewing, currentUser } = usePresence();
  useEffect(() => {
    setViewing(selectedSession ?? null);
    return () => setViewing(null);
  }, [selectedSession, setViewing]);

  const [detailTab, setDetailTab] = useState<
    "transcript" | "checkpoints" | "info"
  >("transcript");
  // Two renderings of the same conversation: the readable card view, and a
  // terminal view that mimics Claude Code's own TUI. Toggled within the
  // transcript tab so both stay one click apart.
  const [conversationMode, setConversationMode] = useState<
    "transcript" | "terminal"
  >("transcript");
  // A link opened to answer the session's ask (the alert strip's) lands on the
  // transcript, the one view that answers it.
  const { state: navState } = useLocation();
  useEffect(() => {
    if ((navState as { answer?: boolean } | null)?.answer) {
      setDetailTab("transcript");
      setConversationMode("transcript");
    }
  }, [navState]);
  // Bumped by "New chat" so the composer's task input focuses
  // even when the landing is already on screen and nothing would otherwise
  // remount.
  const [chatFocusSignal, setChatFocusSignal] = useState(0);
  // Bumped by "Jump in" (spec F) so the reply box grabs focus the moment you
  // join a teammate's thread — the join and the act are one gesture.
  const [replyFocusSignal, setReplyFocusSignal] = useState(0);

  // The detail pane's chrome — the parent breadcrumb, subagent chips, the
  // metadata row (status / model / harness / attribution / claim), the join
  // affordance, and the session controls (id, resume, stop, delete) — is useful
  // but stacks tall above the conversation. Collapsed by default so the chat
  // opens clean: a top-right "Details" toggle in the header reveals it, and a
  // compact status token keeps the essentials (status, model, subagent count,
  // ended) one click from the rest. Persisted across visits.
  const [chromeExpanded, setChromeExpanded] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("standup:workChromeExpanded") === "1";
  });
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(
        "standup:workChromeExpanded",
        chromeExpanded ? "1" : "0"
      );
    }
  }, [chromeExpanded]);

  // Which parents have their child (subagent) list expanded past the
  // consolidated default in the detail pane.
  const detailExpand = useExpandedSet();

  // At phone width only one pane shows: the detail when a session or launch is
  // selected or the new-chat composer was asked for, else the list. Following
  // the selection lets browser Back (which drops it) return to the list.
  const [narrowComposer, setNarrowComposer] = useState(false);
  useEffect(() => {
    if (selection) setNarrowComposer(false);
  }, [selection?.kind, selection?.id]);
  const narrowDetail = !!selection || narrowComposer;
  const showList = !narrow || !narrowDetail;
  const showDetail = !narrow || narrowDetail;
  const backToList = () => {
    setNarrowComposer(false);
    if (selection) onSelect(null);
  };

  // Start a fresh chat: clear the selection and focus the composer's task input.
  const startNewChat = () => {
    onSelect(null);
    setNarrowComposer(true);
    setChatFocusSignal((n) => n + 1);
  };
  const startNewChatRef = useRef(startNewChat);
  startNewChatRef.current = startNewChat;
  useEffect(() => {
    if (newChatSignal > 0) startNewChatRef.current();
  }, [newChatSignal]);

  // The sessions and sessionless launches the sidebar lists, narrowed by the
  // caller's filter. The detail pane still opens any session or launch (a
  // filtered sidebar doesn't lock you out of one you navigated to directly).
  const visibleSessions = showSession ? sessions.filter(showSession) : sessions;
  const visibleLaunches = showLaunch ? launches.filter(showLaunch) : launches;

  // Free-text sidebar filter over the visible sessions — the user works from a
  // long history and finds the older ones by searching rather than scrolling.
  const [query, setQuery] = useState("");

  // Resolves a session's project id to its display name so the filter can match
  // on the project the way the user reads it in the sidebar.
  const projectNameById = new Map(projects.map((p) => [p.id, p.name]));

  // Case-insensitive substring match against the fields a user scans by: the
  // title, the resolved project name, and the agent type. An empty query matches
  // everything (no filtering).
  const matchesQuery = (session: Session) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    const projectName = projectNameById.get(session.projectId) ?? "";
    return (
      (session.title ?? "").toLowerCase().includes(q) ||
      projectName.toLowerCase().includes(q) ||
      (session.agentType ?? "").toLowerCase().includes(q)
    );
  };

  // The root set feeding the sidebar, narrowed by the search box. Child
  // (subagent) resolution still reads the full `sessions` set, so a matched
  // parent keeps finding its children even when the query would exclude them.
  const filteredSessions = query.trim()
    ? visibleSessions.filter(matchesQuery)
    : visibleSessions;

  const selected = sessions.find((s) => s.id === selectedSession);
  const selectedProject = selected
    ? projects.find((p) => p.id === selected.projectId)
    : null;
  const selectedCheckpoints = checkpoints.filter(
    (c) => c.sessionId === selectedSession
  );
  // Only launched sessions have one — a monitored session was started by the
  // user in their own terminal, so there's no worktree/branch/tmux pane to
  // show beyond the working directory itself.
  const selectedLaunch = launches.find((l) => l.sessionId === selectedSession);
  // The launch selected directly (before it has a session) — its progress
  // view is shown in the detail pane.
  const openLaunch = launches.find((l) => l.id === selectedLaunchId);

  // Live model/effort label and harness for the selected session — shared by the
  // header's compact status token and its expanded metadata row. Per-harness: a
  // Codex session has no Claude transcript, so the live/Claude fields are unset
  // and it falls back to the launch's codex fields.
  const sessionHarness = selected?.harness ?? selectedLaunch?.harness;
  const modelEffort = selected
    ? launchModelEffortLabels(
        {
          harness: sessionHarness,
          liveModel: selected.liveModel,
          liveEffort: selected.liveEffort,
          model: selectedLaunch?.model,
          effort: selectedLaunch?.effort,
          codexModel: selectedLaunch?.codexModel,
          codexEffort: selectedLaunch?.codexEffort,
        },
        claudeModelLabel
      )
    : null;


  // Clears a sessionless launch (failed provisioning, or an abandoned
  // "starting"). The launch:cleaned broadcast refreshes the list, so the row
  // drops on its own — no local state to manage.
  const dismissLaunch = (id: string) => {
    void fetch(`/api/launches/${id}/cleanup`, { method: "POST" }).catch(() => {});
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
    {/* Plan-approval gate: any plan an agent is blocked on, surfaced above
        both panes so approving/editing it is one click regardless of what's
        selected, on a phone's list too. Renders nothing when none is pending;
        capped and scrolled so a pile of plans never squeezes the panes out. */}
    <div style={{ flexShrink: 0, maxHeight: "45%", overflowY: "auto" }}>
      <PlanApprovalPanel planSignal={planSignal} />
    </div>
    <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
      {/* Session history */}
      <div
        style={{
          width: narrow ? "100%" : 290,
          borderRight: narrow ? undefined : `1px solid ${theme.edge}`,
          overflowY: "auto",
          background: theme.surface,
          flexShrink: 0,
          display: showList ? undefined : "none",
        }}
      >
        <div
          style={{
            padding: "10px 12px",
            borderBottom: `1px solid ${theme.edgeSoft}`,
            position: "sticky",
            top: 0,
            background: theme.surface,
            zIndex: 1,
          }}
        >
          {/* Filters the session list by title, project name, or agent type —
              the way to reach older sessions past the first page. */}
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sessions…"
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "5px 9px",
              fontSize: 12,
              borderRadius: 6,
              border: `1px solid ${theme.edge}`,
              background: theme.ground,
              color: theme.text,
              outline: "none",
            }}
          />
        </div>

        <FlatSessionList
          projects={projects}
          sessions={filteredSessions}
          allSessions={sessions}
          launches={visibleLaunches}
          actors={actors}
          query={query}
          selectedSession={selectedSession ?? null}
          selectedLaunchId={selectedLaunchId ?? null}
          onOpenSession={setSelectedSession}
          onOpenLaunch={setSelectedLaunch}
          onDismissLaunch={dismissLaunch}
          onSessionChanged={onSessionChanged}
          emptyText={emptyText}
          rowDetail={rowDetail}
          sections={sections}
        />

        <div style={{ height: 20 }} />
      </div>

      {/* Detail pane. Column flex with minHeight 0 so each branch below owns
          its own scroll region (header/tabs stay put, only the tab content
          scrolls) rather than the whole pane scrolling as one block. No
          overflow here — a scrollable ancestor around an already-scrollable
          child just doubles the scrollbar and lets the header drift off
          with it. */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          display: showDetail ? "flex" : "none",
          flexDirection: "column",
        }}
      >
        {narrow && (
          <button
            data-testid="work-back-to-list"
            onClick={backToList}
            style={{
              display: "flex", alignItems: "center", gap: 6, minHeight: 44, padding: "0 14px", flexShrink: 0,
              background: theme.surface, border: "none", borderBottom: `1px solid ${theme.edgeSoft}`,
              color: theme.running, fontSize: 12.5, fontWeight: 600, cursor: "pointer", textAlign: "left",
            }}
          >
            <LuChevronLeft aria-hidden /> All workers
          </button>
        )}
        {selected ? (
          <>
            <div
              style={{
                padding: "18px 20px 14px",
                borderBottom: `1px solid ${theme.edgeSoft}`,
              }}
            >
              <div
                // When the pane is too narrow for the title and the controls, the
                // controls wrap under it; at phone width the title always has its own line.
                style={{ display: "flex", gap: 11, rowGap: 8, alignItems: "center", flexWrap: "wrap" }}
              >
                <ProjectAvatar project={selectedProject} size={30} fontSize={15} />
                <span
                  title={selected.title || "Untitled"}
                  style={{
                    fontSize: 17,
                    fontWeight: 700,
                    // Grow to fill the row so the status token and Details
                    // toggle sit at the top-right; clamp to one line so a long
                    // title can't push them off — minWidth:0 lets the flex child
                    // shrink to engage the ellipsis, full text on hover.
                    flex: narrow ? "1 0 calc(100% - 41px)" : "1 1 240px",
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {selected.agentType ? `${selected.agentType}: ` : ""}
                  {selected.title || "Untitled"}
                </span>

                {/* Compact status token — shown only while the chrome is
                    collapsed. Carries the essentials (status, model, harness,
                    subagent count, ended) without the tall metadata block, and
                    expands the full chrome on click so nothing is hidden away. */}
                {!chromeExpanded && (
                  <button
                    onClick={() => setChromeExpanded(true)}
                    title="Show session details"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 7,
                      flexShrink: 0,
                      maxWidth: narrow ? "100%" : "55%",
                      overflow: "hidden",
                      background: "none",
                      border: `1px solid ${theme.edge}`,
                      borderRadius: 999,
                      padding: "3px 10px",
                      cursor: "pointer",
                      fontFamily: theme.mono,
                      fontSize: 10.5,
                      color: theme.faint,
                    }}
                  >
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: 6,
                        background: statusColors[selected.status],
                        flexShrink: 0,
                      }}
                    />
                    <span
                      style={{
                        color: statusColors[selected.status],
                        textTransform: "uppercase",
                        letterSpacing: "0.08em",
                        flexShrink: 0,
                      }}
                    >
                      {selected.status}
                    </span>
                    {modelEffort && (
                      <span style={{ flexShrink: 0 }}>· {modelEffort.model}</span>
                    )}
                    {sessionHarness && sessionHarness !== "claude" && (
                      <span style={{ flexShrink: 0 }}>· {sessionHarness}</span>
                    )}
                    {(() => {
                      const subs = childSessions(sessions, selected.id).length;
                      return subs > 0 ? (
                        <span style={{ flexShrink: 0 }}>· {subs} sub</span>
                      ) : null;
                    })()}
                    {selected.endedAt && (
                      <span style={{ flexShrink: 0 }}>· ended</span>
                    )}
                  </button>
                )}

                {sessionAction?.(selected)}

                {/* Top-right toggle: reveal or hide the full session chrome. */}
                <button
                  onClick={() => setChromeExpanded((v) => !v)}
                  title={
                    chromeExpanded ? "Hide session details" : "Show session details"
                  }
                  style={{
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                    background: chromeExpanded ? theme.raised : "none",
                    border: `1px solid ${theme.edge}`,
                    borderRadius: 5,
                    padding: "4px 9px",
                    minHeight: narrow ? 44 : undefined,
                    cursor: "pointer",
                    fontSize: 11.5,
                    fontWeight: 600,
                    color: chromeExpanded ? theme.text : theme.faint,
                  }}
                >
                  {chromeExpanded ? <LuChevronUp /> : <LuChevronDown />}
                  Details
                </button>
              </div>

              {chromeExpanded && (
                <>
              {/* A subsession's breadcrumb back up to the parent that spawned it. */}
              {selected.parentSessionId && (() => {
                const parentId = selected.parentSessionId;
                const parent = sessions.find((s) => s.id === parentId);
                return (
                  <button
                    onClick={() => setSelectedSession(parentId)}
                    title="Open the parent session"
                    style={{
                      marginTop: 8,
                      background: "none",
                      border: "none",
                      padding: 0,
                      cursor: "pointer",
                      fontSize: 12,
                      color: theme.running,
                      display: "flex",
                      alignItems: "center",
                      gap: 5,
                      maxWidth: "100%",
                    }}
                  >
                    <span style={{ flexShrink: 0 }}>↑ parent:</span>
                    <span
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {parent?.title || "parent session"}
                    </span>
                  </button>
                );
              })()}

              {/* A root's spawned subagents, each a nested subsession.
                  Consolidated by default (running subagents, else the last
                  few); "show all" expands to the full set. Clicking a chip
                  drills into that child's own detail/history. */}
              {(() => {
                const total = childSessions(sessions, selected.id).length;
                if (total === 0) return null;
                const running = visibleChildren(sessions, selected.id, {
                  runningOnly: true,
                }).length;
                const expanded = detailExpand.expanded.has(selected.id);
                const subs = expanded
                  ? visibleChildren(sessions, selected.id)
                  : consolidatedChildren(sessions, selected.id);
                const hidden = total - subs.length;
                return (
                  <div style={{ marginTop: 10 }}>
                    <div
                      style={{
                        fontFamily: theme.mono,
                        fontSize: 10,
                        letterSpacing: "0.1em",
                        textTransform: "uppercase",
                        color: theme.faint,
                      }}
                    >
                      Subsessions (
                      {running > 0 ? `${running} active / ${total} total` : total})
                    </div>
                    <div
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        gap: 6,
                        marginTop: 6,
                      }}
                    >
                      {subs.map((sub) => (
                        <button
                          key={sub.id}
                          onClick={() => setSelectedSession(sub.id)}
                          title={sub.title || sub.agentType || "subsession"}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            background: theme.raised,
                            border: `1px solid ${theme.edge}`,
                            borderRadius: 5,
                            padding: "3px 8px",
                            cursor: "pointer",
                            fontSize: 11.5,
                            color: theme.text,
                            maxWidth: 220,
                          }}
                        >
                          <span
                            style={{
                              width: 6,
                              height: 6,
                              borderRadius: 6,
                              background: statusColors[sub.status],
                              flexShrink: 0,
                            }}
                          />
                          <span
                            style={{
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {sub.agentType || sub.title || "subsession"}
                          </span>
                        </button>
                      ))}
                      {(expanded || hidden > 0) && (
                        <button
                          onClick={() => detailExpand.toggle(selected.id)}
                          style={{
                            background: "none",
                            border: `1px solid ${theme.edge}`,
                            borderRadius: 5,
                            padding: "3px 8px",
                            cursor: "pointer",
                            fontSize: 11.5,
                            fontWeight: 600,
                            color: theme.faint,
                          }}
                        >
                          {expanded ? "show less" : `show all ${total}`}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })()}
              <div
                style={{
                  display: "flex",
                  gap: 15,
                  marginTop: 12,
                  alignItems: "center",
                  flexWrap: "wrap",
                  fontFamily: theme.mono,
                  fontSize: 11,
                  color: theme.faint,
                }}
              >
                <span
                  style={{
                    color: statusColors[selected.status],
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    fontSize: 10.5,
                  }}
                >
                  {selected.status}
                </span>
                {/* Live model and effort, read from the session's own
                    transcript/events (falling back to the launch's fields for a
                    harness with no Claude transcript). */}
                {modelEffort && (
                  <span title="Live model and effort, read from the session's own transcript/events">
                    {modelEffort.model} / {modelEffort.effort}
                  </span>
                )}
                {/* Which harness drove this session — shown only when it isn't
                    the default (claude), so a Claude session's row reads as before. */}
                {sessionHarness && sessionHarness !== "claude" ? (
                  <span title="Agent CLI that drove this session">{sessionHarness}</span>
                ) : null}
                {selected.endedAt && <span>ended</span>}
                <StartedBy
                  createdActor={selected.createdActor}
                  ownerActor={selected.ownerActor}
                  actors={actors}
                />
                <span style={{ flex: 1 }} />
                <ClaimOwnershipButton
                  session={selected}
                  currentUser={currentUser}
                  actors={actors}
                  onChanged={onSessionChanged}
                />
              </div>

              {/* Sessions are shared: this is the affordance to open and act in
                  someone else's thread, recording you as a participant (spec F).
                  Jumping in also lands focus in the reply box and swaps to the
                  transcript so the same click that joins lets you steer/reply. */}
              <JoinThread
                session={selected}
                actors={actors}
                currentUser={currentUser}
                onJoined={() => {
                  onSessionChanged();
                  setDetailTab("transcript");
                  setReplyFocusSignal((n) => n + 1);
                }}
              />

              <div style={{ marginTop: 14 }}>
                {/* Keyed so an open confirm never carries over to another session. */}
                <SessionControls key={selected.id} session={selected} onChanged={onSessionChanged} />
              </div>
                </>
              )}
            </div>

            {/* Tabs: checkpoints are the milestone spine, the transcript is
                the full conversation. Both are useful for different questions
                — "what has it achieved" vs "what exactly did it say". */}
            <div
              style={{
                display: "flex",
                gap: 2,
                padding: "10px 20px 0",
                borderBottom: `1px solid ${theme.edgeSoft}`,
              }}
            >
              {(["transcript", "checkpoints", "info"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setDetailTab(t)}
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    padding: "6px 12px",
                    border: "none",
                    borderBottom: `2px solid ${
                      detailTab === t ? theme.running : "transparent"
                    }`,
                    background: "none",
                    color: detailTab === t ? theme.text : theme.faint,
                    cursor: "pointer",
                    textTransform: "capitalize",
                  }}
                >
                  {t}
                  {t === "checkpoints" && selectedCheckpoints.length > 0 && (
                    <span style={{ color: theme.faint, marginLeft: 6 }}>
                      {selectedCheckpoints.length}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {detailTab === "transcript" ? (
              <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
                <div style={{ display: "flex", gap: 6, padding: "8px 20px 0" }}>
                  {(["transcript", "terminal"] as const).map((mode) => (
                    <button
                      key={mode}
                      onClick={() => setConversationMode(mode)}
                      style={{
                        fontFamily: theme.mono,
                        fontSize: 10.5,
                        padding: "3px 10px",
                        borderRadius: 4,
                        border: `1px solid ${
                          conversationMode === mode ? theme.edge : "transparent"
                        }`,
                        background: conversationMode === mode ? theme.surface : "none",
                        color: conversationMode === mode ? theme.text : theme.faint,
                        cursor: "pointer",
                        textTransform: "capitalize",
                      }}
                    >
                      {mode}
                    </button>
                  ))}
                </div>
                {conversationMode === "terminal" ? (
                  <TerminalView
                    key={selected.id}
                    sessionId={selected.id}
                    sessionEnded={!!selected.endedAt}
                    eventSignal={
                      signalTargets(lastEvent.sessionId, selected.id) ? lastEvent.n : 0
                    }
                    replyFocusSignal={replyFocusSignal}
                    onReplyFocused={() => setReplyFocusSignal(0)}
                    settings={selected}
                  />
                ) : (
                  <TranscriptView
                    key={selected.id}
                    sessionId={selected.id}
                    sessionEnded={!!selected.endedAt}
                    eventSignal={
                      signalTargets(lastEvent.sessionId, selected.id) ? lastEvent.n : 0
                    }
                    replyFocusSignal={replyFocusSignal}
                    onReplyFocused={() => setReplyFocusSignal(0)}
                    settings={selected}
                  />
                )}
              </div>
            ) : detailTab === "checkpoints" ? (
              <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "10px 0 24px" }}>
                {selectedCheckpoints.length === 0 ? (
                  <div
                    style={{
                      fontSize: 13,
                      color: theme.faint,
                      padding: "28px 20px",
                      lineHeight: 1.55,
                    }}
                  >
                    No checkpoints yet. Agents only report these if told to —
                    see docs/agent-instructions.md. Sessions launched from the
                    console are instructed automatically.
                  </div>
                ) : (
                  selectedCheckpoints.map((cp) => (
                    <div
                      key={cp.id}
                      style={{
                        padding: "9px 20px 5px",
                        display: "flex",
                        gap: 12,
                      }}
                    >
                      <div style={{ width: 34 }}>
                        <span
                          style={{
                            fontFamily: theme.mono,
                            fontSize: 9.5,
                            color: theme.faint,
                          }}
                        >
                          {new Date(cp.createdAt).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </div>
                      <div style={{ fontSize: 14, lineHeight: 1.55 }}>
                        {cp.source === "auto" && (
                          <span
                            style={{
                              fontFamily: theme.mono,
                              fontSize: 9,
                              letterSpacing: "0.1em",
                              textTransform: "uppercase",
                              color: theme.expert,
                              border: `1px solid ${alpha(theme.expert, 0x44)}`,
                              borderRadius: 3,
                              padding: "1px 5px",
                              marginRight: 7,
                              verticalAlign: 2,
                            }}
                          >
                            auto
                          </span>
                        )}
                        {cp.summary}
                      </div>
                    </div>
                  ))
                )}
              </div>
            ) : (
              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  overflowY: "auto",
                  padding: "18px 20px 24px",
                }}
              >
                <div style={{ marginBottom: 18 }}>
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      color: theme.dim,
                      marginBottom: 8,
                    }}
                  >
                    Participants
                  </div>
                  <ParticipantTimeline
                    session={selected}
                    currentUser={currentUser}
                    eventSignal={
                      signalTargets(lastEvent.sessionId, selected.id) ? lastEvent.n : 0
                    }
                  />
                </div>

                <div style={{ marginBottom: 18 }}>
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      color: theme.dim,
                      marginBottom: 6,
                    }}
                  >
                    Working directory
                  </div>
                  <div
                    title="cd into this to work alongside the agent"
                    style={{
                      fontFamily: theme.mono,
                      fontSize: 12.5,
                      color: theme.text,
                      userSelect: "all",
                      wordBreak: "break-all",
                    }}
                  >
                    {selected.cwd}
                  </div>
                </div>

                {selectedLaunch ? (
                  <>
                    <PipelineSection
                      key={selectedLaunch.id}
                      launchIds={[selectedLaunch.id]}
                      style={{ marginBottom: 18 }}
                    />
                    <div style={{ marginBottom: 18 }}>
                      <div
                        style={{
                          fontSize: 11,
                          fontWeight: 600,
                          color: theme.dim,
                          marginBottom: 6,
                        }}
                      >
                        Branch
                      </div>
                      <div
                        style={{
                          fontFamily: theme.mono,
                          fontSize: 12.5,
                          color: theme.text,
                        }}
                      >
                        {selectedLaunch.branch}{" "}
                        <span style={{ color: theme.faint }}>
                          ({selectedLaunch.kind})
                        </span>
                      </div>
                    </div>

                    {selectedLaunch.tmuxSession && (
                      <div>
                        <div
                          style={{
                            fontSize: 11,
                            fontWeight: 600,
                            color: theme.dim,
                            marginBottom: 6,
                          }}
                        >
                          Attach to the agent's terminal
                        </div>
                        <div
                          title="For a full interactive terminal"
                          style={{
                            fontFamily: theme.mono,
                            fontSize: 12.5,
                            color: theme.text,
                            userSelect: "all",
                          }}
                        >
                          TMUX= tmux -S {WORKER_TMUX_SOCKET_HINT} attach -t {selectedLaunch.tmuxSession}
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <div style={{ fontSize: 12.5, color: theme.faint, lineHeight: 1.55 }}>
                    You started this session in your own terminal, so there's
                    no worktree or tmux pane Standup owns — just the working
                    directory above.
                  </div>
                )}
              </div>
            )}
          </>
        ) : openLaunch ? (
          <LaunchProgress
            key={openLaunch.id}
            launchId={openLaunch.id}
            initialLaunch={openLaunch}
            onOpenSession={setSelectedSession}
          />
        ) : (
          // Nothing selected — the ChatGPT/Claude "new chat" landing. A focused
          // composer pinned below an empty canvas: pick a project, describe the
          // work, and an agent starts. Opening a session from the sidebar (or a
          // feed item) swaps this for that session's detail.
          <div
            style={{
              flex: 1,
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              style={{
                flex: 1,
                minHeight: 0,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 10,
                padding: "0 24px",
                textAlign: "center",
              }}
            >
              <div style={{ fontSize: 20, fontWeight: 700, color: theme.text }}>
                Start something new
              </div>
              <div
                style={{
                  fontSize: 13.5,
                  color: theme.dim,
                  lineHeight: 1.6,
                  maxWidth: 440,
                }}
              >
                Pick a project and describe a task to launch an agent — or open a session from the sidebar to follow one that's already running.
              </div>
            </div>
            {launchableProjects.length > 0 && (
              <Composer
                projects={launchableProjects}
                onLaunch={onLaunch}
                focusSignal={chatFocusSignal}
              />
            )}
          </div>
        )}
      </div>
    </div>
    </div>
  );
}

/**
 * The "show all N" / "show less" control under a consolidated child list. Sized
 * to sit inline with the nested child rows (paddingLeft aligns it under them),
 * so a root's collapsed subagents expand and re-collapse in place.
 */
function ChildListToggle({
  total,
  expanded,
  onToggle,
  paddingLeft,
}: {
  total: number;
  expanded: boolean;
  onToggle: () => void;
  paddingLeft: number;
}) {
  return (
    <button
      onClick={onToggle}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        background: "none",
        border: "none",
        padding: `3px 12px 7px ${paddingLeft}px`,
        cursor: "pointer",
        fontSize: 11,
        fontWeight: 600,
        color: theme.faint,
      }}
    >
      {expanded ? "show less" : `show all ${total}`}
    </button>
  );
}

/**
 * A single time-ordered list of every session across every project — the
 * default sidebar view. Merges sessionless launches (still provisioning, or
 * failed before any session existed) so a failed launch is visible from the
 * one place where work is listed, exactly as the grouped view surfaces them.
 *
 * Sort key is the most recent activity we have for a row: a session's
 * last-activity time (its latest transcript or event, else its start), or a
 * launch's created-at for a sessionless launch. Newest first — the same
 * direction a chat feed reads, so a session that just got a new message rises
 * to the top.
 */
function FlatSessionList({
  projects,
  sessions,
  allSessions,
  launches,
  actors,
  query,
  selectedSession,
  selectedLaunchId,
  onOpenSession,
  onOpenLaunch,
  onDismissLaunch,
  onSessionChanged,
  emptyText,
  rowDetail,
  sections,
}: {
  emptyText?: ReactNode;
  rowDetail?: (session: Session) => ReactNode;
  sections?: ListSections;
  projects: ProjectWithCounts[];
  sessions: Session[];
  allSessions: Session[];
  launches: Launch[];
  actors: Actor[];
  query: string;
  selectedSession: string | null;
  selectedLaunchId: string | null;
  onOpenSession: (id: string) => void;
  onOpenLaunch: (id: string) => void;
  onDismissLaunch: (id: string) => void;
  onSessionChanged: () => void;
}) {
  const projectById = new Map(projects.map((p) => [p.id, p]));

  // The list opens to a first page and grows on demand, so a large history
  // doesn't render hundreds of rows at once. Reset to the first page whenever the
  // search changes, since the row set the count applies to is now different.
  const [visibleCount, setVisibleCount] = useState(25);
  useEffect(() => {
    setVisibleCount(25);
  }, [query]);

  // Per-root expand toggle for the nested subagent lists (see useExpandedSet).
  const expand = useExpandedSet();

  // Subagent children don't get their own top-level row — they nest under their
  // parent. Top-level rows come from `sessions` (narrowed by the caller); each
  // root's children come from `allSessions` (the full set), so a child the
  // caller's filter would drop still nests under its listed root.
  const { roots } = buildSessionTree(sessions);

  // `group` 0 is the first section, 1 the rest (always 0 with no sections).
  type Row =
    | { kind: "session"; ts: number; group: number; session: Session }
    | { kind: "launch"; ts: number; group: number; launch: Launch };

  const rows: Row[] = [
    ...roots.map((s): Row => ({
      kind: "session",
      // Sort by the session's last-activity time (its latest transcript/event,
      // derived server-side), falling back to ended-at then started-at for a row
      // that carries none — so a new message bumps the session toward the top.
      ts: new Date(s.lastActivityAt ?? s.endedAt ?? s.startedAt).getTime(),
      group: sections && !sections.hasSession(s) ? 1 : 0,
      session: s,
    })),
    // Sessionless launches (still provisioning, or failed before a session
    // existed). Already narrowed by the caller, so this only drops
    // attached/cleaned ones.
    ...launches
      .filter((l) => !l.sessionId && l.status !== "cleaned")
      .map((l): Row => ({
        kind: "launch",
        ts: new Date(l.createdAt).getTime(),
        group: sections && !sections.hasLaunch(l) ? 1 : 0,
        launch: l,
      })),
  ].sort((a, b) => a.group - b.group || b.ts - a.ts);

  const visibleRows = rows.slice(0, visibleCount);
  const remaining = rows.length - visibleRows.length;
  const groupSize = [rows.filter((r) => r.group === 0).length, rows.filter((r) => r.group === 1).length];
  const sectionHeader = (group: number) =>
    sections && (
      <div
        key={`section-${group}`}
        data-testid={`work-section-${group}`}
        style={{
          fontFamily: theme.mono, fontSize: 9.5, letterSpacing: "0.12em", textTransform: "uppercase",
          color: theme.dim, padding: "10px 14px 4px",
        }}
      >
        {group === 0 ? sections.first : sections.rest} · {groupSize[group]}
      </div>
    );

  if (rows.length === 0) {
    return (
      <div style={{ padding: "16px 14px", fontSize: 12.5, color: theme.faint }}>
        {query.trim()
          ? `No sessions match “${query.trim()}”.`
          : emptyText ?? "No sessions yet. Start one with New chat."}
      </div>
    );
  }

  // One session row. `indent` renders a subagent child pushed in under its
  // parent with a ↳ marker (the flat view has no project header, so the child
  // still shows its own project icon).
  const renderRow = (session: Session, indent = false) => {
    const project = projectById.get(session.projectId);
    const isActive = selectedSession === session.id;
    const statusColor = statusColors[session.status];
    return (
      <button
        key={session.id}
        onClick={() => onOpenSession(session.id)}
        style={{
          width: "100%",
          textAlign: "left",
          background: isActive ? theme.raised : "transparent",
          border: "none",
          borderLeft: `2px solid ${isActive ? statusColor : "transparent"}`,
          padding: indent ? "6px 12px 6px 30px" : "8px 12px 8px 14px",
          cursor: "pointer",
          display: "block",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {indent && (
            <span style={{ color: theme.faint, fontSize: 11, flexShrink: 0 }}>↳</span>
          )}
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: 6,
              background: statusColor,
              flexShrink: 0,
            }}
          />
          <span
            style={{ fontSize: 12.5, flexShrink: 0 }}
            title={project?.name ?? "Unknown project"}
          >
            <ProjectIcon project={project} size={14} fallback="📦" />
          </span>
          <span
            title={session.title || "Untitled"}
            style={{
              fontSize: 12.5,
              color: theme.text,
              flex: 1,
              // A flex child won't shrink below its content width without this,
              // so the ellipsis never engages and a long title blows the row.
              minWidth: 0,
              lineHeight: 1.35,
              fontWeight: isActive ? 600 : 400,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {session.agentType ? `${session.agentType}: ` : ""}
            {session.title || "Untitled"}
          </span>
          {session.owned && (
            <span
              title="Standup owns this session's terminal"
              style={{
                fontSize: 11,
                color: theme.checkpoint,
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
              }}
            >
              <LuArrowLeftRight />
            </span>
          )}
          <ViewingPips sessionId={session.id} />
        </div>
        <div
          style={{
            marginTop: 5,
            paddingLeft: 14,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <SilenceStrip status={session.status} ticks={session.activityTicks} />
          {session.createdActor && (
            <StartedBy
              createdActor={session.createdActor}
              ownerActor={session.ownerActor}
              actors={actors}
              size={14}
              style={{ marginLeft: "auto" }}
            />
          )}
        </div>
        {!indent && rowDetail?.(session)}
      </button>
    );
  };

  return (
    <>
      {[0, 1].map((group) => visibleRows.some((r) => r.group === group) && [
        sectionHeader(group),
        ...visibleRows.filter((r) => r.group === group).map((row) => {
        if (row.kind === "launch") {
          const launch = row.launch;
          const project = projectById.get(launch.projectId);
          const isSelected = selectedLaunchId === launch.id;
          const failed = launch.status === "failed";
          return (
            <div key={launch.id} style={{ padding: "6px 12px" }}>
              {failed ? (
                <div
                  style={{
                    display: "flex",
                    gap: 6,
                    alignItems: "center",
                    fontSize: 12,
                    color: theme.waiting,
                  }}
                >
                  <LuCircleX style={{ flexShrink: 0 }} />
                  <span style={{ flexShrink: 0, fontSize: 11 }}>
                    <ProjectIcon project={project} size={14} fallback="📦" />
                  </span>
                  <span
                    style={{
                      flex: 1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {launch.task || "Launch"} failed
                  </span>
                  <button
                    onClick={() => onDismissLaunch(launch.id)}
                    title="Dismiss this failed launch"
                    style={{
                      background: "none",
                      border: "none",
                      padding: 0,
                      cursor: "pointer",
                      color: theme.faint,
                      fontSize: 13,
                      lineHeight: 1,
                    }}
                  >
                    ×
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => onOpenLaunch(launch.id)}
                  title="Watch this launch provision"
                  style={{
                    display: "flex",
                    width: "100%",
                    textAlign: "left",
                    gap: 6,
                    alignItems: "center",
                    fontSize: 12,
                    color: theme.running,
                    background: isSelected ? theme.raised : "none",
                    border: "none",
                    borderRadius: 4,
                    padding: "3px 6px",
                    cursor: "pointer",
                  }}
                >
                  <span style={{ flexShrink: 0 }}><ProjectIcon project={project} size={14} fallback="📦" /></span>
                  <span style={{ flexShrink: 0 }}>⧗ {launchPhaseLabel(launch)}</span>
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      color: theme.faint,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {launch.task}
                  </span>
                </button>
              )}
            </div>
          );
        }

        const session = row.session;
        const total = childSessions(allSessions, session.id).length;
        const expanded = expand.expanded.has(session.id);
        // Consolidated by default (running children, else the last few) so a
        // heavy fan-out doesn't dominate the flat stream; "show all" expands.
        const shownChildren = expanded
          ? visibleChildren(allSessions, session.id)
          : consolidatedChildren(allSessions, session.id);
        const hidden = total - shownChildren.length;
        return (
          <div key={session.id}>
            <ClosableSessionRow session={session} onClosed={onSessionChanged}>
              {renderRow(session)}
            </ClosableSessionRow>
            {shownChildren.map((child) => renderRow(child, true))}
            {(expanded || hidden > 0) && (
              <ChildListToggle
                total={total}
                expanded={expanded}
                onToggle={() => expand.toggle(session.id)}
                paddingLeft={30}
              />
            )}
          </div>
        );
      }),
      ])}
      {remaining > 0 && (
        <button
          onClick={() => setVisibleCount((n) => n + 25)}
          style={{
            display: "block",
            width: "100%",
            textAlign: "left",
            background: "none",
            border: "none",
            borderTop: `1px solid ${theme.edgeSoft}`,
            padding: "10px 14px",
            cursor: "pointer",
            fontSize: 12,
            fontWeight: 600,
            color: theme.running,
          }}
        >
          Show more ({remaining} remaining)
        </button>
      )}
    </>
  );
}
