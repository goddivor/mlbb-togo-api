import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RewardsService } from '../rewards/rewards.service';
import { SEASON_VARIANT, framesForAward } from '../rewards/frames.catalog';
import { isFrameRowActive } from '../rewards/rewards.logic';
import { PUBLIC_USER_WHERE } from '../users/public-user.filter';
import { parseJson } from '../common/utils/json.util';
import { GamificationService } from './gamification.service';
import { SEASON_PODIUM_XP, seasonAwardXp } from './gamification.rules';
import { stageOf } from './achievement-facts';

type Placement = 1 | 2 | 3;

/** Time budget of the season rewards inside an admin request (ms). */
export const SEASON_REWARDS_BUDGET_MS = 20_000;
type PodiumEntry = { placement: Placement; teamId: string };

export interface SeasonFacts {
  /** Final podium: playoffs podium when present, else the regular one. */
  podium: PodiumEntry[];
  /** Regular-season standings rows (team, played, losses). */
  standings: { teamId: string; played: number; losses: number }[];
  /** League/playoff participations: userId -> teamId -> matches. */
  participations: Map<string, Map<string, number>>;
}

/** Season frame variant (`S<n>`), or null when the season has no number. */
export function seasonVariant(number: number | null | undefined): string | null {
  if (!number || number < 1) return null;
  const v = `S${number}`;
  return SEASON_VARIANT.test(v) ? v : null;
}

/** Final podium of a frozen summary (playoffs first, catalogue §3.2). */
export function finalPodium(summary: any): PodiumEntry[] {
  const list = summary?.playoffsPodium?.length ? summary.playoffsPodium : (summary?.podium ?? []);
  return (list as any[])
    .filter((p) => p && [1, 2, 3].includes(p.placement) && typeof p.teamId === 'string')
    .map((p) => ({ placement: p.placement as Placement, teamId: p.teamId }));
}

/** Players of `teamId` in the season (most matches first), for podium rewards. */
export function teamPlayers(participations: Map<string, Map<string, number>>, teamId: string): string[] {
  const out: string[] = [];
  for (const [userId, teams] of participations) if (teams.has(teamId)) out.push(userId);
  return out;
}

/**
 * Unbeaten regular season: the team lost no match of the standings and the
 * player played at least 5 league matches with it (secret `invincibles`).
 */
export function invinciblePlayers(facts: SeasonFacts, minMatches = 5): string[] {
  const unbeaten = new Set(facts.standings.filter((s) => s.played > 0 && s.losses === 0).map((s) => s.teamId));
  const out: string[] = [];
  for (const [userId, teams] of facts.participations) {
    for (const [teamId, n] of teams) if (unbeaten.has(teamId) && n >= minMatches) out.push(userId);
  }
  return [...new Set(out)];
}

/**
 * Season rewards (catalogue §2.1, §3.2, §5.3): participation, podium,
 * awards, season variant frames and the transfer of `champion_en_titre`.
 * Idempotent (XP keys, permanent frames are add-only), so it runs on close
 * and again when awards or podiums of a closed season change.
 */
@Injectable()
export class SeasonRewardsService {
  private readonly logger = new Logger(SeasonRewardsService.name);

  constructor(
    private prisma: PrismaService,
    private gamification: GamificationService,
    @Optional() private rewards?: RewardsService,
  ) {}

  async applySafe(seasonId: string, deadline?: number) {
    try {
      return await this.apply(seasonId, new Date(), deadline);
    } catch (err) {
      this.logger.warn(`season rewards ${seasonId} failed: ${(err as Error)?.message}`);
      return null;
    }
  }

