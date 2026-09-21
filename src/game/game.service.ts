import { ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { parseJson } from '../common/utils/json.util';
import { decodeRank } from '../users/users.service';
import { GameSyncService } from './game-sync.service';
import { kdaOf } from './game.mappers';

export interface Viewer {
  id: string;
  roleUser?: string;
}

const STAFF = new Set(['admin', 'moderator']);
export const MAX_MATCH_PAGE = 50;

/**
 * Game data follows the profile privacy settings (settings page): a private
 * profile or hidden stats are only visible to the owner and to staff.
 */
export function canViewGame(privacy: any, isOwner: boolean, isStaff: boolean): boolean {
  if (isOwner || isStaff) return true;
  if (!privacy || typeof privacy !== 'object') return true;
  return privacy.profilePublic !== false && privacy.showStats !== false;
}

export function tokenStatusOf(user: { mlbbToken?: string | null; mlbbTokenStatus?: string | null }) {
  if (!user?.mlbbToken) return 'none';
  return user.mlbbTokenStatus === 'expired' ? 'expired' : 'valid';
}

/** Career stats are only meaningful once Moonton returned at least one game. */
export function careerOrNull(raw: string | null | undefined) {
  const stats = parseJson<any>(raw, {});
  return stats && typeof stats === 'object' && Number(stats.total) > 0 ? stats : null;
}

/** Public shape of a stored match (no user id, no raw detail). */
export function serializeGameMatch(m: any) {
  return {
    bid: m.bid,
    sid: m.sid,
    heroId: m.heroId,
    heroName: m.heroName ?? null,
    heroImage: m.heroImage ?? null,
    kills: m.kills,
    deaths: m.deaths,
    assists: m.assists,
    kda: kdaOf(m.kills, m.deaths, m.assists),
    laneId: m.laneId ?? null,
    score: m.score,
    mvp: m.mvp,
    win: m.win,
    playedAt: m.playedAt,
    durationSec: m.durationSec ?? null,
    hasDetail: !!m.detail,
  };
}

/** Read side of the cached game data (never calls Moonton, except lazily for a match detail). */
@Injectable()
export class GameService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly sync?: GameSyncService,
  ) {}

  private async loadUser(userId: string) {
    const user = /^[a-f0-9]{24}$/i.test(userId)
      ? await this.prisma.user.findUnique({ where: { id: userId } })
      : null;
    if (!user || STAFF.has(user.roleUser)) throw new NotFoundException('Utilisateur introuvable.');
    return user;
  }

  private access(user: any, viewer?: Viewer | null) {
    const isOwner = !!viewer && viewer.id === user.id;
    const isStaff = !!viewer && STAFF.has(viewer.roleUser ?? '');
    return { isOwner, visible: canViewGame(user.privacy, isOwner, isStaff) };
  }

  /** GET /users/:id/game */
  async getSummary(userId: string, viewer?: Viewer | null) {
    const user = await this.loadUser(userId);
    const { isOwner, visible } = this.access(user, viewer);
    const linked = !!user.mlbbRoleId;
    if (!visible) return { userId: user.id, visible: false, linked, isOwner };

    const seasons = parseJson<number[]>(user.gameSeasons, []);
    const currentSeason = seasons.length ? seasons[0] : null;
    const [seasonRows, matchesCount] = linked
      ? await Promise.all([
          this.prisma.gameSeasonStats.findMany({ where: { userId: user.id }, orderBy: { sid: 'desc' } }),
          this.prisma.gameMatch.count({ where: { userId: user.id } }),
        ])
      : [[], 0];
    const seasonStats = seasonRows.map((s) => ({
      sid: s.sid,
      frequentHeroes: parseJson<any[]>(s.frequentHeroes, []),
      syncedAt: s.syncedAt,
    }));
    const current = seasonStats.find((s) => s.sid === currentSeason);
    const stats = linked ? careerOrNull(user.gameStats) : null;

    return {
      userId: user.id,
      visible: true,
      linked,
      isOwner,
      profile: linked
        ? {
            nickname: user.gameNickname ?? null,
            avatar: user.gameAvatar ?? null,
            level: user.gameLevel ?? null,
            rank: decodeRank(user.gameRankLevel),
            rankLevel: user.gameRankLevel ?? null,
            peakRank: decodeRank(user.gamePeakRankLevel),
            peakRankLevel: user.gamePeakRankLevel ?? null,
            country: user.gameCountry ?? null,
          }
        : null,
      stats,
      seasons,
      currentSeason,
      frequentHeroes: current?.frequentHeroes ?? (linked ? parseJson<any[]>(user.gameFrequentHeroes, []) : []),
      seasonStats,
      matchesCount,
      sync: {
        status: linked ? user.gameSyncStatus ?? null : null,
        lastSyncAt: linked ? user.gameSyncedAt ?? null : null,
        lastAttemptAt: linked ? user.gameSyncAttemptAt ?? null : null,
        statsSyncedAt: linked ? user.gameStatsSyncedAt ?? null : null,
        statsAvailable: !!stats,
        tokenStatus: linked ? tokenStatusOf(user) : 'none',
        tokenExpiredAt: linked ? user.mlbbTokenExpiredAt ?? null : null,
      },
    };
  }

  /** GET /users/:id/game/matches (from the DB only). */
  async listMatches(
    userId: string,
    viewer: Viewer | null | undefined,
    q: { season?: number; hero?: number; page?: number; limit?: number },
  ) {
    const user = await this.loadUser(userId);
    const page = Math.max(1, Math.floor(q.page || 1));
    const limit = Math.min(MAX_MATCH_PAGE, Math.max(1, Math.floor(q.limit || 10)));
    const empty = { items: [], total: 0, page, limit, hasMore: false };
    const { visible } = this.access(user, viewer);
    if (!visible) return { ...empty, visible: false };
    if (!user.mlbbRoleId) return { ...empty, visible: true };

    const where: any = { userId: user.id };
    if (Number.isFinite(q.season)) where.sid = q.season;
    if (Number.isFinite(q.hero)) where.heroId = q.hero;
    const [total, rows] = await Promise.all([
      this.prisma.gameMatch.count({ where }),
      this.prisma.gameMatch.findMany({
        where,
        orderBy: { playedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    return {
      visible: true,
      items: rows.map(serializeGameMatch),
      total,
      page,
      limit,
      hasMore: page * limit < total,
    };
  }

  /** GET /users/:id/game/matches/:bid (detail fetched lazily with the owner's session). */
  async getMatch(userId: string, bid: string, viewer?: Viewer | null) {
    const user = await this.loadUser(userId);
    const { visible } = this.access(user, viewer);
    if (!visible) throw new ForbiddenException('Ce profil est privé.');
    const match = await this.prisma.gameMatch.findUnique({
      where: { userId_bid: { userId: user.id, bid: String(bid) } },
    });
    if (!match) throw new NotFoundException('Match introuvable.');

    let detail = parseJson<any>(match.detail, null);
    if (!detail && this.sync) {
      detail = await this.sync.fetchMatchDetail(user, match).catch(() => null);
    }
    return {
      match: {
        ...serializeGameMatch(match),
        hasDetail: !!detail,
        durationSec: detail?.durationSec ?? match.durationSec ?? null,
      },
      detail,
    };
  }
}
