import {
  OTHER_CITY_ID,
  OTHER_CITY_NAME,
  TOGO_CITIES,
  TogoCity,
  normalizeCity,
} from './geo.constants';

/** Minimal shapes the aggregation needs (kept DB-agnostic so it is testable). */
export interface MapUserInput {
  id: string;
  username: string;
  avatar?: string | null;
  gameNickname?: string | null;
  city?: string | null;
  privacy?: any;
}

export interface MapTeamInput {
  id: string;
  name: string;
  image?: string | null;
  type?: string | null;
  city?: string | null;
  memberCount?: number;
}

export interface MapTournamentInput {
  id: string;
  name: string;
  status?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  city?: string | null;
}

export interface MapEventInput {
  id: string;
  title: string;
  type?: string | null;
  date?: string | null;
  time?: string | null;
  city?: string | null;
}

export interface MapDraftInput {
  id: string;
  name: string;
  status?: string | null;
  category?: string | null;
  city?: string | null;
}

export interface SeasonWindow {
  id: string;
  name: string;
  startDate?: Date | string | null;
  endDate?: Date | string | null;
}

export interface MapAggregateInput {
  users: MapUserInput[];
  teams: MapTeamInput[];
  tournaments: MapTournamentInput[];
  events: MapEventInput[];
  drafts: MapDraftInput[];
  /** Restricts tournaments / events to the season's date window. */
  season?: SeasonWindow | null;
  now?: Date;
}

export interface MapPlayerPreview {
  id: string;
  username: string;
  avatar: string | null;
}

export interface MapTournamentItem {
  id: string;
  name: string;
  status: string | null;
  startDate: string | null;
  endDate: string | null;
  upcoming: boolean;
}

export interface MapEventItem {
  id: string;
  title: string;
  type: string | null;
  date: string | null;
  time: string | null;
  upcoming: boolean;
}

export interface MapDraftItem {
  id: string;
  name: string;
  status: string | null;
  category: string | null;
}

export interface MapCityBucket {
  id: string;
  name: string;
  region: string | null;
  lat: number | null;
  lng: number | null;
  players: number;
  /** Up to `PUBLIC_PLAYERS_LIMIT` public profiles of the city. */
  topPlayers: MapPlayerPreview[];
  teams: { id: string; name: string; image: string | null; type: string; memberCount: number }[];
  tournaments: MapTournamentItem[];
  events: MapEventItem[];
  drafts: MapDraftItem[];
  counts: {
    players: number;
    teams: number;
    tournaments: number;
    events: number;
    drafts: number;
    upcoming: number;
    past: number;
    total: number;
  };
}

export interface MapAggregate {
  season: { id: string; name: string } | null;
  totals: {
    players: number;
    teams: number;
    tournaments: number;
    events: number;
    drafts: number;
    /** Items that could be attached to a known city. */
    located: number;
    /** Items whose city is empty or unknown. */
    unlocated: number;
  };
  cities: MapCityBucket[];
  other: MapCityBucket;
}

export const PUBLIC_PLAYERS_LIMIT = 3;

/** Only players who kept their profile public are listed by name. */
export function isProfilePublic(privacy: any): boolean {
  if (!privacy || typeof privacy !== 'object') return true;
  return privacy.profilePublic !== false;
}

/** A user without a city (or with "Autre") is not counted anywhere. */
export function hasCity(raw?: string | null): boolean {
  return !!(raw && raw.trim());
}

