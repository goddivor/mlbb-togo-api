// Pure gamification rules: XP amounts, level curve, achievement and mission
// definitions. No I/O here so everything is unit testable.

export const XP_TYPES = [
  'match_played',
  'match_win',
  'match_mvp',
  'tournament_registration',
  'daily_login',
  'forum_post',
  'friend_added',
  'achievement',
  'mission',
  // Recorded by an admin (rewards #122): winner / finalist / MVP of a tournament.
  'tournament_win',
  'tournament_final',
  'tournament_mvp',
  // Catalogue §2.1 (rewards #125).
  'comment_posted',
  'like_received',
  'bracket_win',
  'bracket_played',
  'season_participation',
  'season_podium',
  'season_win',
  'season_award',
  'recruitment_accepted',
  'recruitment_hire',
  'pickban_completed',
  'ai_coach_used',
  'event_joined',
  'game_account_linked',
  'peak_rank_reached',
  'profile_completed',
  'stream_watch',
  'event_reward',
  'like_pause',
] as const;

export type XpType = (typeof XP_TYPES)[number];

/**
 * XP granted per event type (achievement/mission bonuses are per definition).
 * Zero-XP types are counters feeding achievements (likes, stream visits,
 * bracket games, season titles) or markers (like reciprocity pause).
 * `season_podium`, `season_award` and `event_reward` amounts are passed by
 * the caller (placement, award category, event bonus).
 */
export const XP_RULES: Record<XpType, number> = {
  match_played: 50,
  match_win: 30,
  match_mvp: 40,
  tournament_registration: 20,
  daily_login: 10,
  forum_post: 5,
  friend_added: 10,
  achievement: 0,
  mission: 0,
  tournament_win: 400,
  tournament_final: 150,
  tournament_mvp: 250,
  comment_posted: 2,
  like_received: 0,
  bracket_win: 40,
  bracket_played: 0,
  season_participation: 150,
  season_podium: 200,
  season_win: 0,
  season_award: 250,
  recruitment_accepted: 100,
  recruitment_hire: 30,
  pickban_completed: 5,
  ai_coach_used: 5,
  event_joined: 30,
  game_account_linked: 100,
  peak_rank_reached: 50,
  profile_completed: 50,
  stream_watch: 0,
  event_reward: 0,
  like_pause: 0,
};

/** Season podium XP by placement (catalogue §2.1). */
export const SEASON_PODIUM_XP: Record<1 | 2 | 3, number> = { 1: 500, 2: 300, 3: 200 };

/** Season award XP by category (catalogue §2.1). */
export function seasonAwardXp(category: string): number {
  if (category === 'mvp') return 800;
  if (category.startsWith('best_')) return 500;
  return 250;
}

// ----- Guard-rails (catalogue §2.2) -----

export interface XpLimit {
  perDay?: number;
  perWeek?: number;
  perMonth?: number;
}

/**
 * Per-type caps: an event over its cap is not recorded at all (it neither
 * gives XP nor counts for achievements), which is what prevents farming.
 */
export const XP_LIMITS: Partial<Record<XpType, XpLimit>> = {
  forum_post: { perDay: 5 },
  friend_added: { perDay: 5 },
  comment_posted: { perDay: 5 },
  pickban_completed: { perDay: 2 },
  ai_coach_used: { perDay: 1, perWeek: 5 },
  recruitment_hire: { perMonth: 5 },
};

/** Social XP types sharing the daily social cap. */
export const SOCIAL_XP_TYPES: readonly XpType[] = [
  'forum_post',
  'comment_posted',
  'friend_added',
  'pickban_completed',
  'ai_coach_used',
];

export const SOCIAL_DAILY_CAP = 60;

export const MIN_POST_LENGTH = 30;
export const MIN_COMMENT_LENGTH = 10;
export const MIN_ACCOUNT_AGE_DAYS = 7;
export const MIN_LIKER_LEVEL = 3;
/** More than this many likes exchanged by two members in 7 days pauses them. */
export const RECIPROCITY_LIKES = 30;
export const RECIPROCITY_WINDOW_DAYS = 7;
export const RECIPROCITY_PAUSE_DAYS = 30;
export const PICKBAN_MIN_SECONDS = 60;
export const RECRUITMENT_COOLDOWN_DAYS = 30;

