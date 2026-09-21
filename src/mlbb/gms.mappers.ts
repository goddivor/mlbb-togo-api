// Pure mappers from raw Moonton GMS records to our API shapes. No I/O, so they
// are unit-tested against the real samples in `__fixtures__/`.
//
// Units: rates exposed by the new endpoints are percentages with 2 decimals
// (0.475368 -> 47.54). `increaseWinRate` is the change, in percentage points,
// of the MAIN hero's win rate when the other hero is an enemy (counters) or a
// teammate (compatibility). Negative vs an enemy = that enemy counters the main
// hero; positive vs an enemy = the main hero is strong against it.

import { LANE_BY_ID, ROLE_BY_ID } from './gms.constants';

export function pct(n: unknown): number | null {
  const v = typeof n === 'string' ? Number(n) : n;
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10000) / 100 : null;
}

const num = (n: unknown): number | null => {
  const v = typeof n === 'string' ? Number(n) : n;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};

/* ---------------- Hero list taxonomy ---------------- */

/** Role and lane keys of a hero list record (language independent ids). */
export function heroTaxonomy(record: any): { roles: string[]; lanes: string[] } {
  const h = record?.data?.hero?.data ?? {};
  const ids = (list: any, field: string): number[] =>
    (Array.isArray(list) ? list : [])
      .map((x: any) => Number(x?.data?.[field]))
      .filter((n) => Number.isFinite(n) && n > 0);
  return {
    roles: ids(h.sortid, 'sort_id').map((id) => ROLE_BY_ID[id]).filter(Boolean),
    lanes: ids(h.roadsort, 'road_sort_id').map((id) => LANE_BY_ID[id]).filter(Boolean),
  };
}

/* ---------------- Ranking (sources 2756565..70, match_type 0) ---------------- */

/** Legacy ranking row (rates as fractions), kept for `/mlbb/ranking` and older callers. */
export interface RankingRow {
  heroId: number | null;
  name: string | null;
  image: string | null;
  winRate: number | null;
  pickRate: number | null;
  banRate: number | null;
  synergies: Array<{ heroId: number | null; image: string | null; increaseWinRate: number | null }>;
}

export function mapRankingRecords(records: any[]): RankingRow[] {
  return (records ?? []).map((record) => {
    const d = record?.data ?? {};
    const mh = d.main_hero?.data ?? {};
    return {
      heroId: num(d.main_heroid),
      name: mh.name ?? null,
      image: mh.head ?? null,
      winRate: num(d.main_hero_win_rate),
      pickRate: num(d.main_hero_appearance_rate),
      banRate: num(d.main_hero_ban_rate),
      synergies: (d.sub_hero ?? []).map((s: any) => ({
        heroId: num(s?.heroid),
        image: s?.hero?.data?.head ?? null,
        increaseWinRate: num(s?.increase_win_rate),
      })),
    };
  });
}

/* ---------------- Counters / compatibility / per-hero stats ---------------- */

export interface SubHeroStat {
  heroId: number;
  image: string | null;
  /** The other hero's own win rate (%). */
  winRate: number | null;
  /** The other hero's pick rate (%). */
  pickRate: number | null;
  /** Change of the main hero's win rate, in points. */
  increaseWinRate: number;
}

export interface RelationStats {
  heroId: number | null;
  name: string | null;
  image: string | null;
  winRate: number | null;
  pickRate: number | null;
  banRate: number | null;
  /** Highest `increaseWinRate` first. */
  best: SubHeroStat[];
  /** Lowest `increaseWinRate` first. */
  worst: SubHeroStat[];
}

export function mapSubHeroes(list: any): SubHeroStat[] {
  return (Array.isArray(list) ? list : [])
    .map((s: any) => ({
      heroId: Number(s?.heroid),
      image: s?.hero?.data?.head ?? s?.hero?.data?.hero?.data?.head ?? null,
      winRate: pct(s?.hero_win_rate),
      pickRate: pct(s?.hero_appearance_rate),
      increaseWinRate: pct(s?.increase_win_rate) ?? 0,
    }))
    .filter((s) => Number.isFinite(s.heroId) && s.heroId > 0);
}

