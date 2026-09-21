import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GamificationService } from '../gamification/gamification.service';
import { MAX_LEVEL, XpType, xpForLevel } from '../gamification/gamification.rules';
import { serializeUserCard } from '../users/users.service';
import { PUBLIC_USER_WHERE } from '../users/public-user.filter';
import { FRAMES, TITLES, badgeTierFor, framesForAchievement, getFrame } from './frames.catalog';
import {
  MvpCandidate,
  XpCandidate,
  electMonthlyNumberOne,
  electWeeklyMvp,
  previousMonth,
  previousWeek,
  weekWindow,
} from './rewards.logic';
import { RewardsService } from './rewards.service';
import {
  EndFrameDto,
  GrantFrameDto,
  MvpWeekDto,
  TournamentResultDto,
  TournamentResultKind,
  XpCorrectionDto,
} from './dto/rewards.dto';

const DAY = 86_400_000;
/** A weekly/monthly holder re-elected right after his period keeps one continuous period. */
const ELECTION_GRACE_MS = 3 * DAY;

export interface Actor {
  id: string;
  username?: string;
}

const RESULT_TYPES: Record<TournamentResultKind, XpType> = {
  winner: 'tournament_win',
  finalist: 'tournament_final',
  mvp: 'tournament_mvp',
};

/** Achievement whose frame a recorded tournament result grants. */
const RESULT_ACHIEVEMENTS: Record<TournamentResultKind, string | null> = {
  winner: 'tournament_winner',
  finalist: null,
  mvp: 'tournament_mvp',
};

@Injectable()
export class RewardsAdminService {
  private readonly logger = new Logger(RewardsAdminService.name);

  constructor(
    private prisma: PrismaService,
    private rewards: RewardsService,
    private gamification: GamificationService,
  ) {}

  // ----- Overview -----

  /** Levels 1 → 200: rewarded steps (frames, titles), badge tier, members who reached them. */
  async timeline(now = new Date()) {
    const [levels, holders] = await Promise.all([
      this.prisma.userProgress.findMany({ select: { level: true } }),
      this.activeHolders(now),
    ]);
    const reached = (l: number) => levels.filter((p) => p.level >= l).length;
    const steps = new Set<number>([1]);
    for (const f of FRAMES) if (f.level) steps.add(f.level);
    for (const t of TITLES) steps.add(t.level);
    return {
      maxLevel: MAX_LEVEL,
      members: levels.length,
      steps: [...steps]
        .sort((a, b) => a - b)
        .map((level) => ({
          level,
          xp: xpForLevel(level),
          badgeTier: badgeTierFor(level),
          reached: reached(level),
          frames: FRAMES.filter((f) => f.level === level).map((f) => ({
            ...this.rewards.serializeDef(f),
            holders: holders.get(f.id) ?? 0,
          })),
          titles: TITLES.filter((t) => t.level === level).map((t) => ({ ...t, holders: reached(level) })),
        })),
    };
  }

  /** Whole catalogue with active and all-time holder counts. */
  async frames(now = new Date()) {
    const [active, ever] = await Promise.all([
      this.activeHolders(now),
      this.prisma.userFrame.groupBy({ by: ['frameId'], _count: { _all: true } }),
    ]);
    const everMap = new Map(ever.map((e) => [e.frameId, e._count._all]));
    return FRAMES.map((f) => ({
      ...this.rewards.serializeDef(f),
      holders: active.get(f.id) ?? 0,
      everHolders: everMap.get(f.id) ?? 0,
    }));
  }

  /** Active temporary frames (holder, expiry) for the "current titles" tab. */
  async temporary(now = new Date()) {
    const tempIds = FRAMES.filter((f) => f.expiry).map((f) => f.id);
    const rows = await this.prisma.userFrame.findMany({
      where: {
        expiredAt: null,
        OR: [{ expiresAt: { gt: now } }, { frameId: { in: tempIds }, expiresAt: null }],
      },
      orderBy: { expiresAt: 'asc' },
    });
    const cards = await this.cards(rows.map((r) => r.userId));
    return rows.map((r) => ({
      ...this.rewards.serializeRow(r, now),
      user: cards.get(r.userId) ?? null,
    }));
  }

  async userCollection(userId: string) {
    return this.rewards.collection(userId);
  }

  // ----- Frames -----

