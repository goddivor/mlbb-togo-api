import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RewardsService } from '../rewards/rewards.service';
import { getFrame } from '../rewards/frames.catalog';
import { PUBLIC_USER_WHERE } from '../users/public-user.filter';
import { GamificationService } from './gamification.service';
import { XpType } from './gamification.rules';
import { getAchievement } from './achievements.catalog';
import {
  ConditionProgress,
  EventCondition,
  EventConditions,
  EventRewards,
  EventShape,
  addYear,
  defaultEvents,
  isEvaluating,
  isQualified,
  isWindowOpen,
  nextEditionSlug,
  nextStatus,
  parseConditions,
  parseRewards,
  refFilter,
  validateEvent,
  wideningViolations,
  withProgress,
} from './reward-events.logic';

const CACHE_MS = 60_000;
/** Users rewarded per final pass (the daily job continues with the rest). */
const FINAL_PASS_BATCH = 300;
const ELIGIBLE_SCAN = 1000;

export interface Actor {
  id: string;
  username?: string;
}

export interface RewardEventInput {
  slug?: string;
  name?: string;
  description?: string | null;
  startsAt?: string | Date;
  endsAt?: string | Date;
  recurrence?: 'none' | 'yearly';
  status?: 'draft' | 'scheduled';
  conditionMode?: 'all' | 'any';
  conditions?: Partial<EventCondition>[];
  rewards?: Partial<EventRewards>;
}

type EventRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  startsAt: Date;
  endsAt: Date;
  recurrence: string;
  conditions: unknown;
  rewards: unknown;
  status: string;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const SLUG = /^[a-z0-9][a-z0-9_-]{1,63}$/;

function shapeOf(row: Pick<EventRow, 'startsAt' | 'endsAt' | 'status' | 'conditions' | 'rewards'>): EventShape {
  return {
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    status: row.status,
    conditions: parseConditions(row.conditions),
    rewards: parseRewards(row.rewards),
  };
}

const known = {
  achievement: (id: string) => !!getAchievement(id),
  frame: (id: string) => !!getFrame(id),
};

/**
 * Reward events (catalogue §6.5): admin CRUD, evaluation during the window
 * (on each relevant XP event) and final pass at the close (daily job).
 * Rewards are idempotent per (user, event) through an `event_reward` XP
 * event keyed by the event id.
 */
@Injectable()
export class RewardEventsService implements OnModuleInit {
  private readonly logger = new Logger(RewardEventsService.name);
  private cache: { at: number; rows: EventRow[] } | null = null;

  constructor(
    private prisma: PrismaService,
    private gamification: GamificationService,
    @Optional() private rewards?: RewardsService,
  ) {}

  onModuleInit() {
    this.gamification.onTracked((userId, type, now) => this.onTracked(userId, type, now));
  }

  // ----- Serialization -----

