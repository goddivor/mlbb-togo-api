import { BadRequestException } from '@nestjs/common';
import { RewardsAdminService } from './rewards-admin.service';
import { PrismaService } from '../prisma/prisma.service';
import { RewardsService } from './rewards.service';
import { GamificationService } from '../gamification/gamification.service';
import { RewardEventsService } from '../gamification/reward-events.service';

const oid = (n: number) => n.toString(16).padStart(24, '0');

function setup() {
  const progress = Array.from({ length: 7 }, (_, i) => ({ id: oid(i + 1), userId: `u${i + 1}` }));
  const prisma: any = {
    userProgress: {
      findMany: jest.fn(async ({ where, take }: any) =>
        progress.filter((p) => !where?.id?.gt || p.id > where.id.gt).slice(0, take),
      ),
      count: jest.fn(async () => progress.length),
    },
    userFrame: { count: jest.fn(async () => 0) },
    userAchievement: { findMany: jest.fn(async () => []) },
    user: {
      findUnique: jest.fn(async ({ where }: any) => ({ id: where.id })),
      findMany: jest.fn(async () => []),
    },
    tournament: { findUnique: jest.fn(async () => ({ id: oid(99), name: 'Cup' })) },
    draftTournament: { findUnique: jest.fn(async () => null) },
    rewardElection: { findUnique: jest.fn(async () => null), create: jest.fn() },
    xpEvent: { groupBy: jest.fn(async () => []) },
    adminLog: { create: jest.fn() },
  };
  const rewards = { syncLevelFrames: jest.fn(async () => []), grantAchievementFrames: jest.fn(async () => []) };
  const gamification = {
    reevaluate: jest.fn(async () => ({ unlocked: ['x'], level: 3, xp: 500 })),
    adjustXp: jest.fn(async () => ({ applied: 0, xp: 0, level: 1, previousXp: 0, previousLevel: 1 })),
  };
  const service = new RewardsAdminService(
    prisma as PrismaService,
    rewards as unknown as RewardsService,
    gamification as unknown as GamificationService,
    {} as RewardEventsService,
  );
  return { service, prisma, gamification };
}

describe('RewardsAdminService', () => {
  const actor = { id: 'adm', username: 'admin' };

  it('recalculates every user page by page (no unbounded request)', async () => {
    const { service, gamification } = setup();
    const first = await service.recalculate(actor, { limit: 3 });
    expect(first).toMatchObject({ users: 3, total: 7, nextCursor: oid(3), achievementsUnlocked: 3 });
    const second = await service.recalculate(actor, { limit: 3, cursor: first.nextCursor! });
    expect(second).toMatchObject({ users: 3, nextCursor: oid(6) });
    const last = await service.recalculate(actor, { limit: 3, cursor: second.nextCursor! });
    expect(last).toMatchObject({ users: 1, nextCursor: null });
    expect(gamification.reevaluate).toHaveBeenCalledTimes(7);
  });

  it('recalculates a single user in one call', async () => {
    const { service, gamification } = setup();
    const res = await service.recalculate(actor, { userId: oid(42) });
    expect(res).toMatchObject({ users: 1, nextCursor: null });
    expect(gamification.reevaluate).toHaveBeenCalledWith(oid(42));
  });

  it('refuses tournament results for system or banned accounts', async () => {
    const { service, prisma } = setup();
    await expect(
      service.recordTournamentResult(actor, { tournamentId: oid(99), kind: 'winner', userIds: [oid(1)] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ isBanned: false, isSystemAccount: false }) }),
    );
  });

  it('excludes admin corrections from the monthly ranking', async () => {
    const { service, prisma } = setup();
    await service.electMonthlyNumberOne(new Date('2026-10-01T00:05:00Z'));
    expect(prisma.xpEvent.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ type: { not: 'admin_correction' } }) }),
    );
  });

  it('rejects a correction that has nothing to apply', async () => {
    const { service } = setup();
    await expect(
      service.correctXp(actor, { userId: oid(5), amount: -100, reason: 'cheat' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