export interface CapUsage {
  /** Events of the same type already recorded today / this week / this month. */
  day: number;
  week: number;
  month: number;
  /** Social XP already granted today. */
  socialToday: number;
}

export type CapDecision = { allowed: false; reason: 'cap' } | { allowed: true; amount: number; capped: boolean };

/**
 * Applies the per-type caps and the daily social cap to a grant. Pure, so
 * the guard-rails are unit tested without a database.
 */
export function applyXpCaps(type: XpType, amount: number, usage: CapUsage): CapDecision {
  const limit = XP_LIMITS[type];
  if (limit) {
    if (limit.perDay !== undefined && usage.day >= limit.perDay) return { allowed: false, reason: 'cap' };
    if (limit.perWeek !== undefined && usage.week >= limit.perWeek) return { allowed: false, reason: 'cap' };
    if (limit.perMonth !== undefined && usage.month >= limit.perMonth) return { allowed: false, reason: 'cap' };
  }
  if (amount > 0 && SOCIAL_XP_TYPES.includes(type)) {
    const left = Math.max(0, SOCIAL_DAILY_CAP - usage.socialToday);
    const granted = Math.min(amount, left);
    return { allowed: true, amount: granted, capped: granted < amount };
  }
  return { allowed: true, amount, capped: false };
}

