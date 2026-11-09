import { afterEach, describe, expect, test } from "bun:test";
import { applyList, coalesce, fetchJson, isList, readJson } from "./liveFetch";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function answer(body: string, status = 200): void {
  globalThis.fetch = (async () => new Response(body, { status })) as unknown as typeof fetch;
}

// A promise and the hooks that settle it, for holding a run in flight.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("fetchJson", () => {
  test("returns an ok body that passes the shape check", async () => {
    answer(JSON.stringify([1, 2]));
    expect(await fetchJson("/api/x", isList<number>)).toEqual([1, 2]);
  });

  test("returns undefined for a response that isn't ok, even with a list body", async () => {
    answer(JSON.stringify([]), 500);
    expect(await fetchJson("/api/x", isList)).toBeUndefined();
  });

  test("returns undefined for a 503 error body", async () => {
    answer(JSON.stringify({ error: "draining" }), 503);
    expect(await fetchJson("/api/x", isList)).toBeUndefined();
  });

  test("returns undefined for an ok body of the wrong shape", async () => {
    answer(JSON.stringify({ error: "nope" }));
    expect(await fetchJson("/api/x", isList)).toBeUndefined();
  });

  test("returns undefined for an ok body that isn't JSON", async () => {
    answer("<html>bad gateway</html>");
    expect(await fetchJson("/api/x", isList)).toBeUndefined();
  });

  test("a network failure still rejects", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(fetchJson("/api/x", isList)).rejects.toThrow("fetch failed");
  });
});

describe("readJson and applyList", () => {
  test("readJson applies the caller's shape check", async () => {
    const isCount = (b: unknown): b is { count: number } =>
      typeof b === "object" && b !== null && typeof (b as { count?: unknown }).count === "number";
    expect(await readJson(new Response(JSON.stringify({ count: 3 })), isCount)).toEqual({ count: 3 });
    expect(await readJson(new Response(JSON.stringify({ count: "3" })), isCount)).toBeUndefined();
  });

  test("applyList hands over a list and skips everything else", async () => {
    const applied: unknown[][] = [];
    await applyList(new Response(JSON.stringify(["a"])), (list) => applied.push(list));
    await applyList(new Response(JSON.stringify({ error: "x" }), { status: 503 }), (list) => applied.push(list));
    await applyList(new Response(JSON.stringify({ error: "x" })), (list) => applied.push(list));
    await applyList(new Response(JSON.stringify(["b"]), { status: 404 }), (list) => applied.push(list));
    expect(applied).toEqual([["a"]]);
  });
});

describe("coalesce", () => {
  test("a call with nothing in flight runs at once", async () => {
    let runs = 0;
    const refresh = coalesce(async () => ++runs);
    expect(await refresh()).toBe(1);
    expect(await refresh()).toBe(2);
  });

  test("a burst while one run is in flight adds exactly one trailing run", async () => {
    const gates = [deferred<void>(), deferred<void>()];
    let runs = 0;
    const refresh = coalesce(async () => {
      const n = runs++;
      await gates[n]!.promise;
      return n;
    });
    const first = refresh();
    const burst = Array.from({ length: 9 }, () => refresh());
    expect(runs).toBe(1);

    gates[0]!.resolve();
    expect(await first).toBe(0);
    await tick();
    expect(runs).toBe(2);

    gates[1]!.resolve();
    // Every call made during the first run resolves with the trailing run.
    expect(await Promise.all(burst)).toEqual(Array(9).fill(1));
    expect(runs).toBe(2);
  });

  test("a call during the trailing run queues one more", async () => {
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    let runs = 0;
    const refresh = coalesce(async () => {
      const n = runs++;
      await gates[n]!.promise;
      return n;
    });
    void refresh();
    const trailing = refresh();
    gates[0]!.resolve();
    await tick();
    expect(runs).toBe(2);

    // Lands while the trailing run is in flight: it may describe a change
    // that run never saw, so it gets a run of its own.
    const late = refresh();
    gates[1]!.resolve();
    expect(await trailing).toBe(1);
    await tick();
    expect(runs).toBe(3);
    gates[2]!.resolve();
    expect(await late).toBe(2);
  });

  test("a call made just as a run settles never overlaps the trailing run", async () => {
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    let runs = 0;
    let active = 0;
    let maxActive = 0;
    const refresh = coalesce(async () => {
      const n = runs++;
      maxActive = Math.max(maxActive, ++active);
      try {
        await gates[n]!.promise;
      } finally {
        active--;
      }
      return n;
    });
    const first = refresh();
    // Lands in the microtasks right after the first run settles, ahead of
    // anything the trailing call below chains onto it.
    const late = first.then(() => refresh());
    const trailing = refresh();
    gates[0]!.resolve();
    await first;
    await tick();
    gates[1]!.resolve();
    expect(await trailing).toBe(1);
    await tick();
    gates[2]!.resolve();
    expect(await late).toBe(2);
    expect(maxActive).toBe(1);
    expect(runs).toBe(3);
  });

  test("a failed run still lets the trailing run go", async () => {
    const gates = [deferred<void>(), deferred<void>()];
    let runs = 0;
    const refresh = coalesce(async () => {
      const n = runs++;
      await gates[n]!.promise;
      return n;
    });
    const first = refresh();
    const trailing = refresh();
    gates[0]!.reject(new Error("503"));
    await expect(first).rejects.toThrow("503");
    gates[1]!.resolve();
    expect(await trailing).toBe(1);
    expect(runs).toBe(2);
  });

  test("a run that throws synchronously rejects its caller and clears the slot", async () => {
    let runs = 0;
    const refresh = coalesce((): Promise<number> => {
      runs++;
      if (runs === 1) throw new Error("boom");
      return Promise.resolve(runs);
    });
    await expect(refresh()).rejects.toThrow("boom");
    expect(await refresh()).toBe(2);
  });
});
