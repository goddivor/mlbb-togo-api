import { BadRequestException } from '@nestjs/common';
import {
  EsportStatsService,
  MatchLike,
  biggestWinOf,
  completedForTeam,
  derivedHonoursOf,
  parseHonours,
  recordOf,
  standingsOf,
  streaksOf,
  timelineOf,
} from './esport-stats.service';
import { normalizeHonoursInput } from './esport-staff.service';
import { PrismaService } from '../prisma/prisma.service';

const A = 'team-a';
const B = 'team-b';
const C = 'team-c';
const S1 = 'season-1';

let seq = 0;
/** Completed match helper: `a` and `b` are the scores of teamA / teamB. */
const done = (
  teamAId: string,
  teamBId: string,
  a: number,
  b: number,
  day: number,
  over: Partial<MatchLike> = {},
): MatchLike => ({
  id: `m${++seq}`,
  status: 'completed',
  type: 'official',
  teamAId,
  teamBId,
  scoreA: a,
  scoreB: b,
  winnerTeamId: a > b ? teamAId : b > a ? teamBId : null,
  scheduledAt: new Date(Date.UTC(2026, 0, day)),
  ...over,
});

describe('team stats pure functions', () => {
  const matches: MatchLike[] = [
    done(A, B, 2, 0, 1, { seasonId: S1 }),
    done(C, A, 1, 2, 2, { seasonId: S1 }),
    done(A, C, 3, 0, 3, { type: 'friendly' }),
    done(A, B, 0, 2, 4, { seasonId: S1 }),
    done(A, B, 1, 1, 5),
    { id: 'sched', status: 'scheduled', teamAId: A, teamBId: B, scheduledAt: new Date() },
  ];

  it('projects completed matches chronologically from the team point of view', () => {
    const views = completedForTeam(A, matches);
    expect(views.map((v) => v.result)).toEqual(['W', 'W', 'W', 'L', 'D']);
    expect(views[1]).toMatchObject({ scoreFor: 2, scoreAgainst: 1, opponentId: C });
    expect(views.some((v) => v.id === 'sched')).toBe(false);
  });

  it('computes the record with win rate on decisive matches only', () => {
    const rec = recordOf(completedForTeam(A, matches));
    expect(rec).toMatchObject({ played: 5, wins: 3, losses: 1, draws: 1, winRate: 75 });
    expect(rec.scoreDiff).toBe(8 - 4);
  });

  it('computes current and best streaks', () => {
    const chrono = completedForTeam(A, matches);
    expect(streaksOf(chrono)).toEqual({ current: { type: 'D', count: 1 }, bestWin: 3, bestLoss: 1 });
    expect(streaksOf(chrono.slice(0, 4)).current).toEqual({ type: 'L', count: 1 });
    expect(streaksOf([]).current).toBeNull();
  });

  it('finds the biggest win by margin', () => {
    const best = biggestWinOf(completedForTeam(A, matches));
    expect(best).toMatchObject({ scoreFor: 3, scoreAgainst: 0, opponentId: C });
    expect(biggestWinOf(completedForTeam(B, matches).filter((v) => v.result !== 'W'))).toBeNull();
  });

  it('builds a cumulative win-rate timeline', () => {
    const tl = timelineOf(completedForTeam(A, matches));
    expect(tl.map((p) => p.winRate)).toEqual([100, 100, 100, 75, 75]);
    expect(timelineOf(completedForTeam(A, matches), 2)).toHaveLength(2);
  });

  it('ranks standings by wins then win rate', () => {
    const rows = standingsOf(matches.filter((m) => m.seasonId === S1));
    expect(rows.map((r) => r.teamId)).toEqual([A, B, C]);
    expect(rows[0]).toMatchObject({ wins: 2, losses: 1 });
  });

  it('derives season honours only for finished seasons with matches', () => {
    const seasons = [
      { id: S1, name: 'Season 1', endDate: new Date(Date.UTC(2026, 1, 1)), isActive: false },
      { id: 'active', name: 'Active', isActive: true },
      { id: 'empty', name: 'Empty', isActive: false },
    ];
    const now = new Date(Date.UTC(2026, 5, 1));
    const a = derivedHonoursOf(A, matches, seasons, now);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ source: 'derived', placement: 1, seasonId: S1, year: 2026 });
    expect(derivedHonoursOf(B, matches, seasons, now)[0]).toMatchObject({ placement: 2 });
    // Season not over yet: no title.
    expect(derivedHonoursOf(A, matches, seasons, new Date(Date.UTC(2026, 0, 15)))).toHaveLength(0);
  });

  it('parses stored honours defensively', () => {
    expect(parseHonours(null)).toEqual([]);
    expect(parseHonours('not json')).toEqual([]);
    expect(parseHonours('{"a":1}')).toEqual([]);
    const list = parseHonours(JSON.stringify([{ title: ' Cup ', year: 2025, placement: '1' }, { title: '' }]));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ title: 'Cup', year: 2025, placement: 1, source: 'manual' });
  });

  it('validates the admin honours payload', () => {
    expect(() => normalizeHonoursInput('x')).toThrow(BadRequestException);
    expect(() => normalizeHonoursInput([{ title: '' }])).toThrow(BadRequestException);
    expect(() => normalizeHonoursInput([{ title: 'Cup', year: 1200 }])).toThrow(BadRequestException);
    expect(() => normalizeHonoursInput([{ title: 'Cup', placement: 0 }])).toThrow(BadRequestException);
    const json = JSON.parse(normalizeHonoursInput([{ title: 'Cup', year: '2025', placement: '2', description: ' x ' }]));
    expect(json[0]).toMatchObject({ title: 'Cup', year: 2025, placement: 2, description: 'x' });
    expect(typeof json[0].id).toBe('string');
  });
});