/** Plain text length of a post/comment body (HTML/markdown markers ignored). */
export function textLength(raw: string | null | undefined): number {
  return String(raw ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/[#*_`>~\[\]()-]/g, '')
    .replace(/\s+/g, ' ')
    .trim().length;
}

/** Idempotency key of a friendship, whatever the side (`friend:<a>:<b>`). */
export function friendPairKey(a: string, b: string): string {
  return a < b ? `friend:${a}:${b}` : `friend:${b}:${a}`;
}

/**
 * Peak rank tiers rewarded once each (`gamePeakRankLevel`, decodeRank
 * thresholds): Epic, Legend, Mythic, Mythic Honor, Mythic Glory, Mythic Immortal.
 */
export const PEAK_RANK_TIERS: readonly { id: string; above: number }[] = [
  { id: 'epic', above: 75 },
  { id: 'legend', above: 105 },
  { id: 'mythic', above: 135 },
  { id: 'mythic_honor', above: 160 },
  { id: 'mythic_glory', above: 185 },
  { id: 'mythic_immortal', above: 235 },
];

export function peakRankTiers(level: number | null | undefined): string[] {
  if (level == null) return [];
  return PEAK_RANK_TIERS.filter((t) => level > t.above).map((t) => t.id);
}

/** Avatar, bio, city, role and favourite heroes filled in. */
export function isProfileComplete(u: {
  avatar?: string | null;
  gameAvatar?: string | null;
  bio?: string | null;
  city?: string | null;
  role?: string | null;
  favoriteHeroes?: string | null;
}): boolean {
  let heroes: unknown = [];
  try {
    heroes = JSON.parse(u.favoriteHeroes || '[]');
  } catch {
    heroes = [];
  }
  return (
    !!(u.avatar || u.gameAvatar) &&
    !!u.bio?.trim() &&
    !!u.city?.trim() &&
    !!u.role?.trim() &&
    Array.isArray(heroes) &&
    heroes.length > 0
  );
}

export const MAX_LEVEL = 200;

/**
 * Cumulative XP required to reach level `n`. Level 1 is the starting level
 * (0 XP); every level above needs 100 * n^1.5 XP in total.
 */
export function xpForLevel(level: number): number {
  const n = Math.floor(level);
  if (n <= 1) return 0;
  return Math.round(100 * Math.pow(n, 1.5));
}

/** Highest level whose XP threshold is reached by `xp`. */
export function levelFromXp(xp: number): number {
  const total = Math.max(0, Math.floor(xp));
  let level = 1;
  while (level < MAX_LEVEL && xpForLevel(level + 1) <= total) level++;
  return level;
}

export interface LevelProgress {
  level: number;
  xp: number;
  currentLevelXp: number;
  nextLevelXp: number | null;
  xpIntoLevel: number;
  xpToNext: number | null;
  /** 0..100 */
  percent: number;
}

/** Progress information within the current level. */
export function levelProgress(xp: number): LevelProgress {
  const total = Math.max(0, Math.floor(xp));
  const level = levelFromXp(total);
  const currentLevelXp = xpForLevel(level);
  const isMax = level >= MAX_LEVEL;
  const nextLevelXp = isMax ? null : xpForLevel(level + 1);
  const xpIntoLevel = total - currentLevelXp;
  const span = nextLevelXp === null ? 0 : nextLevelXp - currentLevelXp;
  const percent = span > 0 ? Math.min(100, Math.floor((xpIntoLevel / span) * 100)) : 100;
  return {
    level,
    xp: total,
    currentLevelXp,
    nextLevelXp,
    xpIntoLevel,
    xpToNext: nextLevelXp === null ? null : nextLevelXp - total,
    percent,
  };
}

// ----- Periods -----

export type MissionPeriod = 'daily' | 'weekly';

function pad(n: number) {
  return String(n).padStart(2, '0');
}

/** UTC day key, e.g. 2026-09-17. */
export function dayKey(d: Date = new Date()): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** ISO week key (Monday based), e.g. 2026-W38. */
export function weekKey(d: Date = new Date()): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${pad(week)}`;
}

export function periodKey(period: MissionPeriod, d: Date = new Date()): string {
  return period === 'daily' ? dayKey(d) : weekKey(d);
}

/** Start of the next period (when the current one rolls over), in UTC. */
export function periodEnd(period: MissionPeriod, d: Date = new Date()): Date {
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (period === 'daily') return new Date(start + 86400000);
  const day = d.getUTCDay() || 7;
  return new Date(start + (8 - day) * 86400000);
}

// ----- Missions -----

export interface MissionDef {
  id: string;
  period: MissionPeriod;
  /** Event type that advances the mission. */
  event: XpType;
  target: number;
  reward: number;
  icon: string;
}

export const MISSIONS: MissionDef[] = [
  { id: 'daily_match', period: 'daily', event: 'match_played', target: 1, reward: 25, icon: 'swords' },
  { id: 'daily_post', period: 'daily', event: 'forum_post', target: 1, reward: 10, icon: 'message' },
  { id: 'daily_login', period: 'daily', event: 'daily_login', target: 1, reward: 5, icon: 'sun' },
  { id: 'weekly_matches', period: 'weekly', event: 'match_played', target: 5, reward: 100, icon: 'swords' },
  { id: 'weekly_wins', period: 'weekly', event: 'match_win', target: 3, reward: 80, icon: 'trophy' },
  { id: 'weekly_tournament', period: 'weekly', event: 'tournament_registration', target: 1, reward: 50, icon: 'medal' },
  { id: 'weekly_friend', period: 'weekly', event: 'friend_added', target: 1, reward: 30, icon: 'users' },
  { id: 'weekly_posts', period: 'weekly', event: 'forum_post', target: 3, reward: 40, icon: 'message' },
  // Catalogue §2.3 (rewards #125).
  { id: 'daily_comment', period: 'daily', event: 'comment_posted', target: 3, reward: 5, icon: 'message' },
  { id: 'weekly_pickban', period: 'weekly', event: 'pickban_completed', target: 3, reward: 20, icon: 'target' },
  { id: 'weekly_bracket', period: 'weekly', event: 'bracket_win', target: 1, reward: 40, icon: 'trophy' },
];

export function missionsFor(event: XpType): MissionDef[] {
  return MISSIONS.filter((m) => m.event === event);
}

// ----- Achievements -----
// The catalogue (118 achievements, catalogue §3) lives in achievements.catalog.ts.
export { ACHIEVEMENTS, newlyUnlocked } from './achievements.catalog';
export type { AchievementContext, AchievementDef } from './achievements.catalog';
