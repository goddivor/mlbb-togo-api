// Loads the (costly) facts some achievement conditions need, on demand: only
// the keys required by the definitions being evaluated are fetched.

import { PrismaService } from '../prisma/prisma.service';
import { normalizeCity, OTHER_CITY_ID } from '../geo/geo.constants';
import { MISSIONS, MIN_ACCOUNT_AGE_DAYS, dayKey } from './gamification.rules';
import { AchievementFacts, FactKey, cappedDailyCount } from './achievements.catalog';
import { parseJson } from '../common/utils/json.util';

const DAY = 86_400_000;
const MAX_ROWS = 5000;
/** Group room messages counted per day for `lounge_regular`. */
export const LOUNGE_MESSAGES_PER_DAY = 30;
const GROUP_KINDS = ['team', 'tournament', 'draft_team'] as const;

type MatchRow = {
  id: string;
  teamAId: string;
  teamBId: string;
  winnerTeamId: string | null;
  scoreA: number;
  scoreB: number;
  status: string;
  stage: string | null;
  type: string;
  format: string | null;
  games: string | null;
  scheduledAt: Date | null;
  createdAt: Date;
  seasonId: string | null;
};

/** Stage of a match (legacy rows derive it from `type`). */
export function stageOf(m: Pick<MatchRow, 'stage' | 'type'>): string {
  if (m.stage) return m.stage;
  return m.type === 'official' ? 'league' : 'scrim';
}

/** Series won after losing the first game. */
export function isRemontada(m: Pick<MatchRow, 'games' | 'winnerTeamId'>, teamId: string): boolean {
  if (m.winnerTeamId !== teamId) return false;
  const games = parseJson<any[]>(m.games ?? '[]', []);
  const first = Array.isArray(games) ? games[0] : null;
  return !!first?.winnerTeamId && first.winnerTeamId !== teamId;
}

/** BO5 won 3-0. */
export function isCleanSweep(m: Pick<MatchRow, 'format' | 'winnerTeamId' | 'teamAId' | 'scoreA' | 'scoreB'>, teamId: string): boolean {
  if (m.format !== 'bo5' || m.winnerTeamId !== teamId) return false;
  const mine = m.teamAId === teamId ? m.scoreA : m.scoreB;
  const theirs = m.teamAId === teamId ? m.scoreB : m.scoreA;
  return mine === 3 && theirs === 0;
}

export class AchievementFactsLoader {
  constructor(private prisma: PrismaService) {}

  async load(userId: string, keys: Set<FactKey>, now = new Date()): Promise<AchievementFacts> {
    const out: AchievementFacts = {};
    const jobs: Promise<void>[] = [];
    const run = (key: FactKey, fn: () => Promise<void>) => {
      if (keys.has(key)) jobs.push(fn());
    };
    run('user', async () => {
      out.user = await this.user(userId);
    });
    run('matches', async () => {
      out.matches = await this.matches(userId);
    });
    run('friends', async () => {
      out.friends = { accepted: (await this.friendIds(userId)).length };
    });
    run('messages', async () => {
      out.messages = await this.messages(userId);
    });
    run('mentions', async () => {
      out.mentions = await this.mentions(userId, now);
    });
    run('recruitment', async () => {
      const rows = await this.prisma.recruitmentApplication.findMany({ where: { userId }, select: { status: true } });
      out.recruitment = { applications: rows.length, accepted: rows.filter((r) => r.status === 'accepted').length };
    });
    run('drafts', async () => {
      out.drafts = await this.drafts(userId);
    });
    run('seasons', async () => {
      out.seasons = await this.seasons(userId);
    });
    run('logins', async () => {
      out.logins = await this.logins(userId);
    });
    run('tournamentCities', async () => {
      out.tournamentCities = await this.tournamentCities(userId);
    });
    run('likes', async () => {
      out.likes = await this.likes(userId);
    });
    run('weeklySweep', async () => {
      out.weeklySweep = await this.weeklySweep(userId);
    });
    run('team', async () => {
      const [captain, requests] = await Promise.all([
        this.prisma.esportTeamMember.findFirst({ where: { userId, isCaptain: true }, select: { id: true } }),
        this.prisma.teamRequest.findMany({ where: { requesterId: userId }, select: { createdTeamId: true } }),
      ]);
      out.team = { captain: !!captain, founder: requests.some((r) => !!r.createdTeamId) };
    });
    await Promise.all(jobs);
    return out;
  }

