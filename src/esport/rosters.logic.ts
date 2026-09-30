/**
 * Per-season rosters (#162).
 *
 * `EsportTeamMember` is a stint: `seasonId` null is the live membership (the
 * roster the admin and the captains manage, and the only kind a community team
 * has), a row carrying a `seasonId` is the roster of that season, archived by
 * the legacy import. `leftAt` marks a player who left.
 *
 * Everything here is pure so it can be unit-tested without a database.
 */

/**
 * Prisma (MongoDB) filter selecting the LIVE memberships, i.e. the rows not
 * tied to a season.
 *
 * `{ seasonId: null }` alone is not enough: the Mongo connector translates it
 * into "the field holds an explicit null", which never matches the rows
 * written before `seasonId` existed (the field is simply absent on them).
 * `isSet: false` matches exactly those, so both branches are needed for a
 * query that must see every live membership, old rows included.
 */
export const LIVE_SEASON_BRANCHES = [{ seasonId: null }, { seasonId: { isSet: false } }] as const;

/** `where` of the live memberships, combinable with any other condition. */
export function liveMembershipWhere<T extends Record<string, unknown>>(where: T = {} as T) {
  return { ...where, AND: [{ OR: [...LIVE_SEASON_BRANCHES] }] };
}

/** `where` of the rows that count for a season: its archive plus the live rows. */
export function seasonMembershipWhere<T extends Record<string, unknown>>(
  seasonId: string,
  where: T = {} as T,
) {
  return { ...where, AND: [{ OR: [{ seasonId }, ...LIVE_SEASON_BRANCHES] }] };
}

export type RosterRow = {
  id?: string;
  teamId?: string;
  userId: string;
  role?: string | null;
  isCaptain?: boolean | null;
  isSubstitute?: boolean | null;
  sort?: number | null;
  seasonId?: string | null;
  joinedAt?: Date | string | null;
  leftAt?: Date | string | null;
  [key: string]: unknown;
};

function time(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const t = new Date(value as any).getTime();
  return Number.isFinite(t) ? t : null;
}

/** True when the stint is still open (nobody recorded a departure yet). */
export function isActiveStint(row: RosterRow, now: Date = new Date()): boolean {
  const left = time(row.leftAt);
  return left === null || left > now.getTime();
}

/**
 * Is that player still in the team TODAY? Only an open, untagged stint (the
 * live roster) or an open stint of the current season answers yes: a roster
 * archived on a past season says where he played, not where he plays.
 */
export function isCurrentMember(
  row: RosterRow,
  currentSeasonId: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!isActiveStint(row, now)) return false;
  if (!row.seasonId) return true;
  return !!currentSeasonId && row.seasonId === currentSeasonId;
}

/** Captain first, substitutes last, then the manual `sort`. */
export function orderRoster<T extends RosterRow>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if (!!a.isCaptain !== !!b.isCaptain) return a.isCaptain ? -1 : 1;
    if (!!a.isSubstitute !== !!b.isSubstitute) return a.isSubstitute ? 1 : -1;
    return (a.sort ?? 0) - (b.sort ?? 0);
  });
}

/**
 * Roster of a team for one season.
 *
 * - a row tagged with that season always counts (that is the archive);
 * - an untagged row counts only when the season asked for is the current one
 *   (or when no season is given at all, e.g. a community team): it is the live
 *   roster, it says nothing about a past season;
 * - a player who left (`leftAt`) is dropped unless `includeLeft`;
 * - the same player can hold two rows for one season (the archived one and the
 *   live one): he is listed once, the season-tagged row winning because it
 *   carries the role he had that season.
 */
