/**
 * Registry of the legacy import (issue #153).
 *
 * The import needs a key that survives everything a member or an admin may do
 * to the rows it created: renaming a profile, linking a game account (which
 * rewrites `gameNickname`), claiming it through Google (which rewrites the
 * mailbox), retyping a match note. Guessing the key from those mutable fields
 * is what made a re-run create duplicates and move stat rows onto them.
 *
 * So the import keeps its own mapping `legacy id -> our id`, in a single
 * `AppSetting` document (key `legacy.import`). No schema change, nothing
 * visible to members, and no collision with the integrations module: that one
 * only ever reads `AppSetting` by the exact key `integration.<name>`
 * (`src/integrations/integrations.logic.ts`), it never enumerates the
 * collection nor tries to decrypt rows it did not write.
 *
 * Everything here is pure: the runner and the service do the Prisma calls.
 */

/** `AppSetting.key` holding the registry. Plain JSON, never encrypted. */
export const LEGACY_REGISTRY_KEY = 'legacy.import';

/**
 * Copy of the registry as it was before the last run. Losing the live one is
 * unrecoverable (the import can no longer tell an adopted profile from a new
 * one), so every run backs it up before overwriting.
 */
export const LEGACY_REGISTRY_BACKUP_KEY = 'legacy.import.backup';

/**
 * Lock held while an import is running: two runs writing the same registry at
 * the same time would fight over it. The value is the epoch ms of the start;
 * a lock older than `LOCK_TTL_MS` is considered stale (the process died).
 */
export const LEGACY_LOCK_KEY = 'legacy.import.lock';
export const LOCK_TTL_MS = 15 * 60_000;

/** Entities the registry tracks. Each map is `legacy id -> our object id`. */
export type LegacyRegistry = {
  version: 1;
  /** ISO date of the run that wrote it (informative). */
  updatedAt: string | null;
  /**
   * Epoch ms of the very first run that wrote this registry. Every id the
   * import creates carries a creation time (the first four bytes of an
   * ObjectId) at or after it, so a mapping that points at an older row was not
   * created by the import (a hand-edited or foreign registry) and is refused.
   */
  firstRunAt: number | null;
  seasons: Record<string, string>;
  teams: Record<string, string>;
  /** One entry per legacy `players` row, so every spelling resolves. */
  players: Record<string, string>;
  matches: Record<string, string>;
  sponsors: Record<string, string>;
  awards: Record<string, string>;
  /** `<legacyTeamId>:<legacyPlayerId>` -> `EsportTeamMember` id. */
  teamMembers: Record<string, string>;
  /** `<legacyMatchId>:<legacyPlayerId>` -> `EsportMatchPlayer` id. */
  matchPlayers: Record<string, string>;
  posts: Record<string, string>;
  events: Record<string, string>;
  streamVideos: Record<string, string>;
};

export const REGISTRY_MAPS = [
  'seasons',
  'teams',
  'players',
  'matches',
  'sponsors',
  'awards',
  'teamMembers',
  'matchPlayers',
  'posts',
  'events',
  'streamVideos',
] as const;

export type RegistryMap = (typeof REGISTRY_MAPS)[number];

export function emptyRegistry(): LegacyRegistry {
  return {
    version: 1,
    updatedAt: null,
    firstRunAt: null,
    seasons: {},
    teams: {},
    players: {},
    matches: {},
    sponsors: {},
    awards: {},
    teamMembers: {},
    matchPlayers: {},
    posts: {},
    events: {},
    streamVideos: {},
  };
}

/** Keep only `string -> 24-hex object id` pairs (never throws). */
function sanitizeMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && /^[0-9a-fA-F]{24}$/.test(v)) out[String(k)] = v;
  }
  return out;
}

/**
 * Read the stored registry. Anything unreadable (absent, corrupt, written by a
 * future version) yields an empty registry: the import then treats every row as new
 * (and refuses to run when imported profiles exist) instead of crashing.
 */
export function parseRegistry(raw: string | null | undefined): LegacyRegistry {
  const registry = emptyRegistry();
  if (!raw) return registry;
  let doc: any;
  try {
    doc = JSON.parse(raw);
  } catch {
    return registry;
  }
  if (!doc || typeof doc !== 'object') return registry;
  registry.updatedAt = typeof doc.updatedAt === 'string' ? doc.updatedAt : null;
  registry.firstRunAt = Number.isFinite(doc.firstRunAt) ? Number(doc.firstRunAt) : null;
  for (const name of REGISTRY_MAPS) registry[name] = sanitizeMap(doc[name]);
  return registry;
}

export function serializeRegistry(registry: LegacyRegistry, now = new Date()): string {
  return JSON.stringify({ ...registry, version: 1, updatedAt: now.toISOString() });
}

/** True when the match was created by the import (drives the rewards guard). */
export function isLegacyMatchId(registry: LegacyRegistry, matchId: string): boolean {
  return Object.values(registry.matches).includes(matchId);
}

/** Ids of every match the import created, for a bulk check. */
export function legacyMatchIds(registry: LegacyRegistry): Set<string> {
  return new Set(Object.values(registry.matches));
}

/**
 * Add `extra` on top of `base` without losing anything: a run that stops
 * halfway must never shrink the registry it started from. On a conflicting
 * legacy id the newer value wins.
 */
export function mergeRegistry(base: LegacyRegistry, extra: LegacyRegistry): LegacyRegistry {
  const out = emptyRegistry();
  out.updatedAt = extra.updatedAt ?? base.updatedAt;
  out.firstRunAt = base.firstRunAt ?? extra.firstRunAt;
  for (const name of REGISTRY_MAPS) out[name] = { ...base[name], ...extra[name] };
  return out;
}

/** Total number of mappings, shown in the report. */
export function registrySize(registry: LegacyRegistry): number {
  return REGISTRY_MAPS.reduce((n, name) => n + Object.keys(registry[name]).length, 0);
}

/** Creation time of a Mongo ObjectId, in epoch ms. */
export function objectIdTime(id: string): number {
  return parseInt(id.slice(0, 8), 16) * 1000;
}

/**
 * Mappings that point at a row older than the registry itself: rows the import
 * cannot have created. Empty when the registry carries no `firstRunAt` (written
 * before the fingerprint existed).
 */
export function foreignMappings(
  registry: LegacyRegistry,
  options: { exempt?: Iterable<string>; toleranceMs?: number } = {},
): string[] {
  if (!registry.firstRunAt) return [];
  const toleranceMs = options.toleranceMs ?? 60_000;
  // Rows the import deliberately reused instead of creating (a legacy player
  // whose account already existed here) are older by design: never flag them.
  const exempt = new Set(options.exempt ?? []);
  const out: string[] = [];
  for (const name of REGISTRY_MAPS) {
    for (const [legacyId, id] of Object.entries(registry[name])) {
      if (exempt.has(id)) continue;
      if (objectIdTime(id) < registry.firstRunAt - toleranceMs) out.push(`${name}[${legacyId}] -> ${id}`);
    }
  }
  return out;
}
