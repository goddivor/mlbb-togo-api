import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Team statistics, history, schedule and honours.
 * Kept separate from EsportService so match-result logic stays untouched.
 * All the heavy lifting is done by pure functions (easy to unit test).
 */

export type MatchLike = {
  id: string;
  seasonId?: string | null;
  type?: string;
  status: string;
  teamAId: string;
  teamBId: string;
  scoreA?: number | null;
  scoreB?: number | null;
  winnerTeamId?: string | null;
  scheduledAt?: Date | string | null;
  createdAt?: Date | string | null;
};

export type MatchResult = 'W' | 'L' | 'D';

export type TeamRef = { id: string; name: string; image?: string | null };

export type SeasonLike = {
  id: string;
  name: string;
  startDate?: Date | string | null;
  endDate?: Date | string | null;
  isActive?: boolean;
  /** Lifecycle status (see EsportSeasonsService); legacy rows have none. */
  status?: string | null;
};

export type TeamMatchView = {
  id: string;
  seasonId: string | null;
  type: string;
  status: string;
  date: Date | null;
  result: MatchResult;
  scoreFor: number;
  scoreAgainst: number;
  opponentId: string;
};

/** Sort date used for a match: scheduledAt first, then createdAt. */
export function matchDate(m: MatchLike): Date | null {
  const raw = m.scheduledAt ?? m.createdAt ?? null;
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

export function resultFor(teamId: string, m: MatchLike): MatchResult {
  if (m.winnerTeamId === teamId) return 'W';
  if (m.winnerTeamId) return 'L';
  return 'D';
}

/** Project a raw match into the point of view of one team. */
export function toTeamView(teamId: string, m: MatchLike): TeamMatchView {
  const isA = m.teamAId === teamId;
  return {
    id: m.id,
    seasonId: m.seasonId ?? null,
    type: m.type ?? 'friendly',
    status: m.status,
    date: matchDate(m),
    result: resultFor(teamId, m),
    scoreFor: (isA ? m.scoreA : m.scoreB) ?? 0,
    scoreAgainst: (isA ? m.scoreB : m.scoreA) ?? 0,
    opponentId: isA ? m.teamBId : m.teamAId,
  };
}

/** Completed matches of a team, oldest first (chronological). */
export function completedForTeam(teamId: string, matches: MatchLike[]): TeamMatchView[] {
  return matches
    .filter(
      (m) =>
        m.status === 'completed' && (m.teamAId === teamId || m.teamBId === teamId),
    )
    .map((m) => toTeamView(teamId, m))
    .sort((a, b) => (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0));
}

export function recordOf(views: TeamMatchView[]) {
  let wins = 0;
  let losses = 0;
  let draws = 0;
  let scoreFor = 0;
  let scoreAgainst = 0;
  for (const v of views) {
    if (v.result === 'W') wins++;
    else if (v.result === 'L') losses++;
    else draws++;
    scoreFor += v.scoreFor;
    scoreAgainst += v.scoreAgainst;
  }
  const decisive = wins + losses;
  return {
    played: views.length,
    wins,
    losses,
    draws,
    winRate: decisive ? Math.round((wins / decisive) * 100) : 0,
    scoreFor,
    scoreAgainst,
    scoreDiff: scoreFor - scoreAgainst,
  };
}

/** Current streak (from the most recent match backwards) and best win streak. */
export function streaksOf(chrono: TeamMatchView[]) {
  let bestWin = 0;
  let bestLoss = 0;
  let run = 0;
  let runType: MatchResult | null = null;
  for (const v of chrono) {
    if (v.result === runType) run++;
    else {
      runType = v.result;
      run = 1;
    }
    if (runType === 'W') bestWin = Math.max(bestWin, run);
    if (runType === 'L') bestLoss = Math.max(bestLoss, run);
  }
  // `run` / `runType` now describe the tail of the sequence = current streak.
  return {
    current: runType ? { type: runType, count: run } : null,
    bestWin,
    bestLoss,
  };
}

/** Biggest margin win (ties broken by the highest score). */
export function biggestWinOf(views: TeamMatchView[]) {
  let best: TeamMatchView | null = null;
  for (const v of views) {
    if (v.result !== 'W') continue;
    if (!best) {
      best = v;
      continue;
    }
    const margin = v.scoreFor - v.scoreAgainst;
    const bestMargin = best.scoreFor - best.scoreAgainst;
    if (margin > bestMargin || (margin === bestMargin && v.scoreFor > best.scoreFor)) best = v;
  }
  return best;
}

/** Cumulative win rate after each match (used by the win-rate chart). */
export function timelineOf(chrono: TeamMatchView[], limit = 20) {
  let wins = 0;
  let decisive = 0;
  const points = chrono.map((v) => {
    if (v.result === 'W') wins++;
    if (v.result !== 'D') decisive++;
    return {
      matchId: v.id,
      date: v.date,
      result: v.result,
      winRate: decisive ? Math.round((wins / decisive) * 100) : 0,
    };
  });
  return points.slice(-limit);
}

export function groupBy<T>(items: T[], key: (i: T) => string | null) {
  const map = new Map<string | null, T[]>();
  for (const it of items) {
    const k = key(it);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(it);
  }
  return map;
}

/** Standings of every team inside one set of completed matches. */
export function standingsOf(matches: MatchLike[]) {
  const teamIds = new Set<string>();
  for (const m of matches) {
    if (m.status !== 'completed') continue;
    teamIds.add(m.teamAId);
    teamIds.add(m.teamBId);
  }
  const rows = Array.from(teamIds).map((teamId) => ({
    teamId,
    ...recordOf(completedForTeam(teamId, matches)),
  }));
  rows.sort(
    (a, b) =>
      b.wins - a.wins ||
      b.winRate - a.winRate ||
      b.scoreDiff - a.scoreDiff ||
      a.losses - b.losses,
  );
  return rows;
}

export function isSeasonOver(season: SeasonLike, now = new Date()) {
  // The explicit lifecycle status wins over dates / the legacy flag.
  if (season.status === 'closed') return true;
  if (season.status === 'active' || season.status === 'playoffs') return false;
  if (season.endDate) {
    const d = new Date(season.endDate);
    if (!isNaN(d.getTime())) return d.getTime() < now.getTime();
  }
  return !season.isActive;
}

/**
 * Derived honours: the team is champion of every finished season in which it
 * holds the best record (at least one completed match required).
 */
export function derivedHonoursOf(
  teamId: string,
  matches: MatchLike[],
  seasons: SeasonLike[],
  now = new Date(),
) {
  const bySeason = groupBy(
    matches.filter((m) => m.status === 'completed' && m.seasonId),
    (m) => m.seasonId ?? null,
  );
  const out: any[] = [];
  for (const s of seasons) {
    if (!isSeasonOver(s, now)) continue;
    const ms = bySeason.get(s.id);
    if (!ms || ms.length === 0) continue;
    const standings = standingsOf(ms);
    const rank = standings.findIndex((r) => r.teamId === teamId);
    if (rank < 0 || rank > 2) continue;
    const row = standings[rank];
    const yearSrc = s.endDate ?? s.startDate ?? null;
    const year = yearSrc ? new Date(yearSrc).getFullYear() : null;
    out.push({
      id: `season:${s.id}`,
      source: 'derived',
      kind: 'season',
      placement: rank + 1,
      title: s.name,
      seasonId: s.id,
      seasonName: s.name,
      year: Number.isFinite(year as number) ? year : null,
      record: { played: row.played, wins: row.wins, losses: row.losses },
    });
  }
  return out;
}

export const STAFF_ROLES = [
  'coach',
  'assistant_coach',
  'manager',
  'analyst',
  'content',
  'other',
] as const;

/** Parse the manual honours JSON stored on the team (never throws). */
export function parseHonours(raw: unknown): any[] {
  if (!raw) return [];
  try {
    const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(list)) return [];
    return list
      .filter((h) => h && typeof h.title === 'string' && h.title.trim())
      .map((h, i) => ({
        id: typeof h.id === 'string' && h.id ? h.id : `manual:${i}`,
        source: 'manual',
        kind: 'manual',
        title: String(h.title).trim(),
        placement: Number.isFinite(+h.placement) && +h.placement > 0 ? Math.round(+h.placement) : null,
        year: Number.isFinite(+h.year) && +h.year > 1900 ? Math.round(+h.year) : null,
        description: typeof h.description === 'string' && h.description.trim() ? h.description.trim() : null,
      }));
  } catch {
    return [];
  }
}

