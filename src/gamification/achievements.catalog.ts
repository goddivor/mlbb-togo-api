// Achievements catalogue (catalogue §3, rewards #125): 118 achievements with
// family, rarity, XP, secret flag, triggers and the facts they need. Pure
// data + pure conditions: no I/O here, everything is unit testable.
//
// Evaluation is event driven: `triggers` lists the signals that can change
// the outcome of a condition, so an XP event only re-evaluates the matching
// definitions, and `needs` lists the (costly) facts to load for them.
// Frames attached to an achievement live in src/rewards/frames.catalog.ts.

import type { XpType } from './gamification.rules';

export const ACHIEVEMENT_FAMILIES = [
  'competition',
  'league',
  'tournaments',
  'draft',
  'social',
  'community',
  'progression',
  'loyalty',
  'exploration',
  'events',
  'secrets',
] as const;
export type AchievementFamily = (typeof ACHIEVEMENT_FAMILIES)[number];

export const RARITIES = ['common', 'rare', 'epic', 'legendary', 'mythic'] as const;
export type Rarity = (typeof RARITIES)[number];

/**
 * Signals: an XP type, `xp` (any positive grant: level based), or a domain
 * signal fired by a module without XP (`profile`, `recruitment`, `draft`,
 * `team`, `season`). `daily_login` doubles as the daily catch-up signal for
 * facts owned by modules that cannot call the engine (messages, mentions).
 */
export type AchievementTrigger = XpType | 'xp' | 'profile' | 'recruitment' | 'draft' | 'team' | 'season';

export type FactKey =
  | 'user'
  | 'matches'
  | 'friends'
  | 'messages'
  | 'mentions'
  | 'recruitment'
  | 'drafts'
  | 'seasons'
  | 'logins'
  | 'tournamentCities'
  | 'likes'
  | 'weeklySweep'
  | 'team';

export interface AchievementFacts {
  user?: {
    joinedAt: Date;
    hasGoogle: boolean;
    hasGame: boolean;
    /** City recognised by src/geo (not "other"). */
    cityKnown: boolean;
    peakRankLevel: number | null;
  };
  matches?: {
    flawless: boolean;
    maxKills: number;
    maxAssists: number;
    /** Roles played in at least 3 completed matches. */
    rolesWith3: number;
    playoffs: boolean;
    remontada: boolean;
    cleanSweep: boolean;
    maxMatchesSameDay: number;
    /** Most wins shared with one accepted friend (same team). */
    bestFriendWins: number;
  };
  friends?: { accepted: number };
  messages?: { direct: number; groupCounted: number };
  mentions?: { distinctAuthors: number };
  recruitment?: { applications: number; accepted: number };
  drafts?: {
    registrations: number;
    tournamentsPlayed: number;
    categories: number;
    wins: number;
    offRoleWins: number;
    championships: number;
  };
  seasons?: { maxLeagueMatchesInSeason: number; awards: string[] };
  logins?: { days: string[]; nightLogins: number; lastLoginAt: Date | null };
  tournamentCities?: { home: boolean; distinct: number };
  likes?: { maxOnOnePost: number };
  weeklySweep?: boolean;
  team?: { captain: boolean; founder: boolean };
}

/** Aggregated facts an achievement condition can look at. */
export interface AchievementContext {
  level: number;
  xp: number;
  /** Number of XP events per type. */
  counts: Partial<Record<XpType, number>>;
  missionsCompleted: number;
  /** Badge keys already derived from esport stats (player-stats.util). */
  badges: string[];
  /** Achievements unlocked so far (collector). */
  achievementCount?: number;
  now?: Date;
  facts?: AchievementFacts;
}

export interface AchievementDef {
  id: string;
  family: AchievementFamily;
  rarity: Rarity;
  icon: string;
  reward: number;
  /** Secret achievements are hidden until unlocked. */
  secret?: boolean;
  /**
   * Granted by a dedicated flow (weekly election, monthly ranking, season
   * close, reward event) rather than by a condition.
   */
  manual?: boolean;
  triggers: AchievementTrigger[];
  needs?: FactKey[];
  condition: (ctx: AchievementContext) => boolean;
}

const DAY = 86_400_000;

const count = (ctx: AchievementContext, type: XpType) => ctx.counts[type] ?? 0;
const facts = (ctx: AchievementContext): AchievementFacts => ctx.facts ?? {};
const never = () => false;

