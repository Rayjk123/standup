import { usePresence } from "../hooks/presence";
import { userLoginCommand } from "../lib/persona";
import { OWNER_SIGN_IN_NOTICE } from "../lib/ownerSignIn";
import { alpha, theme } from "./theme";

/**
 * Shown where this browser can read the viewer's Persona (or schedules) but
 * can't direct it yet: the host is told to sign in as the owner, a guest how
 * to get a login link.
 */
export function PersonaSignInBanner({ as, hostAlias }: { as: "owner" | "user"; hostAlias?: string }) {
  const { currentUser } = usePresence();
  const color = theme.stalled;
  return (
    <div
      style={{
        padding: "7px 16px",
        fontSize: 12,
        color,
        background: alpha(color, 0x14),
        borderBottom: `1px solid ${alpha(color, 0x33)}`,
        overflowWrap: "anywhere",
      }}
    >
      {as === "owner" ? (
        OWNER_SIGN_IN_NOTICE
      ) : (
        <>
          <div style={{ fontWeight: 600, marginBottom: 2 }}>Sign in to direct your Persona</div>
          This browser can't send to Persona, decide its approvals or change its schedules yet. Ask{" "}
          {hostAlias ? <strong>{hostAlias}</strong> : "the host"} for a login link (they run{" "}
          <code style={{ fontFamily: theme.mono }}>{userLoginCommand(currentUser || undefined)}</code>), or DM{" "}
          <code style={{ fontFamily: theme.mono }}>login</code> to the Standup Slack app.
        </>
      )}
    </div>
  );
}
