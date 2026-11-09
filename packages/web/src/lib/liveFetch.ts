/**
 * Reads behind the console's live collections. A collector that is draining or
 * restarting answers 503 with an `{ error }` body; these helpers turn that, or
 * any body of the wrong shape, into `undefined` so the caller keeps what it
 * holds instead of replacing a list with an error object.
 */

/** Whether `body` is a list — the shape every collection route answers. */
export function isList<T>(body: unknown): body is T[] {
  return Array.isArray(body);
}

/**
 * The body of `res` when it is ok and passes `isValid`; otherwise undefined.
 * A body that isn't JSON counts as the wrong shape.
 */
export async function readJson<T>(res: Response, isValid: (body: unknown) => body is T): Promise<T | undefined> {
  if (!res.ok) return undefined;
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return undefined;
  }
  return isValid(body) ? body : undefined;
}

/**
 * GETs `url` and returns its body when the response is ok and passes
 * `isValid`; otherwise undefined. A network failure still rejects.
 */
export async function fetchJson<T>(url: string, isValid: (body: unknown) => body is T): Promise<T | undefined> {
  return readJson(await fetch(url), isValid);
}

/** Hands `apply` the list in `res`, unless it is an error or not a list. */
export async function applyList<T>(res: Response, apply: (list: T[]) => void): Promise<void> {
  const list = await readJson(res, isList<T>);
  if (list !== undefined) apply(list);
}

/**
 * Wraps a refetch so a burst of calls runs it at most twice: one run in
 * flight, plus one trailing run for every call that arrived while it was in
 * flight. The trailing run is what keeps the result current — a call made
 * after the in-flight request was sent may describe a change that request
 * never saw. Every call resolves (or rejects) with the run that covers it.
 * The trailing run starts in the same callback that sees the in-flight one
 * settle, so no call can find the slot empty in between and start a second,
 * concurrent run whose answer might land out of order.
 */
export function coalesce<T>(fn: () => Promise<T>): () => Promise<T> {
  let inFlight = false;
  let trailing: { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } | null = null;
  const run = (): Promise<T> => {
    inFlight = true;
    const current = new Promise<T>((resolve) => resolve(fn()));
    const settle = () => {
      inFlight = false;
      const next = trailing;
      if (next === null) return;
      trailing = null;
      run().then(next.resolve, next.reject);
    };
    current.then(settle, settle);
    return current;
  };
  return () => {
    if (!inFlight) return run();
    if (trailing === null) {
      let resolve!: (value: T) => void;
      let reject!: (err: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      trailing = { promise, resolve, reject };
    }
    return trailing.promise;
  };
}
