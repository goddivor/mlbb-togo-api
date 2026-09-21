// Moonton GMS identifiers (see api-research/ARENA_UPSTREAM.md). Every public
// hero statistic is a POST on `/api/gms/source/<appId>/<sourceId>`.

export const GMS_BASE = 'https://api.gms.moontontech.com';

/** Hero data app used by www.mobilelegends.com. */
export const APP_HEROES = '2669606';
/** "Academy" app: full matchup matrix, builds, timeline, item catalogs. */
export const APP_ACADEMY = '2713644';
export type GmsAppId = typeof APP_HEROES | typeof APP_ACADEMY;

export const ACT_ID = '2669607';

export const GMS_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

export const SRC = {
  // app 2669606
  heroes: '2756564',
  combos: '2674711',
  combosObject: 2684183,
  // app 2713644
  academyStats: '2755183',
  matrix: '2777391',
  timeline: '2777027',
  builds: '2776688',
  heroLanes: '2766683',
  equipment: '2775075',
  talents: '2718121',
} as const;

/** Ranking / counters / compatibility / per-hero stats source by window (days). */
export const WINDOW_SOURCES: Record<number, string> = {
  1: '2756567',
  3: '2756568',
  7: '2756569',
  15: '2756565',
  30: '2756570',
};
export const WINDOW_DAYS = [1, 3, 7, 15, 30] as const;
export type WindowDays = (typeof WINDOW_DAYS)[number];

/** Daily trend series sources (app 2669606) and their Academy fallbacks. */
export const TREND_SOURCES: Record<number, string> = { 7: '2674709', 15: '2687909', 30: '2690860' };
export const ACADEMY_TREND_SOURCES: Record<number, string> = { 7: '2755185', 15: '2755186', 30: '2755187' };
export const TREND_DAYS = [7, 15, 30] as const;
export type TrendDays = (typeof TREND_DAYS)[number];

/** Rank tier -> GMS `bigrank`. */
export const RANK_TIERS: Record<string, string> = {
  all: '101',
  epic: '5',
  legend: '6',
  mythic: '7',
  honor: '8',
  glory: '9',
};
export type RankTier = keyof typeof RANK_TIERS;

/** Lane key -> GMS `real_road` / `road_sort_id`. */
export const LANE_IDS: Record<string, number> = { exp: 1, mid: 2, roam: 3, jungle: 4, gold: 5 };
export const LANE_BY_ID: Record<number, string> = { 1: 'exp', 2: 'mid', 3: 'roam', 4: 'jungle', 5: 'gold' };

/** Role key -> GMS `sort_id`. */
export const ROLE_BY_ID: Record<number, string> = {
  1: 'tank',
  2: 'fighter',
  3: 'assassin',
  4: 'mage',
  5: 'marksman',
  6: 'support',
};

/** Cache TTLs: the meta moves daily, catalogs almost never. */
export const TTL = {
  ranking: 6 * 60 * 60 * 1000,
  counters: 6 * 60 * 60 * 1000,
  matrix: 6 * 60 * 60 * 1000,
  stats: 6 * 60 * 60 * 1000,
  trends: 12 * 60 * 60 * 1000,
  timeline: 12 * 60 * 60 * 1000,
  builds: 24 * 60 * 60 * 1000,
  combos: 24 * 60 * 60 * 1000,
  catalog: 24 * 60 * 60 * 1000,
  heroes: 24 * 60 * 60 * 1000,
};

/** Normalizes a rank query (`mythic`, `7`, `101`...) to a known tier key. */
export function normalizeRank(rank?: string | null): RankTier {
  const r = String(rank ?? '').trim().toLowerCase();
  if (!r) return 'all';
  // Own keys only: `in` would accept `constructor` / `__proto__`.
  if (Object.prototype.hasOwnProperty.call(RANK_TIERS, r)) return r as RankTier;
  const byValue = Object.entries(RANK_TIERS).find(([, v]) => v === r);
  return (byValue?.[0] as RankTier) ?? 'all';
}

/** Normalizes a window query to one of 1/3/7/15/30 days (default 1). */
export function normalizeDays(days?: string | number | null): WindowDays {
  const n = Number(days);
  return (WINDOW_DAYS as readonly number[]).includes(n) ? (n as WindowDays) : 1;
}

/** Normalizes a trend window to 7/15/30 days (default 7). */
export function normalizeTrendDays(days?: string | number | null): TrendDays {
  const n = Number(days);
  return (TREND_DAYS as readonly number[]).includes(n) ? (n as TrendDays) : 7;
}

/** Normalizes a lane query (`gold`, `5`) to a lane key, or null. */
export function normalizeLane(lane?: string | number | null): string | null {
  const l = String(lane ?? '').trim().toLowerCase();
  if (!l) return null;
  if (Object.prototype.hasOwnProperty.call(LANE_IDS, l)) return l;
  return LANE_BY_ID[Number(l)] ?? null;
}

/** Languages served by the site; anything else falls back to English so the
 * cache keys (hero list ~1 MB per language) stay bounded. */
export const GMS_LANGS = ['en', 'fr'] as const;

export function normalizeLang(lang?: string | null): string {
  const l = String(lang ?? '').trim().toLowerCase();
  return (GMS_LANGS as readonly string[]).includes(l) ? l : 'en';
}
