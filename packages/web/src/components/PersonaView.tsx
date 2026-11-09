import { Suspense, memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import type { CSSProperties, Dispatch, ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import type { Components } from "react-markdown";
import type {
  PersonaApproval,
  PersonaAttachment,
  PersonaCommandResponse,
  PersonaHoldReport,
  PersonaJob,
  PersonaMessage,
  PersonaMessagesResponse,
  PersonaReplyTo,
  PersonaState,
  PersonaThreadSummary,
  Session,
} from "@standup/shared";
import {
  APPROVAL_STATUS_TEXT,
  approveLabel,
  describeApproval,
  holdExpiresIn,
  isPersonaVideoMime,
  parsePersonaCommand,
  personaAttachmentPath,
  personaAttachmentPosterPath,
  withoutIds,
} from "@standup/shared";
import { Markdown } from "./Markdown";
import { alpha, theme } from "./theme";
import { JOB_NEED, JOB_STATE, sessionPath } from "./jobStatus";
import { JobActions } from "./JobActions";
import { absoluteTime, relativeTime } from "../lib/schedules";
import { PersonaJobDrawer } from "./lazyViews";
import { Skeleton } from "./Skeleton";
import { JobPickerMenu, JobRouteChip, JobTagChip, useJobHashPicker } from "./JobTagPicker";
import { COMMAND_MENU_ID, SlashCommandMenu, commandOptionId, useSlashCommandPicker } from "./CommandMenu";
import { CommandResultCard } from "./CommandResultCard";
import { JobFilterBar, JobFilterControl, MessageJobChip, MessageJobChips, shortJobId } from "./MessageJobTags";
import { useStickyScroll } from "../hooks/useStickyScroll";
import { createCatchUp } from "../hooks/catchUp";
import { useNarrow } from "../hooks/useNarrow";
import { usePresence } from "../hooks/presence";
import {
  accessUpdate,
  activityLabel,
  approvalFromLabel,
  approvalWaitingLabel,
  audienceBadge,
  callerFields,
  composerAudienceWarning,
  composerRoute,
  consoleThreadOf,
  jobTaggableOn,
  fetchPersonaSnapshot,
  hasOlderMessages,
  holdReportLine,
  hostCapacity,
  initialPersonaViewState,
  isApprovalDecider,
  isHostViewer,
  isOpenJob,
  isPersonaDisabled,
  isThreadUnread,
  isUserDisabled,
  isUserPaused,
  jobLastActivity,
  jobState,
  jobSummaryLine,
  filteredThread,
  maxSeq,
  messageJobIds,
  messageJobPath,
  messageJobTags,
  messagesPath,
  newIdempotencyKey,
  olderMessagesPath,
  openOptionsMessageIds,
  PERSONA_PAGE,
  orderThreads,
  otherUsers,
  parseProjectList,
  parseTagFilter,
  pendingApprovals,
  pendingAttachmentIds,
  pendingStripTitle,
  personaCall,
  personaReducer,
  runStateChip,
  signInNeededAs,
  sortJobs,
  tagFilterKey,
  taggedMessagesPath,
  threadHeaderLabel,
  threadLabel,
  threadPreview,
  unavailableMessage,
  userStatusLabel,
  withUser,
  type CapacityReading,
  type HostCapacity,
  type PersonaAction,
  type PersonaChipTone,
  type PersonaOutboxItem,
  type PersonaRefusal,
  type PersonaUserEntry,
  type PersonaViewState,
} from "../lib/persona";
import type { ComposerRoute } from "../lib/persona";
import { PersonaSignInBanner } from "./PersonaSignInBanner";
import { CommitmentsPanel, sideToggleHeading } from "./PersonaCommitments";
import {
  AttachButton,
  OutboxAttachments,
  PASTED_AS_TEXT,
  UploadTray,
  dragHasFiles,
  isUploadPending,
  pastedFiles,
  transferFiles,
  usePendingUploads,
  type UploadFn,
} from "./PersonaUploads";
import {
  discardPersonaUpload,
  formatDuration,
  keepSentPreview,
  pruneSentPreviews,
  sourceAnswers,
  uploadBlockedReason,
} from "../lib/personaUploads";

/** A stable empty message list, so memoized filters don't rerun on it. */
const NO_MESSAGES: PersonaMessage[] = [];

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const TONE_COLORS: Record<PersonaChipTone, string> = {
  idle: theme.dim,
  running: theme.running,
  waiting: theme.waiting,
  stalled: theme.stalled,
  faint: theme.faint,
};

/**
 * Element overrides for Persona's replies. Its text can be steered by worker
 * output, so every link opens without an opener or referrer (images already
 * render as links by default in `Markdown`).
 */
const PERSONA_MARKDOWN: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: theme.running }}>
      {children}
    </a>
  ),
};

function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * The conversation with Persona, the owner's always-on orchestrator. The
 * owner talks here instead of picking a project and a session; Persona turns
 * requests into jobs, runs them on worker sessions, and brings back only what
 * needs the owner — questions (quick replies) and held actions (approvals).
 *
 * State lives in App (so frames apply while another tab is open); this view
 * reads it, resyncs on mount (`onOpen`), and performs the owner's mutations
 * against `/api/persona`, folding each response back in through `onAction`.
 * The composer is usable from the first render: the thread shows a skeleton
 * until its first page arrives, older pages load as the owner scrolls up, and
 * the jobs list fills in when the full snapshot lands. Laid out for a phone
 * first: on a narrow screen the thread and composer fill the height and the
 * jobs list folds into a toggle beneath them.
 */