// ----- Pure fact helpers (login streaks, gaps) -----

function dayNumber(key: string): number {
  const t = Date.parse(`${key}T00:00:00Z`);
  return Number.isNaN(t) ? NaN : Math.round(t / DAY);
}

/** Longest run of consecutive UTC days in a list of `YYYY-MM-DD` keys. */
export function longestDayStreak(days: string[]): number {
  const nums = [...new Set(days.map(dayNumber).filter((n) => !Number.isNaN(n)))].sort((a, b) => a - b);
  let best = 0;
  let run = 0;
  for (let i = 0; i < nums.length; i++) {
    run = i > 0 && nums[i] === nums[i - 1] + 1 ? run + 1 : 1;
    best = Math.max(best, run);
  }
  return best;
}

/** Largest gap (in days) between two consecutive login days. */
export function longestDayGap(days: string[]): number {
  const nums = [...new Set(days.map(dayNumber).filter((n) => !Number.isNaN(n)))].sort((a, b) => a - b);
  let gap = 0;
  for (let i = 1; i < nums.length; i++) gap = Math.max(gap, nums[i] - nums[i - 1]);
  return gap;
}

/** Messages counted for `lounge_regular`: at most `perDay` per UTC day. */
export function cappedDailyCount(dates: Date[], perDay: number): number {
  const byDay = new Map<string, number>();
  for (const d of dates) {
    const k = d.toISOString().slice(0, 10);
    byDay.set(k, (byDay.get(k) ?? 0) + 1);
  }
  let total = 0;
  for (const n of byDay.values()) total += Math.min(perDay, n);
  return total;
}

// ----- Definition helpers -----

type Base = Pick<AchievementDef, 'id' | 'family' | 'rarity' | 'icon' | 'reward'> & Partial<AchievementDef>;

function def(d: Base & Pick<AchievementDef, 'triggers' | 'condition'>): AchievementDef {
  return d as AchievementDef;
}

/** Counter based achievement: `count(type) >= n`, re-evaluated on `type`. */
function counter(
  id: string,
  family: AchievementFamily,
  rarity: Rarity,
  reward: number,
  icon: string,
  type: XpType,
  n: number,
  extra: Partial<AchievementDef> = {},
): AchievementDef {
  return def({ id, family, rarity, reward, icon, triggers: [type], condition: (c) => count(c, type) >= n, ...extra });
}

function level(id: string, rarity: Rarity, reward: number, icon: string, n: number): AchievementDef {
  return def({ id, family: 'progression', rarity, reward, icon, triggers: ['xp'], condition: (c) => c.level >= n });
}

function badge(
  id: string,
  rarity: Rarity,
  reward: number,
  icon: string,
  key: string,
): AchievementDef {
  return def({
    id,
    family: 'competition',
    rarity,
    reward,
    icon,
    triggers: ['match_played', 'daily_login'],
    condition: (c) => c.badges.includes(key),
  });
}

function manual(
  id: string,
  family: AchievementFamily,
  rarity: Rarity,
  reward: number,
  icon: string,
  extra: Partial<AchievementDef> = {},
): AchievementDef {
  return def({ id, family, rarity, reward, icon, manual: true, triggers: [], condition: never, ...extra });
}

const LANE_AWARDS = ['best_gold', 'best_mid', 'best_jungle', 'best_roam', 'best_exp'];

