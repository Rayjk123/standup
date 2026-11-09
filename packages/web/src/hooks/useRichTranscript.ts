import { useMemo } from "react";
import { useSessionEvents } from "./useSessionEvents";
import { reduceSessionRows } from "./sessionProjection";

/** Mirrors the server types in collector/src/rich-transcript.ts. */

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
  answer?: string;
}

export type ToolResult =
  | { kind: "bash"; stdout: string; stderr: string; interrupted: boolean }
  | { kind: "diff"; filePath: string; hunks: DiffHunk[] }
  | { kind: "write"; filePath: string; lineCount: number }
  | { kind: "read"; filePath: string; numLines?: number; totalLines?: number }
  | { kind: "todo"; todos: { content?: string; status?: string }[] }
  | { kind: "question"; questions: AskQuestion[] }
  | { kind: "agent"; agentType?: string; status?: string }
  | { kind: "text"; text: string; isError: boolean }
  | { kind: "pending" };

interface RowBase {
  id: string;
  timestamp: string;
}

export type RichRow =
  | (RowBase & { kind: "user"; text: string; sentBy?: string })
  | (RowBase & { kind: "localCommand"; name: string; args: string; stdout: string })
  | (RowBase & { kind: "taskNotification"; summary: string; status: string })
  | (RowBase & { kind: "thinking"; text: string })
  | (RowBase & { kind: "text"; text: string })
  | (RowBase & {
      kind: "tool";
      name: string;
      input: Record<string, unknown>;
      result: ToolResult;
    })
  | (RowBase & { kind: "compaction"; trigger: string; preTokens: number; postTokens: number })
  | (RowBase & { kind: "mode"; label: string });

export interface RichTranscriptPage {
  rows: RichRow[];
  hasMore: boolean;
  /** History exists before this window but isn't reachable by paging yet. */
  truncated: boolean;
  totalRows: number;
  outputTokens: number;
  contextTokens: number;
  model?: string;
  /** Standup owns this session's pane, so it can be replied to. */
  owned: boolean;
}

/**
 * Loads a session's transcript as an ordered, full-fidelity row stream,
 * projected from the Phase-2 transcript-events log (see useSessionEvents +
 * reduceSessionRows). The hook opens on the tail (the newest records) so a long
 * session loads in constant time; `hasMore`/`loadMore` page earlier records in
 * on demand. The projection folds whatever records are loaded — a contiguous
 * suffix of the log — so token totals reflect the loaded window, and pending
 * tool rows resolve in place as their results arrive.
 */
export function useRichTranscript({
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

  const proj = useMemo(() => reduceSessionRows(records), [records]);

  const page = useMemo<RichTranscriptPage | null>(() => {
    if (loading && records.length === 0) return null;
    return {
      rows: proj.rows,
      hasMore: hasEarlier,
      truncated: false,
      totalRows: proj.rows.length,
      outputTokens: proj.outputTokens,
      contextTokens: proj.contextTokens,
      model: proj.model,
      owned,
    };
  }, [proj, owned, loading, records.length, hasEarlier]);

  return { page, loading, loadMore: loadEarlier, reload };
}
