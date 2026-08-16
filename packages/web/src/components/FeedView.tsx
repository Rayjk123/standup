import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type {
  Checkpoint,
  Ask,
  Session,
  Project,
  ExpertExchange,
  Launch,
  ClaudeEffort,
  ClaudeModel,
} from "@standup/shared";
import { friendlyModel } from "./theme";
import { Replier } from "./Replier";
import { Composer } from "./Composer";
import { LaunchControls } from "./LaunchControls";

/**
 * Renders the agent's question and what retrieval returned, attributed to a
 * region. Shown in full rather than collapsed: the design's whole argument
 * for routing expert traffic through the feed is that you need to notice a
 * wrong answer before it turns into a bad edit.
 */
function ExpertBody({ exchange }: { exchange: ExpertExchange }) {
  return (
    <>
      <div className="mb-2 text-[13px] text-dim">{exchange.question}</div>
      <div className="rounded-md border border-edge-soft border-l-[3px] border-l-expert px-[13px] py-[11px]">
        <div className="mb-1.5 flex flex-wrap items-baseline gap-2">
          <span className="text-[13.5px] font-bold text-expert">
            @{exchange.region || "repo"}-expert
          </span>
          {exchange.sources.length > 0 && (
            <span className="font-mono text-[10px] text-faint">
              {exchange.sources.slice(0, 3).join(" · ")}
              {exchange.sources.length > 3 ? ` +${exchange.sources.length - 3}` : ""}
            </span>
          )}
        </div>
        <div className="max-h-[260px] overflow-y-auto whitespace-pre-wrap font-mono text-[11.5px] leading-[1.55] text-text">
          {exchange.answer}
        </div>
      </div>
    </>
  );
}

/**
 * A launch the human started from the composer.
 *
 * Surfaces the tmux attach command because the console deliberately does not
 * render agent responses — it carries checkpoints, asks, and expert
 * exchanges, not the conversation. Without this, starting work from the
 * console gives you no way back to what the agent actually said.
 */
