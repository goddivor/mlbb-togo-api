// Pure aggregation helpers for the league statistics page (teams / players /
// meta / records). They only work on plain rows (no I/O) so they can be unit
// tested and reused. Seasons are small: every function aggregates in memory
// over the completed matches of one season (or of all seasons).

export type MatchRow = {
  id: string;
  seasonId?: string | null;
  type?: string | null;
  status: string;
  teamAId: string;
  teamBId: string;
  scoreA?: number | null;
  scoreB?: number | null;
  winnerTeamId?: string | null;
  scheduledAt?: Date | string | null;
  createdAt?: Date | string | null;
  /**
   * Reserved for a future per-game breakdown (`EsportMatch.games`, JSON).
   * When it exists and carries `bans`, the meta uses it as the ban source.
   */
  games?: unknown;
};

export type PlayerRow = {
  id?: string;
  matchId: string;
  userId: string;
  teamId: string;
  hero?: string | null;
  heroId?: string | null;
  role?: string | null;
  kills?: number | null;
  deaths?: number | null;
  assists?: number | null;
  gold?: number | null;
  damage?: number | null;
  isMvp?: boolean | null;
};

export type PlayerSort = 'kills' | 'kda' | 'mvp' | 'games' | 'assists' | 'winRate' | 'deaths';
export const PLAYER_SORTS: PlayerSort[] = ['kills', 'kda', 'mvp', 'games', 'assists', 'winRate', 'deaths'];

export type RecordPeriod = 'week' | 'season';

/** Minimum games before a win rate is considered meaningful on the meta tab. */
export const META_MIN_GAMES = 3;
/** Rolling window used for "records of the week". */
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function round1(n: number) {
  return Math.round(n * 10) / 10;
}

export function round2(n: number) {
  return Math.round(n * 100) / 100;
}

export function kdaOf(kills: number, deaths: number, assists: number) {
  return round2((kills + assists) / Math.max(1, deaths));
}

export function winRateOf(wins: number, losses: number) {
  const decisive = wins + losses;
  return decisive ? round1((wins / decisive) * 100) : 0;
}

/** Date of a match: scheduledAt first, then createdAt. */
export function matchDate(m: MatchRow): Date | null {
  const raw = m.scheduledAt ?? m.createdAt ?? null;
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

export function isCompleted(m: MatchRow) {
  return m.status === 'completed';
}

/** Rolling 7-day window ending at `now` (inclusive). */
export function weekWindow(now: Date = new Date()) {
  return { from: new Date(now.getTime() - WEEK_MS), to: now };
}

export function inWindow(d: Date | null, w: { from: Date; to: Date }) {
  if (!d) return false;
  const t = d.getTime();
  return t >= w.from.getTime() && t <= w.to.getTime();
}

/** Group player rows by match id (only rows whose match is known). */
export function playersByMatch(matches: MatchRow[], players: PlayerRow[]) {
  const ids = new Set(matches.map((m) => m.id));
  const map = new Map<string, PlayerRow[]>();
  for (const p of players) {
    if (!ids.has(p.matchId)) continue;
    const list = map.get(p.matchId);
    if (list) list.push(p);
    else map.set(p.matchId, [p]);
  }
  return map;
}

function resultOf(winnerTeamId: string | null | undefined, teamId: string): 'win' | 'loss' | 'draw' {
  if (!winnerTeamId) return 'draw';
  return winnerTeamId === teamId ? 'win' : 'loss';
}

function bump(map: Map<string, number>, key: string | null | undefined, by = 1) {
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + by);
}

