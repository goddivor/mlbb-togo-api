import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { serializeUserCard } from '../users/users.service';
import { ESPORT_ROLES } from '../esport/esport.service';
import { CommunityService } from '../community/community.service';

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

  private async assertManager(teamId: string, user: any) {
    if (user?.roleUser === 'admin') return;
    if (user?.id && (await this.isCaptain(teamId, user.id))) return;
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

  private async teamMap(ids: string[]) {
    const teams = await this.prisma.esportTeam.findMany({
      where: { id: { in: Array.from(new Set(ids)) } },
      select: { id: true, name: true, image: true, type: true },
    });
    return new Map(teams.map((t) => [t.id, t]));
  }

  // ----- Public: open campaigns -----

  async listOpen(role?: string) {
    const where: any = { status: 'open' };
    if (role && (ESPORT_ROLES as readonly string[]).includes(role))
      where.slots = { some: { role } };
    const recs = await this.prisma.recruitment.findMany({
      where,
      orderBy: { openedAt: 'desc' },
    });
    const tmap = await this.teamMap(recs.map((r) => r.teamId));
    return recs.map((r) => ({
      id: r.id,
      teamId: r.teamId,
      message: r.message,
      slots: r.slots,
      openedAt: r.openedAt,
      status: r.status,
      team: tmap.get(r.teamId) ?? null,
    }));
  }

  async myApplications(userId: string) {
    const apps = await this.prisma.recruitmentApplication.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    const tmap = await this.teamMap(apps.map((a) => a.teamId));
    return apps.map((a) => ({ ...a, team: tmap.get(a.teamId) ?? null }));
  }

  // ----- A team's campaigns (captain sees everything + applications) -----

  async listByTeam(teamId: string, user: any) {
    const manager =
      user?.roleUser === 'admin' || (user?.id && (await this.isCaptain(teamId, user.id)));
    const recs = await this.prisma.recruitment.findMany({
      where: manager ? { teamId } : { teamId, status: 'open' },
      orderBy: { openedAt: 'desc' },
    });
    if (!manager)
      return recs.map((r) => ({ ...r, applications: [], applicationCount: 0 }));

    const apps = await this.prisma.recruitmentApplication.findMany({
      where: { recruitmentId: { in: recs.map((r) => r.id) }, status: 'pending' },
      orderBy: { createdAt: 'asc' },
    });
    const umap = await this.userCards(apps.map((a) => a.userId));
    const byRec = new Map<string, any[]>();
    for (const a of apps) {
      const arr = byRec.get(a.recruitmentId) ?? [];
      arr.push({ ...a, user: umap.get(a.userId) ?? null });
      byRec.set(a.recruitmentId, arr);
    }
    return recs.map((r) => ({
      ...r,
      applications: byRec.get(r.id) ?? [],
      applicationCount: (byRec.get(r.id) ?? []).length,
    }));
  }

  private async userCards(ids: string[]) {
    const users = await this.prisma.user.findMany({
      where: { id: { in: Array.from(new Set(ids)) } },
    });
    return new Map(users.map((u) => [u.id, serializeUserCard(u)]));
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

  async apply(user: any, recruitmentId: string, data: any) {
    const rec = await this.prisma.recruitment.findUnique({ where: { id: recruitmentId } });
    if (!rec) throw new NotFoundException('Campagne introuvable.');
    if (rec.status !== 'open')
      throw new ConflictException('Cette campagne est fermée.');
    const member = await this.prisma.esportTeamMember.findUnique({
      where: { teamId_userId: { teamId: rec.teamId, userId: user.id } },
    });
    if (member) throw new ConflictException('Vous êtes déjà membre de cette équipe.');
    const existing = await this.prisma.recruitmentApplication.findFirst({
      where: { recruitmentId, userId: user.id, status: 'pending' },
    });
    if (existing) throw new ConflictException('Vous avez déjà postulé.');
    let role: string | null = null;
    if (data?.role) {
      role = String(data.role).toLowerCase();
      if (!rec.slots.some((s) => s.role === role))
        throw new BadRequestException("Ce poste n'est pas ouvert au recrutement.");
    }
    await this.prisma.recruitmentApplication.create({
      data: {
        recruitmentId,
        teamId: rec.teamId,
        userId: user.id,
        role,
        message: data?.message?.trim() || null,
      },
    });
    const me = await this.prisma.user.findUnique({ where: { id: user.id } });
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

  async listApplications(recruitmentId: string, user: any) {
    const rec = await this.prisma.recruitment.findUnique({ where: { id: recruitmentId } });
    if (!rec) throw new NotFoundException('Campagne introuvable.');
    await this.assertManager(rec.teamId, user);
    const apps = await this.prisma.recruitmentApplication.findMany({
      where: { recruitmentId, status: 'pending' },
      orderBy: { createdAt: 'asc' },
    });
    const umap = await this.userCards(apps.map((a) => a.userId));
    return apps.map((a) => ({ ...a, user: umap.get(a.userId) ?? null }));
  }

  async decideApplication(appId: string, user: any, data: any) {
    const app = await this.prisma.recruitmentApplication.findUnique({ where: { id: appId } });
    if (!app) throw new NotFoundException('Candidature introuvable.');
    await this.assertManager(app.teamId, user);
    const status = data?.status === 'accepted' ? 'accepted' : 'rejected';

    if (status === 'accepted') {
      const already = await this.prisma.esportTeamMember.findUnique({
        where: { teamId_userId: { teamId: app.teamId, userId: app.userId } },
      });
      if (!already) {
        await this.prisma.esportTeamMember.create({
          data: { teamId: app.teamId, userId: app.userId, role: app.role ?? null },
        });
      }
    }
    await this.prisma.recruitmentApplication.update({
      where: { id: appId },
      data: { status },
    });
    const team = await this.prisma.esportTeam.findUnique({ where: { id: app.teamId } });
    await this.community.notifyUser(app.userId, {
      type: 'recruitment_decision',
      title:
        status === 'accepted' ? 'Candidature acceptée' : 'Candidature refusée',
      message: `Équipe « ${team?.name ?? ''} ».`,
      link: `/teams/${app.teamId}`,
      data: { status, teamName: team?.name ?? '' },
    });
    return { ok: true, status };
  }
}
