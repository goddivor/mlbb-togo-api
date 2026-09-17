/** Feed categories (issue #49). Legacy categories are folded into `community`. */
export const POST_CATEGORIES = [
  'announcement',
  'stream',
  'offline',
  'community',
] as const;
export type PostCategory = (typeof POST_CATEGORIES)[number];

/** Only admins/moderators may publish in these categories. */
export const STAFF_ONLY_CATEGORIES: readonly PostCategory[] = [
  'announcement',
  'stream',
];

export const STAFF_ROLES = ['admin', 'moderator'];

export const POST_SORTS = ['latest', 'popular', 'pinned'] as const;
export type PostSort = (typeof POST_SORTS)[number];

export const CONTENT_FORMATS = ['text', 'markdown'] as const;
export type ContentFormat = (typeof CONTENT_FORMATS)[number];

export const MAX_POST_IMAGES = 6;
export const DEFAULT_PAGE_SIZE = 10;
export const MAX_PAGE_SIZE = 50;
