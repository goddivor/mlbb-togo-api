import {
  MatchRow,
  PlayerRow,
  bansOf,
  computeMeta,
  computePlayerRankings,
  computeRecords,
  computeTeamStats,
  inWindow,
  kdaOf,
  matchDate,
  weekWindow,
  winRateOf,
} from './league-stats.util';

const A = 'team-a';
const B = 'team-b';
const C = 'team-c';
const S1 = 'season-1';

const day = (n: number) => new Date(Date.UTC(2026, 8, n));

const match = (
  id: string,
  teamAId: string,
  teamBId: string,
  scoreA: number,
  scoreB: number,
  d: number,
  over: Partial<MatchRow> = {},
): MatchRow => ({
  id,
  seasonId: S1,
  type: 'league',
  status: 'completed',
  teamAId,
  teamBId,
  scoreA,
  scoreB,
  winnerTeamId: scoreA === scoreB ? null : scoreA > scoreB ? teamAId : teamBId,
  scheduledAt: day(d),
  createdAt: day(d),
  ...over,
});

const row = (
  matchId: string,
  userId: string,
  teamId: string,
  hero: string,
  role: string,
  k: number,
  d: number,
  a: number,
  over: Partial<PlayerRow> = {},
): PlayerRow => ({ matchId, userId, teamId, hero, role, kills: k, deaths: d, assists: a, isMvp: false, ...over });

// m1: A beats B 2-0 (day 1), m2: B beats A 2-1 (day 3), m3: A beats C 2-0 (day 10)
const MATCHES: MatchRow[] = [
  match('m1', A, B, 2, 0, 1),
  match('m2', A, B, 1, 2, 3),
  match('m3', A, C, 2, 0, 10),
  match('m4', B, C, 1, 1, 11, { winnerTeamId: null }),
  match('m5', C, A, 0, 0, 12, { status: 'scheduled' }),
];

const PLAYERS: PlayerRow[] = [
  row('m1', 'u1', A, 'Fanny', 'jungle', 10, 2, 4, { isMvp: true, damage: 90000, gold: 12000 }),
  row('m1', 'u2', A, 'Tigreal', 'roam', 1, 3, 12),
  row('m1', 'u3', B, 'Ling', 'jungle', 3, 5, 1),
  row('m2', 'u1', A, 'Fanny', 'jungle', 4, 4, 2),
  row('m2', 'u3', B, 'Ling', 'jungle', 8, 1, 5, { isMvp: true, damage: 120000, gold: 15000 }),
  row('m3', 'u1', A, 'Lancelot', 'jungle', 7, 0, 3, { isMvp: true }),
  row('m3', 'u2', A, 'Tigreal', 'roam', 0, 1, 15),
  row('m3', 'u4', C, 'Layla', 'gold', 2, 6, 1),
  // Scheduled match: must be ignored everywhere.
  row('m5', 'u4', C, 'Layla', 'gold', 99, 0, 99),
];

describe('basic helpers', () => {
  it('computes kda and win rate with safe denominators', () => {
    expect(kdaOf(10, 0, 5)).toBe(15);
    expect(kdaOf(3, 2, 1)).toBe(2);
    expect(winRateOf(0, 0)).toBe(0);
    expect(winRateOf(2, 1)).toBe(66.7);
  });

  it('reads the match date from scheduledAt then createdAt', () => {
    expect(matchDate({ ...MATCHES[0], scheduledAt: null })?.getTime()).toBe(day(1).getTime());
    expect(matchDate({ ...MATCHES[0], scheduledAt: 'nope', createdAt: null })).toBeNull();
  });

  it('builds a rolling 7-day window', () => {
    const now = day(20);
    const w = weekWindow(now);
    expect(w.to).toBe(now);
    expect(w.from.getTime()).toBe(day(13).getTime());
    expect(inWindow(day(13), w)).toBe(true);
    expect(inWindow(day(12), w)).toBe(false);
    expect(inWindow(null, w)).toBe(false);
  });
});

