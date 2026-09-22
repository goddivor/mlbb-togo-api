import {
  ACHIEVEMENTS,
  ACHIEVEMENT_FAMILIES,
  AchievementContext,
  AchievementFacts,
  achievementsFor,
  cappedDailyCount,
  factsNeeded,
  getAchievement,
  longestDayGap,
  longestDayStreak,
  newlyUnlocked,
} from './achievements.catalog';
import { FRAMES } from '../rewards/frames.catalog';

const NOW = new Date('2026-09-21T12:00:00Z');

const ctx = (over: Partial<AchievementContext> = {}, facts: AchievementFacts = {}): AchievementContext => ({
  level: 1,
  xp: 0,
  counts: {},
  missionsCompleted: 0,
  badges: [],
  achievementCount: 0,
  now: NOW,
  facts,
  ...over,
});

const days = (from: string, n: number) =>
  Array.from({ length: n }, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));

const EXISTING = [
  'first_steps', 'first_match', 'matches_10', 'matches_50', 'first_win', 'wins_10', 'mvp_1', 'mvp_5',
  'competitor', 'veteran', 'chatterbox', 'columnist', 'social', 'popular', 'regular', 'devoted',
  'level_5', 'level_10', 'level_25', 'mission_master', 'on_fire', 'hero_master',
];

describe('achievements catalogue', () => {
  it('has the 118 achievements of catalogue §3 with unique ids', () => {
    expect(ACHIEVEMENTS).toHaveLength(118);
    expect(new Set(ACHIEVEMENTS.map((a) => a.id)).size).toBe(118);
  });

  it('keeps the 22 existing ids', () => {
    for (const id of EXISTING) expect(getAchievement(id)).toBeDefined();
  });

  it('matches the family breakdown of catalogue §3.12', () => {
    const expected: Record<string, number> = {
      competition: 22, league: 12, tournaments: 10, draft: 9, social: 11, community: 10,
      progression: 14, loyalty: 8, exploration: 7, events: 8, secrets: 7,
    };
    for (const f of ACHIEVEMENT_FAMILIES) {
      expect([f, ACHIEVEMENTS.filter((a) => a.family === f).length]).toEqual([f, expected[f]]);
    }
  });

  it('only hides the 7 secret achievements (on_fire and hero_master are public now)', () => {
    const secret = ACHIEVEMENTS.filter((a) => a.secret).map((a) => a.id).sort();
    expect(secret).toEqual(
      ['brothers_in_arms', 'clean_sweep', 'comeback', 'invincibles', 'marathon', 'night_owl', 'remontada'].sort(),
    );
  });

  it('keeps XP within the rarity grid', () => {
    const range: Record<string, [number, number]> = {
      common: [15, 60],
      rare: [75, 250],
      epic: [250, 500],
      legendary: [500, 1500],
      mythic: [1500, 2500],
    };
    for (const a of ACHIEVEMENTS) {
      const [min, max] = range[a.rarity];
      expect([a.id, a.reward >= min && a.reward <= max]).toEqual([a.id, true]);
    }
  });

  it('links every achievement frame of the frames catalogue to an existing achievement', () => {
    for (const f of FRAMES.filter((x) => x.achievement)) {
      expect([f.id, !!getAchievement(f.achievement)]).toEqual([f.id, true]);
    }
  });

  it('declares triggers for every condition based achievement', () => {
    for (const a of ACHIEVEMENTS.filter((x) => !x.manual)) expect([a.id, a.triggers.length > 0]).toEqual([a.id, true]);
  });
});

