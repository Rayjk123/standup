import { Component, type ErrorInfo, type ReactNode } from "react";
import { theme } from "./theme";
import { retryFailedViews } from "../lib/lazyNamed";

/** What a lazily loaded view shows while its chunk downloads. */
export function ViewLoading() {
  return (
    <div data-testid="view-loading" style={{ padding: 24, color: theme.dim, fontSize: 13 }}>
      Loading…
    </div>
  );
}

interface Props {
  children: ReactNode;
  /** A change remounts the boundary and retries: the route, so opening another tab recovers. */
  resetKey?: string;
}

/**
 * Catches a lazily loaded view that fails to load or render, so one tab's
 * failure leaves the top bar and the other tabs working, and offers a reload.
 */
export class ViewBoundary extends Component<Props, { error?: Error; resetKey?: string }> {
  state: { error?: Error; resetKey?: string } = { resetKey: this.props.resetKey };

  constructor(props: Props) {
    super(props);
    // A boundary mounted afresh (a reopened dialog) retries views that failed before.
    retryFailedViews();
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: { error?: Error; resetKey?: string }) {
    if (props.resetKey === state.resetKey) return null;
    // Clearing the error re-renders the view: let a failed chunk load again.
    if (state.error) retryFailedViews();
    return { error: undefined, resetKey: props.resetKey };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[console] view failed", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" data-testid="view-error" style={{ padding: 24, color: theme.dim, fontSize: 13, display: "flex", gap: 12, alignItems: "center" }}>
        <span>This view couldn't load: {this.state.error.message}</span>
        <button
          onClick={() => window.location.reload()}
          style={{
            background: "none",
            border: `1px solid ${theme.edge}`,
            borderRadius: 5,
            padding: "4px 10px",
            color: theme.text,
            cursor: "pointer",
            fontSize: 12.5,
          }}
        >
          Reload
        </button>
      </div>
    );
  }
}
