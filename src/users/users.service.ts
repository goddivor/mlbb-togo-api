import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { parseJson, toJson } from '../common/utils/json.util';
import { UpdateUserDto } from './dto/update-user.dto';

/** Calcule le pourcentage de victoires, arrondi à 1 décimale (0 si aucun match). */
export function computeWinRate(wins: number, losses: number): number {
  const total = (wins || 0) + (losses || 0);
  if (total === 0) return 0;
  return Math.round(((wins || 0) / total) * 1000) / 10;
}

/**
 * Sérialise un User Prisma pour les réponses API :
 * - retire le mot de passe ;
 * - parse favoriteHeroes / badges en tableaux ;
 * - ajoute role_user (= roleUser) et winRate calculé.
 */
export function serializeUser(user: any) {
  if (!user) return user;
  const { password, mlbbToken, ...rest } = user;

  const hasGoogle = !!user.googleId;
  const hasGame = !!user.mlbbRoleId;
  const source = user.profileSource === 'google' ? 'google' : 'game';

  // Avatar/nom affichés selon la préférence, avec repli sur l'autre source puis le champ legacy.
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
    // Identités liées
    hasGoogle,
    hasGame,
    profileSource: source,
    // Profil affiché (résolu selon profileSource)
    avatar: displayAvatar,
    displayName,
    // Données de jeu prêtes à l'emploi
    gameStats: parseJson<any>(user.gameStats, {}),
    gameFrequentHeroes: parseJson<any[]>(user.gameFrequentHeroes, []),
    gameSeasons: parseJson<number[]>(user.gameSeasons, []),
  };
}

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    const users = await this.prisma.user.findMany();
    return users.map(serializeUser);
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
