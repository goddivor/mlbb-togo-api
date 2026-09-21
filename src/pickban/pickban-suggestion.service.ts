import { Injectable } from '@nestjs/common';
import { HeroSuggestion, SuggestionReason } from './dto/pickban.dto';
import { LANES, PickBanAction, PickBanTeam } from './pickban-order';

// Pure suggestion engine for the pick & ban simulator. No I/O: the caller
// provides the hero catalogue and the (cached) meta of the heroes already on
// the board, so the scoring stays deterministic and unit-testable.

export interface HeroCandidate {
  id: string;
  name: string;
  image?: string | null;
  thumb?: string | null;
  role?: string | null;
  roles?: string[];
  laneKeys?: string[];
  // Rates are percentages (0-100). Fractions (0-1) are normalized by the caller.
  winRate?: number | null;
  pickRate?: number | null;
  banRate?: number | null;
}

// Meta of a hero already picked, expressed with OUR hero ids.
export interface PickedHeroMeta {
  heroId: string;
  strongAgainst: string[]; // heroes this hero beats
  weakAgainst: string[]; // heroes that beat this hero
  bestTeammates: string[];
  // Full matchup matrix (Academy), when available: change of THIS hero's win
  // rate, in points, when the keyed hero is an enemy (`vsEnemy`) or a
  // teammate (`withAlly`). When present it supersedes the top-5 lists above,
  // so every candidate is scored against every hero on the board.
  vsEnemy?: Map<string, number>;
  withAlly?: Map<string, number>;
}

/** Matrix entry as returned by HeroMetaService.getMatchups (Moonton ids). */
export interface MatrixRef {
  heroId: number | null;
  increaseWinRate: number;
}

/**
 * Builds the meta of a picked hero from its full matchup matrix, keyed by OUR
 * hero ids. The top-5 lists are derived from the matrix for display/fallback.
 * Returns null when both matrices are empty.
 */
export function toPickedMeta(
  heroId: string,
  counters: MatrixRef[],
  teammates: MatrixRef[],
  byMoontonId: Map<number, string>,
): PickedHeroMeta | null {
  const toMap = (list: MatrixRef[]) => {
    const map = new Map<string, number>();
    for (const r of list ?? []) {
      const id = r?.heroId != null ? byMoontonId.get(Number(r.heroId)) : undefined;
      if (id && id !== heroId && typeof r.increaseWinRate === 'number') map.set(id, r.increaseWinRate);
    }
    return map;
  };
  const vsEnemy = toMap(counters);
  const withAlly = toMap(teammates);
  if (!vsEnemy.size && !withAlly.size) return null;

  const top = (map: Map<string, number>, dir: 1 | -1) =>
    [...map.entries()]
      .filter(([, v]) => dir * v > 0)
      .sort((a, b) => dir * (b[1] - a[1]))
      .slice(0, 5)
      .map(([id]) => id);

  return {
    heroId,
    strongAgainst: top(vsEnemy, 1),
    weakAgainst: top(vsEnemy, -1),
    bestTeammates: top(withAlly, 1),
    vsEnemy: vsEnemy.size ? vsEnemy : undefined,
    withAlly: withAlly.size ? withAlly : undefined,
  };
}

export interface SuggestionContext {
  action: PickBanAction;
  team: PickBanTeam;
  allyPicks: string[];
  enemyPicks: string[];
  excluded: Set<string>; // already picked or banned (both teams)
  // Explicit lane chosen for an ally pick, keyed by hero id (optional).
  allyLanes?: Record<string, string | undefined>;
  pickedMeta: Map<string, PickedHeroMeta>;
  metaAvailable: boolean;
}

// Score weights. Kept in one place so they are easy to tune.
export const WEIGHTS = {
  countersEnemy: 25,
  counteredByEnemy: -20,
  synergyWithAlly: 15,
  laneCoverage: 20,
  threatensAlly: 30,
  synergyWithEnemy: 15,
  winRate: 0.6, // per point above 50%
  banRate: 0.3, // per point (ban suggestions)
  pickRate: 0.1, // per point
  // Full-matrix weights, per point of win-rate change.
  matrixCounter: 6, // candidate lowers (or raises) an enemy pick's win rate
  matrixSynergy: 4, // candidate raises an ally pick's win rate
  matrixThreat: 7, // ban: candidate lowers an ally pick's win rate
  matrixEnemySynergy: 4, // ban: candidate raises an enemy pick's win rate
};

