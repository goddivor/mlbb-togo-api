import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ImportedService } from './imported.service';
import { PrismaService } from '../prisma/prisma.service';
import { PlayerStatsService } from '../stats/player-stats.service';
import {
  IMPORTED_EMAIL_DOMAIN,
  LEGACY_REGISTRY_BACKUP_KEY,
  LEGACY_REGISTRY_KEY,
} from './imported-merge.logic';

/**
 * In-memory Prisma stand-in: a tiny document store with the handful of
 * operations the service uses (`findMany`, `findUnique`, `count`, `update`,
 * `updateMany`, `delete`, `deleteMany`) and a `$transaction` that runs the
 * thunks the service queued. Enough to exercise the whole merge without a
 * database, in the spirit of the other service specs.
 */
type Row = Record<string, any>;

function matches(row: Row, where: any): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'OR') {
      if (!(cond as any[]).some((c) => matches(row, c))) return false;
      continue;
    }
    if (key === 'NOT') {
      if (matches(row, cond)) return false;
      continue;
    }
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      const c = cond as any;
      if ('in' in c && !c.in.includes(row[key])) return false;
      if ('not' in c && row[key] === c.not) return false;
      if ('contains' in c && !String(row[key] ?? '').includes(c.contains)) return false;
      continue;
    }
    // Prisma reads a missing boolean column as its default (false), not as
    // undefined: `isBanned: false` must still match a row that never set it.
    if (typeof cond === 'boolean') {
      if (!!row[key] !== cond) return false;
      continue;
    }
    if (row[key] !== cond) return false;
  }
  return true;
}

function makeDb(seed: Record<string, Row[]>) {
  const store: Record<string, Row[]> = {};
  for (const [k, v] of Object.entries(seed)) store[k] = v.map((r) => ({ ...r }));
  const ops: string[] = [];

  /**
   * Writes are lazy thenables, like Prisma's: nothing happens until they are
   * awaited, which is what lets `$transaction` receive them as a list.
   */
  const lazy = <T>(run: () => T) => ({
    then: (resolve: any, reject: any) => {
      try {
        return Promise.resolve(run()).then(resolve, reject);
      } catch (e) {
        return Promise.reject(e).then(resolve, reject);
      }
    },
  });

  const model = (name: string) => {
    store[name] ||= [];
    const rows = () => store[name];
    return {
      findMany: async ({ where }: any = {}) =>
        rows()
          .filter((r) => matches(r, where))
          .map((r) => ({ ...r })),
      findUnique: async ({ where }: any) => {
        const row = rows().find((r) => matches(r, where));
        return row ? { ...row } : null;
      },
      findFirst: async ({ where }: any = {}) => {
        const row = rows().find((r) => matches(r, where));
        return row ? { ...row } : null;
      },
      count: async ({ where }: any = {}) => rows().filter((r) => matches(r, where)).length,
      update: ({ where, data }: any) =>
        lazy(() => {
          const row = rows().find((r) => matches(r, where));
          if (!row) throw new Error(`${name}: row not found`);
          Object.assign(row, data);
          ops.push(`update:${name}`);
          return { ...row };
        }),
      updateMany: ({ where, data }: any) =>
        lazy(() => {
          const hit = rows().filter((r) => matches(r, where));
          for (const row of hit) Object.assign(row, data);
          ops.push(`updateMany:${name}:${hit.length}`);
          return { count: hit.length };
        }),
      delete: ({ where }: any) =>
        lazy(() => {
          const i = rows().findIndex((r) => matches(r, where));
          if (i < 0) throw new Error(`${name}: row not found`);
          const [row] = rows().splice(i, 1);
          ops.push(`delete:${name}`);
          return row;
        }),
      deleteMany: ({ where }: any) =>
        lazy(() => {
          const keep = rows().filter((r) => !matches(r, where));
          const n = rows().length - keep.length;
          store[name] = keep;
          if (n) ops.push(`deleteMany:${name}:${n}`);
          return { count: n };
        }),
      create: ({ data }: any) =>
        lazy(() => {
          const row = { id: `${name}-${rows().length + 1}`, ...data };
          rows().push(row);
          return { ...row };
        }),
    };
  };

  const prisma: any = new Proxy(
    {
      $transaction: async (queued: any[]) => {
        const out = [];
        for (const q of queued) out.push(await q);
        return out;
      },
      __store: store,
      __ops: ops,
    },
    {
      get(target, prop: string) {
        if (prop in target) return (target as any)[prop];
        return model(prop);
      },
    },
  );
  return prisma;
}

