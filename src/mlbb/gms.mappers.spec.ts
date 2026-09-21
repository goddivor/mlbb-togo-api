import * as fs from 'fs';
import * as path from 'path';
import {
  computeDeltas,
  heroTaxonomy,
  mapBuildRecords,
  mapComboRecords,
  mapEquipmentRecords,
  mapMatrixRecords,
  mapRankingRecords,
  mapRelationRecords,
  mapTalentRecords,
  mapTimelineRecords,
  mapTrendRecords,
  pct,
} from './gms.mappers';

// Real Moonton responses captured in api-research/mlbb-upstream-samples.
function fixture(name: string): any[] {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '__fixtures__', `${name}.json`), 'utf8'));
  return raw.response.data.records;
}

describe('gms.mappers', () => {
  it('pct converts fractions to percentages with 2 decimals', () => {
    expect(pct(0.475368)).toBe(47.54);
    expect(pct(-0.040605)).toBe(-4.06);
    expect(pct('0.5')).toBe(50);
    expect(pct(null)).toBeNull();
    expect(pct(undefined)).toBeNull();
    expect(pct('abc')).toBeNull();
  });

  it('heroTaxonomy reads language independent role and lane ids', () => {
    expect(heroTaxonomy(fixture('hero-detail')[0])).toEqual({ roles: ['marksman'], lanes: ['gold'] });
    expect(heroTaxonomy({})).toEqual({ roles: [], lanes: [] });
  });

  it('maps the ranking (legacy fractions)', () => {
    const rows = mapRankingRecords(fixture('heroes-rank'));
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({ heroId: 14, winRate: 0.581554 });
    expect(typeof rows[0].pickRate).toBe('number');
    expect(typeof rows[0].banRate).toBe('number');
    expect(rows[0].name).toBeTruthy();
    expect(rows[0].synergies.length).toBeGreaterThan(0);
    expect(rows[0].synergies[0].heroId).toEqual(expect.any(Number));
  });

  it('maps counters: best = heroes the main hero beats, worst = its counters', () => {
    const rel = mapRelationRecords(fixture('hero-counters'))!;
    expect(rel.heroId).toBe(18);
    expect(rel.name).toBe('Layla');
    expect(rel.winRate).toBe(47.54);
    expect(rel.best).toHaveLength(5);
    expect(rel.worst).toHaveLength(5);
    expect(rel.best[0]).toMatchObject({ heroId: 48, increaseWinRate: 2.71 });
    expect(rel.best.every((s) => s.increaseWinRate > 0)).toBe(true);
    expect(rel.worst.every((s) => s.increaseWinRate < 0)).toBe(true);
    expect(rel.worst[0].increaseWinRate).toBe(-4.06); // most negative first
    expect(rel.best[0].image).toMatch(/^https:/);
  });

  it('maps compatibility and Academy per-hero stats (nested main_hero)', () => {
    const compat = mapRelationRecords(fixture('hero-compatibility'))!;
    expect(compat.worst[0].increaseWinRate).toBe(-9.2);
    const academy = mapRelationRecords(fixture('academy-hero-stats'))!;
    expect(academy).toMatchObject({ heroId: 18, name: 'Layla', winRate: 47.5 });
    expect(academy.best[0]).toMatchObject({ heroId: 94, increaseWinRate: 2.9 });
    expect(academy.best[0].image).toMatch(/^https:/);
    expect(mapRelationRecords([])).toBeNull();
  });

  it('maps the Academy matrix sorted by increase', () => {
    const m = mapMatrixRecords(fixture('academy-hero-counters'))!;
    expect(m.heroId).toBe(18);
    expect(m.winRate).toBe(47.5);
    expect(m.pickRate).toBe(1.12);
    expect(m.entries).toHaveLength(5); // the fixture is trimmed (132 live)
    expect(m.entries.map((e) => e.increaseWinRate)).toEqual([1.57, 0.72, -0.47, -2.05, -4.31]);
    expect(m.entries[m.entries.length - 1].heroId).toBe(93);
    expect(mapMatrixRecords(fixture('academy-hero-teammates'))!.entries).toHaveLength(5);
  });

  it('maps skill combos', () => {
    const combos = mapComboRecords(fixture('hero-skill-combos'));
    expect(combos.map((c) => c.title)).toEqual(['TEAMFIGHT COMBOS', 'LANING COMBOS']);
    expect(combos[0].skills[0]).toEqual({ id: 8410, icon: expect.stringMatching(/^https:/) });
    expect(combos[0].description).toContain('Ling');
  });

  it('maps trends oldest first and computes deltas', () => {
    const points = mapTrendRecords(fixture('hero-trends'));
    expect(points.map((p) => p.date)).toEqual(['2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19']);
    expect(points[4]).toEqual({ date: '2026-09-19', winRate: 44.01, pickRate: 1.87, banRate: 4.65 });
    const d1 = computeDeltas(points, 1);
    expect(d1).toMatchObject({ from: '2026-09-18', to: '2026-09-19', winRate: -0.05 });
    const d30 = computeDeltas(points, 30); // falls back to the oldest point
    expect(d30).toMatchObject({ from: '2026-09-15', winRate: -0.4 });
    expect(computeDeltas([], 7).winRate).toBeNull();
    expect(mapTrendRecords(fixture('academy-hero-trends'))).toHaveLength(5);
  });

  it('maps the win rate timeline', () => {
    const t = mapTimelineRecords(fixture('academy-hero-winrate-timeline'))!;
    expect(t.totalWinRate).toBe(52.71);
    expect(t.buckets[0]).toEqual({ from: 10, to: 12, winRate: 45.84 });
    expect(t.buckets.map((b) => b.from)).toEqual([10, 12, 14, 16, 18]);
    expect(mapTimelineRecords([{ data: { time_win_rate: [{ time_min: 20, win_rate: 0.5 }] } }])!.buckets[0]).toEqual({
      from: 20,
      to: null,
      winRate: 50,
    });
  });

  it('maps catalogs', () => {
    const items = mapEquipmentRecords(fixture('academy-equipment'));
    expect(items[0]).toEqual({ id: 10002, name: 'Bud of Hope', icon: expect.stringMatching(/^https:/) });
    const talents = mapTalentRecords(fixture('academy-emblems'));
    expect(talents[0]).toMatchObject({ id: 1221, name: 'Weapons Master' });
    expect(talents[0].description).toContain('5%');
  });

  it('maps builds, resolving items and talents, most picked first', () => {
    const items = new Map([[3005, { id: 3005, name: 'Swift Boots', icon: 'i' }]]);
    const talents = new Map([[1211, { id: 1211, name: 'Rupture', icon: 't' }]]);
    const builds = mapBuildRecords(fixture('academy-hero-builds'), items, talents);
    expect(builds).toHaveLength(3);
    expect(builds[0].pickRate).toBe(16.45);
    expect(builds[0].winRate).toBe(53.43);
    expect(builds[0].items[0]).toEqual({ id: 3005, name: 'Swift Boots', icon: 'i' });
    expect(builds[0].items[1]).toEqual({ id: 3003, name: null, icon: null });
    expect(builds[0].talents.map((t) => t.id)).toEqual([1211, 621, 132]);
    expect(builds[0].talents[0].name).toBe('Rupture');
    expect(builds[0].emblem).toMatchObject({ id: 20005, name: 'Assassin' });
    expect(builds[0].emblem!.attributes).toContain('+10 Adaptive Attack');
    expect(builds[0].spell).toMatchObject({ id: 20100, name: 'Flicker' });
    expect(builds.map((b) => b.pickRate)).toEqual([16.45, 5.39, 4.72]);
  });
});
