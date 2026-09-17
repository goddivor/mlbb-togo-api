// Pure helpers used by the player dashboard aggregation. No I/O here so the
// composition rules (feed ordering, calendar filtering, rank lookup, badge
// timeline) can be unit tested in isolation.

import {
  BadgeKey,
  Participation,
  PlayerStats,
  computeBadges,
  computePlayerStats,
  winRateOf,
} from '../stats/player-stats.util';

export type ActivityType =
  | 'match'
  | 'draft_registration'
  | 'friend_accepted'
  | 'badge'
  | 'post'
  | 'comment';

export interface ActivityEvent {
  id: string;
  type: ActivityType;
  date: Date;
  /** Structured params so the client can render a localized sentence. */
  data: Record<string, any>;
  link: string | null;
}

export type UpcomingKind =
  | 'esport_match'
  | 'tournament_match'
  | 'tournament'
  | 'draft_match'
  | 'draft_tournament';

export interface UpcomingItem {
  id: string;
  kind: UpcomingKind;
  /** Null when the event is known but not yet scheduled. */
  date: Date | null;
  data: Record<string, any>;
  link: string | null;
}

export interface QuickStats {
  games: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
  mvpCount: number;
  kda: number;
  currentStreak: number;
  bestStreak: number;
  form: PlayerStats['form'];
}

export const DEFAULT_FEED_LIMIT = 15;
export const DEFAULT_UPCOMING_LIMIT = 10;

/** Merges several event sources and keeps the most recent ones. */
export function mergeFeed(
  groups: ActivityEvent[][],
  limit = DEFAULT_FEED_LIMIT,
): ActivityEvent[] {
  const all = groups.flat().filter((e) => e && e.date instanceof Date && !isNaN(e.date.getTime()));
  all.sort((a, b) => b.date.getTime() - a.date.getTime() || a.id.localeCompare(b.id));
  return all.slice(0, Math.max(0, limit));
}

/**
 * Dates at which each badge was earned, replaying the matches in
 * chronological order. The stored badge list has no timestamps, so this is
 * the only way to place badges on a timeline. Deterministic.
 */
export function badgeTimeline(
  input: Participation[],
): Array<{ badge: BadgeKey; date: Date }> {
  const list = [...input].sort((a, b) => a.date.getTime() - b.date.getTime());
  const seen = new Set<BadgeKey>();
  const out: Array<{ badge: BadgeKey; date: Date }> = [];
  for (let i = 0; i < list.length; i++) {
    const badges = computeBadges(computePlayerStats(list.slice(0, i + 1)));
    for (const b of badges) {
      if (seen.has(b)) continue;
      seen.add(b);
      out.push({ badge: b, date: list[i].date });
    }
  }
  return out;
}

/** 1-based position of the user in a ranked list, null when absent. */
export function rankOf(entries: Array<{ id: string }>, userId: string): number | null {
  const idx = entries.findIndex((e) => e.id === userId);
  return idx === -1 ? null : idx + 1;
}

/** Start of the day (UTC) so today's already-started events stay listed. */
export function startOfDay(now: Date): Date {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Keeps events from today onwards (unscheduled ones are kept too), sorted by
 * date ascending with unscheduled events last.
 */
export function sortUpcoming(
  items: UpcomingItem[],
  now: Date,
  limit = DEFAULT_UPCOMING_LIMIT,
): UpcomingItem[] {
  const floor = startOfDay(now).getTime();
  const kept = items.filter(
    (i) => i.date === null || (i.date instanceof Date && !isNaN(i.date.getTime()) && i.date.getTime() >= floor),
  );
  kept.sort((a, b) => {
    if (a.date === null && b.date === null) return a.id.localeCompare(b.id);
    if (a.date === null) return 1;
    if (b.date === null) return -1;
    return a.date.getTime() - b.date.getTime() || a.id.localeCompare(b.id);
  });
  return kept.slice(0, Math.max(0, limit));
}

/** Parses a tournament date ("YYYY-MM-DD" or ISO). Null when unusable. */
export function parseLooseDate(raw: unknown): Date | null {
  if (raw instanceof Date) return isNaN(raw.getTime()) ? null : raw;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Ids of the teams registered to a tournament. `registeredTeams` is a JSON
 * string holding either plain ids (legacy seed) or `{ id, name, logo }`.
 */
export function registeredTeamIds(raw: unknown): string[] {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((t) => (typeof t === 'string' ? t : t && typeof t.id === 'string' ? t.id : null))
    .filter((id): id is string => !!id);
}

export function quickStatsOf(s: PlayerStats): QuickStats {
  return {
    games: s.games,
    wins: s.wins,
    losses: s.losses,
    draws: s.draws,
    winRate: s.winRate,
    mvpCount: s.mvpCount,
    kda: s.kda,
    currentStreak: s.currentStreak,
    bestStreak: s.bestStreak,
    form: s.form,
  };
}

/** Quick stats from the denormalized user counters (no match rows). */
export function countersToQuickStats(
  u: { wins?: number | null; losses?: number | null; mvpCount?: number | null; streak?: number | null } | null | undefined,
): QuickStats {
  const base = emptyQuickStats();
  if (!u) return base;
  const wins = u.wins ?? 0;
  const losses = u.losses ?? 0;
  const streak = u.streak ?? 0;
  return {
    ...base,
    games: wins + losses,
    wins,
    losses,
    winRate: winRateOf(wins, losses),
    mvpCount: u.mvpCount ?? 0,
    currentStreak: streak,
    bestStreak: Math.max(0, streak),
  };
}

export function emptyQuickStats(): QuickStats {
  return {
    games: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    winRate: 0,
    mvpCount: 0,
    kda: 0,
    currentStreak: 0,
    bestStreak: 0,
    form: [],
  };
}
