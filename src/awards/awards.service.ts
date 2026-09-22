import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { SEASON_REWARDS_BUDGET_MS, SeasonRewardsService } from '../gamification/season-rewards.service';
import { PrismaService } from '../prisma/prisma.service';
import { TeamRef } from '../esport/esport-stats.service';
import {
  EsportSeasonsService,
  SeasonRecord,
  parseSummary,
  resolveStatus,
  serializeSeason,
} from '../esport/esport-seasons.service';
import { StandingsService } from '../standings/standings.service';
import { serializeUserCard } from '../users/users.service';
import {
  AwardRecord,
  AwardSuggestion,
  PodiumEntry,
  PodiumWithTeam,
  SeasonPodiums,
  UserRef,
  compareAwards,
  decoratePodium,
  derivePlayoffsPodium,
  derivePodiumFromBracket,
  isFixedCategory,
  normalizePodium,
  parsePodiums,
  serializeAward,
  suggestAwards,
} from './awards.logic';
import { CreateAwardDto, SetPodiumDto, SuggestAwardsDto, UpdateAwardDto } from './dto/award.dto';

type SeasonRow = SeasonRecord & { podiums?: string | null; settings?: string | null };

export type SeasonPodiumsView = {
  regular: PodiumWithTeam[];
  playoffs: PodiumWithTeam[];
  /** Where each podium comes from. */
  source: { regular: 'manual' | 'summary' | 'standings' | 'none'; playoffs: 'manual' | 'summary' | 'matches' | 'none' };
};

/**
 * Season awards (#46), podiums and Hall of Fame (#47). Decisions live in
 * `awards.logic.ts`; this service orchestrates Prisma and the other modules.
 * Awards and podiums stay editable after a season is closed: writes on a
 * closed season also refresh the frozen `summary` so both stay consistent.
 */
@Injectable()
export class AwardsService {
  constructor(
    private prisma: PrismaService,
    private seasons: EsportSeasonsService,
    private standings: StandingsService,
    @Optional() private seasonRewards?: SeasonRewardsService,
  ) {}

  // ----- Lookups ------------------------------------------------------------

  private async season(idOrSlug: string): Promise<SeasonRow> {
    const found = await this.seasons.findRaw(idOrSlug);
    return (await this.prisma.esportSeason.findUnique({ where: { id: found.id } })) as SeasonRow;
  }

  private async teamRefs(ids: Iterable<string | null | undefined>): Promise<Map<string, TeamRef>> {
    const uniq = Array.from(new Set(Array.from(ids).filter(Boolean) as string[]));
    if (!uniq.length) return new Map();
    const teams = await this.prisma.esportTeam.findMany({
      where: { id: { in: uniq } },
      select: { id: true, name: true, image: true },
    });
    return new Map(teams.map((t) => [t.id, { id: t.id, name: t.name, image: t.image ?? null }]));
  }

  private async userRefs(ids: Iterable<string | null | undefined>): Promise<Map<string, UserRef>> {
    const uniq = Array.from(new Set(Array.from(ids).filter(Boolean) as string[]));
    if (!uniq.length) return new Map();
    const users = await this.prisma.user.findMany({ where: { id: { in: uniq } } });
    return new Map(
      users.map((u) => {
        const card = serializeUserCard(u);
        return [u.id, { id: u.id, username: card.username, displayName: card.displayName, avatar: card.avatar ?? null }];
      }),
    );
  }

  private async awardRows(seasonId: string): Promise<AwardRecord[]> {
    const rows = (await this.prisma.seasonAward.findMany({ where: { seasonId } })) as AwardRecord[];
    return rows.sort(compareAwards);
  }

  private async seasonMatches(seasonId: string) {
    return this.prisma.esportMatch.findMany({ where: { seasonId } });
  }

  // ----- Podiums --------------------------------------------------------------

