import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { serializeUserCard } from '../users/users.service';

export const ESPORT_ROLES = ['roam', 'jungle', 'mid', 'exp', 'gold'] as const;
export const MATCH_TYPES = ['friendly', 'training', 'official'];
export const MATCH_STATUS = ['scheduled', 'completed', 'cancelled'];

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
    description: team.description ?? null,
    type: team.type ?? 'community',
    isRecruiting: !!team.isRecruiting,
    esportId: team.esportId ?? null,
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

  private async attachStats(teams: any[]) {
    const completed = await this.prisma.esportMatch.findMany({
      where: { status: 'completed' },
      select: { teamAId: true, teamBId: true, winnerTeamId: true, status: true },
    });
    return teams.map((tm) => ({ ...tm, stats: this.computeTeamStats(tm.id, completed) }));
  }

  async getOrg() {
    const org = await this.prisma.esport.findFirst({
      include: { teams: { orderBy: { sort: 'asc' }, include: teamInclude } },
    });
    if (!org) return null;
    const teams = await this.attachStats((org.teams ?? []).map(serializeTeam));
    return { ...org, teams };
  }

  async getTeams(type?: string) {
    const teams = await this.prisma.esportTeam.findMany({
      where: type ? { type } : {},
      orderBy: { sort: 'asc' },
      include: teamInclude,
    });
    return this.attachStats(teams.map(serializeTeam));
  }

  async getTeam(id: string) {
    const team = await this.prisma.esportTeam.findUnique({
      where: { id },
      include: teamInclude,
    });
    if (!team) throw new NotFoundException('Équipe introuvable.');
    const [withStats] = await this.attachStats([serializeTeam(team)]);
    const matches = await this.getTeamMatches(id, 10);
    return { ...withStats, matches };
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
    const type = data.type === 'esport' ? 'esport' : 'community';
    const esportId = type === 'esport' ? await this.resolveOrgId(data.esportId) : null;
    const team = await this.prisma.esportTeam.create({
      data: {
        name: data.name,
        image: data.image ?? null,
        description: data.description ?? null,
        type,
        isRecruiting: !!data.isRecruiting,
        sort: typeof data.sort === 'number' ? data.sort : 0,
        esportId,
      },
    });

    // Créée depuis une demande de joueur : on lie la demande et on
    // désigne le demandeur comme capitaine.
    if (data.requestId) {
      const req = await this.prisma.teamRequest.findUnique({
        where: { id: data.requestId },
      });
      if (req) {
        await this.prisma.teamRequest.update({
          where: { id: req.id },
          data: { status: 'approved', createdTeamId: team.id },
        });
        const existing = await this.prisma.esportTeamMember.findUnique({
          where: { teamId_userId: { teamId: team.id, userId: req.requesterId } },
        });
        if (!existing) {
          await this.prisma.esportTeamMember.create({
            data: { teamId: team.id, userId: req.requesterId, isCaptain: true },
          });
        }
      }
    }
    return this.getTeam(team.id);
  }

  async updateTeam(id: string, data: any) {
    await this.getTeam(id);
    const team = await this.prisma.esportTeam.update({
      where: { id },
      data: {
        name: data.name ?? undefined,
        image: data.image === undefined ? undefined : data.image,
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

  async transformToEsport(id: string) {
    const team = await this.prisma.esportTeam.findUnique({ where: { id } });
    if (!team) throw new NotFoundException('Équipe introuvable.');
    const esportId = await this.resolveOrgId();
    await this.prisma.esportTeam.update({
      where: { id },
      data: { type: 'esport', esportId },
    });
    return this.getTeam(id);
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

  // ----- Seasons -----

  async listSeasons() {
    return this.prisma.esportSeason.findMany({
      orderBy: [{ isActive: 'desc' }, { startDate: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async getSeason(id: string) {
    const season = await this.prisma.esportSeason.findUnique({ where: { id } });
    if (!season) throw new NotFoundException('Saison introuvable.');
    return season;
  }

  async createSeason(data: any) {
    if (!data?.name) throw new BadRequestException('Le nom de la saison est requis.');
    if (data.isActive) await this.clearActiveSeasons();
    return this.prisma.esportSeason.create({
      data: {
        name: data.name,
        description: data.description ?? null,
        startDate: data.startDate ? new Date(data.startDate) : null,
        endDate: data.endDate ? new Date(data.endDate) : null,
        isActive: !!data.isActive,
      },
    });
  }

  async updateSeason(id: string, data: any) {
    await this.getSeason(id);
    if (data.isActive === true) await this.clearActiveSeasons();
    return this.prisma.esportSeason.update({
      where: { id },
      data: {
        name: data.name ?? undefined,
        description: data.description === undefined ? undefined : data.description,
        startDate:
          data.startDate === undefined
            ? undefined
            : data.startDate
              ? new Date(data.startDate)
              : null,
        endDate:
          data.endDate === undefined
            ? undefined
            : data.endDate
              ? new Date(data.endDate)
              : null,
        isActive: typeof data.isActive === 'boolean' ? data.isActive : undefined,
      },
    });
  }

  async deleteSeason(id: string) {
    await this.getSeason(id);
    await this.prisma.esportSeason.delete({ where: { id } });
    return { ok: true };
  }

  private async clearActiveSeasons() {
    await this.prisma.esportSeason.updateMany({
      where: { isActive: true },
      data: { isActive: false },
    });
  }

  // ----- Matches -----

  private async teamMap(ids: string[]) {
    const uniq = Array.from(new Set(ids.filter(Boolean)));
    const teams = uniq.length
      ? await this.prisma.esportTeam.findMany({
          where: { id: { in: uniq } },
          select: { id: true, name: true, image: true },
        })
      : [];
    return new Map(teams.map((tm) => [tm.id, tm]));
  }

  private serializeMatch(m: any, tmap: Map<string, any>) {
    return {
      id: m.id,
      seasonId: m.seasonId ?? null,
      type: m.type,
      status: m.status,
      scheduledAt: m.scheduledAt,
      scoreA: m.scoreA ?? 0,
      scoreB: m.scoreB ?? 0,
      winnerTeamId: m.winnerTeamId ?? null,
      notes: m.notes ?? null,
      createdAt: m.createdAt,
      teamA: tmap.get(m.teamAId) ?? { id: m.teamAId, name: '?' },
      teamB: tmap.get(m.teamBId) ?? { id: m.teamBId, name: '?' },
      winner: m.winnerTeamId ? tmap.get(m.winnerTeamId) ?? null : null,
    };
  }

  async listMatches(filter: { seasonId?: string; teamId?: string; status?: string } = {}) {
    const where: any = {};
    if (filter.seasonId) where.seasonId = filter.seasonId;
    if (filter.status) where.status = filter.status;
    if (filter.teamId)
      where.OR = [{ teamAId: filter.teamId }, { teamBId: filter.teamId }];
    const matches = await this.prisma.esportMatch.findMany({
      where,
      orderBy: [{ scheduledAt: 'desc' }, { createdAt: 'desc' }],
    });
    const tmap = await this.teamMap(
      matches.flatMap((m) => [m.teamAId, m.teamBId, m.winnerTeamId].filter(Boolean) as string[]),
    );
    return matches.map((m) => this.serializeMatch(m, tmap));
  }

  async getMatch(id: string) {
    const m = await this.prisma.esportMatch.findUnique({ where: { id } });
    if (!m) throw new NotFoundException('Match introuvable.');
    const tmap = await this.teamMap(
      [m.teamAId, m.teamBId, m.winnerTeamId].filter(Boolean) as string[],
    );
    return this.serializeMatch(m, tmap);
  }

  async createMatch(data: any, createdById?: string) {
    const type = MATCH_TYPES.includes(data?.type) ? data.type : 'friendly';
    if (!data?.teamAId || !data?.teamBId)
      throw new BadRequestException('Les deux équipes sont requises.');
    if (data.teamAId === data.teamBId)
      throw new BadRequestException('Une équipe ne peut pas jouer contre elle-même.');
    const found = await this.prisma.esportTeam.findMany({
      where: { id: { in: [data.teamAId, data.teamBId] } },
      select: { id: true },
    });
    if (found.length !== 2) throw new NotFoundException('Équipe introuvable.');
    if (data.seasonId) await this.getSeason(data.seasonId);

    await this.prisma.esportMatch.create({
      data: {
        seasonId: data.seasonId ?? null,
        type,
        teamAId: data.teamAId,
        teamBId: data.teamBId,
        scheduledAt: data.scheduledAt ? new Date(data.scheduledAt) : null,
        notes: data.notes ?? null,
        createdById: createdById ?? null,
      },
    });
    return this.listMatches();
  }

  async updateMatch(id: string, data: any) {
    await this.getMatch(id);
    const patch: any = {};
    if (data.type !== undefined)
      patch.type = MATCH_TYPES.includes(data.type) ? data.type : undefined;
    if (data.seasonId !== undefined) patch.seasonId = data.seasonId || null;
    if (data.teamAId !== undefined) patch.teamAId = data.teamAId;
    if (data.teamBId !== undefined) patch.teamBId = data.teamBId;
    if (data.scheduledAt !== undefined)
      patch.scheduledAt = data.scheduledAt ? new Date(data.scheduledAt) : null;
    if (data.notes !== undefined) patch.notes = data.notes;
    if (data.status !== undefined && MATCH_STATUS.includes(data.status))
      patch.status = data.status;
    if (patch.teamAId && patch.teamBId && patch.teamAId === patch.teamBId)
      throw new BadRequestException('Une équipe ne peut pas jouer contre elle-même.');
    await this.prisma.esportMatch.update({ where: { id }, data: patch });
    return this.getMatch(id);
  }

  async setMatchResult(id: string, data: any) {
    const m = await this.prisma.esportMatch.findUnique({ where: { id } });
    if (!m) throw new NotFoundException('Match introuvable.');
    const scoreA = Number.isFinite(+data?.scoreA) ? Math.max(0, +data.scoreA) : 0;
    const scoreB = Number.isFinite(+data?.scoreB) ? Math.max(0, +data.scoreB) : 0;
    let winnerTeamId: string | null = null;
    if (data?.winnerTeamId) {
      if (data.winnerTeamId !== m.teamAId && data.winnerTeamId !== m.teamBId)
        throw new BadRequestException("Le vainqueur doit être l'une des deux équipes.");
      winnerTeamId = data.winnerTeamId;
    } else if (scoreA > scoreB) winnerTeamId = m.teamAId;
    else if (scoreB > scoreA) winnerTeamId = m.teamBId;

    await this.prisma.esportMatch.update({
      where: { id },
      data: { scoreA, scoreB, winnerTeamId, status: 'completed' },
    });
    return this.getMatch(id);
  }

  async deleteMatch(id: string) {
    await this.getMatch(id);
    await this.prisma.esportMatch.delete({ where: { id } });
    return { ok: true };
  }

  private computeTeamStats(teamId: string, matches: any[]) {
    let wins = 0;
    let losses = 0;
    let draws = 0;
    for (const m of matches) {
      if (m.status !== 'completed') continue;
      if (m.teamAId !== teamId && m.teamBId !== teamId) continue;
      if (m.winnerTeamId === teamId) wins++;
      else if (m.winnerTeamId) losses++;
      else draws++;
    }
    const decisive = wins + losses;
    return {
      played: wins + losses + draws,
      wins,
      losses,
      draws,
      winRate: decisive ? Math.round((wins / decisive) * 100) : 0,
    };
  }

  async getTeamMatches(teamId: string, limit = 10) {
    const matches = await this.prisma.esportMatch.findMany({
      where: { OR: [{ teamAId: teamId }, { teamBId: teamId }] },
      orderBy: [{ scheduledAt: 'desc' }, { createdAt: 'desc' }],
      take: limit,
    });
    const tmap = await this.teamMap(
      matches.flatMap((m) => [m.teamAId, m.teamBId, m.winnerTeamId].filter(Boolean) as string[]),
    );
    return matches.map((m) => this.serializeMatch(m, tmap));
  }
}
