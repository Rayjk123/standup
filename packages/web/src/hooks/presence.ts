import { createContext, useContext } from "react";
import type { PresenceEntry } from "@standup/shared";

/**
 * Ephemeral team presence (Phase 7 — Concept 1), shared through context so the
 * facepile and per-session viewing pips can read the live roster and report
 * what the current user is looking at without threading props through every
 * view. The roster is pushed by the collector over the WebSocket and is never
 * persisted.
 */
export interface PresenceApi {
  /** Everyone currently connected, one row per user. */
  roster: PresenceEntry[];
  /** The current viewer's resolved identity (tunnel alias, else host user). */
  currentUser: string;
  /** Report which session this client is viewing (null on a list view). */
  setViewing: (sessionId: string | null) => void;
  /** Report whether this client is composing a reply/steer. */
  setTyping: (typing: boolean) => void;
}

const PresenceContext = createContext<PresenceApi>({
  roster: [],
  currentUser: "",
  setViewing: () => {},
  setTyping: () => {},
});

export const PresenceProvider = PresenceContext.Provider;

export function usePresence(): PresenceApi {
  return useContext(PresenceContext);
}

/** The present users viewing a given session — the source for its viewing pips. */
export function viewersOf(roster: PresenceEntry[], sessionId: string): PresenceEntry[] {
  return roster.filter((e) => e.viewingSessionId === sessionId);
}
