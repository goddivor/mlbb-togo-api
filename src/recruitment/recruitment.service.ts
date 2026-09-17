import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  decodeRank,
  serializePublicUser,
  serializeUserCard,
} from '../users/users.service';
import { ESPORT_ROLES } from '../esport/esport.service';
import { CommunityService } from '../community/community.service';
import {
  ACTIVE_STATUSES,
  APPLICATION_TRANSITIONS,
  ApplicationStatus,
  CANDIDATE_STATUSES,
  MANAGER_STATUSES,
  MAX_RANK_LEVEL,
  isAvailability,
} from './recruitment.constants';
import { ListCampaignsQueryDto } from './dto/list-campaigns-query.dto';
import { ListApplicationsQueryDto } from './dto/list-applications-query.dto';
import { UpdateApplicationStatusDto } from './dto/update-application-status.dto';
import { ApplyRecruitmentDto } from './dto/apply-recruitment.dto';

@Injectable()
export class RecruitmentService {
  constructor(
    private prisma: PrismaService,
    private community: CommunityService,
  ) {}

  private async isCaptain(teamId: string, userId: string) {
    const cap = await this.prisma.esportTeamMember.findFirst({
      where: { teamId, userId, isCaptain: true },
    });
    return !!cap;
  }

  /** Team owner (captain) or platform staff. */
  private async isManager(teamId: string, user: any) {
    if (user?.roleUser === 'admin') return true;
    if (user?.id && (await this.isCaptain(teamId, user.id))) return true;
    return false;
  }

  private async assertManager(teamId: string, user: any) {
    if (await this.isManager(teamId, user)) return;
    throw new ForbiddenException("Réservé au capitaine de l'équipe.");
  }

  private normalizeSlots(slots: any): { role: string; quantity: number }[] {
    if (!Array.isArray(slots)) return [];
    const seen = new Set<string>();
    const out: { role: string; quantity: number }[] = [];
    for (const s of slots) {
      const role = String(s?.role || '').toLowerCase();
      if (!(ESPORT_ROLES as readonly string[]).includes(role) || seen.has(role)) continue;
      seen.add(role);
      const quantity = Math.max(1, Math.min(20, parseInt(s?.quantity, 10) || 1));
      out.push({ role, quantity });
    }
    return out;
  }

