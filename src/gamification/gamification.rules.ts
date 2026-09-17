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
] as const;

export type XpType = (typeof XP_TYPES)[number];

/** XP granted per event type (achievement/mission bonuses are per definition). */
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
};

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
];

export function missionsFor(event: XpType): MissionDef[] {
  return MISSIONS.filter((m) => m.event === event);
}

// ----- Achievements -----

/** Aggregated facts an achievement condition can look at. */
export interface AchievementContext {
  level: number;
  xp: number;
  /** Number of XP events per type. */
  counts: Partial<Record<XpType, number>>;
  missionsCompleted: number;
  /** Badge keys already derived from esport stats (player-stats.util). */
  badges: string[];
}

export interface AchievementDef {
  id: string;
  icon: string;
  reward: number;
  /** Secret achievements are hidden until unlocked. */
  secret?: boolean;
  condition: (ctx: AchievementContext) => boolean;
}

const count = (ctx: AchievementContext, type: XpType) => ctx.counts[type] ?? 0;

export const ACHIEVEMENTS: AchievementDef[] = [
  { id: 'first_steps', icon: 'footprints', reward: 20, condition: (c) => c.xp > 0 },
  { id: 'first_match', icon: 'swords', reward: 30, condition: (c) => count(c, 'match_played') >= 1 },
  { id: 'matches_10', icon: 'swords', reward: 60, condition: (c) => count(c, 'match_played') >= 10 },
  { id: 'matches_50', icon: 'shield', reward: 150, condition: (c) => count(c, 'match_played') >= 50 },
  { id: 'first_win', icon: 'trophy', reward: 40, condition: (c) => count(c, 'match_win') >= 1 },
  { id: 'wins_10', icon: 'trophy', reward: 100, condition: (c) => count(c, 'match_win') >= 10 },
  { id: 'mvp_1', icon: 'star', reward: 50, condition: (c) => count(c, 'match_mvp') >= 1 },
  { id: 'mvp_5', icon: 'star', reward: 120, condition: (c) => count(c, 'match_mvp') >= 5 },
  { id: 'competitor', icon: 'medal', reward: 40, condition: (c) => count(c, 'tournament_registration') >= 1 },
  { id: 'veteran', icon: 'medal', reward: 120, condition: (c) => count(c, 'tournament_registration') >= 5 },
  { id: 'chatterbox', icon: 'message', reward: 30, condition: (c) => count(c, 'forum_post') >= 5 },
  { id: 'columnist', icon: 'message', reward: 80, condition: (c) => count(c, 'forum_post') >= 25 },
  { id: 'social', icon: 'users', reward: 30, condition: (c) => count(c, 'friend_added') >= 1 },
  { id: 'popular', icon: 'users', reward: 80, condition: (c) => count(c, 'friend_added') >= 10 },
  { id: 'regular', icon: 'sun', reward: 40, condition: (c) => count(c, 'daily_login') >= 7 },
  { id: 'devoted', icon: 'sun', reward: 100, condition: (c) => count(c, 'daily_login') >= 30 },
  { id: 'level_5', icon: 'zap', reward: 50, condition: (c) => c.level >= 5 },
  { id: 'level_10', icon: 'zap', reward: 100, condition: (c) => c.level >= 10 },
  { id: 'level_25', icon: 'crown', reward: 250, condition: (c) => c.level >= 25 },
  { id: 'mission_master', icon: 'target', reward: 80, condition: (c) => c.missionsCompleted >= 10 },
  { id: 'on_fire', icon: 'flame', reward: 60, secret: true, condition: (c) => c.badges.includes('streak_5') },
  { id: 'hero_master', icon: 'crown', reward: 80, secret: true, condition: (c) => c.badges.includes('hero_master') },
];

/** Ids of achievements whose condition is met but not yet in `unlocked`. */
export function newlyUnlocked(ctx: AchievementContext, unlocked: Iterable<string>): AchievementDef[] {
  const have = new Set(unlocked);
  return ACHIEVEMENTS.filter((a) => !have.has(a.id) && a.condition(ctx));
}
