import { GamificationService } from './gamification.service';
import { PrismaService } from '../prisma/prisma.service';
import { CommunityService } from '../community/community.service';
import { XP_RULES, xpForLevel } from './gamification.rules';

const U = 'user-1';

/** Minimal in-memory stand-in for the Prisma models the service touches. */
function makePrisma() {
  let seq = 0;
  const id = () => `id-${++seq}`;
  const dup = () => Object.assign(new Error('Unique constraint'), { code: 'P2002' });

  const xpEvents: any[] = [];
  const progress = new Map<string, any>();
  const missions: any[] = [];
  const achievements: any[] = [];
  const counters = new Map<string, number>();
  const users = new Map<string, any>([[U, { id: U, username: 'tank', roleUser: 'user', badges: '[]' }]]);
  let match: any = null;
  let players: any[] = [];

  /** Subset of the Prisma filters used by the engine on XP events. */
  const matchEvent = (e: any, where: any = {}) => {
    if (where.userId !== undefined) {
      if (typeof where.userId === 'string' ? e.userId !== where.userId : !where.userId.in.includes(e.userId)) return false;
    }
    if (where.type !== undefined) {
      if (typeof where.type === 'string' ? e.type !== where.type : !where.type.in.includes(e.type)) return false;
    }
    if (where.createdAt?.gte && e.createdAt < where.createdAt.gte) return false;
    if (typeof where.refId === 'string' && e.refId !== where.refId) return false;
    if (typeof where.refId === 'object' && where.refId.startsWith && !e.refId.startsWith(where.refId.startsWith)) return false;
    if (typeof where.refId === 'object' && where.refId.endsWith && !e.refId.endsWith(where.refId.endsWith)) return false;
    return true;
  };

  const prisma = {
    _state: { xpEvents, progress, missions, achievements, users },
    setMatch(m: any, p: any[]) {
      match = m;
      players = p;
    },
    xpEvent: {
      create: jest.fn(async ({ data }: any) => {
        if (
          xpEvents.some(
            (e) => e.userId === data.userId && e.type === data.type && e.refId === data.refId,
          )
        )
          throw dup();
        const row = { id: id(), createdAt: new Date(), ...data };
        xpEvents.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const k = where.userId_type_refId;
        const row = xpEvents.find((e) => e.userId === k.userId && e.type === k.type && e.refId === k.refId);
        Object.assign(row, data);
        return row;
      }),
      delete: jest.fn(async ({ where }: any) => {
        const k = where.userId_type_refId;
        const i = xpEvents.findIndex((e) => e.userId === k.userId && e.type === k.type && e.refId === k.refId);
        return xpEvents.splice(i, 1)[0];
      }),
      count: jest.fn(async ({ where }: any) => xpEvents.filter((e) => matchEvent(e, where)).length),
      aggregate: jest.fn(async ({ where }: any) => ({
        _sum: { amount: xpEvents.filter((e) => matchEvent(e, where)).reduce((n, e) => n + e.amount, 0) },
      })),
      findFirst: jest.fn(async ({ where }: any) => xpEvents.find((e) => matchEvent(e, where)) ?? null),
      findUnique: jest.fn(async ({ where }: any) => {
        const k = where.userId_type_refId;
        return xpEvents.find((e) => e.userId === k.userId && e.type === k.type && e.refId === k.refId) ?? null;
      }),
      groupBy: jest.fn(async ({ where }: any) => {
        const map = new Map<string, number>();
        for (const e of xpEvents)
          if (e.userId === where.userId) map.set(e.type, (map.get(e.type) ?? 0) + 1);
        return Array.from(map, ([type, n]) => ({ type, _count: { _all: n } }));
      }),
      findMany: jest.fn(async ({ where, take }: any) =>
        xpEvents
          .filter((e) => e.userId === where.userId)
          .reverse()
          .slice(0, take),
      ),
    },
    // Atomic counters: the read-modify-write happens in one synchronous step, like $inc.
    xpCounter: {
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const k = `${where.userId_key.userId}|${where.userId_key.key}`;
        const value = (counters.get(k) ?? 0) + (counters.has(k) ? update.value.increment : create.value);
        counters.set(k, value);
        return { value };
      }),
    },
    userProgress: {
      count: jest.fn(async () => progress.size),
      findUnique: jest.fn(async ({ where }: any) => progress.get(where.userId) ?? null),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const row = progress.get(where.userId);
        if (row) row.xp += update.xp.increment;
        else progress.set(where.userId, { userId: where.userId, ...create, updatedAt: new Date() });
        return progress.get(where.userId);
      }),
      update: jest.fn(async ({ where, data }: any) => {
        Object.assign(progress.get(where.userId), data);
        return progress.get(where.userId);
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const row = progress.get(where.userId);
        if (!row) return { count: 0 };
        if (where.level && !(row.level < where.level.lt)) return { count: 0 };
        if (where.xp && !(row.xp >= where.xp.gte)) return { count: 0 };
        if (data.xp?.increment !== undefined) row.xp += data.xp.increment;
        else Object.assign(row, data);
        return { count: 1 };
      }),
      findMany: jest.fn(async ({ take }: any) =>
        Array.from(progress.values())
          .sort((a, b) => b.xp - a.xp)
          .slice(0, take),
      ),
    },
    userMission: {
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const k = where.userId_missionId_periodKey;
        let row = missions.find(
          (m) => m.userId === k.userId && m.missionId === k.missionId && m.periodKey === k.periodKey,
        );
        if (row) row.progress += update.progress.increment;
        else {
          row = { id: id(), completedAt: null, ...create };
          missions.push(row);
        }
        return { ...row };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = missions.find((m) => m.id === where.id);
        Object.assign(row, data);
        return row;
      }),
      count: jest.fn(async ({ where }: any) =>
        missions.filter((m) => m.userId === where.userId && m.completedAt).length,
      ),
      findMany: jest.fn(async ({ where }: any) =>
        missions.filter(
          (m) =>
            m.userId === where.userId &&
            (!where.periodKey || where.periodKey.in.includes(m.periodKey)) &&
            (!where.missionId || where.missionId.in.includes(m.missionId)),
        ),
      ),
    },
    userAchievement: {
      groupBy: jest.fn(async () => {
        const map = new Map<string, number>();
        for (const a of achievements) map.set(a.achievementId, (map.get(a.achievementId) ?? 0) + 1);
        return Array.from(map, ([achievementId, n]) => ({
          achievementId,
          _count: { _all: n },
          _min: { unlockedAt: null },
          _max: { unlockedAt: null },
        }));
      }),
      findMany: jest.fn(async ({ where }: any) =>
        achievements.filter((a) => a.userId === where.userId),
      ),
      create: jest.fn(async ({ data }: any) => {
        if (
          achievements.some(
            (a) => a.userId === data.userId && a.achievementId === data.achievementId,
          )
        )
          throw dup();
        const row = { id: id(), unlockedAt: new Date(), ...data };
        achievements.push(row);
        return row;
      }),
    },
    user: {
      findUnique: jest.fn(async ({ where }: any) => users.get(where.id) ?? null),
      findMany: jest.fn(async ({ where }: any) =>
        Array.from(users.values()).filter(
          (u) =>
            where.id.in.includes(u.id) &&
            (where.isSystemAccount === undefined || !!u.isSystemAccount === where.isSystemAccount) &&
            (where.isBanned === undefined || !!u.isBanned === where.isBanned),
        ),
      ),
    },
    esportMatch: {
      findUnique: jest.fn(async () => match),
      findMany: jest.fn(async () => (match ? [match] : [])),
    },
    esportMatchPlayer: { findMany: jest.fn(async () => players) },
  };
  // Models the engine only reads for achievement facts: empty by default.
  const stub = () => ({
    findMany: jest.fn(async () => []),
    findFirst: jest.fn(async () => null),
    findUnique: jest.fn(async () => null),
    count: jest.fn(async () => 0),
    groupBy: jest.fn(async () => []),
  });
  return new Proxy(prisma, {
    get: (target: any, key) => (key in target ? target[key] : (target[key] = stub())),
  }) as typeof prisma;
}

