import { BadRequestException } from '@nestjs/common';
import { RewardEventsService } from './reward-events.service';
import { PrismaService } from '../prisma/prisma.service';
import { GamificationService } from './gamification.service';
import { RewardsService } from '../rewards/rewards.service';

const ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const d = (iso: string) => new Date(iso);

/** In-memory XP events + one reward event, enough for the evaluation paths. */
function setup(event: Partial<any> = {}) {
  const row: any = {
    id: ID,
    slug: 'rainy_season_2027',
    name: 'Saison des pluies',
    description: null,
    startsAt: d('2027-06-15T00:00:00Z'),
    endsAt: d('2027-07-15T00:00:00Z'),
    recurrence: 'yearly',
    status: 'active',
    conditions: { mode: 'all', items: [{ type: 'daily_login', count: 3, scope: null }] },
    rewards: { achievementId: 'rainy_season', frameId: 'saison_pluies', frameDays: null, xp: 25 },
    createdById: null,
    createdAt: d('2027-01-01T00:00:00Z'),
    updatedAt: d('2027-01-01T00:00:00Z'),
    ...event,
  };
  const xp: any[] = [];
  const joined: Record<string, Date> = {};
  const inWindow = (e: any, where: any) =>
    (!where.userId || e.userId === where.userId) &&
    (!where.type || e.type === where.type) &&
    (!where.refId || typeof where.refId !== 'string' || e.refId === where.refId) &&
    (!where.refId?.in || where.refId.in.includes(e.refId)) &&
    (!where.OR || where.OR.some((o: any) => e.refId.startsWith(o.refId.startsWith))) &&
    (!where.createdAt || ((!where.createdAt.gte || e.createdAt >= where.createdAt.gte) && (!where.createdAt.lte || e.createdAt <= where.createdAt.lte)));
  const prisma: any = {
    rewardEvent: {
      findUnique: jest.fn(async () => row),
      findMany: jest.fn(async () => [row]),
      update: jest.fn(async ({ data }: any) => Object.assign(row, data)),
      create: jest.fn(),
    },
    xpEvent: {
      count: jest.fn(async ({ where }: any) => xp.filter((e) => inWindow(e, where)).length),
      findUnique: jest.fn(async ({ where }: any) => {
        const k = where.userId_type_refId;
        return xp.find((e) => e.userId === k.userId && e.type === k.type && e.refId === k.refId) ?? null;
      }),
      findMany: jest.fn(async ({ where }: any) => xp.filter((e) => inWindow(e, where))),
      groupBy: jest.fn(async ({ where }: any) => {
        const map = new Map<string, number>();
        for (const e of xp.filter((x) => inWindow(x, where))) map.set(e.userId, (map.get(e.userId) ?? 0) + 1);
        return [...map].map(([userId, n]) => ({ userId, refId: ID, _count: { _all: n } }));
      }),
    },
    user: {
      findMany: jest.fn(async ({ where }: any) =>
        (where.id?.in ?? Object.keys(joined))
          .filter((id: string) => !where.joinedAt || (joined[id] ?? d('2020-01-01T00:00:00Z')) <= where.joinedAt.lte)
          .map((id: string) => ({ id })),
      ),
    },
    adminLog: { create: jest.fn() },
  };
  const gamification = {
    onTracked: jest.fn(),
    track: jest.fn(async (userId: string, type: string, refId: string) => {
      if (xp.some((e) => e.userId === userId && e.type === type && e.refId === refId)) return { granted: false };
      xp.push({ userId, type, refId, createdAt: d('2027-06-20T00:00:00Z') });
      return { granted: true };
    }),
    unlockAchievement: jest.fn(async () => true),
  };
  const rewards = { grantFrameSafe: jest.fn(async () => ({})) };
  const service = new RewardEventsService(
    prisma as PrismaService,
    gamification as unknown as GamificationService,
    rewards as unknown as RewardsService,
  );
  const login = (userId: string, iso: string) => xp.push({ userId, type: 'daily_login', refId: iso.slice(0, 10), createdAt: d(iso) });
  return { service, prisma, gamification, rewards, row, xp, login, joined };
}