  serialize(row: EventRow, awarded = 0, now = new Date()) {
    const shape = shapeOf(row);
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      recurrence: row.recurrence,
      status: row.status,
      open: isWindowOpen(row, now),
      conditionMode: shape.conditions.mode,
      conditions: shape.conditions.items,
      rewards: shape.rewards,
      awarded,
      createdById: row.createdById,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  // ----- Admin CRUD -----

  async list(now = new Date()) {
    const [rows, awarded] = await Promise.all([
      this.prisma.rewardEvent.findMany({ orderBy: { startsAt: 'desc' } }),
      this.prisma.xpEvent.groupBy({ by: ['refId'], where: { type: 'event_reward' }, _count: { _all: true } }),
    ]);
    const counts = new Map(awarded.map((a) => [a.refId, a._count._all]));
    return (rows as EventRow[]).map((r) => this.serialize(r, counts.get(r.id) ?? 0, now));
  }

  private async find(id: string) {
    if (!/^[a-f\d]{24}$/i.test(id)) throw new NotFoundException('Événement introuvable.');
    const row = (await this.prisma.rewardEvent.findUnique({ where: { id } })) as EventRow | null;
    if (!row) throw new NotFoundException('Événement introuvable.');
    return row;
  }

  private toShape(input: RewardEventInput, base?: EventShape): EventShape {
    const conditions: EventConditions =
      input.conditions !== undefined || input.conditionMode !== undefined
        ? parseConditions({
            mode: input.conditionMode ?? base?.conditions.mode ?? 'all',
            items: input.conditions ?? base?.conditions.items ?? [],
          })
        : (base?.conditions ?? { mode: 'all', items: [] });
    return {
      startsAt: input.startsAt !== undefined ? new Date(input.startsAt) : (base?.startsAt ?? new Date(NaN)),
      endsAt: input.endsAt !== undefined ? new Date(input.endsAt) : (base?.endsAt ?? new Date(NaN)),
      status: input.status ?? base?.status ?? 'draft',
      conditions,
      rewards: input.rewards !== undefined ? parseRewards({ ...(base?.rewards ?? {}), ...input.rewards }) : (base?.rewards ?? parseRewards({})),
    };
  }

  async create(actor: Actor, input: RewardEventInput) {
    const slug = (input.slug ?? '').trim().toLowerCase();
    if (!SLUG.test(slug)) throw new BadRequestException('Identifiant (slug) invalide.');
    const name = (input.name ?? '').trim();
    if (!name) throw new BadRequestException('Le nom est requis.');
    const shape = this.toShape(input);
    const errors = validateEvent(shape, known, shape.status !== 'draft');
    if (errors.length) throw new BadRequestException(errors.join(' '));
    const exists = await this.prisma.rewardEvent.findUnique({ where: { slug }, select: { id: true } });
    if (exists) throw new ConflictException('Cet identifiant existe déjà.');
    const row = (await this.prisma.rewardEvent.create({
      data: {
        slug,
        name,
        description: input.description?.trim() || null,
        startsAt: shape.startsAt,
        endsAt: shape.endsAt,
        recurrence: input.recurrence === 'yearly' ? 'yearly' : 'none',
        status: shape.status === 'scheduled' ? 'scheduled' : 'draft',
        conditions: shape.conditions as any,
        rewards: shape.rewards as any,
        createdById: actor.id,
      },
    })) as EventRow;
    this.cache = null;
    await this.log('rewards.event.create', actor, row.id, { slug, status: row.status });
    return this.serialize(row);
  }

  /**
   * Updates an event. Closed events are read-only; an open window (started,
   * published) may only be widened.
   */
  async update(actor: Actor, id: string, input: RewardEventInput, now = new Date()) {
    const row = await this.find(id);
    if (row.status === 'closed') throw new BadRequestException('Un événement clôturé ne peut plus être modifié.');
    const prev = shapeOf(row);
    const next = this.toShape(input, prev);
    const open = isWindowOpen(row, now);
    if (open && input.status === 'draft') throw new BadRequestException('Un événement en cours ne peut pas repasser en brouillon.');
    if (open) next.status = row.status;
    const errors = validateEvent(next, known, next.status !== 'draft');
    if (errors.length) throw new BadRequestException(errors.join(' '));
    if (open) {
      const violations = wideningViolations(prev, next);
      if (violations.length) {
        throw new BadRequestException(`Un événement en cours ne peut qu’être élargi. ${violations.join(' ')}`);
      }
    }
    const data: any = {
      startsAt: next.startsAt,
      endsAt: next.endsAt,
      conditions: next.conditions,
      rewards: next.rewards,
    };
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw new BadRequestException('Le nom est requis.');
      data.name = name;
    }
    if (input.description !== undefined) data.description = input.description?.trim() || null;
    if (input.recurrence !== undefined) data.recurrence = input.recurrence === 'yearly' ? 'yearly' : 'none';
    if (!open && input.status !== undefined) data.status = input.status === 'scheduled' ? 'scheduled' : 'draft';
    if (input.slug !== undefined && input.slug !== row.slug) {
      if (open) throw new BadRequestException('L’identifiant d’un événement en cours ne peut pas changer.');
      const slug = input.slug.trim().toLowerCase();
      if (!SLUG.test(slug)) throw new BadRequestException('Identifiant (slug) invalide.');
      const exists = await this.prisma.rewardEvent.findUnique({ where: { slug }, select: { id: true } });
      if (exists) throw new ConflictException('Cet identifiant existe déjà.');
      data.slug = slug;
    }
    const updated = (await this.prisma.rewardEvent.update({ where: { id }, data })) as EventRow;
    this.cache = null;
    await this.log('rewards.event.update', actor, id, { slug: updated.slug, open, status: updated.status });
    // A widened open window may already qualify players: evaluate them now.
    if (open && isEvaluating(updated, now)) await this.finalPass(updated, now, false);
    return this.serialize(updated, await this.awardedCount(id), now);
  }