  /** A campaign requirement: a rank level inside the ladder bounds, or null. */
  private normalizeRankLevel(value: any): number | null {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(MAX_RANK_LEVEL, Math.trunc(n)));
  }

  private async teamMap(ids: string[]) {
    const teams = await this.prisma.esportTeam.findMany({
      where: { id: { in: Array.from(new Set(ids)) } },
      select: { id: true, name: true, image: true, type: true },
    });
    return new Map(teams.map((t) => [t.id, t]));
  }

  private serializeCampaign(rec: any, team: any) {
    return {
      id: rec.id,
      teamId: rec.teamId,
      message: rec.message,
      slots: rec.slots,
      minRankLevel: rec.minRankLevel ?? null,
      minRankLabel: decodeRank(rec.minRankLevel),
      availability: rec.availability ?? null,
      openedAt: rec.openedAt,
      closedAt: rec.closedAt ?? null,
      status: rec.status,
      team: team ?? null,
    };
  }

  // ----- Public: campaigns -----

  /**
   * Public campaign board with the advanced filters (lane, rank, availability).
   * Everything that can be pushed down to Mongo is pushed down; nothing here
   * reads a User row, so no PII can escape.
   */
  async listOpen(query: ListCampaignsQueryDto = {}) {
    const where: Record<string, any> = {};
    const status = query.status ?? 'open';
    if (status !== 'all') where.status = status;
    if (query.role) where.slots = { some: { role: query.role } };

    // Composed through AND so the two "or no requirement at all" clauses do not
    // overwrite each other.
    const and: any[] = [];
    if (query.availability) {
      and.push({
        OR: [{ availability: query.availability }, { availability: null }],
      });
    }
    if (query.rankLevel !== undefined) {
      and.push({
        OR: [{ minRankLevel: null }, { minRankLevel: { lte: query.rankLevel } }],
      });
    }
    if (and.length) where.AND = and;

    const recs = await this.prisma.recruitment.findMany({
      where,
      orderBy: { openedAt: 'desc' },
      ...(query.limit ? { take: query.limit } : {}),
    });
    const tmap = await this.teamMap(recs.map((r) => r.teamId));
    return recs.map((r) => this.serializeCampaign(r, tmap.get(r.teamId)));
  }

  /** The signed-in player's own applications, with their campaign context. */
  async myApplications(userId: string, query: ListApplicationsQueryDto = {}) {
    const where: Record<string, any> = { userId };
    this.applyStatusFilter(where, query.status);
    if (query.role) where.role = query.role;

    const apps = await this.prisma.recruitmentApplication.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      ...(query.limit ? { take: query.limit } : {}),
    });
    const tmap = await this.teamMap(apps.map((a) => a.teamId));
    const recs = await this.prisma.recruitment.findMany({
      where: { id: { in: [...new Set(apps.map((a) => a.recruitmentId))] } },
    });
    const rmap = new Map(recs.map((r) => [r.id, r]));

    return apps.map((a) => {
      const rec = rmap.get(a.recruitmentId);
      return {
        ...a,
        team: tmap.get(a.teamId) ?? null,
        recruitment: rec
          ? {
              id: rec.id,
              status: rec.status,
              slots: rec.slots,
              message: rec.message,
            }
          : null,
        // The UI does not have to replay the transition table.
        canWithdraw: (
          APPLICATION_TRANSITIONS[a.status as ApplicationStatus] ?? []
        ).includes('withdrawn'),
      };
    });
  }

  private applyStatusFilter(
    where: Record<string, any>,
    status?: ApplicationStatus | 'active' | 'all',
  ) {
    const wanted = status ?? 'active';
    if (wanted === 'all') return;
    if (wanted === 'active') {
      where.status = { in: [...ACTIVE_STATUSES] };
      return;
    }
    where.status = wanted;
  }

  // ----- A team's campaigns (captain sees everything + applications) -----

  async listByTeam(teamId: string, user: any, query: ListApplicationsQueryDto = {}) {
    const manager = await this.isManager(teamId, user);
    const recs = await this.prisma.recruitment.findMany({
      where: manager ? { teamId } : { teamId, status: 'open' },
      orderBy: { openedAt: 'desc' },
    });
    if (!manager)
      return recs.map((r) => ({ ...r, applications: [], applicationCount: 0 }));

    const where: Record<string, any> = {
      recruitmentId: { in: recs.map((r) => r.id) },
    };
    this.applyStatusFilter(where, query.status);
    this.applyCandidateFilters(where, query);

    const apps = await this.prisma.recruitmentApplication.findMany({
      where,
      orderBy: { createdAt: 'asc' },
    });
    const umap = await this.userProfiles(apps.map((a) => a.userId));
    const byRec = new Map<string, any[]>();
    for (const a of apps) {
      const arr = byRec.get(a.recruitmentId) ?? [];
      arr.push(this.serializeApplication(a, umap.get(a.userId)));
      byRec.set(a.recruitmentId, arr);
    }
    return recs.map((r) => ({
      ...r,
      minRankLabel: decodeRank(r.minRankLevel),
      applications: byRec.get(r.id) ?? [],
      applicationCount: (byRec.get(r.id) ?? []).length,
    }));
  }

  /** Candidate-side filters shared by every application listing. */
  private applyCandidateFilters(
    where: Record<string, any>,
    query: ListApplicationsQueryDto,
  ) {
    if (query.role) where.role = query.role;
    if (query.availability) where.availability = query.availability;
    if (query.minRankLevel !== undefined)
      where.rankLevel = { gte: query.minRankLevel };
  }

  /**
   * Enriched candidate profiles. The recruiter needs the game stats to judge an
   * application, so this uses the public profile serializer (rank, win rate,
   * favourite heroes...) rather than the raw User row: password, email and
   * mlbbToken are stripped there once and for all.
   */
  private async userProfiles(ids: string[]) {
    const users = await this.prisma.user.findMany({
      where: { id: { in: Array.from(new Set(ids)) } },
    });
    return new Map(users.map((u) => [u.id, serializePublicUser(u)]));
  }

  private serializeApplication(app: any, user: any) {
    return {
      ...app,
      rankLabel: decodeRank(app.rankLevel),
      user: user ?? null,
    };
  }

  // ----- Management (captain/admin) -----

  async create(user: any, data: any) {
    if (!data?.teamId) throw new BadRequestException('teamId requis.');
    await this.assertManager(data.teamId, user);
    const slots = this.normalizeSlots(data.slots);
    if (slots.length === 0)
      throw new BadRequestException('Au moins un poste recherché est requis.');
    return this.prisma.recruitment.create({
      data: {
        teamId: data.teamId,
        createdById: user.id,
        message: data.message?.trim() || null,
        slots,
        minRankLevel: this.normalizeRankLevel(data.minRankLevel),
        availability: isAvailability(data.availability) ? data.availability : null,
        status: 'open',
      },
    });
  }

  async update(id: string, user: any, data: any) {
    const rec = await this.prisma.recruitment.findUnique({ where: { id } });
    if (!rec) throw new NotFoundException('Campagne introuvable.');
    await this.assertManager(rec.teamId, user);
    const patch: any = {};
    if (data.message !== undefined) patch.message = data.message?.trim() || null;
    if (data.slots !== undefined) patch.slots = this.normalizeSlots(data.slots);
    if (data.minRankLevel !== undefined)
      patch.minRankLevel = this.normalizeRankLevel(data.minRankLevel);
    if (data.availability !== undefined)
      patch.availability = isAvailability(data.availability)
        ? data.availability
        : null;
    if (data.status === 'open' || data.status === 'closed') {
      patch.status = data.status;
      patch.closedAt = data.status === 'closed' ? new Date() : null;
    }
    return this.prisma.recruitment.update({ where: { id }, data: patch });
  }

  async remove(id: string, user: any) {
    const rec = await this.prisma.recruitment.findUnique({ where: { id } });
    if (!rec) throw new NotFoundException('Campagne introuvable.');
    await this.assertManager(rec.teamId, user);
    await this.prisma.recruitmentApplication.deleteMany({ where: { recruitmentId: id } });
    await this.prisma.recruitment.delete({ where: { id } });
    return { ok: true };
  }

  // ----- Applications -----

  async apply(user: any, recruitmentId: string, data: ApplyRecruitmentDto = {}) {
    const rec = await this.prisma.recruitment.findUnique({ where: { id: recruitmentId } });
    if (!rec) throw new NotFoundException('Campagne introuvable.');
    if (rec.status !== 'open')
      throw new ConflictException('Cette campagne est fermée.');
    const member = await this.prisma.esportTeamMember.findUnique({
      where: { teamId_userId: { teamId: rec.teamId, userId: user.id } },
    });
    if (member) throw new ConflictException('Vous êtes déjà membre de cette équipe.');
    // Only an application still in the pipeline blocks a new one: a candidate
    // who withdrew or was turned down may try again later.
    const existing = await this.prisma.recruitmentApplication.findFirst({
      where: { recruitmentId, userId: user.id, status: { in: [...ACTIVE_STATUSES] } },
    });
    if (existing) throw new ConflictException('Vous avez déjà postulé.');
    let role: string | null = null;
    if (data?.role) {
      role = String(data.role).toLowerCase();
      if (!rec.slots.some((s) => s.role === role))
        throw new BadRequestException("Ce poste n'est pas ouvert au recrutement.");
    }

    const me = await this.prisma.user.findUnique({ where: { id: user.id } });
    if (
      rec.minRankLevel != null &&
      (me?.gameRankLevel ?? 0) < rec.minRankLevel
    ) {
      throw new ConflictException(
        `Cette campagne demande au moins le rang ${decodeRank(rec.minRankLevel)}.`,
      );
    }

    await this.prisma.recruitmentApplication.create({
      data: {
        recruitmentId,
        teamId: rec.teamId,
        userId: user.id,
        role,
        message: data?.message?.trim() || null,
        availability: isAvailability(data?.availability) ? data.availability : null,
        // Snapshot: the recruiter filters on the rank the player had when they
        // applied, so a shortlist stays stable between two visits.
        rankLevel: me?.gameRankLevel ?? null,
      },
    });
    const who = me ? serializeUserCard(me).displayName || me.username : 'Un joueur';
    await this.community.notifyUser(rec.createdById, {
      type: 'recruitment_application',
      title: 'Nouvelle candidature',
      message: `${who} a postulé à votre recrutement.`,
      link: `/teams/${rec.teamId}`,
      data: { who },
    });
    return { ok: true };
  }

  async listApplications(
    recruitmentId: string,
    user: any,
    query: ListApplicationsQueryDto = {},
  ) {
    const rec = await this.prisma.recruitment.findUnique({ where: { id: recruitmentId } });
    if (!rec) throw new NotFoundException('Campagne introuvable.');
    await this.assertManager(rec.teamId, user);

    const where: Record<string, any> = { recruitmentId };
    this.applyStatusFilter(where, query.status);
    this.applyCandidateFilters(where, query);

    const apps = await this.prisma.recruitmentApplication.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      ...(query.limit ? { take: query.limit } : {}),
    });
    const umap = await this.userProfiles(apps.map((a) => a.userId));
    return apps.map((a) => this.serializeApplication(a, umap.get(a.userId)));
  }

  /** Every application of a team, across its campaigns (recruiter tracking). */
  async listTeamApplications(
    teamId: string,
    user: any,
    query: ListApplicationsQueryDto = {},
  ) {
    await this.assertManager(teamId, user);

    const where: Record<string, any> = { teamId };
    this.applyStatusFilter(where, query.status);
    this.applyCandidateFilters(where, query);

    const apps = await this.prisma.recruitmentApplication.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      ...(query.limit ? { take: query.limit } : {}),
    });
    const umap = await this.userProfiles(apps.map((a) => a.userId));
    return apps.map((a) => this.serializeApplication(a, umap.get(a.userId)));
  }

  /**
   * Single entry point of the application life cycle.
   *
   * Authorisation is checked *before* the transition table so that a stranger
   * always gets a 403 and never learns, through a 409, what state somebody
   * else's application is in.
   */
  async updateApplicationStatus(
    appId: string,
    user: any,
    dto: UpdateApplicationStatusDto,
  ) {
    const app = await this.prisma.recruitmentApplication.findUnique({
      where: { id: appId },
    });
    if (!app) throw new NotFoundException('Candidature introuvable.');

    const target = dto.status;
    const current = app.status as ApplicationStatus;

    if (CANDIDATE_STATUSES.includes(target)) {
      // Withdrawing is personal: not even the captain nor an admin may withdraw
      // somebody else's application.
      if (app.userId !== user?.id)
        throw new ForbiddenException(
          'Seul le candidat peut retirer sa candidature.',
        );
    } else if (MANAGER_STATUSES.includes(target)) {
      await this.assertManager(app.teamId, user);
    } else {
      throw new BadRequestException('Statut non pilotable.');
    }

    if (!(APPLICATION_TRANSITIONS[current] ?? []).includes(target)) {
      throw new ConflictException(
        `Transition « ${current} » vers « ${target} » impossible.`,
      );
    }

    if (target === 'accepted') {
      const already = await this.prisma.esportTeamMember.findUnique({
        where: { teamId_userId: { teamId: app.teamId, userId: app.userId } },
      });
      if (!already) {
        await this.prisma.esportTeamMember.create({
          data: { teamId: app.teamId, userId: app.userId, role: app.role ?? null },
        });
      }
    }

    const updated = await this.prisma.recruitmentApplication.update({
      where: { id: appId },
      data: {
        status: target,
        decidedById: user?.id ?? null,
        decidedAt: new Date(),
        decisionNote: dto.note?.trim() || null,
      },
    });

    await this.notifyStatusChange(app, target, dto.note);
    return { ok: true, status: target, application: updated };
  }

  /**
   * One notification per status change, reusing the two recruitment types the
   * notification module already knows (and already maps to the "teams"
   * preference). A brand-new type would bypass that preference.
   */
  private async notifyStatusChange(
    app: { teamId: string; userId: string; recruitmentId: string },
    status: ApplicationStatus,
    note?: string,
  ) {
    const team = await this.prisma.esportTeam.findUnique({
      where: { id: app.teamId },
    });
    const teamName = team?.name ?? '';

    if (status === 'withdrawn') {
      const rec = await this.prisma.recruitment.findUnique({
        where: { id: app.recruitmentId },
      });
      if (!rec) return;
      const me = await this.prisma.user.findUnique({ where: { id: app.userId } });
      const who = me ? serializeUserCard(me).displayName || me.username : 'Un joueur';
      await this.community.notifyUser(rec.createdById, {
        type: 'recruitment_application',
        title: 'Candidature retirée',
        message: `${who} a retiré sa candidature.`,
        link: `/teams/${app.teamId}`,
        data: { who, status },
      });
      return;
    }

    const titles: Record<string, string> = {
      shortlisted: 'Candidature présélectionnée',
      accepted: 'Candidature acceptée',
      rejected: 'Candidature refusée',
    };
    await this.community.notifyUser(app.userId, {
      type: 'recruitment_decision',
      title: titles[status] ?? 'Candidature mise à jour',
      message: note?.trim()
        ? `Équipe « ${teamName} » : ${note.trim()}`
        : `Équipe « ${teamName} ».`,
      link: `/teams/${app.teamId}`,
      data: { status, teamName, note: note?.trim() || null },
    });
  }
}