function LaunchBody({
  launch,
  session,
  onStopped,
}: {
  launch: Launch;
  session?: Session;
  onStopped: () => void;
}) {
  const failed = launch.status === "failed";
  const modelLabel = session?.liveModel
    ? friendlyModel(session.liveModel)
    : launch.model ?? "default";
  const effortLabel = session?.liveEffort ?? launch.effort ?? "default";

  return (
    <>
      <div className="text-sm leading-[1.55] text-text">{launch.task}</div>

      {failed ? (
        <div className="mt-[7px] font-mono text-[11px] leading-normal text-waiting">
          ✗ {launch.error ?? "Launch failed"}
        </div>
      ) : (
        <>
          <div className="mt-[7px] font-mono text-[10.5px] text-running">
            ⧗ worktree {launch.branch} · agent running
            <span className="text-faint"> · {modelLabel} / {effortLabel}</span>
          </div>
          {launch.tmuxSession && (
            <>
              <LaunchControls launch={launch} onStopped={onStopped} />
              <div
                className="mt-2 select-all font-mono text-[10.5px] text-faint"
                title="For a full interactive terminal"
              >
                tmux attach -t {launch.tmuxSession}
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}

interface FeedViewProps {
  checkpoints: Checkpoint[];
  asks: Ask[];
  expertExchanges: ExpertExchange[];
  launches: Launch[];
  sessions: Session[];
  projects: Project[];
  onSteer: (sessionId: string, body: string) => Promise<void>;
  onResolveAsk: (askId: string, answer: string) => Promise<{ error?: string }>;
  onLaunch: (
    projectId: string,
    task: string,
    model?: ClaudeModel,
    effort?: ClaudeEffort
  ) => Promise<{ error?: string }>;
  onLaunchChanged: () => void;
}

export function FeedView({
  checkpoints,
  asks,
  expertExchanges,
  launches,
  sessions,
  projects,
  onSteer,
  onResolveAsk,
  onLaunch,
  onLaunchChanged,
}: FeedViewProps) {
  // What the human has sent this session, keyed by feed item id. Optimistic:
  // asks disappear from `asks` once resolved server-side, so without this the
  // confirmation would vanish the instant it succeeded.
  const [replies, setReplies] = useState<Record<string, string>>({});

  const navigate = useNavigate();

  // The merged feed carries checkpoints, asks, and expert exchanges — never
  // raw tool calls. That separation is enforced here, at the query, not in
  // the rendering: an activity tier that reaches this array has already
  // made the feed unreadable.
  type FeedItem =
    | { type: "checkpoint"; data: Checkpoint }
    | { type: "ask"; data: Ask }
    | { type: "expert"; data: ExpertExchange }
    | { type: "launch"; data: Launch & { sessionId: string } };

  const feedItems: FeedItem[] = [
    ...checkpoints.map((c) => ({ type: "checkpoint" as const, data: c })),
    ...asks.map((a) => ({ type: "ask" as const, data: a })),
    ...expertExchanges.map((e) => ({ type: "expert" as const, data: e })),
    // Launches are what the human started, so they belong in the feed as a
    // record of intent — without this a launch produced no visible trace at
    // all, which reads as the console having swallowed the request.
    ...launches
      .filter((l) => l.status !== "cleaned")
      .map((l) => ({
        type: "launch" as const,
        data: { ...l, sessionId: l.sessionId ?? "" },
      })),
  ].sort(
    // Oldest first, newest last — reads top-to-bottom like a chat thread,
    // with the composer immediately below the most recent item.
    (a, b) =>
      new Date(a.data.createdAt).getTime() -
      new Date(b.data.createdAt).getTime()
  );

  const getSession = (sessionId: string) =>
    sessions.find((s) => s.id === sessionId);
  const getProject = (projectId: string) =>
    projects.find((p) => p.id === projectId);

  // Keep the newest item in view as the feed grows, rather than leaving the
  // reader scrolled up at the oldest item every time the list re-renders.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [feedItems.length]);

  // Column layout so the composer stays pinned below a scrolling feed
  // rather than scrolling away with it.
  return (
    <div className="flex h-full min-h-0 flex-col">
      {feedItems.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center p-10 text-dim">
          <div className="mb-2.5 text-[30px]">📭</div>
          <div className="text-sm">No activity yet.</div>
          <div className="mt-1 text-[12.5px] text-faint">
            Checkpoints and asks from agents will appear here — or start work below.
          </div>
        </div>
      ) : (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto py-2">
          {feedItems.map((item) => {
        const session = getSession(item.data.sessionId);
        const isAsk = item.type === "ask";
        const isExpert = item.type === "expert";
        const isLaunch = item.type === "launch";
        // Haiku-inferred, not agent-reported — see auto-checkpoint.ts.
        // Flagged distinctly since it's a guess about what happened, not a
        // fact the agent stated about itself.
        const isAutoCheckpoint =
          item.type === "checkpoint" && (item.data as Checkpoint).source === "auto";
        // A launch knows its project directly; it may not have a session yet
        // (the agent registers a moment after the worktree is created).
        const project = isLaunch
          ? getProject((item.data as Launch).projectId)
          : session
            ? getProject(session.projectId)
            : null;
        const accent = isAsk
          ? "text-waiting"
          : isExpert || isAutoCheckpoint
            ? "text-expert"
            : isLaunch
              ? "text-running"
              : "text-checkpoint";
        // Mirrors the original hex+alpha computation: an avatar tile tinted
        // with the project's accent (currently always "running", since
        // project.emoji is effectively always set) at ~12% opacity, or a
        // flat surface fill when there's no project at all.
        const avatarBgClass = project
          ? project.emoji
            ? "bg-running/[12%]"
            : "bg-surface/[12%]"
          : "bg-surface";

        // Opens the session this item belongs to in Projects, where the full
        // transcript and controls live. A launch may not have a session yet
        // (the agent registers a moment after the worktree is created) — its
        // project is still worth opening.
        const openInProjects = () => {
          if (session) navigate(`/projects/s/${session.id}`);
          else if (isLaunch) navigate(`/projects/p/${(item.data as Launch).projectId}`);
        };

        return (
          <div
            key={item.data.id}
            onClick={openInProjects}
            className="flex cursor-pointer gap-3 px-5 pb-[5px] pt-[9px]"
          >
            {/* Avatar */}
            <div
              className={`flex h-[34px] w-[34px] flex-shrink-0 items-center justify-center rounded-lg border border-edge text-[17px] ${avatarBgClass}`}
            >
              {isAutoCheckpoint ? "🤖" : (project?.emoji ?? "📦")}
            </div>

            {/* Content */}
            <div className="min-w-0 flex-1">
              <div className="mb-[3px] flex flex-wrap items-baseline gap-2">
                <span className="text-[14.5px] font-bold text-text">
                  {/* Auto-checkpoints are Standup's own inference, not a
                      claim about who did the work — attributed to "System"
                      rather than falling through to "Unknown". */}
                  {isAutoCheckpoint ? "System" : (project?.name ?? "Unknown")}
                </span>
                <span className="rounded-[3px] border border-running/[0.267] px-[5px] py-px font-mono text-[9px] tracking-[0.08em] text-running uppercase">
                  agent
                </span>
                <span className="text-[12.5px] text-dim">
                  {session?.title ?? "Untitled"}
                </span>
                <span className="text-[11.5px] text-faint">
                  {new Date(item.data.createdAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </div>

              {(isAsk || isExpert || isLaunch || isAutoCheckpoint) && (
                <div className="mb-[5px]">
                  <span
                    className={`font-mono text-[9.5px] font-semibold tracking-[0.16em] uppercase ${accent}`}
                  >
                    {isAsk
                      ? "Needs you"
                      : isExpert
                        ? "Expert consulted"
                        : isAutoCheckpoint
                          ? "Auto-checkpoint"
                          : "You started this"}
                  </span>
                </div>
              )}

              {isExpert ? (
                <ExpertBody exchange={item.data as ExpertExchange} />
              ) : isLaunch ? (
                <div onClick={(e) => e.stopPropagation()}>
                  <LaunchBody
                    launch={item.data as Launch}
                    session={getSession((item.data as Launch).sessionId ?? "")}
                    onStopped={onLaunchChanged}
                  />
                </div>
              ) : (
                <div className="text-sm leading-[1.55] text-text">
                  {item.type === "checkpoint"
                    ? (item.data as Checkpoint).summary
                    : (item.data as Ask).question}
                </div>
              )}

              {/* Expert exchanges and launches are records, not prompts —
                  neither has a counterpart action for the human, so no
                  reply affordance. */}
              {!isExpert && !isLaunch && (
                <div onClick={(e) => e.stopPropagation()}>
                  <Replier
                    target={isAsk ? "ask" : "checkpoint"}
                    options={isAsk ? (item.data as Ask).options : undefined}
                    reply={replies[item.data.id]}
                    onReply={async (body) => {
                      if (isAsk) {
                        await onResolveAsk(item.data.id, body);
                      } else {
                        await onSteer(item.data.sessionId, body);
                      }
                      setReplies((prev) => ({ ...prev, [item.data.id]: body }));
                    }}
                  />
                </div>
              )}
            </div>
          </div>
        );
          })}
        </div>
      )}

      <Composer projects={projects} onLaunch={onLaunch} />
    </div>
  );
}
