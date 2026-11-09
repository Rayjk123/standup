import { OWNER_SIGN_IN_NOTICE, dismissOwnerSignIn, useOwnerSignInNeeded } from "../lib/ownerSignIn";
import { theme } from "./theme";

/** A banner shown after the collector refused a request for lacking the owner token. */
export function OwnerSignInNotice() {
  if (!useOwnerSignInNeeded()) return null;
  return (
    <div
      role="alert"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 1000,
        display: "flex",
        justifyContent: "center",
        gap: 12,
        padding: "8px 12px",
        background: theme.noticeBg,
        color: theme.noticeText,
        fontSize: 13,
      }}
    >
      <span>{OWNER_SIGN_IN_NOTICE}</span>
      <button onClick={dismissOwnerSignIn} style={{ background: "none", border: "none", color: "inherit", cursor: "pointer" }}>
        Dismiss
      </button>
    </div>
  );
}