describe('achievement conditions (table)', () => {
  const cases: [string, AchievementContext, boolean][] = [
    ['matches_100', ctx({ counts: { match_played: 99 } }), false],
    ['matches_100', ctx({ counts: { match_played: 100 } }), true],
    ['wins_50', ctx({ counts: { match_win: 50 } }), true],
    ['mvp_10', ctx({ counts: { match_mvp: 9 } }), false],
    ['untouchable', ctx({ badges: ['streak_10'] }), true],
    ['kda_5', ctx({ badges: ['kda_3'] }), false],
    ['flawless', ctx({}, { matches: { flawless: true } as any }), true],
    ['rampage', ctx({}, { matches: { maxKills: 12 } as any }), true],
    ['rampage', ctx({}, { matches: { maxKills: 11 } as any }), false],
    ['guardian_angel', ctx({}, { matches: { maxAssists: 20 } as any }), true],
    ['five_lanes', ctx({}, { matches: { rolesWith3: 4 } as any }), false],
    ['five_lanes', ctx({}, { matches: { rolesWith3: 5 } as any }), true],
    ['peak_mythic', ctx({}, { user: { peakRankLevel: 135 } as any }), false],
    ['peak_mythic', ctx({}, { user: { peakRankLevel: 136 } as any }), true],
    ['peak_immortal', ctx({}, { user: { peakRankLevel: 236 } as any }), true],
    ['season_rookie', ctx({ counts: { season_participation: 1 } }), true],
    ['season_starter', ctx({}, { seasons: { maxLeagueMatchesInSeason: 8, awards: [] } }), true],
    ['seasons_5', ctx({ counts: { season_participation: 4 } }), false],
    ['season_champion', ctx({ counts: { season_win: 1 } }), true],
    ['dynasty', ctx({ counts: { season_win: 1 } }), false],
    ['dynasty', ctx({ counts: { season_win: 2 } }), true],
    ['season_mvp', ctx({}, { seasons: { maxLeagueMatchesInSeason: 0, awards: ['mvp'] } }), true],
    ['best_in_lane', ctx({}, { seasons: { maxLeagueMatchesInSeason: 0, awards: ['best_roam'] } }), true],
    ['best_in_lane', ctx({}, { seasons: { maxLeagueMatchesInSeason: 0, awards: ['custom'] } }), false],
    ['honoured', ctx({}, { seasons: { maxLeagueMatchesInSeason: 0, awards: ['custom'] } }), true],
    ['captain', ctx({}, { team: { captain: true, founder: false } }), true],
    ['circuit_regular', ctx({ counts: { tournament_registration: 15 } }), true],
    ['trophy_hunter', ctx({ counts: { tournament_win: 2 } }), false],
    ['home_turf', ctx({}, { tournamentCities: { home: true, distinct: 1 } }), true],
    ['togo_tour', ctx({}, { tournamentCities: { home: false, distinct: 3 } }), true],
    ['draft_signup', ctx({}, { drafts: { registrations: 1 } as any }), true],
    ['mercenary', ctx({}, { drafts: { tournamentsPlayed: 5 } as any }), true],
    ['all_formats', ctx({}, { drafts: { categories: 2 } as any }), false],
    ['off_role_win', ctx({}, { drafts: { offRoleWins: 1 } as any }), true],
    ['draft_champion', ctx({}, { drafts: { championships: 1 } as any }), true],
    ['draft_mastermind', ctx({ counts: { pickban_completed: 100 } }), true],
    ['networker', ctx({}, { friends: { accepted: 25 } }), true],
    ['scene_icon', ctx({}, { friends: { accepted: 49 } }), false],
    ['icebreaker', ctx({}, { messages: { direct: 1, groupCounted: 0 } }), true],
    ['lounge_regular', ctx({}, { messages: { direct: 0, groupCounted: 100 } }), true],
    ['talk_of_the_town', ctx({}, { mentions: { distinctAuthors: 10 } }), true],
    ['applicant', ctx({}, { recruitment: { applications: 1, accepted: 0 } }), true],
    ['signed', ctx({ counts: { recruitment_accepted: 1 } }), true],
    ['talent_scout', ctx({ counts: { recruitment_hire: 3 } }), true],
    ['team_founder', ctx({}, { team: { captain: false, founder: true } }), true],
    ['first_words', ctx({ counts: { forum_post: 1 } }), true],
    ['golden_quill', ctx({ counts: { forum_post: 100 } }), true],
    ['debater', ctx({ counts: { comment_posted: 99 } }), false],
    ['liked', ctx({ counts: { like_received: 50 } }), true],
    ['community_voice', ctx({ counts: { like_received: 1000 } }), true],
    ['viral', ctx({}, { likes: { maxOnOnePost: 50 } }), true],
    ['level_50', ctx({ level: 50 }), true],
    ['level_200', ctx({ level: 199 }), false],
    ['tireless', ctx({ missionsCompleted: 100 }), true],
    ['weekly_sweep', ctx({}, { weeklySweep: true }), true],
    ['collector', ctx({ achievementCount: 49 }), false],
    ['collector', ctx({ achievementCount: 50 }), true],
    ['faithful', ctx({ counts: { daily_login: 100 } }), true],
    ['unconditional', ctx({ counts: { daily_login: 364 } }), false],
    ['perfect_week', ctx({}, { logins: { days: days('2026-09-01', 7), nightLogins: 0, lastLoginAt: NOW } }), true],
    ['perfect_week', ctx({}, { logins: { days: [...days('2026-09-01', 3), ...days('2026-09-05', 4)], nightLogins: 0, lastLoginAt: NOW } }), false],
    ['perfect_month', ctx({}, { logins: { days: days('2026-08-01', 30), nightLogins: 0, lastLoginAt: NOW } }), true],
    [
      'one_year',
      ctx({}, { user: { joinedAt: new Date('2025-09-01T00:00:00Z') } as any, logins: { days: [], nightLogins: 0, lastLoginAt: new Date('2026-09-10T00:00:00Z') } }),
      true,
    ],
    [
      'one_year',
      ctx({}, { user: { joinedAt: new Date('2025-09-01T00:00:00Z') } as any, logins: { days: [], nightLogins: 0, lastLoginAt: new Date('2026-07-01T00:00:00Z') } }),
      false,
    ],
    ['verified_summoner', ctx({}, { user: { hasGame: true } as any }), true],
    ['twin_identity', ctx({}, { user: { hasGame: true, hasGoogle: false } as any }), false],
    ['twin_identity', ctx({}, { user: { hasGame: true, hasGoogle: true } as any }), true],
    ['business_card', ctx({ counts: { profile_completed: 1 } }), true],
    ['on_the_map', ctx({}, { user: { cityKnown: true } as any }), true],
    ['diligent_student', ctx({ counts: { ai_coach_used: 50 } }), true],
    ['spectator', ctx({ counts: { stream_watch: 4 } }), false],
    ['spectator', ctx({ counts: { stream_watch: 5 } }), true],
    ['present', ctx({ counts: { event_joined: 1 } }), true],
    ['unmissable', ctx({ counts: { event_joined: 10 } }), true],
    ['night_owl', ctx({}, { logins: { days: [], nightLogins: 10, lastLoginAt: null } }), true],
    ['comeback', ctx({}, { logins: { days: ['2026-01-01', '2026-03-02'], nightLogins: 0, lastLoginAt: null } }), true],
    ['comeback', ctx({}, { logins: { days: ['2026-01-01', '2026-02-28'], nightLogins: 0, lastLoginAt: null } }), false],
    ['remontada', ctx({}, { matches: { remontada: true } as any }), true],
    ['clean_sweep', ctx({}, { matches: { cleanSweep: true } as any }), true],
    ['marathon', ctx({}, { matches: { maxMatchesSameDay: 4 } as any }), true],
    ['brothers_in_arms', ctx({}, { matches: { bestFriendWins: 10 } as any }), true],
  ];

  it.each(cases)('%s → %s', (id, c, expected) => {
    expect(getAchievement(id)!.condition(c)).toBe(expected);
  });

  it('never unlocks manual achievements by condition', () => {
    const everything = ctx(
      { level: 200, xp: 300_000, missionsCompleted: 500, achievementCount: 117, counts: { season_win: 5 } },
      {},
    );
    const ids = newlyUnlocked(everything, []).map((a) => a.id);
    for (const manual of ['weekly_mvp', 'monthly_number_one', 'pioneer', 'invincibles', 'independence_day', 'rainy_season']) {
      expect(ids).not.toContain(manual);
    }
  });
});