const teamSelect = { id: true, name: true, image: true } as const;

@Injectable()
export class EsportStatsService {
  constructor(private prisma: PrismaService) {}

  private async assertTeam(id: string) {
    // Prisma throws on malformed ObjectIDs: treat them as "not found".
    const team = await this.prisma.esportTeam
      .findUnique({
        where: { id },
        select: { id: true, name: true, image: true, honours: true },
      })
      .catch(() => null);
    if (!team) throw new NotFoundException('Équipe introuvable.');
    return team;
  }

  private async teamMatches(teamId: string, where: any = {}) {
    return this.prisma.esportMatch.findMany({
      where: { ...where, OR: [{ teamAId: teamId }, { teamBId: teamId }] },
    });
  }

  private async teamMap(ids: string[]): Promise<Map<string, TeamRef>> {
    const uniq = Array.from(new Set(ids.filter(Boolean)));
    const teams = uniq.length
      ? await this.prisma.esportTeam.findMany({
          where: { id: { in: uniq } },
          select: teamSelect,
        })
      : [];
    return new Map(teams.map((tm) => [tm.id, tm]));
  }

  private async seasonMap(ids: (string | null)[]) {
    const uniq = Array.from(new Set(ids.filter(Boolean) as string[]));
    const seasons = uniq.length
      ? await this.prisma.esportSeason.findMany({ where: { id: { in: uniq } } })
      : [];
    return new Map(seasons.map((s) => [s.id, s]));
  }

