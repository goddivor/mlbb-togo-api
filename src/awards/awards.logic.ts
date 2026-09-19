// Pure helpers for the season awards (#46), the playoffs podium and the Hall
// of Fame (#47). No I/O: everything works on plain rows so it can be unit
// tested and reused by the seasons service when a season is closed.

import { MatchLike, TeamRef, matchDate } from '../esport/esport-stats.service';
import { isPlayoffMatch, SeasonScope } from '../standings/standings.logic';
import { MatchRow, PlayerAggregate, PlayerRow, computePlayerRankings } from '../league-stats/league-stats.util';
import type { BracketMatch } from '../tournaments/bracket.util';

export const FIXED_CATEGORIES = ['mvp', 'best_gold', 'best_mid', 'best_jungle', 'best_roam', 'best_exp'] as const;
export const AWARD_CATEGORIES = [...FIXED_CATEGORIES, 'custom'] as const;
export type FixedCategory = (typeof FIXED_CATEGORIES)[number];
export type AwardCategory = (typeof AWARD_CATEGORIES)[number];

/** Lane covered by a "best_*" award (null for the MVP and custom awards). */
export const CATEGORY_LANE: Record<AwardCategory, string | null> = {
  mvp: null,
  best_gold: 'gold',
  best_mid: 'mid',
  best_jungle: 'jungle',
  best_roam: 'roam',
  best_exp: 'exp',
  custom: null,
};

/** Display order of the categories (MVP first, then the lanes, then customs). */
export const CATEGORY_ORDER: Record<AwardCategory, number> = {
  mvp: 0,
  best_gold: 1,
  best_jungle: 2,
  best_mid: 3,
  best_exp: 4,
  best_roam: 5,
  custom: 9,
};

export function isAwardCategory(v: unknown): v is AwardCategory {
  return typeof v === 'string' && (AWARD_CATEGORIES as readonly string[]).includes(v);
}

