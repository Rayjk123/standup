import { useState, useEffect, useRef, useCallback } from "react";
import { createLiveSocket, type LiveSocket, type LiveSocketHandlers, type LiveSocketStatus } from "./liveSocket";

export {
  helloAction,
  isSeqGap,
  reconnectPlan,
  SERVICE_RESTART_CLOSE,
  SERVICE_RESTART_RECONNECT_MAX_MS,
  SERVICE_RESTART_RECONNECT_MIN_MS,
  wsUrlWithCursor,
  type ReplayCursor,
} from "./liveSocket";

/**
 * The collector WebSocket endpoint, derived from the page's own origin instead
 * of a fixed `localhost` so it resolves to whatever host actually served the
 * app. Loaded through a tunnel host on a teammate's machine, a literal
 * `ws://localhost:...` points at the visitor's own loopback and never reaches
 * the host; deriving from `window.location` makes the socket follow the tunnel.
 * `wss:` on an https page so a secure origin isn't downgraded to an insecure
 * socket (browsers block that as mixed content). The socket shares the page
 * origin at `/ws` — proxied to the collector's WS port — so one tunnelled port
 * carries the web app, `/api`, and the live socket together.
 */
export function resolveWsUrl(
  loc: { protocol: string; host: string } = window.location
): string {
  const scheme = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${loc.host}/ws`;
}

/**
 * The live socket for the life of the component (see createLiveSocket). The
 * status reports when the connection dropped, so the UI can say it is
 * reconnecting. The socket opens once `enabled` is true, and stays open after.
 */
export function useWebSocket(url: string, handlers: LiveSocketHandlers, enabled = true) {
  const [status, setStatus] = useState<LiveSocketStatus>(() => ({ connected: false, downSince: Date.now() }));
  const socketRef = useRef<LiveSocket | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  // Sends a raw string frame if the socket is open — used for the ephemeral
  // client → server presence channel (Phase 7). A no-op while disconnected;
  // presence is re-sent on the next hello-ok, so a dropped update self-heals.
  const send = useCallback((data: string) => {
    socketRef.current?.send(data);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const socket = createLiveSocket({
      url,
      handlers: () => handlersRef.current,
      onStatus: setStatus,
      onStale: () => handlersRef.current.onStale?.(),
      wakeOn: [
        { source: document, events: ["visibilitychange"] },
        { source: window, events: ["online", "focus"] },
      ],
      isVisible: () => document.visibilityState !== "hidden",
    });
    socketRef.current = socket;
    setStatus(socket.status());
    return () => {
      socket.dispose();
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [url, enabled]);

  // Reconnects a down socket now instead of waiting out the backoff.
  const retry = useCallback(() => socketRef.current?.wake(), []);
  // The same, even when the socket was dialled a moment ago (the banner's button).
  const retryNow = useCallback(() => socketRef.current?.retryNow(), []);
  // Pings an open socket now; never dials a down one.
  const check = useCallback(() => socketRef.current?.check(), []);

  return { isConnected: status.connected, downSince: status.downSince, cause: status.cause ?? null, send, retry, retryNow, check };
}
