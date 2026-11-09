import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  BOARD_STATUSES,
  BOARD_STATUS_LABEL,
  describeConflict,
  isOpenBoardStatus,
  type BoardStatus,
  type BoardTaskFlag,
  type BoardTaskSource,
  type BoardTaskWithConflicts,
  type Launch,
  type ProjectWithCounts,
  type ReviewFinding,
  type Session,
  type TaskRun,
  type Ticket,
} from "@standup/shared";
import { LuArrowUpRight, LuChevronDown, LuChevronRight, LuExternalLink, LuSearch, LuTriangleAlert } from "react-icons/lu";
import { alpha, theme } from "./theme";
import { ProjectIcon } from "./ProjectIcon";
import {
  LiveTicketCard,
  TicketQuickActions,
  TicketSeverityLens,
  findingsByTicket,
  ticketRunResolver,
  timeAgo,
  type TicketActions,
} from "./TicketCard";
import {
  CLOSED_COLUMN_CAP,
  boardFilterKey,
  cardLinks,
  filterBoardTasks,
  groupByColumn,
  parseBoardFilter,
  ticketIdOf,
  waitingOnLine,
  writeBoardFilter,
  type BoardCardLink,
  type BoardFilter,
  type BoardListState,
  type WaitingOnTone,
} from "../lib/board";
import { parseLiveWorkers, writeLiveWorkers } from "../lib/liveWorkers";

const COLUMN_ACCENT: Record<BoardStatus, string> = {
  queued: theme.faint,
  coding: theme.running,
  validation: theme.expert,
  live_check: theme.running,
  in_review: theme.stalled,
  waiting: theme.waiting,
  done: theme.checkpoint,
  failed: theme.faint,
};

const FLAG_COLOR: Record<BoardTaskFlag, string> = {
  planned: theme.expert,
  cancelled: theme.faint,
  parked: theme.stalled,
};

const SOURCE_LABEL: Record<BoardTaskSource, string> = {
  job: "job",
  ticket: "ticket",
  backlog: "backlog",
};

const SOURCE_OPTIONS: { value: BoardTaskSource | ""; label: string }[] = [
  { value: "", label: "All sources" },
  { value: "job", label: "Jobs" },
  { value: "ticket", label: "Tickets" },
  { value: "backlog", label: "Backlog" },
];

const STATUS_OPTIONS: { value: BoardStatus | ""; label: string }[] = [
  { value: "", label: "All columns" },
  ...BOARD_STATUSES.map((s) => ({ value: s, label: BOARD_STATUS_LABEL[s] })),
];

const SIGN_IN_INSTRUCTION =
  "Ask the host for a sign-in link (bun run scripts/console-login.ts --user <you>).";

/** What the board says when it can't read the viewer's own tasks. */
const LIST_NOTICE: Partial<Record<BoardListState, string>> = {
  team: `Sign in to the console to see your Persona's jobs here. ${SIGN_IN_INSTRUCTION} The ticket queue shows below.`,
  refused: `You're not signed in, so the board can't show your Persona's jobs or the ticket queue. ${SIGN_IN_INSTRUCTION}`,
  pending: "Loading the board…",
  failed: "Couldn't read the board yet. Retrying…",
  unavailable: "This collector doesn't serve the board. Update Standup, then reload.",
};

/** A waitingOn line on the viewer reads plainly; Persona deciding by itself is muted and italic. */
const WAITING_ON_STYLE: Record<WaitingOnTone, React.CSSProperties> = {
  viewer: { color: theme.dim },
  persona: { color: theme.faint, fontStyle: "italic" },
  parked: { color: theme.stalled },
};

/** Open High/critical findings, the ones a needs_review ticket's collapsed card counts. */
function openHighFindings(findings: readonly ReviewFinding[]): number {
  return findings.filter((f) => f.status === "open" && (f.severity === "high" || f.severity === "critical")).length;
}

/** How long a card that just changed column stays highlighted. */
const MOVED_HIGHLIGHT_MS = 1600;