  async remove(actor: Actor, id: string) {
    const row = await this.find(id);
    if (row.status !== 'draft') throw new BadRequestException('Seul un brouillon peut être supprimé.');
    await this.prisma.rewardEvent.delete({ where: { id } });
    this.cache = null;
    await this.log('rewards.event.delete', actor, id, { slug: row.slug });
    return { ok: true };
  }

  /** Next yearly edition as a draft (dates shifted by one year). */
  async duplicate(actor: Actor, id: string) {
    const row = await this.find(id);
    let slug = nextEditionSlug(row.slug, row.startsAt);
    for (let i = 2; await this.prisma.rewardEvent.findUnique({ where: { slug }, select: { id: true } }); i++) {
      slug = `${nextEditionSlug(row.slug, row.startsAt)}_${i}`;
    }
    const created = (await this.prisma.rewardEvent.create({
      data: {
        slug,
        name: row.name,
        description: row.description,
        startsAt: addYear(row.startsAt),
        endsAt: addYear(row.endsAt),
        recurrence: row.recurrence,
        status: 'draft',
        conditions: row.conditions as any,
        rewards: row.rewards as any,
        createdById: actor.id,
      },
    })) as EventRow;
    await this.log('rewards.event.duplicate', actor, created.id, { from: row.slug, slug });
    return this.serialize(created);
  }

  /** Closes an event now: final pass on the window, then `closed`. */
  async close(actor: Actor, id: string, now = new Date()) {
    let row = await this.find(id);
    if (row.status === 'closed') return { event: this.serialize(row, await this.awardedCount(id), now), awarded: 0, remaining: 0 };
    if (row.status === 'draft') throw new BadRequestException('Publie l’événement avant de le clôturer.');
    if (row.endsAt.getTime() > now.getTime()) {
      // Closing early ends the window now (explicit admin action).
      row = (await this.prisma.rewardEvent.update({ where: { id }, data: { endsAt: now } })) as EventRow;
    }
    const pass = await this.finalPass(row, now, true);
    await this.log('rewards.event.close', actor, id, { slug: row.slug, awarded: pass.awarded, remaining: pass.remaining });
    const fresh = await this.find(id);
    return { event: this.serialize(fresh, await this.awardedCount(id), now), awarded: pass.awarded, remaining: pass.remaining };
  }

  /** Members who already meet the conditions, rewarded ones included (calibration helper). */
  async eligible(id: string, now = new Date()) {
    const row = await this.find(id);
    const shape = shapeOf(row);
    const candidates = await this.candidates(row, shape, now, ELIGIBLE_SCAN);
    let eligible = 0;
    for (const userId of candidates) {
      const progress = await this.progressFor(userId, row, shape, now);
      if (isQualified(shape.conditions.mode, progress)) eligible++;
    }
    // Already rewarded members meet the conditions too.
    const awarded = await this.awardedCount(id);
    return { eligible: eligible + awarded, awarded, scanned: candidates.length };
  }

  /** Seeds the default events of catalogue §6.5 as drafts (idempotent by slug family). */
  async seedDefaults(actor: Actor | null, now = new Date()) {
    const first = await this.prisma.user.findFirst({ orderBy: { joinedAt: 'asc' }, select: { joinedAt: true } });
    const launch = first?.joinedAt ?? now;
    const existing = await this.prisma.rewardEvent.findMany({ select: { slug: true } });
    const families = new Set(existing.map((e) => e.slug.replace(/_\d{4}(_\d+)?$/, '')));
    const created: string[] = [];
    for (const d of defaultEvents(now, launch)) {
      if (families.has(d.slug.replace(/_\d{4}$/, ''))) continue;
      await this.prisma.rewardEvent.create({
        data: {
          slug: d.slug,
          name: d.name,
          description: d.description,
          startsAt: d.startsAt,
          endsAt: d.endsAt,
          recurrence: d.recurrence,
          status: 'draft',
          conditions: d.conditions as any,
          rewards: d.rewards as any,
          createdById: actor?.id ?? null,
        },
      });
      created.push(d.slug);
    }
    if (created.length && actor) await this.log('rewards.event.defaults', actor, undefined, { created });
    this.cache = null;
    return { created };
  }

