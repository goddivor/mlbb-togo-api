// Pure helpers used to derive player statistics from esport match
// participations. They are kept free of any I/O so they can be unit
// tested and reused (badges, aggregates, progression).

export type MatchResult = 'win' | 'loss' | 'draw';

export interface Participation {
  matchId: string;
  teamId: string;
  seasonId: string | null;
  date: Date;
  result: MatchResult;
  hero: string | null;
  role: string | null;
  kills: number;
  deaths: number;
  assists: number;
  isMvp: boolean;
}

export interface Breakdown {
  key: string;
  games: number;
  wins: number;
  losses: number;
  winRate: number;
  kills: number;
  deaths: number;
  assists: number;
  kda: number;
  mvp: number;
}

export interface PeriodPoint extends Breakdown {
  label: string;
}

export interface PlayerStats {
  games: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
  mvpCount: number;
  kills: number;
  deaths: number;
  assists: number;
  avgKills: number;
  avgDeaths: number;
  avgAssists: number;
  kda: number;
  currentStreak: number;
  bestStreak: number;
  form: MatchResult[];
  formWinRate: number;
  heroes: Breakdown[];
  roles: Breakdown[];
  byMonth: PeriodPoint[];
  bySeason: PeriodPoint[];
  firstMatchAt: Date | null;
  lastMatchAt: Date | null;
}

export const BADGE_KEYS = [
  'first_win',
  'wins_10',
  'wins_25',
  'wins_50',
  'games_10',
  'games_50',
  'games_100',
  'mvp_1',
  'mvp_5',
  'mvp_10',
  'streak_3',
  'streak_5',
  'streak_10',
  'kda_3',
  'kda_5',
  'hero_master',
  'flex',
] as const;

export type BadgeKey = (typeof BADGE_KEYS)[number];

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

export function kdaOf(kills: number, deaths: number, assists: number) {
  return round2((kills + assists) / Math.max(1, deaths));
}

export function winRateOf(wins: number, losses: number) {
  const decisive = wins + losses;
  return decisive ? round1((wins / decisive) * 100) : 0;
}

export function resultFor(
  winnerTeamId: string | null | undefined,
  teamId: string,
): MatchResult {
  if (!winnerTeamId) return 'draw';
  return winnerTeamId === teamId ? 'win' : 'loss';
}

function emptyBreakdown(key: string): Breakdown {
  return {
    key,
    games: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    kills: 0,
    deaths: 0,
    assists: 0,
    kda: 0,
    mvp: 0,
  };
}

function accumulate(b: Breakdown, p: Participation) {
  b.games++;
  if (p.result === 'win') b.wins++;
  else if (p.result === 'loss') b.losses++;
  b.kills += p.kills;
  b.deaths += p.deaths;
  b.assists += p.assists;
  if (p.isMvp) b.mvp++;
}

function finalize(b: Breakdown): Breakdown {
  b.winRate = winRateOf(b.wins, b.losses);
  b.kda = kdaOf(b.kills, b.deaths, b.assists);
  return b;
}

function groupBy(
  list: Participation[],
  keyOf: (p: Participation) => string | null,
): Breakdown[] {
  const map = new Map<string, Breakdown>();
  for (const p of list) {
    const k = keyOf(p);
    if (!k) continue;
    let b = map.get(k);
    if (!b) {
      b = emptyBreakdown(k);
      map.set(k, b);
    }
    accumulate(b, p);
  }
  return Array.from(map.values()).map(finalize);
}

export function monthKey(d: Date) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/** Longest run of consecutive wins over the (chronological) list. */
export function bestWinStreak(list: Participation[]) {
  let best = 0;
  let cur = 0;
  for (const p of list) {
    if (p.result === 'win') {
      cur++;
      if (cur > best) best = cur;
    } else if (p.result === 'loss') cur = 0;
  }
  return best;
}

