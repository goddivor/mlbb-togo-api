import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AccessService } from './access.service';
import { ALL_PERMISSIONS, MODERATOR_PERMISSIONS } from './permissions';

/** Minimal in-memory Prisma double covering what AccessService uses. */
function fakePrisma(users: any[]) {
  const roles: any[] = [];
  let seq = 0;
  const matchRole = (where: any) => (r: any) =>
    Object.entries(where ?? {}).every(([k, v]: [string, any]) =>
      v && typeof v === 'object' && 'in' in v ? v.in.includes(r[k]) : r[k] === v,
    );
  const matchUser = (where: any) => (u: any) => {
    if (!where) return true;
    if (where.id?.in && !where.id.in.includes(u.id)) return false;
    if (typeof where.id === 'string' && where.id !== u.id) return false;
    if (where.roleUser?.in && !where.roleUser.in.includes(u.roleUser)) return false;
    if (where.roleIds?.has && !(u.roleIds ?? []).includes(where.roleIds.has)) return false;
    if (where.roleIds?.hasSome && !(u.roleIds ?? []).some((r: string) => where.roleIds.hasSome.includes(r)))
      return false;
    if (where.isBanned === false && u.isBanned) return false;
    return true;
  };
  return {
    roles,
    users,
    role: {
      findFirst: jest.fn(async ({ where }: any) => roles.find(matchRole(where)) ?? null),
      findUnique: jest.fn(async ({ where }: any) => roles.find(matchRole(where)) ?? null),
      findMany: jest.fn(async (args: any = {}) => roles.filter(matchRole(args.where))),
      create: jest.fn(async ({ data }: any) => {
        const r = { id: `role${++seq}`, createdAt: new Date(), updatedAt: new Date(), ...data };
        roles.push(r);
        return r;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const r = roles.find((x) => x.id === where.id);
        Object.assign(r, data);
        return r;
      }),
      delete: jest.fn(async ({ where }: any) => {
        roles.splice(roles.findIndex((x) => x.id === where.id), 1);
      }),
    },
    user: {
      findMany: jest.fn(async (args: any = {}) => users.filter(matchUser(args.where))),
      findUnique: jest.fn(async ({ where }: any) => users.find((u) => u.id === where.id) ?? null),
      count: jest.fn(async ({ where }: any) => users.filter(matchUser(where)).length),
      update: jest.fn(async ({ where, data }: any) => {
        const u = users.find((x) => x.id === where.id);
        Object.assign(u, data);
        return u;
      }),
    },
    adminLog: { create: jest.fn(async () => ({})) },
    $runCommandRaw: jest.fn(async () => ({ nModified: 0 })),
  };
}