  private opponentRef(id: string, tmap: Map<string, TeamRef>): TeamRef {
    return tmap.get(id) ?? { id, name: '?', image: null };
  }

  async getTeamStats(teamId: string) {
    await this.assertTeam(teamId);
    const raw = await this.teamMatches(teamId, { status: 'completed' });
    const chrono = completedForTeam(teamId, raw);
    const overall = recordOf(chrono);
    const streaks = streaksOf(chrono);
    const biggest = biggestWinOf(chrono);

    const tmap = await this.teamMap([
      ...chrono.map((v) => v.opponentId),
      ...(biggest ? [biggest.opponentId] : []),
    ]);
    const smap = await this.seasonMap(chrono.map((v) => v.seasonId));

    const bySeason = Array.from(groupBy(chrono, (v) => v.seasonId).entries()).map(
      ([seasonId, views]) => ({
        seasonId,
        season: seasonId ? (smap.get(seasonId)?.name ?? null) : null,
        startDate: seasonId ? (smap.get(seasonId)?.startDate ?? null) : null,
        ...recordOf(views),
      }),
    );
    bySeason.sort((a, b) => {
      const da = a.startDate ? new Date(a.startDate).getTime() : -Infinity;
      const db = b.startDate ? new Date(b.startDate).getTime() : -Infinity;
      return db - da;
    });

    const headToHead = Array.from(groupBy(chrono, (v) => v.opponentId).entries())
      .map(([opponentId, views]) => ({
        opponent: this.opponentRef(opponentId as string, tmap),
        ...recordOf(views),
        last: views[views.length - 1]
          ? { result: views[views.length - 1].result, date: views[views.length - 1].date }
          : null,
      }))
      .sort((a, b) => b.played - a.played || b.wins - a.wins);

    const byType = Array.from(groupBy(chrono, (v) => v.type).entries()).map(
      ([type, views]) => ({ type, ...recordOf(views) }),
    );

    return {
      teamId,
      ...overall,
      form: chrono.slice(-5).map((v) => v.result),
      currentStreak: streaks.current,
      bestWinStreak: streaks.bestWin,
      worstLossStreak: streaks.bestLoss,
      biggestWin: biggest
        ? {
            matchId: biggest.id,
            date: biggest.date,
            scoreFor: biggest.scoreFor,
            scoreAgainst: biggest.scoreAgainst,
            opponent: this.opponentRef(biggest.opponentId, tmap),
          }
        : null,
      timeline: timelineOf(chrono),
      bySeason,
      byType,
      headToHead,
    };
  }

