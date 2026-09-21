import {
  analysisHeuristic,
  buildHeuristic,
  coachHeuristic,
  counterPicksHeuristic,
  recommendHeroesHeuristic,
} from './ai-heuristics';
import { ALL_KNOWN_EMBLEMS, ALL_KNOWN_ITEM_NAMES, ALL_KNOWN_SPELLS } from './ai.constants';
import { CatalogHero, HeroMeta, PlayerContext } from './ai.types';

const hero = (name: string, role: string, lanes: string[] = [], over: Partial<CatalogHero> = {}): CatalogHero => ({
  id: `id-${name.toLowerCase()}`,
  name,
  role,
  roles: [role],
  laneKeys: lanes,
  image: `${name}.png`,
  thumb: null,
  heroId: null,
  speciality: [],
  stats: null,
  ...over,
});

const catalog: CatalogHero[] = [
  hero('Tigreal', 'tank', ['roam', 'exp']),
  hero('Atlas', 'tank', ['roam']),
  hero('Khufra', 'tank', ['roam']),
  hero('Layla', 'marksman', ['gold']),
  hero('Granger', 'marksman', ['gold']),
  hero('Kagura', 'mage', ['mid']),
  hero('Lunox', 'mage', ['mid']),
  hero('Gusion', 'assassin', ['jungle']),
  hero('Ling', 'assassin', ['jungle']),
  hero('Chou', 'fighter', ['exp', 'jungle']),
  hero('Angela', 'support', ['roam']),
];

const player = (over: Partial<PlayerContext> = {}): PlayerContext => ({
  id: 'u1',
  username: 'tankmain',
  rank: 'epic',
  role: 'tank',
  wins: 44,
  losses: 16,
  mvpCount: 5,
  streak: 3,
  favoriteHeroes: [],
  gameFrequentHeroes: [],
  gameRoles: [],
  gameStats: {},
  ...over,
});

const meta = (weak: string[], strong: string[] = []): HeroMeta => ({
  available: true,
  winRate: 51.2,
  pickRate: 3,
  banRate: 1,
  synergy: { best: [], worst: [] },
  counters: {
    strong: strong.map((name) => ({ heroId: 1, name, image: null, winRate: 55, increaseWinRate: 3 })),
    weak: weak.map((name, i) => ({ heroId: 1, name, image: null, winRate: 45, increaseWinRate: -(4 - i) })),
  },
});