// Minimum matrix effect (points) for a pair to be named in the reasons.
export const MATRIX_REASON_THRESHOLD = 1.5;
// Cap of a single pair's matrix effect (points), so one outlier cannot dominate.
export const MATRIX_CAP = 8;

const capped = (v: number) => Math.max(-MATRIX_CAP, Math.min(MATRIX_CAP, v));

const LANE_LABEL: Record<string, string> = {
  gold: 'Gold',
  mid: 'Mid',
  jungle: 'Jungle',
  exp: 'EXP',
  roam: 'Roam',
};

interface Scored {
  hero: HeroCandidate;
  score: number;
  reasons: SuggestionReason[];
}

function describe(r: SuggestionReason): string {
  switch (r.kind) {
    case 'counters':
      return `counters ${r.names?.join(', ')}`;
    case 'counteredBy':
      return `countered by ${r.names?.join(', ')}`;
    case 'synergy':
      return `synergy with ${r.names?.join(', ')}`;
    case 'lane':
      return `covers ${LANE_LABEL[r.lane ?? ''] ?? r.lane} lane`;
    case 'threatens':
      return `counters your ${r.names?.join(', ')}`;
    case 'pairsWith':
      return `pairs with enemy ${r.names?.join(', ')}`;
    case 'winRate':
      return `${r.value?.toFixed(1)}% win rate`;
    case 'banRate':
      return `${r.value?.toFixed(0)}% ban rate`;
  }
}

@Injectable()
export class PickBanSuggestionService {
  suggest(
    heroes: HeroCandidate[],
    ctx: SuggestionContext,
    limit = 5,
  ): HeroSuggestion[] {
    const byId = new Map(heroes.map((h) => [h.id, h]));
    const uncovered = this.uncoveredLanes(ctx.allyPicks, byId, ctx.allyLanes);

    const scored: Scored[] = heroes
      .filter((h) => !ctx.excluded.has(h.id))
      .map((hero) =>
        ctx.action === 'pick'
          ? this.scorePick(hero, ctx, byId, uncovered)
          : this.scoreBan(hero, ctx, byId),
      );

    scored.sort((a, b) => b.score - a.score || a.hero.name.localeCompare(b.hero.name));

    return scored.slice(0, limit).map((s) => ({
      heroId: s.hero.id,
      heroName: s.hero.name,
      image: s.hero.image ?? undefined,
      thumb: s.hero.thumb ?? undefined,
      role: s.hero.role ?? undefined,
      reason: s.reasons.length ? s.reasons.map(describe).join(', ') : 'solid meta choice',
      reasons: s.reasons,
      score: Math.round(s.score),
    }));
  }

  // Lanes not yet covered by the ally picks. A pick with an explicit lane
  // covers it; otherwise the hero's first recommended lane is used.
  uncoveredLanes(
    allyPicks: string[],
    byId: Map<string, HeroCandidate>,
    allyLanes: Record<string, string | undefined> = {},
  ): Set<string> {
    const uncovered = new Set<string>(LANES);
    for (const id of allyPicks) {
      const lane = allyLanes[id] ?? byId.get(id)?.laneKeys?.[0];
      if (lane) uncovered.delete(lane);
    }
    return uncovered;
  }

