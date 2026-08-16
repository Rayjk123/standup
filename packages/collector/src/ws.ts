import type { WsMessage } from "@standup/shared";

type WsClient = {
  send: (data: string) => void;
  readyState: number;
};

const clients = new Set<WsClient>();

export function createWsServer(port: number): (message: WsMessage) => void {
  Bun.serve({
    port,
    fetch(req, server) {
      // Upgrade HTTP request to WebSocket
      if (server.upgrade(req)) {
        return;
      }
      return new Response("WebSocket upgrade required", { status: 426 });
    },
    websocket: {
      open(ws) {
        clients.add(ws as unknown as WsClient);
        console.log(`[ws] Client connected (${clients.size} total)`);
      },
      close(ws) {
        clients.delete(ws as unknown as WsClient);
        console.log(`[ws] Client disconnected (${clients.size} total)`);
      },
      message(ws, message) {
        // Handle ping/pong for keepalive
        if (message === "ping") {
          ws.send("pong");
        }
      },
    },
  });

  // Return broadcast function
  return function broadcast(message: WsMessage): void {
    const data = JSON.stringify(message);
    for (const client of clients) {
      try {
        if (client.readyState === 1) {
          // OPEN
          client.send(data);
        }
      } catch {
        clients.delete(client);
      }
    }
  };
}
