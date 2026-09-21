import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { CommunityBuildsService } from './community-builds.service';
import { CommunityBuildsEvents, CommunityBuildEvent } from './community-builds.events';
import { PrismaService } from '../prisma/prisma.service';
import { LIMITS } from './community-builds.rules';

// Minimal in-memory Prisma double: equality, `in`, `gt`, `gte` filters,
// compound unique keys and ordering are enough for this service.
let seq = 0;
const oid = () => (++seq).toString(16).padStart(24, '0');

function matches(row: any, where: any = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key.includes('_') && cond && typeof cond === 'object' && !Array.isArray(cond) && !('in' in cond)) {
      // Compound unique key, e.g. buildId_reporterId.
      if (!(key in row)) return matches(row, cond);
    }
    const value = row[key];
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as any;
      if ('in' in c) return c.in.includes(value);
      if ('gt' in c) return value > c.gt;
      if ('gte' in c) return value != null && value >= c.gte;
    }
    return value === cond;
  });
}

function table(name: string, unique: string[][] = [], defaults: Record<string, unknown> = {}) {
  const rows: any[] = [];
  const sortRows = (list: any[], orderBy: any) => {
    const orders = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
    return [...list].sort((a, b) => {
      for (const o of orders) {
        const [k, dir] = Object.entries(o)[0] as [string, string];
        if (a[k] === b[k]) continue;
        const cmp = a[k] > b[k] ? 1 : -1;
        return dir === 'desc' ? -cmp : cmp;
      }
      return 0;
    });
  };
  return {
    rows,
    findUnique: jest.fn(async ({ where }: any) => rows.find((r) => matches(r, where)) ?? null),
    findFirst: jest.fn(async ({ where }: any) => rows.find((r) => matches(r, where)) ?? null),
    findMany: jest.fn(async ({ where, orderBy, skip = 0, take }: any = {}) => {
      const list = sortRows(rows.filter((r) => matches(r, where)), orderBy);
      return list.slice(skip, take ? skip + take : undefined);
    }),
    count: jest.fn(async ({ where }: any = {}) => rows.filter((r) => matches(r, where)).length),
    create: jest.fn(async ({ data }: any) => {
      for (const keys of unique) {
        if (rows.some((r) => keys.every((k) => r[k] === data[k]))) {
          throw Object.assign(new Error(`Unique ${name}`), { code: 'P2002' });
        }
      }
      const now = new Date();
      const row = { id: oid(), createdAt: now, updatedAt: now, ...defaults, ...data };
      rows.push(row);
      return row;
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const row = rows.find((r) => matches(r, where));
      if (!row) throw new Error(`${name} not found`);
      for (const [k, v] of Object.entries(data)) {
        const op = v as any;
        if (op && typeof op === 'object' && 'increment' in op) row[k] = (row[k] ?? 0) + op.increment;
        else if (op && typeof op === 'object' && 'decrement' in op) row[k] = (row[k] ?? 0) - op.decrement;
        else row[k] = v;
      }
      row.updatedAt = new Date();
      return row;
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      const list = rows.filter((r) => matches(r, where));
      list.forEach((r) => Object.assign(r, data));
      return { count: list.length };
    }),
    delete: jest.fn(async ({ where }: any) => {
      const i = rows.findIndex((r) => matches(r, where));
      return rows.splice(i, 1)[0];
    }),
    deleteMany: jest.fn(async ({ where }: any) => {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) if (matches(rows[i], where)) rows.splice(i, 1);
      return { count: before - rows.length };
    }),
  };
}