  private scorePick(
    hero: HeroCandidate,
    ctx: SuggestionContext,
    byId: Map<string, HeroCandidate>,
    uncovered: Set<string>,
  ): Scored {
    let score = 0;
    const reasons: SuggestionReason[] = [];

    const counters: string[] = [];
    const counteredBy: string[] = [];
    for (const enemyId of ctx.enemyPicks) {
      const meta = ctx.pickedMeta.get(enemyId);
      if (!meta) continue;
      if (meta.vsEnemy) {
        // Matrix: the enemy's win rate change when facing this candidate.
        const enemyDelta = meta.vsEnemy.get(hero.id);
        if (enemyDelta == null) continue;
        const edge = capped(-enemyDelta);
        score += edge * WEIGHTS.matrixCounter;
        if (edge >= MATRIX_REASON_THRESHOLD) counters.push(this.nameOf(enemyId, byId));
        else if (edge <= -MATRIX_REASON_THRESHOLD) counteredBy.push(this.nameOf(enemyId, byId));
        continue;
      }
      if (meta.weakAgainst.includes(hero.id)) {
        counters.push(this.nameOf(enemyId, byId));
        score += WEIGHTS.countersEnemy;
      }
      if (meta.strongAgainst.includes(hero.id)) {
        counteredBy.push(this.nameOf(enemyId, byId));
        score += WEIGHTS.counteredByEnemy;
      }
    }
    if (counters.length) reasons.push({ kind: 'counters', names: counters });
    if (counteredBy.length) reasons.push({ kind: 'counteredBy', names: counteredBy });

    const synergies: string[] = [];
    for (const allyId of ctx.allyPicks) {
      const meta = ctx.pickedMeta.get(allyId);
      if (!meta) continue;
      if (meta.withAlly) {
        const gain = meta.withAlly.get(hero.id);
        if (gain == null) continue;
        score += capped(gain) * WEIGHTS.matrixSynergy;
        if (gain >= MATRIX_REASON_THRESHOLD) synergies.push(this.nameOf(allyId, byId));
        continue;
      }
      if (meta.bestTeammates.includes(hero.id)) {
        synergies.push(this.nameOf(allyId, byId));
        score += WEIGHTS.synergyWithAlly;
      }
    }
    if (synergies.length) reasons.push({ kind: 'synergy', names: synergies });

    const lanes = (hero.laneKeys ?? []).filter((l) => uncovered.has(l));
    if (lanes.length) {
      score += WEIGHTS.laneCoverage;
      reasons.push({ kind: 'lane', lane: lanes[0] });
    }

    score += this.metaScore(hero, 'pick', reasons);
    return { hero, score, reasons };
  }

  private scoreBan(
    hero: HeroCandidate,
    ctx: SuggestionContext,
    byId: Map<string, HeroCandidate>,
  ): Scored {
    let score = 0;
    const reasons: SuggestionReason[] = [];

    const threatens: string[] = [];
    for (const allyId of ctx.allyPicks) {
      const meta = ctx.pickedMeta.get(allyId);
      if (!meta) continue;
      if (meta.vsEnemy) {
        // Matrix: our pick's win rate change when this candidate is an enemy.
        const delta = meta.vsEnemy.get(hero.id);
        if (delta == null) continue;
        const threat = capped(-delta);
        score += threat * WEIGHTS.matrixThreat;
        if (threat >= MATRIX_REASON_THRESHOLD) threatens.push(this.nameOf(allyId, byId));
        continue;
      }
      if (meta.weakAgainst.includes(hero.id)) {
        threatens.push(this.nameOf(allyId, byId));
        score += WEIGHTS.threatensAlly;
      }
    }
    if (threatens.length) reasons.push({ kind: 'threatens', names: threatens });

    const pairsWith: string[] = [];
    for (const enemyId of ctx.enemyPicks) {
      const meta = ctx.pickedMeta.get(enemyId);
      if (!meta) continue;
      if (meta.withAlly) {
        const gain = meta.withAlly.get(hero.id);
        if (gain == null) continue;
        score += capped(gain) * WEIGHTS.matrixEnemySynergy;
        if (gain >= MATRIX_REASON_THRESHOLD) pairsWith.push(this.nameOf(enemyId, byId));
        continue;
      }
      if (meta.bestTeammates.includes(hero.id)) {
        pairsWith.push(this.nameOf(enemyId, byId));
        score += WEIGHTS.synergyWithEnemy;
      }
    }
    if (pairsWith.length) reasons.push({ kind: 'pairsWith', names: pairsWith });

    score += this.metaScore(hero, 'ban', reasons);
    return { hero, score, reasons };
  }

  private metaScore(
    hero: HeroCandidate,
    action: PickBanAction,
    reasons: SuggestionReason[],
  ): number {
    let score = 0;
    const win = hero.winRate ?? null;
    const ban = hero.banRate ?? null;
    const pick = hero.pickRate ?? null;

    if (win != null) {
      score += (win - 50) * WEIGHTS.winRate;
      if (win >= 53) reasons.push({ kind: 'winRate', value: win });
    }
    if (action === 'ban' && ban != null) {
      score += ban * WEIGHTS.banRate;
      if (ban >= 30) reasons.push({ kind: 'banRate', value: ban });
    }
    if (pick != null) score += pick * WEIGHTS.pickRate;
    return score;
  }

  private nameOf(id: string, byId: Map<string, HeroCandidate>): string {
    return byId.get(id)?.name ?? id;
  }
}
