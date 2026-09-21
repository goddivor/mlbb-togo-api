import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { serializeUserCard } from '../users/users.service';
import { ChatGateway } from './chat.gateway';
import { CommunityService, UNREAD_MESSAGE } from './community.service';
import {
  isRoomKind,
  parseMentions,
  RoomKind,
  ROOM_KINDS,
  TtlCache,
} from './rooms.util';

/** A group chat scope (esport team, tournament, draft team) and its members. */
export interface RoomScope {
  kind: RoomKind;
  scopeId: string;
  title: string;
  avatar: string | null;
  memberIds: string[];
}

const DEFAULT_PAGE = 40;
const MAX_PAGE = 100;
const MEMBERSHIP_TTL_MS = 15_000;
const OBJECT_ID = /^[a-f\d]{24}$/i;

const parseJson = <T>(raw: unknown, fallback: T): T => {
  if (typeof raw !== 'string') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

const uniq = (ids: string[]) => Array.from(new Set(ids.filter(Boolean)));

/**
 * Group chat rooms. Membership is never stored: it is derived from the
 * current roster / registrations each time (memoised for a few seconds), so
 * a player who leaves a team immediately loses access to its room.
 */
@Injectable()
export class RoomsService {
  private scopes = new TtlCache<RoomScope | null>(MEMBERSHIP_TTL_MS);

  constructor(
    private prisma: PrismaService,
    private chat: ChatGateway,
    private community: CommunityService,
  ) {
    this.chat.setRoomsResolver({
      roomsOf: (userId) => this.threadIdsOf(userId),
      canJoin: (userId, threadId) => this.canAccessThread(userId, threadId),
    });
  }

  // ----- Scope resolution -----

  private cacheKey(kind: string, scopeId: string) {
    return `${kind}:${scopeId}`;
  }

  /** Resolve (with a short cache) the scope behind a room, or null. */
  async resolveScope(kind: string, scopeId: string): Promise<RoomScope | null> {
    if (!isRoomKind(kind)) throw new BadRequestException('Type de salon invalide.');
    if (!OBJECT_ID.test(scopeId || ''))
      throw new BadRequestException('Identifiant de salon invalide.');
    const key = this.cacheKey(kind, scopeId);
    const cached = this.scopes.get(key);
    if (cached !== undefined) return cached;
    const scope = await this.loadScope(kind, scopeId);
    this.scopes.set(key, scope);
    return scope;
  }

  /** Forget a cached scope (e.g. after a roster change). */
  invalidateScope(kind: string, scopeId: string) {
    this.scopes.delete(this.cacheKey(kind, scopeId));
  }

  private async loadScope(kind: RoomKind, scopeId: string): Promise<RoomScope | null> {
    if (kind === 'team') {
      const team = await this.prisma.esportTeam.findUnique({
        where: { id: scopeId },
        include: { members: { select: { userId: true } } },
      });
      if (!team) return null;
      return {
        kind,
        scopeId,
        title: team.name,
        avatar: team.image ?? null,
        memberIds: uniq(team.members.map((m) => m.userId)),
      };
    }
    if (kind === 'draft_team') {
      const team = await this.prisma.draftTeam.findUnique({ where: { id: scopeId } });
      if (!team) return null;
      const members = await this.prisma.draftTeamMember.findMany({
        where: { teamId: scopeId },
        select: { userId: true },
      });
      return {
        kind,
        scopeId,
        title: team.name,
        avatar: team.icon || null,
        memberIds: uniq(members.map((m) => m.userId)),
      };
    }
    // kind === 'tournament': a classic tournament (registered esport teams)
    // or, failing that, a community draft tournament (registered players).
    const tournament = await this.prisma.tournament.findUnique({ where: { id: scopeId } });
    if (tournament) {
      const registered = parseJson<any[]>(tournament.registeredTeams, []);
      const teamIds = uniq(
        (Array.isArray(registered) ? registered : []).map((r) => r?.id).filter(
          (id) => typeof id === 'string',
        ),
      );
      const members = teamIds.length
        ? await this.prisma.esportTeamMember.findMany({
            where: { teamId: { in: teamIds } },
            select: { userId: true },
          })
        : [];
      return {
        kind,
        scopeId,
        title: tournament.name,
        avatar: tournament.banner ?? null,
        memberIds: uniq(members.map((m) => m.userId)),
      };
    }
    const draft = await this.prisma.draftTournament.findUnique({ where: { id: scopeId } });
    if (!draft) return null;
    const regs = await this.prisma.draftRegistration.findMany({
      where: { tournamentId: scopeId },
      select: { userId: true },
    });
    return {
      kind,
      scopeId,
      title: draft.name,
      avatar: null,
      memberIds: uniq(regs.map((r) => r.userId)),
    };
  }

  /** Every scope the user currently belongs to (teams, tournaments, drafts). */
  async scopesOf(userId: string): Promise<RoomScope[]> {
    const [memberships, draftRegs, draftMemberships] = await Promise.all([
      this.prisma.esportTeamMember.findMany({ where: { userId }, select: { teamId: true } }),
      this.prisma.draftRegistration.findMany({
        where: { userId },
        select: { tournamentId: true },
      }),
      this.prisma.draftTeamMember.findMany({ where: { userId }, select: { teamId: true } }),
    ]);
    const teamIds = uniq(memberships.map((m) => m.teamId));

    // Classic tournaments where one of the user's teams is registered. The
    // registration list is a JSON string, so filter in memory (few rows).
    const tournaments = teamIds.length
      ? await this.prisma.tournament.findMany({
          select: { id: true, registeredTeams: true },
        })
      : [];
    const tournamentIds = tournaments
      .filter((t) =>
        parseJson<any[]>(t.registeredTeams, []).some(
          (r) => r?.id && teamIds.includes(r.id),
        ),
      )
      .map((t) => t.id);

    const refs: { kind: RoomKind; scopeId: string }[] = [
      ...teamIds.map((scopeId) => ({ kind: 'team' as const, scopeId })),
      ...tournamentIds.map((scopeId) => ({ kind: 'tournament' as const, scopeId })),
      ...uniq(draftRegs.map((r) => r.tournamentId)).map((scopeId) => ({
        kind: 'tournament' as const,
        scopeId,
      })),
      ...uniq(draftMemberships.map((m) => m.teamId)).map((scopeId) => ({
        kind: 'draft_team' as const,
        scopeId,
      })),
    ];
    const scopes = await Promise.all(refs.map((r) => this.resolveScope(r.kind, r.scopeId)));
    return scopes.filter((s): s is RoomScope => !!s && s.memberIds.includes(userId));
  }

  // ----- Threads -----

  /** Find or lazily create the thread backing a scope. */
  private async ensureThread(scope: RoomScope) {
    const where = { kind: scope.kind, scopeId: scope.scopeId };
    let thread = await this.prisma.messageThread.findFirst({ where });
    if (!thread) {
      thread = await this.prisma.messageThread.create({
        data: {
          ...where,
          title: scope.title,
          avatar: scope.avatar,
          participantIds: [],
          lastMessageAt: new Date(0),
        },
      });
      // Two concurrent first accesses may both create a thread: keep the
      // oldest one so everybody lands in the same room.
      const first = await this.prisma.messageThread.findFirst({
        where,
        orderBy: { createdAt: 'asc' },
      });
      if (first && first.id !== thread.id) {
        await this.prisma.messageThread.delete({ where: { id: thread.id } });
        thread = first;
      }
    } else if (thread.title !== scope.title || (thread.avatar ?? null) !== scope.avatar) {
      thread = await this.prisma.messageThread.update({
        where: { id: thread.id },
        data: { title: scope.title, avatar: scope.avatar },
      });
    }
    return thread;
  }

  private async threadIdsOf(userId: string): Promise<string[]> {
    const scopes = await this.scopesOf(userId);
    const threads = await Promise.all(scopes.map((s) => this.ensureThread(s)));
    return threads.map((t) => t.id);
  }

  /** Whether the user may read a thread (direct participant or room member). */
  async canAccessThread(userId: string, threadId: string): Promise<boolean> {
    if (!OBJECT_ID.test(threadId || '')) return false;
    const thread = await this.prisma.messageThread.findUnique({ where: { id: threadId } });
    if (!thread) return false;
    if (!isRoomKind(thread.kind) || !thread.scopeId)
      return thread.participantIds.includes(userId);
    const scope = await this.resolveScope(thread.kind, thread.scopeId);
    return !!scope && scope.memberIds.includes(userId);
  }

  /** Resolve a room the user is a member of, or throw. */
  private async requireMembership(userId: string, kind: string, scopeId: string) {
    const scope = await this.resolveScope(kind, scopeId);
    if (!scope) throw new NotFoundException('Salon introuvable.');
    if (!scope.memberIds.includes(userId))
      throw new ForbiddenException('Accès refusé à ce salon.');
    return scope;
  }

  private async memberCards(ids: string[]) {
    if (!ids.length) return new Map<string, any>();
    const users = await this.prisma.user.findMany({ where: { id: { in: ids } } });
    return new Map(users.map((u) => [u.id, serializeUserCard(u)]));
  }

  private async unreadFor(userId: string, threadId: string) {
    const cursor = await this.prisma.threadRead.findUnique({
      where: { threadId_userId: { threadId, userId } },
    });
    return this.prisma.message.count({
      where: {
        threadId,
        senderId: { not: userId },
        ...(cursor ? { createdAt: { gt: cursor.lastReadAt } } : {}),
      },
    });
  }

  // ----- API -----

  /** Rooms of the user with unread counts and last message, newest first. */
  async listRooms(userId: string) {
    const scopes = await this.scopesOf(userId);
    const rooms = await Promise.all(
      scopes.map(async (scope) => {
        const thread = await this.ensureThread(scope);
        const [last, unread] = await Promise.all([
          this.prisma.message.findFirst({
            where: { threadId: thread.id },
            orderBy: { createdAt: 'desc' },
          }),
          this.unreadFor(userId, thread.id),
        ]);
        return {
          id: thread.id,
          kind: scope.kind,
          scopeId: scope.scopeId,
          title: scope.title,
          avatar: scope.avatar,
          memberCount: scope.memberIds.length,
          unread,
          lastMessageAt: last ? last.createdAt : null,
          lastMessage: last
            ? { body: last.body, senderId: last.senderId, createdAt: last.createdAt }
            : null,
        };
      }),
    );
    const senderIds = uniq(rooms.map((r) => r.lastMessage?.senderId as string));
    const cards = await this.memberCards(senderIds);
    const order = (r: any) => (r.lastMessageAt ? new Date(r.lastMessageAt).getTime() : 0);
    return rooms
      .map((r) => ({
        ...r,
        lastMessage: r.lastMessage
          ? { ...r.lastMessage, sender: cards.get(r.lastMessage.senderId) ?? null }
          : null,
      }))
      .sort((a, b) => order(b) - order(a) || a.title.localeCompare(b.title));
  }

  /** Room header + members + a page of messages (newest page by default). */
  async getRoom(
    userId: string,
    kind: string,
    scopeId: string,
    query: { before?: string; limit?: string | number } = {},
  ) {
    const scope = await this.requireMembership(userId, kind, scopeId);
    const thread = await this.ensureThread(scope);
    const limit = Math.min(
      MAX_PAGE,
      Math.max(1, Number(query.limit) || DEFAULT_PAGE),
    );
    const before = query.before ? new Date(query.before) : null;
    const where: any = { threadId: thread.id };
    if (before && !isNaN(before.getTime())) where.createdAt = { lt: before };
    const page = await this.prisma.message.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
    });
    const hasMore = page.length > limit;
    const messages = page.slice(0, limit).reverse();

    const cards = await this.memberCards(
      uniq([...scope.memberIds, ...messages.map((m) => m.senderId)]),
    );
    const cursor = await this.prisma.threadRead.findUnique({
      where: { threadId_userId: { threadId: thread.id, userId } },
    });
    return {
      thread: {
        id: thread.id,
        kind: scope.kind,
        scopeId: scope.scopeId,
        title: scope.title,
        avatar: scope.avatar,
        memberCount: scope.memberIds.length,
        lastReadAt: cursor?.lastReadAt ?? null,
      },
      members: scope.memberIds.map((id) => cards.get(id)).filter(Boolean),
      messages: messages.map((m) => this.serializeMessage(m, userId, cards)),
      hasMore,
    };
  }

  private serializeMessage(m: any, userId: string, cards: Map<string, any>) {
    return {
      id: m.id,
      body: m.body,
      senderId: m.senderId,
      mine: m.senderId === userId,
      createdAt: m.createdAt,
      sender: cards.get(m.senderId) ?? null,
    };
  }

  /** Post a message in a room; mentioned members get a notification. */
  async postMessage(userId: string, kind: string, scopeId: string, body: string) {
    const text = (body ?? '').trim();
    if (!text) throw new BadRequestException('Le message ne peut pas être vide.');
    if (text.length > 4000) throw new BadRequestException('Message trop long.');
    const scope = await this.requireMembership(userId, kind, scopeId);
    const thread = await this.ensureThread(scope);

    const created = await this.prisma.message.create({
      data: { threadId: thread.id, senderId: userId, body: text },
    });
    await Promise.all([
      this.prisma.messageThread.update({
        where: { id: thread.id },
        data: { lastMessageAt: created.createdAt },
      }),
      // The author has obviously seen their own message.
      this.setReadCursor(userId, thread.id, created.createdAt),
    ]);

    const cards = await this.memberCards(scope.memberIds);
    const sender = cards.get(userId) ?? null;
    const payload = {
      threadId: thread.id,
      kind: scope.kind,
      scopeId: scope.scopeId,
      title: scope.title,
      message: {
        id: created.id,
        body: created.body,
        senderId: created.senderId,
        createdAt: created.createdAt,
        sender,
      },
    };
    // Deliver to every member's sockets (not only to the socket.io room, so a
    // member connected before the thread was lazily created still gets it).
    for (const memberId of scope.memberIds) {
      this.chat.emitToUser(memberId, 'message:new', payload);
      this.chat.joinUserToRoom(memberId, thread.id);
    }

    const members = scope.memberIds
      .map((id) => ({ id, username: cards.get(id)?.username ?? '' }))
      .filter((m) => m.username);
    const mentioned = parseMentions(text, members).filter((id) => id !== userId);
    const who = sender?.displayName || sender?.username || 'Un membre';
    await Promise.all(
      mentioned.map((targetId) =>
        this.community.notifyUser(targetId, {
          type: 'mention',
          title: `${who} vous a mentionné dans « ${scope.title} »`,
          message: text.slice(0, 120),
          link: `/messages?room=${scope.kind}:${scope.scopeId}`,
          data: {
            who,
            room: scope.title,
            threadId: thread.id,
            kind: scope.kind,
            scopeId: scope.scopeId,
          },
        }),
      ),
    );

    return { threadId: thread.id, message: this.serializeMessage(created, userId, cards) };
  }

  private setReadCursor(userId: string, threadId: string, at: Date) {
    return this.prisma.threadRead.upsert({
      where: { threadId_userId: { threadId, userId } },
      create: { threadId, userId, lastReadAt: at },
      update: { lastReadAt: at },
    });
  }

  /** Move the user's read cursor of a room to now. */
  async markRead(userId: string, kind: string, scopeId: string) {
    const scope = await this.requireMembership(userId, kind, scopeId);
    const thread = await this.ensureThread(scope);
    const at = new Date();
    await this.setReadCursor(userId, thread.id, at);
    return { ok: true, threadId: thread.id, lastReadAt: at };
  }

  /** Unread badges: direct threads (readAt) + rooms (read cursors). */
  async unreadSummary(userId: string) {
    const directThreads = await this.prisma.messageThread.findMany({
      where: {
        participantIds: { has: userId },
        NOT: { kind: { in: [...ROOM_KINDS] } },
      },
      select: { id: true },
    });
    const direct = directThreads.length
      ? await this.prisma.message.count({
          where: {
            threadId: { in: directThreads.map((t) => t.id) },
            senderId: { not: userId },
            ...UNREAD_MESSAGE,
          },
        })
      : 0;
    const rooms = (await this.listRooms(userId)).reduce((n, r) => n + r.unread, 0);
    return { direct, rooms, total: direct + rooms };
  }
}
