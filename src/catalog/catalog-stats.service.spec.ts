import { NotFoundException } from '@nestjs/common';
import { GmsError } from '../mlbb/gms.client';
import { MetaCacheService } from '../mlbb/meta-cache.service';
import { CatalogStatsService, LANE_CONCURRENCY } from './catalog-stats.service';

const LANE_BY_ROAD: Record<number, string> = { 1: 'exp', 2: 'mid', 3: 'roam', 4: 'jungle', 5: 'gold' };

function setup(opts: { failLanes?: string[] } = {}) {
  const calls: Array<{ lane: string; rank: string }> = [];
  let inFlight = 0;
  let peak = 0;
  const gms = {
    callSource: jest.fn(async (_app: string, _src: string, body: any) => {
      const road = body.filters.find((f: any) => f.field === 'real_road').value;
      const rank = body.filters.find((f: any) => f.field === 'big_rank').value;
      const lane = LANE_BY_ROAD[road];
      calls.push({ lane, rank });
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      if (opts.failLanes?.includes(lane)) throw new GmsError('down');
      // Hero 1 plays gold, hero 2 plays mid: every lane returns both heroes.
      return {
        total: 2,
        records: [
          { data: { heroid: 1, build: [{ equipid: [100, 200, 300], runeid: 20012, skillid: 20030, new_rune_skill: [112], build_win_rate: 0.6, build_pick_rate: 0.3 }] } },
          { data: { heroid: 2, build: [{ equipid: [100, 200, 999], runeid: 20006, skillid: 20100, new_rune_skill: [611], build_win_rate: 0.5, build_pick_rate: 0.1 }] } },
        ],
      };
    }),
  };
  const mlbb = {
    heroIndex: jest.fn(async () =>
      new Map([
        [1, { name: 'Miya', image: 'miya.png', roles: ['marksman'], lanes: ['gold'] }],
        [2, { name: 'Eudora', image: 'eudora.png', roles: ['mage'], lanes: ['mid'] }],
      ]),
    ),
  };
  const heroMeta = { getTalentCatalog: jest.fn(async () => [{ id: 112, name: 'Swift', icon: null }]) };
  const item = (name: string, gameId: number, extra: any = {}) => ({ id: `id-${gameId}`, name, gameId, enabled: true, icon: null, ...extra });
  const prisma = {
    item: {
      findMany: jest.fn(async () => [
        item('Blade', 100, { gameMeta: JSON.stringify({ categoryId: 1, category: 'Attack', tier: 3, buildsFrom: [300, 555], buildsInto: [] }) }),
        item('Boots', 200),
        item('Dagger', 300, { gameMeta: JSON.stringify({ categoryId: 1, category: 'Attack', tier: 1, isComponent: true, buildsInto: [100] }) }),
        item('Hidden', 999, { enabled: false }),
      ]),
    },
    battleSpell: { findMany: jest.fn(async () => [{ id: 's1', name: 'Inspire', gameId: 20030, enabled: true, cooldown: '75s' }]) },
    emblem: { findMany: jest.fn(async () => [{ id: 'e1', name: 'Marksman Emblem', gameId: 20012, description: '+15% Attack Speed\n+16 Adaptive Attack' }]) },
  };
  const service = new CatalogStatsService(prisma as any, gms as any, new MetaCacheService(), mlbb as any, heroMeta as any);
  return { service, calls, peak: () => peak };
}

describe('CatalogStatsService', () => {
  it('costs one Moonton call per lane, bounded concurrency, then serves the cache', async () => {
    const { service, calls, peak } = setup();
    await service.synergies({ rank: 'mythic' });
    expect(calls).toHaveLength(5);
    expect(new Set(calls.map((c) => c.rank))).toEqual(new Set(['7']));
    expect(peak()).toBeLessThanOrEqual(LANE_CONCURRENCY);

    await Promise.all([service.spells({ rank: 'mythic' }), service.emblems({ rank: 'mythic' }), service.itemHeroes(100, { rank: 'mythic' })]);
    expect(calls).toHaveLength(5);
  });

  it('fetches a single lane when filtered', async () => {
    const { service, calls } = setup();
    await service.synergies({ lane: 'gold' });
    expect(calls.map((c) => c.lane)).toEqual(['gold']);
  });

  it('pairs only enabled items from the relevant hero lanes', async () => {
    const { service } = setup();
    const res = await service.synergies({});
    // Hero 1 counted in gold only, hero 2 in mid only; item 999 is hidden.
    expect(res.buildsAnalysed).toBe(2);
    expect(res.heroesCovered).toBe(2);
    expect(res.pairs[0]).toMatchObject({ builds: 2, heroes: 2, winRate: 57.5 });
    expect(res.pairs[0].items.map((i) => i.gameId)).toEqual([100, 200]);
    expect(res.pairs.every((p) => p.items.every((i) => i.gameId !== 999))).toBe(true);
  });

  it('lists items with parsed recipes and only links to known items', async () => {
    const { service } = setup();
    const res = await service.listItems();
    expect(res.items.map((i) => i.name)).toEqual(['Blade', 'Boots', 'Dagger']);
    expect(res.items[0]).toMatchObject({ category: 'Attack', tier: 3, buildsFrom: [300] });
    expect(res.items[2]).toMatchObject({ isComponent: true, buildsInto: [100] });
    expect(res.categories).toEqual([{ id: 1, name: 'Attack', count: 2 }]);
  });

  it('ranks the heroes of an item and rejects an unknown item', async () => {
    const { service } = setup();
    const res = await service.itemHeroes(100, {});
    expect(res.heroes.map((h) => [h.name, h.lane, h.usage])).toEqual([
      ['Miya', 'gold', 30],
      ['Eudora', 'mid', 10],
    ]);
    await expect(service.itemHeroes(999, {})).rejects.toBeInstanceOf(NotFoundException);
  });

  it('attaches heroes and talents to spells and emblems', async () => {
    const { service } = setup();
    const spells = await service.spells({});
    expect(spells.spells[0].heroes.map((h) => h.name)).toEqual(['Miya']);
    expect(spells.spells[0].usage).toMatchObject({ builds: 1, winRate: 60 });
    const emblems = await service.emblems({});
    expect(emblems.emblems[0].attributes).toEqual(['+15% Attack Speed', '+16 Adaptive Attack']);
    expect(emblems.emblems[0].talents).toMatchObject([{ id: 112, name: 'Swift', builds: 1 }]);
  });

  it('still serves the lists when Moonton is down', async () => {
    const { service } = setup({ failLanes: ['exp', 'mid', 'roam', 'jungle', 'gold'] });
    const res = await service.spells({});
    expect(res.available).toBe(false);
    expect(res.spells).toHaveLength(1);
    expect(res.spells[0].heroes).toEqual([]);
  });

  it('backs off after a failed cold load instead of calling Moonton on every view', async () => {
    const { service, calls } = setup({ failLanes: ['gold'] });
    await service.spells({ lane: 'gold' });
    await service.spells({ lane: 'gold' });
    expect(calls).toHaveLength(1);
  });
});