/** One record of 2756565..70 / 2755183 (`match_type` 0 or 1) for a single hero. */
export function mapRelationRecords(records: any[]): RelationStats | null {
  const d = records?.[0]?.data;
  if (!d) return null;
  const mh = d.main_hero?.data?.hero?.data ?? d.main_hero?.data ?? {};
  return {
    heroId: num(d.main_heroid),
    name: mh.name ?? null,
    image: mh.head ?? null,
    winRate: pct(d.main_hero_win_rate),
    pickRate: pct(d.main_hero_appearance_rate ?? d.main_hero_pick_rate),
    banRate: pct(d.main_hero_ban_rate),
    best: mapSubHeroes(d.sub_hero).sort((a, b) => b.increaseWinRate - a.increaseWinRate),
    worst: mapSubHeroes(d.sub_hero_last).sort((a, b) => a.increaseWinRate - b.increaseWinRate),
  };
}

/* ---------------- Full matchup matrix (Academy 2777391) ---------------- */

export interface MatrixEntry {
  heroId: number;
  winRate: number | null;
  increaseWinRate: number;
}

export interface MatchupMatrix {
  heroId: number | null;
  winRate: number | null;
  pickRate: number | null;
  banRate: number | null;
  /** Every other hero, highest `increaseWinRate` first. */
  entries: MatrixEntry[];
}

export function mapMatrixRecords(records: any[]): MatchupMatrix | null {
  const d = records?.[0]?.data;
  if (!d) return null;
  const entries = (Array.isArray(d.sub_hero) ? d.sub_hero : [])
    .map((s: any) => ({
      heroId: Number(s?.heroid),
      winRate: pct(s?.hero_win_rate),
      increaseWinRate: pct(s?.increase_win_rate) ?? 0,
    }))
    .filter((s: MatrixEntry) => Number.isFinite(s.heroId) && s.heroId > 0)
    .sort((a: MatrixEntry, b: MatrixEntry) => b.increaseWinRate - a.increaseWinRate);
  return {
    heroId: num(d.main_heroid),
    winRate: pct(d.main_hero_win_rate),
    pickRate: pct(d.main_hero_pick_rate ?? d.main_hero_appearance_rate),
    banRate: pct(d.main_hero_ban_rate),
    entries,
  };
}

/* ---------------- Skill combos (2674711) ---------------- */

export interface SkillCombo {
  title: string | null;
  description: string | null;
  skills: Array<{ id: number | null; icon: string | null }>;
}

export function mapComboRecords(records: any[]): SkillCombo[] {
  return (records ?? []).map((r: any) => {
    const d = r?.data ?? {};
    return {
      title: d.title ?? null,
      description: d.desc ?? null,
      skills: (Array.isArray(d.skill_id) ? d.skill_id : []).map((sk: any) => ({
        id: num(sk?.data?.skillid),
        icon: sk?.data?.skillicon ?? null,
      })),
    };
  });
}

/* ---------------- Trends (2674709 / 2687909 / 2690860, Academy 2755185-7) ---------------- */

export interface TrendPoint {
  date: string;
  winRate: number | null;
  pickRate: number | null;
  banRate: number | null;
}

/** Daily series, oldest first. */
export function mapTrendRecords(records: any[]): TrendPoint[] {
  const list = records?.[0]?.data?.win_rate;
  return (Array.isArray(list) ? list : [])
    .filter((p: any) => typeof p?.date === 'string')
    .map((p: any) => ({
      date: p.date,
      winRate: pct(p.win_rate),
      pickRate: pct(p.app_rate),
      banRate: pct(p.ban_rate),
    }))
    .sort((a: TrendPoint, b: TrendPoint) => a.date.localeCompare(b.date));
}

export interface RateDeltas {
  winRate: number | null;
  pickRate: number | null;
  banRate: number | null;
  /** Dates compared (from -> to). */
  from: string | null;
  to: string | null;
}

/**
 * Change over `days` on a daily series (oldest first): last point minus the
 * point `days` days earlier (or the oldest one available).
 */
export function computeDeltas(series: TrendPoint[], days: number): RateDeltas {
  const empty: RateDeltas = { winRate: null, pickRate: null, banRate: null, from: null, to: null };
  if (!series?.length || series.length < 2) return empty;
  const last = series[series.length - 1];
  const base = series[Math.max(0, series.length - 1 - Math.max(1, days))];
  const diff = (a: number | null, b: number | null) =>
    a == null || b == null ? null : Math.round((a - b) * 100) / 100;
  return {
    winRate: diff(last.winRate, base.winRate),
    pickRate: diff(last.pickRate, base.pickRate),
    banRate: diff(last.banRate, base.banRate),
    from: base.date,
    to: last.date,
  };
}

