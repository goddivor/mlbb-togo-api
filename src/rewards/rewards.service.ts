import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CommunityService } from '../community/community.service';
import {
  FRAMES,
  FrameDef,
  FrameSource,
  SEASON_VARIANT,
  TITLES,
  frameKey,
  framesForAchievement,
  getFrame,
  getTitle,
  isTemporaryFrame,
  isTitleUnlocked,
  levelFramesUpTo,
  parseFrameKey,
} from './frames.catalog';
import {
  FramePeriod,
  GrantOptions,
  checkEquip,
  closeHistory,
  isFrameRowActive,
  missingLevelFrames,
  nextEquipState,
  parseHistory,
  planGrant,
  resolveEquippedFrame,
} from './rewards.logic';

const DAY = 86_400_000;

/** 28/09/2026 (UTC = Lomé). */
function frDate(d: Date) {
  return d.toISOString().slice(0, 10).split('-').reverse().join('/');
}

export interface GrantFrameInput extends GrantOptions {
  variant?: string | null;
  source?: FrameSource;
  sourceRef?: string | null;
  grantedById?: string | null;
  /** Send the "new frame" notification (default true). */
  notify?: boolean;
}

export interface GrantFrameResult {
  frameId: string;
  variant: string;
  action: 'noop' | 'create' | 'extend' | 'reactivate' | 'make_permanent' | 'renew';
  expiresAt: Date | null;
}

/**
 * Core of the avatar frames system: grant / reactivate / extend / expire /
 * equip. Depends on Prisma only (plus optional notifications) so that the
 * gamification engine (levels, achievements) can call it without cycles.
 */
@Injectable()
export class RewardsService {
  private readonly logger = new Logger(RewardsService.name);

  constructor(
    private prisma: PrismaService,
    @Optional() private community?: CommunityService,
  ) {}

  // ----- Grants -----

  /**
   * Grants a frame (idempotent for permanent frames, extends an active
   * temporary one, reactivates an expired one). Duration: `days` when given,
   * else the catalogue default (`expiry.days`), else permanent.
   */
  async grantFrame(userId: string, frameId: string, input: GrantFrameInput = {}, now = new Date()): Promise<GrantFrameResult> {
    const frame = getFrame(frameId);
    if (!frame) throw new BadRequestException('Cadre inconnu.');
    const variant = this.cleanVariant(frame, input.variant);
    const days =
      input.days !== undefined && input.days !== null
        ? input.days
        : frame.expiry && 'days' in frame.expiry
          ? frame.expiry.days
          : null;
    const opts: GrantOptions = { startsAt: input.startsAt, days, continuityGraceMs: input.continuityGraceMs };

    for (let attempt = 0; attempt < 2; attempt++) {
      const row = await this.prisma.userFrame.findUnique({
        where: { userId_frameId_variant: { userId, frameId, variant } },
      });
      const plan = planGrant(
        row
          ? {
              expiresAt: row.expiresAt,
              expiredAt: row.expiredAt,
              timesGranted: row.timesGranted,
              history: parseHistory(row.history),
            }
          : null,
        opts,
        now,
      );
      if (plan.action === 'noop') return { frameId, variant, action: 'noop', expiresAt: row?.expiresAt ?? null };

      if (plan.action === 'create') {
        try {
          await this.prisma.userFrame.create({
            data: {
              userId,
              frameId,
              variant,
              source: input.source ?? frame.source,
              sourceRef: input.sourceRef ?? null,
              grantedById: input.grantedById ?? null,
              unlockedAt: now,
              expiresAt: plan.expiresAt,
              // Explicit null: Prisma's `{ expiredAt: null }` filters do not
              // match a missing field on MongoDB.
              expiredAt: null,
              history: plan.history as any,
            },
          });
        } catch (err: any) {
          if (err?.code === 'P2002') continue; // concurrent grant: re-plan on the stored row
          throw err;
        }
      } else {
        await this.prisma.userFrame.update({
          where: { id: row!.id },
          data: {
            expiresAt: plan.expiresAt,
            expiredAt: null,
            timesGranted: plan.timesGranted,
            history: plan.history as any,
            ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
            ...(input.grantedById ? { grantedById: input.grantedById } : {}),
          },
        });
      }

      const action = plan.action === 'create' ? 'create' : plan.kind;
      await this.syncEquippedExpiry(userId, frameKey(frameId, variant), plan.expiresAt);
      if (input.notify !== false && action !== 'extend') {
        await this.notify(userId, {
          type: 'frame_unlock',
          title: 'Nouveau cadre débloqué',
          message: plan.expiresAt
            ? `Le cadre « ${frame.name.fr} » est à toi jusqu’au ${frDate(plan.expiresAt)}.`
            : `Le cadre « ${frame.name.fr} » rejoint ta collection.`,
          link: '/progress',
          data: { frameId, variant, expiresAt: plan.expiresAt },
        });
      }
      return { frameId, variant, action, expiresAt: plan.expiresAt };
    }
    return { frameId, variant, action: 'noop', expiresAt: null };
  }

