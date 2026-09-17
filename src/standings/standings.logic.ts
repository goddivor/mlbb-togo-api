import {
  MatchLike,
  MatchResult,
  TeamMatchView,
  TeamRef,
  completedForTeam,
  matchDate,
  recordOf,
  streaksOf,
} from '../esport/esport-stats.service';
import {
  DEFAULT_POINTS,
  DEFAULT_QUALIFY_TOP,
  DELTA_WINDOWS,
  FORM_LENGTH,
  LEAGUE_MATCH_TYPES,
  PLAYOFF_MATCH_TYPES,
  QUALIFY_TOP_OPTIONS,
  StandingsType,
} from './standings.constants';

/**
 * Pure standings logic (no I/O): scoring, tie-breakers, streak/form,
 * rank deltas, strength of schedule and head-to-head. Everything here is
 * unit tested in `standings.logic.spec.ts`.
 */

export type PointsRule = { win: number; draw: number; loss: number };

export type StandingsSettings = {
  points: PointsRule;
  qualifyTop: number;
};

export type SeasonScope = {
  playoffsStartDate?: Date | string | null;
};

export type StandingRow = {
  rank: number;
  teamId: string;
  team: TeamRef;
  played: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
  scoreFor: number;
  scoreAgainst: number;
  scoreDiff: number;
  points: number;
  streak: { type: MatchResult; count: number } | null;
  form: MatchResult[];
  /** Average win rate of the opponents faced (per match), null without games. */
  sos: number | null;
  /** Rank change since N days ago (positive = climbed), null when unranked then. */
  delta: { d7: number | null; d30: number | null };
  qualified: boolean;
};

export type H2HMatch = {
  id: string;
  date: Date | null;
  type: string;
  scoreA: number;
  scoreB: number;
  winnerTeamId: string | null;
};

export type H2HRecord = {
  teamA: TeamRef;
  teamB: TeamRef;
  played: number;
  winsA: number;
  winsB: number;
  draws: number;
  scoreA: number;
  scoreB: number;
  last: H2HMatch | null;
  matches: H2HMatch[];
};

const toInt = (v: unknown, fallback: number, min = 0, max = 100) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

export const DEFAULT_SETTINGS: StandingsSettings = {
  points: { ...DEFAULT_POINTS },
  qualifyTop: DEFAULT_QUALIFY_TOP,
};

/** Parse the season `settings` JSON (never throws, always complete). */
export function parseSettings(raw: unknown): StandingsSettings {
  let obj: any = null;
  try {
    obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    obj = null;
  }
  if (!obj || typeof obj !== 'object') return { points: { ...DEFAULT_POINTS }, qualifyTop: DEFAULT_QUALIFY_TOP };
  const pts = obj.points && typeof obj.points === 'object' ? obj.points : {};
  return {
    points: {
      win: toInt(pts.win, DEFAULT_POINTS.win),
      draw: toInt(pts.draw, DEFAULT_POINTS.draw),
      loss: toInt(pts.loss, DEFAULT_POINTS.loss),
    },
    qualifyTop: normalizeQualifyTop(obj.qualifyTop),
  };
}

/** Snap a threshold to the allowed options (default when invalid). */
export function normalizeQualifyTop(v: unknown): number {
  const n = Number(v);
  return (QUALIFY_TOP_OPTIONS as readonly number[]).includes(n) ? n : DEFAULT_QUALIFY_TOP;
}

/** Merge a partial update into existing settings (used by the admin PATCH). */
export function mergeSettings(
  current: StandingsSettings,
  patch: { qualifyTop?: number; points?: Partial<PointsRule> },
): StandingsSettings {
  return {
    points: {
      win: toInt(patch.points?.win, current.points.win),
      draw: toInt(patch.points?.draw, current.points.draw),
      loss: toInt(patch.points?.loss, current.points.loss),
    },
    qualifyTop: patch.qualifyTop === undefined ? current.qualifyTop : normalizeQualifyTop(patch.qualifyTop),
  };
}

