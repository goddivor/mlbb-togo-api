import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'roles';

/**
 * @deprecated Legacy role check on `roleUser` (admin | moderator). Use
 * `@RequirePermissions(...)` with `PermissionsGuard` (src/access/permissions.ts).
 */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
