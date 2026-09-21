import {
  ALL_PERMISSIONS,
  MODERATOR_PERMISSIONS,
  SYSTEM_ROLE_ADMIN,
  SYSTEM_ROLE_MODERATOR,
  normalizePermissions,
} from './permissions';

/**
 * Pure RBAC rules (no database access) so they can be unit-tested in
 * isolation: permission resolution, legacy `roleUser` derivation, legacy
 * migration and the safety rules (last administrator, self lock-out).
 */

export interface RoleLike {
  id: string;
  name?: string;
  permissions?: readonly string[] | null;
  systemKey?: string | null;
  isSystem?: boolean;
}

export type LegacyRoleUser = 'admin' | 'moderator' | 'user';

export function isAdminRole(role?: RoleLike | null): boolean {
  return role?.systemKey === SYSTEM_ROLE_ADMIN;
}

/** Permissions granted by one role. Administrateur always has them all. */
export function rolePermissions(role: RoleLike): string[] {
  if (isAdminRole(role)) return [...ALL_PERMISSIONS];
  return normalizePermissions(role.permissions ?? []);
}

/** Union of the permissions of every role, in catalogue order. */
export function resolvePermissions(roles: readonly RoleLike[]): string[] {
  const set = new Set<string>();
  for (const role of roles) rolePermissions(role).forEach((p) => set.add(p));
  return ALL_PERMISSIONS.filter((p) => set.has(p));
}

/**
 * Backward-compatible `roleUser`: `admin` for Administrateur holders,
 * `moderator` for anyone holding at least one permission (staff), `user`
 * otherwise. Staff exclusions (leaderboards, directory...) keep relying on it.
 */
export function deriveRoleUser(roles: readonly RoleLike[]): LegacyRoleUser {
  if (roles.some(isAdminRole)) return 'admin';
  return resolvePermissions(roles).length > 0 ? 'moderator' : 'user';
}

/** System role a legacy `roleUser` maps to, or null for regular users. */
export function legacySystemKey(roleUser?: string | null): string | null {
  if (roleUser === 'admin') return SYSTEM_ROLE_ADMIN;
  if (roleUser === 'moderator') return SYSTEM_ROLE_MODERATOR;
  return null;
}

/**
 * A user still needs the legacy migration when he is flagged staff by
 * `roleUser` but holds no role yet. Once migrated (or once an admin edited his
 * roles, which re-derives `roleUser`), this is false: the migration is
 * idempotent and never re-grants a role that was removed on purpose.
 */
export function needsLegacyMigration(user: {
  roleUser?: string | null;
  roleIds?: readonly string[] | null;
}): boolean {
  return !!legacySystemKey(user.roleUser) && !(user.roleIds && user.roleIds.length);
}

/** Default permission set of the seeded Modérateur role. */
export function defaultModeratorPermissions(): string[] {
  return [...MODERATOR_PERMISSIONS];
}

export type RbacViolation = 'last_admin' | 'self_lockout' | null;

/**
 * Checks a change of one user's role set.
 * - `last_admin`: the change would leave the platform without any holder of
 *   the Administrateur role.
 * - `self_lockout`: the actor would remove his own `admin.roles` permission.
 */
export function checkUserRolesChange(input: {
  actorId: string;
  targetId: string;
  currentRoleIds: readonly string[];
  nextRoleIds: readonly string[];
  roles: readonly RoleLike[];
  adminHolderIds: readonly string[];
}): RbacViolation {
  const byId = new Map(input.roles.map((r) => [r.id, r]));
  const pick = (ids: readonly string[]) =>
    ids.map((id) => byId.get(id)).filter((r): r is RoleLike => !!r);
  const before = pick(input.currentRoleIds);
  const after = pick(input.nextRoleIds);

  if (before.some(isAdminRole) && !after.some(isAdminRole)) {
    const others = input.adminHolderIds.filter((id) => id !== input.targetId);
    if (others.length === 0) return 'last_admin';
  }
  if (
    input.actorId === input.targetId &&
    resolvePermissions(before).includes('admin.roles') &&
    !resolvePermissions(after).includes('admin.roles')
  ) {
    return 'self_lockout';
  }
  return null;
}

/**
 * Checks an edit (`nextPermissions`) or a deletion (`nextPermissions = null`)
 * of a role against the actor's own access: the actor may not remove his own
 * `admin.roles` permission through a role he holds.
 */
export function checkRoleEdit(input: {
  actorRoleIds: readonly string[];
  roleId: string;
  nextPermissions: readonly string[] | null;
  roles: readonly RoleLike[];
}): RbacViolation {
  if (!input.actorRoleIds.includes(input.roleId)) return null;
  const actorRoles = input.roles.filter((r) => input.actorRoleIds.includes(r.id));
  if (!resolvePermissions(actorRoles).includes('admin.roles')) return null;
  const next = actorRoles
    .filter((r) => r.id !== input.roleId || input.nextPermissions !== null)
    .map((r) =>
      r.id === input.roleId ? { ...r, permissions: input.nextPermissions } : r,
    );
  return resolvePermissions(next).includes('admin.roles') ? null : 'self_lockout';
}

/** Removing a user entirely (deletion) must not remove the last admin. */
export function checkUserRemoval(input: {
  targetRoleIds: readonly string[];
  targetId: string;
  roles: readonly RoleLike[];
  adminHolderIds: readonly string[];
}): RbacViolation {
  const admin = input.roles.find(isAdminRole);
  if (!admin || !input.targetRoleIds.includes(admin.id)) return null;
  return input.adminHolderIds.some((id) => id !== input.targetId) ? null : 'last_admin';
}

export const VIOLATION_MESSAGES: Record<Exclude<RbacViolation, null>, string> = {
  last_admin:
    'Impossible : il doit toujours rester au moins un titulaire du rôle Administrateur.',
  self_lockout:
    'Impossible : vous ne pouvez pas retirer votre propre accès à la gestion des rôles.',
};

const HEX = /^#[0-9a-fA-F]{6}$/;
export function normalizeColor(color: unknown, fallback = '#6366f1'): string {
  return typeof color === 'string' && HEX.test(color.trim()) ? color.trim() : fallback;
}
