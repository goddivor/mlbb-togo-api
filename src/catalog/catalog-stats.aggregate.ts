// Pure aggregation of the Moonton Academy recommended builds (source 2776688)
// into catalog statistics: item pairs bought together, heroes using an item,
// a battle spell or an emblem, and the talents picked with an emblem.
// No I/O here so every rule is unit tested.

import { LANE_IDS } from '../mlbb/gms.constants';

const LANE_ORDER = Object.keys(LANE_IDS);

/** One Academy build, reduced to Moonton ids. Rates are percentages. */
export interface CompactBuild {
  items: number[];
  emblemId: number | null;
  talents: number[];
  spellId: number | null;
  winRate: number | null;
  pickRate: number | null;
}

/** The top builds of one hero in one lane (one Academy record). */
export interface HeroLaneBuilds {
  heroId: number;
  lane: string;
  builds: CompactBuild[];
}

const toNum = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

const toPct = (v: unknown): number | null => {
  const n = toNum(v);
  return n == null ? null : Math.round(n * 10000) / 100;
};

const ids = (list: unknown): number[] =>
  (Array.isArray(list) ? list : []).map((x) => toNum(x)).filter((n): n is number => n != null && n > 0);

/**
 * Maps the records of one lane-wide Academy builds call (every hero of the
 * lane at once) to compact rows. Records without a hero id are dropped.
 */
export function compactLaneBuilds(records: any[], lane: string): HeroLaneBuilds[] {
  const out: HeroLaneBuilds[] = [];
  for (const r of records ?? []) {
    const d = r?.data ?? {};
    const heroId = toNum(d.heroid);
    if (heroId == null || heroId <= 0) continue;
    const builds: CompactBuild[] = (Array.isArray(d.build) ? d.build : []).map((b: any) => ({
      items: ids(b?.equipid),
      emblemId: toNum(b?.runeid ?? b?.emblem?.data?.emblemid),
      talents: ids(b?.new_rune_skill),
      spellId: toNum(b?.skillid ?? b?.battleskill?.data?.battleskillid),
      winRate: toPct(b?.build_win_rate),
      pickRate: toPct(b?.build_pick_rate),
    }));
    if (builds.length) out.push({ heroId, lane, builds });
  }
  return out;
}

/**
 * Keeps the rows of the lanes each hero is really played in: Academy returns
 * every hero for every lane, and off-lane rows (a tank in gold lane) are
 * built on a handful of games. A hero with unknown lanes keeps all its rows.
 * `lane` narrows the result to one lane.
 */
export function selectRelevant(
  rows: HeroLaneBuilds[],
  heroLanes: Map<number, string[]>,
  lane?: string | null,
): HeroLaneBuilds[] {
  return rows.filter((r) => {
    if (lane && r.lane !== lane) return false;
    const lanes = heroLanes.get(r.heroId);
    return !lanes || lanes.length === 0 || lanes.includes(r.lane);
  });
}

/**
 * Average win rate weighted by pick rate. Entries without a win rate are
 * ignored; when no entry has a positive weight it falls back to a plain mean.
 */
