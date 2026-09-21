import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PlayerStatsService } from '../stats/player-stats.service';
import { UsersService, serializeUserCard } from '../users/users.service';
import { computePlayerStats, Participation } from '../stats/player-stats.util';
import { LeaderboardMetric } from '../users/dto/leaderboard-query.dto';
import { GameService } from '../game/game.service';
import { GameSyncService } from '../game/game-sync.service';
import {
  ActivityEvent,
  UpcomingItem,
  badgeTimeline,
  countersToQuickStats,
  mergeFeed,
  parseLooseDate,
  quickStatsOf,
  rankOf,
  registeredTeamIds,
  sortUpcoming,
  startOfDay,
} from './dashboard.util';

// Every source is capped so the aggregate stays cheap whatever the account age.
const SOURCE_TAKE = 10;
const LAST_MATCHES = 5;
const LATEST_NOTIFICATIONS = 5;
const RANK_METRIC: LeaderboardMetric = 'winRate';
// Same sample floor as the /leaderboard page default: a 1-0 record is not a rank.
const RANK_MIN_GAMES = 10;
// Bracket statuses that still describe a match to come.
const PENDING_BRACKET = new Set(['pending', 'scheduled', 'live']);
// Draft tournaments the player can still expect something from.
const ACTIVE_DRAFT = ['registration', 'closed', 'drafted', 'ongoing'];

@Injectable()
export class DashboardService {
  private readonly logger = new Logger('DashboardService');

  constructor(
    private prisma: PrismaService,
    private playerStats: PlayerStatsService,
    private users: UsersService,
    @Optional() private game?: GameService,
    @Optional() private gameSync?: GameSyncService,
  ) {}

