import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Tab, TabGroup, TabList, TabPanel, TabPanels } from "@headlessui/react";
import type {
  Project,
  ProjectWithCounts,
  Session,
  Checkpoint,
  Launch,
  ClaudeEffort,
  ClaudeModel,
} from "@standup/shared";
import { statusColors, friendlyModel } from "./theme";
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

const PROJECT_TABS = ["chat", "knowledge", "settings"] as const;
const DETAIL_TABS = ["transcript", "checkpoints", "info"] as const;

// Directional (left-border) counterparts of statusColors' all-sides
// `border` class — session list rows only ever color their left edge.
const borderLeftByStatus = {
  running: "border-l-running",
  idle: "border-l-idle",
  waiting: "border-l-waiting",
  stalled: "border-l-stalled",
} as const;

const tabButtonClass =
  "cursor-pointer border-none border-b-2 border-transparent bg-none px-3 py-1.5 text-xs font-semibold capitalize text-faint data-selected:border-running data-selected:text-text";

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

  return (
    <div className="flex h-full">
      {/* Project list */}
      <div className="w-[290px] shrink-0 overflow-y-auto border-r border-edge bg-surface">
        {projects.map((project) => {
          const projectSessions = getSessionsByProject(project.id);
          const alertCount = projectSessions.filter(
            (s) => s.status === "waiting" || s.status === "stalled"
          ).length;

          return (
            <div key={project.id} className="mb-[3px]">
              {/* Project header */}
              <div className="flex items-center gap-[9px] px-3.5 pt-3 pb-[7px]">
                <div className="flex h-[22px] w-[22px] items-center justify-center rounded-md border border-running/[33%] bg-running/[12%] text-xs">
                  {project.emoji ?? "📦"}
                </div>
                {/* The project itself is selectable, not just its sessions —
                    it owns knowledge and configuration of its own. */}
                <button
                  onClick={() => setSelectedProject(project.id)}
                  className={`cursor-pointer border-none bg-none p-0 text-[13.5px] font-bold ${
                    selectedProjectId === project.id ? "text-running" : "text-text"
                  }`}
                >
                  {project.name}
                </button>
                {alertCount > 0 && (
                  <span className="rounded-lg bg-waiting px-1.5 py-px font-mono text-[9.5px] font-bold text-ground">
                    {alertCount}
                  </span>
                )}
                <span className="flex-1" />
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
                  className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-md border border-edge bg-none p-0 text-[13px] leading-none text-faint"
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
                  className="px-3.5 pb-1.5 pl-[45px] text-[11.5px] text-expert opacity-85"
                >
                  {project.knowledgeDocs} knowledge doc
                  {project.knowledgeDocs === 1 ? "" : "s"}
                </div>
              )}

              {/* Sessions */}
              {projectSessions.length === 0 ? (
                <div className="px-3.5 pt-0.5 pb-2 pl-[45px] text-xs text-faint">
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
                      className={`block w-full cursor-pointer border-none border-l-2 py-2 pr-3 pl-3.5 text-left ${
                        isActive ? "bg-raised" : "bg-transparent"
                      } ${isActive ? borderLeftByStatus[session.status] : "border-l-transparent"}`}
                    >
                      <div className="flex items-center gap-2">
                        <span className={`h-1.5 w-1.5 shrink-0 rounded-md ${statusColor.bg}`} />
                        <span
                          className={`flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[12.5px] leading-[1.35] text-text ${
                            isActive ? "font-semibold" : "font-normal"
                          }`}
                        >
                          {session.title || "Untitled"}
                        </span>
                        {/* Owned sessions can be driven from here; monitored
                            ones can only be watched. Worth seeing without
                            opening each session. */}
                        {session.owned && (
                          <span
                            title="Standup owns this session's terminal"
                            className="shrink-0 font-mono text-[9px] text-checkpoint"
                          >
                            ⇄
                          </span>
                        )}
                      </div>
                      <div className="mt-[5px] pl-3.5">
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
          className="mt-1.5 w-full cursor-pointer border-none border-t border-edge-soft bg-none px-3.5 py-3 text-left text-[12.5px] text-faint"
        >
          + New project
        </button>
        <div className="h-5" />
      </div>

      {/* Detail pane — the editor takes over when configuring a project.
          Column flex with minHeight 0 so each branch below owns its own
          scroll region (header/tabs stay put, only the tab content
          scrolls) rather than the whole pane scrolling as one block. No
          overflow here — a scrollable ancestor around an already-scrollable
          child just doubles the scrollbar and lets the header drift off
          with it. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {editing === null && openProject ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <TabGroup
              selectedIndex={PROJECT_TABS.indexOf(projectTab)}
              onChange={(i) => setProjectTab(PROJECT_TABS[i])}
              className="flex min-h-0 flex-1 flex-col"
            >
              <div className="border-b border-edge-soft px-5 pt-[18px]">
                <div className="flex items-center gap-[11px]">
                  <span className="text-xl">{openProject.emoji ?? "📦"}</span>
                  <span className="text-[17px] font-bold">{openProject.name}</span>
                  <span className="font-mono text-[10.5px] text-faint">
                    {openProject.repos.length} repo
                    {openProject.repos.length === 1 ? "" : "s"} · {openProject.branch}
                  </span>
                </div>

                <TabList className="mt-3 flex gap-0.5">
                  {PROJECT_TABS.map((t) => (
                    <Tab key={t} className={tabButtonClass}>
                      {t}
                      {t === "knowledge" && openProject.knowledgeDocs > 0 && (
                        <span className="ml-1.5 text-faint">{openProject.knowledgeDocs}</span>
                      )}
                    </Tab>
                  ))}
                </TabList>
              </div>

              <TabPanels className="flex min-h-0 flex-1 flex-col">
                <TabPanel className="flex min-h-0 flex-1 flex-col" unmount={false}>
                  {/* Chat is the landing tab and the whole reason for the "+" in
                      the sidebar — an empty canvas with the composer pinned
                      below, the way a new ChatGPT/Claude conversation opens. */}
                  <div className="flex min-h-0 flex-1 flex-col">
                    <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-[13.5px] leading-relaxed text-dim">
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
                </TabPanel>
                <TabPanel className="min-h-0 flex-1 overflow-y-auto" unmount={false}>
                  <KnowledgePanel projectId={openProject.id} />
                </TabPanel>
                <TabPanel className="min-h-0 flex-1 overflow-y-auto" unmount={false}>
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
                </TabPanel>
              </TabPanels>
            </TabGroup>
          </div>
        ) : editing !== null ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
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
          <TabGroup
            selectedIndex={DETAIL_TABS.indexOf(detailTab)}
            onChange={(i) => setDetailTab(DETAIL_TABS[i])}
            className="flex min-h-0 flex-1 flex-col"
          >
            <div className="border-b border-edge-soft px-5 pt-[18px] pb-3.5">
              <div className="flex items-center gap-[11px]">
                <div className="flex h-[30px] w-[30px] items-center justify-center rounded-[7px] border border-running/[33%] bg-running/[12%] text-[15px]">
                  {selectedProject?.emoji ?? "📦"}
                </div>
                <span className="text-[17px] font-bold">{selected.title || "Untitled"}</span>
              </div>
              <div className="mt-3 flex gap-[15px] font-mono text-[11px] text-faint">
                <span className={`text-[10.5px] tracking-[0.1em] uppercase ${statusColors[selected.status].text}`}>
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

              <div className="mt-3.5">
                <SessionControls session={selected} onChanged={onSessionChanged} />
              </div>
            </div>

            {/* Tabs: checkpoints are the milestone spine, the transcript is
                the full conversation. Both are useful for different questions
                — "what has it achieved" vs "what exactly did it say". */}
            <TabList className="flex gap-0.5 border-b border-edge-soft px-5 pt-2.5">
              {DETAIL_TABS.map((t) => (
                <Tab key={t} className={tabButtonClass}>
                  {t}
                  {t === "checkpoints" && selectedCheckpoints.length > 0 && (
                    <span className="ml-1.5 text-faint">{selectedCheckpoints.length}</span>
                  )}
                </Tab>
              ))}
            </TabList>

            <TabPanels className="flex min-h-0 flex-1 flex-col">
              <TabPanel className="flex min-h-0 flex-1 flex-col" unmount={false}>
                <TranscriptView
                  key={selected.id}
                  sessionId={selected.id}
                  sessionEnded={!!selected.endedAt}
                  eventSignal={
                    lastEvent.sessionId === selected.id ? lastEvent.n : 0
                  }
                />
              </TabPanel>
              <TabPanel className="min-h-0 flex-1 overflow-y-auto pt-2.5 pb-6" unmount={false}>
                {selectedCheckpoints.length === 0 ? (
                  <div className="px-5 py-7 text-[13px] leading-[1.55] text-faint">
                    No checkpoints yet. Agents only report these if told to —
                    see docs/agent-instructions.md. Sessions launched from the
                    console are instructed automatically.
                  </div>
                ) : (
                  selectedCheckpoints.map((cp) => (
                    <div key={cp.id} className="flex gap-3 px-5 pt-[9px] pb-[5px]">
                      <div className="w-[34px]">
                        <span className="font-mono text-[9.5px] text-faint">
                          {new Date(cp.createdAt).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </div>
                      <div className="text-sm leading-[1.55]">
                        {cp.source === "auto" && (
                          <span className="mr-[7px] rounded-[3px] border border-expert/[27%] px-[5px] py-px align-[2px] font-mono text-[9px] tracking-[0.1em] text-expert uppercase">
                            auto
                          </span>
                        )}
                        {cp.summary}
                      </div>
                    </div>
                  ))
                )}
              </TabPanel>
              <TabPanel className="min-h-0 flex-1 overflow-y-auto px-5 pt-[18px] pb-6" unmount={false}>
                <div className="mb-[18px]">
                  <div className="mb-1.5 text-[11px] font-semibold text-dim">
                    Working directory
                  </div>
                  <div
                    title="cd into this to work alongside the agent"
                    className="font-mono text-[12.5px] break-all text-text select-all"
                  >
                    {selected.cwd}
                  </div>
                </div>

                {selectedLaunch ? (
                  <>
                    <div className="mb-[18px]">
                      <div className="mb-1.5 text-[11px] font-semibold text-dim">Branch</div>
                      <div className="font-mono text-[12.5px] text-text">
                        {selectedLaunch.branch}{" "}
                        <span className="text-faint">({selectedLaunch.kind})</span>
                      </div>
                    </div>

                    {selectedLaunch.tmuxSession && (
                      <div>
                        <div className="mb-1.5 text-[11px] font-semibold text-dim">
                          Attach to the agent's terminal
                        </div>
                        <div
                          title="For a full interactive terminal"
                          className="font-mono text-[12.5px] text-text select-all"
                        >
                          tmux attach -t {selectedLaunch.tmuxSession}
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-[12.5px] leading-[1.55] text-faint">
                    You started this session in your own terminal, so there's
                    no worktree or tmux pane Standup owns — just the working
                    directory above.
                  </div>
                )}
              </TabPanel>
            </TabPanels>
          </TabGroup>
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center text-dim">
            Select a session to view details
          </div>
        )}
      </div>
    </div>
  );
}
