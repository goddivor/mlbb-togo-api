import { ConflictException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CommunityService } from '../community/community.service';
import { StreamService } from '../stream/stream.service';
import { serializeUserCard } from '../users/users.service';
import { parseJson } from '../common/utils/json.util';
import {
  MIN_ACCOUNT_AGE_DAYS,
  MIN_LIKER_LEVEL,
  MISSIONS,
  RECIPROCITY_LIKES,
  RECIPROCITY_PAUSE_DAYS,
  RECIPROCITY_WINDOW_DAYS,
  RECRUITMENT_COOLDOWN_DAYS,
  SOCIAL_XP_TYPES,
  XP_LIMITS,
  XP_RULES,
  XpType,
  applyXpCaps,
  dayKey,
  friendPairKey,
  isProfileComplete,
  levelFromXp,
  levelProgress,
  missionsFor,
  peakRankTiers,
  periodEnd,
  periodKey,
  weekKey,
} from './gamification.rules';
import {
  ACHIEVEMENTS,
  AchievementContext,
  AchievementDef,
  AchievementTrigger,
  achievementsFor,
  factsNeeded,
  getAchievement,
  newlyUnlocked,
} from './achievements.catalog';
import { AchievementFactsLoader } from './achievement-facts';
import { PUBLIC_USER_WHERE, isHiddenAccount } from '../users/public-user.filter';
import { RewardsService } from '../rewards/rewards.service';
import { framesForAchievement } from '../rewards/frames.catalog';

const DAY = 86_400_000;
const RECENT_EVENTS = 20;
const MAX_LEADERBOARD = 100;
const ACHIEVEMENT_PASSES = 3;
const STATS_TTL_MS = 5 * 60_000;

export interface TrackResult {
  granted: boolean;
  amount: number;
  xp: number;
  level: number;
  leveledUp: boolean;
  unlocked: string[];
  missionsCompleted: string[];
  /** Why nothing was recorded (duplicate key or cap reached). */
  reason?: 'duplicate' | 'cap';
}

export interface TrackOptions {
  now?: Date;
  /** Short snapshot of the source, kept after the source is deleted. */
  meta?: Record<string, unknown>;
  /** Amount override (placement / category / event bonus based types). */
  amount?: number;
}

export interface UnlockOptions {
  /** Grant the frames attached to the achievement (default true). */
  frames?: boolean;
  /** Season variant for season frames (`S<n>`). */
  variant?: string | null;
  now?: Date;
}

/** Called after every recorded XP event (reward event windows). */
export type TrackListener = (userId: string, type: XpType, now: Date) => Promise<void>;

export interface AchievementStats {
  members: number;
  unlocks: Map<string, { count: number; first: Date | null; last: Date | null }>;
}

@Injectable()
export class GamificationService {
  private readonly logger = new Logger(GamificationService.name);
  private readonly facts: AchievementFactsLoader;
  private readonly listeners: TrackListener[] = [];
  private statsCache: { at: number; value: AchievementStats } | null = null;

  constructor(
    private prisma: PrismaService,
    @Optional() private community?: CommunityService,
    @Optional() private rewards?: RewardsService,
    @Optional() private stream?: StreamService,
  ) {
    this.facts = new AchievementFactsLoader(prisma);
  }

  /** Registers a listener run after each recorded XP event (never throws). */
  onTracked(listener: TrackListener) {
    this.listeners.push(listener);
  }

  // ----- Hooks (never throw: callers fire and forget) -----

  /**
   * Safe entry point for other modules. Records the event, advances missions,
   * unlocks achievements. Errors are logged and swallowed so the main action
   * (posting, registering, saving a result…) never fails because of XP.
   */
  async trackSafe(userId: string | null | undefined, type: XpType, refId: string, opts: TrackOptions = {}) {
    if (!userId) return null;
    try {
      return await this.track(userId, type, refId, opts);
    } catch (err) {
      this.logger.warn(`track ${type} for ${userId} failed: ${(err as Error)?.message}`);
      return null;
    }
  }

  /** First visit of the day (idempotent per UTC day). */
  async trackDailyLogin(userId: string | null | undefined, now = new Date()) {
    return this.trackSafe(userId, 'daily_login', dayKey(now), { now });
  }