  async grant(actor: Actor, dto: GrantFrameDto) {
    await this.assertUser(dto.userId);
    const res = await this.rewards.grantFrame(dto.userId, dto.frameId, {
      variant: dto.variant,
      days: dto.days,
      source: 'admin',
      sourceRef: `admin:${actor.id}`,
      grantedById: actor.id,
    });
    await this.log('rewards.frame.grant', actor, dto.userId, {
      frameId: dto.frameId,
      variant: res.variant || undefined,
      days: dto.days,
      action: res.action,
    });
    return res;
  }

  async end(actor: Actor, dto: EndFrameDto) {
    if (!getFrame(dto.frameId)) throw new BadRequestException('Cadre inconnu.');
    const res = await this.rewards.endFrame(dto.userId, dto.frameId, dto.variant ?? '');
    await this.log('rewards.frame.end', actor, dto.userId, { frameId: dto.frameId, variant: dto.variant, ended: res.ended });
    return res;
  }

  // ----- XP correction -----

  async correctXp(actor: Actor, dto: XpCorrectionDto) {
    await this.assertUser(dto.userId);
    const reason = dto.reason.trim();
    if (reason.length < 3) throw new BadRequestException('Motif obligatoire.');
    const res = await this.gamification.adjustXp(dto.userId, dto.amount, { reason, adminId: actor.id });
    await this.rewards.revalidateTitle(dto.userId);
    await this.log('rewards.xp.correction', actor, dto.userId, {
      amount: res.applied,
      reason,
      xp: `${res.previousXp} -> ${res.xp}`,
    });
    return res;
  }

  // ----- Tournament results (recorded manually) -----

