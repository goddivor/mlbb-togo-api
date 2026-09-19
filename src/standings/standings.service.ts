import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MatchLike, TeamRef } from '../esport/esport-stats.service';
import {
  EsportSeasonsService,
  SeasonRecord,
  parseSummary,
  resolveStatus,
} from '../esport/esport-seasons.service';
import { Lang, STANDINGS_TYPES, SUPPORTED_LANGS, StandingsType } from './standings.constants';
import {
  StandingRow,
  StandingsSettings,
  computeStandings,
  enrichFrozenRows,
  headToHead,
  mergeSettings,
  parseSettings,
  scopeMatches,
} from './standings.logic';
import { buildStandingsPdf } from './standings.pdf';
import { UpdateStandingsSettingsDto } from './dto/standings-settings.dto';

type SeasonWithSettings = SeasonRecord & { settings?: string | null };

export type StandingsResponse = {
  season: {
    id: string;
    name: string;
    slug: string | null;
    number: number | null;
    status: string;
    color: string | null;
    closedAt: Date | null;
  };
  type: StandingsType;
  frozen: boolean;
  frozenAt: string | null;
  settings: StandingsSettings;
  meta: {
    qualifyTop: number;
    asOf: Date;
    generatedAt: Date;
    matches: { total: number; completed: number; scoped: number };
    tieBreakers: string[];
  };
  rows: StandingRow[];
};

const OBJECT_ID = /^[0-9a-f]{24}$/i;

/**
 * League standings: orchestrates Prisma reads and delegates every
 * computation to the pure functions of `standings.logic.ts`.
 */
@Injectable()
export class StandingsService {
  constructor(
    private prisma: PrismaService,
    private seasons: EsportSeasonsService,
  ) {}

  static parseType(raw?: string): StandingsType {
    const t = (raw ?? 'league').toLowerCase();
    if (!(STANDINGS_TYPES as readonly string[]).includes(t)) {
      throw new BadRequestException(`Type de classement invalide (${STANDINGS_TYPES.join(' | ')}).`);
    }
    return t as StandingsType;
  }

  static parseLang(raw?: string): Lang {
    const l = (raw ?? 'fr').toLowerCase();
    return (SUPPORTED_LANGS as readonly string[]).includes(l) ? (l as Lang) : 'fr';
  }

  /** Raw season by id / slug / "current" (404 when unknown). */
  private async resolveSeason(seasonId?: string): Promise<SeasonWithSettings> {
    const key = (seasonId ?? 'current').trim();
    if (!key || key === 'current') {
      const current = await this.seasons.current();
      return (await this.prisma.esportSeason.findUnique({ where: { id: current.id } })) as SeasonWithSettings;
    }
    const found = await this.seasons.findRaw(key);
    return (await this.prisma.esportSeason.findUnique({ where: { id: found.id } })) as SeasonWithSettings;
  }

  private async seasonMatches(seasonId: string): Promise<MatchLike[]> {
    return (await this.prisma.esportMatch.findMany({ where: { seasonId } })) as MatchLike[];
  }

  private async teamMap(ids: string[]): Promise<Map<string, TeamRef>> {
    const uniq = Array.from(new Set(ids.filter(Boolean)));
    const teams = uniq.length
      ? await this.prisma.esportTeam.findMany({
          where: { id: { in: uniq } },
          select: { id: true, name: true, image: true },
        })
      : [];
    return new Map(teams.map((t) => [t.id, t]));
  }

