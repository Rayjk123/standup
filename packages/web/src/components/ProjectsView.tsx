import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import type {
  Project,
  ProjectWithCounts,
  Session,
  Checkpoint,
  Launch,
  ClaudeEffort,
  ClaudeModel,
} from "@standup/shared";
import { LuBox, LuCircleX, LuArrowLeftRight } from "react-icons/lu";
import { theme, statusColors, friendlyModel } from "./theme";
import { SilenceStrip } from "./SilenceStrip";
import { ProjectEditor } from "./ProjectEditor";
import { SessionControls } from "./SessionControls";
import { TranscriptView } from "./TranscriptView";
import { WorkspaceRootSetting } from "./WorkspaceRootSetting";
import { KnowledgePanel } from "./KnowledgePanel";
import { Composer } from "./Composer";
import { LaunchProgress, launchPhaseLabel } from "./LaunchProgress";

interface ProjectsViewProps {
  projects: ProjectWithCounts[];
  sessions: Session[];
  checkpoints: Checkpoint[];
  launches: Launch[];
  onSaveProject: (
    id: string | null,
    patch: Partial<Project>
  ) => Promise<{ error?: string }>;
  onDeleteProject: (id: string) => Promise<{ error?: string }>;
  onSessionChanged: () => void;
  onLaunch: (
    projectId: string,
    task: string,
    model?: ClaudeModel,
    effort?: ClaudeEffort
  ) => Promise<{ error?: string }>;
  lastEvent: { sessionId: string; n: number };
  draftSignal: { projectId: string; n: number };
}

