import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';

@WebSocketGateway({ cors: { origin: true, credentials: true } })
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;

  // userId -> set of socket ids (supports multiple tabs/devices)
  private sockets = new Map<string, Set<string>>();

  constructor(private readonly jwt: JwtService) {}

  private extractUserId(client: Socket): string | null {
    const token =
      (client.handshake.auth as any)?.token ||
      (client.handshake.query as any)?.token;
    if (!token || typeof token !== 'string') return null;
    try {
      const payload: any = this.jwt.verify(token);
      return payload?.sub || null;
    } catch {
      return null;
    }
  }

  handleConnection(client: Socket) {
    const userId = this.extractUserId(client);
    if (!userId) {
      client.disconnect();
      return;
    }
    (client.data as any).userId = userId;
    if (!this.sockets.has(userId)) this.sockets.set(userId, new Set());
    const set = this.sockets.get(userId)!;
    const wasOffline = set.size === 0;
    set.add(client.id);
    client.join(`user:${userId}`);

    // Give the freshly connected client the current presence snapshot.
    client.emit('presence:state', { online: this.onlineIds() });
    if (wasOffline) {
      this.server.emit('presence:update', { userId, online: true });
    }
  }

  handleDisconnect(client: Socket) {
    const userId = (client.data as any)?.userId;
    if (!userId) return;
    const set = this.sockets.get(userId);
    if (!set) return;
    set.delete(client.id);
    if (set.size === 0) {
      this.sockets.delete(userId);
      this.server.emit('presence:update', { userId, online: false });
    }
  }

  onlineIds(): string[] {
    return Array.from(this.sockets.keys());
  }

  isOnline(userId: string): boolean {
    return this.sockets.has(userId);
  }

  emitToUser(userId: string, event: string, payload: any) {
    this.server?.to(`user:${userId}`).emit(event, payload);
  }
}
