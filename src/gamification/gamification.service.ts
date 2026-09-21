import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CommunityService } from '../community/community.service';
import { serializeUserCard } from '../users/users.service';
import { parseJson } from '../common/utils/json.util';
import {
  ACHIEVEMENTS,
  AchievementContext,
  MISSIONS,
  XP_RULES,
  XpType,
  dayKey,
  levelFromXp,
  levelProgress,
  missionsFor,
  newlyUnlocked,
  periodEnd,
  periodKey,
} from './gamification.rules';
import { PUBLIC_USER_WHERE, isHiddenAccount } from '../users/public-user.filter';

const RECENT_EVENTS = 20;
const MAX_LEADERBOARD = 100;
const ACHIEVEMENT_PASSES = 3;

export interface TrackResult {
  granted: boolean;
  amount: number;
  xp: number;
  level: number;
  leveledUp: boolean;
  unlocked: string[];
  missionsCompleted: string[];
}

@Injectable()
export class GamificationService {
  private readonly logger = new Logger(GamificationService.name);

  constructor(
    private prisma: PrismaService,
    @Optional() private community?: CommunityService,
  ) {}

  // ----- Hooks (never throw: callers fire and forget) -----

  /**
   * Safe entry point for other modules. Records the event, advances missions,
   * unlocks achievements. Errors are logged and swallowed so the main action
   * (posting, registering, saving a result…) never fails because of XP.
   */
  async trackSafe(userId: string | null | undefined, type: XpType, refId: string) {
    if (!userId) return null;
    try {
      return await this.track(userId, type, refId);
    } catch (err) {
      this.logger.warn(`track ${type} for ${userId} failed: ${(err as Error)?.message}`);
      return null;
    }
  }

  /** First visit of the day (idempotent per UTC day). */
  async trackDailyLogin(userId: string | null | undefined, now = new Date()) {
    return this.trackSafe(userId, 'daily_login', dayKey(now));
  }

  /**
   * Grants match XP to every participant of a completed esport match. Safe to
   * call after each result/players update: grants are keyed by match id.
   */
  async syncMatch(matchId: string) {
    try {
      const m = await this.prisma.esportMatch.findUnique({ where: { id: matchId } });
      if (!m || m.status !== 'completed') return;
      const players = await this.prisma.esportMatchPlayer.findMany({ where: { matchId } });
      for (const p of players) {
        await this.track(p.userId, 'match_played', matchId);
        if (m.winnerTeamId && m.winnerTeamId === p.teamId)
          await this.track(p.userId, 'match_win', matchId);
        if (p.isMvp) await this.track(p.userId, 'match_mvp', matchId);
      }
    } catch (err) {
      this.logger.warn(`syncMatch ${matchId} failed: ${(err as Error)?.message}`);
    }
  }

  // ----- Core -----

  /**
   * Records an XP event. Returns `granted: false` when the same
   * (user, type, refId) was already rewarded.
   */
  async track(userId: string, type: XpType, refId: string, now = new Date()): Promise<TrackResult> {
    const before = await this.progressOf(userId);
    const amount = XP_RULES[type] ?? 0;
    const granted = await this.grant(userId, type, refId, amount);
    if (!granted) {
      return {
        granted: false,
        amount: 0,
        xp: before.xp,
        level: before.level,
        leveledUp: false,
        unlocked: [],
        missionsCompleted: [],
      };
    }

    const missionsCompleted = await this.advanceMissions(userId, type, now);
    const unlocked = await this.evaluateAchievements(userId);
    const after = await this.finalizeLevel(userId, before.level);

    return {
      granted: true,
      amount,
      xp: after.xp,
      level: after.level,
      leveledUp: after.level > before.level,
      unlocked,
      missionsCompleted,
    };
  }

  /** Inserts the XP event and bumps the counter. False when duplicated. */
  private async grant(userId: string, type: string, refId: string, amount: number) {
    try {
      await this.prisma.xpEvent.create({ data: { userId, type, refId, amount } });
    } catch (err: any) {
      if (err?.code === 'P2002') return false;
      throw err;
    }
    if (amount > 0) {
      await this.prisma.userProgress.upsert({
        where: { userId },
        create: { userId, xp: amount, level: levelFromXp(amount) },
        update: { xp: { increment: amount } },
      });
    }
    return true;
  }