describe('GamificationService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let community: { notifyUser: jest.Mock };
  let service: GamificationService;

  beforeEach(() => {
    prisma = makePrisma();
    community = { notifyUser: jest.fn().mockResolvedValue(null) };
    service = new GamificationService(
      prisma as unknown as PrismaService,
      community as unknown as CommunityService,
    );
  });

  describe('track', () => {
    it('grants the configured XP and unlocks first achievements', async () => {
      const res = await service.track(U, 'forum_post', 'post-1');
      expect(res.granted).toBe(true);
      expect(res.amount).toBe(XP_RULES.forum_post);
      expect([...res.unlocked].sort()).toEqual(['first_steps', 'first_words']);
      // 5 XP for the post + 10 XP daily mission + 2 x 20 XP achievement bonus.
      expect(res.missionsCompleted).toEqual(['daily_post']);
      expect(res.xp).toBe(55);
      expect(res.level).toBe(1);
      expect(community.notifyUser).toHaveBeenCalledWith(
        U,
        expect.objectContaining({ type: 'achievement_unlock' }),
      );
    });

    it('is idempotent for the same (user, type, refId)', async () => {
      await service.track(U, 'match_played', 'm1');
      const again = await service.track(U, 'match_played', 'm1');
      expect(again.granted).toBe(false);
      expect(again.amount).toBe(0);
      expect(prisma._state.xpEvents.filter((e) => e.type === 'match_played')).toHaveLength(1);
      // A different match is a new grant.
      const other = await service.track(U, 'match_played', 'm2');
      expect(other.granted).toBe(true);
    });

    it('levels up and notifies once the threshold is crossed', async () => {
      // 6 matches: 6 * 50 XP + achievement bonuses (first_steps 20, first_match 30) = 350 > 283.
      let last: any;
      for (let i = 0; i < 6; i++) last = await service.track(U, 'match_played', `m${i}`);
      expect(last.level).toBe(2);
      expect(last.xp).toBeGreaterThanOrEqual(xpForLevel(2));
      const levelUps = community.notifyUser.mock.calls.filter((c) => c[1].type === 'level_up');
      expect(levelUps).toHaveLength(1);
      expect(levelUps[0][1].data.level).toBe(2);
      expect(prisma._state.progress.get(U).level).toBe(2);
    });

    it('notifies a level up only once when grants run concurrently', async () => {
      for (let i = 0; i < 4; i++) await service.track(U, 'match_played', `m${i}`);
      // Two overlapping grants that both cross the level 2 threshold.
      await Promise.all([
        service.track(U, 'match_played', 'm4'),
        service.track(U, 'match_played', 'm5'),
      ]);
      const levelUps = community.notifyUser.mock.calls.filter((c) => c[1].type === 'level_up');
      expect(levelUps).toHaveLength(1);
      expect(prisma._state.progress.get(U).level).toBe(2);
    });

    it('never fails the caller through trackSafe', async () => {
      prisma.xpEvent.create.mockRejectedValueOnce(new Error('db down'));
      await expect(service.trackSafe(U, 'forum_post', 'p')).resolves.toBeNull();
      await expect(service.trackSafe(null, 'forum_post', 'p')).resolves.toBeNull();
    });
  });

  describe('missions', () => {
    it('advances daily and weekly missions and rewards completion once', async () => {
      const res = await service.track(U, 'match_played', 'm1');
      expect(res.missionsCompleted).toEqual(['daily_match']);
      const me = await service.getMe(U);
      const daily = me.missions.find((m) => m.id === 'daily_match');
      const weekly = me.missions.find((m) => m.id === 'weekly_matches');
      expect(daily).toMatchObject({ progress: 1, target: 1, completed: true });
      expect(weekly).toMatchObject({ progress: 1, target: 5, completed: false });
      expect(prisma._state.xpEvents.find((e) => e.type === 'mission')).toMatchObject({
        refId: expect.stringMatching(/^daily_match:\d{4}-\d{2}-\d{2}$/),
        amount: 25,
      });
      // A second match today does not complete the daily mission again.
      const again = await service.track(U, 'match_played', 'm2');
      expect(again.missionsCompleted).toEqual([]);
      expect(prisma._state.xpEvents.filter((e) => e.type === 'mission')).toHaveLength(1);
    });

    it('rolls progress over to a fresh period', async () => {
      const day1 = new Date('2026-09-17T10:00:00Z'); // Thursday
      const day2 = new Date('2026-09-18T10:00:00Z'); // Friday, same ISO week
      const nextWeek = new Date('2026-09-21T10:00:00Z'); // Monday

      await service.track(U, 'forum_post', 'p1', day1);
      let me = await service.getMe(U, day1);
      expect(me.missions.find((m) => m.id === 'daily_post')).toMatchObject({
        progress: 1,
        completed: true,
        periodKey: '2026-09-17',
      });

      // Next day: daily is back to zero, weekly keeps counting.
      me = await service.getMe(U, day2);
      expect(me.missions.find((m) => m.id === 'daily_post')).toMatchObject({
        progress: 0,
        completed: false,
        periodKey: '2026-09-18',
      });
      const res = await service.track(U, 'forum_post', 'p2', day2);
      expect(res.missionsCompleted).toEqual(['daily_post']);
      me = await service.getMe(U, day2);
      expect(me.missions.find((m) => m.id === 'weekly_posts')).toMatchObject({
        progress: 2,
        target: 3,
        completed: false,
        periodKey: '2026-W38',
      });

      // Next week: the weekly mission restarts.
      me = await service.getMe(U, nextWeek);
      expect(me.missions.find((m) => m.id === 'weekly_posts')).toMatchObject({
        progress: 0,
        periodKey: '2026-W39',
      });
      // The daily reward was granted twice (two distinct period keys).
      expect(prisma._state.xpEvents.filter((e) => e.type === 'mission')).toHaveLength(2);
    });
  });

  describe('syncMatch', () => {
    it('rewards played, win and MVP for a completed match only', async () => {
      prisma.setMatch({ id: 'm1', status: 'scheduled', teamAId: 'A', teamBId: 'B', winnerTeamId: null }, [
        { userId: U, teamId: 'A', isMvp: true },
      ]);
      await service.syncMatch('m1');
      expect(prisma._state.xpEvents).toHaveLength(0);

      prisma.setMatch({ id: 'm1', status: 'completed', teamAId: 'A', teamBId: 'B', winnerTeamId: 'A' }, [
        { userId: U, teamId: 'A', isMvp: true },
        { userId: 'user-2', teamId: 'B', isMvp: false },
      ]);
      await service.syncMatch('m1');
      await service.syncMatch('m1');
      const mine = prisma._state.xpEvents.filter((e) => e.userId === U && !['achievement', 'mission'].includes(e.type));
      expect(mine.map((e) => e.type).sort()).toEqual(['match_mvp', 'match_played', 'match_win']);
      const theirs = prisma._state.xpEvents.filter((e) => e.userId === 'user-2' && !['achievement', 'mission'].includes(e.type));
      expect(theirs.map((e) => e.type)).toEqual(['match_played']);
    });
  });

  describe('read API', () => {
    it('lists achievements with locked/unlocked state and hides secrets publicly', async () => {
      await service.track(U, 'forum_post', 'p1');
      const me = await service.getMe(U);
      const first = me.achievements.find((a) => a.id === 'first_steps');
      expect(first?.unlocked).toBe(true);
      expect(first?.unlockedAt).toBeInstanceOf(Date);
      expect(me.achievements.find((a) => a.id === 'wins_10')?.unlocked).toBe(false);
      // Secret and locked: listed for the owner, but hidden (no icon, no frame).
      expect(me.achievements.find((a) => a.id === 'night_owl')).toMatchObject({ hidden: true, icon: 'lock', family: 'secrets' });
      expect(first).toMatchObject({ family: 'progression', rarity: 'common', percent: 100 });
      expect(me.members).toBe(1);
      expect(me.recentEvents[0]).toMatchObject({ type: 'achievement', amount: 20 });

      const pub = await service.getPublic(U);
      expect(pub.achievements.some((a) => a.id === 'night_owl')).toBe(false);
      expect(pub.achievements.some((a) => a.id === 'on_fire')).toBe(true);
      expect(pub.achievementsUnlocked).toBe(2);
      expect(pub.user).toMatchObject({ id: U, username: 'tank' });
    });

    it('ranks the leaderboard by XP, keeps staff players and skips system accounts', async () => {
      prisma._state.users.set('user-2', { id: 'user-2', username: 'mage', roleUser: 'user', badges: '[]' });
      prisma._state.users.set('staff', { id: 'staff', username: 'staffer', roleUser: 'admin', badges: '[]' });
      prisma._state.users.set('admin', {
        id: 'admin',
        username: 'admin',
        roleUser: 'admin',
        isSystemAccount: true,
        badges: '[]',
      });
      await service.track(U, 'forum_post', 'p1');
      await service.track('user-2', 'match_played', 'm1');
      await service.track('staff', 'match_played', 'm2');
      await service.track('admin', 'match_played', 'm1');
      const board = await service.leaderboard(10);
      expect(board.entries.map((e) => e.user.username).sort()).toEqual(['mage', 'staffer', 'tank']);
      expect(board.entries[0]).toMatchObject({ rank: 1, level: 1 });
    });
  });
  describe('guard-rails (catalogue §2.2)', () => {
    const OLD = new Date('2026-01-01T00:00:00Z');
    const NOW = new Date('2026-09-21T10:00:00Z');
    const addUser = (id: string, joinedAt = OLD) =>
      prisma._state.users.set(id, { id, username: id, roleUser: 'user', badges: '[]', joinedAt });

    it('stops recording forum posts after 5 per day (not counted, no XP)', async () => {
      for (let i = 1; i <= 5; i++) expect((await service.track(U, 'forum_post', `p${i}`, { now: NOW })).granted).toBe(true);
      const sixth = await service.track(U, 'forum_post', 'p6', { now: NOW });
      expect(sixth).toMatchObject({ granted: false, reason: 'cap' });
      expect(prisma._state.xpEvents.filter((e) => e.type === 'forum_post')).toHaveLength(5);
    });

    it('never exceeds a cap under concurrent grants (atomic counters)', async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => service.track(U, 'forum_post', `race${i}`, { now: NOW })),
      );
      expect(results.filter((r) => r.granted)).toHaveLength(5);
      expect(prisma._state.xpEvents.filter((e) => e.type === 'forum_post')).toHaveLength(5);
      // A duplicate key never consumes a slot.
      expect((await service.track(U, 'forum_post', 'race0', { now: NOW })).reason).toBe('duplicate');
    });

    it('does not pay again a friendship already rewarded with its legacy key', async () => {
      addUser('a');
      addUser('b');
      prisma._state.xpEvents.push({ userId: 'a', type: 'friend_added', refId: 'fr-old', amount: 10, createdAt: OLD });
      await service.trackFriendship('a', 'b', NOW, 'fr-old');
      const rows = prisma._state.xpEvents.filter((e) => e.type === 'friend_added');
      expect(rows.map((e) => [e.userId, e.refId]).sort()).toEqual([
        ['a', 'fr-old'],
        ['b', 'friend:a:b'],
      ]);
    });

    it('reports live: false for an already counted day when nothing is live', async () => {
      const stream = { getLive: jest.fn(async () => ({ live: true })) };
      const svc = new GamificationService(prisma as unknown as PrismaService, community as unknown as CommunityService, undefined, stream as any);
      expect(await svc.trackSpectator(U, NOW)).toMatchObject({ counted: true, live: true, days: 1 });
      stream.getLive.mockResolvedValue({ live: false });
      expect(await svc.trackSpectator(U, NOW)).toEqual({ counted: false, live: false, days: 1 });
    });

    it('caps the social XP of a day at 60 but still records the action', async () => {
      // 5 posts (25) + 5 comments (10) + 2 pick & ban (10) + 1 coach (5) = 50, then friends at 10.
      for (let i = 1; i <= 5; i++) await service.track(U, 'forum_post', `p${i}`, { now: NOW });
      for (let i = 1; i <= 5; i++) await service.track(U, 'comment_posted', `c${i}`, { now: NOW });
      for (let i = 1; i <= 2; i++) await service.track(U, 'pickban_completed', `d${i}`, { now: NOW });
      await service.track(U, 'ai_coach_used', '2026-09-21', { now: NOW });
      const f1 = await service.track(U, 'friend_added', 'friend:a:b', { now: NOW });
      const f2 = await service.track(U, 'friend_added', 'friend:a:c', { now: NOW });
      expect(f1).toMatchObject({ granted: true, amount: 10 });
      expect(f2).toMatchObject({ granted: true, amount: 0 });
      const social = prisma._state.xpEvents.filter((e) =>
        ['forum_post', 'comment_posted', 'friend_added', 'pickban_completed', 'ai_coach_used'].includes(e.type),
      );
      expect(social.reduce((n, e) => n + e.amount, 0)).toBe(60);
      expect(prisma._state.xpEvents.find((e) => e.refId === 'friend:a:c').meta).toMatchObject({ capped: true, requested: 10 });
    });

    it('keeps competitive XP out of the social cap', async () => {
      for (let i = 1; i <= 5; i++) await service.track(U, 'forum_post', `p${i}`, { now: NOW });
      for (let i = 1; i <= 5; i++) await service.track(U, 'comment_posted', `c${i}`, { now: NOW });
      await service.track(U, 'ai_coach_used', 'day', { now: NOW });
      await service.track(U, 'pickban_completed', 'd1', { now: NOW });
      await service.track(U, 'pickban_completed', 'd2', { now: NOW });
      await service.track(U, 'friend_added', 'f1', { now: NOW });
      expect((await service.track(U, 'match_played', 'm1', { now: NOW })).amount).toBe(50);
    });

    it('counts the AI coach once a day and five times a week', async () => {
      const day = (n: number) => new Date(Date.UTC(2026, 8, 21 + n, 12));
      for (let i = 0; i < 5; i++) {
        expect((await service.track(U, 'ai_coach_used', `k${i}`, { now: day(i) })).granted).toBe(true);
      }
      expect((await service.track(U, 'ai_coach_used', 'k4b', { now: day(4) })).reason).toBe('cap');
      expect((await service.track(U, 'ai_coach_used', 'k5', { now: day(5) })).reason).toBe('cap');
      // Next ISO week (Monday 28/09).
      expect((await service.track(U, 'ai_coach_used', 'k7', { now: day(7) })).granted).toBe(true);
    });

    it('ignores self-likes, young accounts and low-level likers; counts a like once per member', async () => {
      addUser('author');
      addUser('fan');
      addUser('young', new Date('2026-09-18T00:00:00Z'));
      addUser('newbie');
      prisma._state.progress.set('fan', { userId: 'fan', xp: 1000, level: 3 });
      prisma._state.progress.set('young', { userId: 'young', xp: 1000, level: 3 });
      prisma._state.progress.set('newbie', { userId: 'newbie', xp: 10, level: 1 });

      expect(await service.trackLike('post1', 'author', 'author', NOW)).toBeNull();
      expect(await service.trackLike('post1', 'author', 'young', NOW)).toBeNull();
      expect(await service.trackLike('post1', 'author', 'newbie', NOW)).toBeNull();
      expect((await service.trackLike('post1', 'author', 'fan', NOW))?.granted).toBe(true);
      expect((await service.trackLike('post1', 'author', 'fan', NOW))?.granted).toBe(false);
      const likes = prisma._state.xpEvents.filter((e) => e.type === 'like_received');
      expect(likes).toEqual([expect.objectContaining({ userId: 'author', amount: 0, refId: 'like:post1:fan' })]);
      expect(prisma._state.progress.get('author')).toBeUndefined();
    });

    it('pauses likes between two members after more than 30 exchanged in 7 days', async () => {
      addUser('a');
      addUser('b');
      prisma._state.progress.set('a', { userId: 'a', xp: 1000, level: 3 });
      prisma._state.progress.set('b', { userId: 'b', xp: 1000, level: 3 });
      for (let i = 0; i < 16; i++) await service.trackLike(`pa${i}`, 'a', 'b', NOW);
      for (let i = 0; i < 15; i++) await service.trackLike(`pb${i}`, 'b', 'a', NOW);
      // 31 likes exchanged: the pair is paused.
      expect(prisma._state.xpEvents.filter((e) => e.type === 'like_pause')).toHaveLength(1);
      expect(await service.trackLike('pa99', 'a', 'b', NOW)).toBeNull();
      expect(await service.trackLike('pb99', 'b', 'a', new Date('2026-10-10T00:00:00Z'))).toBeNull();
      // 30 days later, likes count again; already counted ones stay.
      expect((await service.trackLike('pa100', 'a', 'b', new Date('2026-10-22T00:00:00Z')))?.granted).toBe(true);
      expect(prisma._state.xpEvents.filter((e) => e.type === 'like_received')).toHaveLength(32);
    });

    it('rewards a friendship once per pair for life, and never with a young account', async () => {
      addUser('a');
      addUser('b');
      addUser('kid', new Date('2026-09-20T00:00:00Z'));
      await service.trackFriendship('a', 'b', NOW);
      await service.trackFriendship('b', 'a', NOW); // unfriend then befriend again
      await service.trackFriendship('a', 'kid', NOW);
      const rows = prisma._state.xpEvents.filter((e) => e.type === 'friend_added');
      // 'a' earns nothing from the 2-day-old account; the newcomer still earns from 'a'.
      expect(rows.map((e) => [e.userId, e.refId]).sort()).toEqual([
        ['a', 'friend:a:b'],
        ['b', 'friend:a:b'],
        ['kid', 'friend:a:kid'],
      ]);
      expect(rows[0].meta).toMatchObject({ username: expect.any(String) });
    });

    it('pays a game account link once per mlbbRoleId on the whole platform', async () => {
      addUser('first');
      addUser('second');
      expect((await service.trackGameLinked('first', 123, NOW))?.granted).toBe(true);
      expect(await service.trackGameLinked('second', 123, NOW)).toBeNull();
      expect(prisma._state.xpEvents.filter((e) => e.type === 'game_account_linked')).toHaveLength(1);
    });
  });

  describe('admin XP correction (atomic clamp)', () => {
    it('never goes below 0, even with concurrent negative corrections', async () => {
      await service.track(U, 'match_played', 'm1');
      const xp = prisma._state.progress.get(U).xp;
      const [a, b] = await Promise.all([
        service.adjustXp(U, -xp, { reason: 'cheat', adminId: 'adm' }),
        service.adjustXp(U, -xp, { reason: 'cheat', adminId: 'adm' }),
      ]);
      expect(prisma._state.progress.get(U).xp).toBe(0);
      expect(a.applied + b.applied).toBe(-xp);
      const corrections = prisma._state.xpEvents.filter((e) => e.type === 'admin_correction');
      expect(corrections.every((e) => e.amount !== 0)).toBe(true);
    });

    it('writes nothing for a user without progress', async () => {
      const res = await service.adjustXp('ghost', -50, { reason: 'test', adminId: 'adm' });
      expect(res.applied).toBe(0);
      expect(prisma._state.xpEvents.filter((e) => e.type === 'admin_correction')).toHaveLength(0);
    });
  });

  describe('manual unlocks and listeners', () => {
    it('unlocks a manual achievement once and notifies listeners of tracked events', async () => {
      const seen: string[] = [];
      service.onTracked(async (_u, type) => {
        seen.push(type);
      });
      expect(await service.unlockAchievement(U, 'weekly_mvp')).toBe(true);
      expect(await service.unlockAchievement(U, 'weekly_mvp')).toBe(false);
      expect(prisma._state.achievements.map((a) => a.achievementId)).toContain('weekly_mvp');
      await service.track(U, 'daily_login', '2026-09-21');
      expect(seen).toEqual(['daily_login']);
    });
  });
});
