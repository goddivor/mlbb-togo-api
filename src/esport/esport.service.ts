import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { serializeUserCard } from '../users/users.service';

export const ESPORT_ROLES = ['roam', 'jungle', 'mid', 'exp', 'gold'] as const;

function assertRole(role: unknown) {
  if (role == null) return null;
  if (typeof role !== 'string' || !ESPORT_ROLES.includes(role as any)) {
    throw new BadRequestException(
      `Rôle invalide. Valeurs autorisées : ${ESPORT_ROLES.join(', ')}.`,
    );
  }
  return role;
}

function serializeMember(m: any) {
  return {
    id: m.id,
    userId: m.userId,
    role: m.role ?? null,
    isCaptain: !!m.isCaptain,
    isSubstitute: !!m.isSubstitute,
    sort: m.sort ?? 0,
    joinedAt: m.joinedAt,
    user: m.user ? serializeUserCard(m.user) : null,
  };
}

function orderMembers(members: any[]) {
  return [...members].sort((a, b) => {
    if (a.isCaptain !== b.isCaptain) return a.isCaptain ? -1 : 1;
    if (a.isSubstitute !== b.isSubstitute) return a.isSubstitute ? 1 : -1;
    return (a.sort ?? 0) - (b.sort ?? 0);
  });
}

function serializeTeam(team: any) {
  if (!team) return team;
  const members = orderMembers(team.members ?? []).map(serializeMember);
  const captain = members.find((m) => m.isCaptain) ?? null;
  return {
    id: team.id,
    name: team.name,
    image: team.image ?? null,
    tag: team.tag ?? null,
    description: team.description ?? null,
    isRecruiting: !!team.isRecruiting,
    esportId: team.esportId,
    sort: team.sort ?? 0,
    foundedAt: team.foundedAt,
    memberCount: members.length,
    starterCount: members.filter((m) => !m.isSubstitute).length,
    substituteCount: members.filter((m) => m.isSubstitute).length,
    captain,
    members,
  };
}

const teamInclude = {
  members: { include: { user: true }, orderBy: { sort: 'asc' as const } },
};

@Injectable()
export class EsportService {
  constructor(private prisma: PrismaService) {}

  async getOrg() {
    const org = await this.prisma.esport.findFirst({
      include: { teams: { orderBy: { sort: 'asc' }, include: teamInclude } },
    });
    if (!org) return null;
    return { ...org, teams: (org.teams ?? []).map(serializeTeam) };
  }

  async getTeams() {
    const teams = await this.prisma.esportTeam.findMany({
      orderBy: { sort: 'asc' },
      include: teamInclude,
    });
    return teams.map(serializeTeam);
  }

  async getTeam(id: string) {
    const team = await this.prisma.esportTeam.findUnique({
      where: { id },
      include: teamInclude,
    });
    if (!team) throw new NotFoundException('Équipe introuvable.');
    return serializeTeam(team);
  }

  async getSponsors() {
    return this.prisma.sponsor.findMany({ orderBy: { sort: 'asc' } });
  }

  async getMtl() {
    return this.prisma.mtl.findFirst({
      include: { images: { orderBy: { sort: 'asc' } } },
    });
  }

  // ----- Admin: organisation -----

  private async resolveOrgId(esportId?: string) {
    if (esportId) return esportId;
    const org = await this.prisma.esport.findFirst({ select: { id: true } });
    if (!org)
      throw new BadRequestException(
        "Aucune organisation e-sport n'existe. Créez-en une d'abord.",
      );
    return org.id;
  }

  async updateOrg(id: string, data: any) {
    const org = await this.prisma.esport.findUnique({ where: { id } });
    if (!org) throw new NotFoundException('Organisation introuvable.');
    return this.prisma.esport.update({
      where: { id },
      data: {
        name: data.name ?? undefined,
        logo: data.logo ?? undefined,
        color: data.color ?? undefined,
        description: data.description ?? undefined,
      },
    });
  }

  // ----- Admin: équipes -----

  async createTeam(data: any) {
    if (!data?.name)
      throw new BadRequestException("Le nom de l'équipe est requis.");
    const esportId = await this.resolveOrgId(data.esportId);
    const team = await this.prisma.esportTeam.create({
      data: {
        name: data.name,
        image: data.image ?? null,
        tag: data.tag ?? null,
        description: data.description ?? null,
        isRecruiting: !!data.isRecruiting,
        sort: typeof data.sort === 'number' ? data.sort : 0,
        esportId,
      },
      include: teamInclude,
    });
    return serializeTeam(team);
  }

