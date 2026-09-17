import { UsersService } from './users.service';
import { PrismaService } from '../prisma/prisma.service';

/** Minimal user row, shaped like what Prisma returns. */
const row = (over: Partial<Record<string, any>> = {}) => ({
  id: over.username ? `id-${over.username}` : 'id-x',
  username: 'x',
  email: 'x@mlbb.tg',
  password: 'hashed',
  avatar: null,
  rank: 'warrior',
  role: 'fighter',
  favoriteHeroes: '[]',
  badges: '[]',
  wins: 0,
  losses: 0,
  mvpCount: 0,
  streak: 0,
  country: 'Togo',
  city: null,
  bio: null,
  joinedAt: new Date(),
  lastActive: new Date(),
  isOnline: false,
  isBanned: false,
  roleUser: 'user',
  provider: 'local',
  googleId: null,
  mlbbRoleId: null,
  gameStats: '{}',
  gameFrequentHeroes: '[]',
  gameRoles: '[]',
  gameSeasons: '[]',
  profileSource: 'game',
  ...over,
});

describe('UsersService.leaderboard', () => {
  let service: UsersService;
  let prisma: {
    user: { findMany: jest.Mock };
    esportMatch: { findMany: jest.Mock };
    esportTeamMember: { findMany: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      user: { findMany: jest.fn() },
      esportMatch: { findMany: jest.fn() },
      esportTeamMember: { findMany: jest.fn() },
    };
    service = new UsersService(prisma as unknown as PrismaService);
  });

  it('ranks by win rate by default and numbers the positions', async () => {
    prisma.user.findMany.mockResolvedValue([
      row({ username: 'low', wins: 2, losses: 8 }), // 20%
      row({ username: 'high', wins: 8, losses: 2 }), // 80%
      row({ username: 'mid', wins: 5, losses: 5 }), // 50%
    ]);

    const res = await service.leaderboard();

    expect(res.metric).toBe('winRate');
    expect(res.total).toBe(3);
    expect(res.entries.map((e: any) => e.username)).toEqual([
      'high',
      'mid',
      'low',
    ]);
    expect(res.entries.map((e: any) => e.position)).toEqual([1, 2, 3]);
  });

  it('excludes banned accounts and staff at the query level', async () => {
    prisma.user.findMany.mockResolvedValue([]);

    await service.leaderboard();

    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { isBanned: false, roleUser: { notIn: ['admin', 'moderator'] } },
    });
  });

  it('never leaks credentials or PII', async () => {
    prisma.user.findMany.mockResolvedValue([
      row({ username: 'a', email: 'secret@mlbb.tg', password: 'hash' }),
    ]);

    const [entry] = (await service.leaderboard()).entries as any[];

    expect(entry.password).toBeUndefined();
    expect(entry.email).toBeUndefined();
    expect(entry.mlbbToken).toBeUndefined();
    expect(entry.username).toBe('a');
  });

  it('ranks by mvp count, wins and streak when asked', async () => {
    const players = [
      row({ username: 'a', wins: 10, losses: 0, mvpCount: 1, streak: 2 }),
      row({ username: 'b', wins: 4, losses: 6, mvpCount: 9, streak: 7 }),
    ];
    prisma.user.findMany.mockResolvedValue(players);

    const byMvp = await service.leaderboard({ metric: 'mvpCount' });
    expect(byMvp.entries[0].username).toBe('b');

    prisma.user.findMany.mockResolvedValue(players);
    const byWins = await service.leaderboard({ metric: 'wins' });
    expect(byWins.entries[0].username).toBe('a');

    prisma.user.findMany.mockResolvedValue(players);
    const byStreak = await service.leaderboard({ metric: 'streak' });
    expect(byStreak.entries[0].username).toBe('b');
  });

  it('breaks ties deterministically instead of relying on row order', async () => {
    // Same win rate, different sample size: the player with more games wins.
    const players = [
      row({ username: 'rookie', wins: 1, losses: 1 }),
      row({ username: 'veteran', wins: 50, losses: 50 }),
    ];
    prisma.user.findMany.mockResolvedValue(players);
    const first = await service.leaderboard();

    prisma.user.findMany.mockResolvedValue([...players].reverse());
    const second = await service.leaderboard();

    expect(first.entries[0].username).toBe('veteran');
    expect(second.entries[0].username).toBe('veteran');
  });

  it('keeps one-match perfect records off the podium via minGames', async () => {
    prisma.user.findMany.mockResolvedValue([
      row({ username: 'lucky', wins: 1, losses: 0 }), // 100% over 1 game
      row({ username: 'proven', wins: 30, losses: 20 }), // 60% over 50
    ]);

    const res = await service.leaderboard({ minGames: 10 });

    expect(res.total).toBe(1);
    expect(res.entries[0].username).toBe('proven');
  });

  it('filters on the hero role at the query level', async () => {
    prisma.user.findMany.mockResolvedValue([]);

    await service.leaderboard({ role: 'tank' });

    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: {
        isBanned: false,
        roleUser: { notIn: ['admin', 'moderator'] },
        role: 'tank',
      },
    });
  });

  it('caps the payload with limit while reporting the full total', async () => {
    prisma.user.findMany.mockResolvedValue(
      Array.from({ length: 12 }, (_, i) =>
        row({ username: `p${i}`, wins: 12 - i, losses: i }),
      ),
    );

    const res = await service.leaderboard({ limit: 5 });

    expect(res.entries).toHaveLength(5);
    expect(res.total).toBe(12);
    expect(res.entries[4].position).toBe(5);
  });

  it('restricts a season to the members of the teams that played it', async () => {
    prisma.esportMatch.findMany.mockResolvedValue([
      { teamAId: 't1', teamBId: 't2' },
      { teamAId: 't2', teamBId: 't1' },
    ]);
    prisma.esportTeamMember.findMany.mockResolvedValue([
      { userId: 'u1' },
      { userId: 'u2' },
      { userId: 'u1' },
    ]);
    prisma.user.findMany.mockResolvedValue([row({ username: 'u1' })]);

    await service.leaderboard({ seasonId: 's1' });

    // Team ids and user ids are both de-duplicated before hitting Prisma.
    expect(prisma.esportTeamMember.findMany).toHaveBeenCalledWith({
      where: { teamId: { in: ['t1', 't2'] } },
      select: { userId: true },
    });
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: {
        isBanned: false,
        roleUser: { notIn: ['admin', 'moderator'] },
        id: { in: ['u1', 'u2'] },
      },
    });
  });

  it('returns an empty board for a season with no match, without querying users', async () => {
    prisma.esportMatch.findMany.mockResolvedValue([]);

    const res = await service.leaderboard({ seasonId: 'empty' });

    expect(res).toEqual({ metric: 'winRate', total: 0, entries: [] });
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });
});
