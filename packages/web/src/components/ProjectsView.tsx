import { useState } from "react";
import type { Project, Session, Checkpoint } from "@standup/shared";
import { theme, statusColors } from "./theme";
import { SilenceStrip } from "./SilenceStrip";
import { ProjectEditor } from "./ProjectEditor";

interface ProjectsViewProps {
  projects: Project[];
  sessions: Session[];
  checkpoints: Checkpoint[];
  onSaveProject: (
    id: string | null,
    patch: Partial<Project>
  ) => Promise<{ error?: string }>;
  onDeleteProject: (id: string) => Promise<{ error?: string }>;
}

export function ProjectsView({
  projects,
  sessions,
  checkpoints,
  onSaveProject,
  onDeleteProject,
}: ProjectsViewProps) {
  const [selectedSession, setSelectedSession] = useState<string | null>(
    sessions[0]?.id ?? null
  );
  // null = not editing; "" = creating a new project; otherwise a project id.
  const [editing, setEditing] = useState<string | null>(null);

  const getSessionsByProject = (projectId: string) =>
    sessions.filter((s) => s.projectId === projectId);

  const selected = sessions.find((s) => s.id === selectedSession);
  const selectedProject = selected
    ? projects.find((p) => p.id === selected.projectId)
    : null;
  const selectedCheckpoints = checkpoints.filter(
    (c) => c.sessionId === selectedSession
  );

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
                <span style={{ fontSize: 13.5, fontWeight: 700 }}>
                  {project.name}
                </span>
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
                <button
                  onClick={() => setEditing(project.id)}
                  title={`Configure ${project.name}`}
                  style={{
                    background: "none",
                    border: "none",
                    color: theme.faint,
                    cursor: "pointer",
                    fontSize: 13,
                    padding: "0 2px",
                    lineHeight: 1,
                  }}
                >
                  ⚙
                </button>
              </div>

              {/* Expert indicator */}
              {project.expert && (
                <div
                  style={{
                    padding: "0 14px 6px 45px",
                    fontSize: 11.5,
                    color: theme.expert,
                    opacity: 0.85,
                  }}
                >
                  @{project.expert} indexed
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

      {/* Detail pane — the editor takes over when configuring a project */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {editing !== null ? (
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
              </div>
            </div>

            {/* Checkpoints for this session */}
            <div style={{ padding: "10px 0 24px" }}>
              {selectedCheckpoints.length === 0 ? (
                <div
                  style={{
                    fontSize: 13,
                    color: theme.faint,
                    padding: "28px 20px",
                  }}
                >
                  No checkpoints yet. This agent will report at its first
                  milestone.
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
                      {cp.summary}
                    </div>
                  </div>
                ))
              )}
            </div>
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