const SRC = 'a'.repeat(24);
const DST = 'b'.repeat(24);

const baseSeed = () => ({
  user: [
    {
      id: SRC,
      username: 'kyle-ghost',
      email: `kyle-ghost${IMPORTED_EMAIL_DOMAIN}`,
      provider: 'imported',
      googleId: null,
      gameNickname: 'Kyle_Ghost',
      mlbbRoleId: null,
      isSystemAccount: false,
      avatar: null,
      bio: null,
      role: 'jungle',
      wins: 0,
      losses: 0,
      mvpCount: 0,
      createdAt: new Date('2026-01-01'),
    },
    {
      id: DST,
      username: 'kyleghost',
      email: 'kyle@gmail.com',
      provider: 'google',
      googleId: 'g-1',
      gameNickname: 'KyleGhost',
      mlbbRoleId: 123,
      isSystemAccount: false,
      avatar: null,
      bio: null,
      role: 'jungle',
      wins: 1,
      losses: 0,
      mvpCount: 0,
      createdAt: new Date('2026-02-01'),
    },
  ],
  esportTeam: [{ id: 't1', name: 'ETERNUM ALPHA' }],
  esportSeason: [
    {
      id: 's1',
      name: 'Saison 1',
      summary: JSON.stringify({
        standings: [{ teamId: 't1', points: 9 }],
        legacy: { rosters: [{ teamId: 't1', userId: SRC, role: 'jungle' }] },
      }),
    },
  ],
  esportTeamMember: [{ id: 'mem1', teamId: 't1', userId: SRC, isCaptain: true }],
  esportMatchPlayer: [{ id: 'mp1', matchId: 'm1', userId: SRC, teamId: 't1' }],
  esportMatch: [
    {
      id: 'm1',
      seasonId: 's1',
      mvpUserId: SRC,
      games: JSON.stringify([
        { number: 1, mvpUserId: SRC, picks: [{ userId: SRC, teamId: 't1', hero: 'Lancelot' }] },
      ]),
    },
  ],
  seasonAward: [{ id: 'aw1', seasonId: 's1', userId: SRC, category: 'mvp', title: null }],
  esportTeamStaff: [],
  tournament: [],
  rewardElection: [],
  friendship: [],
  appSetting: [
    {
      id: 'set1',
      key: LEGACY_REGISTRY_KEY,
      value: JSON.stringify({
        version: 1,
        players: { '11': SRC },
        teamMembers: { '1:11': 'mem1' },
        matches: { '1': 'm1' },
      }),
    },
    {
      id: 'set2',
      key: LEGACY_REGISTRY_BACKUP_KEY,
      value: JSON.stringify({ version: 1, players: { '11': SRC }, matches: { '1': 'm1' } }),
    },
  ],
  adminLog: [],
  notification: [],
  xpEvent: [],
});

function makeService(seed: Record<string, Row[]> = baseSeed()) {
  const prisma = makeDb(seed);
  const stats = { recomputeUsers: jest.fn().mockResolvedValue(1) };
  const service = new ImportedService(
    prisma as unknown as PrismaService,
    stats as unknown as PlayerStatsService,
  );
  return { service, prisma, stats };
}

const actor = { id: 'admin-1', username: 'wtadmin' };

