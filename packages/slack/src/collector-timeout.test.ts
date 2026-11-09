// The collector REST calls must be time-bounded: a collector that accepts the
// socket but stops responding (deadlocked collector, half-open tunnel) would
// otherwise hang a settings PUT forever, leaving the command handler that awaits
// it stuck mid-mutation (no confirmation, no version stamp). These pin that
// getJson (getSettings) and putJson (setFeedChannel / patchChannelFeatures)
// attach an abort signal to fetch, and that a fetch which rejects (as a fired
// timeout does) surfaces as null — the caller-visible outcome that lets the
// handler complete — rather than hanging.

import { afterEach, describe, expect, test } from "bun:test";
import type { ChannelFeaturesPatch } from "@standup/shared";
import { CollectorClient } from "./collector-client.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function client(): CollectorClient {
  return new CollectorClient("http://collector.test", "ws://collector.test", {
    onMessage: () => {},
    onReconnect: () => {},
  });
}

/** Capture the RequestInit fetch is called with, returning a benign OK response. */
function captureInit(): { last: () => RequestInit | undefined } {
  let init: RequestInit | undefined;
  globalThis.fetch = (async (_url: unknown, opts?: RequestInit) => {
    init = opts;
    return { ok: true, json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
  return { last: () => init };
}

const patch: ChannelFeaturesPatch = { clear: ["C123"] };

describe("CollectorClient REST timeout", () => {
  test("getJson (getSettings) attaches an abort signal to fetch", async () => {
    const cap = captureInit();
    await client().getSettings();
    expect(cap.last()?.signal).toBeInstanceOf(AbortSignal);
  });

  test("putJson (setFeedChannel) attaches an abort signal to fetch", async () => {
    const cap = captureInit();
    await client().setFeedChannel("C123");
    const init = cap.last();
    expect(init?.method).toBe("PUT");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  test("putJson (patchChannelFeatures) attaches an abort signal to fetch", async () => {
    const cap = captureInit();
    await client().patchChannelFeatures(patch);
    expect(cap.last()?.signal).toBeInstanceOf(AbortSignal);
  });

  // A fetch that rejects the moment its abort signal fires — what a real fired
  // timeout does. Checks `aborted` first so a pre-aborted signal (used below to
  // drive the abort synchronously, without waiting the real 15s) still rejects.
  const rejectOnAbort = ((_url: unknown, opts?: RequestInit) =>
    new Promise((_resolve, reject) => {
      const signal = opts?.signal;
      if (!signal) return; // no signal means the timeout wasn't wired — leave it to hang the test
      const fail = () => reject(new DOMException("The operation timed out.", "TimeoutError"));
      if (signal.aborted) fail();
      else signal.addEventListener("abort", fail);
    })) as unknown as typeof fetch;

  test("a hung request that aborts surfaces as null on GET, not a hang", async () => {
    // The public method must resolve to null (unreachable), which is what lets the
    // awaiting mutation queue advance instead of stalling forever.
    globalThis.fetch = rejectOnAbort;
    const original = AbortSignal.timeout.bind(AbortSignal);
    // Drive the abort synchronously with a pre-aborted signal so the test doesn't
    // wait the real 15s timeout, while still exercising the reject-on-abort path.
    AbortSignal.timeout = (() =>
      AbortSignal.abort(new DOMException("timeout", "TimeoutError"))) as typeof AbortSignal.timeout;
    try {
      await expect(client().getSettings()).resolves.toBeNull();
    } finally {
      AbortSignal.timeout = original;
    }
  });

  test("a hung request that aborts surfaces as null on PUT, not a hang", async () => {
    globalThis.fetch = rejectOnAbort;
    const original = AbortSignal.timeout.bind(AbortSignal);
    AbortSignal.timeout = (() =>
      AbortSignal.abort(new DOMException("timeout", "TimeoutError"))) as typeof AbortSignal.timeout;
    try {
      await expect(client().setFeedChannel("C123")).resolves.toBeNull();
    } finally {
      AbortSignal.timeout = original;
    }
  });
});
