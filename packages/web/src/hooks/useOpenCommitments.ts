import { useEffect, useState } from "react";
import type { PersonaCommitment } from "@standup/shared";
import { personaCall } from "../lib/persona";

/** How often the open commitments are re-read while a reader is mounted and enabled. */
export const COMMITMENTS_POLL_MS = 15_000;

/**
 * The viewer's open Persona commitments, read on mount and every `pollMs`
 * while the tab is visible; a hidden tab catches up the moment it is shown
 * again. `null` until the first read lands, and a failed re-read keeps the
 * last list. Nothing is read while `enabled` is false, and turning it off
 * stops the polling.
 */
export function useOpenCommitments(
  { pollMs = COMMITMENTS_POLL_MS, enabled = true }: { pollMs?: number; enabled?: boolean } = {}
): { list: PersonaCommitment[] | null; readAt: number } {
  const [list, setList] = useState<PersonaCommitment[] | null>(null);
  const [readAt, setReadAt] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = async () => {
      const res = await personaCall<{ commitments: PersonaCommitment[] }>("/commitments");
      if (cancelled) return;
      setReadAt(Date.now());
      if (res.ok) setList(res.data?.commitments ?? []);
    };
    const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";
    const onVisibility = () => {
      if (visible()) void load();
    };
    void load();
    const timer = setInterval(() => {
      if (visible()) void load();
    }, pollMs);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [pollMs, enabled]);

  return { list, readAt };
}