/** Positive = current win streak, negative = current loss streak. */
export function currentStreak(list: Participation[]) {
  let streak = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i].result;
    if (r === 'draw') continue;
    if (streak === 0) streak = r === 'win' ? 1 : -1;
    else if (streak > 0 && r === 'win') streak++;
    else if (streak < 0 && r === 'loss') streak--;
    else break;
  }
  return streak;
}

/**
 * Aggregates a player's participations (any order) into profile stats.
 * `seasonNames` is optional and only decorates the per-season points.
 */
export function computePlayerStats(
  input: Participation[],
  seasonNames: Map<string, string> = new Map(),
): PlayerStats {
  const list = [...input].sort((a, b) => a.date.getTime() - b.date.getTime());
  const total = emptyBreakdown('all');
  let draws = 0;
  for (const p of list) {
    accumulate(total, p);
    if (p.result === 'draw') draws++;
  }
  finalize(total);
  const games = list.length;
  const form = list.slice(-10).map((p) => p.result);
  const formWins = form.filter((r) => r === 'win').length;
  const formLosses = form.filter((r) => r === 'loss').length;

  const heroes = groupBy(list, (p) => p.hero).sort(
    (a, b) => b.games - a.games || b.winRate - a.winRate,
  );
  const roles = groupBy(list, (p) => p.role).sort((a, b) => b.games - a.games);
  const byMonth = groupBy(list, (p) => monthKey(p.date))
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((b) => ({ ...b, label: b.key }));
  const bySeason = groupBy(list, (p) => p.seasonId).map((b) => ({
    ...b,
    label: seasonNames.get(b.key) ?? b.key,
  }));

  return {
    games,
    wins: total.wins,
    losses: total.losses,
    draws,
    winRate: total.winRate,
    mvpCount: total.mvp,
    kills: total.kills,
    deaths: total.deaths,
    assists: total.assists,
    avgKills: games ? round1(total.kills / games) : 0,
    avgDeaths: games ? round1(total.deaths / games) : 0,
    avgAssists: games ? round1(total.assists / games) : 0,
    kda: total.kda,
    currentStreak: currentStreak(list),
    bestStreak: bestWinStreak(list),
    form,
    formWinRate: winRateOf(formWins, formLosses),
    heroes,
    roles,
    byMonth,
    bySeason,
    firstMatchAt: list.length ? list[0].date : null,
    lastMatchAt: list.length ? list[list.length - 1].date : null,
  };
}

/** Badges earned from the stats. Deterministic, so safe to recompute. */
export function computeBadges(s: PlayerStats): BadgeKey[] {
  const out: BadgeKey[] = [];
  if (s.wins >= 1) out.push('first_win');
  if (s.wins >= 10) out.push('wins_10');
  if (s.wins >= 25) out.push('wins_25');
  if (s.wins >= 50) out.push('wins_50');
  if (s.games >= 10) out.push('games_10');
  if (s.games >= 50) out.push('games_50');
  if (s.games >= 100) out.push('games_100');
  if (s.mvpCount >= 1) out.push('mvp_1');
  if (s.mvpCount >= 5) out.push('mvp_5');
  if (s.mvpCount >= 10) out.push('mvp_10');
  if (s.bestStreak >= 3) out.push('streak_3');
  if (s.bestStreak >= 5) out.push('streak_5');
  if (s.bestStreak >= 10) out.push('streak_10');
  if (s.games >= 10 && s.kda >= 3) out.push('kda_3');
  if (s.games >= 10 && s.kda >= 5) out.push('kda_5');
  if (s.heroes.some((h) => h.games >= 10 && h.winRate >= 60)) out.push('hero_master');
  if (s.roles.filter((r) => r.games >= 3).length >= 3) out.push('flex');
  return out;
}

/**
 * Merges computed badges into the stored list while keeping any badge that
 * is not managed here (e.g. granted manually). Idempotent.
 */
export function mergeBadges(stored: string[], computed: BadgeKey[]): string[] {
  const managed = new Set<string>(BADGE_KEYS);
  const kept = (stored ?? []).filter((b) => !managed.has(b));
  return [...kept, ...computed];
}
