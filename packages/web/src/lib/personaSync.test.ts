import { describe, expect, test } from "bun:test";
import { syncPersonaSnapshot, type PersonaSnapshot } from "./persona";

const ok: PersonaSnapshot = { messages: { threadId: "t", messages: [] } };
const failed: PersonaSnapshot = { loadError: "Request failed (502)" };

function run(results: PersonaSnapshot[], opts: { current?: () => boolean; retryMs?: number[] } = {}) {
  const applied: PersonaSnapshot[] = [];
  const waits: number[] = [];
  let i = 0;
  const done = syncPersonaSnapshot({
    fetchSnapshot: async () => results[Math.min(i++, results.length - 1)]!,
    apply: (s) => applied.push(s),
    frameMark: () => 0,
    current: opts.current ?? (() => true),
    sleep: async (ms) => {
      waits.push(ms);
    },
    retryMs: opts.retryMs ?? [10, 20, 40],
  });
  return { done, applied, waits };
}

describe("syncPersonaSnapshot", () => {
  test("retries a failed read until one loads, applying each", async () => {
    const r = run([failed, failed, ok]);
    expect(await r.done).toBe(true);
    expect(r.applied).toEqual([failed, failed, ok]);
    expect(r.waits).toEqual([10, 20]);
  });

  test("gives up when the retries run out", async () => {
    const r = run([failed]);
    expect(await r.done).toBe(false);
    expect(r.applied).toHaveLength(4);
  });

  test("a refusal or a disabled Persona isn't retried", async () => {
    expect(await run([{ forbidden: "sign in" }]).done).toBe(true);
    expect(await run([{ disabledReason: "off" }]).done).toBe(true);
  });

  test("stops, without applying, once a newer resync took over", async () => {
    let current = true;
    const r = run([failed, ok], {
      current: () => {
        const was = current;
        current = false;
        return was;
      },
    });
    expect(await r.done).toBe(false);
    expect(r.applied).toEqual([failed]);
  });
});
