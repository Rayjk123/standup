import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import type { Project, ProjectWithCounts } from "@standup/shared";
import { LuArrowRight } from "react-icons/lu";
import { theme } from "./theme";
import { ProjectIcon, ProjectAvatar } from "./ProjectIcon";
import { ProjectEditor } from "./ProjectEditor";
import { ReviewSettings } from "./ReviewSettings";
import { ProjectPersonalization } from "./ProjectPersonalization";
import { OrchestrationProfiles } from "./OrchestrationProfiles";
import { WorkspaceRootSetting } from "./WorkspaceRootSetting";

interface ProjectsViewProps {
  projects: ProjectWithCounts[];
  onSaveProject: (
    id: string | null,
    patch: Partial<Project>
  ) => Promise<{ error?: string }>;
  onDeleteProject: (id: string) => Promise<{ error?: string }>;
}

// Projects is the configuration surface: the project list plus, for the
// selected project, its settings (review, personalization, repos/name/image)
// and a link into its knowledge corpus. Running work and per-session detail
// live in Work; the corpus itself lives in Knowledge.
export function ProjectsView({
  projects,
  onSaveProject,
  onDeleteProject,
}: ProjectsViewProps) {
  // Selection lives in the path so it survives a refresh and can be linked to.
  // Only the "p" (project) kind is meaningful here.
  const { kind, selectedId } = useParams();
  const navigate = useNavigate();

  const selectedProjectId = kind === "p" ? selectedId : undefined;
  const setSelectedProject = (id: string) => navigate(`/projects/p/${id}`);

  // null = not editing; "" = creating a new project; otherwise a project id.
  const [editing, setEditing] = useState<string | null>(null);

  const openProject = projects.find((p) => p.id === selectedProjectId);

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
          const isActive = selectedProjectId === project.id;
          return (
            <button
              key={project.id}
              onClick={() => setSelectedProject(project.id)}
              style={{
                width: "100%",
                textAlign: "left",
                background: isActive ? theme.raised : "transparent",
                border: "none",
                borderLeft: `2px solid ${isActive ? theme.running : "transparent"}`,
                padding: "12px 14px",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 9,
              }}
            >
              <ProjectAvatar project={project} size={22} fontSize={12} />
              <span
                style={{
                  fontSize: 13.5,
                  fontWeight: isActive ? 700 : 600,
                  color: isActive ? theme.running : theme.text,
                  flex: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {project.name}
              </span>
              {project.knowledgeDocs > 0 && (
                <span
                  title="Human-authored knowledge docs searchable by agents in this project"
                  style={{ fontSize: 11, color: theme.expert, opacity: 0.85 }}
                >
                  {project.knowledgeDocs}
                </span>
              )}
            </button>
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

      {/* Detail pane — the config surface for the selected project, or the
          editor when creating/editing one. */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {editing !== null ? (
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
        ) : openProject ? (
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
                padding: "18px 20px 14px",
                borderBottom: `1px solid ${theme.edgeSoft}`,
              }}
            >
              <div style={{ display: "flex", gap: 11, alignItems: "center" }}>
                <span style={{ fontSize: 20, display: "inline-flex", alignItems: "center" }}>
                  <ProjectIcon project={openProject} size={22} />
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

              {/* Knowledge lives in its own tab now; a project's config links
                  into the corpus scoped to that project rather than embedding
                  it here. */}
              <button
                onClick={() => navigate(`/knowledge?project=${openProject.id}`)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  marginTop: 12,
                  fontSize: 12,
                  fontWeight: 600,
                  color: theme.expert,
                  background: "none",
                  border: `1px solid ${theme.edge}`,
                  borderRadius: 6,
                  padding: "5px 10px",
                  cursor: "pointer",
                }}
              >
                {openProject.knowledgeDocs > 0
                  ? `${openProject.knowledgeDocs} knowledge doc${
                      openProject.knowledgeDocs === 1 ? "" : "s"
                    }`
                  : "Knowledge"}
                <LuArrowRight />
              </button>
            </div>

            <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
              <ReviewSettings
                project={openProject}
                onSave={async (patch) => onSaveProject(openProject.id, patch)}
              />
              <ProjectPersonalization
                projectId={openProject.id}
                projectName={openProject.name}
              />
              <div
                style={{
                  padding: "18px 20px 8px",
                  maxWidth: 620,
                  borderTop: `1px solid ${theme.edgeSoft}`,
                }}
              >
                <OrchestrationProfiles scope="project" projectId={openProject.id} />
              </div>
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
            </div>
          </div>
        ) : (
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
              Configure a project
            </div>
            <div
              style={{
                fontSize: 13.5,
                color: theme.dim,
                lineHeight: 1.6,
                maxWidth: 440,
              }}
            >
              Pick a project to edit its review settings, personalization,
              repos, and knowledge — or create a new one. Running work lives in
              the Board's Live workers drawer.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
