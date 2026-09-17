import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { serializeUserCard } from '../users/users.service';
import { STAFF_ROLES, parseHonours } from './esport-stats.service';

const MAX_HONOURS = 50;

function assertStaffRole(role: unknown) {
  if (role == null) return 'coach';
  if (typeof role !== 'string' || !STAFF_ROLES.includes(role as any)) {
    throw new BadRequestException(
      `Rôle staff invalide. Valeurs autorisées : ${STAFF_ROLES.join(', ')}.`,
    );
  }
  return role;
}

function cleanString(v: unknown, max = 500): string | null {
  if (v === null) return null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}

/** Validate the honours payload sent by the admin, returns the JSON to store. */
export function normalizeHonoursInput(input: unknown): string {
  if (!Array.isArray(input))
    throw new BadRequestException('honours doit être une liste.');
  if (input.length > MAX_HONOURS)
    throw new BadRequestException(`Maximum ${MAX_HONOURS} distinctions.`);
  const list = input.map((h: any, i: number) => {
    const title = cleanString(h?.title, 120);
    if (!title)
      throw new BadRequestException(`Le titre de la distinction #${i + 1} est requis.`);
    const placement = h?.placement == null || h.placement === '' ? null : +h.placement;
    if (placement != null && (!Number.isFinite(placement) || placement < 1 || placement > 99))
      throw new BadRequestException(`Classement invalide pour « ${title} ».`);
    const year = h?.year == null || h.year === '' ? null : +h.year;
    if (year != null && (!Number.isFinite(year) || year < 1900 || year > 2200))
      throw new BadRequestException(`Année invalide pour « ${title} ».`);
    return {
      id: typeof h?.id === 'string' && h.id ? h.id : `h${Date.now().toString(36)}${i}`,
      title,
      placement: placement == null ? null : Math.round(placement),
      year: year == null ? null : Math.round(year),
      description: cleanString(h?.description, 300),
    };
  });
  return JSON.stringify(list);
}

/**
 * Staff (coach, manager...) and honours management.
 * Isolated from EsportService so roster/match logic is left alone.
 */
@Injectable()
export class EsportStaffService {
  constructor(private prisma: PrismaService) {}

  private async assertTeam(id: string) {
    const team = await this.prisma.esportTeam.findUnique({
      where: { id },
      select: { id: true, honours: true },
    });
    if (!team) throw new NotFoundException('Équipe introuvable.');
    return team;
  }

  private async serializeStaff(rows: any[]) {
    const userIds = Array.from(new Set(rows.map((r) => r.userId).filter(Boolean)));
    const users = userIds.length
      ? await this.prisma.user.findMany({ where: { id: { in: userIds } } })
      : [];
    const umap = new Map(users.map((u) => [u.id, serializeUserCard(u)]));
    return rows.map((r) => {
      const user = r.userId ? (umap.get(r.userId) ?? null) : null;
      return {
        id: r.id,
        teamId: r.teamId,
        userId: r.userId ?? null,
        name: r.name || user?.displayName || user?.username || '',
        role: r.role,
        avatar: r.avatar || user?.avatar || null,
        bio: r.bio ?? null,
        sort: r.sort ?? 0,
        createdAt: r.createdAt,
        user,
      };
    });
  }

  async listStaff(teamId: string) {
    await this.assertTeam(teamId);
    const rows = await this.prisma.esportTeamStaff.findMany({
      where: { teamId },
      orderBy: [{ sort: 'asc' }, { createdAt: 'asc' }],
    });
    return this.serializeStaff(rows);
  }

  private async resolveUser(userId: unknown) {
    if (!userId) return null;
    if (typeof userId !== 'string') throw new BadRequestException('userId invalide.');
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Joueur introuvable.');
    return user;
  }

  async addStaff(teamId: string, data: any) {
    await this.assertTeam(teamId);
    const user = await this.resolveUser(data?.userId);
    const card = user ? serializeUserCard(user) : null;
    const name = cleanString(data?.name, 80) || card?.displayName || card?.username || null;
    if (!name) throw new BadRequestException('Le nom du membre du staff est requis.');
    await this.prisma.esportTeamStaff.create({
      data: {
        teamId,
        userId: user?.id ?? null,
        name,
        role: assertStaffRole(data?.role),
        avatar: cleanString(data?.avatar, 1000),
        bio: cleanString(data?.bio, 500),
        sort: typeof data?.sort === 'number' ? data.sort : 0,
      },
    });
    return this.listStaff(teamId);
  }

  async updateStaff(teamId: string, staffId: string, data: any) {
    await this.assertTeam(teamId);
    const row = await this.prisma.esportTeamStaff.findFirst({
      where: { id: staffId, teamId },
    });
    if (!row) throw new NotFoundException('Membre du staff introuvable.');
    const patch: any = {};
    if (data?.userId !== undefined) {
      const user = await this.resolveUser(data.userId);
      patch.userId = user?.id ?? null;
    }
    if (data?.name !== undefined) {
      const name = cleanString(data.name, 80);
      if (!name) throw new BadRequestException('Le nom du membre du staff est requis.');
      patch.name = name;
    }
    if (data?.role !== undefined) patch.role = assertStaffRole(data.role);
    if (data?.avatar !== undefined) patch.avatar = cleanString(data.avatar, 1000);
    if (data?.bio !== undefined) patch.bio = cleanString(data.bio, 500);
    if (typeof data?.sort === 'number') patch.sort = data.sort;
    await this.prisma.esportTeamStaff.update({ where: { id: staffId }, data: patch });
    return this.listStaff(teamId);
  }

  async removeStaff(teamId: string, staffId: string) {
    await this.assertTeam(teamId);
    const row = await this.prisma.esportTeamStaff.findFirst({
      where: { id: staffId, teamId },
    });
    if (!row) throw new NotFoundException('Membre du staff introuvable.');
    await this.prisma.esportTeamStaff.delete({ where: { id: staffId } });
    return this.listStaff(teamId);
  }

  /** Manual honours only (what the admin edits). */
  async getManualHonours(teamId: string) {
    const team = await this.assertTeam(teamId);
    return parseHonours(team.honours);
  }

  async setHonours(teamId: string, honours: unknown) {
    await this.assertTeam(teamId);
    const json = normalizeHonoursInput(honours);
    await this.prisma.esportTeam.update({ where: { id: teamId }, data: { honours: json } });
    return parseHonours(json);
  }
}