export function PersonaView({
  persona,
  sessions,
  onAction,
  onRefresh,
  onOpen = onRefresh,
}: {
  persona: PersonaViewState;
  sessions: Session[];
  onAction: Dispatch<PersonaAction>;
  onRefresh: () => Promise<void>;
  /** Run when the view mounts; skips a resync one that just ran already answers. */
  onOpen?: () => Promise<void>;
}) {
  // On a narrow viewport the jobs sidebar folds under the thread.
  const narrow = useNarrow();
  const [jobsOpen, setJobsOpen] = useState(false);
  // The job drawer is the `?job=<id>` query, so it deep-links and Back closes it.
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const drawerJobId = searchParams.get("job");
  // The job the next message is tagged to, and a bump that focuses the composer.
  const [tagJobId, setTagJobId] = useState<string | null>(null);
  const [composerFocus, setComposerFocus] = useState(0);
  // Approvals with a decision in flight. The ref is the synchronous guard (a
  // card can render twice — inline and in the strip — and a double tap lands
  // before React re-renders); the state drives the disabled buttons.
  const deciding = useRef(new Set<string>());
  const [busyApprovals, setBusyApprovals] = useState<Set<string>>(new Set());
  const [approvalErrors, setApprovalErrors] = useState<Record<string, string>>({});
  const [pauseBusy, setPauseBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void onOpen();
  }, [onOpen]);

  // The page of messages above the loaded window, one read at a time. A read
  // that fails marks the thread so nothing reads again on its own; the
  // owner's next scroll up retries it.
  const [olderBusy, setOlderBusy] = useState(false);
  const [olderFailed, setOlderFailed] = useState<string | null>(null);
  const olderInFlight = useRef(false);
  const threadIdForOlder = persona.threadId;
  const firstSeq = persona.messages[0]?.seq;
  const loadOlder = useCallback(async () => {
    if (!threadIdForOlder || firstSeq === undefined || olderInFlight.current) return;
    olderInFlight.current = true;
    setOlderBusy(true);
    try {
      const res = await personaCall<PersonaMessagesResponse>(olderMessagesPath(threadIdForOlder, firstSeq));
      if (res.ok && res.data) {
        onAction({ type: "older", threadId: threadIdForOlder, messages: res.data.messages, limit: PERSONA_PAGE });
        setOlderFailed(null);
      } else {
        setOlderFailed(threadIdForOlder);
      }
    } finally {
      olderInFlight.current = false;
      setOlderBusy(false);
    }
  }, [threadIdForOlder, firstSeq, onAction]);

  // While mounted, messages arriving in the selected thread count as seen.
  useEffect(() => {
    onAction({ type: "viewing", active: true });
    return () => onAction({ type: "viewing", active: false });
  }, [onAction]);

  const selectThread = useCallback(
    async (threadId: string) => {
      onAction({ type: "select", threadId });
      const res = await personaCall<PersonaMessagesResponse>(messagesPath(threadId));
      if (res.ok && res.data) onAction({ type: "threadMessages", response: res.data });
      else if (!res.ok && !res.disabled && !res.forbidden) {
        setNotice(`Couldn't load that thread: ${res.error ?? "request failed"}`);
      }
    },
    [onAction]
  );

  // A message landed on a thread the switcher doesn't know: fetch the list
  // for its channel and title.
  const threadsStale = persona.threadsStale;
  useEffect(() => {
    if (!threadsStale) return;
    let cancelled = false;
    void personaCall<{ threads: PersonaThreadSummary[] }>("/threads").then((res) => {
      if (!cancelled && res.ok && Array.isArray(res.data?.threads)) {
        onAction({ type: "threads", threads: res.data.threads });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [threadsStale, onAction]);

  const disabled = isPersonaDisabled(persona);
  const state = persona.state;
  const pending = useMemo(() => pendingApprovals(persona.approvals), [persona.approvals]);
  const approvalsById = useMemo(
    () => new Map(persona.approvals.map((a) => [a.id, a])),
    [persona.approvals]
  );
  const jobsById = useMemo(() => new Map(persona.jobs.map((j) => [j.id, j])), [persona.jobs]);
  const openJobs = persona.jobs.filter(isOpenJob).length;

  const post = useCallback(
    async <T,>(path: string, body?: unknown, method = "POST") => {
      const res = await personaCall<T>(path, { method, body });
      if (res.disabled) onAction({ type: "disabled", reason: res.error ?? "Persona is disabled", unavailable: res.unavailable });
      // A refused write leaves the Persona readable: `sign-in` raises the
      // sign-in banner, anything but `unauthenticated` is a passing notice.
      if (res.forbidden) {
        if (res.reason === "sign-in") onAction({ type: "signInNeeded" });
        else if (res.reason === "unauthenticated") {
          onAction({ type: "forbidden", reason: res.error ?? "Persona needs a signed-in identity", refusal: res.reason });
        } else setNotice(res.error ?? "Persona refused that request");
      }
      return res;
    },
    [onAction]
  );

  const deliver = useCallback(
    async (item: Pick<PersonaOutboxItem, "idempotencyKey" | "text" | "threadId" | "replyTo" | "jobId" | "routed" | "attachmentIds" | "command">) => {
      if (item.command) {
        const ran = await post<PersonaCommandResponse>("/commands", {
          text: item.text,
          threadId: item.threadId || persona.threadId || undefined,
          idempotencyKey: item.idempotencyKey,
        });
        if (ran.ok && ran.data?.message) {
          onAction({
            type: "sent",
            idempotencyKey: item.idempotencyKey,
            message: ran.data.message,
            ...(ran.data.result ? { also: [ran.data.result] } : {}),
          });
        } else if (!ran.ok) {
          onAction({ type: "sendFailed", idempotencyKey: item.idempotencyKey, error: ran.error ?? "The command didn't run" });
        }
        return;
      }
      const body = {
        text: item.text,
        threadId: item.threadId || persona.threadId || undefined,
        idempotencyKey: item.idempotencyKey,
        ...(item.replyTo ? { replyTo: item.replyTo } : {}),
        ...(item.attachmentIds && item.attachmentIds.length > 0 ? { attachmentIds: item.attachmentIds } : {}),
      };
      let res = await post<{ message: PersonaMessage }>("/messages", item.jobId ? { ...body, jobId: item.jobId } : body);
      // The collector refuses the whole message for a job it won't take on
      // this thread (404 "Unknown job"). A job that came from the filter
      // rather than the owner's own pick is dropped and the message sent
      // untagged; the refused attempt made no message, so the key is unused.
      if (!res.ok && res.status === 404 && res.error === "Unknown job" && item.jobId && item.routed) {
        res = await post<{ message: PersonaMessage }>("/messages", body);
        // A replay of an earlier, tagged copy of the message (its first answer lost) still carries the tag.
        const kept = !!res.data?.message && messageJobIds(res.data.message).includes(item.jobId);
        if (res.ok && !kept) setNotice("Sent without the job tag: Persona doesn't take that job on this thread.");
      }
      if (res.ok && res.data?.message) {
        onAction({ type: "sent", idempotencyKey: item.idempotencyKey, message: res.data.message });
      } else if (!res.ok) {
        onAction({
          type: "sendFailed",
          idempotencyKey: item.idempotencyKey,
          error: res.error ?? "Send failed",
        });
      }
      // A 2xx without a message body leaves the item pending; the
      // persona:message echo (or the next resync) confirms it.
    },
    [post, onAction, persona.threadId]
  );

  // Read through a ref so `send` (every message row's quick-reply handler)
  // keeps its identity as messages arrive.
  const messagesRef = useRef(persona.messages);
  messagesRef.current = persona.messages;

  const send = useCallback(
    (text: string, replyTo?: PersonaReplyTo, jobId?: string, attachments?: PersonaAttachment[], routed?: boolean) => {
      const trimmed = text.trim();
      const media = attachments ?? [];
      if (!trimmed && media.length === 0) return;
      const item: PersonaOutboxItem = {
        idempotencyKey: newIdempotencyKey(),
        text: trimmed,
        createdAt: new Date().toISOString(),
        afterSeq: maxSeq(messagesRef.current),
        status: "sending",
        threadId: persona.threadId || undefined,
        ...(replyTo ? { replyTo } : {}),
        ...(jobId ? { jobId, ...(routed ? { routed: true } : {}) } : {}),
        ...(media.length > 0 ? { attachmentIds: media.map((a) => a.id), attachments: media } : {}),
      };
      onAction({ type: "queue", item });
      void deliver(item);
    },
    [persona.threadId, onAction, deliver]
  );

  const resend = useCallback(
    (item: PersonaOutboxItem) => {
      // Same key: if the first attempt reached the server, it dedupes.
      onAction({ type: "resend", idempotencyKey: item.idempotencyKey });
      void deliver(item);
    },
    [onAction, deliver]
  );

  const decide = useCallback(
    async (approval: PersonaApproval, verdict: "approve" | "deny", reason?: string) => {
      if (deciding.current.has(approval.id)) return;
      deciding.current.add(approval.id);
      setBusyApprovals(new Set(deciding.current));
      setApprovalErrors(({ [approval.id]: _cleared, ...rest }) => rest);
      try {
        const res = await post<{ approval: PersonaApproval }>(
          `/approvals/${encodeURIComponent(approval.id)}/${verdict}`,
          verdict === "deny" ? (reason ? { reason } : {}) : undefined
        );
        if (res.ok && res.data?.approval) {
          onAction({ type: "approval", approval: res.data.approval });
        } else if (!res.ok) {
          setApprovalErrors((prev) => ({
            ...prev,
            [approval.id]:
              res.status === 409 ? "Already decided — refreshing." : (res.error ?? "Failed"),
          }));
          // Someone (or something) decided it first; pull the real status.
          if (res.status === 409) void onRefresh();
        }
      } finally {
        deciding.current.delete(approval.id);
        setBusyApprovals(new Set(deciding.current));
      }
    },
    [post, onAction, onRefresh]
  );

  const togglePause = useCallback(async () => {
    if (!state || pauseBusy) return;
    setPauseBusy(true);
    setNotice(null);
    try {
      const res = await post<PersonaState>(state.runState === "paused" ? "/resume" : "/pause");
      if (res.ok && res.data) onAction({ type: "state", state: res.data });
      else if (!res.ok && !res.disabled) setNotice(res.error ?? "Failed");
    } finally {
      setPauseBusy(false);
    }
  }, [state, pauseBusy, post, onAction]);

  const openJob = useCallback(
    (id: string) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set("job", id);
        return next;
      });
    },
    [setSearchParams]
  );

  const closeJob = useCallback(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("job");
      return next;
    });
  }, [setSearchParams]);

  // The thread's job filter is the `?tags=<id>,<id>` query, so it deep-links too.
  const tagsParam = searchParams.get("tags") ?? "";
  const tagFilter = useMemo(() => parseTagFilter(tagsParam), [tagsParam]);
  const tagFilterSet = useMemo(() => new Set(tagFilter), [tagFilter]);

  const setTagFilter = useCallback(
    (ids: string[]) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (ids.length > 0) next.set("tags", ids.join(","));
        else next.delete("tags");
        return next;
      });
    },
    [setSearchParams]
  );

  const showJobMessages = useCallback(
    (id: string) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.delete("job");
        next.set("tags", id);
        return next;
      });
    },
    [setSearchParams]
  );

  // A push, so Back returns to the thread with this job's drawer open.
  const viewWorker = useCallback((sessionId: string) => navigate(sessionPath(sessionId)), [navigate]);

  // While filtering, fetch every message in the thread tagged with the chosen
  // jobs, so matches older than the loaded window show too. They are held as
  // the view's backfill, apart from the thread, and dropped when the filter
  // or the thread changes.
  const selectedThreadId = persona.threadId;
  const loaded = persona.loaded;
  const filterKey = tagFilterKey(tagFilter);
  useEffect(() => {
    if (!loaded || !selectedThreadId || !filterKey) return;
    let cancelled = false;
    void personaCall<PersonaMessagesResponse>(taggedMessagesPath(selectedThreadId, filterKey.split(","))).then((res) => {
      if (!cancelled && res.ok && Array.isArray(res.data?.messages)) {
        onAction({ type: "backfill", threadId: selectedThreadId, key: filterKey, messages: res.data.messages });
      }
    });
    return () => {
      cancelled = true;
      onAction({ type: "backfillClear" });
    };
  }, [loaded, selectedThreadId, filterKey, onAction]);

  // The owner's messages newer than the thread's tail when filtering began
  // stay in the filtered view, so a message sent while filtering doesn't
  // vanish once its echo replaces the pending bubble. A session lasts while
  // some filter is set on one thread: changing which jobs are chosen keeps it.
  const filterSession = loaded && filterKey ? `thread:${selectedThreadId ?? ""}` : "";
  const [filterMark, setFilterMark] = useState({ session: "", seq: 0 });
  let keepAfterSeq = filterMark.seq;
  if (filterMark.session !== filterSession) {
    const summary = persona.threads.find((t) => t.id === selectedThreadId);
    keepAfterSeq = Math.max(maxSeq(persona.messages), summary?.lastMessage?.seq ?? 0);
    setFilterMark({ session: filterSession, seq: keepAfterSeq });
  }

  const backfill = persona.backfill;
  const backfillRows =
    backfill && backfill.threadId === selectedThreadId && backfill.key === filterKey ? backfill.messages : NO_MESSAGES;
  const filtered = useMemo(
    () => (tagFilterSet.size > 0 ? filteredThread(persona.messages, backfillRows, tagFilterSet, keepAfterSeq) : null),
    [persona.messages, backfillRows, tagFilterSet, keepAfterSeq]
  );
  // Every message held for the thread: the backfill only holds rows older
  // than the loaded window, so the two never overlap.
  const heldMessages = useMemo(
    () => (backfillRows.length > 0 ? [...backfillRows, ...persona.messages] : persona.messages),
    [backfillRows, persona.messages]
  );

  // Drops an inferred tag at once, then settles on the server's copy of the
  // message (also echoed as a `persona:message` frame). A failure puts back
  // just that tag, onto the message as it is by then.
  const removeTag = useCallback(
    async (message: PersonaMessage, jobId: string) => {
      const tag = messageJobTags(message).find((t) => t.jobId === jobId);
      if (!tag) return;
      onAction({ type: "tagRemove", messageId: message.id, jobId });
      const res = await post<{ message: PersonaMessage }>(messageJobPath(message.id, jobId), undefined, "DELETE");
      if (res.ok && res.data?.message) {
        onAction({ type: "messageUpdated", message: res.data.message });
      } else if (!res.ok) {
        onAction({ type: "tagRestore", messageId: message.id, tag });
        if (!res.disabled && !res.forbidden) setNotice(`Couldn't remove that tag: ${res.error ?? "request failed"}`);
      }
    },
    [post, onAction]
  );

  const discussJob = useCallback(
    (id: string) => {
      setTagJobId(id);
      closeJob();
      setComposerFocus((n) => n + 1);
    },
    [closeJob]
  );

  // Filtered to exactly one job the collector takes on this thread, the
  // composer is routed to it: every message sent is about that job, as from
  // its own reply box. A `#` tag picked for one message still wins for that
  // message.
  // The thread's audience: the console's is private; another's is undecided until the threads list names it.
  const routeConsoleId = persona.consoleThreadId || state?.threadId || null;
  const routeAudience =
    !persona.threadId || persona.threadId === routeConsoleId
      ? "private"
      : persona.threads.find((t) => t.id === persona.threadId)?.audience;
  const routeThread = useMemo(
    () => ({ id: persona.threadId, private: routeAudience === undefined ? undefined : routeAudience === "private" }),
    [persona.threadId, routeAudience]
  );
  const route = useMemo(
    () => composerRoute(tagFilter, jobsById, Boolean(persona.jobsLoaded), routeThread),
    [tagFilter, jobsById, persona.jobsLoaded, routeThread]
  );
  const routeJobId = route?.kind === "job" ? route.jobId : null;
  // The `#` picker offers only the jobs the collector takes as a tag here.
  const taggableJobs = useMemo(() => persona.jobs.filter((j) => jobTaggableOn(j, routeThread)), [persona.jobs, routeThread]);
  // A `#` tag (or "Discuss in Persona") the collector won't take on the thread
  // now shown is dropped, and the view says so.
  const tagJob = tagJobId ? jobsById.get(tagJobId) : undefined;
  const refusedTagTitle = tagJob && !jobTaggableOn(tagJob, routeThread) ? tagJob.title : null;
  useEffect(() => {
    if (refusedTagTitle === null) return;
    setTagJobId(null);
    setNotice(`"${refusedTagTitle}" belongs to another thread, so messages here can't be tagged to it. Open its own thread to discuss it.`);
  }, [refusedTagTitle]);
  const sendTagged = useCallback(
    (text: string, attachments?: PersonaAttachment[]) => {
      if (tagJobId) send(text, undefined, tagJobId, attachments);
      else send(text, undefined, routeJobId ?? undefined, attachments, !!routeJobId);
      setTagJobId(null);
    },
    [send, tagJobId, routeJobId]
  );
  const clearFilter = useCallback(() => setTagFilter([]), [setTagFilter]);

  // A slash command rides the outbox like a message (a pending line, Retry on
  // failure) but is delivered to the command route, never to Persona.
  const runCommand = useCallback(
    (text: string) => {
      const item: PersonaOutboxItem = {
        idempotencyKey: newIdempotencyKey(),
        text: text.trim(),
        createdAt: new Date().toISOString(),
        afterSeq: maxSeq(messagesRef.current),
        status: "sending",
        threadId: persona.threadId || undefined,
        command: true,
      };
      onAction({ type: "queue", item });
      void deliver(item);
    },
    [persona.threadId, onAction, deliver]
  );

  // A discarded send's uploads will never be sent, so the collector can drop them.
  const outboxRef = useRef(persona.outbox);
  outboxRef.current = persona.outbox;
  const discardSend = useCallback(
    (key: string) => {
      const item = outboxRef.current.find((o) => o.idempotencyKey === key);
      for (const id of item?.attachmentIds ?? []) void discardPersonaUpload(id);
      onAction({ type: "discard", idempotencyKey: key });
    },
    [onAction]
  );

  // A sent attachment's local preview lasts while some unconfirmed send holds it.
  const outbox = persona.outbox;
  const others = persona.others;
  useEffect(() => {
    pruneSentPreviews(pendingAttachmentIds({ outbox, others }));
  }, [outbox, others]);
  // Leaving the view releases them all. Deferred, and cancelled by a remount,
  // so React's development double-mount keeps them.
  const releaseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    clearTimeout(releaseTimer.current);
    return () => {
      releaseTimer.current = setTimeout(() => pruneSentPreviews(new Set()), 0);
    };
  }, []);

  const { currentUser } = usePresence();
  const signInAs = signInNeededAs(persona, currentUser);
  const signIn = signInAs !== undefined;
  const host = isHostViewer(persona);
  const { hostAlias } = callerFields(state);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [viewUser, setViewUser] = useState<PersonaUserEntry | null>(null);

  const approvalProps = useMemo<ApprovalProps>(
    () => ({
      busy: busyApprovals,
      errors: approvalErrors,
      onDecide: decide,
      viewerOwner: state?.owner,
      viewer: state?.owner,
      readOnly: signIn,
    }),
    [busyApprovals, approvalErrors, decide, state?.owner, signIn]
  );

  // Its own reads wait for the server's first word (an answer, or a failed
  // read under the kept view), leaving the boot to the thread's.
  const serverAnswered = persona.loaded && (!persona.cached || Boolean(persona.loadError));
  const commitments =
    disabled || signIn || !serverAnswered ? null : <CommitmentsPanel jobs={persona.jobs} onOpenJob={openJob} />;
  // Skeleton rows until a snapshot carries the jobs; a failed or refused
  // read shows the list as held, under the view's own notice.
  const jobsKnown = Boolean(persona.jobsLoaded || persona.disabledReason || persona.loadError);
  const jobs = jobsKnown ? (
    <JobsPanel jobs={persona.jobs} selected={drawerJobId} onOpen={openJob} />
  ) : (
    <div data-testid="jobs-loading" style={{ display: "flex", flexDirection: "column", gap: 10, padding: "8px 14px 14px" }}>
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} height={34} />
      ))}
    </div>
  );

  const drawerMessageCount = useMemo(
    () => (drawerJobId ? heldMessages.filter((m) => messageJobIds(m).includes(drawerJobId)).length : 0),
    [heldMessages, drawerJobId]
  );

  // Its chunk loads on first open; the thread stays put meanwhile. A deep
  // link waits for the jobs list rather than calling its job unknown.
  const drawer = drawerJobId && jobsKnown ? (
    <Suspense fallback={null}>
      <PersonaJobDrawer
        jobId={drawerJobId}
        job={jobsById.get(drawerJobId)}
        sessions={sessions}
        approvals={persona.approvals}
        onClose={closeJob}
        onDiscuss={discussJob}
        messageCount={drawerMessageCount}
        onShowMessages={showJobMessages}
        onViewWorker={viewWorker}
        renderFloorCard={(a: PersonaApproval) => <ApprovalCard approval={a} {...approvalProps} />}
      />
    </Suspense>
  ) : null;

  if (persona.forbidden) {
    return (
      <RefusedNote reason={persona.forbidden} refusal={persona.forbiddenReason} signInAs={signInAs} hostAlias={hostAlias} />
    );
  }

  const people =
    host && peopleOpen ? (
      <PeoplePanel
        selected={viewUser?.alias ?? null}
        hostAlias={state?.owner}
        onSelect={(entry) => {
          closeJob();
          setViewUser(entry);
        }}
      />
    ) : null;

  if (host && viewUser && viewUser.alias !== state?.owner) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
        <StatusBar
          persona={persona}
          pauseBusy={pauseBusy}
          onTogglePause={togglePause}
          canPause={false}
          people={{ open: peopleOpen, onToggle: () => setPeopleOpen((o) => !o) }}
        />
        {people}
        <UserPersonaView
          key={viewUser.alias}
          entry={viewUser}
          viewer={state?.owner}
          sessions={sessions}
          narrow={narrow}
          onBack={() => setViewUser(null)}
        />
      </div>
    );
  }

  const consoleThreadId = persona.consoleThreadId || state?.threadId || null;
  const threadRows = orderThreads(persona.threads, consoleThreadId, state?.owner);
  // A console-only owner sees no switcher; it appears once a second thread exists.
  const showSwitcher = threadRows.length > 1;
  const onConsoleThread = !persona.threadId || persona.threadId === consoleThreadId;
  const selectedRow = onConsoleThread ? undefined : threadRows.find((t) => t.id === persona.threadId);
  // The job filter shows once there is a job to filter by, or while one is set.
  const filterable = persona.jobs.length > 0 || tagFilter.length > 0 || persona.messages.some((m) => messageJobIds(m).length > 0);

  const main = (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <StatusBar
        persona={persona}
        pauseBusy={pauseBusy}
        onTogglePause={togglePause}
        canPause={!signIn}
        people={host ? { open: peopleOpen, onToggle: () => setPeopleOpen((o) => !o) } : undefined}
      />
      {people}
      {signInAs && <PersonaSignInBanner as={signInAs} hostAlias={hostAlias} />}
      {narrow && showSwitcher && (
        <ThreadSelect
          rows={threadRows}
          persona={persona}
          consoleThreadId={consoleThreadId}
          onSelect={selectThread}
        />
      )}
      {state?.runState === "error" && state.lastError && (
        <Banner color={theme.waiting}>
          The last turn failed: {state.lastError}. Queued items retry with backoff.
        </Banner>
      )}
      {persona.loadError && !disabled && (
        <Banner color={theme.stalled}>Couldn't reach Persona: {persona.loadError}</Banner>
      )}
      {notice && <Banner color={theme.stalled}>{notice}</Banner>}
      {pending.length > 0 && <PendingStrip approvals={pending} jobsById={jobsById} {...approvalProps} />}
      {(selectedRow || filterable) && (
        <ThreadHeader
          thread={selectedRow}
          actions={
            filterable ? (
              <JobFilterControl
                messages={heldMessages}
                jobs={persona.jobs}
                jobsById={jobsById}
                selected={tagFilter}
                narrow={narrow}
                onChange={setTagFilter}
              />
            ) : undefined
          }
        />
      )}
      {filtered && (
        <JobFilterBar
          count={filtered.matches}
          selected={tagFilter}
          jobsById={jobsById}
          narrow={narrow}
          onChange={setTagFilter}
        />
      )}
      {persona.loaded || persona.outbox.length > 0 ? (
        <Thread
          persona={persona}
          approvalsById={approvalsById}
          jobsById={jobsById}
          approvalProps={approvalProps}
          narrow={narrow}
          consoleThread={onConsoleThread}
          onQuickReply={send}
          quickReplies={!signIn && !disabled}
          onResend={resend}
          onDiscard={discardSend}
          onRevealJob={openJob}
          onRemoveTag={signIn || disabled ? undefined : removeTag}
          rows={filtered?.rows}
          older={
            filtered
              ? undefined
              : {
                  has: hasOlderMessages(persona),
                  busy: olderBusy,
                  failed: olderFailed !== null && olderFailed === persona.threadId,
                  load: loadOlder,
                }
          }
        />
      ) : (
        <ThreadSkeleton narrow={narrow} />
      )}
      {disabled ? (
        <DisabledNote reason={persona.disabledReason} unavailable={persona.unavailable} hostAlias={hostAlias} />
      ) : signIn ? null : (
        <PersonaComposer
          jobs={taggableJobs}
          tag={tagJobId ? jobsById.get(tagJobId) : undefined}
          onTag={setTagJobId}
          route={route?.kind === "job" ? { jobId: route.jobId, job: route.job } : undefined}
          onClearRoute={clearFilter}
          routeNote={route?.kind === "untagged" ? untaggedRouteNote(route, jobsById) : undefined}
          focusSignal={composerFocus}
          paused={state?.runState === "paused"}
          warning={composerAudienceWarning(selectedRow)}
          threadId={persona.threadId || undefined}
          consoleThreadId={consoleThreadId || undefined}
          attachBlocked={uploadBlockedReason(selectedRow)}
          placeholder={composerPlaceholder(
            onConsoleThread ? undefined : threadLabel(selectedRow ?? { channel: "slack" }),
            route?.kind === "job" ? (route.job?.title ?? `job ${shortJobId(route.jobId)}`) : undefined
          )}
          onSend={sendTagged}
          onCommand={onConsoleThread || selectedRow?.audience === "private" ? runCommand : undefined}
        />
      )}
    </div>
  );

  if (narrow) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
        {main}
        <div style={{ borderTop: `1px solid ${theme.edge}`, background: theme.surface }}>
          <button
            type="button"
            onClick={() => setJobsOpen((o) => !o)}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "9px 14px",
              background: "transparent",
              border: "none",
              color: theme.dim,
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            <span>
              Jobs{persona.jobs.length > 0 && ` · ${openJobs} open of ${persona.jobs.length}`}
            </span>
            <span style={{ color: theme.faint }}>{jobsOpen ? "▾" : "▸"}</span>
          </button>
          {jobsOpen && (
            <div style={{ maxHeight: "40vh", overflowY: "auto" }}>
              {jobs}
              {commitments}
            </div>
          )}
        </div>
        {drawer}
      </div>
    );
  }

  return (
    <div style={{ height: "100%", display: "flex" }}>
      {showSwitcher && (
        <ThreadList
          rows={threadRows}
          persona={persona}
          consoleThreadId={consoleThreadId}
          onSelect={selectThread}
        />
      )}
      {main}
      <div
        style={{
          width: 300,
          flexShrink: 0,
          borderLeft: `1px solid ${theme.edge}`,
          background: theme.surface,
          overflowY: "auto",
        }}
      >
        <div
          style={{
            padding: "12px 14px 6px",
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: theme.faint,
          }}
        >
          Jobs{openJobs > 0 && ` · ${openJobs} open`}
        </div>
        {jobs}
        {commitments}
        {!disabled && <HoldReportPanel />}
      </div>
      {drawer}
    </div>
  );
}

