import { useState } from "react";
import type { Ask, Session, Project } from "@standup/shared";
import { Link } from "react-router-dom";
import { Replier } from "./Replier";
import { SessionScreen } from "./SessionScreen";

interface BlockedViewProps {
  asks: Ask[];
  sessions: Session[];
  projects: Project[];
  onResolveAsk: (askId: string, answer: string) => Promise<{ error?: string }>;
  onDismissAsk: (askId: string) => Promise<{ error?: string }>;
}

export function BlockedView({
  asks,
  sessions,
  projects,
  onResolveAsk,
  onDismissAsk,
}: BlockedViewProps) {
  const [resolving, setResolving] = useState<string | null>(null);
  // Resolving can legitimately fail — answering a prompt-ask for a monitored
  // session is refused, and a launched session's pane may have exited.
  // Swallowing that made a failed reply look like a dead button.
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [dismissing, setDismissing] = useState<string | null>(null);

  const getSession = (sessionId: string) =>
    sessions.find((s) => s.id === sessionId);
  const getProject = (projectId: string) =>
    projects.find((p) => p.id === projectId);

  const handleResolve = async (askId: string, answer: string) => {
    setResolving(askId);
    setErrors((prev) => ({ ...prev, [askId]: "" }));
    try {
      const result = await onResolveAsk(askId, answer);
      if (result?.error) {
        setErrors((prev) => ({ ...prev, [askId]: result.error! }));
      }
    } catch (err) {
      setErrors((prev) => ({ ...prev, [askId]: (err as Error).message }));
    } finally {
      setResolving(null);
    }
  };

  const handleDismiss = async (askId: string) => {
    setDismissing(askId);
    setErrors((prev) => ({ ...prev, [askId]: "" }));
    try {
      const result = await onDismissAsk(askId);
      if (result?.error) {
        setErrors((prev) => ({ ...prev, [askId]: result.error! }));
      }
    } catch (err) {
      setErrors((prev) => ({ ...prev, [askId]: (err as Error).message }));
    } finally {
      setDismissing(null);
    }
  };

  if (asks.length === 0) {
    return (
      <div className="px-5 pb-[30px] pt-[22px]">
        <div className="mb-1">
          <span className="text-[19px] font-bold">Waiting on you</span>
        </div>
        <div className="mb-5 text-sm text-dim">
          Nothing here. Every agent has what it needs.
        </div>
        <div className="rounded-lg border border-dashed border-edge px-5 py-9 text-center">
          <div className="mb-2.5 text-[30px]">🌤️</div>
          <div className="text-sm text-dim">Queue clear.</div>
          <Link
            to="/feed"
            className="mt-3 inline-block rounded-md border border-edge px-3.5 py-[7px] text-[12.5px] text-dim no-underline"
          >
            Back to the feed
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="max-h-[calc(100vh-100px)] overflow-y-auto px-5 pb-[30px] pt-[22px]">
      <div className="mb-1">
        <span className="text-[19px] font-bold">Waiting on you</span>
      </div>
      <div className="mb-5 text-sm text-dim">
        {/* Two different kinds of blocked: an ask_human is genuinely paused
            inside a tool call, while a prompt-ask is sitting on a dialog in
            its terminal. Saying only the former was misleading. */}
        Each of these agents is waiting on you — paused inside a tool call, or
        sitting on a prompt in its terminal. Answering resumes it.
      </div>

      <div className="grid gap-3">
        {asks.map((ask) => {
          const session = getSession(ask.sessionId);
          const project = session ? getProject(session.projectId) : null;
          const isResolving = resolving === ask.id;
          const isDismissing = dismissing === ask.id;

          return (
            <div
              key={ask.id}
              className={`flex gap-[13px] rounded-[9px] border border-waiting/[27%] bg-surface px-[17px] py-[15px] ${
                isResolving || isDismissing ? "opacity-60" : ""
              }`}
            >
              {/* Avatar */}
              <div className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-lg border border-running/[33%] bg-running/[12%] text-[17px]">
                {project?.emoji ?? "📦"}
              </div>

              {/* Content */}
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex flex-wrap items-baseline gap-2">
                  <span className="text-[14.5px] font-bold">
                    {project?.name ?? "Unknown"}
                  </span>
                  <span className="text-[12.5px] text-dim">
                    {session?.title ?? "Untitled"}
                  </span>
                  <span className="flex-1" />
                  <span className="font-mono text-[11px] text-waiting">
                    blocked{" "}
                    {Math.floor(
                      (Date.now() - new Date(ask.createdAt).getTime()) / 60000
                    )}
                    m
                  </span>
                  <button
                    onClick={() => handleDismiss(ask.id)}
                    disabled={isResolving || isDismissing}
                    title="Dismiss without answering — the agent's wait ends the same as if it had timed out."
                    className={`rounded border border-edge bg-transparent px-[7px] py-px text-xs leading-[1.6] text-faint ${
                      isResolving || isDismissing ? "cursor-default" : "cursor-pointer"
                    }`}
                  >
                    ×
                  </button>
                </div>

                <div className="text-sm leading-[1.55] text-text">
                  {ask.question}
                </div>

                {/* An ask_human carries its own question. A prompt-ask only
                    knows that the agent is waiting, so the screen is the
                    only place the actual question exists. */}
                {ask.kind === "permission_prompt" && (
                  <SessionScreen sessionId={ask.sessionId} />
                )}

                {/* Shared with the feed so both paths handle option-less
                    asks identically — this view previously rendered nothing
                    at all when an ask had no predefined options. */}
                <Replier
                  target="ask"
                  options={ask.options}
                  onReply={(answer) => handleResolve(ask.id, answer)}
                />

                {errors[ask.id] && (
                  <div className="mt-[9px] font-mono text-[11px] leading-relaxed text-waiting">
                    {errors[ask.id]}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