  /** Never throws: used by the gamification hooks. */
  async grantFrameSafe(userId: string, frameId: string, input: GrantFrameInput = {}) {
    try {
      return await this.grantFrame(userId, frameId, input);
    } catch (err) {
      this.logger.warn(`grant ${frameId} to ${userId} failed: ${(err as Error)?.message}`);
      return null;
    }
  }

  /**
   * Grants every level frame up to `level` the user does not own yet
   * (catch-up for players who levelled up before the frames existed). One
   * summary notification.
   */
  async syncLevelFrames(userId: string, level: number, now = new Date()): Promise<string[]> {
    const due = levelFramesUpTo(level).map((f) => f.id);
    if (!due.length) return [];
    const owned = await this.prisma.userFrame.findMany({
      where: { userId, frameId: { in: due } },
      select: { frameId: true },
    });
    const missing = missingLevelFrames(
      due,
      owned.map((o) => o.frameId),
    );
    const granted: string[] = [];
    for (const id of missing) {
      const res = await this.grantFrame(userId, id, { source: 'level', sourceRef: `level:${getFrame(id)?.level}`, notify: false }, now);
      if (res.action !== 'noop') granted.push(id);
    }
    if (granted.length) {
      const last = getFrame(granted[granted.length - 1])!;
      await this.notify(userId, {
        type: 'frame_unlock',
        title: 'Nouveau cadre débloqué',
        message:
          granted.length === 1
            ? `Le cadre « ${last.name.fr} » rejoint ta collection.`
            : `${granted.length} nouveaux cadres rejoignent ta collection.`,
        link: '/progress',
        data: { frameIds: granted },
      });
    }
    return granted;
  }

  async syncLevelFramesSafe(userId: string, level: number) {
    try {
      return await this.syncLevelFrames(userId, level);
    } catch (err) {
      this.logger.warn(`level frames for ${userId} failed: ${(err as Error)?.message}`);
      return [];
    }
  }

  /** Frames attached to an achievement (hook of `evaluateAchievements`). */
  async grantAchievementFrames(userId: string, achievementId: string, variant?: string | null) {
    const granted: GrantFrameResult[] = [];
    for (const f of framesForAchievement(achievementId)) {
      if (f.variantBySeason && !variant) continue; // season frames need the season (seasons hook)
      const res = await this.grantFrameSafe(userId, f.id, {
        variant: f.variantBySeason ? variant : null,
        sourceRef: `achievement:${achievementId}`,
      });
      if (res) granted.push(res);
    }
    return granted;
  }

  // ----- Ending / expiry -----

  /** Ends a frame now (admin action, champion transfer). Idempotent. */
  async endFrame(userId: string, frameId: string, variant = '', now = new Date()) {
    const row = await this.prisma.userFrame.findUnique({
      where: { userId_frameId_variant: { userId, frameId, variant } },
    });
    if (!row) throw new NotFoundException('Ce membre ne possède pas ce cadre.');
    if (!isFrameRowActive(row, now)) return { ended: false, frameId, variant };
    await this.prisma.userFrame.update({
      where: { id: row.id },
      data: {
        expiresAt: now,
        expiredAt: now,
        history: closeHistory(parseHistory(row.history), now) as any,
      },
    });
    await this.unequipExpired(userId, frameKey(frameId, variant));
    return { ended: true, frameId, variant };
  }

