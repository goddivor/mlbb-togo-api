import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SeasonRewardsService } from '../gamification/season-rewards.service';
import { MatchLike, TeamRef, standingsOf } from './esport-stats.service';
import {
  CloseSeasonDto,
  CreateSeasonDto,
  SEASON_STATUS,
  SeasonStatus,
  UpdateSeasonDto,
} from './dto/season.dto';
import {
  AwardRecord,
  compareAwards,
  decoratePodium,
  derivePlayoffsPodium,
  parsePodiums,
  serializeAward,
} from '../awards/awards.logic';
import { serializeUserCard } from '../users/users.service';

/**
 * League seasons: theme, lifecycle (upcoming -> active -> playoffs -> closed)
 * and the frozen summary written at closing. Standings (#43), matches (#44),
 * stats (#45), awards (#46) and the Hall of Fame (#47) plug into this module:
 * they read `status`, `summary` and the `current` season.
 *
 * All decision logic lives in pure functions (unit tested) and the service
 * only orchestrates Prisma calls.
 */

export type SeasonRecord = {
  id: string;
  name: string;
  slug?: string | null;
  number?: number | null;
  theme?: string | null;
  slogan?: string | null;
  description?: string | null;
  status?: string | null;
  startDate?: Date | null;
  endDate?: Date | null;
  playoffsStartDate?: Date | null;
  closedAt?: Date | null;
  banner?: string | null;
  color?: string | null;
  summary?: string | null;
  isActive: boolean;
  createdAt?: Date;
  updatedAt?: Date;
};

/** Standing row as frozen in the season summary. */
export type SummaryStanding = {
  rank: number;
  teamId: string;
  team: TeamRef;
  played: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
  scoreFor: number;
  scoreAgainst: number;
  scoreDiff: number;
};

export type SeasonSummary = {
  version: 1;
  frozenAt: string;
  seasonId: string;
  name: string;
  slug: string | null;
  number: number | null;
  theme: string | null;
  matches: { total: number; completed: number };
  standings: SummaryStanding[];
  podium: { placement: 1 | 2 | 3; teamId: string; team: TeamRef }[];
  /** Playoffs podium (#46): manual override or derived from the playoff matches. */
  playoffsPodium?: { placement: 1 | 2 | 3; teamId: string; team: TeamRef }[];
  champion: { teamId: string; team: TeamRef } | null;
  /** Season awards (#46, serialized) and player stats (#45). */
  awards: any[];
  players: any[];
};

/** Optional extras merged into the frozen summary (awards + podium overrides). */
export type SummaryExtras = {
  awards?: any[];
  regularPodium?: { placement: 1 | 2 | 3; teamId: string; team: TeamRef }[] | null;
  playoffsPodium?: { placement: 1 | 2 | 3; teamId: string; team: TeamRef }[] | null;
};

/** Statuses during which the season is "live" (mirrors the legacy isActive flag). */
export const LIVE_STATUS: SeasonStatus[] = ['active', 'playoffs'];

export type SeasonAction = 'activate' | 'playoffs' | 'close' | 'reopen';

const TRANSITIONS: Record<SeasonAction, { from: SeasonStatus[]; to: (s: SeasonRecord) => SeasonStatus }> = {
  activate: { from: ['upcoming'], to: () => 'active' },
  playoffs: { from: ['active'], to: () => 'playoffs' },
  close: { from: ['active', 'playoffs'], to: () => 'closed' },
  // Reopening returns to the phase the season was in when it got closed.
  reopen: { from: ['closed'], to: (s) => (s.playoffsStartDate ? 'playoffs' : 'active') },
};

