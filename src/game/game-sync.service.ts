import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { toJson } from '../common/utils/json.util';
import { MoontonClient, MoontonOutcome, MoontonResult, jwtExpiry } from './moonton.client';
import { GAME_DATA_SOURCE, GameDataSource } from './game-data.source';
import { FrequentHero, MatchDetail, MatchSummary } from './game.mappers';

export type GameSyncStatus = 'ok' | 'moonton_offline' | 'token_expired' | 'unavailable';

/** Opportunistic sync (dashboard visit) at most once per window per user. */
export const OPPORTUNISTIC_SYNC_MS = 6 * 60 * 60 * 1000;
// Match history crawl bounds (per sync): newest seasons first.
export const MAX_SEASONS = 4;
export const MAX_PAGES_PER_SEASON = 5;
export const PAGE_SIZE = 20;
export const TOP_HEROES_MATCHES = 3;

export interface BaseInfo {
  nickname: string | null;
  avatar: string | null;
  level: number | null;
  rankLevel: number | null;
  peakRankLevel: number | null;
  country: string | null;
}

export interface PrefetchedInfo {
  result: MoontonResult;
  info: BaseInfo | null;
}

/** `sg-api /base/getBaseInfo` data -> identity fields. */
export function mapBaseInfo(d: any): BaseInfo {
  const info = d || {};
  const int = (v: any) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    nickname: info.name || null,
    avatar: info.avatar || null,
    level: int(info.level),
    rankLevel: int(info.rank_level),
    peakRankLevel: int(info.history_rank_level),
    country: info.reg_country || null,
  };
}

/**
 * Overall sync status from the identity call (sg-api) and the detailed stats
 * probe (actgateway). A refused session anywhere wins: the token is dead.
 */
export function resolveSyncStatus(info: MoontonOutcome, stats: MoontonOutcome): GameSyncStatus {
  if (info === 'token_expired' || stats === 'token_expired') return 'token_expired';
  if (stats === 'ok') return 'ok';
  if (stats === 'offline') return 'moonton_offline';
  return 'unavailable';
}

/** Short diagnostic stored with the status (never contains the token). */
export function syncMessage(...results: Array<{ outcome: MoontonOutcome; code: number | null; message: string | null } | null>) {
  const failed = results.filter((r) => r && r.outcome !== 'ok');
  if (!failed.length) return null;
  return failed
    .map((r) => `${r!.outcome}${r!.code != null ? ` ${r!.code}` : ''}${r!.message ? ` ${r!.message}` : ''}`)
    .join(' | ')
    .slice(0, 200);
}

/** Identity fields written on the User row after a successful getBaseInfo. */
export function identityFields(info: BaseInfo) {
  return {
    gameNickname: info.nickname,
    gameAvatar: info.avatar,
    gameLevel: info.level,
    gameRankLevel: info.rankLevel,
    gamePeakRankLevel: info.peakRankLevel,
    gameCountry: info.country,
  };
}

/** Summary columns of a GameMatch row (the detail is never overwritten here). */
export function matchRow(m: MatchSummary) {
  return {
    sid: m.sid,
    heroId: m.heroId,
    heroName: m.heroName,
    heroImage: m.heroImage,
    kills: m.kills,
    deaths: m.deaths,
    assists: m.assists,
    laneId: m.laneId,
    score: m.score,
    mvp: m.mvp,
    win: m.win,
    playedAt: m.playedAt,
  };
}

