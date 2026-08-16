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
import { theme, statusColors, friendlyModel } from "./theme";
import { SilenceStrip } from "./SilenceStrip";
import { ProjectEditor } from "./ProjectEditor";
import { SessionControls } from "./SessionControls";
import { TranscriptView } from "./TranscriptView";
import { KnowledgePanel } from "./KnowledgePanel";
import { Composer } from "./Composer";

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
}: ProjectsViewProps) {
  // Selection lives in the path so it survives a refresh and can be linked
  // to. `kind` distinguishes a project from a session, since both are
  // selectable into the same detail pane and their ids would otherwise be
  // ambiguous.
  const { kind, selectedId } = useParams();
  const navigate = useNavigate();

  const selectedProjectId = kind === "p" ? selectedId : undefined;
  const selectedSession =
    kind === "s" ? selectedId : selectedProjectId ? null : sessions[0]?.id ?? null;

  const setSelectedSession = (id: string) => navigate(`/projects/s/${id}`);
  const setSelectedProject = (id: string) => navigate(`/projects/p/${id}`);

  // null = not editing; "" = creating a new project; otherwise a project id.
  const [editing, setEditing] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<
    "transcript" | "checkpoints" | "info"
  >("transcript");
  const [projectTab, setProjectTab] = useState<"knowledge" | "settings">(
    "knowledge"
  );

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

  return (
    <div style={{ display: "flex", height: "calc(100vh - 100px)" }}>
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
                  {project.emoji ?? "📦"}
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

              {/* Sessions */}
              {projectSessions.length === 0 ? (
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
                              fontFamily: theme.mono,
                              fontSize: 9,
                              color: theme.checkpoint,
                              flexShrink: 0,
                            }}
                          >
                            ⇄
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
        <div style={{ height: 20 }} />
      </div>

      {/* Detail pane — the editor takes over when configuring a project.
          Column flex with minHeight 0 so the transcript can own its own
          scroll region and keep its reply box pinned, rather than the whole
          pane scrolling as one block. */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          overflowY: "auto",
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
                <span style={{ fontSize: 20 }}>{openProject.emoji ?? "📦"}</span>
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
                {(["knowledge", "settings"] as const).map((t) => (
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

            <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
              {projectTab === "knowledge" ? (
                <KnowledgePanel projectId={openProject.id} />
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

            {/* Starting work from here was previously only possible from the
                Feed tab — this locks the composer to the open project so
                launching an agent doesn't require leaving Projects. */}
            <Composer
              key={openProject.id}
              projects={[openProject]}
              onLaunch={onLaunch}
            />
          </div>
        ) : editing !== null ? (
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
                  {selectedProject?.emoji ?? "📦"}
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
              <div style={{ padding: "10px 0 24px" }}>
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
              <div style={{ padding: "18px 20px 24px" }}>
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
        ) : (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
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