export function weightedWinRate(entries: Array<{ winRate: number | null; weight: number | null }>): number | null {
  const valid = entries.filter((e) => e.winRate != null);
  if (!valid.length) return null;
  const total = valid.reduce((s, e) => s + Math.max(e.weight ?? 0, 0), 0);
  const value =
    total > 0
      ? valid.reduce((s, e) => s + (e.winRate as number) * Math.max(e.weight ?? 0, 0), 0) / total
      : valid.reduce((s, e) => s + (e.winRate as number), 0) / valid.length;
  return Math.round(value * 100) / 100;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

interface Acc {
  builds: number;
  heroes: Set<number>;
  weight: number;
  rates: Array<{ winRate: number | null; weight: number | null }>;
}

const newAcc = (): Acc => ({ builds: 0, heroes: new Set(), weight: 0, rates: [] });

function add(acc: Acc, heroId: number, b: CompactBuild) {
  acc.builds++;
  acc.heroes.add(heroId);
  acc.weight += Math.max(b.pickRate ?? 0, 0);
  acc.rates.push({ winRate: b.winRate, weight: b.pickRate });
}

/** Aggregated usage of one entry (item pair, spell, emblem, talent). */
export interface UsageStat {
  /** Number of top builds containing the entry. */
  builds: number;
  /** Number of distinct heroes with such a build. */
  heroes: number;
  /** Share of all the analysed builds (%). */
  share: number;
  /** Sum of the builds' pick rates (popularity weight). */
  weight: number;
  /** Pick-rate weighted average win rate of those builds (%). */
  winRate: number | null;
}

function toStat(acc: Acc, totalBuilds: number): UsageStat {
  return {
    builds: acc.builds,
    heroes: acc.heroes.size,
    share: totalBuilds ? round2((acc.builds / totalBuilds) * 100) : 0,
    weight: round2(acc.weight),
    winRate: weightedWinRate(acc.rates),
  };
}

/** Deterministic ranking: most builds, then popularity, then win rate. */
export function compareUsage(a: UsageStat, b: UsageStat): number {
  return b.builds - a.builds || b.weight - a.weight || (b.winRate ?? -1) - (a.winRate ?? -1);
}

export const countBuilds = (rows: HeroLaneBuilds[]) => rows.reduce((s, r) => s + r.builds.length, 0);

export interface ItemPairStat extends UsageStat {
  /** Moonton ids, smallest first. */
  a: number;
  b: number;
}

/**
 * Counts every pair of distinct items found in the same build. `eligible`
 * drops unknown or hidden items before pairing.
 */
export function countItemPairs(
  rows: HeroLaneBuilds[],
  eligible: (itemId: number) => boolean = () => true,
): ItemPairStat[] {
  const pairs = new Map<string, Acc>();
  for (const r of rows) {
    for (const b of r.builds) {
      const list = [...new Set(b.items.filter(eligible))].sort((x, y) => x - y);
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const key = `${list[i]}:${list[j]}`;
          if (!pairs.has(key)) pairs.set(key, newAcc());
          add(pairs.get(key)!, r.heroId, b);
        }
      }
    }
  }
  const total = countBuilds(rows);
  return [...pairs.entries()]
    .map(([key, acc]) => {
      const [a, b] = key.split(':').map(Number);
      return { a, b, ...toStat(acc, total) };
    })
    .sort((x, y) => compareUsage(x, y) || x.a - y.a || x.b - y.b);
}

/** Usage of every id returned by `keysOf` (spells, emblems, items...), keyed by id. */
export function usageBy(rows: HeroLaneBuilds[], keysOf: (b: CompactBuild) => Array<number | null>): Map<number, UsageStat> {
  const accs = new Map<number, Acc>();
  for (const r of rows) {
    for (const b of r.builds) {
      for (const k of new Set(keysOf(b))) {
        if (k == null) continue;
        if (!accs.has(k)) accs.set(k, newAcc());
        add(accs.get(k)!, r.heroId, b);
      }
    }
  }
  const total = countBuilds(rows);
  return new Map([...accs.entries()].map(([k, acc]) => [k, toStat(acc, total)]));
}

export interface HeroUsage {
  heroId: number;
  /** Lane where the hero uses the entry the most. */
  lane: string;
  /** Sum of the pick rates of the hero's top builds (in that lane) with the entry (%). */
  usage: number;
  /** Number of those builds. */
  builds: number;
  winRate: number | null;
}

/**
 * Heroes whose top builds contain a matching entry, ranked by usage (the
 * share of the hero's games in a lane played with such a build).
 */
export function rankHeroUsage(rows: HeroLaneBuilds[], matches: (b: CompactBuild) => boolean, limit = 10): HeroUsage[] {
  const best = new Map<number, HeroUsage>();
  for (const r of rows) {
    const hits = r.builds.filter(matches);
    if (!hits.length) continue;
    const entry: HeroUsage = {
      heroId: r.heroId,
      lane: r.lane,
      usage: round2(hits.reduce((s, b) => s + Math.max(b.pickRate ?? 0, 0), 0)),
      builds: hits.length,
      winRate: weightedWinRate(hits.map((b) => ({ winRate: b.winRate, weight: b.pickRate }))),
    };
    const prev = best.get(r.heroId);
    if (
      !prev ||
      entry.usage > prev.usage ||
      (entry.usage === prev.usage && LANE_ORDER.indexOf(entry.lane) < LANE_ORDER.indexOf(prev.lane))
    ) {
      best.set(r.heroId, entry);
    }
  }
  return [...best.values()]
    .sort((a, b) => b.usage - a.usage || b.builds - a.builds || (b.winRate ?? -1) - (a.winRate ?? -1) || a.heroId - b.heroId)
    .slice(0, Math.max(limit, 0));
}

/** Runs `fn` over `list` with at most `limit` calls in flight, keeping the order. */
export async function mapLimit<T, R>(list: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      out[i] = await fn(list[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, worker));
  return out;
}