describe('computeTeamStats', () => {
  it('aggregates W/L, scores, averages, MVPs and top heroes per team', () => {
    const stats = computeTeamStats(MATCHES, PLAYERS);
    expect(stats.map((s) => s.teamId)).toEqual([A, B, C]);
    const a = stats[0];
    expect(a).toMatchObject({
      games: 3,
      wins: 2,
      losses: 1,
      draws: 0,
      winRate: 66.7,
      scoreFor: 5,
      scoreAgainst: 2,
      scoreDiff: 3,
      gamesWithStats: 3,
      mvpCount: 2,
      avgDurationMin: null,
    });
    // kills: m1 11, m2 4, m3 7 = 22 over 3 games
    expect(a.avgKills).toBe(7.3);
    expect(a.topHeroes).toEqual([
      { key: 'Fanny', count: 2 },
      { key: 'Tigreal', count: 2 },
      { key: 'Lancelot', count: 1 },
    ]);
    const c = stats[2];
    expect(c).toMatchObject({ games: 2, wins: 0, losses: 1, draws: 1, winRate: 0, gamesWithStats: 1 });
    // C has stats only on m3 (m4 has no rows, m5 is not completed).
    expect(c.avgKills).toBe(2);
  });

  it('returns an empty list without matches', () => {
    expect(computeTeamStats([], PLAYERS)).toEqual([]);
  });
});

describe('computePlayerRankings', () => {
  it('lists only players with a completed game and sorts by kills by default', () => {
    const list = computePlayerRankings(MATCHES, PLAYERS);
    expect(list.map((p) => p.userId)).toEqual(['u1', 'u3', 'u4', 'u2']);
    const u1 = list[0];
    expect(u1).toMatchObject({
      games: 3,
      wins: 2,
      losses: 1,
      winRate: 66.7,
      kills: 21,
      deaths: 6,
      assists: 9,
      avgKills: 7,
      kda: 5,
      mvpCount: 2,
      role: 'jungle',
      teamId: A,
    });
    expect(u1.topHeroes[0]).toEqual({ key: 'Fanny', count: 2 });
    // u4 only has the scheduled game's absurd line ignored: 1 game, 2 kills.
    expect(list[2]).toMatchObject({ userId: 'u4', games: 1, kills: 2 });
  });

  it('supports every sort key and the limit', () => {
    expect(computePlayerRankings(MATCHES, PLAYERS, { sort: 'assists' })[0].userId).toBe('u2');
    expect(computePlayerRankings(MATCHES, PLAYERS, { sort: 'kda' })[0].userId).toBe('u2');
    expect(computePlayerRankings(MATCHES, PLAYERS, { sort: 'mvp' }).map((p) => p.userId).slice(0, 2)).toEqual(['u1', 'u3']);
    expect(computePlayerRankings(MATCHES, PLAYERS, { sort: 'games', limit: 1 })).toHaveLength(1);
    expect(computePlayerRankings(MATCHES, PLAYERS, { sort: 'winRate' })[0].userId).toBe('u2');
  });

  it('filters by lane, keeping only the games played on it', () => {
    const roam = computePlayerRankings(MATCHES, PLAYERS, { role: 'ROAM' });
    expect(roam.map((p) => p.userId)).toEqual(['u2']);
    expect(computePlayerRankings(MATCHES, PLAYERS, { role: 'mid' })).toEqual([]);
  });

  it('uses the team of the most recent game', () => {
    const moved = [...PLAYERS, row('m4', 'u1', B, 'Fanny', 'jungle', 1, 1, 1)];
    const u1 = computePlayerRankings(MATCHES, moved).find((p) => p.userId === 'u1')!;
    expect(u1.teamId).toBe(B);
    expect(u1.games).toBe(4);
    expect(u1.draws).toBe(1);
  });
});

