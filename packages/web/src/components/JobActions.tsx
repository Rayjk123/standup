import type { CSSProperties } from "react";
import { Link } from "react-router-dom";
import type { PersonaJobAction, PersonaJobActionKind } from "@standup/shared";
import { theme } from "./theme";
import { reviewPath, sessionPath } from "./jobStatus";

/**
 * What a job needs its owner to do (`PersonaJobView.actions`), each as the
 * control that opens it: a review packet links to the Review tab, a worker's
 * hand-off to that worker's session, an approval or a question goes to the
 * Persona chat that decides it, a note opens the job's thread, and a waiting
 * pipeline run reveals the run. An action this
 * surface has no way to open is left out, so every control shown leads
 * somewhere.
 */
export function JobActions({
  actions,
  onDiscuss,
  onShowMessages,
  onPipeline,
}: {
  actions: PersonaJobAction[];
  /** Opens the Persona chat on this job, where approvals and questions are decided. */
  onDiscuss?: () => void;
  /** Shows the thread filtered to this job. */
  onShowMessages?: () => void;
  /** Reveals the job's pipeline runs. */
  onPipeline?: () => void;
}) {
  const handlers: Partial<Record<PersonaJobActionKind, (() => void) | undefined>> = {
    approval: onDiscuss,
    ask: onDiscuss,
    message: onShowMessages ?? onDiscuss,
    pipeline: onPipeline,
  };
  const shown = actions.filter((a) => linkOf(a) !== null || handlers[a.kind]);
  if (shown.length === 0) return null;

  return (
    <span
      data-testid="job-actions"
      style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", columnGap: 10, rowGap: 2 }}
    >
      {shown.map((action, i) =>
        linkOf(action) !== null ? (
          <Link
            key={`${action.kind}:${action.id}:${i}`}
            data-testid="job-action"
            data-kind={action.kind}
            to={linkOf(action)!}
            style={actionLink}
          >
            {action.label}
          </Link>
        ) : (
          <button
            key={`${action.kind}:${action.id}:${i}`}
            type="button"
            data-testid="job-action"
            data-kind={action.kind}
            onClick={handlers[action.kind]}
            style={actionButton}
          >
            {action.label}
          </button>
        )
      )}
    </span>
  );
}

/** The console route an action opens on its own (a review packet, a worker session), or null. */
function linkOf(action: PersonaJobAction): string | null {
  if (action.kind === "review") return reviewPath(action.id);
  if (action.kind === "session") return sessionPath(action.id);
  return null;
}

const actionLink: CSSProperties = {
  fontSize: 11.5,
  fontWeight: 600,
  color: theme.running,
  textDecoration: "none",
  overflowWrap: "anywhere",
};

const actionButton: CSSProperties = {
  ...actionLink,
  border: "none",
  background: "transparent",
  padding: 0,
  textAlign: "left",
  cursor: "pointer",
};