  async recordTournamentResult(actor: Actor, dto: TournamentResultDto) {
    const [tournament, draft] = await Promise.all([
      this.prisma.tournament.findUnique({ where: { id: dto.tournamentId }, select: { id: true, name: true } }),
      this.prisma.draftTournament.findUnique({ where: { id: dto.tournamentId }, select: { id: true, name: true } }),
    ]);
    const target = tournament ?? draft;
    if (!target) throw new NotFoundException('Tournoi introuvable.');
    const userIds = [...new Set(dto.userIds)];
    const users = await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true } });
    if (users.length !== userIds.length) throw new BadRequestException('Membre introuvable.');

    const type = RESULT_TYPES[dto.kind];
    const achievement = RESULT_ACHIEVEMENTS[dto.kind];
    const frameIds = achievement ? framesForAchievement(achievement).map((f) => f.id) : [];
    const results = [];
    for (const userId of userIds) {
      const tracked = await this.gamification.track(userId, type, target.id);
      const frames = [];
      for (const frameId of frameIds) {
        frames.push(
          await this.rewards.grantFrame(userId, frameId, {
            source: 'award',
            sourceRef: `tournament:${target.id}:${dto.kind}`,
            grantedById: actor.id,
          }),
        );
      }
      results.push({ userId, xpGranted: tracked.granted ? tracked.amount : 0, alreadyRecorded: !tracked.granted, frames });
    }
    if (tournament && dto.kind === 'mvp' && userIds.length === 1) {
      await this.prisma.tournament.update({ where: { id: tournament.id }, data: { mvpUserId: userIds[0] } });
    }
    await this.log('rewards.tournament.result', actor, target.id, { kind: dto.kind, userIds, name: target.name });
    return { tournamentId: target.id, kind: dto.kind, results };
  }

  async tournamentResults(tournamentId?: string) {
    const rows = await this.prisma.xpEvent.findMany({
      where: {
        type: { in: Object.values(RESULT_TYPES) },
        ...(tournamentId ? { refId: tournamentId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const kindOf = new Map(Object.entries(RESULT_TYPES).map(([k, t]) => [t, k]));
    const cards = await this.cards(rows.map((r) => r.userId));
    return rows.map((r) => ({
      tournamentId: r.refId,
      kind: kindOf.get(r.type as XpType),
      userId: r.userId,
      user: cards.get(r.userId) ?? null,
      xp: r.amount,
      recordedAt: r.createdAt,
    }));
  }

  // ----- Elections -----

  /** Weekly MVP of the previous week (idempotent). */
  async electWeeklyMvp(now = new Date()) {
    const week = previousWeek(now);
    const done = await this.prisma.rewardElection.findUnique({
      where: { kind_period: { kind: 'mvp_week', period: week.key } },
    });
    if (done) return { period: week.key, userId: done.userId, alreadyDone: true };

    const window = { gte: week.start, lt: week.end };
    const [matches, mvps] = await Promise.all([
      this.prisma.xpEvent.count({ where: { type: 'match_played', createdAt: window } }),
      this.prisma.xpEvent.groupBy({
        by: ['userId'],
        where: { type: 'match_mvp', createdAt: window },
        _count: { _all: true },
        _min: { createdAt: true },
      }),
    ]);
    const eligible = await this.publicIds(mvps.map((m) => m.userId));
    const wins = eligible.size
      ? await this.prisma.xpEvent.groupBy({
          by: ['userId'],
          where: { type: 'match_win', createdAt: window, userId: { in: [...eligible] } },
          _count: { _all: true },
        })
      : [];
    const winMap = new Map(wins.map((w) => [w.userId, w._count._all]));
    const candidates: MvpCandidate[] = mvps
      .filter((m) => eligible.has(m.userId))
      .map((m) => ({
        userId: m.userId,
        mvps: m._count._all,
        wins: winMap.get(m.userId) ?? 0,
        firstMvpAt: m._min.createdAt ?? week.end,
      }));
    const winner = electWeeklyMvp(candidates, matches);
    // No official match (or no MVP yet): nothing recorded, a later run may still elect.
    if (!winner) return { period: week.key, userId: null, alreadyDone: false };

    if (!(await this.lockElection('mvp_week', week.key, winner, 'auto'))) {
      return { period: week.key, userId: winner, alreadyDone: true };
    }
    await this.rewards.grantFrame(winner, 'mvp_semaine', {
      startsAt: week.end,
      days: 7,
      continuityGraceMs: ELECTION_GRACE_MS,
      sourceRef: `mvp_week:${week.key}`,
    });
    return { period: week.key, userId: winner, alreadyDone: false };
  }

  /** Monthly number one (most XP gained during the previous month, idempotent). */
  async electMonthlyNumberOne(now = new Date()) {
    const month = previousMonth(now);
    const done = await this.prisma.rewardElection.findUnique({
      where: { kind_period: { kind: 'number_one_month', period: month.key } },
    });
    if (done) return { period: month.key, userId: done.userId, alreadyDone: true };

    const sums = await this.prisma.xpEvent.groupBy({
      by: ['userId'],
      where: { createdAt: { gte: month.start, lt: month.end } },
      _sum: { amount: true },
      _max: { createdAt: true },
    });
    const eligible = await this.publicIds(sums.map((s) => s.userId));
    const candidates: XpCandidate[] = sums
      .filter((s) => eligible.has(s.userId))
      .map((s) => ({ userId: s.userId, xp: s._sum.amount ?? 0, lastAt: s._max.createdAt ?? month.end }));
    const winner = electMonthlyNumberOne(candidates);
    if (!winner) return { period: month.key, userId: null, alreadyDone: false };

    if (!(await this.lockElection('number_one_month', month.key, winner, 'auto'))) {
      return { period: month.key, userId: winner, alreadyDone: true };
    }
    await this.rewards.grantFrame(winner, 'numero_un', {
      startsAt: month.end,
      days: 30,
      continuityGraceMs: ELECTION_GRACE_MS,
      sourceRef: `number_one_month:${month.key}`,
    });
    return { period: month.key, userId: winner, alreadyDone: false };
  }

  /** Admin override of the weekly MVP (default: previous week). */
  async setWeeklyMvp(actor: Actor, dto: MvpWeekDto, now = new Date()) {
    await this.assertUser(dto.userId);
    const week = dto.week ? weekWindow(dto.week) : previousWeek(now);
    if (!week) throw new BadRequestException('Semaine invalide.');
    const existing = await this.prisma.rewardElection.findUnique({
      where: { kind_period: { kind: 'mvp_week', period: week.key } },
    });
    if (existing?.userId === dto.userId) return { period: week.key, userId: dto.userId, changed: false };

    if (existing?.userId) {
      try {
        await this.rewards.endFrame(existing.userId, 'mvp_semaine', '', now);
      } catch (err) {
        if (!(err instanceof NotFoundException)) throw err;
      }
    }
    await this.prisma.rewardElection.upsert({
      where: { kind_period: { kind: 'mvp_week', period: week.key } },
      create: { kind: 'mvp_week', period: week.key, userId: dto.userId, source: 'admin' },
      update: { userId: dto.userId, source: 'admin' },
    });
    const grant = await this.rewards.grantFrame(dto.userId, 'mvp_semaine', {
      startsAt: week.end,
      days: 7,
      continuityGraceMs: ELECTION_GRACE_MS,
      sourceRef: `mvp_week:${week.key}`,
      grantedById: actor.id,
    });
    await this.log('rewards.mvp_week.set', actor, dto.userId, { week: week.key, previous: existing?.userId ?? null });
    return { period: week.key, userId: dto.userId, previousUserId: existing?.userId ?? null, changed: true, frame: grant };
  }

  /** True when this call created the election row (first run wins). */
  private async lockElection(kind: string, period: string, userId: string, source: string) {
    try {
      await this.prisma.rewardElection.create({ data: { kind, period, userId, source } });
      return true;
    } catch (err: any) {
      if (err?.code === 'P2002') return false;
      throw err;
    }
  }

  // ----- Recalculation (add-only) -----

  async recalculate(actor: Actor, userId?: string) {
    const ids = userId
      ? [(await this.assertUser(userId)).id]
      : (await this.prisma.userProgress.findMany({ select: { userId: true } })).map((p) => p.userId);
    let unlocked = 0;
    let frames = 0;
    for (const id of ids) {
      try {
        const before = await this.prisma.userFrame.count({ where: { userId: id } });
        const res = await this.gamification.reevaluate(id);
        unlocked += res.unlocked.length;
        await this.rewards.syncLevelFrames(id, res.level);
        const achievements = await this.prisma.userAchievement.findMany({ where: { userId: id }, select: { achievementId: true } });
        for (const a of achievements) await this.rewards.grantAchievementFrames(id, a.achievementId);
        frames += (await this.prisma.userFrame.count({ where: { userId: id } })) - before;
      } catch (err) {
        this.logger.warn(`recalculate ${id} failed: ${(err as Error)?.message}`);
      }
    }
    await this.log('rewards.recalculate', actor, userId ?? 'all', { users: ids.length, unlocked, frames });
    return { users: ids.length, achievementsUnlocked: unlocked, framesGranted: frames };
  }

  // ----- Daily job -----

  /**
   * Daily cron (idempotent): elect last week's MVP and last month's number
   * one if not done yet, expire due frames, remind frames expiring tomorrow,
   * close ended reward events.
   */
  async runDaily(now = new Date()) {
    const step = async <T>(name: string, fn: () => Promise<T>) => {
      try {
        return await fn();
      } catch (err) {
        this.logger.error(`daily ${name} failed: ${(err as Error)?.message}`);
        return { error: (err as Error)?.message ?? 'failed' };
      }
    };
    const mvpWeek = await step('mvp_week', () => this.electWeeklyMvp(now));
    const numberOne = await step('number_one', () => this.electMonthlyNumberOne(now));
    const expired = await step('expire', () => this.rewards.expireDue(now));
    const expiringSoon = await step('expiring', () => this.rewards.notifyExpiringSoon(now));
    const eventsClosed = await step('events', () => this.closeEndedEvents(now));
    return { ranAt: now, mvpWeek, numberOne, expired, expiringSoon, eventsClosed };
  }

  /** Closes scheduled/active events whose window ended (rewards pass: lot A2). */
  async closeEndedEvents(now = new Date()) {
    const { count } = await this.prisma.rewardEvent.updateMany({
      where: { status: { in: ['scheduled', 'active'] }, endsAt: { lte: now } },
      data: { status: 'closed' },
    });
    return count;
  }

  // ----- Helpers -----

  private async activeHolders(now: Date) {
    const rows = await this.prisma.userFrame.groupBy({
      by: ['frameId'],
      where: { expiredAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.frameId, r._count._all]));
  }

  private async publicIds(ids: string[]) {
    if (!ids.length) return new Set<string>();
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(ids)] }, ...PUBLIC_USER_WHERE },
      select: { id: true },
    });
    return new Set(users.map((u) => u.id));
  }

  private async cards(ids: string[]) {
    const uniq = [...new Set(ids)];
    if (!uniq.length) return new Map<string, any>();
    const users = await this.prisma.user.findMany({ where: { id: { in: uniq } } });
    return new Map(users.map((u) => [u.id, serializeUserCard(u)]));
  }

  private async assertUser(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw new NotFoundException('Utilisateur introuvable.');
    return user;
  }

  private async log(action: string, actor: Actor, target: string | undefined, details: Record<string, unknown>) {
    try {
      await this.prisma.adminLog.create({
        data: {
          action,
          admin: actor.username ?? actor.id,
          target: target ?? null,
          details: JSON.stringify(details).slice(0, 500),
        },
      });
    } catch (err) {
      this.logger.warn(`admin log failed: ${(err as Error)?.message}`);
    }
  }
}
