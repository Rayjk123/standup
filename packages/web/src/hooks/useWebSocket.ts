import { useState, useEffect, useRef, useCallback } from "react";
import type { WsMessage } from "@standup/shared";

// `onMessage` fires synchronously for every message, in order — unlike a
// single `lastMessage` state slot, two messages that arrive in the same
// task (e.g. a hook handler broadcasting ask:resolved then checkpoint:new
// back-to-back) don't coalesce into just the last one.
//
// `onReconnect` fires when the socket reopens after having been connected
// before, so callers can resync anything the server broadcast while the
// tab was disconnected (sleep, network blip, server restart) instead of
// silently going stale until a manual reload.
export function useWebSocket(
  url: string,
  onMessage: (message: WsMessage) => void,
  onReconnect?: () => void,
) {
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const hasConnectedBeforeRef = useRef(false);

  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;
  const onReconnectRef = useRef(onReconnect);
  onReconnectRef.current = onReconnect;

  const connect = useCallback(() => {
    try {
      const ws = new WebSocket(url);

      ws.onopen = () => {
        console.log("[ws] Connected");
        setIsConnected(true);
        if (hasConnectedBeforeRef.current) {
          onReconnectRef.current?.();
        }
        hasConnectedBeforeRef.current = true;
      };

      ws.onclose = () => {
        console.log("[ws] Disconnected, reconnecting in 3s...");
        setIsConnected(false);
        reconnectTimeoutRef.current = setTimeout(connect, 3000);
      };

      ws.onerror = (err) => {
        console.error("[ws] Error:", err);
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as WsMessage;
          onMessageRef.current(message);
        } catch {
          // Ignore non-JSON messages (like pong)
        }
      };

      wsRef.current = ws;
    } catch (err) {
      console.error("[ws] Failed to connect:", err);
      reconnectTimeoutRef.current = setTimeout(connect, 3000);
    }
  }, [url]);

  useEffect(() => {
    connect();

    // Keepalive ping every 30s
    const pingInterval = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send("ping");
      }
    }, 30000);

    return () => {
      clearInterval(pingInterval);
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      wsRef.current?.close();
    };
  }, [connect]);

  return { isConnected };
}
