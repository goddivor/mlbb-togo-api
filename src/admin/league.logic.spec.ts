import {
  awardsCoverage,
  buildChecklist,
  checklistReady,
  countMatches,
  countRecent,
  hasScoresheet,
} from './league.logic';

const NOW = new Date('2026-09-19T12:00:00Z');
const day = (offset: number) => new Date(NOW.getTime() + offset * 24 * 60 * 60 * 1000);

const match = (over: Record<string, any> = {}) => ({
  id: over.id ?? Math.random().toString(36).slice(2),
  status: 'scheduled',
  type: 'official',
  stage: null,
  scheduledAt: null,
  updatedAt: null,
  games: null,
  ...over,
});

describe('league.logic', () => {
  describe('hasScoresheet', () => {
    it('is true with player rows or parsed games', () => {
      expect(hasScoresheet(match(), 0)).toBe(false);
      expect(hasScoresheet(match(), 2)).toBe(true);
      const games = JSON.stringify([{ number: 1, winnerTeamId: 'a', duration: 900, mvpUserId: null, screenshot: null }]);
      expect(hasScoresheet(match({ games }), 0)).toBe(true);
      expect(hasScoresheet(match({ games: 'not json' }), 0)).toBe(false);
    });
  });

  describe('countMatches', () => {
    it('counts by status, stage, week, pending results and dates', () => {
      const rows = [
        match({ id: 'done-fresh', status: 'completed', updatedAt: day(-2) }),
        match({ id: 'done-old', status: 'completed', updatedAt: day(-20), stage: 'playoff' }),
        match({ id: 'done-sheet', status: 'completed', updatedAt: day(-1) }),
        match({ id: 'sched-nodate', status: 'scheduled', type: 'friendly' }),
        match({ id: 'sched-past', status: 'scheduled', scheduledAt: day(-3) }),
        match({ id: 'sched-future', status: 'scheduled', scheduledAt: day(3) }),
        match({ id: 'cancelled', status: 'cancelled' }),
      ];
      const counts = countMatches(rows, new Map([['done-sheet', 10]]), NOW);
      expect(counts.total).toBe(7);
      expect(counts.byStatus).toEqual({ scheduled: 3, completed: 3, cancelled: 1 });
      expect(counts.byStage).toEqual({ scrim: 1, league: 5, playoff: 1 });
      expect(counts.completedThisWeek).toBe(2);
      expect(counts.pendingResults).toBe(2);
      expect(counts.unscheduled).toBe(1);
      expect(counts.overdue).toBe(1);
    });

    it('handles an empty season', () => {
      const counts = countMatches([], new Map(), NOW);
      expect(counts.total).toBe(0);
      expect(counts.pendingResults).toBe(0);
    });
  });

  describe('awardsCoverage', () => {
    it('reports filled fixed categories and custom awards', () => {
      const cov = awardsCoverage([{ category: 'mvp' }, { category: 'best_mid' }, { category: 'custom' }, { category: 'custom' }]);
      expect(cov.filled).toBe(2);
      expect(cov.total).toBe(6);
      expect(cov.missing).toEqual(['best_gold', 'best_jungle', 'best_roam', 'best_exp']);
      expect(cov.custom).toBe(2);
    });
  });

  describe('buildChecklist', () => {
    const base = {
      seasonId: 'abc',
      counts: countMatches([], new Map(), NOW),
      awards: { filled: 6, total: 6, missing: [], custom: 0 },
      podiums: { regular: true, playoffs: false },
      summaryAvailable: true,
    };

    it('is ready when everything is resolved', () => {
      const items = buildChecklist(base);
      expect(items.map((i) => i.key)).toEqual(['matchesResolved', 'scoresheets', 'awards', 'podiums', 'summary']);
      expect(checklistReady(items)).toBe(true);
      expect(items.every((i) => i.remaining === 0)).toBe(true);
    });

    it('flags remaining work with deep links', () => {
      const counts = countMatches([match({ status: 'scheduled' }), match({ id: 'x', status: 'completed' })], new Map(), NOW);
      const items = buildChecklist({
        ...base,
        counts,
        awards: { filled: 4, total: 6, missing: ['best_roam', 'best_exp'], custom: 0 },
        podiums: { regular: false, playoffs: false },
        summaryAvailable: false,
      });
      expect(checklistReady(items)).toBe(false);
      const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
      expect(byKey.matchesResolved).toMatchObject({ done: false, remaining: 1, href: '/admin/matches?season=abc&status=scheduled' });
      expect(byKey.scoresheets).toMatchObject({ done: false, remaining: 1, href: '/admin/matches?season=abc&status=pending' });
      expect(byKey.awards).toMatchObject({ done: false, remaining: 2, href: '/admin/awards?season=abc' });
      expect(byKey.podiums.done).toBe(false);
      expect(byKey.summary.done).toBe(false);
    });
  });

  describe('countRecent', () => {
    it('counts rows within the window', () => {
      const rows = [{ createdAt: day(-1) }, { createdAt: day(-6) }, { createdAt: day(-8) }, { createdAt: 'bad' }];
      expect(countRecent(rows, NOW)).toBe(2);
    });
  });
});
