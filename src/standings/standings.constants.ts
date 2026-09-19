/** Default league scoring, overridable per season through `EsportSeason.settings`. */
export const DEFAULT_POINTS = { win: 3, draw: 1, loss: 0 } as const;

/** Default number of qualified teams (top N highlighted on the table). */
export const DEFAULT_QUALIFY_TOP = 4;

/** Allowed qualification thresholds (mirrors the issue: top 1/2/3/4/6/8). */
export const QUALIFY_TOP_OPTIONS = [1, 2, 3, 4, 6, 8] as const;

/** Standings scopes exposed by the API. */
export const STANDINGS_TYPES = ['league', 'playoff', 'all'] as const;
export type StandingsType = (typeof STANDINGS_TYPES)[number];

/**
 * Match types counted by each scope. `official` is the historical league
 * type; `league` / `playoff` are accepted so a future match-type extension
 * (#44) works without touching this module.
 */
export const LEAGUE_MATCH_TYPES = ['official', 'league'];
export const PLAYOFF_MATCH_TYPES = ['playoff', 'playoffs'];

/** Length of the "form" sequence (last N results). */
export const FORM_LENGTH = 5;

/** Rank-delta windows, in days. */
export const DELTA_WINDOWS = [7, 30] as const;

export const SUPPORTED_LANGS = ['fr', 'en'] as const;
export type Lang = (typeof SUPPORTED_LANGS)[number];