  private async progressOf(userId: string) {
    const row = await this.prisma.userProgress.findUnique({ where: { userId } });
    return { xp: row?.xp ?? 0, level: row?.level ?? 1 };
  }

  /** Recomputes the stored level from XP and notifies on level up. */
  private async finalizeLevel(userId: string, previousLevel: number) {
    const row = await this.prisma.userProgress.findUnique({ where: { userId } });
    const xp = row?.xp ?? 0;
    const level = levelFromXp(xp);
    let raised = false;
    if (row && level > row.level) {
      // Guarded write: only the call that actually raises the stored level
      // notifies, so concurrent grants (same match result submitted twice in
      // parallel) never send duplicate level-up notifications.
      const { count } = await this.prisma.userProgress.updateMany({
        where: { userId, level: { lt: level } },
        data: { level },
      });
      raised = count > 0;
    } else if (row && level < row.level) {
      await this.prisma.userProgress.update({ where: { userId }, data: { level } });
    }
    if (raised && level > previousLevel) {
      await this.notify(userId, {
        type: 'level_up',
        title: 'Niveau supérieur !',
        message: `Tu viens d'atteindre le niveau ${level}.`,
        link: '/progress',
        data: { level },
      });
    }
    return { xp, level };
  }

  /** Advances every mission fed by `type` for the current period. */
  private async advanceMissions(userId: string, type: XpType, now = new Date()) {
    const completed: string[] = [];
    for (const m of missionsFor(type)) {
      const key = periodKey(m.period, now);
      const row = await this.prisma.userMission.upsert({
        where: { userId_missionId_periodKey: { userId, missionId: m.id, periodKey: key } },
        create: { userId, missionId: m.id, periodKey: key, progress: 1 },
        update: { progress: { increment: 1 } },
      });
      if (row.completedAt || row.progress < m.target) continue;
      await this.prisma.userMission.update({
        where: { id: row.id },
        data: { completedAt: now },
      });
      await this.grant(userId, 'mission', `${m.id}:${key}`, m.reward);
      completed.push(m.id);
    }
    return completed;
  }

  private async buildContext(userId: string): Promise<AchievementContext> {
    const [progress, events, user, missions] = await Promise.all([
      this.prisma.userProgress.findUnique({ where: { userId } }),
      this.prisma.xpEvent.groupBy({
        by: ['type'],
        where: { userId },
        _count: { _all: true },
      }),
      this.prisma.user.findUnique({ where: { id: userId }, select: { badges: true } }),
      this.prisma.userMission.count({ where: { userId, completedAt: { not: null } } }),
    ]);
    const counts: AchievementContext['counts'] = {};
    for (const e of events) counts[e.type as XpType] = e._count._all;
    const xp = progress?.xp ?? 0;
    return {
      xp,
      level: levelFromXp(xp),
      counts,
      missionsCompleted: missions,
      badges: parseJson<string[]>(user?.badges ?? '[]', []),
    };
  }

  /**
   * Unlocks every achievement whose condition is now met. Bonus XP from an
   * unlock can satisfy another condition (level based), hence the passes.
   */
  private async evaluateAchievements(userId: string) {
    const unlocked: string[] = [];
    const rows = await this.prisma.userAchievement.findMany({
      where: { userId },
      select: { achievementId: true },
    });
    const have = new Set(rows.map((r) => r.achievementId));
    for (let pass = 0; pass < ACHIEVEMENT_PASSES; pass++) {
      const ctx = await this.buildContext(userId);
      const fresh = newlyUnlocked(ctx, have);
      if (!fresh.length) break;
      for (const a of fresh) {
        try {
          await this.prisma.userAchievement.create({
            data: { userId, achievementId: a.id },
          });
        } catch (err: any) {
          if (err?.code === 'P2002') continue;
          throw err;
        }
        have.add(a.id);
        unlocked.push(a.id);
        await this.grant(userId, 'achievement', a.id, a.reward);
        await this.notify(userId, {
          type: 'achievement_unlock',
          title: 'Succès débloqué !',
          message: `Nouveau succès débloqué (+${a.reward} XP).`,
          link: '/progress',
          data: { achievementId: a.id, reward: a.reward },
        });
      }
    }
    return unlocked;
  }

  private async notify(
    userId: string,
    data: { type: string; title: string; message: string; link?: string; data?: any },
  ) {
    if (!this.community) return;
    try {
      await this.community.notifyUser(userId, data);
    } catch (err) {
      this.logger.warn(`notify ${data.type} failed: ${(err as Error)?.message}`);
    }
  }

