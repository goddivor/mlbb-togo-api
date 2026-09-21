import {
  ADMIN_PAGE_ACTIONS,
  ALL_PERMISSIONS,
  ANY_ADMIN,
  MODERATOR_PERMISSIONS,
  PERMISSIONS,
  PERMISSION_GROUPS,
  hasAdminAccess,
  hasAnyPermission,
  hasPermission,
  isKnownPermission,
  normalizePermissions,
  permissionsOf,
} from './permissions';

describe('permission catalogue', () => {
  it('has unique keys, a known group and fr/en labels for every entry', () => {
    const groups = new Set(PERMISSION_GROUPS.map((g) => g.key));
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length);
    for (const p of PERMISSIONS) {
      expect(groups.has(p.group)).toBe(true);
      expect(p.label.fr).toBeTruthy();
      expect(p.label.en).toBeTruthy();
    }
  });

  it('declares one admin area per admin page, each with its route', () => {
    const areas = PERMISSIONS.filter((p) => p.key.startsWith('admin.'));
    for (const a of areas) expect(a.route).toBe(`/admin/${a.key.slice('admin.'.length)}`);
    expect(areas.map((a) => a.key)).toEqual(
      expect.arrayContaining([
        'admin.league',
        'admin.seasons',
        'admin.matches',
        'admin.awards',
        'admin.sponsors',
        'admin.catalog',
        'admin.esport',
        'admin.tournaments',
        'admin.draft',
        'admin.stream',
        'admin.users',
        'admin.requests',
        'admin.messages',
        'admin.logs',
        'admin.roles',
      ]),
    );
    expect(ALL_PERMISSIONS).toEqual(
      expect.arrayContaining(['forum.announce', 'forum.moderate', 'posts.sponsor', 'matches.validate']),
    );
  });

  it('moderator defaults only reference catalogue keys and exclude admin-only areas', () => {
    expect(normalizePermissions(MODERATOR_PERMISSIONS)).toHaveLength(MODERATOR_PERMISSIONS.length);
    for (const k of ['admin.roles', 'admin.esport', 'admin.seasons', 'users.delete', 'sponsors.manage']) {
      expect(MODERATOR_PERMISSIONS).not.toContain(k);
    }
  });
});

describe('normalizePermissions', () => {
  it('drops unknown keys and duplicates and keeps catalogue order', () => {
    expect(normalizePermissions(['admin.users', 'nope', 'admin.league', 'admin.users', 3])).toEqual([
      'admin.league',
      'admin.users',
    ]);
    expect(normalizePermissions('admin.users')).toEqual([]);
  });
});

describe('permission checks', () => {
  const editor = { permissions: ['admin.league', 'forum.announce'] };

  it('checks explicit permissions', () => {
    expect(hasPermission(editor, 'admin.league')).toBe(true);
    expect(hasPermission(editor, 'admin.users')).toBe(false);
    expect(hasAnyPermission(editor, ['admin.users', 'forum.announce'])).toBe(true);
    expect(hasAnyPermission(editor, [])).toBe(true);
    expect(hasPermission(null, 'admin.league')).toBe(false);
  });

  it('ANY_ADMIN matches any admin area but not action-only permissions', () => {
    expect(hasPermission(editor, ANY_ADMIN)).toBe(true);
    expect(hasAdminAccess({ permissions: ['forum.announce'] })).toBe(false);
    expect(hasAdminAccess({ permissions: [] })).toBe(false);
  });

  it('an action permission with its own admin page opens the admin interface', () => {
    expect(ADMIN_PAGE_ACTIONS).toEqual(['builds.moderate']);
    for (const key of ADMIN_PAGE_ACTIONS) {
      expect(isKnownPermission(key)).toBe(true);
      expect(PERMISSIONS.find((p) => p.key === key)?.route).toMatch(/^\/admin\//);
    }
    expect(hasAdminAccess({ permissions: ['builds.moderate'] })).toBe(true);
    expect(hasPermission({ permissions: ['builds.moderate'] }, ANY_ADMIN)).toBe(false);
  });

  it('resolved permissions take precedence over the legacy roleUser', () => {
    expect(hasPermission({ roleUser: 'admin', permissions: [] }, 'admin.users')).toBe(false);
  });

  it('falls back to the legacy roleUser when permissions were never resolved', () => {
    expect(permissionsOf({ roleUser: 'admin' })).toEqual(ALL_PERMISSIONS);
    expect(permissionsOf({ roleUser: 'moderator' })).toEqual(MODERATOR_PERMISSIONS);
    expect(permissionsOf({ roleUser: 'user' })).toEqual([]);
  });
});