export function isPlayoffMatch(m: MatchLike, season?: SeasonScope | null): boolean {
  const type = (m.type ?? '').toLowerCase();
  if (PLAYOFF_MATCH_TYPES.includes(type)) return true;
  // A league match played after the playoffs kick-off counts as a playoff game.
  if (LEAGUE_MATCH_TYPES.includes(type) && season?.playoffsStartDate) {
    const start = new Date(season.playoffsStartDate).getTime();
    const d = matchDate(m)?.getTime();
    if (d != null && !isNaN(start) && d >= start) return true;
  }
  return false;
}

/** Completed matches of the requested scope. */
export function scopeMatches(matches: MatchLike[], type: StandingsType, season?: SeasonScope | null): MatchLike[] {
  const completed = matches.filter((m) => m.status === 'completed');
  if (type === 'all') return completed;
  if (type === 'playoff') return completed.filter((m) => isPlayoffMatch(m, season));
  return completed.filter(
    (m) => LEAGUE_MATCH_TYPES.includes((m.type ?? '').toLowerCase()) && !isPlayoffMatch(m, season),
  );
}

/** Matches played up to (and including) a cut-off date. Undated matches are ignored. */
export function matchesUntil(matches: MatchLike[], cutoff: Date): MatchLike[] {
  const limit = cutoff.getTime();
  return matches.filter((m) => {
    const d = matchDate(m);
    return d != null && d.getTime() <= limit;
  });
}

export function pointsOf(record: { wins: number; draws: number; losses: number }, rule: PointsRule): number {
  return record.wins * rule.win + record.draws * rule.draw + record.losses * rule.loss;
}

/** Wins of `a` over `b` minus wins of `b` over `a` (positive = a leads the H2H). */
export function h2hBalance(a: string, b: string, matches: MatchLike[]): number {
  let bal = 0;
  for (const m of matches) {
    if (m.status !== 'completed') continue;
    const pair = (m.teamAId === a && m.teamBId === b) || (m.teamAId === b && m.teamBId === a);
    if (!pair) continue;
    if (m.winnerTeamId === a) bal++;
    else if (m.winnerTeamId === b) bal--;
  }
  return bal;
}

type BaseRow = Omit<StandingRow, 'rank' | 'delta' | 'qualified' | 'sos'> & { views: TeamMatchView[] };

function baseRows(matches: MatchLike[], rule: PointsRule, teams: Map<string, TeamRef>): BaseRow[] {
  const ids = new Set<string>();
  for (const m of matches) {
    if (m.status !== 'completed') continue;
    ids.add(m.teamAId);
    ids.add(m.teamBId);
  }
  return Array.from(ids).map((teamId) => {
    const views = completedForTeam(teamId, matches);
    const record = recordOf(views);
    return {
      teamId,
      team: teams.get(teamId) ?? { id: teamId, name: '?', image: null },
      ...record,
      points: pointsOf(record, rule),
      streak: streaksOf(views).current,
      form: views.slice(-FORM_LENGTH).map((v) => v.result),
      views,
    };
  });
}

/** Tie-breakers: Pts, then game diff, then WR%, then head-to-head, then name. */
export function compareRows<T extends { points: number; scoreDiff: number; winRate: number; teamId: string; team: TeamRef }>(
  a: T,
  b: T,
  matches: MatchLike[],
): number {
  return (
    b.points - a.points ||
    b.scoreDiff - a.scoreDiff ||
    b.winRate - a.winRate ||
    h2hBalance(b.teamId, a.teamId, matches) ||
    (a.team.name || '').localeCompare(b.team.name || '', undefined, { sensitivity: 'base' })
  );
}

/** Ranked ids only (cheap; used for the delta snapshots). */
export function rankOrder(matches: MatchLike[], rule: PointsRule, teams: Map<string, TeamRef>): string[] {
  return baseRows(matches, rule, teams)
    .sort((a, b) => compareRows(a, b, matches))
    .map((r) => r.teamId);
}

/** Average win rate of the opponents faced, weighted per match. */
export function strengthOfSchedule(views: TeamMatchView[], winRateOf: Map<string, number>): number | null {
  if (views.length === 0) return null;
  let sum = 0;
  for (const v of views) sum += winRateOf.get(v.opponentId) ?? 0;
  return Math.round(sum / views.length);
}

