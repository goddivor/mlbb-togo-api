import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import { serializeUserCard } from '../users/users.service';
import { ChatGateway } from './chat.gateway';
import { PushService } from '../push/push.service';
import {
  DEFAULT_NOTIFICATIONS_LIMIT,
  NotificationsQueryDto,
} from './dto/notifications-query.dto';
import { ROOM_KINDS } from './rooms.util';

const REQUEST_STATUS = ['pending', 'in_review', 'approved', 'rejected'];

/**
 * Prisma filter for a message that has not been read yet. On MongoDB
 * `readAt: null` only matches an explicit null, not a missing field (which is
 * how `message.create` stores an unset optional), so both cases are covered.
 */
export const UNREAD_MESSAGE = { OR: [{ readAt: null }, { readAt: { isSet: false } }] };

// Maps a notification type to the preference category the user can toggle
// in their settings. Types without an entry are always delivered.
const NOTIF_CATEGORY: Record<string, string> = {
  friend_request: 'friends',
  friend_accept: 'friends',
  message: 'messages',
  mention: 'messages',
  team_request: 'teams',
  request_decision: 'teams',
  recruitment_application: 'teams',
  recruitment_decision: 'teams',
};

@Injectable()
export class CommunityService {
  constructor(
    private prisma: PrismaService,
    private chat: ChatGateway,
    private push: PushService,
    @Optional() private access?: AccessService,
  ) {}

  // ----- Notifications (internal helpers) -----

  /** Notification publique, utilisable par d'autres modules (esport…). */
  async notifyUser(
    userId: string,
    data: {
      type: string;
      title: string;
      message: string;
      link?: string;
      data?: Record<string, any>;
    },
  ) {
    return this.notify(userId, data);
  }

