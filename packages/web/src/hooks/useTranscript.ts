import { useMemo } from "react";
import { useSessionEvents } from "./useSessionEvents";
import { reduceSessionProjection } from "./sessionProjection";

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output?: string;
  isError?: boolean;
}

export interface TranscriptMessage {
  uuid: string;
  role: "user" | "assistant";
  timestamp: string;
  text: string;
  /** Extended-thinking prose, kept separate from `text` — see transcript.ts. */
  thinking?: string;
  toolCalls: ToolCall[];
  outputTokens?: number;
  model?: string;
  /** The actor who sent this reply, when it came in through Standup's reply box. */
  sentBy?: string;
  /** A `/command` run through the CLI passthrough — see server-side LocalCommand. */
  localCommand?: { name: string; args: string; stdout: string };
  /** An injected background-task completion — see server-side TaskNotification. */
  taskNotification?: { summary: string; status: string };
}

export interface TranscriptPage {
  messages: TranscriptMessage[];
  hasMore: boolean;
  totalMessages: number;
  outputTokens: number;
  contextTokens: number;
  /** Standup owns this session's pane, so it can be replied to. */
  owned: boolean;
}

/**
 * Loads a session's transcript as readable message cards, projected from the
 * Phase-2 transcript-events log (see useSessionEvents + reduceSessionProjection).
 * The hook opens on the tail (the newest records) so a long session loads in
 * constant time; `hasMore`/`loadMore` page earlier records in on demand. The
 * projection folds whatever records are loaded — a contiguous suffix of the log
 * — so `totalMessages`/`outputTokens` reflect the loaded window, and pending→
 * resolved tool pairing stays correct because a tool_use and its later
 * tool_result always fall on the same side of the tail cut.
 */
export function useTranscript({
  sessionId,
  sessionEnded,
  eventSignal,
}: {
  sessionId: string;
  sessionEnded: boolean;
  eventSignal: number;
}) {
  const { records, owned, loading, hasEarlier, loadEarlier, reload } = useSessionEvents({
    sessionId,
    sessionEnded,
    eventSignal,
  });

  const proj = useMemo(() => reduceSessionProjection(records), [records]);

  const page = useMemo<TranscriptPage | null>(() => {
    // Nothing fetched yet — let the view show its "reading…" state.
    if (loading && records.length === 0) return null;
    return {
      messages: proj.messages,
      hasMore: hasEarlier,
      totalMessages: proj.messages.length,
      outputTokens: proj.outputTokens,
      contextTokens: proj.contextTokens,
      owned,
    };
  }, [proj, owned, loading, records.length, hasEarlier]);

  return { page, loading, loadMore: loadEarlier, reload };
}