/**
 * Full standings of one match set. `asOf` is the reference date for the
 * 7 / 30-day deltas (now for a live season, `closedAt` for a frozen one).
 */
export function computeStandings(
  matches: MatchLike[],
  settings: StandingsSettings,
  teams: Map<string, TeamRef>,
  asOf: Date = new Date(),
): StandingRow[] {
  const rows = baseRows(matches, settings.points, teams).sort((a, b) => compareRows(a, b, matches));
  const winRateOf = new Map(rows.map((r) => [r.teamId, r.winRate]));
  const snapshots = DELTA_WINDOWS.map((days) => {
    const cutoff = new Date(asOf.getTime() - days * 86_400_000);
    return rankOrder(matchesUntil(matches, cutoff), settings.points, teams);
  });
  return rows.map(({ views, ...row }, i) => {
    const rank = i + 1;
    const deltaAt = (snapshot: string[]) => {
      const then = snapshot.indexOf(row.teamId);
      return then < 0 ? null : then + 1 - rank;
    };
    return {
      rank,
      ...row,
      sos: strengthOfSchedule(views, winRateOf),
      delta: { d7: deltaAt(snapshots[0]), d30: deltaAt(snapshots[1]) },
      qualified: rank <= settings.qualifyTop,
    };
  });
}

/** Rows of a frozen summary enriched with points / extras computed from the matches. */
export function enrichFrozenRows(
  frozen: {
    rank: number;
    teamId: string;
    team: TeamRef;
    played: number;
    wins: number;
    losses: number;
    draws: number;
    winRate: number;
    scoreFor: number;
    scoreAgainst: number;
    scoreDiff: number;
  }[],
  computed: StandingRow[],
  settings: StandingsSettings,
): StandingRow[] {
  const byTeam = new Map(computed.map((r) => [r.teamId, r]));
  return frozen.map((f, i) => {
    const live = byTeam.get(f.teamId);
    const rank = f.rank || i + 1;
    return {
      rank,
      teamId: f.teamId,
      team: f.team,
      played: f.played,
      wins: f.wins,
      losses: f.losses,
      draws: f.draws ?? 0,
      winRate: f.winRate,
      scoreFor: f.scoreFor,
      scoreAgainst: f.scoreAgainst,
      scoreDiff: f.scoreDiff,
      points: pointsOf({ wins: f.wins, draws: f.draws ?? 0, losses: f.losses }, settings.points),
      streak: live?.streak ?? null,
      form: live?.form ?? [],
      sos: live?.sos ?? null,
      delta: live?.delta ?? { d7: null, d30: null },
      qualified: rank <= settings.qualifyTop,
    };
  });
}

/** Head-to-head record between two teams (chronological match list). */
export function headToHead(a: TeamRef, b: TeamRef, matches: MatchLike[]): H2HRecord {
  const list = matches
    .filter(
      (m) =>
        m.status === 'completed' &&
        ((m.teamAId === a.id && m.teamBId === b.id) || (m.teamAId === b.id && m.teamBId === a.id)),
    )
    .map((m) => {
      const isA = m.teamAId === a.id;
      return {
        id: m.id,
        date: matchDate(m),
        type: m.type ?? 'friendly',
        scoreA: (isA ? m.scoreA : m.scoreB) ?? 0,
        scoreB: (isA ? m.scoreB : m.scoreA) ?? 0,
        winnerTeamId: m.winnerTeamId ?? null,
      };
    })
    .sort((x, y) => (x.date?.getTime() ?? 0) - (y.date?.getTime() ?? 0));
  let winsA = 0;
  let winsB = 0;
  let draws = 0;
  let scoreA = 0;
  let scoreB = 0;
  for (const m of list) {
    if (m.winnerTeamId === a.id) winsA++;
    else if (m.winnerTeamId === b.id) winsB++;
    else draws++;
    scoreA += m.scoreA;
    scoreB += m.scoreB;
  }
  return {
    teamA: a,
    teamB: b,
    played: list.length,
    winsA,
    winsB,
    draws,
    scoreA,
    scoreB,
    last: list[list.length - 1] ?? null,
    matches: list,
  };
}
