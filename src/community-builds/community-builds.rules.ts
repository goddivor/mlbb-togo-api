// Pure rules of the community builds (#129): limits, input normalization,
// visibility and ownership. No I/O here so they can be unit tested directly.

export const BUILD_STATUSES = ['draft', 'published', 'hidden'] as const;
export type BuildStatus = (typeof BUILD_STATUSES)[number];

export const BUILD_LANES = ['gold', 'exp', 'jungle', 'mid', 'roam'] as const;
export type BuildLane = (typeof BUILD_LANES)[number];

export const REPORT_REASONS = ['spam', 'offensive', 'misleading', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const BUILD_SORTS = ['likes', 'recent'] as const;
export type BuildSort = (typeof BUILD_SORTS)[number];

export const LIMITS = {
  titleMin: 3,
  titleMax: 60,
  notesMax: 1500,
  items: 6,
  /** One talent per tier (1, 2 and the core tier 3). */
  talents: 3,
  reportDetailsMax: 500,
  hideReasonMax: 300,
  /** Builds a player may own (drafts + published + hidden). */
  buildsPerUser: 60,
  /** Publications (first publish or republish) per rolling 24 hours. */
  publishesPerDay: 5,
  /** Reports a player may file per rolling 24 hours. */
  reportsPerDay: 20,
  pageSizeMax: 50,
  pageSizeDefault: 20,
} as const;

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Raised by the rules; the service maps it to a 400. */
export class BuildRuleError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'BuildRuleError';
  }
}

// Control characters except tab and line feed (kept in notes).
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** Trims, strips control characters and collapses 3+ blank lines. */
export function cleanText(value: unknown, multiline = false): string {
  if (typeof value !== 'string') return '';
  let text = value.replace(/\r\n?/g, '\n').replace(CONTROL, '');
  text = multiline ? text.replace(/\n{3,}/g, '\n\n') : text.replace(/\s+/g, ' ');
  return text.trim();
}

export function normalizeTitle(value: unknown): string {
  const title = cleanText(value);
  if (title.length < LIMITS.titleMin || title.length > LIMITS.titleMax) {
    throw new BuildRuleError(
      `The title must be ${LIMITS.titleMin} to ${LIMITS.titleMax} characters long.`,
      'title_length',
    );
  }
  return title;
}

export function normalizeNotes(value: unknown): string | null {
  const notes = cleanText(value, true);
  if (notes.length > LIMITS.notesMax) {
    throw new BuildRuleError(`Notes are limited to ${LIMITS.notesMax} characters.`, 'notes_length');
  }
  return notes || null;
}

export function normalizeLane(value: unknown): BuildLane | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && (BUILD_LANES as readonly string[]).includes(value)) {
    return value as BuildLane;
  }
  throw new BuildRuleError('Unknown lane.', 'lane');
}

/** Item ids in slot order: at most 6, no duplicate. */
export function normalizeItemIds(value: unknown): string[] {
  const ids = Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && !!v) : [];
  if (ids.length > LIMITS.items) {
    throw new BuildRuleError(`A build holds at most ${LIMITS.items} items.`, 'items_count');
  }
  if (new Set(ids).size !== ids.length) {
    throw new BuildRuleError('An item appears twice in the build.', 'items_duplicate');
  }
  return ids;
}

export interface CatalogRef {
  id: string;
  enabled?: boolean | null;
}

export interface TalentRef extends CatalogRef {
  tier?: number | null;
}

/** A catalog entry players may pick: missing `enabled` means enabled. */
export const isPickable = (row: CatalogRef | null | undefined): boolean =>
  !!row && row.enabled !== false;

/**
 * Every requested id must match a pickable catalog row. `kept` lists ids the
 * build already had: an entry disabled after the build was written does not
 * block editing the rest of the build.
 */