const HOLD_TAG_COLORS: Record<"noisy" | "retired" | "kept", string> = {
  noisy: theme.waiting,
  retired: theme.faint,
  kept: theme.accent,
};

/**
 * The noisy-hold report: the owner's decisions on held actions, grouped by
 * the rule each was held under. Loaded when opened. It only shows where holds
 * look like noise; changing a hold stays the owner's own edit.
 */
function HoldReportPanel() {
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<PersonaHoldReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void personaCall<PersonaHoldReport>("/hold-report").then((res) => {
      if (cancelled) return;
      if (res.ok && res.data) {
        setReport(res.data);
        setError(null);
      } else {
        setError(res.error ?? "Couldn't load the report");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  return (
    <div style={{ borderTop: `1px solid ${theme.edge}`, marginTop: 6 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={sideToggleHeading}
      >
        <span>Hold report</span>
        <span>{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div style={{ padding: "0 14px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
          {error && <div style={{ fontSize: 12, color: theme.stalled }}>{error}</div>}
          {report && report.rows.length === 0 && (
            <div style={{ fontSize: 12, color: theme.faint }}>No held actions yet.</div>
          )}
          {report && report.rows.length > 0 && (
            <div style={{ fontSize: 11, color: theme.faint }}>
              Flagged as noisy at ≥{Math.round(report.minApproveRate * 100)}% approved over ≥{report.minSamples}{" "}
              decisions. Suggestions only — nothing here changes a hold.
            </div>
          )}
          {report?.rows.map((row) => {
            const line = holdReportLine(row);
            return (
              <div key={line.rule} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontFamily: theme.mono, fontSize: 11.5, color: theme.text, overflowWrap: "anywhere", flex: 1 }}>
                    {line.rule}
                  </span>
                  {line.tag && (
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        textTransform: "uppercase",
                        padding: "1px 6px",
                        borderRadius: 4,
                        color: HOLD_TAG_COLORS[line.tag],
                        background: alpha(HOLD_TAG_COLORS[line.tag], 0x1f),
                      }}
                    >
                      {line.tag}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11.5, color: theme.dim }}>
                  {line.count} · {line.rate} · median {line.median}
                </div>
                {line.note && <div style={{ fontSize: 11, color: theme.faint }}>{line.note}</div>}
              </div>
            );
          })}
          {report && report.unattributed > 0 && (
            <div style={{ fontSize: 11, color: theme.faint }}>{report.unattributed} older holds had no recognizable rule.</div>
          )}
        </div>
      )}
    </div>
  );
}

export interface ApprovalProps {
  busy: Set<string>;
  errors: Record<string, string>;
  onDecide: (approval: PersonaApproval, verdict: "approve" | "deny", reason?: string) => void;
  /** The Persona on screen's owner; a card owned by anyone else is labelled with whose Persona raised it. */
  viewerOwner?: string;
  /**
   * Who is looking. Only a card's decider (its approver, else its owner) gets
   * Approve/Deny; anyone else sees whom it is waiting on.
   */
  viewer?: string;
  /** Cards show without Approve/Deny (a read-only view, or a browser not signed in). */
  readOnly?: boolean;
}

function StatusBar({
  persona,
  pauseBusy,
  onTogglePause,
  canPause: pauseAllowed,
  people,
}: {
  persona: PersonaViewState;
  pauseBusy: boolean;
  onTogglePause: () => void;
  /** False when this viewer can't direct the Persona, which hides Pause/Resume. */
  canPause: boolean;
  /** The host's People toggle; absent for everyone else. */
  people?: { open: boolean; onToggle: () => void };
}) {
  const chip = runStateChip(persona);
  const color = TONE_COLORS[chip.tone];
  const state = persona.state;
  const activity = activityLabel(persona);
  const thinking = state?.runState === "thinking";
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!thinking) return;
    const timer = setInterval(() => setTick((t) => t + 1), 120);
    return () => clearInterval(timer);
  }, [thinking]);
  const canPause = pauseAllowed && state && !isPersonaDisabled(persona);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: "6px 12px",
        padding: "9px 16px",
        borderBottom: `1px solid ${theme.edge}`,
        background: theme.surface,
      }}
    >
      <span style={{ fontSize: 13, fontWeight: 700, color: theme.text }}>Persona</span>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          fontSize: 11,
          fontWeight: 700,
          padding: "2px 8px",
          borderRadius: 10,
          color,
          background: alpha(color, 0x1f),
          border: `1px solid ${alpha(color, 0x44)}`,
        }}
      >
        {thinking ? (
          <span style={{ fontFamily: theme.mono }}>{SPINNER[tick % SPINNER.length]}</span>
        ) : (
          <span style={{ width: 6, height: 6, borderRadius: 3, background: color }} />
        )}
        {chip.label}
      </span>
      {activity && (
        <span
          style={{
            fontSize: 11.5,
            color: theme.running,
            fontFamily: theme.mono,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: "100%",
          }}
        >
          {activity}…
        </span>
      )}
      {state && state.pendingInbox > 0 && state.runState !== "thinking" && (
        <span style={{ fontSize: 11.5, color: theme.dim }}>{state.pendingInbox} queued</span>
      )}
      <div style={{ flex: 1 }} />
      {state && !isPersonaDisabled(persona) && typeof state.maxActiveLaunches === "number" && (
        <HostCapacityReadout capacity={hostCapacity(state)} />
      )}
      {canPause && (
        <button
          type="button"
          onClick={onTogglePause}
          disabled={pauseBusy}
          style={{
            ...secondaryButton,
            color: state.runState === "paused" ? theme.running : theme.dim,
            opacity: pauseBusy ? 0.6 : 1,
            cursor: pauseBusy ? "default" : "pointer",
          }}
        >
          {state.runState === "paused" ? "Resume" : "Pause"}
        </button>
      )}
      {people && (
        <button
          type="button"
          onClick={people.onToggle}
          aria-expanded={people.open}
          style={{ ...secondaryButton, color: people.open ? theme.running : theme.dim }}
        >
          People
        </button>
      )}
    </div>
  );
}

