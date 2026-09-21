import { Logger } from '@nestjs/common';
import {
  GameSyncService,
  OPPORTUNISTIC_SYNC_MS,
  resolveSyncStatus,
  shouldAutoSync,
  syncMessage,
} from './game-sync.service';
import { GameDataSource, SourceResult } from './game-data.source';
import { MoontonClient, MoontonResult } from './moonton.client';
import { PrismaService } from '../prisma/prisma.service';
import {
  mapCareerStats,
  mapFrequentHeroes,
  mapMatchDetail,
  mapRecentMatches,
  mapSeasons,
  MatchSummary,
} from './game.mappers';
import { samples } from './__fixtures__/battlereport.samples';

const USER_ID = '650000000000000000000001';

const ok = <T>(data: T): SourceResult<T> => ({ outcome: 'ok', code: 0, message: 'Success', data });
const offline: SourceResult<any> = { outcome: 'offline', code: 10407, message: '接口下线', data: null };
const expired: SourceResult<any> = { outcome: 'token_expired', code: 1002, message: 'auth is empty', data: null };

const infoOk: MoontonResult = { ok: true, outcome: 'ok', code: 0, message: 'ok', httpStatus: 200, data: samples.info.data };
const infoExpired: MoontonResult = { ok: false, outcome: 'token_expired', code: 401, message: 'Unauthorized', httpStatus: 401, data: null };

const match = (bid: string, over: Partial<MatchSummary> = {}): MatchSummary => ({
  bid,
  sid: 40,
  heroId: 17,
  heroName: 'Fanny',
  heroImage: null,
  kills: 1,
  deaths: 2,
  assists: 3,
  laneId: 4,
  score: 8,
  mvp: false,
  win: true,
  playedAt: new Date('2026-09-20T10:00:00Z'),
  ...over,
});

/** In-memory Prisma double covering what the sync touches. */
function makePrisma(user: Record<string, any>) {
  const matches = new Map<string, any>();
  const seasons = new Map<string, any>();
  const state = { user: { ...user } };
  const prisma = {
    state,
    matches,
    seasons,
    user: {
      findUnique: jest.fn(async () => ({ ...state.user })),
      update: jest.fn(async ({ data }: any) => {
        state.user = { ...state.user, ...data };
        return { ...state.user };
      }),
    },
    hero: { findMany: jest.fn(async () => [{ name: 'Fanny', role: 'assassin' }]) },
    gameMatch: {
      findMany: jest.fn(async ({ where }: any) =>
        [...matches.values()].filter((m) => m.userId === where.userId && where.bid.in.includes(m.bid)),
      ),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const key = `${where.userId_bid.userId}:${where.userId_bid.bid}`;
        const prev = matches.get(key);
        const next = prev ? { ...prev, ...update } : { ...create };
        matches.set(key, next);
        return next;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const key = `${where.userId_bid.userId}:${where.userId_bid.bid}`;
        matches.set(key, { ...matches.get(key), ...data });
        return matches.get(key);
      }),
    },
    gameSeasonStats: {
      findUnique: jest.fn(async ({ where }: any) => seasons.get(`${where.userId_sid.userId}:${where.userId_sid.sid}`) ?? null),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const key = `${where.userId_sid.userId}:${where.userId_sid.sid}`;
        const next = seasons.has(key) ? { ...seasons.get(key), ...update } : { ...create };
        seasons.set(key, next);
        return next;
      }),
    },
  };
  return prisma;
}

function makeSource(over: Partial<Record<keyof GameDataSource, any>> = {}) {
  return {
    name: 'fake',
    careerStats: jest.fn(async () =>
      ok({ ...mapCareerStats(samples.stats.data), seasons: mapSeasons(samples.stats.data) }),
    ),
    seasons: jest.fn(async () => ok(mapSeasons(samples.season.data))),
    frequentHeroes: jest.fn(async () => ok(mapFrequentHeroes(samples.frequent.data))),
    recentMatches: jest.fn(async (_jwt: string, sid: number) => ok(mapRecentMatches(samples.matches.data, sid))),
    heroMatches: jest.fn(async () => ok({ hero: null, items: [], page: { nextCursor: null, hasNext: false } })),
    matchDetail: jest.fn(async () => ok(mapMatchDetail(samples.matchDetail.data))),
    ...over,
  };
}

const linkedUser = {
  id: USER_ID,
  mlbbRoleId: 1880233572,
  mlbbZoneId: 57027,
  mlbbToken: 'session-token',
  mlbbTokenStatus: 'valid',
  mlbbTokenExpiredAt: null,
  gameNickname: 'Old nick',
  gameStats: JSON.stringify({ wins: 5, total: 10 }),
  gameSeasons: '[39]',
  gameFrequentHeroes: '[{"heroId":1}]',
};