  private async notify(
    userId: string,
    data: {
      type: string;
      title: string;
      message: string;
      link?: string;
      data?: Record<string, any>;
    },
  ) {
    // Honor the recipient's notification preferences (a category set to false
    // silences that kind of notification). Unknown categories are allowed.
    const category = NOTIF_CATEGORY[data.type];
    if (category) {
      const recipient = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { notifPrefs: true },
      });
      const prefs = (recipient?.notifPrefs as Record<string, boolean>) ?? {};
      if (prefs[category] === false) return null;
    }

    const notification = await this.prisma.notification.create({
      data: {
        userId,
        type: data.type,
        title: data.title,
        message: data.message,
        data: data.data ?? undefined,
        link: data.link ?? null,
        read: false,
      },
    });
    this.chat.emitToUser(userId, 'notification:new', notification);
    // Fire a Web Push so the user is notified even when the app is closed.
    void this.push.sendToUser(userId, {
      title: data.title,
      body: data.message,
      link: data.link ?? '/dashboard',
    });
    return notification;
  }

  private emitMessage(participantIds: string[], threadId: string, message: any) {
    const payload = {
      threadId,
      message: {
        id: message.id,
        body: message.body,
        senderId: message.senderId,
        readAt: message.readAt ?? null,
        createdAt: message.createdAt,
      },
    };
    for (const pid of participantIds)
      this.chat.emitToUser(pid, 'message:new', payload);
  }

  private async notifyAdmins(data: {
    type: string;
    title: string;
    message: string;
    link?: string;
    data?: Record<string, any>;
  }) {
    const adminIds = (await this.access?.userIdsWithPermission('admin.requests')) ?? [];
    await Promise.all(adminIds.map((id) => this.notify(id, data)));
  }

  // ----- Notifications (API) -----

  /**
   * Paginated history for the signed-in user.
   *
   * `userId` is never taken from the query string: it comes from the JWT, so a
   * user can only ever page through their own mailbox. The `counts` facet is
   * computed over the whole mailbox (type filter excluded) so the filter chips
   * keep showing every available type once one of them is selected.
   */
  async listNotifications(userId: string, query: NotificationsQueryDto = {}) {
    const page = query.page ?? 1;
    const limit = query.limit ?? DEFAULT_NOTIFICATIONS_LIMIT;
    const status = query.status ?? 'all';

    const where: Record<string, any> = { userId };
    if (query.type) where.type = query.type;
    if (status === 'unread') where.read = false;
    if (status === 'read') where.read = true;

    const [total, items, unread, grouped] = await Promise.all([
      this.prisma.notification.count({ where }),
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.notification.count({ where: { userId, read: false } }),
      this.prisma.notification.groupBy({
        by: ['type'],
        where: { userId },
        _count: { _all: true },
      }),
    ]);

    const counts: Record<string, number> = {};
    for (const g of grouped) counts[g.type] = g._count._all;

    return {
      items,
      total,
      unread,
      counts,
      page,
      limit,
      // Always at least 1 so the pager has a page to sit on when empty.
      pages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  async unreadCount(userId: string) {
    const count = await this.prisma.notification.count({
      where: { userId, read: false },
    });
    return { count };
  }

  async markRead(userId: string, id: string) {
    // updateMany (not update) so an id belonging to somebody else simply
    // matches nothing instead of flipping their notification.
    const { count } = await this.prisma.notification.updateMany({
      where: { id, userId },
      data: { read: true },
    });
    return { ok: true, updated: count };
  }

  /**
   * Marks the user's unread notifications as read. An optional type narrows it
   * to the category currently displayed on the page, so "mark all as read"
   * never silently clears notifications the user cannot see.
   */
  async markAllRead(userId: string, type?: string) {
    const where: Record<string, any> = { userId, read: false };
    if (type) where.type = type;
    const { count } = await this.prisma.notification.updateMany({
      where,
      data: { read: true },
    });
    return { ok: true, updated: count };
  }

  // ----- Team requests -----

  private async withRequester(request: any) {
    if (!request) return request;
    const user = await this.prisma.user.findUnique({
      where: { id: request.requesterId },
    });
    return { ...request, requester: user ? serializeUserCard(user) : null };
  }

  async createTeamRequest(userId: string, data: any) {
    if (!data?.proposedName?.trim())
      throw new BadRequestException("Le nom de l'équipe proposée est requis.");
    const request = await this.prisma.teamRequest.create({
      data: {
        requesterId: userId,
        proposedName: data.proposedName.trim(),
        message: data.message?.trim() || null,
      },
    });
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const who = user ? serializeUserCard(user).displayName || user.username : 'Un joueur';
    await this.notifyAdmins({
      type: 'team_request',
      title: "Nouvelle demande d'équipe",
      message: `${who} propose l'équipe « ${request.proposedName} ».`,
      link: '/admin/requests',
      data: { who, teamName: request.proposedName },
    });
    return request;
  }

  async myTeamRequests(userId: string) {
    return this.prisma.teamRequest.findMany({
      where: { requesterId: userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listTeamRequests(status?: string) {
    const where: any = {};
    if (status) where.status = status;
    const requests = await this.prisma.teamRequest.findMany({
      where,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    });
    return Promise.all(requests.map((r) => this.withRequester(r)));
  }

  async getTeamRequest(id: string) {
    const request = await this.prisma.teamRequest.findUnique({ where: { id } });
    if (!request) throw new NotFoundException('Demande introuvable.');
    return this.withRequester(request);
  }

  async setTeamRequestStatus(id: string, status: string) {
    if (!REQUEST_STATUS.includes(status))
      throw new BadRequestException('Statut invalide.');
    const request = await this.prisma.teamRequest.findUnique({ where: { id } });
    if (!request) throw new NotFoundException('Demande introuvable.');
    const updated = await this.prisma.teamRequest.update({
      where: { id },
      data: { status },
    });
    const titles: Record<string, string> = {
      in_review: 'Votre demande est en cours d’examen',
      approved: 'Votre demande a été acceptée',
      rejected: 'Votre demande a été refusée',
      pending: 'Votre demande est en attente',
    };
    await this.notify(request.requesterId, {
      type: 'request_decision',
      title: titles[status] ?? 'Mise à jour de votre demande',
      message: `Équipe « ${request.proposedName} ».`,
      link: '/messages',
      data: { status, teamName: request.proposedName },
    });
    return this.withRequester(updated);
  }

  // ----- Messages -----

  private async participantsMap(ids: string[]) {
    const users = await this.prisma.user.findMany({
      where: { id: { in: Array.from(new Set(ids)) } },
    });
    return new Map(users.map((u) => [u.id, serializeUserCard(u)]));
  }

  async startThread(fromUserId: string, data: any) {
    if (!data?.userId) throw new BadRequestException('Destinataire requis.');
    if (!data?.body?.trim())
      throw new BadRequestException('Le message ne peut pas être vide.');
    if (data.userId === fromUserId)
      throw new BadRequestException('Destinataire invalide.');
    const target = await this.prisma.user.findUnique({ where: { id: data.userId } });
    if (!target) throw new NotFoundException('Destinataire introuvable.');

    const thread = await this.prisma.messageThread.create({
      data: {
        subject: data.subject?.trim() || null,
        requestId: data.requestId || null,
        participantIds: [fromUserId, data.userId],
        lastMessageAt: new Date(),
      },
    });
    const created = await this.prisma.message.create({
      data: { threadId: thread.id, senderId: fromUserId, body: data.body.trim() },
    });
    this.emitMessage([fromUserId, data.userId], thread.id, created);
    await this.notify(data.userId, {
      type: 'message',
      title: 'Nouveau message',
      message: data.body.trim().slice(0, 120),
      link: '/messages',
    });
    return this.getThread(fromUserId, thread.id);
  }

  async listThreads(userId: string) {
    // Group rooms (team / tournament) live in the same collection but are
    // listed by RoomsService; keep this list to 1-1 conversations only.
    const threads = await this.prisma.messageThread.findMany({
      where: {
        participantIds: { has: userId },
        NOT: { kind: { in: [...ROOM_KINDS] } },
      },
      orderBy: { lastMessageAt: 'desc' },
    });
    const otherIds = threads.map(
      (th) => th.participantIds.find((p) => p !== userId) as string,
    );
    const pmap = await this.participantsMap(otherIds.filter(Boolean));
    const result = [];
    for (const th of threads) {
      const otherId = th.participantIds.find((p) => p !== userId);
      const [last, unread] = await Promise.all([
        this.prisma.message.findFirst({
          where: { threadId: th.id },
          orderBy: { createdAt: 'desc' },
        }),
        this.prisma.message.count({
          where: { threadId: th.id, senderId: { not: userId }, ...UNREAD_MESSAGE },
        }),
      ]);
      result.push({
        id: th.id,
        subject: th.subject,
        requestId: th.requestId,
        lastMessageAt: th.lastMessageAt,
        unread,
        other: otherId ? pmap.get(otherId) ?? null : null,
        lastMessage: last ? { body: last.body, senderId: last.senderId, createdAt: last.createdAt } : null,
      });
    }
    return result;
  }

  async getThread(userId: string, id: string) {
    const thread = await this.prisma.messageThread.findUnique({ where: { id } });
    if (!thread) throw new NotFoundException('Conversation introuvable.');
    if (!thread.participantIds.includes(userId))
      throw new ForbiddenException('Accès refusé à cette conversation.');
    const messages = await this.prisma.message.findMany({
      where: { threadId: id },
      orderBy: { createdAt: 'asc' },
    });
    const pmap = await this.participantsMap(thread.participantIds);
    const otherId = thread.participantIds.find((p) => p !== userId);
    return {
      id: thread.id,
      subject: thread.subject,
      requestId: thread.requestId,
      other: otherId ? pmap.get(otherId) ?? null : null,
      messages: messages.map((m) => ({
        id: m.id,
        body: m.body,
        senderId: m.senderId,
        mine: m.senderId === userId,
        readAt: m.readAt,
        createdAt: m.createdAt,
      })),
    };
  }

  /** Mark every message in the thread not authored by `userId` as read, and
   *  tell the other participant(s) so their sent messages show read receipts. */
  async markThreadRead(userId: string, threadId: string) {
    const thread = await this.prisma.messageThread.findUnique({
      where: { id: threadId },
    });
    if (!thread) throw new NotFoundException('Conversation introuvable.');
    if (!thread.participantIds.includes(userId))
      throw new ForbiddenException('Accès refusé à cette conversation.');
    const readAt = new Date();
    const res = await this.prisma.message.updateMany({
      where: { threadId, senderId: { not: userId }, ...UNREAD_MESSAGE },
      data: { readAt },
    });
    if (res.count > 0) {
      for (const pid of thread.participantIds.filter((p) => p !== userId))
        this.chat.emitToUser(pid, 'message:read', { threadId, readerId: userId, readAt });
    }
    return { ok: true, read: res.count };
  }

  async reply(userId: string, threadId: string, body: string) {
    if (!body?.trim())
      throw new BadRequestException('Le message ne peut pas être vide.');
    const thread = await this.prisma.messageThread.findUnique({
      where: { id: threadId },
    });
    if (!thread) throw new NotFoundException('Conversation introuvable.');
    if (!thread.participantIds.includes(userId))
      throw new ForbiddenException('Accès refusé à cette conversation.');
    const created = await this.prisma.message.create({
      data: { threadId, senderId: userId, body: body.trim() },
    });
    await this.prisma.messageThread.update({
      where: { id: threadId },
      data: { lastMessageAt: new Date() },
    });
    this.emitMessage(thread.participantIds, threadId, created);
    const otherId = thread.participantIds.find((p) => p !== userId);
    if (otherId)
      await this.notify(otherId, {
        type: 'message',
        title: 'Nouveau message',
        message: body.trim().slice(0, 120),
        link: '/messages',
      });
    return this.getThread(userId, threadId);
  }
}