  /** Regular + playoffs podiums of a season (manual > frozen > computed). */
  async podiumsOf(season: SeasonRow, matches?: Awaited<ReturnType<AwardsService['seasonMatches']>>): Promise<SeasonPodiumsView> {
    const manual = parsePodiums(season.podiums);
    const summary = parseSummary(season.summary);
    const closed = resolveStatus(season) === 'closed';
    const source: SeasonPodiumsView['source'] = { regular: 'none', playoffs: 'none' };

    let regular: PodiumEntry[] | null = manual.regular;
    if (regular) source.regular = 'manual';
    else if (closed && summary?.podium?.length) {
      regular = summary.podium.map((p) => ({ placement: p.placement, teamId: p.teamId }));
      source.regular = 'summary';
    } else {
      const table = await this.standings.getStandings(season.id, 'league').catch(() => null);
      const rows = table?.rows?.slice(0, 3) ?? [];
      if (rows.length) {
        regular = rows.map((r, i) => ({ placement: (i + 1) as 1 | 2 | 3, teamId: r.teamId }));
        source.regular = 'standings';
      }
    }

    let playoffs: PodiumEntry[] | null = manual.playoffs;
    if (playoffs) source.playoffs = 'manual';
    else if (closed && (summary as any)?.playoffsPodium?.length) {
      playoffs = ((summary as any).playoffsPodium as PodiumEntry[]).map((p) => ({ placement: p.placement, teamId: p.teamId }));
      source.playoffs = 'summary';
    } else {
      const rows = matches ?? (await this.seasonMatches(season.id));
      playoffs = derivePlayoffsPodium(rows as any, season);
      if (playoffs) source.playoffs = 'matches';
    }

    const teams = await this.teamRefs([...(regular ?? []), ...(playoffs ?? [])].map((p) => p.teamId));
    return { regular: decoratePodium(regular, teams), playoffs: decoratePodium(playoffs, teams), source };
  }

  async setPodium(idOrSlug: string, dto: SetPodiumDto) {
    const season = await this.season(idOrSlug);
    const current = parsePodiums(season.podiums);
    const next: SeasonPodiums = { ...current };

    if (dto.regular !== undefined) next.regular = normalizePodium(dto.regular);
    if (dto.playoffs !== undefined) next.playoffs = normalizePodium(dto.playoffs);

    if (dto.derivePlayoffs === 'matches') {
      const derived = derivePlayoffsPodium((await this.seasonMatches(season.id)) as any, season);
      if (!derived) throw new BadRequestException('Aucun match de playoffs terminé sur cette saison.');
      next.playoffs = derived;
    } else if (dto.derivePlayoffs === 'tournament') {
      if (!dto.tournamentId) throw new BadRequestException('tournamentId est requis.');
      const tournament = await this.prisma.tournament.findUnique({ where: { id: dto.tournamentId } });
      if (!tournament) throw new NotFoundException('Tournoi introuvable.');
      let bracket: any[] = [];
      try {
        bracket = JSON.parse(tournament.brackets || '[]');
      } catch {
        bracket = [];
      }
      const derived = derivePodiumFromBracket(bracket);
      if (!derived) throw new BadRequestException('La finale de ce tournoi n’est pas terminée.');
      next.playoffs = derived;
    }

    const all = [...(next.regular ?? []), ...(next.playoffs ?? [])].map((p) => p.teamId);
    const teams = await this.teamRefs(all);
    const unknown = all.find((id) => !teams.has(id));
    if (unknown) throw new NotFoundException('Équipe introuvable.');

    const stored = next.regular || next.playoffs ? JSON.stringify(next) : null;
    await this.prisma.esportSeason.update({ where: { id: season.id }, data: { podiums: stored } });
    await this.syncSummary(season.id);
    return this.forSeason(season.id);
  }

  // ----- Awards CRUD ------------------------------------------------------------

  async create(idOrSlug: string, dto: CreateAwardDto) {
    const season = await this.season(idOrSlug);
    if (dto.category === 'custom' && !dto.title?.trim()) {
      throw new BadRequestException('Le titre est requis pour une distinction personnalisée.');
    }
    if (isFixedCategory(dto.category)) {
      const dup = await this.prisma.seasonAward.findFirst({ where: { seasonId: season.id, category: dto.category } });
      if (dup) throw new ConflictException('Cette distinction existe déjà pour la saison : modifiez-la.');
    }
    await this.assertRefs(dto.userId, dto.teamId);
    const teamId = dto.teamId ?? (dto.userId ? await this.teamOf(dto.userId, season.id) : null);
    const created = await this.prisma.seasonAward.create({
      data: {
        seasonId: season.id,
        category: dto.category,
        title: dto.category === 'custom' ? dto.title!.trim() : dto.title?.trim() || null,
        userId: dto.userId ?? null,
        teamId,
        description: dto.description?.trim() || null,
        imageUrl: dto.imageUrl?.trim() || null,
        criteria: dto.criteria ? JSON.stringify(dto.criteria) : null,
        sort: dto.sort ?? 0,
      },
    });
    await this.syncSummary(season.id);
    return this.one(created.id);
  }

