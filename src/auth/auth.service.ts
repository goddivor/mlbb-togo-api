import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { GamificationService } from '../gamification/gamification.service';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { toJson } from '../common/utils/json.util';
import { serializeUser } from '../users/users.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { MoontonClient } from '../game/moonton.client';
import { BaseInfo, GameSyncService, PrefetchedInfo, identityFields } from '../game/game-sync.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger('AuthService');

  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private moonton: MoontonClient,
    private gameSync: GameSyncService,
    @Optional() private gamification?: GamificationService,
  ) {}

  private signToken(user: { id: string; username: string; roleUser: string }) {
    return this.jwt.sign({
      sub: user.id,
      username: user.username,
      roleUser: user.roleUser,
    });
  }

  async register(dto: RegisterDto) {
    const existing = await this.prisma.user.findFirst({
      where: { OR: [{ email: dto.email }, { username: dto.username }] },
    });
    if (existing) {
      throw new ConflictException(
        "Cet email ou nom d'utilisateur est déjà utilisé.",
      );
    }

    const hashed = await bcrypt.hash(dto.password, 10);
    const user = await this.prisma.user.create({
      data: {
        username: dto.username,
        email: dto.email,
        password: hashed,
        rank: dto.rank ?? undefined,
        role: dto.role ?? undefined,
        favoriteHeroes: toJson(dto.favoriteHeroes ?? []),
        country: dto.country ?? undefined,
        city: dto.city ?? undefined,
        bio: dto.bio ?? undefined,
      },
    });

    const token = this.signToken(user);
    return { token, user: serializeUser(user) };
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (!user) {
      throw new UnauthorizedException('Identifiants invalides.');
    }
    const valid = await bcrypt.compare(dto.password, user.password);
    if (!valid) {
      throw new UnauthorizedException('Identifiants invalides.');
    }
    if (user.isBanned) {
      throw new UnauthorizedException('Compte suspendu.');
    }

    const token = this.signToken(user);
    void this.gamification?.trackDailyLogin(user.id);
    return { token, user: serializeUser(user) };
  }

  async adminLogin(dto: { username: string; password: string }) {
    const user = await this.prisma.user.findUnique({
      where: { username: dto.username },
    });
    if (!user || !user.password) {
      throw new UnauthorizedException('Identifiants invalides.');
    }
    const valid = await bcrypt.compare(dto.password, user.password);
    if (!valid) {
      throw new UnauthorizedException('Identifiants invalides.');
    }
    if (user.roleUser !== 'admin' && user.roleUser !== 'moderator') {
      throw new UnauthorizedException("Ce compte n'a pas d'accès administrateur.");
    }
    if (user.isBanned) {
      throw new UnauthorizedException('Compte suspendu.');
    }
    const token = this.signToken(user);
    return { token, user: serializeUser(user) };
  }

  async me(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException('Utilisateur introuvable.');
    }
    return serializeUser(user);
  }

  async gameHeroes(userId: string, sid: number) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.mlbbRoleId) {
      throw new BadRequestException('Aucun compte de jeu lié.');
    }
    return this.gameSync.seasonHeroes(userId, sid);
  }

  private async validateMlbbCode(roleId: number, zoneId: number, vc: number) {
    const res = await this.moonton.sgPost('/base/login', {
      roleId,
      zoneId,
      vc,
      referer: 'academy',
      type: 'web',
    });
    if (res.outcome === 'unreachable') {
      throw new BadRequestException('Service MLBB momentanément indisponible. Réessayez dans un instant.');
    }
    if (!res.ok || !res.data) {
      throw new UnauthorizedException(res.message || 'Code de vérification invalide ou expiré.');
    }
    return (res.data.jwt || res.data.token || null) as string | null;
  }

  /** Columns written when a fresh Moonton session is stored (login / link). */
  private sessionFields(zoneId: number, token: string | null, info: BaseInfo | null) {
    const data: any = {
      mlbbZoneId: zoneId,
      mlbbToken: token,
      mlbbTokenStatus: token ? 'valid' : null,
      mlbbTokenExpiredAt: null,
    };
    if (info) {
      Object.assign(data, identityFields(info));
      data.gameSyncedAt = new Date();
    }
    return data;
  }

  /** Full game sync right after a login/link; a failure never blocks the login. */
  private async syncAfterLogin(userId: string, prefetched: PrefetchedInfo) {
    try {
      const { user } = await this.gameSync.syncUser(userId, { prefetched });
      return user;
    } catch (e: any) {
      this.logger.warn(`Game sync after login failed for ${userId}: ${e?.message ?? e}`);
      return null;
    }
  }

  async mlbbSendVc(roleId: number, zoneId: number) {
    const res = await this.moonton.sgPost('/base/sendVc', { roleId, zoneId });

    if (res.outcome === 'unreachable') {
      throw new BadRequestException(
        'Service MLBB momentanément indisponible (trafic élevé). Réessaie dans quelques instants.',
      );
    }
    if (!res.ok) {
      throw new BadRequestException(
        res.message || "Impossible d'envoyer le code. Vérifie l'ID de jeu et le serveur.",
      );
    }
    return {
      success: true,
      message: 'Code envoyé dans votre courrier en jeu (valable 5 minutes).',
    };
  }

  async mlbbLogin(roleId: number, zoneId: number, vc: number) {
    const mlbbToken = await this.validateMlbbCode(roleId, zoneId, vc);
    const base = mlbbToken ? await this.gameSync.fetchBaseInfo(mlbbToken, roleId, zoneId) : null;
    const info = base?.info ?? null;

    let user = await this.prisma.user.findFirst({ where: { mlbbRoleId: roleId } });
    if (!user) {
      user = await this.prisma.user.create({
        data: {
          username: await this.uniqueUsername(info?.nickname || `Player ${roleId}`, roleId),
          email: `mlbb-${roleId}@players.mlbbtogo`,
          password: await bcrypt.hash(crypto.randomUUID(), 10),
          provider: 'mlbb',
          mlbbRoleId: roleId,
          profileSource: 'game',
          ...this.sessionFields(zoneId, mlbbToken, info),
        },
      });
    } else {
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: { ...this.sessionFields(zoneId, mlbbToken, info), lastActive: new Date() },
      });
    }
    if (base) user = (await this.syncAfterLogin(user.id, base)) ?? user;

    void this.gamification?.trackDailyLogin(user.id);
    return { token: this.signToken(user), user: serializeUser(user) };
  }

  private async mergeContent(survivorId: string, victimId: string) {
    if (survivorId === victimId) return;
    await this.prisma.post.updateMany({
      where: { authorId: victimId },
      data: { authorId: survivorId },
    });
    await this.prisma.comment.updateMany({
      where: { authorId: victimId },
      data: { authorId: survivorId },
    });
    await this.prisma.notification.updateMany({
      where: { userId: victimId },
      data: { userId: survivorId },
    });
    // Cached game data follows the game account.
    await this.prisma.gameMatch.updateMany({
      where: { userId: victimId },
      data: { userId: survivorId },
    });
    await this.prisma.gameSeasonStats.updateMany({
      where: { userId: victimId },
      data: { userId: survivorId },
    });
  }

  async linkMlbb(userId: string, roleId: number, zoneId: number, vc: number) {
    const current = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!current) throw new NotFoundException('Utilisateur introuvable.');
    if (current.mlbbRoleId && current.mlbbRoleId !== roleId) {
      throw new ConflictException('Un compte de jeu est déjà lié à ce profil.');
    }

    const mlbbToken = await this.validateMlbbCode(roleId, zoneId, vc);
    const base = mlbbToken ? await this.gameSync.fetchBaseInfo(mlbbToken, roleId, zoneId) : null;

    const owner = await this.prisma.user.findFirst({ where: { mlbbRoleId: roleId } });
    let carry: any = {};
    if (owner && owner.id !== userId) {
      if (owner.googleId && current.googleId) {
        throw new ConflictException(
          'Chaque compte est déjà lié à un compte Google différent. Fusion automatique impossible.',
        );
      }

      if (owner.googleId && !current.googleId) {
        carry = {
          googleId: owner.googleId,
          googleEmail: owner.googleEmail,
          googleName: owner.googleName,
          googleAvatar: owner.googleAvatar,
        };
      }
      await this.mergeContent(userId, owner.id);
      await this.prisma.user.delete({ where: { id: owner.id } });
    }

    let user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        mlbbRoleId: roleId,
        ...this.sessionFields(zoneId, mlbbToken, base?.info ?? null),
        ...carry,
        lastActive: new Date(),
      },
    });
    if (base) user = (await this.syncAfterLogin(user.id, base)) ?? user;
    return serializeUser(user);
  }

  /**
   * Manual "Synchroniser": refreshes what Moonton still serves. Always returns
   * the user; `gameSyncStatus` tells the UI whether the session expired or the
   * detailed stats routes are offline (stored data is kept either way).
   */
  async syncGame(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.mlbbToken || !user.mlbbZoneId || !user.mlbbRoleId) {
      throw new BadRequestException('Aucun compte de jeu lié.');
    }
    const { user: updated } = await this.gameSync.syncUser(userId);
    return serializeUser(updated);
  }

  async unlinkMlbb(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Utilisateur introuvable.');
    if (!user.mlbbRoleId) {
      throw new BadRequestException('Aucun compte de jeu lié.');
    }
    if (!user.googleId) {
      throw new BadRequestException(
        "Impossible de dissocier : c'est ta seule méthode de connexion. Lie d'abord un compte Google.",
      );
    }
    // Unlinking removes the cached game data of that account.
    await this.prisma.gameMatch.deleteMany({ where: { userId } });
    await this.prisma.gameSeasonStats.deleteMany({ where: { userId } });
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        mlbbRoleId: null,
        mlbbZoneId: null,
        mlbbToken: null,
        gameNickname: null,
        gameAvatar: null,
        gameLevel: null,
        gameRankLevel: null,
        gameCountry: null,
        gameStats: '{}',
        gameFrequentHeroes: '[]',
        gameSeasons: '[]',
        gameRoles: '[]',
        gameSyncedAt: null,
        gamePeakRankLevel: null,
        mlbbTokenStatus: null,
        mlbbTokenExpiredAt: null,
        gameSyncStatus: null,
        gameSyncMessage: null,
        gameSyncAttemptAt: null,
        gameStatsSyncedAt: null,

        profileSource: user.profileSource === 'game' ? 'google' : user.profileSource,
        provider: user.provider === 'mlbb' ? 'google' : user.provider,
      },
    });
    return serializeUser(updated);
  }

  private async fetchGoogleProfile(accessToken: string) {
    let profile: any;
    // Retry: the network hop to googleapis.com can fail transiently.
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const res = await fetch(
          'https://www.googleapis.com/oauth2/v3/userinfo',
          {
            headers: { Authorization: `Bearer ${accessToken}` },
            signal: controller.signal,
          },
        ).finally(() => clearTimeout(timeout));
        if (res.status === 401 || res.status === 403) {
          // A genuinely invalid/expired token: no point retrying.
          throw new UnauthorizedException('Jeton Google invalide.');
        }
        if (!res.ok) throw new Error('userinfo ' + res.status);
        profile = await res.json();
        break;
      } catch (e: any) {
        if (e instanceof UnauthorizedException) throw e;
        // Log the underlying cause (undici hides it behind "fetch failed").
        this.logger.warn(
          `Google userinfo échec (tentative ${attempt}/3): ${e?.message}${
            e?.cause ? ` — ${e.cause?.code || e.cause?.message || e.cause}` : ''
          }`,
        );
        if (attempt < 3) await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
    if (!profile) {
      throw new UnauthorizedException(
        'Impossible de contacter Google. Vérifiez la connexion et réessayez.',
      );
    }
    const googleId: string = profile.sub;
    const email: string = profile.email;
    if (!googleId || !email) {
      throw new UnauthorizedException('Profil Google incomplet.');
    }
    return {
      googleId,
      googleEmail: email,
      googleName: profile.name || email.split('@')[0],
      googleAvatar: (profile.picture as string) || null,
    };
  }

  async googleLogin(accessToken: string) {
    const g = await this.fetchGoogleProfile(accessToken);

    let user =
      (await this.prisma.user.findFirst({ where: { googleId: g.googleId } })) ||
      (await this.prisma.user.findUnique({ where: { email: g.googleEmail } }));

    if (!user) {
      user = await this.prisma.user.create({
        data: {
          username: await this.uniqueUsernameFrom(g.googleName),
          email: g.googleEmail,
          password: await bcrypt.hash(crypto.randomUUID(), 10),
          provider: 'google',
          profileSource: 'google',
          ...g,
        },
      });
    } else {
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: { ...g, lastActive: new Date() },
      });
    }

    void this.gamification?.trackDailyLogin(user.id);
    return { token: this.signToken(user), user: serializeUser(user) };
  }

  async linkGoogle(userId: string, accessToken: string) {
    const current = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!current) throw new NotFoundException('Utilisateur introuvable.');
    const g = await this.fetchGoogleProfile(accessToken);
    if (current.googleId && current.googleId !== g.googleId) {
      throw new ConflictException('Un compte Google est déjà lié à ce profil.');
    }

    const owner = await this.prisma.user.findFirst({ where: { googleId: g.googleId } });
    let carry: any = {};
    if (owner && owner.id !== userId) {
      if (owner.mlbbRoleId && current.mlbbRoleId) {
        throw new ConflictException(
          'Chaque compte est déjà lié à un compte de jeu différent. Fusion automatique impossible.',
        );
      }

      if (owner.mlbbRoleId && !current.mlbbRoleId) {
        carry = {
          mlbbRoleId: owner.mlbbRoleId,
          mlbbZoneId: owner.mlbbZoneId,
          mlbbToken: owner.mlbbToken,
          gameNickname: owner.gameNickname,
          gameAvatar: owner.gameAvatar,
          gameLevel: owner.gameLevel,
          gameRankLevel: owner.gameRankLevel,
          gameCountry: owner.gameCountry,
          gameStats: owner.gameStats,
          gameFrequentHeroes: owner.gameFrequentHeroes,
          gameSyncedAt: owner.gameSyncedAt,
          gamePeakRankLevel: owner.gamePeakRankLevel,
          gameRoles: owner.gameRoles,
          gameSeasons: owner.gameSeasons,
          mlbbTokenStatus: owner.mlbbTokenStatus,
          mlbbTokenExpiredAt: owner.mlbbTokenExpiredAt,
          gameSyncStatus: owner.gameSyncStatus,
          gameSyncMessage: owner.gameSyncMessage,
          gameSyncAttemptAt: owner.gameSyncAttemptAt,
          gameStatsSyncedAt: owner.gameStatsSyncedAt,
        };
      }
      await this.mergeContent(userId, owner.id);
      await this.prisma.user.delete({ where: { id: owner.id } });
    }

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { ...g, ...carry, lastActive: new Date() },
    });
    return serializeUser(user);
  }

  async setProfileSource(userId: string, source: 'google' | 'game') {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Utilisateur introuvable.');
    if (source === 'google' && !user.googleId) {
      throw new BadRequestException('Aucun compte Google lié.');
    }
    if (source === 'game' && !user.mlbbRoleId) {
      throw new BadRequestException('Aucun compte de jeu lié.');
    }
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { profileSource: source },
    });
    return serializeUser(updated);
  }

  private async uniqueUsernameFrom(base: string): Promise<string> {
    const clean = (base || 'Joueur').trim().slice(0, 28);
    const exists = await this.prisma.user.findUnique({ where: { username: clean } });
    if (!exists) return clean;
    return `${clean.slice(0, 22)} ${Math.floor(1000 + Math.random() * 9000)}`.slice(0, 30);
  }

  private async uniqueUsername(base: string, roleId: number): Promise<string> {
    const clean = (base || `Player ${roleId}`).trim().slice(0, 30);
    const exists = await this.prisma.user.findUnique({ where: { username: clean } });
    if (!exists) return clean;
    return `${clean.slice(0, 22)} #${roleId}`.slice(0, 30);
  }

  async changePassword(dto: ChangePasswordDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (!user) {
      throw new UnauthorizedException('Identifiants invalides.');
    }
    const valid = await bcrypt.compare(dto.currentPassword, user.password);
    if (!valid) {
      throw new UnauthorizedException('Mot de passe actuel incorrect.');
    }
    const hashed = await bcrypt.hash(dto.newPassword, 10);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { password: hashed },
    });
    return { success: true, message: 'Mot de passe mis à jour.' };
  }
}
