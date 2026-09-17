import { validateAnalysis, validateBuild, validateCoach, validateCounters, validateHeroPicks } from './ai-validate';
import { CatalogHero } from './ai.types';

const hero = (name: string, role: string): CatalogHero => ({
  id: `id-${name.toLowerCase()}`,
  name,
  role,
  roles: [role],
  laneKeys: [],
  image: `${name}.png`,
  thumb: null,
  heroId: null,
  speciality: [],
  stats: null,
});
const catalog = [hero('Tigreal', 'tank'), hero('Layla', 'marksman'), hero('Gusion', 'assassin'), hero('Kagura', 'mage')];

describe('validateHeroPicks', () => {
  it('maps names to catalog ids case-insensitively and drops unknown or duplicate heroes', () => {
    const out = validateHeroPicks(
      [
        { name: 'tigreal', reason: 'r1', confidence: 0.9 },
        { name: 'Zorro The Invented', reason: 'x', confidence: 1 },
        { name: 'TIGREAL', reason: 'dup', confidence: 0.5 },
        { name: 'Layla', reason: 'r2', confidence: 7 },
      ],
      catalog,
    );
    expect(out.map((h) => h.id)).toEqual(['id-tigreal', 'id-layla']);
    expect(out[0].image).toBe('Tigreal.png');
    expect(out[1].confidence).toBe(1); // clamped
  });

  it('handles garbage input', () => {
    expect(validateHeroPicks(null, catalog)).toEqual([]);
    expect(validateHeroPicks([{}, 3, 'x'], catalog)).toEqual([]);
  });
});

describe('validateCounters', () => {
  const enemies = [catalog[1]]; // Layla
  it('excludes the enemies and keeps only known "against" names', () => {
    const out = validateCounters(
      {
        counters: [
          { name: 'Layla', reason: 'self', effectiveness: 1, against: ['Layla'] },
          { name: 'Gusion', reason: 'dive', effectiveness: 0.8, against: ['layla', 'Nobody'] },
          { name: 'Fake', reason: '', effectiveness: 0.5, against: [] },
        ],
      },
      catalog,
      enemies,
      true,
    );
    expect(out).not.toBeNull();
    expect(out!.counters.map((c) => c.name)).toEqual(['Gusion']);
    expect(out!.counters[0].against).toEqual(['Layla']);
    expect(out!.enemies[0].id).toBe('id-layla');
  });

  it('returns null when nothing valid remains', () => {
    expect(validateCounters({ counters: [{ name: 'Layla' }] }, catalog, enemies, false)).toBeNull();
    expect(validateCounters({ nope: 1 }, catalog, enemies, false)).toBeNull();
  });
});

describe('validateBuild', () => {
  it('falls back to class defaults for unknown emblem/spell and requires 3+ items', () => {
    const out = validateBuild(
      {
        note: 'ok',
        boots: { name: 'Swift Boots', reason: 'speed' },
        items: [
          { name: 'Windtalker', reason: 'a', priority: 'core' },
          { name: 'windtalker', reason: 'dup', priority: 'core' },
          { name: "Berserker's Fury", reason: 'b', priority: 'weird' },
          { name: 'Scarlet Phantom', reason: 'c', priority: 'situational' },
        ],
        emblem: { name: 'Emblem Of Doom', talents: ['x'], reason: 'r' },
        spell: { name: 'Teleport', reason: 'r' },
      },
      catalog[1],
      false,
    );
    expect(out).not.toBeNull();
    expect(out!.items.map((i) => i.name)).toEqual(['Windtalker', "Berserker's Fury", 'Scarlet Phantom']);
    expect(out!.items[1].priority).toBe('core');
    expect(out!.emblem.name).toBe('Marksman Emblem');
    expect(out!.spell.name).toBe('Inspire');
    expect(validateBuild({ items: [{ name: 'One' }] }, catalog[1], false)).toBeNull();
  });
});

describe('validateCoach / validateAnalysis', () => {
  it('validates shapes and impact enums', () => {
    const coach = validateCoach(
      { summary: 's', tips: [{ title: 't', detail: 'd', priority: 'urgent' }, { title: '', detail: 'x' }], heroes: [{ name: 'kagura', reason: 'r', confidence: 0.6 }] },
      catalog,
    );
    expect(coach!.tips).toEqual([{ title: 't', detail: 'd', priority: 'medium' }]);
    expect(coach!.heroes[0].id).toBe('id-kagura');
    expect(validateCoach({ tips: [] }, catalog)).toBeNull();

    const stats = { games: 10, winRate: 50, mvpRate: 10, streak: 0, rank: 'epic', role: 'tank' };
    const an = validateAnalysis({ strengths: [{ category: 'c', description: 'd', impact: 'high' }], weaknesses: 'no', recommendations: ['a', 2, ''] }, stats);
    expect(an!.strengths).toHaveLength(1);
    expect(an!.weaknesses).toEqual([]);
    expect(an!.recommendations).toEqual(['a', '2']);
    expect(validateAnalysis({}, stats)).toBeNull();
  });
});
