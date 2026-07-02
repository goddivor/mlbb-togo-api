import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { serializeUserCard } from '../users/users.service';
import { CommunityService } from '../community/community.service';

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
  constructor(
    private prisma: PrismaService,
    private community: CommunityService,
  ) {}

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

  // Admin, ou capitaine de l'équipe concernée.
  private async assertTeamManager(teamId: string, user: any) {
    if (user?.roleUser === 'admin') return;
    if (user?.id && (await this.isCaptain(teamId, user.id))) return;
    throw new ForbiddenException("Réservé au capitaine de l'équipe.");
  }

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

  async updateMember(teamId: string, userId: string, data: any, user?: any) {
    await this.assertTeamManager(teamId, user);
    const member = await this.prisma.esportTeamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    if (!member) throw new NotFoundException("Membre introuvable dans l'équipe.");
    const isAdmin = user?.roleUser === 'admin';
    const role = data.role === undefined ? undefined : assertRole(data.role);

    // Seul l'admin peut toucher au statut de capitaine.
    if (isAdmin && data.isCaptain === true) await this.clearCaptain(teamId);
    await this.prisma.esportTeamMember.update({
      where: { teamId_userId: { teamId, userId } },
      data: {
        role,
        isCaptain:
          isAdmin && typeof data.isCaptain === 'boolean'
            ? data.isCaptain
            : undefined,
        isSubstitute:
          typeof data.isSubstitute === 'boolean' ? data.isSubstitute : undefined,
        sort: typeof data.sort === 'number' ? data.sort : undefined,
      },
    });
    return this.getTeam(teamId);
  }

  async removeMember(teamId: string, userId: string, user?: any) {
    await this.assertTeamManager(teamId, user);
    const member = await this.prisma.esportTeamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    if (!member) throw new NotFoundException("Membre introuvable dans l'équipe.");
    // Le capitaine ne peut pas se retirer lui-même (le capitaine).
    if (user?.roleUser !== 'admin' && member.isCaptain)
      throw new ForbiddenException('Le capitaine ne peut pas être retiré.');
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

  // Admin, ou capitaine d'une des deux équipes (hors officiel).
  private async assertMatchManager(match: any, user: any) {
    if (user?.roleUser === 'admin') return;
    if (match.type === 'official')
      throw new ForbiddenException(
        "Seul l'administrateur peut gérer une rencontre officielle.",
      );
    if (
      user?.id &&
      ((await this.isCaptain(match.teamAId, user.id)) ||
        (await this.isCaptain(match.teamBId, user.id)))
    )
      return;
    throw new ForbiddenException("Réservé au capitaine de l'équipe.");
  }

  async createMatch(data: any, createdById?: string, user?: any) {
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

    // Le capitaine ne peut créer que des amicaux/entraînements de son équipe.
    if (user && user.roleUser !== 'admin') {
      if (type === 'official')
        throw new ForbiddenException(
          "Seul l'administrateur peut planifier une rencontre officielle.",
        );
      const capA = await this.isCaptain(data.teamAId, user.id);
      const capB = await this.isCaptain(data.teamBId, user.id);
      if (!capA && !capB)
        throw new ForbiddenException("Réservé au capitaine de l'équipe.");
    }

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

  async updateMatch(id: string, data: any, user?: any) {
    const raw = await this.prisma.esportMatch.findUnique({ where: { id } });
    if (!raw) throw new NotFoundException('Match introuvable.');
    await this.assertMatchManager(raw, user);
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

  async setMatchResult(id: string, data: any, user?: any) {
    const m = await this.prisma.esportMatch.findUnique({ where: { id } });
    if (!m) throw new NotFoundException('Match introuvable.');
    await this.assertMatchManager(m, user);
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

  async deleteMatch(id: string, user?: any) {
    const raw = await this.prisma.esportMatch.findUnique({ where: { id } });
    if (!raw) throw new NotFoundException('Match introuvable.');
    await this.assertMatchManager(raw, user);
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

  // ----- Join requests (recrutement, validé par le capitaine) -----

  private async isCaptain(teamId: string, userId: string) {
    const cap = await this.prisma.esportTeamMember.findFirst({
      where: { teamId, userId, isCaptain: true },
    });
    return !!cap;
  }

  async requestJoin(userId: string, teamId: string, data: any) {
    const team = await this.prisma.esportTeam.findUnique({ where: { id: teamId } });
    if (!team) throw new NotFoundException('Équipe introuvable.');
    const member = await this.prisma.esportTeamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    if (member) throw new ConflictException('Vous êtes déjà membre de cette équipe.');
    const pending = await this.prisma.esportJoinRequest.findFirst({
      where: { teamId, userId, status: 'pending' },
    });
    if (pending)
      throw new ConflictException('Vous avez déjà une demande en attente pour cette équipe.');
    const role = assertRole(data?.role);

    const req = await this.prisma.esportJoinRequest.create({
      data: { teamId, userId, role, message: data?.message?.trim() || null },
    });

    const captain = await this.prisma.esportTeamMember.findFirst({
      where: { teamId, isCaptain: true },
    });
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const who = user ? serializeUserCard(user).displayName || user.username : 'Un joueur';
    if (captain) {
      await this.community.notifyUser(captain.userId, {
        type: 'join_request',
        title: 'Nouvelle demande de recrutement',
        message: `${who} souhaite rejoindre « ${team.name} ».`,
        link: `/teams/${teamId}`,
      });
    }
    return req;
  }

  async myJoinRequests(userId: string) {
    return this.prisma.esportJoinRequest.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listJoinRequests(teamId: string, user: any) {
    const allowed =
      user?.roleUser === 'admin' || (await this.isCaptain(teamId, user.id));
    if (!allowed)
      throw new ForbiddenException('Réservé au capitaine de l’équipe.');
    const reqs = await this.prisma.esportJoinRequest.findMany({
      where: { teamId, status: 'pending' },
      orderBy: { createdAt: 'asc' },
    });
    const users = await this.prisma.user.findMany({
      where: { id: { in: reqs.map((r) => r.userId) } },
    });
    const umap = new Map(users.map((u) => [u.id, serializeUserCard(u)]));
    return reqs.map((r) => ({ ...r, user: umap.get(r.userId) ?? null }));
  }

  async decideJoinRequest(id: string, user: any, data: any) {
    const req = await this.prisma.esportJoinRequest.findUnique({ where: { id } });
    if (!req) throw new NotFoundException('Demande introuvable.');
    const team = await this.prisma.esportTeam.findUnique({ where: { id: req.teamId } });
    if (!team) throw new NotFoundException('Équipe introuvable.');
    const allowed =
      user?.roleUser === 'admin' || (await this.isCaptain(req.teamId, user.id));
    if (!allowed)
      throw new ForbiddenException('Réservé au capitaine de l’équipe.');

    const status = data?.status === 'accepted' ? 'accepted' : 'rejected';

    if (status === 'accepted') {
      const already = await this.prisma.esportTeamMember.findUnique({
        where: { teamId_userId: { teamId: req.teamId, userId: req.userId } },
      });
      if (!already) {
        const role = data?.role !== undefined ? assertRole(data.role) : req.role ?? null;
        await this.prisma.esportTeamMember.create({
          data: { teamId: req.teamId, userId: req.userId, role },
        });
      }
    }

    await this.prisma.esportJoinRequest.update({ where: { id }, data: { status } });
    await this.community.notifyUser(req.userId, {
      type: 'join_decision',
      title:
        status === 'accepted'
          ? 'Vous avez rejoint une équipe'
          : 'Demande de recrutement refusée',
      message: `Équipe « ${team.name} ».`,
      link: `/teams/${req.teamId}`,
    });
    return { ok: true, status };
  }
}
