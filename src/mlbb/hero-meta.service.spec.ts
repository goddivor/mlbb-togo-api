import * as fs from 'fs';
import * as path from 'path';
import { HeroMetaService } from './hero-meta.service';
import { MetaCacheService } from './meta-cache.service';
import { GmsError } from './gms.client';

function fixture(name: string): any[] {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '__fixtures__', `${name}.json`), 'utf8'));
  return raw.response.data.records;
}

const INDEX = new Map<number, any>([
  [14, { name: 'Rafaela', image: 'raf.png', roles: ['support'], lanes: ['roam'] }],
  [132, { name: 'Marcel', image: 'mar.png', roles: ['tank'], lanes: ['roam'] }],
  [19, { name: 'Zilong', image: 'zil.png', roles: ['fighter'], lanes: ['exp'] }],
  [27, { name: 'Sun', image: 'sun.png', roles: ['fighter'], lanes: ['exp', 'jungle'] }],
  [20, { name: 'Lolita', image: 'lol.png', roles: ['tank'], lanes: ['roam'] }],
  [18, { name: 'Layla', image: 'lay.png', roles: ['marksman'], lanes: ['gold'] }],
  [48, { name: 'Diggie', image: 'dig.png', roles: ['support'], lanes: ['roam'] }],
  [93, { name: 'Atlas', image: 'atl.png', roles: ['tank'], lanes: ['roam'] }],
]);

function make(route: (app: string, source: string, body: any) => any[] | Error) {
  const gms = {
    callSource: jest.fn(async (app: string, source: string, body: any) => {
      const out = route(app, source, body);
      if (out instanceof Error) throw out;
      return { records: out, total: out.length };
    }),
  };
  const mlbb = { heroIndex: jest.fn(async () => INDEX) };
  const service = new HeroMetaService(gms as any, new MetaCacheService(), mlbb as any);
  return { service, gms };
}

const filter = (body: any, field: string) => body?.filters?.find((f: any) => f.field === field)?.value;