const control: React.CSSProperties = {
  fontSize: 11.5, fontWeight: 600, border: `1px solid ${theme.edge}`,
  borderRadius: 5, padding: "5px 10px", background: "none", color: theme.text,
};
const linkStyle: React.CSSProperties = {
  fontSize: 11.5, color: theme.running, textDecoration: "none",
  display: "inline-flex", alignItems: "center", gap: 3,
};
const chip = (color: string): React.CSSProperties => ({
  fontFamily: theme.mono, fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase",
  color, border: `1px solid ${alpha(color, 0x44)}`, borderRadius: 3, padding: "1px 5px", whiteSpace: "nowrap",
});

interface BoardViewProps {
  tasks: BoardTaskWithConflicts[];
  tickets: Ticket[];
  findings: ReviewFinding[];
  sessions: Session[];
  projects: ProjectWithCounts[];
  launches: Launch[];
  taskRuns: TaskRun[];
  ticketActions: TicketActions;
  /** How the last board list read went; a team-scoped, refused or failed read shows a notice over the cards. */
  listState?: BoardListState;
  /** Whether the route holds closed tasks older than the ones loaded. */
  closedMore?: boolean;
  /** Reads the next page of older closed tasks matching `filter` onto the board; undefined when no read is sent. */
  onLoadOlder?: (filter: BoardFilter) => Promise<void> | undefined;
  /** Told the view's filter on mount and whenever it changes. */
  onFilterChange?: (filter: BoardFilter) => void;
}

/**
 * The Board: every task the viewer has in flight — Persona jobs, review
 * tickets, backlog items — as cards in their lifecycle columns. The filter
 * (text, project, source, status) lives in the URL query so a link can open
 * it pre-filtered. A ticket card expands into the full ticket card, so every
 * ticket action stays reachable from here.
 */
