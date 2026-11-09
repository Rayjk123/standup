import { useCallback, useEffect, useRef, useState } from "react";
import type { TranscriptEventsPage } from "@standup/shared";
import type { RawRecord } from "./sessionProjection";

/** Forward delta page size — the server caps this endpoint at 2000. */
const PAGE_LIMIT = 2000;
/**
 * Records loaded on open (the tail) and per "load earlier" step. A record is
 * roughly one JSONL line; a session's rendered message/row count is smaller
 * (tool_result-only records fold away), so these comfortably fill the ~300-card
 * render window while keeping open time constant on the 8MB / 4000+-line
 * sessions this reader targets.
 */
const INITIAL_TAIL = 600;
const EARLIER_STEP = 400;

interface EventsResponse extends TranscriptEventsPage {
  owned?: boolean;
}

/**
 * Drives a session's transcript from the Phase-2 `transcript_events` log
 * (Concept 3) instead of re-reading a JSONL tail window every refresh.
 *
 * It opens on the TAIL — the newest `INITIAL_TAIL` records — so a long session
 * loads in constant time rather than shipping the whole log before first paint.
 * From there it does two things: pages FORWARD from the head cursor to append
 * new turns as they land (a live WS nudge, or the slow backstop), and pages
 * BACKWARD from the oldest loaded record when the reader asks for earlier
 * history (`loadEarlier`, gated by `hasEarlier`). The GET itself reconciles
 * JSONL → log server-side, so a fetch both ingests new turns and returns them.
 */
