import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { alpha, theme } from "./theme";
import { PersonalizationSettings } from "./PersonalizationSettings";
import { ThemeControl } from "./ThemeControl";
import { PlaybooksSection } from "./PlaybooksSection";
import { PersonaProfileView } from "./PersonaProfileView";
import { YourUsageSection } from "./YourUsageSection";
import { JobBudgetSettings } from "./JobBudgetSettings";
import { TeamKnowledgeApiSettings } from "./TeamKnowledgeApiSettings";
import { PersonaDecisionsSection } from "./PersonaFloorDecisions";
import { NotificationSettings } from "./NotificationSettings";
import { DeciderSettings } from "./DeciderSettings";
import { WorkspaceOrchestration, WorkspaceSettings } from "./WorkspaceSettings";
import { useNarrow } from "../hooks/useNarrow";
import { isYouSectionId, youSectionPath, type YouSectionId } from "../lib/youSections";

/**
 * The You tab's groups: the viewer's own sections, then the settings that
 * apply to everyone on this Standup host.
 */
const YOU_GROUPS = [
  { id: "yours", label: "Yours" },
  { id: "workspace", label: "Workspace" },
] as const;

type YouGroupId = (typeof YOU_GROUPS)[number]["id"];

/** One section of the You tab: the viewer's own information or settings, or a host-wide setting. */
interface YouSection {
  /** The path segment, `/you/<id>`. */
  id: YouSectionId;
  /** Absent for the viewer's own sections; a Workspace section is tagged as applying to everyone. */
  group?: Exclude<YouGroupId, "yours">;
  title: string;
  /** One line under the title saying what the section holds. */
  summary: string;
  render: () => ReactNode;
}

/**
 * The You tab's sections, in page order. Each renders self-fetching content
 * scoped to the signed-in viewer, or — in the Workspace group — the host-wide
 * settings; a new section is its id in YOU_SECTION_IDS plus one entry here.
 */
const YOU_SECTIONS: readonly YouSection[] = [
  {
    id: "profile",
    title: "Profile",
    summary: "Who you are, the standing instructions every session you launch carries, and what Persona knows about you.",
    render: () => (
      <>
        <PersonalizationSettings />
        <div style={{ marginTop: 22, paddingTop: 18, borderTop: `1px solid ${theme.edge}` }}>
          <PersonaProfileView />
        </div>
      </>
    ),
  },
  {
    id: "appearance",
    title: "Appearance",
    summary: "Light, dark, or matching your system.",
    render: () => <ThemeControl />,
  },
  {
    id: "decider",
    title: "Decision routing",
    summary: "Which model answers Standup's small decisions for you, and what it decided.",
    render: () => <DeciderSettings />,
  },
  {
    id: "usage",
    title: "Cost & usage",
    summary: "Token usage and estimated cost of the sessions you own.",
    render: () => <YourUsageSection />,
  },
  {
    id: "budgets",
    title: "Job budgets",
    summary: "The time and spend each Persona job may use before Persona is told and new launches wait for you.",
    render: () => <JobBudgetSettings />,
  },
  {
    id: "team-api",
    title: "Team knowledge API",
    summary: "Let teammates search your knowledge base read-only over your tunnel, and see who has.",
    render: () => <TeamKnowledgeApiSettings />,
  },
  {
    id: "decisions",
    title: "Persona's floor allows",
    summary: "Safety-floor holds your Persona allowed once on its own, with the call and its reason.",
    render: () => <PersonaDecisionsSection />,
  },
  {
    id: "notifications",
    title: "Notifications",
    summary: "Your daily brief, and which Persona updates reach you on Slack or push — globally or per project.",
    render: () => <NotificationSettings />,
  },
  {
    id: "playbooks",
    title: "Playbooks",
    summary: "How past jobs went, saved by Persona and reused in later briefs.",
    render: () => <PlaybooksSection />,
  },
  {
    id: "workspace",
    group: "workspace",
    title: "Multiplayer",
    summary: "How new launches share a repo when more than one person uses this Standup.",
    render: () => <WorkspaceSettings />,
  },
  {
    id: "orchestration",
    group: "workspace",
    title: "Orchestration",
    summary: "The steps a launch follows unless a project, your own profiles, or the launch itself picks other ones.",
    render: () => <WorkspaceOrchestration />,
  },
];

