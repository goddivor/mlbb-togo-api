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

// API publique MLBB (rone.dev) pour la connexion par code de vérification.
const MLBB_API = 'https://mlbb.rone.dev/api';

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

  // ============ Connexion MLBB (code de vérification) ============

  /** Envoie un code de vérification dans le courrier en jeu du joueur. */
  async mlbbSendVc(roleId: number, zoneId: number) {
    let json: any;
    try {
      const res = await fetch(`${MLBB_API}/user/auth/send-vc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role_id: roleId, zone_id: zoneId }),
      });
      json = await res.json();
    } catch (e: any) {
      this.logger.warn(`send-vc injoignable: ${e?.message}`);
      throw new BadRequestException("Service MLBB momentanément indisponible. Réessayez.");
    }
    if (json?.code !== 0) {
      throw new BadRequestException(
        json?.msg || "Impossible d'envoyer le code. Vérifiez l'ID de jeu et le serveur.",
      );
    }
    return {
      success: true,
      message: 'Code envoyé dans votre courrier en jeu (valable 5 minutes).',
    };
  }

  /** Connexion via le code reçu en jeu : valide le code, crée/retrouve notre compte et émet notre JWT. */
  async mlbbLogin(roleId: number, zoneId: number, vc: number) {
    let json: any;
    try {
      const res = await fetch(`${MLBB_API}/user/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role_id: roleId, zone_id: zoneId, vc }),
      });
      json = await res.json();
    } catch (e: any) {
      this.logger.warn(`mlbb login injoignable: ${e?.message}`);
      throw new BadRequestException('Service MLBB momentanément indisponible. Réessayez.');
    }
    if (json?.code !== 0 || !json?.data) {
      throw new UnauthorizedException(json?.msg || 'Code de vérification invalide ou expiré.');
    }

    const data = json.data;
    const mlbbToken: string | null = data.jwt || data.token || null;

    // Nom du joueur (best-effort via /user/info).
    let playerName = `Player ${roleId}`;
    if (mlbbToken) {
      try {
        const infoRes = await fetch(`${MLBB_API}/user/info`, {
          headers: { Authorization: `Bearer ${mlbbToken}` },
        });
        const info: any = await infoRes.json();
        const d = info?.data ?? {};
        playerName = d.name || d.nickname || d.username || d.roleName || playerName;
      } catch {
        /* on garde le nom par défaut */
      }
    }

    // Crée ou met à jour notre utilisateur lié à ce compte MLBB.
    let user = await this.prisma.user.findUnique({ where: { mlbbRoleId: roleId } });
    if (!user) {
      user = await this.prisma.user.create({
        data: {
          username: await this.uniqueUsername(playerName, roleId),
          email: `mlbb-${roleId}@players.mlbbtogo`,
          password: await bcrypt.hash(crypto.randomUUID(), 10),
          provider: 'mlbb',
          mlbbRoleId: roleId,
          mlbbZoneId: zoneId,
          mlbbToken,
        },
      });
    } else {
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: { mlbbZoneId: zoneId, mlbbToken, lastActive: new Date() },
      });
    }

    return { token: this.signToken(user), user: serializeUser(user) };
  }

  // ============ Connexion Google ============

  /** Connexion via Google : récupère le profil avec l'access token, crée/relie le compte, émet notre JWT. */
  async googleLogin(accessToken: string) {
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
    const name: string = profile.name || email.split('@')[0];
    const avatar: string | null = profile.picture || null;

    // Cherche par googleId, sinon par email (lie un compte existant).
    let user =
      (await this.prisma.user.findUnique({ where: { googleId } })) ||
      (await this.prisma.user.findUnique({ where: { email } }));

    if (!user) {
      user = await this.prisma.user.create({
        data: {
          username: await this.uniqueUsernameFrom(name),
          email,
          password: await bcrypt.hash(crypto.randomUUID(), 10),
          provider: 'google',
          googleId,
          avatar,
        },
      });
    } else if (!user.googleId) {
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: { googleId, avatar: user.avatar ?? avatar, lastActive: new Date() },
      });
    } else {
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: { lastActive: new Date() },
      });
    }

    return { token: this.signToken(user), user: serializeUser(user) };
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
