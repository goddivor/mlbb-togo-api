import { Injectable } from '@nestjs/common';
import { HeroSuggestion } from './dto/suggest-pick-ban.dto';

/**
 * Pure suggestion engine for pick/ban drafting.
 * Testable, no external dependencies.
 * Analyzes hero meta (counters, synergies, win/pick/ban rates) and draft state
 * to score and rank hero suggestions.
 */

export interface HeroMetaData {
  id: string;
  name: string;
  image?: string;
  thumb?: string;
  role?: string;
  laneKeys?: string[];
  stats?: {
    winRate?: number;
    pickRate?: number;
    banRate?: number;
  };
}

export interface HeroCounterData {
  heroId: string;
  strong?: string[]; // hero IDs this hero counters
  weak?: string[]; // hero IDs that counter this hero
  bestTeammates?: string[]; // synergy hero IDs
}

/**
 * Score factors for suggestion ranking (adjustable weights):
 * - Counter offensive: +25 per strong counter to enemy picks
 * - Counter defensive: +30 per enemy hero it's weak to (ban it)
 * - Synergy: +15 per best teammate already picked
 * - Lane coverage: +20 per uncovered lane
 * - Meta: +10 for high win rate, +5 for high pick rate
 */

interface ScoringContext {
  action: 'pick' | 'ban';
  team: 'blue' | 'red';
  allHeroes: Map<string, HeroMetaData>;
  counterData: Map<string, HeroCounterData>;
  pickedHeroIds: Set<string>;
  bannedHeroIds: Set<string>;
  allyPicks: string[];
  enemyPicks: string[];
  allyBans: string[];
  enemyBans: string[];
  uncoveredLanes: Set<string>;
}

@Injectable()
export class PickBanSuggestionService {
  /**
   * Score and rank heroes based on draft state and meta data.
   * Returns top 5 suggestions sorted by score descending.
   */
  suggestHeroes(
    availableHeroes: HeroMetaData[],
    heroCounters: Map<string, HeroCounterData>,
    context: Omit<ScoringContext, 'allHeroes' | 'counterData'>,
  ): HeroSuggestion[] {
    const allHeroes = new Map(availableHeroes.map((h) => [h.id, h]));
    const ctx: ScoringContext = {
      ...context,
      allHeroes,
      counterData: heroCounters,
    };

    const available = availableHeroes.filter(
      (h) => !ctx.pickedHeroIds.has(h.id) && !ctx.bannedHeroIds.has(h.id),
    );

    const scored = available
      .map((hero) => ({
        hero,
        score: this.scoreHero(hero, ctx),
        reason: this.buildReason(hero, ctx),
      }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    return scored.map((s) => ({
      heroId: s.hero.id,
      heroName: s.hero.name,
      image: s.hero.image,
      thumb: s.hero.thumb,
      role: s.hero.role,
      reason: s.reason,
      score: s.score,
    }));
  }

  /**
   * Calculate a score for a hero based on the current draft state.
   */
  private scoreHero(hero: HeroMetaData, ctx: ScoringContext): number {
    if (ctx.action === 'ban') {
      return this.scoreBan(hero, ctx);
    }
    return this.scorePick(hero, ctx);
  }

  /**
   * Score a hero for picking.
   * Consider: lane coverage, counter to enemy, synergy with allies, meta rate.
   */
  private scorePick(hero: HeroMetaData, ctx: ScoringContext): number {
    let score = 0;

    // Lane coverage: +20 per lane this hero can fill
    const heroLanes = hero.laneKeys || [];
    const coversUncovered = heroLanes.filter((l) => ctx.uncoveredLanes.has(l));
    score += coversUncovered.length * 20;

    // Counter offensive: +25 per enemy pick this hero counters
    const counter = ctx.counterData.get(hero.id);
    if (counter?.strong) {
      const countsEnemies = counter.strong.filter((e) =>
        ctx.enemyPicks.includes(e),
      ).length;
      score += countsEnemies * 25;
    }

    // Synergy: +15 per allied hero picked
    if (counter?.bestTeammates) {
      const synergies = counter.bestTeammates.filter((t) =>
        ctx.allyPicks.includes(t),
      ).length;
      score += synergies * 15;
    }

    // Meta factors: win/pick rates
    const stats = hero.stats as any;
    if (stats?.winRate && stats.winRate > 50) score += 10;
    if (stats?.pickRate && stats.pickRate > 50) score += 5;

    // Fallback base score if no picks yet (meta only)
    if (ctx.allyPicks.length === 0) {
      score = Math.max(score, (stats?.winRate ?? 0) / 10 + 5);
    }

    return score;
  }

  /**
   * Score a hero for banning.
   * Prioritize: heroes that counter our team, high ban/pick rate, enemy synergies.
   */
  private scoreBan(hero: HeroMetaData, ctx: ScoringContext): number {
    let score = 0;

    // Counter defensive: +30 per ally pick this hero counters
    const counter = ctx.counterData.get(hero.id);
    if (counter?.strong) {
      const countsAllies = counter.strong.filter((a) =>
        ctx.allyPicks.includes(a),
      ).length;
      score += countsAllies * 30;
    }

    // High meta rates: +15 ban rate, +10 pick rate
    const stats = hero.stats as any;
    if (stats?.banRate && stats.banRate > 50) score += 15;
    if (stats?.pickRate && stats.pickRate > 60) score += 10;

    // Low win rate is bad for us: +5 (easier to play against high-win heroes)
    if (stats?.winRate && stats.winRate > 55) score += 5;

    // Fallback base score
    if (score === 0) {
      score = (stats?.banRate ?? 0) / 10 + 5;
    }

    return score;
  }

  /**
   * Build a human-readable reason for the suggestion.
   */
  private buildReason(hero: HeroMetaData, ctx: ScoringContext): string {
    const reasons: string[] = [];

    // Check for counters
    const counter = ctx.counterData.get(hero.id);
    if (counter?.strong) {
      const countsEnemies = counter.strong
        .filter((e) => ctx.enemyPicks.includes(e))
        .map((e) => {
          const enemy = ctx.allHeroes.get(e);
          return enemy?.name;
        })
        .filter(Boolean);
      if (countsEnemies.length > 0) {
        reasons.push(`counters ${countsEnemies.join(', ')}`);
      }
    }

    // Check for lane coverage
    if (ctx.action === 'pick') {
      const heroLanes = hero.laneKeys || [];
      const coversLanes = heroLanes.filter((l) => ctx.uncoveredLanes.has(l));
      if (coversLanes.length > 0) {
        const laneLabels = this.laneName(coversLanes[0]);
        reasons.push(`covers ${laneLabels} lane`);
      }
    }

    // Check for high meta rates
    const stats = hero.stats as any;
    if (ctx.action === 'ban' && stats?.banRate && stats.banRate > 50) {
      reasons.push(`high ban rate (${Math.round(stats.banRate)}%)`);
    }

    if (reasons.length === 0) {
      reasons.push('strong meta pick');
    }

    return reasons.join(', ');
  }

  private laneName(laneKey: string): string {
    const names: Record<string, string> = {
      gold: 'Gold',
      mid: 'Mid',
      jungle: 'Jungle',
      exp: 'Exp',
      roam: 'Roam',
    };
    return names[laneKey] || laneKey;
  }
}
