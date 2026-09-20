import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AdminService } from './admin.service';
import {
  EsportSeasonsService,
  SeasonRecord,
  resolveStatus,
  serializeSeason,
} from '../esport/esport-seasons.service';
import { StandingsService } from '../standings/standings.service';
import { AwardsService } from '../awards/awards.service';
import { LeagueStatsService } from '../league-stats/league-stats.service';
import { GamificationService } from '../gamification/gamification.service';
import { PlayerStatsService } from '../stats/player-stats.service';
import { PostsService } from '../posts/posts.service';
import { StreamService } from '../stream/stream.service';
import { filterForSeason, groupByTier } from '../sponsors/sponsors.logic';
import { SPONSOR_TIERS } from '../sponsors/sponsors.constants';
import { LeagueAnnounceDto } from './dto/league.dto';
import {
  LeagueMatchRow,
  awardsCoverage,
  buildChecklist,
  checklistReady,
  countMatches,
  countRecent,
} from './league.logic';

type ActingUser = { id?: string; username?: string; roleUser?: string };

const TOP_STANDINGS = 5;

/**
 * League control room (#56): one aggregated overview per season, a quick
 * announcement composer and a "recompute stats" action. Every building block
 * already exists in its own module; this service only orchestrates them and
 * records the admin actions in the AdminLog.
 */
@Injectable()
export class LeagueService {
  private readonly logger = new Logger(LeagueService.name);
  /** Last recompute per season (in-memory, informative only). */
  private lastRecompute = new Map<string, { at: string; matches: number; by: string | null }>();

  constructor(
    private prisma: PrismaService,
    private admin: AdminService,
    private seasons: EsportSeasonsService,
    private standings: StandingsService,
    private awards: AwardsService,
    private leagueStats: LeagueStatsService,
    private gamification: GamificationService,
    private playerStats: PlayerStatsService,
    private posts: PostsService,
    private stream: StreamService,
  ) {}

  /** `current` (default) -> the site's current season, otherwise id / slug. */
  private async resolveSeason(key?: string): Promise<SeasonRecord & { podiums?: string | null }> {
    const k = (key ?? 'current').trim();
    if (!k || k === 'current') {
      const current = await this.seasons.current();
      return (await this.prisma.esportSeason.findUnique({ where: { id: current.id } })) as SeasonRecord;
    }
    const found = await this.seasons.findRaw(k);
    return (await this.prisma.esportSeason.findUnique({ where: { id: found.id } })) as SeasonRecord;
  }

  private async log(action: string, user: ActingUser | undefined, target?: string, details?: string) {
    try {
      await this.admin.createLog({ action, admin: user?.username ?? user?.id ?? 'admin', target, details });
    } catch (err) {
      this.logger.warn(`admin log failed: ${(err as Error)?.message}`);
    }
  }

  // ----- Overview -------------------------------------------------------------

