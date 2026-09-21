import 'reflect-metadata';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { ANY_ADMIN, isKnownPermission } from './permissions';

/**
 * Static audit of the controllers (mapping of the former `@Roles` guards):
 * no endpoint may still rely on the legacy role guard, and every
 * `@RequirePermissions(...)` must reference catalogue keys and be paired with
 * the PermissionsGuard.
 */
function controllerFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return controllerFiles(full);
    return name.endsWith('.controller.ts') ? [full] : [];
  });
}

const SRC = join(__dirname, '..');
const files = controllerFiles(SRC);

describe('endpoint permission mapping', () => {
  it('finds the controllers', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(files.map((f) => [f.slice(SRC.length + 1), f]))('%s', (_name, file) => {
    const src = readFileSync(file, 'utf8');
    expect(src).not.toMatch(/@Roles\(/);
    expect(src).not.toMatch(/RolesGuard/);
    const uses = [...src.matchAll(/@RequirePermissions\(([^)]*)\)/g)];
    for (const [, args] of uses) {
      const keys = [...args.matchAll(/'([^']+)'/g)].map((m) => m[1]);
      const named = args.includes('ANY_ADMIN') ? [ANY_ADMIN] : [];
      expect(keys.length + named.length).toBeGreaterThan(0);
      for (const k of keys) expect(isKnownPermission(k)).toBe(true);
    }
    if (uses.length) expect(src).toMatch(/PermissionsGuard/);
  });

  it('keeps the expected mapping of sensitive endpoints', () => {
    const read = (p: string) => readFileSync(join(SRC, p), 'utf8');
    expect(read('users/users.controller.ts')).toMatch(
      /@RequirePermissions\('admin\.roles'\)\s*@Patch\(':id\/roles'\)/,
    );
    expect(read('users/users.controller.ts')).toMatch(
      /@RequirePermissions\('users\.delete'\)\s*@Delete\(':id'\)/,
    );
    expect(read('admin/admin.controller.ts')).toMatch(
      /@RequirePermissions\('admin\.league'\)\s*@Post\('league\/announce'\)/,
    );
    expect(read('esport/esport.controller.ts')).toMatch(
      /@RequirePermissions\('admin\.seasons'\)\s*@Post\('seasons'\)/,
    );
  });
});