describe('EsportStatsService', () => {
  let service: EsportStatsService;
  let prisma: {
    esportTeam: { findUnique: jest.Mock; findMany: jest.Mock };
    esportMatch: { findMany: jest.Mock };
    esportSeason: { findMany: jest.Mock };
  };

  const teams = [
    { id: A, name: 'Alpha', image: null, honours: null },
    { id: B, name: 'Beta', image: null, honours: null },
    { id: C, name: 'Gamma', image: null, honours: null },
  ];

  beforeEach(() => {
    prisma = {
      esportTeam: {
        findUnique: jest.fn(({ where }) => Promise.resolve(teams.find((t) => t.id === where.id) ?? null)),
        findMany: jest.fn(({ where }) => Promise.resolve(teams.filter((t) => where.id.in.includes(t.id)))),
      },
      esportMatch: { findMany: jest.fn() },
      esportSeason: { findMany: jest.fn().mockResolvedValue([{ id: S1, name: 'Season 1', isActive: false }]) },
    };
    service = new EsportStatsService(prisma as unknown as PrismaService);
  });

  it('returns 404 for an unknown team', async () => {
    await expect(service.getTeamStats('nope')).rejects.toMatchObject({ status: 404 });
  });

  it('aggregates stats, form, per-season records and head-to-head', async () => {
    prisma.esportMatch.findMany.mockResolvedValue([
      done(A, B, 2, 0, 1, { seasonId: S1 }),
      done(B, A, 2, 1, 2, { seasonId: S1 }),
      done(A, C, 1, 0, 3, { type: 'friendly' }),
    ]);
    const res = await service.getTeamStats(A);
    expect(res).toMatchObject({ played: 3, wins: 2, losses: 1, winRate: 67, form: ['W', 'L', 'W'] });
    expect(res.currentStreak).toEqual({ type: 'W', count: 1 });
    expect(res.bySeason.map((s: any) => s.season)).toEqual(['Season 1', null]);
    expect(res.headToHead[0]).toMatchObject({ opponent: { id: B, name: 'Beta' }, played: 2, wins: 1, losses: 1 });
    expect(res.biggestWin).toMatchObject({ scoreFor: 2, scoreAgainst: 0, opponent: { name: 'Beta' } });
  });

  it('paginates history most recent first and attaches honours', async () => {
    const ms = [1, 2, 3, 4, 5].map((d) => done(A, B, d % 2 ? 1 : 0, d % 2 ? 0 : 1, d, { seasonId: S1 }));
    prisma.esportMatch.findMany.mockResolvedValue(ms);
    const page1 = await service.getTeamHistory(A, 1, 2);
    expect(page1).toMatchObject({ total: 5, pages: 3, page: 1, limit: 2 });
    expect(page1.items.map((i: any) => i.result)).toEqual(['W', 'L']);
    expect(page1.items[0].opponent.name).toBe('Beta');
    expect(page1.items[0].season).toBe('Season 1');
    expect(page1.honours[0]).toMatchObject({ source: 'derived', placement: 1 });
    const page3 = await service.getTeamHistory(A, 3, 2);
    expect(page3.items).toHaveLength(1);
    // Out of range / invalid values are clamped.
    expect((await service.getTeamHistory(A, -4, 999)).limit).toBe(50);
  });

  it('lists upcoming scheduled matches, dated first, undated last', async () => {
    const future = new Date(Date.now() + 86_400_000);
    const later = new Date(Date.now() + 2 * 86_400_000);
    const past = new Date(Date.now() - 5 * 86_400_000);
    prisma.esportMatch.findMany.mockResolvedValue([
      { id: 'undated', status: 'scheduled', type: 'friendly', teamAId: B, teamBId: A, scheduledAt: null },
      { id: 'later', status: 'scheduled', type: 'official', teamAId: A, teamBId: C, scheduledAt: later, seasonId: S1 },
      { id: 'soon', status: 'scheduled', type: 'training', teamAId: A, teamBId: B, scheduledAt: future },
      { id: 'old', status: 'scheduled', type: 'friendly', teamAId: A, teamBId: B, scheduledAt: past },
    ]);
    const res = await service.getTeamSchedule(A);
    expect(res.map((m: any) => m.id)).toEqual(['soon', 'later', 'undated']);
    expect(res[0]).toMatchObject({ isHome: true, opponent: { name: 'Beta' } });
    expect(res[1].season).toBe('Season 1');
    expect(res[2]).toMatchObject({ isHome: false, date: null });
  });
});