describe('ImportedService.preview', () => {
  it('describes everything that moves', async () => {
    const { service } = makeService();
    const plan = await service.preview(SRC, DST);
    expect(plan.canMerge).toBe(true);
    expect(plan.reasons).toEqual([]);
    expect(plan.moves.teamMemberships).toEqual([
      { id: 'mem1', teamId: 't1', teamName: 'ETERNUM ALPHA', isCaptain: true },
    ]);
    expect(plan.moves.matchPlayers).toBe(1);
    expect(plan.moves.awards).toHaveLength(1);
    expect(plan.moves.gamePicks).toBe(2);
    expect(plan.moves.matchMvp).toBe(1);
    expect(plan.moves.registryEntries).toEqual(['11']);
    expect(plan.moves.seasonArchives).toBe(1);
  });

  it('drops a membership the target already holds', async () => {
    const seed = baseSeed();
    seed.esportTeamMember.push({ id: 'mem2', teamId: 't1', userId: DST, isCaptain: false });
    const { service } = makeService(seed);
    const plan = await service.preview(SRC, DST);
    expect(plan.moves.teamMemberships).toEqual([]);
    expect(plan.moves.droppedTeamMemberships).toHaveLength(1);
    expect(plan.canMerge).toBe(true);
  });

  it('refuses when the target already has a sheet on the same match', async () => {
    const seed = baseSeed();
    seed.esportMatchPlayer.push({ id: 'mp2', matchId: 'm1', userId: DST, teamId: 't1' });
    const { service } = makeService(seed);
    const plan = await service.preview(SRC, DST);
    expect(plan.canMerge).toBe(false);
    expect(plan.reasons).toEqual([{ code: 'match_conflict', count: 1 }]);
    expect(plan.conflicts).toEqual([{ matchId: 'm1', seasonName: 'Saison 1' }]);
    await expect(service.merge(SRC, DST, actor)).rejects.toThrow(ConflictException);
  });

  it('refuses when the placeholder holds authored content', async () => {
    const seed: any = baseSeed();
    seed.post = [{ id: 'p1', authorId: SRC }];
    const { service } = makeService(seed);
    const plan = await service.preview(SRC, DST);
    expect(plan.canMerge).toBe(false);
    expect(plan.blocking).toEqual([{ model: 'post', count: 1 }]);
    // Codes, never sentences: the admin interface is bilingual.
    expect(plan.reasons).toEqual([{ code: 'blocking', model: 'post', count: 1 }]);
  });

  it('refuses a target that is itself an unclaimed imported profile', async () => {
    const seed = baseSeed();
    seed.user[1] = {
      ...seed.user[1],
      provider: 'imported',
      googleId: null,
      email: `kyleghost${IMPORTED_EMAIL_DOMAIN}`,
    };
    const { service } = makeService(seed);
    await expect(service.preview(SRC, DST)).rejects.toThrow(BadRequestException);
  });

  it('refuses a source that is not an imported profile, a missing target and self-merge', async () => {
    const { service } = makeService();
    await expect(service.preview(DST, SRC)).rejects.toThrow(BadRequestException);
    await expect(service.preview(SRC, 'c'.repeat(24))).rejects.toThrow(NotFoundException);
    await expect(service.preview(SRC, SRC)).rejects.toThrow(BadRequestException);
    await expect(service.preview('c'.repeat(24), DST)).rejects.toThrow(NotFoundException);
  });
});

