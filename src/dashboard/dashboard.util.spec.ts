import { Participation } from '../stats/player-stats.util';
import {
  ActivityEvent,
  UpcomingItem,
  badgeTimeline,
  countersToQuickStats,
  mergeFeed,
  parseLooseDate,
  quickStatsOf,
  rankOf,
  registeredTeamIds,
  sortUpcoming,
  startOfDay,
} from './dashboard.util';
import { computePlayerStats } from '../stats/player-stats.util';

const day = (n: number) => new Date(Date.UTC(2026, 0, n, 12));

const part = (n: number, result: Participation['result'], over: Partial<Participation> = {}): Participation => ({
  matchId: `m${n}`,
  teamId: 'A',
  seasonId: null,
  date: day(n),
  result,
  hero: 'Lancelot',
  role: 'jungle',
  kills: 5,
  deaths: 1,
  assists: 5,
  isMvp: false,
  ...over,
});

const ev = (id: string, n: number): ActivityEvent => ({
  id,
  type: 'post',
  date: day(n),
  data: {},
  link: null,
});

const up = (id: string, date: Date | null): UpcomingItem => ({
  id,
  kind: 'esport_match',
  date,
  data: {},
  link: null,
});

describe('mergeFeed', () => {
  it('merges sources newest first and caps the length', () => {
    const out = mergeFeed([[ev('a', 1), ev('b', 5)], [ev('c', 3)], [ev('d', 9)]], 3);
    expect(out.map((e) => e.id)).toEqual(['d', 'b', 'c']);
  });

  it('drops events with an invalid date and orders ties by id', () => {
    const bad = { ...ev('x', 1), date: new Date('nope') };
    const out = mergeFeed([[ev('b', 2), bad, ev('a', 2)]]);
    expect(out.map((e) => e.id)).toEqual(['a', 'b']);
  });
});

describe('badgeTimeline', () => {
  it('dates each badge at the match that unlocked it, once', () => {
    const parts = [part(3, 'win', { isMvp: true }), part(1, 'loss'), part(2, 'win')];
    const out = badgeTimeline(parts);
    const byBadge = Object.fromEntries(out.map((b) => [b.badge, b.date.getTime()]));
    expect(byBadge.first_win).toBe(day(2).getTime());
    expect(byBadge.mvp_1).toBe(day(3).getTime());
    expect(out.filter((b) => b.badge === 'first_win')).toHaveLength(1);
  });

  it('is empty without matches', () => {
    expect(badgeTimeline([])).toEqual([]);
  });
});

describe('rankOf', () => {
  it('returns the 1-based position or null', () => {
    const entries = [{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }];
    expect(rankOf(entries, 'u2')).toBe(2);
    expect(rankOf(entries, 'zz')).toBeNull();
  });
});

describe('sortUpcoming', () => {
  const now = new Date(Date.UTC(2026, 0, 10, 15, 30));

  it('keeps today and future events, unscheduled last, sorted ascending', () => {
    const items = [
      up('future', day(12)),
      up('past', day(9)),
      up('today-earlier', new Date(Date.UTC(2026, 0, 10, 8))),
      up('none', null),
      up('soon', day(11)),
    ];
    expect(sortUpcoming(items, now).map((i) => i.id)).toEqual([
      'today-earlier',
      'soon',
      'future',
      'none',
    ]);
  });

  it('applies the limit after sorting', () => {
    const items = [up('c', day(13)), up('a', day(11)), up('b', day(12))];
    expect(sortUpcoming(items, now, 2).map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('startOfDay floors to midnight UTC', () => {
    expect(startOfDay(now).toISOString()).toBe('2026-01-10T00:00:00.000Z');
  });
});

describe('parseLooseDate', () => {
  it('accepts ISO strings, plain dates and Date objects', () => {
    expect(parseLooseDate('2026-04-15')?.toISOString()).toBe('2026-04-15T00:00:00.000Z');
    expect(parseLooseDate(day(3))).toEqual(day(3));
    expect(parseLooseDate('')).toBeNull();
    expect(parseLooseDate('not a date')).toBeNull();
    expect(parseLooseDate(null)).toBeNull();
  });
});

describe('registeredTeamIds', () => {
  it('reads both legacy id lists and team objects', () => {
    expect(registeredTeamIds('["t1","t2"]')).toEqual(['t1', 't2']);
    expect(registeredTeamIds('[{"id":"t3","name":"X"},{"name":"no id"}]')).toEqual(['t3']);
    expect(registeredTeamIds('{bad json')).toEqual([]);
    expect(registeredTeamIds(undefined)).toEqual([]);
  });
});

describe('quickStatsOf', () => {
  it('picks the widget figures from the full stats', () => {
    const s = computePlayerStats([part(1, 'win'), part(2, 'win'), part(3, 'loss')]);
    const q = quickStatsOf(s);
    expect(q).toMatchObject({ games: 3, wins: 2, losses: 1, currentStreak: -1, bestStreak: 2 });
    expect(q.form).toEqual(['win', 'win', 'loss']);
    expect(q).not.toHaveProperty('heroes');
  });
});

describe('countersToQuickStats', () => {
  it('derives the widget figures from the user counters', () => {
    expect(countersToQuickStats({ wins: 44, losses: 16, mvpCount: 3, streak: -2 })).toMatchObject({
      games: 60,
      winRate: 73.3,
      mvpCount: 3,
      currentStreak: -2,
      bestStreak: 0,
      form: [],
    });
    expect(countersToQuickStats(null).games).toBe(0);
  });
});
