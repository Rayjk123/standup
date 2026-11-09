import { fetchWithTimeout } from "../net/fetch.js";

/** Total attempts for one Slack Web API call, including the first. */
export const MAX_ATTEMPTS = 5;
export const BASE_BACKOFF_MS = 500;
export const MAX_BACKOFF_MS = 30_000;

const RETRYABLE = (status: number) => status === 429 || status >= 500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Full jitter: a uniform delay in [0, min(cap, base * 2^attempt)). */
function backoffDelay(attempt: number): number {
  const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
  return Math.floor(Math.random() * ceiling);
}

/**
 * POSTs to a Slack Web API method, retrying 429 and 5xx with exponential
 * backoff and full jitter. A 429's Retry-After header, when present, replaces
 * the computed delay.
 */
export async function postWithRetry(method: string, token: string, payload: unknown): Promise<unknown> {
  let lastStatus = 0;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const res = await fetchWithTimeout(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
    });
    if (res.ok) return res.json();
    lastStatus = res.status;
    if (!RETRYABLE(res.status) || attempt === MAX_ATTEMPTS - 1) break;
    const retryAfter = Number(res.headers.get("retry-after"));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffDelay(attempt));
  }
  throw new Error(`slack ${method} failed after ${MAX_ATTEMPTS} attempts (last status ${lastStatus})`);
}

export function startStream(token: string, channel: string, threadTs: string): Promise<unknown> {
  return postWithRetry("chat.startStream", token, { channel, thread_ts: threadTs });
}

export function appendStream(token: string, channel: string, ts: string, markdown: string): Promise<unknown> {
  return postWithRetry("chat.appendStream", token, { channel, ts, markdown_text: markdown });
}