  async update(id: string, dto: UpdateAwardDto) {
    const award = await this.prisma.seasonAward.findUnique({ where: { id } });
    if (!award) throw new NotFoundException('Distinction introuvable.');
    if (award.category === 'custom' && dto.title !== undefined && !dto.title?.trim()) {
      throw new BadRequestException('Le titre est requis pour une distinction personnalisée.');
    }
    await this.assertRefs(dto.userId ?? undefined, dto.teamId ?? undefined);
    const data: any = {};
    if (dto.title !== undefined) data.title = dto.title?.trim() || null;
    if (dto.userId !== undefined) data.userId = dto.userId;
    if (dto.teamId !== undefined) data.teamId = dto.teamId;
    if (dto.description !== undefined) data.description = dto.description?.trim() || null;
    if (dto.imageUrl !== undefined) data.imageUrl = dto.imageUrl?.trim() || null;
    if (dto.criteria !== undefined) data.criteria = dto.criteria ? JSON.stringify(dto.criteria) : null;
    if (dto.sort !== undefined) data.sort = dto.sort;
    // A new winner without an explicit team inherits the team he played for.
    if (dto.userId && dto.teamId === undefined) data.teamId = await this.teamOf(dto.userId, award.seasonId);
    await this.prisma.seasonAward.update({ where: { id }, data });
    await this.syncSummary(award.seasonId);
    return this.one(id);
  }

  async remove(id: string) {
    const award = await this.prisma.seasonAward.findUnique({ where: { id } });
    if (!award) throw new NotFoundException('Distinction introuvable.');
    await this.prisma.seasonAward.delete({ where: { id } });
    await this.syncSummary(award.seasonId);
    return { ok: true };
  }

  private async one(id: string) {
    const award = (await this.prisma.seasonAward.findUnique({ where: { id } })) as AwardRecord | null;
    if (!award) throw new NotFoundException('Distinction introuvable.');
    const [users, teams] = await Promise.all([this.userRefs([award.userId]), this.teamRefs([award.teamId])]);
    return serializeAward(award, users, teams);
  }

  private async assertRefs(userId?: string, teamId?: string) {
    if (userId) {
      const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
      if (!u) throw new NotFoundException('Joueur introuvable.');
    }
    if (teamId) {
      const t = await this.prisma.esportTeam.findUnique({ where: { id: teamId }, select: { id: true } });
      if (!t) throw new NotFoundException('Équipe introuvable.');
    }
  }

  /** Team a player represented during the season (last stats row), else his current roster. */
  private async teamOf(userId: string, seasonId: string): Promise<string | null> {
    const matches = await this.prisma.esportMatch.findMany({ where: { seasonId }, select: { id: true } });
    if (matches.length) {
      const row = await this.prisma.esportMatchPlayer.findFirst({
        where: { userId, matchId: { in: matches.map((m) => m.id) } },
        orderBy: { createdAt: 'desc' },
        select: { teamId: true },
      });
      if (row) return row.teamId;
    }
    const member = await this.prisma.esportTeamMember.findFirst({ where: { userId }, select: { teamId: true } });
    return member?.teamId ?? null;
  }

  // ----- Suggestions --------------------------------------------------------------

  async suggest(idOrSlug: string, dto: SuggestAwardsDto = {}) {
    const season = await this.season(idOrSlug);
    const matches = await this.prisma.esportMatch.findMany({ where: { seasonId: season.id, status: 'completed' } });
    const players = matches.length
      ? await this.prisma.esportMatchPlayer.findMany({ where: { matchId: { in: matches.map((m) => m.id) } } })
      : [];
    const suggestions = suggestAwards(matches, players, { minGames: dto.minGames });
    const [users, teams] = await Promise.all([
      this.userRefs(suggestions.flatMap((s) => [s.userId, ...s.alternatives.map((a) => a.userId)])),
      this.teamRefs(suggestions.flatMap((s) => [s.teamId, ...s.alternatives.map((a) => a.teamId)])),
    ]);
    const decorate = (s: { userId: string; teamId: string }) => ({
      user: users.get(s.userId) ?? { id: s.userId, username: '?', displayName: '?', avatar: null },
      team: teams.get(s.teamId) ?? { id: s.teamId, name: '?', image: null },
    });
    return {
      season: { id: season.id, name: season.name, slug: season.slug ?? null },
      matches: matches.length,
      hasPlayerStats: players.length > 0,
      suggestions: suggestions.map((s: AwardSuggestion) => ({
        ...s,
        ...decorate(s),
        alternatives: s.alternatives.map((a) => ({ ...a, ...decorate(a) })),
      })),
    };
  }

  // ----- Public reads ---------------------------------------------------------------