export function selectSeasonRoster<T extends RosterRow>(
  rows: T[],
  options: {
    seasonId?: string | null;
    currentSeasonId?: string | null;
    includeLeft?: boolean;
    now?: Date;
  } = {},
): T[] {
  const now = options.now ?? new Date();
  const seasonId = options.seasonId ?? null;
  const isCurrent = !seasonId || seasonId === (options.currentSeasonId ?? null);
  const kept: T[] = [];
  for (const row of rows ?? []) {
    if (!row) continue;
    if (!options.includeLeft && !isActiveStint(row, now)) continue;
    if (row.seasonId) {
      if (row.seasonId !== seasonId) continue;
    } else if (!isCurrent) {
      continue;
    }
    kept.push(row);
  }
  const byUser = new Map<string, T>();
  for (const row of kept) {
    const previous = byUser.get(row.userId);
    if (!previous || (!previous.seasonId && row.seasonId)) byUser.set(row.userId, row);
  }
  return orderRoster([...byUser.values()]);
}

/** Ids of the seasons a team has an archived roster for, newest order kept. */
export function rosterSeasonIds(rows: RosterRow[]): string[] {
  const out: string[] = [];
  for (const row of rows ?? []) {
    const id = row?.seasonId;
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Season whose roster a team page shows by default.
 *
 * The current season wins whenever the team has someone playing it. A team
 * built for one season and abandoned since (the ETERNUM case: 19 matches, no
 * member today) would otherwise show an empty roster for ever, so it falls back
 * to its most recent archived roster; `seasonOrder` is the site season list,
 * newest first. An explicit request is never overridden.
 */
export function resolveRosterSeasonId(
  rows: RosterRow[],
  options: {
    seasonId?: string | null;
    currentSeasonId?: string | null;
    seasonOrder?: string[];
    now?: Date;
  } = {},
): string | null {
  if (options.seasonId) return options.seasonId;
  const currentSeasonId = options.currentSeasonId ?? null;
  if (selectSeasonRoster(rows, { seasonId: currentSeasonId, currentSeasonId, now: options.now }).length)
    return currentSeasonId;
  const archived = rosterSeasonIds(rows);
  if (!archived.length) return currentSeasonId;
  const order = options.seasonOrder ?? [];
  return order.find((id) => archived.includes(id)) ?? archived[archived.length - 1];
}

export type TeamHistoryEntry = {
  teamId: string;
  /** Season ids he played for in that team, `null` for the live membership. */
  seasonIds: string[];
  roles: string[];
  isCaptain: boolean;
  wasSubstitute: boolean;
  /** Still in the team today. */
  isCurrent: boolean;
  joinedAt: Date | string | null;
  leftAt: Date | string | null;
};

/**
 * Teams a player belonged to, with the seasons of each stint. A team he only
 * played for in season 1 is listed with `isCurrent: false`, which is the
 * question the owner wants answered ("is he still in the team now?").
 */
export function playerTeamHistory(
  rows: RosterRow[],
  currentSeasonId: string | null | undefined,
  now: Date = new Date(),
): TeamHistoryEntry[] {
  const byTeam = new Map<string, TeamHistoryEntry>();
  for (const row of rows ?? []) {
    if (!row?.teamId) continue;
    const entry =
      byTeam.get(row.teamId) ??
      ({
        teamId: row.teamId,
        seasonIds: [],
        roles: [],
        isCaptain: false,
        wasSubstitute: false,
        isCurrent: false,
        joinedAt: null,
        leftAt: null,
      } as TeamHistoryEntry);
    if (row.seasonId && !entry.seasonIds.includes(row.seasonId)) entry.seasonIds.push(row.seasonId);
    if (row.role && !entry.roles.includes(row.role)) entry.roles.push(row.role);
    if (row.isCaptain) entry.isCaptain = true;
    if (row.isSubstitute) entry.wasSubstitute = true;
    if (isCurrentMember(row, currentSeasonId, now)) entry.isCurrent = true;
    const joined = time(row.joinedAt);
    if (joined !== null && (entry.joinedAt === null || joined < (time(entry.joinedAt) ?? Infinity)))
      entry.joinedAt = row.joinedAt ?? null;
    const left = time(row.leftAt);
    if (left !== null && (entry.leftAt === null || left > (time(entry.leftAt) ?? -Infinity)))
      entry.leftAt = row.leftAt ?? null;
    byTeam.set(row.teamId, entry);
  }
  for (const entry of byTeam.values()) if (entry.isCurrent) entry.leftAt = null;
  return [...byTeam.values()];
}
