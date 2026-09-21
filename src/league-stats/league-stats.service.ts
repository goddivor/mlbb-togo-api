import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EsportSeasonsService } from '../esport/esport-seasons.service';
import { serializeUserCard } from '../users/users.service';
import {
  MatchRow,
  PLAYER_SORTS,
  PlayerRow,
  PlayerSort,
  RecordPeriod,
  computeMeta,
  computePlayerRankings,
  computeRecords,
  computeTeamStats,
} from './league-stats.util';

/** In-memory cache TTL: stats are read far more often than matches change. */
export const CACHE_TTL_MS = 60_000;
const MAX_LIMIT = 200;

export type SeasonScope = { id: string; name: string } | null;

type TeamRef = { id: string; name: string; image: string | null };
type HeroRef = { name: string; image: string | null; role: string | null };

/**
 * Tiny TTL cache keyed by endpoint + query. Exported so the specs can cover
 * it without a Prisma instance.
 */
export class TtlCache<T = unknown> {
  private store = new Map<string, { expires: number; value: T }>();
  constructor(private ttl = CACHE_TTL_MS, private now: () => number = () => Date.now()) {}

  get(key: string): T | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expires <= this.now()) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: T) {
    this.store.set(key, { expires: this.now() + this.ttl, value });
    return value;
  }

  clear() {
    this.store.clear();
  }
}

/** Query validation kept pure (unit tested). */
export function parsePlayerSort(raw?: string | null): PlayerSort {
  if (!raw) return 'kills';
  if (!PLAYER_SORTS.includes(raw as PlayerSort))
    throw new BadRequestException(`Tri inconnu : ${raw} (attendu ${PLAYER_SORTS.join(', ')}).`);
  return raw as PlayerSort;
}

export function parseLimit(raw?: string | number | null, fallback = 50) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) throw new BadRequestException('limit doit être un entier positif.');
  return Math.min(MAX_LIMIT, n);
}

export function parsePeriod(raw?: string | null): RecordPeriod {
  if (!raw || raw === 'season') return 'season';
  if (raw === 'week') return 'week';
  throw new BadRequestException('period doit valoir week ou season.');
}

@Injectable()
export class LeagueStatsService {
  private cache = new TtlCache<unknown>();

  constructor(
    private prisma: PrismaService,
    private seasons: EsportSeasonsService,
  ) {}

  // ----- Season scope -------------------------------------------------------

  /**
   * `current` -> the site's current season, `all` / empty -> no filter,
   * otherwise a season id. Returns the resolved season (null = all seasons).
   */
  async resolveSeason(raw?: string | null): Promise<{ scope: SeasonScope; key: string }> {
    const v = (raw ?? '').trim();
    if (!v || v === 'all') return { scope: null, key: 'all' };
    if (v === 'current') {
      try {
        const s = await this.seasons.current();
        return { scope: { id: s.id, name: s.name }, key: s.id };
      } catch (e) {
        if (e instanceof NotFoundException) return { scope: null, key: 'none' };
        throw e;
      }
    }
    if (!/^[a-f\d]{24}$/i.test(v)) throw new BadRequestException('seasonId invalide.');
    const s = await this.prisma.esportSeason.findUnique({ where: { id: v }, select: { id: true, name: true } });
    if (!s) throw new NotFoundException('Saison introuvable.');
    return { scope: { id: s.id, name: s.name }, key: s.id };
  }

  // ----- Data loading (bounded: one season, completed matches only) --------

  private async loadMatches(scope: SeasonScope, noSeason = false): Promise<MatchRow[]> {
    if (noSeason) return [];
    return this.prisma.esportMatch.findMany({
      where: { status: 'completed', ...(scope ? { seasonId: scope.id } : {}) },
    });
  }

  private async loadPlayers(matches: MatchRow[]): Promise<PlayerRow[]> {
    if (!matches.length) return [];
    return this.prisma.esportMatchPlayer.findMany({ where: { matchId: { in: matches.map((m) => m.id) } } });
  }

  private async teamRefs(ids: Iterable<string>): Promise<Map<string, TeamRef>> {
    const uniq = Array.from(new Set(Array.from(ids).filter(Boolean)));
    if (!uniq.length) return new Map();
    const teams = await this.prisma.esportTeam.findMany({
      where: { id: { in: uniq } },
      select: { id: true, name: true, image: true },
    });
    return new Map(teams.map((t) => [t.id, { id: t.id, name: t.name, image: t.image ?? null }]));
  }

  private async userRefs(ids: Iterable<string>) {
    const uniq = Array.from(new Set(Array.from(ids).filter(Boolean)));
    if (!uniq.length) return new Map<string, any>();
    const users = await this.prisma.user.findMany({ where: { id: { in: uniq } } });
    return new Map(
      users.map((u) => {
        const card = serializeUserCard(u);
        return [u.id, { id: u.id, username: card.username, displayName: card.displayName, avatar: card.avatar }];
      }),
    );
  }

  private async heroRefs(names: Iterable<string | null | undefined>): Promise<Map<string, HeroRef>> {
    const uniq = Array.from(new Set(Array.from(names).filter(Boolean) as string[]));
    if (!uniq.length) return new Map();
    const heroes = await this.prisma.hero.findMany({
      where: { name: { in: uniq } },
      select: { name: true, image: true, thumb: true, role: true },
    });
    return new Map(heroes.map((h) => [h.name, { name: h.name, image: h.thumb || h.image || null, role: h.role }]));
  }

  private heroCard(name: string | null | undefined, refs: Map<string, HeroRef>) {
    if (!name) return null;
    const ref = refs.get(name);
    return { name, image: ref?.image ?? null, role: ref?.role ?? null };
  }

