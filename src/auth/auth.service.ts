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

// API publique MLBB. Deux bases : le domaine principal et son miroir officiel
// (annoncé par l'API elle-même dans `alternative_endpoint` quand elle sature).
// On tente la première, puis on bascule sur la suivante en cas d'indisponibilité.
const MLBB_BASES = [
  'https://mlbb.rone.dev/api',
  'https://openmlbb.fastapicloud.dev/api',
];

// Profil de jeu « vide » (quand l'API n'a pas renvoyé de jeton exploitable).
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

  async me(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException('Utilisateur introuvable.');
    }
    return serializeUser(user);
  }

  // ============ Connexion / liaison MLBB (code de vérification) ============

  /**
   * Appelle l'API MLBB avec bascule automatique vers le miroir : on essaie chaque
   * base tant que la réponse indique une indisponibilité (503 / SERVICE_UNAVAILABLE)
   * ou qu'une erreur réseau survient. Renvoie le JSON, ou null si tout échoue.
   */
  private async mlbbFetch(path: string, init?: any): Promise<any> {
    let last: any = null;
    for (const base of MLBB_BASES) {
      try {
        const res = await fetch(`${base}${path}`, init);
        const json = await res.json();
        if (res.status === 503 || json?.code === 'SERVICE_UNAVAILABLE') {
          last = json;
          continue; // base saturée → on tente la suivante
        }
        return json;
      } catch {
        // erreur réseau : on tente la base suivante
      }
    }
    return last;
  }

  /** Mappe les héros fréquents bruts de l'API MLBB vers notre format. */
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

  /** Liste des saisons du joueur (sids), la plus récente en tête. */
  private async fetchSeasons(token: string): Promise<number[]> {
    const json = await this.mlbbFetch('/user/season', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const sids = json?.data?.sids;
    return Array.isArray(sids) ? sids : [];
  }

  /** Héros fréquents du joueur pour une saison donnée (sid OBLIGATOIRE côté API). */
  private async fetchFrequentHeroes(token: string, sid: number, limit = 8): Promise<any[]> {
    const json = await this.mlbbFetch(
      `/user/heroes/frequent?sid=${sid}&limit=${limit}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    return this.mapFrequentHeroes(json?.data?.result);
  }

  /**
   * Récupère le profil de jeu complet : identité + statistiques globales
   * (« tous modes », `/user/stats` ne segmente pas par mode) + saisons +
   * héros favoris de la saison courante. Tolérant aux pannes.
   */
  private async fetchGameProfile(token: string) {
    const headers = { Authorization: `Bearer ${token}` };
    const [infoR, statsR, seasons] = await Promise.all([
      this.mlbbFetch('/user/info', { headers }),
      this.mlbbFetch('/user/stats', { headers }),
      this.fetchSeasons(token),
    ]);

    // Session valide seulement si l'API renvoie code 0 avec des données.
    // Sinon (token expiré, SERVICE_UNAVAILABLE, panne...), on NE doit PAS
    // écraser les données déjà stockées.
    const infoOk = !!(infoR && infoR.code === 0 && infoR.data);
    const statsOk = !!(statsR && statsR.code === 0 && statsR.data);
    const valid = infoOk || statsOk;

    const info = infoR?.data ?? {};
    const st = statsR?.data ?? {};
    // Les héros favoris exigent un sid : on prend la saison la plus récente.
    const currentSeason = seasons.length ? seasons[0] : null;
    const frequentHeroes =
      currentSeason != null ? await this.fetchFrequentHeroes(token, currentSeason) : [];

    // Rôles principaux (top 3) : on mappe les héros favoris vers leur rôle via
    // notre base héros, pondéré par le nombre de parties.
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
      valid,
    };
  }

  /** Déduit les 3 rôles principaux à partir des héros favoris (via la base héros). */
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

  /** Héros favoris du compte connecté pour une saison donnée (sélecteur de saison). */
  async gameHeroes(userId: string, sid: number) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.mlbbToken) {
      throw new BadRequestException('Aucun compte de jeu lié.');
    }
    return this.fetchFrequentHeroes(user.mlbbToken, sid);
  }

  /** Valide un code de vérification et renvoie le jeton de l'API MLBB. */
  private async validateMlbbCode(roleId: number, zoneId: number, vc: number) {
    const json = await this.mlbbFetch('/user/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role_id: roleId, zone_id: zoneId, vc }),
    });
    if (!json || json.code === 'SERVICE_UNAVAILABLE') {
      throw new BadRequestException('Service MLBB momentanément indisponible. Réessayez dans un instant.');
    }
    if (json.code !== 0 || !json.data) {
      throw new UnauthorizedException(json.msg || 'Code de vérification invalide ou expiré.');
    }
    return (json.data.jwt || json.data.token || null) as string | null;
  }

  /** Champs Prisma dérivés d'un profil de jeu, prêts pour create/update. */
  private gameFields(zoneId: number, token: string | null, profile: any) {
    return {
      mlbbZoneId: zoneId,
      mlbbToken: token,
      gameNickname: profile.nickname,
      gameAvatar: profile.avatar,
      gameLevel: profile.level,
      gameRankLevel: profile.rankLevel,
      gameCountry: profile.country,
      gameStats: toJson(profile.stats),
      gameFrequentHeroes: toJson(profile.frequentHeroes),
      gameRoles: toJson(profile.roles),
      gameSeasons: toJson(profile.seasons),
      gameSyncedAt: new Date(),
    };
  }

  /** Envoie un code de vérification dans le courrier en jeu du joueur. */
  async mlbbSendVc(roleId: number, zoneId: number) {
    const json = await this.mlbbFetch('/user/auth/send-vc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role_id: roleId, zone_id: zoneId }),
    });
    // Indisponibilité API (les deux bases KO) : message distinct du cas « mauvais ID ».
    if (!json || json.code === 'SERVICE_UNAVAILABLE') {
      throw new BadRequestException(
        'Service MLBB momentanément indisponible (trafic élevé). Réessaie dans quelques instants.',
      );
    }
    if (json.code !== 0) {
      throw new BadRequestException(
        json.msg || "Impossible d'envoyer le code. Vérifie l'ID de jeu et le serveur.",
      );
    }
    return {
      success: true,
      message: 'Code envoyé dans votre courrier en jeu (valable 5 minutes).',
    };
  }

  /** Connexion via le code reçu en jeu : valide le code, crée/retrouve notre compte et émet notre JWT. */
  async mlbbLogin(roleId: number, zoneId: number, vc: number) {
    const mlbbToken = await this.validateMlbbCode(roleId, zoneId, vc);
    const profile = mlbbToken
      ? await this.fetchGameProfile(mlbbToken)
      : { nickname: null, avatar: null, level: null, rankLevel: null, country: null, stats: {}, frequentHeroes: [] };

    // Crée ou met à jour notre utilisateur lié à ce compte MLBB.
    // (findFirst car mlbbRoleId n'est plus @unique côté Prisma — cf. index partiel.)
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

  /**
   * Réassigne le contenu (posts, commentaires, notifications) d'un compte
   * fusionné vers le compte conservé, avant suppression de l'ancien.
   */
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

  /**
   * Lie un compte de jeu MLBB à l'utilisateur déjà connecté (ex. compte Google).
   * Si ce compte de jeu existe déjà en tant que profil séparé, les deux comptes
   * sont fusionnés (contenu réassigné, ancien profil supprimé).
   */
  async linkMlbb(userId: string, roleId: number, zoneId: number, vc: number) {
    const current = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!current) throw new NotFoundException('Utilisateur introuvable.');
    if (current.mlbbRoleId && current.mlbbRoleId !== roleId) {
      throw new ConflictException('Un compte de jeu est déjà lié à ce profil.');
    }

    const mlbbToken = await this.validateMlbbCode(roleId, zoneId, vc);
    const profile = mlbbToken ? await this.fetchGameProfile(mlbbToken) : EMPTY_GAME_PROFILE;

    // Le compte de jeu appartient-il déjà à un autre profil ? Si oui : fusion.
    const owner = await this.prisma.user.findFirst({ where: { mlbbRoleId: roleId } });
    let carry: any = {};
    if (owner && owner.id !== userId) {
      if (owner.googleId && current.googleId) {
        throw new ConflictException(
          'Chaque compte est déjà lié à un compte Google différent. Fusion automatique impossible.',
        );
      }
      // On hérite du compte Google de l'autre profil si le courant n'en a pas.
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

  /** Resynchronise les données de jeu de l'utilisateur connecté. */
  async syncGame(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.mlbbToken || !user.mlbbZoneId) {
      throw new BadRequestException('Aucun compte de jeu lié.');
    }
    const profile = await this.fetchGameProfile(user.mlbbToken);
    // Session KO (API indisponible ou token expiré) : on NE touche PAS aux
    // données existantes, on remonte une erreur explicite.
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

  /**
   * Dissocie le compte de jeu MLBB du compte connecté (efface identité + données
   * de jeu). Refusé si c'est la seule méthode de connexion (pas de compte Google),
   * pour ne pas rendre le profil inaccessible.
   */
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
        // Le profil bascule sur Google si le jeu était la source affichée.
        profileSource: user.profileSource === 'game' ? 'google' : user.profileSource,
        provider: user.provider === 'mlbb' ? 'google' : user.provider,
      },
    });
    return serializeUser(updated);
  }

  // ============ Connexion / liaison Google ============

  /** Récupère le profil Google (sub, email, nom, photo) depuis un access token. */
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

  /** Connexion via Google : récupère le profil, crée/relie le compte, émet notre JWT. */
  async googleLogin(accessToken: string) {
    const g = await this.fetchGoogleProfile(accessToken);

    // Cherche par googleId, sinon par email (lie un compte local existant).
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

  /**
   * Lie un compte Google à l'utilisateur déjà connecté (ex. compte de jeu).
   * Si ce compte Google existe déjà en tant que profil séparé, les deux comptes
   * sont fusionnés (contenu réassigné, ancien profil supprimé).
   */
  async linkGoogle(userId: string, accessToken: string) {
    const current = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!current) throw new NotFoundException('Utilisateur introuvable.');
    const g = await this.fetchGoogleProfile(accessToken);
    if (current.googleId && current.googleId !== g.googleId) {
      throw new ConflictException('Un compte Google est déjà lié à ce profil.');
    }

    // Le compte Google appartient-il déjà à un autre profil ? Si oui : fusion.
    const owner = await this.prisma.user.findFirst({ where: { googleId: g.googleId } });
    let carry: any = {};
    if (owner && owner.id !== userId) {
      if (owner.mlbbRoleId && current.mlbbRoleId) {
        throw new ConflictException(
          'Chaque compte est déjà lié à un compte de jeu différent. Fusion automatique impossible.',
        );
      }
      // On hérite du compte de jeu de l'autre profil si le courant n'en a pas.
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

  /** Choisit la source du profil affiché (google | game). */
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

  /** Username unique à partir d'un nom (gère les collisions). */
  private async uniqueUsernameFrom(base: string): Promise<string> {
    const clean = (base || 'Joueur').trim().slice(0, 28);
    const exists = await this.prisma.user.findUnique({ where: { username: clean } });
    if (!exists) return clean;
    return `${clean.slice(0, 22)} ${Math.floor(1000 + Math.random() * 9000)}`.slice(0, 30);
  }

  /** Génère un username unique (gère les collisions avec @unique). */
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
