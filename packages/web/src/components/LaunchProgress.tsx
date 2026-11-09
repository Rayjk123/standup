import { useState, useEffect, useRef, type RefObject } from "react";
import type { Launch, LaunchPhase } from "@standup/shared";
import { theme } from "./theme";
import { CollapsibleText } from "./CollapsibleText";
import { PipelineSection } from "./PipelineSection";

/**
 * Human label for a still-"starting" launch's current phase. A provisioned
 * launch (a workspace of several checkouts, etc.) runs three slow steps; naming the one it's
 * in is what turns a static "provisioning…" into visible movement.
 */
export function launchPhaseLabel(launch: Launch): string {
  if (launch.phase === "queued") return "queued for host room…";
  if (!launch.provisioned) return "starting…";
  switch (launch.phase) {
    case "building":
      return "installing / building…";
    case "starting":
      return "starting agent…";
    case "provisioning":
    default:
      return "provisioning workspace…";
  }
}

/** Canonical order of the slow launch steps, matching the collector's setPhase. */
const PHASE_ORDER: LaunchPhase[] = ["provisioning", "building", "starting"];

/**
 * The active-tense label shown for each lifecycle step in the transcript.
 * `queued` precedes the slow steps rather than being one of them: it is shown
 * on its own line, with the reason streamed into the launch log.
 */
const PHASE_LABEL: Record<LaunchPhase, string> = {
  queued: "Queued until the host has room…",
  provisioning: "Provisioning workspace…",
  building: "Building…",
  starting: "Starting the agent…",
};

/**
 * How far a launch has progressed, as an index into PHASE_ORDER: -1 before any
 * phase is recorded (just "starting up"), 0-2 within the slow steps, and
 * PHASE_ORDER.length once running (every step done). A failed launch clears its
 * phase, so it lands back at -1 and the failure line carries the story instead.
 */
function reachedIndex(launch: Launch): number {
  if (launch.status === "running") return PHASE_ORDER.length;
  if (!launch.phase) return -1;
  return PHASE_ORDER.indexOf(launch.phase);
}

interface LaunchProgressProps {
  launchId: string;
  /** The row from the list, for an immediate first paint before the poll. */
  initialLaunch?: Launch;
  /** Called once the launch has a live session, so the pane can switch to it. */
  onOpenSession: (sessionId: string) => void;
}

/**
 * A launch before its agent's session attaches, rendered as the transcript it
 * is becoming rather than a separate placeholder screen. The pre-attach
 * lifecycle — starting → provisioning → building → starting the agent — reads
 * as ordinary status lines in the same feed the live conversation will fill,
 * with the provision/build output (the slow, interesting part for a provisioned
 * workspace) streamed inline under the step it belongs to. When the agent
 * reports in, the pane hands off to the session view — a continuation of the
 * same transcript, not a swap out of a badge state.
 *
 * The incremental log is DB-only (not pushed on the socket), so this polls the
 * launch row the way SessionScreen polls a live pane, and stops the moment the
 * launch reaches a live session or a terminal state.
 */