describe('HeroMetaService', () => {
  it('ranks heroes for a tier/window, filters by role or lane and sorts', async () => {
    const { service, gms } = make((app, source, body) => {
      expect(app).toBe('2669606');
      expect(source).toBe('2756570'); // 30 days
      expect(filter(body, 'bigrank')).toBe('7'); // mythic
      return fixture('heroes-rank');
    });
    const all = await service.getRanking({ rank: 'mythic', days: 30 });
    expect(all).toMatchObject({ rank: 'mythic', days: 30, sort: 'winRate', order: 'desc', total: 5 });
    expect(all.heroes[0]).toMatchObject({ position: 1, heroId: 14, name: expect.any(String), roles: ['support'], winRate: 58.16 });

    const roam = await service.getRanking({ rank: 'mythic', days: 30, lane: 'roam', sort: 'winRate', order: 'asc' });
    expect(roam.heroes.map((h) => h.heroId)).toEqual([20, 132, 14]);
    expect(roam.heroes[0].position).toBe(1);

    const fighters = await service.getRanking({ rank: 'mythic', days: 30, role: 'fighter' });
    expect(fighters.heroes.map((h) => h.heroId)).toEqual([19, 27]);
    expect(gms.callSource).toHaveBeenCalledTimes(1); // one cached dataset for every filter
  });

  it('normalizes unknown rank/days to all/1 day', async () => {
    const { service, gms } = make(() => fixture('heroes-rank'));
    const out = await service.getRanking({ rank: 'bogus', days: 12 });
    expect(out).toMatchObject({ rank: 'all', days: 1 });
    expect(gms.callSource.mock.calls[0][1]).toBe('2756567');
  });

  it('exposes the full matrix enriched with names and images', async () => {
    const { service } = make((app, source, body) => {
      expect(app).toBe('2713644');
      expect(source).toBe('2777391');
      return filter(body, 'camp_type') === 0 ? fixture('academy-hero-counters') : fixture('academy-hero-teammates');
    });
    const m = await service.getMatchups(18, { rank: 'all' });
    expect(m.counters).toHaveLength(5);
    expect(m.counters[4]).toMatchObject({ heroId: 93, name: 'Atlas', image: 'atl.png', increaseWinRate: -4.31 });
    expect(m.teammates).toHaveLength(5);
  });

  it('builds the legacy overview (counters, synergy, combos) and the optional matrix', async () => {
    const { service } = make((app, source, body) => {
      if (source === '2674711') return fixture('hero-skill-combos');
      if (source === '2777391') return fixture('academy-hero-counters');
      return filter(body, 'match_type') === '0' ? fixture('hero-counters') : fixture('hero-compatibility');
    });
    const meta = await service.getHeroMeta(18, 'en', { matrix: true });
    expect(meta).toMatchObject({ available: true, winRate: 47.54 });
    expect(meta.counters.strong[0]).toMatchObject({ heroId: 48, name: 'Diggie', increaseWinRate: 2.71 });
    expect(meta.counters.weak[0].increaseWinRate).toBe(-4.06);
    expect(meta.synergy.best.length).toBe(5);
    expect(meta.synergy.worst[0].increaseWinRate).toBe(-9.2);
    expect(meta.combos).toHaveLength(2);
    expect(meta.matrix!.counters).toHaveLength(5);
  });

  it('degrades to empty lists when Moonton is down', async () => {
    const { service } = make(() => new GmsError('down'));
    const meta = await service.getHeroMeta(18);
    expect(meta).toMatchObject({ available: false, winRate: 0, counters: { strong: [], weak: [] }, combos: [] });
    await expect(service.getRanking()).rejects.toBeInstanceOf(GmsError);
  });

  it('returns per-hero stats with ranking positions and trend deltas', async () => {
    const { service } = make((app, source, body) => {
      if (source === '2690860') return fixture('hero-trends'); // 30-day series
      if (filter(body, 'main_heroid') === 18) return fixture('hero-stats');
      return [...fixture('heroes-rank'), { data: { main_heroid: 18, main_hero_win_rate: 0.5, main_hero_appearance_rate: 0.9, main_hero_ban_rate: 0.01 } }];
    });
    const stats = await service.getHeroStats(18, { rank: 'mythic', days: 7 });
    expect(stats).toMatchObject({ heroId: 18, name: 'Layla', rank: 'mythic', days: 7, source: 'gms', available: true });
    expect(stats.winRate).toBeGreaterThan(0);
    expect(stats.positions.pickRate).toBe(1);
    expect(stats.total).toBe(6);
    expect(stats.deltas.to).toBe('2026-09-19');
    expect(stats.teammates.length).toBe(5);
  });

  it('falls back to Academy trends when the hero data source fails', async () => {
    const { service } = make((app, source) => (app === '2669606' ? new GmsError('gone') : source === '2755186' ? fixture('academy-hero-trends') : []));
    const out = await service.getTrends(6, { rank: 'mythic', days: 15 });
    expect(out.points).toHaveLength(5);
    expect(out.days).toBe(15);
  });

  it('defaults builds and timeline to the hero main lane', async () => {
    const { service, gms } = make((app, source, body) => {
      if (source === '2776688') {
        expect(filter(body, 'real_road')).toBe(5);
        return fixture('academy-hero-builds');
      }
      if (source === '2777027') {
        expect(filter(body, 'real_road')).toBe(4);
        return fixture('academy-hero-winrate-timeline');
      }
      if (source === '2775075') return fixture('academy-equipment');
      if (source === '2718121') return fixture('academy-emblems');
      return [];
    });
    const builds = await service.getBuilds(18, {});
    expect(builds).toMatchObject({ lane: 'gold', lanes: ['gold'] });
    expect(builds.builds[0]).toMatchObject({ pickRate: 16.45, winRate: 53.43 });

    const timeline = await service.getTimeline(18, { lane: 'jungle' });
    expect(timeline).toMatchObject({ lane: 'jungle', totalWinRate: 52.71 });
    expect(timeline.buckets).toHaveLength(5);
    expect(gms.callSource).toHaveBeenCalled();
  });
});
