import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { toJson } from '../common/utils/json.util';
import { serializeUser } from '../users/users.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';

// Moonton upstream, called directly (no third-party proxy).
// AUTH_BASE handles the account flow (sendVc/login/logout/getBaseInfo).
// STATS_BASE (actgateway) serves the battlereport/* stats endpoints.
const AUTH_BASE = 'https://sg-api.mobilelegends.com';
const STATS_BASE = 'https://app.web.moontontech.com/actgateway';
// x-actid / x-appid are required by getBaseInfo (Moonton "academy" app).
const MLBB_X_ACTID = '2728785';
const MLBB_X_APPID = '2713644';
const MLBB_ORIGIN = 'https://www.mobilelegends.com';
const MLBB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

const EMPTY_GAME_PROFILE = {
  nickname: null,
  avatar: null,
  level: null,
  rankLevel: null,
  country: null,
  stats: {},
  frequentHeroes: [],
  roles: [],
  seasons: [],
  currentSeason: null,
};

@Injectable()
export class AuthService {
  private readonly logger = new Logger('AuthService');

  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
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

    const token = this.signToken(user);
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

  private mlbbBaseHeaders(): Record<string, string> {
    return {
      'User-Agent': MLBB_UA,
      Accept: '*/*',
      Origin: MLBB_ORIGIN,
      Referer: `${MLBB_ORIGIN}/`,
      DNT: '1',
    };
  }

