import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  ADMIN_ROLE_NAME,
  MODERATOR_ROLE_NAME,
  PERMISSIONS,
  PERMISSION_GROUPS,
  SYSTEM_ROLE_ADMIN,
  SYSTEM_ROLE_MODERATOR,
  normalizePermissions,
} from './permissions';
import {
  RbacViolation,
  VIOLATION_MESSAGES,
  checkRoleEdit,
  checkUserRemoval,
  checkUserRolesChange,
  defaultModeratorPermissions,
  deriveRoleUser,
  isAdminRole,
  legacySystemKey,
  needsLegacyMigration,
  normalizeColor,
  resolvePermissions,
  rolePermissions,
} from './roles.logic';
import { CreateRoleDto, UpdateRoleDto } from './dto/role.dto';

type Actor = { id: string; username?: string; roleIds?: string[] };

type UserRow = { id: string; roleUser: string; roleIds: string[] };

/**
 * Roles & permissions (RBAC): system role seeding, legacy migration, role
 * CRUD, role assignment and permission resolution for the JWT strategy.
 */
@Injectable()
export class AccessService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AccessService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Boot hook: seeds the system roles and migrates legacy `roleUser` staff.
   * Idempotent (safe on every cold start); never blocks the boot on failure.
   * Disable with RBAC_BOOT_MIGRATION=0.
   */
  async onApplicationBootstrap() {
    if (process.env.RBAC_BOOT_MIGRATION === '0') return;
    try {
      const res = await this.runMigration();
      if (res.migrated || res.systemAccounts || res.backfilled) {
        this.logger.log(
          `RBAC migration: ${res.migrated} staff account(s) migrated, ` +
            `${res.systemAccounts} system account(s) flagged, ${res.backfilled} user(s) backfilled.`,
        );
      }
    } catch (err) {
      this.logger.warn(`RBAC boot migration failed: ${(err as Error)?.message}`);
    }
  }

  // ----- System roles & migration ------------------------------------------

  /**
   * Full idempotent migration (boot hook and `scripts/migrate-rbac.js`):
   * backfills the new User fields, flags the bootstrap admin account as a
   * system account, seeds the system roles and migrates legacy staff.
   */
  async runMigration() {
    const { backfilled, systemAccounts } = await this.backfillUserFields();
    const { migrated } = await this.migrateLegacyUsers();
    return { backfilled, systemAccounts, migrated };
  }

  /**
   * MongoDB documents created before this feature have no `roleIds` /
   * `isSystemAccount` fields, and Prisma filters such as
   * `isSystemAccount: false` do not match a missing field. Only documents
   * missing the field are touched, so an admin's later choice is never
   * overwritten. The bootstrap account created by prisma/create-admin.js
   * (local provider, username `admin`, no game link) becomes a system account.
   */
  async backfillUserFields(): Promise<{ backfilled: number; systemAccounts: number }> {
    const run = async (q: object, set: object): Promise<number> => {
      const res: any = await this.prisma.$runCommandRaw({
        update: 'User',
        updates: [{ q, u: { $set: set }, multi: true }],
      });
      return Number(res?.nModified ?? 0);
    };
    const systemAccounts = await run(
      {
        isSystemAccount: { $exists: false },
        username: 'admin',
        provider: 'local',
        $or: [{ mlbbRoleId: null }, { mlbbRoleId: { $exists: false } }],
      },
      { isSystemAccount: true },
    );
    const flags = await run({ isSystemAccount: { $exists: false } }, { isSystemAccount: false });
    const ids = await run({ roleIds: { $exists: false } }, { roleIds: [] });
    return { backfilled: Math.max(flags, ids), systemAccounts };
  }

  private async findSystemRole(key: string): Promise<Role | null> {
    return this.prisma.role.findFirst({ where: { systemKey: key } });
  }

  /** Creates (or repairs) the locked Administrateur role. */
  async ensureAdminRole(): Promise<Role> {
    const existing = await this.findSystemRole(SYSTEM_ROLE_ADMIN);
    if (existing) {
      if (!existing.isSystem) {
        return this.prisma.role.update({ where: { id: existing.id }, data: { isSystem: true } });
      }
      return existing;
    }
    const byName = await this.prisma.role.findUnique({ where: { name: ADMIN_ROLE_NAME } });
    const data = {
      isSystem: true,
      systemKey: SYSTEM_ROLE_ADMIN,
      permissions: [] as string[],
      description: 'Accès complet à toute l’administration (rôle système).',
      color: '#ef4444',
    };
    if (byName) return this.prisma.role.update({ where: { id: byName.id }, data });
    return this.prisma.role.create({ data: { name: ADMIN_ROLE_NAME, ...data } });
  }

  /** Creates the editable Modérateur role if it does not exist. */
  async ensureModeratorRole(): Promise<Role> {
    const existing = await this.findSystemRole(SYSTEM_ROLE_MODERATOR);
    if (existing) return existing;
    const byName = await this.prisma.role.findUnique({ where: { name: MODERATOR_ROLE_NAME } });
    if (byName) {
      return this.prisma.role.update({
        where: { id: byName.id },
        data: { systemKey: SYSTEM_ROLE_MODERATOR },
      });
    }
    return this.prisma.role.create({
      data: {
        name: MODERATOR_ROLE_NAME,
        description: 'Modération du forum, du catalogue et de la communauté.',
        permissions: defaultModeratorPermissions(),
        isSystem: false,
        systemKey: SYSTEM_ROLE_MODERATOR,
        color: '#f59e0b',
      },
    });
  }

  private async systemRoleFor(roleUser: string): Promise<Role | null> {
    const key = legacySystemKey(roleUser);
    if (key === SYSTEM_ROLE_ADMIN) return this.ensureAdminRole();
    if (key === SYSTEM_ROLE_MODERATOR) return this.ensureModeratorRole();
    return null;
  }

  /** Migrates one legacy staff user (roleUser admin/moderator, no roles). */
  async migrateUser<T extends UserRow>(user: T): Promise<T> {
    if (!needsLegacyMigration(user)) return user;
    const role = await this.systemRoleFor(user.roleUser);
    if (!role) return user;
    await this.prisma.user.update({ where: { id: user.id }, data: { roleIds: [role.id] } });
    return { ...user, roleIds: [role.id] };
  }

  /**
   * Idempotent migration of every legacy staff account:
   * `admin` -> Administrateur, `moderator` -> Modérateur.
   */
  async migrateLegacyUsers(): Promise<{ migrated: number; adminRoleId: string }> {
    const admin = await this.ensureAdminRole();
    const staff = await this.prisma.user.findMany({
      where: { roleUser: { in: ['admin', 'moderator'] } },
      select: { id: true, roleUser: true, roleIds: true },
    });
    let migrated = 0;
    for (const u of staff) {
      if (!needsLegacyMigration(u)) continue;
      await this.migrateUser(u);
      migrated++;
    }
    return { migrated, adminRoleId: admin.id };
  }

  // ----- Permission resolution ---------------------------------------------

  async rolesByIds(ids: readonly string[]): Promise<Role[]> {
    if (!ids?.length) return [];
    return this.prisma.role.findMany({ where: { id: { in: [...ids] } } });
  }

  /**
   * Effective access of a user row (called once per authenticated request by
   * the JWT strategy). Legacy staff without roles are migrated on the fly.
   */
  async resolveUser(user: UserRow): Promise<{
    roleIds: string[];
    roleUser: string;
    permissions: string[];
  }> {
    let row = user;
    if (needsLegacyMigration(row)) {
      try {
        row = await this.migrateUser(row);
      } catch (err) {
        this.logger.warn(`RBAC lazy migration failed: ${(err as Error)?.message}`);
      }
    }
    const roles = await this.rolesByIds(row.roleIds ?? []);
    return {
      roleIds: roles.map((r) => r.id),
      roleUser: row.roleUser,
      permissions: resolvePermissions(roles),
    };
  }

  async permissionsOfUser(userId: string): Promise<string[]> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, roleUser: true, roleIds: true },
    });
    if (!user) return [];
    return (await this.resolveUser(user)).permissions;
  }

  /** Ids of the users holding any of `permissions` (staff notifications). */
  async userIdsWithPermission(permissions: string | readonly string[]): Promise<string[]> {
    const wanted = typeof permissions === 'string' ? [permissions] : permissions;
    await this.ensureAdminRole();
    const roles = await this.prisma.role.findMany();
    const ids = roles
      .filter((r) => rolePermissions(r).some((p) => wanted.includes(p)))
      .map((r) => r.id);
    if (!ids.length) return [];
    const users = await this.prisma.user.findMany({
      where: { roleIds: { hasSome: ids }, isBanned: false },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }

  /** Re-derives the legacy `roleUser` of the given users from their roles. */
  async syncRoleUser(userIds: readonly string[]) {
    if (!userIds.length) return;
    const [users, roles] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: [...userIds] } },
        select: { id: true, roleUser: true, roleIds: true },
      }),
      this.prisma.role.findMany(),
    ]);
    const byId = new Map(roles.map((r) => [r.id, r]));
    for (const u of users) {
      const held = u.roleIds.map((id) => byId.get(id)).filter((r): r is Role => !!r);
      const next = deriveRoleUser(held);
      const cleanIds = held.map((r) => r.id);
      if (next !== u.roleUser || cleanIds.length !== u.roleIds.length) {
        await this.prisma.user.update({
          where: { id: u.id },
          data: { roleUser: next, roleIds: cleanIds },
        });
      }
    }
  }

  // ----- Catalogue & roles CRUD --------------------------------------------

  catalogue() {
    return { groups: PERMISSION_GROUPS, permissions: PERMISSIONS };
  }

  private async memberCounts(roleIds: string[]): Promise<Map<string, number>> {
    const counts = await Promise.all(
      roleIds.map((id) => this.prisma.user.count({ where: { roleIds: { has: id } } })),
    );
    return new Map(roleIds.map((id, i) => [id, counts[i]]));
  }

  private serializeRole(role: Role, memberCount?: number) {
    return {
      id: role.id,
      name: role.name,
      description: role.description,
      color: role.color,
      isSystem: role.isSystem,
      systemKey: role.systemKey,
      editable: !isAdminRole(role),
      deletable: !role.isSystem,
      permissions: rolePermissions(role),
      memberCount: memberCount ?? 0,
      createdAt: role.createdAt,
      updatedAt: role.updatedAt,
    };
  }

  async listRoles() {
    await this.ensureAdminRole();
    const roles = await this.prisma.role.findMany({ orderBy: { createdAt: 'asc' } });
    const counts = await this.memberCounts(roles.map((r) => r.id));
    return roles
      .map((r) => this.serializeRole(r, counts.get(r.id)))
      .sort((a, b) => Number(b.isSystem) - Number(a.isSystem));
  }

  private async getRoleRaw(id: string): Promise<Role> {
    const role = await this.prisma.role.findUnique({ where: { id } }).catch(() => null);
    if (!role) throw new NotFoundException('Rôle introuvable.');
    return role;
  }

  async getRole(id: string) {
    const role = await this.getRoleRaw(id);
    const members = await this.prisma.user.findMany({
      where: { roleIds: { has: id } },
      select: {
        id: true,
        username: true,
        email: true,
        avatar: true,
        gameAvatar: true,
        googleAvatar: true,
        gameNickname: true,
      },
      orderBy: { username: 'asc' },
    });
    return {
      ...this.serializeRole(role, members.length),
      members: members.map((m) => ({
        id: m.id,
        username: m.username,
        email: m.email,
        displayName: m.gameNickname || m.username,
        avatar: m.gameAvatar || m.googleAvatar || m.avatar || null,
      })),
    };
  }

  private async assertNameFree(name: string, exceptId?: string) {
    const other = await this.prisma.role.findUnique({ where: { name } });
    if (other && other.id !== exceptId) {
      throw new ConflictException('Un rôle porte déjà ce nom.');
    }
  }

  async createRole(dto: CreateRoleDto, actor: Actor) {
    const name = dto.name.trim();
    await this.assertNameFree(name);
    const role = await this.prisma.role.create({
      data: {
        name,
        description: dto.description?.trim() || null,
        color: normalizeColor(dto.color),
        permissions: normalizePermissions(dto.permissions ?? []),
        isSystem: false,
      },
    });
    await this.log('role.create', actor, role.name, role.permissions.join(', '));
    return this.serializeRole(role, 0);
  }

  async updateRole(id: string, dto: UpdateRoleDto, actor: Actor) {
    const role = await this.getRoleRaw(id);
    if (isAdminRole(role)) {
      throw new ForbiddenException('Le rôle Administrateur est un rôle système non modifiable.');
    }
    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      await this.assertNameFree(name, id);
      data.name = name;
    }
    if (dto.description !== undefined) data.description = dto.description.trim() || null;
    if (dto.color !== undefined) data.color = normalizeColor(dto.color, role.color);
    if (dto.permissions !== undefined) {
      const next = normalizePermissions(dto.permissions);
      await this.assertNoViolation(
        checkRoleEdit({
          actorRoleIds: await this.actorRoleIds(actor),
          roleId: id,
          nextPermissions: next,
          roles: await this.prisma.role.findMany(),
        }),
      );
      data.permissions = next;
    }
    const updated = await this.prisma.role.update({ where: { id }, data });
    if (dto.permissions !== undefined) {
      await this.syncRoleUser(await this.memberIds(id));
    }
    await this.log('role.update', actor, updated.name, updated.permissions.join(', '));
    const counts = await this.memberCounts([id]);
    return this.serializeRole(updated, counts.get(id));
  }

  async deleteRole(id: string, actor: Actor) {
    const role = await this.getRoleRaw(id);
    if (role.isSystem) {
      throw new ForbiddenException('Un rôle système ne peut pas être supprimé.');
    }
    await this.assertNoViolation(
      checkRoleEdit({
        actorRoleIds: await this.actorRoleIds(actor),
        roleId: id,
        nextPermissions: null,
        roles: await this.prisma.role.findMany(),
      }),
    );
    const members = await this.prisma.user.findMany({
      where: { roleIds: { has: id } },
      select: { id: true, roleIds: true },
    });
    for (const m of members) {
      await this.prisma.user.update({
        where: { id: m.id },
        data: { roleIds: m.roleIds.filter((r) => r !== id) },
      });
    }
    await this.prisma.role.delete({ where: { id } });
    await this.syncRoleUser(members.map((m) => m.id));
    await this.log('role.delete', actor, role.name);
    return { success: true };
  }

  // ----- Assignment ---------------------------------------------------------

  private async memberIds(roleId: string): Promise<string[]> {
    const rows = await this.prisma.user.findMany({
      where: { roleIds: { has: roleId } },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  private async actorRoleIds(actor: Actor): Promise<string[]> {
    if (actor.roleIds) return actor.roleIds;
    const row = await this.prisma.user.findUnique({
      where: { id: actor.id },
      select: { roleIds: true },
    });
    return row?.roleIds ?? [];
  }

  private async adminHolderIds(): Promise<string[]> {
    const admin = await this.ensureAdminRole();
    return this.memberIds(admin.id);
  }

  private async assertNoViolation(v: RbacViolation) {
    if (v) throw new BadRequestException(VIOLATION_MESSAGES[v]);
  }

  /** Replaces the whole role set of a user. */
  async setUserRoles(userId: string, roleIds: string[], actor: Actor) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, roleUser: true, roleIds: true },
    });
    if (!user) throw new NotFoundException('Utilisateur introuvable.');
    const current = (await this.migrateUser(user)).roleIds;
    const roles = await this.prisma.role.findMany();
    const known = new Set(roles.map((r) => r.id));
    const next = [...new Set(roleIds)].filter((id) => known.has(id));
    if (next.length !== new Set(roleIds).size) {
      throw new BadRequestException('Rôle introuvable.');
    }
    await this.assertNoViolation(
      checkUserRolesChange({
        actorId: actor.id,
        targetId: userId,
        currentRoleIds: current,
        nextRoleIds: next,
        roles,
        adminHolderIds: await this.adminHolderIds(),
      }),
    );
    const held = roles.filter((r) => next.includes(r.id));
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { roleIds: next, roleUser: deriveRoleUser(held) },
      select: { id: true, username: true, roleUser: true, roleIds: true },
    });
    await this.log(
      'user.roles',
      actor,
      user.username,
      held.map((r) => r.name).join(', ') || '(aucun)',
    );
    return { ...updated, permissions: resolvePermissions(held) };
  }

  async addMember(roleId: string, userId: string, actor: Actor) {
    await this.getRoleRaw(roleId);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, roleUser: true, roleIds: true },
    });
    if (!user) throw new NotFoundException('Utilisateur introuvable.');
    const current = (await this.migrateUser(user)).roleIds;
    if (current.includes(roleId)) return this.getRole(roleId);
    await this.setUserRoles(userId, [...current, roleId], actor);
    return this.getRole(roleId);
  }

  async removeMember(roleId: string, userId: string, actor: Actor) {
    await this.getRoleRaw(roleId);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, roleUser: true, roleIds: true },
    });
    if (!user) throw new NotFoundException('Utilisateur introuvable.');
    const current = (await this.migrateUser(user)).roleIds;
    await this.setUserRoles(
      userId,
      current.filter((id) => id !== roleId),
      actor,
    );
    return this.getRole(roleId);
  }

  /**
   * Legacy `PATCH /users/:id/role` ({ roleUser }): mapped onto the system
   * roles (admin -> Administrateur, moderator -> Modérateur, user -> none).
   */
  async setLegacyRole(userId: string, roleUser: string, actor: Actor) {
    if (!['admin', 'moderator', 'user'].includes(roleUser)) {
      throw new BadRequestException('Rôle invalide.');
    }
    const role = await this.systemRoleFor(roleUser);
    return this.setUserRoles(userId, role ? [role.id] : [], actor);
  }

  /** Guard used before deleting an account (never delete the last admin). */
  async assertUserRemovable(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, roleIds: true },
    });
    if (!user) return;
    await this.assertNoViolation(
      checkUserRemoval({
        targetId: userId,
        targetRoleIds: user.roleIds,
        roles: await this.prisma.role.findMany(),
        adminHolderIds: await this.adminHolderIds(),
      }),
    );
  }

  private async log(action: string, actor: Actor, target?: string, details?: string) {
    try {
      await this.prisma.adminLog.create({
        data: {
          action,
          admin: actor.username ?? actor.id,
          target: target ?? null,
          details: details?.slice(0, 500) ?? null,
        },
      });
    } catch (err) {
      this.logger.warn(`admin log failed: ${(err as Error)?.message}`);
    }
  }
}