export function slugify(input: string): string {
  return String(input ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** Make `base` unique against the `taken` set by appending -2, -3, ... */
export function uniqueSlug(base: string, taken: Set<string>): string {
  const root = base || 'saison';
  if (!taken.has(root)) return root;
  let i = 2;
  while (taken.has(`${root}-${i}`)) i++;
  return `${root}-${i}`;
}

/**
 * Status of a season. Legacy documents (created before the lifecycle) have
 * no `status`: it is derived from `isActive` and the end date.
 */
export function resolveStatus(season: SeasonRecord, now = new Date()): SeasonStatus {
  if (season.status && (SEASON_STATUS as readonly string[]).includes(season.status)) {
    return season.status as SeasonStatus;
  }
  if (season.isActive) return 'active';
  if (season.endDate) {
    const d = new Date(season.endDate);
    if (!isNaN(d.getTime()) && d.getTime() < now.getTime()) return 'closed';
  }
  return 'upcoming';
}

export function isLive(status: SeasonStatus) {
  return LIVE_STATUS.includes(status);
}

/** Target status of a lifecycle action, or null when the transition is illegal. */
export function nextStatus(season: SeasonRecord, action: SeasonAction, now = new Date()): SeasonStatus | null {
  const rule = TRANSITIONS[action];
  if (!rule) return null;
  const from = resolveStatus(season, now);
  return rule.from.includes(from) ? rule.to(season) : null;
}

export function parseSummary(raw: unknown): SeasonSummary | null {
  if (!raw) return null;
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return obj && typeof obj === 'object' ? (obj as SeasonSummary) : null;
  } catch {
    return null;
  }
}

/** Frozen snapshot of a season: final standings + podium (pure). */
export function buildSeasonSummary(
  season: SeasonRecord,
  matches: MatchLike[],
  teams: Map<string, TeamRef>,
  now = new Date(),
  extras: SummaryExtras = {},
): SeasonSummary {
  const completed = matches.filter((m) => m.status === 'completed');
  const ref = (id: string): TeamRef => teams.get(id) ?? { id, name: '?', image: null };
  const standings: SummaryStanding[] = standingsOf(completed).map((row, i) => ({
    rank: i + 1,
    teamId: row.teamId,
    team: ref(row.teamId),
    played: row.played,
    wins: row.wins,
    losses: row.losses,
    draws: row.draws,
    winRate: row.winRate,
    scoreFor: row.scoreFor,
    scoreAgainst: row.scoreAgainst,
    scoreDiff: row.scoreDiff,
  }));
  const podium =
    extras.regularPodium?.length
      ? extras.regularPodium
      : standings.slice(0, 3).map((r) => ({
          placement: r.rank as 1 | 2 | 3,
          teamId: r.teamId,
          team: r.team,
        }));
  return {
    version: 1,
    frozenAt: now.toISOString(),
    seasonId: season.id,
    name: season.name,
    slug: season.slug ?? null,
    number: season.number ?? null,
    theme: season.theme ?? null,
    matches: { total: matches.length, completed: completed.length },
    standings,
    podium,
    playoffsPodium: extras.playoffsPodium ?? [],
    champion: podium[0] ? { teamId: podium[0].teamId, team: podium[0].team } : null,
    awards: extras.awards ?? [],
    players: [],
  };
}

/** Sort: live seasons first, then by number / start date descending. */
export function compareSeasons(a: SeasonRecord, b: SeasonRecord, now = new Date()) {
  const la = isLive(resolveStatus(a, now)) ? 1 : 0;
  const lb = isLive(resolveStatus(b, now)) ? 1 : 0;
  if (la !== lb) return lb - la;
  const na = a.number ?? -1;
  const nb = b.number ?? -1;
  if (na !== nb) return nb - na;
  const da = a.startDate ? new Date(a.startDate).getTime() : 0;
  const db = b.startDate ? new Date(b.startDate).getTime() : 0;
  if (da !== db) return db - da;
  const ca = a.createdAt ? new Date(a.createdAt).getTime() : 0;
  const cb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
  return cb - ca;
}

/** Public shape of a season (status resolved, summary parsed). */
export function serializeSeason(season: SeasonRecord, now = new Date()) {
  const status = resolveStatus(season, now);
  return {
    id: season.id,
    name: season.name,
    slug: season.slug ?? null,
    number: season.number ?? null,
    theme: season.theme ?? null,
    slogan: season.slogan ?? null,
    description: season.description ?? null,
    status,
    isActive: isLive(status),
    startDate: season.startDate ?? null,
    endDate: season.endDate ?? null,
    playoffsStartDate: season.playoffsStartDate ?? null,
    closedAt: season.closedAt ?? null,
    banner: season.banner ?? null,
    color: season.color ?? null,
    summary: parseSummary(season.summary),
    createdAt: season.createdAt,
    updatedAt: season.updatedAt,
  };
}

export type SerializedSeason = ReturnType<typeof serializeSeason>;

const OBJECT_ID = /^[0-9a-f]{24}$/i;

function toDate(v: string | null | undefined): Date | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) throw new BadRequestException('Date invalide.');
  return d;
}

