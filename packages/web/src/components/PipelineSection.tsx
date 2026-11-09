import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { runIsLive } from "@standup/shared";
import type { PipelineRun } from "@standup/shared";
import { theme } from "./theme";
import { PipelineView } from "./PipelineView";
import {
  applyPipelineFrame,
  applyRunsRead,
  pipelineViewer,
  subscribePipelineResync,
  subscribePipelineUpdates,
} from "../lib/pipelineUpdates";

/** How often pipeline runs are re-read while shown. */
const POLL_MS = 5000;

/**
 * The pipeline runs of `launchIds`, re-read every `pollMs` (never, when it is
 * 0) and on each socket resync, and updated by `pipeline:updated` frames (see
 * applyPipelineFrame).
 * `setRun` applies a run returned by an action (a waive) without waiting for
 * the next read. A change of `refreshKey` re-reads at once: a run's worker
 * state (PipelineRun.worker) changes when a session ends, which sends no
 * pipeline frame.
 */
export function usePipelineRuns(
  launchIds: string[],
  pollMs: number = POLL_MS,
  refreshKey = ""
): { runs: PipelineRun[]; loaded: boolean; loadedKey: string | null; setRun: (run: PipelineRun) => void } {
  const [runs, setRuns] = useState<PipelineRun[]>([]);
  const [loaded, setLoaded] = useState(false);
  // The launch-id set the last finished read was for, so a caller can tell a
  // read of the current set from one of an earlier set.
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const key = launchIds.join(",");

  const setRun = useCallback((run: PipelineRun) => {
    setRuns((prev) => {
      const i = prev.findIndex((r) => r.id === run.id);
      if (i === -1) return prev;
      const next = prev.slice();
      next[i] = run;
      return next;
    });
  }, []);

  useEffect(() => {
    if (!key) {
      setRuns([]);
      setLoaded(true);
      setLoadedKey("");
      return;
    }
    let cancelled = false;
    // The runs frames changed while each read was in flight: a read keeps those (see applyRunsRead).
    const inFlight = new Set<Set<string>>();
    // A failed read retries on its own when nothing polls: after 2s, then 4s, up to 30s apart.
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = 2000;
    const load = async () => {
      const framed = new Set<string>();
      inFlight.add(framed);
      let ok = false;
      try {
        const res = await fetch(`/api/pipeline/runs?launchIds=${encodeURIComponent(key)}`);
        if (res.ok) {
          const data = (await res.json()) as { runs?: PipelineRun[] };
          const read = data.runs;
          if (!cancelled && Array.isArray(read)) {
            setRuns((prev) => applyRunsRead(prev, read, framed));
            ok = true;
          }
        }
      } catch {
        // Keep the last runs on screen; a later read retries.
      } finally {
        inFlight.delete(framed);
        if (!cancelled) {
          setLoaded(true);
          if (ok) {
            setLoadedKey(key);
            clearTimeout(retryTimer);
            retryDelay = 2000;
          } else if (pollMs <= 0) {
            clearTimeout(retryTimer);
            retryTimer = setTimeout(() => void load(), retryDelay);
            retryDelay = Math.min(retryDelay * 2, 30000);
          }
        }
      }
    };
    void load();
    const timer = pollMs > 0 ? setInterval(() => void load(), pollMs) : undefined;
    const ids = new Set(key.split(","));
    const unsubscribe = subscribePipelineUpdates((run) => {
      for (const framed of inFlight) framed.add(run.id);
      setRuns((prev) => applyPipelineFrame(prev, run, ids, pipelineViewer()));
    });
    const unsubscribeResync = subscribePipelineResync(() => void load());
    return () => {
      cancelled = true;
      clearInterval(timer);
      clearTimeout(retryTimer);
      unsubscribe();
      unsubscribeResync();
    };
  }, [key, pollMs, refreshKey]);

  return { runs, loaded, loadedKey, setRun };
}

/**
 * `runs` (oldest first) split into the ones to show and the earlier ones to
 * fold away: every run whose launch still has a worker (see runIsLive) is
 * current; when none does, the newest run is, so a finished job still shows
 * its last pipeline. The rest keep their order.
 */
export function splitRuns(runs: PipelineRun[]): { current: PipelineRun[]; earlier: PipelineRun[] } {
  const live = runs.filter(runIsLive);
  const current = live.length > 0 ? live : runs.slice(-1);
  const shown = new Set(current.map((r) => r.id));
  return { current, earlier: runs.filter((r) => !shown.has(r.id)) };
}

function RunItem({
  run,
  readOnly,
  onRunChange,
  surface,
}: {
  run: PipelineRun;
  readOnly: boolean;
  onRunChange?: (run: PipelineRun) => void;
  surface?: string;
}) {
  return run.status === "disabled" ? (
    <div data-testid="pipeline-off" style={{ fontSize: 12, color: theme.faint }}>
      Pipeline off for this launch.
    </div>
  ) : (
    <PipelineView run={run} readOnly={readOnly} onRunChange={onRunChange} surface={surface} />
  );
}

/**
 * One PipelineView per current run (see splitRuns), and the earlier launches'
 * runs folded under a closed "Earlier launches (N)" disclosure; a run whose
 * pipeline is disabled shows a single "pipeline off" line instead.
 */
export function PipelineRunList({
  runs,
  readOnly = false,
  onRunChange,
  surface,
}: {
  runs: PipelineRun[];
  readOnly?: boolean;
  onRunChange?: (run: PipelineRun) => void;
  /** The background the views sit on (see PipelineGraph). */
  surface?: string;
}) {
  const { current, earlier } = splitRuns(runs);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {current.map((run) => (
        <RunItem key={run.id} run={run} readOnly={readOnly} onRunChange={onRunChange} surface={surface} />
      ))}
      {earlier.length > 0 && (
        <details data-testid="pipeline-earlier">
          <summary style={{ fontSize: 12, color: theme.dim, cursor: "pointer" }}>
            Earlier launches ({earlier.length})
          </summary>
          <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 10 }}>
            {earlier.map((run) => (
              <RunItem key={run.id} run={run} readOnly={readOnly} onRunChange={onRunChange} surface={surface} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

/**
 * The "Pipeline" block for a launch view: a heading and the runs of
 * `launchIds`. Renders nothing until a launch has a run.
 */
export function PipelineSection({
  launchIds,
  pollMs,
  readOnly = false,
  style,
}: {
  launchIds: string[];
  pollMs?: number;
  readOnly?: boolean;
  style?: CSSProperties;
}) {
  const { runs, setRun } = usePipelineRuns(launchIds, pollMs);
  if (runs.length === 0) return null;
  return (
    <section data-testid="pipeline-section" style={{ display: "flex", flexDirection: "column", gap: 8, ...style }}>
      <div style={heading}>Pipeline</div>
      <PipelineRunList runs={runs} readOnly={readOnly} onRunChange={setRun} />
    </section>
  );
}

const heading: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: theme.faint,
};