  private async user(userId: string): Promise<AchievementFacts['user']> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { joinedAt: true, googleId: true, mlbbRoleId: true, city: true, gamePeakRankLevel: true },
    });
    const city = normalizeCity(u?.city ?? null);
    return {
      joinedAt: u?.joinedAt ?? new Date(),
      hasGoogle: !!u?.googleId,
      hasGame: !!u?.mlbbRoleId,
      cityKnown: !!city && city.id !== OTHER_CITY_ID,
      peakRankLevel: u?.gamePeakRankLevel ?? null,
    };
  }

  private async friendIds(userId: string): Promise<string[]> {
    const rows = await this.prisma.friendship.findMany({
      where: { status: 'accepted', OR: [{ requesterId: userId }, { addresseeId: userId }] },
      select: { requesterId: true, addresseeId: true },
    });
    return [...new Set(rows.map((r) => (r.requesterId === userId ? r.addresseeId : r.requesterId)))];
  }

  private async matches(userId: string): Promise<AchievementFacts['matches']> {
    const rows = await this.prisma.esportMatchPlayer.findMany({
      where: { userId },
      select: { matchId: true, teamId: true, role: true, kills: true, deaths: true, assists: true },
      take: MAX_ROWS,
    });
    const empty = {
      flawless: false,
      maxKills: 0,
      maxAssists: 0,
      rolesWith3: 0,
      playoffs: false,
      remontada: false,
      cleanSweep: false,
      maxMatchesSameDay: 0,
      bestFriendWins: 0,
    };
    if (!rows.length) return empty;
    const matches = (await this.prisma.esportMatch.findMany({
      where: { id: { in: rows.map((r) => r.matchId) }, status: 'completed' },
    })) as unknown as MatchRow[];
    const byId = new Map(matches.map((m) => [m.id, m]));
    const out = { ...empty };
    const roles = new Map<string, number>();
    const perDay = new Map<string, number>();
    const won: { matchId: string; teamId: string }[] = [];
    for (const r of rows) {
      const m = byId.get(r.matchId);
      if (!m) continue;
      const win = m.winnerTeamId === r.teamId;
      if (win) won.push({ matchId: r.matchId, teamId: r.teamId });
      if (win && r.deaths === 0 && r.kills + r.assists >= 10) out.flawless = true;
      out.maxKills = Math.max(out.maxKills, r.kills);
      out.maxAssists = Math.max(out.maxAssists, r.assists);
      if (r.role) roles.set(r.role, (roles.get(r.role) ?? 0) + 1);
      if (stageOf(m) === 'playoff') out.playoffs = true;
      if (isRemontada(m, r.teamId)) out.remontada = true;
      if (isCleanSweep(m, r.teamId)) out.cleanSweep = true;
      const day = dayKey(m.scheduledAt ?? m.createdAt);
      perDay.set(day, (perDay.get(day) ?? 0) + 1);
    }
    out.rolesWith3 = [...roles.values()].filter((n) => n >= 3).length;
    out.maxMatchesSameDay = Math.max(0, ...perDay.values());
    if (won.length) {
      const friends = new Set(await this.friendIds(userId));
      if (friends.size) {
        const mates = await this.prisma.esportMatchPlayer.findMany({
          where: { matchId: { in: won.map((w) => w.matchId) }, userId: { in: [...friends] } },
          select: { matchId: true, teamId: true, userId: true },
        });
        const teamOf = new Map(won.map((w) => [w.matchId, w.teamId]));
        const shared = new Map<string, number>();
        for (const m of mates) {
          if (teamOf.get(m.matchId) === m.teamId) shared.set(m.userId, (shared.get(m.userId) ?? 0) + 1);
        }
        out.bestFriendWins = Math.max(0, ...shared.values());
      }
    }
    return out;
  }

  private async messages(userId: string): Promise<AchievementFacts['messages']> {
    // Only the threads the player wrote in (bounded), never every group room.
    const sent = await this.prisma.message.findMany({
      where: { senderId: userId },
      select: { threadId: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: MAX_ROWS,
    });
    if (!sent.length) return { direct: 0, groupCounted: 0 };
    const threads = await this.prisma.messageThread.findMany({
      where: { id: { in: [...new Set(sent.map((m) => m.threadId))] } },
      select: { id: true, kind: true },
    });
    // Legacy threads may miss `kind`: anything that is not a group room is direct.
    const group = new Set(threads.filter((t) => GROUP_KINDS.includes(t.kind as any)).map((t) => t.id));
    const direct = sent.filter((m) => !group.has(m.threadId)).length;
    const groupDates = sent.filter((m) => group.has(m.threadId)).map((m) => m.createdAt);
    return { direct, groupCounted: cappedDailyCount(groupDates, LOUNGE_MESSAGES_PER_DAY) };
  }

  private async mentions(userId: string, now: Date): Promise<AchievementFacts['mentions']> {
    const rows = await this.prisma.notification.findMany({
      where: { userId, type: 'mention' },
      select: { data: true },
      take: MAX_ROWS,
    });
    const byId = new Set<string>();
    const byName = new Set<string>();
    for (const r of rows) {
      const d = (r.data ?? {}) as any;
      if (typeof d.fromUserId === 'string') byId.add(d.fromUserId);
      else if (typeof d.who === 'string') byName.add(d.who);
    }
    // Mentions from accounts younger than 7 days do not count (catalogue §2.2).
    let valid = 0;
    if (byId.size) {
      valid = await this.prisma.user.count({
        where: { id: { in: [...byId] }, joinedAt: { lte: new Date(now.getTime() - MIN_ACCOUNT_AGE_DAYS * DAY) } },
      });
    }
    return { distinctAuthors: valid + byName.size };
  }

  private async drafts(userId: string): Promise<AchievementFacts['drafts']> {
    const [registrations, members] = await Promise.all([
      this.prisma.draftRegistration.count({ where: { userId } }),
      this.prisma.draftTeamMember.findMany({
        where: { userId },
        select: { tournamentId: true, teamId: true, preferredRole: true, assignedRole: true },
      }),
    ]);
    const out = { registrations, tournamentsPlayed: 0, categories: 0, wins: 0, offRoleWins: 0, championships: 0 };
    if (!members.length) return out;
    const tournamentIds = [...new Set(members.map((m) => m.tournamentId))];
    out.tournamentsPlayed = tournamentIds.length;
    const [tournaments, wins, finals] = await Promise.all([
      this.prisma.draftTournament.findMany({ where: { id: { in: tournamentIds } }, select: { category: true } }),
      this.prisma.draftMatch.findMany({
        where: { winnerTeamId: { in: members.map((m) => m.teamId) }, status: 'done' },
        select: { tournamentId: true, round: true, winnerTeamId: true, teamAId: true, teamBId: true },
      }),
      this.prisma.draftMatch.groupBy({ by: ['tournamentId'], where: { tournamentId: { in: tournamentIds } }, _max: { round: true } }),
    ]);
    out.categories = new Set(tournaments.map((t) => t.category)).size;
    const lastRound = new Map(finals.map((f) => [f.tournamentId, f._max.round ?? 0]));
    const memberOf = new Map(members.map((m) => [m.teamId, m]));
    // A bye (one team only) is not a win.
    const played = wins.filter((w) => w.teamAId && w.teamBId);
    out.wins = played.length;
    out.offRoleWins = played.filter((w) => {
      const m = memberOf.get(w.winnerTeamId!);
      return !!m && m.assignedRole !== m.preferredRole;
    }).length;
    out.championships = played.filter((w) => w.round === lastRound.get(w.tournamentId)).length;
    return out;
  }

  private async seasons(userId: string): Promise<AchievementFacts['seasons']> {
    const [rows, awards] = await Promise.all([
      this.prisma.esportMatchPlayer.findMany({ where: { userId }, select: { matchId: true }, take: MAX_ROWS }),
      this.prisma.seasonAward.findMany({ where: { userId }, select: { category: true } }),
    ]);
    let max = 0;
    if (rows.length) {
      const matches = await this.prisma.esportMatch.findMany({
        where: { id: { in: rows.map((r) => r.matchId) }, status: 'completed' },
        select: { seasonId: true, stage: true, type: true },
      });
      const perSeason = new Map<string, number>();
      for (const m of matches) {
        if (!m.seasonId || !['league', 'playoff'].includes(stageOf(m))) continue;
        perSeason.set(m.seasonId, (perSeason.get(m.seasonId) ?? 0) + 1);
      }
      max = Math.max(0, ...perSeason.values());
    }
    return { maxLeagueMatchesInSeason: max, awards: [...new Set(awards.map((a) => a.category))] };
  }

  private async logins(userId: string): Promise<AchievementFacts['logins']> {
    const rows = await this.prisma.xpEvent.findMany({
      where: { userId, type: 'daily_login' },
      select: { refId: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: MAX_ROWS,
    });
    return {
      days: rows.map((r) => r.refId),
      // 02:00-05:00 UTC (Lomé time).
      nightLogins: rows.filter((r) => {
        const h = r.createdAt.getUTCHours();
        return h >= 2 && h < 5;
      }).length,
      lastLoginAt: rows.length ? rows[rows.length - 1].createdAt : null,
    };
  }

  private async tournamentCities(userId: string): Promise<AchievementFacts['tournamentCities']> {
    const [regs, user] = await Promise.all([
      this.prisma.xpEvent.findMany({ where: { userId, type: 'tournament_registration' }, select: { refId: true } }),
      this.prisma.user.findUnique({ where: { id: userId }, select: { city: true } }),
    ]);
    const tIds = regs.map((r) => r.refId).filter((r) => !r.startsWith('draft:'));
    const dIds = regs.map((r) => r.refId).filter((r) => r.startsWith('draft:')).map((r) => r.slice(6));
    const valid = (ids: string[]) => ids.filter((id) => /^[a-f\d]{24}$/i.test(id));
    const [ts, ds] = await Promise.all([
      valid(tIds).length
        ? this.prisma.tournament.findMany({ where: { id: { in: valid(tIds) } }, select: { city: true } })
        : [],
      valid(dIds).length
        ? this.prisma.draftTournament.findMany({ where: { id: { in: valid(dIds) } }, select: { city: true } })
        : [],
    ]);
    const cities = new Set<string>();
    for (const t of [...ts, ...ds]) {
      const c = normalizeCity(t.city ?? null);
      if (c && c.id !== OTHER_CITY_ID) cities.add(c.id);
    }
    const home = normalizeCity(user?.city ?? null);
    return { home: !!home && home.id !== OTHER_CITY_ID && cities.has(home.id), distinct: cities.size };
  }

  private async likes(userId: string): Promise<AchievementFacts['likes']> {
    const rows = await this.prisma.xpEvent.findMany({
      where: { userId, type: 'like_received' },
      select: { refId: true },
      take: 20_000,
    });
    const perPost = new Map<string, number>();
    for (const r of rows) {
      const postId = r.refId.split(':')[1];
      if (postId) perPost.set(postId, (perPost.get(postId) ?? 0) + 1);
    }
    return { maxOnOnePost: Math.max(0, ...perPost.values()) };
  }

  private async weeklySweep(userId: string): Promise<boolean> {
    // weekly_bracket depends on bracket results the player does not control:
    // the sweep asks for every other weekly mission.
    const weekly = MISSIONS.filter((m) => m.period === 'weekly' && m.id !== 'weekly_bracket').map((m) => m.id);
    const rows = await this.prisma.userMission.findMany({
      where: { userId, missionId: { in: weekly } },
      select: { missionId: true, periodKey: true, completedAt: true },
    });
    const done = new Map<string, Set<string>>();
    for (const r of rows) {
      if (!r.completedAt) continue;
      done.set(r.periodKey, (done.get(r.periodKey) ?? new Set()).add(r.missionId));
    }
    return [...done.values()].some((s) => s.size >= weekly.length);
  }
}
