import {
  ACHIEVEMENTS,
  AchievementContext,
  MISSIONS,
  dayKey,
  levelFromXp,
  levelProgress,
  newlyUnlocked,
  periodEnd,
  periodKey,
  weekKey,
  xpForLevel,
} from './gamification.rules';

const ctx = (over: Partial<AchievementContext> = {}): AchievementContext => ({
  level: 1,
  xp: 0,
  counts: {},
  missionsCompleted: 0,
  badges: [],
  ...over,
});

describe('level curve', () => {
  it('starts at level 1 with 0 XP', () => {
    expect(xpForLevel(1)).toBe(0);
    expect(xpForLevel(0)).toBe(0);
    expect(levelFromXp(0)).toBe(1);
  });

  it('needs 100 * n^1.5 cumulative XP for level n', () => {
    expect(xpForLevel(2)).toBe(283);
    expect(xpForLevel(4)).toBe(800);
    expect(xpForLevel(9)).toBe(2700);
    expect(xpForLevel(10)).toBe(3162);
  });

  it('is strictly increasing', () => {
    for (let n = 2; n < 60; n++) expect(xpForLevel(n)).toBeGreaterThan(xpForLevel(n - 1));
  });

  it('maps XP back to the highest reached level', () => {
    expect(levelFromXp(282)).toBe(1);
    expect(levelFromXp(283)).toBe(2);
    expect(levelFromXp(799)).toBe(3);
    expect(levelFromXp(800)).toBe(4);
    expect(levelFromXp(3162)).toBe(10);
    expect(levelFromXp(-50)).toBe(1);
  });

  it('exposes progress within the current level', () => {
    const p = levelProgress(500);
    expect(p.level).toBe(2);
    expect(p.currentLevelXp).toBe(283);
    expect(p.nextLevelXp).toBe(520);
    expect(p.xpIntoLevel).toBe(217);
    expect(p.xpToNext).toBe(20);
    expect(p.percent).toBe(91);
  });

  it('caps at the maximum level', () => {
    const p = levelProgress(10_000_000);
    expect(p.nextLevelXp).toBeNull();
    expect(p.xpToNext).toBeNull();
    expect(p.percent).toBe(100);
  });
});

describe('periods', () => {
  it('builds UTC day keys', () => {
    expect(dayKey(new Date('2026-09-17T23:30:00Z'))).toBe('2026-09-17');
    expect(dayKey(new Date('2026-01-05T00:00:00Z'))).toBe('2026-01-05');
  });

  it('builds ISO week keys (Monday based)', () => {
    expect(weekKey(new Date('2026-09-14T00:00:00Z'))).toBe('2026-W38'); // Monday
    expect(weekKey(new Date('2026-09-20T23:59:59Z'))).toBe('2026-W38'); // Sunday
    expect(weekKey(new Date('2026-09-21T00:00:00Z'))).toBe('2026-W39');
    expect(weekKey(new Date('2027-01-01T12:00:00Z'))).toBe('2026-W53');
  });

  it('rolls daily missions over at midnight UTC', () => {
    const d = new Date('2026-09-17T15:00:00Z');
    expect(periodKey('daily', d)).toBe('2026-09-17');
    expect(periodEnd('daily', d).toISOString()).toBe('2026-09-18T00:00:00.000Z');
  });

  it('rolls weekly missions over on Monday', () => {
    const d = new Date('2026-09-17T15:00:00Z'); // Thursday
    expect(periodEnd('weekly', d).toISOString()).toBe('2026-09-21T00:00:00.000Z');
    const sunday = new Date('2026-09-20T10:00:00Z');
    expect(periodEnd('weekly', sunday).toISOString()).toBe('2026-09-21T00:00:00.000Z');
    const monday = new Date('2026-09-21T10:00:00Z');
    expect(periodEnd('weekly', monday).toISOString()).toBe('2026-09-28T00:00:00.000Z');
  });
});

describe('definitions', () => {
  it('have unique mission and achievement ids', () => {
    expect(new Set(MISSIONS.map((m) => m.id)).size).toBe(MISSIONS.length);
    expect(new Set(ACHIEVEMENTS.map((a) => a.id)).size).toBe(ACHIEVEMENTS.length);
  });
});

describe('achievement conditions', () => {
  it('unlocks nothing for a blank context', () => {
    expect(newlyUnlocked(ctx(), [])).toEqual([]);
  });

  it('unlocks first_steps and first_match after the first match', () => {
    const ids = newlyUnlocked(ctx({ xp: 50, counts: { match_played: 1 } }), []).map((a) => a.id);
    expect(ids).toEqual(['first_steps', 'first_match']);
  });

  it('skips already unlocked achievements', () => {
    const ids = newlyUnlocked(ctx({ xp: 50, counts: { match_played: 1 } }), ['first_steps']).map(
      (a) => a.id,
    );
    expect(ids).toEqual(['first_match']);
  });

  it('unlocks tiered achievements only once their threshold is met', () => {
    const at9 = newlyUnlocked(ctx({ xp: 1, counts: { match_win: 9 } }), ['first_steps']).map(
      (a) => a.id,
    );
    expect(at9).toEqual(['first_win']);
    const at10 = newlyUnlocked(ctx({ xp: 1, counts: { match_win: 10 } }), ['first_steps']).map(
      (a) => a.id,
    );
    expect(at10).toEqual(['first_win', 'wins_10']);
  });

  it('unlocks level based achievements', () => {
    const ids = newlyUnlocked(ctx({ xp: 1200, level: 5 }), ['first_steps']).map((a) => a.id);
    expect(ids).toEqual(['level_5']);
  });

  it('builds on esport badges for secret achievements', () => {
    const ids = newlyUnlocked(ctx({ xp: 1, badges: ['streak_5', 'hero_master'] }), [
      'first_steps',
    ]).map((a) => a.id);
    expect(ids).toEqual(['on_fire', 'hero_master']);
  });

  it('counts completed missions', () => {
    const ids = newlyUnlocked(ctx({ xp: 1, missionsCompleted: 10 }), ['first_steps']).map(
      (a) => a.id,
    );
    expect(ids).toEqual(['mission_master']);
  });
});
