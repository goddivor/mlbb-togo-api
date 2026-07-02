import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { serializeUserCard } from '../users/users.service';
import { ChatGateway } from './chat.gateway';

const REQUEST_STATUS = ['pending', 'in_review', 'approved', 'rejected'];

@Injectable()
export class CommunityService {
  constructor(
    private prisma: PrismaService,
    private chat: ChatGateway,
  ) {}

  // ----- Notifications (internal helpers) -----

  private async notify(
    userId: string,
    data: { type: string; title: string; message: string; link?: string },
  ) {
    const notification = await this.prisma.notification.create({
      data: {
        userId,
        type: data.type,
        title: data.title,
        message: data.message,
        link: data.link ?? null,
        read: false,
      },
    });
    this.chat.emitToUser(userId, 'notification:new', notification);
    return notification;
  }

  private emitMessage(participantIds: string[], threadId: string, message: any) {
    const payload = {
      threadId,
      message: {
        id: message.id,
        body: message.body,
        senderId: message.senderId,
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
  }) {
    const admins = await this.prisma.user.findMany({
      where: { roleUser: { in: ['admin', 'moderator'] } },
      select: { id: true },
    });
    await Promise.all(admins.map((a) => this.notify(a.id, data)));
  }

  // ----- Notifications (API) -----

  async listNotifications(userId: string) {
    return this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async unreadCount(userId: string) {
    const count = await this.prisma.notification.count({
      where: { userId, read: false },
    });
    return { count };
  }

  async markRead(userId: string, id: string) {
    await this.prisma.notification.updateMany({
      where: { id, userId },
      data: { read: true },
    });
    return { ok: true };
  }

  async markAllRead(userId: string) {
    await this.prisma.notification.updateMany({
      where: { userId, read: false },
      data: { read: true },
    });
    return { ok: true };
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
        tag: data.tag?.trim() || null,
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
    const threads = await this.prisma.messageThread.findMany({
      where: { participantIds: { has: userId } },
      orderBy: { lastMessageAt: 'desc' },
    });
    const otherIds = threads.map(
      (th) => th.participantIds.find((p) => p !== userId) as string,
    );
    const pmap = await this.participantsMap(otherIds.filter(Boolean));
    const result = [];
    for (const th of threads) {
      const otherId = th.participantIds.find((p) => p !== userId);
      const last = await this.prisma.message.findFirst({
        where: { threadId: th.id },
        orderBy: { createdAt: 'desc' },
      });
      result.push({
        id: th.id,
        subject: th.subject,
        requestId: th.requestId,
        lastMessageAt: th.lastMessageAt,
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
        createdAt: m.createdAt,
      })),
    };
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