const groupOf = (s: YouSection): YouGroupId => s.group ?? "yours";

/**
 * The per-user page, and the one place for settings: every section stacked in
 * one scroll, with a side rail (a chip row on a phone) that jumps between them.
 * The selected section lives in the path (`/you/usage`), so a link (or the old
 * /cost and /settings routes) lands on it; an unknown section falls back to the
 * top of the page.
 */
export function YouView() {
  const { section } = useParams();
  const narrow = useNarrow();
  const scroller = useRef<HTMLDivElement>(null);
  const anchors = useRef(new Map<string, HTMLElement>());

  const content = useRef<HTMLDivElement>(null);
  // The section just jumped to wears an amber ring for a moment, so the eye
  // finds where it landed (a short section near the end sits mid-screen).
  const [arrived, setArrived] = useState<string | null>(null);
  const arrivedTimer = useRef<ReturnType<typeof setTimeout>>();
  const arrive = (id: string) => {
    clearTimeout(arrivedTimer.current);
    setArrived(id);
    arrivedTimer.current = setTimeout(() => setArrived(null), 1200);
  };
  useEffect(() => {
    if (section && isYouSectionId(section)) arrive(section);
  }, [section]);
  useEffect(() => () => clearTimeout(arrivedTimer.current), []);
  const reducedMotion = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  // Sections above the target load asynchronously and grow after the first
  // scroll, which would push the target back down. So the jump is repeated as
  // the content resizes, until the viewer scrolls themselves or it settles.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const jump = () => {
      if (section) anchors.current.get(section)?.scrollIntoView?.({ block: "start" });
      else el.scrollTo?.({ top: 0 });
    };
    jump();
    if (!section || typeof ResizeObserver === "undefined" || !content.current) return;
    const observer = new ResizeObserver(jump);
    observer.observe(content.current);
    const stop = () => observer.disconnect();
    const settle = setTimeout(stop, 3000);
    // Any input of the viewer's own (wheel, touch, scrollbar drag, keys) ends it.
    const inputs = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
    for (const type of inputs) el.addEventListener(type, stop, { once: true, passive: true });
    return () => {
      clearTimeout(settle);
      stop();
      for (const type of inputs) el.removeEventListener(type, stop);
    };
  }, [section]);

  if (section !== undefined && !isYouSectionId(section)) return <Navigate to="/you" replace />;

  const pad = narrow ? 14 : 24;
  // Bare /you opens on the first section, so the rail marks it.
  const current = section ?? YOU_SECTIONS[0].id;
  const link = (s: YouSection) => {
    const isActive = s.id === current;
    return (
      <Link
        key={s.id}
        to={youSectionPath(s.id)}
        aria-current={isActive ? "page" : undefined}
        // The path doesn't change on a second click, so the jump is made here.
        onClick={() => {
          if (s.id !== section) return;
          anchors.current.get(s.id)?.scrollIntoView?.({ block: "start" });
          arrive(s.id);
        }}
        style={
          narrow
            ? {
                fontSize: 12.5,
                fontWeight: 600,
                padding: "8px 12px",
                borderRadius: 999,
                textDecoration: "none",
                whiteSpace: "nowrap",
                flexShrink: 0,
                border: `1px solid ${isActive ? theme.accent : theme.edge}`,
                background: isActive ? theme.accentSoft : "transparent",
                color: isActive ? theme.text : theme.dim,
              }
            : {
                display: "block",
                fontSize: 12.5,
                fontWeight: 600,
                padding: "6px 10px",
                borderRadius: 5,
                textDecoration: "none",
                background: isActive ? theme.accentSoft : "transparent",
                boxShadow: isActive ? `inset 2px 0 0 ${theme.accent}` : "none",
                color: isActive ? theme.text : theme.dim,
              }
        }
      >
        {s.title}
      </Link>
    );
  };
  const groupLabel: CSSProperties = {
    fontFamily: theme.mono,
    fontSize: 9.5,
    letterSpacing: "0.14em",
    textTransform: "uppercase",
    color: theme.faint,
    margin: 0,
    padding: "0 10px 6px",
  };
  // On a phone the sections are a sticky chip row, the groups split by a
  // rule; on a desktop they are a sticky side rail under group labels.
  const nav = narrow ? (
    <div
      style={{
        position: "sticky",
        top: 0,
        zIndex: 1,
        background: theme.ground,
        borderBottom: `1px solid ${theme.edgeSoft}`,
        padding: "10px 0",
      }}
    >
      <nav aria-label="You sections" style={{ padding: `0 ${pad}px`, display: "flex", gap: 6, overflowX: "auto" }}>
        {YOU_GROUPS.map((g, i) => [
          i > 0 && <span key={`${g.id}-rule`} aria-hidden style={{ width: 1, flexShrink: 0, background: theme.edge, margin: "3px 2px" }} />,
          ...YOU_SECTIONS.filter((s) => groupOf(s) === g.id).map(link),
        ])}
      </nav>
    </div>
  ) : (
    <nav aria-label="You sections" style={{ position: "sticky", top: 18, alignSelf: "start", display: "grid", gap: 18 }}>
      {YOU_GROUPS.map((g) => (
        <div key={g.id} role="group" aria-labelledby={`you-group-${g.id}`}>
          <p id={`you-group-${g.id}`} style={groupLabel}>{g.label}</p>
          <div style={{ display: "grid", gap: 2 }}>{YOU_SECTIONS.filter((s) => groupOf(s) === g.id).map(link)}</div>
        </div>
      ))}
    </nav>
  );
  return (
    <div ref={scroller} style={{ overflowY: "auto", height: "100%" }}>
      {narrow && nav}
      <div
        style={
          narrow
            ? undefined
            : { maxWidth: 1120, margin: "0 auto", padding: `18px ${pad}px 0`, display: "grid", gridTemplateColumns: "200px minmax(0, 1fr)", gap: 24 }
        }
      >
      {!narrow && nav}
      <div
        ref={content}
        style={{ maxWidth: 880, width: "100%", margin: "0 auto", padding: narrow ? `18px ${pad}px 48px` : "0 0 48px", display: "grid", gap: 18 }}
      >
        {YOU_SECTIONS.map((s) => (
          <section
            key={s.id}
            id={`you-${s.id}`}
            aria-labelledby={`you-${s.id}-title`}
            ref={(el) => {
              if (el) anchors.current.set(s.id, el);
              else anchors.current.delete(s.id);
            }}
            style={{
              // Lands a jumped-to section below the phone's sticky chip row, or a
              // little below the top on a desktop, level with the rail.
              scrollMarginTop: narrow ? 64 : 18,
              background: theme.surface,
              border: `1px solid ${theme.edge}`,
              borderRadius: 10,
              padding: narrow ? "16px 14px 20px" : "20px 22px 24px",
              minWidth: 0,
              boxShadow: `0 0 0 2px ${alpha(theme.accent, arrived === s.id ? 0x66 : 0)}`,
              transition: reducedMotion ? "none" : "box-shadow 600ms cubic-bezier(0.16, 1, 0.3, 1)",
            }}
          >
            <h2 id={`you-${s.id}-title`} style={{ fontSize: 15, fontWeight: 700, color: theme.text, margin: 0 }}>
              {s.title}
              {s.group && " "}
              {s.group && (
                <span
                  style={{
                    fontFamily: theme.mono,
                    fontSize: 9.5,
                    fontWeight: 600,
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    color: theme.dim,
                    border: `1px solid ${theme.edge}`,
                    borderRadius: 3,
                    padding: "1px 6px",
                    marginLeft: 8,
                    verticalAlign: 2,
                  }}
                >
                  Everyone on this Standup
                </span>
              )}
            </h2>
            <div style={{ fontSize: 12, color: theme.dim, margin: "4px 0 16px", lineHeight: 1.5 }}>{s.summary}</div>
            {s.render()}
          </section>
        ))}
      </div>
      </div>
    </div>
  );
}