describe('recommendHeroesHeuristic', () => {
  it('is deterministic and returns at most 5 cards with images', () => {
    const a = recommendHeroesHeuristic({ player: player(), catalog, lang: 'fr' });
    const b = recommendHeroesHeuristic({ player: player(), catalog, lang: 'fr' });
    expect(a).toEqual(b);
    expect(a.heroes).toHaveLength(5);
    for (const h of a.heroes) {
      expect(h.image).toBeTruthy();
      expect(h.confidence).toBeGreaterThan(0);
      expect(h.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('filters by role case-insensitively and by lane via laneKeys', () => {
    const r = recommendHeroesHeuristic({ player: player(), catalog, role: 'Marksman', lang: 'en' });
    expect(r.heroes.map((h) => h.name).sort()).toEqual(['Granger', 'Layla']);
    const l = recommendHeroesHeuristic({ player: player(), catalog, lane: 'jungle', lang: 'en' });
    expect(l.heroes.map((h) => h.name).sort()).toEqual(['Chou', 'Gusion', 'Ling']);
    expect(l.filters).toEqual({ role: null, lane: 'jungle' });
  });

  it('prioritises favourites, most played heroes and the main role', () => {
    const r = recommendHeroesHeuristic({
      player: player({ favoriteHeroes: ['kagura'], gameFrequentHeroes: [{ name: 'Ling', matches: 40, winRate: 62 }] }),
      catalog,
      lang: 'en',
    });
    const names = r.heroes.map((h) => h.name);
    expect(names.slice(0, 2).sort()).toEqual(['Kagura', 'Ling']);
    expect(r.heroes.find((h) => h.name === 'Ling')!.reason).toContain('40 games');
    // Tanks (main role) come right after.
    expect(['Atlas', 'Khufra', 'Tigreal']).toContain(names[2]);
  });

  it('uses meta win rates when provided', () => {
    const wr = new Map([['granger', 58], ['layla', 44]]);
    const r = recommendHeroesHeuristic({ player: player({ role: 'marksman' }), catalog, role: 'marksman', metaWinRateByName: wr, lang: 'en' });
    expect(r.heroes[0].name).toBe('Granger');
    expect(r.heroes[0].reason).toContain('58%');
  });
});

describe('counterPicksHeuristic', () => {
  const enemies = [catalog.find((h) => h.name === 'Layla')!];

  it('uses meta "weak against" entries, never returns the enemies and maps names to catalog ids', () => {
    const metas = new Map([[enemies[0].id, meta(['Gusion', 'Ling', 'Unknown Hero', 'Layla'])]]);
    const r = counterPicksHeuristic({ enemies, metaByEnemyId: metas, catalog, lang: 'fr' });
    expect(r.metaAvailable).toBe(true);
    const names = r.counters.map((c) => c.name);
    expect(names.slice(0, 2)).toEqual(['Gusion', 'Ling']);
    expect(names).not.toContain('Layla');
    expect(names).not.toContain('Unknown Hero');
    expect(r.counters[0].id).toBe('id-gusion');
    expect(r.counters[0].against).toEqual(['Layla']);
    expect(r.counters[0].effectiveness).toBeGreaterThan(r.counters[2].effectiveness);
  });

  it('falls back to class matchups ranked by meta win rate when counters data is unavailable', () => {
    const wr = new Map([['chou', 56], ['gusion', 48]]);
    const r = counterPicksHeuristic({ enemies, metaByEnemyId: new Map([[enemies[0].id, null]]), catalog, metaWinRateByName: wr, lang: 'en' });
    expect(r.metaAvailable).toBe(false);
    // Marksman is countered by assassins/fighters in the class table.
    expect(r.counters.map((c) => c.name)).toEqual(['Chou', 'Ling', 'Gusion']);
    for (const c of r.counters) expect(['assassin', 'fighter']).toContain(c.role);
    expect(r.counters[0].reason).toContain('Layla');
    expect(r.counters[0].reason).toContain('56%');
    // A ranking entry without counters data still counts as "no meta".
    const onlyRanking = { ...meta([]), available: true };
    expect(counterPicksHeuristic({ enemies, metaByEnemyId: new Map([[enemies[0].id, onlyRanking]]), catalog, lang: 'en' }).metaAvailable).toBe(false);
  });
});

describe('buildHeuristic', () => {
  it('only uses curated real items, lane-driven spell, and flags missing meta', () => {
    const ling = catalog.find((h) => h.name === 'Ling')!;
    const b = buildHeuristic({ hero: ling, meta: null, catalog, lang: 'en' });
    expect(b.metaAvailable).toBe(false);
    expect(b.note).toMatch(/unavailable/);
    expect(b.spell.name).toBe('Retribution');
    expect(ALL_KNOWN_EMBLEMS.has(b.emblem.name)).toBe(true);
    expect(ALL_KNOWN_SPELLS.has(b.spell.name)).toBe(true);
    expect(ALL_KNOWN_ITEM_NAMES.has(b.boots.name)).toBe(true);
    for (const i of b.items) expect(ALL_KNOWN_ITEM_NAMES.has(i.name)).toBe(true);
    expect(b.items.filter((i) => i.priority === 'core')).toHaveLength(4);
    expect(new Set(b.items.map((i) => i.name)).size).toBe(b.items.length);
  });

  it('adds an anti-magic item when the hero is countered mostly by mages', () => {
    const layla = catalog.find((h) => h.name === 'Layla')!;
    const b = buildHeuristic({ hero: layla, meta: meta(['Kagura', 'Lunox', 'Gusion']), catalog, lang: 'fr' });
    expect(b.metaAvailable).toBe(true);
    expect(b.items.find((i) => i.priority === 'situational')!.name).toBe("Athena's Shield");
    expect(b.spell.name).toBe('Inspire');
  });

  it('reports a partial meta when the win rate is known but counters are not', () => {
    const layla = catalog.find((h) => h.name === 'Layla')!;
    const b = buildHeuristic({ hero: layla, meta: { ...meta([]), available: true }, catalog, lang: 'en' });
    expect(b.metaAvailable).toBe(true);
    expect(b.note).toMatch(/counters unavailable/);
    expect(b.items.every((i) => i.priority === 'core' || ALL_KNOWN_ITEM_NAMES.has(i.name))).toBe(true);
  });
});

describe('coachHeuristic / analysisHeuristic', () => {
  it('builds localised tips from the player numbers', () => {
    const fr = coachHeuristic({ player: player({ streak: -4, wins: 10, losses: 20 }), catalog, lang: 'fr' });
    expect(fr.summary).toContain('33.3%');
    expect(fr.tips[0].title).toBe('Coupe la série de défaites');
    expect(fr.tips[0].priority).toBe('high');
    expect(fr.heroes.length).toBeGreaterThan(0);
    const en = coachHeuristic({ player: player(), catalog, lang: 'en' });
    expect(en.summary).toContain('73.3%');
    expect(en.tips.some((t) => t.title === 'Ride the streak')).toBe(true);
    expect(en.source).toBe('heuristic');
  });

  it('returns strengths, weaknesses and stats deterministically', () => {
    const a = analysisHeuristic(player({ favoriteHeroes: ['Tigreal'] }), 'en');
    expect(a.stats).toEqual({ games: 60, winRate: 73.3, mvpRate: 8.3, streak: 3, rank: 'epic', role: 'tank' });
    expect(a.strengths.map((s) => s.category)).toEqual(['Win rate', 'Consistency', 'Defined hero pool']);
    expect(a.weaknesses).toEqual([]);
    expect(a.recommendations).toContain('Keep your current routine: it works.');
    const b = analysisHeuristic(player({ wins: 1, losses: 2, streak: -3 }), 'fr');
    expect(b.weaknesses.map((w) => w.category)).toEqual(['Peu de données', 'Tilt', 'Pool de héros vide']);
  });
});
