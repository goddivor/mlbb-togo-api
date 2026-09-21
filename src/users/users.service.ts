import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { parseJson, toJson } from '../common/utils/json.util';
import { UpdateUserDto } from './dto/update-user.dto';
import {
  LeaderboardMetric,
  LeaderboardQueryDto,
} from './dto/leaderboard-query.dto';

export function decodeRank(level?: number | null): string | null {
  if (level == null) return null;
  const tiers: Array<[number, string]> = [
    [10, 'Warrior'],
    [25, 'Elite'],
    [45, 'Master'],
    [75, 'Grandmaster'],
    [105, 'Epic'],
    [135, 'Legend'],
    [160, 'Mythic'],
    [185, 'Mythic Honor'],
    [235, 'Mythic Glory'],
    [Number.POSITIVE_INFINITY, 'Mythic Immortal'],
  ];
  for (const [max, name] of tiers) {
    if (level <= max) return name;
  }
  return null;
}

export function computeWinRate(wins: number, losses: number): number {
  const total = (wins || 0) + (losses || 0);
  if (total === 0) return 0;
  return Math.round(((wins || 0) / total) * 1000) / 10;
}

/**
 * Ranking comparator. Every metric falls back on the same chain so that two
 * players with identical figures keep a stable, non-random order across calls:
 * games played, then wins, then MVP count, then username.
 */
export function compareByMetric(metric: LeaderboardMetric) {
  const primary: Record<LeaderboardMetric, (u: any) => number> = {
    winRate: (u) => u.winRate || 0,
    wins: (u) => u.wins || 0,
    mvpCount: (u) => u.mvpCount || 0,
    streak: (u) => u.streak || 0,
  };
  const value = primary[metric];

  return (a: any, b: any) =>
    value(b) - value(a) ||
    (b.games || 0) - (a.games || 0) ||
    (b.wins || 0) - (a.wins || 0) ||
    (b.mvpCount || 0) - (a.mvpCount || 0) ||
    String(a.username || '').localeCompare(String(b.username || ''));
}

export function serializeUser(user: any) {
  if (!user) return user;
  const { password, mlbbToken, ...rest } = user;

  const hasGoogle = !!user.googleId;
  const hasGame = !!user.mlbbRoleId;
  const source = user.profileSource === 'google' ? 'google' : 'game';

  const displayAvatar =
    source === 'google'
      ? user.googleAvatar || user.gameAvatar || user.avatar || null
      : user.gameAvatar || user.googleAvatar || user.avatar || null;
  const displayName =
    source === 'google'
      ? user.googleName || user.gameNickname || user.username
      : user.gameNickname || user.googleName || user.username;

  return {
    ...rest,
    favoriteHeroes: parseJson<string[]>(user.favoriteHeroes, []),
    badges: parseJson<string[]>(user.badges, []),
    winRate: computeWinRate(user.wins, user.losses),
    roleUser: user.roleUser,
    role_user: user.roleUser,

    hasGoogle,
    hasGame,
    profileSource: source,

    avatar: displayAvatar,
    displayName,

    gameStats: parseJson<any>(user.gameStats, {}),
    gameFrequentHeroes: parseJson<any[]>(user.gameFrequentHeroes, []),
    gameRoles: parseJson<any[]>(user.gameRoles, []),
    gameSeasons: parseJson<number[]>(user.gameSeasons, []),

    gameRank: decodeRank(user.gameRankLevel),
    gamePeakRank: decodeRank(user.gamePeakRankLevel),
  };
}

// Public fields only (directory / profiles visible to everyone): we hide
// email, googleId/email, provider, game identifiers, tokens...
const PUBLIC_FIELDS = [
  'id',
  'username',
  'displayName',
  'avatar',
  'rank',
  'roleUser',
  'country',
  'city',
  'bio',
  'badges',
  'joinedAt',
  'lastActive',
  'isOnline',
  'wins',
  'losses',
  'mvpCount',
  'streak',
  'winRate',
  'profileSource',
  'hasGame',
  'favoriteHeroes',
  'gameNickname',
  'gameLevel',
  'gameRankLevel',
  'gameRank',
  'gamePeakRankLevel',
  'gamePeakRank',
  'gameCountry',
  'gameStats',
  'gameFrequentHeroes',
  'gameRoles',
  'gameSeasons',
];

function pick(obj: any, fields: string[]) {
  const out: any = {};
  for (const f of fields) out[f] = obj[f];
  return out;
}

/** Full public profile (game stats included). */
export function serializePublicUser(user: any) {
  if (!user) return user;
  return pick(serializeUser(user), PUBLIC_FIELDS);
}

