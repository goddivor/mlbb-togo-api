import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GamificationService } from '../gamification/gamification.service';
import { MAX_LEVEL, XpType, xpForLevel } from '../gamification/gamification.rules';
import { parseJson } from '../common/utils/json.util';
import { serializeUserCard } from '../users/users.service';
import { PUBLIC_USER_WHERE } from '../users/public-user.filter';
import { FRAMES, TITLES, badgeTierFor, framesForAchievement, getFrame, isTemporaryFrame } from './frames.catalog';
import {
  MvpCandidate,
  XpCandidate,
  electMonthlyNumberOne,
  electWeeklyMvp,
  previousMonth,
  previousWeek,
  weekWindow,
} from './rewards.logic';
import { NOT_EXPIRED, RewardsService } from './rewards.service';
import { RewardEventsService } from '../gamification/reward-events.service';
import { SeasonRewardsService } from '../gamification/season-rewards.service';
import { ACHIEVEMENTS } from '../gamification/achievements.catalog';
import {
  EndFrameDto,
  GrantFrameDto,
  MvpWeekDto,
  TournamentResultDto,
  TournamentResultKind,
  XpCorrectionDto,
} from './dto/rewards.dto';

const DAY = 86_400_000;
const OBJECT_ID = /^[a-f\d]{24}$/i;
/** A weekly/monthly holder re-elected right after his period keeps one continuous period. */
const ELECTION_GRACE_MS = 3 * DAY;
/** Users re-evaluated per page of "recalculate all" (serverless timeout). */
export const RECALCULATE_PAGE = 25;
/** Budget of the bounded steps of the daily job (Vercel stops at 60 s). */
const DAILY_BUDGET_MS = 40_000;
/** Events whose participants are rewarded by the daily job (days back). */
const EVENT_LOOKBACK_DAYS = 30;

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
    private events: RewardEventsService,
    private seasonRewards: SeasonRewardsService,
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
        AND: [NOT_EXPIRED, { OR: [{ expiresAt: { gt: now } }, { frameId: { in: tempIds }, expiresAt: null }] }],
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
    if (!OBJECT_ID.test(userId)) throw new BadRequestException('Identifiant invalide.');
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
    const frame = getFrame(dto.frameId);
    if (!frame) throw new BadRequestException('Cadre inconnu.');
    const variant = dto.variant ?? '';
    // Permanent frames are never removed (owner decision 9): only temporary
    // ones (catalogue expiry or granted with a duration) can be ended.
    const row = await this.prisma.userFrame.findUnique({
      where: { userId_frameId_variant: { userId: dto.userId, frameId: dto.frameId, variant } },
      select: { expiresAt: true },
    });
    if (row && !isTemporaryFrame(frame) && !row.expiresAt) {
      throw new BadRequestException('Un cadre permanent ne peut pas être retiré.');
    }
    const res = await this.rewards.endFrame(dto.userId, dto.frameId, variant);
    await this.log('rewards.frame.end', actor, dto.userId, { frameId: dto.frameId, variant: dto.variant, ended: res.ended });
    return res;
  }

  // ----- XP correction -----

  async correctXp(actor: Actor, dto: XpCorrectionDto) {
    await this.assertUser(dto.userId);
    const reason = dto.reason.trim();
    if (reason.length < 3) throw new BadRequestException('Motif obligatoire.');
    const res = await this.gamification.adjustXp(dto.userId, dto.amount, { reason, adminId: actor.id });
    if (res.applied === 0) throw new BadRequestException('Aucun XP à retirer pour ce membre.');
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
    // Staff stay eligible, system and banned accounts do not (like the elections).
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds }, ...PUBLIC_USER_WHERE },
      select: { id: true },
    });
    if (users.length !== userIds.length) throw new BadRequestException('Membre introuvable ou non éligible.');

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
    await this.gamification.unlockAchievement(winner, 'weekly_mvp');
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
      // Admin corrections are not XP gained by playing.
      where: { createdAt: { gte: month.start, lt: month.end }, type: { not: 'admin_correction' } },
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
    await this.gamification.unlockAchievement(winner, 'monthly_number_one');
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
    await this.gamification.unlockAchievement(dto.userId, 'weekly_mvp');
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

  /**
   * Add-only recalculation. One user, or every user with progress page by
   * page (`cursor` = last processed progress id, `nextCursor` null at the
   * end) so a request never runs into the serverless timeout.
   */
  async recalculate(actor: Actor, opts: { userId?: string; cursor?: string; limit?: number } = {}) {
    let ids: string[];
    let nextCursor: string | null = null;
    let total: number | undefined;
    if (opts.userId) {
      ids = [(await this.assertUser(opts.userId)).id];
    } else {
      const take = Math.min(100, Math.max(1, Math.floor(opts.limit ?? RECALCULATE_PAGE)));
      const rows = await this.prisma.userProgress.findMany({
        where: opts.cursor ? { id: { gt: opts.cursor } } : {},
        orderBy: { id: 'asc' },
        select: { id: true, userId: true },
        take,
      });
      ids = rows.map((r) => r.userId);
      nextCursor = rows.length === take ? rows[rows.length - 1].id : null;
      total = await this.prisma.userProgress.count();
    }
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
    if (opts.userId || !opts.cursor) {
      await this.log('rewards.recalculate', actor, opts.userId ?? 'all', { users: ids.length, unlocked, frames });
    }
    return {
      users: ids.length,
      achievementsUnlocked: unlocked,
      framesGranted: frames,
      nextCursor,
      ...(total !== undefined ? { total } : {}),
    };
  }

  // ----- Achievements -----

  /** Catalogue with unlock counts (admin "Succès" tab). */
  async achievements() {
    const stats = await this.gamification.achievementStats(true);
    return {
      members: stats.members,
      achievements: ACHIEVEMENTS.map((a) => {
        const u = stats.unlocks.get(a.id);
        return {
          id: a.id,
          family: a.family,
          rarity: a.rarity,
          icon: a.icon,
          reward: a.reward,
          secret: !!a.secret,
          manual: !!a.manual,
          frameId: framesForAchievement(a.id)[0]?.id ?? null,
          triggers: a.triggers,
          unlocks: u?.count ?? 0,
          percent: GamificationService.percent(u?.count ?? 0, stats.members),
          firstUnlockedAt: u?.first ?? null,
          lastUnlockedAt: u?.last ?? null,
        };
      }),
    };
  }

  // ----- Event participation -----

  /**
   * `event_joined` for the participants of site events whose date has come
   * (catalogue §2.1: validated at the event date). Participants may be user
   * ids, usernames or esport team ids (members). Idempotent per event.
   */
  async rewardEventParticipants(now = new Date()) {
    const since = now.getTime() - EVENT_LOOKBACK_DAYS * DAY;
    const events = await this.prisma.event.findMany({ where: { createdAt: { lte: now } } });
    let granted = 0;
    for (const e of events) {
      const at = e.date ? Date.parse(e.date) : NaN;
      if (Number.isNaN(at) || at > now.getTime() || at < since) continue;
      const raw = parseJson<any[]>(e.participants, []);
      const refs = (Array.isArray(raw) ? raw : [])
        .map((p) => (typeof p === 'string' ? p : (p?.userId ?? p?.id ?? p?.username ?? null)))
        .filter((p): p is string => typeof p === 'string' && !!p.trim());
      if (!refs.length) continue;
      const ids = refs.filter((r) => OBJECT_ID.test(r));
      const names = refs.filter((r) => !OBJECT_ID.test(r));
      const [users, members] = await Promise.all([
        this.prisma.user.findMany({
          where: { OR: [{ id: { in: ids } }, { username: { in: names } }], ...PUBLIC_USER_WHERE },
          select: { id: true },
        }),
        ids.length
          ? this.prisma.esportTeamMember.findMany({ where: { teamId: { in: ids } }, select: { userId: true } })
          : [],
      ]);
      const userIds = new Set([...users.map((u) => u.id), ...members.map((m) => m.userId)]);
      for (const userId of userIds) {
        const res = await this.gamification.trackSafe(userId, 'event_joined', e.id, { now, meta: { title: e.title } });
        if (res?.granted) granted++;
      }
    }
    return granted;
  }

  // ----- Daily job -----

  /**
   * Daily cron (idempotent): elect last week's MVP and last month's number
   * one if not done yet, expire due frames, remind frames expiring tomorrow,
   * activate / final pass / close reward events, reward the participants of
   * site events whose date has come.
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
    // Fast steps first; the unbounded ones (seasons, reward events) run
    // last with a shared deadline so the job stays under the 60 s limit.
    const deadline = Date.now() + DAILY_BUDGET_MS;
    const mvpWeek = await step('mvp_week', () => this.electWeeklyMvp(now));
    const numberOne = await step('number_one', () => this.electMonthlyNumberOne(now));
    const expired = await step('expire', () => this.rewards.expireDue(now));
    const expiringSoon = await step('expiring', () => this.rewards.notifyExpiringSoon(now));
    const eventParticipants = await step('event_participants', () => this.rewardEventParticipants(now));
    const seasons = await step('seasons', () => this.seasonRewards.applyRecent(deadline, 14, now));
    const events = await step('events', () => this.events.runDaily(now, deadline));
    return { ranAt: now, mvpWeek, numberOne, expired, expiringSoon, eventParticipants, seasons, events };
  }

  // ----- Helpers -----

  private async activeHolders(now: Date) {
    const rows = await this.prisma.userFrame.groupBy({
      by: ['frameId'],
      where: { AND: [NOT_EXPIRED, { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }] },
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
