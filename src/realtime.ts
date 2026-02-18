import type { Server as HttpServer } from "node:http";

import { WebSocketServer, type WebSocket } from "ws";

interface RealtimeEnvelope<T = unknown> {
  type: string;
  payload: T;
  ts: string;
}

export class RealtimeHub {
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<WebSocket>();

  constructor(server: HttpServer) {
    this.wss = new WebSocketServer({ server });
    this.wss.on("connection", (socket) => {
      this.clients.add(socket);
      socket.on("close", () => this.clients.delete(socket));
    });
  }

  broadcast<T>(type: string, payload: T): void {
    const message: RealtimeEnvelope<T> = {
      type,
      payload,
      ts: new Date().toISOString()
    };
    const serialized = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === client.OPEN) {
        client.send(serialized);
      }
    }
  }

  close(): void {
    this.wss.close();
  }
}