  /**
   * `deadline` (epoch ms) bounds the work on serverless: the result says
   * `complete: false` and a later run (daily job) finishes, idempotently.
   */
  async apply(seasonId: string, now = new Date(), deadline = Number.POSITIVE_INFINITY) {
    const late = () => Date.now() >= deadline;
    const season = await this.prisma.esportSeason.findUnique({ where: { id: seasonId } });
    if (!season || season.status !== 'closed') return null;
    const variant = seasonVariant(season.number);
    const summary = parseJson<any>(season.summary ?? 'null', null);
    const facts = await this.facts(seasonId, summary);
    const publicIds = await this.publicIds([...facts.participations.keys()]);
    const out = { participants: 0, podium: 0, champions: [] as string[], awards: 0, invincibles: 0, complete: false };

    // Participation: at least one league/playoff match in the closed season.
    for (const userId of facts.participations.keys()) {
      if (late()) return out;
      if (!publicIds.has(userId)) continue;
      const res = await this.gamification.trackSafe(userId, 'season_participation', seasonId, {
        now,
        meta: { season: season.name },
      });
      if (res?.granted) out.participants++;
    }

    // Podium (team members who played for the team in the season).
    for (const p of facts.podium) {
      let members = teamPlayers(facts.participations, p.teamId).filter((u) => publicIds.has(u));
      if (!members.length) members = await this.roster(p.teamId);
      for (const userId of members) {
        if (late()) return out;
        const res = await this.gamification.trackSafe(userId, 'season_podium', seasonId, {
          now,
          amount: SEASON_PODIUM_XP[p.placement],
          meta: { season: season.name, place: p.placement, teamId: p.teamId },
        });
        if (res?.granted) out.podium++;
        if (p.placement === 1) {
          out.champions.push(userId);
          // 0 XP title counter: season_champion / dynasty achievements.
          await this.gamification.trackSafe(userId, 'season_win', seasonId, { now, meta: { season: season.name } });
          if (variant && this.rewards) {
            await this.rewards.grantFrameSafe(userId, 'champion_saison', {
              variant,
              source: 'award',
              sourceRef: `season:${seasonId}`,
            });
          }
        }
      }
    }
    await this.transferReigningChampion(season, out.champions);

    // Awards: XP by category, season variant frames, achievements.
    const awards = await this.prisma.seasonAward.findMany({ where: { seasonId } });
    for (const a of awards) {
      if (late()) return out;
      if (!a.userId) continue;
      const res = await this.gamification.trackSafe(a.userId, 'season_award', a.id, {
        now,
        amount: seasonAwardXp(a.category),
        meta: { season: season.name, category: a.category, title: a.title ?? null },
      });
      if (res?.granted) out.awards++;
      if (variant && this.rewards) {
        const frames = a.category === 'mvp' ? ['mvp_saison'] : framesForAward(a.category).map((f) => f.id);
        for (const frameId of frames) {
          await this.rewards.grantFrameSafe(a.userId, frameId, { variant, source: 'award', sourceRef: `award:${a.id}` });
        }
      }
      await this.gamification.checkSafe(a.userId, ['season']);
    }

    for (const userId of invinciblePlayers(facts)) {
      if (late()) return out;
      if (!publicIds.has(userId)) continue;
      if (await this.gamification.unlockAchievement(userId, 'invincibles', { now })) out.invincibles++;
    }
    out.complete = true;
    return out;
  }

  /**
   * Daily catch-up: re-applies (idempotently) the rewards of the seasons
   * closed in the last `days` days, in case a request was cut off.
   */
  async applyRecent(deadline: number, days = 14, now = new Date()) {
    const seasons = await this.prisma.esportSeason.findMany({
      where: { status: 'closed', closedAt: { gte: new Date(now.getTime() - days * 86_400_000) } },
      select: { id: true },
      orderBy: { closedAt: 'asc' },
    });
    let complete = 0;
    for (const s of seasons) {
      if (Date.now() >= deadline) break;
      const res = await this.applySafe(s.id, deadline);
      if (res?.complete) complete++;
    }
    return { seasons: seasons.length, complete };
  }

  /**
   * `champion_en_titre` follows the champions of the most recently closed
   * season: holders who are not champions any more lose it, new champions
   * get it (a champion who wins again keeps one continuous period).
   */
  private async transferReigningChampion(season: { id: string; closedAt: Date | null }, champions: string[]) {
    if (!this.rewards || !champions.length) return;
    const latest = await this.prisma.esportSeason.findFirst({
      where: { status: 'closed' },
      orderBy: { closedAt: 'desc' },
      select: { id: true },
    });
    if (latest?.id !== season.id) return;
    const holders = await this.prisma.userFrame.findMany({
      where: { frameId: 'champion_en_titre', variant: '' },
    });
    const keep = new Set(champions);
    for (const h of holders) {
      if (!keep.has(h.userId) && isFrameRowActive(h)) {
        await this.rewards.endFrame(h.userId, 'champion_en_titre', '').catch(() => null);
      }
    }
    for (const userId of keep) {
      await this.rewards.grantFrameSafe(userId, 'champion_en_titre', {
        source: 'award',
        sourceRef: `season:${season.id}`,
      });
    }
  }

  private async facts(seasonId: string, summary: any): Promise<SeasonFacts> {
    const matches = await this.prisma.esportMatch.findMany({
      where: { seasonId, status: 'completed' },
      select: { id: true, stage: true, type: true },
    });
    const league = matches.filter((m) => ['league', 'playoff'].includes(stageOf(m)));
    const rows = league.length
      ? await this.prisma.esportMatchPlayer.findMany({
          where: { matchId: { in: league.map((m) => m.id) } },
          select: { userId: true, teamId: true },
        })
      : [];
    const participations = new Map<string, Map<string, number>>();
    for (const r of rows) {
      const teams = participations.get(r.userId) ?? new Map<string, number>();
      teams.set(r.teamId, (teams.get(r.teamId) ?? 0) + 1);
      participations.set(r.userId, teams);
    }
    const standings = ((summary?.standings ?? []) as any[])
      .filter((s) => typeof s?.teamId === 'string')
      .map((s) => ({ teamId: s.teamId, played: Number(s.played) || 0, losses: Number(s.losses) || 0 }));
    return { podium: finalPodium(summary), standings, participations };
  }

  private async roster(teamId: string) {
    const members = await this.prisma.esportTeamMember.findMany({
      where: { teamId, isSubstitute: false },
      select: { userId: true },
    });
    const ids = await this.publicIds(members.map((m) => m.userId));
    return [...ids];
  }

  private async publicIds(ids: string[]) {
    if (!ids.length) return new Set<string>();
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(ids)] }, ...PUBLIC_USER_WHERE },
      select: { id: true },
    });
    return new Set(users.map((u) => u.id));
  }
}