  // ----- Player -----

  /** Events in their window with the player's progress (Progression banner). */
  async activeFor(userId: string, now = new Date()) {
    const rows = (await this.openEvents(now)).filter((r) => isEvaluating(r, now));
    const out = [];
    for (const row of rows) {
      const shape = shapeOf(row);
      const [progress, done] = await Promise.all([this.progressFor(userId, row, shape, now), this.rewarded(userId, row.id)]);
      const s = this.serialize(row, 0, now);
      out.push({
        id: s.id,
        slug: s.slug,
        name: s.name,
        description: s.description,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        status: s.status,
        conditionMode: s.conditionMode,
        conditions: progress.map(({ type, count, scope, progress: p }) => ({ type, count, scope, progress: p })),
        rewards: s.rewards,
        completed: done || isQualified(shape.conditions.mode, progress),
      });
    }
    return out;
  }

  // ----- Evaluation -----

  private async openEvents(now: Date): Promise<EventRow[]> {
    if (!this.cache || now.getTime() - this.cache.at > CACHE_MS) {
      const rows = (await this.prisma.rewardEvent.findMany({
        where: { status: { in: ['scheduled', 'active'] } },
      })) as EventRow[];
      this.cache = { at: now.getTime(), rows };
    }
    return this.cache.rows;
  }

  /** Listener: re-evaluates the open events fed by `type` for this player. */
  private async onTracked(userId: string, type: XpType, now: Date) {
    if (type === 'event_reward') return;
    const rows = (await this.openEvents(now)).filter(
      (r) =>
        isEvaluating(r, now) &&
        parseConditions(r.conditions).items.some((c) => c.type === type || c.type === 'account_created_before'),
    );
    for (const row of rows) {
      try {
        await this.evaluateUser(userId, row, now);
      } catch (err) {
        this.logger.warn(`event ${row.slug} for ${userId} failed: ${(err as Error)?.message}`);
      }
    }
  }

  private async rewarded(userId: string, eventId: string) {
    const row = await this.prisma.xpEvent.findUnique({
      where: { userId_type_refId: { userId, type: 'event_reward', refId: eventId } },
      select: { id: true },
    });
    return !!row;
  }

  private async awardedCount(eventId: string) {
    return this.prisma.xpEvent.count({ where: { type: 'event_reward', refId: eventId } });
  }