  /** Everything the dashboard widgets need, in one round trip. */
  async getDashboard(userId: string, now = new Date()) {
    // Opportunistic, non-blocking game refresh (rate-limited per user).
    void this.gameSync
      ?.maybeSyncInBackground(userId, now)
      .catch((e) => this.logger.warn(`Game auto-sync skipped: ${e?.message ?? e}`));

    const [parts, lastMatches, rank, notifications, upcoming, social, counters, game] = await Promise.all([
      this.participations(userId),
      this.lastMatches(userId),
      this.rank(userId),
      this.notifications(userId),
      this.upcoming(userId, now),
      this.socialEvents(userId),
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { wins: true, losses: true, mvpCount: true, streak: true },
      }),
      this.gameSummary(userId),
    ]);

    // Without per-match rows (legacy or seeded accounts) fall back on the
    // denormalized counters so the widget still matches the leaderboard.
    const stats = parts.length
      ? quickStatsOf(computePlayerStats(parts))
      : countersToQuickStats(counters);
    const activity = mergeFeed([
      this.matchEvents(lastMatches.feed),
      this.badgeEvents(parts),
      ...social,
    ]);

    return {
      generatedAt: now,
      quickStats: stats,
      game,
      rank,
      lastMatches: lastMatches.items,
      upcoming,
      notifications,
      activity,
    };
  }

  // ---------------------------------------------------------------- sources

  /** Cached game account data of the owner (null when unavailable). */
  private async gameSummary(userId: string) {
    if (!this.game) return null;
    try {
      return await this.game.getSummary(userId, { id: userId });
    } catch {
      return null;
    }
  }

  private async participations(userId: string): Promise<Participation[]> {
    return this.playerStats.getParticipations(userId);
  }

  /** Staff accounts have no match history: the stats service hides them. */
  private async lastMatches(userId: string) {
    try {
      const page = await this.playerStats.getUserMatches(userId, 1, SOURCE_TAKE);
      return { items: page.items.slice(0, LAST_MATCHES), feed: page.items };
    } catch (e) {
      if (e instanceof NotFoundException) return { items: [], feed: [] };
      throw e;
    }
  }

  private async rank(userId: string) {
    // The leaderboard already loads every ranked player; asking for all of
    // them costs nothing more and gives the exact position. Players under
    // the sample floor get `position: null` (the widget shows "not ranked").
    const board = await this.users.leaderboard({
      metric: RANK_METRIC,
      minGames: RANK_MIN_GAMES,
      limit: Number.MAX_SAFE_INTEGER,
    });
    const position = rankOf(board.entries, userId);
    const me = position ? board.entries[position - 1] : null;
    return {
      metric: board.metric,
      position,
      total: board.total,
      value: me ? me.winRate ?? 0 : null,
      games: me ? me.games ?? 0 : 0,
    };
  }

  private async notifications(userId: string) {
    const [unread, latest] = await Promise.all([
      this.prisma.notification.count({ where: { userId, read: false } }),
      this.prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: LATEST_NOTIFICATIONS,
      }),
    ]);
    return { unread, latest };
  }

  // --------------------------------------------------------------- upcoming

  private async upcoming(userId: string, now: Date): Promise<UpcomingItem[]> {
    const [esport, draft] = await Promise.all([
      this.esportUpcoming(userId, now),
      this.draftUpcoming(userId),
    ]);
    return sortUpcoming([...esport, ...draft], now);
  }

  /** Scheduled esport matches + tournaments of the player's esport teams. */
  private async esportUpcoming(userId: string, now: Date): Promise<UpcomingItem[]> {
    const memberships = await this.prisma.esportTeamMember.findMany({
      where: { userId },
      select: { teamId: true },
    });
    const myTeams = memberships.map((m) => m.teamId);
    if (!myTeams.length) return [];
    const mine = new Set(myTeams);
    const floor = startOfDay(now);

    const [matches, tournaments] = await Promise.all([
      this.prisma.esportMatch.findMany({
        where: {
          status: 'scheduled',
          OR: [{ teamAId: { in: myTeams } }, { teamBId: { in: myTeams } }],
          AND: [{ OR: [{ scheduledAt: { gte: floor } }, { scheduledAt: null }] }],
        },
        orderBy: [{ scheduledAt: 'asc' }],
        take: SOURCE_TAKE,
      }),
      this.prisma.tournament.findMany({
        where: { status: { in: ['upcoming', 'ongoing'] } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);

    const teamIds = new Set<string>(myTeams);
    for (const m of matches) {
      teamIds.add(m.teamAId);
      teamIds.add(m.teamBId);
    }
    const teams = await this.prisma.esportTeam.findMany({
      where: { id: { in: Array.from(teamIds) } },
      select: { id: true, name: true, image: true },
    });
    const tmap = new Map(teams.map((t) => [t.id, t]));
    const ref = (id: string | null) =>
      id ? tmap.get(id) ?? { id, name: '?', image: null } : null;

    const items: UpcomingItem[] = matches.map((m) => {
      const isA = mine.has(m.teamAId);
      const teamId = isA ? m.teamAId : m.teamBId;
      const opponentId = isA ? m.teamBId : m.teamAId;
      return {
        id: `esport:${m.id}`,
        kind: 'esport_match',
        date: m.scheduledAt ?? null,
        data: {
          matchId: m.id,
          type: m.type,
          team: ref(teamId),
          opponent: ref(opponentId),
        },
        link: `/teams/${teamId}`,
      };
    });

    for (const t of tournaments) {
      const registered = registeredTeamIds(t.registeredTeams).filter((id) => mine.has(id));
      if (!registered.length) continue;
      const myTeam = ref(registered[0]);
      items.push({
        id: `tournament:${t.id}`,
        kind: 'tournament',
        date: parseLooseDate(t.startDate),
        data: { tournamentId: t.id, name: t.name, status: t.status, team: myTeam },
        link: `/tournaments/${t.id}`,
      });
      let brackets: any[] = [];
      try {
        const parsed = JSON.parse(t.brackets || '[]');
        brackets = Array.isArray(parsed) ? parsed : [];
      } catch {
        brackets = [];
      }
      const registeredNames = this.registeredNames(t.registeredTeams);
      for (const b of brackets) {
        if (!PENDING_BRACKET.has(b?.status)) continue;
        const isA = mine.has(b.teamAId);
        const isB = mine.has(b.teamBId);
        if (!isA && !isB) continue;
        const opponentId = isA ? b.teamBId : b.teamAId;
        items.push({
          id: `bracket:${t.id}:${b.id}`,
          kind: 'tournament_match',
          date: parseLooseDate(b.scheduledAt),
          data: {
            tournamentId: t.id,
            tournamentName: t.name,
            matchId: b.id,
            round: b.round ?? null,
            status: b.status,
            team: ref(isA ? b.teamAId : b.teamBId),
            opponent: opponentId
              ? tmap.get(opponentId) ?? {
                  id: opponentId,
                  name: registeredNames.get(opponentId) ?? '?',
                  image: null,
                }
              : null,
          },
          link: `/tournaments/${t.id}`,
        });
      }
    }
    return items;
  }

  private registeredNames(raw: string): Map<string, string> {
    try {
      const parsed = JSON.parse(raw || '[]');
      if (!Array.isArray(parsed)) return new Map();
      return new Map(
        parsed
          .filter((t) => t && typeof t === 'object' && typeof t.id === 'string')
          .map((t) => [t.id, String(t.name ?? '?')]),
      );
    } catch {
      return new Map();
    }
  }

  /** Community (draft) tournaments the player joined + their pending matches. */
  private async draftUpcoming(userId: string): Promise<UpcomingItem[]> {
    const [regs, memberships] = await Promise.all([
      this.prisma.draftRegistration.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: SOURCE_TAKE,
      }),
      this.prisma.draftTeamMember.findMany({ where: { userId }, take: SOURCE_TAKE }),
    ]);
    const tournamentIds = Array.from(
      new Set([...regs.map((r) => r.tournamentId), ...memberships.map((m) => m.tournamentId)]),
    );
    if (!tournamentIds.length) return [];

    const tournaments = await this.prisma.draftTournament.findMany({
      where: { id: { in: tournamentIds }, status: { in: ACTIVE_DRAFT } },
    });
    const tmap = new Map(tournaments.map((t) => [t.id, t]));
    const items: UpcomingItem[] = [];

    for (const r of regs) {
      const t = tmap.get(r.tournamentId);
      if (!t) continue;
      items.push({
        id: `draft:${t.id}`,
        kind: 'draft_tournament',
        date: t.registrationClosesAt ?? null,
        data: {
          tournamentId: t.id,
          name: t.name,
          category: t.category,
          status: t.status,
          preferredRole: r.preferredRole,
        },
        link: `/draft/${t.id}`,
      });
    }

    const myTeamIds = memberships.map((m) => m.teamId);
    if (!myTeamIds.length) return items;
    const mine = new Set(myTeamIds);
    const matches = await this.prisma.draftMatch.findMany({
      where: {
        status: 'pending',
        OR: [{ teamAId: { in: myTeamIds } }, { teamBId: { in: myTeamIds } }],
      },
      orderBy: [{ round: 'asc' }, { position: 'asc' }],
      take: SOURCE_TAKE,
    });
    if (!matches.length) return items;
    const teamIds = Array.from(
      new Set(matches.flatMap((m) => [m.teamAId, m.teamBId]).filter((id): id is string => !!id)),
    );
    const teams = await this.prisma.draftTeam.findMany({
      where: { id: { in: teamIds } },
      select: { id: true, name: true, icon: true },
    });
    const teamMap = new Map(teams.map((t) => [t.id, t]));
    for (const m of matches) {
      const t = tmap.get(m.tournamentId);
      if (!t) continue;
      const isA = !!m.teamAId && mine.has(m.teamAId);
      const teamId = isA ? m.teamAId : m.teamBId;
      const opponentId = isA ? m.teamBId : m.teamAId;
      items.push({
        id: `draftmatch:${m.id}`,
        kind: 'draft_match',
        date: m.scheduledAt ?? null,
        data: {
          tournamentId: t.id,
          tournamentName: t.name,
          category: t.category,
          matchId: m.id,
          round: m.round,
          team: teamId ? teamMap.get(teamId) ?? { id: teamId, name: '?', icon: '' } : null,
          opponent: opponentId ? teamMap.get(opponentId) ?? { id: opponentId, name: '?', icon: '' } : null,
        },
        link: `/draft/${t.id}`,
      });
    }
    return items;
  }

  // ------------------------------------------------------------------- feed

  private matchEvents(items: any[]): ActivityEvent[] {
    return items.map((m) => ({
      id: `match:${m.matchId}`,
      type: 'match',
      date: new Date(m.date),
      data: {
        matchId: m.matchId,
        result: m.result,
        team: m.team,
        opponent: m.opponent,
        scoreFor: m.scoreFor,
        scoreAgainst: m.scoreAgainst,
        hero: m.hero,
        isMvp: m.isMvp,
      },
      link: m.team?.id ? `/teams/${m.team.id}` : null,
    }));
  }

  private badgeEvents(parts: Participation[]): ActivityEvent[] {
    return badgeTimeline(parts)
      .slice(-SOURCE_TAKE)
      .map((b) => ({
        id: `badge:${b.badge}`,
        type: 'badge',
        date: b.date,
        data: { badge: b.badge },
        link: '/profile',
      }));
  }

  /** Draft registrations, accepted friendships, posts and comments. */
  private async socialEvents(userId: string): Promise<ActivityEvent[][]> {
    const [regs, friendships, posts, comments] = await Promise.all([
      this.prisma.draftRegistration.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: SOURCE_TAKE,
      }),
      this.prisma.friendship.findMany({
        where: { status: 'accepted', OR: [{ requesterId: userId }, { addresseeId: userId }] },
        orderBy: { updatedAt: 'desc' },
        take: SOURCE_TAKE,
      }),
      this.prisma.post.findMany({
        where: { authorId: userId },
        orderBy: { createdAt: 'desc' },
        take: SOURCE_TAKE,
        select: { id: true, title: true, category: true, createdAt: true },
      }),
      this.prisma.comment.findMany({
        where: { authorId: userId },
        orderBy: { createdAt: 'desc' },
        take: SOURCE_TAKE,
        include: { post: { select: { id: true, title: true } } },
      }),
    ]);

    const tournamentIds = Array.from(new Set(regs.map((r) => r.tournamentId)));
    const friendIds = Array.from(
      new Set(friendships.map((f) => (f.requesterId === userId ? f.addresseeId : f.requesterId))),
    );
    const [tournaments, friends] = await Promise.all([
      tournamentIds.length
        ? this.prisma.draftTournament.findMany({
            where: { id: { in: tournamentIds } },
            select: { id: true, name: true, category: true },
          })
        : Promise.resolve([]),
      friendIds.length
        ? this.prisma.user.findMany({ where: { id: { in: friendIds } } })
        : Promise.resolve([]),
    ]);
    const tmap = new Map(tournaments.map((t) => [t.id, t]));
    const fmap = new Map(friends.map((u) => [u.id, serializeUserCard(u)]));

    const regEvents: ActivityEvent[] = regs
      .filter((r) => tmap.has(r.tournamentId))
      .map((r) => {
        const t = tmap.get(r.tournamentId)!;
        return {
          id: `reg:${r.id}`,
          type: 'draft_registration',
          date: r.createdAt,
          data: { tournamentId: t.id, name: t.name, category: t.category, role: r.preferredRole },
          link: `/draft/${t.id}`,
        };
      });

    const friendEvents: ActivityEvent[] = friendships.map((f) => {
      const otherId = f.requesterId === userId ? f.addresseeId : f.requesterId;
      const other = fmap.get(otherId) ?? null;
      return {
        id: `friend:${f.id}`,
        type: 'friend_accepted',
        date: f.updatedAt,
        data: {
          userId: otherId,
          name: other?.displayName ?? other?.username ?? '?',
          avatar: other?.avatar ?? null,
        },
        link: `/players/${otherId}`,
      };
    });

    const postEvents: ActivityEvent[] = posts.map((p) => ({
      id: `post:${p.id}`,
      type: 'post',
      date: p.createdAt,
      data: { postId: p.id, title: p.title, category: p.category },
      link: '/forum',
    }));

    const commentEvents: ActivityEvent[] = comments.map((c) => ({
      id: `comment:${c.id}`,
      type: 'comment',
      date: c.createdAt,
      data: { postId: c.postId, title: c.post?.title ?? '', excerpt: c.content.slice(0, 80) },
      link: '/forum',
    }));

    return [regEvents, friendEvents, postEvents, commentEvents];
  }
}