  /**
   * Marks every row past its expiry as expired and restores the fallback
   * frame of the users wearing it. Idempotent (daily cron).
   */
  async expireDue(now = new Date()) {
    const rows = await this.prisma.userFrame.findMany({
      // `not: null` is required: Prisma compares with `$expr` on MongoDB, where
      // null sorts before any date (permanent rows would match `lte`).
      where: { expiredAt: null, expiresAt: { not: null, lte: now } },
    });
    for (const row of rows) {
      await this.prisma.userFrame.update({
        where: { id: row.id },
        data: { expiredAt: row.expiresAt ?? now, history: closeHistory(parseHistory(row.history), row.expiresAt ?? now) as any },
      });
      await this.unequipExpired(row.userId, frameKey(row.frameId, row.variant));
      const frame = getFrame(row.frameId);
      await this.notify(row.userId, {
        type: 'frame_expired',
        title: 'Cadre expiré',
        message: `Ton cadre « ${frame?.name.fr ?? row.frameId} » a expiré.`,
        link: '/progress',
        data: { frameId: row.frameId, variant: row.variant },
      });
    }
    return rows.length;
  }

  /** "Expires tomorrow" reminder for rows ending within the next 24 h. */
  async notifyExpiringSoon(now = new Date()) {
    const rows = await this.prisma.userFrame.findMany({
      where: { expiredAt: null, expiresAt: { gt: now, lte: new Date(now.getTime() + DAY) } },
    });
    for (const row of rows) {
      const frame = getFrame(row.frameId);
      await this.notify(row.userId, {
        type: 'frame_expiring',
        title: 'Cadre bientôt expiré',
        message: `Ton cadre « ${frame?.name.fr ?? row.frameId} » expire demain.`,
        link: '/progress',
        data: { frameId: row.frameId, variant: row.variant, expiresAt: row.expiresAt },
      });
    }
    return rows.length;
  }