export function BoardView({
  tasks, tickets, findings, sessions, projects, launches, taskRuns, ticketActions, listState, closedMore, onLoadOlder,
  onFilterChange,
}: BoardViewProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const filter = parseBoardFilter(searchParams);
  const filterKey = boardFilterKey(filter);
  const onFilterChangeRef = useRef(onFilterChange);
  onFilterChangeRef.current = onFilterChange;
  useEffect(() => {
    onFilterChangeRef.current?.(filter);
  }, [filterKey]);
  const setFilter = (patch: Partial<BoardFilter>) =>
    setSearchParams((prev) => writeBoardFilter(prev, { ...parseBoardFilter(prev), ...patch }), { replace: true });

  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const ticketById = useMemo(() => new Map(tickets.map((t) => [t.id, t])), [tickets]);
  const sessionById = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);
  const runForTicket = useMemo(() => ticketRunResolver(launches, taskRuns), [launches, taskRuns]);
  const ticketFindings = useMemo(() => findingsByTicket(findings), [findings]);

  const filtered = useMemo(
    () => filterBoardTasks(tasks, filter),
    [tasks, filter.text, filter.projectId, filter.source, filter.status]
  );
  // Closed columns the viewer expanded past the cap.
  const [uncapped, setUncapped] = useState<ReadonlySet<BoardStatus>>(new Set());
  const toggleUncapped = (status: BoardStatus) =>
    setUncapped((cur) => {
      const n = new Set(cur);
      if (n.has(status)) n.delete(status);
      else n.add(status);
      return n;
    });
  const columns = useMemo(() => groupByColumn(filtered, CLOSED_COLUMN_CAP, uncapped), [filtered, uncapped]);
  // A closed column's "Load older" reads the next page and, once a read is
  // sent, expands the column, so the page lands in view rather than behind
  // the cap. Pages hold only closed tasks, so a filter on an open status
  // offers none.
  const [loadingOlder, setLoadingOlder] = useState(false);
  const canLoadOlder = !!onLoadOlder && !!closedMore && !(filter.status && isOpenBoardStatus(filter.status));
  const loadOlder = async (status: BoardStatus) => {
    if (!onLoadOlder || loadingOlder) return;
    const read = onLoadOlder(filter);
    if (!read) return;
    setUncapped((cur) => new Set([...cur, status]));
    setLoadingOlder(true);
    try {
      await read;
    } finally {
      setLoadingOlder(false);
    }
  };
  const notice = listState ? LIST_NOTICE[listState] : undefined;

  // Cards whose column changed since the last render glow briefly.
  const [moved, setMoved] = useState<ReadonlySet<string>>(new Set());
  const lastStatus = useRef<Map<string, BoardStatus> | null>(null);
  const movedTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const prev = lastStatus.current;
    lastStatus.current = new Map(tasks.map((t) => [t.id, t.status]));
    if (!prev) return;
    const changed = tasks.filter((t) => prev.has(t.id) && prev.get(t.id) !== t.status).map((t) => t.id);
    if (changed.length === 0) return;
    setMoved((cur) => new Set([...cur, ...changed]));
    const timer = setTimeout(() => {
      movedTimers.current.delete(timer);
      setMoved((cur) => {
        const n = new Set(cur);
        for (const id of changed) n.delete(id);
        return n;
      });
    }, MOVED_HIGHLIGHT_MS);
    movedTimers.current.add(timer);
  }, [tasks]);
  useEffect(() => {
    const timers = movedTimers.current;
    return () => {
      for (const t of timers) clearTimeout(t);
    };
  }, []);

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((cur) => {
      const n = new Set(cur);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{
        display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap",
        padding: "8px 20px", borderBottom: `1px solid ${theme.edgeSoft}`,
      }}>
        <span style={{
          fontFamily: theme.mono, fontSize: 11, letterSpacing: "0.14em", textTransform: "uppercase",
          fontWeight: 700, color: theme.text,
        }}>Board</span>
        <span data-testid="board-count" style={{ fontSize: 11.5, color: theme.faint }}>
          {listState === "pending" || (listState === "failed" && tasks.length === 0)
            ? "loading…"
            : filtered.length === tasks.length
              ? `${tasks.length} tasks`
              : `${filtered.length} of ${tasks.length} tasks`}
        </span>
        <span style={{ flex: 1 }} />
        <label style={{ ...control, display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 8px" }}>
          <LuSearch style={{ color: theme.faint }} />
          <input
            data-testid="board-search"
            value={filter.text}
            onChange={(e) => setFilter({ text: e.target.value })}
            placeholder="Search tasks, files…"
            style={{
              background: "none", border: "none", outline: "none", color: theme.text,
              fontSize: 12, width: 180, fontFamily: "inherit",
            }}
          />
        </label>
        <select
          data-testid="board-project"
          value={filter.projectId}
          onChange={(e) => setFilter({ projectId: e.target.value })}
          style={{ ...control, cursor: "pointer", color: filter.projectId ? theme.text : theme.faint }}
        >
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <select
          data-testid="board-source"
          value={filter.source}
          onChange={(e) => setFilter({ source: e.target.value as BoardTaskSource | "" })}
          style={{ ...control, cursor: "pointer", color: filter.source ? theme.text : theme.faint }}
        >
          {SOURCE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <select
          data-testid="board-status"
          value={filter.status}
          onChange={(e) => setFilter({ status: e.target.value as BoardStatus | "" })}
          style={{ ...control, cursor: "pointer", color: filter.status ? theme.text : theme.faint }}
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      {notice && (
        <div
          data-testid="board-list-notice"
          data-state={listState}
          style={{
            fontSize: 12, color: theme.dim, padding: "8px 20px",
            borderBottom: `1px solid ${theme.edgeSoft}`, lineHeight: 1.5,
          }}
        >
          {notice}
        </div>
      )}

      <div style={{ flex: 1, display: "flex", overflowX: "auto", minHeight: 0 }}>
        {columns.map((col) => (
          <div
            key={col.status}
            data-testid={`board-column-${col.status}`}
            style={{
              width: 300, flexShrink: 0, display: "flex", flexDirection: "column",
              borderRight: `1px solid ${theme.edgeSoft}`, minHeight: 0,
            }}
          >
            <div style={{
              display: "flex", alignItems: "center", gap: 8,
              padding: "11px 14px 8px", borderBottom: `1px solid ${theme.edgeSoft}`,
            }}>
              <span style={{ width: 7, height: 7, borderRadius: 7, background: COLUMN_ACCENT[col.status] }} />
              <span style={{
                fontFamily: theme.mono, fontSize: 10.5, letterSpacing: "0.12em",
                textTransform: "uppercase", fontWeight: 700, color: theme.text,
              }}>{col.label}</span>
              <span data-testid={`board-column-count-${col.status}`} style={{ fontSize: 11, color: theme.faint }}>
                {col.total}
              </span>
            </div>
            <div style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "10px 12px 24px" }}>
              {col.tasks.length === 0 ? (
                <div style={{ fontSize: 11.5, color: theme.faint, padding: "8px 2px" }}>—</div>
              ) : (
                col.tasks.map((task) => {
                  const ticketId = ticketIdOf(task);
                  const ticket = ticketId ? ticketById.get(ticketId) : undefined;
                  const isExpanded = expanded.has(task.id);
                  const highFindings = ticket?.status === "needs_review"
                    ? openHighFindings(ticketFindings.get(ticket.id) ?? [])
                    : 0;
                  return (
                    <BoardCard
                      key={task.id}
                      task={task}
                      project={task.projectId ? projectById.get(task.projectId) : undefined}
                      accent={COLUMN_ACCENT[task.status]}
                      moved={moved.has(task.id)}
                      expandable={!!ticketId}
                      expanded={isExpanded}
                      onToggle={() => toggle(task.id)}
                      highFindings={isExpanded ? 0 : highFindings}
                    >
                      {ticket && !isExpanded && (
                        ticket.status === "proposed" ? (
                          <TicketQuickActions ticket={ticket} actions={ticketActions} />
                        ) : (
                          <div
                            data-testid={`board-ticket-lens-${ticket.id}`}
                            style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}
                          >
                            <TicketSeverityLens ticket={ticket} />
                          </div>
                        )
                      )}
                      {ticketId && isExpanded && (
                        ticket ? (
                          <LiveTicketCard
                            ticket={ticket}
                            project={projectById.get(ticket.projectId)}
                            session={ticket.sessionId ? sessionById.get(ticket.sessionId) : undefined}
                            run={runForTicket(ticket)}
                            findings={ticketFindings.get(ticket.id) ?? []}
                            actions={ticketActions}
                          />
                        ) : (
                          <div style={{ fontSize: 11.5, color: theme.faint }}>This ticket isn't loaded.</div>
                        )
                      )}
                    </BoardCard>
                  );
                })
              )}
              {(col.hidden > 0 || (uncapped.has(col.status) && col.total > CLOSED_COLUMN_CAP)) && (
                <button
                  data-testid={`board-column-older-${col.status}`}
                  onClick={() => toggleUncapped(col.status)}
                  aria-expanded={uncapped.has(col.status)}
                  style={{
                    background: "none", border: "none", cursor: "pointer", font: "inherit",
                    fontSize: 11, color: theme.running, padding: "4px 2px",
                  }}
                >
                  {col.hidden > 0 ? `+${col.hidden} older` : "Show fewer"}
                </button>
              )}
              {!isOpenBoardStatus(col.status) && canLoadOlder && col.hidden === 0 && (
                <button
                  data-testid={`board-column-load-older-${col.status}`}
                  onClick={() => void loadOlder(col.status)}
                  disabled={loadingOlder}
                  style={{
                    background: "none", border: "none", cursor: loadingOlder ? "default" : "pointer", font: "inherit",
                    fontSize: 11, color: theme.running, padding: "4px 2px", display: "block",
                    opacity: loadingOlder ? 0.6 : 1,
                  }}
                >
                  {loadingOlder ? "Loading…" : "Load older"}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CardLink({ link }: { link: BoardCardLink }) {
  const [searchParams] = useSearchParams();
  if (link.to) {
    // A worker link opens the Live workers drawer under these columns, keeping the board's filter and show-all.
    const to = link.worker
      ? `?${writeLiveWorkers(searchParams, { ...parseLiveWorkers(searchParams), open: true, selection: link.worker }).toString()}`
      : link.to;
    return (
      <Link to={to} style={linkStyle} data-testid={`board-link-${link.kind}`}>
        <LuArrowUpRight /> {link.label}
      </Link>
    );
  }
  if (link.href) {
    return (
      <a href={link.href} target="_blank" rel="noreferrer" style={linkStyle} data-testid={`board-link-${link.kind}`}>
        <LuExternalLink /> {link.label}
      </a>
    );
  }
  return (
    <span style={{ fontFamily: theme.mono, fontSize: 11, color: theme.faint }} data-testid={`board-link-${link.kind}`}>
      {link.label}
    </span>
  );
}

function BoardCard({
  task, project, accent, moved, expandable, expanded, onToggle, highFindings, children,
}: {
  task: BoardTaskWithConflicts;
  project?: ProjectWithCounts;
  accent: string;
  moved: boolean;
  expandable: boolean;
  expanded: boolean;
  onToggle: () => void;
  /** Open High/critical findings on a needs_review ticket, counted on its collapsed card. */
  highFindings: number;
  children?: React.ReactNode;
}) {
  const links = cardLinks(task);
  const conflicts = task.conflicts ?? [];
  const waiting = task.waitingOn ? waitingOnLine(task.waitingOn) : undefined;
  return (
    <div
      data-testid={`board-card-${task.id}`}
      data-moved={moved ? "true" : undefined}
      style={{
        background: theme.surface,
        border: `1px solid ${moved ? accent : theme.edgeSoft}`,
        boxShadow: moved ? `0 0 0 2px ${alpha(accent, 0x33)}` : "none",
        transition: "border-color 600ms ease, box-shadow 600ms ease",
        borderRadius: 8, padding: "10px 12px", marginBottom: 9,
      }}
    >
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
        <span style={chip(theme.dim)}>{SOURCE_LABEL[task.source]}</span>
        {task.stage && <span data-testid="board-stage" style={chip(theme.running)}>{task.stage}</span>}
        {task.flag && <span data-testid="board-flag" style={chip(FLAG_COLOR[task.flag])}>{task.flag}</span>}
        {conflicts.length > 0 && (
          <span
            data-testid={`board-conflicts-${task.id}`}
            title={conflicts.map(describeConflict).join("\n")}
            style={{ ...chip(theme.stalled), display: "inline-flex", alignItems: "center", gap: 3, cursor: "help" }}
          >
            <LuTriangleAlert /> {conflicts.length} conflict{conflicts.length === 1 ? "" : "s"}
          </span>
        )}
        {highFindings > 0 && (
          <span data-testid={`board-high-findings-${task.id}`} style={chip(theme.waiting)}>
            {highFindings} high finding{highFindings === 1 ? "" : "s"}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10.5, color: theme.faint }}>{timeAgo(task.updatedAt)}</span>
      </div>

      <div style={{ fontSize: 13, fontWeight: 700, color: theme.text, lineHeight: 1.35 }}>{task.title}</div>

      {(project || task.projectId) && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
          <span style={{ fontSize: 13, display: "inline-flex" }}><ProjectIcon project={project} size={13} /></span>
          <span style={{ fontSize: 11.5, color: theme.faint }}>{project?.name ?? task.projectId}</span>
        </div>
      )}

      {waiting && (
        <div
          data-testid="board-waiting-on"
          data-tone={waiting.tone}
          title={waiting.text}
          style={{
            fontSize: 11.5,
            ...WAITING_ON_STYLE[waiting.tone],
            marginTop: 6,
            // At most two lines, cut with an ellipsis; the title carries the whole line.
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
            textOverflow: "ellipsis",
            overflowWrap: "anywhere",
          }}
        >
          {waiting.text}
        </div>
      )}

      {(links.length > 0 || expandable) && (
        <div style={{ display: "flex", gap: 12, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
          {links.map((l, i) => <CardLink key={`${l.kind}-${i}`} link={l} />)}
          {expandable && (
            <button
              data-testid={`board-ticket-toggle-${task.id}`}
              onClick={onToggle}
              aria-expanded={expanded}
              style={{
                ...linkStyle, background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit",
                fontSize: 11.5, color: theme.expert,
              }}
            >
              {expanded ? <LuChevronDown /> : <LuChevronRight />} ticket
            </button>
          )}
        </div>
      )}

      {children && <div style={{ marginTop: 10 }}>{children}</div>}
    </div>
  );
}