@Injectable()
export class GameSyncService {
  private readonly logger = new Logger('GameSyncService');
  private readonly running = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: MoontonClient,
    @Inject(GAME_DATA_SOURCE) private readonly source: GameDataSource,
  ) {}

  /** Identity of the session owner (still served by Moonton). */
  async fetchBaseInfo(jwt: string, roleId?: number | null, zoneId?: number | null): Promise<PrefetchedInfo> {
    const result = await this.client.sgPost('/base/getBaseInfo', { roleId, zoneId }, { jwt, forInfo: true });
    return { result, info: result.ok ? mapBaseInfo(result.data) : null };
  }

  /**
   * Refresh a linked account: identity (getBaseInfo), career stats, seasons and
   * current-season heroes, then crawl the match history in the background.
   * Never wipes stored data: a failed call only updates the status fields.
   */
  async syncUser(userId: string, opts: { prefetched?: PrefetchedInfo; awaitMatches?: boolean } = {}) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.mlbbToken || !user.mlbbRoleId) {
      throw new BadRequestException('Aucun compte de jeu lié.');
    }
    const jwt = user.mlbbToken;
    const now = new Date();

    const [base, stats] = await Promise.all([
      opts.prefetched ?? this.fetchBaseInfo(jwt, user.mlbbRoleId, user.mlbbZoneId),
      this.source.careerStats(jwt),
    ]);
    const status = resolveSyncStatus(base.result.outcome, stats.outcome);

    const data: Record<string, any> = {
      gameSyncAttemptAt: now,
      gameSyncStatus: status,
      gameSyncMessage: syncMessage(base.result, stats),
    };
    if (base.info) {
      Object.assign(data, identityFields(base.info));
      data.gameSyncedAt = now;
    }
    if (status === 'token_expired') {
      data.mlbbTokenStatus = 'expired';
      data.mlbbTokenExpiredAt = user.mlbbTokenExpiredAt ?? now;
    } else if (base.result.ok || stats.outcome === 'ok') {
      data.mlbbTokenStatus = 'valid';
      data.mlbbTokenExpiredAt = null;
    }

    let seasons: number[] = [];
    if (stats.data) {
      const { seasons: statSeasons, ...career } = stats.data;
      data.gameStats = toJson(career);
      data.gameStatsSyncedAt = now;
      seasons = statSeasons;
      if (!seasons.length) {
        const s = await this.source.seasons(jwt);
        if (s.data) seasons = s.data;
      }
      if (seasons.length) {
        data.gameSeasons = toJson(seasons);
        const current = seasons[0];
        const freq = await this.source.frequentHeroes(jwt, current, null, PAGE_SIZE);
        if (freq.data) {
          data.gameFrequentHeroes = toJson(freq.data.items);
          data.gameRoles = toJson(await this.computeMainRoles(freq.data.items));
          await this.persistSeasonHeroes(userId, current, freq.data.items, now);
        }
      }
    }

    const updated = await this.prisma.user.update({ where: { id: userId }, data });

    if (stats.data && seasons.length) {
      const crawl = this.syncMatches(userId, jwt, seasons);
      if (opts.awaitMatches) await crawl;
      else void crawl;
    }
    return { user: updated, status };
  }

  /**
   * Crawl recent matches per season (cursor pagination), older seasons' heroes
   * and the top heroes' matches. Stops at the first page that brings nothing
   * new, and on any session/route failure. Idempotent (upserts only).
   */
  async syncMatches(userId: string, jwt: string, seasons: number[]) {
    if (this.running.has(userId)) return { created: 0, updated: 0, skipped: true };
    this.running.add(userId);
    let created = 0;
    let updated = 0;
    try {
      for (const [i, sid] of seasons.slice(0, MAX_SEASONS).entries()) {
        if (i > 0) {
          const freq = await this.source.frequentHeroes(jwt, sid, null, PAGE_SIZE);
          if (await this.stopOn(userId, freq.outcome)) return { created, updated };
          if (freq.data) await this.persistSeasonHeroes(userId, sid, freq.data.items);
        }
        let cursor: string | null = null;
        for (let page = 0; page < MAX_PAGES_PER_SEASON; page++) {
          const res = await this.source.recentMatches(jwt, sid, cursor, PAGE_SIZE);
          if (await this.stopOn(userId, res.outcome)) return { created, updated };
          if (!res.data) break;
          const out = await this.persistMatches(userId, res.data.items);
          created += out.created;
          updated += out.updated;
          if (!out.created || !res.data.page.hasNext) break;
          cursor = res.data.page.nextCursor;
        }
      }

      // Per-hero history of the current season's most played heroes.
      const current = seasons[0];
      const top = await this.prisma.gameSeasonStats.findUnique({
        where: { userId_sid: { userId, sid: current } },
      });
      const heroes: FrequentHero[] = top ? JSON.parse(top.frequentHeroes || '[]') : [];
      for (const h of heroes.slice(0, TOP_HEROES_MATCHES)) {
        const res = await this.source.heroMatches(jwt, h.heroId, current, null, PAGE_SIZE);
        if (await this.stopOn(userId, res.outcome)) break;
        if (res.data) {
          const out = await this.persistMatches(userId, res.data.items);
          created += out.created;
          updated += out.updated;
        }
      }
      return { created, updated };
    } catch (e: any) {
      this.logger.warn(`Match sync failed for ${userId}: ${e?.message ?? e}`);
      return { created, updated };
    } finally {
      this.running.delete(userId);
    }
  }

  /** True when the crawl must stop; marks a dead session on the way. */
  private async stopOn(userId: string, outcome: MoontonOutcome): Promise<boolean> {
    if (outcome === 'ok') return false;
    if (outcome === 'token_expired') await this.markTokenExpired(userId);
    return true;
  }

  async markTokenExpired(userId: string, now = new Date()) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { mlbbTokenExpiredAt: true },
    });
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        mlbbTokenStatus: 'expired',
        mlbbTokenExpiredAt: user?.mlbbTokenExpiredAt ?? now,
        gameSyncStatus: 'token_expired',
      },
    });
  }

  /** Upsert match summaries on [userId, bid]; never touches stored details. */
  async persistMatches(userId: string, items: MatchSummary[]) {
    if (!items.length) return { created: 0, updated: 0 };
    const unique = [...new Map(items.map((m) => [m.bid, m])).values()];
    const existing = await this.prisma.gameMatch.findMany({
      where: { userId, bid: { in: unique.map((m) => m.bid) } },
      select: { bid: true },
    });
    const known = new Set(existing.map((e) => e.bid));
    for (const m of unique) {
      await this.prisma.gameMatch.upsert({
        where: { userId_bid: { userId, bid: m.bid } },
        create: { userId, bid: m.bid, ...matchRow(m) },
        update: matchRow(m),
      });
    }
    const created = unique.filter((m) => !known.has(m.bid)).length;
    return { created, updated: unique.length - created };
  }

  async persistSeasonHeroes(userId: string, sid: number, heroes: FrequentHero[], now = new Date()) {
    const frequentHeroes = toJson(heroes);
    await this.prisma.gameSeasonStats.upsert({
      where: { userId_sid: { userId, sid } },
      create: { userId, sid, frequentHeroes, syncedAt: now },
      update: { frequentHeroes, syncedAt: now },
    });
  }

  /**
   * Fetch and store the scoreboard of a stored match with the owner's session.
   * Returns null when it cannot be fetched (dead session, offline route...).
   */
  async fetchMatchDetail(
    user: { id: string; mlbbToken: string | null; mlbbRoleId: number | null; mlbbTokenStatus?: string | null },
    match: { bid: string; sid: number },
  ): Promise<MatchDetail | null> {
    if (!user.mlbbToken || user.mlbbTokenStatus === 'expired') return null;
    const res = await this.source.matchDetail(user.mlbbToken, match.bid, match.sid, user.mlbbRoleId);
    if (res.outcome === 'token_expired') await this.markTokenExpired(user.id);
    if (!res.data || !res.data.players.length) return null;
    await this.prisma.gameMatch.update({
      where: { userId_bid: { userId: user.id, bid: match.bid } },
      data: {
        detail: toJson(res.data),
        detailSyncedAt: new Date(),
        ...(res.data.durationSec != null ? { durationSec: res.data.durationSec } : {}),
      },
    });
    return res.data;
  }

  /** Live frequent heroes of a season, cached in GameSeasonStats. */
  async seasonHeroes(userId: string, sid: number): Promise<FrequentHero[]> {
    const cached = await this.prisma.gameSeasonStats.findUnique({ where: { userId_sid: { userId, sid } } });
    if (cached) return JSON.parse(cached.frequentHeroes || '[]');
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.mlbbToken || user.mlbbTokenStatus === 'expired') return [];
    const res = await this.source.frequentHeroes(user.mlbbToken, sid, null, PAGE_SIZE);
    if (res.outcome === 'token_expired') await this.markTokenExpired(userId);
    if (!res.data) return [];
    await this.persistSeasonHeroes(userId, sid, res.data.items);
    return res.data.items;
  }

  /**
   * Non-blocking refresh when the owner opens the dashboard: skipped when the
   * session is known dead, already running, or refreshed less than 6 h ago.
   */
  async maybeSyncInBackground(userId: string, now = new Date()): Promise<boolean> {
    if (this.running.has(`sync:${userId}`)) return false;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { mlbbToken: true, mlbbRoleId: true, mlbbTokenStatus: true, gameSyncAttemptAt: true },
    });
    if (!shouldAutoSync(user, now)) return false;
    this.running.add(`sync:${userId}`);
    void this.syncUser(userId)
      .catch((e) => this.logger.warn(`Background game sync failed for ${userId}: ${e?.message ?? e}`))
      .finally(() => this.running.delete(`sync:${userId}`));
    return true;
  }

  private async computeMainRoles(heroes: FrequentHero[]): Promise<Array<{ role: string; matches: number }>> {
    if (!heroes.length) return [];
    const names = heroes.map((h) => h.name).filter(Boolean);
    const rows = await this.prisma.hero.findMany({
      where: { name: { in: names } },
      select: { name: true, role: true },
    });
    const roleByName = new Map(rows.map((h) => [h.name, h.role]));
    const tally = new Map<string, number>();
    for (const h of heroes) {
      const role = roleByName.get(h.name);
      if (!role) continue;
      tally.set(role, (tally.get(role) ?? 0) + (h.matches ?? 0));
    }
    return [...tally.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([role, matches]) => ({ role, matches }));
  }
}

/** Pure gate of the opportunistic sync. */
export function shouldAutoSync(
  user: {
    mlbbToken?: string | null;
    mlbbRoleId?: number | null;
    mlbbTokenStatus?: string | null;
    gameSyncAttemptAt?: Date | null;
  } | null,
  now = new Date(),
): boolean {
  if (!user?.mlbbToken || !user.mlbbRoleId) return false;
  if (user.mlbbTokenStatus === 'expired') return false;
  const exp = jwtExpiry(user.mlbbToken);
  if (exp && exp.getTime() <= now.getTime()) return false;
  if (user.gameSyncAttemptAt && now.getTime() - new Date(user.gameSyncAttemptAt).getTime() < OPPORTUNISTIC_SYNC_MS) {
    return false;
  }
  return true;
}