export function assertPickable(
  ids: string[],
  rows: CatalogRef[],
  label: string,
  kept: readonly string[] = [],
): void {
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) throw new BuildRuleError(`Unknown ${label}.`, `${label}_unknown`);
    if (!isPickable(row) && !kept.includes(id)) {
      throw new BuildRuleError(`The ${label} "${id}" is not available.`, `${label}_disabled`);
    }
  }
}

/** Talents: at most one per tier (tiers 1 to 3). */
export function assertTalentTiers(talents: TalentRef[]): void {
  if (talents.length > LIMITS.talents) {
    throw new BuildRuleError(`A build holds at most ${LIMITS.talents} talents.`, 'talents_count');
  }
  const tiers = new Set<number>();
  for (const t of talents) {
    const tier = t.tier ?? 0;
    if (tier < 1 || tier > 3) throw new BuildRuleError('Talent without a valid tier.', 'talents_tier');
    if (tiers.has(tier)) {
      throw new BuildRuleError('Pick at most one talent per tier.', 'talents_tier_duplicate');
    }
    tiers.add(tier);
  }
}

/** What a build needs before it can be published. */
export function assertPublishable(build: { title?: string | null; itemIds?: string[] | null }): void {
  normalizeTitle(build.title);
  if (!build.itemIds || build.itemIds.length === 0) {
    throw new BuildRuleError('Add at least one item before publishing.', 'publish_no_items');
  }
}

export interface Viewer {
  id?: string | null;
  canModerate?: boolean;
}

export interface BuildAccessRow {
  authorId: string;
  status: string;
}

export const isOwner = (build: BuildAccessRow, viewer?: Viewer | null): boolean =>
  !!viewer?.id && build.authorId === viewer.id;

/**
 * Visibility: published builds are public; drafts are seen by their author
 * only; hidden builds by their author (to know why) and moderators.
 */
export function canView(build: BuildAccessRow, viewer?: Viewer | null): boolean {
  if (build.status === 'published') return true;
  if (isOwner(build, viewer)) return true;
  return build.status === 'hidden' && !!viewer?.canModerate;
}

/** Only the author edits or deletes; moderators act through their own endpoints. */
export function assertOwner(build: BuildAccessRow, viewer?: Viewer | null): void {
  if (!isOwner(build, viewer)) throw new BuildRuleError('This build is not yours.', 'not_owner');
}

/** Likes: published builds of someone else only. */
export function assertLikeable(build: BuildAccessRow, viewer?: Viewer | null): void {
  if (build.status !== 'published') {
    throw new BuildRuleError('Only published builds can be liked.', 'like_not_published');
  }
  if (isOwner(build, viewer)) throw new BuildRuleError('You cannot like your own build.', 'like_own');
}

export function assertReportable(build: BuildAccessRow, viewer?: Viewer | null): void {
  if (build.status !== 'published') {
    throw new BuildRuleError('Only published builds can be reported.', 'report_not_published');
  }
  if (isOwner(build, viewer)) {
    throw new BuildRuleError('You cannot report your own build.', 'report_own');
  }
}

export function normalizeReportReason(value: unknown): ReportReason {
  if (typeof value === 'string' && (REPORT_REASONS as readonly string[]).includes(value)) {
    return value as ReportReason;
  }
  throw new BuildRuleError('Unknown report reason.', 'report_reason');
}

export function normalizeSort(value: unknown): BuildSort {
  return value === 'recent' ? 'recent' : 'likes';
}

export function normalizePage(page: unknown, limit: unknown): { page: number; limit: number; skip: number } {
  const p = Math.max(1, Math.floor(Number(page)) || 1);
  const l = Math.min(
    LIMITS.pageSizeMax,
    Math.max(1, Math.floor(Number(limit)) || LIMITS.pageSizeDefault),
  );
  return { page: p, limit: l, skip: (p - 1) * l };
}

/** Rolling-window quota check (`count` events already in the window). */
export function assertQuota(count: number, max: number, code: string, what: string): void {
  if (count >= max) {
    throw new BuildRuleError(`Limit reached: ${max} ${what} per 24 hours.`, code);
  }
}