  /** Awards + podiums + sponsors of one season. */
  async forSeason(idOrSlug: string) {
    const season = await this.season(idOrSlug);
    const [awards, matches, sponsors] = await Promise.all([
      this.awardRows(season.id),
      this.seasonMatches(season.id),
      this.prisma.sponsor.findMany({ where: { seasonIds: { has: season.id }, isActive: true }, orderBy: { sort: 'asc' } }),
    ]);
    const podiums = await this.podiumsOf(season, matches);
    const [users, teams] = await Promise.all([
      this.userRefs(awards.map((a) => a.userId)),
      this.teamRefs(awards.map((a) => a.teamId)),
    ]);
    const items = awards.map((a) => serializeAward(a, users, teams));
    return {
      season: serializeSeason(season),
      awards: items,
      mvp: items.find((a) => a.category === 'mvp') ?? null,
      podiums,
      sponsors,
      matches: { total: matches.length, completed: matches.filter((m) => m.status === 'completed').length },
    };
  }

  /** Closed seasons, newest first, with podiums, MVP, awards and sponsors. */
  async hallOfFame() {
    const closed = (await this.seasons.list('closed')) as ReturnType<typeof serializeSeason>[];
    if (!closed.length) return { seasons: [] };
    const ids = closed.map((s) => s.id);
    const [rows, awards, sponsors] = await Promise.all([
      this.prisma.esportSeason.findMany({ where: { id: { in: ids } } }) as Promise<SeasonRow[]>,
      this.prisma.seasonAward.findMany({ where: { seasonId: { in: ids } } }) as Promise<AwardRecord[]>,
      this.prisma.sponsor.findMany({ where: { seasonIds: { hasSome: ids }, isActive: true }, orderBy: { sort: 'asc' } }),
    ]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const [users, teams] = await Promise.all([
      this.userRefs(awards.map((a) => a.userId)),
      this.teamRefs(awards.map((a) => a.teamId)),
    ]);
    const seasons = [];
    for (const s of closed) {
      const raw = byId.get(s.id);
      if (!raw) continue;
      const podiums = await this.podiumsOf(raw);
      const own = awards.filter((a) => a.seasonId === s.id).sort(compareAwards).map((a) => serializeAward(a, users, teams));
      seasons.push({
        season: s,
        podiums,
        champion: podiums.playoffs[0]?.team ?? podiums.regular[0]?.team ?? s.summary?.champion?.team ?? null,
        mvp: own.find((a) => a.category === 'mvp') ?? null,
        awards: own,
        awardsCount: own.length,
        sponsors: sponsors.filter((sp) => sp.seasonIds.includes(s.id)),
      });
    }
    return { seasons };
  }

  // ----- Frozen summary sync ----------------------------------------------------------

  /**
   * Closed seasons keep a frozen `summary`: mirror the current awards and
   * podiums into it so the archive and the public season page agree.
   */
  private async syncSummary(seasonId: string) {
    const season = (await this.prisma.esportSeason.findUnique({ where: { id: seasonId } })) as SeasonRow | null;
    if (!season || resolveStatus(season) !== 'closed') return;
    const summary = parseSummary(season.summary);
    if (!summary) return;
    const manual = parsePodiums(season.podiums);
    const awards = await this.awardRows(seasonId);
    const [users, teams] = await Promise.all([
      this.userRefs(awards.map((a) => a.userId)),
      this.teamRefs([...awards.map((a) => a.teamId), ...(manual.regular ?? []).map((p) => p.teamId), ...(manual.playoffs ?? []).map((p) => p.teamId)]),
    ]);
    const next: any = { ...summary, awards: awards.map((a) => serializeAward(a, users, teams)) };
    if (manual.regular) {
      next.podium = decoratePodium(manual.regular, teams);
    } else {
      // Override removed: back to the frozen standings.
      next.podium = (summary.standings ?? []).slice(0, 3).map((r) => ({ placement: r.rank, teamId: r.teamId, team: r.team }));
    }
    next.champion = next.podium[0] ? { teamId: next.podium[0].teamId, team: next.podium[0].team } : null;
    if (manual.playoffs) {
      next.playoffsPodium = decoratePodium(manual.playoffs, teams);
    } else {
      const derived = derivePlayoffsPodium((await this.seasonMatches(seasonId)) as any, season);
      const refs = await this.teamRefs((derived ?? []).map((p) => p.teamId));
      next.playoffsPodium = decoratePodium(derived, refs);
    }
    await this.prisma.esportSeason.update({ where: { id: seasonId }, data: { summary: JSON.stringify(next) } });
    // Awards / podium edited after the close: grant what is new (add-only).
    await this.seasonRewards?.applySafe(seasonId, Date.now() + SEASON_REWARDS_BUDGET_MS);
  }
}
