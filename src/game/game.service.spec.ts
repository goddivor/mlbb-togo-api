import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { GameService, canViewGame, careerOrNull, tokenStatusOf } from './game.service';
import { GameSyncService } from './game-sync.service';
import { PrismaService } from '../prisma/prisma.service';

const ID = '650000000000000000000001';
const OTHER = '650000000000000000000002';

const userRow = (over: Record<string, any> = {}) => ({
  id: ID,
  roleUser: 'user',
  privacy: null,
  mlbbRoleId: 111,
  mlbbToken: 'secret-session',
  mlbbTokenStatus: 'valid',
  mlbbTokenExpiredAt: null,
  gameNickname: 'Nick',
  gameAvatar: null,
  gameLevel: 80,
  gameRankLevel: 150,
  gamePeakRankLevel: 170,
  gameCountry: 'TG',
  gameStats: '{}',
  gameSeasons: '[40,39]',
  gameFrequentHeroes: '[{"heroId":5,"name":"Legacy"}]',
  gameSyncStatus: 'moonton_offline',
  gameSyncedAt: new Date('2026-09-21T08:00:00Z'),
  gameSyncAttemptAt: new Date('2026-09-21T08:00:00Z'),
  gameStatsSyncedAt: null,
  ...over,
});

const matchRow = (bid: string, over: Record<string, any> = {}) => ({
  id: `m${bid}`,
  userId: ID,
  bid,
  sid: 40,
  heroId: 17,
  heroName: 'Fanny',
  heroImage: null,
  kills: 4,
  deaths: 0,
  assists: 6,
  laneId: 4,
  score: 9.5,
  mvp: true,
  win: true,
  playedAt: new Date('2026-09-20T10:00:00Z'),
  durationSec: null,
  detail: null,
  ...over,
});

function makePrisma(user: any, matches: any[] = [], seasons: any[] = []) {
  return {
    user: { findUnique: jest.fn(async () => user) },
    gameSeasonStats: { findMany: jest.fn(async () => seasons) },
    gameMatch: {
      count: jest.fn(async () => matches.length),
      findMany: jest.fn(async ({ skip, take }: any) => matches.slice(skip, skip + take)),
      findUnique: jest.fn(async ({ where }: any) => matches.find((m) => m.bid === where.userId_bid.bid) ?? null),
    },
  };
}

describe('game read helpers', () => {
  it('follows the profile privacy settings', () => {
    expect(canViewGame(null, false, false)).toBe(true);
    expect(canViewGame({ profilePublic: true, showStats: true }, false, false)).toBe(true);
    expect(canViewGame({ profilePublic: false }, false, false)).toBe(false);
    expect(canViewGame({ showStats: false }, false, false)).toBe(false);
    expect(canViewGame({ profilePublic: false }, true, false)).toBe(true);
    expect(canViewGame({ showStats: false }, false, true)).toBe(true);
  });

  it('reports the session status without exposing it', () => {
    expect(tokenStatusOf({ mlbbToken: null })).toBe('none');
    expect(tokenStatusOf({ mlbbToken: 'x', mlbbTokenStatus: 'expired' })).toBe('expired');
    expect(tokenStatusOf({ mlbbToken: 'x', mlbbTokenStatus: null })).toBe('valid');
  });

  it('treats empty career stats as missing', () => {
    expect(careerOrNull('{}')).toBeNull();
    expect(careerOrNull('{"total":0}')).toBeNull();
    expect(careerOrNull('{"total":3,"wins":2}')).toEqual({ total: 3, wins: 2 });
  });
});

describe('GameService', () => {
  it('serves the cached summary without the Moonton token', async () => {
    const prisma = makePrisma(userRow(), [matchRow('1')], [{ sid: 40, frequentHeroes: '[{"heroId":17}]', syncedAt: new Date() }]);
    const service = new GameService(prisma as unknown as PrismaService);

    const out: any = await service.getSummary(ID, null);

    expect(out).toMatchObject({
      visible: true,
      linked: true,
      isOwner: false,
      stats: null,
      seasons: [40, 39],
      currentSeason: 40,
      frequentHeroes: [{ heroId: 17 }],
      matchesCount: 1,
      profile: { nickname: 'Nick', rank: 'Mythic', peakRank: 'Mythic Honor', level: 80 },
      sync: { status: 'moonton_offline', tokenStatus: 'valid', statsAvailable: false },
    });
    expect(JSON.stringify(out)).not.toContain('secret-session');
  });

  it('hides everything but the link flag on a private profile', async () => {
    const prisma = makePrisma(userRow({ privacy: { profilePublic: false } }));
    const service = new GameService(prisma as unknown as PrismaService);

    expect(await service.getSummary(ID, { id: OTHER })).toEqual({ userId: ID, visible: false, linked: true, isOwner: false });
    expect(await service.getSummary(ID, { id: ID })).toMatchObject({ visible: true, isOwner: true });
    await expect(service.getMatch(ID, '1', null)).rejects.toBeInstanceOf(ForbiddenException);
    expect(await service.listMatches(ID, null, {})).toMatchObject({ visible: false, items: [], total: 0 });
  });

  it('never serves staff accounts or invalid ids', async () => {
    const service = new GameService(makePrisma(userRow({ roleUser: 'admin' })) as unknown as PrismaService);
    await expect(service.getSummary(ID)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getSummary('not-an-id')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('pages stored matches with filters', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => matchRow(String(i)));
    const prisma = makePrisma(userRow(), rows);
    const service = new GameService(prisma as unknown as PrismaService);

    const out: any = await service.listMatches(ID, null, { season: 40, hero: 17, page: 2, limit: 5 });

    expect(prisma.gameMatch.count).toHaveBeenCalledWith({ where: { userId: ID, sid: 40, heroId: 17 } });
    expect(prisma.gameMatch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { playedAt: 'desc' }, skip: 5, take: 5 }),
    );
    expect(out).toMatchObject({ total: 12, page: 2, limit: 5, hasMore: true });
    expect(out.items[0]).toMatchObject({ bid: '5', kda: 10, hasDetail: false });
    expect(out.items[0].userId).toBeUndefined();
  });

  it('fetches a missing match detail lazily through the sync service', async () => {
    const prisma = makePrisma(userRow(), [matchRow('9')]);
    const detail = { durationSec: 900, playedAt: null, teams: [], players: [{ name: 'a' }] };
    const sync = { fetchMatchDetail: jest.fn(async () => detail) };
    const service = new GameService(prisma as unknown as PrismaService, sync as unknown as GameSyncService);

    const out: any = await service.getMatch(ID, '9', null);

    expect(sync.fetchMatchDetail).toHaveBeenCalledWith(expect.objectContaining({ id: ID }), expect.objectContaining({ bid: '9' }));
    expect(out.detail).toBe(detail);
    expect(out.match).toMatchObject({ bid: '9', hasDetail: true, durationSec: 900 });
  });

  it('serves a stored detail without calling Moonton', async () => {
    const stored = { durationSec: 600, players: [] };
    const prisma = makePrisma(userRow(), [matchRow('9', { detail: JSON.stringify(stored) })]);
    const sync = { fetchMatchDetail: jest.fn() };
    const service = new GameService(prisma as unknown as PrismaService, sync as unknown as GameSyncService);

    const out: any = await service.getMatch(ID, '9', null);
    expect(sync.fetchMatchDetail).not.toHaveBeenCalled();
    expect(out.detail).toEqual(stored);
  });
});
