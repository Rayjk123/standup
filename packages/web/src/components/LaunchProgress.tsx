import { useState, useEffect, useRef } from "react";
import type { Launch } from "@standup/shared";
import { theme } from "./theme";

/**
 * Human label for a still-"starting" launch's current phase. A provisioned
 * launch (a Brazil workspace, etc.) runs three slow steps; naming the one it's
 * in is what turns a static "provisioning…" into visible movement.
 */
export function launchPhaseLabel(launch: Launch): string {
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

interface LaunchProgressProps {
  launchId: string;
  /** The row from the list, for an immediate first paint before the poll. */
  initialLaunch?: Launch;
  /** Called once the launch has a live session, so the pane can switch to it. */
  onOpenSession: (sessionId: string) => void;
}

/**
 * Live view of a launch while it provisions — the workspace-create and
 * install/build output that used to be invisible (it ran detached with no
 * session, no tmux pane, and the log discarded). The collector now streams
 * that output onto the launch row; this polls it, the same way SessionScreen
 * polls a live pane, and hands off to the session view the moment the agent
 * actually starts.
 */
export function LaunchProgress({
  launchId,
  initialLaunch,
  onOpenSession,
}: LaunchProgressProps) {
  const [launch, setLaunch] = useState<Launch | null>(initialLaunch ?? null);
  const preRef = useRef<HTMLPreElement>(null);
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
    const el = preRef.current;
    if (!el) return;
    const nearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [launch?.log]);

  const failed = launch?.status === "failed";
  const label = launch ? launchPhaseLabel(launch) : "loading…";

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div
        style={{
          padding: "18px 20px 14px",
          borderBottom: `1px solid ${theme.edgeSoft}`,
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 600, color: theme.text }}>
          {launch?.task ?? "Launch"}
        </div>
        <div
          style={{
            marginTop: 8,
            fontFamily: theme.mono,
            fontSize: 11,
            letterSpacing: "0.06em",
            color: failed ? theme.waiting : theme.running,
          }}
        >
          {failed ? "✕ failed" : `⧗ ${label}`}
        </div>
        {failed && launch?.error && (
          <div
            style={{
              marginTop: 8,
              fontFamily: theme.mono,
              fontSize: 11,
              color: theme.faint,
              lineHeight: 1.45,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {launch.error}
          </div>
        )}
      </div>

      <div style={{ flex: 1, minHeight: 0, padding: "12px 20px 20px" }}>
        <div
          style={{
            fontFamily: theme.mono,
            fontSize: 9.5,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: theme.faint,
            marginBottom: 6,
          }}
        >
          Provision & build output
        </div>
        <pre
          ref={preRef}
          style={{
            fontFamily: theme.mono,
            fontSize: 11,
            lineHeight: 1.5,
            color: theme.dim,
            background: theme.ground,
            border: `1px solid ${theme.edgeSoft}`,
            borderRadius: 6,
            padding: "10px 12px",
            margin: 0,
            height: "100%",
            boxSizing: "border-box",
            overflow: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {launch?.log?.trim()
            ? launch.log
            : "Waiting for output — the workspace is being created…"}
        </pre>
      </div>
    </div>
  );
}