export function LaunchProgress({
  launchId,
  initialLaunch,
  onOpenSession,
}: LaunchProgressProps) {
  const [launch, setLaunch] = useState<Launch | null>(initialLaunch ?? null);
  const logRef = useRef<HTMLPreElement>(null);
  // Guards against a double hand-off if two polls land before the pane swaps.
  const handedOff = useRef(false);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setInterval> | undefined;

    async function load() {
      try {
        const res = await fetch(`/api/launches/${launchId}`);
        if (!res.ok || !alive) return;
        const next = (await res.json()) as Launch;
        setLaunch(next);

        // The agent has started and reported in — its session is where the
        // real work is watchable, so switch to it and stop polling.
        if (next.status === "running" && next.sessionId && !handedOff.current) {
          handedOff.current = true;
          onOpenSession(next.sessionId);
        }
        // Nothing more will change once terminal — stop polling.
        if (next.status !== "starting" && timer) clearInterval(timer);
      } catch {
        /* transient; the next tick retries */
      }
    }

    void load();
    timer = setInterval(load, 1500);
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [launchId, onOpenSession]);

  // Keep the newest output in view as it streams in, unless the user has
  // scrolled up to read something.
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [launch?.log]);

  const failed = launch?.status === "failed";
  const log = launch?.log?.trim() ? launch.log : "";

  // An existing-tree launch (in-place, or an adopted checkout) skips
  // provision/build entirely and goes straight to starting the agent, so those
  // steps would be fiction — only "starting the agent" applies there.
  const existingTree =
    launch?.inPlace === true || launch?.kind === "adopted";
  const slowSteps: LaunchPhase[] = existingTree
    ? ["starting"]
    : PHASE_ORDER;

  const reached = launch ? reachedIndex(launch) : -1;

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
      {/* Reads like a session's header — task as the title, a status meta line —
          so a launching session looks like a session from the first paint. */}
      <div
        style={{
          padding: "16px 20px 12px",
          borderBottom: `1px solid ${theme.edgeSoft}`,
        }}
      >
        {/* The task is the header's title. A pasted blob (a tens-of-KB report)
            would otherwise render full-size in this non-scrolling header and
            push the lifecycle log off-screen, so a long task collapses to a
            bounded preview here just as it does in the transcript. */}
        <div style={{ fontSize: 15, fontWeight: 600, color: theme.text }}>
          <CollapsibleText
            text={launch?.task ?? "Launch"}
            markdown={false}
            maxLines={12}
            maxChars={800}
          />
        </div>
        <div
          style={{
            display: "flex",
            gap: 14,
            marginTop: 8,
            alignItems: "center",
            flexWrap: "wrap",
            fontFamily: theme.mono,
            fontSize: 11,
            color: theme.faint,
          }}
        >
          <span
            style={{
              color: failed ? theme.waiting : theme.running,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              fontSize: 10.5,
            }}
          >
            {failed ? "failed" : "starting"}
          </span>
          {launch?.branch && (
            <span>
              {launch.branch}
              {launch.kind ? ` (${launch.kind})` : ""}
            </span>
          )}
        </div>
      </div>

      {/* The lifecycle as transcript entries: one subtle status line per step
          the launch has reached, the streamed provision/build output inline
          under the step it's running, and the failure — if any — as its own
          line rather than a stuck badge. */}
      <div style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "8px 0 16px" }}>
        {launch === null ? (
          <StatusLine dot={theme.running} label="Starting…" active />
        ) : (
          <>
            <StatusLine
              dot={reached > -1 || failed ? theme.checkpoint : theme.running}
              label={reached > -1 || failed ? "Starting" : "Starting…"}
              active={reached === -1 && !failed && launch.phase !== "queued"}
            />

            {launch.phase === "queued" && !failed && (
              <div>
                <StatusLine dot={theme.running} label={PHASE_LABEL.queued} active />
                {log && <LogBlock innerRef={logRef}>{log}</LogBlock>}
              </div>
            )}

            {slowSteps.map((phase) => {
              const rank = PHASE_ORDER.indexOf(phase);
              if (rank > reached) return null; // not reached yet — appears when it is
              const isActive = rank === reached && !failed;
              return (
                <div key={phase}>
                  <StatusLine
                    dot={isActive ? theme.running : theme.checkpoint}
                    label={isActive ? PHASE_LABEL[phase] : PHASE_LABEL[phase].replace(/…$/, "")}
                    active={isActive}
                  />
                  {isActive && log && <LogBlock innerRef={logRef}>{log}</LogBlock>}
                </div>
              );
            })}

            {failed && (
              <div>
                <StatusLine dot={theme.waiting} label="Launch failed" tone={theme.waiting} />
                {launch.error && (
                  <div
                    style={{
                      padding: "0 20px 4px 36px",
                      fontFamily: theme.mono,
                      fontSize: 11.5,
                      lineHeight: 1.5,
                      color: theme.dim,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    }}
                  >
                    {launch.error}
                  </div>
                )}
                {log && <LogBlock innerRef={logRef}>{log}</LogBlock>}
              </div>
            )}
          </>
        )}
        <PipelineSection launchIds={[launchId]} style={{ padding: "12px 20px 0" }} />
      </div>
    </div>
  );
}

/**
 * One lifecycle line — a status dot and mono label, matching the transcript's
 * own system/status rows (a task-notification line) so the launch feed and the
 * conversation that follows it read as one surface.
 */
function StatusLine({
  dot,
  label,
  active = false,
  tone,
}: {
  dot: string;
  label: string;
  active?: boolean;
  tone?: string;
}) {
  return (
    <div
      style={{
        padding: "7px 20px",
        display: "flex",
        gap: 8,
        alignItems: "baseline",
      }}
    >
      <span style={{ color: dot, fontSize: 10, flexShrink: 0 }}>●</span>
      <span
        style={{
          fontFamily: theme.mono,
          fontSize: 11.5,
          color: tone ?? (active ? theme.text : theme.dim),
          wordBreak: "break-word",
          flex: 1,
          minWidth: 0,
        }}
      >
        {label}
      </span>
    </div>
  );
}

/** The streamed provision/build output, indented under the step it belongs to. */
function LogBlock({
  children,
  innerRef,
}: {
  children: string;
  innerRef: RefObject<HTMLPreElement>;
}) {
  return (
    <pre
      ref={innerRef}
      style={{
        margin: "2px 20px 6px 36px",
        fontFamily: theme.mono,
        fontSize: 11,
        lineHeight: 1.5,
        color: theme.dim,
        background: theme.ground,
        border: `1px solid ${theme.edgeSoft}`,
        borderRadius: 6,
        padding: "9px 11px",
        maxHeight: 340,
        overflow: "auto",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {children}
    </pre>
  );
}