describe('RewardEventsService', () => {
  const now = d('2027-06-20T12:00:00Z');

  it('registers itself as a listener of tracked XP events', () => {
    const { service, gamification } = setup();
    service.onModuleInit();
    expect(gamification.onTracked).toHaveBeenCalled();
  });

  it('rewards a player during the window as soon as the conditions are met, once', async () => {
    const { service, gamification, rewards, login } = setup();
    service.onModuleInit();
    const listener = gamification.onTracked.mock.calls[0][0];
    login('p1', '2027-06-01T10:00:00Z'); // before the window: not counted
    login('p1', '2027-06-16T10:00:00Z');
    login('p1', '2027-06-17T10:00:00Z');
    await listener('p1', 'daily_login', now);
    expect(gamification.track).not.toHaveBeenCalled();
    login('p1', '2027-06-18T10:00:00Z');
    await listener('p1', 'daily_login', now);
    await listener('p1', 'daily_login', now);
    expect(gamification.track).toHaveBeenCalledWith('p1', 'event_reward', ID, expect.objectContaining({ amount: 25 }));
    // Already rewarded: the second evaluation stops before any grant.
    expect(gamification.track.mock.calls.filter((c: any[]) => c[1] === 'event_reward')).toHaveLength(1);
    expect(rewards.grantFrameSafe).toHaveBeenCalledTimes(1);
    expect(rewards.grantFrameSafe).toHaveBeenCalledWith('p1', 'saison_pluies', expect.objectContaining({ source: 'event' }));
    // The event frame replaces the achievement's default frame grant.
    expect(gamification.unlockAchievement).toHaveBeenCalledWith('p1', 'rainy_season', expect.objectContaining({ frames: false }));
  });

  it('ignores XP types that no condition uses and events outside their window', async () => {
    const { service, gamification, login } = setup();
    service.onModuleInit();
    const listener = gamification.onTracked.mock.calls[0][0];
    for (const day of ['16', '17', '18']) login('p1', `2027-06-${day}T10:00:00Z`);
    await listener('p1', 'forum_post', now);
    await listener('p1', 'daily_login', d('2027-07-20T00:00:00Z'));
    expect(gamification.track).not.toHaveBeenCalled();
  });

  it('reports the player progress for the Progression banner', async () => {
    const { service, login } = setup();
    login('p1', '2027-06-16T10:00:00Z');
    const [event] = await service.activeFor('p1', now);
    expect(event).toMatchObject({
      slug: 'rainy_season_2027',
      conditionMode: 'all',
      conditions: [{ type: 'daily_login', count: 3, scope: null, progress: 1 }],
      completed: false,
    });
  });

  it('only accepts widening edits on an open window', async () => {
    const { service } = setup();
    await expect(
      service.update({ id: 'adm' }, ID, { endsAt: '2027-07-10T00:00:00Z' }, now),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.update({ id: 'adm' }, ID, { conditions: [{ type: 'daily_login', count: 5 }] }, now),
    ).rejects.toThrow(/ne peut pas augmenter/);
    const widened = await service.update({ id: 'adm' }, ID, { endsAt: '2027-07-31T00:00:00Z', conditions: [{ type: 'daily_login', count: 2 }] }, now);
    expect(widened.endsAt.toISOString()).toBe('2027-07-31T00:00:00.000Z');
    expect(widened.conditions[0].count).toBe(2);
  });

  it('lets a draft be edited freely but never a closed event', async () => {
    const draft = setup({ status: 'draft' });
    const out = await draft.service.update({ id: 'adm' }, ID, { endsAt: '2027-07-01T00:00:00Z' }, now);
    expect(out.endsAt.toISOString()).toBe('2027-07-01T00:00:00.000Z');
    const closed = setup({ status: 'closed' });
    await expect(closed.service.update({ id: 'adm' }, ID, { name: 'x' }, now)).rejects.toThrow(/clôturé/);
  });

  it('runs the final pass at the end of the window and closes the event', async () => {
    const { service, prisma, gamification, login } = setup();
    for (const day of ['16', '17', '18']) login('p1', `2027-06-${day}T10:00:00Z`);
    login('p2', '2027-06-16T10:00:00Z');
    const out = await service.runDaily(d('2027-07-16T00:05:00Z'));
    expect(out).toMatchObject({ closed: 1, awarded: 1 });
    expect(gamification.track.mock.calls.filter((c: any[]) => c[1] === 'event_reward').map((c: any[]) => c[0])).toEqual(['p1']);
    expect(prisma.rewardEvent.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'closed' } }));
  });

  it('activates a scheduled event once its window starts', async () => {
    const { service, prisma } = setup({ status: 'scheduled' });
    const out = await service.runDaily(now);
    expect(out.activated).toBe(1);
    expect(prisma.rewardEvent.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'active' } }));
  });

  it('closes early on demand, ending the window now', async () => {
    const { service, prisma } = setup();
    const res = await service.close({ id: 'adm' }, ID, now);
    expect(prisma.rewardEvent.update).toHaveBeenCalledWith(expect.objectContaining({ data: { endsAt: now } }));
    expect(res.remaining).toBe(0);
    expect(res.event.status).toBe('closed');
  });

  describe('final pass (bounded, exact candidates)', () => {
    const later = d('2027-07-16T00:05:00Z');
    const far = () => Date.now() + 60_000;

    it('only processes members meeting every condition in `all` mode, within the scope', async () => {
      const { service, row, xp, gamification, login } = setup({
        conditions: {
          mode: 'all',
          items: [
            { type: 'daily_login', count: 1, scope: null },
            { type: 'bracket_played', count: 1, scope: 'cup' },
          ],
        },
      });
      login('both', '2027-06-16T10:00:00Z');
      login('loginOnly', '2027-06-16T10:00:00Z');
      login('otherCup', '2027-06-16T10:00:00Z');
      xp.push({ userId: 'both', type: 'bracket_played', refId: 'bracket:cup:m1', createdAt: d('2027-06-17T00:00:00Z') });
      xp.push({ userId: 'otherCup', type: 'bracket_played', refId: 'bracket:other:m1', createdAt: d('2027-06-17T00:00:00Z') });
      const res = await service.finalPass(row, later, { close: true, deadline: far() });
      expect(res).toEqual({ awarded: 1, remaining: 0 });
      expect(gamification.track.mock.calls.map((c: any[]) => c[0])).toEqual(['both']);
      expect(row.status).toBe('closed');
    });

    it('stops at the deadline, reports what is left and closes on a later run', async () => {
      const { service, row, gamification, login } = setup();
      for (const u of ['p1', 'p2', 'p3']) for (const day of ['16', '17', '18']) login(u, `2027-06-${day}T10:00:00Z`);
      const cut = await service.finalPass(row, later, { close: true, deadline: Date.now() - 1 });
      expect(cut).toEqual({ awarded: 0, remaining: 3 });
      expect(row.status).toBe('active');
      const first = await service.finalPass(row, later, { close: true, deadline: far(), batch: 2 });
      expect(first).toEqual({ awarded: 3, remaining: 0 });
      expect(gamification.track.mock.calls.map((c: any[]) => c[0])).toEqual(['p1', 'p2', 'p3']);
      expect(row.status).toBe('closed');
    });

    it('treats account creation as a source alone and as a filter in `all` mode', async () => {
      const { service, row, joined, login } = setup({
        endsAt: d('2027-07-15T00:00:00Z'),
        conditions: {
          mode: 'all',
          items: [
            { type: 'account_created_before', count: 1, scope: null },
            { type: 'daily_login', count: 1, scope: null },
          ],
        },
      });
      joined.old = d('2026-01-01T00:00:00Z');
      joined.late = d('2027-08-01T00:00:00Z');
      login('old', '2027-06-16T10:00:00Z');
      login('late', '2027-06-16T10:00:00Z');
      expect(await service.eligible(ID, later)).toMatchObject({ eligible: 1, pending: 1 });
      expect(await service.finalPass(row, later, { close: false, deadline: far() })).toEqual({ awarded: 1, remaining: 0 });
    });

    it('closes early from the admin with a bounded pass and leaves the rest to the daily job', async () => {
      const { service, row } = setup();
      const res = await service.close({ id: 'adm' }, ID, d('2027-06-20T12:00:00Z'));
      expect(res.remaining).toBe(0);
      expect(row.endsAt).toEqual(d('2027-06-20T12:00:00Z'));
    });
  });
});