describe('ImportedService.merge', () => {
  it('moves the history, repoints the registry and deletes the placeholder', async () => {
    const { service, prisma, stats } = makeService();
    const out = await service.merge(SRC, DST, actor);
    expect(out.success).toBe(true);

    const s = prisma.__store;
    expect(s.user.map((u: any) => u.id)).toEqual([DST]);
    expect(s.esportTeamMember[0].userId).toBe(DST);
    expect(s.esportMatchPlayer[0].userId).toBe(DST);
    expect(s.seasonAward[0].userId).toBe(DST);
    expect(s.esportMatch[0].mvpUserId).toBe(DST);
    const games = JSON.parse(s.esportMatch[0].games);
    expect(games[0].mvpUserId).toBe(DST);
    expect(games[0].picks[0].userId).toBe(DST);
    expect(games[0].picks[0].hero).toBe('Lancelot');
    const reg = JSON.parse(s.appSetting[0].value);
    expect(reg.players).toEqual({ '11': DST });
    expect(reg.matches).toEqual({ '1': 'm1' });
    // The membership row moved, so its registry entry still points at it.
    expect(reg.teamMembers).toEqual({ '1:11': 'mem1' });
    // The backup follows: restoring it must never resurrect the placeholder.
    expect(JSON.parse(s.appSetting[1].value).players).toEqual({ '11': DST });

    const summary = JSON.parse(s.esportSeason[0].summary);
    expect(summary.legacy.rosters).toEqual([{ teamId: 't1', userId: DST, role: 'jungle' }]);
    expect(summary.standings).toEqual([{ teamId: 't1', points: 9 }]);

    expect(stats.recomputeUsers).toHaveBeenCalledWith([DST]);
    expect(s.adminLog).toHaveLength(1);
    expect(s.adminLog[0].action).toBe('imported.merge');
    expect(s.adminLog[0].admin).toBe('wtadmin');
    expect(s.adminLog[0].target).toBe(DST);
  });

  it('drops the placeholder residue instead of moving it', async () => {
    const seed: any = baseSeed();
    seed.notification = [{ id: 'n1', userId: SRC }];
    seed.xpEvent = [{ id: 'x1', userId: SRC }];
    seed.friendship = [{ id: 'f1', requesterId: 'other', addresseeId: SRC }];
    const { service, prisma } = makeService(seed);
    const out = await service.merge(SRC, DST, actor);
    expect(prisma.__store.notification).toEqual([]);
    expect(prisma.__store.xpEvent).toEqual([]);
    expect(prisma.__store.friendship).toEqual([]);
    expect(out.dropped.map((d: any) => d.model).sort()).toEqual([
      'friendship',
      'notification',
      'xpEvent',
    ]);
  });

  it('prunes the registry entry of a membership it drops', async () => {
    const seed = baseSeed();
    seed.esportTeamMember.push({ id: 'mem2', teamId: 't1', userId: DST, isCaptain: false });
    const { service, prisma } = makeService(seed);
    await service.merge(SRC, DST, actor);
    // `mem1` was dropped (the target already held t1), so nothing may still map to it.
    expect(JSON.parse(prisma.__store.appSetting[0].value).teamMembers).toEqual({});
    expect(prisma.__store.esportTeamMember.map((m: any) => m.id)).toEqual(['mem2']);
  });

  it('answers 409 when a concurrent merge takes a row away, and 404 when the source is gone', async () => {
    const raced = makeService();
    const boom: any = new Error('record not found');
    boom.code = 'P2025';
    raced.prisma.$transaction = async () => {
      throw boom;
    };
    await expect(raced.service.merge(SRC, DST, actor)).rejects.toThrow(ConflictException);
    // The source really went away in the meantime: 404, not 409.
    const gone = makeService();
    gone.prisma.$transaction = async () => {
      gone.prisma.__store.user = gone.prisma.__store.user.filter((u: any) => u.id !== SRC);
      throw boom;
    };
    await expect(gone.service.merge(SRC, DST, actor)).rejects.toThrow(NotFoundException);
  });

  it('replays into a counter recompute once the placeholder is gone', async () => {
    const { service, prisma, stats } = makeService();
    await service.merge(SRC, DST, actor);
    stats.recomputeUsers.mockClear();

    const again = await service.merge(SRC, DST, actor);
    expect(again.alreadyMerged).toBe(true);
    expect(again.target.id).toBe(DST);
    expect(stats.recomputeUsers).toHaveBeenCalledWith([DST]);
    expect(prisma.__store.adminLog.map((l: any) => l.action)).toContain('imported.merge.replay');
  });

  it('still refuses a replay whose target does not exist either', async () => {
    const { service } = makeService();
    await service.merge(SRC, DST, actor);
    await expect(service.merge(SRC, 'c'.repeat(24), actor)).rejects.toThrow(NotFoundException);
  });

  it('never replays a source this operation never merged', async () => {
    const { service, prisma, stats } = makeService();
    const stranger = 'd'.repeat(24);
    // Well-formed, non-existent source + a perfectly real target: without the
    // admin-log proof this must be a 404, not a recompute of that account.
    await expect(service.merge(stranger, DST, actor)).rejects.toThrow(NotFoundException);
    expect(stats.recomputeUsers).not.toHaveBeenCalled();
    expect(prisma.__store.adminLog).toHaveLength(0);
  });
});