export const ACHIEVEMENTS: AchievementDef[] = [
  // ----- 3.1 Competition (22) -----
  counter('first_match', 'competition', 'common', 30, 'swords', 'match_played', 1),
  counter('matches_10', 'competition', 'common', 60, 'swords', 'match_played', 10),
  counter('matches_50', 'competition', 'rare', 150, 'shield', 'match_played', 50),
  counter('matches_100', 'competition', 'epic', 400, 'shield', 'match_played', 100),
  counter('first_win', 'competition', 'common', 40, 'trophy', 'match_win', 1),
  counter('wins_10', 'competition', 'rare', 100, 'trophy', 'match_win', 10),
  counter('wins_50', 'competition', 'epic', 450, 'trophy', 'match_win', 50),
  counter('mvp_1', 'competition', 'rare', 75, 'star', 'match_mvp', 1),
  counter('mvp_5', 'competition', 'epic', 250, 'star', 'match_mvp', 5),
  counter('mvp_10', 'competition', 'legendary', 700, 'star', 'match_mvp', 10),
  manual('weekly_mvp', 'competition', 'epic', 400, 'star'),
  badge('on_fire', 'rare', 150, 'flame', 'streak_5'),
  badge('untouchable', 'legendary', 900, 'flame', 'streak_10'),
  badge('kda_5', 'epic', 350, 'target', 'kda_5'),
  def({
    id: 'flawless',
    family: 'competition',
    rarity: 'epic',
    reward: 300,
    icon: 'shield',
    triggers: ['match_played'],
    needs: ['matches'],
    condition: (c) => !!facts(c).matches?.flawless,
  }),
  def({
    id: 'rampage',
    family: 'competition',
    rarity: 'epic',
    reward: 300,
    icon: 'swords',
    triggers: ['match_played'],
    needs: ['matches'],
    condition: (c) => (facts(c).matches?.maxKills ?? 0) >= 12,
  }),
  def({
    id: 'guardian_angel',
    family: 'competition',
    rarity: 'rare',
    reward: 150,
    icon: 'users',
    triggers: ['match_played'],
    needs: ['matches'],
    condition: (c) => (facts(c).matches?.maxAssists ?? 0) >= 20,
  }),
  badge('hero_master', 'epic', 300, 'crown', 'hero_master'),
  badge('flex', 'rare', 150, 'target', 'flex'),
  def({
    id: 'five_lanes',
    family: 'competition',
    rarity: 'epic',
    reward: 450,
    icon: 'target',
    triggers: ['match_played'],
    needs: ['matches'],
    condition: (c) => (facts(c).matches?.rolesWith3 ?? 0) >= 5,
  }),
  def({
    id: 'peak_mythic',
    family: 'competition',
    rarity: 'epic',
    reward: 300,
    icon: 'crown',
    triggers: ['peak_rank_reached', 'game_account_linked'],
    needs: ['user'],
    condition: (c) => (facts(c).user?.peakRankLevel ?? 0) > 135,
  }),
  def({
    id: 'peak_immortal',
    family: 'competition',
    rarity: 'mythic',
    reward: 1500,
    icon: 'crown',
    triggers: ['peak_rank_reached', 'game_account_linked'],
    needs: ['user'],
    condition: (c) => (facts(c).user?.peakRankLevel ?? 0) > 235,
  }),

  // ----- 3.2 League & seasons (12) -----
  counter('season_rookie', 'league', 'common', 60, 'calendar', 'season_participation', 1),
  def({
    id: 'season_starter',
    family: 'league',
    rarity: 'rare',
    reward: 200,
    icon: 'calendar',
    triggers: ['match_played', 'season_participation'],
    needs: ['seasons'],
    condition: (c) => (facts(c).seasons?.maxLeagueMatchesInSeason ?? 0) >= 8,
  }),
  counter('seasons_3', 'league', 'epic', 400, 'calendar', 'season_participation', 3),
  counter('seasons_5', 'league', 'legendary', 900, 'calendar', 'season_participation', 5),
  def({
    id: 'playoffs_qualified',
    family: 'league',
    rarity: 'rare',
    reward: 150,
    icon: 'medal',
    triggers: ['match_played'],
    needs: ['matches'],
    condition: (c) => !!facts(c).matches?.playoffs,
  }),
  counter('season_podium', 'league', 'epic', 400, 'medal', 'season_podium', 1),
  counter('season_champion', 'league', 'legendary', 1000, 'trophy', 'season_win', 1),
  counter('dynasty', 'league', 'mythic', 2000, 'crown', 'season_win', 2),
  def({
    id: 'season_mvp',
    family: 'league',
    rarity: 'legendary',
    reward: 1500,
    icon: 'star',
    triggers: ['season_award', 'season'],
    needs: ['seasons'],
    condition: (c) => (facts(c).seasons?.awards ?? []).includes('mvp'),
  }),
  def({
    id: 'best_in_lane',
    family: 'league',
    rarity: 'legendary',
    reward: 1000,
    icon: 'star',
    triggers: ['season_award', 'season'],
    needs: ['seasons'],
    condition: (c) => (facts(c).seasons?.awards ?? []).some((a) => LANE_AWARDS.includes(a)),
  }),
  def({
    id: 'honoured',
    family: 'league',
    rarity: 'epic',
    reward: 400,
    icon: 'medal',
    triggers: ['season_award', 'season'],
    needs: ['seasons'],
    condition: (c) => (facts(c).seasons?.awards ?? []).includes('custom'),
  }),
  def({
    id: 'captain',
    family: 'league',
    rarity: 'rare',
    reward: 150,
    icon: 'shield',
    triggers: ['team', 'daily_login'],
    needs: ['team'],
    condition: (c) => !!facts(c).team?.captain,
  }),

  // ----- 3.3 Tournaments (10) -----
  counter('competitor', 'tournaments', 'common', 40, 'medal', 'tournament_registration', 1),
  counter('veteran', 'tournaments', 'rare', 120, 'medal', 'tournament_registration', 5),
  counter('circuit_regular', 'tournaments', 'epic', 350, 'medal', 'tournament_registration', 15),
  counter('bracket_first_win', 'tournaments', 'common', 50, 'swords', 'bracket_win', 1),
  counter('finalist', 'tournaments', 'epic', 300, 'medal', 'tournament_final', 1),
  counter('tournament_winner', 'tournaments', 'legendary', 800, 'trophy', 'tournament_win', 1),
  counter('trophy_hunter', 'tournaments', 'mythic', 2000, 'trophy', 'tournament_win', 3),
  counter('tournament_mvp', 'tournaments', 'legendary', 600, 'star', 'tournament_mvp', 1),
  def({
    id: 'home_turf',
    family: 'tournaments',
    rarity: 'rare',
    reward: 100,
    icon: 'map',
    triggers: ['tournament_registration', 'profile'],
    needs: ['tournamentCities'],
    condition: (c) => !!facts(c).tournamentCities?.home,
  }),
  def({
    id: 'togo_tour',
    family: 'tournaments',
    rarity: 'epic',
    reward: 300,
    icon: 'map',
    triggers: ['tournament_registration'],
    needs: ['tournamentCities'],
    condition: (c) => (facts(c).tournamentCities?.distinct ?? 0) >= 3,
  }),

  // ----- 3.4 Draft & Pick & Ban (9) -----
  def({
    id: 'draft_signup',
    family: 'draft',
    rarity: 'common',
    reward: 30,
    icon: 'users',
    triggers: ['tournament_registration', 'draft'],
    needs: ['drafts'],
    condition: (c) => (facts(c).drafts?.registrations ?? 0) >= 1,
  }),
  def({
    id: 'mercenary',
    family: 'draft',
    rarity: 'rare',
    reward: 150,
    icon: 'users',
    triggers: ['draft', 'bracket_played'],
    needs: ['drafts'],
    condition: (c) => (facts(c).drafts?.tournamentsPlayed ?? 0) >= 5,
  }),
  def({
    id: 'all_formats',
    family: 'draft',
    rarity: 'rare',
    reward: 150,
    icon: 'target',
    triggers: ['draft', 'bracket_played'],
    needs: ['drafts'],
    condition: (c) => (facts(c).drafts?.categories ?? 0) >= 3,
  }),
  def({
    id: 'instant_chemistry',
    family: 'draft',
    rarity: 'common',
    reward: 50,
    icon: 'zap',
    triggers: ['bracket_win', 'draft'],
    needs: ['drafts'],
    condition: (c) => (facts(c).drafts?.wins ?? 0) >= 1,
  }),
  def({
    id: 'off_role_win',
    family: 'draft',
    rarity: 'rare',
    reward: 120,
    icon: 'zap',
    triggers: ['bracket_win', 'draft'],
    needs: ['drafts'],
    condition: (c) => (facts(c).drafts?.offRoleWins ?? 0) >= 1,
  }),
  def({
    id: 'draft_champion',
    family: 'draft',
    rarity: 'legendary',
    reward: 700,
    icon: 'trophy',
    triggers: ['bracket_win', 'draft'],
    needs: ['drafts'],
    condition: (c) => (facts(c).drafts?.championships ?? 0) >= 1,
  }),
  counter('budding_strategist', 'draft', 'common', 25, 'target', 'pickban_completed', 1),
  counter('analyst', 'draft', 'rare', 150, 'target', 'pickban_completed', 25),
  counter('draft_mastermind', 'draft', 'epic', 400, 'crown', 'pickban_completed', 100),

  // ----- 3.5 Social (11) -----
  counter('social', 'social', 'common', 30, 'users', 'friend_added', 1),
  counter('popular', 'social', 'rare', 80, 'users', 'friend_added', 10),
  def({
    id: 'networker',
    family: 'social',
    rarity: 'epic',
    reward: 250,
    icon: 'users',
    triggers: ['friend_added', 'daily_login'],
    needs: ['friends'],
    condition: (c) => (facts(c).friends?.accepted ?? 0) >= 25,
  }),
  def({
    id: 'scene_icon',
    family: 'social',
    rarity: 'legendary',
    reward: 600,
    icon: 'crown',
    triggers: ['friend_added', 'daily_login'],
    needs: ['friends'],
    condition: (c) => (facts(c).friends?.accepted ?? 0) >= 50,
  }),
  def({
    id: 'icebreaker',
    family: 'social',
    rarity: 'common',
    reward: 15,
    icon: 'message',
    triggers: ['daily_login'],
    needs: ['messages'],
    condition: (c) => (facts(c).messages?.direct ?? 0) >= 1,
  }),
  def({
    id: 'lounge_regular',
    family: 'social',
    rarity: 'rare',
    reward: 100,
    icon: 'message',
    triggers: ['daily_login'],
    needs: ['messages'],
    condition: (c) => (facts(c).messages?.groupCounted ?? 0) >= 100,
  }),
  def({
    id: 'talk_of_the_town',
    family: 'social',
    rarity: 'rare',
    reward: 120,
    icon: 'message',
    triggers: ['daily_login'],
    needs: ['mentions'],
    condition: (c) => (facts(c).mentions?.distinctAuthors ?? 0) >= 10,
  }),
  def({
    id: 'applicant',
    family: 'social',
    rarity: 'common',
    reward: 30,
    icon: 'users',
    triggers: ['recruitment'],
    needs: ['recruitment'],
    condition: (c) => (facts(c).recruitment?.applications ?? 0) >= 1,
  }),
  def({
    id: 'signed',
    family: 'social',
    rarity: 'rare',
    reward: 200,
    icon: 'medal',
    triggers: ['recruitment_accepted', 'recruitment'],
    needs: ['recruitment'],
    condition: (c) => count(c, 'recruitment_accepted') >= 1 || (facts(c).recruitment?.accepted ?? 0) >= 1,
  }),
  counter('talent_scout', 'social', 'epic', 300, 'users', 'recruitment_hire', 3),
  def({
    id: 'team_founder',
    family: 'social',
    rarity: 'rare',
    reward: 150,
    icon: 'shield',
    triggers: ['team', 'daily_login'],
    needs: ['team'],
    condition: (c) => !!facts(c).team?.founder,
  }),

  // ----- 3.6 Community & forum (10) -----
  counter('first_words', 'community', 'common', 20, 'message', 'forum_post', 1),
  counter('chatterbox', 'community', 'common', 30, 'message', 'forum_post', 5),
  counter('columnist', 'community', 'rare', 80, 'message', 'forum_post', 25),
  counter('golden_quill', 'community', 'epic', 350, 'message', 'forum_post', 100),
  counter('quick_reply', 'community', 'common', 15, 'message', 'comment_posted', 1),
  counter('debater', 'community', 'rare', 150, 'message', 'comment_posted', 100),
  counter('liked', 'community', 'common', 50, 'heart', 'like_received', 50),
  counter('influencer', 'community', 'rare', 250, 'heart', 'like_received', 250),
  counter('community_voice', 'community', 'legendary', 800, 'heart', 'like_received', 1000),
  def({
    id: 'viral',
    family: 'community',
    rarity: 'epic',
    reward: 400,
    icon: 'heart',
    triggers: ['like_received'],
    needs: ['likes'],
    condition: (c) => (facts(c).likes?.maxOnOnePost ?? 0) >= 50,
  }),

  // ----- 3.7 Progression (14) -----
  def({
    id: 'first_steps',
    family: 'progression',
    rarity: 'common',
    reward: 20,
    icon: 'footprints',
    triggers: ['xp'],
    condition: (c) => c.xp > 0,
  }),
  level('level_5', 'common', 50, 'zap', 5),
  level('level_10', 'common', 60, 'zap', 10),
  level('level_25', 'rare', 150, 'crown', 25),
  level('level_50', 'epic', 300, 'crown', 50),
  level('level_75', 'epic', 450, 'crown', 75),
  level('level_100', 'legendary', 800, 'crown', 100),
  level('level_150', 'legendary', 1200, 'crown', 150),
  level('level_200', 'mythic', 2500, 'crown', 200),
  def({
    id: 'mission_master',
    family: 'progression',
    rarity: 'rare',
    reward: 80,
    icon: 'target',
    triggers: ['mission'],
    condition: (c) => c.missionsCompleted >= 10,
  }),
  def({
    id: 'tireless',
    family: 'progression',
    rarity: 'epic',
    reward: 400,
    icon: 'target',
    triggers: ['mission'],
    condition: (c) => c.missionsCompleted >= 100,
  }),
  def({
    id: 'weekly_sweep',
    family: 'progression',
    rarity: 'rare',
    reward: 200,
    icon: 'target',
    triggers: ['mission'],
    needs: ['weeklySweep'],
    condition: (c) => !!facts(c).weeklySweep,
  }),
  def({
    id: 'collector',
    family: 'progression',
    rarity: 'legendary',
    reward: 800,
    icon: 'crown',
    triggers: ['achievement'],
    condition: (c) => (c.achievementCount ?? 0) >= 50,
  }),
  manual('monthly_number_one', 'progression', 'legendary', 600, 'crown'),

  // ----- 3.8 Loyalty (8) -----
  counter('regular', 'loyalty', 'common', 40, 'sun', 'daily_login', 7),
  counter('devoted', 'loyalty', 'rare', 100, 'sun', 'daily_login', 30),
  counter('faithful', 'loyalty', 'epic', 300, 'sun', 'daily_login', 100),
  counter('unconditional', 'loyalty', 'legendary', 1000, 'sun', 'daily_login', 365),
  def({
    id: 'perfect_week',
    family: 'loyalty',
    rarity: 'common',
    reward: 50,
    icon: 'calendar',
    triggers: ['daily_login'],
    needs: ['logins'],
    condition: (c) => longestDayStreak(facts(c).logins?.days ?? []) >= 7,
  }),
  def({
    id: 'perfect_month',
    family: 'loyalty',
    rarity: 'epic',
    reward: 400,
    icon: 'calendar',
    triggers: ['daily_login'],
    needs: ['logins'],
    condition: (c) => longestDayStreak(facts(c).logins?.days ?? []) >= 30,
  }),
  def({
    id: 'one_year',
    family: 'loyalty',
    rarity: 'rare',
    reward: 200,
    icon: 'calendar',
    triggers: ['daily_login'],
    needs: ['user', 'logins'],
    condition: (c) => {
      const f = facts(c);
      const now = (c.now ?? new Date()).getTime();
      const joined = f.user?.joinedAt?.getTime();
      const last = f.logins?.lastLoginAt?.getTime();
      return joined !== undefined && joined <= now - 365 * DAY && last !== undefined && last >= now - 30 * DAY;
    },
  }),
  manual('pioneer', 'loyalty', 'legendary', 500, 'crown'),

  // ----- 3.9 Site exploration (7) -----
  def({
    id: 'verified_summoner',
    family: 'exploration',
    rarity: 'common',
    reward: 50,
    icon: 'shield',
    triggers: ['game_account_linked', 'profile'],
    needs: ['user'],
    condition: (c) => count(c, 'game_account_linked') >= 1 || !!facts(c).user?.hasGame,
  }),
  def({
    id: 'twin_identity',
    family: 'exploration',
    rarity: 'common',
    reward: 40,
    icon: 'users',
    triggers: ['game_account_linked', 'profile', 'daily_login'],
    needs: ['user'],
    condition: (c) => !!facts(c).user?.hasGoogle && !!facts(c).user?.hasGame,
  }),
  counter('business_card', 'exploration', 'common', 40, 'users', 'profile_completed', 1),
  def({
    id: 'on_the_map',
    family: 'exploration',
    rarity: 'common',
    reward: 25,
    icon: 'map',
    triggers: ['profile', 'daily_login'],
    needs: ['user'],
    condition: (c) => !!facts(c).user?.cityKnown,
  }),
  counter('coach_advice', 'exploration', 'common', 20, 'zap', 'ai_coach_used', 1),
  counter('diligent_student', 'exploration', 'rare', 150, 'zap', 'ai_coach_used', 50),
  counter('spectator', 'exploration', 'rare', 75, 'eye', 'stream_watch', 5),

  // ----- 3.10 Events (8) -----
  counter('present', 'events', 'common', 40, 'calendar', 'event_joined', 1),
  counter('unmissable', 'events', 'rare', 200, 'calendar', 'event_joined', 10),
  manual('independence_day', 'events', 'rare', 100, 'flag'),
  manual('independence_cup', 'events', 'rare', 150, 'trophy'),
  manual('harmattan', 'events', 'rare', 150, 'sun'),
  manual('rainy_season', 'events', 'rare', 150, 'cloud'),
  manual('year_end_lights', 'events', 'rare', 100, 'star'),
  manual('site_anniversary', 'events', 'rare', 100, 'gift'),

  // ----- 3.11 Secrets (7) -----
  def({
    id: 'night_owl',
    family: 'secrets',
    rarity: 'rare',
    reward: 100,
    icon: 'moon',
    secret: true,
    triggers: ['daily_login'],
    needs: ['logins'],
    condition: (c) => (facts(c).logins?.nightLogins ?? 0) >= 10,
  }),
  def({
    id: 'comeback',
    family: 'secrets',
    rarity: 'rare',
    reward: 150,
    icon: 'footprints',
    secret: true,
    triggers: ['daily_login'],
    needs: ['logins'],
    condition: (c) => longestDayGap(facts(c).logins?.days ?? []) >= 60,
  }),
  def({
    id: 'remontada',
    family: 'secrets',
    rarity: 'epic',
    reward: 300,
    icon: 'flame',
    secret: true,
    triggers: ['match_win'],
    needs: ['matches'],
    condition: (c) => !!facts(c).matches?.remontada,
  }),
  def({
    id: 'clean_sweep',
    family: 'secrets',
    rarity: 'epic',
    reward: 300,
    icon: 'zap',
    secret: true,
    triggers: ['match_win'],
    needs: ['matches'],
    condition: (c) => !!facts(c).matches?.cleanSweep,
  }),
  def({
    id: 'marathon',
    family: 'secrets',
    rarity: 'rare',
    reward: 150,
    icon: 'swords',
    secret: true,
    triggers: ['match_played'],
    needs: ['matches'],
    condition: (c) => (facts(c).matches?.maxMatchesSameDay ?? 0) >= 4,
  }),
  def({
    id: 'brothers_in_arms',
    family: 'secrets',
    rarity: 'epic',
    reward: 350,
    icon: 'users',
    secret: true,
    triggers: ['match_win', 'friend_added'],
    needs: ['matches'],
    condition: (c) => (facts(c).matches?.bestFriendWins ?? 0) >= 10,
  }),
  manual('invincibles', 'secrets', 'mythic', 2500, 'shield', { secret: true }),
];