  async updateTeam(id: string, data: any) {
    await this.getTeam(id);
    const team = await this.prisma.esportTeam.update({
      where: { id },
      data: {
        name: data.name ?? undefined,
        image: data.image === undefined ? undefined : data.image,
        tag: data.tag === undefined ? undefined : data.tag,
        description:
          data.description === undefined ? undefined : data.description,
        isRecruiting:
          typeof data.isRecruiting === 'boolean' ? data.isRecruiting : undefined,
        sort: typeof data.sort === 'number' ? data.sort : undefined,
      },
      include: teamInclude,
    });
    return serializeTeam(team);
  }

  async deleteTeam(id: string) {
    await this.getTeam(id);
    await this.prisma.esportTeam.delete({ where: { id } });
    return { ok: true };
  }

  // ----- Admin: membres -----

  async addMember(teamId: string, data: any) {
    await this.getTeam(teamId);
    if (!data?.userId) throw new BadRequestException('userId est requis.');
    const user = await this.prisma.user.findUnique({
      where: { id: data.userId },
    });
    if (!user) throw new NotFoundException('Joueur introuvable.');
    const role = assertRole(data.role);
    const existing = await this.prisma.esportTeamMember.findUnique({
      where: { teamId_userId: { teamId, userId: data.userId } },
    });
    if (existing)
      throw new ConflictException("Ce joueur est déjà membre de l'équipe.");

    if (data.isCaptain) await this.clearCaptain(teamId);
    await this.prisma.esportTeamMember.create({
      data: {
        teamId,
        userId: data.userId,
        role,
        isCaptain: !!data.isCaptain,
        isSubstitute: !!data.isSubstitute,
        sort: typeof data.sort === 'number' ? data.sort : 0,
      },
    });
    return this.getTeam(teamId);
  }

  async updateMember(teamId: string, userId: string, data: any) {
    const member = await this.prisma.esportTeamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    if (!member) throw new NotFoundException("Membre introuvable dans l'équipe.");
    const role = data.role === undefined ? undefined : assertRole(data.role);

    if (data.isCaptain === true) await this.clearCaptain(teamId);
    await this.prisma.esportTeamMember.update({
      where: { teamId_userId: { teamId, userId } },
      data: {
        role,
        isCaptain:
          typeof data.isCaptain === 'boolean' ? data.isCaptain : undefined,
        isSubstitute:
          typeof data.isSubstitute === 'boolean' ? data.isSubstitute : undefined,
        sort: typeof data.sort === 'number' ? data.sort : undefined,
      },
    });
    return this.getTeam(teamId);
  }

  async removeMember(teamId: string, userId: string) {
    const member = await this.prisma.esportTeamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    if (!member) throw new NotFoundException("Membre introuvable dans l'équipe.");
    await this.prisma.esportTeamMember.delete({
      where: { teamId_userId: { teamId, userId } },
    });
    return this.getTeam(teamId);
  }

  async setCaptain(teamId: string, userId: string) {
    const member = await this.prisma.esportTeamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    if (!member) throw new NotFoundException("Membre introuvable dans l'équipe.");
    await this.clearCaptain(teamId);
    await this.prisma.esportTeamMember.update({
      where: { teamId_userId: { teamId, userId } },
      data: { isCaptain: true },
    });
    return this.getTeam(teamId);
  }

  private async clearCaptain(teamId: string) {
    await this.prisma.esportTeamMember.updateMany({
      where: { teamId, isCaptain: true },
      data: { isCaptain: false },
    });
  }

  // ----- Admin: sponsors -----

  async createSponsor(data: any) {
    if (!data?.logo)
      throw new BadRequestException('Le logo du sponsor est requis.');
    return this.prisma.sponsor.create({
      data: {
        name: data.name ?? null,
        logo: data.logo,
        url: data.url ?? null,
        sort: typeof data.sort === 'number' ? data.sort : 0,
      },
    });
  }

  async updateSponsor(id: string, data: any) {
    const sponsor = await this.prisma.sponsor.findUnique({ where: { id } });
    if (!sponsor) throw new NotFoundException('Sponsor introuvable.');
    return this.prisma.sponsor.update({
      where: { id },
      data: {
        name: data.name === undefined ? undefined : data.name,
        logo: data.logo ?? undefined,
        url: data.url === undefined ? undefined : data.url,
        sort: typeof data.sort === 'number' ? data.sort : undefined,
      },
    });
  }

  async deleteSponsor(id: string) {
    const sponsor = await this.prisma.sponsor.findUnique({ where: { id } });
    if (!sponsor) throw new NotFoundException('Sponsor introuvable.');
    await this.prisma.sponsor.delete({ where: { id } });
    return { ok: true };
  }
}