function topEntries(map: Map<string, number>, limit: number) {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

export interface TeamAggregate {
  teamId: string;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
  scoreFor: number;
  scoreAgainst: number;
  scoreDiff: number;
  /** Games that carry player stats (K/D/A averages are computed over them). */
  gamesWithStats: number;
  kills: number;
  deaths: number;
  assists: number;
  avgKills: number;
  avgDeaths: number;
  avgAssists: number;
  /** Not recorded on league matches yet: always null, kept for the contract. */
  avgDurationMin: number | null;
  mvpCount: number;
  topHeroes: { key: string; count: number }[];
}

function emptyTeam(teamId: string): TeamAggregate {
  return {
    teamId,
    games: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    winRate: 0,
    scoreFor: 0,
    scoreAgainst: 0,
    scoreDiff: 0,
    gamesWithStats: 0,
    kills: 0,
    deaths: 0,
    assists: 0,
    avgKills: 0,
    avgDeaths: 0,
    avgAssists: 0,
    avgDurationMin: null,
    mvpCount: 0,
    topHeroes: [],
  };
}

/** Per-team aggregates over the completed matches. Sorted by win rate then wins. */
export function computeTeamStats(matches: MatchRow[], players: PlayerRow[], heroLimit = 3): TeamAggregate[] {
  const completed = matches.filter(isCompleted);
  const byMatch = playersByMatch(completed, players);
  const teams = new Map<string, TeamAggregate>();
  const heroPicks = new Map<string, Map<string, number>>();

  const teamOf = (id: string) => {
    let t = teams.get(id);
    if (!t) {
      t = emptyTeam(id);
      teams.set(id, t);
      heroPicks.set(id, new Map());
    }
    return t;
  };

  for (const m of completed) {
    for (const side of ['A', 'B'] as const) {
      const teamId = side === 'A' ? m.teamAId : m.teamBId;
      const t = teamOf(teamId);
      t.games++;
      const r = resultOf(m.winnerTeamId, teamId);
      if (r === 'win') t.wins++;
      else if (r === 'loss') t.losses++;
      else t.draws++;
      const sf = (side === 'A' ? m.scoreA : m.scoreB) ?? 0;
      const sa = (side === 'A' ? m.scoreB : m.scoreA) ?? 0;
      t.scoreFor += sf;
      t.scoreAgainst += sa;

      const rows = (byMatch.get(m.id) ?? []).filter((p) => p.teamId === teamId);
      if (!rows.length) continue;
      t.gamesWithStats++;
      for (const p of rows) {
        t.kills += p.kills ?? 0;
        t.deaths += p.deaths ?? 0;
        t.assists += p.assists ?? 0;
        if (p.isMvp) t.mvpCount++;
        bump(heroPicks.get(teamId)!, p.hero);
      }
    }
  }

  return Array.from(teams.values())
    .map((t) => {
      t.winRate = winRateOf(t.wins, t.losses);
      t.scoreDiff = t.scoreFor - t.scoreAgainst;
      const g = t.gamesWithStats;
      t.avgKills = g ? round1(t.kills / g) : 0;
      t.avgDeaths = g ? round1(t.deaths / g) : 0;
      t.avgAssists = g ? round1(t.assists / g) : 0;
      t.topHeroes = topEntries(heroPicks.get(t.teamId)!, heroLimit);
      return t;
    })
    .sort(
      (a, b) =>
        b.winRate - a.winRate || b.wins - a.wins || b.scoreDiff - a.scoreDiff || a.teamId.localeCompare(b.teamId),
    );
}

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

export interface PlayerAggregate {
  userId: string;
  /** Team of the most recent game. */
  teamId: string;
  /** Most played lane. */
  role: string | null;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
  kills: number;
  deaths: number;
  assists: number;
  avgKills: number;
  avgDeaths: number;
  avgAssists: number;
  kda: number;
  mvpCount: number;
  topHeroes: { key: string; count: number }[];
}

export interface PlayerRankingOptions {
  role?: string | null;
  sort?: PlayerSort;
  limit?: number;
  heroLimit?: number;
}

export function comparePlayers(sort: PlayerSort) {
  const primary: Record<PlayerSort, (p: PlayerAggregate) => number> = {
    kills: (p) => p.kills,
    kda: (p) => p.kda,
    mvp: (p) => p.mvpCount,
    games: (p) => p.games,
    assists: (p) => p.assists,
    winRate: (p) => p.winRate,
    deaths: (p) => p.deaths,
  };
  const value = primary[sort];
  return (a: PlayerAggregate, b: PlayerAggregate) =>
    value(b) - value(a) ||
    b.games - a.games ||
    b.kda - a.kda ||
    b.mvpCount - a.mvpCount ||
    a.userId.localeCompare(b.userId);
}

/**
 * Individual rankings. Only players with at least one completed game with
 * stats are listed. `role` filters on the lane played in the game (a player
 * who flexes keeps only the games on that lane).
 */
export function computePlayerRankings(
  matches: MatchRow[],
  players: PlayerRow[],
  opts: PlayerRankingOptions = {},
): PlayerAggregate[] {
  const completed = matches.filter(isCompleted);
  const mmap = new Map(completed.map((m) => [m.id, m]));
  const role = opts.role ? String(opts.role).toLowerCase() : null;
  const sort: PlayerSort = opts.sort && PLAYER_SORTS.includes(opts.sort) ? opts.sort : 'kills';
  const heroLimit = opts.heroLimit ?? 3;

  const acc = new Map<
    string,
    PlayerAggregate & { lastAt: number; roles: Map<string, number>; heroes: Map<string, number> }
  >();

  for (const p of players) {
    const m = mmap.get(p.matchId);
    if (!m) continue;
    const lane = p.role ? String(p.role).toLowerCase() : null;
    if (role && lane !== role) continue;
    let a = acc.get(p.userId);
    if (!a) {
      a = {
        userId: p.userId,
        teamId: p.teamId,
        role: null,
        games: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        winRate: 0,
        kills: 0,
        deaths: 0,
        assists: 0,
        avgKills: 0,
        avgDeaths: 0,
        avgAssists: 0,
        kda: 0,
        mvpCount: 0,
        topHeroes: [],
        lastAt: -Infinity,
        roles: new Map(),
        heroes: new Map(),
      };
      acc.set(p.userId, a);
    }
    a.games++;
    const r = resultOf(m.winnerTeamId, p.teamId);
    if (r === 'win') a.wins++;
    else if (r === 'loss') a.losses++;
    else a.draws++;
    a.kills += p.kills ?? 0;
    a.deaths += p.deaths ?? 0;
    a.assists += p.assists ?? 0;
    if (p.isMvp) a.mvpCount++;
    bump(a.roles, lane);
    bump(a.heroes, p.hero);
    const at = matchDate(m)?.getTime() ?? 0;
    if (at >= a.lastAt) {
      a.lastAt = at;
      a.teamId = p.teamId;
    }
  }

  const list: PlayerAggregate[] = Array.from(acc.values()).map((a) => {
    const { lastAt: _lastAt, roles, heroes, ...rest } = a;
    const g = rest.games;
    return {
      ...rest,
      role: topEntries(roles, 1)[0]?.key ?? null,
      winRate: winRateOf(rest.wins, rest.losses),
      avgKills: g ? round1(rest.kills / g) : 0,
      avgDeaths: g ? round1(rest.deaths / g) : 0,
      avgAssists: g ? round1(rest.assists / g) : 0,
      kda: kdaOf(rest.kills, rest.deaths, rest.assists),
      topHeroes: topEntries(heroes, heroLimit),
    };
  });

  list.sort(comparePlayers(sort));
  const limit = Math.max(1, Math.floor(opts.limit ?? 50));
  return list.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Meta (heroes)
// ---------------------------------------------------------------------------

export interface HeroAggregate {
  hero: string;
  picks: number;
  wins: number;
  losses: number;
  /** Null until the hero reaches `minGames` picks. */
  winRate: number | null;
  /** Percentage of games (with stats) in which the hero was picked. */
  pickRate: number;
  bans: number;
  /** Percentage of games with ban data in which the hero was banned. */
  banRate: number | null;
  mvpCount: number;
  kills: number;
  deaths: number;
  assists: number;
  kda: number;
  /** Most frequent lane. */
  role: string | null;
}

export type BanSource = 'match-games' | 'unavailable';

export interface MetaAggregate {
  /** Completed matches in the scope. */
  matches: number;
  /** Matches that carry per-player stats (denominator of the pick rate). */
  matchesWithStats: number;
  /** Matches that carry ban data (denominator of the ban rate). */
  matchesWithBans: number;
  minGames: number;
  banSource: BanSource;
  heroes: HeroAggregate[];
  mostPlayed: HeroAggregate[];
  bestWinRate: HeroAggregate[];
  mostBanned: HeroAggregate[];
}

/**
 * Bans recorded on a match. Reads an optional `games` JSON breakdown
 * (`[{ bansA: string[], bansB: string[] }]` or `{ bans: string[] }`). The
 * schema does not persist it yet, so this returns `null` (= no data) for
 * every current match; pick & ban simulator boards are deliberately ignored
 * because they are practice data, not league games.
 */
export function bansOf(m: MatchRow): string[] | null {
  let raw = m.games;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!raw) return null;
  const games = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  let found = false;
  for (const g of games) {
    if (!g || typeof g !== 'object') continue;
    for (const key of ['bans', 'bansA', 'bansB']) {
      const list = (g as Record<string, unknown>)[key];
      if (Array.isArray(list)) {
        found = true;
        for (const h of list) if (typeof h === 'string' && h.trim()) out.push(h.trim());
      }
    }
  }
  return found ? out : null;
}

export function computeMeta(
  matches: MatchRow[],
  players: PlayerRow[],
  opts: { minGames?: number; limit?: number } = {},
): MetaAggregate {
  const completed = matches.filter(isCompleted);
  const byMatch = playersByMatch(completed, players);
  const minGames = Math.max(1, opts.minGames ?? META_MIN_GAMES);
  const limit = Math.max(1, opts.limit ?? 10);

  type Acc = HeroAggregate & { roles: Map<string, number> };
  const heroes = new Map<string, Acc>();
  const heroOf = (name: string) => {
    let h = heroes.get(name);
    if (!h) {
      h = {
        hero: name,
        picks: 0,
        wins: 0,
        losses: 0,
        winRate: null,
        pickRate: 0,
        bans: 0,
        banRate: null,
        mvpCount: 0,
        kills: 0,
        deaths: 0,
        assists: 0,
        kda: 0,
        role: null,
        roles: new Map(),
      };
      heroes.set(name, h);
    }
    return h;
  };

  let matchesWithStats = 0;
  let matchesWithBans = 0;
  for (const m of completed) {
    const rows = byMatch.get(m.id) ?? [];
    if (rows.length) matchesWithStats++;
    for (const p of rows) {
      const name = p.hero?.trim();
      if (!name) continue;
      const h = heroOf(name);
      h.picks++;
      const r = resultOf(m.winnerTeamId, p.teamId);
      if (r === 'win') h.wins++;
      else if (r === 'loss') h.losses++;
      h.kills += p.kills ?? 0;
      h.deaths += p.deaths ?? 0;
      h.assists += p.assists ?? 0;
      if (p.isMvp) h.mvpCount++;
      bump(h.roles, p.role ? String(p.role).toLowerCase() : null);
    }
    const bans = bansOf(m);
    if (bans) {
      matchesWithBans++;
      for (const b of bans) heroOf(b).bans++;
    }
  }

  const list: HeroAggregate[] = Array.from(heroes.values()).map((h) => {
    const { roles, ...rest } = h;
    return {
      ...rest,
      role: topEntries(roles, 1)[0]?.key ?? null,
      winRate: rest.picks >= minGames ? winRateOf(rest.wins, rest.losses) : null,
      pickRate: matchesWithStats ? round1((rest.picks / matchesWithStats) * 100) : 0,
      banRate: matchesWithBans ? round1((rest.bans / matchesWithBans) * 100) : null,
      kda: kdaOf(rest.kills, rest.deaths, rest.assists),
    };
  });

  const byName = (a: HeroAggregate, b: HeroAggregate) => a.hero.localeCompare(b.hero);
  const mostPlayed = [...list]
    .filter((h) => h.picks > 0)
    .sort((a, b) => b.picks - a.picks || (b.winRate ?? 0) - (a.winRate ?? 0) || byName(a, b))
    .slice(0, limit);
  const bestWinRate = [...list]
    .filter((h) => h.winRate !== null)
    .sort((a, b) => (b.winRate ?? 0) - (a.winRate ?? 0) || b.picks - a.picks || byName(a, b))
    .slice(0, limit);
  const mostBanned = [...list]
    .filter((h) => h.bans > 0)
    .sort((a, b) => b.bans - a.bans || b.picks - a.picks || byName(a, b))
    .slice(0, limit);

  return {
    matches: completed.length,
    matchesWithStats,
    matchesWithBans,
    minGames,
    banSource: matchesWithBans ? 'match-games' : 'unavailable',
    heroes: list.sort((a, b) => b.picks - a.picks || byName(a, b)),
    mostPlayed,
    bestWinRate,
    mostBanned,
  };
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export interface PlayerRecord {
  value: number;
  userId: string;
  teamId: string;
  matchId: string;
  hero: string | null;
  role: string | null;
  date: Date | null;
  kills: number;
  deaths: number;
  assists: number;
}

export interface MatchRecord {
  value: number;
  matchId: string;
  teamAId: string;
  teamBId: string;
  scoreA: number;
  scoreB: number;
  winnerTeamId: string | null;
  date: Date | null;
}

export interface RecordsAggregate {
  period: RecordPeriod;
  window: { from: Date; to: Date } | null;
  matches: number;
  topKills: PlayerRecord | null;
  topAssists: PlayerRecord | null;
  topDamage: PlayerRecord | null;
  topGold: PlayerRecord | null;
  topKda: PlayerRecord | null;
  /** Game duration is not recorded on league matches yet: always null. */
  longestGame: MatchRecord | null;
  biggestMargin: MatchRecord | null;
}

function bestPlayer(
  rows: { p: PlayerRow; m: MatchRow }[],
  value: (p: PlayerRow) => number | null | undefined,
): PlayerRecord | null {
  let best: PlayerRecord | null = null;
  for (const { p, m } of rows) {
    const v = value(p);
    if (v === null || v === undefined || Number.isNaN(v)) continue;
    const date = matchDate(m);
    // Ties: the most recent performance wins.
    if (!best || v > best.value || (v === best.value && (date?.getTime() ?? 0) > (best.date?.getTime() ?? 0))) {
      best = {
        value: v,
        userId: p.userId,
        teamId: p.teamId,
        matchId: m.id,
        hero: p.hero ?? null,
        role: p.role ?? null,
        date,
        kills: p.kills ?? 0,
        deaths: p.deaths ?? 0,
        assists: p.assists ?? 0,
      };
    }
  }
  return best;
}

export function computeRecords(
  matches: MatchRow[],
  players: PlayerRow[],
  opts: { period?: RecordPeriod; now?: Date } = {},
): RecordsAggregate {
  const period: RecordPeriod = opts.period === 'week' ? 'week' : 'season';
  const window = period === 'week' ? weekWindow(opts.now ?? new Date()) : null;
  const completed = matches.filter((m) => isCompleted(m) && (!window || inWindow(matchDate(m), window)));
  const mmap = new Map(completed.map((m) => [m.id, m]));
  const rows = players
    .map((p) => ({ p, m: mmap.get(p.matchId)! }))
    .filter((x) => !!x.m);

  let biggest: MatchRecord | null = null;
  for (const m of completed) {
    const a = m.scoreA ?? 0;
    const b = m.scoreB ?? 0;
    const margin = Math.abs(a - b);
    if (margin === 0) continue;
    const date = matchDate(m);
    if (!biggest || margin > biggest.value || (margin === biggest.value && (date?.getTime() ?? 0) > (biggest.date?.getTime() ?? 0))) {
      biggest = {
        value: margin,
        matchId: m.id,
        teamAId: m.teamAId,
        teamBId: m.teamBId,
        scoreA: a,
        scoreB: b,
        winnerTeamId: m.winnerTeamId ?? null,
        date,
      };
    }
  }

  return {
    period,
    window,
    matches: completed.length,
    topKills: bestPlayer(rows, (p) => p.kills ?? 0),
    topAssists: bestPlayer(rows, (p) => p.assists ?? 0),
    topDamage: bestPlayer(rows, (p) => p.damage),
    topGold: bestPlayer(rows, (p) => p.gold),
    topKda: bestPlayer(rows, (p) => kdaOf(p.kills ?? 0, p.deaths ?? 0, p.assists ?? 0)),
    longestGame: null,
    biggestMargin: biggest,
  };
}
