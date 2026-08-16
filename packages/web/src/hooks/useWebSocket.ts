import { useState, useEffect, useRef, useCallback } from "react";
import type { WsMessage } from "@standup/shared";

export function useWebSocket(url: string) {
  const [lastMessage, setLastMessage] = useState<WsMessage | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

  const connect = useCallback(() => {
    try {
      const ws = new WebSocket(url);

      ws.onopen = () => {
        console.log("[ws] Connected");
        setIsConnected(true);
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
          setLastMessage(message);
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

  return { lastMessage, isConnected };
}