@Injectable()
export class EsportSeasonsService {
  constructor(
    private prisma: PrismaService,
    @Optional() private seasonRewards?: SeasonRewardsService,
  ) {}

  // ----- Reads -----

  async list(status?: string) {
    const rows = (await this.prisma.esportSeason.findMany()) as SeasonRecord[];
    const withSlugs = await this.ensureSlugs(rows);
    const now = new Date();
    return withSlugs
      .sort((a, b) => compareSeasons(a, b, now))
      .map((s) => serializeSeason(s, now))
      .filter((s) => !status || s.status === status);
  }

  /** Raw record by id or slug (404 when unknown). */
  async findRaw(idOrSlug: string): Promise<SeasonRecord> {
    const key = String(idOrSlug ?? '').trim();
    let season: SeasonRecord | null = null;
    if (OBJECT_ID.test(key)) {
      season = (await this.prisma.esportSeason.findUnique({ where: { id: key } })) as SeasonRecord | null;
    }
    if (!season && key) {
      season = (await this.prisma.esportSeason.findFirst({ where: { slug: key } })) as SeasonRecord | null;
    }
    if (!season) throw new NotFoundException('Saison introuvable.');
    const [withSlug] = await this.ensureSlugs([season]);
    return withSlug;
  }

  async get(idOrSlug: string) {
    return serializeSeason(await this.findRaw(idOrSlug));
  }

  /**
   * The season the site considers current: the live one (active/playoffs),
   * otherwise the most recently closed one, otherwise the next upcoming one.
   */
  async current() {
    const all = await this.list();
    const live = all.find((s) => isLive(s.status));
    if (live) return live;
    const closed = all
      .filter((s) => s.status === 'closed')
      .sort((a, b) => new Date(b.closedAt ?? b.endDate ?? 0).getTime() - new Date(a.closedAt ?? a.endDate ?? 0).getTime());
    if (closed[0]) return closed[0];
    if (all[0]) return all[0];
    throw new NotFoundException('Aucune saison.');
  }

  // ----- Writes -----

  async create(dto: CreateSeasonDto) {
    const name = dto.name?.trim();
    if (!name) throw new BadRequestException('Le nom de la saison est requis.');
    const slug = await this.allocateSlug(dto.slug ?? name);
    const number = dto.number ?? (await this.nextNumber());
    const status: SeasonStatus = dto.status ?? 'upcoming';
    if (isLive(status) || dto.isActive) await this.assertNoOtherLive(null);
    const finalStatus: SeasonStatus = dto.isActive && status === 'upcoming' ? 'active' : status;
    const created = await this.prisma.esportSeason.create({
      data: {
        name,
        slug,
        number,
        theme: dto.theme?.trim() || null,
        slogan: dto.slogan?.trim() || null,
        description: dto.description?.trim() || null,
        status: finalStatus,
        startDate: toDate(dto.startDate) ?? null,
        endDate: toDate(dto.endDate) ?? null,
        playoffsStartDate: toDate(dto.playoffsStartDate) ?? null,
        banner: dto.banner?.trim() || null,
        color: dto.color?.trim() || null,
        isActive: isLive(finalStatus),
        closedAt: finalStatus === 'closed' ? new Date() : null,
      },
    });
    return serializeSeason(created as SeasonRecord);
  }

