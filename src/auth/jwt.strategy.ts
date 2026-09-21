import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Resolve the JWT secret from the environment. There is deliberately NO fallback:
 * a missing secret must crash the app at boot rather than sign tokens with a
 * public, source-controlled value that anyone could use to forge admin tokens.
 */
export function getJwtSecret(config?: ConfigService): string {
  const secret = config?.get<string>('JWT_SECRET') ?? process.env.JWT_SECRET;
  if (!secret) {
    throw new Error(
      'JWT_SECRET manquant : définissez-le dans le fichier .env avant de démarrer le serveur.',
    );
  }
  return secret;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private prisma: PrismaService,
    config: ConfigService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: getJwtSecret(config),
    });
  }

  async validate(payload: any) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
    });
    if (!user) {
      throw new UnauthorizedException('Utilisateur introuvable.');
    }
    // Enforce bans on every request, including tokens issued before the ban.
    if (user.isBanned) {
      throw new UnauthorizedException('Compte suspendu.');
    }
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      roleUser: user.roleUser,
    };
  }
}