  // ----- Read API -----

  private async assertUser(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || isHiddenAccount(user))
      throw new NotFoundException('Utilisateur introuvable.');
    return user;
  }

  private async achievementsOf(userId: string, includeSecret: boolean) {
    const rows = await this.prisma.userAchievement.findMany({ where: { userId } });
    const map = new Map(rows.map((r) => [r.achievementId, r.unlockedAt]));
    return ACHIEVEMENTS.filter((a) => includeSecret || !a.secret || map.has(a.id)).map((a) => ({
      id: a.id,
      icon: a.icon,
      reward: a.reward,
      secret: !!a.secret,
      unlocked: map.has(a.id),
      unlockedAt: map.get(a.id) ?? null,
    }));
  }

  private async missionsOf(userId: string, now = new Date()) {
    const keys = { daily: periodKey('daily', now), weekly: periodKey('weekly', now) };
    const rows = await this.prisma.userMission.findMany({
      where: { userId, periodKey: { in: [keys.daily, keys.weekly] } },
    });
    const map = new Map(rows.map((r) => [`${r.missionId}:${r.periodKey}`, r]));
    return MISSIONS.map((m) => {
      const key = keys[m.period];
      const row = map.get(`${m.id}:${key}`);
      const progress = Math.min(m.target, row?.progress ?? 0);
      return {
        id: m.id,
        period: m.period,
        event: m.event,
        icon: m.icon,
        target: m.target,
        reward: m.reward,
        progress,
        completed: !!row?.completedAt || progress >= m.target,
        completedAt: row?.completedAt ?? null,
        periodKey: key,
        resetsAt: periodEnd(m.period, now),
      };
    });
  }

  /** Full progression of the current user. */
  async getMe(userId: string, now = new Date()) {
    const [progress, achievements, missions, events] = await Promise.all([
      this.progressOf(userId),
      this.achievementsOf(userId, true),
      this.missionsOf(userId, now),
      this.prisma.xpEvent.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: RECENT_EVENTS,
      }),
    ]);
    return {
      ...levelProgress(progress.xp),
      achievements,
      missions,
      recentEvents: events.map((e) => ({
        id: e.id,
        type: e.type,
        amount: e.amount,
        refId: e.refId,
        createdAt: e.createdAt,
      })),
      xpRules: XP_RULES,
    };
  }

  /** Public subset shown on another player's profile. */
  async getPublic(userId: string) {
    const user = await this.assertUser(userId);
    const [progress, achievements] = await Promise.all([
      this.progressOf(userId),
      this.achievementsOf(userId, false),
    ]);
    return {
      user: serializeUserCard(user),
      ...levelProgress(progress.xp),
      achievements,
      achievementsUnlocked: achievements.filter((a) => a.unlocked).length,
      achievementsTotal: ACHIEVEMENTS.length,
    };
  }

  /** Lightweight level for cards (null when the user has no progress yet). */
  async levelsOf(userIds: string[]) {
    const uniq = Array.from(new Set(userIds.filter(Boolean)));
    if (!uniq.length) return new Map<string, { xp: number; level: number }>();
    const rows = await this.prisma.userProgress.findMany({
      where: { userId: { in: uniq } },
      select: { userId: true, xp: true, level: true },
    });
    return new Map(rows.map((r) => [r.userId, { xp: r.xp, level: r.level }]));
  }

  /** Top players by XP. */
  async leaderboard(limit = 20) {
    const take = Math.min(MAX_LEADERBOARD, Math.max(1, Math.floor(limit) || 20));
    const rows = await this.prisma.userProgress.findMany({
      orderBy: [{ xp: 'desc' }, { updatedAt: 'asc' }],
      take: take * 2,
    });
    const users = rows.length
      ? await this.prisma.user.findMany({
          where: {
            id: { in: rows.map((r) => r.userId) },
            ...PUBLIC_USER_WHERE,
          },
        })
      : [];
    const umap = new Map(users.map((u) => [u.id, u]));
    const entries = rows
      .filter((r) => umap.has(r.userId))
      .slice(0, take)
      .map((r, i) => ({
        rank: i + 1,
        xp: r.xp,
        level: levelFromXp(r.xp),
        user: serializeUserCard(umap.get(r.userId)),
      }));
    return { entries, total: entries.length };
  }
}
