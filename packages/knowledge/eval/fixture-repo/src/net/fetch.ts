/** Per-request timeout for outbound HTTP from the collector. */
export const FETCH_TIMEOUT_MS = 30_000;

/**
 * fetch with an explicit timeout. Without a signal, Bun's fetch waits on a
 * stalled upstream until its own 360 second default expires, which shows up as
 * webhook and Slack calls hanging for six minutes.
 */
export function fetchWithTimeout(input: string | URL, init: RequestInit = {}, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  return fetch(input, { ...init, signal });
}