export function isFixedCategory(v: unknown): v is FixedCategory {
  return typeof v === 'string' && (FIXED_CATEGORIES as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Award suggestions
// ---------------------------------------------------------------------------

/** Stats snapshot stored with an award (`criteria` JSON). */
export type AwardCriteria = {
  games: number;
  wins: number;
  losses: number;
  winRate: number;
  kills: number;
  deaths: number;
  assists: number;
  avgKills: number;
  avgDeaths: number;
  avgAssists: number;
  kda: number;
  mvpCount: number;
  role: string | null;
  topHeroes: { key: string; count: number }[];
  /** How the winner was ranked ("mvp" = MVP count, "kda" = KDA on the lane). */
  basis: 'mvp' | 'kda';
  /** Minimum games required to be eligible when the suggestion was made. */
  minGames: number;
};

export type AwardSuggestion = {
  category: FixedCategory;
  lane: string | null;
  userId: string;
  teamId: string;
  criteria: AwardCriteria;
  /** Runner-ups (next best candidates) for the admin picker. */
  alternatives: { userId: string; teamId: string; criteria: AwardCriteria }[];
};

export function criteriaOf(p: PlayerAggregate, basis: 'mvp' | 'kda', minGames: number): AwardCriteria {
  return {
    games: p.games,
    wins: p.wins,
    losses: p.losses,
    winRate: p.winRate,
    kills: p.kills,
    deaths: p.deaths,
    assists: p.assists,
    avgKills: p.avgKills,
    avgDeaths: p.avgDeaths,
    avgAssists: p.avgAssists,
    kda: p.kda,
    mvpCount: p.mvpCount,
    role: p.role,
    topHeroes: p.topHeroes,
    basis,
    minGames,
  };
}

/** MVP order: most match MVPs, then KDA, then win rate, then games. */
export function compareMvp(a: PlayerAggregate, b: PlayerAggregate) {
  return (
    b.mvpCount - a.mvpCount ||
    b.kda - a.kda ||
    b.winRate - a.winRate ||
    b.games - a.games ||
    a.userId.localeCompare(b.userId)
  );
}

/** Lane award order: best KDA, then MVP count, then win rate, then games. */
export function compareLane(a: PlayerAggregate, b: PlayerAggregate) {
  return (
    b.kda - a.kda ||
    b.mvpCount - a.mvpCount ||
    b.winRate - a.winRate ||
    b.games - a.games ||
    a.userId.localeCompare(b.userId)
  );
}

export type SuggestOptions = {
  /** Minimum games (with stats) to be eligible; relaxed to 1 when nobody qualifies. */
  minGames?: number;
  /** Number of runner-ups returned per category. */
  alternatives?: number;
};

/**
 * Suggested winners per fixed category, computed from the completed matches
 * of a season and their per-player stats:
 *  - `mvp`: the player with the most match MVPs (ties: KDA, win rate, games);
 *  - `best_<lane>`: the best KDA among the games played on that lane (ties:
 *    MVP count, win rate, games).
 * Players need `minGames` games (default 3) to be eligible; when nobody
 * reaches it the threshold falls back to 1 so small seasons still get a
 * suggestion. Categories without any candidate are omitted.
 */
export function suggestAwards(matches: MatchRow[], players: PlayerRow[], opts: SuggestOptions = {}): AwardSuggestion[] {
  const wanted = Math.max(1, Math.floor(opts.minGames ?? 3));
  const alt = Math.max(0, Math.floor(opts.alternatives ?? 3));
  const out: AwardSuggestion[] = [];

  const pick = (
    category: FixedCategory,
    lane: string | null,
    basis: 'mvp' | 'kda',
    compare: (a: PlayerAggregate, b: PlayerAggregate) => number,
  ) => {
    const all = computePlayerRankings(matches, players, { role: lane, sort: 'kda', limit: 10_000 });
    if (!all.length) return;
    let minGames = wanted;
    let eligible = all.filter((p) => p.games >= minGames);
    if (!eligible.length) {
      minGames = 1;
      eligible = all;
    }
    eligible.sort(compare);
    const [best, ...rest] = eligible;
    out.push({
      category,
      lane,
      userId: best.userId,
      teamId: best.teamId,
      criteria: criteriaOf(best, basis, minGames),
      alternatives: rest.slice(0, alt).map((p) => ({ userId: p.userId, teamId: p.teamId, criteria: criteriaOf(p, basis, minGames) })),
    });
  };

  pick('mvp', null, 'mvp', compareMvp);
  for (const category of FIXED_CATEGORIES) {
    const lane = CATEGORY_LANE[category];
    if (lane) pick(category, lane, 'kda', compareLane);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Podiums
// ---------------------------------------------------------------------------

export type PodiumEntry = { placement: 1 | 2 | 3; teamId: string };
export type PodiumWithTeam = PodiumEntry & { team: TeamRef };

/** JSON stored in `EsportSeason.podiums` (both keys optional / null = automatic). */
export type SeasonPodiums = {
  regular: PodiumEntry[] | null;
  playoffs: PodiumEntry[] | null;
};

export function parsePodiums(raw: unknown): SeasonPodiums {
  const empty: SeasonPodiums = { regular: null, playoffs: null };
  if (!raw) return empty;
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!obj || typeof obj !== 'object') return empty;
    return { regular: normalizePodium(obj.regular), playoffs: normalizePodium(obj.playoffs) };
  } catch {
    return empty;
  }
}

/**
 * Sanitize a podium payload: placements 1..3, one team per placement, no
 * team twice, sorted by placement. Returns null for empty / invalid input.
 */
export function normalizePodium(input: unknown): PodiumEntry[] | null {
  if (!Array.isArray(input)) return null;
  const seenPlace = new Set<number>();
  const seenTeam = new Set<string>();
  const out: PodiumEntry[] = [];
  for (const row of input) {
    const placement = Number(row?.placement);
    const teamId = typeof row?.teamId === 'string' ? row.teamId.trim() : '';
    if (![1, 2, 3].includes(placement) || !teamId) continue;
    if (seenPlace.has(placement) || seenTeam.has(teamId)) continue;
    seenPlace.add(placement);
    seenTeam.add(teamId);
    out.push({ placement: placement as 1 | 2 | 3, teamId });
  }
  out.sort((a, b) => a.placement - b.placement);
  return out.length ? out : null;
}

export function decoratePodium(entries: PodiumEntry[] | null | undefined, teams: Map<string, TeamRef>): PodiumWithTeam[] {
  return (entries ?? []).map((e) => ({ ...e, team: teams.get(e.teamId) ?? { id: e.teamId, name: '?', image: null } }));
}

export type PlayoffMatchLike = MatchLike & { stage?: string | null };

/** Playoff game: explicit `stage` (#44) or the legacy type / date rule of the standings. */
export function isPlayoffGame(m: PlayoffMatchLike, season?: SeasonScope | null): boolean {
  return m.stage === 'playoff' || isPlayoffMatch(m, season);
}

const time = (m: MatchLike) => matchDate(m)?.getTime() ?? 0;
const loserOf = (m: MatchLike) => (m.winnerTeamId === m.teamAId ? m.teamBId : m.teamAId);
const diffFor = (teamId: string, m: MatchLike) => {
  const a = m.scoreA ?? 0;
  const b = m.scoreB ?? 0;
  return m.teamAId === teamId ? a - b : b - a;
};

/**
 * Playoffs podium derived from the completed playoff-stage matches of a
 * season (single-elimination reading):
 *  1. the final is the most recent decided playoff match; its winner is 1st
 *     and its loser is 2nd;
 *  2. a third-place match is a decided match, played after the semi-finals,
 *     between two teams that already lost a playoff match: its winner is 3rd;
 *  3. otherwise 3rd goes to the most recently eliminated non-finalist (ties:
 *     best score difference in the eliminating match, then team id).
 * Returns null when no decided playoff match exists.
 */
export function derivePlayoffsPodium(matches: PlayoffMatchLike[], season?: SeasonScope | null): PodiumEntry[] | null {
  const decided = matches
    .filter((m) => m.status === 'completed' && m.winnerTeamId && isPlayoffGame(m, season))
    .sort((a, b) => time(b) - time(a) || String(b.id).localeCompare(String(a.id)));
  if (!decided.length) return null;

  // Losses in chronological order to know who was already eliminated.
  const chrono = [...decided].reverse();
  const lostBefore = new Map<string, number>(); // teamId -> count of losses so far
  const isThirdPlace = new Map<string, boolean>();
  for (const m of chrono) {
    const la = lostBefore.get(m.teamAId) ?? 0;
    const lb = lostBefore.get(m.teamBId) ?? 0;
    isThirdPlace.set(m.id, la > 0 && lb > 0);
    lostBefore.set(loserOf(m), (lostBefore.get(loserOf(m)) ?? 0) + 1);
  }

  const final = decided.find((m) => !isThirdPlace.get(m.id)) ?? decided[0];
  const first = final.winnerTeamId as string;
  const second = loserOf(final);
  const podium: PodiumEntry[] = [
    { placement: 1, teamId: first },
    { placement: 2, teamId: second },
  ];

  const finalists = new Set([first, second]);
  const thirdPlaceMatch = decided.find(
    (m) => isThirdPlace.get(m.id) && !finalists.has(m.teamAId) && !finalists.has(m.teamBId),
  );
  let third: string | null = thirdPlaceMatch ? (thirdPlaceMatch.winnerTeamId as string) : null;

  if (!third) {
    // Most recently eliminated non-finalist.
    const eliminated = new Map<string, { at: number; diff: number }>();
    for (const m of decided) {
      const loser = loserOf(m);
      if (finalists.has(loser)) continue;
      const prev = eliminated.get(loser);
      const cur = { at: time(m), diff: diffFor(loser, m) };
      if (!prev || cur.at > prev.at) eliminated.set(loser, cur);
    }
    const ranked = Array.from(eliminated.entries()).sort(
      (a, b) => b[1].at - a[1].at || b[1].diff - a[1].diff || a[0].localeCompare(b[0]),
    );
    third = ranked[0]?.[0] ?? null;
  }
  if (third) podium.push({ placement: 3, teamId: third });
  return podium;
}

/**
 * Playoffs podium read from a single-elimination tournament bracket
 * (`Tournament.brackets`): the final is the match of the last round; 3rd
 * goes to the semi-final loser with the best score difference (ties: lower
 * bracket position). Returns null until the final is finished.
 */
export function derivePodiumFromBracket(bracket: BracketMatch[]): PodiumEntry[] | null {
  if (!Array.isArray(bracket) || !bracket.length) return null;
  const last = Math.max(...bracket.map((m) => m.round));
  const final = bracket.find((m) => m.round === last && m.position === 0) ?? bracket.find((m) => m.round === last);
  if (!final || final.status !== 'finished' || !final.winnerTeamId || !final.teamAId || !final.teamBId) return null;
  const first = final.winnerTeamId;
  const second = final.teamAId === first ? final.teamBId : final.teamAId;
  const podium: PodiumEntry[] = [
    { placement: 1, teamId: first },
    { placement: 2, teamId: second },
  ];
  const semis = bracket
    .filter((m) => m.round === last - 1 && m.status === 'finished' && m.winnerTeamId && m.teamAId && m.teamBId)
    .map((m) => {
      const loser = (m.teamAId === m.winnerTeamId ? m.teamBId : m.teamAId) as string;
      const diff = m.teamAId === loser ? m.scoreA - m.scoreB : m.scoreB - m.scoreA;
      return { loser, diff, position: m.position };
    })
    .filter((s) => s.loser !== first && s.loser !== second)
    .sort((a, b) => b.diff - a.diff || a.position - b.position);
  if (semis[0]) podium.push({ placement: 3, teamId: semis[0].loser });
  return podium;
}

// ---------------------------------------------------------------------------
// Serialization helpers shared with the seasons summary
// ---------------------------------------------------------------------------

export type AwardRecord = {
  id: string;
  seasonId: string;
  category: string;
  title?: string | null;
  userId?: string | null;
  teamId?: string | null;
  description?: string | null;
  imageUrl?: string | null;
  criteria?: string | null;
  sort?: number | null;
  createdAt?: Date;
  updatedAt?: Date;
};

export function parseCriteria(raw: unknown): Partial<AwardCriteria> | null {
  if (!raw) return null;
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

export function compareAwards(a: AwardRecord, b: AwardRecord) {
  const oa = CATEGORY_ORDER[a.category as AwardCategory] ?? 9;
  const ob = CATEGORY_ORDER[b.category as AwardCategory] ?? 9;
  return oa - ob || (a.sort ?? 0) - (b.sort ?? 0) || String(a.title ?? '').localeCompare(String(b.title ?? ''));
}

export type UserRef = { id: string; username: string; displayName: string; avatar: string | null };

/** Public shape of an award (user / team resolved by the caller). */
export function serializeAward(a: AwardRecord, users: Map<string, UserRef>, teams: Map<string, TeamRef>) {
  return {
    id: a.id,
    seasonId: a.seasonId,
    category: a.category,
    lane: CATEGORY_LANE[a.category as AwardCategory] ?? null,
    title: a.title ?? null,
    userId: a.userId ?? null,
    user: a.userId ? (users.get(a.userId) ?? { id: a.userId, username: '?', displayName: '?', avatar: null }) : null,
    teamId: a.teamId ?? null,
    team: a.teamId ? (teams.get(a.teamId) ?? { id: a.teamId, name: '?', image: null }) : null,
    description: a.description ?? null,
    imageUrl: a.imageUrl ?? null,
    criteria: parseCriteria(a.criteria),
    sort: a.sort ?? 0,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

export type SerializedAward = ReturnType<typeof serializeAward>;
