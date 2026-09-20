import { FIXED_CATEGORIES } from '../awards/awards.logic';
import { resolveStage, parseGames, MatchStage } from '../esport/esport-match-details';

/**
 * Pure helpers of the league control room (#56): match counters, awards
 * coverage and the season closing checklist. No I/O so everything is unit
 * testable; the service only feeds Prisma rows into these functions.
 */

export type LeagueMatchRow = {
  id: string;
  status: string;
  type?: string | null;
  stage?: string | null;
  scheduledAt?: Date | string | null;
  updatedAt?: Date | string | null;
  games?: string | null;
};

export type MatchCounts = {
  total: number;
  byStatus: { scheduled: number; completed: number; cancelled: number };
  byStage: Record<MatchStage, number>;
  /** Completed matches whose last update falls in the past 7 days. */
  completedThisWeek: number;
  /** Completed matches with neither per-game details nor player rows. */
  pendingResults: number;
  /** Scheduled matches without a date. */
  unscheduled: number;
  /** Scheduled matches whose date is already in the past (result missing). */
  overdue: number;
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function toTime(v: Date | string | null | undefined): number | null {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
}

/** Does the completed match carry a scoresheet (games or player stats)? */
export function hasScoresheet(m: LeagueMatchRow, playerRows: number): boolean {
  if (playerRows > 0) return true;
  return parseGames(m.games).length > 0;
}

export function countMatches(
  matches: LeagueMatchRow[],
  playerRowsByMatch: Map<string, number>,
  now = new Date(),
): MatchCounts {
  const out: MatchCounts = {
    total: matches.length,
    byStatus: { scheduled: 0, completed: 0, cancelled: 0 },
    byStage: { scrim: 0, league: 0, playoff: 0 },
    completedThisWeek: 0,
    pendingResults: 0,
    unscheduled: 0,
    overdue: 0,
  };
  const weekAgo = now.getTime() - WEEK_MS;
  for (const m of matches) {
    const status = m.status as keyof MatchCounts['byStatus'];
    if (status in out.byStatus) out.byStatus[status]++;
    out.byStage[resolveStage(m)]++;
    if (m.status === 'completed') {
      const updated = toTime(m.updatedAt);
      if (updated !== null && updated >= weekAgo) out.completedThisWeek++;
      if (!hasScoresheet(m, playerRowsByMatch.get(m.id) ?? 0)) out.pendingResults++;
    } else if (m.status === 'scheduled') {
      const at = toTime(m.scheduledAt);
      if (at === null) out.unscheduled++;
      else if (at < now.getTime()) out.overdue++;
    }
  }
  return out;
}

export type AwardsCoverage = {
  filled: number;
  total: number;
  missing: string[];
  custom: number;
};

export function awardsCoverage(awards: { category: string }[]): AwardsCoverage {
  const present = new Set(awards.map((a) => a.category));
  const missing = FIXED_CATEGORIES.filter((c) => !present.has(c));
  return {
    filled: FIXED_CATEGORIES.length - missing.length,
    total: FIXED_CATEGORIES.length,
    missing: [...missing],
    custom: awards.filter((a) => a.category === 'custom').length,
  };
}

export type ChecklistItem = {
  key: 'matchesResolved' | 'scoresheets' | 'awards' | 'podiums' | 'summary';
  done: boolean;
  /** Remaining count when relevant (matches left, awards missing…). */
  remaining: number;
  href: string;
};

export type ChecklistInput = {
  seasonId: string;
  counts: MatchCounts;
  awards: AwardsCoverage;
  podiums: { regular: boolean; playoffs: boolean };
  summaryAvailable: boolean;
};

/**
 * Closing checklist: every scheduled match resolved (completed or
 * cancelled), no result without scoresheet, the 6 fixed awards attributed,
 * a regular podium set and the summary preview computable.
 */
export function buildChecklist(input: ChecklistInput): ChecklistItem[] {
  const { seasonId, counts, awards, podiums, summaryAvailable } = input;
  const season = encodeURIComponent(seasonId);
  return [
    {
      key: 'matchesResolved',
      done: counts.byStatus.scheduled === 0,
      remaining: counts.byStatus.scheduled,
      href: `/admin/matches?season=${season}&status=scheduled`,
    },
    {
      key: 'scoresheets',
      done: counts.pendingResults === 0,
      remaining: counts.pendingResults,
      href: `/admin/matches?season=${season}&status=pending`,
    },
    {
      key: 'awards',
      done: awards.filled >= awards.total,
      remaining: awards.total - awards.filled,
      href: `/admin/awards?season=${season}`,
    },
    {
      key: 'podiums',
      done: podiums.regular,
      remaining: podiums.regular ? 0 : 1,
      href: `/admin/awards?season=${season}#podiums`,
    },
    {
      key: 'summary',
      done: summaryAvailable,
      remaining: summaryAvailable ? 0 : 1,
      href: `/admin/seasons`,
    },
  ];
}

export function checklistReady(items: ChecklistItem[]): boolean {
  return items.every((i) => i.done);
}

/** Announcement counters of the feed (last 7 days by default). */
export function countRecent(rows: { createdAt: Date | string }[], now = new Date(), windowMs = WEEK_MS): number {
  const since = now.getTime() - windowMs;
  return rows.filter((r) => (toTime(r.createdAt) ?? 0) >= since).length;
}