  /** Swaps a user wearing `key` back to his fallback frame (or none). */
  private async unequipExpired(userId: string, key: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { equippedFrame: true, fallbackFrame: true },
    });
    if (!user || user.equippedFrame !== key) return;
    const fallback = user.fallbackFrame && user.fallbackFrame !== key ? user.fallbackFrame : null;
    await this.prisma.user.update({
      where: { id: userId },
      data: { equippedFrame: fallback, equippedFrameExpiresAt: null, ...(fallback ? {} : { fallbackFrame: null }) },
    });
  }

  /** Keeps `User.equippedFrameExpiresAt` in sync after an extension. */
  private async syncEquippedExpiry(userId: string, key: string, expiresAt: Date | null) {
    await this.prisma.user.updateMany({
      where: { id: userId, equippedFrame: key },
      data: { equippedFrameExpiresAt: expiresAt },
    });
  }

  // ----- Equip -----

  async equipFrame(userId: string, frameId: string | null | undefined, variant?: string | null, now = new Date()) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, equippedFrame: true, fallbackFrame: true, equippedFrameExpiresAt: true },
    });
    if (!user) throw new NotFoundException('Utilisateur introuvable.');

    if (!frameId) {
      const next = nextEquipState(user, null, false, null);
      await this.prisma.user.update({ where: { id: userId }, data: next });
      return { equippedFrame: null, fallbackFrame: null };
    }

    // Accept `frameId:variant` as well as separate fields.
    const parsed = parseFrameKey(frameId);
    const id = parsed.frameId;
    const v = (variant ?? parsed.variant ?? '').trim();
    const frame = getFrame(id);
    const row = frame
      ? await this.prisma.userFrame.findUnique({
          where: { userId_frameId_variant: { userId, frameId: id, variant: v } },
        })
      : null;
    const check = checkEquip(!!frame, row, now);
    if (check === 'unknown_frame') throw new BadRequestException('Cadre inconnu.');
    if (check === 'not_owned') throw new BadRequestException('Tu ne possèdes pas ce cadre.');
    if (check === 'expired') throw new BadRequestException('Ce cadre a expiré.');

    const key = frameKey(id, v);
    const temporary = isTemporaryFrame(frame) || !!row!.expiresAt;
    const next = nextEquipState(user, key, temporary, row!.expiresAt);
    await this.prisma.user.update({ where: { id: userId }, data: next });
    return { equippedFrame: next.equippedFrame, fallbackFrame: next.fallbackFrame };
  }

  async equipTitle(userId: string, titleId: string | null | undefined) {
    if (!titleId) {
      await this.prisma.user.update({ where: { id: userId }, data: { equippedTitle: null } });
      return { equippedTitle: null };
    }
    if (!getTitle(titleId)) throw new BadRequestException('Titre inconnu.');
    const level = await this.levelOf(userId);
    if (!isTitleUnlocked(titleId, level)) throw new BadRequestException('Ce titre n’est pas encore débloqué.');
    await this.prisma.user.update({ where: { id: userId }, data: { equippedTitle: titleId } });
    return { equippedTitle: titleId };
  }

  /** Unequips a title the user no longer qualifies for (negative XP correction). */
  async revalidateTitle(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { equippedTitle: true } });
    if (!user?.equippedTitle) return;
    const level = await this.levelOf(userId);
    if (!isTitleUnlocked(user.equippedTitle, level)) {
      await this.prisma.user.update({ where: { id: userId }, data: { equippedTitle: null } });
    }
  }

  private async levelOf(userId: string) {
    const p = await this.prisma.userProgress.findUnique({ where: { userId }, select: { level: true } });
    return p?.level ?? 1;
  }

  // ----- Read -----

  /** Collection of a user: every catalogue frame with its owned entries, titles. */
  async collection(userId: string, now = new Date()) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, equippedFrame: true, fallbackFrame: true, equippedFrameExpiresAt: true, equippedTitle: true },
    });
    if (!user) throw new NotFoundException('Utilisateur introuvable.');
    const level = await this.levelOf(userId);
    // Catch-up on read: players who reached a level before the frames existed.
    await this.syncLevelFramesSafe(userId, level);

    const rows = await this.prisma.userFrame.findMany({ where: { userId }, orderBy: { unlockedAt: 'asc' } });
    const byFrame = new Map<string, typeof rows>();
    for (const r of rows) byFrame.set(r.frameId, [...(byFrame.get(r.frameId) ?? []), r]);

    return {
      level,
      equippedFrame: resolveEquippedFrame(user, now),
      fallbackFrame: user.fallbackFrame ?? null,
      equippedTitle: user.equippedTitle ?? null,
      frames: FRAMES.map((f) => {
        const entries = (byFrame.get(f.id) ?? []).map((r) => this.serializeRow(r, now));
        return {
          ...this.serializeDef(f),
          owned: entries.some((e) => e.active),
          entries,
        };
      }),
      titles: TITLES.map((t) => ({ ...t, unlocked: level >= t.level })),
    };
  }

  serializeDef(f: FrameDef) {
    return {
      id: f.id,
      name: f.name,
      shape: f.shape,
      tier: f.tier,
      source: f.source,
      level: f.level ?? null,
      achievement: f.achievement ?? null,
      awards: f.awards ?? null,
      animation: f.animation,
      variantBySeason: !!f.variantBySeason,
      temporary: !!f.expiry,
      expiry: f.expiry ?? null,
      secret: !!f.secret,
    };
  }

  serializeRow(
    r: {
      frameId: string;
      variant: string;
      source: string;
      sourceRef: string | null;
      unlockedAt: Date;
      expiresAt: Date | null;
      expiredAt: Date | null;
      timesGranted: number;
      history: unknown;
    },
    now = new Date(),
  ) {
    return {
      frameId: r.frameId,
      variant: r.variant,
      key: frameKey(r.frameId, r.variant),
      source: r.source,
      sourceRef: r.sourceRef,
      unlockedAt: r.unlockedAt,
      expiresAt: r.expiresAt,
      expiredAt: r.expiredAt ?? (r.expiresAt && r.expiresAt.getTime() <= now.getTime() ? r.expiresAt : null),
      active: isFrameRowActive(r, now),
      timesGranted: r.timesGranted,
      history: parseHistory(r.history) as FramePeriod[],
    };
  }

  private cleanVariant(frame: FrameDef, variant?: string | null): string {
    const v = (variant ?? '').trim();
    if (!frame.variantBySeason) {
      if (v) throw new BadRequestException('Ce cadre n’a pas de variante.');
      return '';
    }
    if (!SEASON_VARIANT.test(v)) throw new BadRequestException('Variante de saison attendue (ex. S2).');
    return v;
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
}
