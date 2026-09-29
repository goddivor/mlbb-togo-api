import { LEGACY_REGISTRY_KEY, legacyMatchIds, parseRegistry } from './legacy-import.registry';

/**
 * Single source of truth for "was this created by the legacy import?" (#153).
 *
 * The imported rows are the archive of a league played years ago on another
 * site. They must never feed a reward: not the match XP, not the season
 * participation, podium or awards, not the achievements, not the
 * reigning-champion title. And they stay archives for ever: an admin playing a
 * real match inside an imported season does not turn that season's imported
 * podium and awards into trophies.
 *
 * Everything is answered from the import registry (`AppSetting`
 * `legacy.import`), never from the shape of the data, and cached process-wide
 * because several services ask the same question in the same request (a
 * "recalculate everything" walks every user).
 *
 * Every read is defensive: a missing or unreadable registry means "nothing is
 * legacy", never an exception, so a broken registry can never block a grant.
 */

type PrismaLike = {
  appSetting: { findUnique(args: any): Promise<{ value: string } | null> };
};

/**
 * Short on purpose: the registry only changes when the import runs, and the
 * import runs in its own process, so the API cannot be told to forget. Five
 * seconds is short enough that no reward decision is taken on a stale answer
 * after a run, and long enough to serve a whole "recalculate everything".
 */
const TTL_MS = 5_000;

type Snapshot = {
  at: number;
  /** Matches the import created. */
  matches: Set<string>;
  /** Seasons the import created: they stay archives for ever. */
  seasons: Set<string>;
  /** Season awards the import created. */
  awards: Set<string>;
};

let snapshot: Snapshot | null = null;
let loading: Promise<Snapshot> | null = null;

/** Forget the cached snapshot (tests, and right after an import). */
export function resetLegacyCache() {
  snapshot = null;
  loading = null;
}

async function load(prisma: PrismaLike): Promise<Snapshot> {
  const empty: Snapshot = { at: Date.now(), matches: new Set(), seasons: new Set(), awards: new Set() };
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: LEGACY_REGISTRY_KEY } });
    if (!row) return empty;
    const registry = parseRegistry(row.value);
    return {
      at: Date.now(),
      matches: legacyMatchIds(registry),
      // A season the import created is an archive for ever, whatever an admin
      // plays in it afterwards: its podium, its awards and its rosters were
      // written by the import and must never pay anybody.
      seasons: new Set(Object.values(registry.seasons)),
      awards: new Set(Object.values(registry.awards)),
    };
  } catch {
    // A missing or unreadable registry means "nothing is legacy", never a throw.
    return empty;
  }
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

/** Seasons the legacy import created: they grant nothing, for ever. */
export async function legacySeasons(prisma: PrismaLike): Promise<Set<string>> {
  return (await current(prisma)).seasons;
}

/** Season awards the legacy import created. */
export async function legacyAwards(prisma: PrismaLike): Promise<Set<string>> {
  return (await current(prisma)).awards;
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