function toTime(v?: Date | string | null): number | null {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * True when `date` (a YYYY-MM-DD or ISO string) sits inside the season's
 * window. Without a season, or without dates on either side, everything
 * matches so an unfiltered map still shows every item.
 */
export function inSeasonWindow(
  date: string | null | undefined,
  season?: SeasonWindow | null,
): boolean {
  if (!season) return true;
  const t = toTime(date);
  if (t === null) return true;
  const start = toTime(season.startDate);
  const end = toTime(season.endDate);
  if (start !== null && t < start) return false;
  if (end !== null && t > end + 24 * 3600 * 1000) return false;
  return true;
}

/** Upcoming = not finished yet (end date, else start date, in the future). */
export function isUpcoming(
  item: { status?: string | null; startDate?: string | null; endDate?: string | null; date?: string | null },
  now: Date,
): boolean {
  if (item.status === 'completed' || item.status === 'finished') return false;
  if (item.status === 'ongoing' || item.status === 'live') return true;
  const ref = toTime(item.endDate ?? item.startDate ?? item.date ?? null);
  if (ref === null) return item.status === 'upcoming';
  // End of the day so an event happening today is still "upcoming".
  return ref + 24 * 3600 * 1000 >= now.getTime();
}

function emptyBucket(city: TogoCity | null): MapCityBucket {
  return {
    id: city?.id ?? OTHER_CITY_ID,
    name: city?.name ?? OTHER_CITY_NAME,
    region: city?.region ?? null,
    lat: city?.lat ?? null,
    lng: city?.lng ?? null,
    players: 0,
    topPlayers: [],
    teams: [],
    tournaments: [],
    events: [],
    drafts: [],
    counts: { players: 0, teams: 0, tournaments: 0, events: 0, drafts: 0, upcoming: 0, past: 0, total: 0 },
  };
}

function finalize(bucket: MapCityBucket): MapCityBucket {
  const upcoming =
    bucket.tournaments.filter((t) => t.upcoming).length + bucket.events.filter((e) => e.upcoming).length;
  bucket.counts = {
    players: bucket.players,
    teams: bucket.teams.length,
    tournaments: bucket.tournaments.length,
    events: bucket.events.length,
    drafts: bucket.drafts.length,
    upcoming,
    past: bucket.tournaments.length + bucket.events.length - upcoming,
    total: bucket.players + bucket.teams.length + bucket.tournaments.length + bucket.events.length + bucket.drafts.length,
  };
  bucket.tournaments.sort((a, b) => (b.startDate ?? '').localeCompare(a.startDate ?? ''));
  bucket.events.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  return bucket;
}

/**
 * Buckets every located entity per city. Pure: the service only feeds it
 * database rows. Cities with nothing are still returned (with zero counts)
 * so the map can draw every marker; the ranked list filters them out.
 */
export function aggregateMap(input: MapAggregateInput): MapAggregate {
  const now = input.now ?? new Date();
  const buckets = new Map<string, MapCityBucket>();
  for (const city of TOGO_CITIES) buckets.set(city.id, emptyBucket(city));
  const other = emptyBucket(null);

  let located = 0;
  let unlocated = 0;
  const bucketFor = (raw?: string | null): MapCityBucket | null => {
    if (!hasCity(raw)) return null;
    const city = normalizeCity(raw);
    if (city) {
      located += 1;
      return buckets.get(city.id)!;
    }
    unlocated += 1;
    return other;
  };

  for (const u of input.users) {
    const b = bucketFor(u.city);
    if (!b) continue;
    b.players += 1;
    if (b.topPlayers.length < PUBLIC_PLAYERS_LIMIT && isProfilePublic(u.privacy)) {
      b.topPlayers.push({ id: u.id, username: u.username, avatar: u.avatar ?? null });
    }
  }

  for (const t of input.teams) {
    const b = bucketFor(t.city);
    if (!b) continue;
    b.teams.push({
      id: t.id,
      name: t.name,
      image: t.image ?? null,
      type: t.type ?? 'community',
      memberCount: t.memberCount ?? 0,
    });
  }

  for (const t of input.tournaments) {
    if (!inSeasonWindow(t.startDate ?? t.endDate ?? null, input.season)) continue;
    const b = bucketFor(t.city);
    if (!b) continue;
    b.tournaments.push({
      id: t.id,
      name: t.name,
      status: t.status ?? null,
      startDate: t.startDate ?? null,
      endDate: t.endDate ?? null,
      upcoming: isUpcoming(t, now),
    });
  }

  for (const e of input.events) {
    if (!inSeasonWindow(e.date ?? null, input.season)) continue;
    const b = bucketFor(e.city);
    if (!b) continue;
    b.events.push({
      id: e.id,
      title: e.title,
      type: e.type ?? null,
      date: e.date ?? null,
      time: e.time ?? null,
      upcoming: isUpcoming({ date: e.date ?? null }, now),
    });
  }

  for (const d of input.drafts) {
    const b = bucketFor(d.city);
    if (!b) continue;
    b.drafts.push({ id: d.id, name: d.name, status: d.status ?? null, category: d.category ?? null });
  }

  const cities = [...buckets.values()].map(finalize);
  finalize(other);

  return {
    season: input.season ? { id: input.season.id, name: input.season.name } : null,
    totals: {
      players: cities.reduce((n, c) => n + c.players, 0) + other.players,
      teams: cities.reduce((n, c) => n + c.teams.length, 0) + other.teams.length,
      tournaments: cities.reduce((n, c) => n + c.tournaments.length, 0) + other.tournaments.length,
      events: cities.reduce((n, c) => n + c.events.length, 0) + other.events.length,
      drafts: cities.reduce((n, c) => n + c.drafts.length, 0) + other.drafts.length,
      located,
      unlocated,
    },
    cities,
    other,
  };
}
