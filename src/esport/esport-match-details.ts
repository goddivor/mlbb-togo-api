import { BadRequestException } from '@nestjs/common';

/**
 * Pure helpers for the "match sheet" fields added by the matches & calendar
 * feature: stage (scrim / league / playoff), series format (BOn), per-game
 * details, screenshots, VOD / stream links and match MVP.
 *
 * Everything here is side-effect free so the rules can be unit tested
 * without a database.
 */

export const MATCH_STAGES = ['scrim', 'league', 'playoff'] as const;
export type MatchStage = (typeof MATCH_STAGES)[number];

export const MATCH_FORMATS = ['bo1', 'bo3', 'bo5', 'bo7'] as const;
export type MatchFormat = (typeof MATCH_FORMATS)[number];

export const MAX_SCREENSHOTS = 10;
const MAX_URL_LENGTH = 2048;
/** Longest realistic MLBB game (seconds). */
const MAX_GAME_DURATION = 3 * 60 * 60;

export interface MatchGame {
  /** 1-based game number. */
  number: number;
  winnerTeamId: string | null;
  /** Game duration in seconds. */
  duration: number | null;
  /** Per-game MVP (user id). */
  mvpUserId: string | null;
  /** Screenshot of the end-of-game scoreboard. */
  screenshot: string | null;
}

export interface MatchLikeRow {
  type?: string | null;
  stage?: string | null;
  teamAId: string;
  teamBId: string;
}

/** Legacy mapping: the historical `type` decides the stage. */
export function stageFromType(type: string | null | undefined): MatchStage {
  return type === 'official' ? 'league' : 'scrim';
}

/** Keep the legacy `type` column meaningful for a given stage. */
export function typeFromStage(stage: MatchStage, currentType?: string | null): string {
  if (stage === 'scrim') {
    // Friendly and training are both scrims: keep the finer legacy value.
    return currentType === 'training' ? 'training' : 'friendly';
  }
  return 'official';
}

export function isStage(v: unknown): v is MatchStage {
  return typeof v === 'string' && (MATCH_STAGES as readonly string[]).includes(v);
}

export function isFormat(v: unknown): v is MatchFormat {
  return typeof v === 'string' && (MATCH_FORMATS as readonly string[]).includes(v);
}

/** Effective stage of a row: explicit value, else derived from `type`. */
export function resolveStage(row: Pick<MatchLikeRow, 'type' | 'stage'>): MatchStage {
  return isStage(row.stage) ? row.stage : stageFromType(row.type);
}

/** Number of games of a series format (bo3 -> 3). */
export function maxGames(format: string | null | undefined): number {
  return isFormat(format) ? Number(format.slice(2)) : 1;
}

/** Wins needed to take the series (bo3 -> 2). */
export function winsNeeded(format: string | null | undefined): number {
  return Math.ceil(maxGames(format) / 2);
}

export function isHttpUrl(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > MAX_URL_LENGTH) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Optional http(s) URL: empty -> null, invalid -> 400. */
export function normalizeUrl(v: unknown, label: string): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (!isHttpUrl(v)) throw new BadRequestException(`URL invalide pour « ${label} ».`);
  return v.trim();
}