  /**
   * Re-evaluates the achievements fed by a domain signal without XP
   * (recruitment application, team founded, profile edit…). Never throws.
   */
  async checkSafe(userId: string | null | undefined, triggers: AchievementTrigger[]) {
    if (!userId) return [];
    try {
      const unlocked = await this.evaluateAchievements(userId, triggers);
      if (unlocked.length) {
        const before = await this.progressOf(userId);
        await this.finalizeLevel(userId, before.level);
      }
      return unlocked;
    } catch (err) {
      this.logger.warn(`check ${triggers.join(',')} for ${userId} failed: ${(err as Error)?.message}`);
      return [];
    }
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

  /**
   * Like received (0 XP counter, catalogue §2.1/2.2): self-likes, likes from
   * accounts younger than 7 days or below level 3, and likes between two
   * members paused for reciprocity are ignored. One count per (post, liker),
   * even after an unlike / like again.
   */
  async trackLike(postId: string, authorId: string | null | undefined, likerId: string, now = new Date()) {
    if (!authorId || authorId === likerId) return null;
    try {
      const [liker, progress] = await Promise.all([
        this.prisma.user.findUnique({ where: { id: likerId }, select: { joinedAt: true } }),
        this.prisma.userProgress.findUnique({ where: { userId: likerId }, select: { xp: true } }),
      ]);
      if (!liker || liker.joinedAt.getTime() > now.getTime() - MIN_ACCOUNT_AGE_DAYS * DAY) return null;
      if (levelFromXp(progress?.xp ?? 0) < MIN_LIKER_LEVEL) return null;
      if (await this.likesPaused(authorId, likerId, now)) return null;
      const res = await this.track(authorId, 'like_received', `like:${postId}:${likerId}`, {
        now,
        meta: { postId, from: likerId },
      });
      if (res.granted) await this.checkReciprocity(authorId, likerId, now);
      return res;
    } catch (err) {
      this.logger.warn(`like ${postId} failed: ${(err as Error)?.message}`);
      return null;
    }
  }

  private pairPauseRef(a: string, b: string) {
    return a < b ? `${a}:${b}` : `${b}:${a}`;
  }

  private async likesPaused(a: string, b: string, now: Date) {
    const pair = this.pairPauseRef(a, b);
    const pause = await this.prisma.xpEvent.findFirst({
      where: {
        type: 'like_pause',
        userId: { in: [a, b] },
        refId: { startsWith: `${pair}:` },
        createdAt: { gte: new Date(now.getTime() - RECIPROCITY_PAUSE_DAYS * DAY) },
      },
      select: { id: true },
    });
    return !!pause;
  }

  /** More than 30 likes exchanged in 7 days pauses the pair for 30 days. */
  private async checkReciprocity(authorId: string, likerId: string, now: Date) {
    const since = new Date(now.getTime() - RECIPROCITY_WINDOW_DAYS * DAY);
    const [ab, ba] = await Promise.all([
      this.prisma.xpEvent.count({
        where: { userId: authorId, type: 'like_received', refId: { endsWith: `:${likerId}` }, createdAt: { gte: since } },
      }),
      this.prisma.xpEvent.count({
        where: { userId: likerId, type: 'like_received', refId: { endsWith: `:${authorId}` }, createdAt: { gte: since } },
      }),
    ]);
    if (ab + ba <= RECIPROCITY_LIKES) return;
    try {
      await this.prisma.xpEvent.create({
        data: {
          userId: authorId,
          type: 'like_pause',
          refId: `${this.pairPauseRef(authorId, likerId)}:${dayKey(now)}`,
          amount: 0,
          meta: { with: likerId, likes: ab + ba },
        },
      });
    } catch (err: any) {
      if (err?.code !== 'P2002') throw err;
    }
  }

  /**
   * Accepted friendship: 10 XP each, once per pair of members for life
   * (`friend:<a>:<b>`), and only when the other account is at least 7 days old.
   */
  async trackFriendship(a: string, b: string, now = new Date(), friendshipId?: string) {
    try {
      const users = await this.prisma.user.findMany({
        where: { id: { in: [a, b] } },
        select: { id: true, username: true, joinedAt: true },
      });
      const byId = new Map(users.map((u) => [u.id, u]));
      const key = friendPairKey(a, b);
      const minAge = now.getTime() - MIN_ACCOUNT_AGE_DAYS * DAY;
      for (const [me, other] of [
        [a, b],
        [b, a],
      ]) {
        const o = byId.get(other);
        if (!o || o.joinedAt.getTime() > minAge) continue;
        // Friendships accepted before #125 were keyed by the friendship id.
        if (friendshipId) {
          const legacy = await this.prisma.xpEvent.findUnique({
            where: { userId_type_refId: { userId: me, type: 'friend_added', refId: friendshipId } },
            select: { id: true },
          });
          if (legacy) continue;
        }
        await this.trackSafe(me, 'friend_added', key, { now, meta: { friendId: other, username: o.username } });
      }
    } catch (err) {
      this.logger.warn(`friendship ${a}/${b} failed: ${(err as Error)?.message}`);
    }
  }

  /**
   * First link of a game account: 100 XP, and a given `mlbbRoleId` only pays
   * once on the whole platform (unlink / relink on another profile included).
   */
  async trackGameLinked(userId: string, roleId: number | null | undefined, now = new Date()) {
    if (!roleId) return null;
    try {
      const ref = `mlbb:${roleId}`;
      const already = await this.prisma.xpEvent.findFirst({
        where: { type: 'game_account_linked', refId: ref },
        select: { userId: true },
      });
      const res = already
        ? null
        : await this.track(userId, 'game_account_linked', ref, { now, meta: { roleId } });
      if (!res?.granted) await this.checkSafe(userId, ['game_account_linked', 'profile']);
      await this.syncPeakRank(userId, now);
      return res;
    } catch (err) {
      this.logger.warn(`game link ${userId} failed: ${(err as Error)?.message}`);
      return null;
    }
  }

  /** 50 XP per new peak rank tier reached in game (once per tier). */
  async syncPeakRank(userId: string, now = new Date()) {
    try {
      const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { gamePeakRankLevel: true } });
      for (const tier of peakRankTiers(u?.gamePeakRankLevel)) {
        await this.track(userId, 'peak_rank_reached', `peak:${tier}`, { now, meta: { tier, level: u?.gamePeakRankLevel } });
      }
    } catch (err) {
      this.logger.warn(`peak rank ${userId} failed: ${(err as Error)?.message}`);
    }
  }

  /** Profile edit: completion bonus (once) and profile based achievements. */
  async syncProfile(userId: string, now = new Date()) {
    try {
      const u = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { avatar: true, gameAvatar: true, bio: true, city: true, role: true, favoriteHeroes: true },
      });
      if (u && isProfileComplete(u)) await this.track(userId, 'profile_completed', 'profile', { now });
      await this.checkSafe(userId, ['profile']);
    } catch (err) {
      this.logger.warn(`profile ${userId} failed: ${(err as Error)?.message}`);
    }
  }

  /**
   * "Watching the live" ping from the Stream page: counted at most once per
   * user and per day, and only while a live is on.
   */
  async trackSpectator(userId: string, now = new Date()) {
    const ref = dayKey(now);
    const existing = await this.prisma.xpEvent.findUnique({
      where: { userId_type_refId: { userId, type: 'stream_watch', refId: ref } },
      select: { id: true },
    });
    // getLive is cached by the stream module: cheap even when the day is already counted.
    const live = this.stream ? !!(await this.stream.getLive().catch(() => ({ live: false }))).live : false;
    let counted = false;
    if (!existing && live) counted = (await this.track(userId, 'stream_watch', ref, { now })).granted;
    const days = await this.prisma.xpEvent.count({ where: { userId, type: 'stream_watch' } });
    return { counted, live, days };
  }

  /**
   * Recruitment accepted: 100 XP to the candidate (once per team per 30
   * days) and 30 XP to the campaign creator (5 per month).
   */
  async trackRecruitment(
    app: { id: string; teamId: string; userId: string },
    recruiterId: string | null | undefined,
    now = new Date(),
  ) {
    try {
      const recent = await this.prisma.xpEvent.findFirst({
        where: {
          userId: app.userId,
          type: 'recruitment_accepted',
          refId: { startsWith: `${app.teamId}:` },
          createdAt: { gte: new Date(now.getTime() - RECRUITMENT_COOLDOWN_DAYS * DAY) },
        },
        select: { id: true },
      });
      if (!recent) {
        await this.track(app.userId, 'recruitment_accepted', `${app.teamId}:${app.id}`, {
          now,
          meta: { teamId: app.teamId, applicationId: app.id },
        });
      } else {
        await this.checkSafe(app.userId, ['recruitment']);
      }
      if (recruiterId && recruiterId !== app.userId) {
        await this.track(recruiterId, 'recruitment_hire', app.id, { now, meta: { teamId: app.teamId, candidateId: app.userId } });
      }
    } catch (err) {
      this.logger.warn(`recruitment ${app.id} failed: ${(err as Error)?.message}`);
    }
  }

  /**
   * Bracket match result: `bracket_played` (0 XP counter) for both line-ups
   * and `bracket_win` (40 XP) for the winners. Keys: `bracket:<t>:<match>`
   * (draft tournaments: `bracket:draft:<t>:<match>`).
   */
  async trackBracketResult(
    input: { tournamentId: string; matchId: string; draft?: boolean; winners: string[]; losers: string[] },
    now = new Date(),
  ) {
    const ref = `bracket:${input.draft ? 'draft:' : ''}${input.tournamentId}:${input.matchId}`;
    const meta = { tournamentId: input.tournamentId, matchId: input.matchId, draft: !!input.draft };
    for (const userId of new Set([...input.winners, ...input.losers])) {
      await this.trackSafe(userId, 'bracket_played', ref, { now, meta });
    }
    for (const userId of new Set(input.winners)) {
      await this.trackSafe(userId, 'bracket_win', ref, { now, meta });
      if (input.draft) await this.checkSafe(userId, ['draft']);
    }
  }

  // ----- Admin tools (rewards #122) -----

  /**
   * Admin XP correction (positive or negative), written as an
   * `admin_correction` XP event with its reason and author. The stored XP
   * never goes below 0: a negative correction is applied with a guarded
   * atomic update (retried on concurrent changes), and nothing is written
   * when there is nothing to apply.
   */
  async adjustXp(userId: string, amount: number, meta: { reason: string; adminId: string }, now = new Date()) {
    const requested = Math.trunc(amount);
    for (let attempt = 0; attempt < 5; attempt++) {
      const before = await this.progressOf(userId);
      const applied = Math.max(-before.xp, requested);
      if (applied === 0) {
        return { applied: 0, xp: before.xp, level: before.level, previousXp: before.xp, previousLevel: before.level };
      }
      if (applied < 0) {
        const { count } = await this.prisma.userProgress.updateMany({
          where: { userId, xp: { gte: -applied } },
          data: { xp: { increment: applied } },
        });
        if (!count) continue; // XP changed meanwhile: clamp again on the fresh value
      } else {
        await this.prisma.userProgress.upsert({
          where: { userId },
          create: { userId, xp: applied, level: levelFromXp(applied) },
          update: { xp: { increment: applied } },
        });
      }
      await this.prisma.xpEvent.create({
        data: {
          userId,
          type: 'admin_correction',
          refId: `correction:${now.getTime()}:${Math.random().toString(36).slice(2, 8)}`,
          amount: applied,
          meta: { reason: meta.reason, adminId: meta.adminId, requested },
        },
      });
      if (applied > 0) await this.evaluateAchievements(userId, ['xp'], now);
      const after = await this.finalizeLevel(userId, before.level);
      return { applied, xp: after.xp, level: after.level, previousXp: before.xp, previousLevel: before.level };
    }
    throw new ConflictException('Correction impossible : réessaie.');
  }

  /**
   * Add-only re-evaluation after a rules change: unlocks missing
   * achievements (every definition), recomputes the level and grants the
   * missing frames.
   */
  async reevaluate(userId: string) {
    const before = await this.progressOf(userId);
    const unlocked = await this.evaluateAchievements(userId, null);
    const after = await this.finalizeLevel(userId, before.level);
    return { unlocked, xp: after.xp, level: after.level };
  }

  /**
   * Unlocks an achievement granted by a dedicated flow (election, season,
   * reward event). Idempotent: false when already unlocked.
   */
  async unlockAchievement(userId: string, achievementId: string, opts: UnlockOptions = {}) {
    const def = getAchievement(achievementId);
    if (!def) return false;
    const now = opts.now ?? new Date();
    const before = await this.progressOf(userId);
    const fresh = await this.recordUnlock(userId, def, opts);
    if (!fresh) {
      // Still grant a new season variant of an owned achievement frame.
      if (opts.variant && opts.frames !== false && this.rewards) {
        await this.rewards.grantAchievementFrames(userId, def.id, opts.variant);
      }
      return false;
    }
    await this.evaluateAchievements(userId, ['achievement', 'xp'], now);
    await this.finalizeLevel(userId, before.level);
    return true;
  }

  // ----- Core -----

  /**
   * Records an XP event. Returns `granted: false` when the same
   * (user, type, refId) was already rewarded or a cap is reached.
   */
  async track(userId: string, type: XpType, refId: string, optsOrNow: TrackOptions | Date = {}): Promise<TrackResult> {
    const opts: TrackOptions = optsOrNow instanceof Date ? { now: optsOrNow } : optsOrNow;
    const now = opts.now ?? new Date();
    const before = await this.progressOf(userId);
    const none = (reason: TrackResult['reason']): TrackResult => ({
      granted: false,
      amount: 0,
      xp: before.xp,
      level: before.level,
      leveledUp: false,
      unlocked: [],
      missionsCompleted: [],
      reason,
    });

    const base = Math.max(0, Math.trunc(opts.amount ?? XP_RULES[type] ?? 0));
    const decision = await this.recordCapped(userId, type, refId, base, opts.meta, now);
    if (decision === 'duplicate' || decision === 'cap') return none(decision);

    const missionsCompleted = await this.advanceMissions(userId, type, now);
    const triggers: AchievementTrigger[] = [type];
    if (decision.amount > 0) triggers.push('xp');
    if (missionsCompleted.length) triggers.push('mission', 'xp');
    const unlocked = await this.evaluateAchievements(userId, triggers, now);
    const after = await this.finalizeLevel(userId, before.level);

    for (const listener of this.listeners) {
      try {
        await listener(userId, type, now);
      } catch (err) {
        this.logger.warn(`listener after ${type} failed: ${(err as Error)?.message}`);
      }
    }

    return {
      granted: true,
      amount: decision.amount,
      xp: after.xp,
      level: after.level,
      leveledUp: after.level > before.level,
      unlocked,
      missionsCompleted,
    };
  }

  /**
   * Records the event under the guard-rails, race free: the idempotency key
   * is reserved first (a duplicate never consumes a cap slot), then per-type
   * caps and the daily social XP use atomic counters (`XpCounter`, $inc), so
   * concurrent grants cannot exceed a cap. An event over a cap is removed.
   */
  private async recordCapped(
    userId: string,
    type: XpType,
    refId: string,
    base: number,
    meta: Record<string, unknown> | undefined,
    now: Date,
  ): Promise<{ amount: number } | 'duplicate' | 'cap'> {
    const limit = XP_LIMITS[type];
    const social = base > 0 && SOCIAL_XP_TYPES.includes(type);
    if (!limit && !social) {
      return (await this.grant(userId, type, refId, base, meta)) ? { amount: base } : 'duplicate';
    }
    if (!(await this.insertEvent(userId, type, refId, 0, meta))) return 'duplicate';

    const day = dayKey(now);
    const usage = { day: 0, week: 0, month: 0, socialToday: 0 };
    if (limit?.perDay !== undefined) usage.day = (await this.bump(userId, `cap:${type}:${day}`, 1)) - 1;
    if (limit?.perWeek !== undefined) usage.week = (await this.bump(userId, `cap:${type}:${weekKey(now)}`, 1)) - 1;
    if (limit?.perMonth !== undefined) usage.month = (await this.bump(userId, `cap:${type}:${day.slice(0, 7)}`, 1)) - 1;
    if (social) usage.socialToday = (await this.bump(userId, `social:${day}`, base)) - base;
    const decision = applyXpCaps(type, base, usage);
    if (!decision.allowed) {
      await this.prisma.xpEvent
        .delete({ where: { userId_type_refId: { userId, type, refId } } })
        .catch(() => null);
      return 'cap';
    }
    if (decision.amount > 0 || decision.capped) {
      await this.prisma.xpEvent.update({
        where: { userId_type_refId: { userId, type, refId } },
        data: {
          amount: decision.amount,
          ...(decision.capped ? { meta: { ...(meta ?? {}), capped: true, requested: base } as any } : {}),
        },
      });
    }
    if (decision.amount > 0) await this.addXp(userId, decision.amount);
    return { amount: decision.amount };
  }

  /** Atomic counter increment; returns the value after the increment. */
  private async bump(userId: string, key: string, by: number): Promise<number> {
    for (let attempt = 0; ; attempt++) {
      try {
        const row = await this.prisma.xpCounter.upsert({
          where: { userId_key: { userId, key } },
          create: { userId, key, value: by },
          update: { value: { increment: by } },
        });
        return row.value;
      } catch (err: any) {
        // Two first increments raced on the create: the second one retries as an update.
        if (err?.code !== 'P2002' || attempt >= 2) throw err;
      }
    }
  }

  /** Inserts the XP event and bumps the counter. False when duplicated. */
  private async grant(userId: string, type: string, refId: string, amount: number, meta?: Record<string, unknown>) {
    if (!(await this.insertEvent(userId, type, refId, amount, meta))) return false;
    if (amount > 0) await this.addXp(userId, amount);
    return true;
  }

  private async insertEvent(userId: string, type: string, refId: string, amount: number, meta?: Record<string, unknown>) {
    try {
      await this.prisma.xpEvent.create({
        data: { userId, type, refId, amount, ...(meta ? { meta: meta as any } : {}) },
      });
      return true;
    } catch (err: any) {
      if (err?.code === 'P2002') return false;
      throw err;
    }
  }

  private async addXp(userId: string, amount: number) {
    await this.prisma.userProgress.upsert({
      where: { userId },
      create: { userId, xp: amount, level: levelFromXp(amount) },
      update: { xp: { increment: amount } },
    });
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
    // Level frames up to the reached level (catch-up included). Never throws.
    if (row && this.rewards) await this.rewards.syncLevelFramesSafe(userId, level);
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

  private async buildContext(
    userId: string,
    defs: AchievementDef[],
    achievementCount: number,
    now: Date,
  ): Promise<AchievementContext> {
    const [progress, events, user, missions, facts] = await Promise.all([
      this.prisma.userProgress.findUnique({ where: { userId } }),
      this.prisma.xpEvent.groupBy({
        by: ['type'],
        where: { userId },
        _count: { _all: true },
      }),
      this.prisma.user.findUnique({ where: { id: userId }, select: { badges: true } }),
      this.prisma.userMission.count({ where: { userId, completedAt: { not: null } } }),
      this.facts.load(userId, factsNeeded(defs), now),
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
      achievementCount,
      now,
      facts,
    };
  }

  /**
   * Unlocks the achievements affected by `triggers` whose condition is now
   * met (`null` = every definition). Bonus XP from an unlock can satisfy
   * another condition (level, collector), hence the passes.
   */
  private async evaluateAchievements(userId: string, triggers: AchievementTrigger[] | null, now = new Date()) {
    const unlocked: string[] = [];
    let defs = achievementsFor(triggers);
    if (!defs.length) return unlocked;
    const rows = await this.prisma.userAchievement.findMany({
      where: { userId },
      select: { achievementId: true },
    });
    const have = new Set(rows.map((r) => r.achievementId));
    for (let pass = 0; pass < ACHIEVEMENT_PASSES; pass++) {
      const pending = defs.filter((d) => !have.has(d.id));
      if (!pending.length) break;
      const ctx = await this.buildContext(userId, pending, have.size, now);
      const fresh = newlyUnlocked(ctx, have, pending);
      if (!fresh.length) break;
      for (const a of fresh) {
        if (!(await this.recordUnlock(userId, a))) {
          have.add(a.id);
          continue;
        }
        have.add(a.id);
        unlocked.push(a.id);
      }
      defs = achievementsFor(['achievement', 'xp']);
    }
    return unlocked;
  }

  /** Writes the unlock, its XP bonus, the notification and the frames. */
  private async recordUnlock(userId: string, a: AchievementDef, opts: UnlockOptions = {}) {
    try {
      await this.prisma.userAchievement.create({ data: { userId, achievementId: a.id } });
    } catch (err: any) {
      if (err?.code === 'P2002') return false;
      throw err;
    }
    await this.grant(userId, 'achievement', a.id, a.reward);
    this.statsCache = null;
    await this.notify(userId, {
      type: 'achievement_unlock',
      title: 'Succès débloqué !',
      message: `Nouveau succès débloqué (+${a.reward} XP).`,
      link: '/progress',
      data: { achievementId: a.id, reward: a.reward },
    });
    // Frame attached to the achievement (frames catalogue), if any.
    if (opts.frames !== false && this.rewards) await this.rewards.grantAchievementFrames(userId, a.id, opts.variant);
    return true;
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

  /**
   * Unlock counts per achievement and number of members (users with a
   * progress row), cached a few minutes: used for the "% of members" figures.
   */
  async achievementStats(fresh = false): Promise<AchievementStats> {
    const now = Date.now();
    if (!fresh && this.statsCache && now - this.statsCache.at < STATS_TTL_MS) return this.statsCache.value;
    const [members, groups] = await Promise.all([
      this.prisma.userProgress.count(),
      this.prisma.userAchievement.groupBy({
        by: ['achievementId'],
        _count: { _all: true },
        _min: { unlockedAt: true },
        _max: { unlockedAt: true },
      }),
    ]);
    const value: AchievementStats = {
      members,
      unlocks: new Map(
        groups.map((g) => [
          g.achievementId,
          { count: g._count._all, first: g._min.unlockedAt ?? null, last: g._max.unlockedAt ?? null },
        ]),
      ),
    };
    this.statsCache = { at: now, value };
    return value;
  }

  static percent(count: number, members: number) {
    return members > 0 ? Math.round((count / members) * 1000) / 10 : 0;
  }

  private async achievementsOf(userId: string, includeSecret: boolean) {
    const [rows, stats] = await Promise.all([
      this.prisma.userAchievement.findMany({ where: { userId } }),
      this.achievementStats(),
    ]);
    const map = new Map(rows.map((r) => [r.achievementId, r.unlockedAt]));
    return ACHIEVEMENTS.filter((a) => includeSecret || !a.secret || map.has(a.id)).map((a) => {
      const unlocked = map.has(a.id);
      const hidden = !!a.secret && !unlocked;
      return {
        id: a.id,
        icon: hidden ? 'lock' : a.icon,
        reward: a.reward,
        secret: !!a.secret,
        hidden,
        unlocked,
        unlockedAt: map.get(a.id) ?? null,
        family: a.family,
        rarity: a.rarity,
        frameId: hidden ? null : (framesForAchievement(a.id)[0]?.id ?? null),
        percent: GamificationService.percent(stats.unlocks.get(a.id)?.count ?? 0, stats.members),
      };
    });
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
    const [progress, achievements, missions, events, stats] = await Promise.all([
      this.progressOf(userId),
      this.achievementsOf(userId, true),
      this.missionsOf(userId, now),
      this.prisma.xpEvent.findMany({
        // Zero-XP counters (likes, stream visits…) are not shown in the feed.
        where: { userId, amount: { not: 0 } },
        orderBy: { createdAt: 'desc' },
        take: RECENT_EVENTS,
      }),
      this.achievementStats(),
    ]);
    return {
      ...levelProgress(progress.xp),
      achievements,
      members: stats.members,
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
    const [progress, achievements, stats] = await Promise.all([
      this.progressOf(userId),
      this.achievementsOf(userId, false),
      this.achievementStats(),
    ]);
    return {
      user: serializeUserCard(user),
      ...levelProgress(progress.xp),
      achievements,
      members: stats.members,
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
