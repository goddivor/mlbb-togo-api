import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { parseJson, toJson } from '../common/utils/json.util';
import { UpdateUserDto } from './dto/update-user.dto';

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
  };
}

// Champs publics uniquement (annuaire / profils visibles par tous) : on masque
// email, googleId/email, provider, identifiants de jeu, jetons...
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

/** Profil public complet (stats de jeu incluses). */
export function serializePublicUser(user: any) {
  if (!user) return user;
  return pick(serializeUser(user), PUBLIC_FIELDS);
}

/** Carte allégée pour la liste des utilisateurs. */
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
    const users = await this.prisma.user.findMany({ where: { isBanned: false } });
    return users
      .map(serializeUserCard)
      .sort((a, b) => {
        if (a.hasGame !== b.hasGame) return a.hasGame ? -1 : 1;
        return (b.gameRankLevel ?? 0) - (a.gameRankLevel ?? 0);
      });
  }

  async findPublic(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('Utilisateur introuvable.');
    return serializePublicUser(user);
  }

  async leaderboard() {
    const users = await this.prisma.user.findMany();
    return users
      .map(serializeUser)
      .sort((a, b) => b.winRate - a.winRate);
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

    const user = await this.prisma.user.update({ where: { id }, data });
    return serializeUser(user);
  }

  async remove(id: string) {
    await this.findOne(id);
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