  async update(idOrSlug: string, dto: UpdateSeasonDto) {
    const season = await this.findRaw(idOrSlug);
    const data: any = {};
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) throw new BadRequestException('Le nom de la saison est requis.');
      data.name = name;
    }
    if (dto.slug !== undefined) data.slug = await this.allocateSlug(dto.slug, season.id);
    if (dto.number !== undefined) data.number = dto.number;
    if (dto.theme !== undefined) data.theme = dto.theme?.trim() || null;
    if (dto.slogan !== undefined) data.slogan = dto.slogan?.trim() || null;
    if (dto.description !== undefined) data.description = dto.description?.trim() || null;
    if (dto.banner !== undefined) data.banner = dto.banner?.trim() || null;
    if (dto.color !== undefined) data.color = dto.color?.trim() || null;
    const start = toDate(dto.startDate);
    if (start !== undefined) data.startDate = start;
    const end = toDate(dto.endDate);
    if (end !== undefined) data.endDate = end;
    const playoffs = toDate(dto.playoffsStartDate);
    if (playoffs !== undefined) data.playoffsStartDate = playoffs;
    await this.prisma.esportSeason.update({ where: { id: season.id }, data });
    // Legacy flag: `isActive: true` behaves like POST /activate.
    if (dto.isActive === true && !isLive(resolveStatus(season))) {
      return this.transition(season.id, 'activate');
    }
    return this.get(season.id);
  }

  async remove(idOrSlug: string) {
    const season = await this.findRaw(idOrSlug);
    await this.prisma.esportSeason.delete({ where: { id: season.id } });
    return { ok: true };
  }

  // ----- Lifecycle -----

  async activate(idOrSlug: string) {
    return this.transition(idOrSlug, 'activate');
  }

  async startPlayoffs(idOrSlug: string) {
    return this.transition(idOrSlug, 'playoffs');
  }

  async close(idOrSlug: string, dto: CloseSeasonDto = {}) {
    return this.transition(idOrSlug, 'close', dto);
  }

  async reopen(idOrSlug: string) {
    return this.transition(idOrSlug, 'reopen');
  }

  /** What the frozen summary would look like right now (admin preview). */
  async previewSummary(idOrSlug: string) {
    const season = await this.findRaw(idOrSlug);
    return this.computeSummary(season);
  }

  private async transition(idOrSlug: string, action: SeasonAction, dto: CloseSeasonDto = {}) {
    const season = await this.findRaw(idOrSlug);
    const now = new Date();
    const to = nextStatus(season, action, now);
    if (!to) {
      throw new ConflictException(
        `Transition impossible depuis le statut « ${resolveStatus(season, now)} ».`,
      );
    }
    const data: any = { status: to, isActive: isLive(to) };
    if (isLive(to)) await this.assertNoOtherLive(season.id);

    if (action === 'activate' && !season.startDate) data.startDate = now;
    if (action === 'playoffs' && !season.playoffsStartDate) data.playoffsStartDate = now;
    if (action === 'close') {
      const summary = await this.computeSummary(season, now);
      if (summary.matches.completed === 0 && !dto.force) {
        throw new BadRequestException(
          'Aucun match terminé sur cette saison : utilisez « force » pour clôturer quand même.',
        );
      }
      data.summary = JSON.stringify(summary);
      data.closedAt = now;
      if (!season.endDate) data.endDate = now;
    }
    if (action === 'reopen') {
      data.closedAt = null;
      data.summary = null;
    }
    const updated = await this.prisma.esportSeason.update({ where: { id: season.id }, data });
    // Participation, podium, awards, season frames, reigning champion (idempotent).
    if (action === 'close') void this.seasonRewards?.applySafe(season.id);
    return serializeSeason(updated as SeasonRecord, now);
  }

  private async computeSummary(season: SeasonRecord, now = new Date()): Promise<SeasonSummary> {
    const matches = (await this.prisma.esportMatch.findMany({
      where: { seasonId: season.id },
    })) as MatchLike[];
    // Awards and manual podiums (#46) are frozen alongside the standings.
    const awards = ((await this.prisma.seasonAward.findMany({ where: { seasonId: season.id } })) as AwardRecord[]).sort(
      compareAwards,
    );
    const podiums = parsePodiums((season as SeasonRecord & { podiums?: string | null }).podiums);
    const playoffs = podiums.playoffs ?? derivePlayoffsPodium(matches as any, season);
    const ids = Array.from(
      new Set([
        ...matches.flatMap((m) => [m.teamAId, m.teamBId]),
        ...awards.map((a) => a.teamId).filter(Boolean),
        ...(podiums.regular ?? []).map((p) => p.teamId),
        ...(playoffs ?? []).map((p) => p.teamId),
      ] as string[]),
    );
    const teams = ids.length
      ? await this.prisma.esportTeam.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true, image: true },
        })
      : [];
    const teamMap = new Map(teams.map((t) => [t.id, t]));
    const userIds = Array.from(new Set(awards.map((a) => a.userId).filter(Boolean) as string[]));
    const users = userIds.length ? await this.prisma.user.findMany({ where: { id: { in: userIds } } }) : [];
    const userMap = new Map(
      users.map((u) => {
        const card = serializeUserCard(u);
        return [u.id, { id: u.id, username: card.username, displayName: card.displayName, avatar: card.avatar ?? null }];
      }),
    );
    return buildSeasonSummary(season, matches, teamMap, now, {
      awards: awards.map((a) => serializeAward(a, userMap, teamMap)),
      regularPodium: podiums.regular ? decoratePodium(podiums.regular, teamMap) : null,
      playoffsPodium: playoffs ? decoratePodium(playoffs, teamMap) : null,
    });
  }

  // ----- Helpers -----

  private async assertNoOtherLive(exceptId: string | null) {
    const rows = (await this.prisma.esportSeason.findMany()) as SeasonRecord[];
    const other = rows.find((s) => s.id !== exceptId && isLive(resolveStatus(s)));
    if (other) {
      throw new ConflictException(
        `La saison « ${other.name} » est déjà active : clôturez-la d'abord.`,
      );
    }
  }

  private async nextNumber() {
    const rows = await this.prisma.esportSeason.findMany({ select: { number: true } });
    const max = rows.reduce((m, r) => Math.max(m, r.number ?? 0), 0);
    return max + 1;
  }

  private async allocateSlug(source: string, exceptId?: string) {
    const base = slugify(source);
    if (!base) throw new BadRequestException('Slug invalide.');
    const rows = await this.prisma.esportSeason.findMany({ select: { id: true, slug: true } });
    const taken = new Set(rows.filter((r) => r.id !== exceptId && r.slug).map((r) => r.slug as string));
    return uniqueSlug(base, taken);
  }

  /** Legacy seasons have no slug: derive one from the name and persist it. */
  private async ensureSlugs(rows: SeasonRecord[]): Promise<SeasonRecord[]> {
    const missing = rows.filter((r) => !r.slug);
    if (missing.length === 0) return rows;
    const all = await this.prisma.esportSeason.findMany({ select: { id: true, slug: true } });
    const taken = new Set(all.filter((r) => r.slug).map((r) => r.slug as string));
    const out: SeasonRecord[] = [];
    for (const r of rows) {
      if (r.slug) {
        out.push(r);
        continue;
      }
      const slug = uniqueSlug(slugify(r.name), taken);
      taken.add(slug);
      const updated = await this.prisma.esportSeason
        .update({ where: { id: r.id }, data: { slug } })
        .catch(() => ({ ...r, slug }));
      out.push(updated as SeasonRecord);
    }
    return out;
  }
}
