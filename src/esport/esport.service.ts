import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { normalizeSponsorInput, serializeSponsor } from '../sponsors/sponsors.logic';
import { PrismaService } from '../prisma/prisma.service';
import { serializeUserCard } from '../users/users.service';
import { PlayerStatsService } from '../stats/player-stats.service';
import { GamificationService } from '../gamification/gamification.service';
import { kdaOf } from '../stats/player-stats.util';
import { normalizeFiguresInput, parseFigures } from './esport-figures';
import { EsportSeasonsService, resolveStatus } from './esport-seasons.service';
import {
  MATCH_STAGES,
  MatchGame,
  assertResultMatchesGames,
  groupByDay,
  isFormat,
  isStage,
  normalizeGames,
  normalizeScreenshots,
  normalizeUrl,
  parseGames,
  parseScreenshots,
  resolveStage,
  scoreFromGames,
  serializeGames,
  stageFromType,
  typeFromStage,
} from './esport-match-details';

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
    esportId: team.esportId ?? null,
    sort: team.sort ?? 0,
    city: team.city ?? null,
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
    private playerStats: PlayerStatsService,
    private seasons: EsportSeasonsService,
    @Optional() private gamification?: GamificationService,
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
    const rows = await this.prisma.sponsor.findMany({ orderBy: { sort: 'asc' } });
    return rows.map(serializeSponsor);
  }

  /** Public target figures (About page), defaults when no organisation exists. */
  async getFigures() {
    const org = await this.prisma.esport.findFirst({
      select: { id: true, figures: true, updatedAt: true },
    });
    return {
      orgId: org?.id ?? null,
      updatedAt: org?.updatedAt ?? null,
      ...parseFigures(org?.figures),
    };
  }

  async updateFigures(data: unknown) {
    const id = await this.resolveOrgId();
    const figures = normalizeFiguresInput(data);
    const org = await this.prisma.esport.update({
      where: { id },
      data: { figures },
      select: { id: true, figures: true, updatedAt: true },
    });
    return { orgId: org.id, updatedAt: org.updatedAt, ...parseFigures(org.figures) };
  }

  async getMtl() {
    return this.prisma.mtl.findFirst({
      include: { images: { orderBy: { sort: 'asc' } } },
    });
  }

  // ----- Admin: organization -----

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

  // ----- Admin: teams -----

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
        sort: typeof data.sort === 'number' ? data.sort : 0,
        esportId,
        city: typeof data.city === 'string' && data.city.trim() ? data.city.trim() : null,
      },
    });

    // Created from a player request: we link the request and
    // designate the requester as captain.
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
        sort: typeof data.sort === 'number' ? data.sort : undefined,
        city:
          data.city === undefined
            ? undefined
            : typeof data.city === 'string' && data.city.trim()
              ? data.city.trim()
              : null,
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

  // ----- Admin: members -----

  // Admin, or captain of the team concerned.
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

    // Only the admin can change the captain status.
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
    // The captain cannot remove himself (the captain).
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
    const input = normalizeSponsorInput(data, false);
    const row = await this.prisma.sponsor.create({
      data: {
        name: input.name ?? null,
        logo: input.logo!,
        url: input.url ?? null,
        sort: input.sort ?? 0,
        tier: input.tier ?? null,
        description: input.description ?? null,
        seasonIds: input.seasonIds ?? [],
        isActive: input.isActive ?? true,
      },
    });
    return serializeSponsor(row);
  }

  async updateSponsor(id: string, data: any) {
    const sponsor = await this.prisma.sponsor.findUnique({ where: { id } });
    if (!sponsor) throw new NotFoundException('Sponsor introuvable.');
    const input = normalizeSponsorInput(data, true);
    const row = await this.prisma.sponsor.update({ where: { id }, data: input });
    return serializeSponsor(row);
  }

  async deleteSponsor(id: string) {
    const sponsor = await this.prisma.sponsor.findUnique({ where: { id } });
    if (!sponsor) throw new NotFoundException('Sponsor introuvable.');
    await this.prisma.sponsor.delete({ where: { id } });
    return { ok: true };
  }

  // ----- Seasons (lifecycle lives in EsportSeasonsService) -----

  async listSeasons() {
    return this.seasons.list();
  }

  /** Raw season lookup used by match creation (404 when unknown). */
  async getSeason(id: string) {
    return this.seasons.findRaw(id);
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

  /** User cards (id -> card) for the MVP avatars. */
  private async userCardMap(ids: string[]) {
    const uniq = Array.from(new Set(ids.filter(Boolean)));
    const users = uniq.length
      ? await this.prisma.user.findMany({ where: { id: { in: uniq } } })
      : [];
    return new Map(users.map((u) => [u.id, serializeUserCard(u)]));
  }

  private serializeMatch(m: any, tmap: Map<string, any>, umap?: Map<string, any>) {
    const games = parseGames(m.games);
    const screenshots = parseScreenshots(m.screenshots);
    return {
      id: m.id,
      seasonId: m.seasonId ?? null,
      type: m.type,
      stage: resolveStage(m),
      format: isFormat(m.format) ? m.format : null,
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
      games: games.map((g) => ({ ...g, mvp: g.mvpUserId ? umap?.get(g.mvpUserId) ?? null : null })),
      gamesCount: games.length,
      screenshots,
      screenshotsCount: screenshots.length,
      vodUrl: m.vodUrl ?? null,
      streamUrl: m.streamUrl ?? null,
      mvpUserId: m.mvpUserId ?? null,
      mvp: m.mvpUserId ? umap?.get(m.mvpUserId) ?? null : null,
    };
  }

  /** Mongo filter for a stage, honouring legacy rows without `stage`. */
  private stageWhere(stage: string) {
    if (stage === 'playoff') return { stage: 'playoff' };
    const legacyTypes = MATCH_TYPES.filter((t) => stageFromType(t) === stage);
    // MongoDB: `null` only matches an explicit null, rows created before the
    // column existed have no `stage` key at all (`isSet: false`).
    return {
      OR: [
        { stage },
        { stage: null, type: { in: legacyTypes } },
        { stage: { isSet: false }, type: { in: legacyTypes } },
      ],
    };
  }

  private buildMatchWhere(filter: {
    seasonId?: string;
    teamId?: string;
    status?: string;
    stage?: string;
    from?: string;
    to?: string;
  }) {
    const and: any[] = [];
    if (filter.seasonId) and.push({ seasonId: filter.seasonId });
    if (filter.status) and.push({ status: filter.status });
    if (filter.teamId) and.push({ OR: [{ teamAId: filter.teamId }, { teamBId: filter.teamId }] });
    if (filter.stage) {
      if (!isStage(filter.stage))
        throw new BadRequestException(`Étape invalide. Valeurs : ${MATCH_STAGES.join(', ')}.`);
      and.push(this.stageWhere(filter.stage));
    }
    const range: any = {};
    if (filter.from) {
      const d = new Date(filter.from);
      if (isNaN(d.getTime())) throw new BadRequestException('Date « from » invalide.');
      range.gte = d;
    }
    if (filter.to) {
      const d = new Date(filter.to);
      if (isNaN(d.getTime())) throw new BadRequestException('Date « to » invalide.');
      range.lte = d;
    }
    if (Object.keys(range).length) and.push({ scheduledAt: range });
    return and.length ? { AND: and } : {};
  }

  private async serializeMatches(matches: any[]) {
    const [tmap, umap] = await Promise.all([
      this.teamMap(
        matches.flatMap((m) => [m.teamAId, m.teamBId, m.winnerTeamId].filter(Boolean) as string[]),
      ),
      this.userCardMap(matches.map((m) => m.mvpUserId).filter(Boolean) as string[]),
    ]);
    return matches.map((m) => this.serializeMatch(m, tmap, umap));
  }

  async listMatches(
    filter: {
      seasonId?: string;
      teamId?: string;
      status?: string;
      stage?: string;
      from?: string;
      to?: string;
    } = {},
  ) {
    const matches = await this.prisma.esportMatch.findMany({
      where: this.buildMatchWhere(filter),
      orderBy: [{ scheduledAt: 'desc' }, { createdAt: 'desc' }],
    });
    return this.serializeMatches(matches);
  }

  /**
   * Calendar view: matches of a period grouped by day (UTC), oldest first.
   * Without `from`/`to` the whole season (or everything) is returned.
   */
  async matchesCalendar(
    filter: { seasonId?: string; teamId?: string; stage?: string; from?: string; to?: string } = {},
  ) {
    const matches = await this.prisma.esportMatch.findMany({
      where: this.buildMatchWhere(filter),
      orderBy: [{ scheduledAt: 'asc' }, { createdAt: 'asc' }],
    });
    const serialized = await this.serializeMatches(matches);
    const { days, undated } = groupByDay(serialized);
    return {
      from: filter.from ?? null,
      to: filter.to ?? null,
      total: serialized.length,
      days,
      undated,
    };
  }

  /** Full match sheet: teams, result, games, screenshots, links, MVP, player stats. */
  async getMatch(id: string) {
    const m = await this.prisma.esportMatch.findUnique({ where: { id } });
    if (!m) throw new NotFoundException('Match introuvable.');
    const games = parseGames(m.games);
    const [tmap, umap, players] = await Promise.all([
      this.teamMap([m.teamAId, m.teamBId, m.winnerTeamId].filter(Boolean) as string[]),
      this.userCardMap(
        [m.mvpUserId, ...games.map((g) => g.mvpUserId)].filter(Boolean) as string[],
      ),
      this.getMatchPlayers(id),
    ]);
    const base = this.serializeMatch(m, tmap, umap);
    const mvpRow = players.players.find((p) => p.userId === base.mvpUserId) ?? null;
    return {
      ...base,
      // Fall back to the per-player MVP flag for matches recorded before the
      // `mvpUserId` column existed.
      mvpUserId: base.mvpUserId ?? players.players.find((p) => p.isMvp)?.userId ?? null,
      mvp: base.mvp ?? (players.players.find((p) => p.isMvp)?.user ?? null),
      mvpStats: mvpRow ?? players.players.find((p) => p.isMvp) ?? null,
      players: { teamA: players.teamA, teamB: players.teamB },
    };
  }

  // Admin, or captain of one of the two teams (except official).
  private async assertMatchManager(match: any, user: any) {
    if (user?.roleUser === 'admin') return;
    if (resolveStage(match) !== 'scrim')
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
    let season: any = null;
    if (data.seasonId) season = await this.getSeason(data.seasonId);

    // The captain can only create friendly/training matches for his team.
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

    // Stage: explicit, else derived from the type (an official match created
    // while the season is in playoffs is a playoff match).
    let stage = isStage(data?.stage) ? data.stage : stageFromType(type);
    if (!isStage(data?.stage) && type === 'official' && season && resolveStatus(season) === 'playoffs')
      stage = 'playoff';
    if (stage !== 'scrim' && user && user.roleUser !== 'admin')
      throw new ForbiddenException("Seul l'administrateur peut planifier une rencontre officielle.");
    const format = isFormat(data?.format) ? data.format : null;

    await this.prisma.esportMatch.create({
      data: {
        seasonId: data.seasonId ?? null,
        type: stage === 'scrim' ? type : 'official',
        stage,
        format,
        teamAId: data.teamAId,
        teamBId: data.teamBId,
        scheduledAt: data.scheduledAt ? new Date(data.scheduledAt) : null,
        notes: data.notes ?? null,
        streamUrl: normalizeUrl(data?.streamUrl, 'stream'),
        vodUrl: normalizeUrl(data?.vodUrl, 'VOD'),
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
    // Stage and type are kept in sync: an explicit stage wins, otherwise a
    // type change re-derives the stage (legacy clients only send `type`).
    if (data.stage !== undefined) {
      if (!isStage(data.stage))
        throw new BadRequestException(`Étape invalide. Valeurs : ${MATCH_STAGES.join(', ')}.`);
      patch.stage = data.stage;
      patch.type = typeFromStage(data.stage, patch.type ?? raw.type);
    } else if (patch.type && patch.type !== raw.type) {
      patch.stage = stageFromType(patch.type);
    }
    if ((patch.stage ?? resolveStage(raw)) !== 'scrim' && user?.roleUser !== 'admin')
      throw new ForbiddenException("Seul l'administrateur peut gérer une rencontre officielle.");
    if (data.format !== undefined) {
      if (data.format !== null && data.format !== '' && !isFormat(data.format))
        throw new BadRequestException('Format invalide (bo1, bo3, bo5, bo7).');
      patch.format = data.format || null;
    }
    if (data.vodUrl !== undefined) patch.vodUrl = normalizeUrl(data.vodUrl, 'VOD');
    if (data.streamUrl !== undefined) patch.streamUrl = normalizeUrl(data.streamUrl, 'stream');
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
    if (patch.status !== undefined || patch.teamAId || patch.teamBId)
      await this.recomputeMatchParticipants(id);
    return this.getMatch(id);
  }

  /**
   * Result of a match. When `games` are provided the score is derived from
   * them and any explicit score / winner must agree; details (format, MVP,
   * screenshots, links) can be saved in the same call.
   */
  async setMatchResult(id: string, data: any, user?: any) {
    const m = await this.prisma.esportMatch.findUnique({ where: { id } });
    if (!m) throw new NotFoundException('Match introuvable.');
    await this.assertMatchManager(m, user);
    const details = await this.normalizeDetails(m, data ?? {});
    const games: MatchGame[] = details.games ?? parseGames(m.games);

    const given = (v: any) => v !== undefined && v !== null && v !== '';
    let scoreA = given(data?.scoreA) && Number.isFinite(+data.scoreA) ? Math.max(0, +data.scoreA) : 0;
    let scoreB = given(data?.scoreB) && Number.isFinite(+data.scoreB) ? Math.max(0, +data.scoreB) : 0;
    let winnerTeamId: string | null = null;
    if (data?.winnerTeamId) {
      if (data.winnerTeamId !== m.teamAId && data.winnerTeamId !== m.teamBId)
        throw new BadRequestException("Le vainqueur doit être l'une des deux équipes.");
      winnerTeamId = data.winnerTeamId;
    }
    if (games.length) {
      assertResultMatchesGames(games, m, {
        scoreA: given(data?.scoreA) ? scoreA : null,
        scoreB: given(data?.scoreB) ? scoreB : null,
        winnerTeamId,
      });
      const derived = scoreFromGames(games, m);
      scoreA = derived.scoreA;
      scoreB = derived.scoreB;
      winnerTeamId = winnerTeamId ?? derived.winnerTeamId;
    }
    if (!winnerTeamId) {
      if (scoreA > scoreB) winnerTeamId = m.teamAId;
      else if (scoreB > scoreA) winnerTeamId = m.teamBId;
    }

    const { games: newGames, ...rest } = details;
    await this.prisma.esportMatch.update({
      where: { id },
      data: {
        ...rest,
        ...(newGames ? { games: serializeGames(newGames) } : {}),
        scoreA,
        scoreB,
        winnerTeamId,
        status: 'completed',
      },
    });
    await this.syncMvpFlag(id, m, details.mvpUserId);
    // Player counters are derived from completed matches (never incremented),
    // so re-submitting a result can't double count.
    await this.recomputeMatchParticipants(id);
    return this.getMatch(id);
  }

  /**
   * Match sheet details only (admin): format, games, screenshots, VOD /
   * stream links, MVP. The status and score are untouched, but games must
   * stay consistent with an already recorded result.
   */
  async setMatchDetails(id: string, data: any, user?: any) {
    const m = await this.prisma.esportMatch.findUnique({ where: { id } });
    if (!m) throw new NotFoundException('Match introuvable.');
    await this.assertMatchManager(m, user);
    const details = await this.normalizeDetails(m, data ?? {});
    if (details.games && m.status === 'completed')
      assertResultMatchesGames(details.games, m, {
        scoreA: m.scoreA,
        scoreB: m.scoreB,
        winnerTeamId: m.winnerTeamId,
      });
    const { games, ...rest } = details;
    await this.prisma.esportMatch.update({
      where: { id },
      data: { ...rest, ...(games ? { games: serializeGames(games) } : {}) },
    });
    await this.syncMvpFlag(id, m, details.mvpUserId);
    return this.getMatch(id);
  }

  /**
   * Validate the optional detail fields of a payload. Only the keys present
   * in `data` are returned so callers can PATCH partially. `games` is
   * validated against the (new or stored) format.
   */
  private async normalizeDetails(m: any, data: any) {
    const out: {
      format?: string | null;
      games?: MatchGame[];
      screenshots?: string | null;
      vodUrl?: string | null;
      streamUrl?: string | null;
      mvpUserId?: string | null;
    } = {};
    if (data.format !== undefined) {
      if (data.format !== null && data.format !== '' && !isFormat(data.format))
        throw new BadRequestException('Format invalide (bo1, bo3, bo5, bo7).');
      out.format = data.format || null;
    }
    const format = out.format !== undefined ? out.format : m.format;
    if (data.games !== undefined) {
      out.games = normalizeGames(data.games, m, format);
      const mvpIds = out.games.map((g) => g.mvpUserId).filter(Boolean) as string[];
      if (mvpIds.length) await this.assertMatchMvpCandidates(m, mvpIds);
    } else if (out.format !== undefined) {
      // Shrinking the format must not leave more games than allowed.
      const stored = parseGames(m.games);
      if (stored.length) normalizeGames(stored, m, format);
    }
    if (data.screenshots !== undefined) out.screenshots = normalizeScreenshots(data.screenshots);
    if (data.vodUrl !== undefined) out.vodUrl = normalizeUrl(data.vodUrl, 'VOD');
    if (data.streamUrl !== undefined) out.streamUrl = normalizeUrl(data.streamUrl, 'stream');
    if (data.mvpUserId !== undefined) {
      if (data.mvpUserId) {
        if (typeof data.mvpUserId !== 'string')
          throw new BadRequestException('mvpUserId invalide.');
        await this.assertMatchMvpCandidates(m, [data.mvpUserId]);
        out.mvpUserId = data.mvpUserId;
      } else out.mvpUserId = null;
    }
    return out;
  }

  /**
   * An MVP (match or game) must be a player of the match: a member of one of
   * the two rosters, or someone already listed in the match player stats
   * (players who left the team since keep their record).
   */
  private async assertMatchMvpCandidates(m: any, ids: string[]) {
    const uniq = Array.from(new Set(ids));
    await this.assertUsersExist(uniq);
    const [members, stats] = await Promise.all([
      this.prisma.esportTeamMember.findMany({
        where: { teamId: { in: [m.teamAId, m.teamBId] }, userId: { in: uniq } },
        select: { userId: true },
      }),
      this.prisma.esportMatchPlayer.findMany({
        where: { matchId: m.id, userId: { in: uniq } },
        select: { userId: true },
      }),
    ]);
    const allowed = new Set([...members, ...stats].map((r) => r.userId));
    if (uniq.some((id) => !allowed.has(id)))
      throw new BadRequestException("Le MVP doit être un joueur de l'une des deux équipes.");
  }

  private async assertUsersExist(ids: string[]) {
    const uniq = Array.from(new Set(ids));
    const found = await this.prisma.user.findMany({
      where: { id: { in: uniq } },
      select: { id: true },
    });
    if (found.length !== uniq.length) throw new NotFoundException('Joueur introuvable.');
  }

  /** Mirror the match MVP onto the per-player stats rows (single MVP). */
  private async syncMvpFlag(matchId: string, m: any, mvpUserId: string | null | undefined) {
    if (mvpUserId === undefined) return;
    await this.prisma.esportMatchPlayer.updateMany({
      where: { matchId, isMvp: true, ...(mvpUserId ? { userId: { not: mvpUserId } } : {}) },
      data: { isMvp: false },
    });
    if (mvpUserId)
      await this.prisma.esportMatchPlayer.updateMany({
        where: { matchId, userId: mvpUserId },
        data: { isMvp: true },
      });
    const ids = await this.playerStats.participantIds(matchId);
    if (ids.length) await this.playerStats.recomputeUsers(ids);
  }

  async deleteMatch(id: string, user?: any) {
    const raw = await this.prisma.esportMatch.findUnique({ where: { id } });
    if (!raw) throw new NotFoundException('Match introuvable.');
    await this.assertMatchManager(raw, user);
    const participants = await this.playerStats.participantIds(id);
    await this.prisma.esportMatchPlayer.deleteMany({ where: { matchId: id } });
    await this.prisma.esportMatch.delete({ where: { id } });
    await this.playerStats.recomputeUsers(participants);
    return { ok: true };
  }

  private async recomputeMatchParticipants(matchId: string) {
    const ids = await this.playerStats.participantIds(matchId);
    if (ids.length) await this.playerStats.recomputeUsers(ids);
    // XP grants are keyed by match id, so re-running is harmless.
    void this.gamification?.syncMatch(matchId);
  }

  // ----- Match players (per-player stats) -----

  private serializeMatchPlayer(r: any, umap: Map<string, any>, hmap: Map<string, any>) {
    const hero = r.hero ? hmap.get(r.hero) : null;
    return {
      id: r.id,
      matchId: r.matchId,
      userId: r.userId,
      teamId: r.teamId,
      hero: r.hero ?? null,
      heroId: r.heroId ?? null,
      heroImage: hero?.thumb || hero?.image || null,
      role: r.role ?? null,
      kills: r.kills ?? 0,
      deaths: r.deaths ?? 0,
      assists: r.assists ?? 0,
      kda: kdaOf(r.kills ?? 0, r.deaths ?? 0, r.assists ?? 0),
      gold: r.gold ?? null,
      damage: r.damage ?? null,
      isMvp: !!r.isMvp,
      user: umap.get(r.userId) ?? null,
    };
  }

  async getMatchPlayers(matchId: string) {
    const m = await this.prisma.esportMatch.findUnique({ where: { id: matchId } });
    if (!m) throw new NotFoundException('Match introuvable.');
    const rows = await this.prisma.esportMatchPlayer.findMany({
      where: { matchId },
      orderBy: { createdAt: 'asc' },
    });
    const userIds = Array.from(new Set(rows.map((r) => r.userId)));
    const users = userIds.length
      ? await this.prisma.user.findMany({ where: { id: { in: userIds } } })
      : [];
    const umap = new Map(users.map((u) => [u.id, serializeUserCard(u)]));
    const names = Array.from(new Set(rows.map((r) => r.hero).filter(Boolean) as string[]));
    const heroes = names.length
      ? await this.prisma.hero.findMany({
          where: { name: { in: names } },
          select: { name: true, image: true, thumb: true },
        })
      : [];
    const hmap = new Map(heroes.map((h) => [h.name, h]));
    const players = rows.map((r) => this.serializeMatchPlayer(r, umap, hmap));
    return {
      matchId,
      teamA: players.filter((p) => p.teamId === m.teamAId),
      teamB: players.filter((p) => p.teamId === m.teamBId),
      players,
    };
  }

  /**
   * Replaces the per-player stats of a match. Every entry must reference one
   * of the two teams; at most one MVP per match. Players missing from the
   * payload are removed. User counters are recomputed afterwards.
   */
  async setMatchPlayers(matchId: string, input: any, user?: any) {
    const m = await this.prisma.esportMatch.findUnique({ where: { id: matchId } });
    if (!m) throw new NotFoundException('Match introuvable.');
    await this.assertMatchManager(m, user);
    const list: any[] = Array.isArray(input) ? input : [];
    const entries = list.map((p) => this.normalizePlayerEntry(p, m));

    const seen = new Set<string>();
    for (const e of entries) {
      if (seen.has(e.userId))
        throw new BadRequestException('Un joueur ne peut apparaître qu’une fois.');
      seen.add(e.userId);
    }
    if (entries.filter((e) => e.isMvp).length > 1)
      throw new BadRequestException('Un seul MVP par match.');

    const userIds = entries.map((e) => e.userId);
    if (userIds.length) {
      const found = await this.prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true },
      });
      if (found.length !== userIds.length)
        throw new NotFoundException('Joueur introuvable.');
    }

    const previous = await this.playerStats.participantIds(matchId);
    const keep = new Set(userIds);
    const toRemove = previous.filter((id) => !keep.has(id));
    if (toRemove.length)
      await this.prisma.esportMatchPlayer.deleteMany({
        where: { matchId, userId: { in: toRemove } },
      });
    for (const e of entries) {
      await this.prisma.esportMatchPlayer.upsert({
        where: { matchId_userId: { matchId, userId: e.userId } },
        create: { matchId, ...e },
        update: { ...e },
      });
    }
    // Keep the match-level MVP in sync with the per-player flag.
    const mvp = entries.find((e) => e.isMvp)?.userId ?? null;
    if (mvp || (m.mvpUserId && !keep.has(m.mvpUserId)))
      await this.prisma.esportMatch.update({ where: { id: matchId }, data: { mvpUserId: mvp } });
    await this.playerStats.recomputeUsers([...previous, ...userIds]);
    void this.gamification?.syncMatch(matchId);
    return this.getMatchPlayers(matchId);
  }

  async removeMatchPlayer(matchId: string, userId: string, user?: any) {
    const m = await this.prisma.esportMatch.findUnique({ where: { id: matchId } });
    if (!m) throw new NotFoundException('Match introuvable.');
    await this.assertMatchManager(m, user);
    await this.prisma.esportMatchPlayer.deleteMany({ where: { matchId, userId } });
    if (m.mvpUserId === userId)
      await this.prisma.esportMatch.update({ where: { id: matchId }, data: { mvpUserId: null } });
    await this.playerStats.recomputeUsers([userId]);
    return this.getMatchPlayers(matchId);
  }

  private normalizePlayerEntry(p: any, m: any) {
    if (!p?.userId || typeof p.userId !== 'string')
      throw new BadRequestException('userId est requis pour chaque joueur.');
    if (p.teamId !== m.teamAId && p.teamId !== m.teamBId)
      throw new BadRequestException("Chaque joueur doit appartenir à l'une des deux équipes.");
    const int = (v: any, min = 0) => {
      const n = Math.floor(Number(v));
      return Number.isFinite(n) ? Math.max(min, n) : 0;
    };
    const opt = (v: any) => (v === undefined || v === null || v === '' ? null : int(v));
    return {
      userId: p.userId,
      teamId: p.teamId,
      hero: typeof p.hero === 'string' && p.hero.trim() ? p.hero.trim() : null,
      heroId: typeof p.heroId === 'string' && /^[0-9a-f]{24}$/i.test(p.heroId) ? p.heroId : null,
      role: assertRole(p.role ?? null),
      kills: int(p.kills),
      deaths: int(p.deaths),
      assists: int(p.assists),
      gold: opt(p.gold),
      damage: opt(p.damage),
      isMvp: !!p.isMvp,
    };
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

  private async isCaptain(teamId: string, userId: string) {
    const cap = await this.prisma.esportTeamMember.findFirst({
      where: { teamId, userId, isCaptain: true },
    });
    return !!cap;
  }
}