  async getStandings(seasonId?: string, typeRaw?: string): Promise<StandingsResponse> {
    const type = StandingsService.parseType(typeRaw);
    const season = await this.resolveSeason(seasonId);
    const settings = parseSettings(season.settings);
    const matches = await this.seasonMatches(season.id);
    const teams = await this.teamMap(matches.flatMap((m) => [m.teamAId, m.teamBId]));
    const now = new Date();
    const status = resolveStatus(season, now);
    const closed = status === 'closed';
    const asOf = closed && season.closedAt ? new Date(season.closedAt) : now;

    const scoped = scopeMatches(matches, type, season);
    const computed = computeStandings(scoped, settings, teams, asOf);

    // A closed season exposes its frozen table (built on every completed
    // match, hence the `all` scope) enriched with the computed extras.
    const summary = closed ? parseSummary(season.summary) : null;
    const frozen = !!summary?.standings && type === 'all';
    const rows = frozen ? enrichFrozenRows(summary!.standings, computed, settings, scoped) : computed;

    return {
      season: {
        id: season.id,
        name: season.name,
        slug: season.slug ?? null,
        number: season.number ?? null,
        status,
        color: season.color ?? null,
        closedAt: season.closedAt ?? null,
      },
      type,
      frozen,
      frozenAt: frozen ? (summary!.frozenAt ?? null) : null,
      settings,
      meta: {
        qualifyTop: settings.qualifyTop,
        asOf,
        generatedAt: now,
        matches: {
          total: matches.length,
          completed: matches.filter((m) => m.status === 'completed').length,
          scoped: scoped.length,
        },
        tieBreakers: ['points', 'scoreDiff', 'winRate', 'headToHead', 'name'],
      },
      rows,
    };
  }

  /**
   * Head-to-head inside a season. With `teamB` -> one record; without it ->
   * the record of `teamA` against every opponent faced (drawer on the UI).
   */
  async getHeadToHead(seasonId: string | undefined, teamA: string, teamB?: string, typeRaw?: string) {
    if (!teamA || !OBJECT_ID.test(teamA)) throw new BadRequestException('teamA est requis.');
    if (teamB && !OBJECT_ID.test(teamB)) throw new BadRequestException('teamB est invalide.');
    const type = StandingsService.parseType(typeRaw ?? 'all');
    const season = await this.resolveSeason(seasonId);
    const matches = scopeMatches(await this.seasonMatches(season.id), type, season);
    const teams = await this.teamMap([teamA, ...(teamB ? [teamB] : []), ...matches.flatMap((m) => [m.teamAId, m.teamBId])]);
    const a = teams.get(teamA);
    if (!a) throw new NotFoundException('Équipe introuvable.');
    const base = { seasonId: season.id, seasonName: season.name, type };
    if (teamB) {
      const b = teams.get(teamB);
      if (!b) throw new NotFoundException('Équipe introuvable.');
      return { ...base, ...headToHead(a, b, matches) };
    }
    const opponentIds = Array.from(
      new Set(
        matches
          .filter((m) => m.status === 'completed' && (m.teamAId === teamA || m.teamBId === teamA))
          .map((m) => (m.teamAId === teamA ? m.teamBId : m.teamAId)),
      ),
    );
    const opponents = opponentIds
      .map((id) => headToHead(a, teams.get(id) ?? { id, name: '?', image: null }, matches))
      .sort((x, y) => y.played - x.played || y.winsA - x.winsA || x.teamB.name.localeCompare(y.teamB.name));
    return { ...base, team: a, opponents };
  }

  async exportPdf(seasonId?: string, typeRaw?: string, langRaw?: string) {
    const data = await this.getStandings(seasonId, typeRaw);
    const lang = StandingsService.parseLang(langRaw);
    const buffer = await buildStandingsPdf({
      lang,
      seasonName: data.season.name,
      type: data.type,
      frozen: data.frozen,
      generatedAt: data.meta.generatedAt,
      qualifyTop: data.settings.qualifyTop,
      points: data.settings.points,
      rows: data.rows,
    });
    const slug = data.season.slug || data.season.id;
    return { buffer, filename: `classement-${slug}-${data.type}.pdf` };
  }

  // ----- Admin -----

  async getSettings(seasonId: string) {
    const season = await this.resolveSeason(seasonId);
    return { seasonId: season.id, ...parseSettings(season.settings) };
  }

  async updateSettings(seasonId: string, dto: UpdateStandingsSettingsDto) {
    const season = await this.resolveSeason(seasonId);
    const next = mergeSettings(parseSettings(season.settings), dto ?? {});
    await this.prisma.esportSeason.update({
      where: { id: season.id },
      data: { settings: JSON.stringify(next) },
    });
    return { seasonId: season.id, ...next };
  }
}