describe('ImportedService.setExpectedEmail', () => {
  it('sets a real address and logs it', async () => {
    const { service, prisma } = makeService();
    const out = await service.setExpectedEmail(SRC, '  Kyle.Ghost@Gmail.com ', actor);
    expect(out.profile.email).toBe('kyle.ghost@gmail.com');
    expect(out.profile.emailSet).toBe(true);
    expect(prisma.__store.adminLog[0].action).toBe('imported.email');
  });

  it('clears it back to the placeholder mailbox', async () => {
    const seed = baseSeed();
    seed.user[0].email = 'kyle@gmail.com';
    const { service } = makeService(seed);
    const out = await service.setExpectedEmail(SRC, null, actor);
    expect(out.profile.email).toBe(`kyle-ghost${IMPORTED_EMAIL_DOMAIN}`);
    expect(out.profile.emailSet).toBe(false);
  });

  it('reports an unchanged value without writing', async () => {
    const { service, prisma } = makeService();
    const out = await service.setExpectedEmail(SRC, null, actor);
    expect(out.unchanged).toBe(true);
    expect(prisma.__store.adminLog).toHaveLength(0);
  });

  it('refuses an address already used, an invalid one and a claimed profile', async () => {
    const { service } = makeService();
    await expect(service.setExpectedEmail(SRC, 'kyle@gmail.com', actor)).rejects.toThrow(
      ConflictException,
    );
    // Held as somebody's `googleEmail`: Google login would never adopt it here.
    const withGoogleEmail = baseSeed();
    (withGoogleEmail.user[1] as any).googleEmail = 'other.person@gmail.com';
    await expect(
      makeService(withGoogleEmail).service.setExpectedEmail(SRC, 'other.person@gmail.com', actor),
    ).rejects.toThrow(ConflictException);
    await expect(service.setExpectedEmail(SRC, 'nope', actor)).rejects.toThrow(BadRequestException);
    // Every refusal carries a code the bilingual UI translates.
    await expect(service.setExpectedEmail(SRC, 'kyle@gmail.com', actor)).rejects.toMatchObject({
      response: { code: 'email_taken' },
    });

    const seed = baseSeed();
    seed.user[0].googleId = 'g-9';
    const claimed = makeService(seed);
    await expect(claimed.service.setExpectedEmail(SRC, 'a@b.com', actor)).rejects.toThrow(
      ConflictException,
    );
  });
});

describe('ImportedService.list and candidates', () => {
  it('lists imported profiles with what they hold', async () => {
    const { service } = makeService();
    const rows = await service.list();
    expect(rows).toHaveLength(1);
    expect(rows[0].username).toBe('kyle-ghost');
    expect(rows[0].emailSet).toBe(false);
    expect(rows[0].matchesPlayed).toBe(1);
    expect(rows[0].teams).toEqual([{ id: 't1', name: 'ETERNUM ALPHA' }]);
    expect(rows[0].seasons).toEqual([{ id: 's1', name: 'Saison 1' }]);
    expect(rows[0].awards).toBe(1);
  });

  it('suggests the look-alike account and never another imported profile', async () => {
    const seed = baseSeed();
    seed.user.push({
      ...seed.user[0],
      id: 'other-imported',
      username: 'kyle-ghost-2',
      email: `kyle-ghost-2${IMPORTED_EMAIL_DOMAIN}`,
    });
    const { service } = makeService(seed);
    const out = await service.candidates(SRC, '');
    expect(out.map((c: any) => c.id)).toEqual([DST]);
    expect(out[0].score).toBeGreaterThan(0.8);
  });
});

describe('ImportedService guards (review)', () => {
  it('refuses a claimed source (Google or game account) and a banned or malformed target', async () => {
    const claimed = baseSeed();
    claimed.user[0].googleId = 'g-9';
    await expect(makeService(claimed).service.preview(SRC, DST)).rejects.toThrow(BadRequestException);

    const game = baseSeed();
    game.user[0].mlbbRoleId = 42 as any;
    await expect(makeService(game).service.merge(SRC, DST, actor)).rejects.toThrow(BadRequestException);

    const banned = baseSeed();
    (banned.user[1] as any).isBanned = true;
    await expect(makeService(banned).service.preview(SRC, DST)).rejects.toThrow(BadRequestException);

    const { service } = makeService();
    await expect(service.preview(SRC, 'x')).rejects.toThrow(BadRequestException);
    await expect(service.candidates('zzz', '')).rejects.toThrow(BadRequestException);
  });
});