  private async cached<T>(key: string, compute: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key) as T | undefined;
    if (hit !== undefined) return hit;
    return this.cache.set(key, await compute()) as T;
  }

  /** Drops every cached entry (matches admin writes could call it). */
  invalidate() {
    this.cache.clear();
  }

  // ----- Endpoints ----------------------------------------------------------

  async teams(seasonId?: string) {
    const { scope, key } = await this.resolveSeason(seasonId);
    return this.cached(`teams:${key}`, async () => {
      const matches = await this.loadMatches(scope, key === 'none');
      const players = await this.loadPlayers(matches);
      const stats = computeTeamStats(matches, players);
      const [teams, heroes] = await Promise.all([
        this.teamRefs(stats.map((s) => s.teamId)),
        this.heroRefs(stats.flatMap((s) => s.topHeroes.map((h) => h.key))),
      ]);
      return {
        season: scope,
        matches: matches.length,
        hasPlayerStats: players.length > 0,
        items: stats.map((s, i) => ({
          rank: i + 1,
          ...s,
          team: teams.get(s.teamId) ?? { id: s.teamId, name: '?', image: null },
          topHeroes: s.topHeroes.map((h) => ({ ...this.heroCard(h.key, heroes), count: h.count })),
        })),
      };
    });
  }

  async players(query: { seasonId?: string; role?: string; sort?: string; limit?: string | number }) {
    const { scope, key } = await this.resolveSeason(query.seasonId);
    const sort = parsePlayerSort(query.sort);
    const limit = parseLimit(query.limit, 50);
    const role = (query.role ?? '').trim().toLowerCase() || null;
    return this.cached(`players:${key}:${role ?? ''}:${sort}:${limit}`, async () => {
      const matches = await this.loadMatches(scope, key === 'none');
      const players = await this.loadPlayers(matches);
      const ranking = computePlayerRankings(matches, players, { role, sort, limit });
      const [users, teams, heroes] = await Promise.all([
        this.userRefs(ranking.map((r) => r.userId)),
        this.teamRefs(ranking.map((r) => r.teamId)),
        this.heroRefs(ranking.flatMap((r) => r.topHeroes.map((h) => h.key))),
      ]);
      return {
        season: scope,
        sort,
        role,
        matches: matches.length,
        items: ranking.map((r, i) => ({
          rank: i + 1,
          ...r,
          user: users.get(r.userId) ?? { id: r.userId, username: '?', displayName: '?', avatar: null },
          team: teams.get(r.teamId) ?? { id: r.teamId, name: '?', image: null },
          topHeroes: r.topHeroes.map((h) => ({ ...this.heroCard(h.key, heroes), count: h.count })),
        })),
      };
    });
  }

  async meta(query: { seasonId?: string; minGames?: string | number; limit?: string | number }) {
    const { scope, key } = await this.resolveSeason(query.seasonId);
    const minGames = parseLimit(query.minGames, 3);
    const limit = parseLimit(query.limit, 10);
    return this.cached(`meta:${key}:${minGames}:${limit}`, async () => {
      const matches = await this.loadMatches(scope, key === 'none');
      const players = await this.loadPlayers(matches);
      const meta = computeMeta(matches, players, { minGames, limit });
      const heroes = await this.heroRefs(meta.heroes.map((h) => h.hero));
      const decorate = (h: (typeof meta.heroes)[number]) => ({
        ...h,
        image: heroes.get(h.hero)?.image ?? null,
        heroClass: heroes.get(h.hero)?.role ?? null,
      });
      return {
        season: scope,
        ...meta,
        heroes: meta.heroes.map(decorate),
        mostPlayed: meta.mostPlayed.map(decorate),
        bestWinRate: meta.bestWinRate.map(decorate),
        mostBanned: meta.mostBanned.map(decorate),
      };
    });
  }

  async records(query: { seasonId?: string; period?: string }) {
    const { scope, key } = await this.resolveSeason(query.seasonId);
    const period = parsePeriod(query.period);
    return this.cached(`records:${key}:${period}`, async () => {
      const matches = await this.loadMatches(scope, key === 'none');
      const players = await this.loadPlayers(matches);
      const rec = computeRecords(matches, players, { period });
      const playerRecs = [rec.topKills, rec.topAssists, rec.topDamage, rec.topGold, rec.topKda];
      const teamIds = [
        ...playerRecs.flatMap((r) => (r ? [r.teamId] : [])),
        ...(rec.biggestMargin ? [rec.biggestMargin.teamAId, rec.biggestMargin.teamBId] : []),
      ];
      const [users, teams, heroes] = await Promise.all([
        this.userRefs(playerRecs.flatMap((r) => (r ? [r.userId] : []))),
        this.teamRefs(teamIds),
        this.heroRefs(playerRecs.map((r) => r?.hero)),
      ]);
      const player = (r: typeof rec.topKills) =>
        r && {
          ...r,
          user: users.get(r.userId) ?? { id: r.userId, username: '?', displayName: '?', avatar: null },
          team: teams.get(r.teamId) ?? { id: r.teamId, name: '?', image: null },
          heroCard: this.heroCard(r.hero, heroes),
        };
      return {
        season: scope,
        period: rec.period,
        window: rec.window,
        matches: rec.matches,
        topKills: player(rec.topKills),
        topAssists: player(rec.topAssists),
        topDamage: player(rec.topDamage),
        topGold: player(rec.topGold),
        topKda: player(rec.topKda),
        longestGame: rec.longestGame,
        biggestMargin: rec.biggestMargin && {
          ...rec.biggestMargin,
          teamA: teams.get(rec.biggestMargin.teamAId) ?? null,
          teamB: teams.get(rec.biggestMargin.teamBId) ?? null,
        },
      };
    });
  }
}