/* ---------------- Win rate by game length (Academy 2777027) ---------------- */

export interface TimelineBucket {
  from: number;
  to: number | null;
  winRate: number | null;
}

export interface WinRateTimeline {
  totalWinRate: number | null;
  buckets: TimelineBucket[];
}

export function mapTimelineRecords(records: any[]): WinRateTimeline | null {
  const d = records?.[0]?.data;
  if (!d) return null;
  const buckets = (Array.isArray(d.time_win_rate) ? d.time_win_rate : [])
    .map((b: any) => ({
      from: Number(b?.time_min ?? 0),
      to: b?.time_max != null ? Number(b.time_max) : null,
      winRate: pct(b?.win_rate),
    }))
    .sort((a: TimelineBucket, b: TimelineBucket) => a.from - b.from);
  return { totalWinRate: pct(d.total_win_rate), buckets };
}

/* ---------------- Catalogs (Academy 2775075 items, 2718121 talents) ---------------- */

export interface CatalogEntry {
  id: number;
  name: string | null;
  icon: string | null;
  description?: string | null;
}

export function mapEquipmentRecords(records: any[]): CatalogEntry[] {
  return (records ?? [])
    .map((r: any) => ({
      id: Number(r?.data?.equipid),
      name: r?.data?.equipname ?? null,
      icon: r?.data?.equipicon ?? null,
    }))
    .filter((e) => Number.isFinite(e.id) && e.id > 0);
}

export function mapTalentRecords(records: any[]): CatalogEntry[] {
  return (records ?? [])
    .map((r: any) => {
      const s = r?.data?.emblemskill ?? {};
      return {
        id: Number(r?.data?.giftid),
        name: s.skillname ?? null,
        icon: s.skillicon ?? null,
        description: s.skilldesc ?? s.skilldescemblem ?? null,
      };
    })
    .filter((e) => Number.isFinite(e.id) && e.id > 0);
}

/* ---------------- Recommended builds (Academy 2776688) ---------------- */

export interface MetaBuild {
  winRate: number | null;
  pickRate: number | null;
  items: CatalogEntry[];
  emblem: { id: number | null; name: string | null; icon: string | null; attributes: string[] } | null;
  talents: CatalogEntry[];
  spell: CatalogEntry | null;
}

export function mapBuildRecords(
  records: any[],
  items: Map<number, CatalogEntry> = new Map(),
  talents: Map<number, CatalogEntry> = new Map(),
): MetaBuild[] {
  const builds: MetaBuild[] = [];
  for (const record of records ?? []) {
    for (const b of Array.isArray(record?.data?.build) ? record.data.build : []) {
      const spellData = b?.battleskill?.data?.__data ?? {};
      const emblemData = b?.emblem?.data ?? {};
      const attrs = String(emblemData?.emblemattr?.emblemattr ?? '')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      const spellId = num(b?.skillid ?? b?.battleskill?.data?.battleskillid);
      builds.push({
        winRate: pct(b?.build_win_rate),
        pickRate: pct(b?.build_pick_rate),
        items: (Array.isArray(b?.equipid) ? b.equipid : []).map((id: any) => {
          const n = Number(id);
          return items.get(n) ?? { id: n, name: null, icon: null };
        }),
        emblem:
          b?.emblem || b?.runeid
            ? {
                id: num(emblemData.emblemid ?? b?.runeid),
                name: emblemData.emblemname ?? emblemData?.emblemattr?.emblemname ?? null,
                icon: emblemData.attriicon ?? null,
                attributes: attrs,
              }
            : null,
        talents: (Array.isArray(b?.new_rune_skill) ? b.new_rune_skill : []).map((id: any) => {
          const n = Number(id);
          return talents.get(n) ?? { id: n, name: null, icon: null };
        }),
        spell:
          spellId != null
            ? {
                id: spellId,
                name: spellData.skillname ?? null,
                icon: spellData.skillicon ?? null,
                description: spellData.skilldesc ?? null,
              }
            : null,
      });
    }
  }
  return builds.sort((a, b) => (b.pickRate ?? 0) - (a.pickRate ?? 0));
}