  private encodeForm(data: Record<string, any>): string {
    const entries = Object.entries(data)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => [k, String(v)] as [string, string]);
    return new URLSearchParams(entries).toString();
  }

  /** Form POST to AUTH_BASE (sendVc/login/logout/getBaseInfo). */
  private async authPost(
    path: string,
    data: Record<string, any>,
    opts: { jwt?: string | null; forInfo?: boolean } = {},
  ): Promise<any> {
    const headers: Record<string, string> = {
      ...this.mlbbBaseHeaders(),
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    };
    if (opts.jwt) {
      headers['authorization'] = opts.jwt;
      headers['x-token'] = opts.jwt;
    }
    if (opts.forInfo) {
      headers['x-actid'] = MLBB_X_ACTID;
      headers['x-appid'] = MLBB_X_APPID;
    }
    try {
      const res = await fetch(`${AUTH_BASE}${path}`, {
        method: 'POST',
        headers,
        body: this.encodeForm(data),
      });
      return await res.json();
    } catch (e) {
      this.logger.warn(`MLBB authPost ${path} failed: ${e}`);
      return null;
    }
  }

  /** JSON GET to STATS_BASE actgateway (battlereport/*). */
  private async statsGet(
    path: string,
    params: Record<string, any>,
    jwt: string,
  ): Promise<any> {
    const qs = this.encodeForm(params);
    const url = `${STATS_BASE}/${path}${qs ? `?${qs}` : ''}`;
    try {
      const res = await fetch(url, {
        headers: {
          ...this.mlbbBaseHeaders(),
          Accept: 'application/json, text/plain, */*',
          authorization: jwt,
          'x-token': jwt,
        },
      });
      return await res.json();
    } catch (e) {
      this.logger.warn(`MLBB statsGet ${path} failed: ${e}`);
      return null;
    }
  }

  private mapFrequentHeroes(result: any): any[] {
    return (Array.isArray(result) ? result : []).map((h: any) => ({
      heroId: h.hid,
      name: h.hid_e?.n ?? `#${h.hid}`,
      image: h.hid_e?.ix ?? null,
      image2x: h.hid_e?.i2x ?? null,
      matches: h.tc ?? 0,
      wins: h.wc ?? 0,
      winRate: h.tc ? Math.round(((h.wc ?? 0) / h.tc) * 1000) / 10 : 0,
      power: h.p ?? 0,
    }));
  }

  private async fetchSeasons(jwt: string): Promise<{ ok: boolean; sids: number[] }> {
    const json = await this.statsGet('battlereport/season/list', {}, jwt);
    const ok = !!(json && json.code === 0 && json.data);
    const sids = json?.data?.sids;
    return { ok, sids: Array.isArray(sids) ? sids : [] };
  }

  private async fetchFrequentHeroes(jwt: string, sid: number, limit = 8): Promise<any[]> {
    const json = await this.statsGet(
      'battlereport/heros/frequent',
      { sid, limit },
      jwt,
    );
    return this.mapFrequentHeroes(json?.data?.result);
  }

  private async fetchGameProfile(jwt: string, roleId: number, zoneId: number) {
    const [infoR, statsR, seasonRes] = await Promise.all([
      this.authPost('/base/getBaseInfo', { roleId, zoneId }, { jwt, forInfo: true }),
      this.statsGet('battlereport/stats', {}, jwt),
      this.fetchSeasons(jwt),
    ]);

    const infoOk = !!(infoR && infoR.code === 0 && infoR.data);
    const statsOk = !!(statsR && statsR.code === 0 && statsR.data);
    const seasonsOk = seasonRes.ok;
    const valid = infoOk || statsOk || seasonsOk;

    const info = infoR?.data ?? {};
    const st = statsR?.data ?? {};
    const seasons = seasonRes.sids;

    const currentSeason = seasons.length ? seasons[0] : null;
    const frequentHeroes =
      currentSeason != null ? await this.fetchFrequentHeroes(jwt, currentSeason) : [];

    const roles = await this.computeMainRoles(frequentHeroes);

    const wins = st.wc ?? 0;
    const total = st.tc ?? 0;
    const stats = {
      wins,
      total,
      losses: Math.max(0, total - wins),
      winRate: total ? Math.round((wins / total) * 1000) / 10 : 0,
      avgScore: st.as ? Math.round((st.as / 100) * 100) / 100 : 0,
      gameTime: st.gt ?? 0,
      mvpCount: st.mvpc ?? 0,
      winStreak: st.wsc ?? 0,
    };

    return {
      nickname: info.name || null,
      avatar: info.avatar || null,
      level: info.level ?? null,
      rankLevel: info.rank_level ?? null,
      country: info.reg_country || null,
      stats,
      frequentHeroes,
      roles,
      seasons,
      currentSeason,
      infoOk,
      statsOk,
      seasonsOk,
      valid,
    };
  }

  private async computeMainRoles(
    frequentHeroes: any[],
  ): Promise<Array<{ role: string; matches: number }>> {
    if (!frequentHeroes.length) return [];
    const names = frequentHeroes.map((h) => h.name).filter(Boolean);
    const heroes = await this.prisma.hero.findMany({
      where: { name: { in: names } },
      select: { name: true, role: true },
    });
    const roleByName = new Map(heroes.map((h) => [h.name, h.role]));
    const tally = new Map<string, number>();
    for (const h of frequentHeroes) {
      const role = roleByName.get(h.name);
      if (!role) continue;
      tally.set(role, (tally.get(role) ?? 0) + (h.matches ?? 0));
    }
    return [...tally.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([role, matches]) => ({ role, matches }));
  }

  async gameHeroes(userId: string, sid: number) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.mlbbToken) {
      throw new BadRequestException('Aucun compte de jeu lié.');
    }
    return this.fetchFrequentHeroes(user.mlbbToken, sid);
  }

  private async validateMlbbCode(roleId: number, zoneId: number, vc: number) {
    const json = await this.authPost('/base/login', {
      roleId,
      zoneId,
      vc,
      referer: 'academy',
      type: 'web',
    });
    if (!json) {
      throw new BadRequestException('Service MLBB momentanément indisponible. Réessayez dans un instant.');
    }
    if (json.code !== 0 || !json.data) {
      throw new UnauthorizedException(
        json.msg || json.message || 'Code de vérification invalide ou expiré.',
      );
    }
    return (json.data.jwt || json.data.token || null) as string | null;
  }

  private gameFields(zoneId: number, token: string | null, profile: any) {
    const data: any = {
      mlbbZoneId: zoneId,
      mlbbToken: token,
      gameSyncedAt: new Date(),
    };
    if (profile.infoOk !== false) {
      data.gameNickname = profile.nickname;
      data.gameAvatar = profile.avatar;
      data.gameLevel = profile.level;
      data.gameRankLevel = profile.rankLevel;
      data.gameCountry = profile.country;
    }
    if (profile.statsOk !== false) {
      data.gameStats = toJson(profile.stats);
    }
    if (profile.seasonsOk !== false) {
      data.gameFrequentHeroes = toJson(profile.frequentHeroes);
      data.gameRoles = toJson(profile.roles);
      data.gameSeasons = toJson(profile.seasons);
    }
    return data;
  }

  async mlbbSendVc(roleId: number, zoneId: number) {
    const json = await this.authPost('/base/sendVc', { roleId, zoneId });

    if (!json) {
      throw new BadRequestException(
        'Service MLBB momentanément indisponible (trafic élevé). Réessaie dans quelques instants.',
      );
    }
    if (json.code !== 0) {
      throw new BadRequestException(
        json.msg || json.message || "Impossible d'envoyer le code. Vérifie l'ID de jeu et le serveur.",
      );
    }
    return {
      success: true,
      message: 'Code envoyé dans votre courrier en jeu (valable 5 minutes).',
    };
  }

  async mlbbLogin(roleId: number, zoneId: number, vc: number) {
    const mlbbToken = await this.validateMlbbCode(roleId, zoneId, vc);
    const profile = mlbbToken
      ? await this.fetchGameProfile(mlbbToken, roleId, zoneId)
      : { nickname: null, avatar: null, level: null, rankLevel: null, country: null, stats: {}, frequentHeroes: [] };

    let user = await this.prisma.user.findFirst({ where: { mlbbRoleId: roleId } });
    if (!user) {
      user = await this.prisma.user.create({
        data: {
          username: await this.uniqueUsername(profile.nickname || `Player ${roleId}`, roleId),
          email: `mlbb-${roleId}@players.mlbbtogo`,
          password: await bcrypt.hash(crypto.randomUUID(), 10),
          provider: 'mlbb',
          mlbbRoleId: roleId,
          profileSource: 'game',
          ...this.gameFields(zoneId, mlbbToken, profile),
        },
      });
    } else {
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: { ...this.gameFields(zoneId, mlbbToken, profile), lastActive: new Date() },
      });
    }

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
  }

  async linkMlbb(userId: string, roleId: number, zoneId: number, vc: number) {
    const current = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!current) throw new NotFoundException('Utilisateur introuvable.');
    if (current.mlbbRoleId && current.mlbbRoleId !== roleId) {
      throw new ConflictException('Un compte de jeu est déjà lié à ce profil.');
    }

    const mlbbToken = await this.validateMlbbCode(roleId, zoneId, vc);
    const profile = mlbbToken
      ? await this.fetchGameProfile(mlbbToken, roleId, zoneId)
      : EMPTY_GAME_PROFILE;

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

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        mlbbRoleId: roleId,
        ...this.gameFields(zoneId, mlbbToken, profile),
        ...carry,
        lastActive: new Date(),
      },
    });
    return serializeUser(user);
  }

  async syncGame(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.mlbbToken || !user.mlbbZoneId || !user.mlbbRoleId) {
      throw new BadRequestException('Aucun compte de jeu lié.');
    }
    const profile = await this.fetchGameProfile(
      user.mlbbToken,
      user.mlbbRoleId,
      user.mlbbZoneId,
    );

    if (!profile.valid) {
      throw new BadRequestException(
        "Le service Mobile Legends est momentanément indisponible ou ta session de jeu a expiré. Réessaie plus tard ; si le problème persiste, relie ton compte de jeu (nouveau code de vérification).",
      );
    }
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: this.gameFields(user.mlbbZoneId, user.mlbbToken, profile),
    });
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

        profileSource: user.profileSource === 'game' ? 'google' : user.profileSource,
        provider: user.provider === 'mlbb' ? 'google' : user.provider,
      },
    });
    return serializeUser(updated);
  }

  private async fetchGoogleProfile(accessToken: string) {
    let profile: any;
    try {
      const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new Error('userinfo ' + res.status);
      profile = await res.json();
    } catch (e: any) {
      this.logger.warn(`Google userinfo échec: ${e?.message}`);
      throw new UnauthorizedException('Jeton Google invalide.');
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