describe('CommunityBuildsService', () => {
  let db: Record<string, ReturnType<typeof table>> & { $transaction: jest.Mock };
  let service: CommunityBuildsService;
  let events: CommunityBuildsEvents;
  let emitted: CommunityBuildEvent[];

  const author = { id: '', username: 'author', permissions: [] as string[] };
  const player = { id: '', username: 'player', permissions: [] as string[] };
  const moderator = { id: '', username: 'modo', permissions: ['builds.moderate'] };
  let heroId: string;
  let items: string[];
  let disabledItem: string;
  let emblemId: string;
  let spellId: string;
  let talents: Record<string, string>;

  const draftInput = (over: Record<string, unknown> = {}) => ({
    heroId: '84',
    title: 'Ling one shot',
    notes: 'Farm fast.',
    lane: 'jungle',
    itemIds: items.slice(0, 3),
    emblemId,
    battleSpellId: spellId,
    talentIds: [talents.t3, talents.t1],
    ...over,
  });

  beforeEach(async () => {
    db = {
      communityBuild: table('communityBuild', [], {
        status: 'draft',
        likesCount: 0,
        reportsCount: 0,
        publishedAt: null,
        hiddenAt: null,
        hiddenById: null,
        hiddenReason: null,
        notes: null,
        lane: null,
      }),
      communityBuildLike: table('like', [['buildId', 'userId']]),
      communityBuildReport: table('report', [['buildId', 'reporterId']], { status: 'open' }),
      adminLog: table('adminLog'),
      item: table('item'),
      emblem: table('emblem'),
      battleSpell: table('battleSpell'),
      emblemTalent: table('emblemTalent'),
      hero: table('hero'),
      user: table('user'),
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    } as any;
    for (const u of [author, player, moderator]) {
      u.id = (await db.user.create({ data: { username: u.username } })).id;
    }
    heroId = (await db.hero.create({ data: { name: 'Ling', heroId: 84, roles: ['assassin'] } })).id;
    items = [];
    for (let i = 0; i < 7; i++) items.push((await db.item.create({ data: { name: `Item ${i}`, enabled: i % 2 ? null : true } })).id);
    disabledItem = (await db.item.create({ data: { name: 'Old item', enabled: false } })).id;
    emblemId = (await db.emblem.create({ data: { name: 'Assassin Emblem', enabled: true } })).id;
    spellId = (await db.battleSpell.create({ data: { name: 'Retribution' } })).id;
    talents = {
      t1: (await db.emblemTalent.create({ data: { name: 'Rupture', tier: 1 } })).id,
      t1b: (await db.emblemTalent.create({ data: { name: 'Agility', tier: 1 } })).id,
      t3: (await db.emblemTalent.create({ data: { name: 'Killing Spree', tier: 3 } })).id,
    };

    events = new CommunityBuildsEvents();
    emitted = [];
    events.subscribe((e) => {
      emitted.push(e);
    });
    service = new CommunityBuildsService(db as unknown as PrismaService, events);
  });

  const publishedBuild = async () => service.create(author, { ...draftInput(), publish: true });

  describe('validation', () => {
    it('creates a draft resolved from the catalog, talents in tier order', async () => {
      const build = await service.create(author, draftInput());
      expect(build).toMatchObject({ status: 'draft', title: 'Ling one shot', lane: 'jungle', isMine: true });
      expect(build.hero).toMatchObject({ id: heroId, heroId: 84, name: 'Ling' });
      expect(build.items.map((i: any) => i.id)).toEqual(items.slice(0, 3));
      expect(build.talents.map((t: any) => t.name)).toEqual(['Rupture', 'Killing Spree']);
      expect(emitted).toEqual([]);
    });

    it('rejects a disabled or unknown catalog entry', async () => {
      await expect(service.create(author, draftInput({ itemIds: [disabledItem] }))).rejects.toThrow(BadRequestException);
      await expect(service.create(author, draftInput({ emblemId: oid() }))).rejects.toThrow(BadRequestException);
    });

    it('rejects two talents of the same tier and duplicate items', async () => {
      await expect(service.create(author, draftInput({ talentIds: [talents.t1, talents.t1b] }))).rejects.toMatchObject({
        response: { code: 'talents_tier_duplicate' },
      });
      await expect(service.create(author, draftInput({ itemIds: [items[0], items[0]] }))).rejects.toMatchObject({
        response: { code: 'items_duplicate' },
      });
    });

    it('rejects an unknown hero and a too short title', async () => {
      await expect(service.create(author, draftInput({ heroId: '999' }))).rejects.toMatchObject({
        response: { code: 'hero_unknown' },
      });
      await expect(service.create(author, draftInput({ title: 'ab' }))).rejects.toMatchObject({
        response: { code: 'title_length' },
      });
    });

    it('needs at least one item to publish, not to save a draft', async () => {
      const draft = await service.create(author, draftInput({ itemIds: [] }));
      await expect(service.publish(draft.id, author)).rejects.toMatchObject({ response: { code: 'publish_no_items' } });
    });

    it('limits publications per rolling day', async () => {
      for (let i = 0; i < LIMITS.publishesPerDay; i++) await publishedBuild();
      await expect(publishedBuild()).rejects.toMatchObject({ response: { code: 'quota_publish' } });
      // Drafts are still allowed.
      await expect(service.create(author, draftInput())).resolves.toMatchObject({ status: 'draft' });
    });

    it('keeps an entry disabled after the build was written when editing', async () => {
      const build = await service.create(author, draftInput());
      db.item.rows.find((r) => r.id === items[0])!.enabled = false;
      await expect(service.update(build.id, author, { title: 'Renamed build' })).resolves.toMatchObject({
        title: 'Renamed build',
      });
      await expect(service.update(build.id, author, { itemIds: [disabledItem] })).rejects.toThrow(BadRequestException);
    });
  });

  describe('ownership and visibility', () => {
    it('lets the author publish, unpublish and delete, and emits events', async () => {
      const draft = await service.create(author, draftInput());
      expect((await service.publish(draft.id, author)).status).toBe('published');
      expect((await service.unpublish(draft.id, author)).status).toBe('draft');
      await service.remove(draft.id, author);
      expect(db.communityBuild.rows).toHaveLength(0);
      expect(emitted.map((e) => e.type)).toEqual(['published', 'unpublished', 'deleted']);
    });

    it('hides drafts from everyone but the author', async () => {
      const draft = await service.create(author, draftInput());
      await expect(service.findOne(draft.id, player)).rejects.toThrow(NotFoundException);
      await expect(service.findOne(draft.id, moderator)).rejects.toThrow(NotFoundException);
      await expect(service.findOne(draft.id, null)).rejects.toThrow(NotFoundException);
      await expect(service.update(draft.id, player, { title: 'Stolen build' })).rejects.toThrow(NotFoundException);
    });

    it('forbids editing or deleting a published build of someone else', async () => {
      const build = await publishedBuild();
      await expect(service.update(build.id, player, { title: 'Stolen build' })).rejects.toThrow(ForbiddenException);
      await expect(service.remove(build.id, moderator)).rejects.toThrow(ForbiddenException);
    });

    it('lists only published builds publicly, per hero and lane', async () => {
      const pub = await publishedBuild();
      await service.create(author, draftInput());
      const res = await service.listPublic({ hero: '84', lane: 'jungle' }, null);
      expect(res.items.map((b: any) => b.id)).toEqual([pub.id]);
      expect(res.total).toBe(1);
      expect((await service.listPublic({ hero: '84', lane: 'roam' }, null)).total).toBe(0);
      expect((await service.listPublic({ hero: '12345' }, null)).total).toBe(0);
      expect(res.items[0]).not.toHaveProperty('reportsCount');
      expect(res.items[0]).not.toHaveProperty('hiddenReason');
    });

    it('lists every build of the author in "mine"', async () => {
      await publishedBuild();
      await service.create(author, draftInput());
      expect((await service.listMine(author)).map((b: any) => b.status).sort()).toEqual(['draft', 'published']);
      expect(await service.listMine(player)).toEqual([]);
    });
  });

  describe('likes', () => {
    it('is idempotent and counts one like per player', async () => {
      const build = await publishedBuild();
      expect(await service.like(build.id, player)).toEqual({ liked: true, likesCount: 1 });
      expect(await service.like(build.id, player)).toEqual({ liked: true, likesCount: 1 });
      expect(await service.like(build.id, moderator)).toEqual({ liked: true, likesCount: 2 });
      expect((await service.findOne(build.id, player)).likedByMe).toBe(true);
      expect(await service.unlike(build.id, player)).toEqual({ liked: false, likesCount: 1 });
      expect(await service.unlike(build.id, player)).toEqual({ liked: false, likesCount: 1 });
      expect(db.communityBuild.rows.find((r: any) => r.id === build.id).likesCount).toBe(1);
      expect(emitted.filter((e) => e.type === 'liked')).toHaveLength(2);
      expect(emitted.filter((e) => e.type === 'unliked')).toHaveLength(1);
      expect(emitted.find((e) => e.type === 'liked')).toMatchObject({ authorId: author.id, actorId: player.id });
    });

    it('refuses liking your own build or an unpublished one', async () => {
      const build = await publishedBuild();
      await expect(service.like(build.id, author)).rejects.toMatchObject({ response: { code: 'like_own' } });
      const draft = await service.create(author, draftInput());
      await expect(service.like(draft.id, player)).rejects.toThrow(NotFoundException);
      await expect(service.unlike(draft.id, player)).rejects.toThrow(NotFoundException);
    });

    it('sorts by likes then by date', async () => {
      const a = await publishedBuild();
      const b = await publishedBuild();
      await service.like(b.id, player);
      expect((await service.listPublic({ sort: 'likes' }, null)).items.map((x: any) => x.id)).toEqual([b.id, a.id]);
    });
  });

  describe('reports and moderation', () => {
    it('records one open report per player and refuses reporting your own build', async () => {
      const build = await publishedBuild();
      await service.report(build.id, player, { reason: 'spam' });
      await expect(service.report(build.id, player, { reason: 'spam' })).rejects.toMatchObject({
        response: { code: 'already_reported' },
      });
      await expect(service.report(build.id, author, { reason: 'spam' })).rejects.toMatchObject({
        response: { code: 'report_own' },
      });
      expect(db.communityBuild.rows[0].reportsCount).toBe(1);
      const queue = await service.moderationList({}, moderator);
      expect(queue.items.map((b: any) => b.id)).toEqual([build.id]);
      expect(queue.items[0].reports[0]).toMatchObject({ reason: 'spam', reporter: { username: 'player' } });
    });

    it('hides a build: gone from public lists, visible to its author and moderators, logged', async () => {
      const build = await publishedBuild();
      await service.report(build.id, player, { reason: 'offensive' });
      const hidden = await service.hide(build.id, moderator, { reason: 'Insults in notes' });
      expect(hidden).toMatchObject({ status: 'hidden', hiddenReason: 'Insults in notes', reportsCount: 0 });
      expect((await service.listPublic({}, null)).total).toBe(0);
      await expect(service.findOne(build.id, player)).rejects.toThrow(NotFoundException);
      expect((await service.findOne(build.id, author)).hiddenReason).toBe('Insults in notes');
      await expect(service.publish(build.id, author)).rejects.toMatchObject({ response: { code: 'hidden_by_moderator' } });
      expect(db.communityBuildReport.rows[0].status).toBe('resolved');
      expect(db.adminLog.rows.map((l) => l.action)).toEqual(['community_build.hide']);

      await service.unhide(build.id, moderator);
      expect((await service.listPublic({}, null)).total).toBe(1);
      expect(emitted.map((e) => e.type)).toEqual(['published', 'hidden', 'unhidden']);
    });

    it('dismisses reports without hiding and deletes with likes and reports', async () => {
      const build = await publishedBuild();
      await service.like(build.id, player);
      await service.report(build.id, player, { reason: 'misleading' });
      expect(await service.dismissReports(build.id, moderator)).toEqual({ dismissed: 1 });
      expect((await service.moderationList({}, moderator)).total).toBe(0);
      await service.moderatorDelete(build.id, moderator);
      expect(db.communityBuild.rows).toHaveLength(0);
      expect(db.communityBuildLike.rows).toHaveLength(0);
      expect(db.communityBuildReport.rows).toHaveLength(0);
      expect(db.adminLog.rows.map((l) => l.action)).toEqual([
        'community_build.dismiss_reports',
        'community_build.delete',
      ]);
    });

    it('never lets moderators reach private drafts', async () => {
      const draft = await service.create(author, draftInput());
      await expect(service.hide(draft.id, moderator, {})).rejects.toThrow(NotFoundException);
      await expect(service.moderatorDelete(draft.id, moderator)).rejects.toThrow(NotFoundException);
      expect((await service.moderationList({ filter: 'all' }, moderator)).total).toBe(0);
    });
  });

  it('keeps serving the request when an event listener fails', async () => {
    events.subscribe(() => {
      throw new Error('xp service down');
    });
    await expect(publishedBuild()).resolves.toMatchObject({ status: 'published' });
  });
});