describe('computeMeta', () => {
  it('computes picks, pick rate, min-games win rate and honest ban source', () => {
    const meta = computeMeta(MATCHES, PLAYERS, { minGames: 2 });
    expect(meta.matches).toBe(4);
    expect(meta.matchesWithStats).toBe(3);
    expect(meta.matchesWithBans).toBe(0);
    expect(meta.banSource).toBe('unavailable');
    expect(meta.mostBanned).toEqual([]);
    const fanny = meta.heroes.find((h) => h.hero === 'Fanny')!;
    expect(fanny).toMatchObject({ picks: 2, wins: 1, losses: 1, winRate: 50, pickRate: 66.7, role: 'jungle', banRate: null });
    const lancelot = meta.heroes.find((h) => h.hero === 'Lancelot')!;
    expect(lancelot.winRate).toBeNull();
    // Ties on picks are broken by win rate (Tigreal 100% > Fanny 50% > Ling 50%).
    expect(meta.mostPlayed.map((h) => h.hero)).toEqual(['Tigreal', 'Fanny', 'Ling', 'Lancelot', 'Layla']);
    expect(meta.bestWinRate.map((h) => h.hero)).toEqual(['Tigreal', 'Fanny', 'Ling']);
  });

  it('applies the default minimum and the limit', () => {
    const meta = computeMeta(MATCHES, PLAYERS, { limit: 2 });
    expect(meta.minGames).toBe(3);
    expect(meta.bestWinRate).toEqual([]);
    expect(meta.mostPlayed).toHaveLength(2);
  });

  it('reads bans from a future per-game breakdown when present', () => {
    expect(bansOf(MATCHES[0])).toBeNull();
    expect(bansOf({ ...MATCHES[0], games: 'not json' })).toBeNull();
    expect(bansOf({ ...MATCHES[0], games: [{ bansA: ['Fanny', ' Ling '], bansB: ['Fanny'] }] })).toEqual([
      'Fanny',
      'Ling',
      'Fanny',
    ]);
    expect(bansOf({ ...MATCHES[0], games: JSON.stringify({ bans: ['Yve'] }) })).toEqual(['Yve']);

    const withBans = MATCHES.map((m) =>
      m.id === 'm1' ? { ...m, games: [{ bansA: ['Yve'], bansB: ['Fanny'] }] } : m,
    );
    const meta = computeMeta(withBans, PLAYERS);
    expect(meta.banSource).toBe('match-games');
    expect(meta.matchesWithBans).toBe(1);
    expect(meta.mostBanned.map((h) => [h.hero, h.bans, h.banRate])).toEqual([
      ['Fanny', 1, 100],
      ['Yve', 1, 100],
    ]);
    // A banned-only hero still appears with zero picks.
    expect(meta.heroes.find((h) => h.hero === 'Yve')).toMatchObject({ picks: 0, pickRate: 0 });
  });
});

describe('computeRecords', () => {
  it('finds the single-game records over the season', () => {
    const rec = computeRecords(MATCHES, PLAYERS, { period: 'season' });
    expect(rec.period).toBe('season');
    expect(rec.window).toBeNull();
    expect(rec.matches).toBe(4);
    expect(rec.topKills).toMatchObject({ value: 10, userId: 'u1', matchId: 'm1', hero: 'Fanny' });
    expect(rec.topAssists).toMatchObject({ value: 15, userId: 'u2', matchId: 'm3' });
    expect(rec.topDamage).toMatchObject({ value: 120000, userId: 'u3', matchId: 'm2' });
    expect(rec.topGold).toMatchObject({ value: 15000, userId: 'u3' });
    expect(rec.topKda).toMatchObject({ value: 15, userId: 'u2', matchId: 'm3' });
    expect(rec.longestGame).toBeNull();
    // m1 and m3 are both 2-0: the most recent one wins the tie.
    expect(rec.biggestMargin).toMatchObject({ value: 2, matchId: 'm3', scoreA: 2, scoreB: 0 });
  });

  it('restricts the week period to the rolling window', () => {
    const rec = computeRecords(MATCHES, PLAYERS, { period: 'week', now: day(14) });
    expect(rec.matches).toBe(2);
    expect(rec.topKills).toMatchObject({ value: 7, userId: 'u1', matchId: 'm3' });
    // No damage/gold recorded on the games of the week.
    expect(rec.topDamage).toBeNull();
    expect(rec.topGold).toBeNull();
    expect(rec.biggestMargin?.matchId).toBe('m3');

    const empty = computeRecords(MATCHES, PLAYERS, { period: 'week', now: day(30) });
    expect(empty.matches).toBe(0);
    expect(empty.topKills).toBeNull();
    expect(empty.biggestMargin).toBeNull();
  });
});