function build(source: ReturnType<typeof makeSource>, info: MoontonResult = infoOk, user = linkedUser) {
  const prisma = makePrisma(user);
  const client = { sgPost: jest.fn(async () => info) };
  const service = new GameSyncService(
    prisma as unknown as PrismaService,
    client as unknown as MoontonClient,
    source as unknown as GameDataSource,
  );
  return { prisma, client, service };
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

describe('resolveSyncStatus / syncMessage', () => {
  it('prioritises a dead session, then the stats route health', () => {
    expect(resolveSyncStatus('ok', 'token_expired')).toBe('token_expired');
    expect(resolveSyncStatus('token_expired', 'offline')).toBe('token_expired');
    expect(resolveSyncStatus('ok', 'ok')).toBe('ok');
    expect(resolveSyncStatus('ok', 'offline')).toBe('moonton_offline');
    expect(resolveSyncStatus('unreachable', 'unreachable')).toBe('unavailable');
  });

  it('summarises failures without payloads', () => {
    expect(syncMessage({ outcome: 'ok', code: 0, message: 'ok' }, offline)).toBe('offline 10407 接口下线');
    expect(syncMessage({ outcome: 'ok', code: 0, message: 'ok' })).toBeNull();
  });
});

describe('GameSyncService.syncUser', () => {
  it('keeps cached stats and refreshes identity when Moonton took the stats routes offline', async () => {
    const source = makeSource({ careerStats: jest.fn(async () => offline) });
    const { prisma, service } = build(source);

    const { status, user } = await service.syncUser(USER_ID);

    expect(status).toBe('moonton_offline');
    expect(user).toMatchObject({
      gameSyncStatus: 'moonton_offline',
      gameSyncMessage: 'offline 10407 接口下线',
      mlbbTokenStatus: 'valid',
      gameNickname: 'SAYA AKAN LAWAN',
      gameRankLevel: 8000,
      gamePeakRankLevel: 9999,
      // Untouched cache:
      gameStats: linkedUser.gameStats,
      gameSeasons: '[39]',
      gameFrequentHeroes: linkedUser.gameFrequentHeroes,
      mlbbToken: 'session-token',
    });
    // No further call on dead routes.
    expect(source.seasons).not.toHaveBeenCalled();
    expect(source.frequentHeroes).not.toHaveBeenCalled();
    expect(source.recentMatches).not.toHaveBeenCalled();
    expect(prisma.gameMatch.upsert).not.toHaveBeenCalled();
  });

  it('marks the session expired on 1002 without wiping anything', async () => {
    const source = makeSource({ careerStats: jest.fn(async () => expired) });
    const { service } = build(source, infoExpired);

    const { status, user } = await service.syncUser(USER_ID);

    expect(status).toBe('token_expired');
    expect(user.mlbbTokenStatus).toBe('expired');
    expect(user.mlbbTokenExpiredAt).toBeInstanceOf(Date);
    expect(user.mlbbToken).toBe('session-token');
    expect(user.gameNickname).toBe('Old nick');
    expect(user.gameStats).toBe(linkedUser.gameStats);
  });

  it('stores career stats, seasons and current-season heroes when routes answer', async () => {
    const source = makeSource();
    const { prisma, service } = build(source);

    const { status, user } = await service.syncUser(USER_ID, { awaitMatches: true });

    expect(status).toBe('ok');
    expect(JSON.parse(user.gameStats)).toMatchObject({ wins: 188, total: 308, winRate: 61 });
    expect(JSON.parse(user.gameStats).seasons).toBeUndefined();
    expect(JSON.parse(user.gameSeasons)).toEqual([40, 39, 38, 37]);
    expect(JSON.parse(user.gameRoles)).toEqual([{ role: 'assassin', matches: 8 }]);
    expect(prisma.seasons.get(`${USER_ID}:40`)).toBeDefined();
    // Crawl: season 40 follows the cursor once, then stops on a page with
    // nothing new; older seasons only bring the same sample match (1 call each).
    expect(source.recentMatches).toHaveBeenCalledTimes(5);
    expect(source.recentMatches.mock.calls[1][2]).toBe('4143043017340290910');
    expect(prisma.matches.size).toBe(1);
  });
});

describe('GameSyncService match persistence', () => {
  it('upserts idempotently on [userId, bid]', async () => {
    const { prisma, service } = build(makeSource());
    const first = await service.persistMatches(USER_ID, [match('1'), match('2'), match('2')]);
    const second = await service.persistMatches(USER_ID, [match('1', { kills: 9 }), match('2')]);

    expect(first).toEqual({ created: 2, updated: 0 });
    expect(second).toEqual({ created: 0, updated: 2 });
    expect(prisma.matches.size).toBe(2);
    expect(prisma.matches.get(`${USER_ID}:1`).kills).toBe(9);
  });

  it('never overwrites a stored detail when a summary is re-synced', async () => {
    const { prisma, service } = build(makeSource());
    await service.persistMatches(USER_ID, [match('1')]);
    prisma.matches.set(`${USER_ID}:1`, { ...prisma.matches.get(`${USER_ID}:1`), detail: '{"players":[]}' });
    await service.persistMatches(USER_ID, [match('1')]);
    expect(prisma.matches.get(`${USER_ID}:1`).detail).toBe('{"players":[]}');
  });

  it('stops paginating once a page brings nothing new', async () => {
    const pages = [
      { items: [match('a'), match('b')], page: { nextCursor: 'c1', hasNext: true } },
      { items: [match('c')], page: { nextCursor: 'c2', hasNext: true } },
    ];
    let call = 0;
    const source = makeSource({ recentMatches: jest.fn(async () => ok(pages[Math.min(call++, 1)])) });
    const { service } = build(source);

    await service.syncMatches(USER_ID, 'jwt', [40]);
    // Page 1 (new), page 2 (new), page 2 again (nothing new) -> stop.
    expect(source.recentMatches).toHaveBeenCalledTimes(3);
    expect(source.recentMatches.mock.calls[1][2]).toBe('c1');

    source.recentMatches.mockClear();
    call = 0;
    await service.syncMatches(USER_ID, 'jwt', [40]);
    expect(source.recentMatches).toHaveBeenCalledTimes(1);
  });

  it('stops the crawl and flags the session on 1002', async () => {
    const source = makeSource({ recentMatches: jest.fn(async () => expired) });
    const { prisma, service } = build(source);
    await service.syncMatches(USER_ID, 'jwt', [40, 39]);
    expect(source.recentMatches).toHaveBeenCalledTimes(1);
    expect(prisma.state.user.mlbbTokenStatus).toBe('expired');
    expect(prisma.state.user.gameSyncStatus).toBe('token_expired');
  });

  it('stores a lazily fetched match detail', async () => {
    const source = makeSource();
    const { prisma, service } = build(source);
    await service.persistMatches(USER_ID, [match('4132717739868068534')]);
    const detail = await service.fetchMatchDetail(linkedUser, { bid: '4132717739868068534', sid: 40 });

    expect(detail?.players).toHaveLength(1);
    const row = prisma.matches.get(`${USER_ID}:4132717739868068534`);
    expect(JSON.parse(row.detail).durationSec).toBe(1292);
    expect(row.durationSec).toBe(1292);
  });

  it('does not call Moonton for a detail with an expired session', async () => {
    const source = makeSource();
    const { service } = build(source);
    const detail = await service.fetchMatchDetail({ ...linkedUser, mlbbTokenStatus: 'expired' }, { bid: '1', sid: 40 });
    expect(detail).toBeNull();
    expect(source.matchDetail).not.toHaveBeenCalled();
  });
});

describe('shouldAutoSync', () => {
  const now = new Date('2026-09-21T12:00:00Z');
  const base = { mlbbToken: 'opaque', mlbbRoleId: 1, mlbbTokenStatus: 'valid', gameSyncAttemptAt: null };

  it('runs for a linked, valid session never synced', () => {
    expect(shouldAutoSync(base, now)).toBe(true);
  });
  it('is rate-limited to one attempt per window', () => {
    const recent = new Date(now.getTime() - OPPORTUNISTIC_SYNC_MS + 60_000);
    const old = new Date(now.getTime() - OPPORTUNISTIC_SYNC_MS - 60_000);
    expect(shouldAutoSync({ ...base, gameSyncAttemptAt: recent }, now)).toBe(false);
    expect(shouldAutoSync({ ...base, gameSyncAttemptAt: old }, now)).toBe(true);
  });
  it('skips unlinked accounts and dead sessions', () => {
    expect(shouldAutoSync(null, now)).toBe(false);
    expect(shouldAutoSync({ ...base, mlbbToken: null }, now)).toBe(false);
    expect(shouldAutoSync({ ...base, mlbbTokenStatus: 'expired' }, now)).toBe(false);
    // JWT whose exp (1700000000) is in the past.
    expect(shouldAutoSync({ ...base, mlbbToken: 'a.eyJleHAiOjE3MDAwMDAwMDB9.c' }, now)).toBe(false);
  });
});