  /** Counts of each condition inside the window (capped at `now`). */
  async progressFor(userId: string, row: EventRow, shape: EventShape, now: Date): Promise<ConditionProgress[]> {
    const end = new Date(Math.min(row.endsAt.getTime(), now.getTime()));
    const values = await Promise.all(
      shape.conditions.items.map(async (c) => {
        if (c.type === 'account_created_before') {
          const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { joinedAt: true } });
          return u && u.joinedAt.getTime() <= row.endsAt.getTime() ? 1 : 0;
        }
        const filter = refFilter(c);
        const refWhere = filter?.equals
          ? { refId: { in: filter.equals } }
          : filter?.startsWith
            ? { OR: filter.startsWith.map((p) => ({ refId: { startsWith: p } })) }
            : {};
        return this.prisma.xpEvent.count({
          where: { userId, type: c.type, createdAt: { gte: row.startsAt, lte: end }, ...refWhere },
        });
      }),
    );
    return withProgress(shape.conditions.items, values);
  }

  /** Rewards the player once when he meets the conditions. True when rewarded now. */
  private async evaluateUser(userId: string, row: EventRow, now: Date) {
    const shape = shapeOf(row);
    if (await this.rewarded(userId, row.id)) return false;
    const progress = await this.progressFor(userId, row, shape, now);
    if (!isQualified(shape.conditions.mode, progress)) return false;
    return this.applyRewards(userId, row, shape.rewards, now);
  }

  private async applyRewards(userId: string, row: EventRow, rewards: EventRewards, now: Date) {
    const res = await this.gamification.track(userId, 'event_reward', row.id, {
      now,
      amount: rewards.xp,
      meta: { slug: row.slug, name: row.name },
    });
    if (!res.granted) return false;
    if (rewards.frameId && this.rewards) {
      const frame = getFrame(rewards.frameId);
      const temporary = rewards.frameDays !== null || !!(frame?.expiry && 'days' in frame.expiry);
      // Temporary event frames run from the end of the window (catalogue §5.5).
      await this.rewards.grantFrameSafe(userId, rewards.frameId, {
        source: 'event',
        sourceRef: `event:${row.slug}`,
        ...(rewards.frameDays !== null ? { days: rewards.frameDays } : {}),
        ...(temporary ? { startsAt: new Date(Math.max(row.endsAt.getTime(), now.getTime())) } : {}),
      });
    }
    if (rewards.achievementId) {
      // The event frame (with its own duration) replaces the achievement's default grant.
      await this.gamification.unlockAchievement(userId, rewards.achievementId, { frames: !rewards.frameId, now });
    }
    return true;
  }

  /** Users that may qualify (not rewarded yet): activity of the condition types in the window. */
  private async candidates(row: EventRow, shape: EventShape, now: Date, limit: number): Promise<string[]> {
    const end = new Date(Math.min(row.endsAt.getTime(), now.getTime()));
    const done = await this.prisma.xpEvent.findMany({
      where: { type: 'event_reward', refId: row.id },
      select: { userId: true },
    });
    const skip = new Set(done.map((d) => d.userId));
    const ids = new Set<string>();
    for (const c of shape.conditions.items) {
      if (c.type === 'account_created_before') {
        const users = await this.prisma.user.findMany({
          where: {
            joinedAt: { lte: row.endsAt },
            ...PUBLIC_USER_WHERE,
            ...(skip.size ? { id: { notIn: [...skip] } } : {}),
          },
          select: { id: true },
          orderBy: { joinedAt: 'asc' },
          take: limit,
        });
        users.forEach((u) => ids.add(u.id));
        continue;
      }
      const groups = await this.prisma.xpEvent.groupBy({
        by: ['userId'],
        where: { type: c.type, createdAt: { gte: row.startsAt, lte: end } },
        _count: { _all: true },
      });
      groups.filter((g) => g._count._all >= c.count && !skip.has(g.userId)).forEach((g) => ids.add(g.userId));
    }
    if (!ids.size) return [];
    const publicIds = new Set(
      (
        await this.prisma.user.findMany({ where: { id: { in: [...ids] }, ...PUBLIC_USER_WHERE }, select: { id: true } })
      ).map((u) => u.id),
    );
    return [...ids].filter((id) => publicIds.has(id)).slice(0, limit);
  }

  /**
   * Rewards every qualified player not rewarded yet (batched). With `close`,
   * the event becomes `closed` once nobody is left to process.
   */
  async finalPass(row: EventRow, now: Date, close: boolean) {
    const shape = shapeOf(row);
    const batch = await this.candidates(row, shape, now, FINAL_PASS_BATCH + 1);
    const todo = batch.slice(0, FINAL_PASS_BATCH);
    let awarded = 0;
    for (const userId of todo) {
      try {
        const progress = await this.progressFor(userId, row, shape, now);
        if (isQualified(shape.conditions.mode, progress) && (await this.applyRewards(userId, row, shape.rewards, now))) awarded++;
      } catch (err) {
        this.logger.warn(`final pass ${row.slug} for ${userId} failed: ${(err as Error)?.message}`);
      }
    }
    const remaining = batch.length > FINAL_PASS_BATCH ? batch.length - FINAL_PASS_BATCH : 0;
    if (close && !remaining) {
      await this.prisma.rewardEvent.update({ where: { id: row.id }, data: { status: 'closed' } });
      this.cache = null;
    }
    return { awarded, remaining };
  }

  /**
   * Daily job: publishes scheduled events whose window started, runs the
   * final pass of ended ones and closes them. Idempotent.
   */
  async runDaily(now = new Date()) {
    const rows = (await this.prisma.rewardEvent.findMany({
      where: { status: { in: ['scheduled', 'active'] } },
    })) as EventRow[];
    const out = { activated: 0, closed: 0, awarded: 0, pending: 0 };
    for (const row of rows) {
      const next = nextStatus(row, now);
      if (next === 'active') {
        await this.prisma.rewardEvent.update({ where: { id: row.id }, data: { status: 'active' } });
        out.activated++;
      } else if (next === 'closed') {
        const pass = await this.finalPass(row, now, true);
        out.awarded += pass.awarded;
        if (pass.remaining) out.pending++;
        else out.closed++;
      }
    }
    this.cache = null;
    return out;
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
