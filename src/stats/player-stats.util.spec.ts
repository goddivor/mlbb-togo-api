import {
  Participation,
  bestWinStreak,
  computeBadges,
  computePlayerStats,
  currentStreak,
  kdaOf,
  mergeBadges,
  resultFor,
  winRateOf,
} from './player-stats.util';

const part = (over: Partial<Participation> = {}): Participation => ({
  matchId: 'm',
  teamId: 'A',
  seasonId: null,
  date: new Date('2026-03-10T00:00:00Z'),
  result: 'win',
  hero: 'Lancelot',
  role: 'jungle',
  kills: 5,
  deaths: 2,
  assists: 3,
  isMvp: false,
  ...over,
});

describe('player-stats helpers', () => {
  it('computes KDA with a floor of one death', () => {
    expect(kdaOf(4, 0, 2)).toBe(6);
    expect(kdaOf(5, 2, 3)).toBe(4);
    expect(kdaOf(1, 3, 1)).toBe(0.67);
  });

  it('computes win rate on decisive games only', () => {
    expect(winRateOf(0, 0)).toBe(0);
    expect(winRateOf(2, 1)).toBe(66.7);
  });

  it('derives the result from the winner team', () => {
    expect(resultFor('A', 'A')).toBe('win');
    expect(resultFor('B', 'A')).toBe('loss');
    expect(resultFor(null, 'A')).toBe('draw');
  });

  it('computes current and best streaks, ignoring draws', () => {
    const list = ['win', 'win', 'loss', 'win', 'draw', 'win', 'win'].map((r) =>
      part({ result: r as any }),
    );
    expect(bestWinStreak(list)).toBe(3);
    expect(currentStreak(list)).toBe(3);
    expect(currentStreak([part({ result: 'win' }), part({ result: 'loss' }), part({ result: 'loss' })])).toBe(-2);
    expect(currentStreak([])).toBe(0);
  });
});

describe('computePlayerStats', () => {
  it('returns zeroed stats without participations', () => {
    const s = computePlayerStats([]);
    expect(s.games).toBe(0);
    expect(s.winRate).toBe(0);
    expect(s.kda).toBe(0);
    expect(s.form).toEqual([]);
    expect(s.heroes).toEqual([]);
    expect(s.firstMatchAt).toBeNull();
  });

  it('aggregates totals, heroes, roles and periods in chronological order', () => {
    const list: Participation[] = [
      part({ matchId: '3', date: new Date('2026-04-02T00:00:00Z'), result: 'loss', hero: 'Layla', role: 'gold', kills: 1, deaths: 5, assists: 2 }),
      part({ matchId: '1', date: new Date('2026-03-01T00:00:00Z'), result: 'win', isMvp: true, seasonId: 's1' }),
      part({ matchId: '2', date: new Date('2026-03-15T00:00:00Z'), result: 'win', kills: 7, deaths: 1, assists: 4, seasonId: 's1' }),
    ];
    const s = computePlayerStats(list, new Map([['s1', 'Season 1']]));
    expect(s.games).toBe(3);
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(1);
    expect(s.winRate).toBe(66.7);
    expect(s.mvpCount).toBe(1);
    expect(s.kills).toBe(13);
    expect(s.kda).toBe(kdaOf(13, 8, 9));
    expect(s.form).toEqual(['win', 'win', 'loss']);
    expect(s.currentStreak).toBe(-1);
    expect(s.bestStreak).toBe(2);
    expect(s.heroes.map((h) => h.key)).toEqual(['Lancelot', 'Layla']);
    expect(s.heroes[0]).toMatchObject({ games: 2, wins: 2, winRate: 100, mvp: 1 });
    expect(s.roles.map((r) => r.key)).toEqual(['jungle', 'gold']);
    expect(s.byMonth.map((p) => p.key)).toEqual(['2026-03', '2026-04']);
    expect(s.byMonth[0]).toMatchObject({ games: 2, winRate: 100 });
    expect(s.bySeason).toEqual([expect.objectContaining({ key: 's1', label: 'Season 1', games: 2 })]);
    expect(s.firstMatchAt).toEqual(new Date('2026-03-01T00:00:00Z'));
    expect(s.lastMatchAt).toEqual(new Date('2026-04-02T00:00:00Z'));
  });

  it('keeps only the last 10 results in the form', () => {
    const list = Array.from({ length: 12 }, (_, i) =>
      part({ matchId: String(i), date: new Date(2026, 0, i + 1), result: i < 2 ? 'loss' : 'win' }),
    );
    const s = computePlayerStats(list);
    expect(s.form).toHaveLength(10);
    expect(s.form.every((r) => r === 'win')).toBe(true);
    expect(s.formWinRate).toBe(100);
  });
});

describe('computeBadges', () => {
  const stats = (over: Partial<ReturnType<typeof computePlayerStats>> = {}) => ({
    ...computePlayerStats([]),
    ...over,
  });

  it('awards nothing to a newcomer', () => {
    expect(computeBadges(stats())).toEqual([]);
  });

  it('awards win, game, mvp and streak thresholds', () => {
    const b = computeBadges(stats({ wins: 25, games: 50, mvpCount: 5, bestStreak: 5 }));
    expect(b).toEqual(
      expect.arrayContaining(['first_win', 'wins_10', 'wins_25', 'games_10', 'games_50', 'mvp_1', 'mvp_5', 'streak_3', 'streak_5']),
    );
    expect(b).not.toContain('wins_50');
    expect(b).not.toContain('games_100');
    expect(b).not.toContain('mvp_10');
    expect(b).not.toContain('streak_10');
  });

  it('requires ten games for the KDA badges', () => {
    expect(computeBadges(stats({ games: 5, kda: 6 }))).not.toContain('kda_3');
    const b = computeBadges(stats({ games: 10, kda: 5 }));
    expect(b).toEqual(expect.arrayContaining(['kda_3', 'kda_5']));
  });

  it('awards hero mastery and flexibility from breakdowns', () => {
    const bd = (key: string, games: number, winRate = 0) => ({
      key, games, wins: 0, losses: 0, winRate, kills: 0, deaths: 0, assists: 0, kda: 0, mvp: 0,
    });
    const b = computeBadges(
      stats({
        heroes: [bd('Lancelot', 10, 60)],
        roles: [bd('jungle', 3), bd('mid', 3), bd('gold', 3)],
      }),
    );
    expect(b).toEqual(expect.arrayContaining(['hero_master', 'flex']));
    expect(computeBadges(stats({ heroes: [bd('Lancelot', 9, 90)] }))).not.toContain('hero_master');
    expect(computeBadges(stats({ roles: [bd('jungle', 3), bd('mid', 2)] }))).not.toContain('flex');
  });

  it('is deterministic (same stats, same badges)', () => {
    const s = stats({ wins: 10, games: 12 });
    expect(computeBadges(s)).toEqual(computeBadges(s));
  });
});

describe('mergeBadges', () => {
  it('keeps unmanaged badges and replaces the managed ones', () => {
    const out = mergeBadges(['founder', 'wins_50', 'first_win'], ['first_win']);
    expect(out).toEqual(['founder', 'first_win']);
  });

  it('is idempotent', () => {
    const once = mergeBadges(['founder'], ['first_win', 'mvp_1']);
    expect(mergeBadges(once, ['first_win', 'mvp_1'])).toEqual(once);
  });
});