describe('AccessService', () => {
  let users: any[];
  let prisma: ReturnType<typeof fakePrisma>;
  let service: AccessService;

  beforeEach(() => {
    users = [
      { id: 'a1', username: 'boss', roleUser: 'admin', roleIds: [] },
      { id: 'm1', username: 'mod', roleUser: 'moderator', roleIds: [] },
      { id: 'u1', username: 'player', roleUser: 'user', roleIds: [] },
    ];
    prisma = fakePrisma(users);
    service = new AccessService(prisma as any);
  });

  describe('legacy migration', () => {
    it('maps admin -> Administrateur and moderator -> Modérateur', async () => {
      const res = await service.migrateLegacyUsers();
      expect(res.migrated).toBe(2);
      const admin = prisma.roles.find((r) => r.systemKey === 'admin');
      const mod = prisma.roles.find((r) => r.systemKey === 'moderator');
      expect(admin).toMatchObject({ name: 'Administrateur', isSystem: true });
      expect(mod).toMatchObject({ name: 'Modérateur', isSystem: false });
      expect(mod.permissions).toEqual([...MODERATOR_PERMISSIONS]);
      expect(users[0].roleIds).toEqual([admin.id]);
      expect(users[1].roleIds).toEqual([mod.id]);
      expect(users[2].roleIds).toEqual([]);
    });

    it('is idempotent: a second run creates nothing and migrates nobody', async () => {
      await service.migrateLegacyUsers();
      const again = await service.migrateLegacyUsers();
      expect(again.migrated).toBe(0);
      expect(prisma.roles).toHaveLength(2);
      expect(users[0].roleIds).toHaveLength(1);
    });

    it('migrates lazily when resolving an unmigrated user', async () => {
      const access = await service.resolveUser(users[0]);
      expect(access.permissions).toEqual([...ALL_PERMISSIONS]);
      expect(users[0].roleIds).toHaveLength(1);
    });

    it('runs the raw backfill for the new user fields', async () => {
      await service.runMigration();
      const cmds = prisma.$runCommandRaw.mock.calls.map((c: any[]) => c[0].updates[0]);
      expect(cmds.some((u: any) => u.q.username === 'admin' && u.u.$set.isSystemAccount === true)).toBe(true);
      expect(cmds.some((u: any) => u.u.$set.isSystemAccount === false)).toBe(true);
      expect(cmds.some((u: any) => Array.isArray(u.u.$set.roleIds))).toBe(true);
    });
  });

  describe('roles and assignment', () => {
    beforeEach(async () => {
      await service.migrateLegacyUsers();
    });

    it('creates a custom role with normalized permissions and assigns it', async () => {
      const role = await service.createRole(
        { name: 'Rédacteur', permissions: ['forum.announce', 'admin.league', 'bogus'] },
        { id: 'a1' },
      );
      expect(role.permissions).toEqual(['admin.league', 'forum.announce']);
      const out = await service.setUserRoles('u1', [role.id], { id: 'a1' });
      expect(out.roleUser).toBe('moderator');
      expect(out.permissions).toEqual(['admin.league', 'forum.announce']);
      await service.setUserRoles('u1', [], { id: 'a1' });
      expect(users[2]).toMatchObject({ roleUser: 'user', roleIds: [] });
    });

    it('refuses to edit or delete the Administrateur role', async () => {
      const admin = prisma.roles.find((r) => r.systemKey === 'admin');
      await expect(service.updateRole(admin.id, { name: 'X' }, { id: 'a1' })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(service.deleteRole(admin.id, { id: 'a1' })).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses to remove the last Administrateur and self lock-out', async () => {
      await expect(service.setUserRoles('a1', [], { id: 'm1' })).rejects.toBeInstanceOf(BadRequestException);
      const admin = prisma.roles.find((r) => r.systemKey === 'admin');
      await service.setUserRoles('u1', [admin.id], { id: 'a1' });
      // Two admins now: removing one is fine, but not yourself.
      await expect(service.setUserRoles('a1', [], { id: 'a1' })).rejects.toThrow(/propre accès/);
      await service.setUserRoles('a1', [], { id: 'u1' });
      expect(users[0]).toMatchObject({ roleUser: 'user', roleIds: [] });
      await expect(service.assertUserRemovable('u1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('re-derives roleUser of members when a role loses all permissions or is deleted', async () => {
      const role = await service.createRole({ name: 'Stream', permissions: ['admin.stream'] }, { id: 'a1' });
      await service.setUserRoles('u1', [role.id], { id: 'a1' });
      expect(users[2].roleUser).toBe('moderator');
      await service.updateRole(role.id, { permissions: [] }, { id: 'a1' });
      expect(users[2].roleUser).toBe('user');
      await service.updateRole(role.id, { permissions: ['admin.stream'] }, { id: 'a1' });
      await service.deleteRole(role.id, { id: 'a1' });
      expect(users[2]).toMatchObject({ roleUser: 'user', roleIds: [] });
    });

    it('lists the users holding a permission', async () => {
      const ids = await service.userIdsWithPermission('admin.requests');
      expect(ids.sort()).toEqual(['a1', 'm1']);
      expect(await service.userIdsWithPermission('admin.roles')).toEqual(['a1']);
    });
  });
});