export function useSessionEvents({
  sessionId,
  sessionEnded,
  eventSignal,
}: {
  sessionId: string;
  sessionEnded: boolean;
  eventSignal: number;
}) {
  const [records, setRecords] = useState<RawRecord[]>([]);
  const [owned, setOwned] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [hasEarlier, setHasEarlier] = useState(false);

  // The highest seq loaded; where the next forward delta page starts.
  const cursorRef = useRef(0);
  // The lowest seq loaded; where the next backward page pages from.
  const firstSeqRef = useRef(0);
  const hasEarlierRef = useRef(false);
  // Prevents overlapping forward drains; a nudge arriving mid-drain sets
  // `pending` so the in-flight drain runs once more instead of being dropped.
  const fetchingRef = useRef(false);
  const pendingRef = useRef(false);
  // Gates forward drains until the tail load has established the head cursor.
  // Without it, a nudge racing the open would drain forward from seq 0 — i.e.
  // pull the whole log, the exact cost the tail load exists to avoid.
  const tailLoadedRef = useRef(false);
  // A backward page runs independently of the forward drain (they touch
  // opposite ends of the loaded range), guarded on its own.
  const earlierFetchingRef = useRef(false);
  const ownedRef = useRef(false);
  // The session a fetch was started for — guards against a late response from a
  // previous session landing in the new session's state after a fast switch.
  const sessionIdRef = useRef(sessionId);

  // Open on the tail: the newest INITIAL_TAIL records, plus where forward and
  // backward paging resume from.
  // Pull the forward delta past the cursor and append it. Walks to the head a
  // page at a time; each page advances the cursor.
  const pull = useCallback(async () => {
    // The tail load owns establishing the cursor and fires the first pull; a
    // nudge/backstop arriving before that is a no-op (not queued — the tail load
    // will pull once it's ready).
    if (!tailLoadedRef.current) return;
    if (fetchingRef.current) {
      pendingRef.current = true;
      return;
    }
    fetchingRef.current = true;
    const forSession = sessionIdRef.current;
    try {
      let since = cursorRef.current;
      const acc: RawRecord[] = [];
      for (;;) {
        const res = await fetch(
          `/api/sessions/${forSession}/transcript/events?sinceSeq=${since}&limit=${PAGE_LIMIT}`
        );
        if (!res.ok) break;
        const page = (await res.json()) as EventsResponse;
        if (typeof page.owned === "boolean") ownedRef.current = page.owned;
        for (const e of page.events) acc.push(e.event as RawRecord);
        since = page.cursor;
        if (sessionIdRef.current === forSession) cursorRef.current = page.cursor;
        if (page.events.length < PAGE_LIMIT) break;
      }

      if (sessionIdRef.current !== forSession) return;
      if (acc.length > 0) setRecords((prev) => prev.concat(acc));
      setOwned(ownedRef.current);
      setLoaded(true);
    } catch {
      setLoaded(true);
    } finally {
      fetchingRef.current = false;
      if (pendingRef.current) {
        pendingRef.current = false;
        void pull();
      }
    }
  }, []);

  const loadTail = useCallback(async () => {
    const forSession = sessionIdRef.current;
    try {
      const res = await fetch(
        `/api/sessions/${forSession}/transcript/events?before=0&limit=${INITIAL_TAIL}`
      );
      if (sessionIdRef.current !== forSession) return;
      if (!res.ok) {
        setLoaded(true);
        return;
      }
      const page = (await res.json()) as EventsResponse;
      if (sessionIdRef.current !== forSession) return;

      const acc = page.events.map((e) => e.event as RawRecord);
      cursorRef.current = page.headSeq ?? (page.events.at(-1)?.seq ?? 0);
      firstSeqRef.current = page.firstSeq ?? 0;
      hasEarlierRef.current = !!page.hasEarlier;
      if (typeof page.owned === "boolean") ownedRef.current = page.owned;

      setRecords(acc);
      setHasEarlier(hasEarlierRef.current);
      setOwned(ownedRef.current);
      setLoaded(true);
      // Forward drains may now run; catch anything that landed during the load.
      tailLoadedRef.current = true;
      void pull();
    } catch {
      // Leave prior records on screen rather than blanking the transcript.
      // Enable forward drains anyway: with the cursor still 0 they degrade to a
      // full forward load, so a transient tail-load failure still recovers.
      tailLoadedRef.current = true;
      setLoaded(true);
    }
  }, [pull]);

  // Page one step further into history: the records just before the oldest one
  // currently loaded, prepended in log order.
  const loadEarlier = useCallback(async () => {
    if (earlierFetchingRef.current || !hasEarlierRef.current) return;
    earlierFetchingRef.current = true;
    const forSession = sessionIdRef.current;
    try {
      const res = await fetch(
        `/api/sessions/${forSession}/transcript/events?before=${firstSeqRef.current}&limit=${EARLIER_STEP}`
      );
      if (!res.ok) return;
      const page = (await res.json()) as EventsResponse;
      if (sessionIdRef.current !== forSession || page.events.length === 0) return;

      const earlier = page.events.map((e) => e.event as RawRecord);
      firstSeqRef.current = page.firstSeq ?? firstSeqRef.current;
      hasEarlierRef.current = !!page.hasEarlier;
      setRecords((prev) => earlier.concat(prev));
      setHasEarlier(hasEarlierRef.current);
    } catch {
      // Leave what's loaded; the reader can retry.
    } finally {
      earlierFetchingRef.current = false;
    }
  }, []);

  // Reset and reopen on the tail when the session changes.
  useEffect(() => {
    sessionIdRef.current = sessionId;
    cursorRef.current = 0;
    firstSeqRef.current = 0;
    hasEarlierRef.current = false;
    pendingRef.current = false;
    tailLoadedRef.current = false;
    ownedRef.current = false;
    setRecords([]);
    setOwned(false);
    setLoaded(false);
    setHasEarlier(false);
    void loadTail();
  }, [sessionId, loadTail]);

  // A hook/ingest nudge for this session — fetch the delta past the cursor.
  useEffect(() => {
    if (eventSignal === 0) return;
    void pull();
  }, [eventSignal, pull]);

  // Slow backstop while the session is live: catches a turn that produced no
  // nudge (a long tool result still streaming into the JSONL).
  useEffect(() => {
    if (sessionEnded) return;
    const timer = setInterval(() => void pull(), 10000);
    return () => clearInterval(timer);
  }, [sessionEnded, pull]);

  const reload = useCallback(() => void pull(), [pull]);

  return { records, owned, loading: !loaded, hasEarlier, loadEarlier, reload };
}