/** Lightweight card for the users list. */
export function serializeUserCard(user: any) {
  if (!user) return user;
  return pick(serializeUser(user), [
    'id',
    'username',
    'displayName',
    'avatar',
    'roleUser',
    'country',
    'winRate',
    'hasGame',
    'isOnline',
    'gameRank',
    'gameRankLevel',
    'gameLevel',
  ]);
}

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    // Staff accounts (admin/moderator) are special control accounts, not players.
    const users = await this.prisma.user.findMany({
      where: { isBanned: false, roleUser: { notIn: ['admin', 'moderator'] } },
    });
    // Gamification level shown on player cards (users without progress: null).
    const levels = new Map(
      (
        await this.prisma.userProgress.findMany({
          where: { userId: { in: users.map((u) => u.id) } },
          select: { userId: true, level: true },
        })
      ).map((p) => [p.userId, p.level]),
    );
    return users
      .map((u) => ({ ...serializeUserCard(u), level: levels.get(u.id) ?? null }))
      .sort((a, b) => {
        if (a.hasGame !== b.hasGame) return a.hasGame ? -1 : 1;
        return (b.gameRankLevel ?? 0) - (a.gameRankLevel ?? 0);
      });
  }

  /** Full user list for the admin panel (includes email, role, ban status). */
  async adminList() {
    const users = await this.prisma.user.findMany({
      orderBy: { joinedAt: 'desc' },
    });
    return users.map((u) => ({
      id: u.id,
      username: u.username,
      displayName: serializeUserCard(u).displayName,
      avatar: serializeUserCard(u).avatar,
      email: u.email,
      roleUser: u.roleUser,
      isBanned: u.isBanned,
      isOnline: u.isOnline,
      country: u.country,
      provider: u.provider,
      hasGame: !!u.mlbbRoleId,
      wins: u.wins,
      losses: u.losses,
      winRate: computeWinRate(u.wins, u.losses),
      joinedAt: u.joinedAt,
      lastActive: u.lastActive,
    }));
  }

  async findPublic(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user || user.roleUser === 'admin' || user.roleUser === 'moderator') {
      throw new NotFoundException('Utilisateur introuvable.');
    }
    return serializePublicUser(user);
  }

  /**
   * Ids of the players who took part in a given esport season, derived from the
   * matches of that season. Player stats are aggregates (the schema keeps no
   * per-season counters), so a season narrows *who* is ranked, not the numbers.
   */
  private async seasonParticipantIds(seasonId: string): Promise<string[]> {
    const matches = await this.prisma.esportMatch.findMany({
      where: { seasonId },
      select: { teamAId: true, teamBId: true },
    });
    if (matches.length === 0) return [];

    const teamIds = [
      ...new Set(matches.flatMap((m) => [m.teamAId, m.teamBId]).filter(Boolean)),
    ];
    const members = await this.prisma.esportTeamMember.findMany({
      where: { teamId: { in: teamIds } },
      select: { userId: true },
    });
    return [...new Set(members.map((m) => m.userId))];
  }

  async leaderboard(query: LeaderboardQueryDto = {}) {
    const metric: LeaderboardMetric = query.metric ?? 'winRate';
    const limit = query.limit ?? 50;
    const minGames = query.minGames ?? 0;

    // Public endpoint: never leak PII (email, googleId, tokens, prefs...) and
    // exclude staff/banned accounts, exactly like the public directory.
    const where: Record<string, any> = {
      isBanned: false,
      roleUser: { notIn: ['admin', 'moderator'] },
    };
    if (query.role) where.role = query.role;

    if (query.seasonId) {
      const ids = await this.seasonParticipantIds(query.seasonId);
      if (ids.length === 0) return { metric, total: 0, entries: [] };
      where.id = { in: ids };
    }

    const users = await this.prisma.user.findMany({ where });
    const ranked = users
      .map((u) => ({
        ...serializePublicUser(u),
        role: u.role,
        games: (u.wins || 0) + (u.losses || 0),
      }))
      .filter((u) => u.games >= minGames)
      .sort(compareByMetric(metric));

    return {
      metric,
      total: ranked.length,
      entries: ranked
        .slice(0, limit)
        .map((u, i) => ({ ...u, position: i + 1 })),
    };
  }

  async findOne(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('Utilisateur introuvable.');
    return serializeUser(user);
  }

  async update(id: string, dto: UpdateUserDto) {
    await this.findOne(id);
    const data: any = {};
    if (dto.username !== undefined) data.username = dto.username;
    if (dto.avatar !== undefined) data.avatar = dto.avatar;
    if (dto.rank !== undefined) data.rank = dto.rank;
    if (dto.role !== undefined) data.role = dto.role;
    if (dto.favoriteHeroes !== undefined)
      data.favoriteHeroes = toJson(dto.favoriteHeroes);
    if (dto.country !== undefined) data.country = dto.country;
    if (dto.city !== undefined) data.city = dto.city;
    if (dto.bio !== undefined) data.bio = dto.bio;
    if (dto.notifPrefs !== undefined) data.notifPrefs = dto.notifPrefs;
    if (dto.privacy !== undefined) data.privacy = dto.privacy;

    const user = await this.prisma.user.update({ where: { id }, data });
    return serializeUser(user);
  }

  async remove(id: string) {
    await this.findOne(id);
    await this.prisma.user.delete({ where: { id } });
    return { success: true };
  }

  /** Self-deletion: remove the account and clean up its owned relations. */
  async deleteSelf(id: string) {
    await this.findOne(id);
    await Promise.all([
      this.prisma.friendship.deleteMany({
        where: { OR: [{ requesterId: id }, { addresseeId: id }] },
      }),
      this.prisma.notification.deleteMany({ where: { userId: id } }),
      this.prisma.esportTeamMember.deleteMany({ where: { userId: id } }),
      this.prisma.esportMatchPlayer.deleteMany({ where: { userId: id } }),
      this.prisma.recruitmentApplication.deleteMany({ where: { userId: id } }),
    ]);
    await this.prisma.user.delete({ where: { id } });
    return { success: true };
  }

  async setBan(id: string, isBanned: boolean) {
    await this.findOne(id);
    const user = await this.prisma.user.update({
      where: { id },
      data: { isBanned },
    });
    return serializeUser(user);
  }

  async setRole(id: string, roleUser: string) {
    await this.findOne(id);
    const user = await this.prisma.user.update({
      where: { id },
      data: { roleUser },
    });
    return serializeUser(user);
  }
}