  async overview(seasonKey?: string) {
    const now = new Date();
    const season = await this.resolveSeason(seasonKey);
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [matches, awardRows, sponsorRows, requestsNew, announcementRows, streamConfig, live] = await Promise.all([
      this.prisma.esportMatch.findMany({ where: { seasonId: season.id } }) as Promise<LeagueMatchRow[]>,
      this.prisma.seasonAward.findMany({ where: { seasonId: season.id }, select: { category: true } }),
      this.prisma.sponsor.findMany(),
      this.prisma.sponsorshipRequest.count({ where: { status: 'new' } }),
      this.prisma.post.findMany({
        where: { category: 'announcement', createdAt: { gte: weekAgo } },
        select: { createdAt: true },
      }),
      this.stream.getConfig().catch(() => null),
      this.stream.getLive().catch(() => ({ live: false, videoId: null, title: null })),
    ]);

    // Player rows per completed match: tells whether a scoresheet exists.
    const completedIds = matches.filter((m) => m.status === 'completed').map((m) => m.id);
    const playerRows = completedIds.length
      ? await this.prisma.esportMatchPlayer.groupBy({
          by: ['matchId'],
          where: { matchId: { in: completedIds } },
          _count: { _all: true },
        })
      : [];
    const playerRowsByMatch = new Map(playerRows.map((r) => [r.matchId, r._count._all]));
    const counts = countMatches(matches, playerRowsByMatch, now);

    const teamIds = new Set(matches.flatMap((m: any) => [m.teamAId, m.teamBId] as string[]));

    const [table, podiums, summaryPreview] = await Promise.all([
      this.standings.getStandings(season.id, 'league').catch(() => null),
      this.awards.podiumsOf(season, matches as any).catch(() => null),
      this.seasons.previewSummary(season.id).catch(() => null),
    ]);

    const coverage = awardsCoverage(awardRows);
    const podiumState = {
      regular: !!podiums && podiums.source.regular !== 'none',
      playoffs: !!podiums && podiums.source.playoffs !== 'none',
      source: podiums?.source ?? { regular: 'none', playoffs: 'none' },
    };
    const checklist = buildChecklist({
      seasonId: season.id,
      counts,
      awards: coverage,
      podiums: podiumState,
      summaryAvailable: !!summaryPreview,
    });

    const sponsors = filterForSeason(sponsorRows, season.id);
    const byTier = groupByTier(sponsors);
    const status = resolveStatus(season, now);

    return {
      generatedAt: now,
      season: serializeSeason(season, now),
      teams: teamIds.size,
      matches: counts,
      standings: {
        frozen: table?.frozen ?? false,
        top: (table?.rows ?? []).slice(0, TOP_STANDINGS).map((r) => ({
          rank: r.rank,
          teamId: r.teamId,
          team: r.team,
          played: r.played,
          wins: r.wins,
          losses: r.losses,
          points: r.points,
          scoreDiff: r.scoreDiff,
          form: r.form,
          qualified: r.qualified,
        })),
      },
      awards: coverage,
      podiums: podiumState,
      sponsors: {
        total: sponsors.length,
        tiers: SPONSOR_TIERS,
        byTier: Object.fromEntries(
          SPONSOR_TIERS.map((tier) => [tier, byTier[tier].map((s) => ({ id: s.id, name: s.name, logo: s.logo }))]),
        ),
        requestsNew,
      },
      announcements: { last7Days: countRecent(announcementRows, now) },
      stream: {
        configured: !!streamConfig && (!!streamConfig.channelId || !!streamConfig.youtubeChannel),
        connected: !!streamConfig?.connected,
        channel: streamConfig?.channelTitle || streamConfig?.youtubeChannel || null,
        live: !!(live as any)?.live,
        liveTitle: (live as any)?.title ?? null,
      },
      checklist: {
        items: checklist,
        ready: checklistReady(checklist),
        closable: status === 'active' || status === 'playoffs',
      },
      lastRecompute: this.lastRecompute.get(season.id) ?? null,
    };
  }

  // ----- Actions ---------------------------------------------------------------

  /** Publish an announcement on the feed (reuses the posts service). */
  async announce(dto: LeagueAnnounceDto, user: ActingUser) {
    const post = await this.posts.create(
      {
        category: 'announcement',
        title: dto.title.trim(),
        content: dto.content,
        contentFormat: dto.contentFormat ?? 'markdown',
        images: dto.images ?? [],
      },
      user,
    );
    const final = dto.pin ? await this.posts.update(post.id, { isPinned: true }, user) : post;
    await this.log('league.announce', user, post.id, dto.title.trim().slice(0, 120));
    return final;
  }

  /**
   * "Generate the stats from the matches": drops the league-stats cache and
   * replays the player counters + XP sync for every completed match of the
   * season. Every step is idempotent so the button can be pressed at will.
   */
  async recompute(seasonKey: string | undefined, user: ActingUser) {
    const season = await this.resolveSeason(seasonKey);
    const matches = await this.prisma.esportMatch.findMany({
      where: { seasonId: season.id, status: 'completed' },
      select: { id: true },
    });
    const userIds = new Set<string>();
    for (const m of matches) {
      for (const id of await this.playerStats.participantIds(m.id)) userIds.add(id);
    }
    if (userIds.size) await this.playerStats.recomputeUsers(Array.from(userIds));
    for (const m of matches) await this.gamification.syncMatch(m.id);
    this.leagueStats.invalidate();

    const at = new Date().toISOString();
    const result = { at, matches: matches.length, by: user?.username ?? null };
    this.lastRecompute.set(season.id, result);
    await this.log('league.recompute', user, season.id, `${matches.length} matches, ${userIds.size} players`);
    return { seasonId: season.id, players: userIds.size, ...result };
  }
}