export function ProjectsView({
  projects,
  sessions,
  checkpoints,
  launches,
  onSaveProject,
  onDeleteProject,
  onSessionChanged,
  onLaunch,
  lastEvent,
  draftSignal,
}: ProjectsViewProps) {
  // Selection lives in the path so it survives a refresh and can be linked
  // to. `kind` distinguishes a project from a session, since both are
  // selectable into the same detail pane and their ids would otherwise be
  // ambiguous.
  const { kind, selectedId } = useParams();
  const navigate = useNavigate();

  const selectedProjectId = kind === "p" ? selectedId : undefined;
  // A sessionless launch (still provisioning, or failed before any session) —
  // selectable into the detail pane so its provision/build progress is
  // watchable while it runs.
  const selectedLaunchId = kind === "l" ? selectedId : undefined;
  const selectedSession =
    kind === "s"
      ? selectedId
      : selectedProjectId || selectedLaunchId
        ? null
        : sessions[0]?.id ?? null;

  const setSelectedSession = (id: string) => navigate(`/projects/s/${id}`);
  const setSelectedProject = (id: string) => navigate(`/projects/p/${id}`);
  const setSelectedLaunch = (id: string) => navigate(`/projects/l/${id}`);

  // null = not editing; "" = creating a new project; otherwise a project id.
  const [editing, setEditing] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<
    "transcript" | "checkpoints" | "info"
  >("transcript");
  // "chat" first and default so opening a project lands you somewhere you
  // can immediately start typing, the way a new ChatGPT/Claude conversation
  // does — knowledge and settings are one click away, not the landing spot.
  const [projectTab, setProjectTab] = useState<"chat" | "knowledge" | "settings">(
    "chat"
  );
  // Bumped by the sidebar "+" so the composer's task input focuses even when
  // the chat tab is already open and nothing would otherwise remount.
  const [chatFocusSignal, setChatFocusSignal] = useState(0);

  const openProject = projects.find((p) => p.id === selectedProjectId);

  const getSessionsByProject = (projectId: string) =>
    sessions.filter((s) => s.projectId === projectId);

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

  // Clears a sessionless launch (failed provisioning, or an abandoned
  // "starting"). The launch:cleaned broadcast refreshes the list, so the row
  // drops on its own — no local state to manage.
  const dismissLaunch = (id: string) => {
    void fetch(`/api/launches/${id}/cleanup`, { method: "POST" }).catch(() => {});
  };

  return (
    <div style={{ display: "flex", height: "100%" }}>
      {/* Project list */}
      <div
        style={{
          width: 290,
          borderRight: `1px solid ${theme.edge}`,
          overflowY: "auto",
          background: theme.surface,
          flexShrink: 0,
        }}
      >
        {projects.map((project) => {
          const projectSessions = getSessionsByProject(project.id);
          const alertCount = projectSessions.filter(
            (s) => s.status === "waiting" || s.status === "stalled"
          ).length;
          // Launches that have no session yet — still provisioning, or failed
          // before the agent ever started. Without surfacing these here, a
          // provision failure (e.g. an expired git credential) is invisible in
          // the project you launched from: no session is ever created, so the
          // only trace is a card in the Feed. Excludes cleaned ones and any
          // that have since attached a session (those show as sessions below).
          const projectLaunches = launches.filter(
            (l) => l.projectId === project.id && !l.sessionId && l.status !== "cleaned"
          );

          return (
            <div key={project.id} style={{ marginBottom: 3 }}>
              {/* Project header */}
              <div
                style={{
                  padding: "12px 14px 7px",
                  display: "flex",
                  alignItems: "center",
                  gap: 9,
                }}
              >
                <div
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 5,
                    background: `${theme.running}1F`,
                    border: `1px solid ${theme.running}55`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 12,
                  }}
                >
                  {project.emoji ?? <LuBox />}
                </div>
                {/* The project itself is selectable, not just its sessions —
                    it owns knowledge and configuration of its own. */}
                <button
                  onClick={() => setSelectedProject(project.id)}
                  style={{
                    fontSize: 13.5,
                    fontWeight: 700,
                    background: "none",
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                    color:
                      selectedProjectId === project.id ? theme.running : theme.text,
                  }}
                >
                  {project.name}
                </button>
                {alertCount > 0 && (
                  <span
                    style={{
                      fontFamily: theme.mono,
                      fontSize: 9.5,
                      background: theme.waiting,
                      color: theme.ground,
                      borderRadius: 8,
                      padding: "1px 6px",
                      fontWeight: 700,
                    }}
                  >
                    {alertCount}
                  </span>
                )}
                <span style={{ flex: 1 }} />
                {/* Jumps straight to a blank chat tab for this project —
                    the quick "start something new" affordance ChatGPT/Claude
                    put next to each item, rather than requiring you to open
                    the project and then find the composer. */}
                <button
                  onClick={() => {
                    setSelectedProject(project.id);
                    setProjectTab("chat");
                    setChatFocusSignal((n) => n + 1);
                  }}
                  title={`Start a new chat in ${project.name}`}
                  style={{
                    background: "none",
                    border: `1px solid ${theme.edge}`,
                    borderRadius: 5,
                    width: 20,
                    height: 20,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: theme.faint,
                    cursor: "pointer",
                    fontSize: 13,
                    lineHeight: 1,
                    padding: 0,
                    flexShrink: 0,
                  }}
                >
                  +
                </button>
              </div>

              {/* Knowledge indicator.
                  Previously read "@<expert> indexed", driven by the project's
                  `expert` field — which nothing in the retrieval path reads,
                  so it claimed an index that did not exist. This counts the
                  docs actually indexed for the project. */}
              {project.knowledgeDocs > 0 && (
                <div
                  title="Human-authored knowledge docs searchable by agents in this project"
                  style={{
                    padding: "0 14px 6px 45px",
                    fontSize: 11.5,
                    color: theme.expert,
                    opacity: 0.85,
                  }}
                >
                  {project.knowledgeDocs} knowledge doc
                  {project.knowledgeDocs === 1 ? "" : "s"}
                </div>
              )}

              {/* Bootstrap can finish while you're on another tab entirely —
                  without this, a run's output just sits there until you
                  happen to open Knowledge and look. */}
              {project.pendingDrafts > 0 && (
                <button
                  onClick={() => {
                    setSelectedProject(project.id);
                    setProjectTab("knowledge");
                  }}
                  title="Generated knowledge drafts awaiting your review"
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    background: "none",
                    border: "none",
                    padding: "0 14px 6px 45px",
                    fontSize: 11.5,
                    fontWeight: 600,
                    color: theme.waiting,
                    cursor: "pointer",
                  }}
                >
                  {project.pendingDrafts} draft{project.pendingDrafts === 1 ? "" : "s"} awaiting
                  review
                </button>
              )}

              {/* Sessionless launches — provisioning in progress, or failed
                  before any session existed. Shown here so a launch failure
                  isn't invisible from the project you started it in. */}
              {projectLaunches.map((launch) => (
                <div key={launch.id} style={{ padding: "3px 12px 6px 45px" }}>
                  {launch.status === "failed" ? (
                    <>
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
                          onClick={() => dismissLaunch(launch.id)}
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
                      {launch.error && (
                        <div
                          style={{
                            fontFamily: theme.mono,
                            fontSize: 10.5,
                            color: theme.faint,
                            marginTop: 2,
                            lineHeight: 1.4,
                            maxHeight: 48,
                            overflow: "hidden",
                          }}
                        >
                          {launch.error.slice(0, 200)}
                        </div>
                      )}
                    </>
                  ) : (
                    <button
                      onClick={() => setSelectedLaunch(launch.id)}
                      title="Watch this launch provision"
                      style={{
                        display: "flex",
                        width: "100%",
                        textAlign: "left",
                        gap: 5,
                        alignItems: "baseline",
                        fontSize: 12,
                        color: theme.running,
                        background:
                          selectedLaunchId === launch.id ? theme.raised : "none",
                        border: "none",
                        borderRadius: 4,
                        padding: "1px 3px",
                        cursor: "pointer",
                      }}
                    >
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
              ))}

              {/* Sessions */}
              {projectSessions.length === 0 && projectLaunches.length === 0 ? (
                <div
                  style={{
                    padding: "2px 14px 8px 45px",
                    fontSize: 12,
                    color: theme.faint,
                  }}
                >
                  No work running.
                </div>
              ) : (
                projectSessions.map((session) => {
                  const isActive = selectedSession === session.id;
                  const statusColor = statusColors[session.status];

                  return (
                    <button
                      key={session.id}
                      onClick={() => setSelectedSession(session.id)}
                      style={{
                        width: "100%",
                        textAlign: "left",
                        background: isActive ? theme.raised : "transparent",
                        border: "none",
                        borderLeft: `2px solid ${isActive ? statusColor : "transparent"}`,
                        padding: "8px 12px 8px 14px",
                        cursor: "pointer",
                        display: "block",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                        }}
                      >
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
                          style={{
                            fontSize: 12.5,
                            color: theme.text,
                            flex: 1,
                            lineHeight: 1.35,
                            fontWeight: isActive ? 600 : 400,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {session.title || "Untitled"}
                        </span>
                        {/* Owned sessions can be driven from here; monitored
                            ones can only be watched. Worth seeing without
                            opening each session. */}
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
                      </div>
                      <div style={{ marginTop: 5, paddingLeft: 14 }}>
                        <SilenceStrip status={session.status} ticks={session.activityTicks} />
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          );
        })}

        <button
          onClick={() => setEditing("")}
          style={{
            width: "100%",
            textAlign: "left",
            background: "none",
            border: "none",
            borderTop: `1px solid ${theme.edgeSoft}`,
            padding: "12px 14px",
            marginTop: 6,
            cursor: "pointer",
            fontSize: 12.5,
            color: theme.faint,
          }}
        >
          + New project
        </button>
        <WorkspaceRootSetting />
        <div style={{ height: 20 }} />
      </div>

      {/* Detail pane — the editor takes over when configuring a project.
          Column flex with minHeight 0 so each branch below owns its own
          scroll region (header/tabs stay put, only the tab content
          scrolls) rather than the whole pane scrolling as one block. No
          overflow here — a scrollable ancestor around an already-scrollable
          child just doubles the scrollbar and lets the header drift off
          with it. */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {editing === null && openProject ? (
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
                padding: "18px 20px 0",
                borderBottom: `1px solid ${theme.edgeSoft}`,
              }}
            >
              <div style={{ display: "flex", gap: 11, alignItems: "center" }}>
                <span style={{ fontSize: 20, display: "inline-flex" }}>
                  {openProject.emoji ?? <LuBox />}
                </span>
                <span style={{ fontSize: 17, fontWeight: 700 }}>
                  {openProject.name}
                </span>
                <span
                  style={{ fontFamily: theme.mono, fontSize: 10.5, color: theme.faint }}
                >
                  {openProject.repos.length} repo
                  {openProject.repos.length === 1 ? "" : "s"} · {openProject.branch}
                </span>
              </div>

              <div style={{ display: "flex", gap: 2, marginTop: 12 }}>
                {(["chat", "knowledge", "settings"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setProjectTab(t)}
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      padding: "6px 12px",
                      border: "none",
                      borderBottom: `2px solid ${
                        projectTab === t ? theme.running : "transparent"
                      }`,
                      background: "none",
                      color: projectTab === t ? theme.text : theme.faint,
                      cursor: "pointer",
                      textTransform: "capitalize",
                    }}
                  >
                    {t}
                    {t === "knowledge" && openProject.knowledgeDocs > 0 && (
                      <span style={{ color: theme.faint, marginLeft: 6 }}>
                        {openProject.knowledgeDocs}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>

            {projectTab === "chat" ? (
              // Chat is the landing tab and the whole reason for the "+" in
              // the sidebar — an empty canvas with the composer pinned
              // below, the way a new ChatGPT/Claude conversation opens.
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
                    alignItems: "center",
                    justifyContent: "center",
                    padding: "0 24px",
                    textAlign: "center",
                    color: theme.dim,
                    fontSize: 13.5,
                    lineHeight: 1.6,
                  }}
                >
                  Describe a task below to start a new agent working in{" "}
                  {openProject.name}.
                </div>
                <Composer
                  key={openProject.id}
                  projects={[openProject]}
                  onLaunch={onLaunch}
                  focusSignal={chatFocusSignal}
                />
              </div>
            ) : (
              <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
                {projectTab === "knowledge" ? (
                  <KnowledgePanel
                    projectId={openProject.id}
                    repos={openProject.repos}
                    draftSignal={draftSignal}
                  />
                ) : (
                  <ProjectEditor
                    project={openProject}
                    onSave={async (patch) => onSaveProject(openProject.id, patch)}
                    onDelete={async () => {
                      const result = await onDeleteProject(openProject.id);
                      if (!result.error) navigate("/projects");
                      return result;
                    }}
                    onCancel={() => navigate("/projects")}
                  />
                )}
              </div>
            )}
          </div>
        ) : editing !== null ? (
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
            <ProjectEditor
              project={editing ? projects.find((p) => p.id === editing) : undefined}
              onSave={async (patch) => {
                const result = await onSaveProject(editing || null, patch);
                if (!result.error) setEditing(null);
                return result;
              }}
              onDelete={
                editing
                  ? async () => {
                      const result = await onDeleteProject(editing);
                      if (!result.error) setEditing(null);
                      return result;
                    }
                  : undefined
              }
              onCancel={() => setEditing(null)}
            />
          </div>
        ) : selected ? (
          <>
            <div
              style={{
                padding: "18px 20px 14px",
                borderBottom: `1px solid ${theme.edgeSoft}`,
              }}
            >
              <div
                style={{ display: "flex", gap: 11, alignItems: "center" }}
              >
                <div
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 7,
                    background: `${theme.running}1F`,
                    border: `1px solid ${theme.running}55`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 15,
                  }}
                >
                  {selectedProject?.emoji ?? <LuBox />}
                </div>
                <span style={{ fontSize: 17, fontWeight: 700 }}>
                  {selected.title || "Untitled"}
                </span>
              </div>
              <div
                style={{
                  display: "flex",
                  gap: 15,
                  marginTop: 12,
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
                <span title="Live model and effort, read from the session's own transcript/events">
                  {selected.liveModel
                    ? friendlyModel(selected.liveModel)
                    : selectedLaunch?.model ?? "default"}{" "}
                  / {selected.liveEffort ?? selectedLaunch?.effort ?? "default"}
                </span>
                {selected.endedAt && <span>ended</span>}
              </div>

              <div style={{ marginTop: 14 }}>
                <SessionControls session={selected} onChanged={onSessionChanged} />
              </div>
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
              <TranscriptView
                key={selected.id}
                sessionId={selected.id}
                sessionEnded={!!selected.endedAt}
                eventSignal={
                  lastEvent.sessionId === selected.id ? lastEvent.n : 0
                }
              />
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
                              border: `1px solid ${theme.expert}44`,
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
                          tmux attach -t {selectedLaunch.tmuxSession}
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
          <div
            style={{
              flex: 1,
              minHeight: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: theme.dim,
            }}
          >
            Select a session to view details
          </div>
        )}
      </div>
    </div>
  );
}
