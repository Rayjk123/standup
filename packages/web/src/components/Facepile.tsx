import type { CSSProperties } from "react";
import type { Actor, PresenceEntry } from "@standup/shared";
import { usePresence, viewersOf } from "../hooks/presence";
import { alpha, theme } from "./theme";

/** Deterministic avatar tint per user, so a face keeps the same color. */
const TINTS = [theme.accent, theme.running, theme.expert, theme.checkpoint, theme.stalled];
function tintFor(user: string): string {
  let h = 0;
  for (let i = 0; i < user.length; i++) h = (h * 31 + user.charCodeAt(i)) | 0;
  return TINTS[Math.abs(h) % TINTS.length];
}

/** First two initials of an alias — `alice` → `AL`, `slack:U…` → `U…`. */
function initials(user: string): string {
  const base = user.includes(":") ? user.slice(user.indexOf(":") + 1) : user;
  return base.slice(0, 2).toUpperCase();
}

/**
 * The initials chip for one identity. `overlap` nudges it left so a row of them
 * reads as a stacked facepile (presence, viewing pips); a standalone tag (the
 * attribution "started by" chip) turns it off. Size scales the font with it.
 */
function avatar(
  user: string,
  ring: boolean,
  title: string | undefined,
  opts?: { key?: string; size?: number; overlap?: boolean }
): JSX.Element {
  const tint = tintFor(user);
  const size = opts?.size ?? 22;
  const overlap = opts?.overlap ?? true;
  return (
    <span
      key={opts?.key}
      title={title}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        background: alpha(tint, 0x22),
        color: tint,
        border: `1px solid ${ring ? tint : "transparent"}`,
        fontSize: Math.max(8, Math.round(size * 0.43)),
        fontWeight: 700,
        fontFamily: theme.mono,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        marginLeft: overlap ? -6 : 0,
      }}
    >
      {initials(user)}
    </span>
  );
}

/** One user's standalone initials chip, with no tooltip of its own, so its container's title shows. */
export function UserAvatar({ user, size }: { user: string; size?: number }) {
  return avatar(user, false, undefined, { size, overlap: false });
}

/** A user's friendly name — the actor's `display` when set, else the raw alias. */
function displayFor(actors: Actor[] | undefined, alias: string): string {
  return actors?.find((a) => a.id === alias)?.display ?? alias;
}

/**
 * The team facepile (Phase 7 — Concept 1): who is connected right now, keyed by
 * the Phase-1 tunnel identity. Reads the ephemeral presence roster from context;
 * the current user's own face carries a ring. Renders nothing when alone off the
 * tunnel (a single local user isn't worth the chrome).
 */
export function Facepile() {
  const { roster, currentUser } = usePresence();
  if (roster.length <= 1) return null;

  const MAX = 6;
  const shown = roster.slice(0, MAX);
  const overflow = roster.length - shown.length;

  return (
    <div style={{ display: "flex", alignItems: "center", paddingLeft: 6 }}>
      {shown.map((e) =>
        avatar(
          e.user,
          e.user === currentUser,
          `${e.user}${e.user === currentUser ? " (you)" : ""}${
            e.typing ? " · typing…" : e.viewingSessionId ? " · viewing a session" : ""
          }`,
          { key: e.user }
        )
      )}
      {overflow > 0 && (
        <span
          title={`${overflow} more online`}
          style={{
            fontFamily: theme.mono,
            fontSize: 10,
            color: theme.faint,
            marginLeft: 4,
          }}
        >
          +{overflow}
        </span>
      )}
    </div>
  );
}

/**
 * Per-session viewing pips: the teammates currently looking at one session,
 * for the session lists. Renders nothing when no one is viewing it.
 */
export function ViewingPips({
  sessionId,
  style,
}: {
  sessionId: string;
  style?: CSSProperties;
}) {
  const { roster, currentUser } = usePresence();
  const viewers: PresenceEntry[] = viewersOf(roster, sessionId);
  if (viewers.length === 0) return null;

  return (
    <span style={{ display: "inline-flex", alignItems: "center", ...style }}>
      {viewers.slice(0, 3).map((v) =>
        avatar(
          v.user,
          v.user === currentUser,
          `${v.user} is viewing${v.typing ? " · typing…" : ""}`,
          { key: v.user }
        )
      )}
    </span>
  );
}

/**
 * A stacked facepile for an explicit set of aliases — the collaborators who have
 * acted on a session (Personalization/Multiplayer spec F participant set), as
 * distinct from the live presence roster the bare `Facepile` shows. Rings the
 * current user's own face; each alias resolves to its display name for the hover
 * title. Renders nothing for an empty set.
 */
export function ActorPips({
  aliases,
  actors,
  currentUser,
  size = 18,
  style,
}: {
  aliases: string[];
  actors?: Actor[];
  currentUser?: string;
  size?: number;
  style?: CSSProperties;
}) {
  if (aliases.length === 0) return null;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", ...style }}>
      {aliases.map((a) =>
        avatar(
          a,
          a === currentUser,
          `${displayFor(actors, a)}${a === currentUser ? " (you)" : ""}`,
          { key: a, size }
        )
      )}
    </span>
  );
}

/**
 * Session attribution (Concept 1 — Personalization/Multiplayer spec E): a
 * "started by <alias>" tag built from the session's `createdActor`, resolved to
 * a display name through the actor directory. When the current owner differs
 * from the creator (someone claimed a shared session) it also names the owner.
 * Renders nothing for a session with no recorded creator (pre-collaboration).
 * `label` off collapses it to just the avatar chip for tight rows.
 */
export function StartedBy({
  createdActor,
  ownerActor,
  actors,
  size = 16,
  label = true,
  style,
}: {
  createdActor?: string;
  ownerActor?: string;
  actors?: Actor[];
  size?: number;
  label?: boolean;
  style?: CSSProperties;
}) {
  if (!createdActor) return null;
  const creator = displayFor(actors, createdActor);
  const owner =
    ownerActor && ownerActor !== createdActor ? displayFor(actors, ownerActor) : null;
  const title = `Started by ${creator}${owner ? ` · owned by ${owner}` : ""}`;

  return (
    <span
      title={title}
      style={{ display: "inline-flex", alignItems: "center", gap: 5, minWidth: 0, ...style }}
    >
      {avatar(createdActor, false, title, { size, overlap: false })}
      {label && (
        <span
          style={{
            fontSize: 11,
            color: theme.faint,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          started by{" "}
          <span style={{ color: theme.dim, fontWeight: 600 }}>{creator}</span>
          {owner && (
            <>
              {" · owned by "}
              <span style={{ color: theme.dim, fontWeight: 600 }}>{owner}</span>
            </>
          )}
        </span>
      )}
    </span>
  );
}
