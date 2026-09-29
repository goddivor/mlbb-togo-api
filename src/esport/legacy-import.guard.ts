import { LEGACY_REGISTRY_KEY, legacyMatchIds, parseRegistry } from './legacy-import.registry';

/**
 * Single source of truth for "was this imported from the legacy site?" (#153).
 *
 * The imported matches are archives of a league that was played years ago on
 * another site. They must never feed a reward: not the match XP, not the season
 * participation or podium, not the achievements, not the reigning-champion
 * title. The answer is read from the import registry (`AppSetting`
 * `legacy.import`) and cached process-wide, because it changes only when the
 * import runs and several services ask the same question in the same request
 * (a "recalculate everything" walks every user).
 *
 * Every read is defensive: a missing or unreadable registry means "nothing is
 * legacy", never an exception, so a broken registry can never block a grant.
 */

type PrismaLike = {
  appSetting: { findUnique(args: any): Promise<{ value: string } | null> };
  esportMatch: { findMany(args: any): Promise<any[]> };
};

const TTL_MS = 60_000;

type Snapshot = {
  at: number;
  /** Ids of the matches created by the import. */
  matches: Set<string>;
  /** Seasons whose matches all come from the import. */
  seasons: Set<string>;
};

let snapshot: Snapshot | null = null;
let loading: Promise<Snapshot> | null = null;

/** Forget the cached snapshot (used by the tests and after an import). */
export function resetLegacyCache() {
  snapshot = null;
  loading = null;
}

async function load(prisma: PrismaLike): Promise<Snapshot> {
  const empty: Snapshot = { at: Date.now(), matches: new Set(), seasons: new Set() };
  let matches = new Set<string>();
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: LEGACY_REGISTRY_KEY } });
    if (row) matches = legacyMatchIds(parseRegistry(row.value));
  } catch {
    return empty;
  }
  if (!matches.size) return empty;
  // A season counts as legacy while every match it holds comes from the
  // import. The day an admin plays a real match in it, it stops being one and
  // its rewards resume for everybody.
  const seasons = new Set<string>();
  try {
    const rows = await prisma.esportMatch.findMany({ select: { id: true, seasonId: true } });
    const total = new Map<string, number>();
    const legacy = new Map<string, number>();
    for (const m of rows) {
      if (!m.seasonId) continue;
      total.set(m.seasonId, (total.get(m.seasonId) ?? 0) + 1);
      if (matches.has(m.id)) legacy.set(m.seasonId, (legacy.get(m.seasonId) ?? 0) + 1);
    }
    for (const [seasonId, n] of total) {
      if (n > 0 && legacy.get(seasonId) === n) seasons.add(seasonId);
    }
  } catch {
    // Keep the match ids: they are the important half.
  }
  return { at: Date.now(), matches, seasons };
}

async function current(prisma: PrismaLike): Promise<Snapshot> {
  if (snapshot && Date.now() - snapshot.at < TTL_MS) return snapshot;
  if (!loading) {
    loading = load(prisma).then((s) => {
      snapshot = s;
      loading = null;
      return s;
    });
  }
  return loading;
}

/** Ids of every match the legacy import created. */
export async function legacyMatches(prisma: PrismaLike): Promise<Set<string>> {
  return (await current(prisma)).matches;
}

/** Seasons made only of imported matches: they grant nothing at all. */
export async function legacySeasons(prisma: PrismaLike): Promise<Set<string>> {
  return (await current(prisma)).seasons;
}

export async function isLegacyMatch(prisma: PrismaLike, matchId: string): Promise<boolean> {
  return (await legacyMatches(prisma)).has(matchId);
}

export async function isLegacySeason(prisma: PrismaLike, seasonId: string): Promise<boolean> {
  return (await legacySeasons(prisma)).has(seasonId);
}

/** Drop the rows that point at an imported match (stats, achievement facts). */
export async function withoutLegacyMatches<T extends { matchId: string }>(
  prisma: PrismaLike,
  rows: T[],
): Promise<T[]> {
  if (!rows.length) return rows;
  const ids = await legacyMatches(prisma);
  return ids.size ? rows.filter((r) => !ids.has(r.matchId)) : rows;
}
