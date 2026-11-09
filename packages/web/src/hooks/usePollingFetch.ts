import { useCallback, useEffect, useState } from "react";

/**
 * Fetches `${endpoint}?limit=N` and keeps it fresh, shared by every rendering
 * of a session's conversation.
 *
 * The refresh policy is the subtle part and lives here so callers can't drift:
 * refetch when a hook event arrives for this session (not on a timer — a timer
 * that skipped "idle" froze the view exactly when a reply landed), plus a slow
 * 10s backstop while the session is still alive for writes that produce no hook
 * (a long tool result streaming in).
 */
export function usePollingFetch<T>({
  endpoint,
  sessionEnded,
  eventSignal,
  pageSize,
}: {
  endpoint: string;
  sessionEnded: boolean;
  eventSignal: number;
  pageSize: number;
}) {
  const [data, setData] = useState<T | null>(null);
  const [limit, setLimit] = useState(pageSize);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${endpoint}?limit=${limit}`);
      if (res.ok) setData(await res.json());
    } catch {
      // Leave the previous data on screen rather than blanking it.
    } finally {
      setLoading(false);
    }
  }, [endpoint, limit]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  useEffect(() => {
    if (eventSignal === 0) return;
    void load();
  }, [eventSignal, load]);

  useEffect(() => {
    if (sessionEnded) return;
    const timer = setInterval(load, 10000);
    return () => clearInterval(timer);
  }, [load, sessionEnded]);

  const loadMore = useCallback(() => setLimit((n) => n + pageSize), [pageSize]);

  return { data, loading, loadMore, reload: load };
}
