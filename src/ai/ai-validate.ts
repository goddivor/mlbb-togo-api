// Validation of LLM structured outputs against the hero catalog and known
// equipment. Unknown hero names are dropped, never invented.

import { ALL_KNOWN_EMBLEMS, ALL_KNOWN_SPELLS, CLASS_BUILDS } from './ai.constants';
import { heroClass, indexByName, toCard } from './ai-heuristics';
import {
  AnalysisPoint,
  AnalysisResponse,
  BuildItem,
  BuildResponse,
  CatalogHero,
  CoachResponse,
  CoachTip,
  CounterCard,
  CounterResponse,
  HeroCard,
  HeroRecommendationsResponse,
} from './ai.types';

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
const str = (s: unknown, max = 400): string => String(s ?? '').trim().slice(0, max);
const clamp01 = (n: unknown, dflt = 0.7): number => {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : dflt;
  return Math.round(Math.min(1, Math.max(0, v)) * 100) / 100;
};
const impactOf = (v: unknown): 'high' | 'medium' | 'low' =>
  v === 'high' || v === 'medium' || v === 'low' ? v : 'medium';

export interface RawHeroPick {
  name?: unknown;
  reason?: unknown;
  confidence?: unknown;
  effectiveness?: unknown;
  against?: unknown;
}

/** Maps LLM hero picks (by NAME) back to catalog rows; drops unknowns/duplicates/excluded ids. */
export function validateHeroPicks(
  picks: unknown,
  catalog: CatalogHero[],
  opts: { limit?: number; exclude?: Set<string> } = {},
): HeroCard[] {
  if (!Array.isArray(picks)) return [];
  const index = indexByName(catalog);
  const seen = new Set<string>();
  const out: HeroCard[] = [];
  for (const raw of picks as RawHeroPick[]) {
    const hero = index.get(norm(raw?.name));
    if (!hero || seen.has(hero.id) || opts.exclude?.has(hero.id)) continue;
    seen.add(hero.id);
    out.push(toCard(hero, str(raw.reason), clamp01(raw.confidence)));
    if (out.length >= (opts.limit ?? 5)) break;
  }
  return out;
}

export function validateRecommendations(
  raw: any,
  catalog: CatalogHero[],
  filters: { role: string | null; lane: string | null },
): HeroRecommendationsResponse | null {
  const heroes = validateHeroPicks(raw?.heroes, catalog, { limit: 5 });
  if (!heroes.length) return null;
  return { source: 'llm', filters, heroes };
}

export function validateCounters(
  raw: any,
  catalog: CatalogHero[],
  enemies: CatalogHero[],
  metaAvailable: boolean,
): CounterResponse | null {
  if (!Array.isArray(raw?.counters)) return null;
  const enemyIds = new Set(enemies.map((e) => e.id));
  const enemyNames = new Set(enemies.map((e) => norm(e.name)));
  const index = indexByName(catalog);
  const seen = new Set<string>();
  const counters: CounterCard[] = [];
  for (const r of raw.counters as RawHeroPick[]) {
    const hero = index.get(norm(r?.name));
    if (!hero || seen.has(hero.id) || enemyIds.has(hero.id)) continue;
    seen.add(hero.id);
    const eff = clamp01(r.effectiveness ?? r.confidence);
    const against = Array.isArray(r.against)
      ? (r.against as unknown[]).map(norm).filter((n) => enemyNames.has(n))
      : [];
    const againstNames = enemies.filter((e) => against.includes(norm(e.name))).map((e) => e.name);
    counters.push({
      ...toCard(hero, str(r.reason), eff),
      effectiveness: eff,
      against: againstNames.length ? againstNames : enemies.map((e) => e.name),
    });
    if (counters.length >= 5) break;
  }
  if (!counters.length) return null;
  return {
    source: 'llm',
    metaAvailable,
    enemies: enemies.map((e) => ({ id: e.id, name: e.name, role: e.role, image: e.image, thumb: e.thumb })),
    counters,
  };
}

export function validateBuild(
  raw: any,
  hero: CatalogHero,
  metaAvailable: boolean,
): BuildResponse | null {
  if (!raw || !Array.isArray(raw.items)) return null;
  const base = CLASS_BUILDS[heroClass(hero)];
  const items: BuildItem[] = [];
  for (const it of raw.items) {
    const name = str(it?.name, 60);
    if (!name || items.some((i) => i.name.toLowerCase() === name.toLowerCase())) continue;
    items.push({
      name,
      reason: str(it?.reason),
      priority: it?.priority === 'situational' ? 'situational' : 'core',
    });
    if (items.length >= 7) break;
  }
  if (items.length < 3) return null;

  const emblemName = str(raw.emblem?.name, 40);
  const emblem = ALL_KNOWN_EMBLEMS.has(emblemName)
    ? {
        name: emblemName,
        talents: Array.isArray(raw.emblem?.talents)
          ? (raw.emblem.talents as unknown[]).map((t) => str(t, 40)).filter(Boolean).slice(0, 3)
          : base.emblem.talents,
        reason: str(raw.emblem?.reason),
      }
    : { name: base.emblem.name, talents: base.emblem.talents, reason: '' };

  const spellName = str(raw.spell?.name, 30);
  const spell = ALL_KNOWN_SPELLS.has(spellName)
    ? { name: spellName, reason: str(raw.spell?.reason) }
    : { name: base.spell.name, reason: '' };

  const bootsName = str(raw.boots?.name, 40);
  const boots = bootsName
    ? { name: bootsName, reason: str(raw.boots?.reason) }
    : { name: base.boots.name, reason: '' };

  return {
    source: 'llm',
    hero: { id: hero.id, name: hero.name, role: hero.role, image: hero.image, thumb: hero.thumb },
    metaAvailable,
    note: str(raw.note),
    boots,
    items,
    emblem,
    spell,
  };
}

export function validateCoach(raw: any, catalog: CatalogHero[]): CoachResponse | null {
  if (!raw || !Array.isArray(raw.tips)) return null;
  const tips: CoachTip[] = raw.tips
    .map((t: any) => ({ title: str(t?.title, 80), detail: str(t?.detail), priority: impactOf(t?.priority) }))
    .filter((t: CoachTip) => t.title && t.detail)
    .slice(0, 5);
  if (!tips.length) return null;
  return {
    source: 'llm',
    summary: str(raw.summary, 600),
    tips,
    heroes: validateHeroPicks(raw.heroes, catalog, { limit: 3 }),
  };
}

export function validateAnalysis(raw: any, stats: AnalysisResponse['stats']): AnalysisResponse | null {
  const points = (list: unknown): AnalysisPoint[] =>
    Array.isArray(list)
      ? list
          .map((p: any) => ({
            category: str(p?.category, 60),
            description: str(p?.description),
            impact: impactOf(p?.impact),
          }))
          .filter((p) => p.category && p.description)
          .slice(0, 5)
      : [];
  const strengths = points(raw?.strengths);
  const weaknesses = points(raw?.weaknesses);
  const recommendations = Array.isArray(raw?.recommendations)
    ? (raw.recommendations as unknown[]).map((r) => str(r)).filter(Boolean).slice(0, 5)
    : [];
  if (!strengths.length && !weaknesses.length) return null;
  return { source: 'llm', stats, strengths, weaknesses, recommendations };
}
