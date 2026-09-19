import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { RoomsService } from './rooms.service';
import { PrismaService } from '../prisma/prisma.service';
import { ChatGateway } from './chat.gateway';
import { CommunityService } from './community.service';

const TEAM = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const TOURNAMENT = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const DRAFT = 'cccccccccccccccccccccccc';
const DRAFT_TEAM = 'dddddddddddddddddddddddd';
const THREAD = 'eeeeeeeeeeeeeeeeeeeeeeee';

const user = (id: string, username: string) => ({
  id,
  username,
  email: `${username}@x.tg`,
  avatar: null,
  roleUser: 'user',
  country: 'Togo',
  wins: 0,
  losses: 0,
  gameStats: '{}',
  gameFrequentHeroes: '[]',
  gameRoles: '[]',
  gameSeasons: '[]',
  favoriteHeroes: '[]',
  badges: '[]',
  profileSource: 'game',
});

function makePrisma() {
  return {
    esportTeam: { findUnique: jest.fn() },
    esportTeamMember: { findMany: jest.fn().mockResolvedValue([]) },
    tournament: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    draftTournament: { findUnique: jest.fn() },
    draftRegistration: { findMany: jest.fn().mockResolvedValue([]) },
    draftTeam: { findUnique: jest.fn() },
    draftTeamMember: { findMany: jest.fn().mockResolvedValue([]) },
    messageThread: {
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    message: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(),
    },
    threadRead: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
    },
    user: { findMany: jest.fn().mockResolvedValue([]) },
  };
}

