import { Prisma } from '@prisma/client';

/**
 * Player-facing features (directory, leaderboards, map, search, public
 * profiles...) show every real player, staff included: holding admin
 * permissions must never hide someone. Only banned users and dedicated
 * system accounts (`isSystemAccount`) are excluded.
 */
export const PUBLIC_USER_WHERE = {
  isBanned: false,
  isSystemAccount: false,
} satisfies Prisma.UserWhereInput;

/** Hidden from public profile/stat endpoints (system accounts only). */
export function isHiddenAccount(
  user?: { isSystemAccount?: boolean | null } | null,
): boolean {
  return !user || user.isSystemAccount === true;
}