const BY_ID = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));

export function getAchievement(id: string | null | undefined): AchievementDef | undefined {
  return id ? BY_ID.get(id) : undefined;
}

/**
 * Definitions affected by any of `triggers` (null = every definition, full
 * re-evaluation). Manual achievements are never evaluated by condition.
 */
export function achievementsFor(triggers: Iterable<AchievementTrigger> | null): AchievementDef[] {
  if (triggers === null) return ACHIEVEMENTS.filter((a) => !a.manual);
  const set = new Set(triggers);
  return ACHIEVEMENTS.filter((a) => !a.manual && a.triggers.some((t) => set.has(t)));
}

/** Facts required to evaluate `defs`. */
export function factsNeeded(defs: AchievementDef[]): Set<FactKey> {
  const out = new Set<FactKey>();
  for (const d of defs) for (const k of d.needs ?? []) out.add(k);
  return out;
}

/** Achievements whose condition is met but not yet in `unlocked`. */
export function newlyUnlocked(
  ctx: AchievementContext,
  unlocked: Iterable<string>,
  defs: AchievementDef[] = ACHIEVEMENTS,
): AchievementDef[] {
  const have = new Set(unlocked);
  return defs.filter((a) => !a.manual && !have.has(a.id) && a.condition(ctx));
}
