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
  const users = new Map<string, any>([[U, { id: U, username: 'tank', roleUser: 'user', badges: '[]' }]]);
  let match: any = null;
  let players: any[] = [];

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
    userProgress: {
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
        if (!row || !(row.level < where.level.lt)) return { count: 0 };
        Object.assign(row, data);
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
        missions.filter((m) => m.userId === where.userId && where.periodKey.in.includes(m.periodKey)),
      ),
    },
    userAchievement: {
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
          (u) => where.id.in.includes(u.id) && !where.roleUser?.notIn?.includes(u.roleUser),
        ),
      ),
    },
    esportMatch: { findUnique: jest.fn(async () => match) },
    esportMatchPlayer: { findMany: jest.fn(async () => players) },
  };
  return prisma;
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
      expect(res.unlocked).toEqual(['first_steps']);
      // 5 XP for the post + 10 XP daily mission + 20 XP achievement bonus.
      expect(res.missionsCompleted).toEqual(['daily_post']);
      expect(res.xp).toBe(35);
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
      expect(me.achievements.some((a) => a.id === 'on_fire')).toBe(true);
      expect(me.recentEvents[0]).toMatchObject({ type: 'achievement', amount: 20 });

      const pub = await service.getPublic(U);
      expect(pub.achievements.some((a) => a.id === 'on_fire')).toBe(false);
      expect(pub.achievementsUnlocked).toBe(1);
      expect(pub.user).toMatchObject({ id: U, username: 'tank' });
    });

    it('ranks the leaderboard by XP and skips staff accounts', async () => {
      prisma._state.users.set('user-2', { id: 'user-2', username: 'mage', roleUser: 'user', badges: '[]' });
      prisma._state.users.set('admin', { id: 'admin', username: 'admin', roleUser: 'admin', badges: '[]' });
      await service.track(U, 'forum_post', 'p1');
      await service.track('user-2', 'match_played', 'm1');
      await service.track('admin', 'match_played', 'm1');
      const board = await service.leaderboard(10);
      expect(board.entries.map((e) => e.user.username)).toEqual(['mage', 'tank']);
      expect(board.entries[0]).toMatchObject({ rank: 1, level: 1 });
    });
  });
});
