import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { parseJson, toJson } from '../common/utils/json.util';
import {
  Participation,
  computeBadges,
  computePlayerStats,
  kdaOf,
  mergeBadges,
  resultFor,
} from './player-stats.util';
import { isHiddenAccount } from '../users/public-user.filter';

const MAX_PAGE_SIZE = 50;

@Injectable()
export class PlayerStatsService {
  constructor(private prisma: PrismaService) {}

  private async assertPlayer(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, isSystemAccount: true, badges: true },
    });
    if (!user || isHiddenAccount(user))
      throw new NotFoundException('Utilisateur introuvable.');
    return user;
  }

  /** Completed-match participations of a player, joined with their match. */
  private async loadParticipations(userId: string) {
    const rows = await this.prisma.esportMatchPlayer.findMany({
      where: { userId },
    });
    if (!rows.length) return { rows: [], matches: new Map<string, any>() };
    const matches = await this.prisma.esportMatch.findMany({
      where: { id: { in: rows.map((r) => r.matchId) }, status: 'completed' },
    });
    const mmap = new Map(matches.map((m) => [m.id, m]));
    return { rows: rows.filter((r) => mmap.has(r.matchId)), matches: mmap };
  }

  private toParticipations(rows: any[], matches: Map<string, any>): Participation[] {
    return rows.map((r) => {
      const m = matches.get(r.matchId);
      return {
        matchId: r.matchId,
        teamId: r.teamId,
        seasonId: m.seasonId ?? null,
        date: m.scheduledAt ?? m.createdAt,
        result: resultFor(m.winnerTeamId, r.teamId),
        hero: r.hero ?? null,
        role: r.role ?? null,
        kills: r.kills ?? 0,
        deaths: r.deaths ?? 0,
        assists: r.assists ?? 0,
        isMvp: !!r.isMvp,
      };
    });
  }

  private async seasonNames(ids: (string | null)[]) {
    const uniq = Array.from(new Set(ids.filter(Boolean) as string[]));
    if (!uniq.length) return new Map<string, string>();
    const seasons = await this.prisma.esportSeason.findMany({
      where: { id: { in: uniq } },
      select: { id: true, name: true },
    });
    return new Map(seasons.map((s) => [s.id, s.name]));
  }

  private async heroImages(names: (string | null)[]) {
    const uniq = Array.from(new Set(names.filter(Boolean) as string[]));
    if (!uniq.length) return new Map<string, string | null>();
    const heroes = await this.prisma.hero.findMany({
      where: { name: { in: uniq } },
      select: { name: true, image: true, thumb: true, role: true },
    });
    return new Map(heroes.map((h) => [h.name, h.thumb || h.image || null]));
  }

  /** Completed-match participations of a player (any order). */
  async getParticipations(userId: string): Promise<Participation[]> {
    const { rows, matches } = await this.loadParticipations(userId);
    return this.toParticipations(rows, matches);
  }

  /** Public aggregated stats for a player profile. */
  async getUserStats(userId: string) {
    const user = await this.assertPlayer(userId);
    const { rows, matches } = await this.loadParticipations(userId);
    const parts = this.toParticipations(rows, matches);
    const names = await this.seasonNames(parts.map((p) => p.seasonId));
    const stats = computePlayerStats(parts, names);
    const images = await this.heroImages(stats.heroes.map((h) => h.key));
    const badges = computeBadges(stats);
    return {
      ...stats,
      heroes: stats.heroes.map((h) => ({ ...h, image: images.get(h.key) ?? null })),
      badges: mergeBadges(parseJson<string[]>(user.badges, []), badges),
      earnedBadges: badges,
    };
  }

  /** Paginated completed-match history of a player (most recent first). */
  async getUserMatches(userId: string, page = 1, limit = 10) {
    await this.assertPlayer(userId);
    const take = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(limit) || 10));
    const current = Math.max(1, Math.floor(page) || 1);
    const { rows, matches } = await this.loadParticipations(userId);
    const sorted = [...rows].sort((a, b) => {
      const ma = matches.get(a.matchId);
      const mb = matches.get(b.matchId);
      const da = (ma.scheduledAt ?? ma.createdAt).getTime();
      const db = (mb.scheduledAt ?? mb.createdAt).getTime();
      return db - da;
    });
    const total = sorted.length;
    const slice = sorted.slice((current - 1) * take, current * take);
    const teamIds = slice.flatMap((r) => {
      const m = matches.get(r.matchId);
      return [m.teamAId, m.teamBId];
    });
    const teams = teamIds.length
      ? await this.prisma.esportTeam.findMany({
          where: { id: { in: Array.from(new Set(teamIds)) } },
          select: { id: true, name: true, image: true },
        })
      : [];
    const tmap = new Map(teams.map((tm) => [tm.id, tm]));
    const names = await this.seasonNames(slice.map((r) => matches.get(r.matchId).seasonId));
    const images = await this.heroImages(slice.map((r) => r.hero));

    const items = slice.map((r) => {
      const m = matches.get(r.matchId);
      const isA = m.teamAId === r.teamId;
      const opponentId = isA ? m.teamBId : m.teamAId;
      return {
        id: r.id,
        matchId: m.id,
        type: m.type,
        status: m.status,
        date: m.scheduledAt ?? m.createdAt,
        seasonId: m.seasonId ?? null,
        seasonName: m.seasonId ? names.get(m.seasonId) ?? null : null,
        team: tmap.get(r.teamId) ?? { id: r.teamId, name: '?', image: null },
        opponent: tmap.get(opponentId) ?? { id: opponentId, name: '?', image: null },
        scoreFor: isA ? m.scoreA ?? 0 : m.scoreB ?? 0,
        scoreAgainst: isA ? m.scoreB ?? 0 : m.scoreA ?? 0,
        result: resultFor(m.winnerTeamId, r.teamId),
        hero: r.hero ?? null,
        heroImage: r.hero ? images.get(r.hero) ?? null : null,
        role: r.role ?? null,
        kills: r.kills ?? 0,
        deaths: r.deaths ?? 0,
        assists: r.assists ?? 0,
        kda: kdaOf(r.kills ?? 0, r.deaths ?? 0, r.assists ?? 0),
        gold: r.gold ?? null,
        damage: r.damage ?? null,
        isMvp: !!r.isMvp,
      };
    });
    return {
      items,
      total,
      page: current,
      limit: take,
      hasMore: current * take < total,
    };
  }

  /**
   * Recomputes the denormalized counters (wins, losses, mvpCount, streak,
   * badges) of the given users from their completed esport matches. Safe to
   * call any number of times: nothing is incremented, everything is derived.
   */
  async recomputeUsers(userIds: string[]) {
    const uniq = Array.from(new Set(userIds.filter(Boolean)));
    for (const userId of uniq) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, badges: true },
      });
      if (!user) continue;
      const { rows, matches } = await this.loadParticipations(userId);
      const stats = computePlayerStats(this.toParticipations(rows, matches));
      const badges = mergeBadges(parseJson<string[]>(user.badges, []), computeBadges(stats));
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          wins: stats.wins,
          losses: stats.losses,
          mvpCount: stats.mvpCount,
          streak: stats.currentStreak,
          badges: toJson(badges),
        },
      });
    }
    return uniq.length;
  }

  /** Users that took part in a match (used to know whom to recompute). */
  async participantIds(matchId: string) {
    const rows = await this.prisma.esportMatchPlayer.findMany({
      where: { matchId },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  }
}