function parseJsonArray(raw: string | null | undefined): unknown[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Parse the stored screenshots JSON (never throws). */
export function parseScreenshots(raw: string | null | undefined): string[] {
  return parseJsonArray(raw).filter(isHttpUrl).slice(0, MAX_SCREENSHOTS);
}

/** Validate an admin screenshots payload and return the JSON to persist. */
export function normalizeScreenshots(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  if (!Array.isArray(input)) throw new BadRequestException('Les captures doivent être une liste d’URL.');
  const urls = input
    .map((u) => (typeof u === 'string' ? u.trim() : u))
    .filter((u) => u !== '' && u !== null && u !== undefined);
  if (urls.length > MAX_SCREENSHOTS)
    throw new BadRequestException(`Au maximum ${MAX_SCREENSHOTS} captures par match.`);
  for (const u of urls) {
    if (!isHttpUrl(u)) throw new BadRequestException('Chaque capture doit être une URL http(s).');
  }
  const uniq = Array.from(new Set(urls as string[]));
  return uniq.length ? JSON.stringify(uniq) : null;
}

/** Parse the stored games JSON (never throws, unknown rows dropped). */
export function parseGames(raw: string | null | undefined): MatchGame[] {
  return parseJsonArray(raw)
    .filter((g): g is Record<string, unknown> => !!g && typeof g === 'object')
    .map((g, i) => ({
      number: i + 1,
      winnerTeamId: typeof g.winnerTeamId === 'string' ? g.winnerTeamId : null,
      duration: Number.isFinite(Number(g.duration)) && g.duration !== null ? Number(g.duration) : null,
      mvpUserId: typeof g.mvpUserId === 'string' ? g.mvpUserId : null,
      screenshot: isHttpUrl(g.screenshot) ? g.screenshot : null,
    }));
}

/**
 * Validate a games payload against the match. Each game must name one of the
 * two teams as winner (or none while it is being played); the count cannot
 * exceed the format and no team can win more games than the series allows.
 */
export function normalizeGames(
  input: unknown,
  match: Pick<MatchLikeRow, 'teamAId' | 'teamBId'>,
  format: string | null | undefined,
): MatchGame[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new BadRequestException('Les games doivent être une liste.');
  const limit = maxGames(format);
  if (input.length > limit)
    throw new BadRequestException(`Un ${(format || 'bo1').toUpperCase()} compte au plus ${limit} game(s).`);
  const games: MatchGame[] = input.map((g: any, i: number) => {
    if (!g || typeof g !== 'object') throw new BadRequestException(`Game ${i + 1} invalide.`);
    let winnerTeamId: string | null = null;
    if (g.winnerTeamId) {
      if (g.winnerTeamId !== match.teamAId && g.winnerTeamId !== match.teamBId)
        throw new BadRequestException(`Game ${i + 1} : le vainqueur doit être l’une des deux équipes.`);
      winnerTeamId = g.winnerTeamId;
    }
    let duration: number | null = null;
    if (g.duration !== undefined && g.duration !== null && g.duration !== '') {
      const d = Math.round(Number(g.duration));
      if (!Number.isFinite(d) || d < 0 || d > MAX_GAME_DURATION)
        throw new BadRequestException(`Game ${i + 1} : durée invalide.`);
      duration = d;
    }
    const mvpUserId =
      typeof g.mvpUserId === 'string' && g.mvpUserId.trim() ? g.mvpUserId.trim() : null;
    const screenshot = normalizeUrl(g.screenshot, `capture de la game ${i + 1}`);
    return { number: i + 1, winnerTeamId, duration, mvpUserId, screenshot };
  });
  const needed = winsNeeded(format);
  const { scoreA, scoreB } = scoreFromGames(games, match);
  if (scoreA > needed || scoreB > needed)
    throw new BadRequestException(
      `Une équipe ne peut pas gagner plus de ${needed} game(s) dans un ${(format || 'bo1').toUpperCase()}.`,
    );
  return games;
}

/** Series score derived from the games (one point per game won). */
export function scoreFromGames(
  games: MatchGame[],
  match: Pick<MatchLikeRow, 'teamAId' | 'teamBId'>,
): { scoreA: number; scoreB: number; winnerTeamId: string | null } {
  let scoreA = 0;
  let scoreB = 0;
  for (const g of games) {
    if (g.winnerTeamId === match.teamAId) scoreA++;
    else if (g.winnerTeamId === match.teamBId) scoreB++;
  }
  const winnerTeamId = scoreA > scoreB ? match.teamAId : scoreB > scoreA ? match.teamBId : null;
  return { scoreA, scoreB, winnerTeamId };
}

/**
 * The declared result must agree with the games: same score and a winner
 * that actually won more games. Called whenever games are provided next to
 * a result (scores and/or an explicit winner).
 */
export function assertResultMatchesGames(
  games: MatchGame[],
  match: Pick<MatchLikeRow, 'teamAId' | 'teamBId'>,
  result: { scoreA?: number | null; scoreB?: number | null; winnerTeamId?: string | null },
) {
  if (!games.length) return;
  const derived = scoreFromGames(games, match);
  if (
    (result.scoreA != null && result.scoreA !== derived.scoreA) ||
    (result.scoreB != null && result.scoreB !== derived.scoreB)
  )
    throw new BadRequestException(
      `Le score (${result.scoreA ?? '?'}-${result.scoreB ?? '?'}) ne correspond pas aux games (${derived.scoreA}-${derived.scoreB}).`,
    );
  if (result.winnerTeamId && derived.winnerTeamId && result.winnerTeamId !== derived.winnerTeamId)
    throw new BadRequestException('Le vainqueur déclaré ne correspond pas aux games.');
  if (result.winnerTeamId && !derived.winnerTeamId)
    throw new BadRequestException('Les games sont à égalité : impossible de désigner ce vainqueur.');
}

/** Games JSON to persist (null when empty). */
export function serializeGames(games: MatchGame[]): string | null {
  if (!games.length) return null;
  return JSON.stringify(
    games.map((g) => ({
      winnerTeamId: g.winnerTeamId,
      duration: g.duration,
      mvpUserId: g.mvpUserId,
      screenshot: g.screenshot,
    })),
  );
}

/** Format an ISO day key (UTC) used to group the calendar. */
export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Group matches by scheduled day (UTC), oldest day first, matches ordered by
 * time inside a day. Matches without a date are grouped under `undated`.
 */
export function groupByDay<T extends { scheduledAt?: Date | string | null }>(matches: T[]) {
  const map = new Map<string, T[]>();
  const undated: T[] = [];
  for (const m of matches) {
    const d = m.scheduledAt ? new Date(m.scheduledAt) : null;
    if (!d || isNaN(d.getTime())) {
      undated.push(m);
      continue;
    }
    const key = dayKey(d);
    const list = map.get(key) ?? [];
    list.push(m);
    map.set(key, list);
  }
  const days = Array.from(map.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, list]) => ({
      date,
      matches: [...list].sort(
        (a, b) => new Date(a.scheduledAt as any).getTime() - new Date(b.scheduledAt as any).getTime(),
      ),
    }));
  return { days, undated };
}
