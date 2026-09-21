import { NotFoundException } from '@nestjs/common';
import { PlayerStatsService } from './player-stats.service';
import { PrismaService } from '../prisma/prisma.service';

const U = 'user-1';

const match = (over: Partial<Record<string, any>> = {}) => ({
  id: 'm1',
  seasonId: null,
  type: 'friendly',
  teamAId: 'A',
  teamBId: 'B',
  scheduledAt: new Date('2026-03-10T18:00:00Z'),
  createdAt: new Date('2026-03-01T00:00:00Z'),
  status: 'completed',
  scoreA: 2,
  scoreB: 1,
  winnerTeamId: 'A',
  ...over,
});

const player = (over: Partial<Record<string, any>> = {}) => ({
  id: 'p1',
  matchId: 'm1',
  userId: U,
  teamId: 'A',
  hero: 'Lancelot',
  heroId: null,
  role: 'jungle',
  kills: 8,
  deaths: 2,
  assists: 5,
  gold: null,
  damage: null,
  isMvp: true,
  ...over,
});

function makePrisma() {
  return {
    user: {
      findUnique: jest.fn().mockResolvedValue({ id: U, roleUser: 'user', badges: '["founder"]' }),
      update: jest.fn().mockResolvedValue({}),
    },
    esportMatchPlayer: { findMany: jest.fn().mockResolvedValue([]) },
    esportMatch: { findMany: jest.fn().mockResolvedValue([]) },
    esportSeason: { findMany: jest.fn().mockResolvedValue([]) },
    esportTeam: { findMany: jest.fn().mockResolvedValue([]) },
    hero: { findMany: jest.fn().mockResolvedValue([]) },
  };
}

describe('PlayerStatsService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let service: PlayerStatsService;

  beforeEach(() => {
    prisma = makePrisma();
    service = new PlayerStatsService(prisma as unknown as PrismaService);
  });

  it('hides system accounts and unknown users, not staff players', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(null);
    await expect(service.getUserStats('nope')).rejects.toBeInstanceOf(NotFoundException);
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'a', isSystemAccount: true, badges: '[]' });
    await expect(service.getUserMatches('a')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('only counts completed matches', async () => {
    prisma.esportMatchPlayer.findMany.mockResolvedValue([
      player({ id: 'p1', matchId: 'm1' }),
      player({ id: 'p2', matchId: 'm2', isMvp: false }),
    ]);
    // m2 is still scheduled: the status filter of the query leaves it out.
    prisma.esportMatch.findMany.mockResolvedValue([match({ id: 'm1' })]);

    const s = await service.getUserStats(U);
    expect(prisma.esportMatch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'completed' }) }),
    );
    expect(s.games).toBe(1);
    expect(s.wins).toBe(1);
    expect(s.mvpCount).toBe(1);
    expect(s.earnedBadges).toEqual(['first_win', 'mvp_1']);
    expect(s.badges).toEqual(['founder', 'first_win', 'mvp_1']);
  });

  it('recomputes user counters from matches instead of incrementing', async () => {
    prisma.esportMatchPlayer.findMany.mockResolvedValue([
      player({ id: 'p1', matchId: 'm1' }),
      player({ id: 'p2', matchId: 'm2', isMvp: false, teamId: 'B' }),
    ]);
    prisma.esportMatch.findMany.mockResolvedValue([
      match({ id: 'm1' }),
      match({ id: 'm2', scheduledAt: new Date('2026-03-12T18:00:00Z'), winnerTeamId: 'A' }),
    ]);

    await service.recomputeUsers([U, U]);
    await service.recomputeUsers([U]);

    // Deduplicated input, and each pass writes the same derived values.
    expect(prisma.user.update).toHaveBeenCalledTimes(2);
    for (const call of prisma.user.update.mock.calls) {
      expect(call[0]).toEqual({
        where: { id: U },
        data: {
          wins: 1,
          losses: 1,
          mvpCount: 1,
          streak: -1,
          badges: JSON.stringify(['founder', 'first_win', 'mvp_1']),
        },
      });
    }
  });

  it('skips users that no longer exist', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    expect(await service.recomputeUsers(['ghost'])).toBe(1);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('paginates the history, most recent first, with opponent and result', async () => {
    prisma.esportMatchPlayer.findMany.mockResolvedValue([
      player({ id: 'p1', matchId: 'm1' }),
      player({ id: 'p2', matchId: 'm2', teamId: 'B', isMvp: false, hero: 'Layla' }),
      player({ id: 'p3', matchId: 'm3', isMvp: false }),
    ]);
    prisma.esportMatch.findMany.mockResolvedValue([
      match({ id: 'm1', scheduledAt: new Date('2026-03-10T18:00:00Z') }),
      match({ id: 'm2', scheduledAt: new Date('2026-03-20T18:00:00Z'), scoreA: 0, scoreB: 2, winnerTeamId: 'B', seasonId: 's1' }),
      match({ id: 'm3', scheduledAt: null, createdAt: new Date('2026-01-01T00:00:00Z'), winnerTeamId: null }),
    ]);
    prisma.esportTeam.findMany.mockResolvedValue([
      { id: 'A', name: 'Alpha', image: null },
      { id: 'B', name: 'Beta', image: null },
    ]);
    prisma.esportSeason.findMany.mockResolvedValue([{ id: 's1', name: 'Season 1' }]);

    const page1 = await service.getUserMatches(U, 1, 2);
    expect(page1.total).toBe(3);
    expect(page1.hasMore).toBe(true);
    expect(page1.items.map((i) => i.matchId)).toEqual(['m2', 'm1']);
    expect(page1.items[0]).toMatchObject({
      team: { name: 'Beta' },
      opponent: { name: 'Alpha' },
      scoreFor: 2,
      scoreAgainst: 0,
      result: 'win',
      seasonName: 'Season 1',
      hero: 'Layla',
    });
    expect(page1.items[1]).toMatchObject({ result: 'win', isMvp: true, kda: 6.5 });

    const page2 = await service.getUserMatches(U, 2, 2);
    expect(page2.items.map((i) => i.matchId)).toEqual(['m3']);
    expect(page2.items[0].result).toBe('draw');
    expect(page2.hasMore).toBe(false);
  });

  it('caps the page size', async () => {
    const res = await service.getUserMatches(U, 0, 500);
    expect(res.page).toBe(1);
    expect(res.limit).toBe(50);
  });
});
