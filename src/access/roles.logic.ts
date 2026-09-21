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

export type RbacViolation = 'last_admin' | 'self_lockout' | 'escalation' | null;

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

/**
 * Anti privilege escalation: an actor may only grant (or take away) what he
 * holds himself. Holders of Administrateur may delegate anything; anyone else
 * may only handle permissions included in his own effective permissions, and
 * never the Administrateur role itself.
 */
export function canDelegatePermissions(
  actorRoles: readonly RoleLike[],
  permissions: readonly string[],
): boolean {
  if (actorRoles.some(isAdminRole)) return true;
  const held = new Set(resolvePermissions(actorRoles));
  return normalizePermissions(permissions).every((p) => held.has(p));
}

export function canDelegateRole(actorRoles: readonly RoleLike[], role: RoleLike): boolean {
  if (actorRoles.some(isAdminRole)) return true;
  if (isAdminRole(role)) return false;
  return canDelegatePermissions(actorRoles, rolePermissions(role));
}

/**
 * Checks that every role added to or removed from a user can be delegated by
 * the actor (see `canDelegateRole`).
 */
export function checkRoleDelegation(input: {
  actorRoleIds: readonly string[];
  currentRoleIds: readonly string[];
  nextRoleIds: readonly string[];
  roles: readonly RoleLike[];
}): RbacViolation {
  const byId = new Map(input.roles.map((r) => [r.id, r]));
  const actorRoles = input.actorRoleIds
    .map((id) => byId.get(id))
    .filter((r): r is RoleLike => !!r);
  const changed = [
    ...input.nextRoleIds.filter((id) => !input.currentRoleIds.includes(id)),
    ...input.currentRoleIds.filter((id) => !input.nextRoleIds.includes(id)),
  ];
  for (const id of changed) {
    const role = byId.get(id);
    if (role && !canDelegateRole(actorRoles, role)) return 'escalation';
  }
  return null;
}

/**
 * Account management (ban, deletion, profile edit, system flag) of another
 * user: the actor must hold every permission the target holds, so staff can
 * never act on an account ranking above them. Acting on oneself is allowed
 * here (self-deletion has its own last-admin rule).
 */
export function checkUserManagement(input: {
  actorId: string;
  targetId: string;
  actorRoleIds: readonly string[];
  targetRoleIds: readonly string[];
  roles: readonly RoleLike[];
}): RbacViolation {
  if (input.actorId === input.targetId) return null;
  const pick = (ids: readonly string[]) => input.roles.filter((r) => ids.includes(r.id));
  const actorRoles = pick(input.actorRoleIds);
  const targetRoles = pick(input.targetRoleIds);
  if (actorRoles.some(isAdminRole)) return null;
  if (targetRoles.some(isAdminRole)) return 'escalation';
  return canDelegatePermissions(actorRoles, resolvePermissions(targetRoles)) ? null : 'escalation';
}

export const VIOLATION_MESSAGES: Record<Exclude<RbacViolation, null>, string> = {
  last_admin:
    'Impossible : il doit toujours rester au moins un titulaire du rôle Administrateur.',
  self_lockout:
    'Impossible : vous ne pouvez pas retirer votre propre accès à la gestion des rôles.',
  escalation:
    'Impossible : vous ne pouvez attribuer ou gérer que des droits que vous détenez vous-même.',
};

const HEX = /^#[0-9a-fA-F]{6}$/;
export function normalizeColor(color: unknown, fallback = '#6366f1'): string {
  return typeof color === 'string' && HEX.test(color.trim()) ? color.trim() : fallback;
}