/**
 * The host's People panel: every user's Persona with its run state, pending
 * cards and launch allowlist. The host can view one read-only, pause or resume
 * it, edit which projects it may launch into, and disable or enable its
 * launches outright.
 */
function PeoplePanel({
  selected,
  hostAlias,
  onSelect,
}: {
  selected: string | null;
  hostAlias?: string;
  onSelect: (entry: PersonaUserEntry | null) => void;
}) {
  const [users, setUsers] = useState<PersonaUserEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ alias: string; text: string } | null>(null);

  const load = useCallback(async () => {
    const res = await personaCall<{ users: PersonaUserEntry[] }>("/users");
    if (res.ok && Array.isArray(res.data?.users)) {
      setUsers(res.data.users);
      setError(null);
    } else setError(res.error ?? "Couldn't load users");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(
    async (alias: string, path: string, method: "POST" | "PUT", body?: unknown) => {
      setBusy(alias);
      setError(null);
      try {
        const res = await personaCall(`/users/${encodeURIComponent(alias)}${path}`, { method, body });
        if (!res.ok) setError(res.error ?? "Failed");
        await load();
        return res.ok;
      } finally {
        setBusy(null);
      }
    },
    [load]
  );

  return (
    <div
      style={{
        borderBottom: `1px solid ${theme.edge}`,
        background: theme.surface,
        padding: "8px 16px 10px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        maxHeight: "40vh",
        overflowY: "auto",
        flexShrink: 0,
      }}
    >
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: theme.faint }}>
        People
      </div>
      {error && <div style={{ fontSize: 11.5, color: theme.waiting }}>{error}</div>}
      {users === null && !error && <div style={{ fontSize: 12, color: theme.dim }}>Loading…</div>}
      {users && otherUsers(users, hostAlias).length === 0 && (
        <div style={{ fontSize: 12, color: theme.dim }}>No other users have a Persona yet.</div>
      )}
      {users?.map((entry) => {
        const own = entry.alias === hostAlias;
        const paused = isUserPaused(entry);
        const disabled = isUserDisabled(entry);
        const viewing = selected === entry.alias || (own && selected === null);
        const projects = entry.access?.launchProjects ?? [];
        const isBusy = busy === entry.alias;
        return (
          <div key={entry.alias} style={{ display: "flex", flexDirection: "column", gap: 4, padding: "4px 0", borderTop: `1px solid ${theme.edgeSoft}` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => onSelect(own ? null : entry)}
                style={{ ...linkButton, fontWeight: viewing ? 700 : 500, color: viewing ? theme.running : theme.text }}
              >
                {entry.alias}
                {own && " (you)"}
              </button>
              <span style={{ fontSize: 11, color: disabled ? theme.waiting : paused ? theme.stalled : theme.faint }}>
                {userStatusLabel(entry)}
              </span>
              {entry.pendingApprovals > 0 && (
                <span style={{ fontSize: 11, color: theme.waiting }}>{entry.pendingApprovals} pending</span>
              )}
              {!own && (
                <>
                  <div style={{ flex: 1 }} />
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => void act(entry.alias, paused ? "/resume" : "/pause", "POST")}
                    style={{ ...secondaryButton, opacity: isBusy ? 0.6 : 1 }}
                  >
                    {paused ? "Resume" : "Pause"}
                  </button>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => void act(entry.alias, "/access", "PUT", accessUpdate(entry, { enabled: disabled }))}
                    title={
                      disabled
                        ? `Let ${entry.alias}'s Persona launch into its allowed projects again`
                        : `Stop ${entry.alias}'s Persona launching into any project`
                    }
                    style={{ ...secondaryButton, color: disabled ? theme.running : theme.dim, opacity: isBusy ? 0.6 : 1 }}
                  >
                    {disabled ? "Enable" : "Disable"}
                  </button>
                </>
              )}
            </div>
            {!own && (
              editing?.alias === entry.alias ? (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <input
                    autoFocus
                    value={editing.text}
                    onChange={(e) => setEditing({ alias: entry.alias, text: e.target.value })}
                    placeholder="project-a, project-b"
                    aria-label={`Projects ${entry.alias}'s Persona may launch into`}
                    style={{
                      flex: "1 1 200px",
                      minWidth: 0,
                      fontSize: 12,
                      color: theme.text,
                      background: theme.ground,
                      border: `1px solid ${theme.edge}`,
                      borderRadius: 5,
                      padding: "4px 7px",
                    }}
                  />
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={async () => {
                      const ok = await act(
                        entry.alias,
                        "/access",
                        "PUT",
                        accessUpdate(entry, { launchProjects: parseProjectList(editing.text) })
                      );
                      if (ok) setEditing(null);
                    }}
                    style={{ ...primaryButton, opacity: isBusy ? 0.6 : 1 }}
                  >
                    Save
                  </button>
                  <button type="button" onClick={() => setEditing(null)} style={secondaryButton}>
                    Cancel
                  </button>
                </div>
              ) : (
                <div style={{ fontSize: 11.5, color: theme.dim, display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <span>
                    May launch into:{" "}
                    {disabled ? (
                      <em>nothing while disabled{projects.length > 0 && ` (allowlist: ${projects.join(", ")})`}</em>
                    ) : projects.length > 0 ? (
                      projects.join(", ")
                    ) : (
                      <em>no projects</em>
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={() => setEditing({ alias: entry.alias, text: (entry.access?.launchProjects ?? []).join(", ") })}
                    style={linkButton}
                  >
                    Edit
                  </button>
                </div>
              )
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The host's read-only view of another user's Persona: its threads, messages,
 * jobs and approvals, fetched with `?user=<alias>`. No composer, and cards
 * can't be decided from here.
 */
function UserPersonaView({
  entry,
  viewer,
  sessions,
  narrow,
  onBack,
}: {
  entry: PersonaUserEntry;
  /** The host looking, for whom each card is waiting on. */
  viewer?: string;
  sessions: Session[];
  narrow: boolean;
  onBack: () => void;
}) {
  const alias = entry.alias;
  const [view, dispatch] = useReducer(personaReducer, initialPersonaViewState);
  const [drawerJobId, setDrawerJobId] = useState<string | null>(null);

  const threadRef = useRef<string | null>(null);
  threadRef.current = view.threadId;
  // Another user's Persona frames never reach the host's socket, so this view
  // re-reads its snapshot (the selected thread's) whenever the page comes back
  // and every 10s while it is on screen.
  useEffect(() => {
    let cancelled = false;
    threadRef.current = null;
    const load = () =>
      fetchPersonaSnapshot(fetch, threadRef.current, alias).then((snapshot) => {
        if (!cancelled) dispatch({ type: "snapshot", snapshot, frameMark: 0 });
      });
    void load();
    const catchUp = createCatchUp({
      run: load,
      intervalMs: 10_000,
      wakeOn: [
        { source: document, events: ["visibilitychange"] },
        { source: window, events: ["online", "focus"] },
      ],
      isVisible: () => document.visibilityState !== "hidden",
    });
    return () => {
      cancelled = true;
      catchUp.dispose();
    };
  }, [alias]);

  const selectThread = useCallback(
    async (threadId: string) => {
      dispatch({ type: "select", threadId });
      const res = await personaCall<PersonaMessagesResponse>(withUser(messagesPath(threadId), alias));
      if (res.ok && res.data) dispatch({ type: "threadMessages", response: res.data });
    },
    [alias]
  );

  const approvalsById = useMemo(() => new Map(view.approvals.map((a) => [a.id, a])), [view.approvals]);
  const jobsById = useMemo(() => new Map(view.jobs.map((j) => [j.id, j])), [view.jobs]);
  const approvalProps = useMemo<ApprovalProps>(
    () => ({ busy: new Set(), errors: {}, onDecide: () => {}, viewerOwner: alias, viewer, readOnly: true }),
    [alias, viewer]
  );
  const closeJob = useCallback(() => setDrawerJobId(null), []);
  const noop = useCallback(() => {}, []);

  // The user's state carries the console thread when the collector serves
  // `/state?user=`; else it's the listed thread on the console channel.
  const consoleThreadId = consoleThreadOf(view);
  const rows = orderThreads(view.threads, consoleThreadId, alias);
  const pending = pendingApprovals(view.approvals);

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: narrow ? "column" : "row" }}>
      {!narrow && rows.length > 1 && (
        <ThreadList rows={rows} persona={view} consoleThreadId={consoleThreadId} onSelect={selectThread} />
      )}
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <Banner color={theme.dim}>
          Viewing <strong>{alias}</strong>'s Persona, read-only
          {isUserPaused(entry) && " (paused)"}.{" "}
          <Link to={withUser("/schedules", alias)} style={{ color: theme.running }}>
            Schedules
          </Link>{" "}
          ·{" "}
          <button type="button" onClick={onBack} style={linkButton}>
            Back to yours
          </button>
        </Banner>
        {narrow && rows.length > 1 && (
          <ThreadSelect rows={rows} persona={view} consoleThreadId={consoleThreadId} onSelect={selectThread} />
        )}
        {!view.loaded && <div style={{ padding: 24, color: theme.dim, fontSize: 13 }}>Loading {alias}'s Persona…</div>}
        {view.loadError && <Banner color={theme.stalled}>Couldn't load {alias}'s Persona: {view.loadError}</Banner>}
        {view.forbidden && <Banner color={theme.stalled}>{view.forbidden}</Banner>}
        {pending.length > 0 && <PendingStrip approvals={pending} jobsById={jobsById} {...approvalProps} />}
        {view.loaded && (
          <Thread
            persona={view}
            approvalsById={approvalsById}
            jobsById={jobsById}
            approvalProps={approvalProps}
            narrow={narrow}
            consoleThread={!view.threadId || view.threadId === consoleThreadId}
            onQuickReply={noop}
            quickReplies={false}
            onResend={noop}
            onDiscard={noop}
            onRevealJob={setDrawerJobId}
          />
        )}
      </div>
      <div
        style={{
          width: narrow ? "auto" : 300,
          flexShrink: 0,
          borderLeft: narrow ? undefined : `1px solid ${theme.edge}`,
          borderTop: narrow ? `1px solid ${theme.edge}` : undefined,
          background: theme.surface,
          overflowY: "auto",
          maxHeight: narrow ? "40vh" : undefined,
        }}
      >
        <JobsPanel jobs={view.jobs} selected={drawerJobId} onOpen={setDrawerJobId} />
      </div>
      {drawerJobId && (
        <PersonaJobDrawer
          jobId={drawerJobId}
          job={jobsById.get(drawerJobId)}
          sessions={sessions}
          approvals={view.approvals}
          onClose={closeJob}
          user={alias}
        />
      )}
    </div>
  );
}

function HostCapacityReadout({ capacity }: { capacity: HostCapacity }) {
  const readings = [capacity.cpu, capacity.ram].filter((r): r is CapacityReading => r !== undefined);
  const sep = <span style={{ color: theme.edge }}>·</span>;
  return (
    <span
      data-testid="host-capacity"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 11,
        color: theme.faint,
        fontFamily: theme.mono,
        whiteSpace: "nowrap",
      }}
    >
      <span title={capacity.workers.title}>{capacity.workers.text}</span>
      {capacity.hostLimited && (
        <span
          title={capacity.hostLimited.title}
          style={{
            fontSize: 10,
            fontWeight: 700,
            padding: "1px 6px",
            borderRadius: 10,
            color: theme.stalled,
            background: alpha(theme.stalled, 0x1f),
            border: `1px solid ${alpha(theme.stalled, 0x44)}`,
          }}
        >
          {capacity.hostLimited.text}
        </span>
      )}
      {capacity.queued && <span title={capacity.queued.title}>{capacity.queued.text}</span>}
      {readings.map((r) => (
        <span key={r.title} style={{ display: "inline-flex", gap: 6 }}>
          {sep}
          <span title={r.title}>{r.text}</span>
        </span>
      ))}
    </span>
  );
}

function Banner({ color, children }: { color: string; children: ReactNode }) {
  return (
    <div
      style={{
        padding: "7px 16px",
        fontSize: 12,
        color,
        background: alpha(color, 0x14),
        borderBottom: `1px solid ${alpha(color, 0x33)}`,
        overflowWrap: "anywhere",
      }}
    >
      {children}
    </div>
  );
}

function PendingStrip({
  approvals,
  jobsById,
  ...approvalProps
}: { approvals: PersonaApproval[]; jobsById: Map<string, PersonaJob> } & ApprovalProps) {
  return (
    <div
      style={{
        borderBottom: `1px solid ${theme.edge}`,
        background: alpha(theme.waiting, 0x0f),
        padding: "10px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        maxHeight: "40vh",
        overflowY: "auto",
        flexShrink: 0,
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: theme.waiting,
        }}
      >
        {pendingStripTitle(approvals, approvalProps.viewer)}
      </div>
      {approvals.map((a) => (
        <ApprovalCard
          key={a.id}
          approval={a}
          jobTitle={a.jobId ? jobsById.get(a.jobId)?.title : undefined}
          {...approvalProps}
        />
      ))}
    </div>
  );
}

export function ApprovalCard({
  approval,
  jobTitle,
  busy,
  errors,
  onDecide,
  viewerOwner,
  viewer,
  readOnly,
}: { approval: PersonaApproval; jobTitle?: string } & ApprovalProps) {
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const isBusy = busy.has(approval.id);
  const isPending = approval.status === "pending";
  const decidable = isPending && !readOnly && isApprovalDecider(approval, viewer);
  const waiting = approvalWaitingLabel(approval, viewer);
  const from = approvalFromLabel(approval, viewerOwner);
  const error = errors[approval.id];
  const card = describeApproval(approval);
  const decidedDetail =
    approval.result && (approval.status === "failed" || approval.status === "superseded") ? withoutIds(approval.result) : undefined;

  return (
    <div
      style={{
        border: `1px solid ${theme.edge}`,
        borderRadius: 7,
        background: theme.surface,
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        textAlign: "left",
      }}
    >
      {(from || waiting || jobTitle || !isPending) && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {from && <span style={{ fontSize: 11, fontWeight: 700, color: theme.accent }}>{from}</span>}
          {waiting && <span style={{ fontSize: 11, fontWeight: 700, color: theme.stalled }}>{waiting}</span>}
          {jobTitle && <span style={{ fontSize: 11, color: theme.faint }}>{jobTitle}</span>}
          {!isPending && (
            <span style={{ fontSize: 11, fontWeight: 700, color: approvalStatusColor(approval) }}>
              {APPROVAL_STATUS_TEXT[approval.status]}
              {approval.decidedBy && ` by ${approval.decidedBy}`}
            </span>
          )}
        </div>
      )}
      <div style={{ fontSize: 13.5, fontWeight: 600, color: theme.text, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        {card.headline}
      </div>
      {card.why && (
        <div style={{ fontSize: 12.5, color: theme.dim, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          Why I'm asking: {card.why}
        </div>
      )}
      {card.note && (
        <div style={{ fontSize: 12.5, color: theme.dim, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          My reason: {card.note}
        </div>
      )}
      {card.sections.map((section, i) => (
        // What approving runs, in full: nothing clipped or whitespace-collapsed,
        // so what's approved is what's read.
        <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ fontSize: 12, color: theme.dim }}>{section.label}</div>
          {section.code ? (
            <pre style={{ ...approvalBlock, color: theme.text, maxHeight: 360 }}>{section.text}</pre>
          ) : (
            <div style={{ ...approvalBlock, color: theme.text, fontFamily: "inherit", fontSize: 12.5, lineHeight: 1.5, maxHeight: 420 }}>
              {section.text}
            </div>
          )}
        </div>
      ))}
      {isPending && card.expiresAt && <HoldDeadline expiresAt={card.expiresAt} />}
      {decidedDetail && (
        <div style={{ fontSize: 12, color: theme.faint, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{decidedDetail}</div>
      )}
      {decidable && !denying && (
        <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
          <button
            type="button"
            onClick={() => onDecide(approval, "approve")}
            disabled={isBusy}
            style={{ ...primaryButton, opacity: isBusy ? 0.6 : 1, cursor: isBusy ? "default" : "pointer" }}
          >
            {approveLabel(approval)}
          </button>
          <button
            type="button"
            onClick={() => setDenying(true)}
            disabled={isBusy}
            style={{ ...secondaryButton, opacity: isBusy ? 0.6 : 1, cursor: isBusy ? "default" : "pointer" }}
          >
            Deny
          </button>
        </div>
      )}
      {decidable && denying && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 2 }}>
          <input
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onDecide(approval, "deny", reason.trim() || undefined);
              if (e.key === "Escape") {
                // Escape cancels the reason only; the job drawer around the card closes on it too.
                e.stopPropagation();
                setDenying(false);
              }
            }}
            placeholder="Reason (optional)"
            style={{
              flex: "1 1 180px",
              minWidth: 0,
              fontSize: 13,
              color: theme.text,
              background: theme.ground,
              border: `1px solid ${theme.edge}`,
              borderRadius: 5,
              padding: "6px 8px",
            }}
          />
          <button
            type="button"
            onClick={() => onDecide(approval, "deny", reason.trim() || undefined)}
            disabled={isBusy}
            style={{
              ...primaryButton,
              background: theme.waiting,
              opacity: isBusy ? 0.6 : 1,
              cursor: isBusy ? "default" : "pointer",
            }}
          >
            Deny
          </button>
          <button
            type="button"
            onClick={() => setDenying(false)}
            disabled={isBusy}
            style={secondaryButton}
          >
            Cancel
          </button>
        </div>
      )}
      {error && <div style={{ fontSize: 11.5, color: theme.waiting }}>{error}</div>}
    </div>
  );
}

/**
 * When a card's safety-floor hold times out, counting down each minute;
 * within ten minutes it turns urgent.
 */
function HoldDeadline({ expiresAt }: { expiresAt: string }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const left = Date.parse(expiresAt) - now.getTime();
  const urgent = left <= 10 * 60_000;
  const at = new Date(expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return (
    <div
      data-testid="hold-deadline"
      style={{ fontSize: 12, fontWeight: urgent ? 700 : 400, color: urgent ? theme.waiting : theme.stalled }}
    >
      {left > 0
        ? `Decide by ${at} (${holdExpiresIn(expiresAt, now)}): after that the hold times out and the call is denied.`
        : "The hold is timing out: the call will be denied."}
    </div>
  );
}

/** A monospace, wrap-everything block for approval args and tool input. */
const approvalBlock: CSSProperties = {
  margin: 0,
  maxHeight: 240,
  overflow: "auto",
  fontFamily: theme.mono,
  fontSize: 11.5,
  lineHeight: 1.5,
  color: theme.dim,
  background: theme.ground,
  border: `1px solid ${theme.edgeSoft}`,
  borderRadius: 5,
  padding: "7px 9px",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};

function approvalStatusColor(approval: PersonaApproval): string {
  switch (approval.status) {
    case "approved":
    case "executed":
      return theme.done;
    case "denied":
    case "failed":
      return theme.waiting;
    default:
      return theme.faint;
  }
}

/** How close to the top of the thread (px) the next older page starts loading. */
const OLDER_THRESHOLD_PX = 400;

/** The thread's place while its first page loads: a few message-shaped bars. */
function ThreadSkeleton({ narrow }: { narrow: boolean }) {
  const rows: { mine: boolean; width: string; height: number }[] = [
    { mine: false, width: "64%", height: 58 },
    { mine: true, width: "38%", height: 34 },
    { mine: false, width: "70%", height: 96 },
    { mine: true, width: "30%", height: 34 },
    { mine: false, width: "56%", height: 72 },
  ];
  return (
    <div
      data-testid="persona-thread-loading"
      aria-busy="true"
      aria-label="Loading the conversation"
      style={{
        flex: 1,
        minHeight: 0,
        overflow: "hidden",
        padding: narrow ? "12px 10px" : "16px 20px",
        display: "flex",
        flexDirection: "column",
        justifyContent: "flex-end",
        gap: 12,
      }}
    >
      {rows.map((r, i) => (
        <Skeleton key={i} width={r.width} height={r.height} style={{ alignSelf: r.mine ? "flex-end" : "flex-start" }} />
      ))}
    </div>
  );
}

export function Thread({
  persona,
  approvalsById,
  jobsById,
  approvalProps,
  narrow,
  consoleThread,
  onQuickReply,
  quickReplies = true,
  onResend,
  onDiscard,
  onRevealJob,
  onRemoveTag,
  rows,
  older,
}: {
  persona: PersonaViewState;
  approvalsById: Map<string, PersonaApproval>;
  jobsById: Map<string, PersonaJob>;
  approvalProps: ApprovalProps;
  narrow: boolean;
  consoleThread: boolean;
  onQuickReply: (text: string, replyTo: PersonaReplyTo) => void;
  /** Whether open questions offer their quick replies; false where the viewer can't answer them. */
  quickReplies?: boolean;
  onResend: (item: PersonaOutboxItem) => void;
  onDiscard: (key: string) => void;
  onRevealJob: (id: string) => void;
  /** Removes an inferred tag from a message; absent where tags are read-only. */
  onRemoveTag?: (message: PersonaMessage, jobId: string) => void;
  /**
   * The rows a job filter leaves, shown in place of the thread's messages;
   * absent when the thread isn't filtered. Pending and failed sends show
   * either way.
   */
  rows?: PersonaMessage[];
  /**
   * Paging up through history: whether older messages exist, whether a page
   * is loading, and the read for the next one. Absent while filtered.
   */
  older?: { has: boolean; busy: boolean; failed?: boolean; load: () => void };
}) {
  const filtering = rows !== undefined;
  const messages = rows ?? persona.messages;
  const outbox = persona.outbox;
  const liveOptions = useMemo(() => openOptionsMessageIds(messages, outbox), [messages, outbox]);
  const last = messages[messages.length - 1];
  const first = messages[0];
  const stickyRef = useStickyScroll(
    `${messages.length}:${last?.id ?? ""}:${outbox.length}`,
    persona.threadId
  );
  const bubbleMax = narrow ? "88%" : "72%";

  // Near the top, the next older page loads. Its rows go in above what's on
  // screen; the distance from the bottom is held across that render, so the
  // message being read stays where it was.
  const elRef = useRef<HTMLDivElement | null>(null);
  const fromBottom = useRef<{ threadId: string | null; px: number } | null>(null);
  const olderRef = useRef(older);
  olderRef.current = older;
  const threadRef = useRef(persona.threadId);
  threadRef.current = persona.threadId;
  const maybeLoadOlder = useCallback(() => {
    const el = elRef.current;
    const o = olderRef.current;
    if (!el || !o || !o.has) return;
    // Scrolling on while the page loads moves the place to hold.
    if (o.busy) {
      if (fromBottom.current) fromBottom.current = { ...fromBottom.current, px: el.scrollHeight - el.scrollTop };
      return;
    }
    if (el.scrollTop > OLDER_THRESHOLD_PX) return;
    fromBottom.current = { threadId: threadRef.current, px: el.scrollHeight - el.scrollTop };
    o.load();
  }, []);
  const scrollRef = useCallback(
    (node: HTMLDivElement | null) => {
      elRef.current?.removeEventListener("scroll", maybeLoadOlder);
      elRef.current = node;
      node?.addEventListener("scroll", maybeLoadOlder, { passive: true });
      stickyRef(node);
    },
    [stickyRef, maybeLoadOlder]
  );
  useLayoutEffect(() => {
    const el = elRef.current;
    const held = fromBottom.current;
    fromBottom.current = null;
    if (!el || !held || held.threadId !== persona.threadId) return;
    el.scrollTop = el.scrollHeight - held.px;
  }, [first?.id, persona.threadId]);
  // A read that settled without moving the window start (it failed, or
  // answered nothing) leaves no place to hold.
  useEffect(() => {
    if (!older?.busy) fromBottom.current = null;
  }, [older?.busy]);
  // A window too short to scroll can't be scrolled to its top: read on,
  // until a read fails.
  useEffect(() => {
    const el = elRef.current;
    if (el && older?.has && !older.busy && !older.failed && el.scrollHeight <= el.clientHeight) older.load();
  }, [older?.has, older?.busy, older?.failed, first?.id]);

  return (
    <div
      ref={scrollRef}
      data-testid="persona-thread"
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        padding: narrow ? "12px 10px" : "16px 20px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      {older?.has && (
        <div data-testid="older-loading" style={{ alignSelf: "center", fontSize: 11.5, color: theme.faint, padding: "2px 0 6px" }}>
          {older.busy ? (
            "Loading earlier messages…"
          ) : older.failed ? (
            <span>
              Couldn't load earlier messages.{" "}
              <button type="button" onClick={() => older.load()} style={linkButton}>
                Retry
              </button>
            </span>
          ) : (
            "Scroll up for earlier messages"
          )}
        </div>
      )}
      {messages.length === 0 && outbox.length === 0 && (
        <div
          style={{
            margin: "auto",
            maxWidth: 420,
            textAlign: "center",
            color: theme.dim,
            fontSize: 13,
            lineHeight: 1.6,
          }}
        >
          {filtering
            ? "No messages in this thread are tagged with the selected jobs."
            : consoleThread
            ? "Tell Persona what you need. It turns requests into jobs, runs them on agent sessions in your projects, and comes back only when something needs you."
            : "No messages in this thread yet."}
        </div>
      )}
      {messages.map((m) => (
        <MessageRow
          key={m.id}
          message={m}
          approval={m.approvalId ? approvalsById.get(m.approvalId) : undefined}
          jobsById={jobsById}
          approvalProps={approvalProps}
          bubbleMax={bubbleMax}
          showOptions={quickReplies && liveOptions.has(m.id)}
          touch={narrow}
          onQuickReply={onQuickReply}
          onRevealJob={onRevealJob}
          onRemoveTag={onRemoveTag}
        />
      ))}
      {outbox.map((item) => (
        <div
          key={item.idempotencyKey}
          style={{ alignSelf: "flex-end", maxWidth: bubbleMax, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3 }}
        >
          {item.jobId && (
            <MessageJobChip
              tag={{ jobId: item.jobId, source: "explicit" }}
              job={jobsById.get(item.jobId)}
              touch={narrow}
              onOpen={onRevealJob}
            />
          )}
          {item.attachments && item.attachments.length > 0 && <OutboxAttachments attachments={item.attachments} />}
          {item.text && <div style={{ ...userBubble, opacity: item.status === "sending" ? 0.6 : 1 }}>{item.text}</div>}
          {item.status === "sending" ? (
            <span style={{ fontSize: 10.5, color: theme.faint }}>sending…</span>
          ) : (
            <span style={{ fontSize: 11, color: theme.waiting, display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
              <span>Not sent{item.error ? ` — ${item.error}` : ""}</span>
              <button type="button" onClick={() => onResend(item)} style={linkButton}>
                Retry
              </button>
              <button type="button" onClick={() => onDiscard(item.idempotencyKey)} style={linkButton}>
                Discard
              </button>
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

interface MessageRowProps {
  message: PersonaMessage;
  approval?: PersonaApproval;
  jobsById: Map<string, PersonaJob>;
  approvalProps: ApprovalProps;
  bubbleMax: string;
  showOptions: boolean;
  /** Sizes the row's controls for a touch screen. */
  touch: boolean;
  onQuickReply: (text: string, replyTo: PersonaReplyTo) => void;
  onRevealJob: (id: string) => void;
  onRemoveTag?: (message: PersonaMessage, jobId: string) => void;
}

/** The jobs a row reads out of `jobsById`: its tagged jobs and its approval's job. */
function rowJobIds(message: PersonaMessage, approval?: PersonaApproval): string[] {
  const ids = messageJobIds(message);
  return approval?.jobId ? [...ids, approval.jobId] : ids;
}

/**
 * A row re-renders only when something it shows changed. `jobsById` is rebuilt
 * whenever any job changes, so it compares just the jobs this row reads. A
 * message whose tags (or their sources) change arrives as a new object, so
 * the identity check covers tag edits.
 */
function sameMessageRow(prev: MessageRowProps, next: MessageRowProps): boolean {
  if (
    prev.message !== next.message ||
    prev.approval !== next.approval ||
    prev.approvalProps !== next.approvalProps ||
    prev.bubbleMax !== next.bubbleMax ||
    prev.showOptions !== next.showOptions ||
    prev.touch !== next.touch ||
    prev.onQuickReply !== next.onQuickReply ||
    prev.onRevealJob !== next.onRevealJob ||
    prev.onRemoveTag !== next.onRemoveTag
  ) {
    return false;
  }
  if (prev.jobsById === next.jobsById) return true;
  return rowJobIds(next.message, next.approval).every(
    (id) => prev.jobsById.get(id) === next.jobsById.get(id)
  );
}

/**
 * One message in the thread. Memoized so an update elsewhere (a new message,
 * a job or activity frame) leaves this row's DOM untouched — re-rendering it
 * would re-parse its markdown and disturb any text the owner is selecting.
 */
const MessageRow = memo(function MessageRow({
  message,
  approval,
  jobsById,
  approvalProps,
  bubbleMax,
  showOptions,
  touch,
  onQuickReply,
  onRevealJob,
  onRemoveTag,
}: MessageRowProps) {
  const time = clock(message.createdAt);
  const chips = (align: "start" | "center" | "end") => (
    <MessageJobChips
      message={message}
      jobsById={jobsById}
      align={align}
      touch={touch}
      onOpen={onRevealJob}
      onRemove={onRemoveTag}
    />
  );

  if (message.command?.result) return <CommandResultCard message={message} />;

  if (message.role === "system") {
    return (
      <div data-message-id={message.id} style={{ alignSelf: "center", width: "100%", maxWidth: 560, display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ textAlign: "center", fontSize: 11.5, color: theme.faint, overflowWrap: "anywhere" }}>
          {message.text}
          {time && <span style={{ marginLeft: 6, fontFamily: theme.mono, fontSize: 10.5 }}>{time}</span>}
        </div>
        {chips("center")}
        {approval && (
          <ApprovalCard
            approval={approval}
            jobTitle={approval.jobId ? jobsById.get(approval.jobId)?.title : undefined}
            {...approvalProps}
          />
        )}
      </div>
    );
  }

  if (message.role === "user") {
    return (
      <div data-message-id={message.id} style={{ alignSelf: "flex-end", maxWidth: bubbleMax, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3 }}>
        {message.attachments && message.attachments.length > 0 && (
          <MessageAttachments attachments={message.attachments} align="end" />
        )}
        {message.text.trim() && <div style={userBubble}>{message.text}</div>}
        {chips("end")}
        <span style={{ fontSize: 10.5, color: theme.faint, fontFamily: theme.mono }}>
          {message.actor ? `${message.actor} · ` : ""}
          {time}
        </span>
      </div>
    );
  }

  return (
    <div data-message-id={message.id} style={{ alignSelf: "flex-start", maxWidth: bubbleMax, minWidth: 0, display: "flex", flexDirection: "column", gap: 5 }}>
      <div
        style={{
          background: theme.surface,
          border: `1px solid ${theme.edgeSoft}`,
          borderRadius: "10px 10px 10px 3px",
          padding: "8px 12px 2px",
          overflowWrap: "anywhere",
          minWidth: 0,
        }}
      >
        {message.text.trim() && <Markdown components={PERSONA_MARKDOWN}>{message.text}</Markdown>}
        {message.attachments && message.attachments.length > 0 && <MessageAttachments attachments={message.attachments} />}
      </div>
      {chips("start")}
      {showOptions && message.options && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {message.options.map((opt, i) => (
            <button
              key={opt}
              type="button"
              onClick={() => onQuickReply(opt, { messageId: message.id, optionIndex: i })}
              title={i === message.recommendedOption ? "Persona recommends this" : undefined}
              style={{
                fontSize: 12.5,
                fontWeight: 600,
                padding: "6px 12px",
                borderRadius: 14,
                border: `1px solid ${i === message.recommendedOption ? theme.accent : alpha(theme.accent, 0x66)}`,
                background: theme.accentSoft,
                color: theme.accent,
                cursor: "pointer",
              }}
            >
              {i === message.recommendedOption ? `★ ${opt}` : opt}
            </button>
          ))}
        </div>
      )}
      <span style={{ fontSize: 10.5, color: theme.faint, fontFamily: theme.mono }}>{time}</span>
    </div>
  );
}, sameMessageRow);

const attachmentMedia: CSSProperties = {
  display: "block",
  maxWidth: "100%",
  maxHeight: 420,
  borderRadius: 6,
  border: `1px solid ${theme.edgeSoft}`,
  background: theme.ground,
};

// MediaError codes (the global isn't there outside a browser).
const MEDIA_ERR_NETWORK = 2;
const MEDIA_ERR_DECODE = 3;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

/**
 * How a video's `error` reads: undecodable here, a failed load, one to probe,
 * or (an abort) nothing to show. A source that fails to fetch at all (401,
 * 404, 5xx, refused) also reports "not supported", so that code alone can't
 * tell a format this browser can't play from a load that failed.
 */
function videoFailure(code: number | undefined): "unplayable" | "network" | "probe" | null {
  if (code === MEDIA_ERR_DECODE) return "unplayable";
  if (code === MEDIA_ERR_SRC_NOT_SUPPORTED) return "probe";
  if (code === MEDIA_ERR_NETWORK) return "network";
  return null;
}

/** How far outside the viewport a video starts loading its metadata and poster. */
const VIDEO_LOAD_MARGIN = "400px";
/** The shape a video's box holds before the video says its own. */
const PLAYER_ASPECT = "16 / 9";

/** The nearest ancestor of `el` that scrolls vertically, or null when only the page does. */
function scrollParent(el: Element): Element | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const overflowY = p.ownerDocument.defaultView?.getComputedStyle(p).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return p;
  }
  return null;
}

/**
 * Whether the element `ref` holds has come within VIDEO_LOAD_MARGIN of what
 * its scroll box shows (the thread's, else the page's); once true it stays
 * true. The scroll box is the observer's root, since a margin around the
 * page alone can't reach past the box clipping it. True from the start where
 * there is no IntersectionObserver.
 */
function useNearViewport(ref: { current: Element | null }): boolean {
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const el = ref.current;
    if (near || !el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        observer.disconnect();
        setNear(true);
      },
      { root: scrollParent(el), rootMargin: VIDEO_LOAD_MARGIN }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [near, ref]);
  return near;
}

/**
 * A video on a message, played in place, with a download link beneath it.
 * The player (its metadata and poster frame) loads only once the video comes
 * near the viewport, so a thread of videos opens as fast as one without;
 * until then a box of the player's size holds its place. Some browsers can't
 * decode some uploads (QuickTime or HEVC in Firefox and Linux Chrome); there
 * the player gives way to the download link. A failed load is offered again
 * instead, by remounting the player on the same source.
 */
function VideoAttachment({ attachment: a, src }: { attachment: PersonaAttachment; src: string }) {
  const figure = useRef<HTMLElement | null>(null);
  const near = useNearViewport(figure);
  // Until its metadata says its shape, the player keeps the placeholder's, so the thread doesn't jump.
  const [sized, setSized] = useState(false);
  const [failure, setFailure] = useState<"unplayable" | "network" | null>(null);
  const [attempt, setAttempt] = useState(0);
  const unplayable = failure === "unplayable";
  // The attempt a probe answers, so a stale answer (after Retry or unmount) is dropped.
  const current = useRef(attempt);
  current.current = attempt;
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const onVideoError = (code: number | undefined) => {
    const kind = videoFailure(code);
    if (kind !== "probe") {
      setFailure(kind);
      return;
    }
    const asked = attempt;
    void sourceAnswers(src).then((served) => {
      if (mounted.current && current.current === asked) setFailure(served ? "unplayable" : "network");
    });
  };
  const duration = a.video?.durationSec;
  const download = (label: string) => (
    <a href={src} download={a.name} data-testid="attachment-download" style={{ color: theme.running, fontSize: 11 }}>
      {label}
    </a>
  );
  return (
    <figure
      ref={figure}
      data-attachment-id={a.id}
      style={{ margin: 0, display: "flex", flexDirection: "column", gap: 3, maxWidth: "100%" }}
    >
      {!near ? (
        <div
          data-testid="attachment-video-placeholder"
          aria-hidden
          style={{ ...attachmentMedia, width: 480, aspectRatio: PLAYER_ASPECT }}
        />
      ) : unplayable ? (
        <div
          data-testid="attachment-video-fallback"
          style={{
            ...attachmentMedia,
            padding: "10px 12px",
            fontSize: 12,
            color: theme.dim,
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <span>This browser can't play this video.</span>
          <span>{download(`Download ${a.name}`)}</span>
        </div>
      ) : failure === "network" ? (
        <div
          data-testid="attachment-video-retry"
          style={{ ...attachmentMedia, padding: "10px 12px", fontSize: 12, color: theme.dim }}
        >
          Couldn't load the video —{" "}
          <button
            type="button"
            onClick={() => {
              setFailure(null);
              setAttempt((n) => n + 1);
            }}
            style={{ ...linkButton, fontSize: 12 }}
          >
            Retry
          </button>
        </div>
      ) : (
        <video
          key={attempt}
          controls
          preload="metadata"
          src={src}
          poster={a.video?.poster ? personaAttachmentPosterPath(a.id) : undefined}
          aria-label={a.caption ?? a.name}
          onError={(e) => onVideoError(e.currentTarget.error?.code)}
          onLoadedMetadata={() => setSized(true)}
          style={{ ...attachmentMedia, width: 480, ...(sized ? {} : { aspectRatio: PLAYER_ASPECT }) }}
        />
      )}
      <figcaption style={{ fontSize: 11.5, color: theme.dim, display: "flex", flexDirection: "column", gap: 1 }}>
        <span>
          {a.caption ?? a.name}
          {duration !== undefined && (
            <span style={{ marginLeft: 6, fontFamily: theme.mono, color: theme.faint }}>{formatDuration(duration)}</span>
          )}
          {!unplayable && <span style={{ marginLeft: 8 }}>{download("Download")}</span>}
        </span>
        {a.video?.note && (
          <span data-testid="attachment-video-note" style={{ fontSize: 10.5, color: theme.faint }}>
            {a.video.note}
          </span>
        )}
      </figcaption>
    </figure>
  );
}

/**
 * Media on a message, shown inline from the collector's stored copies (by
 * attachment id): images and videos Persona attached to a reply or the owner
 * sent. An image opens full size in a new tab; a video plays in
 * place (the route serves byte ranges, so it seeks without a full download).
 */
function MessageAttachments({ attachments, align = "start" }: { attachments: PersonaAttachment[]; align?: "start" | "end" }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: align === "end" ? "flex-end" : "stretch",
        gap: 8,
        padding: align === "end" ? 0 : "4px 0 8px",
        maxWidth: "100%",
      }}
    >
      {attachments.map((a) => {
        const src = personaAttachmentPath(a.id);
        if (isPersonaVideoMime(a.mimeType)) return <VideoAttachment key={a.id} attachment={a} src={src} />;
        return (
          <figure key={a.id} data-attachment-id={a.id} style={{ margin: 0, display: "flex", flexDirection: "column", gap: 3 }}>
            <a href={src} target="_blank" rel="noopener noreferrer" title={a.name}>
              <img src={src} alt={a.caption ?? a.name} loading="lazy" style={attachmentMedia} />
            </a>
            {a.caption && <figcaption style={{ fontSize: 11.5, color: theme.dim }}>{a.caption}</figcaption>}
          </figure>
        );
      })}
    </div>
  );
}

/**
 * The bar above the thread: the selected (non-console) thread's name and who
 * can read it, and the thread's tools (the job filter) at the right.
 */
function ThreadHeader({ thread, actions }: { thread?: PersonaThreadSummary; actions?: ReactNode }) {
  const badge = thread ? audienceBadge(thread.audience) : undefined;
  const open = thread?.audience === "shared" || thread?.audience === "external";
  return (
    <div
      data-testid="thread-header"
      style={{
        // An opaque bar in the column's flow, stacked above the thread so the
        // filter's dropdown covers messages rather than sliding under them.
        position: "relative",
        zIndex: 2,
        background: theme.surface,
        borderBottom: `1px solid ${theme.edge}`,
        padding: "6px 14px",
        fontSize: 12,
        color: open ? theme.waiting : theme.dim,
        display: "flex",
        alignItems: "center",
        gap: 6,
        flexShrink: 0,
      }}
    >
      {badge && (
        <span role="img" aria-label={badge.label} title={badge.label}>
          {badge.icon}
        </span>
      )}
      {thread && <span style={{ fontWeight: 600, flex: 1, minWidth: 0 }}>{threadHeaderLabel(thread)}</span>}
      {actions && <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>{actions}</div>}
    </div>
  );
}

/** The composer's placeholder: the thread it posts in (absent for the console) and the job it is routed to, if any. */
export function composerPlaceholder(threadName: string | undefined, jobName: string | undefined): string {
  if (!threadName) return jobName ? `Message Persona about ${jobName}…` : "Ask Persona for anything…";
  return `Message Persona in ${threadName}${jobName ? ` about ${jobName}` : ""}…`;
}

/** What the composer says when the thread is filtered by job but its messages go untagged. */
export function untaggedRouteNote(
  route: Extract<ComposerRoute, { kind: "untagged" }>,
  jobsById: Map<string, PersonaJob>
): string {
  if (route.reason === "several") return "Filtered to several jobs — messages go to the thread untagged. Filter to one job to send to it.";
  const name = route.jobId ? (jobsById.get(route.jobId)?.title ?? `job ${shortJobId(route.jobId)}`) : "this job";
  return route.reason === "unknown"
    ? `${name} isn't one of your jobs any more — messages go to the thread untagged.`
    : `${name} belongs to another thread — messages here go untagged.`;
}

export function PersonaComposer({
  jobs,
  tag,
  onTag,
  route,
  onClearRoute,
  routeNote,
  focusSignal = 0,
  paused,
  warning,
  placeholder,
  threadId,
  consoleThreadId,
  attachBlocked,
  upload,
  onSend,
  onCommand,
}: {
  /** The jobs `#` can tag the message to. */
  jobs: PersonaJob[];
  /** The job the message is tagged to, shown as a removable chip. */
  tag?: PersonaJob;
  onTag: (jobId: string | null) => void;
  /** The job every message is sent about while the thread is filtered to it alone, shown as a "→ <job>" chip. */
  route?: { jobId: string; job?: PersonaJob };
  /** The route chip's ×: clears the job filter. */
  onClearRoute?: () => void;
  /** Why sends go to the thread untagged although it is filtered by job; shown above the input. */
  routeNote?: string;
  /** Bumped to focus the input (e.g. after "Discuss in Persona"). */
  focusSignal?: number;
  paused: boolean;
  /** Shown above the input when what's typed is visible to others. */
  warning?: string;
  placeholder: string;
  /** The thread uploads go to; absent means the console thread. */
  threadId?: string;
  /** The console thread's id once known; an absent `threadId` means the same thread. */
  consoleThreadId?: string;
  /** Why this thread takes no uploads; the attach button explains it instead of opening. */
  attachBlocked?: string;
  /** Uploads one file; the collector's `/uploads` route by default. */
  upload?: UploadFn;
  /** The message, and the uploads it carries (possibly with empty text). */
  onSend: (text: string, attachments: PersonaAttachment[]) => void;
  /** Runs a known slash command (`/state`); absent where commands don't run, so `/…` is sent as text. */
  onCommand?: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const picker = useJobHashPicker({ jobs, text, setText, inputRef: ref, onPick: onTag });
  const runCommand = useCallback(
    (line: string) => {
      onCommand?.(line);
      setText("");
    },
    [onCommand]
  );
  const commands = useSlashCommandPicker({ text, setText, onRun: runCommand, enabled: !!onCommand });
  const uploads = usePendingUploads(threadId, upload, consoleThreadId);
  const [dragging, setDragging] = useState(false);
  // dragenter/dragleave fire for every child crossed; the depth says when the drag left the composer.
  const dragDepth = useRef(0);

  useEffect(() => {
    if (focusSignal > 0) ref.current?.focus();
  }, [focusSignal]);

  // Grow with the draft up to a few lines, then scroll inside.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const uploading = uploads.items.some(isUploadPending);
  const readyCount = uploads.items.filter((i) => i.status === "ready").length;
  const canSend = !uploading && (text.trim() !== "" || readyCount > 0);
  // A command needs no uploads, so it runs while they finish.
  const commandDraft = !!onCommand && (!!commands.current || !!parsePersonaCommand(text));

  const submit = () => {
    // A known command (or the one the open menu highlights) runs; an unknown
    // `/word` goes to Persona as text. Uploads stay staged for the next message.
    if (commandDraft) {
      runCommand(commands.current ? `/${commands.current.name}` : text.trim());
      return;
    }
    if (!canSend) return;
    const ready = uploads.take();
    const attachments: PersonaAttachment[] = [];
    for (const item of ready) {
      if (!item.attachment) continue;
      attachments.push(item.attachment);
      if (item.previewUrl) keepSentPreview(item.attachment.id, item.previewUrl);
    }
    onSend(text, attachments);
    setText("");
  };

  const addFiles = (files: File[]) => {
    if (files.length === 0) return;
    if (attachBlocked) uploads.setNotice(attachBlocked);
    else uploads.add(files);
  };

  const endDrag = () => {
    dragDepth.current = 0;
    setDragging(false);
  };

  return (
    <div
      data-testid="persona-composer"
      data-dragging={dragging ? "true" : undefined}
      onDragEnter={(e) => {
        if (!dragHasFiles(e.dataTransfer)) return;
        e.preventDefault();
        dragDepth.current++;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (!dragHasFiles(e.dataTransfer)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = attachBlocked ? "none" : "copy";
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(e) => {
        const files = transferFiles(e.dataTransfer);
        endDrag();
        if (files.length === 0) return;
        // Taken here either way: a file dropped and not handled would open in the tab.
        e.preventDefault();
        addFiles(files);
      }}
      style={{
        borderTop: `1px solid ${theme.edge}`,
        background: theme.surface,
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 5,
        flexShrink: 0,
        position: "relative",
        outline: dragging ? `2px dashed ${attachBlocked ? theme.faint : theme.running}` : "none",
        outlineOffset: -4,
      }}
    >
      {dragging && (
        <div
          data-testid="persona-drop-zone"
          aria-hidden
          style={{
            position: "absolute",
            inset: 4,
            borderRadius: 6,
            background: attachBlocked ? alpha(theme.ground, 0xcc) : alpha(theme.running, 0x1f),
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 13,
            fontWeight: 600,
            color: attachBlocked ? theme.dim : theme.running,
            pointerEvents: "none",
            zIndex: 1,
          }}
        >
          {attachBlocked ?? "Drop images or videos to attach"}
        </div>
      )}
      {picker.open && (
        <JobPickerMenu matches={picker.matches} active={picker.active} query={picker.query} onPick={picker.pick} />
      )}
      {commands.open && <SlashCommandMenu matches={commands.matches} active={commands.active} onRun={commands.run} />}
      {tag ? (
        <JobTagChip job={tag} onRemove={() => onTag(null)} />
      ) : route ? (
        <JobRouteChip jobId={route.jobId} job={route.job} onClear={() => onClearRoute?.()} />
      ) : routeNote ? (
        <div data-testid="composer-route-note" style={{ fontSize: 11, color: theme.dim }}>
          {routeNote}
        </div>
      ) : null}
      <UploadTray items={uploads.items} onRemove={uploads.remove} onDuration={uploads.setDuration} />
      {uploads.notice && (
        <div role="status" data-testid="persona-upload-notice" style={{ fontSize: 11, color: theme.waiting }}>
          {uploads.notice}
        </div>
      )}
      {uploading && (
        <div role="status" data-testid="persona-upload-waiting" style={{ fontSize: 11, color: theme.dim }}>
          Waiting for uploads to finish — Send unlocks when they're done.
        </div>
      )}
      {warning && (
        <div role="note" style={{ fontSize: 11, color: theme.waiting }}>
          {warning}
        </div>
      )}
      {paused && (
        <div style={{ fontSize: 11, color: theme.stalled }}>
          Paused — messages queue until you resume.
        </div>
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <AttachButton blockedReason={attachBlocked} onFiles={addFiles} onBlocked={uploads.setNotice} />
        <textarea
          ref={ref}
          value={text}
          rows={1}
          onChange={(e) => {
            setText(e.target.value);
            picker.syncCaret();
          }}
          onPaste={(e) => {
            // A copied image is attached; anything else pastes as usual. Where
            // uploads are off, the paste always goes through as text.
            const { files, textWon } = pastedFiles(e.clipboardData);
            if (attachBlocked) {
              if (files.length > 0 || textWon) uploads.setNotice(attachBlocked);
              return;
            }
            if (textWon) uploads.setNotice(PASTED_AS_TEXT);
            if (files.length === 0) return;
            e.preventDefault();
            uploads.add(files);
          }}
          onSelect={picker.syncCaret}
          aria-controls={commands.open ? COMMAND_MENU_ID : undefined}
          aria-activedescendant={commands.current ? commandOptionId(commands.current.name) : undefined}
          onKeyDown={(e) => {
            if (commands.onKeyDown(e) || picker.onKeyDown(e)) {
              e.preventDefault();
              return;
            }
            // Enter sends; Shift+Enter falls through to a newline. An IME
            // composition's Enter confirms the candidate, never sends.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={placeholder}
          style={{
            flex: 1,
            minWidth: 0,
            resize: "none",
            // 16px keeps iOS Safari from zooming the page on focus.
            fontSize: 16,
            lineHeight: 1.4,
            fontFamily: theme.sans,
            color: theme.text,
            background: theme.ground,
            border: `1px solid ${theme.edge}`,
            borderRadius: 8,
            padding: "8px 10px",
            outline: "none",
          }}
        />
        <button
          type="button"
          onClick={submit}
          disabled={!canSend && !commandDraft}
          title={uploading && !commandDraft ? "Waiting for uploads to finish" : undefined}
          style={{
            ...primaryButton,
            padding: "9px 16px",
            opacity: canSend ? 1 : 0.5,
            cursor: canSend ? "pointer" : "default",
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}

interface ThreadSwitcherProps {
  rows: PersonaThreadSummary[];
  persona: PersonaViewState;
  consoleThreadId: string | null;
  onSelect: (threadId: string) => void;
}

function rowLabel(row: PersonaThreadSummary, consoleThreadId: string | null): string {
  return threadLabel(row, row.id === consoleThreadId);
}

/** The desktop switcher: a column of threads, console first, each with a preview line. */
function ThreadList({ rows, persona, consoleThreadId, onSelect }: ThreadSwitcherProps) {
  return (
    <nav
      aria-label="Persona threads"
      style={{
        width: 230,
        flexShrink: 0,
        borderRight: `1px solid ${theme.edge}`,
        background: theme.surface,
        overflowY: "auto",
      }}
    >
      <div
        style={{
          padding: "12px 14px 6px",
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: theme.faint,
        }}
      >
        Threads
      </div>
      {rows.map((row) => {
        const selected = row.id === persona.threadId;
        const unread = isThreadUnread(row, persona);
        const preview = threadPreview(row, 60);
        const badge = audienceBadge(row.audience);
        return (
          <button
            key={row.id}
            type="button"
            onClick={() => !selected && onSelect(row.id)}
            aria-current={selected ? "true" : undefined}
            title={row.externalRef ?? undefined}
            style={{
              width: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "stretch",
              gap: 2,
              padding: "8px 14px",
              textAlign: "left",
              background: selected ? theme.ground : "transparent",
              border: "none",
              borderLeft: `2px solid ${selected ? theme.running : "transparent"}`,
              cursor: selected ? "default" : "pointer",
            }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontSize: 12.5,
                  fontWeight: unread || selected ? 700 : 500,
                  color: theme.text,
                }}
              >
                {rowLabel(row, consoleThreadId)}
              </span>
              {badge && (
                <span
                  role="img"
                  aria-label={badge.label}
                  title={badge.label}
                  style={{ fontSize: 11, flexShrink: 0 }}
                >
                  {badge.icon}
                </span>
              )}
              {row.channel === "slack" && (
                <span style={{ fontSize: 10, color: theme.faint }}>Slack</span>
              )}
              {unread && (
                <span
                  aria-label="unread"
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: theme.running,
                    flexShrink: 0,
                  }}
                />
              )}
            </span>
            {preview && (
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontSize: 11.5,
                  color: unread ? theme.dim : theme.faint,
                }}
              >
                {preview}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}

/** The narrow-screen switcher: a dropdown above the thread; unread threads lead with a dot. */
function ThreadSelect({ rows, persona, consoleThreadId, onSelect }: ThreadSwitcherProps) {
  const anyUnread = rows.some((row) => isThreadUnread(row, persona));
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 10px",
        borderBottom: `1px solid ${theme.edge}`,
        background: theme.surface,
      }}
    >
      <label
        htmlFor="persona-thread"
        style={{ fontSize: 11, fontWeight: 600, color: anyUnread ? theme.running : theme.faint }}
      >
        {anyUnread ? "● Thread" : "Thread"}
      </label>
      <select
        id="persona-thread"
        value={persona.threadId ?? ""}
        onChange={(e) => onSelect(e.target.value)}
        style={{
          flex: 1,
          minWidth: 0,
          // 16px keeps iOS Safari from zooming the page on focus.
          fontSize: 16,
          color: theme.text,
          background: theme.ground,
          border: `1px solid ${theme.edge}`,
          borderRadius: 6,
          padding: "5px 8px",
        }}
      >
        {rows.map((row) => {
          const preview = threadPreview(row, 40);
          const label = rowLabel(row, consoleThreadId);
          const badge = audienceBadge(row.audience);
          return (
            <option
              key={row.id}
              value={row.id}
              aria-label={badge ? `${label}, ${badge.label}` : undefined}
            >
              {`${isThreadUnread(row, persona) ? "● " : ""}${badge ? `${badge.icon} ` : ""}${label}${preview ? ` — ${preview}` : ""}`}
            </option>
          );
        })}
      </select>
    </div>
  );
}

/**
 * In place of the composer while Persona can't run: turned off on this
 * collector, or (`unavailable`) on but with no room on the host for this
 * user's.
 */
function DisabledNote({ reason, unavailable, hostAlias }: { reason?: string; unavailable?: boolean; hostAlias?: string }) {
  return (
    <div
      style={{
        borderTop: `1px solid ${theme.edge}`,
        background: theme.surface,
        padding: "14px 16px",
        fontSize: 12.5,
        lineHeight: 1.6,
        color: theme.dim,
      }}
    >
      {unavailable ? (
        <>
          <div style={{ color: theme.text, fontWeight: 600, marginBottom: 2 }}>{unavailableMessage(hostAlias)}</div>
          {reason && <div style={{ color: theme.faint }}>{reason}</div>}
          Sessions, Work and every other view are unaffected.
        </>
      ) : (
        <>
          <div style={{ color: theme.text, fontWeight: 600, marginBottom: 2 }}>Persona is turned off</div>
          {reason ?? "Persona is disabled on this collector (STANDUP_PERSONA=0)."} Restart the
          collector without <code style={{ fontFamily: theme.mono }}>STANDUP_PERSONA=0</code> to
          talk to it. Sessions, Work and every other view are unaffected.
        </>
      )}
    </div>
  );
}

/**
 * What a viewer the collector won't show a Persona to sees. An `unauthenticated`
 * viewer reached the console without a tunnel identity; a `sign-in` one is a
 * browser that hasn't signed in, told how to; anything else shows the server's
 * explanation.
 */
function RefusedNote({
  reason,
  refusal,
  signInAs,
  hostAlias,
}: {
  reason: string;
  refusal?: PersonaRefusal;
  signInAs?: "owner" | "user";
  hostAlias?: string;
}) {
  const unauthenticated = refusal === "unauthenticated";
  if (refusal === "sign-in" && signInAs) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
        <PersonaSignInBanner as={signInAs} hostAlias={hostAlias} />
        <div style={{ padding: 24, fontSize: 13, lineHeight: 1.6, color: theme.dim }}>
          Your Persona's threads, jobs and approvals show here once this browser is signed in. Sessions, Work and every
          other view are yours to use as usual.
        </div>
      </div>
    );
  }
  return (
    <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ maxWidth: 440, textAlign: "center", fontSize: 13, lineHeight: 1.6, color: theme.dim }}>
        <div style={{ color: theme.text, fontWeight: 600, fontSize: 14, marginBottom: 4 }}>
          {unauthenticated ? "Open the console through the tunnel" : "Persona isn't available here"}
        </div>
        {unauthenticated
          ? "Every user has their own Persona, tied to who you are. This page reached the console without a tunnel identity, so there's no Persona to show — open the console through the tunnel link instead."
          : reason}{" "}
        Sessions, Work and every other view are yours to use as usual.
      </div>
    </div>
  );
}

/** The jobs list; a row opens that job's drawer. */
export function JobsPanel({
  jobs,
  selected,
  onOpen,
}: {
  jobs: PersonaJob[];
  /** The job whose drawer is open. */
  selected: string | null;
  onOpen: (id: string) => void;
}) {
  const sorted = useMemo(() => sortJobs(jobs), [jobs]);

  if (sorted.length === 0) {
    return (
      <div style={{ padding: "8px 14px 14px", fontSize: 12, color: theme.faint }}>
        No jobs yet. Each request Persona takes on shows up here with the sessions working on it.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", padding: "0 8px 10px" }}>
      {sorted.map((job) => {
        const state = jobState(job);
        const status = JOB_STATE[state];
        const open = selected === job.id;
        const summary = jobSummaryLine(job);
        const needs = job.view?.needs?.map((n) => JOB_NEED[n]).filter(Boolean) ?? [];
        const lastActivity = jobLastActivity(job);
        // The row stays terse: only an action with a route of its own links from
        // here, the rest are opened in the drawer the row leads to.
        const actions = state === "needs_you" ? job.view?.actions ?? [] : [];
        return (
          <div key={job.id} style={{ borderBottom: `1px solid ${theme.edgeSoft}` }} data-job-state={state}>
            <button
              type="button"
              onClick={() => onOpen(job.id)}
              aria-current={open ? "true" : undefined}
              title={summary?.text ?? job.goal}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "flex-start",
                gap: 8,
                padding: "8px 6px",
                background: open ? theme.ground : "transparent",
                border: "none",
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              <span
                style={{
                  flexShrink: 0,
                  fontSize: 10,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  padding: "1px 6px",
                  marginTop: 1,
                  minWidth: 64,
                  textAlign: "center",
                  borderRadius: 4,
                  color: status.color,
                  background: alpha(status.color, 0x1f),
                }}
              >
                {status.label}
              </span>
              <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                <span style={{ fontSize: 12.5, color: theme.text, overflowWrap: "anywhere" }}>{job.title}</span>
                {summary && (
                  <span
                    data-testid="job-summary"
                    style={{
                      fontSize: 11.5,
                      color: theme.dim,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                    }}
                  >
                    {summary.source === "checkpoint" ? "Worker: " : ""}
                    {summary.text}
                  </span>
                )}
                <span data-testid="job-meta" style={{ fontSize: 11, color: theme.faint }}>
                  {needs.length > 0 && <span style={{ color: status.color }}>{needs.join(" · ")} · </span>}
                  <span title={absoluteTime(lastActivity)}>active {relativeTime(lastActivity)}</span>
                </span>
              </span>
              <span style={{ color: theme.faint, fontSize: 11 }}>›</span>
            </button>
            {actions.length > 0 && (
              <div style={{ padding: "0 6px 7px 78px" }}>
                <JobActions actions={actions} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const userBubble: CSSProperties = {
  background: theme.raised,
  color: theme.text,
  borderRadius: "10px 10px 3px 10px",
  padding: "8px 12px",
  fontSize: 13,
  lineHeight: 1.5,
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};

const primaryButton: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  padding: "6px 14px",
  borderRadius: 6,
  border: "none",
  background: theme.running,
  color: theme.ground,
};

const secondaryButton: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  padding: "5px 12px",
  borderRadius: 6,
  border: `1px solid ${theme.edge}`,
  background: "transparent",
  color: theme.dim,
  cursor: "pointer",
};

const linkButton: CSSProperties = {
  background: "transparent",
  border: "none",
  padding: 0,
  fontSize: 11,
  fontWeight: 600,
  color: theme.running,
  cursor: "pointer",
};