describe('event driven evaluation', () => {
  it('only selects the definitions fed by a trigger', () => {
    const ids = achievementsFor(['forum_post']).map((a) => a.id);
    expect(ids).toEqual(['first_words', 'chatterbox', 'columnist', 'golden_quill']);
  });

  it('re-evaluates level achievements on any XP gain', () => {
    const ids = achievementsFor(['xp']).map((a) => a.id);
    expect(ids).toContain('level_50');
    expect(ids).toContain('first_steps');
    expect(ids).not.toContain('first_match');
  });

  it('loads only the facts the selected definitions need', () => {
    expect([...factsNeeded(achievementsFor(['forum_post']))]).toEqual([]);
    expect([...factsNeeded(achievementsFor(['like_received']))]).toEqual(['likes']);
    expect(factsNeeded(achievementsFor(['match_played'])).has('matches')).toBe(true);
  });

  it('evaluates every condition based definition on a full recalculation', () => {
    expect(achievementsFor(null).length).toBe(ACHIEVEMENTS.filter((a) => !a.manual).length);
  });
});

describe('fact helpers', () => {
  it('computes the longest run of consecutive days', () => {
    expect(longestDayStreak([])).toBe(0);
    expect(longestDayStreak(['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-03'])).toBe(3);
    expect(longestDayStreak(['2026-01-02', '2026-01-01', '2026-01-02'])).toBe(2);
  });

  it('computes the longest absence', () => {
    expect(longestDayGap(['2026-01-01'])).toBe(0);
    expect(longestDayGap(['2026-01-01', '2026-01-11', '2026-01-12'])).toBe(10);
  });

  it('counts at most N lounge messages per day', () => {
    const at = (iso: string) => new Date(iso);
    const dates = [
      ...Array.from({ length: 40 }, () => at('2026-09-01T10:00:00Z')),
      ...Array.from({ length: 5 }, () => at('2026-09-02T10:00:00Z')),
    ];
    expect(cappedDailyCount(dates, 30)).toBe(35);
  });
});
