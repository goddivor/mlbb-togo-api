import {
  CompactBuild,
  HeroLaneBuilds,
  compactLaneBuilds,
  countItemPairs,
  mapLimit,
  rankHeroUsage,
  selectRelevant,
  usageBy,
  weightedWinRate,
} from './catalog-stats.aggregate';

const build = (items: number[], winRate: number | null, pickRate: number | null, extra: Partial<CompactBuild> = {}): CompactBuild => ({
  items,
  emblemId: null,
  talents: [],
  spellId: null,
  winRate,
  pickRate,
  ...extra,
});

describe('compactLaneBuilds', () => {
  it('maps Academy records to ids and percentage rates', () => {
    const rows = compactLaneBuilds(
      [
        {
          data: {
            heroid: 1,
            hero_name: '弥亚',
            build: [
              {
                equipid: [2008, '2006', 2009],
                new_rune_skill: [112, 621, 1231],
                runeid: 20012,
                skillid: 20030,
                build_win_rate: 0.592,
                build_pick_rate: 0.0687,
              },
            ],
          },
        },
        { data: { heroid: null, build: [{ equipid: [1] }] } },
        { data: { heroid: 2, build: [] } },
      ],
      'gold',
    );
    expect(rows).toEqual([
      {
        heroId: 1,
        lane: 'gold',
        builds: [
          { items: [2008, 2006, 2009], emblemId: 20012, talents: [112, 621, 1231], spellId: 20030, winRate: 59.2, pickRate: 6.87 },
        ],
      },
    ]);
  });

  it('falls back to the nested emblem and spell ids', () => {
    const [row] = compactLaneBuilds(
      [{ data: { heroid: 3, build: [{ emblem: { data: { emblemid: 20005 } }, battleskill: { data: { battleskillid: 20020 } } }] } }],
      'jungle',
    );
    expect(row.builds[0]).toMatchObject({ emblemId: 20005, spellId: 20020, items: [], winRate: null, pickRate: null });
  });
});

describe('selectRelevant', () => {
  const rows: HeroLaneBuilds[] = [
    { heroId: 1, lane: 'gold', builds: [build([1], 50, 1)] },
    { heroId: 1, lane: 'roam', builds: [build([2], 50, 1)] },
    { heroId: 2, lane: 'roam', builds: [build([3], 50, 1)] },
  ];

  it('keeps only the lanes a hero is played in, and every lane of an unknown hero', () => {
    const lanes = new Map([[1, ['gold']]]);
    expect(selectRelevant(rows, lanes).map((r) => `${r.heroId}:${r.lane}`)).toEqual(['1:gold', '2:roam']);
  });

  it('narrows to one lane', () => {
    expect(selectRelevant(rows, new Map(), 'roam').map((r) => r.heroId)).toEqual([1, 2]);
  });
});

describe('weightedWinRate', () => {
  it('weights win rates by pick rate', () => {
    // (60*3 + 40*1) / 4 = 55
    expect(weightedWinRate([{ winRate: 60, weight: 3 }, { winRate: 40, weight: 1 }])).toBe(55);
  });

  it('ignores missing win rates and falls back to a plain mean without weights', () => {
    expect(weightedWinRate([{ winRate: 60, weight: 0 }, { winRate: 50, weight: null }, { winRate: null, weight: 5 }])).toBe(55);
    expect(weightedWinRate([{ winRate: null, weight: 1 }])).toBeNull();
    expect(weightedWinRate([])).toBeNull();
  });
});

describe('countItemPairs', () => {
  const rows: HeroLaneBuilds[] = [
    { heroId: 1, lane: 'gold', builds: [build([10, 20, 30], 60, 3), build([20, 10, 40], 40, 1)] },
    { heroId: 2, lane: 'exp', builds: [build([10, 20, 20], 50, 2)] },
  ];

  it('counts every unordered pair once per build, with heroes and weighted win rate', () => {
    const pairs = countItemPairs(rows);
    const top = pairs[0];
    expect(top).toMatchObject({ a: 10, b: 20, builds: 3, heroes: 2, weight: 6, share: 100 });
    // (60*3 + 40*1 + 50*2) / 6
    expect(top.winRate).toBeCloseTo(53.33, 2);
    // 10-20, 10-30, 20-30, 10-40, 20-40: duplicated 20 in the last build adds no self pair.
    expect(pairs).toHaveLength(5);
    expect(pairs.find((p) => p.a === 20 && p.b === 20)).toBeUndefined();
  });

  it('ranks by builds, then popularity, then win rate, deterministically', () => {
    const order = countItemPairs(rows).map((p) => `${p.a}-${p.b}`);
    // 10-30 and 20-30 (weight 3) come before 10-40 and 20-40 (weight 1).
    expect(order).toEqual(['10-20', '10-30', '20-30', '10-40', '20-40']);
  });

  it('drops ineligible items before pairing', () => {
    const pairs = countItemPairs(rows, (id) => id !== 20);
    expect(pairs.map((p) => `${p.a}-${p.b}`)).toEqual(['10-30', '10-40']);
  });
});

describe('usageBy', () => {
  it('aggregates by key and ignores null keys', () => {
    const rows: HeroLaneBuilds[] = [
      {
        heroId: 1,
        lane: 'gold',
        builds: [build([], 60, 2, { spellId: 7 }), build([], 50, 2, { spellId: null })],
      },
      { heroId: 2, lane: 'mid', builds: [build([], 40, 2, { spellId: 7 })] },
    ];
    const usage = usageBy(rows, (b) => [b.spellId]);
    expect([...usage.keys()]).toEqual([7]);
    expect(usage.get(7)).toEqual({ builds: 2, heroes: 2, share: 66.67, weight: 4, winRate: 50 });
  });
});

describe('rankHeroUsage', () => {
  const rows: HeroLaneBuilds[] = [
    { heroId: 1, lane: 'gold', builds: [build([5], 50, 10), build([5, 6], 60, 5), build([6], 50, 30)] },
    { heroId: 1, lane: 'exp', builds: [build([5], 70, 4)] },
    { heroId: 2, lane: 'mid', builds: [build([5], 45, 20)] },
    { heroId: 3, lane: 'mid', builds: [build([6], 45, 50)] },
  ];

  it('keeps the best lane per hero and ranks by usage', () => {
    const list = rankHeroUsage(rows, (b) => b.items.includes(5));
    expect(list).toEqual([
      { heroId: 2, lane: 'mid', usage: 20, builds: 1, winRate: 45 },
      // gold: 10 + 5 = 15 beats exp: 4; win rate (50*10 + 60*5) / 15
      { heroId: 1, lane: 'gold', usage: 15, builds: 2, winRate: 53.33 },
    ]);
  });

  it('applies the limit', () => {
    expect(rankHeroUsage(rows, (b) => b.items.includes(5), 1).map((h) => h.heroId)).toEqual([2]);
  });
});

describe('mapLimit', () => {
  it('keeps the order and never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5 * (6 - n)));
      inFlight--;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50]);
    expect(peak).toBe(2);
  });
});
