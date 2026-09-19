import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { threadRoom } from './rooms.util';

/**
 * Callbacks provided by the rooms service so the gateway can resolve group
 * chat membership without a circular dependency on the service.
 */
export interface RoomsResolver {
  /** Thread ids of every group room the user belongs to. */
  roomsOf(userId: string): Promise<string[]>;
  /** Whether the user may join a given thread room. */
  canJoin(userId: string, threadId: string): Promise<boolean>;
}

@WebSocketGateway({ cors: { origin: true, credentials: true } })
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;

  // userId -> set of socket ids (supports multiple tabs/devices)
  private sockets = new Map<string, Set<string>>();
  private rooms: RoomsResolver | null = null;

  constructor(private readonly jwt: JwtService) {}

  setRoomsResolver(resolver: RoomsResolver) {
    this.rooms = resolver;
  }

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

    // Join the socket.io room of every group chat the user belongs to so
    // typing indicators reach them without an explicit subscription.
    void this.rooms
      ?.roomsOf(userId)
      .then((ids) => {
        for (const id of ids) client.join(threadRoom(id));
      })
      .catch(() => undefined);
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

  /** Explicit subscription to a room (e.g. a thread created after connect). */
  @SubscribeMessage('room:join')
  async onRoomJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { threadId?: string },
  ) {
    const userId = (client.data as any)?.userId as string | undefined;
    const threadId = body?.threadId;
    if (!userId || !threadId || !this.rooms) return { ok: false };
    const allowed = await this.rooms.canJoin(userId, threadId).catch(() => false);
    if (!allowed) return { ok: false };
    client.join(threadRoom(threadId));
    return { ok: true };
  }

  /** Typing indicator, relayed to the other members of a joined room only. */
  @SubscribeMessage('room:typing')
  onRoomTyping(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { threadId?: string; typing?: boolean },
  ) {
    const userId = (client.data as any)?.userId as string | undefined;
    const threadId = body?.threadId;
    if (!userId || !threadId) return;
    const room = threadRoom(threadId);
    // Membership was checked when the socket joined the room.
    if (!client.rooms.has(room)) return;
    client.to(room).emit('room:typing', {
      threadId,
      userId,
      typing: body?.typing !== false,
    });
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

  emitToRoom(threadId: string, event: string, payload: any) {
    this.server?.to(threadRoom(threadId)).emit(event, payload);
  }

  /** Make every connected socket of a user join a thread room. */
  joinUserToRoom(userId: string, threadId: string) {
    this.server?.in(`user:${userId}`).socketsJoin(threadRoom(threadId));
  }
}
