import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  LeagueStatsService,
  TtlCache,
  parseLimit,
  parsePeriod,
  parsePlayerSort,
} from './league-stats.service';

describe('query parsing', () => {
  it('validates the player sort', () => {
    expect(parsePlayerSort(undefined)).toBe('kills');
    expect(parsePlayerSort('kda')).toBe('kda');
    expect(() => parsePlayerSort('foo')).toThrow(BadRequestException);
  });

  it('validates and caps the limit', () => {
    expect(parseLimit(undefined, 50)).toBe(50);
    expect(parseLimit('')).toBe(50);
    expect(parseLimit('7')).toBe(7);
    expect(parseLimit(999)).toBe(200);
    expect(() => parseLimit('0')).toThrow(BadRequestException);
    expect(() => parseLimit('abc')).toThrow(BadRequestException);
  });

  it('validates the records period', () => {
    expect(parsePeriod(undefined)).toBe('season');
    expect(parsePeriod('week')).toBe('week');
    expect(() => parsePeriod('month')).toThrow(BadRequestException);
  });
});

describe('TtlCache', () => {
  it('expires entries after the ttl', () => {
    let now = 1000;
    const cache = new TtlCache<number>(60_000, () => now);
    expect(cache.get('k')).toBeUndefined();
    cache.set('k', 1);
    now += 59_999;
    expect(cache.get('k')).toBe(1);
    now += 1;
    expect(cache.get('k')).toBeUndefined();
    cache.set('k', 2);
    cache.clear();
    expect(cache.get('k')).toBeUndefined();
  });
});

const SEASON = { id: '6aabf8dc58e97de098ec208c', name: 'S3' };

function build(overrides: { current?: () => Promise<any>; season?: any } = {}) {
  const matches = [
    {
      id: 'm1',
      seasonId: SEASON.id,
      status: 'completed',
      teamAId: 'ta',
      teamBId: 'tb',
      scoreA: 2,
      scoreB: 0,
      winnerTeamId: 'ta',
      scheduledAt: new Date('2026-09-10T00:00:00Z'),
      createdAt: new Date('2026-09-10T00:00:00Z'),
    },
  ];
  const players = [
    { matchId: 'm1', userId: 'u1', teamId: 'ta', hero: 'Fanny', role: 'jungle', kills: 9, deaths: 1, assists: 2, isMvp: true },
    { matchId: 'm1', userId: 'u2', teamId: 'tb', hero: 'Ling', role: 'jungle', kills: 1, deaths: 5, assists: 0, isMvp: false },
  ];
  const calls = { matches: 0 };
  const prisma: any = {
    esportMatch: {
      findMany: jest.fn(async ({ where }: any) => {
        calls.matches++;
        return matches.filter((m) => !where.seasonId || m.seasonId === where.seasonId);
      }),
    },
    esportMatchPlayer: { findMany: jest.fn(async () => players) },
    esportSeason: { findUnique: jest.fn(async ({ where }: any) => (where.id === SEASON.id ? SEASON : null)) },
    esportTeam: {
      findMany: jest.fn(async () => [
        { id: 'ta', name: 'Alpha', image: null },
        { id: 'tb', name: 'Beta', image: 'b.png' },
      ]),
    },
    user: {
      findMany: jest.fn(async () => [
        { id: 'u1', username: 'one', avatar: null, profileSource: 'game', gameNickname: 'One' },
        { id: 'u2', username: 'two', avatar: 'a.png', profileSource: 'game' },
      ]),
    },
    hero: {
      findMany: jest.fn(async () => [{ name: 'Fanny', image: 'f.png', thumb: null, role: 'assassin' }]),
    },
  };
  const seasons: any = { current: overrides.current ?? (async () => SEASON) };
  return { service: new LeagueStatsService(prisma, seasons), prisma, calls };
}

describe('LeagueStatsService', () => {
  it('resolves the season scope', async () => {
    const { service } = build();
    expect(await service.resolveSeason(undefined)).toEqual({ scope: null, key: 'all' });
    expect(await service.resolveSeason('all')).toEqual({ scope: null, key: 'all' });
    expect(await service.resolveSeason('current')).toEqual({ scope: SEASON, key: SEASON.id });
    expect(await service.resolveSeason(SEASON.id)).toEqual({ scope: SEASON, key: SEASON.id });
    await expect(service.resolveSeason('nope')).rejects.toThrow(BadRequestException);
    await expect(service.resolveSeason('6aabf8dc58e97de098ec2000')).rejects.toThrow(NotFoundException);
  });

  it('returns empty stats when there is no season at all for `current`', async () => {
    const { service, calls } = build({
      current: async () => {
        throw new NotFoundException();
      },
    });
    const res = await service.teams('current');
    expect(res.season).toBeNull();
    expect(res.items).toEqual([]);
    expect(calls.matches).toBe(0);
  });

  it('decorates teams with logos and hero images', async () => {
    const { service } = build();
    const res = await service.teams(SEASON.id);
    expect(res.season).toEqual(SEASON);
    expect(res.matches).toBe(1);
    expect(res.hasPlayerStats).toBe(true);
    expect(res.items[0]).toMatchObject({
      rank: 1,
      team: { id: 'ta', name: 'Alpha' },
      wins: 1,
      mvpCount: 1,
      topHeroes: [{ name: 'Fanny', image: 'f.png', role: 'assassin', count: 1 }],
    });
    expect(res.items[1].team.image).toBe('b.png');
  });

  it('decorates players with user cards and validates the sort', async () => {
    const { service } = build();
    const res = await service.players({ seasonId: 'current', sort: 'kda', limit: '10' });
    expect(res.sort).toBe('kda');
    expect(res.items[0]).toMatchObject({
      rank: 1,
      user: { id: 'u1', username: 'one', displayName: 'One' },
      team: { name: 'Alpha' },
      kda: 11,
    });
    await expect(service.players({ sort: 'nope' })).rejects.toThrow(BadRequestException);
  });

  it('serves meta and records with an honest ban source', async () => {
    const { service } = build();
    const meta = await service.meta({ seasonId: 'all', minGames: '1' });
    expect(meta.banSource).toBe('unavailable');
    expect(meta.mostPlayed[0]).toMatchObject({ hero: 'Fanny', image: 'f.png', heroClass: 'assassin', winRate: 100 });
    expect(meta.mostPlayed[1]).toMatchObject({ hero: 'Ling', image: null });

    const rec = await service.records({ seasonId: 'all', period: 'season' });
    expect(rec.topKills).toMatchObject({ value: 9, user: { username: 'one' }, heroCard: { name: 'Fanny' } });
    expect(rec.biggestMargin).toMatchObject({ value: 2, teamA: { name: 'Alpha' }, teamB: { name: 'Beta' } });
    expect(rec.longestGame).toBeNull();
    await expect(service.records({ period: 'day' })).rejects.toThrow(BadRequestException);
  });

  it('caches results per key for a minute', async () => {
    const { service, calls } = build();
    await service.teams('all');
    await service.teams('all');
    expect(calls.matches).toBe(1);
    await service.teams(SEASON.id);
    expect(calls.matches).toBe(2);
    service.invalidate();
    await service.teams('all');
    expect(calls.matches).toBe(3);
  });
});
