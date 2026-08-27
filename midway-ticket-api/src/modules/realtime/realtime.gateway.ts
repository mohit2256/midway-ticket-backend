// ═══════════════════════════════════════════════════════════════════════════════
// REALTIME GATEWAY — WebSockets for live scanner + operator dashboard updates
//
// Transport: Socket.IO over the same HTTPS origin as the REST API (upgrades
// from HTTPS/TCP to WSS on connect — no separate port/service to run).
//
// Rooms, not broadcast-to-everyone:
//   `operator:{operatorId}`  → dashboard screens for that operator
//   `fair:{fairId}`          → scanner staff + dashboard for one active fair
// A client joins a room right after connecting (see handleJoin). This keeps
// one operator's live traffic invisible to every other operator — important
// once this scales to many tenants.
//
// This gateway only ever PUSHES events that already happened (ticket scanned,
// ride sold out). It is not the source of truth — Postgres is. If a client
// misses an event (disconnected, reconnecting), the dashboard's normal
// polling/query on reconnect fills the gap. That's what makes this safe to
// treat as "eventual consistency" rather than something requiring guaranteed
// delivery.
// ═══════════════════════════════════════════════════════════════════════════════

import {
  WebSocketGateway, WebSocketServer, SubscribeMessage,
  MessageBody, ConnectedSocket, OnGatewayConnection, OnGatewayDisconnect,
} from "@nestjs/websockets";
import { Injectable, Logger } from "@nestjs/common";
import { Server, Socket } from "socket.io";

@Injectable()
@WebSocketGateway({
  cors: { origin: true, credentials: true },
  // Namespace keeps this separate from any future socket use (e.g. chat)
  namespace: "/realtime",
})
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server: Server;

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  /** Frontend calls this right after connecting:
   *  socket.emit('join', { room: `operator:${operatorId}` })
   *  socket.emit('join', { room: `fair:${fairId}` })
   */
  @SubscribeMessage("join")
  handleJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { room: string },
  ) {
    client.join(body.room);
    return { joined: body.room };
  }

  @SubscribeMessage("leave")
  handleLeave(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { room: string },
  ) {
    client.leave(body.room);
    return { left: body.room };
  }

  // ── Emit helpers — called by other modules via RealtimeGateway injection ──

  /** Live feed for scanner + operator dashboard on a specific fair */
  emitTicketScanned(fairId: string, payload: {
    outcome: string; rideName?: string; displayId?: string; gate?: string;
  }) {
    this.server.to(`fair:${fairId}`).emit("ticket:scanned", payload);
  }

  /** Operator dashboard number tiles (revenue, tickets sold) — eventual consistency,
   *  UI just re-renders on receipt; no ack/guarantee needed. */
  emitDashboardUpdate(operatorId: string, payload: Record<string, unknown>) {
    this.server.to(`operator:${operatorId}`).emit("dashboard:update", payload);
  }

  emitRideSoldOut(fairId: string, payload: { rideId: string; rideName: string }) {
    this.server.to(`fair:${fairId}`).emit("ride:sold_out", payload);
  }
}
