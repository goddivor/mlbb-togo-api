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

/**
 * Hero picked by a player during one game of the series. Stored inside the
 * `EsportMatch.games` JSON (no dedicated table): a game is a full 5v5 draft,
 * so the picks belong to the game, not to the match.
 */
export interface MatchPick {
  /** Platform account of the player. */
  userId: string;
  /** Side he played for (one of the two teams of the match). */
  teamId: string;
  /** Catalog `Hero` id when resolved. */
  heroId: string | null;
  /** Catalog hero name (kept next to the id so the UI never needs a join). */
  hero: string | null;
  /** Substitute brought in for this game. */
  isSub: boolean;
}

export const MAX_PICKS_PER_GAME = 12;

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
  /**
   * Per-game draft. Absent (rather than empty) when the game has no recorded
   * picks, so games saved before this feature round-trip unchanged.
   */
  picks?: MatchPick[];
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

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Parse the picks of a stored game (never throws, unusable rows dropped). */
function parsePicks(raw: unknown): MatchPick[] {
  if (!Array.isArray(raw)) return [];
  const picks: MatchPick[] = [];
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue;
    const row = p as Record<string, unknown>;
    const userId = str(row.userId);
    const teamId = str(row.teamId);
    if (!userId || !teamId) continue;
    picks.push({
      userId,
      teamId,
      heroId: str(row.heroId),
      hero: str(row.hero),
      isSub: row.isSub === true,
    });
  }
  return picks.slice(0, MAX_PICKS_PER_GAME);
}

/** Parse the stored games JSON (never throws, unknown rows dropped). */
export function parseGames(raw: string | null | undefined): MatchGame[] {
  return parseJsonArray(raw)
    .filter((g): g is Record<string, unknown> => !!g && typeof g === 'object')
    .map((g, i) => {
      const picks = parsePicks(g.picks);
      return {
        number: i + 1,
        winnerTeamId: typeof g.winnerTeamId === 'string' ? g.winnerTeamId : null,
        duration: Number.isFinite(Number(g.duration)) && g.duration !== null ? Number(g.duration) : null,
        mvpUserId: typeof g.mvpUserId === 'string' ? g.mvpUserId : null,
        screenshot: isHttpUrl(g.screenshot) ? g.screenshot : null,
        // Omitted (not `[]`) when empty: games recorded before the draft was
        // stored must round-trip byte for byte.
        ...(picks.length ? { picks } : {}),
      };
    });
}

/** MongoDB object id, the only shape an id field of a pick may take. */
const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
const MAX_HERO_NAME = 60;

/**
 * Allowed values a draft may reference. Both are optional so the pure layer
 * stays usable without a database; the service passes the real sets (match
 * participants / rosters, hero catalog) so a pick can never name a user or a
 * hero that does not exist.
 */
export type PickScope = {
  userIds?: Set<string> | null;
  heroIds?: Set<string> | null;
};

/**
 * Validate the picks of one game: both sides must be teams of the match, ids
 * must be real object ids (and, when a scope is given, known ones) and a
 * player can only pick once per game.
 */
export function normalizePicks(
  input: unknown,
  match: Pick<MatchLikeRow, 'teamAId' | 'teamBId'>,
  gameNumber: number,
  scope: PickScope = {},
): MatchPick[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input))
    throw new BadRequestException(`Game ${gameNumber} : les picks doivent être une liste.`);
  if (input.length > MAX_PICKS_PER_GAME)
    throw new BadRequestException(
      `Game ${gameNumber} : au maximum ${MAX_PICKS_PER_GAME} picks.`,
    );
  const seen = new Set<string>();
  return input.map((p: any) => {
    if (!p || typeof p !== 'object')
      throw new BadRequestException(`Game ${gameNumber} : pick invalide.`);
    const userId = str(p.userId);
    const teamId = str(p.teamId);
    if (!userId) throw new BadRequestException(`Game ${gameNumber} : pick sans joueur.`);
    if (!OBJECT_ID.test(userId))
      throw new BadRequestException(`Game ${gameNumber} : identifiant de joueur invalide.`);
    if (scope.userIds && !scope.userIds.has(userId))
      throw new BadRequestException(
        `Game ${gameNumber} : ce joueur ne fait partie d’aucune des deux équipes.`,
      );
    if (teamId !== match.teamAId && teamId !== match.teamBId)
      throw new BadRequestException(
        `Game ${gameNumber} : chaque pick doit appartenir à l’une des deux équipes.`,
      );
    if (seen.has(userId))
      throw new BadRequestException(
        `Game ${gameNumber} : un joueur ne peut apparaître qu’une fois.`,
      );
    seen.add(userId);
    const heroId = str(p.heroId);
    if (heroId && !OBJECT_ID.test(heroId))
      throw new BadRequestException(`Game ${gameNumber} : identifiant de héros invalide.`);
    if (heroId && scope.heroIds && !scope.heroIds.has(heroId))
      throw new BadRequestException(`Game ${gameNumber} : héros inconnu du catalogue.`);
    const hero = str(p.hero);
    if (hero && hero.length > MAX_HERO_NAME)
      throw new BadRequestException(`Game ${gameNumber} : nom de héros invalide.`);
    return { userId, teamId, heroId, hero, isSub: p.isSub === true };
  });
}

/**
 * Safety net for a games payload that says nothing about the draft.
 *
 * A caller that knows about the picks sends them back, and an explicit `picks`
 * key (including `picks: []`, which clears the draft) always wins. For an older
 * caller that simply omits the field, the stored draft is brought back so
 * saving a result does not silently wipe it.
 *
 * Games can only be matched by position, which is meaningless as soon as one is
 * inserted or removed: the fallback therefore only applies when the payload has
 * exactly as many games as the stored series. Any other shape drops the missing
 * drafts rather than shifting them onto the wrong game.
 */
export function carryOverPicks(
  input: unknown,
  games: MatchGame[],
  stored: MatchGame[],
): MatchGame[] {
  const rows = Array.isArray(input) ? input : [];
  const mentionsPicks = (i: number) => {
    const sent = rows[i];
    return !!sent && typeof sent === 'object' && (sent as Record<string, unknown>).picks !== undefined;
  };
  // A different length means games were added or removed: positions no longer
  // line up with the stored series, so nothing may be carried over.
  const alignable = rows.length === stored.length && games.length === stored.length;
  return games.map((g, i) => {
    if (mentionsPicks(i) || !alignable) return g;
    const previous = stored[i]?.picks;
    return previous?.length ? { ...g, picks: previous } : g;
  });
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
  scope: PickScope = {},
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
    const picks = normalizePicks(g.picks, match, i + 1, scope);
    return {
      number: i + 1,
      winnerTeamId,
      duration,
      mvpUserId,
      screenshot,
      ...(picks.length ? { picks } : {}),
    };
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
      // Only written when the draft is known, so a game without picks keeps
      // exactly the shape it had before this field existed.
      ...(g.picks?.length ? { picks: g.picks } : {}),
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