  async getTeamHistory(teamId: string, page = 1, limit = 10, seasonId?: string) {
    const team = await this.assertTeam(teamId);
    const safeLimit = Math.min(50, Math.max(1, Math.floor(limit) || 10));
    // Optional season filter (global season switcher on the frontend).
    const raw = await this.teamMatches(teamId, {
      status: 'completed',
      ...(seasonId ? { seasonId } : {}),
    });
    const chrono = completedForTeam(teamId, raw);
    const desc = [...chrono].reverse();
    const total = desc.length;
    const pages = Math.max(1, Math.ceil(total / safeLimit));
    const safePage = Math.min(pages, Math.max(1, Math.floor(page) || 1));
    const slice = desc.slice((safePage - 1) * safeLimit, safePage * safeLimit);

    const tmap = await this.teamMap(slice.map((v) => v.opponentId));
    const smap = await this.seasonMap(slice.map((v) => v.seasonId));
    const items = slice.map((v) => ({
      id: v.id,
      date: v.date,
      type: v.type,
      result: v.result,
      scoreFor: v.scoreFor,
      scoreAgainst: v.scoreAgainst,
      opponent: this.opponentRef(v.opponentId, tmap),
      seasonId: v.seasonId,
      season: v.seasonId ? (smap.get(v.seasonId)?.name ?? null) : null,
    }));

    return {
      items,
      total,
      page: safePage,
      limit: safeLimit,
      pages,
      honours: await this.getHonours(teamId, team.honours, raw),
    };
  }

  /** Manual honours (admin) + derived season titles, most recent first. */
  async getHonours(teamId: string, rawHonours?: string | null, matches?: MatchLike[]) {
    let stored = rawHonours;
    if (stored === undefined) {
      const team = await this.assertTeam(teamId);
      stored = team.honours;
    }
    const seasons = await this.prisma.esportSeason.findMany();
    const seasonMatches =
      matches ??
      (await this.prisma.esportMatch.findMany({
        where: { status: 'completed', seasonId: { not: null } },
      }));
    const list = [...parseHonours(stored), ...derivedHonoursOf(teamId, seasonMatches, seasons)];
    return list.sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || (a.placement ?? 99) - (b.placement ?? 99));
  }

  async getTeamSchedule(teamId: string) {
    await this.assertTeam(teamId);
    const raw = await this.teamMatches(teamId, { status: 'scheduled' });
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const upcoming = raw
      .map((m) => ({ m, date: m.scheduledAt ? new Date(m.scheduledAt) : null }))
      .filter(({ date }) => !date || date.getTime() >= startOfToday.getTime())
      .sort((a, b) => {
        if (!a.date && !b.date) return 0;
        if (!a.date) return 1;
        if (!b.date) return -1;
        return a.date.getTime() - b.date.getTime();
      });
    const tmap = await this.teamMap(upcoming.flatMap(({ m }) => [m.teamAId, m.teamBId]));
    const smap = await this.seasonMap(upcoming.map(({ m }) => m.seasonId));
    return upcoming.map(({ m, date }) => {
      const isA = m.teamAId === teamId;
      return {
        id: m.id,
        date,
        type: m.type,
        status: m.status,
        notes: m.notes ?? null,
        isHome: isA,
        opponent: this.opponentRef(isA ? m.teamBId : m.teamAId, tmap),
        teamA: this.opponentRef(m.teamAId, tmap),
        teamB: this.opponentRef(m.teamBId, tmap),
        seasonId: m.seasonId ?? null,
        season: m.seasonId ? (smap.get(m.seasonId)?.name ?? null) : null,
      };
    });
  }
}
