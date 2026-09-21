import { ALL_PERMISSIONS, MODERATOR_PERMISSIONS } from './permissions';
import {
  checkRoleEdit,
  checkUserRemoval,
  checkUserRolesChange,
  deriveRoleUser,
  legacySystemKey,
  needsLegacyMigration,
  normalizeColor,
  resolvePermissions,
  rolePermissions,
} from './roles.logic';

const admin = { id: 'r-admin', systemKey: 'admin', isSystem: true, permissions: [] };
const moderator = { id: 'r-mod', systemKey: 'moderator', permissions: [...MODERATOR_PERMISSIONS] };
const editor = { id: 'r-edit', permissions: ['admin.league', 'forum.announce'] };
const roleManager = { id: 'r-roles', permissions: ['admin.roles'] };
const roles = [admin, moderator, editor, roleManager];

describe('permission resolution', () => {
  it('Administrateur always resolves to every permission, whatever is stored', () => {
    expect(rolePermissions(admin)).toEqual([...ALL_PERMISSIONS]);
  });

  it('unions the permissions of all roles and ignores unknown keys', () => {
    const custom = { id: 'x', permissions: ['admin.users', 'legacy.unknown'] };
    expect(resolvePermissions([editor, custom])).toEqual([
      'admin.league',
      'admin.users',
      'forum.announce',
    ]);
    expect(resolvePermissions([])).toEqual([]);
  });
});

describe('deriveRoleUser (backward compatibility)', () => {
  it('maps roles onto admin / moderator / user', () => {
    expect(deriveRoleUser([admin])).toBe('admin');
    expect(deriveRoleUser([editor, admin])).toBe('admin');
    expect(deriveRoleUser([editor])).toBe('moderator');
    expect(deriveRoleUser([{ id: 'empty', permissions: [] }])).toBe('user');
    expect(deriveRoleUser([])).toBe('user');
  });
});

describe('legacy migration rules', () => {
  it('maps legacy roleUser values to system roles', () => {
    expect(legacySystemKey('admin')).toBe('admin');
    expect(legacySystemKey('moderator')).toBe('moderator');
    expect(legacySystemKey('user')).toBeNull();
  });

  it('only migrates staff that hold no role yet (idempotent)', () => {
    expect(needsLegacyMigration({ roleUser: 'admin', roleIds: [] })).toBe(true);
    expect(needsLegacyMigration({ roleUser: 'moderator', roleIds: undefined })).toBe(true);
    expect(needsLegacyMigration({ roleUser: 'admin', roleIds: ['r-admin'] })).toBe(false);
    expect(needsLegacyMigration({ roleUser: 'user', roleIds: [] })).toBe(false);
  });
});

describe('checkUserRolesChange', () => {
  const base = { roles, actorId: 'boss', targetId: 'u1' };

  it('refuses to remove the last Administrateur holder', () => {
    expect(
      checkUserRolesChange({
        ...base,
        currentRoleIds: ['r-admin'],
        nextRoleIds: [],
        adminHolderIds: ['u1'],
      }),
    ).toBe('last_admin');
  });

  it('allows removing an Administrateur when another one remains', () => {
    expect(
      checkUserRolesChange({
        ...base,
        currentRoleIds: ['r-admin'],
        nextRoleIds: ['r-edit'],
        adminHolderIds: ['u1', 'u2'],
      }),
    ).toBeNull();
  });

  it('refuses self-demotion out of admin.roles', () => {
    expect(
      checkUserRolesChange({
        ...base,
        actorId: 'u1',
        currentRoleIds: ['r-admin'],
        nextRoleIds: ['r-edit'],
        adminHolderIds: ['u1', 'u2'],
      }),
    ).toBe('self_lockout');
    // Keeping admin.roles through another role is fine.
    expect(
      checkUserRolesChange({
        ...base,
        actorId: 'u1',
        currentRoleIds: ['r-admin'],
        nextRoleIds: ['r-roles'],
        adminHolderIds: ['u1', 'u2'],
      }),
    ).toBeNull();
  });

  it('allows any change that does not touch those rules', () => {
    expect(
      checkUserRolesChange({ ...base, currentRoleIds: [], nextRoleIds: ['r-edit'], adminHolderIds: ['boss'] }),
    ).toBeNull();
  });
});

describe('checkRoleEdit', () => {
  it('refuses to strip admin.roles from a role the actor depends on', () => {
    expect(
      checkRoleEdit({ actorRoleIds: ['r-roles'], roleId: 'r-roles', nextPermissions: ['admin.users'], roles }),
    ).toBe('self_lockout');
    expect(checkRoleEdit({ actorRoleIds: ['r-roles'], roleId: 'r-roles', nextPermissions: null, roles })).toBe(
      'self_lockout',
    );
  });

  it('allows it when another held role still grants admin.roles', () => {
    expect(
      checkRoleEdit({ actorRoleIds: ['r-roles', 'r-admin'], roleId: 'r-roles', nextPermissions: [], roles }),
    ).toBeNull();
  });

  it('ignores roles the actor does not hold', () => {
    expect(checkRoleEdit({ actorRoleIds: ['r-admin'], roleId: 'r-edit', nextPermissions: null, roles })).toBeNull();
  });
});

describe('checkUserRemoval', () => {
  it('protects the last Administrateur from deletion', () => {
    expect(checkUserRemoval({ targetId: 'u1', targetRoleIds: ['r-admin'], roles, adminHolderIds: ['u1'] })).toBe(
      'last_admin',
    );
    expect(
      checkUserRemoval({ targetId: 'u1', targetRoleIds: ['r-admin'], roles, adminHolderIds: ['u1', 'u2'] }),
    ).toBeNull();
    expect(checkUserRemoval({ targetId: 'u3', targetRoleIds: ['r-edit'], roles, adminHolderIds: ['u1'] })).toBeNull();
  });
});

describe('normalizeColor', () => {
  it('accepts #rrggbb only', () => {
    expect(normalizeColor('#A1b2C3')).toBe('#A1b2C3');
    expect(normalizeColor('red', '#000000')).toBe('#000000');
  });
});