describe('RoomsService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let chat: { setRoomsResolver: jest.Mock; emitToUser: jest.Mock; joinUserToRoom: jest.Mock };
  let community: { notifyUser: jest.Mock };
  let service: RoomsService;

  beforeEach(() => {
    prisma = makePrisma();
    chat = { setRoomsResolver: jest.fn(), emitToUser: jest.fn(), joinUserToRoom: jest.fn() };
    community = { notifyUser: jest.fn().mockResolvedValue(null) };
    service = new RoomsService(
      prisma as unknown as PrismaService,
      chat as unknown as ChatGateway,
      community as unknown as CommunityService,
    );
  });

  it('registers itself as the gateway rooms resolver', () => {
    expect(chat.setRoomsResolver).toHaveBeenCalledTimes(1);
  });

  describe('resolveScope', () => {
    it('derives team membership from the esport roster', async () => {
      prisma.esportTeam.findUnique.mockResolvedValue({
        id: TEAM,
        name: 'Lions',
        image: 'lions.png',
        members: [{ userId: 'u1' }, { userId: 'u2' }, { userId: 'u1' }],
      });
      const scope = await service.resolveScope('team', TEAM);
      expect(scope).toEqual({
        kind: 'team',
        scopeId: TEAM,
        title: 'Lions',
        avatar: 'lions.png',
        memberIds: ['u1', 'u2'],
      });
    });

    it('derives tournament membership from the registered teams rosters', async () => {
      prisma.tournament.findUnique.mockResolvedValue({
        id: TOURNAMENT,
        name: 'Cup',
        banner: null,
        registeredTeams: JSON.stringify([{ id: TEAM }, { id: 'other' }]),
      });
      prisma.esportTeamMember.findMany.mockResolvedValue([{ userId: 'u1' }, { userId: 'u3' }]);
      const scope = await service.resolveScope('tournament', TOURNAMENT);
      expect(prisma.esportTeamMember.findMany).toHaveBeenCalledWith({
        where: { teamId: { in: [TEAM, 'other'] } },
        select: { userId: true },
      });
      expect(scope?.memberIds).toEqual(['u1', 'u3']);
      expect(scope?.title).toBe('Cup');
    });

    it('falls back to draft tournament registrations', async () => {
      prisma.tournament.findUnique.mockResolvedValue(null);
      prisma.draftTournament.findUnique.mockResolvedValue({ id: DRAFT, name: 'Draft 5v5' });
      prisma.draftRegistration.findMany.mockResolvedValue([{ userId: 'u5' }]);
      const scope = await service.resolveScope('tournament', DRAFT);
      expect(scope).toMatchObject({ kind: 'tournament', title: 'Draft 5v5', memberIds: ['u5'] });
    });

    it('derives draft team membership from the drafted roster', async () => {
      prisma.draftTeam.findUnique.mockResolvedValue({ id: DRAFT_TEAM, name: 'Team A', icon: '' });
      prisma.draftTeamMember.findMany.mockResolvedValue([{ userId: 'u7' }]);
      const scope = await service.resolveScope('draft_team', DRAFT_TEAM);
      expect(scope).toMatchObject({ title: 'Team A', avatar: null, memberIds: ['u7'] });
    });

    it('returns null for an unknown scope and caches lookups', async () => {
      prisma.esportTeam.findUnique.mockResolvedValue(null);
      expect(await service.resolveScope('team', TEAM)).toBeNull();
      expect(await service.resolveScope('team', TEAM)).toBeNull();
      expect(prisma.esportTeam.findUnique).toHaveBeenCalledTimes(1);
      service.invalidateScope('team', TEAM);
      await service.resolveScope('team', TEAM);
      expect(prisma.esportTeam.findUnique).toHaveBeenCalledTimes(2);
    });

    it('rejects invalid kinds and ids', async () => {
      await expect(service.resolveScope('direct', TEAM)).rejects.toThrow('Type de salon invalide.');
      await expect(service.resolveScope('team', 'nope')).rejects.toThrow(
        'Identifiant de salon invalide.',
      );
    });
  });

  describe('getRoom / membership', () => {
    beforeEach(() => {
      prisma.esportTeam.findUnique.mockResolvedValue({
        id: TEAM,
        name: 'Lions',
        image: null,
        members: [{ userId: 'u1' }],
      });
    });

    it('refuses a non-member', async () => {
      await expect(service.getRoom('stranger', 'team', TEAM)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('404s on an unknown scope', async () => {
      prisma.esportTeam.findUnique.mockResolvedValue(null);
      await expect(service.getRoom('u1', 'team', TEAM)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('lazily creates the thread and pages messages newest-first', async () => {
      prisma.messageThread.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: THREAD, kind: 'team', scopeId: TEAM });
      prisma.messageThread.create.mockResolvedValue({
        id: THREAD,
        kind: 'team',
        scopeId: TEAM,
        title: 'Lions',
        avatar: null,
      });
      const msgs = [3, 2, 1].map((n) => ({
        id: `m${n}`,
        threadId: THREAD,
        senderId: n === 1 ? 'u1' : 'u9',
        body: `msg ${n}`,
        createdAt: new Date(n * 1000),
      }));
      prisma.message.findMany.mockResolvedValue(msgs);
      prisma.user.findMany.mockResolvedValue([user('u1', 'alpha')]);

      const room = await service.getRoom('u1', 'team', TEAM, { limit: 2 });

      expect(prisma.messageThread.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ kind: 'team', scopeId: TEAM, participantIds: [] }),
      });
      expect(prisma.message.findMany).toHaveBeenCalledWith({
        where: { threadId: THREAD },
        orderBy: { createdAt: 'desc' },
        take: 3,
      });
      expect(room.hasMore).toBe(true);
      expect(room.messages.map((m) => m.id)).toEqual(['m2', 'm3']);
      expect(room.thread).toMatchObject({ id: THREAD, title: 'Lions', memberCount: 1 });
      expect(room.members).toHaveLength(1);
    });

    it('applies the "before" cursor when loading older messages', async () => {
      prisma.messageThread.findFirst.mockResolvedValue({
        id: THREAD,
        title: 'Lions',
        avatar: null,
      });
      await service.getRoom('u1', 'team', TEAM, { before: '2024-01-01T00:00:00.000Z' });
      expect(prisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { threadId: THREAD, createdAt: { lt: new Date('2024-01-01T00:00:00.000Z') } },
        }),
      );
    });
  });

  describe('postMessage', () => {
    beforeEach(() => {
      prisma.esportTeam.findUnique.mockResolvedValue({
        id: TEAM,
        name: 'Lions',
        image: null,
        members: [{ userId: 'u1' }, { userId: 'u2' }, { userId: 'u3' }],
      });
      prisma.messageThread.findFirst.mockResolvedValue({ id: THREAD, title: 'Lions', avatar: null });
      prisma.user.findMany.mockResolvedValue([
        user('u1', 'alpha'),
        user('u2', 'beta'),
        user('u3', 'gamma'),
      ]);
      prisma.message.create.mockImplementation(({ data }: any) =>
        Promise.resolve({ id: 'm1', createdAt: new Date(5000), ...data }),
      );
    });

    it('rejects empty bodies', async () => {
      await expect(service.postMessage('u1', 'team', TEAM, '   ')).rejects.toThrow(
        'Le message ne peut pas être vide.',
      );
    });

    it('stores the message, moves the author cursor and fans out to members', async () => {
      const res = await service.postMessage('u1', 'team', TEAM, ' hello ');
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: { threadId: THREAD, senderId: 'u1', body: 'hello' },
      });
      expect(prisma.threadRead.upsert).toHaveBeenCalledWith({
        where: { threadId_userId: { threadId: THREAD, userId: 'u1' } },
        create: { threadId: THREAD, userId: 'u1', lastReadAt: new Date(5000) },
        update: { lastReadAt: new Date(5000) },
      });
      expect(chat.emitToUser).toHaveBeenCalledTimes(3);
      expect(chat.emitToUser).toHaveBeenCalledWith(
        'u2',
        'message:new',
        expect.objectContaining({ threadId: THREAD, kind: 'team', scopeId: TEAM }),
      );
      expect(res.message).toMatchObject({ id: 'm1', body: 'hello', mine: true });
      expect(community.notifyUser).not.toHaveBeenCalled();
    });

    it('notifies mentioned members but never the author', async () => {
      await service.postMessage('u1', 'team', TEAM, '@beta @alpha @nobody go');
      expect(community.notifyUser).toHaveBeenCalledTimes(1);
      expect(community.notifyUser).toHaveBeenCalledWith(
        'u2',
        expect.objectContaining({
          type: 'mention',
          link: `/messages?room=team:${TEAM}`,
        }),
      );
    });
  });

  describe('read cursors', () => {
    beforeEach(() => {
      prisma.esportTeam.findUnique.mockResolvedValue({
        id: TEAM,
        name: 'Lions',
        image: null,
        members: [{ userId: 'u1' }],
      });
      prisma.messageThread.findFirst.mockResolvedValue({ id: THREAD, title: 'Lions', avatar: null });
    });

    it('markRead upserts the cursor', async () => {
      const res = await service.markRead('u1', 'team', TEAM);
      expect(res.ok).toBe(true);
      expect(prisma.threadRead.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { threadId_userId: { threadId: THREAD, userId: 'u1' } } }),
      );
    });

    it('listRooms counts foreign messages newer than the cursor', async () => {
      prisma.esportTeamMember.findMany.mockResolvedValue([{ teamId: TEAM }]);
      prisma.threadRead.findUnique.mockResolvedValue({ lastReadAt: new Date(2000) });
      prisma.message.count.mockResolvedValue(4);
      prisma.message.findFirst.mockResolvedValue({
        body: 'last',
        senderId: 'u9',
        createdAt: new Date(9000),
      });

      const rooms = await service.listRooms('u1');

      expect(prisma.message.count).toHaveBeenCalledWith({
        where: { threadId: THREAD, senderId: { not: 'u1' }, createdAt: { gt: new Date(2000) } },
      });
      expect(rooms).toHaveLength(1);
      expect(rooms[0]).toMatchObject({ kind: 'team', scopeId: TEAM, unread: 4, memberCount: 1 });
      expect(rooms[0].lastMessage?.body).toBe('last');
    });

    it('listRooms counts everything when the user never opened the room', async () => {
      prisma.esportTeamMember.findMany.mockResolvedValue([{ teamId: TEAM }]);
      await service.listRooms('u1');
      expect(prisma.message.count).toHaveBeenCalledWith({
        where: { threadId: THREAD, senderId: { not: 'u1' } },
      });
    });
  });

  describe('scopesOf', () => {
    it('lists teams, registered tournaments, draft registrations and drafted teams', async () => {
      prisma.esportTeamMember.findMany.mockImplementation(({ where }: any) =>
        Promise.resolve(where.userId ? [{ teamId: TEAM }] : [{ userId: 'u1' }]),
      );
      prisma.esportTeam.findUnique.mockResolvedValue({
        id: TEAM,
        name: 'Lions',
        image: null,
        members: [{ userId: 'u1' }],
      });
      prisma.tournament.findMany.mockResolvedValue([
        { id: TOURNAMENT, registeredTeams: JSON.stringify([{ id: TEAM }]) },
        { id: 'ffffffffffffffffffffffff', registeredTeams: '[]' },
      ]);
      prisma.tournament.findUnique.mockImplementation(({ where }: any) =>
        Promise.resolve(
          where.id === TOURNAMENT
            ? { id: TOURNAMENT, name: 'Cup', banner: null, registeredTeams: JSON.stringify([{ id: TEAM }]) }
            : null,
        ),
      );
      prisma.draftRegistration.findMany.mockImplementation(({ where }: any) =>
        Promise.resolve(where.userId ? [{ tournamentId: DRAFT }] : [{ userId: 'u1' }]),
      );
      prisma.draftTournament.findUnique.mockResolvedValue({ id: DRAFT, name: 'Draft' });
      prisma.draftTeamMember.findMany.mockImplementation(({ where }: any) =>
        Promise.resolve(where.userId ? [{ teamId: DRAFT_TEAM }] : [{ userId: 'u1' }]),
      );
      prisma.draftTeam.findUnique.mockResolvedValue({ id: DRAFT_TEAM, name: 'Drafted', icon: '' });

      const scopes = await service.scopesOf('u1');
      expect(scopes.map((s) => `${s.kind}:${s.scopeId}`)).toEqual([
        `team:${TEAM}`,
        `tournament:${TOURNAMENT}`,
        `tournament:${DRAFT}`,
        `draft_team:${DRAFT_TEAM}`,
      ]);
    });
  });

  describe('canAccessThread', () => {
    it('checks participants for direct threads and membership for rooms', async () => {
      prisma.messageThread.findUnique.mockResolvedValueOnce({
        kind: 'direct',
        scopeId: null,
        participantIds: ['u1', 'u2'],
      });
      expect(await service.canAccessThread('u1', THREAD)).toBe(true);
      prisma.messageThread.findUnique.mockResolvedValueOnce({
        kind: 'team',
        scopeId: TEAM,
        participantIds: [],
      });
      prisma.esportTeam.findUnique.mockResolvedValue({
        id: TEAM,
        name: 'Lions',
        image: null,
        members: [{ userId: 'u2' }],
      });
      expect(await service.canAccessThread('u1', THREAD)).toBe(false);
      expect(await service.canAccessThread('u1', 'bad')).toBe(false);
    });
  });
});
